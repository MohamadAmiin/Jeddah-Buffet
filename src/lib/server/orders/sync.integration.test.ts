import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { onRestaurantCreated, updateSettings } from '../restaurants';
import { registerDevice } from '../auth/pos-device';
import { createCategory, createItem, getMenuVersion } from '../menu';
import { seedStaff } from '../db/test/seed';
import { closeTestDb, testDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { posSyncOps } from '../db/schema/pos-sync';
import { orders, invoices } from '../db/schema/orders';
import { journalEntries } from '../db/schema/accounting';
import { auditLog } from '../db/schema/audit';
import { posSessions } from '../db/schema/pos-sessions';
import type { PosDeviceContext } from '../auth/pos-context';
import type { OpEnvelope, OpKind } from '../../sync-ops';
import { dismissOp, handleOp, retryOp } from './sync';

afterAll(async () => {
	await closeTestDb();
});

type Fixture = {
	restaurantId: string;
	ownerId: string;
	deviceId: string;
	deviceCode: string;
	cashierId: string;
	waiterId: string;
	teaId: string;
	menuVersion: number;
	sessionId: string;
};

async function requireId<T>(p: Promise<T | { ok: false }>): Promise<string> {
	const r = (await p) as { ok: boolean; id?: string };
	if (!r.ok || typeof r.id !== 'string') throw new Error('menu helper failed');
	return r.id;
}

async function makeFixture(email: string): Promise<Fixture> {
	const [r] = await testDb().insert(restaurants).values({ name: 'Cafe Sync' }).returning({
		id: restaurants.id
	});
	const restaurantId = r.id;
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurantId, { restaurantName: 'Cafe Sync', timeZone: 'UTC' })
	);
	const [owner] = await testDb()
		.insert(users)
		.values({
			restaurantId,
			role: 'owner',
			displayName: 'Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });
	await db.transaction((tx) =>
		updateSettings(
			tx,
			restaurantId,
			{
				taxMode: 'exclusive',
				taxRateBp: 1000,
				currencyCode: 'USD',
				posIdleLockSeconds: 120
			},
			{ actorUserId: owner.id, ip: null, userAgent: null }
		)
	);
	await testDb()
		.update(restaurantSettings)
		.set({ acceptsCard: true, acceptsMobile: true })
		.where(eq(restaurantSettings.restaurantId, restaurantId));
	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId, actorUserId: owner.id, label: 'Counter' })
	);
	const categoryId = await db.transaction((tx) =>
		requireId(createCategory(tx, restaurantId, { name: 'Drinks' }))
	);
	const teaId = await db.transaction((tx) =>
		requireId(createItem(tx, restaurantId, { categoryId, name: 'Tea', priceMinor: 850n }))
	);
	const cashier = await seedStaff(db, restaurantId, { displayName: 'Sam', roleName: 'Cashier' });
	const waiter = await seedStaff(db, restaurantId, { displayName: 'Wren', roleName: 'Waiter' });
	// Open the session through handleOp so the whole flow is real.
	const posSessionId = randomUUID();
	const posDeviceCtx: PosDeviceContext = {
		restaurantId,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode
	};
	const openEnv: OpEnvelope<OpKind, unknown> = {
		kind: 'session.open',
		clientOpId: randomUUID(),
		deviceId: device.deviceId,
		employeeId: cashier.id,
		occurredAt: new Date().toISOString(),
		seq: 1,
		payload: { posSessionId, openingCashMinor: '0' }
	};
	const openResult = await handleOp(db, posDeviceCtx, { ip: null, userAgent: null }, openEnv);
	if (openResult.http !== 200) throw new Error('fixture open failed');
	const menuVersion = await getMenuVersion(testDb(), restaurantId);
	return {
		restaurantId,
		ownerId: owner.id,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode,
		cashierId: cashier.id,
		waiterId: waiter.id,
		teaId,
		menuVersion,
		sessionId: posSessionId
	};
}

function posDeviceCtx(fx: Fixture): PosDeviceContext {
	return { restaurantId: fx.restaurantId, deviceId: fx.deviceId, deviceCode: fx.deviceCode };
}

