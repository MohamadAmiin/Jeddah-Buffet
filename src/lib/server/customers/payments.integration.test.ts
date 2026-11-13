import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb, testDb } from '../db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	syncContext,
	withSecondDevice,
	type RecordSaleOptions,
	type SalesFixture
} from '../db/test/sales';
import { customerPayments } from '../db/schema/customers';
import { posSessions } from '../db/schema/pos-sessions';
import { auditLog } from '../db/schema/audit';
import { closeSession, expectedCash } from '../pos-sessions';
import { setCreditEnabled, updatePaymentMethod } from '../restaurants';
import { minor } from '../../money';
import {
	archiveCustomer,
	balanceOf,
	createCustomer,
	listCustomers,
	receivableTripwire,
	statement,
	type CustomerWriteContext
} from './index';
import {
	paymentsOf,
	receiveCustomerPayment,
	reverseCustomerPayment,
	storedBalanceAfter,
	type ReceiveInput
} from './payments';

// Customer payments (tasks/customer-credit T-11).
//
// MANDATORY (spec 29): the posting rule of a customer payment, per tender kind,
// and of its reversal. Plus the two things the risk panel called blockers and
// majors: a payment or a cash reversal can never race a shift close into an
// inconsistent ledger, and expected cash adds cash customer payments without
// multiplying anything.

afterAll(async () => {
	await closeTestDb();
});

const AT = new Date('2026-09-28T09:00:00Z');

type World = {
	f: SalesFixture;
	session: string;
	ctx: CustomerWriteContext;
	customer: string;
	seq: number;
};

async function world(opts: { limit?: bigint | null } = {}): Promise<World> {
	const f = await seedSalesRestaurant(db);
	const session = randomUUID();
	await openSessionAt(db, f, { posSessionId: session, openedAt: AT, openingCashMinor: 50_000n });
	const ctx = { restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null };
	await db.transaction((tx) =>
		setCreditEnabled(tx, f.restaurantId, true, {
			actorUserId: f.ownerId,
			ip: null,
			userAgent: null
		})
	);
	const created = await db.transaction((tx) =>
		createCustomer(tx, ctx, {
			name: 'Ali Hassan',
			phone: '615000001',
			creditLimitMinor: opts.limit == null ? null : minor(opts.limit)
		})
	);
	if (!created.ok) throw new Error(created.reason);
	return { f, session, ctx, customer: created.customerId, seq: 0 };
}

/** `quantity` burgers: 880 each (800 + 10% exclusive). */
function sale(w: World, o: Partial<RecordSaleOptions> = {}, quantity = 1): RecordSaleOptions {
	w.seq += 1;
	return {
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
		],
		...o
	};
}

const charge = (w: World, quantity = 1) => recordSaleAt(db, w.f, sale(w, {}, quantity));
const cashSale = (w: World, quantity = 1) =>
	recordSaleAt(db, w.f, sale(w, { method: 'cash', customer: undefined }, quantity));
const cardSale = (w: World, quantity = 1) =>
	recordSaleAt(db, w.f, sale(w, { method: 'card', customer: undefined }, quantity));

function receiveContext(w: World) {
	return {
		restaurantId: w.f.restaurantId,
		actorUserId: w.f.staffId,
		deviceId: w.f.deviceId,
		clientOpId: randomUUID(),
		occurredAt: new Date(AT.getTime() + 3_600_000),
		ip: '203.0.113.5',
		userAgent: 'vitest'
	};
}

function input(
	w: World,
	amount: bigint,
	method: 'cash' | 'card' | 'mobile' = 'cash',
	over: Partial<ReceiveInput> = {}
): ReceiveInput {
	return {
		paymentId: randomUUID(),
		customerId: w.customer,
		posSessionId: w.session,
		method,
		paymentMethodId: w.f.paymentMethods[method].id,
		paymentMethodName: w.f.paymentMethods[method].name,
		amountMinor: minor(amount),
		tenderedMinor: method === 'cash' ? minor(amount) : null,
		changeMinor: method === 'cash' ? minor(0n) : null,
		receivedAt: new Date(AT.getTime() + 3_600_000),
		...over
	};
}

