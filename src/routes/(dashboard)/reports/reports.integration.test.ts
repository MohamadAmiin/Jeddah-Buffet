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
import { load } from './+page.server';

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

async function burgerSale(f: SalesFixture, posSessionId: string, occurredAt: Date) {
	await recordSaleAt(db, f, {
		posSessionId,
		occurredAt,
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'dine_in',
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
			itemName: 'Burger',
			quantity: 1,
			amount: '8.50'
		});
		expect(data.itemAmountLabel).toBe('Net');
		expect(data.byTender[0]).toEqual({ method: 'cash', label: 'Cash', count: 1, amount: '9.35' });
		expect(data.sessions[0].difference).toEqual({ text: '−0.35 USD', negative: true });

		const json = JSON.stringify(data);
		expect(json).not.toMatch(/pinHash|passwordHash|token/);
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
