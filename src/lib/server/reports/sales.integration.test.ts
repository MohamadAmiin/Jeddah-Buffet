import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb, testDb } from '../db/test/db';
import {
	seedSalesRestaurant,
	openSessionAt,
	closeSessionAt,
	recordSaleAt,
	withSecondDevice,
	type SalesFixture
} from '../db/test/sales';
import { seedPaymentMethod } from '../db/test/settings';
import { orders, payments } from '../db/schema/orders';
import { archivePaymentMethod, updatePaymentMethod } from '../restaurants';
import { ORDER_TYPES } from '../../sync-ops';
import { defaultReportDate, salesReport } from './sales';

afterAll(async () => {
	await closeTestDb();
});

async function seedThreeSessions(f: SalesFixture) {
	// S1 opened 28th 08:00 local (Africa/Mogadishu UTC+3) → 05:00Z.
	const s1 = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: s1,
		openedAt: new Date('2026-09-28T05:00:00Z'),
		openingCashMinor: 10000n
	});
	// Sale A on S1: 1 × Burger + Extra cheese, cash, dine-in T4, 06:00Z.
	await recordSaleAt(db, f, {
		posSessionId: s1,
		occurredAt: new Date('2026-09-28T06:00:00Z'),
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'dine_in',
		tableLabel: 'T4',
		lines: [
			{
				menuItemId: f.items.burger,
				itemName: 'Burger',
				quantity: 1,
				unitPriceMinor: 800n,
				taxRateBp: f.taxRateBp,
				modifiers: [
					{
						modifierId: f.modifiers.extraCheese,
						modifierName: 'Extra cheese',
						priceDeltaMinor: 50n
					}
				]
			}
		]
	});
	await closeSessionAt(db, f, {
		posSessionId: s1,
		closedAt: new Date('2026-09-28T11:00:00Z'),
		countedCashMinor: 10900n
	});

	// S2 opened 28th 18:00 local → 15:00Z, left open across midnight.
	const s2 = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: s2,
		openedAt: new Date('2026-09-28T15:00:00Z'),
		openingCashMinor: 10000n
	});
	// Sale B on S2: 2 × Burger, card, dine-in, 17:00Z.
	await recordSaleAt(db, f, {
		posSessionId: s2,
		occurredAt: new Date('2026-09-28T17:00:00Z'),
		invoiceSeq: 2,
		method: 'card',
		orderType: 'dine_in',
		tableLabel: null,
		lines: [
			{
				menuItemId: f.items.burger,
				itemName: 'Burger',
				quantity: 2,
				unitPriceMinor: 800n,
				taxRateBp: f.taxRateBp
			}
		]
	});
	// Sale C on S2: 3 × Tea, cash, takeaway, 29th 01:30 local = 28th 22:30Z.
	await recordSaleAt(db, f, {
		posSessionId: s2,
		occurredAt: new Date('2026-09-28T22:30:00Z'),
		invoiceSeq: 3,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines: [
			{
				menuItemId: f.items.tea,
				itemName: 'Tea',
				quantity: 3,
				unitPriceMinor: 200n,
				taxRateBp: f.taxRateBp
			}
		]
	});

	// S3 opened 29th 09:00 local → 06:00Z, left open. S2 is still open on POS1
	// and a device holds one open session, so S3 runs on a second till.
	const f2 = await withSecondDevice(db, f);
	const s3 = randomUUID();
	await openSessionAt(db, f2, {
		posSessionId: s3,
		openedAt: new Date('2026-09-29T06:00:00Z'),
		openingCashMinor: 5000n
	});
	// Sale D on S3: 1 × Burger, cash, dine-in T1, 06:30Z.
	await recordSaleAt(db, f2, {
		posSessionId: s3,
		occurredAt: new Date('2026-09-29T06:30:00Z'),
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'dine_in',
		tableLabel: 'T1',
		lines: [
			{
				menuItemId: f.items.burger,
				itemName: 'Burger',
				quantity: 1,
				unitPriceMinor: 800n,
				taxRateBp: f.taxRateBp
			}
		]
	});

	return { s1, s2, s3 };
}

/**
 * A paid order and its payment as stored BEFORE named methods: payment_method_id
 * and payment_method_name both NULL (payments_payment_method_pair). Copied from
 * insertPaidCashOrder in src/lib/server/pos-sessions/sessions.integration.test.ts.
 * An INSERT, never an update: payments are append-only (0012; invariant 2).
 */