async function receive(
	w: World,
	amount: bigint,
	method: 'cash' | 'card' | 'mobile' = 'cash',
	over: Partial<ReceiveInput> = {}
) {
	const payload = input(w, amount, method, over);
	const result = await db.transaction((tx) =>
		receiveCustomerPayment(tx, receiveContext(w), payload)
	);
	return { result, paymentId: payload.paymentId };
}

async function paid(w: World, amount: bigint, method: 'cash' | 'card' | 'mobile' = 'cash') {
	const { result, paymentId } = await receive(w, amount, method);
	if (!result.ok) throw new Error(`fixture payment refused: ${result.reason}`);
	return paymentId;
}

const reverse = (w: World, paymentId: string, reason = 'Keyed the wrong amount') =>
	db.transaction((tx) => reverseCustomerPayment(tx, w.ctx, { paymentId, reason }));

/** Every journal line of one customer payment's entries (the payment and its
 * reversal), as `date code Dr|Cr amount`, in posting order. */
async function linesOfPayment(paymentId: string): Promise<string[]> {
	const result = await testDb().execute<{ line: string }>(sql`
		select e.business_date::text || ' ' || a.code || ' ' ||
		       case when l.debit_minor > 0 then 'Dr ' || l.debit_minor else 'Cr ' || l.credit_minor end as line
		from journal_entries e
		join journal_entry_lines l on l.entry_id = e.id
		join accounts a on a.id = l.account_id
		where e.source_type = 'customer_payment' and e.source_id = ${paymentId}
		order by e.posted_at, e.id, l.line_no
	`);
	return result.rows.map((r) => r.line);
}

async function counts(restaurantId: string) {
	const payments = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(customerPayments)
		.where(eq(customerPayments.restaurantId, restaurantId));
	const entries = await testDb().execute<{ c: number }>(sql`
		select count(*)::int as c from journal_entries
		where restaurant_id = ${restaurantId} and source_type = 'customer_payment'
	`);
	return { payments: payments[0].c, entries: entries.rows[0].c };
}

async function todayInZone(restaurantId: string): Promise<string> {
	const result = await testDb().execute<{ today: string }>(sql`
		select to_char(now() at time zone s.time_zone, 'YYYY-MM-DD') as today
		from restaurant_settings s where s.restaurant_id = ${restaurantId}
	`);
	return result.rows[0].today;
}

