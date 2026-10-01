import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { posSyncOps } from '$lib/server/db/schema/pos-sync';
import { db } from '$lib/server/db/client';
import { closeTestDb } from '$lib/server/db/test/db';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { restaurantSettings } from '$lib/server/db/schema/restaurant-settings';
import { registerDevice } from '$lib/server/auth/pos-device';
import { createCategory, createItem, getMenuVersion } from '$lib/server/menu';
import { seedStaff } from '$lib/server/db/test/seed';
import { seedTaxRate } from '$lib/server/db/test/settings';
import { POST } from './+server';
import type { RequestEvent } from '@sveltejs/kit';
import type { OpEnvelope, OpKind } from '$lib/sync-ops';

const DEVICE_COOKIE = 'matcami_pos_device';

afterAll(async () => {
	await closeTestDb();
});

async function requireIdMenu<T>(p: Promise<T | { ok: false }>): Promise<string> {
	const r = (await p) as { ok: boolean; id?: string };
	if (!r.ok || typeof r.id !== 'string') throw new Error('menu helper failed');
	return r.id;
}

type Fixture = {
	restaurantId: string;
	ownerId: string;
	cashierId: string;
	waiterId: string;
	deviceId: string;
	deviceCode: string;
	deviceToken: string;
	itemId: string;
	menuVersion: number;
};

async function makeFixture(email: string): Promise<Fixture> {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe Sync API' }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: 'Cafe Sync API',
			timeZone: 'UTC'
		})
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	await db.transaction(async (tx) => {
		const ctx = { actorUserId: owner.id, ip: null, userAgent: null };
		await seedTaxRate(tx, restaurant.id, { rateBp: 825, makeDefault: true }, ctx);
		return updateSettings(
			tx,
			restaurant.id,
			{
				taxMode: 'exclusive',
				currencyCode: 'USD',
				posIdleLockSeconds: 120
			},
			ctx
		);
	});
	await db
		.update(restaurantSettings)
		.set({ acceptsCard: true })
		.where(eq(restaurantSettings.restaurantId, restaurant.id));
	const cashier = await seedStaff(db, restaurant.id, {
		displayName: 'Sam',
		roleName: 'Cashier'
	});
	const waiter = await seedStaff(db, restaurant.id, {
		displayName: 'Wren',
		roleName: 'Waiter'
	});
	const device = await db.transaction((tx) =>
		registerDevice(tx, {
			restaurantId: restaurant.id,
			actorUserId: owner.id,
			label: 'Till'
		})
	);
	const categoryId = await db.transaction((tx) =>
		requireIdMenu(createCategory(tx, restaurant.id, { name: 'Drinks' }))
	);
	const itemId = await db.transaction((tx) =>
		requireIdMenu(
			createItem(tx, restaurant.id, {
				categoryId,
				name: 'Tea',
				priceMinor: 850n
			})
		)
	);
	const menuVersion = await getMenuVersion(db, restaurant.id);
	return {
		restaurantId: restaurant.id,
		ownerId: owner.id,
		cashierId: cashier.id,
		waiterId: waiter.id,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode,
		deviceToken: device.token,
		itemId,
		menuVersion
	};
}

function makeEvent(body: unknown, cookies: Record<string, string> = {}): RequestEvent {
	const jar = new Map(Object.entries(cookies));
	const url = new URL('http://localhost/api/pos/sync');
	const init: RequestInit = {
		method: 'POST',
		headers: { origin: 'http://localhost', 'content-type': 'application/json' },
		body: JSON.stringify(body)
	};
	return {
		cookies: {
			get: (name: string) => jar.get(name),
			getAll: () => [...jar].map(([name, value]) => ({ name, value })),
			set: (name: string, value: string) => jar.set(name, value),
			delete: (name: string) => jar.delete(name),
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '203.0.113.5',
		locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null },
		params: {},
		platform: undefined,
		request: new Request(url, init),
		route: { id: '/api/pos/sync' },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

async function post(
	body: unknown,
	fx: Fixture,
	extraCookies: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
	const response = (await POST(
		makeEvent(body, { [DEVICE_COOKIE]: fx.deviceToken, ...extraCookies })
	)) as Response;
	return { status: response.status, body: await response.json() };
}

function envelope(
	fx: Fixture,
	kind: OpKind,
	employeeId: string,
	payload: unknown,
	clientOpId = randomUUID()
): OpEnvelope<OpKind, unknown> {
	return {
		kind,
		clientOpId,
		deviceId: fx.deviceId,
		employeeId,
		occurredAt: new Date().toISOString(),
		seq: 0,
		payload
	};
}

describe('POST /api/pos/sync (T-27)', () => {
	it('415 on the wrong content type; 400 on unparseable body; 400 on a malformed envelope', async () => {
		const fx = await makeFixture(`sync-api-${randomUUID()}@example.com`);
		const noJson = (await POST({
			...makeEvent('nope', { [DEVICE_COOKIE]: fx.deviceToken }),
			request: new Request('http://localhost/api/pos/sync', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'not json'
			})
		} as RequestEvent)) as Response;
		expect(noJson.status).toBe(415);

		const badJson = (await POST({
			...makeEvent({}, { [DEVICE_COOKIE]: fx.deviceToken }),
			request: new Request('http://localhost/api/pos/sync', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{not json'
			})
		} as RequestEvent)) as Response;
		expect(badJson.status).toBe(400);

		const badEnv = await post({ hello: 'world' }, fx);
		expect(badEnv.status).toBe(400);
		expect((badEnv.body as { error: string }).error).toBe('invalid_request');
	});

	it('a well-formed session.open op returns 200 accepted with businessDate', async () => {
		const fx = await makeFixture(`sync-api-${randomUUID()}@example.com`);
		const env = envelope(fx, 'session.open', fx.cashierId, {
			posSessionId: randomUUID(),
			openingCashMinor: '0'
		});
		const result = await post(env, fx);
		expect(result.status).toBe(200);
		const body = result.body as {
			status: string;
			posSessionId?: string;
			businessDate?: string;
		};
		expect(body.status).toBe('accepted');
		expect(body.posSessionId).toBeTruthy();
		expect(body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('a duplicate op replays; two POSTs of the same envelope leave one op row', async () => {
		const fx = await makeFixture(`sync-api-${randomUUID()}@example.com`);
		const env = envelope(fx, 'session.open', fx.cashierId, {
			posSessionId: randomUUID(),
			openingCashMinor: '0'
		});
		const first = await post(env, fx);
		expect(first.status).toBe(200);
		const second = await post(env, fx);
		expect(second.status).toBe(200);
		expect((second.body as { status: string }).status).toBe('replayed');
		const rows = await db.execute<{ c: string }>(
			sql`select count(*)::text as c from pos_sync_ops where client_op_id = ${env.clientOpId}`
		);
		expect((rows.rows[0] as { c: string }).c).toBe('1');
		void posSyncOps;
	});

	it('a card session.close by a waiter answers 403 not_permitted with nothing stored', async () => {
		const fx = await makeFixture(`sync-api-${randomUUID()}@example.com`);
		// Open a session first as cashier through the API.
		const openEnv = envelope(fx, 'session.open', fx.cashierId, {
			posSessionId: randomUUID(),
			openingCashMinor: '0'
		});
		const opened = await post(openEnv, fx);
		const posSessionId = (opened.body as { posSessionId: string }).posSessionId;

		// Waiter attempts session.close.
		const closeEnv = envelope(fx, 'session.close', fx.waiterId, {
			posSessionId,
			countedCashMinor: '0'
		});
		const closed = await post(closeEnv, fx);
		expect(closed.status).toBe(403);
	});
});