async function insertPrePlanPayment(
	f: SalesFixture,
	posSessionId: string,
	o: { method: 'cash' | 'mobile'; amountMinor: bigint; at: Date }
): Promise<void> {
	const [orderRow] = await testDb()
		.insert(orders)
		.values({
			restaurantId: f.restaurantId,
			posSessionId,
			deviceId: f.deviceId,
			employeeUserId: f.staffId,
			orderType: 'takeaway',
			status: 'paid',
			taxMode: f.taxMode,
			currencyCode: 'USD',
			menuVersion: f.menuVersion,
			subtotalMinor: o.amountMinor,
			discountMinor: 0n,
			taxMinor: 0n,
			totalMinor: o.amountMinor,
			openedAt: o.at,
			paidAt: o.at
		})
		.returning({ id: orders.id });
	await testDb()
		.insert(payments)
		.values({
			restaurantId: f.restaurantId,
			orderId: orderRow.id,
			method: o.method,
			amountMinor: o.amountMinor,
			tenderedMinor: o.method === 'cash' ? o.amountMinor : null,
			changeMinor: o.method === 'cash' ? 0n : null,
			paidAt: o.at
		});
}

/**
 * seedThreeSessions, then (settings-tax-payments-receipt T-17) two named mobile
 * methods with one sale each on S2 — Tea ×1 by 'EVC Plus' (220), Tea ×2 by 'Zaad'
 * (440) — and two pre-plan payments on S2: mobile 300 and cash 500.
 */
async function seedNamedAndPrePlanPayments(f: SalesFixture) {
	const { s2 } = await seedThreeSessions(f);
	const ctx = { actorUserId: f.ownerId, ip: null, userAgent: null };
	const evcId = await db.transaction((tx) =>
		seedPaymentMethod(tx, f.restaurantId, { name: 'EVC Plus', kind: 'mobile' }, ctx)
	);
	const zaadId = await db.transaction((tx) =>
		seedPaymentMethod(tx, f.restaurantId, { name: 'Zaad', kind: 'mobile' }, ctx)
	);
	const tea = (quantity: number) => [
		{
			menuItemId: f.items.tea,
			itemName: 'Tea',
			quantity,
			unitPriceMinor: 200n,
			taxRateBp: f.taxRateBp
		}
	];
	await recordSaleAt(db, f, {
		posSessionId: s2,
		occurredAt: new Date('2026-09-28T18:00:00Z'),
		invoiceSeq: 4,
		method: 'mobile',
		paymentMethod: { id: evcId, name: 'EVC Plus' },
		orderType: 'takeaway',
		tableLabel: null,
		lines: tea(1)
	});
	await recordSaleAt(db, f, {
		posSessionId: s2,
		occurredAt: new Date('2026-09-28T19:00:00Z'),
		invoiceSeq: 5,
		method: 'mobile',
		paymentMethod: { id: zaadId, name: 'Zaad' },
		orderType: 'takeaway',
		tableLabel: null,
		lines: tea(2)
	});
	await insertPrePlanPayment(f, s2, {
		method: 'mobile',
		amountMinor: 300n,
		at: new Date('2026-09-28T20:00:00Z')
	});
	await insertPrePlanPayment(f, s2, {
		method: 'cash',
		amountMinor: 500n,
		at: new Date('2026-09-28T20:30:00Z')
	});
	return { s2, evcId, zaadId, ctx };
}

let fx: SalesFixture;
beforeEach(async () => {
	fx = await seedSalesRestaurant(db);
});

