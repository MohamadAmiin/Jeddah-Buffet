import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb } from '../db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '../db/test/sales';
import { postEntry } from '../accounting/journal';
import { cogsLines, countSurplusLines, wasteLines } from '../accounting/posting-rules';
import { minor } from '../../money';
import { salesReportRange } from './sales';
import { byBusinessDate, sumDays } from './detail';

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