function saleEnv(
	fx: Fixture,
	overrides: {
		clientOpId?: string;
		employeeId?: string;
		method?: 'cash' | 'card' | 'mobile';
		invoiceSeq?: number;
		invoiceNumber?: string;
		posSessionId?: string;
		unitPriceMinor?: string;
		totals?: { subtotalMinor: string; discountMinor: string; taxMinor: string; totalMinor: string };
	} = {}
): OpEnvelope<OpKind, unknown> {
	const invoiceSeq = overrides.invoiceSeq ?? 1;
	const method = overrides.method ?? 'cash';
	const totals = overrides.totals ?? {
		subtotalMinor: '850',
		discountMinor: '0',
		taxMinor: '85',
		totalMinor: '935'
	};
	const payments =
		method === 'cash'
			? [
					{
						paymentId: randomUUID(),
						method: 'cash',
						amountMinor: totals.totalMinor,
						tenderedMinor: '2000',
						changeMinor: String(Number(2000) - Number(totals.totalMinor))
					}
				]
			: [
					{
						paymentId: randomUUID(),
						method,
						amountMinor: totals.totalMinor,
						tenderedMinor: null,
						changeMinor: null
					}
				];
	return {
		kind: 'sale.complete',
		clientOpId: overrides.clientOpId ?? randomUUID(),
		deviceId: fx.deviceId,
		employeeId: overrides.employeeId ?? fx.cashierId,
		occurredAt: new Date().toISOString(),
		seq: 1,
		payload: {
			orderId: randomUUID(),
			posSessionId: overrides.posSessionId ?? fx.sessionId,
			orderType: 'takeaway',
			tableLabel: null,
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: fx.menuVersion,
			invoiceSeq,
			invoiceNumber:
				overrides.invoiceNumber ?? `${fx.deviceCode}-${String(invoiceSeq).padStart(6, '0')}`,
			openedAt: new Date().toISOString(),
			lines: [
				{
					lineId: randomUUID(),
					lineNo: 1,
					menuItemId: fx.teaId,
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: overrides.unitPriceMinor ?? '850',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: []
				}
			],
			totals,
			payments
		}
	};
}

let fx: Fixture;
beforeEach(async () => {
	fx = await makeFixture(`sync-${randomUUID()}@example.com`);
});

describe('MANDATORY (spec 29) — retries never create duplicates', () => {
	it('the same envelope twice: accepted then replayed; every count is 1', async () => {
		const env = saleEnv(fx);
		const first = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(first.http).toBe(200);
		if (first.http === 200) expect(first.body.status).toBe('accepted');
		const second = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(second.http).toBe(200);
		if (second.http === 200) expect(second.body.status).toBe('replayed');

		const opCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(posSyncOps)
			.where(eq(posSyncOps.restaurantId, fx.restaurantId));
		expect(opCount[0].c).toBe('2'); // one session.open + one sale.complete
		const orderCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(orders)
			.where(eq(orders.restaurantId, fx.restaurantId));
		expect(orderCount[0].c).toBe('1');
		const invoiceCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(invoices)
			.where(eq(invoices.restaurantId, fx.restaurantId));
		expect(invoiceCount[0].c).toBe('1');
	});

	it('concurrent duplicates leave one order; the loser replays', async () => {
		const env = saleEnv(fx);
		const [a, b] = await Promise.all([
			handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env),
			handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env)
		]);
		expect(a.http).toBe(200);
		expect(b.http).toBe(200);
		const statuses = [a, b]
			.map((r) => (r.http === 200 ? r.body.status : null))
			.filter((s) => s !== null);
		expect(statuses).toContain('accepted');
		expect(statuses).toContain('replayed');

		const orderCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(orders)
			.where(eq(orders.restaurantId, fx.restaurantId));
		expect(orderCount[0].c).toBe('1');
	});

	// MANDATORY (spec 29 — offline sync: retries never create duplicates), for the
	// order type menu-and-printing T-09 adds.
	it('a delivery sale sent twice: accepted then replayed; one order, one invoice, one entry set', async () => {
		const env = saleEnv(fx);
		const payload = env.payload as { orderId: string; orderType: string };
		payload.orderType = 'delivery';

		const first = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(first.http).toBe(200);
		if (first.http === 200) expect(first.body.status).toBe('accepted');
		const second = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(second.http).toBe(200);
		if (second.http === 200) expect(second.body.status).toBe('replayed');

		const count = (q: Promise<{ c: string }[]>) => q.then((rows) => rows[0].c);
		expect(
			await count(
				testDb()
					.select({ c: sql<string>`count(*)::text` })
					.from(orders)
					.where(eq(orders.id, payload.orderId))
			)
		).toBe('1');
		expect(
			await count(
				testDb()
					.select({ c: sql<string>`count(*)::text` })
					.from(invoices)
					.where(eq(invoices.orderId, payload.orderId))
			)
		).toBe('1');
		expect(
			await count(
				testDb()
					.select({ c: sql<string>`count(*)::text` })
					.from(journalEntries)
					.where(eq(journalEntries.sourceId, payload.orderId))
			)
		).toBe('1');
		const [orderRow] = await testDb().select().from(orders).where(eq(orders.id, payload.orderId));
		expect(orderRow.orderType).toBe('delivery');
	});
});

