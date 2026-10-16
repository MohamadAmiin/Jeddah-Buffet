import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../db/client';
import { closeTestDb } from '../db/test/db';
import {
	closeSessionAt,
	offerExemptRate,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '../db/test/sales';
import { seedStaff } from '../db/test/seed';
import { listTaxOverrides } from './tax-overrides';

// The tax-exempt bills report (tasks/bill-tax-override T-09): every exempt bill in
// a business-date range, read from STORED columns, with a total per cashier.

afterAll(async () => {
	await closeTestDb();
});

async function sessionOn(f: SalesFixture, day: string): Promise<string> {
	const posSessionId = randomUUID();
	await openSessionAt(db, f, {
		posSessionId,
		// 09:00 in Africa/Mogadishu (UTC+3) — the business date is `day`.
		openedAt: new Date(`${day}T06:00:00Z`),
		openingCashMinor: 0n
	});
	return posSessionId;
}

function tea(f: SalesFixture) {
	return {
		menuItemId: f.items.tea,
		itemName: 'Tea',
		quantity: 1,
		unitPriceMinor: 200n,
		taxRateBp: f.taxRateBp
	};
}

describe('listTaxOverrides', () => {
	it('lists the exempt bills of the range, oldest first, with a total per cashier', async () => {
		const f = await seedSalesRestaurant(db);
		const other = await seedStaff(db, f.restaurantId, {
			displayName: 'Ayaan',
			roleName: 'Cashier'
		});
		const exempt = await offerExemptRate(db, f);
		const s28 = await sessionOn(f, '2026-09-28');

		await recordSaleAt(db, f, {
			posSessionId: s28,
			occurredAt: new Date('2026-09-28T08:00:00Z'),
			invoiceSeq: 1,
			method: 'cash',
			orderType: 'takeaway',
			tableLabel: null,
			exempt: { rateId: exempt.id, rateName: exempt.name, reason: 'UNICEF' },
			lines: [tea(f)]
		});
		// An ordinary sale: never listed.
		await recordSaleAt(db, f, {
			posSessionId: s28,
			occurredAt: new Date('2026-09-28T09:00:00Z'),
			invoiceSeq: 2,
			method: 'cash',
			orderType: 'takeaway',
			tableLabel: null,
			lines: [tea(f)]
		});
		// One open shift per device: close the 28th before the 29th opens.
		await closeSessionAt(db, f, {
			posSessionId: s28,
			closedAt: new Date('2026-09-28T20:00:00Z'),
			countedCashMinor: 400n
		});
		const s29 = await sessionOn(f, '2026-09-29');
		await recordSaleAt(db, f, {
			posSessionId: s29,
			occurredAt: new Date('2026-09-29T08:00:00Z'),
			invoiceSeq: 3,
			method: 'cash',
			orderType: 'takeaway',
			tableLabel: null,
			employeeId: other.id,
			exempt: { rateId: exempt.id, rateName: exempt.name, reason: 'Embassy of Kenya' },
			lines: [tea(f), tea(f)]
		});

		// Another restaurant's exempt bill on the same day never appears.
		const g = await seedSalesRestaurant(db);
		const gExempt = await offerExemptRate(db, g);
		await recordSaleAt(db, g, {
			posSessionId: await sessionOn(g, '2026-09-28'),
			occurredAt: new Date('2026-09-28T08:30:00Z'),
			invoiceSeq: 1,
			method: 'cash',
			orderType: 'takeaway',
			tableLabel: null,
			exempt: { rateId: gExempt.id, rateName: gExempt.name, reason: 'Elsewhere' },
			lines: [tea(g)]
		});

		const report = await listTaxOverrides(db, f.restaurantId, {
			from: '2026-09-28',
			to: '2026-09-29'
		});
		expect(report.rows).toEqual([
			{
				orderId: expect.any(String),
				invoiceNumber: `${f.deviceCode}-000001`,
				businessDate: '2026-09-28',
				paidAt: new Date('2026-09-28T08:00:00Z'),
				cashier: expect.any(String),
				rateName: 'Exempt',
				reason: 'UNICEF',
				totalMinor: 200n,
				taxRemovedMinor: 20n
			},
			{
				orderId: expect.any(String),
				invoiceNumber: `${f.deviceCode}-000003`,
				businessDate: '2026-09-29',
				paidAt: new Date('2026-09-29T08:00:00Z'),
				cashier: 'Ayaan',
				rateName: 'Exempt',
				reason: 'Embassy of Kenya',
				totalMinor: 400n,
				taxRemovedMinor: 40n
			}
		]);
		expect(report.byCashier).toEqual([
			{ userId: other.id, cashier: 'Ayaan', count: 1, taxRemovedMinor: 40n },
			{ userId: f.staffId, cashier: expect.any(String), count: 1, taxRemovedMinor: 20n }
		]);

		const oneDay = await listTaxOverrides(db, f.restaurantId, {
			from: '2026-09-29',
			to: '2026-09-29'
		});
		expect(oneDay.rows.map((row) => row.reason)).toEqual(['Embassy of Kenya']);
	});

	it('an empty range is two empty lists; a bad date is refused', async () => {
		const f = await seedSalesRestaurant(db);
		expect(
			await listTaxOverrides(db, f.restaurantId, { from: '2026-01-01', to: '2026-01-31' })
		).toEqual({ from: '2026-01-01', to: '2026-01-31', rows: [], byCashier: [] });
		await expect(
			listTaxOverrides(db, f.restaurantId, { from: '2026-1-1', to: '2026-01-31' })
		).rejects.toThrow(RangeError);
	});
});