/** A promise and the function that settles it: holds a transaction open. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open = () => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MANDATORY (spec 29) — the posting rule of a customer payment', () => {
	it('cash: Dr 1000 / Cr 1100 on the shift’s business date; the row stores the balance after; audited with the op key', async () => {
		const w = await world();
		await charge(w, 5); // owes 4400

		const { result, paymentId } = await receive(w, 2000n, 'cash', {
			tenderedMinor: minor(5000n),
			changeMinor: minor(3000n)
		});

		expect(result).toEqual({ ok: true, balanceAfterMinor: 2400n, businessDate: '2026-09-28' });
		expect(await linesOfPayment(paymentId)).toEqual([
			'2026-09-28 1000 Dr 2000',
			'2026-09-28 1100 Cr 2000'
		]);
		const [row] = await testDb()
			.select()
			.from(customerPayments)
			.where(eq(customerPayments.id, paymentId));
		expect(row).toMatchObject({
			customerId: w.customer,
			amountMinor: 2000n,
			method: 'cash',
			paymentMethodName: 'Cash',
			tenderedMinor: 5000n,
			changeMinor: 3000n,
			balanceAfterMinor: 2400n,
			posSessionId: w.session,
			deviceId: w.f.deviceId,
			recordedByUserId: w.f.staffId,
			businessDate: '2026-09-28',
			reversedAt: null
		});
		expect(row.journalEntryId).toBeTruthy();
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(2400n);
		expect(await storedBalanceAfter(db, w.f.restaurantId, paymentId)).toBe(2400n);

		const audit = await testDb()
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.restaurantId, w.f.restaurantId),
					eq(auditLog.event, 'customer.payment_received')
				)
			);
		expect(audit).toHaveLength(1);
		expect(audit[0].deviceId).toBe(w.f.deviceId);
		expect(audit[0].clientOpId).toBeTruthy();
		expect(audit[0].actorUserId).toBe(w.f.staffId);
		expect(audit[0].details).toMatchObject({
			paymentId,
			customerId: w.customer,
			amountMinor: '2000',
			method: 'cash',
			balanceAfterMinor: '2400'
		});
	});

	it('card posts Dr 1020 / Cr 1100; mobile posts Dr 1030 / Cr 1100; neither touches cash', async () => {
		const w = await world();
		await charge(w, 5);
		const card = await paid(w, 1000n, 'card');
		const mobile = await paid(w, 500n, 'mobile');

		expect(await linesOfPayment(card)).toEqual([
			'2026-09-28 1020 Dr 1000',
			'2026-09-28 1100 Cr 1000'
		]);
		expect(await linesOfPayment(mobile)).toEqual([
			'2026-09-28 1030 Dr 500',
			'2026-09-28 1100 Cr 500'
		]);
		expect(await db.transaction((tx) => expectedCash(tx, w.f.restaurantId, w.session))).toBe(
			50_000n
		);
	});

	it('a full repayment clears the balance; charges and payments keep 1100 equal to the sum of balances', async () => {
		const w = await world();
		await charge(w, 2); // 1760
		await charge(w, 1); // 880  → 2640
		await paid(w, 1000n, 'cash');
		await paid(w, 1640n, 'mobile');

		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(0n);
		expect(await receivableTripwire(db, w.f.restaurantId)).toEqual({
			sumOfBalances: 0n,
			ledger1100: 0n,
			matches: true
		});
		const rows = await statement(db, w.f.restaurantId, w.customer);
		expect(rows.map((r) => [r.kind, r.amountMinor, r.balanceMinor])).toEqual([
			['charge', 1760n, 1760n],
			['charge', 880n, 2640n],
			['payment', -1000n, 1640n],
			['payment', -1640n, 0n]
		]);
		expect(rows[2]).toMatchObject({ methodName: 'Cash', method: 'cash', tillCode: w.f.deviceCode });
	});

	it('the balance of two charges and two payments is not multiplied (two scalar subqueries)', async () => {
		const w = await world();
		await charge(w, 1); // 880
		await charge(w, 1); // 880
		await charge(w, 1); // 880 → 2640
		await paid(w, 500n);
		await paid(w, 500n, 'card');
		// As joins this would read 3 × 1000 against 2 × 2640.
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(1640n);
		const [listed] = await listCustomers(db, w.f.restaurantId);
		expect(listed.balanceMinor).toBe(1640n);
		expect((await receivableTripwire(db, w.f.restaurantId)).matches).toBe(true);
	});
});

describe('refusals write nothing', () => {
	it('more than is owed, zero, wrong change, a closed or unknown shift, an unknown or foreign customer', async () => {
		const w = await world();
		const other = await world();
		await charge(w, 1); // owes 880

		const tries: Array<[Awaited<ReturnType<typeof receive>>['result'], string]> = [
			[(await receive(w, 881n)).result, 'exceeds_balance'],
			[(await receive(w, 0n)).result, 'invalid_amount'],
			[
				(await receive(w, 500n, 'cash', { tenderedMinor: minor(400n), changeMinor: minor(0n) }))
					.result,
				'cash_change'
			],
			[
				(await receive(w, 500n, 'cash', { tenderedMinor: minor(1000n), changeMinor: minor(1n) }))
					.result,
				'cash_change'
			],
			[
				(await receive(w, 500n, 'card', { tenderedMinor: minor(500n), changeMinor: minor(0n) }))
					.result,
				'cash_change'
			],
			[(await receive(w, 500n, 'cash', { posSessionId: randomUUID() })).result, 'unknown_session'],
			[(await receive(w, 500n, 'cash', { posSessionId: other.session })).result, 'unknown_session'],
			[(await receive(w, 500n, 'cash', { customerId: randomUUID() })).result, 'unknown_customer'],
			[(await receive(w, 500n, 'cash', { customerId: other.customer })).result, 'unknown_customer'],
			// A debt is never paid with credit.
			[
				(
					await receive(w, 500n, 'cash', {
						method: 'credit' as never,
						tenderedMinor: null,
						changeMinor: null
					})
				).result,
				'tender_not_accepted'
			],
			// Another restaurant's method.
			[
				(await receive(w, 500n, 'card', { paymentMethodId: other.f.paymentMethods.card.id }))
					.result,
				'tender_not_accepted'
			]
		];
		for (const [result, reason] of tries) expect(result).toEqual({ ok: false, reason });

		expect(await counts(w.f.restaurantId)).toEqual({ payments: 0, entries: 0 });
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(880n);
	});

	it("MANDATORY (verification finding): another till's open shift is refused — cash is never counted in a different drawer", async () => {
		const w = await world();
		await charge(w, 1);
		// A second till of the same restaurant, with its own open shift.
		const second = await withSecondDevice(db, w.f);
		const otherShift = randomUUID();
		await openSessionAt(db, second, {
			posSessionId: otherShift,
			openedAt: AT,
			openingCashMinor: 10_000n
		});

		// The op comes from the FIRST till but names the second till's shift.
		const { result } = await receive(w, 500n, 'cash', { posSessionId: otherShift });

		expect(result).toEqual({ ok: false, reason: 'session_device_mismatch' });
		expect(await counts(w.f.restaurantId)).toEqual({ payments: 0, entries: 0 });
		expect(await db.transaction((tx) => expectedCash(tx, w.f.restaurantId, otherShift))).toBe(
			10_000n
		);
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(880n);
	});

	it('a switched-off method is refused; the Customer credit switch is irrelevant', async () => {
		const w = await world();
		await charge(w, 1);
		const settingsCtx = { actorUserId: w.f.ownerId, ip: null, userAgent: null };
		await db.transaction((tx) =>
			updatePaymentMethod(
				tx,
				w.f.restaurantId,
				w.f.paymentMethods.mobile.id,
				{ enabled: false },
				settingsCtx
			)
		);
		expect((await receive(w, 500n, 'mobile')).result).toEqual({
			ok: false,
			reason: 'tender_not_accepted'
		});

		// Credit OFF stops new charges, never a payment.
		await db.transaction((tx) => setCreditEnabled(tx, w.f.restaurantId, false, settingsCtx));
		expect((await receive(w, 500n, 'cash')).result).toMatchObject({ ok: true });
	});

	it('a payment in a CLOSED shift is refused', async () => {
		const w = await world();
		await charge(w, 1);
		await closeSessionAt(db, w.f, {
			posSessionId: w.session,
			closedAt: new Date(AT.getTime() + 7_200_000),
			countedCashMinor: 50_000n
		});
		expect((await receive(w, 500n)).result).toEqual({ ok: false, reason: 'session_closed' });
	});

	it('the same payment id twice is refused the second time', async () => {
		const w = await world();
		await charge(w, 2);
		const payload = input(w, 500n);
		const first = await db.transaction((tx) =>
			receiveCustomerPayment(tx, receiveContext(w), payload)
		);
		const second = await db.transaction((tx) =>
			receiveCustomerPayment(tx, receiveContext(w), payload)
		);
		expect(first).toMatchObject({ ok: true });
		expect(second).toEqual({ ok: false, reason: 'duplicate_payment' });
		expect(await counts(w.f.restaurantId)).toEqual({ payments: 1, entries: 1 });
	});

	it('an ARCHIVED customer who owes can still pay: a debt stays collectable', async () => {
		const w = await world();
		const id = await paid(await chargedWorld(w), 880n, 'mobile');
		expect(await db.transaction((tx) => archiveCustomer(tx, w.ctx, w.customer))).toEqual({
			ok: true
		});
		// The owner reverses that payment after archiving: the customer owes again.
		expect(await reverse(w, id)).toMatchObject({ ok: true });
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(880n);

		// On the till's list although archived, because they owe.
		const collectable = await listCustomers(db, w.f.restaurantId, { include: 'collectable' });
		expect(collectable.map((c) => c.id)).toEqual([w.customer]);
		expect(collectable[0].archivedAt).toBeInstanceOf(Date);
		expect(await listCustomers(db, w.f.restaurantId)).toEqual([]);

		expect((await receive(w, 880n)).result).toMatchObject({ ok: true, balanceAfterMinor: 0n });
	});
});

async function chargedWorld(w: World): Promise<World> {
	await charge(w, 1);
	return w;
}

describe('MANDATORY (spec 29) — the reversal of a customer payment', () => {
	it('mirrors the entry, restores the balance, stamps the row once and audits it', async () => {
		const w = await world();
		await charge(w, 5); // 4400
		const id = await paid(w, 2000n, 'card');

		const result = await reverse(w, id, '  Keyed twice  ');

		const today = await todayInZone(w.f.restaurantId);
		expect(result).toEqual({ ok: true, reversalBusinessDate: today });
		expect(await linesOfPayment(id)).toEqual([
			'2026-09-28 1020 Dr 2000',
			'2026-09-28 1100 Cr 2000',
			// The mirror: the same lines in the same order, sides swapped.
			`${today} 1020 Cr 2000`,
			`${today} 1100 Dr 2000`
		]);
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(4400n);
		expect((await receivableTripwire(db, w.f.restaurantId)).matches).toBe(true);

		const [row] = await testDb().select().from(customerPayments).where(eq(customerPayments.id, id));
		expect(row.reversedAt).toBeInstanceOf(Date);
		expect(row).toMatchObject({
			reversedByUserId: w.f.ownerId,
			reversalReason: 'Keyed twice',
			reversalBusinessDate: today,
			amountMinor: 2000n
		});
		expect(row.reversalEntryId).toBeTruthy();

		expect(await reverse(w, id)).toEqual({ ok: false, reason: 'already_reversed' });
		const audit = await testDb()
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.restaurantId, w.f.restaurantId),
					eq(auditLog.event, 'customer.payment_reversed')
				)
			);
		expect(audit).toHaveLength(1);
		expect(audit[0].details).toEqual({
			paymentId: id,
			customerId: w.customer,
			amountMinor: '2000',
			reason: 'Keyed twice',
			reversalBusinessDate: today
		});
	});

	it('a CASH reversal carries its SHIFT’s business date, not today’s, and leaves the drawer', async () => {
		const w = await world();
		await charge(w, 5);
		const id = await paid(w, 2000n, 'cash');
		expect(await db.transaction((tx) => expectedCash(tx, w.f.restaurantId, w.session))).toBe(
			52_000n
		);

		// Made today (weeks after the fixture's shift date), in a shift still open.
		const result = await reverse(w, id);

		expect(result).toEqual({ ok: true, reversalBusinessDate: '2026-09-28' });
		expect(await todayInZone(w.f.restaurantId)).not.toBe('2026-09-28');
		expect(await linesOfPayment(id)).toEqual([
			'2026-09-28 1000 Dr 2000',
			'2026-09-28 1100 Cr 2000',
			'2026-09-28 1000 Cr 2000',
			'2026-09-28 1100 Dr 2000'
		]);
		expect(await db.transaction((tx) => expectedCash(tx, w.f.restaurantId, w.session))).toBe(
			50_000n
		);
	});

	it('the statement keeps the payment on its date and shows the reversal as its own row', async () => {
		const w = await world();
		await charge(w, 5); // 4400
		const id = await paid(w, 2000n, 'mobile');
		await reverse(w, id, 'Wrong customer');

		const rows = await statement(db, w.f.restaurantId, w.customer);
		expect(rows.map((r) => [r.kind, r.amountMinor, r.balanceMinor, r.reversed])).toEqual([
			['charge', 4400n, 4400n, false],
			['payment', -2000n, 2400n, true],
			['reversal', 2000n, 4400n, false]
		]);
		expect(rows[1].businessDate).toBe('2026-09-28');
		expect(rows[2]).toMatchObject({ reason: 'Wrong customer', paymentId: id });

		const views = await paymentsOf(db, w.f.restaurantId, w.customer);
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			id,
			amountMinor: 2000n,
			reversed: true,
			reversalReason: 'Wrong customer',
			shiftOpen: true
		});
	});

	it('refuses a bad reason, an unknown id and another restaurant’s payment, writing nothing', async () => {
		const w = await world();
		const other = await world();
		await charge(w, 1);
		const id = await paid(w, 500n, 'card');

		expect(await reverse(w, id, 'x')).toEqual({ ok: false, reason: 'invalid_reason' });
		expect(await reverse(w, id, 'y'.repeat(201))).toEqual({ ok: false, reason: 'invalid_reason' });
		expect(await reverse(w, randomUUID())).toEqual({ ok: false, reason: 'not_found' });
		expect(await reverse(w, 'not-a-uuid')).toEqual({ ok: false, reason: 'not_found' });
		expect(await reverse(other, id)).toEqual({ ok: false, reason: 'not_found' });

		expect(await counts(w.f.restaurantId)).toEqual({ payments: 1, entries: 1 });
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(380n);
	});

	it('a CASH payment cannot be reversed once its shift is closed; a card payment still can', async () => {
		const w = await world();
		await charge(w, 5);
		const cash = await paid(w, 1000n, 'cash');
		const card = await paid(w, 1000n, 'card');
		await closeSessionAt(db, w.f, {
			posSessionId: w.session,
			closedAt: new Date(AT.getTime() + 7_200_000),
			countedCashMinor: 51_000n
		});

		expect(await reverse(w, cash)).toEqual({ ok: false, reason: 'shift_closed' });
		expect(await reverse(w, card)).toMatchObject({ ok: true });
		const views = await paymentsOf(db, w.f.restaurantId, w.customer);
		expect(views.every((v) => v.shiftOpen === false)).toBe(true);
	});
});

describe('expected cash and the shift close', () => {
	it('MANDATORY: a busy shift closes on the exact figure — sums are not multiplied', async () => {
		const w = await world();
		// Sales: 2 cash (880 + 1760), 1 card (880), 2 on credit (2640 + 880).
		await cashSale(w, 1);
		await cashSale(w, 2);
		await cardSale(w, 1);
		await charge(w, 3);
		await charge(w, 1); // owes 3520
		// Customer payments: 2 cash (700 + 300), 1 card (400), 1 cash reversed (250).
		await paid(w, 700n, 'cash');
		await paid(w, 300n, 'cash');
		await paid(w, 400n, 'card');
		const wrong = await paid(w, 250n, 'cash');
		expect(await reverse(w, wrong)).toMatchObject({ ok: true });

		// 50,000 float + 2,640 cash sales + 1,000 cash customer payments.
		const expected = 53_640n;
		expect(await db.transaction((tx) => expectedCash(tx, w.f.restaurantId, w.session))).toBe(
			expected
		);

		await closeSessionAt(db, w.f, {
			posSessionId: w.session,
			closedAt: new Date(AT.getTime() + 7_200_000),
			countedCashMinor: expected - 40n // 0.40 short
		});

		const [closed] = await testDb().select().from(posSessions).where(eq(posSessions.id, w.session));
		expect(closed).toMatchObject({
			status: 'closed',
			expectedCashMinor: expected,
			countedCashMinor: expected - 40n,
			differenceMinor: -40n
		});
		// Only the true difference reaches 6800.
		const shortage = await testDb().execute<{ line: string }>(sql`
			select a.code || ' ' ||
			       case when l.debit_minor > 0 then 'Dr ' || l.debit_minor else 'Cr ' || l.credit_minor end as line
			from journal_entries e
			join journal_entry_lines l on l.entry_id = e.id
			join accounts a on a.id = l.account_id
			where e.source_type = 'pos_session' and e.source_id = ${w.session}
			order by l.line_no
		`);
		expect(shortage.rows.map((r) => r.line)).toEqual(['6800 Dr 40', '1000 Cr 40']);
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(2120n);
		expect((await receivableTripwire(db, w.f.restaurantId)).matches).toBe(true);
	});
});

describe('MANDATORY (risk panel blocker) — a payment or a cash reversal never races the shift close', () => {
	function closeContext(w: World) {
		return syncContext(w.f, {
			clientOpId: randomUUID(),
			occurredAt: new Date(AT.getTime() + 7_200_000)
		});
	}

	it('a cash reversal that started first: the close WAITS for it and counts without the payment', async () => {
		const w = await world();
		await charge(w, 5);
		const id = await paid(w, 2000n, 'cash'); // expected cash 52,000

		const hold = gate();
		let reversed = false;
		const reversal = db.transaction(async (tx) => {
			const result = await reverseCustomerPayment(tx, w.ctx, {
				paymentId: id,
				reason: 'Keyed twice'
			});
			reversed = true;
			await hold.wait; // the transaction stays open, holding the shift FOR SHARE
			return result;
		});
		while (!reversed) await pause(10);

		let closed = false;
		const close = db
			.transaction((tx) =>
				closeSession(tx, closeContext(w), {
					posSessionId: w.session,
					countedCashMinor: minor(50_000n)
				})
			)
			.then((r) => {
				closed = true;
				return r;
			});
		await pause(400);
		// The close is blocked behind the reversal's lock on the shift row.
		expect(closed).toBe(false);

		hold.open();
		expect(await reversal).toMatchObject({ ok: true });
		const result = await close;

		// It read expected cash AFTER the reversal committed: no false shortage.
		expect(result.expectedCashMinor).toBe(50_000n);
		expect(result.differenceMinor).toBe(0n);
		const entries = await testDb().execute<{ c: number }>(sql`
			select count(*)::int as c from journal_entries
			where source_type = 'pos_session' and source_id = ${w.session}
		`);
		expect(entries.rows[0].c).toBe(0);
	});

	it('a close that started first: the cash reversal WAITS, then is refused — nothing lands in the closed shift', async () => {
		const w = await world();
		await charge(w, 5);
		const id = await paid(w, 2000n, 'cash');

		const hold = gate();
		let closing = false;
		const close = db.transaction(async (tx) => {
			const result = await closeSession(tx, closeContext(w), {
				posSessionId: w.session,
				countedCashMinor: minor(52_000n)
			});
			closing = true;
			await hold.wait; // holds the shift FOR UPDATE, not yet committed
			return result;
		});
		while (!closing) await pause(10);

		let settled = false;
		const reversal = reverse(w, id).then((r) => {
			settled = true;
			return r;
		});
		const payment = receive(w, 500n).then((r) => {
			settled = true;
			return r;
		});
		await pause(400);
		expect(settled).toBe(false);

		hold.open();
		const result = await close;
		expect(result.expectedCashMinor).toBe(52_000n);
		expect(await reversal).toEqual({ ok: false, reason: 'shift_closed' });
		expect((await payment).result).toEqual({ ok: false, reason: 'session_closed' });

		// The closed shift's cash is exactly what it was counted against.
		expect(await linesOfPayment(id)).toEqual([
			'2026-09-28 1000 Dr 2000',
			'2026-09-28 1100 Cr 2000'
		]);
		expect(await counts(w.f.restaurantId)).toEqual({ payments: 1, entries: 1 });
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(2400n);
	});

	it('two payments racing for one balance: the second is refused, never both', async () => {
		const w = await world();
		await charge(w, 1); // owes 880
		const [a, b] = await Promise.all([receive(w, 600n), receive(w, 600n, 'card')]);
		const reasons = [a.result, b.result].map((r) => (r.ok ? 'ok' : r.reason)).sort();
		expect(reasons).toEqual(['exceeds_balance', 'ok']);
		expect(await balanceOf(db, w.f.restaurantId, w.customer)).toBe(280n);
	});
});
