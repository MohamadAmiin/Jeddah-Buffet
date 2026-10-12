import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb } from '../db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '../db/test/sales';
import { orderLineModifiers, orderLines, orders, payments } from '../db/schema/orders';
import { postEntry } from '../accounting/journal';
import { cogsLines, countSurplusLines, wasteLines } from '../accounting/posting-rules';
import { minor } from '../../money';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { seedTaxRate } from '../db/test/settings';
import { updateItem } from '../menu';
import { salesReportRange } from './sales';
import {
	byBusinessDate,
	countLines,
	countOrders,
	lineRows,
	orderRows,
	salesByTaxRate,
	sumDays
} from './detail';

// tasks/sales-report-export T-04..T-06 — the detail queries. Zone
// Africa/Mogadishu (UTC+3), exclusive 10% (the fixture's defaults).

afterAll(async () => {
	await closeTestDb();
});

let fx: SalesFixture;
beforeEach(async () => {
	fx = await seedSalesRestaurant(db);
});

const burger = (f: SalesFixture, quantity = 1) => ({
	menuItemId: f.items.burger,
	itemName: 'Burger',
	quantity,
	unitPriceMinor: 800n,
	taxRateBp: f.taxRateBp
});
const tea = (f: SalesFixture, quantity = 1) => ({
	menuItemId: f.items.tea,
	itemName: 'Tea',
	quantity,
	unitPriceMinor: 200n,
	taxRateBp: f.taxRateBp
});

/**
 * S1 opens the 28th 18:00 local (15:00Z) and stays OPEN across midnight:
 * sale 1 (Burger, cash) at 17:00Z and sale 2 (2 × Tea, card) at 22:30Z = the
 * 29th 01:30 local, which belongs to the 28th. S1 then closes, and S2 opens
 * the 29th 09:00 local (06:00Z) with sale 3 (Burger ×2, cash), left open.
 */
async function seedDays(f: SalesFixture) {
	const s1 = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: s1,
		openedAt: new Date('2026-09-28T15:00:00Z'),
		openingCashMinor: 0n
	});
	await recordSaleAt(db, f, {
		posSessionId: s1,
		occurredAt: new Date('2026-09-28T17:00:00Z'),
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'dine_in',
		tableLabel: 'T4',
		lines: [burger(f)]
	});
	await recordSaleAt(db, f, {
		posSessionId: s1,
		occurredAt: new Date('2026-09-28T22:30:00Z'),
		invoiceSeq: 2,
		method: 'card',
		orderType: 'takeaway',
		tableLabel: null,
		lines: [tea(f, 2)]
	});
	await closeSessionAt(db, f, {
		posSessionId: s1,
		closedAt: new Date('2026-09-28T23:00:00Z'),
		countedCashMinor: 880n
	});
	const s2 = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: s2,
		openedAt: new Date('2026-09-29T06:00:00Z'),
		openingCashMinor: 0n
	});
	await recordSaleAt(db, f, {
		posSessionId: s2,
		occurredAt: new Date('2026-09-29T07:00:00Z'),
		invoiceSeq: 3,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines: [burger(f, 2)]
	});
	return { s1, s2 };
}

/** One balanced entry through the journal writer, on a chosen business date. */
async function post(
	f: SalesFixture,
	businessDate: string,
	event: 'waste' | 'stock_count_surplus' | 'cost_of_goods_sold',
	lines: ReturnType<typeof wasteLines>
) {
	const sourceType =
		event === 'waste' ? 'waste_entry' : event === 'stock_count_surplus' ? 'stock_count' : 'order';
	await db.transaction((tx) =>
		postEntry(tx, {
			restaurantId: f.restaurantId,
			businessDate,
			event,
			sourceType,
			sourceId: randomUUID(),
			memo: 'report test',
			lines
		})
	);
}

