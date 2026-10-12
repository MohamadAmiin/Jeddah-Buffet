import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import { posSessions } from '$lib/server/db/schema/pos-sessions';
import type { Principal } from '$lib/server/auth/session';
import { minor } from '$lib/money';
import { formatMoney, moneyFormatFor } from '$lib/money/format';
import { restaurantSettings } from '$lib/server/db/schema/restaurant-settings';
import { updateSettings } from '$lib/server/restaurants';
import { load, ORDERS_SHOWN } from './+page.server';

afterAll(async () => {
	await closeTestDb();
});

const usd = moneyFormatFor('USD');

type ReportData = {
	businessDate: string;
	prevDate: string;
	nextDate: string;
	itemAmountLabel: string;
	totals: Record<string, string | number>;
	byTender: unknown[];
	byPaymentMethod: { key: string; label: string; kind: string; count: number; amount: string }[];
	byOrderType: { orderType: string; label: string; count: number; amount: string }[];
	byItem: unknown[];
	sessions: { difference: { text: string; negative: boolean } | null }[];
	flagged: { count: number; unrecordedCount: number };
	isEmpty: boolean;
};

function eventFor(
	user: { userId: string; restaurantId: string; role: Principal['role'] } | null,
	restaurantId: string,
	search = ''
): RequestEvent {
	const principal: Principal | null = user
		? {
				userId: user.userId,
				restaurantId: user.restaurantId,
				role: user.role,
				displayName: user.role === 'owner' ? 'Owner' : 'Staff',
				email: user.role === 'owner' ? 'owner@example.com' : null,
				sessionId: 's-1',
				expiresAt: new Date(Date.now() + 60_000)
			}
		: null;
	const url = new URL('http://localhost/reports' + search);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user: principal, restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url),
		route: { id: '/(dashboard)/reports' },
		url
	} as unknown as RequestEvent;
}

async function asOwner(f: SalesFixture, search = ''): Promise<ReportData> {
	return (await load(
		eventFor(
			{ userId: f.ownerId, restaurantId: f.restaurantId, role: 'owner' },
			f.restaurantId,
			search
		) as never
	)) as ReportData;
}

async function thrown(p: unknown): Promise<{ status?: number; location?: string }> {
	try {
		await p;
	} catch (e) {
		return e as { status?: number; location?: string };
	}
	throw new Error('expected the load to throw');
}

