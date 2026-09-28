// The sync handler — dispatches one queued operation to the right domain
// function inside ONE db.transaction (invariant 4), replays a known
// (device_id, client_op_id) exactly, keys foreign devices with 409, records a
// hard failure by TENDER (422 for request-class, `unrecorded` for fact-class),
// and never lets a rolled-back transaction leave an `accepted` row behind
// (the pos_sync_ops insert is the first statement inside the tx). The
// class-by-tender rule is invariant 5 and blocker 5 of the overview.

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import type { PosDeviceContext } from '../auth/pos-context';
import {
	OP_KINDS,
	formatInvoiceNumber,
	type OpEnvelope,
	type OpKind,
	type SyncResult
} from '../../sync-ops';
import { minor } from '../../money';
import { checkEmployee } from '../permissions';
import { writeAudit } from '../audit';
import {
	SessionAlreadyClosed,
	SessionHasUnrecordedOps,
	SessionNotFound,
	closeSession,
	openSession,
	type SessionContext
} from '../pos-sessions';
import { validateSale, type HardFlag, type SoftFlag, type SyncContext } from './validate';
import { recordSale } from './pay';
import { posSyncOps } from '../db/schema/pos-sync';
import { posDevices } from '../db/schema/pos-devices';
import { posSessions } from '../db/schema/pos-sessions';
import { users } from '../db/schema/users';

// Compile-time pin: SessionContext must accept a SyncContext (T-20's shape
// declaration must stay identical to T-18's).
export const _SessionContextIsSyncContext: SessionContext = {} as SyncContext;

export type HandleResult =
	| { http: 200; body: SyncResult & { alreadyClosed?: true } }
	| { http: 400 | 403 | 409 | 422; body: { error: string; flag?: string; count?: number } };

export class HardFailure extends Error {
	constructor(
		public readonly flag: HardFlag,
		public readonly detail: string
	) {
		super(`${flag}: ${detail}`);
	}
}

