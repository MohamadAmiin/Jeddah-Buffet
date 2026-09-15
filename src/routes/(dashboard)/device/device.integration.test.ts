import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { posDevices } from '$lib/server/db/schema/pos-devices';
import { auditLog } from '$lib/server/db/schema/audit';
import type { Principal } from '$lib/server/auth/session';
import { registerDevice, validateDeviceToken } from '$lib/server/auth/pos-device';
import { onRestaurantCreated, settingsComplete } from '$lib/server/restaurants';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/** A restaurant as registration leaves it — settings row, time zone, no idle lock — plus its owner and one device. */
async function makeRestaurant() {
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

type DevicePageData = {
	device: {
		id: string;
		deviceCode: string;
		label: string;
		registeredAt: Date;
		lastSeenAt: Date | null;
		revokedAt: Date | null;
	} | null;
	settings: { complete: boolean; missing: string[] };
	idleLockSeconds: number | null;
	timeZone: string | null;
};

async function loadAs(user: Principal): Promise<DevicePageData> {
	return (await load(makeEvent(user) as never)) as DevicePageData;
}

function revoke(event: RequestEvent) {
	return actions.revoke!(event as Parameters<NonNullable<typeof actions.revoke>>[0]);
}

function setIdleLock(event: RequestEvent) {
	return actions.setIdleLock!(event as Parameters<NonNullable<typeof actions.setIdleLock>>[0]);
}

// What settingsComplete() reports before the owner has chosen anything: T-08's
// idle lock, then T-36's tax mode, tax rate and currency, in that order.
const NOTHING_SET = {
	complete: false,
	missing: ['POS idle lock', 'tax mode', 'tax rate', 'currency']
};

describe('the /device page', () => {
	// MANDATORY (spec 29 — permission checks; this repository applies the rule to
	// every route). 403 exactly — never a 404, never a 303 — from the load AND from
	// both actions, each a separately reachable endpoint.
	it.each(['cashier', 'waiter'] as const)(
		'refuses a %s with 403 on the load and on both actions, and changes nothing',
		async (role) => {
			const a = await makeRestaurant();
			const [staff] = await db
				.insert(users)
				.values({ restaurantId: a.restaurantId, role, displayName: 'Staff' })
				.returning();
			const asStaff = principal(staff.id, a.restaurantId, role);

			expect(await statusOf(() => load(makeEvent(asStaff) as never))).toBe(403);
			expect(await statusOf(() => revoke(makeEvent(asStaff, { deviceId: a.deviceId })))).toBe(403);
			expect(
				await statusOf(() => setIdleLock(makeEvent(asStaff, { posIdleLockSeconds: '120' })))
			).toBe(403);

			expect(await validateDeviceToken(db, a.token)).not.toBeNull();
			expect(await settingsComplete(db, a.restaurantId)).toEqual(NOTHING_SET);
		}
	);

	it('returns the device, the settings gate and the stored idle lock to the owner', async () => {
		const a = await makeRestaurant();

		const result = await loadAs(principal(a.ownerId, a.restaurantId, 'owner'));

		expect(result.device?.deviceCode).toBe('POS1');
		expect(result.device?.label).toBe('Counter tablet');
		expect(result.device?.revokedAt).toBeNull();
		expect(result.device?.lastSeenAt).toBeNull();
		expect(result.settings).toEqual(NOTHING_SET);
		// Null, exactly as stored — no number the owner never chose.
		expect(result.idleLockSeconds).toBeNull();
	});

	it('never lets the device token or its hash leave the server', async () => {
		const a = await makeRestaurant();
		const [{ tokenHash }] = await db
			.select({ tokenHash: posDevices.tokenHash })
			.from(posDevices)
			.where(eq(posDevices.id, a.deviceId));

		// Exactly what SvelteKit serialises into the page HTML and __data.json.
		const serialised = JSON.stringify(await loadAs(principal(a.ownerId, a.restaurantId, 'owner')));

		expect(serialised).not.toContain(tokenHash);
		expect(serialised).not.toContain(a.token);
		expect(serialised).not.toMatch(/token/i);
	});

	it('still returns a revoked device, with revokedAt set, so the page can tell', async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
		await revoke(makeEvent(asOwner, { deviceId: a.deviceId }));

		const result = await loadAs(asOwner);

		expect(result.device?.id).toBe(a.deviceId);
		expect(result.device?.revokedAt).toBeInstanceOf(Date);
	});

	it('saves an idle lock of 120 through updateSettings, with its audit row, taking it off the missing list', async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

		const result = await setIdleLock(makeEvent(asOwner, { posIdleLockSeconds: '120' }));

		expect(result).toEqual({ message: 'Auto-lock saved.' });
		// The idle lock has left the list; the three T-36 settings are chosen on
		// /settings, not on this page, so they remain.
		expect(await settingsComplete(db, a.restaurantId)).toEqual({
			complete: false,
			missing: ['tax mode', 'tax rate', 'currency']
		});
		expect((await loadAs(asOwner)).idleLockSeconds).toBe(120);
		const updated = () => db.select().from(auditLog).where(eq(auditLog.event, 'settings.updated'));
		expect(await updated()).toHaveLength(1);

		// The same value again changes nothing and writes no second audit row.
		const again = await setIdleLock(makeEvent(asOwner, { posIdleLockSeconds: '120' }));
		expect(again).toEqual({ message: 'No change to save.' });
		expect(await updated()).toHaveLength(1);
	});

	it.each(['29', '1801', '', 'abc', '120.5'])(
		'refuses an idle lock of %j with 400 and leaves the setting unset',
		async (value) => {
			const a = await makeRestaurant();
			const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

			const result = await setIdleLock(makeEvent(asOwner, { posIdleLockSeconds: value }));

			expect((result as { status?: number }).status).toBe(400);
			expect(await settingsComplete(db, a.restaurantId)).toEqual(NOTHING_SET);
		}
	);
});
