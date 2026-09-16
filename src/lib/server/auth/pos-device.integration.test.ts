import { describe, it, expect, afterAll } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { posDevices } from '../db/schema/pos-devices';
import {
	DEVICE_COOKIE,
	DEVICE_COOKIE_MAX_AGE_SECONDS,
	deviceTokenHash,
	registerDevice,
	revokeDevice,
	setDeviceCookie,
	validateDeviceToken
} from './pos-device';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/** A restaurant and its owner. users_owner_has_credentials requires email AND a password hash. */
async function makeRestaurantWithOwner(email = 'owner@cafe.com') {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	return { restaurantId: restaurant.id, ownerId: owner.id };
}

function register(restaurantId: string, actorUserId: string, label = 'Counter tablet', now?: Date) {
	return db.transaction((tx) => registerDevice(tx, { restaurantId, actorUserId, label, now }));
}

function revoke(deviceId: string, restaurantId: string, actorUserId: string) {
	return db.transaction((tx) => revokeDevice(tx, { deviceId, restaurantId, actorUserId }));
}

async function deviceCount(restaurantId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(posDevices)
		.where(eq(posDevices.restaurantId, restaurantId));
	return row.n;
}

describe('registerDevice', () => {
	it('registers a device that then validates to the same device, restaurant and code', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner();
		const registered = await register(restaurantId, ownerId);

		expect(await validateDeviceToken(db, registered.token)).toEqual({
			deviceId: registered.deviceId,
			restaurantId,
			deviceCode: registered.deviceCode
		});
	});

	it('gives the first device POS1 and stores the label and the registering owner', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner();
		const { deviceId, deviceCode } = await register(restaurantId, ownerId, 'Front counter');

		expect(deviceCode).toBe('POS1');
		const [row] = await db.select().from(posDevices).where(eq(posDevices.id, deviceId));
		expect(row.label).toBe('Front counter');
		expect(row.registeredByUserId).toBe(ownerId);
		expect(row.revokedAt).toBeNull();
	});

	it('returns an expiresAt one cookie lifetime after now', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner();
		const now = new Date('2026-09-15T10:00:00.000Z');
		const { expiresAt } = await register(restaurantId, ownerId, 'Counter tablet', now);

		const expected = now.getTime() + DEVICE_COOKIE_MAX_AGE_SECONDS * 1000;
		expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(1000);
	});

	it('never stores the raw token — only its SHA-256', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner();
		const { token } = await register(restaurantId, ownerId);

		const count = async (value: string) => {
			const { rows } = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from pos_devices where token_hash = ${value}`
			);
			return rows[0].n;
		};
		expect(await count(token)).toBe(0);
		expect(await count(deviceTokenHash(token))).toBe(1);
	});

	// Under a partial unique index this would pass with two POS1 rows — exactly the
	// outcome pos_devices forbids, because POS1-000001 would then name two sales.
	it('never reuses a code: register, revoke, register gives POS2', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner();
		const first = await register(restaurantId, ownerId);
		await revoke(first.deviceId, restaurantId, ownerId);
		const second = await register(restaurantId, ownerId);

		expect(second.deviceCode).toBe('POS2');
		expect(second.deviceId).not.toBe(first.deviceId);
		expect(second.token).not.toBe(first.token);
		expect(await validateDeviceToken(db, first.token)).toBeNull();
		expect(await validateDeviceToken(db, second.token)).not.toBeNull();

		const rows = await db
			.select()
			.from(posDevices)
			.where(eq(posDevices.restaurantId, restaurantId));
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
	});

	// Refusing a second registration is the ROUTE's 409, where the `for update`
	// select lives. This pins that the module does not silently supersede.
	it('does not replace an active device: two registrations leave POS1 and POS2 active', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner();
		await register(restaurantId, ownerId);
		await register(restaurantId, ownerId);

		const rows = await db
			.select()
			.from(posDevices)
			.where(eq(posDevices.restaurantId, restaurantId));
		expect(rows.map((r) => r.deviceCode).sort()).toEqual(['POS1', 'POS2']);
		expect(rows.every((r) => r.revokedAt === null)).toBe(true);
	});

	it('refuses a cashier, and the owner of another restaurant, inserting nothing', async () => {
		const a = await makeRestaurantWithOwner('a@cafe.com');
		const b = await makeRestaurantWithOwner('b@cafe.com');
		const [cashier] = await db
			.insert(users)
			.values({ restaurantId: a.restaurantId, role: 'cashier', displayName: 'Cashier' })
			.returning();

		await expect(register(a.restaurantId, cashier.id)).rejects.toThrow(
			'registerDevice requires the owner of this restaurant'
		);
		await expect(register(a.restaurantId, b.ownerId)).rejects.toThrow(
			'registerDevice requires the owner of this restaurant'
		);
		expect(await deviceCount(a.restaurantId)).toBe(0);
	});
});

describe('revokeDevice', () => {
	it('stamps the row instead of deleting it, and the token stops validating', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner();
		const { deviceId, token } = await register(restaurantId, ownerId);
		const before = await deviceCount(restaurantId);

		await revoke(deviceId, restaurantId, ownerId);

		expect(await validateDeviceToken(db, token)).toBeNull();
		expect(await deviceCount(restaurantId)).toBe(before);
		const [row] = await db.select().from(posDevices).where(eq(posDevices.id, deviceId));
		expect(row.revokedAt).not.toBeNull();
		expect(row.revokedByUserId).toBe(ownerId);
	});

	it('returns the code and label it stamped, and null when there is nothing to stamp', async () => {
		const a = await makeRestaurantWithOwner('a@cafe.com');
		const b = await makeRestaurantWithOwner('b@cafe.com');
		const deviceA = await register(a.restaurantId, a.ownerId, 'Tablet A');
		const deviceB = await register(b.restaurantId, b.ownerId, 'Tablet B');

		expect(await revoke(deviceA.deviceId, a.restaurantId, a.ownerId)).toEqual({
			deviceCode: 'POS1',
			label: 'Tablet A'
		});
		// Already revoked.
		expect(await revoke(deviceA.deviceId, a.restaurantId, a.ownerId)).toBeNull();
		// No such device.
		expect(await revoke(crypto.randomUUID(), a.restaurantId, a.ownerId)).toBeNull();
		// Another restaurant's device, and it stays valid.
		expect(await revoke(deviceB.deviceId, a.restaurantId, a.ownerId)).toBeNull();
		expect(await validateDeviceToken(db, deviceB.token)).not.toBeNull();
	});
});

describe('setDeviceCookie', () => {
	it("passes only path, maxAge and expires, leaving httpOnly, sameSite and Secure at SvelteKit's defaults", () => {
		const calls: Array<[string, string, Record<string, unknown>]> = [];
		const cookies = {
			set: (name: string, value: string, options: Record<string, unknown>) =>
				calls.push([name, value, options])
		} as unknown as Cookies;
		const expiresAt = new Date('2027-10-20T00:00:00.000Z');

		setDeviceCookie(cookies, 'the-token', expiresAt);

		expect(calls).toEqual([
			[
				DEVICE_COOKIE,
				'the-token',
				{ path: '/', maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS, expires: expiresAt }
			]
		]);
	});
});
