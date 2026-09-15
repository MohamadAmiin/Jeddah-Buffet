import { describe, it, expect, afterAll } from 'vitest';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import {
	DEVICE_COOKIE,
	generateDeviceToken,
	registerDevice,
	revokeDevice
} from '$lib/server/auth/pos-device';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import {
	archiveItem,
	createCategory,
	createItem,
	createModifier,
	createModifierGroup,
	linkModifierGroup,
	setItemAvailability
} from '$lib/server/menu';
import { GET } from './+server';
import { GET as versionGet } from './version/+server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

type Snapshot = {
	version: number;
	restaurantId: string;
	takenAt: string;
	currency: string | null;
	currencyExponent: number | null;
	taxMode: string | null;
	taxRateBp: number | null;
	categories: Array<{ id: string; name: string; sortOrder: number }>;
	items: Array<{
		id: string;
		categoryId: string;
		name: string;
		priceMinor: string;
		taxRateBp: number | null;
		isAvailable: boolean;
		sortOrder: number;
		modifierGroupIds: string[];
	}>;
	modifierGroups: Array<{
		id: string;
		name: string;
		minSelect: number;
		maxSelect: number;
		modifiers: Array<{ id: string; name: string; priceDeltaMinor: string }>;
	}>;
};

/** A restaurant with settings, an owner, a registered till and a "Drinks" category. */
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
	const category = await db.transaction((tx) =>
		createCategory(tx, restaurant.id, { name: 'Drinks' })
	);
	return {
		restaurantId: restaurant.id,
		ownerId: owner.id,
		categoryId: category.id,
		ctx: { actorUserId: owner.id, ip: null, userAgent: null },
		...device
	};
}

async function addItem(
	r: { restaurantId: string; categoryId: string },
	name: string,
	priceMinor: bigint,
	taxRateBp: number | null = null
) {
	const item = await db.transaction((tx) =>
		createItem(tx, r.restaurantId, { categoryId: r.categoryId, name, priceMinor, taxRateBp })
	);
	if (!item.ok) throw new Error('item not created');
	return item.id;
}

function makeEvent(
	url: string,
	cookies: Record<string, string>,
	headers: Record<string, string> = {}
) {
	const jar = new Map(Object.entries(cookies));
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
		request: new Request(new URL(url, 'http://localhost'), { headers }),
		route: { id: new URL(url, 'http://localhost').pathname },
		setHeaders: () => {},
		url: new URL(url, 'http://localhost')
	} as unknown as Parameters<typeof GET>[0];
}

async function call(
	handler: typeof GET,
	url: string,
	cookies: Record<string, string>,
	headers: Record<string, string> = {}
) {
	try {
		const response = await handler(makeEvent(url, cookies, headers));
		return { status: response.status, headers: response.headers, text: await response.text() };
	} catch (thrown) {
		return { status: (thrown as { status?: number }).status, headers: null, text: '' };
	}
}

const snapshotFor = async (token: string) => {
	const result = await call(GET, '/api/menu', { [DEVICE_COOKIE]: token });
	expect(result.status).toBe(200);
	return JSON.parse(result.text) as Snapshot;
};