describe('salesReport — totals and business date grouping', () => {
	it('the 28th aggregates A, B and C', async () => {
		await seedThreeSessions(fx);
		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(report.totals.grossSales).toBe(3050n);
		expect(report.totals.discounts).toBe(0n);
		expect(report.totals.netSales).toBe(3050n);
		expect(report.totals.tax).toBe(305n);
		expect(report.totals.takings).toBe(3355n);
		expect(report.totals.orderCount).toBe(3);
		// Spec 25 identity: takings === netSales + tax.
		expect(report.totals.takings).toBe(report.totals.netSales + report.totals.tax);
	});

	it('the 01:30 sale belongs to the 28th, not the 29th', async () => {
		await seedThreeSessions(fx);
		const day28 = await salesReport(db, fx.restaurantId, '2026-09-28');
		const teaRow = day28.byItem.find((r) => r.itemName === 'Tea');
		expect(teaRow).toEqual({
			menuItemId: fx.items.tea,
			itemName: 'Tea',
			quantity: 3,
			amount: 600n
		});
		const day29 = await salesReport(db, fx.restaurantId, '2026-09-29');
		expect(day29.byItem.find((r) => r.itemName === 'Tea')).toBeUndefined();
		expect(day29.totals.orderCount).toBe(1);
		expect(day29.totals.takings).toBe(880n);
	});

	it('byTender always returns three rows in cash/card/mobile order', async () => {
		await seedThreeSessions(fx);
		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(report.byTender).toEqual([
			{ method: 'cash', amount: 1595n, count: 2 },
			{ method: 'card', amount: 1760n, count: 1 },
			{ method: 'mobile', amount: 0n, count: 0 }
		]);
		const sumTenders = report.byTender.reduce((acc, r) => acc + r.amount, 0n);
		expect(sumTenders).toBe(report.totals.takings);
	});

	// settings-tax-payments-receipt T-17 (spec 26 "Sales by Payment Method").
	it('byPaymentMethod groups by named method, cash first, unrecorded rows last', async () => {
		const { evcId, zaadId } = await seedNamedAndPrePlanPayments(fx);
		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(report.byPaymentMethod).toEqual([
			// 935 (sale A) + 660 (sale C) + the folded pre-plan 500.
			{
				paymentMethodId: fx.paymentMethods.cash.id,
				name: 'Cash',
				kind: 'cash',
				archived: false,
				amount: 2095n,
				count: 3
			},
			{
				paymentMethodId: fx.paymentMethods.card.id,
				name: 'Card',
				kind: 'card',
				archived: false,
				amount: 1760n,
				count: 1
			},
			{
				paymentMethodId: evcId,
				name: 'EVC Plus',
				kind: 'mobile',
				archived: false,
				amount: 220n,
				count: 1
			},
			{
				paymentMethodId: zaadId,
				name: 'Zaad',
				kind: 'mobile',
				archived: false,
				amount: 440n,
				count: 1
			},
			{
				paymentMethodId: null,
				name: 'Mobile money (method not recorded)',
				kind: 'mobile',
				archived: false,
				amount: 300n,
				count: 1
			}
		]);
		// Nothing dropped: the section sums to what customers paid.
		const sumMethods = report.byPaymentMethod.reduce((acc, r) => acc + r.amount, 0n);
		expect(sumMethods).toBe(4815n);
		expect(sumMethods).toBe(report.totals.takings);
		// byTender is still by KIND, unchanged.
		expect(report.byTender).toEqual([
			{ method: 'cash', amount: 2095n, count: 3 },
			{ method: 'card', amount: 1760n, count: 1 },
			{ method: 'mobile', amount: 960n, count: 3 }
		]);
	});

	it("the section shows a method's current name; payments keep the name they were taken under", async () => {
		const { evcId, zaadId, ctx } = await seedNamedAndPrePlanPayments(fx);
		const results = await db.transaction(async (tx) => [
			await updatePaymentMethod(tx, fx.restaurantId, evcId, { name: 'EVC Plus Hormuud' }, ctx),
			await archivePaymentMethod(tx, fx.restaurantId, zaadId, ctx)
		]);
		expect(results).toEqual([{ ok: true, changed: true }, { ok: true }]);

		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		// Grouped by the method ROW: the rename relabels EVC Plus's one row instead of
		// splitting its takings in two, and the archived Zaad keeps its row.
		expect(report.byPaymentMethod).toEqual([
			{
				paymentMethodId: fx.paymentMethods.cash.id,
				name: 'Cash',
				kind: 'cash',
				archived: false,
				amount: 2095n,
				count: 3
			},
			{
				paymentMethodId: fx.paymentMethods.card.id,
				name: 'Card',
				kind: 'card',
				archived: false,
				amount: 1760n,
				count: 1
			},
			{
				paymentMethodId: evcId,
				name: 'EVC Plus Hormuud',
				kind: 'mobile',
				archived: false,
				amount: 220n,
				count: 1
			},
			{
				paymentMethodId: zaadId,
				name: 'Zaad',
				kind: 'mobile',
				archived: true,
				amount: 440n,
				count: 1
			},
			{
				paymentMethodId: null,
				name: 'Mobile money (method not recorded)',
				kind: 'mobile',
				archived: false,
				amount: 300n,
				count: 1
			}
		]);

		// The payment keeps the name it was taken under (invariant 2: never rewritten).
		const stored = await db
			.select({ name: payments.paymentMethodName })
			.from(payments)
			.where(eq(payments.paymentMethodId, evcId));
		expect(stored).toEqual([{ name: 'EVC Plus' }]);
	});

	it('byOrderType, byEmployee, byItem, byCategory', async () => {
		await seedThreeSessions(fx);
		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(report.byOrderType).toEqual([
			{ orderType: 'dine_in', amount: 2695n, count: 2 },
			{ orderType: 'takeaway', amount: 660n, count: 1 },
			{ orderType: 'delivery', amount: 0n, count: 0 }
		]);
		expect(report.byEmployee).toEqual([
			{ userId: fx.staffId, displayName: 'Sam', amount: 3355n, count: 3 }
		]);
		expect(report.byItem).toEqual([
			{ menuItemId: fx.items.burger, itemName: 'Burger', quantity: 3, amount: 2450n },
			{ menuItemId: fx.items.tea, itemName: 'Tea', quantity: 3, amount: 600n }
		]);
		const totalUnits = report.byItem.reduce((acc, r) => acc + r.quantity, 0);
		expect(totalUnits).toBe(6);
		const sumItems = report.byItem.reduce((acc, r) => acc + r.amount, 0n);
		expect(sumItems).toBe(report.totals.grossSales);
		expect(
			report.byCategory.map((c) => ({ name: c.name, quantity: c.quantity, amount: c.amount }))
		).toEqual([
			{ name: 'Food', quantity: 3, amount: 2450n },
			{ name: 'Drinks', quantity: 3, amount: 600n }
		]);
	});

	// menu-and-printing T-10: the third type is a row of its own, in ORDER_TYPES
	// order, and the three rows sum to the takings — nothing drops out (spec 26).
	it('byOrderType lists every type and sums to the takings', async () => {
		const sid = randomUUID();
		await openSessionAt(db, fx, {
			posSessionId: sid,
			openedAt: new Date('2026-09-28T05:00:00Z'),
			openingCashMinor: 10000n
		});
		const burger = (quantity: number, modifiers = false) => [
			{
				menuItemId: fx.items.burger,
				itemName: 'Burger',
				quantity,
				unitPriceMinor: 800n,
				taxRateBp: fx.taxRateBp,
				...(modifiers
					? {
							modifiers: [
								{
									modifierId: fx.modifiers.extraCheese,
									modifierName: 'Extra cheese',
									priceDeltaMinor: 50n
								}
							]
						}
					: {})
			}
		];
		await recordSaleAt(db, fx, {
			posSessionId: sid,
			occurredAt: new Date('2026-09-28T06:00:00Z'),
			invoiceSeq: 1,
			method: 'cash',
			orderType: 'dine_in',
			tableLabel: 'T4',
			lines: burger(1)
		});
		await recordSaleAt(db, fx, {
			posSessionId: sid,
			occurredAt: new Date('2026-09-28T07:00:00Z'),
			invoiceSeq: 2,
			method: 'cash',
			orderType: 'takeaway',
			tableLabel: null,
			lines: [
				{
					menuItemId: fx.items.tea,
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: 200n,
					taxRateBp: fx.taxRateBp
				}
			]
		});
		await recordSaleAt(db, fx, {
			posSessionId: sid,
			occurredAt: new Date('2026-09-28T08:00:00Z'),
			invoiceSeq: 3,
			method: 'cash',
			orderType: 'delivery',
			tableLabel: null,
			lines: burger(1, true)
		});

		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(report.byOrderType.map((r) => r.orderType)).toEqual([...ORDER_TYPES]);
		expect(report.byOrderType).toEqual([
			{ orderType: 'dine_in', amount: 880n, count: 1 },
			{ orderType: 'takeaway', amount: 220n, count: 1 },
			{ orderType: 'delivery', amount: 935n, count: 1 }
		]);
		const sum = report.byOrderType.reduce((acc, r) => acc + r.amount, 0n);
		expect(sum).toBe(report.totals.takings);
		expect(report.totals.orderCount).toBe(3);
	});

	it('sessions on the 28th list S1 (closed) and S2 (open)', async () => {
		await seedThreeSessions(fx);
		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(report.sessions).toHaveLength(2);
		const [s1Row, s2Row] = report.sessions;
		expect(s1Row.deviceCode).toBe('POS1');
		expect(s1Row.status).toBe('closed');
		expect(s1Row.openingCash).toBe(10000n);
		expect(s1Row.expectedCash).toBe(10935n);
		expect(s1Row.countedCash).toBe(10900n);
		expect(s1Row.difference).toBe(-35n);
		expect(s2Row.status).toBe('open');
		expect(s2Row.expectedCash).toBeNull();
		expect(s2Row.countedCash).toBeNull();
		expect(s2Row.difference).toBeNull();
		expect(report.flagged).toEqual({ count: 0, unrecordedCount: 0 });
	});
});