describe('device lineage', () => {
	it('an envelope naming another restaurant’s device gets 409 foreign_device with nothing stored', async () => {
		const other = await makeFixture(`sync-other-${randomUUID()}@example.com`);
		const env = saleEnv(fx);
		(env as { deviceId: string }).deviceId = other.deviceId;
		const result = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(result.http).toBe(409);
		if (result.http === 409) expect(result.body.error).toBe('foreign_device');
		const opCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(opCount[0].c).toBe('0');
	});
});

describe('fact-class flags', () => {
	it('cash sale with unknown employee lands as unrecorded with flag invalid_payload employee_unknown', async () => {
		const env = saleEnv(fx, { employeeId: randomUUID() });
		const result = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(result.http).toBe(200);
		if (result.http === 200) {
			expect(result.body.status).toBe('unrecorded');
			expect(result.body.flag).toBe('invalid_payload');
			expect(result.body.error).toBe('employee_unknown');
		}
		const [op] = await testDb()
			.select({
				status: posSyncOps.status,
				employeeUserId: posSyncOps.employeeUserId,
				flag: posSyncOps.flag
			})
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(op.status).toBe('unrecorded');
		expect(op.employeeUserId).toBeNull();

		const orderCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(orders)
			.where(eq(orders.restaurantId, fx.restaurantId));
		expect(orderCount[0].c).toBe('0');
	});

	it('cash sale with a waiter is recorded_flagged with employee_not_permitted', async () => {
		const env = saleEnv(fx, { employeeId: fx.waiterId });
		const result = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(result.http).toBe(200);
		if (result.http === 200) {
			expect(result.body.status).toBe('recorded_flagged');
			expect(result.body.flag).toBe('employee_not_permitted');
		}
		const [op] = await testDb()
			.select({ status: posSyncOps.status, orderId: posSyncOps.orderId })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(op.status).toBe('recorded_flagged');
		expect(op.orderId).not.toBeNull();
	});

	it('unknown session on a cash sale is stored unrecorded with posSessionId = the payload id', async () => {
		const s = randomUUID();
		const env = saleEnv(fx, { posSessionId: s });
		const result = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(result.http).toBe(200);
		if (result.http === 200) {
			expect(result.body.status).toBe('unrecorded');
			expect(result.body.flag).toBe('unknown_session');
		}
		const [op] = await testDb()
			.select({ posSessionId: posSyncOps.posSessionId, invoiceSeq: posSyncOps.invoiceSeq })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(op.posSessionId).toBe(s);
		expect(op.invoiceSeq).toBe(1);
	});
});

describe('request-class refusals', () => {
	it('a card sale by a waiter is 403 not_permitted, nothing stored', async () => {
		const env = saleEnv(fx, { employeeId: fx.waiterId, method: 'card' });
		const result = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(result.http).toBe(403);
		if (result.http === 403) expect(result.body.error).toBe('not_permitted');
		const opCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(opCount[0].c).toBe('0');
	});

	it('unknown session on a card sale returns 422 rejected; nothing stored', async () => {
		const env = saleEnv(fx, { method: 'card', posSessionId: randomUUID() });
		const result = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(result.http).toBe(422);
		if (result.http === 422) {
			expect(result.body.error).toBe('rejected');
			expect(result.body.flag).toBe('unknown_session');
		}
		const opCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(opCount[0].c).toBe('0');
	});
});

