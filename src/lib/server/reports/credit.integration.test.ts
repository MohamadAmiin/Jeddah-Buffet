import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb, testDb } from '../db/test/db';
import {
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type RecordSaleOptions,
	type SalesFixture
} from '../db/test/sales';
import { setCreditEnabled } from '../restaurants';
import { createCustomer } from '../customers';
import { receiveCustomerPayment, reverseCustomerPayment } from '../customers/payments';
import { add, minor, sum } from '../../money';
import { salesReport } from './sales';
import { creditReport } from './credit';

// Reports with customer credit in them (tasks/customer-credit T-14). Every
// identity the sales report states is pinned here on a day that mixes cash, card
// and credit sales with customer payments and reversals — the day on which
// "takings" stops meaning "everything sold".

afterAll(async () => {
	await closeTestDb();
});

const AT = new Date('2026-09-28T09:00:00Z');
const DAY = '2026-09-28';

type World = { f: SalesFixture; session: string; customer: string; seq: number };

async function world(): Promise<World> {
	const f = await seedSalesRestaurant(db);
	const session = randomUUID();
	await openSessionAt(db, f, { posSessionId: session, openedAt: AT, openingCashMinor: 0n });
	await db.transaction((tx) =>
		setCreditEnabled(tx, f.restaurantId, true, {
			actorUserId: f.ownerId,
			ip: null,
			userAgent: null
		})
	);
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

/** `quantity` burgers at 800 + 10%: 880 each. */
async function sell(w: World, method: RecordSaleOptions['method'], quantity: number) {
	w.seq += 1;
	return recordSaleAt(db, w.f, {
		posSessionId: w.session,
		occurredAt: new Date(AT.getTime() + w.seq * 60_000),
		invoiceSeq: w.seq,
		method,
		...(method === 'credit' ? { customer: { id: w.customer, name: 'Ali Hassan' } } : {}),
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
	});
}

async function pay(w: World, amount: bigint, method: 'cash' | 'card' | 'mobile'): Promise<string> {
	const paymentId = randomUUID();
	const at = new Date(AT.getTime() + 3_600_000 + w.seq++ * 1000);
	const result = await db.transaction((tx) =>
		receiveCustomerPayment(
			tx,
			{
				restaurantId: w.f.restaurantId,
				actorUserId: w.f.staffId,
				deviceId: w.f.deviceId,
				clientOpId: randomUUID(),
				occurredAt: at,
				ip: null,
				userAgent: null
			},
			{
				paymentId,
				customerId: w.customer,
				posSessionId: w.session,
				method,
				paymentMethodId: w.f.paymentMethods[method].id,
				paymentMethodName: w.f.paymentMethods[method].name,
				amountMinor: minor(amount),
				tenderedMinor: method === 'cash' ? minor(amount) : null,
				changeMinor: method === 'cash' ? minor(0n) : null,
				receivedAt: at
			}
		)
	);
	if (!result.ok) throw new Error(result.reason);
	return paymentId;
}

const reverse = (w: World, paymentId: string) =>
	db.transaction((tx) =>
		reverseCustomerPayment(
			tx,
			{ restaurantId: w.f.restaurantId, actorUserId: w.f.ownerId, ip: null, userAgent: null },
			{ paymentId, reason: 'Keyed twice' }
		)
	);

async function today(restaurantId: string): Promise<string> {
	const result = await testDb().execute<{ today: string }>(sql`
		select to_char(now() at time zone s.time_zone, 'YYYY-MM-DD') as today
		from restaurant_settings s where s.restaurant_id = ${restaurantId}
	`);
	return result.rows[0].today;
}

/** Cash 880, card 1760, credit 2640: net sales 4800 + tax 480 = 5280. */
async function mixedDay(): Promise<World> {
	const w = await world();
	await sell(w, 'cash', 1);
	await sell(w, 'card', 2);
	await sell(w, 'credit', 3);
	return w;
}

describe('the sales report on a day with credit sales', () => {
	it('takings are money received; net sales + tax = takings + sold on credit', async () => {
		const w = await mixedDay();
		const { totals } = await salesReport(db, w.f.restaurantId, DAY);

		expect(totals).toMatchObject({
			grossSales: 4800n,
			netSales: 4800n,
			tax: 480n,
			takings: 2640n,
			soldOnCredit: 2640n,
			orderCount: 3
		});
		expect(add(totals.netSales, totals.tax)).toBe(add(totals.takings, totals.soldOnCredit));
	});

	it('by tender: cash + card + mobile = takings; credit is its own row; all of it = net sales + tax', async () => {
		const w = await mixedDay();
		const report = await salesReport(db, w.f.restaurantId, DAY);

		expect(report.byTender).toEqual([
			{ method: 'cash', amount: 880n, count: 1 },
			{ method: 'card', amount: 1760n, count: 1 },
			{ method: 'mobile', amount: 0n, count: 0 },
			{ method: 'credit', amount: 2640n, count: 1 }
		]);
		const received = report.byTender.filter((t) => t.method !== 'credit');
		expect(sum(received.map((t) => t.amount))).toBe(report.totals.takings);
		expect(sum(report.byTender.map((t) => t.amount))).toBe(
			add(report.totals.netSales, report.totals.tax)
		);
	});

	it('by payment method: the credit row comes last, by name, and the rows sum to takings + sold on credit', async () => {
		const w = await mixedDay();
		const report = await salesReport(db, w.f.restaurantId, DAY);

		expect(report.byPaymentMethod.map((m) => [m.name, m.kind, m.amount, m.count])).toEqual([
			['Cash', 'cash', 880n, 1],
			['Card', 'card', 1760n, 1],
			['Customer credit', 'credit', 2640n, 1]
		]);
		expect(sum(report.byPaymentMethod.map((m) => m.amount))).toBe(
			add(report.totals.takings, report.totals.soldOnCredit)
		);
	});

	it('by order type, by employee and by item still sum to net sales + tax', async () => {
		const w = await mixedDay();
		const report = await salesReport(db, w.f.restaurantId, DAY);
		const all = add(report.totals.netSales, report.totals.tax);

		expect(sum(report.byOrderType.map((r) => r.amount))).toBe(all);
		expect(sum(report.byEmployee.map((r) => r.amount))).toBe(all);
		expect(report.byItem.map((r) => [r.itemName, r.quantity])).toEqual([['Burger', 6]]);
	});

	it('a day with no credit sales has no credit row and zero sold on credit', async () => {
		const w = await world();
		await sell(w, 'cash', 1);
		const report = await salesReport(db, w.f.restaurantId, DAY);
		expect(report.byTender.map((t) => t.method)).toEqual(['cash', 'card', 'mobile']);
		expect(report.totals.soldOnCredit).toBe(0n);
		expect(report.totals.takings).toBe(880n);
	});
});

describe('customer payments received are never takings', () => {
	it('a payment appears only under customer payments; takings and sales are unchanged', async () => {
		const w = await mixedDay();
		const before = await salesReport(db, w.f.restaurantId, DAY);
		await pay(w, 1000n, 'cash');
		await pay(w, 500n, 'mobile');
		const after = await salesReport(db, w.f.restaurantId, DAY);

		expect(after.totals).toEqual(before.totals);
		expect(after.byTender).toEqual(before.byTender);
		expect(after.customerPayments).toEqual({
			rows: [
				{
					paymentMethodId: w.f.paymentMethods.cash.id,
					name: 'Cash',
					kind: 'cash',
					received: 1000n,
					reversed: 0n,
					net: 1000n,
					count: 1
				},
				{
					paymentMethodId: w.f.paymentMethods.mobile.id,
					name: 'Mobile money',
					kind: 'mobile',
					received: 500n,
					reversed: 0n,
					net: 500n,
					count: 1
				}
			],
			net: 1500n
		});
	});

	it('a reversal is its own negative on its own date: the payment’s day never changes', async () => {
		const w = await mixedDay();
		await pay(w, 1000n, 'cash');
		const mobile = await pay(w, 500n, 'mobile');
		const wrong = await pay(w, 250n, 'cash');
		const onTheDay = await salesReport(db, w.f.restaurantId, DAY);

		// The mobile reversal is dated today; the cash one its shift's date (the 28th).
		expect(await reverse(w, mobile)).toMatchObject({ ok: true });
		expect(await reverse(w, wrong)).toEqual({ ok: true, reversalBusinessDate: DAY });

		const day = await salesReport(db, w.f.restaurantId, DAY);
		const cash = day.customerPayments.rows.find((r) => r.kind === 'cash');
		const mob = day.customerPayments.rows.find((r) => r.kind === 'mobile');
		expect(cash).toMatchObject({ received: 1250n, reversed: 250n, net: 1000n, count: 2 });
		// Unchanged by a reversal made on another day.
		expect(mob).toEqual(onTheDay.customerPayments.rows.find((r) => r.kind === 'mobile'));
		expect(day.customerPayments.net).toBe(1500n);

		const now = await salesReport(db, w.f.restaurantId, await today(w.f.restaurantId));
		expect(now.customerPayments).toEqual({
			rows: [
				{
					paymentMethodId: w.f.paymentMethods.mobile.id,
					name: 'Mobile money',
					kind: 'mobile',
					received: 0n,
					reversed: 500n,
					net: -500n,
					count: 0
				}
			],
			net: -500n
		});
		// A day that holds only a reversal has no sales.
		expect(now.totals.orderCount).toBe(0);
	});
});

describe('the customer credit report', () => {
	it('lists every charge and payment of the range, with a total per cashier', async () => {
		const w = await mixedDay();
		await pay(w, 1000n, 'cash');
		const wrong = await pay(w, 250n, 'cash');
		await pay(w, 500n, 'mobile');
		await reverse(w, wrong);

		const report = await creditReport(db, w.f.restaurantId, { from: DAY, to: DAY });

		expect(report.charges).toHaveLength(1);
		expect(report.charges[0]).toMatchObject({
			invoiceNumber: `${w.f.deviceCode}-000003`,
			businessDate: DAY,
			customerId: w.customer,
			customerName: 'Ali Hassan',
			cashier: 'Sam',
			tillCode: w.f.deviceCode,
			amountMinor: 2640n
		});
		expect(report.payments.map((p) => [p.kind, p.methodName, p.amountMinor, p.reason])).toEqual([
			['payment', 'Cash', 1000n, null],
			['payment', 'Cash', 250n, null],
			['payment', 'Mobile money', 500n, null],
			['reversal', 'Cash', 250n, 'Keyed twice']
		]);
		expect(report.payments[3].cashier).toBe('Owner');
		expect(report.byCashier).toEqual([
			{
				userId: w.f.staffId,
				cashier: 'Sam',
				charges: 1,
				chargedMinor: 2640n,
				payments: 3,
				receivedMinor: 1750n
			}
		]);
		expect(report.chargedMinor).toBe(2640n);
		expect(report.receivedNetMinor).toBe(1500n);
	});

	it('is empty outside the range, never shows another restaurant, and refuses a bad date', async () => {
		const w = await mixedDay();
		const other = await mixedDay();
		await pay(w, 1000n, 'cash');

		const outside = await creditReport(db, w.f.restaurantId, {
			from: '2026-01-01',
			to: '2026-01-31'
		});
		expect(outside).toMatchObject({ charges: [], payments: [], byCashier: [], chargedMinor: 0n });

		const theirs = await creditReport(db, other.f.restaurantId, { from: DAY, to: DAY });
		expect(theirs.charges.map((c) => c.customerId)).toEqual([other.customer]);
		expect(theirs.payments).toEqual([]);

		await expect(
			creditReport(db, w.f.restaurantId, { from: '28/09/2026', to: DAY })
		).rejects.toThrow(RangeError);
	});
});
