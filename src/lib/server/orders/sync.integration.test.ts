import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { onRestaurantCreated, updateSettings } from '../restaurants';
import { registerDevice } from '../auth/pos-device';
import { createCategory, createItem, getMenuVersion, updateItem } from '../menu';
import { seedStaff } from '../db/test/seed';
import {
	cashMethodId,
	defaultTaxRateOf,
	seedPaymentMethod,
	seedTaxRate
} from '../db/test/settings';
import { closeTestDb, testDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { posSyncOps } from '../db/schema/pos-sync';
import { orders, invoices, payments } from '../db/schema/orders';
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
	/** One method per KIND (T-16): the built-in Cash row, 'Card' and 'Mobile money'. */
	methods: Record<'cash' | 'card' | 'mobile', { id: string; name: string }>;
	/** The named default rate ('Tax' 10%), which saleEnv sends on its line. */
	defaultRate: { id: string; name: string };
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
	await db.transaction(async (tx) => {
		const ctx = { actorUserId: owner.id, ip: null, userAgent: null };
		await seedTaxRate(tx, restaurantId, { rateBp: 1000, makeDefault: true }, ctx);
		return updateSettings(
			tx,
			restaurantId,
			{
				taxMode: 'exclusive',
				currencyCode: 'USD',
				posIdleLockSeconds: 120
			},
			ctx
		);
	});
	// Card and mobile are named payment methods since T-15, not the retired
	// accepts_card / accepts_mobile switches; Cash is built in (seedCashMethod).
	const { cardId, mobileId } = await db.transaction(async (tx) => {
		const ctx = { actorUserId: owner.id, ip: null, userAgent: null };
		return {
			cardId: await seedPaymentMethod(tx, restaurantId, { name: 'Card', kind: 'card' }, ctx),
			mobileId: await seedPaymentMethod(
				tx,
				restaurantId,
				{ name: 'Mobile money', kind: 'mobile' },
				ctx
			)
		};
	});
	const defaultRate = await defaultTaxRateOf(testDb(), restaurantId);
	if (defaultRate === null) throw new Error('fixture has no default tax rate');
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
		sessionId: posSessionId,
		methods: {
			cash: { id: await cashMethodId(testDb(), restaurantId), name: 'Cash' },
			card: { id: cardId, name: 'Card' },
			mobile: { id: mobileId, name: 'Mobile money' }
		},
		defaultRate: { id: defaultRate.id, name: defaultRate.name }
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
		/** The named method that took the payment; it must be of kind `method`.
		 * Defaults to the fixture's method of that kind (T-16). */
		paymentMethod?: { id: string; name: string };
		/** The pre-plan payload format (settings-tax-payments-receipt T-14): none of
		 * the four optional keys (method id and name, line rate id and name). */
		omitIds?: boolean;
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
	// The four optional keys (T-14), sent by default; absent with omitIds.
	const paymentMethod = overrides.paymentMethod ?? fx.methods[method];
	const methodKeys = overrides.omitIds
		? {}
		: { paymentMethodId: paymentMethod.id, paymentMethodName: paymentMethod.name };
	const rateKeys = overrides.omitIds
		? {}
		: { taxRateId: fx.defaultRate.id, taxRateName: fx.defaultRate.name };
	const payments =
		method === 'cash'
			? [
					{
						paymentId: randomUUID(),
						method: 'cash',
						...methodKeys,
						amountMinor: totals.totalMinor,
						tenderedMinor: '2000',
						changeMinor: String(Number(2000) - Number(totals.totalMinor))
					}
				]
			: [
					{
						paymentId: randomUUID(),
						method,
						...methodKeys,
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
					...rateKeys,
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

describe('named methods and rates (settings-tax-payments-receipt T-16)', () => {
	const send = (env: OpEnvelope<OpKind, unknown>) =>
		handleOp(db, posDeviceCtx(fx), { ip: null, userAgent: null }, env);

	/** Every row a recorded sale writes, counted for one restaurant. */
	async function saleCounts(restaurantId: string) {
		const r = await testDb().execute<Record<string, number>>(sql`
			select
				(select count(*)::int from orders where restaurant_id = ${restaurantId}) as orders,
				(select count(*)::int from payments where restaurant_id = ${restaurantId}) as payments,
				(select count(*)::int from invoices where restaurant_id = ${restaurantId}) as invoices,
				(select count(*)::int from journal_entries where restaurant_id = ${restaurantId}) as entries,
				(select count(*)::int from audit_log
					where restaurant_id = ${restaurantId} and event = 'sale.recorded') as recorded
		`);
		return r.rows[0];
	}
	const ONE_OF_EACH = { orders: 1, payments: 1, invoices: 1, entries: 1, recorded: 1 };

	const paymentRows = () =>
		testDb().select().from(payments).where(eq(payments.restaurantId, fx.restaurantId));

	async function seedMethod(input: {
		name: string;
		kind: 'card' | 'mobile';
		enabled?: boolean;
	}): Promise<{ id: string; name: string }> {
		const ctx = { actorUserId: fx.ownerId, ip: null, userAgent: null };
		const id = await db.transaction((tx) => seedPaymentMethod(tx, fx.restaurantId, input, ctx));
		return { id, name: input.name };
	}

	// MANDATORY (spec 29 — offline sync: retries never create duplicates), with the
	// four keys. Invariant 2: a replay updates nothing, so the payment row is unchanged.
	it('MANDATORY (spec 29): a sale with the four keys sent twice is accepted then replayed; one of each row', async () => {
		const env = saleEnv(fx);
		const first = await send(env);
		expect(first.http).toBe(200);
		if (first.http === 200) expect(first.body.status).toBe('accepted');
		const before = await paymentRows();
		expect(before).toHaveLength(1);
		expect(before[0]).toMatchObject({
			method: 'cash',
			paymentMethodId: fx.methods.cash.id,
			paymentMethodName: 'Cash'
		});

		const second = await send(env);
		expect(second.http).toBe(200);
		if (second.http === 200) expect(second.body.status).toBe('replayed');

		expect(await saleCounts(fx.restaurantId)).toEqual(ONE_OF_EACH);
		expect(await paymentRows()).toEqual(before);
	});

	// MANDATORY (spec 29 — offline retries), the pre-plan format (invariant 5): a till
	// queued before this plan sends none of the four keys.
	it('MANDATORY (spec 29): the pre-plan payload sent twice is accepted then replayed; the payment is on the Cash row', async () => {
		const env = saleEnv(fx, { omitIds: true });
		const payload = env.payload as {
			lines: Record<string, unknown>[];
			payments: Record<string, unknown>[];
		};
		for (const key of ['paymentMethodId', 'paymentMethodName']) {
			expect(key in payload.payments[0], key).toBe(false);
		}
		for (const key of ['taxRateId', 'taxRateName']) {
			expect(key in payload.lines[0], key).toBe(false);
		}

		const first = await send(env);
		expect(first.http).toBe(200);
		if (first.http === 200) expect(first.body.status).toBe('accepted');
		const second = await send(env);
		expect(second.http).toBe(200);
		if (second.http === 200) expect(second.body.status).toBe('replayed');

		expect(await saleCounts(fx.restaurantId)).toEqual(ONE_OF_EACH);
		const rows = await paymentRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].paymentMethodId).toBe(fx.methods.cash.id);
		expect(rows[0].paymentMethodName).toBe('Cash');
	});

	// MANDATORY (spec 29 — offline retries), mobile.
	it('MANDATORY (spec 29): a mobile sale naming EVC Plus sent twice is accepted then replayed; one order, posted mobile_sale', async () => {
		const evc = await seedMethod({ name: 'EVC Plus', kind: 'mobile' });
		const env = saleEnv(fx, { method: 'mobile', paymentMethod: evc });
		const orderId = (env.payload as { orderId: string }).orderId;

		const first = await send(env);
		expect(first.http).toBe(200);
		if (first.http === 200) expect(first.body.status).toBe('accepted');
		const second = await send(env);
		expect(second.http).toBe(200);
		if (second.http === 200) expect(second.body.status).toBe('replayed');

		const orderRows = await testDb()
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.restaurantId, fx.restaurantId));
		expect(orderRows).toEqual([{ id: orderId }]);
		const entries = await testDb()
			.select({ event: journalEntries.event })
			.from(journalEntries)
			.where(eq(journalEntries.sourceId, orderId));
		expect(entries).toEqual([{ event: 'mobile_sale' }]);
	});

	// The request class is decided by the KIND (peekMethod / isRequestClass): a
	// mobile sale has not completed on the till, so a HARD failure is a 422 the till
	// turns into sale.abandoned — never an unrecorded row (CLAUDE.md decision (f)).
	it('a mobile sale naming a switched-off method is 422 rejected invalid_payload; nothing is stored', async () => {
		const zaad = await seedMethod({ name: 'Zaad', kind: 'mobile', enabled: false });
		const env = saleEnv(fx, { method: 'mobile', paymentMethod: zaad });

		expect(await send(env)).toEqual({
			http: 422,
			body: { error: 'rejected', flag: 'invalid_payload' }
		});
		const ops = await testDb()
			.select({ id: posSyncOps.id })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));
		expect(ops).toHaveLength(0);
		const orderRows = await testDb()
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.restaurantId, fx.restaurantId));
		expect(orderRows).toHaveLength(0);
	});

	it('retry resolves the method: an unrecorded cash sale retried after a menu change records on the Cash row', async () => {
		const env = saleEnv(fx, { unitPriceMinor: '1' });
		const stored = await send(env);
		expect(stored.http).toBe(200);
		if (stored.http === 200) {
			expect(stored.body.status).toBe('unrecorded');
			expect(stored.body.flag).toBe('price_tamper');
		}
		const [op] = await testDb()
			.select({ id: posSyncOps.id })
			.from(posSyncOps)
			.where(eq(posSyncOps.clientOpId, env.clientOpId));

		// updateItem bumps the menu version, so the op's version is now an older one.
		const changed = await db.transaction((tx) =>
			updateItem(
				tx,
				fx.restaurantId,
				fx.teaId,
				{ priceMinor: 900n },
				{ actorUserId: fx.ownerId, ip: null, userAgent: null }
			)
		);
		expect(changed).toEqual({ ok: true, changed: true });
		expect(await getMenuVersion(testDb(), fx.restaurantId)).toBeGreaterThan(fx.menuVersion);

		expect(await retryOp(db, fx.restaurantId, op.id.toString(), fx.ownerId)).toEqual({
			ok: true,
			status: 'recorded_flagged'
		});
		const [order] = await testDb()
			.select({ flagReason: orders.flagReason })
			.from(orders)
			.where(eq(orders.restaurantId, fx.restaurantId));
		expect(order.flagReason?.split(',')).toContain('stale_menu_price');
		const rows = await paymentRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			method: 'cash',
			paymentMethodId: fx.methods.cash.id,
			paymentMethodName: 'Cash'
		});
	});
});