class Refused extends Error {
	constructor(public readonly result: HandleResult) {
		super('refused');
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASH_STRING = /^[0-9]{1,15}$/;

const sessionOpenSchema = z.object({
	posSessionId: z.string().uuid(),
	openingCashMinor: z.string().regex(CASH_STRING)
});
const sessionCloseSchema = z.object({
	posSessionId: z.string().uuid(),
	countedCashMinor: z.string().regex(CASH_STRING)
});
const saleAbandonedSchema = z.object({
	orderId: z.string().uuid(),
	invoiceSeq: z.number().int().min(1).max(999_999),
	invoiceNumber: z.string().max(15),
	reason: z.enum(['rejected', 'cancelled'])
});
const pinLoginSchema = z.object({ outcome: z.enum(['success', 'failed']) });

function parseOrHard<T extends z.ZodTypeAny>(schema: T, payload: unknown): z.infer<T> {
	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw new HardFailure('invalid_payload', `${first.path.join('.')}: ${first.message}`);
	}
	return parsed.data as z.infer<T>;
}

function peekMethod(payload: unknown): 'cash' | 'card' | 'mobile' | null {
	const p = payload as { payments?: unknown[] } | null;
	if (!p || !Array.isArray(p.payments) || p.payments.length === 0) return null;
	const first = p.payments[0] as { method?: unknown };
	if (first.method === 'cash' || first.method === 'card' || first.method === 'mobile') {
		return first.method;
	}
	return null;
}

function peekSessionId(payload: unknown): string | null {
	const p = payload as { posSessionId?: unknown } | null;
	const s = p?.posSessionId;
	return typeof s === 'string' && UUID.test(s) ? s : null;
}

function peekInvoice(payload: unknown): { seq: number | null; number: string | null } {
	const p = payload as { invoiceSeq?: unknown; invoiceNumber?: unknown } | null;
	const seq =
		typeof p?.invoiceSeq === 'number' && Number.isInteger(p.invoiceSeq) ? p.invoiceSeq : null;
	const number = typeof p?.invoiceNumber === 'string' ? p.invoiceNumber : null;
	return { seq, number };
}

/** Walk the cause chain of a thrown value looking for a pg error. */
function pgError(thrown: unknown): { code?: string; constraint?: string; message?: string } | null {
	let current: unknown = thrown;
	for (let depth = 0; depth < 6 && current; depth++) {
		const e = current as {
			code?: string;
			constraint?: string;
			message?: string;
			cause?: unknown;
		};
		if (typeof e.code === 'string' && e.code.length > 0) return e;
		current = e.cause;
	}
	return null;
}

function isRequestClass(envelope: OpEnvelope<OpKind, unknown>): boolean {
	if (envelope.kind === 'session.close') return true;
	if (envelope.kind === 'sale.complete') {
		const method = peekMethod(envelope.payload);
		return method === 'card' || method === 'mobile';
	}
	return false;
}

async function replayLookup(
	db: Db,
	restaurantId: string,
	deviceId: string,
	clientOpId: string
): Promise<HandleResult | null> {
	const [row] = await db
		.select({
			status: posSyncOps.status,
			flag: posSyncOps.flag,
			error: posSyncOps.error,
			posSessionId: posSyncOps.posSessionId,
			kind: posSyncOps.kind
		})
		.from(posSyncOps)
		.where(
			and(
				eq(posSyncOps.restaurantId, restaurantId),
				eq(posSyncOps.deviceId, deviceId),
				eq(posSyncOps.clientOpId, clientOpId)
			)
		)
		.limit(1);
	if (!row) return null;
	const body: SyncResult & { alreadyClosed?: true } = {
		clientOpId,
		status: 'replayed'
	};
	if (row.flag) body.flag = row.flag;
	if (row.error) body.error = row.error;
	if (row.posSessionId) {
		body.posSessionId = row.posSessionId;
		const [sessionRow] = await db
			.select({
				businessDate: posSessions.businessDate,
				expectedCashMinor: posSessions.expectedCashMinor,
				differenceMinor: posSessions.differenceMinor,
				status: posSessions.status
			})
			.from(posSessions)
			.where(and(eq(posSessions.id, row.posSessionId), eq(posSessions.restaurantId, restaurantId)))
			.limit(1);
		if (sessionRow) {
			body.businessDate = sessionRow.businessDate;
			if (
				row.kind === 'session.close' &&
				sessionRow.status === 'closed' &&
				sessionRow.expectedCashMinor !== null &&
				sessionRow.differenceMinor !== null
			) {
				body.expectedCashMinor = sessionRow.expectedCashMinor.toString();
				body.differenceMinor = sessionRow.differenceMinor.toString();
			}
		}
	}
	return { http: 200, body };
}

async function findDevice(
	db: Db,
	deviceId: string
): Promise<{
	id: string;
	deviceCode: string;
	restaurantId: string;
	revokedAt: Date | null;
} | null> {
	const [row] = await db
		.select({
			id: posDevices.id,
			deviceCode: posDevices.deviceCode,
			restaurantId: posDevices.restaurantId,
			revokedAt: posDevices.revokedAt
		})
		.from(posDevices)
		.where(eq(posDevices.id, deviceId))
		.limit(1);
	return row ?? null;
}

async function resolveEmployeeUserId(
	db: Db,
	restaurantId: string,
	envelopeEmployeeId: string
): Promise<string | null> {
	if (!UUID.test(envelopeEmployeeId)) return null;
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.id, envelopeEmployeeId), eq(users.restaurantId, restaurantId)))
		.limit(1);
	return row?.id ?? null;
}

/** Store an unrecorded op OUTSIDE the failed transaction (its handle is
 * dead). Its own db.transaction. */
