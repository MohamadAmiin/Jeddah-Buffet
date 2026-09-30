import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { createItem, setItemImage } from '$lib/server/menu';
import { GET } from './[id]/+server';

// GET /menu/images/[id] — the dashboard's photo route (menu-and-printing T-08).
// Built the way menu-page.integration.test.ts builds its events: a Principal in
// locals, the tenant beside it. The 403 is the route's own (invariant 8, reads
// included), not the hook's — route-guards.integration.test.ts covers the hook.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72]);

async function makeRestaurant(name: string) {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, { restaurantName: name, timeZone: 'Africa/Mogadishu' })
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email: `owner-${restaurant.id}@cafe.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const { id: cashierId } = await seedStaff(db, restaurant.id, { displayName: 'Cashier' });
	const item = await db.transaction((tx) =>
		createItem(tx, restaurant.id, { name: 'Burger', priceMinor: 800n })
	);
	if (!item.ok) throw new Error('item not created');
	const photo = await db.transaction((tx) =>
		setItemImage(tx, restaurant.id, item.id, { bytes: PNG, contentType: 'image/png' })
	);
	if (!photo.ok) throw new Error('photo not set');
	return { restaurantId: restaurant.id, ownerId: owner.id, cashierId, imageId: photo.imageId };
}

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Cashier',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function makeEvent(user: Principal, id: string): RequestEvent {
	const url = new URL(`http://localhost/menu/images/${id}`);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: { id },
		request: new Request(url),
		route: { id: '/(dashboard)/menu/images/[id]' },
		setHeaders: () => {},
		url
	} as unknown as RequestEvent;
}

async function call(user: Principal, id: string) {
	try {
		const response = await GET(makeEvent(user, id));
		return {
			status: response.status,
			contentType: response.headers.get('content-type'),
			bytes: new Uint8Array(await response.arrayBuffer())
		};
	} catch (thrown) {
		return { status: (thrown as { status?: number }).status, contentType: null, bytes: null };
	}
}

describe('GET /menu/images/[id]', () => {
	it('serves the owner their own photo', async () => {
		const a = await makeRestaurant('Cafe One');
		const result = await call(principal(a.ownerId, a.restaurantId, 'owner'), a.imageId);
		expect(result.status).toBe(200);
		expect(result.contentType).toBe('image/png');
		expect(Array.from(result.bytes!)).toEqual(Array.from(PNG));
	});

	// MANDATORY (spec 29; invariant 8 — reads included): 403 EXACTLY for a
	// signed-in principal without admin.menu.
	it('answers exactly 403, with no bytes, to a cashier of the same restaurant', async () => {
		const a = await makeRestaurant('Cafe One');
		const result = await call(principal(a.cashierId, a.restaurantId, 'staff'), a.imageId);
		expect(result.status).toBe(403);
		expect(result.bytes).toBeNull();
	});

	it("answers 404 to another restaurant's owner asking for this restaurant's photo", async () => {
		const a = await makeRestaurant('Cafe One');
		const b = await makeRestaurant('Cafe Two');
		const result = await call(principal(b.ownerId, b.restaurantId, 'owner'), a.imageId);
		expect(result.status).toBe(404);
		expect(result.bytes).toBeNull();
	});
});
