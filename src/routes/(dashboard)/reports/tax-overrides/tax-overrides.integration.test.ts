import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import {
	offerExemptRate,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import type { Principal } from '$lib/server/auth/session';
import { load } from './+page.server';

// /reports/tax-overrides (tasks/bill-tax-override T-12). MANDATORY (spec 29 — a
// permission check per route): admin.reports on the load.

afterAll(async () => {
	await closeTestDb();
});

type PageData = {
	from: string;
	to: string;
	byCashier: { cashier: string; count: number; taxRemoved: string }[];
	rows: {
		invoiceNumber: string;
		businessDate: string;
		rateName: string;
		reason: string;
		total: string;
		taxRemoved: string;
	}[];
};

function eventFor(
	user: { userId: string; restaurantId: string; role: Principal['role'] },
	search = ''
): RequestEvent {
	const principal: Principal = {
		userId: user.userId,
		restaurantId: user.restaurantId,
		role: user.role,
		displayName: user.role === 'owner' ? 'Owner' : 'Staff',
		email: user.role === 'owner' ? 'owner@example.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
	const url = new URL('http://localhost/reports/tax-overrides' + search);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: {
			user: principal,
			restaurantId: user.restaurantId,
			sessionToken: null,
			posDevice: null
		},
		params: {},
		request: new Request(url),
		route: { id: '/(dashboard)/reports/tax-overrides' },
		url
	} as unknown as RequestEvent;
}

const asOwner = async (f: SalesFixture, search = '') =>
	(await load(
		eventFor({ userId: f.ownerId, restaurantId: f.restaurantId, role: 'owner' }, search) as never
	)) as PageData;

async function thrown(p: unknown): Promise<{ status?: number }> {
	try {
		await p;
	} catch (e) {
		return e as { status?: number };
	}
	throw new Error('expected the load to throw');
}

async function exemptSale(f: SalesFixture): Promise<void> {
	const exempt = await offerExemptRate(db, f);
	const posSessionId = randomUUID();
	await openSessionAt(db, f, {
		posSessionId,
		openedAt: new Date('2026-09-28T06:00:00Z'),
		openingCashMinor: 0n
	});
	await recordSaleAt(db, f, {
		posSessionId,
		occurredAt: new Date('2026-09-28T08:00:00Z'),
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		exempt: { rateId: exempt.id, rateName: exempt.name, reason: 'UNICEF' },
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
}

describe('/reports/tax-overrides', () => {
	it('MANDATORY (spec 29): a staff member gets 403', async () => {
		const f = await seedSalesRestaurant(db);
		const staff = await seedStaff(db, f.restaurantId, { displayName: 'Cashier' });
		const result = await thrown(
			load(eventFor({ userId: staff.id, restaurantId: f.restaurantId, role: 'staff' }) as never)
		);
		expect(result.status).toBe(403);
	});

	it('lists the exempt bill, formatted, for the owner', async () => {
		const f = await seedSalesRestaurant(db);
		await exemptSale(f);
		const data = await asOwner(f, '?from=2026-09-28&to=2026-09-28');
		expect(data.from).toBe('2026-09-28');
		expect(data.rows).toEqual([
			expect.objectContaining({
				invoiceNumber: `${f.deviceCode}-000001`,
				businessDate: '2026-09-28',
				rateName: 'Exempt',
				reason: 'UNICEF',
				total: '8.00',
				taxRemoved: '0.80'
			})
		]);
		expect(data.byCashier).toEqual([expect.objectContaining({ count: 1, taxRemoved: '0.80' })]);
	});

	it('reads a reversed range the right way round; a bad date is 400', async () => {
		const f = await seedSalesRestaurant(db);
		await exemptSale(f);
		const data = await asOwner(f, '?from=2026-09-30&to=2026-09-27');
		expect([data.from, data.to]).toEqual(['2026-09-27', '2026-09-30']);
		expect(data.rows).toHaveLength(1);
		expect((await thrown(asOwner(f, '?from=2026-02-30'))).status).toBe(400);
	});
});
