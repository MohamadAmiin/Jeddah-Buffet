import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/client';
import { closeTestDb } from '../db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '../db/test/sales';
import { buildExport, EXPORT_SECTIONS, ExportTooLarge, type ExportSection } from './export';

// tasks/sales-report-export T-07 — every section's file, end to end. Zone
// Africa/Mogadishu (UTC+3), USD, exclusive 10%.

afterAll(async () => {
	await closeTestDb();
});

let fx: SalesFixture;
beforeEach(async () => {
	fx = await seedSalesRestaurant(db);
});

const RANGE = { from: '2026-09-28', to: '2026-09-28' };

/** One closed shift on the 28th, 1.00 short: two cash sales, one of them hostile. */
async function seed(f: SalesFixture) {
	const sid = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: sid,
		openedAt: new Date('2026-09-28T05:00:00Z'),
		openingCashMinor: 1000n
	});
	await recordSaleAt(db, f, {
		posSessionId: sid,
		occurredAt: new Date('2026-09-28T06:00:00Z'),
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'dine_in',
		tableLabel: 'T4',
		lines: [
			{
				menuItemId: f.items.burger,
				itemName: 'Burger',
				quantity: 2,
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
	// The till bounds item text by length only: a crafted sale can store a formula.
	await recordSaleAt(db, f, {
		posSessionId: sid,
		occurredAt: new Date('2026-09-28T07:00:00Z'),
		invoiceSeq: 2,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines: [
			{
				menuItemId: f.items.tea,
				itemName: '=1+2',
				quantity: 1,
				unitPriceMinor: 200n,
				taxRateBp: f.taxRateBp
			}
		]
	});
	// Expected cash 1000 + 1870 + 220 = 3090; counted 3. 1.00 short.
	await closeSessionAt(db, f, {
		posSessionId: sid,
		closedAt: new Date('2026-09-28T11:00:00Z'),
		countedCashMinor: 2990n
	});
}

const lines = (csv: string) => csv.slice(1).split('\r\n').slice(0, -1);

const HEADERS: Record<ExportSection, string> = {
	summary: '"Metric","Value","Unit"',
	days: '"Business date","Orders","Gross sales (USD)","Discounts (USD)","Net sales (USD)","Tax (USD)","Takings (USD)","Cost of goods sold (USD)","Waste & adjustments (USD)","Comps & staff meals (USD)","Cost of sales (USD)","Gross profit (USD)","Open shifts"',
	'payment-methods': '"Method","Type","Archived","Payments","Amount (USD)"',
	employees: '"Employee","Orders","Amount (USD)"',
	items: '"Item","Basis","Quantity","Amount (USD)"',
	categories: '"Category (current)","Basis","Quantity","Amount (USD)"',
	'tax-rates': '"Tax rate","Rate (%)","Basis","Lines","Quantity","Amount (USD)"',
	shifts:
		'"Device","Business date","Status","Opened at","Closed at","Opening cash (USD)","Expected cash (USD)","Counted cash (USD)","Difference (USD)"',
	orders:
		'"Business date","Device","Invoice number","Paid at","Received at","Order type","Table","Employee","Tax mode","Lines","Subtotal (USD)","Discount (USD)","Tax (USD)","Total (USD)","Payment type","Payment method","Flag","Note"',
	lines:
		'"Business date","Device","Invoice number","Paid at","Order type","Tax mode","Line","Item","Quantity","Unit price (USD)","Modifiers","Modifier total (USD)","Tax rate","Rate (%)","Line discount (USD)","Line amount (USD)","Basis"'
};

describe('buildExport', () => {
	it.each(EXPORT_SECTIONS.map((s) => [s]))(
		'%s: a BOM, the exact header, CRLF rows, a safe file name',
		async (section) => {
			await seed(fx);
			const { filename, csv } = await buildExport(db, fx.restaurantId, RANGE, section);
			expect(filename).toBe(`matcami-sales-2026-09-28_2026-09-28-${section}.csv`);
			expect(csv.startsWith('﻿')).toBe(true);
			expect(csv.endsWith('\r\n')).toBe(true);
			expect(lines(csv)[0]).toBe(HEADERS[section]);
		}
	);

	it('summary: the stored totals, the profit and the snapshot facts', async () => {
		await seed(fx);
		const { csv } = await buildExport(db, fx.restaurantId, RANGE, 'summary', {
			now: new Date('2026-09-28T12:00:00Z')
		});
		const rows = lines(csv);
		expect(rows).toContain('"Generated at","2026-09-28 15:00:00",');
		expect(rows).toContain('"Time zone","Africa/Mogadishu",');
		expect(rows).toContain('"Orders",2,"count"');
		expect(rows).toContain('"Gross sales",19.00,"USD"');
		expect(rows).toContain('"Tax",1.90,"USD"');
		expect(rows).toContain('"Takings",20.90,"USD"');
		expect(rows).toContain('"Cash payments",20.90,"USD"');
		expect(rows).toContain('"Gross profit",19.00,"USD"');
		expect(rows).toContain('"Shifts still open",0,"count"');
	});

	it('orders and lines: one row each, stored numbers, local times', async () => {
		await seed(fx);
		const orders = lines((await buildExport(db, fx.restaurantId, RANGE, 'orders')).csv);
		expect(orders).toHaveLength(3);
		// No cell of this fixture holds a comma, so a plain split reads the columns.
		const cells = orders[1].split(',');
		expect(cells.slice(0, 4)).toEqual([
			'"2026-09-28"',
			`"${fx.deviceCode}"`,
			`"${fx.deviceCode}-000001"`,
			'"2026-09-28 09:00:00"'
		]);
		expect(cells.slice(5)).toEqual([
			'"Dine-in"',
			'"T4"',
			'"Sam"',
			'"Exclusive"',
			'1',
			'17.00',
			'0.00',
			'1.70',
			'18.70',
			'"Cash"',
			'"Cash"',
			'',
			''
		]);
		const items = lines((await buildExport(db, fx.restaurantId, RANGE, 'lines')).csv);
		expect(items[1]).toContain('"Extra cheese (+0.50)",0.50,');
		expect(items[1]).toContain(',2,8.00,');
		expect(items[1]).toContain(',17.00,"Net"');
	});

	it('a formula typed into an item name never reaches a spreadsheet as one', async () => {
		await seed(fx);
		for (const section of ['items', 'lines'] as const) {
			const { csv } = await buildExport(db, fx.restaurantId, RANGE, section);
			expect(csv).toContain(`"'=1+2"`);
			expect(csv).not.toMatch(/(^|,)"?=1\+2/m);
		}
	});

	it('money cells use an ASCII minus and no thousands separator', async () => {
		await seed(fx);
		const shifts = lines((await buildExport(db, fx.restaurantId, RANGE, 'shifts')).csv);
		expect(shifts[1]).toMatch(/,10\.00,30\.90,29\.90,-1\.00$/);
		expect(shifts[1]).toContain('"Closed"');
	});

	it('refuses a file above the row cap', async () => {
		await seed(fx);
		await expect(
			buildExport(db, fx.restaurantId, RANGE, 'orders', { rowCap: 1 })
		).rejects.toBeInstanceOf(ExportTooLarge);
		await expect(
			buildExport(db, fx.restaurantId, RANGE, 'lines', { rowCap: 1 })
		).rejects.toBeInstanceOf(ExportTooLarge);
	});
});
