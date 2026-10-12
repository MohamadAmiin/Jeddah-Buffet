import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { closeTestDb } from '$lib/server/db/test/db';
import {
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import type { Principal } from '$lib/server/auth/session';
import { GET } from './+server';

// tasks/sales-report-export T-09 — the download route, driven with a hand-built
// RequestEvent exactly as reports.integration.test.ts drives the page's load.

afterAll(async () => {
	await closeTestDb();
});

function eventFor(
	user: { userId: string; restaurantId: string; role: Principal['role'] } | null,
	restaurantId: string,
	search: string
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
	const url = new URL('http://localhost/reports/export' + search);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user: principal, restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url),
		route: { id: '/(dashboard)/reports/export' },
		url
	} as unknown as RequestEvent;
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
	try {
		await p;
		return 200;
	} catch (e) {
		return (e as { status?: number }).status;
	}
}

let fx: SalesFixture;
beforeEach(async () => {
	fx = await seedSalesRestaurant(db);
	const sid = randomUUID();
	await openSessionAt(db, fx, {
		posSessionId: sid,
		openedAt: new Date('2026-09-28T05:00:00Z'),
		openingCashMinor: 0n
	});
	await recordSaleAt(db, fx, {
		posSessionId: sid,
		occurredAt: new Date('2026-09-28T06:00:00Z'),
		invoiceSeq: 1,
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
});

const owner = () => ({ userId: fx.ownerId, restaurantId: fx.restaurantId, role: 'owner' as const });
const Q = '?from=2026-09-28&to=2026-09-28&section=orders';

describe('MANDATORY (spec 29) — permission check on /reports/export', () => {
	it('a staff principal gets 403', async () => {
		const staff = { userId: fx.staffId, restaurantId: fx.restaurantId, role: 'staff' as const };
		expect(await status(GET(eventFor(staff, fx.restaurantId, Q) as never))).toBe(403);
	});

	it('no principal is redirected to /login by the route itself', async () => {
		expect(await status(GET(eventFor(null, fx.restaurantId, Q) as never))).toBe(303);
	});
});

describe('GET /reports/export', () => {
	it('answers the owner with a CSV attachment and exactly the five headers', async () => {
		const response = await GET(eventFor(owner(), fx.restaurantId, Q) as never);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="matcami-sales-2026-09-28_2026-09-28-orders.csv"'
		);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
		// Read the BYTES: Response.text() strips a UTF-8 byte-order mark.
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
		expect(body.startsWith('\uFEFF"Business date"')).toBe(true);
		expect(body.split('\r\n').filter(Boolean)).toHaveLength(2);
	});

	it('refuses an unknown section, a bad date and a range over 366 days with 400', async () => {
		const ask = (q: string) => status(GET(eventFor(owner(), fx.restaurantId, q) as never));
		expect(await ask('?from=2026-09-28&to=2026-09-28&section=bogus')).toBe(400);
		expect(await ask('?from=2026-09-28&to=2026-09-28')).toBe(400);
		expect(await ask('?from=2026-02-30&section=orders')).toBe(400);
		expect(await ask('?from=2025-01-01&to=2026-09-28&section=orders')).toBe(400);
	});

	it('takes the tenant from the session, never from the query', async () => {
		const other = await seedSalesRestaurant(db);
		const response = await GET(
			eventFor(
				{ userId: other.ownerId, restaurantId: other.restaurantId, role: 'owner' },
				other.restaurantId,
				`${Q}&restaurantId=${fx.restaurantId}&restaurant_id=${fx.restaurantId}`
			) as never
		);
		const body = await response.text();
		// The header row only: the other restaurant has no sales.
		expect(body.split('\r\n').filter(Boolean)).toHaveLength(1);
	});
});