describe('sale.abandoned and pin.login (fact-class facts)', () => {
	it('sale.abandoned is accepted, burns an invoice number, writes one audit row', async () => {
		const env: OpEnvelope<OpKind, unknown> = {
			kind: 'sale.abandoned',
			clientOpId: randomUUID(),
			deviceId: fx.deviceId,
			employeeId: fx.cashierId,
			occurredAt: new Date().toISOString(),
			seq: 1,
			payload: {
				orderId: randomUUID(),
				invoiceSeq: 5,
				invoiceNumber: `${fx.deviceCode}-000005`,
				reason: 'rejected'
			}
		};
		const result = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(result.http).toBe(200);
		if (result.http === 200) expect(result.body.status).toBe('accepted');
		const [op] = await testDb()
			.select({ invoiceSeq: posSyncOps.invoiceSeq })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(op.invoiceSeq).toBe(5);
		const audit = await testDb()
			.select({ event: auditLog.event })
			.from(auditLog)
			.where(and(eq(auditLog.restaurantId, fx.restaurantId), eq(auditLog.event, 'sale.abandoned')));
		expect(audit).toHaveLength(1);
	});

	it('pin.login success writes one pos.pin.offline_success row; a retry replays', async () => {
		const clientOpId = randomUUID();
		const env: OpEnvelope<OpKind, unknown> = {
			kind: 'pin.login',
			clientOpId,
			deviceId: fx.deviceId,
			employeeId: fx.cashierId,
			occurredAt: new Date().toISOString(),
			seq: 1,
			payload: { outcome: 'success' }
		};
		const first = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(first.http).toBe(200);
		if (first.http === 200) expect(first.body.status).toBe('accepted');
		const second = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		expect(second.http).toBe(200);
		if (second.http === 200) expect(second.body.status).toBe('replayed');
		const audit = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.restaurantId, fx.restaurantId),
					eq(auditLog.event, 'pos.pin.offline_success')
				)
			);
		expect(audit[0].c).toBe('1');
	});
});

describe('session lifecycle through handleOp', () => {
	it('close blocks on an unrecorded op; after dismissing it, close succeeds', async () => {
		// First produce an unrecorded cash op naming the fixture's real session so
		// its pos_session_id column matches.
		const bad = saleEnv(fx, { unitPriceMinor: '1' });
		const badResult = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, bad);
		expect(badResult.http).toBe(200);
		if (badResult.http === 200) {
			expect(badResult.body.status).toBe('unrecorded');
			expect(badResult.body.flag).toBe('price_tamper');
		}

		const [unrecorded] = await testDb()
			.select({ id: posSyncOps.id, posSessionId: posSyncOps.posSessionId })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, bad.clientOpId));
		expect(unrecorded.posSessionId).toBe(fx.sessionId);

		const closeEnv: OpEnvelope<OpKind, unknown> = {
			kind: 'session.close',
			clientOpId: randomUUID(),
			deviceId: fx.deviceId,
			employeeId: fx.cashierId,
			occurredAt: new Date().toISOString(),
			seq: 1,
			payload: { posSessionId: fx.sessionId, countedCashMinor: '0' }
		};
		const blocked = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, closeEnv);
		expect(blocked.http).toBe(409);
		if (blocked.http === 409) {
			expect(blocked.body.error).toBe('session_has_unrecorded_ops');
			expect(blocked.body.count).toBe(1);
		}

		const dismissed = await dismissOp(
			db,
			fx.restaurantId,
			unrecorded.id.toString(),
			fx.ownerId,
			'Test sale during training'
		);
		expect(dismissed.ok).toBe(true);

		const closed = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, closeEnv);
		expect(closed.http).toBe(200);
		if (closed.http === 200) {
			expect(closed.body.status).toBe('accepted');
			expect(closed.body.expectedCashMinor).toBe('0');
			expect(closed.body.differenceMinor).toBe('0');
		}
	});

	it('close by a waiter is 403 not_permitted; a second close on a closed session returns accepted alreadyClosed', async () => {
		const wrongEnv: OpEnvelope<OpKind, unknown> = {
			kind: 'session.close',
			clientOpId: randomUUID(),
			deviceId: fx.deviceId,
			employeeId: fx.waiterId,
			occurredAt: new Date().toISOString(),
			seq: 1,
			payload: { posSessionId: fx.sessionId, countedCashMinor: '0' }
		};
		const forbidden = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, wrongEnv);
		expect(forbidden.http).toBe(403);

		const goodEnv: OpEnvelope<OpKind, unknown> = {
			kind: 'session.close',
			clientOpId: randomUUID(),
			deviceId: fx.deviceId,
			employeeId: fx.cashierId,
			occurredAt: new Date().toISOString(),
			seq: 1,
			payload: { posSessionId: fx.sessionId, countedCashMinor: '0' }
		};
		const first = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, goodEnv);
		expect(first.http).toBe(200);

		const againEnv: OpEnvelope<OpKind, unknown> = { ...goodEnv, clientOpId: randomUUID() };
		const second = await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, againEnv);
		expect(second.http).toBe(200);
		if (second.http === 200) {
			expect(second.body.status).toBe('accepted');
			expect(second.body.alreadyClosed).toBe(true);
		}

		const [session] = await testDb()
			.select({ status: posSessions.status })
			.from(posSessions)
			.where(eq(posSessions.id, fx.sessionId));
		expect(session.status).toBe('closed');
	});
});

