import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb, testDb } from '../db/test/db';
import { seedStaff } from '../db/test/seed';
import {
	closeSessionAt,
	openSessionAt,
	pushOp,
	recordSaleAt,
	saleEnvelope,
	seedSalesRestaurant,
	type RecordSaleOptions,
	type SalesFixture
} from '../db/test/sales';
import { customerPayments } from '../db/schema/customers';
import { posSyncOps } from '../db/schema/pos-sync';
import { auditLog } from '../db/schema/audit';
import { setCreditEnabled } from '../restaurants';
import { expectedCash } from '../pos-sessions';
import { balanceOf, createCustomer } from '../customers';
import type { CustomerPaymentPayload, OpEnvelope } from '../../sync-ops';

// The `customer.payment` sync op (tasks/customer-credit T-12).
//
// MANDATORY (spec 29): offline sync — a retried payment op never creates a
// second payment, and answers the same balance; permissions — the op is refused
// with 403 for an employee without pos.payment, writing nothing.
//
// It is a REQUEST, not a fact: 403 or 422, and a refusal stores nothing.

afterAll(async () => {
	await closeTestDb();
});

const AT = new Date('2026-09-28T09:00:00Z');

type World = { f: SalesFixture; session: string; customer: string; seq: number };

async function world(): Promise<World> {
	const f = await seedSalesRestaurant(db);
	const session = randomUUID();
	await openSessionAt(db, f, { posSessionId: session, openedAt: AT, openingCashMinor: 50_000n });
	const settings = { actorUserId: f.ownerId, ip: null, userAgent: null };
	await db.transaction((tx) => setCreditEnabled(tx, f.restaurantId, true, settings));
	const created = await db.transaction((tx) =>
		createCustomer(
			tx,
			{ restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null },
			{ name: 'Ali Hassan', phone: '615000001', creditLimitMinor: null }
		)
	);
	if (!created.ok) throw new Error(created.reason);
	return { f, session, customer: created.customerId, seq: 0 };
}

/** Charge `quantity` burgers (880 each) to the customer. */
async function charge(w: World, quantity: number): Promise<void> {
	w.seq += 1;
	const options: RecordSaleOptions = {
		posSessionId: w.session,
		occurredAt: new Date(AT.getTime() + w.seq * 60_000),
		invoiceSeq: w.seq,
		method: 'credit',
		customer: { id: w.customer },
		orderType: 'dine_in',
		tableLabel: null,
		lines: [
			{
				menuItemId: w.f.items.burger,
				itemName: 'Burger',
				quantity,
				unitPriceMinor: 800n,
				taxRateBp: w.f.taxRateBp
			}
		]
	};
	await recordSaleAt(db, w.f, options);
}

function paymentOp(
	w: World,
	amount: string,
	over: Partial<CustomerPaymentPayload> = {},
	envelope: Partial<OpEnvelope<'customer.payment', CustomerPaymentPayload>> = {}
): OpEnvelope<'customer.payment', CustomerPaymentPayload> {
	const at = new Date(AT.getTime() + 3_600_000).toISOString();
	return {
		kind: 'customer.payment',
		clientOpId: randomUUID(),
		deviceId: w.f.deviceId,
		employeeId: w.f.staffId,
		occurredAt: at,
		seq: 100,
		payload: {
			paymentId: randomUUID(),
			customerId: w.customer,
			posSessionId: w.session,
			method: 'cash',
			paymentMethodId: w.f.paymentMethods.cash.id,
			paymentMethodName: 'Cash',
			amountMinor: amount,
			tenderedMinor: amount,
			changeMinor: '0',
			receivedAt: at,
			...over
		},
		...envelope
	};
}

async function rows(restaurantId: string) {
	const payments = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(customerPayments)
		.where(eq(customerPayments.restaurantId, restaurantId));
	const ops = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(posSyncOps)
		.where(and(eq(posSyncOps.restaurantId, restaurantId), eq(posSyncOps.kind, 'customer.payment')));
	const entries = await testDb().execute<{ c: number }>(sql`
		select count(*)::int as c from journal_entries
		where restaurant_id = ${restaurantId} and source_type = 'customer_payment'
	`);
	const audits = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(auditLog)
		.where(
			and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.event, 'customer.payment_received'))
		);
	return {
		payments: payments[0].c,
		ops: ops[0].c,
		entries: entries.rows[0].c,
		audits: audits[0].c
	};
}

const NOTHING = { payments: 0, ops: 0, entries: 0, audits: 0 };

describe('MANDATORY (spec 29) — a retried customer payment never creates a second one', () => {
	it('the same op twice: accepted then replayed, with the SAME balance; one payment, one entry, one audit row', async () => {
		const w = await world();
		await charge(w, 5); // owes 4400
		const op = paymentOp(w, '2000');

		const first = await pushOp(db, w.f, op);
		// Something else happens before the retry lands: the balance moves on.
		await charge(w, 1);
		const second = await pushOp(db, w.f, op);

		expect(first).toEqual({
			http: 200,
			body: {
				clientOpId: op.clientOpId,
				status: 'accepted',
				posSessionId: w.session,
				businessDate: '2026-09-28',
				balanceAfterMinor: '2400'
			}
		});
		expect(second).toMatchObject({
			http: 200,
			body: { status: 'replayed', posSessionId: w.session, balanceAfterMinor: '2400' }
		});
		expect(await rows(w.f.restaurantId)).toEqual({ payments: 1, ops: 1, entries: 1, audits: 1 });
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(3280n); // 4400 − 2000 + 880
		expect(await db.transaction((tx) => expectedCash(tx, w.f.restaurantId, w.session))).toBe(
			52_000n
		);
	});

	it('concurrent duplicates leave one payment; the loser replays', async () => {
		const w = await world();
		await charge(w, 5);
		const op = paymentOp(w, '1000');

		const results = await Promise.all([pushOp(db, w.f, op), pushOp(db, w.f, op)]);

		const statuses = results.map((r) => (r.body as { status?: string }).status).sort();
		expect(statuses).toEqual(['accepted', 'replayed']);
		expect(await rows(w.f.restaurantId)).toEqual({ payments: 1, ops: 1, entries: 1, audits: 1 });
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(3400n);
	});

	it('the audit row carries the op key and the till', async () => {
		const w = await world();
		await charge(w, 1);
		const op = paymentOp(w, '880', {
			method: 'mobile',
			paymentMethodId: w.f.paymentMethods.mobile.id,
			paymentMethodName: 'Mobile money',
			tenderedMinor: null,
			changeMinor: null
		});
		expect(await pushOp(db, w.f, op)).toMatchObject({
			http: 200,
			body: { balanceAfterMinor: '0' }
		});

		const [row] = await testDb()
			.select()
			.from(auditLog)
			.where(eq(auditLog.event, 'customer.payment_received'));
		expect(row).toMatchObject({
			deviceId: w.f.deviceId,
			clientOpId: op.clientOpId,
			actorUserId: w.f.staffId
		});
	});
});