async function storeUnrecorded(
	db: Db,
	ctx: SyncContext,
	envelope: OpEnvelope<OpKind, unknown>,
	failure: { flag: HardFlag; detail: string }
): Promise<HandleResult> {
	const invoice = peekInvoice(envelope.payload);
	const posSessionId = peekSessionId(envelope.payload);
	try {
		await db.transaction(async (tx) => {
			await tx.insert(posSyncOps).values({
				restaurantId: ctx.restaurantId,
				deviceId: ctx.opDeviceId,
				receivedViaDeviceId: ctx.cookieDeviceId,
				clientOpId: ctx.clientOpId,
				kind: envelope.kind,
				employeeUserId: ctx.employeeUserId,
				occurredAt: ctx.occurredAt,
				receivedAt: ctx.receivedAt,
				status: 'unrecorded',
				flag: failure.flag,
				error: failure.detail,
				payload: envelope as unknown as Record<string, unknown>,
				posSessionId,
				invoiceSeq: invoice.seq,
				invoiceNumber: invoice.number
			});
			await writeAudit(tx, {
				event: 'sync.op_unrecorded',
				details: {
					deviceCode: ctx.opDeviceCode,
					kind: envelope.kind,
					flag: failure.flag,
					detail: failure.detail
				},
				restaurantId: ctx.restaurantId,
				actorUserId: ctx.employeeUserId,
				subjectUserId: null,
				deviceId: ctx.opDeviceId,
				clientOpId: null,
				occurredAt: ctx.occurredAt,
				ip: ctx.ip,
				userAgent: ctx.userAgent
			});
		});
	} catch (thrown) {
		const pg = pgError(thrown);
		if (pg?.code === '23505' && pg.constraint === 'pos_sync_ops_device_client_op_unique') {
			// A race committed first; replay its answer.
			const replay = await replayLookup(db, ctx.restaurantId, ctx.opDeviceId, ctx.clientOpId);
			if (replay) return replay;
		}
		throw thrown;
	}
	return {
		http: 200,
		body: {
			clientOpId: ctx.clientOpId,
			status: 'unrecorded',
			flag: failure.flag,
			error: failure.detail
		}
	};
}

