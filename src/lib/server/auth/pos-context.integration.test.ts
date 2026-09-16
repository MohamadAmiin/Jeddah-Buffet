import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { DEVICE_COOKIE, generateDeviceToken, registerDevice, revokeDevice } from './pos-device';
import { createSession, validateSessionToken } from './session';
import { requireDevice } from './pos-context';

// The DEVICE half of spec 29's "a permission check test on every POS API route".
// The mandatory walk over the routes themselves lives with those routes; these
// cases pin the helper every one of them calls.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeOwner(email: string) {
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

function register(restaurantId: string, ownerId: string) {
	return db.transaction((tx) =>
		registerDevice(tx, { restaurantId, actorUserId: ownerId, label: 'Counter tablet' })
	);
}

/** A minimal RequestEvent, built the way route-guards.integration.test.ts builds one. */
function makeEvent(cookies: Record<string, string> = {}, locals: Partial<App.Locals> = {}) {
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
		locals: {
			user: null,
			restaurantId: null,
			sessionToken: null,
			posDevice: null,
			...locals
		} as App.Locals,
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

/** Report the status requireDevice threw, rather than merely that it threw. */
async function statusOf(event: RequestEvent): Promise<number | undefined> {
	try {
		await requireDevice(event, db);
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

describe('requireDevice', () => {
	it('answers 403 when there is no device cookie', async () => {
		const event = makeEvent();
		expect(await statusOf(event)).toBe(403);
		expect(event.locals.posDevice).toBeNull();
	});

	it('answers 403 for a token that was never registered', async () => {
		expect(await statusOf(makeEvent({ [DEVICE_COOKIE]: generateDeviceToken() }))).toBe(403);
	});

	// Revocation is enforced on the READ path, not only at registration.
	it('answers 403 for a revoked device', async () => {
		const { restaurantId, ownerId } = await makeOwner('owner@cafe.com');
		const { deviceId, token } = await register(restaurantId, ownerId);
		await db.transaction((tx) =>
			revokeDevice(tx, { deviceId, restaurantId, actorUserId: ownerId })
		);

		expect(await statusOf(makeEvent({ [DEVICE_COOKIE]: token }))).toBe(403);
	});

	it('resolves a registered device and leaves it on locals.posDevice', async () => {
		const { restaurantId, ownerId } = await makeOwner('owner@cafe.com');
		const { deviceId, deviceCode, token } = await register(restaurantId, ownerId);
		const event = makeEvent({ [DEVICE_COOKIE]: token });

		const context = await requireDevice(event, db);

		expect(context).toEqual({ restaurantId, deviceId, deviceCode });
		expect(event.locals.posDevice).toEqual(context);
	});

	// THE REGRESSION THIS FILE EXISTS TO PREVENT: a valid dashboard session and a
	// dashboard tenant on the request are NOT a device, and must not be read as one.
	it('answers 403 to a signed-in owner whose browser holds no device cookie', async () => {
		const { restaurantId, ownerId } = await makeOwner('owner@cafe.com');
		const { token } = await createSession(db, ownerId);
		const principal = await validateSessionToken(db, token);
		expect(principal).not.toBeNull();

		const event = makeEvent({}, { user: principal, restaurantId, sessionToken: token });

		expect(await statusOf(event)).toBe(403);
	});

	it("takes the tenant from the device row, never from the request's dashboard tenant", async () => {
		const a = await makeOwner('a@cafe.com');
		const b = await makeOwner('b@cafe.com');
		const { token } = await register(a.restaurantId, a.ownerId);

		const context = await requireDevice(
			makeEvent({ [DEVICE_COOKIE]: token }, { restaurantId: b.restaurantId }),
			db
		);

		expect(context.restaurantId).toBe(a.restaurantId);
	});
});
