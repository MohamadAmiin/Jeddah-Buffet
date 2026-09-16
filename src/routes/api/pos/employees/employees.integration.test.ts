import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { hashPin } from '$lib/pin';
import {
	DEVICE_COOKIE,
	generateDeviceToken,
	registerDevice,
	revokeDevice
} from '$lib/server/auth/pos-device';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { GET } from './+server';

const db = testDb();
let PIN_1234: string;

beforeAll(async () => {
	PIN_1234 = await hashPin('1234');
});

afterAll(async () => {
	await closeTestDb();
});

/** A restaurant WITH its settings row, its owner, an active cashier, and a registered till. */
async function makeRestaurant(name: string, email: string) {
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
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	await db.insert(users).values({
		restaurantId: restaurant.id,
		role: 'cashier',
		displayName: 'Sam',
		pinHash: PIN_1234
	});
	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId: restaurant.id, actorUserId: owner.id, label: 'Till' })
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, ...device };
}

function makeEvent(cookies: Record<string, string>): RequestEvent {
	const jar = new Map(Object.entries(cookies));
	const url = new URL('http://localhost/api/pos/employees');
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
		request: new Request(url),
		route: { id: '/api/pos/employees' },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

/** GET, returning the status, the SERIALISED body parsed back, and the headers — or the thrown status. */
async function get(cookies: Record<string, string>) {
	try {
		const response = await GET(makeEvent(cookies));
		return {
			status: response.status,
			body: JSON.parse(await response.text()) as {
				device: { id: string };
				employees: Array<Record<string, unknown>>;
				settings: { posIdleLockSeconds: number | null };
			},
			headers: response.headers
		};
	} catch (thrown) {
		const status = (thrown as { status?: number }).status;
		if (status === undefined) throw thrown;
		return { status, body: null, headers: null };
	}
}

describe('GET /api/pos/employees', () => {
	// MANDATORY (spec 29 — a permission check test on every POS API route). A read,
	// and still guarded: this one ships password-equivalent material.
	it('answers exactly 403 — and returns nothing — without a live registered device', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const none = await get({});
		expect(none).toEqual({ status: 403, body: null, headers: null });

		const unknown = await get({ [DEVICE_COOKIE]: generateDeviceToken() });
		expect(unknown).toEqual({ status: 403, body: null, headers: null });

		await db.transaction((tx) =>
			revokeDevice(tx, {
				deviceId: a.deviceId,
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId
			})
		);
		const revoked = await get({ [DEVICE_COOKIE]: a.token });
		expect(revoked).toEqual({ status: 403, body: null, headers: null });
	});

	it("returns only the device's restaurant's employees", async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const b = await makeRestaurant('Cafe B', 'b@cafe.com');
		await db.insert(users).values({
			restaurantId: b.restaurantId,
			role: 'waiter',
			displayName: 'Should Not Appear'
		});

		const result = await get({ [DEVICE_COOKIE]: a.token });

		expect(result.status).toBe(200);
		const names = result.body!.employees.map((e) => e.displayName);
		expect(names).not.toContain('Should Not Appear');
		// Restaurant A has exactly its owner and its cashier.
		expect(result.body!.employees).toHaveLength(2);
	});

	// The leak this catches is a route that spreads a database row: asserted on the
	// SERIALISED body, not on the read model's return value.
	it('serialises exactly the five keys of the read model, and exactly three top-level keys', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const { body } = await get({ [DEVICE_COOKIE]: a.token });

		expect(Object.keys(body!).sort()).toEqual(['device', 'employees', 'settings']);
		// The device's uuid — what the till binds its cache to — and nothing else.
		expect(body!.device).toEqual({ id: a.deviceId });
		for (const entry of body!.employees) {
			expect(Object.keys(entry).sort()).toEqual([
				'displayName',
				'id',
				'isActive',
				'pinPhc',
				'role'
			]);
		}
	});

	it('keeps an employee with no PIN and drops a deactivated one — both decided by the read model', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await db.insert(users).values([
			{ restaurantId: a.restaurantId, role: 'waiter', displayName: 'New Hire' },
			{ restaurantId: a.restaurantId, role: 'waiter', displayName: 'Gone', isActive: false }
		]);

		const { body } = await get({ [DEVICE_COOKIE]: a.token });
		const byName = new Map(body!.employees.map((e) => [e.displayName, e]));

		expect(byName.get('New Hire')?.pinPhc).toBeNull();
		expect(byName.has('Gone')).toBe(false);
	});

	it('passes the idle lock through as null until set, then as the stored integer', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const before = await get({ [DEVICE_COOKIE]: a.token });
		// null, not a substituted number.
		expect(before.body!.settings).toEqual({ posIdleLockSeconds: null });

		await db.transaction((tx) =>
			updateSettings(
				tx,
				a.restaurantId,
				{ posIdleLockSeconds: 120 },
				{ actorUserId: a.ownerId, ip: null, userAgent: null }
			)
		);
		const after = await get({ [DEVICE_COOKIE]: a.token });
		expect(after.body!.settings).toEqual({ posIdleLockSeconds: 120 });
	});

	it('tells every cache not to keep the response', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const { headers } = await get({ [DEVICE_COOKIE]: a.token });
		expect(headers!.get('cache-control')).toBe('no-store');
	});
});