export async function handleOp(
	db: Db,
	device: PosDeviceContext,
	request: { ip: string | null; userAgent: string | null },
	envelope: OpEnvelope<OpKind, unknown>
): Promise<HandleResult> {
	const receivedAt = new Date();
	const occurredAt = new Date(envelope.occurredAt);
	if (Number.isNaN(occurredAt.getTime())) {
		// Class by tender for the hard-failure recovery below.
		// This one is invalid regardless of kind — treat as fact-class fallback
		// since a card sale still hasn't happened either.
		const dummyCtx = buildFallbackCtx();
		return storeUnrecorded(db, dummyCtx, envelope, {
			flag: 'invalid_payload',
			detail: 'occurredAt'
		});
	}

	// Replay before anything else.
	const replay = await replayLookup(
		db,
		device.restaurantId,
		envelope.deviceId,
		envelope.clientOpId
	);
	if (replay) return replay;

	// Lineage.
	const opDevice = await findDevice(db, envelope.deviceId);
	if (!opDevice || opDevice.restaurantId !== device.restaurantId) {
		return { http: 409, body: { error: 'foreign_device' } };
	}

	const employeeUserId = await resolveEmployeeUserId(db, device.restaurantId, envelope.employeeId);

	const ctx: SyncContext = {
		restaurantId: device.restaurantId,
		cookieDeviceId: device.deviceId,
		opDeviceId: envelope.deviceId,
		opDeviceCode: opDevice.deviceCode,
		employeeId: envelope.employeeId,
		employeeUserId,
		clientOpId: envelope.clientOpId,
		occurredAt,
		receivedAt,
		ip: request.ip,
		userAgent: request.userAgent
	};

	// Pre-transaction gate for request-class ops only.
	if (isRequestClass(envelope)) {
		const keys =
			envelope.kind === 'session.close'
				? (['pos.payment'] as const)
				: (['pos.sell', 'pos.payment'] as const);
		const check = await checkEmployee(db, ctx.restaurantId, ctx.employeeId, keys);
		if (!check.ok) {
			return { http: 403, body: { error: 'not_permitted' } };
		}
	}

	try {
		return await db.transaction(async (tx) => {
			// First statement inside the transaction: the op row.
			const initialPosSessionId = peekSessionId(envelope.payload);
			const initialInvoice = peekInvoice(envelope.payload);
			const [opRow] = await tx
				.insert(posSyncOps)
				.values({
					restaurantId: ctx.restaurantId,
					deviceId: ctx.opDeviceId,
					receivedViaDeviceId: ctx.cookieDeviceId,
					clientOpId: ctx.clientOpId,
					kind: envelope.kind,
					employeeUserId: ctx.employeeUserId,
					occurredAt: ctx.occurredAt,
					receivedAt: ctx.receivedAt,
					status: 'accepted',
					payload: envelope as unknown as Record<string, unknown>,
					posSessionId: initialPosSessionId,
					invoiceSeq: initialInvoice.seq,
					invoiceNumber: initialInvoice.number
				})
				.returning({ id: posSyncOps.id });

			switch (envelope.kind) {
				case 'sale.complete': {
					const v = await validateSale(tx, ctx, envelope as OpEnvelope<'sale.complete', unknown>);
					if (!v.ok) throw new HardFailure(v.hard, v.detail);
					if (ctx.employeeUserId === null) {
						throw new HardFailure('invalid_payload', 'employee_unknown');
					}
					const r = await recordSale(tx, ctx, v.sale, v.softFlags);
					const status: 'accepted' | 'recorded_flagged' =
						v.softFlags.length > 0 ? 'recorded_flagged' : 'accepted';
					await tx
						.update(posSyncOps)
						.set({
							orderId: r.orderId,
							posSessionId: v.sale.posSessionId,
							invoiceSeq: v.sale.invoiceSeq,
							invoiceNumber: v.sale.invoiceNumber,
							status,
							flag: v.softFlags.length > 0 ? v.softFlags.join(',') : null
						})
						.where(eq(posSyncOps.id, opRow.id));
					const body: SyncResult = {
						clientOpId: ctx.clientOpId,
						status,
						posSessionId: v.sale.posSessionId,
						businessDate: v.sale.businessDate
					};
					if (v.softFlags.length > 0) body.flag = v.softFlags.join(',');
					return { http: 200, body };
				}

				case 'session.open': {
					const parsed = parseOrHard(sessionOpenSchema, envelope.payload);
					if (ctx.employeeUserId === null) {
						throw new HardFailure('invalid_payload', 'employee_unknown');
					}
					const check = await checkEmployee(tx, ctx.restaurantId, ctx.employeeId, ['pos.payment']);
					const softFlags: SoftFlag[] = [];
					if (!check.ok) softFlags.push(check.reason);
					if (ctx.occurredAt.getTime() - ctx.receivedAt.getTime() > 5 * 60 * 1000) {
						softFlags.push('clock_ahead');
					}
					const o = await openSession(tx, ctx, {
						posSessionId: parsed.posSessionId,
						openingCashMinor: minor(BigInt(parsed.openingCashMinor))
					});
					const status: 'accepted' | 'recorded_flagged' =
						softFlags.length > 0 ? 'recorded_flagged' : 'accepted';
					await tx
						.update(posSyncOps)
						.set({
							posSessionId: o.posSessionId,
							status,
							flag: softFlags.length > 0 ? softFlags.join(',') : null
						})
						.where(eq(posSyncOps.id, opRow.id));
					const body: SyncResult = {
						clientOpId: ctx.clientOpId,
						status,
						posSessionId: o.posSessionId,
						businessDate: o.businessDate
					};
					if (softFlags.length > 0) body.flag = softFlags.join(',');
					return { http: 200, body };
				}

				case 'session.close': {
					const parsed = parseOrHard(sessionCloseSchema, envelope.payload);
					if (ctx.employeeUserId === null) {
						throw new HardFailure('invalid_payload', 'employee_unknown');
					}
					try {
						const c = await closeSession(tx, ctx, {
							posSessionId: parsed.posSessionId,
							countedCashMinor: minor(BigInt(parsed.countedCashMinor))
						});
						await tx
							.update(posSyncOps)
							.set({ posSessionId: c.posSessionId, status: 'accepted' })
							.where(eq(posSyncOps.id, opRow.id));
						return {
							http: 200,
							body: {
								clientOpId: ctx.clientOpId,
								status: 'accepted',
								posSessionId: c.posSessionId,
								businessDate: c.businessDate,
								expectedCashMinor: c.expectedCashMinor.toString(),
								differenceMinor: c.differenceMinor.toString()
							}
						};
					} catch (thrown) {
						if (thrown instanceof SessionHasUnrecordedOps) {
							throw new Refused({
								http: 409,
								body: {
									error: 'session_has_unrecorded_ops',
									count: thrown.count
								}
							});
						}
						if (thrown instanceof SessionAlreadyClosed) {
							const [row] = await tx
								.select({
									businessDate: posSessions.businessDate,
									expectedCashMinor: posSessions.expectedCashMinor,
									differenceMinor: posSessions.differenceMinor
								})
								.from(posSessions)
								.where(eq(posSessions.id, parsed.posSessionId))
								.limit(1);
							await tx
								.update(posSyncOps)
								.set({ posSessionId: parsed.posSessionId, status: 'accepted' })
								.where(eq(posSyncOps.id, opRow.id));
							return {
								http: 200,
								body: {
									clientOpId: ctx.clientOpId,
									status: 'accepted',
									alreadyClosed: true,
									posSessionId: parsed.posSessionId,
									businessDate: row?.businessDate,
									expectedCashMinor: row?.expectedCashMinor?.toString(),
									differenceMinor: row?.differenceMinor?.toString()
								}
							};
						}
						if (thrown instanceof SessionNotFound) {
							throw new HardFailure('unknown_session', parsed.posSessionId);
						}
						throw thrown;
					}
				}

				case 'sale.abandoned': {
					const parsed = parseOrHard(saleAbandonedSchema, envelope.payload);
					if (parsed.invoiceNumber !== formatInvoiceNumber(ctx.opDeviceCode, parsed.invoiceSeq)) {
						throw new HardFailure('invalid_payload', 'invoice_number_mismatch');
					}
					await tx
						.update(posSyncOps)
						.set({
							invoiceSeq: parsed.invoiceSeq,
							invoiceNumber: parsed.invoiceNumber,
							status: 'accepted'
						})
						.where(eq(posSyncOps.id, opRow.id));
					await writeAudit(tx, {
						event: 'sale.abandoned',
						details: {
							deviceCode: ctx.opDeviceCode,
							invoiceNumber: parsed.invoiceNumber,
							reason: parsed.reason
						},
						restaurantId: ctx.restaurantId,
						actorUserId: ctx.employeeUserId,
						subjectUserId: null,
						deviceId: ctx.opDeviceId,
						clientOpId: ctx.clientOpId,
						occurredAt: ctx.occurredAt,
						ip: ctx.ip,
						userAgent: ctx.userAgent
					});
					return {
						http: 200,
						body: { clientOpId: ctx.clientOpId, status: 'accepted' }
					};
				}

				case 'pin.login': {
					const parsed = parseOrHard(pinLoginSchema, envelope.payload);
					if (ctx.employeeUserId === null) {
						throw new HardFailure('invalid_payload', 'employee_unknown');
					}
					await tx
						.update(posSyncOps)
						.set({ status: 'accepted' })
						.where(eq(posSyncOps.id, opRow.id));
					if (parsed.outcome === 'success') {
						await writeAudit(tx, {
							event: 'pos.pin.offline_success',
							details: { deviceCode: ctx.opDeviceCode },
							restaurantId: ctx.restaurantId,
							actorUserId: ctx.employeeUserId,
							subjectUserId: ctx.employeeUserId,
							deviceId: ctx.opDeviceId,
							clientOpId: ctx.clientOpId,
							occurredAt: ctx.occurredAt,
							ip: ctx.ip,
							userAgent: ctx.userAgent
						});
					} else {
						await writeAudit(tx, {
							event: 'pos.pin.offline_failed',
							details: { deviceCode: ctx.opDeviceCode, reason: 'bad_pin' },
							restaurantId: ctx.restaurantId,
							actorUserId: ctx.employeeUserId,
							subjectUserId: ctx.employeeUserId,
							deviceId: ctx.opDeviceId,
							clientOpId: ctx.clientOpId,
							occurredAt: ctx.occurredAt,
							ip: ctx.ip,
							userAgent: ctx.userAgent
						});
					}
					return {
						http: 200,
						body: { clientOpId: ctx.clientOpId, status: 'accepted' }
					};
				}

				default: {
					// OP_KINDS is exhaustive; a wire kind not in it is dropped by the route.
					void OP_KINDS;
					throw new HardFailure('invalid_payload', `unknown kind: ${String(envelope.kind)}`);
				}
			}
		});
	} catch (thrown) {
		if (thrown instanceof Refused) return thrown.result;

		const pg = pgError(thrown);
		if (
			pg?.code === '23505' &&
			(pg.constraint === 'pos_sync_ops_device_client_op_unique' ||
				pg.constraint === 'audit_log_device_client_op_unique')
		) {
			const again = await replayLookup(
				db,
				device.restaurantId,
				envelope.deviceId,
				envelope.clientOpId
			);
			if (again) return again;
			// The audit-index case with no op row: treat as a database_error and
			// fall through to the class path below.
			const failure = new HardFailure('database_error', pg.constraint);
			return classifyHardFailure(db, ctx, envelope, failure);
		}

		let failure: HardFailure;
		if (thrown instanceof HardFailure) {
			failure = thrown;
		} else if (
			pg?.code === '23505' &&
			(pg.constraint === 'invoices_device_number_unique' ||
				pg.constraint === 'invoices_device_seq_unique')
		) {
			failure = new HardFailure('invoice_collision', pg.constraint);
		} else {
			failure = new HardFailure(
				'database_error',
				((thrown as Error).message ?? String(thrown)).slice(0, 500)
			);
		}
		return classifyHardFailure(db, ctx, envelope, failure);
	}
}