describe('byBusinessDate and sumDays (T-04)', () => {
	it('returns one row per day of the range, empty days included', async () => {
		await seedDays(fx);
		const rows = await byBusinessDate(db, fx.restaurantId, '2026-09-27', '2026-09-30');
		expect(rows.map((r) => r.businessDate)).toEqual([
			'2026-09-27',
			'2026-09-28',
			'2026-09-29',
			'2026-09-30'
		]);
		expect(rows[0]).toEqual(
			expect.objectContaining({ orderCount: 0, grossSales: 0n, takings: 0n, grossProfit: 0n })
		);
		// The 01:30 card sale belongs to the 28th (invariant 11).
		expect(rows[1]).toEqual(
			expect.objectContaining({
				orderCount: 2,
				grossSales: 1200n,
				tax: 120n,
				takings: 1320n,
				openShifts: 0
			})
		);
		expect(rows[2]).toEqual(
			expect.objectContaining({ orderCount: 1, grossSales: 1600n, openShifts: 1 })
		);
	});

	it('each day matches salesReportRange for that day', async () => {
		await seedDays(fx);
		const rows = await byBusinessDate(db, fx.restaurantId, '2026-09-28', '2026-09-29');
		for (const row of rows) {
			const day = await salesReportRange(db, fx.restaurantId, row.businessDate, row.businessDate);
			expect(row.grossSales).toBe(day.totals.grossSales);
			expect(row.discounts).toBe(day.totals.discounts);
			expect(row.netSales).toBe(day.totals.netSales);
			expect(row.tax).toBe(day.totals.tax);
			expect(row.takings).toBe(day.totals.takings);
			expect(row.orderCount).toBe(day.totals.orderCount);
		}
	});

	it('a waste-only day carries its cost, and the range totals include it', async () => {
		await seedDays(fx);
		await post(fx, '2026-09-28', 'cost_of_goods_sold', cogsLines(minor(300n)));
		await post(fx, '2026-09-30', 'waste', wasteLines(minor(4000n)));
		const rows = await byBusinessDate(db, fx.restaurantId, '2026-09-28', '2026-09-30');
		expect(rows[0]).toEqual(
			expect.objectContaining({ cogs: 300n, costOfSales: 300n, grossProfit: 900n })
		);
		expect(rows[2]).toEqual(
			expect.objectContaining({
				orderCount: 0,
				waste: 4000n,
				costOfSales: 4000n,
				grossProfit: -4000n
			})
		);
		const totals = sumDays(rows);
		expect(totals.netSales).toBe(2800n);
		expect(totals.costOfSales).toBe(4300n);
		expect(totals.grossProfit).toBe(-1500n);
		expect(totals.openShifts).toBe(1);
	});

	it('a count surplus makes the day negative cost of sales: signed, never clamped', async () => {
		await post(fx, '2026-09-28', 'stock_count_surplus', countSurplusLines(minor(1200n)));
		const [row] = await byBusinessDate(db, fx.restaurantId, '2026-09-28', '2026-09-28');
		expect(row.waste).toBe(-1200n);
		expect(row.costOfSales).toBe(-1200n);
		expect(row.grossProfit).toBe(1200n);
	});

	// TRIPWIRE — nothing writes refunds yet (4200), so the journal's net sales and
	// the orders' net sales agree. When a refunds plan lands this fails, and the
	// report's sales figures (read from orders) must be revisited (spec 25: net
	// sales = gross − discounts AND refunds).
	it('journal 4000 − 4100 equals the rows’ net sales for the range', async () => {
		await seedDays(fx);
		const rows = await byBusinessDate(db, fx.restaurantId, '2026-09-28', '2026-09-29');
		const journal = await db.execute<{ net: string }>(sql`
			select (coalesce(sum(l.credit_minor - l.debit_minor) filter (where a.code = '4000'), 0)
				- coalesce(sum(l.debit_minor - l.credit_minor) filter (where a.code = '4100'), 0))::text as net
			from journal_entries e
			join journal_entry_lines l on l.entry_id = e.id
			join accounts a on a.id = l.account_id
			where e.restaurant_id = ${fx.restaurantId}
				and e.business_date between '2026-09-28' and '2026-09-29'
		`);
		expect(BigInt(journal.rows[0].net)).toBe(sumDays(rows).netSales);
		expect(sumDays(rows).netSales).toBe(2800n);
	});

	it('never shows another restaurant’s sales or journal', async () => {
		await seedDays(fx);
		const other = await seedSalesRestaurant(db);
		await post(other, '2026-09-28', 'waste', wasteLines(minor(999n)));
		const rows = await byBusinessDate(db, other.restaurantId, '2026-09-28', '2026-09-29');
		expect(sumDays(rows)).toEqual(
			expect.objectContaining({ orderCount: 0, grossSales: 0n, waste: 999n })
		);
	});
});