describe('retryOp and dismissOp', () => {
	it('retryOp on an unrecorded price_tamper sale still fails; the row stays unrecorded and gets error', async () => {
		const bad = saleEnv(fx, { unitPriceMinor: '1' });
		await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, bad);
		const [op] = await testDb()
			.select({ id: posSyncOps.id })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, bad.clientOpId));
		const retry = await retryOp(db, fx.restaurantId, op.id.toString(), fx.ownerId);
		expect(retry.ok).toBe(false);
		if (!retry.ok) expect(retry.reason).toBe('still_unrecorded');

		const [row] = await testDb()
			.select({
				status: posSyncOps.status,
				resolvedAt: posSyncOps.resolvedAt,
				resolution: posSyncOps.resolution
			})
			.from(posSyncOps)
			.where(eq(posSyncOps.id, op.id));
		expect(row.status).toBe('unrecorded');
		expect(row.resolvedAt).toBeNull();
	});

	it('dismissOp on a recorded_flagged op resolves it, keeps its status, writes one audit row', async () => {
		const env = saleEnv(fx, { employeeId: fx.waiterId });
		await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		const [op] = await testDb()
			.select({ id: posSyncOps.id, status: posSyncOps.status })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(op.status).toBe('recorded_flagged');
		const result = await dismissOp(db, fx.restaurantId, op.id.toString(), fx.ownerId, 'reviewed');
		expect(result.ok).toBe(true);
		const [row] = await testDb()
			.select({
				status: posSyncOps.status,
				resolvedAt: posSyncOps.resolvedAt,
				resolution: posSyncOps.resolution
			})
			.from(posSyncOps)
			.where(eq(posSyncOps.id, op.id));
		expect(row.status).toBe('recorded_flagged');
		expect(row.resolvedAt).not.toBeNull();
		expect(row.resolution).toBe('dismissed');

		const audit = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(auditLog)
			.where(
				and(eq(auditLog.restaurantId, fx.restaurantId), eq(auditLog.event, 'sync.op_dismissed'))
			);
		expect(audit[0].c).toBe('1');
	});

	it('dismissOp with an empty reason returns invalid_reason', async () => {
		const env = saleEnv(fx, { employeeId: fx.waiterId });
		await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		const [op] = await testDb()
			.select({ id: posSyncOps.id })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		const result = await dismissOp(db, fx.restaurantId, op.id.toString(), fx.ownerId, '   ');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid_reason');
	});
});

describe('journal entries land on the right sale.recorded fixture', () => {
	it('one accepted sale writes exactly one journal_entries row scoped to the restaurant', async () => {
		const env = saleEnv(fx);
		await handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);
		const entries = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntries)
			.where(eq(journalEntries.restaurantId, fx.restaurantId));
		expect(entries[0].c).toBe('1');
	});
});
