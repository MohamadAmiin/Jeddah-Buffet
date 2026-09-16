import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { posDevices } from '$lib/server/db/schema/pos-devices';
import { auditLog } from '$lib/server/db/schema/audit';
import type { Principal } from '$lib/server/auth/session';
import { registerDevice, validateDeviceToken } from '$lib/server/auth/pos-device';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(email: string) {
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
	const device = await db.transaction((tx) =>
		registerDevice(tx, {
			restaurantId: restaurant.id,
			actorUserId: owner.id,
			label: 'Counter tablet'
		})
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, ...device };
}

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Staff',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

/** A dashboard request: the principal and tenant the hook would have set, and an optional form body. */
function makeEvent(user: Principal, form?: Record<string, string>): RequestEvent {
	const url = new URL('http://localhost/device');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/device' },
		url
	} as unknown as RequestEvent;
}

/** The status a load or action threw, or undefined when it returned. */
async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

function revoke(event: RequestEvent) {
	return actions.revoke!(event as Parameters<NonNullable<typeof actions.revoke>>[0]);
}

async function revokedRows() {
	return db.select().from(auditLog).where(eq(auditLog.event, 'pos.device.revoked'));
}

describe('the /device revoke action', () => {
	// MANDATORY (spec 29 — a permission check on every POS surface). A 403 — never a
	// 404, never a 303 — and the row untouched.
	it('refuses a cashier with exactly 403, in the action and in the load', async () => {
		const a = await makeRestaurant('owner@cafe.com');
		const [cashier] = await db
			.insert(users)
			.values({ restaurantId: a.restaurantId, role: 'cashier', displayName: 'Staff' })
			.returning();
		const asCashier = principal(cashier.id, a.restaurantId, 'cashier');

		expect(await statusOf(() => revoke(makeEvent(asCashier, { deviceId: a.deviceId })))).toBe(403);
		expect(await statusOf(() => load(makeEvent(asCashier) as never))).toBe(403);

		const [row] = await db.select().from(posDevices).where(eq(posDevices.id, a.deviceId));
		expect(row.revokedAt).toBeNull();
		expect(await revokedRows()).toHaveLength(0);
	});

	it('revokes: the token stops validating, and the row is stamped, never deleted', async () => {
		const a = await makeRestaurant('owner@cafe.com');
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
		const [{ n: before }] = await db.select({ n: sql<number>`count(*)::int` }).from(posDevices);

		const result = await revoke(makeEvent(asOwner, { deviceId: a.deviceId }));

		expect(result).toEqual({ message: 'Device revoked. It can no longer show the PIN screen.' });
		expect(await validateDeviceToken(db, a.token)).toBeNull();
		const [{ n: after }] = await db.select({ n: sql<number>`count(*)::int` }).from(posDevices);
		expect(after).toBe(before);
		const [row] = await db.select().from(posDevices).where(eq(posDevices.id, a.deviceId));
		expect(row.revokedAt).not.toBeNull();
		expect(row.revokedByUserId).toBe(a.ownerId);
	});

	it('writes exactly one pos.device.revoked row — code and label from the stamp, no device id', async () => {
		const a = await makeRestaurant('owner@cafe.com');
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

		await revoke(makeEvent(asOwner, { deviceId: a.deviceId }));

		const rows = await revokedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({ deviceCode: a.deviceCode, label: 'Counter tablet' });
		expect(rows[0].actorUserId).toBe(a.ownerId);
		// A dashboard-actor event: "null for every dashboard event".
		expect(rows[0].deviceId).toBeNull();
	});

	it('answers a second revoke with "already revoked" and still one audit row', async () => {
		const a = await makeRestaurant('owner@cafe.com');
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

		await revoke(makeEvent(asOwner, { deviceId: a.deviceId }));
		const again = await revoke(makeEvent(asOwner, { deviceId: a.deviceId }));

		expect(again).toEqual({ message: 'That device was already revoked.' });
		expect(await revokedRows()).toHaveLength(1);
	});

	it("cannot revoke another restaurant's device", async () => {
		const a = await makeRestaurant('a@cafe.com');
		const b = await makeRestaurant('b@cafe.com');
		const asOwnerB = principal(b.ownerId, b.restaurantId, 'owner');

		const result = await revoke(makeEvent(asOwnerB, { deviceId: a.deviceId }));

		expect(result).toEqual({ message: 'That device was already revoked.' });
		const [row] = await db.select().from(posDevices).where(eq(posDevices.id, a.deviceId));
		expect(row.revokedAt).toBeNull();
		expect(await validateDeviceToken(db, a.token)).not.toBeNull();
		expect(await revokedRows()).toHaveLength(0);
	});

	it('refuses a missing or malformed deviceId with 400 and changes nothing', async () => {
		const a = await makeRestaurant('owner@cafe.com');
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

		const result = await revoke(makeEvent(asOwner, { deviceId: 'not-a-uuid' }));

		expect((result as { status?: number }).status).toBe(400);
		expect(await validateDeviceToken(db, a.token)).not.toBeNull();
	});
});