describe('orderRows and lineRows (T-05)', () => {
	it('lists paid orders with invoice numbers and local times, in sequence order', async () => {
		await seedDays(fx);
		const asc = await orderRows(db, fx.restaurantId, '2026-09-28', '2026-09-29', { order: 'asc' });
		expect(asc.map((r) => r.invoiceNumber)).toEqual([
			`${fx.deviceCode}-000001`,
			`${fx.deviceCode}-000002`,
			`${fx.deviceCode}-000003`
		]);
		// The 22:30Z card sale: 01:30 local on the 29th, business date the 28th.
		expect(asc[1]).toEqual(
			expect.objectContaining({
				businessDate: '2026-09-28',
				paidAt: '2026-09-29 01:30:00',
				orderType: 'takeaway',
				tableLabel: null,
				taxMode: 'exclusive',
				lineCount: 1,
				subtotal: 400n,
				tax: 40n,
				total: 440n,
				payments: [{ kind: 'card', name: fx.paymentMethods.card.name, amount: 440n }],
				flagReason: null
			})
		);
		expect(asc[0].tableLabel).toBe('T4');
		const desc = await orderRows(db, fx.restaurantId, '2026-09-28', '2026-09-29', {
			order: 'desc',
			limit: 2
		});
		expect(desc.map((r) => r.invoiceSeq)).toEqual([3, 2]);
		expect(await countOrders(db, fx.restaurantId, '2026-09-28', '2026-09-29')).toBe(3);
		expect(await countOrders(db, fx.restaurantId, '2026-09-29', '2026-09-29')).toBe(1);
	});

	it('a second payment row never duplicates the order or its line count', async () => {
		await seedDays(fx);
		const [first] = await orderRows(db, fx.restaurantId, '2026-09-28', '2026-09-28', {
			order: 'asc'
		});
		// An INSERT, never an update: payments are append-only (0012; invariant 2).
		await db.insert(payments).values({
			restaurantId: fx.restaurantId,
			orderId: first.orderId,
			method: 'card',
			amountMinor: 0n,
			tenderedMinor: null,
			changeMinor: null,
			paidAt: new Date('2026-09-28T17:05:00Z')
		});
		const rows = await orderRows(db, fx.restaurantId, '2026-09-28', '2026-09-28', {
			order: 'asc'
		});
		expect(rows).toHaveLength(2);
		expect(rows[0].payments.map((p) => p.kind)).toEqual(['cash', 'card']);
		expect(rows[0].lineCount).toBe(1);
	});

	it('lists every line with its stored numbers, modifiers ordered by name', async () => {
		const sid = randomUUID();
		await openSessionAt(db, fx, {
			posSessionId: sid,
			openedAt: new Date('2026-09-28T05:00:00Z'),
			openingCashMinor: 0n
		});
		const sale = await recordSaleAt(db, fx, {
			posSessionId: sid,
			occurredAt: new Date('2026-09-28T06:00:00Z'),
			invoiceSeq: 1,
			method: 'cash',
			orderType: 'dine_in',
			tableLabel: null,
			lines: [
				{
					...burger(fx, 2),
					modifiers: [
						{
							modifierId: fx.modifiers.extraCheese,
							modifierName: 'Extra cheese',
							priceDeltaMinor: 50n
						}
					]
				},
				tea(fx)
			]
		});
		// A second modifier row inserted AFTER the first, named to sort before it.
		const [line1] = await db
			.select({ id: orderLines.id })
			.from(orderLines)
			.where(and(eq(orderLines.orderId, sale.orderId), eq(orderLines.lineNo, 1)));
		await db.insert(orderLineModifiers).values({
			restaurantId: fx.restaurantId,
			orderLineId: line1.id,
			modifierId: fx.modifiers.extraCheese,
			modifierName: 'Aioli',
			priceDeltaMinor: -25n
		});

		const lines = await lineRows(db, fx.restaurantId, '2026-09-28', '2026-09-28');
		expect(lines).toHaveLength(2);
		expect(lines[0]).toEqual(
			expect.objectContaining({
				invoiceNumber: `${fx.deviceCode}-000001`,
				paidAt: '2026-09-28 09:00:00',
				lineNo: 1,
				itemName: 'Burger',
				quantity: 2,
				unitPrice: 800n,
				modifiers: [
					{ name: 'Aioli', delta: -25n },
					{ name: 'Extra cheese', delta: 50n }
				],
				modifierTotal: 25n,
				taxRateName: fx.defaultTaxRate.name,
				taxRateBp: fx.taxRateBp,
				discount: 0n,
				lineAmount: 1650n
			})
		);
		expect(lines[1]).toEqual(
			expect.objectContaining({ lineNo: 2, itemName: 'Tea', modifiers: [], lineAmount: 200n })
		);
		expect(await countLines(db, fx.restaurantId, '2026-09-28', '2026-09-28')).toBe(2);
	});

	it('never lists another restaurant’s orders or lines', async () => {
		await seedDays(fx);
		const other = await seedSalesRestaurant(db);
		expect(
			await orderRows(db, other.restaurantId, '2026-09-28', '2026-09-29', { order: 'asc' })
		).toEqual([]);
		expect(await lineRows(db, other.restaurantId, '2026-09-28', '2026-09-29')).toEqual([]);
		expect(await countLines(db, other.restaurantId, '2026-09-28', '2026-09-29')).toBe(0);
	});
});