async function burgerSale(
	f: SalesFixture,
	posSessionId: string,
	occurredAt: Date,
	orderType: 'dine_in' | 'takeaway' | 'delivery' = 'dine_in'
) {
	await recordSaleAt(db, f, {
		posSessionId,
		occurredAt,
		invoiceSeq: 1,
		method: 'cash',
		orderType,
		tableLabel: null,
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
}

describe('MANDATORY (spec 29) — permission check on /reports', () => {
	it('a staff principal gets 403, not a redirect', async () => {
		const f = await seedSalesRestaurant(db);
		const staff = await seedStaff(db, f.restaurantId, { displayName: 'Other staff' });
		const err = await thrown(
			load(
				eventFor(
					{ userId: staff.id, restaurantId: f.restaurantId, role: 'staff' },
					f.restaurantId
				) as never
			)
		);
		expect(err.status).toBe(403);
		expect(err.location).toBeUndefined();
	});

	it('an anonymous caller is redirected to /login', async () => {
		const f = await seedSalesRestaurant(db);
		const err = await thrown(load(eventFor(null, f.restaurantId) as never));
		expect(err.status).toBe(303);
		expect(err.location?.startsWith('/login?next=')).toBe(true);
	});
});

describe('the business date', () => {
	it("defaults to the recent session's business date", async () => {
		const f = await seedSalesRestaurant(db);
		const sid = randomUUID();
		await openSessionAt(db, f, {
			posSessionId: sid,
			openedAt: new Date(Date.now() - 3_600_000),
			openingCashMinor: 0n
		});
		const [row] = await db
			.select({ businessDate: posSessions.businessDate })
			.from(posSessions)
			.where(eq(posSessions.id, sid));
		expect((await asOwner(f)).businessDate).toBe(row.businessDate);
	});

	it("falls back to the zone's calendar today with no session", async () => {
		const f = await seedSalesRestaurant(db);
		const data = await asOwner(f);
		expect(data.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(data.businessDate).toBe(
			new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Mogadishu' }).format(new Date())
		);
	});

	it('rejects a bad date with 400', async () => {
		const f = await seedSalesRestaurant(db);
		for (const bad of ['2026-13-45', '2026-02-30', 'yesterday', '28/09/2026']) {
			const err = await thrown(asOwner(f, '?date=' + encodeURIComponent(bad)));
			expect(err.status, bad).toBe(400);
		}
	});

	it('computes the neighbouring dates across a month end', async () => {
		const f = await seedSalesRestaurant(db);
		const data = await asOwner(f, '?date=2026-03-01');
		expect(data.prevDate).toBe('2026-02-28');
		expect(data.nextDate).toBe('2026-03-02');
	});
});

describe('formatting happens in the load', () => {
	it('formats totals, rows and the session difference', async () => {
		const f = await seedSalesRestaurant(db);
		const sid = randomUUID();
		const openedAt = new Date(Date.now() - 2 * 3_600_000);
		const { businessDate } = await openSessionAt(db, f, {
			posSessionId: sid,
			openedAt,
			openingCashMinor: 10000n
		});
		await burgerSale(f, sid, new Date(Date.now() - 3_600_000));
		await closeSessionAt(db, f, {
			posSessionId: sid,
			closedAt: new Date(Date.now() - 1_800_000),
			countedCashMinor: 10900n
		});

		const data = await asOwner(f, '?date=' + businessDate);
		expect(data.totals.takings).toBe('9.35 USD');
		expect(data.totals.takings).toBe(formatMoney(minor(935n), usd));
		expect(data.totals.tax).toBe('0.85 USD');
		expect(data.byItem[0]).toEqual({
			menuItemId: f.items.burger,
			key: `${f.items.burger}:Burger:exclusive`,
			itemName: 'Burger',
			quantity: 1,
			amount: '8.50'
		});
		expect(data.itemAmountLabel).toBe('Net');
		expect(data.byTender[0]).toEqual({ method: 'cash', label: 'Cash', count: 1, amount: '9.35' });
		// settings-tax-payments-receipt T-17: the named-method section, formatted here.
		expect(data.byPaymentMethod).toEqual([
			{ key: f.paymentMethods.cash.id, label: 'Cash', kind: 'Cash', count: 1, amount: '9.35' }
		]);
		expect(data.sessions[0].difference).toEqual({ text: '−0.35 USD', negative: true });

		const json = JSON.stringify(data);
		expect(json).not.toMatch(/pinHash|passwordHash|token/);
	});

	// menu-and-printing T-10: the label map is a Record over OrderType.
	it('labels the delivery row Delivery', async () => {
		const f = await seedSalesRestaurant(db);
		const sid = randomUUID();
		const { businessDate } = await openSessionAt(db, f, {
			posSessionId: sid,
			openedAt: new Date(Date.now() - 2 * 3_600_000),
			openingCashMinor: 10000n
		});
		await burgerSale(f, sid, new Date(Date.now() - 3_600_000), 'delivery');

		const data = await asOwner(f, '?date=' + businessDate);
		expect(data.byOrderType.map((r) => r.label)).toEqual(['Dine-in', 'Takeaway', 'Delivery']);
		expect(data.byOrderType[2]).toEqual({
			orderType: 'delivery',
			label: 'Delivery',
			count: 1,
			amount: '9.35'
		});
	});

	it('labels the item column Incl. tax in inclusive mode', async () => {
		const f = await seedSalesRestaurant(db, { taxMode: 'inclusive', taxRateBp: 2000 });
		expect((await asOwner(f)).itemAmountLabel).toBe('Incl. tax');
	});

	it('an empty date is empty', async () => {
		const f = await seedSalesRestaurant(db);
		const data = await asOwner(f, '?date=2026-01-01');
		expect(data.isEmpty).toBe(true);
		expect(data.flagged).toEqual({ count: 0, unrecordedCount: 0 });
	});
});

// tasks/sales-report-export T-10 — the load over a RANGE of business dates.
type RangeData = ReportData & {
	from: string;
	to: string;
	singleDay: boolean;
	title: string;
	presets: { label: string; query: string; current: boolean }[];
	days: { businessDate: string; orderCount: number }[];
	profit: Record<string, { text: string; negative: boolean }>;
	orders: { invoiceNumber: string; total: string; payment: string; orderType: string }[];
	orderCount: number;
	shownOrders: number;
	taxRates: { name: string; rate: string; basis: string; amount: string }[];
	exports: { section: string; label: string; query: string }[];
	byItem: { itemName: string }[];
};

async function twoDays(f: SalesFixture) {
	const s1 = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: s1,
		openedAt: new Date('2026-09-28T05:00:00Z'),
		openingCashMinor: 0n
	});
	await burgerSale(f, s1, new Date('2026-09-28T06:00:00Z'));
	await closeSessionAt(db, f, {
		posSessionId: s1,
		closedAt: new Date('2026-09-28T10:00:00Z'),
		countedCashMinor: 935n
	});
	const s2 = randomUUID();
	await openSessionAt(db, f, {
		posSessionId: s2,
		openedAt: new Date('2026-09-29T05:00:00Z'),
		openingCashMinor: 0n
	});
	await recordSaleAt(db, f, {
		posSessionId: s2,
		occurredAt: new Date('2026-09-29T06:00:00Z'),
		invoiceSeq: 2,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines: [
			{
				menuItemId: f.items.tea,
				itemName: 'Tea',
				quantity: 2,
				unitPriceMinor: 200n,
				taxRateBp: f.taxRateBp
			}
		]
	});
}

describe('the report over a range (T-10)', () => {
	it('titles, days, totals, orders, tax rates and downloads for a two-day range', async () => {
		const f = await seedSalesRestaurant(db);
		await twoDays(f);
		const data = (await asOwner(f, '?from=2026-09-28&to=2026-09-29')) as RangeData;
		expect(data.title).toBe('Sales · 2026-09-28 to 2026-09-29');
		expect(data.singleDay).toBe(false);
		expect(data.days.map((d) => [d.businessDate, d.orderCount])).toEqual([
			['2026-09-28', 1],
			['2026-09-29', 1]
		]);
		expect(data.totals.takings).toBe(formatMoney(minor(1375n), usd));
		expect(data.profit.grossProfit).toEqual({
			text: formatMoney(minor(1250n), usd),
			negative: false
		});
		expect(data.orderCount).toBe(2);
		expect(data.shownOrders).toBe(2);
		expect(data.orders.map((o) => o.invoiceNumber)).toEqual([
			`${f.deviceCode}-000002`,
			`${f.deviceCode}-000001`
		]);
		expect(data.orders[0]).toEqual(
			expect.objectContaining({ total: '4.40', payment: 'Cash', orderType: 'Takeaway' })
		);
		expect(data.taxRates).toEqual([
			expect.objectContaining({ rate: '10.00%', basis: 'Net', amount: '12.50' })
		]);
		expect(data.exports.map((e) => e.section)).toEqual([
			'summary',
			'days',
			'payment-methods',
			'employees',
			'items',
			'categories',
			'tax-rates',
			'shifts',
			'orders',
			'lines'
		]);
		expect(data.exports[8].query).toBe('from=2026-09-28&to=2026-09-29&section=orders');
		expect(ORDERS_SHOWN).toBe(200);
	});

	it('a one-day range keeps the single-day title and neighbours', async () => {
		const f = await seedSalesRestaurant(db);
		await twoDays(f);
		const data = (await asOwner(f, '?from=2026-09-28&to=2026-09-28')) as RangeData;
		expect(data.title).toBe('Sales · 2026-09-28');
		expect(data.singleDay).toBe(true);
		expect(data.businessDate).toBe('2026-09-28');
		expect(data.prevDate).toBe('2026-09-27');
		expect(data.nextDate).toBe('2026-09-29');
	});

	it('presets end on the current business date and mark the current one', async () => {
		const f = await seedSalesRestaurant(db);
		const { businessDate } = await openSessionAt(db, f, {
			posSessionId: randomUUID(),
			openedAt: new Date(Date.now() - 2 * 3_600_000),
			openingCashMinor: 0n
		});
		const data = (await asOwner(f)) as RangeData;
		expect(data.presets[0]).toEqual({
			label: 'Today',
			query: `from=${businessDate}&to=${businessDate}`,
			current: true
		});
		expect(data.presets[1].query.endsWith(`to=${businessDate}`)).toBe(true);
		expect(data.presets[2].query).toBe(`from=${businessDate.slice(0, 8)}01&to=${businessDate}`);
	});

	it('a range over 366 days is a 400', async () => {
		const f = await seedSalesRestaurant(db);
		expect((await thrown(asOwner(f, '?from=2025-01-01&to=2026-09-28'))).status).toBe(400);
	});

	it('MANDATORY (spec 29 — tax in both modes): a mode switch inside the range labels the column Amount and each row', async () => {
		const f = await seedSalesRestaurant(db);
		const sid = randomUUID();
		await openSessionAt(db, f, {
			posSessionId: sid,
			openedAt: new Date('2026-09-28T05:00:00Z'),
			openingCashMinor: 0n
		});
		await burgerSale(f, sid, new Date('2026-09-28T06:00:00Z'));
		const ctx = { actorUserId: f.ownerId, ip: null, userAgent: null };
		await db.transaction((tx) => updateSettings(tx, f.restaurantId, { taxMode: 'inclusive' }, ctx));
		const [row] = await db
			.select({ menuVersion: restaurantSettings.menuVersion })
			.from(restaurantSettings)
			.where(eq(restaurantSettings.restaurantId, f.restaurantId));
		await recordSaleAt(
			db,
			{ ...f, taxMode: 'inclusive', menuVersion: row.menuVersion },
			{
				posSessionId: sid,
				occurredAt: new Date('2026-09-28T07:00:00Z'),
				invoiceSeq: 2,
				method: 'cash',
				orderType: 'takeaway',
				tableLabel: null,
				lines: [
					{
						menuItemId: f.items.burger,
						itemName: 'Burger',
						quantity: 1,
						unitPriceMinor: 800n,
						taxRateBp: f.taxRateBp
					}
				]
			}
		);
		const data = (await asOwner(f, '?date=2026-09-28')) as RangeData;
		expect(data.itemAmountLabel).toBe('Amount');
		expect(data.byItem.map((r) => r.itemName).sort()).toEqual([
			'Burger (incl. tax)',
			'Burger (net)'
		]);
	});
});