describe('MANDATORY (spec 29) — permissions: the op checks the EMPLOYEE', () => {
	it('an employee without pos.payment (a waiter) is refused with 403; nothing is stored', async () => {
		const w = await world();
		await charge(w, 1);
		const waiter = await seedStaff(db, w.f.restaurantId, {
			displayName: 'Wael',
			roleName: 'Waiter'
		});

		const result = await pushOp(db, w.f, paymentOp(w, '500', {}, { employeeId: waiter.id }));

		expect(result).toEqual({ http: 403, body: { error: 'not_permitted' } });
		expect(await rows(w.f.restaurantId)).toEqual(NOTHING);
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(880n);
	});

	it('an unknown employee is refused with 403', async () => {
		const w = await world();
		await charge(w, 1);
		const result = await pushOp(db, w.f, paymentOp(w, '500', {}, { employeeId: randomUUID() }));
		expect(result.http).toBe(403);
		expect(await rows(w.f.restaurantId)).toEqual(NOTHING);
	});

	it("another restaurant's till cannot pay into this restaurant: foreign_device, nothing stored", async () => {
		const w = await world();
		const other = await world();
		await charge(w, 1);
		// The other restaurant's device cookie, naming this restaurant's op device.
		const result = await pushOp(db, other.f, paymentOp(w, '500'));
		expect(result).toEqual({ http: 409, body: { error: 'foreign_device' } });
		expect(await rows(w.f.restaurantId)).toEqual(NOTHING);
	});
});

describe('a refused payment answers 422 with the reason and stores nothing', () => {
	it('more than is owed; an unknown customer; a closed shift; a malformed payload', async () => {
		const w = await world();
		const other = await world();
		await charge(w, 1); // owes 880

		const over = await pushOp(db, w.f, paymentOp(w, '881'));
		expect(over).toEqual({
			http: 422,
			body: { error: 'rejected', flag: 'invalid_payload', detail: 'exceeds_balance' }
		});

		const stranger = await pushOp(db, w.f, paymentOp(w, '500', { customerId: other.customer }));
		expect(stranger).toMatchObject({ http: 422, body: { detail: 'unknown_customer' } });

		const withCredit = await pushOp(
			db,
			w.f,
			paymentOp(w, '500', { method: 'credit' as never, tenderedMinor: null, changeMinor: null })
		);
		expect(withCredit).toMatchObject({ http: 422, body: { flag: 'invalid_payload' } });

		const malformed = await pushOp(db, w.f, paymentOp(w, '-5'));
		expect(malformed).toMatchObject({ http: 422, body: { flag: 'invalid_payload' } });

		await closeSessionAt(db, w.f, {
			posSessionId: w.session,
			closedAt: new Date(AT.getTime() + 7_200_000),
			countedCashMinor: 50_000n
		});
		const closed = await pushOp(db, w.f, paymentOp(w, '500'));
		expect(closed).toMatchObject({ http: 422, body: { detail: 'session_closed' } });

		expect(await rows(w.f.restaurantId)).toEqual(NOTHING);
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(880n);
	});

	it('a refused op can be sent again under the SAME key once it is valid, and then records once', async () => {
		const w = await world();
		const op = paymentOp(w, '500');
		// Nothing is owed yet.
		expect(await pushOp(db, w.f, op)).toMatchObject({
			http: 422,
			body: { detail: 'exceeds_balance' }
		});
		await charge(w, 1);
		expect(await pushOp(db, w.f, op)).toMatchObject({ http: 200, body: { status: 'accepted' } });
		expect(await pushOp(db, w.f, op)).toMatchObject({ http: 200, body: { status: 'replayed' } });
		expect(await rows(w.f.restaurantId)).toEqual({ payments: 1, ops: 1, entries: 1, audits: 1 });
	});

	it('a card SALE and a session close keep their two-key 422 body (no detail)', async () => {
		const w = await world();
		const env = saleEnvelope(w.f, {
			posSessionId: randomUUID(), // unknown session
			occurredAt: new Date(AT.getTime() + 60_000),
			invoiceSeq: 1,
			method: 'card',
			orderType: 'takeaway',
			tableLabel: null,
			lines: [
				{
					menuItemId: w.f.items.burger,
					itemName: 'Burger',
					quantity: 1,
					unitPriceMinor: 800n,
					taxRateBp: w.f.taxRateBp
				}
			]
		});
		expect(await pushOp(db, w.f, env)).toEqual({
			http: 422,
			body: { error: 'rejected', flag: 'unknown_session' }
		});
	});
});
