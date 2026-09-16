import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import {
	DEVICE_COOKIE,
	generateDeviceToken,
	registerDevice,
	revokeDevice
} from '$lib/server/auth/pos-device';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { createCategory } from '$lib/server/menu';
import { GET } from './+server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/** A restaurant with its settings row (menu_version 1), its owner and a registered till. */
async function makeRestaurant(name: string) {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, { restaurantName: name, timeZone: 'UTC' })
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: `${name} Owner`,
			email: `owner-${restaurant.id}@cafe.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId: restaurant.id, actorUserId: owner.id, label: 'Till' })
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, ...device };
}

function makeEvent(cookies: Record<string, string>, headers: Record<string, string> = {}) {
	const jar = new Map(Object.entries(cookies));
	const url = new URL('http://localhost/api/menu/version');
	return {
		cookies: {
			get: (name: string) => jar.get(name),
			getAll: () => [...jar].map(([name, value]) => ({ name, value })),
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		getClientAddress: () => '203.0.113.5',
		locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, { headers }),
		route: { id: '/api/menu/version' },
		setHeaders: () => {},
		url
	} as unknown as Parameters<typeof GET>[0];
}

/** The response, or the status and message of what the handler threw. */
async function call(event: RequestEvent) {
	try {
		const response = await GET(event as Parameters<typeof GET>[0]);
		const text = await response.text();
		return { status: response.status, headers: response.headers, text };
	} catch (thrown) {
		return { status: (thrown as { status?: number }).status, headers: null, text: '' };
	}
}

describe('GET /api/menu/version', () => {
	// MANDATORY (spec 29 — a permission check on every POS API route).
	it('answers 403, with no version, to no cookie, an unknown device and a revoked one', async () => {
		const a = await makeRestaurant('Cafe One');
		await db.transaction((tx) =>
			revokeDevice(tx, {
				deviceId: a.deviceId,
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId
			})
		);

		const jars: Record<string, string>[] = [
			{},
			{ [DEVICE_COOKIE]: generateDeviceToken() },
			{ [DEVICE_COOKIE]: a.token }
		];
		for (const cookies of jars) {
			const result = await call(makeEvent(cookies));
			expect(result.status).toBe(403);
			expect(result.text).not.toMatch(/version/);
		}
	});

	it('answers a registered device with the version, the restaurant, an ETag and the cache policy', async () => {
		const a = await makeRestaurant('Cafe One');

		const result = await call(makeEvent({ [DEVICE_COOKIE]: a.token }));

		expect(result.status).toBe(200);
		expect(JSON.parse(result.text)).toEqual({ version: 1, restaurantId: a.restaurantId });
		expect(result.headers!.get('etag')).toBe(`W/"menu-${a.restaurantId}-1"`);
		expect(result.headers!.get('cache-control')).toBe('private, no-cache');
		expect(result.headers!.get('vary')).toBe('Cookie');
	});

	it('answers its own ETag with 304 and no body — as a list, weak or strong', async () => {
		const a = await makeRestaurant('Cafe One');
		const first = await call(makeEvent({ [DEVICE_COOKIE]: a.token }));
		const etag = first.headers!.get('etag')!;

		for (const ifNoneMatch of [etag, `"something-else", ${etag}`, etag.replace(/^W\//, '')]) {
			const again = await call(
				makeEvent({ [DEVICE_COOKIE]: a.token }, { 'if-none-match': ifNoneMatch })
			);
			expect(again.status).toBe(304);
			expect(again.text).toBe('');
			expect(again.headers!.get('etag')).toBe(etag);
		}
	});

	it('moves after a menu write, and the old ETag no longer matches', async () => {
		const a = await makeRestaurant('Cafe One');
		const first = await call(makeEvent({ [DEVICE_COOKIE]: a.token }));
		await db.transaction((tx) => createCategory(tx, a.restaurantId, { name: 'Drinks' }));

		const after = await call(
			makeEvent({ [DEVICE_COOKIE]: a.token }, { 'if-none-match': first.headers!.get('etag')! })
		);

		expect(after.status).toBe(200);
		expect(JSON.parse(after.text)).toEqual({ version: 2, restaurantId: a.restaurantId });
	});

	it("gives each device only its own restaurant's version", async () => {
		const a = await makeRestaurant('Cafe One');
		const b = await makeRestaurant('Cafe Two');
		await db.transaction((tx) => createCategory(tx, a.restaurantId, { name: 'Drinks' }));

		expect(JSON.parse((await call(makeEvent({ [DEVICE_COOKIE]: a.token }))).text)).toEqual({
			version: 2,
			restaurantId: a.restaurantId
		});
		expect(JSON.parse((await call(makeEvent({ [DEVICE_COOKIE]: b.token }))).text)).toEqual({
			version: 1,
			restaurantId: b.restaurantId
		});
	});

	// Two restaurants at the SAME version must not share a validator: a tablet moved
	// from A to B would otherwise revalidate with A's ETag, get a 304 and keep A's menu.
	it("does not answer restaurant A's ETag with 304 for restaurant B's device at an equal version", async () => {
		const a = await makeRestaurant('Cafe One');
		const b = await makeRestaurant('Cafe Two');
		const etagOfA = (await call(makeEvent({ [DEVICE_COOKIE]: a.token }))).headers!.get('etag')!;

		const result = await call(
			makeEvent({ [DEVICE_COOKIE]: b.token }, { 'if-none-match': etagOfA })
		);

		expect(result.status).toBe(200);
		expect(JSON.parse(result.text)).toEqual({ version: 1, restaurantId: b.restaurantId });
	});
});