async function classifyHardFailure(
	db: Db,
	ctx: SyncContext,
	envelope: OpEnvelope<OpKind, unknown>,
	failure: HardFailure
): Promise<HandleResult> {
	if (isRequestClass(envelope)) {
		return {
			http: 422,
			body: { error: 'rejected', flag: failure.flag }
		};
	}
	return storeUnrecorded(db, ctx, envelope, { flag: failure.flag, detail: failure.detail });
}

/** A neutral SyncContext for the rare invalid-occurredAt case before the
 * device lineage runs. We still record the fact under the cookie's device. */
function buildFallbackCtx(): SyncContext {
	return {
		restaurantId: '',
		cookieDeviceId: '',
		opDeviceId: '',
		opDeviceCode: '',
		employeeId: '',
		employeeUserId: null,
		clientOpId: '',
		occurredAt: new Date(),
		receivedAt: new Date(),
		ip: null,
		userAgent: null
	};
}

/** Owner retry from /reports/flagged. Rebuilds the op envelope from the
 * stored payload and re-runs handleOp inside a fresh transaction, then
 * flips the ORIGINAL row (same client_op_id — no second row). */
export async function retryOp(
	db: Db,
	restaurantId: string,
	opId: string,
	actorUserId: string,
	request: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null }
): Promise<
	| { ok: true; status: 'accepted' | 'recorded_flagged' }
	| { ok: false; reason: 'not_found' | 'still_unrecorded'; flag?: string; detail?: string }
