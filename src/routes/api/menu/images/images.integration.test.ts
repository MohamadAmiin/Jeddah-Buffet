import { describe, it, expect, afterAll } from 'vitest';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { DEVICE_COOKIE, registerDevice, revokeDevice } from '$lib/server/auth/pos-device';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { createItem, setItemImage } from '$lib/server/menu';
import { GET } from './[id]/+server';

// GET /api/menu/images/[id] — the till's photo route (menu-and-printing T-08).
// The permission case is MANDATORY (spec 29 — a permission check on every POS
// API route); the tenant cases are invariant 8's "reads included".

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72]);

/** A restaurant with settings, an owner, a registered till and one item with a photo. */
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
	const item = await db.transaction((tx) =>
		createItem(tx, restaurant.id, { name: 'Burger', priceMinor: 800n })
	);
	if (!item.ok) throw new Error('item not created');
	const photo = await db.transaction((tx) =>
		setItemImage(tx, restaurant.id, item.id, { bytes: PNG, contentType: 'image/png' })
	);
	if (!photo.ok) throw new Error('photo not set');
	return { restaurantId: restaurant.id, ownerId: owner.id, imageId: photo.imageId, ...device };
}

function makeEvent(id: string, cookies: Record<string, string>) {
	const jar = new Map(Object.entries(cookies));
	const url = new URL(`http://localhost/api/menu/images/${id}`);
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
		params: { id },
		request: new Request(url),
		route: { id: '/api/menu/images/[id]' },
		setHeaders: () => {},
		url
	} as unknown as Parameters<typeof GET>[0];
}

async function call(id: string, cookies: Record<string, string>) {
	try {
		const response = await GET(makeEvent(id, cookies));
		return {
			status: response.status,
			headers: response.headers,
			bytes: new Uint8Array(await response.arrayBuffer())
		};
	} catch (thrown) {
		return { status: (thrown as { status?: number }).status, headers: null, bytes: null };
	}
}

describe('GET /api/menu/images/[id]', () => {
	it("serves a registered device its own restaurant's photo, bytes exact, seven headers", async () => {
		const a = await makeRestaurant('Cafe One');
		const result = await call(a.imageId, { [DEVICE_COOKIE]: a.token });

		expect(result.status).toBe(200);
		expect(Array.from(result.bytes!)).toEqual(Array.from(PNG));
		expect([...result.headers!.keys()].sort()).toEqual(
			[
				'cache-control',
				'content-disposition',
				'content-length',
				'content-security-policy',
				'content-type',
				'cross-origin-resource-policy',
				'x-content-type-options'
			].sort()
		);
		expect(result.headers!.get('content-type')).toBe('image/png');
		expect(result.headers!.get('content-length')).toBe(String(PNG.byteLength));
		expect(result.headers!.get('cache-control')).toBe('private, max-age=31536000, immutable');
		expect(result.headers!.get('x-content-type-options')).toBe('nosniff');
	});

	it("answers 404, with no bytes, to another restaurant's photo id and to a malformed id", async () => {
		const a = await makeRestaurant('Cafe One');
		const b = await makeRestaurant('Cafe Two');

		const crossed = await call(b.imageId, { [DEVICE_COOKIE]: a.token });
		expect(crossed.status).toBe(404);
		expect(crossed.bytes).toBeNull();

		const malformed = await call('not-a-uuid', { [DEVICE_COOKIE]: a.token });
		expect(malformed.status).toBe(404);
		expect(malformed.bytes).toBeNull();
	});

	// MANDATORY (spec 29 — a permission check on every POS API route).
	it('answers exactly 403, with no bytes, to no device cookie and to a revoked device', async () => {
		const a = await makeRestaurant('Cafe One');

		const anonymous = await call(a.imageId, {});
		expect(anonymous.status).toBe(403);
		expect(anonymous.bytes).toBeNull();

		await db.transaction((tx) =>
			revokeDevice(tx, {
				deviceId: a.deviceId,
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId
			})
		);
		const revoked = await call(a.imageId, { [DEVICE_COOKIE]: a.token });
		expect(revoked.status).toBe(403);
		expect(revoked.bytes).toBeNull();
	});
});