describe('GET /api/menu', () => {
	// MANDATORY (spec 29 — a permission check on every POS API route). A 403 that
	// still leaked the menu would be worse than none.
	it('answers 403, with no item names, to no cookie, an unknown device and a revoked one', async () => {
		const a = await makeRestaurant('Cafe One');
		await addItem(a, 'Secret Tea', 850n);
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
			const result = await call(GET, '/api/menu', cookies);
			expect(result.status).toBe(403);
			expect(result.text).not.toContain('Secret Tea');
		}
	});

	// MANDATORY (spec 29 — money arithmetic): money crosses JSON as a decimal STRING.
	it('serialises every *Minor value as a string that BigInt() reads back exactly', async () => {
		const a = await makeRestaurant('Cafe One');
		await addItem(a, 'Tea', 850n);
		await addItem(a, 'Banquet', 9007199254740993n);

		const payload = await snapshotFor(a.token);
		const byName = new Map(payload.items.map((item) => [item.name, item]));

		expect(byName.get('Tea')!.priceMinor).toBe('850');
		expect(BigInt(byName.get('Tea')!.priceMinor)).toBe(850n);
		expect(BigInt(byName.get('Banquet')!.priceMinor)).toBe(9007199254740993n);
		// Why the string exists: through a JavaScript number the same digits come back
		// as a different amount — 9007199254740992, one minor unit lost.
		expect(BigInt(Number('9007199254740993'))).not.toBe(9007199254740993n);
	});

	it('serialises a negative modifier delta as "-50", and links groups onto their items', async () => {
		const a = await makeRestaurant('Cafe One');
		const itemId = await addItem(a, 'Burger', 850n);
		const group = await db.transaction((tx) =>
			createModifierGroup(tx, a.restaurantId, { name: 'Cheese', minSelect: 0, maxSelect: 1 })
		);
		if (!group.ok) throw new Error('group not created');
		await db.transaction((tx) =>
			createModifier(tx, a.restaurantId, {
				groupId: group.id,
				name: 'No cheese',
				priceDeltaMinor: -50n
			})
		);
		await db.transaction((tx) => linkModifierGroup(tx, a.restaurantId, itemId, group.id));

		const payload = await snapshotFor(a.token);

		const modifier = payload.modifierGroups[0].modifiers[0];
		expect(modifier.priceDeltaMinor).toBe('-50');
		expect(BigInt(modifier.priceDeltaMinor)).toBe(-50n);
		expect(payload.items[0].modifierGroupIds).toEqual([group.id]);
	});

	it('carries the same version GET /api/menu/version reports, and both move together', async () => {
		const a = await makeRestaurant('Cafe One');
		const version = async () =>
			JSON.parse((await call(versionGet, '/api/menu/version', { [DEVICE_COOKIE]: a.token })).text)
				.version as number;

		expect((await snapshotFor(a.token)).version).toBe(await version());
		await addItem(a, 'Tea', 850n);
		const after = await snapshotFor(a.token);
		expect(after.version).toBe(await version());
		expect(after.version).toBe(3); // 1, +1 for the category, +1 for the item
	});

	it('ships the restaurant rate beside each item rate, never pre-resolving an inherited null', async () => {
		const a = await makeRestaurant('Cafe One');
		await addItem(a, 'Inherits', 850n, null);
		await addItem(a, 'Own rate', 850n, 500);

		const unset = await snapshotFor(a.token);
		expect(unset.taxRateBp).toBeNull();
		expect(unset.taxMode).toBeNull();
		expect(unset.currency).toBeNull();
		expect(unset.currencyExponent).toBeNull();

		await db.transaction((tx) =>
			updateSettings(
				tx,
				a.restaurantId,
				{ taxMode: 'exclusive', taxRateBp: 825, currencyCode: 'USD' },
				a.ctx
			)
		);
		const set = await snapshotFor(a.token);
		const byName = new Map(set.items.map((item) => [item.name, item]));
		expect(set.taxRateBp).toBe(825);
		expect(set.taxMode).toBe('exclusive');
		expect([set.currency, set.currencyExponent]).toEqual(['USD', 2]);
		expect(byName.get('Inherits')!.taxRateBp).toBeNull();
		expect(byName.get('Own rate')!.taxRateBp).toBe(500);
	});

	it('leaves an archived item out and keeps a sold-out one, flagged', async () => {
		const a = await makeRestaurant('Cafe One');
		const gone = await addItem(a, 'Gone', 850n);
		const soldOut = await addItem(a, 'Sold out', 850n);
		await db.transaction((tx) => archiveItem(tx, a.restaurantId, gone));
		await db.transaction((tx) => setItemAvailability(tx, a.restaurantId, soldOut, false));

		const payload = await snapshotFor(a.token);

		expect(payload.items.map((item) => item.name)).toEqual(['Sold out']);
		expect(payload.items[0].isAvailable).toBe(false);
	});

	it("sends each device only its own restaurant's rows, and its own restaurant id", async () => {
		const a = await makeRestaurant('Cafe One');
		const b = await makeRestaurant('Cafe Two');
		await addItem(a, 'Tea of A', 850n);
		await addItem(b, 'Tea of B', 900n);

		const ofA = await snapshotFor(a.token);
		const ofB = await snapshotFor(b.token);

		expect(ofA.items.map((item) => item.name)).toEqual(['Tea of A']);
		expect(ofB.items.map((item) => item.name)).toEqual(['Tea of B']);
		expect([ofA.restaurantId, ofB.restaurantId]).toEqual([a.restaurantId, b.restaurantId]);
	});

	it("answers its own ETag with 304, and restaurant A's ETag for B's device with 200", async () => {
		const a = await makeRestaurant('Cafe One');
		const b = await makeRestaurant('Cafe Two');
		const first = await call(GET, '/api/menu', { [DEVICE_COOKIE]: a.token });
		const etag = first.headers!.get('etag')!;

		const again = await call(
			GET,
			'/api/menu',
			{ [DEVICE_COOKIE]: a.token },
			{ 'if-none-match': etag }
		);
		expect(again.status).toBe(304);
		expect(again.text).toBe('');

		// A and B both sit at version 2 (one category each): the same number, not the same menu.
		const crossed = await call(
			GET,
			'/api/menu',
			{ [DEVICE_COOKIE]: b.token },
			{ 'if-none-match': etag }
		);
		expect(crossed.status).toBe(200);
		expect((JSON.parse(crossed.text) as Snapshot).restaurantId).toBe(b.restaurantId);
	});
});