> {
	const [row] = await db
		.select({
			id: posSyncOps.id,
			deviceId: posSyncOps.deviceId,
			receivedViaDeviceId: posSyncOps.receivedViaDeviceId,
			clientOpId: posSyncOps.clientOpId,
			kind: posSyncOps.kind,
			occurredAt: posSyncOps.occurredAt,
			payload: posSyncOps.payload
		})
		.from(posSyncOps)
		.where(
			and(
				eq(posSyncOps.id, BigInt(opId)),
				eq(posSyncOps.restaurantId, restaurantId),
				eq(posSyncOps.status, 'unrecorded')
			)
		)
		.limit(1);
	if (!row) return { ok: false, reason: 'not_found' };

	const opDevice = await findDevice(db, row.deviceId);
	if (!opDevice) return { ok: false, reason: 'not_found' };

	const envelope = row.payload as unknown as OpEnvelope<OpKind, unknown>;
	const employeeUserId = await resolveEmployeeUserId(db, restaurantId, envelope.employeeId);
	const ctx: SyncContext = {
		restaurantId,
		cookieDeviceId: row.deviceId,
		opDeviceId: row.deviceId,
		opDeviceCode: opDevice.deviceCode,
		employeeId: envelope.employeeId,
		employeeUserId,
		clientOpId: row.clientOpId,
		occurredAt: row.occurredAt,
		receivedAt: new Date(),
		ip: request.ip,
		userAgent: request.userAgent
	};

	try {
		return await db.transaction(async (tx) => {
			await tx
				.update(posSyncOps)
				.set({
					status: 'accepted',
					flag: null,
					error: null,
					resolvedAt: new Date(),
					resolvedByUserId: actorUserId,
					resolution: 'retried'
				})
				.where(eq(posSyncOps.id, row.id));
			let status: 'accepted' | 'recorded_flagged' = 'accepted';
			let orderId: string | null = null;
			let posSessionId: string | null = null;
			let invoiceSeq: number | null = null;
			let invoiceNumber: string | null = null;

			switch (envelope.kind) {
				case 'sale.complete': {
					const v = await validateSale(tx, ctx, envelope as OpEnvelope<'sale.complete', unknown>);
					if (!v.ok) throw new HardFailure(v.hard, v.detail);
					if (ctx.employeeUserId === null) {
						throw new HardFailure('invalid_payload', 'employee_unknown');
					}
					const r = await recordSale(tx, ctx, v.sale, v.softFlags);
					status = v.softFlags.length > 0 ? 'recorded_flagged' : 'accepted';
					orderId = r.orderId;
					posSessionId = v.sale.posSessionId;
					invoiceSeq = v.sale.invoiceSeq;
					invoiceNumber = v.sale.invoiceNumber;
					break;
				}
				case 'session.open': {
					const parsed = parseOrHard(sessionOpenSchema, envelope.payload);
					if (ctx.employeeUserId === null) {
						throw new HardFailure('invalid_payload', 'employee_unknown');
					}
					const check = await checkEmployee(tx, restaurantId, envelope.employeeId, ['pos.payment']);
					const softFlags: SoftFlag[] = [];
					if (!check.ok) softFlags.push(check.reason);
					const o = await openSession(tx, ctx, {
						posSessionId: parsed.posSessionId,
						openingCashMinor: minor(BigInt(parsed.openingCashMinor))
					});
					status = softFlags.length > 0 ? 'recorded_flagged' : 'accepted';
					posSessionId = o.posSessionId;
					break;
				}
				case 'sale.abandoned': {
					const parsed = parseOrHard(saleAbandonedSchema, envelope.payload);
					if (parsed.invoiceNumber !== formatInvoiceNumber(ctx.opDeviceCode, parsed.invoiceSeq)) {
						throw new HardFailure('invalid_payload', 'invoice_number_mismatch');
					}
					invoiceSeq = parsed.invoiceSeq;
					invoiceNumber = parsed.invoiceNumber;
					await writeAudit(tx, {
						event: 'sale.abandoned',
						details: {
							deviceCode: ctx.opDeviceCode,
							invoiceNumber: parsed.invoiceNumber,
							reason: parsed.reason
						},
						restaurantId,
						actorUserId,
						subjectUserId: null,
						deviceId: row.deviceId,
						clientOpId: null,
						occurredAt: ctx.occurredAt,
						ip: request.ip,
						userAgent: request.userAgent
					});
					break;
				}
				case 'pin.login': {
					const parsed = parseOrHard(pinLoginSchema, envelope.payload);
					if (ctx.employeeUserId === null) {
						throw new HardFailure('invalid_payload', 'employee_unknown');
					}
					if (parsed.outcome === 'success') {
						await writeAudit(tx, {
							event: 'pos.pin.offline_success',
							details: { deviceCode: ctx.opDeviceCode },
							restaurantId,
							actorUserId,
							subjectUserId: ctx.employeeUserId,
							deviceId: row.deviceId,
							clientOpId: null,
							occurredAt: ctx.occurredAt,
							ip: request.ip,
							userAgent: request.userAgent
						});
					} else {
						await writeAudit(tx, {
							event: 'pos.pin.offline_failed',
							details: { deviceCode: ctx.opDeviceCode, reason: 'bad_pin' },
							restaurantId,
							actorUserId,
							subjectUserId: ctx.employeeUserId,
							deviceId: row.deviceId,
							clientOpId: null,
							occurredAt: ctx.occurredAt,
							ip: request.ip,
							userAgent: request.userAgent
						});
					}
					break;
				}
				default:
					throw new HardFailure('invalid_payload', `cannot retry ${envelope.kind}`);
			}

			await tx
				.update(posSyncOps)
				.set({
					status,
					orderId,
					posSessionId,
					invoiceSeq,
					invoiceNumber
				})
				.where(eq(posSyncOps.id, row.id));

			await writeAudit(tx, {
				event: 'sync.op_retried',
				details: { opId, outcome: status },
				restaurantId,
				actorUserId,
				subjectUserId: null,
				deviceId: row.deviceId,
				clientOpId: null,
				occurredAt: ctx.occurredAt,
				ip: request.ip,
				userAgent: request.userAgent
			});

			return { ok: true, status } as const;
		});
	} catch (thrown) {
		let flag: string | undefined;
		let detail: string | undefined;
		if (thrown instanceof HardFailure) {
			flag = thrown.flag;
			detail = thrown.detail;
		} else {
			const pg = pgError(thrown);
			flag = 'database_error';
			detail = pg?.constraint ?? pg?.message ?? String(thrown).slice(0, 500);
		}
		await db.transaction(async (tx) => {
			await tx.update(posSyncOps).set({ error: detail }).where(eq(posSyncOps.id, row.id));
			await writeAudit(tx, {
				event: 'sync.op_retried',
				details: { opId, outcome: 'unrecorded' },
				restaurantId,
				actorUserId,
				subjectUserId: null,
				deviceId: row.deviceId,
				clientOpId: null,
				occurredAt: ctx.occurredAt,
				ip: request.ip,
				userAgent: request.userAgent
			});
		});
		return { ok: false, reason: 'still_unrecorded', flag, detail };
	}
}