describe('defaultReportDate', () => {
	it("returns the recent session's date at 00:40 the next day", async () => {
		await seedThreeSessions(fx);
		expect(await defaultReportDate(db, fx.restaurantId, new Date('2026-09-28T21:40:00Z'))).toBe(
			'2026-09-28'
		);
	});
	it('returns the S3 date at 23:00 local on the 29th', async () => {
		await seedThreeSessions(fx);
		expect(await defaultReportDate(db, fx.restaurantId, new Date('2026-09-29T20:00:00Z'))).toBe(
			'2026-09-29'
		);
	});
	it("falls back to the zone's calendar today when nothing opened in 24 hours", async () => {
		await seedThreeSessions(fx);
		expect(await defaultReportDate(db, fx.restaurantId, new Date('2026-09-30T22:00:00Z'))).toBe(
			'2026-10-01'
		);
	});
});

describe('salesReport — tenant isolation and edge cases', () => {
	it('another restaurant with inclusive tax at 20% preserves the identity and never leaks', async () => {
		await seedThreeSessions(fx);
		const other = await seedSalesRestaurant(db, { taxMode: 'inclusive', taxRateBp: 2000 });
		const otherSession = randomUUID();
		await openSessionAt(db, other, {
			posSessionId: otherSession,
			openedAt: new Date('2026-09-28T09:00:00Z'),
			openingCashMinor: 0n
		});
		await recordSaleAt(db, other, {
			posSessionId: otherSession,
			occurredAt: new Date('2026-09-28T10:00:00Z'),
			invoiceSeq: 1,
			method: 'cash',
			orderType: 'takeaway',
			tableLabel: null,
			lines: [
				{
					menuItemId: other.items.special,
					itemName: 'Special',
					quantity: 1,
					unitPriceMinor: 999n,
					taxRateBp: other.taxRateBp
				}
			]
		});
		const otherReport = await salesReport(db, other.restaurantId, '2026-09-28');
		expect(otherReport.totals.grossSales).toBe(832n);
		expect(otherReport.totals.tax).toBe(167n);
		expect(otherReport.totals.takings).toBe(999n);
		expect(otherReport.totals.takings).toBe(otherReport.totals.netSales + otherReport.totals.tax);
		expect(otherReport.byItem).toEqual([
			{ menuItemId: other.items.special, itemName: 'Special', quantity: 1, amount: 999n }
		]);
		// T-17: every method in its report is one of ITS methods.
		const otherMethodIds = Object.values(other.paymentMethods).map((m) => m.id);
		expect(otherReport.byPaymentMethod.length).toBeGreaterThan(0);
		for (const row of otherReport.byPaymentMethod) {
			expect(otherMethodIds).toContain(row.paymentMethodId);
		}

		// The first restaurant is unchanged.
		const firstReport = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(firstReport.totals.orderCount).toBe(3);
	});

	it('empty date returns zeros and empty sections', async () => {
		const report = await salesReport(db, fx.restaurantId, '2026-01-01');
		expect(report.totals).toEqual({
			grossSales: 0n,
			discounts: 0n,
			netSales: 0n,
			tax: 0n,
			takings: 0n,
			orderCount: 0
		});
		expect(report.byTender).toEqual([
			{ method: 'cash', amount: 0n, count: 0 },
			{ method: 'card', amount: 0n, count: 0 },
			{ method: 'mobile', amount: 0n, count: 0 }
		]);
		expect(report.byPaymentMethod).toEqual([]);
		expect(report.byOrderType).toEqual([
			{ orderType: 'dine_in', amount: 0n, count: 0 },
			{ orderType: 'takeaway', amount: 0n, count: 0 },
			{ orderType: 'delivery', amount: 0n, count: 0 }
		]);
		expect(report.byEmployee).toEqual([]);
		expect(report.byItem).toEqual([]);
		expect(report.byCategory).toEqual([]);
		expect(report.sessions).toEqual([]);
		expect(report.flagged).toEqual({ count: 0, unrecordedCount: 0 });
	});

	it('rejects a bad date shape', async () => {
		await expect(salesReport(db, fx.restaurantId, '28/09/2026')).rejects.toBeInstanceOf(RangeError);
	});
});

describe('MANDATORY (spec 29) — money arithmetic', () => {
	it('every money field is a bigint; JSON.stringify throws', async () => {
		await seedThreeSessions(fx);
		const report = await salesReport(db, fx.restaurantId, '2026-09-28');
		expect(typeof report.totals.takings).toBe('bigint');
		expect(typeof report.totals.grossSales).toBe('bigint');
		expect(typeof report.byTender[0].amount).toBe('bigint');
		expect(typeof report.byPaymentMethod[0].amount).toBe('bigint');
		expect(() => JSON.stringify(report)).toThrow();
	});
});