/** A second named rate on Tea, and the fixture's menu version after the bump. */
async function reducedTea(f: SalesFixture): Promise<{ f: SalesFixture; rateId: string }> {
	const ctx = { actorUserId: f.ownerId, ip: null, userAgent: null };
	const rateId = await db.transaction((tx) =>
		seedTaxRate(tx, f.restaurantId, { name: 'Reduced', rateBp: 500 }, ctx)
	);
	const changed = await db.transaction((tx) =>
		updateItem(tx, f.restaurantId, f.items.tea, { taxRateId: rateId }, ctx)
	);
	expect('ok' in changed ? changed.ok : true).not.toBe(false);
	const [row] = await db
		.select({ menuVersion: restaurantSettings.menuVersion })
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, f.restaurantId));
	return { f: { ...f, menuVersion: row.menuVersion }, rateId };
}

async function twoRateSale(f: SalesFixture, rateId: string) {
	const sid = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: sid,
		openedAt: new Date('2026-09-28T05:00:00Z'),
		openingCashMinor: 0n
	});
	await recordSaleAt(db, f, {
		posSessionId: sid,
		occurredAt: new Date('2026-09-28T06:00:00Z'),
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines: [
			burger(f, 2),
			{ ...tea(f, 3), taxRateBp: 500, taxRateId: rateId, taxRateName: 'Reduced' }
		]
	});
}

describe('salesByTaxRate (T-06)', () => {
	it('MANDATORY (spec 29 — tax in both modes): exclusive, one row per rate with the stored line amounts', async () => {
		const { f, rateId } = await reducedTea(fx);
		await twoRateSale(f, rateId);
		const rows = await salesByTaxRate(db, f.restaurantId, '2026-09-28', '2026-09-28');
		expect(rows).toEqual([
			{
				taxMode: 'exclusive',
				taxRateName: f.defaultTaxRate.name,
				taxRateBp: 1000,
				lineCount: 1,
				quantity: 2,
				amount: 1600n
			},
			{
				taxMode: 'exclusive',
				taxRateName: 'Reduced',
				taxRateBp: 500,
				lineCount: 1,
				quantity: 3,
				amount: 600n
			}
		]);
		const report = await salesReportRange(db, f.restaurantId, '2026-09-28', '2026-09-28');
		const byItem = report.byItem.reduce((acc, r) => acc + r.amount, 0n);
		expect(rows.reduce((acc, r) => acc + r.amount, 0n)).toBe(byItem);
	});

	it('MANDATORY (spec 29 — tax in both modes): inclusive, the rows carry the inclusive basis', async () => {
		const inc = await seedSalesRestaurant(db, { taxMode: 'inclusive', taxRateBp: 1000 });
		const { f, rateId } = await reducedTea(inc);
		await twoRateSale(f, rateId);
		const rows = await salesByTaxRate(db, f.restaurantId, '2026-09-28', '2026-09-28');
		expect(rows.map((r) => [r.taxMode, r.taxRateName, r.amount])).toEqual([
			['inclusive', f.defaultTaxRate.name, 1600n],
			['inclusive', 'Reduced', 600n]
		]);
	});

	// Lines recorded before named rates (migration 0016) carry no rate id or name and
	// are never backfilled (invariant 2). Inserted as such: the validator of today
	// fills the name in whenever the number matches.
	it('a line recorded without a rate name is its own row', async () => {
		const sid = randomUUID();
		await openSessionAt(db, fx, {
			posSessionId: sid,
			openedAt: new Date('2026-09-28T05:00:00Z'),
			openingCashMinor: 0n
		});
		const at = new Date('2026-09-28T06:00:00Z');
		const [order] = await db
			.insert(orders)
			.values({
				restaurantId: fx.restaurantId,
				posSessionId: sid,
				deviceId: fx.deviceId,
				employeeUserId: fx.staffId,
				orderType: 'takeaway',
				status: 'paid',
				taxMode: 'exclusive',
				currencyCode: 'USD',
				menuVersion: fx.menuVersion,
				subtotalMinor: 800n,
				discountMinor: 0n,
				taxMinor: 80n,
				totalMinor: 880n,
				openedAt: at,
				paidAt: at
			})
			.returning({ id: orders.id });
		await db.insert(orderLines).values({
			restaurantId: fx.restaurantId,
			orderId: order.id,
			lineNo: 1,
			menuItemId: fx.items.burger,
			itemName: 'Burger',
			quantity: 1,
			unitPriceMinor: 800n,
			taxRateBp: 1000,
			status: 'new'
		});
		const rows = await salesByTaxRate(db, fx.restaurantId, '2026-09-28', '2026-09-28');
		expect(rows).toEqual([
			expect.objectContaining({ taxRateName: null, taxRateBp: 1000, amount: 800n })
		]);
	});
});