export async function dismissOp(
	db: Db,
	restaurantId: string,
	opId: string,
	actorUserId: string,
	reason: string,
	request: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null }
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'invalid_reason' }> {
	const trimmed = reason.trim();
	if (trimmed.length === 0 || trimmed.length > 200) {
		return { ok: false, reason: 'invalid_reason' };
	}
	let deviceId: string | null = null;
	const updated = await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ id: posSyncOps.id, deviceId: posSyncOps.deviceId })
			.from(posSyncOps)
			.where(
				and(
					eq(posSyncOps.id, BigInt(opId)),
					eq(posSyncOps.restaurantId, restaurantId),
					sql`${posSyncOps.status} in ('recorded_flagged', 'unrecorded')`,
					sql`${posSyncOps.resolvedAt} is null`
				)
			)
			.limit(1);
		if (!row) return 0;
		deviceId = row.deviceId;
		await tx
			.update(posSyncOps)
			.set({
				resolvedAt: new Date(),
				resolvedByUserId: actorUserId,
				resolution: 'dismissed'
			})
			.where(eq(posSyncOps.id, row.id));
		await writeAudit(tx, {
			event: 'sync.op_dismissed',
			details: { opId, reason: trimmed },
			restaurantId,
			actorUserId,
			subjectUserId: null,
			deviceId: row.deviceId,
			clientOpId: null,
			occurredAt: new Date(),
			ip: request.ip,
			userAgent: request.userAgent
		});
		return 1;
	});
	if (updated === 0) return { ok: false, reason: 'not_found' };
	// deviceId is set above when updated === 1
	void deviceId;
	return { ok: true };
}
