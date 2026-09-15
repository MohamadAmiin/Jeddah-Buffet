import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import type { Principal } from '$lib/server/auth/session';
import { registerDevice, revokeDevice } from '$lib/server/auth/pos-device';
import { createEmployee } from '$lib/server/auth/employees';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { load } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

type Overview = {
	settings: { complete: boolean; missing: string[] };
	employeesReady: boolean;
	deviceRegistered: boolean;
};

/** A restaurant exactly as registration leaves it: settings row, time zone, one owner, nothing else. */
async function freshRestaurant() {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: 'Cafe One',
			timeZone: 'Africa/Mogadishu'
		})
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email: 'owner@cafe.com',
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	return { restaurantId: restaurant.id, ownerId: owner.id };
}

function eventFor(userId: string, restaurantId: string, role: Principal['role']): RequestEvent {
	const user: Principal = {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Staff',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
	const url = new URL('http://localhost/dashboard');
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url),
		route: { id: '/(dashboard)/dashboard' },
		url
	} as unknown as RequestEvent;
}

async function overview(a: { restaurantId: string; ownerId: string }): Promise<Overview> {
	return (await load(eventFor(a.ownerId, a.restaurantId, 'owner') as never)) as Overview;
}

const ctx = (actorUserId: string) => ({ actorUserId, ip: null, userAgent: null });

describe('the overview checklist', () => {
	it('reads nothing as done for a freshly registered restaurant', async () => {
		const a = await freshRestaurant();

		const data = await overview(a);

		expect(data.settings.complete).toBe(false);
		expect(data.employeesReady).toBe(false);
		expect(data.deviceRegistered).toBe(false);
	});

	it('counts the till registered only while its device is not revoked', async () => {
		const a = await freshRestaurant();
		const device = await db.transaction((tx) =>
			registerDevice(tx, {
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId,
				label: 'Counter tablet'
			})
		);
		expect((await overview(a)).deviceRegistered).toBe(true);

		await db.transaction((tx) =>
			revokeDevice(tx, {
				deviceId: device.deviceId,
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId
			})
		);
		expect((await overview(a)).deviceRegistered).toBe(false);
	});

	it('counts the employees ready only when a cashier AND a waiter each have a PIN', async () => {
		const a = await freshRestaurant();

		await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ role: 'cashier', displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);
		expect((await overview(a)).employeesReady).toBe(false);

		await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ role: 'waiter', displayName: 'Robin', pin: '5678' },
				ctx(a.ownerId)
			)
		);
		expect((await overview(a)).employeesReady).toBe(true);

		// And back again when the data goes away: a cashier without a PIN.
		await db.update(users).set({ pinHash: null }).where(eq(users.displayName, 'Sam'));
		expect((await overview(a)).employeesReady).toBe(false);
	});

	it('returns no hash and no device token', async () => {
		const a = await freshRestaurant();
		const device = await db.transaction((tx) =>
			registerDevice(tx, {
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId,
				label: 'Counter tablet'
			})
		);
		await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ role: 'cashier', displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		// Exactly what SvelteKit serialises into the page HTML and __data.json.
		const serialised = JSON.stringify(await overview(a));

		for (const needle of ['pinHash', 'pin_hash', 'passwordHash', 'token', device.token]) {
			expect(serialised).not.toContain(needle);
		}
	});

	it('keeps its own guard: a cashier gets 403', async () => {
		const a = await freshRestaurant();
		const [cashier] = await db
			.insert(users)
			.values({ restaurantId: a.restaurantId, role: 'cashier', displayName: 'Staff' })
			.returning();

		const status = await Promise.resolve(
			load(eventFor(cashier.id, a.restaurantId, 'cashier') as never)
		).then(
			() => undefined,
			(thrown: { status?: number }) => thrown.status
		);

		expect(status).toBe(403);
	});
});
