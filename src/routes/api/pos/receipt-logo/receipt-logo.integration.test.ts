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
import { onRestaurantCreated, setReceiptLogo } from '$lib/server/restaurants';
import { GET } from './+server';
import { GET as employeesGet } from '../employees/+server';

// GET /api/pos/receipt-logo (tasks/settings-tax-payments-receipt T-20): the logo's
// bytes for the till — served to a registered, unrevoked device only (invariant
// 8), for the DEVICE ROW's restaurant only (invariant 12), as padded base64 the
// print agent accepts, and never kept by any HTTP cache (the till keeps it in
// IndexedDB, T-21).

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/**
 * A restaurant WITH its settings row, its owner and a registered till — the
 * employees fixture minus the cashier, whom this route never lists.
 */
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

	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId: restaurant.id, actorUserId: owner.id, label: 'Till' })
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, ...device };
}

type R = Awaited<ReturnType<typeof makeRestaurant>>;

function makeEvent(
	cookies: Record<string, string>,
	routeId = '/api/pos/receipt-logo'
): RequestEvent {
	const jar = new Map(Object.entries(cookies));
	const url = new URL(`http://localhost${routeId}`);
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
		route: { id: routeId },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

type LogoBody = { sha256: string; widthDots: number; heightDots: number; bitmap: string };

/** GET, returning the status, the SERIALISED body parsed back, and the headers — or the thrown status. */
async function get(cookies: Record<string, string>) {
	try {
		const response = await GET(makeEvent(cookies));
		return {
			status: response.status,
			body: JSON.parse(await response.text()) as LogoBody & { error?: string },
			headers: response.headers
		};
	} catch (thrown) {
		const status = (thrown as { status?: number }).status;
		if (status === undefined) throw thrown;
		return { status, body: null, headers: null };
	}
}

/** A 16 × 2 logo: 16 / 8 × 2 = 4 bytes. */
const FOUR_BYTES = new Uint8Array([0xff, 0x00, 0x81, 0x7e]);
/** sha256 of "16x2\n" followed by FOUR_BYTES — T-12 hashes the shape as well as the bitmap. */
const FOUR_BYTES_SHA = '76413a20db4a92b11606749459eace5b95cebd3ae13279d689866290cb1bfa2d';

const setLogo = (r: R, bitmap: Uint8Array) =>
	db.transaction((tx) =>
		setReceiptLogo(
			tx,
			r.restaurantId,
			{ widthDots: 16, heightDots: 2, bitmap },
			{ actorUserId: r.ownerId, ip: null, userAgent: null }
		)
	);

describe('GET /api/pos/receipt-logo', () => {
	// MANDATORY (spec 29 — a permission check test on every POS API route). A read,
	// and still guarded (invariant 8): a logo IS stored here, and none of it leaves.
	it('answers exactly 403 — and reads nothing — without a live registered device', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await setLogo(a, FOUR_BYTES);

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

	it('answers 404 no_logo when the restaurant has none', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const result = await get({ [DEVICE_COOKIE]: a.token });
		expect(result.status).toBe(404);
		// A parsed body, not error(404): the till tells "no logo" (clear its cache)
		// from a failure (keep it).
		expect(result.body).toEqual({ error: 'no_logo' });
		expect(result.headers!.get('cache-control')).toBe('no-store');
	});

	it('serves the logo as base64 with its fingerprint', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const set = await setLogo(a, FOUR_BYTES);
		if (!set.ok) throw new Error(set.reason);

		const result = await get({ [DEVICE_COOKIE]: a.token });
		expect(result.status).toBe(200);
		const body = result.body!;
		expect(Object.keys(body).sort()).toEqual(['bitmap', 'heightDots', 'sha256', 'widthDots']);
		// Standard base64 WITH padding — exactly what the print agent's parseJob
		// accepts (T-25) — decoding to the stored bytes, 16 / 8 × 2 of them.
		expect(body.bitmap).toBe('/wCBfg==');
		expect([...Buffer.from(body.bitmap, 'base64')]).toEqual([0xff, 0x00, 0x81, 0x7e]);
		expect(Buffer.from(body.bitmap, 'base64').length).toBe(4);
		expect(body.widthDots).toBe(16);
		expect(body.heightDots).toBe(2);
		expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(body.sha256).toBe(set.sha256);
		expect(body.sha256).toBe(FOUR_BYTES_SHA);
		expect(result.headers!.get('cache-control')).toBe('no-store');

		// The same fingerprint the settings bundle carries for this device, so the
		// till can tell from the bundle alone whether its cached bytes are current.
		const bundle = await employeesGet(
			makeEvent({ [DEVICE_COOKIE]: a.token }, '/api/pos/employees')
		);
		expect(bundle.status).toBe(200);
		const { settings } = JSON.parse(await bundle.text()) as {
			settings: { receipt: { logo: { sha256: string } | null } };
		};
		expect(settings.receipt.logo?.sha256).toBe(body.sha256);
	});

	it("never serves another restaurant's logo", async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const b = await makeRestaurant('Cafe B', 'b@cafe.com');
		await setLogo(a, FOUR_BYTES);

		// B has no logo of its own: A's is not an answer.
		const bBefore = await get({ [DEVICE_COOKIE]: b.token });
		expect(bBefore.status).toBe(404);
		expect(bBefore.body).toEqual({ error: 'no_logo' });

		const setB = await setLogo(b, new Uint8Array([0x00, 0x00, 0x00, 0x01]));
		if (!setB.ok) throw new Error(setB.reason);
		const bAfter = await get({ [DEVICE_COOKIE]: b.token });
		expect(bAfter.status).toBe(200);
		expect(bAfter.body!.sha256).toBe(setB.sha256);
		expect(bAfter.body!.sha256).not.toBe(FOUR_BYTES_SHA);
		expect(bAfter.body!.bitmap).toBe('AAAAAQ==');

		// And A still gets its own.
		const aAfter = await get({ [DEVICE_COOKIE]: a.token });
		expect(aAfter.status).toBe(200);
		expect(aAfter.body!.sha256).toBe(FOUR_BYTES_SHA);
	});
});
