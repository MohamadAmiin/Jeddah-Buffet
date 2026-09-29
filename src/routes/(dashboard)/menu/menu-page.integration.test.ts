import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { menuCategories, menuImages, menuItems } from '$lib/server/db/schema/menu';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { createCategory, listMenu } from '$lib/server/menu';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const CURRENCY_MESSAGE = 'Set the currency in Settings before adding prices.';

async function makeRestaurant({ currency }: { currency: boolean }) {
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
	if (currency) {
		await db.transaction((tx) =>
			updateSettings(
				tx,
				restaurant.id,
				{ currencyCode: 'USD' },
				{ actorUserId: owner.id, ip: null, userAgent: null }
			)
		);
	}
	const category = await db.transaction((tx) =>
		createCategory(tx, restaurant.id, { name: 'Drinks' })
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, categoryId: category.id };
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

// A form value may be a File: the photo actions read multipart bodies.
function makeEvent(user: Principal, form?: Record<string, string | File>): RequestEvent {
	const url = new URL('http://localhost/menu');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/menu' },
		url
	} as unknown as RequestEvent;
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

type ActionName = keyof typeof actions;
function act(name: ActionName, event: RequestEvent) {
	return actions[name]!(event as Parameters<NonNullable<(typeof actions)[ActionName]>>[0]);
}

describe('the /menu page', () => {
	// MANDATORY (spec 29 — permission checks; this repository applies the rule to
	// every route): 403 from the load and from EVERY action, each a separately
	// reachable endpoint.
	it('refuses a cashier with 403 on the load and on every action', async () => {
		const r = await makeRestaurant({ currency: true });
		const cashier = await seedStaff(db, r.restaurantId, {
			displayName: 'Staff'
		});
		const asCashier = principal(cashier.id, r.restaurantId, 'staff');

		expect(await statusOf(() => load(makeEvent(asCashier) as never))).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			expect(
				await statusOf(() =>
					act(name, makeEvent(asCashier, { categoryId: r.categoryId, name: 'Tea', price: '1' }))
				),
				name
			).toBe(403);
		}
		expect(await db.select().from(menuItems)).toHaveLength(0);
	});

	it('stores a price of 8.50 as exactly 850n', async () => {
		const r = await makeRestaurant({ currency: true });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const result = await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '8.50', taxRateBp: '' })
		);

		// The result also carries itemId (T-11), for the panel's follow-up photo upload.
		expect(result).toMatchObject({ message: 'Tea added.' });
		expect(typeof (result as { itemId?: unknown }).itemId).toBe('string');
		const [row] = await db.select().from(menuItems).where(eq(menuItems.name, 'Tea'));
		expect(row.priceMinor).toBe(850n);
		expect(row.taxRateBp).toBeNull();
	});

	it('refuses a price with more decimals than the currency has, and stores nothing', async () => {
		const r = await makeRestaurant({ currency: true });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const result = await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '8.505' })
		);

		expect((result as { status?: number }).status).toBe(400);
		expect(await db.select().from(menuItems)).toHaveLength(0);
	});

	it('gates every price on the currency: no currency, no exponent, no write', async () => {
		const r = await makeRestaurant({ currency: false });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const data = (await load(makeEvent(asOwner) as never)) as { currency: unknown };
		expect(data.currency).toBeNull();

		const result = await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '8.50' })
		);
		expect(result).toMatchObject({ status: 400, data: { message: CURRENCY_MESSAGE } });
		expect(await db.select().from(menuItems)).toHaveLength(0);
	});

	it('sends the page formatted strings, never a bigint', async () => {
		const r = await makeRestaurant({ currency: true });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '1234.5' })
		);

		const data = await load(makeEvent(asOwner) as never);

		// JSON.stringify throws on a bigint, so this line is the assertion.
		const serialised = JSON.stringify(data);
		expect(serialised).toContain('"price":"1,234.50"');
		expect(serialised).toContain('"taxRate":"restaurant rate"');
	});
});

describe('the /menu page — optional categories, availability, photos (menu-and-printing T-11)', () => {
	// A 1×1 PNG, 68 bytes.
	const PNG_BASE64 =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
	const pngFile = (name = 'photo.png') =>
		new File([Buffer.from(PNG_BASE64, 'base64')], name, { type: 'image/png' });

	async function owner() {
		const r = await makeRestaurant({ currency: true });
		return { ...r, asOwner: principal(r.ownerId, r.restaurantId, 'owner') };
	}

	async function addItem(
		r: { restaurantId: string; asOwner: Principal },
		name: string,
		categoryId = ''
	): Promise<string> {
		const result = (await act(
			'createItem',
			makeEvent(r.asOwner, { categoryId, name, price: '2.00' })
		)) as { message: string; itemId?: string };
		expect(result.message).toBe(`${name} added.`);
		if (!result.itemId) throw new Error('createItem returned no itemId');
		return result.itemId;
	}

	const itemRow = async (itemId: string) => {
		const [row] = await db.select().from(menuItems).where(eq(menuItems.id, itemId));
		return row;
	};
	const photoRows = (restaurantId: string) =>
		db.select().from(menuImages).where(eq(menuImages.restaurantId, restaurantId));

	it('adds an item with no category and returns its id', async () => {
		const r = await owner();
		const itemId = await addItem(r, 'Water');
		const menu = await listMenu(db, r.restaurantId);
		expect(menu.items.find((i) => i.id === itemId)?.categoryId).toBeNull();
		const data = (await load(makeEvent(r.asOwner) as never)) as {
			uncategorisedCount: number;
			categories: { itemCount: number }[];
			items: { imageUrl: string | null }[];
		};
		expect(data.uncategorisedCount).toBe(1);
		expect(data.categories[0].itemCount).toBe(0);
		expect(data.items[0].imageUrl).toBeNull();
	});

	it('moves an item to no category and back', async () => {
		const r = await owner();
		const itemId = await addItem(r, 'Tea', r.categoryId);
		expect((await itemRow(itemId)).categoryId).toBe(r.categoryId);

		expect(
			await act(
				'updateItem',
				makeEvent(r.asOwner, { itemId, name: 'Tea', price: '', categoryId: '' })
			)
		).toEqual({ message: 'Tea saved.' });
		expect((await itemRow(itemId)).categoryId).toBeNull();

		expect(
			await act(
				'updateItem',
				makeEvent(r.asOwner, { itemId, name: 'Tea', price: '', categoryId: r.categoryId })
			)
		).toEqual({ message: 'Tea saved.' });
		expect((await itemRow(itemId)).categoryId).toBe(r.categoryId);
	});

	it('renames a category, and refuses a duplicate name', async () => {
		const r = await owner();
		await db.transaction((tx) => createCategory(tx, r.restaurantId, { name: 'Food' }));

		expect(
			await act('renameCategory', makeEvent(r.asOwner, { categoryId: r.categoryId, name: 'Juice' }))
		).toEqual({ message: 'Renamed.' });
		const [row] = await db.select().from(menuCategories).where(eq(menuCategories.id, r.categoryId));
		expect(row.name).toBe('Juice');

		const dup = await act(
			'renameCategory',
			makeEvent(r.asOwner, { categoryId: r.categoryId, name: 'food' })
		);
		expect(dup).toMatchObject({
			status: 400,
			data: { message: 'A category with that name already exists.' }
		});
	});

	it('archives a category and reports how many items moved', async () => {
		const r = await owner();
		await addItem(r, 'Tea', r.categoryId);
		await addItem(r, 'Coffee', r.categoryId);

		expect(
			await act('archiveCategory', makeEvent(r.asOwner, { categoryId: r.categoryId }))
		).toEqual({ message: 'Archived. 2 item(s) moved to No category.' });
		const rows = await db
			.select()
			.from(menuItems)
			.where(eq(menuItems.restaurantId, r.restaurantId));
		expect(rows.map((row) => row.categoryId)).toEqual([null, null]);
	});

	it('marks an item sold out and available again', async () => {
		const r = await owner();
		const itemId = await addItem(r, 'Tea', r.categoryId);

		expect(await act('setAvailability', makeEvent(r.asOwner, { itemId, available: 'no' }))).toEqual(
			{
				message: 'Marked sold out.'
			}
		);
		expect((await itemRow(itemId)).isAvailable).toBe(false);
		expect(await act('setAvailability', makeEvent(r.asOwner, { itemId, available: 'no' }))).toEqual(
			{
				message: 'No change to save.'
			}
		);
		expect(
			await act('setAvailability', makeEvent(r.asOwner, { itemId, available: 'yes' }))
		).toEqual({ message: 'Marked available.' });
		expect((await itemRow(itemId)).isAvailable).toBe(true);
	});

	it('stores a photo, and refuses SVG bytes, an oversize file and an empty file', async () => {
		const r = await owner();
		const itemId = await addItem(r, 'Burger');

		const saved = (await act('setImage', makeEvent(r.asOwner, { itemId, image: pngFile() }))) as {
			message: string;
			imageId?: string;
		};
		expect(saved.message).toBe('Photo saved.');
		expect(await photoRows(r.restaurantId)).toHaveLength(1);
		expect((await itemRow(itemId)).imageId).toBe(saved.imageId);
		const data = (await load(makeEvent(r.asOwner) as never)) as { items: { imageUrl: string }[] };
		expect(data.items[0].imageUrl).toBe(`/menu/images/${saved.imageId}`);

		// An SVG that the browser labelled image/png: refused by its bytes.
		const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'x.png', {
			type: 'image/png'
		});
		expect(await act('setImage', makeEvent(r.asOwner, { itemId, image: svg }))).toMatchObject({
			status: 400,
			data: { message: 'Use a JPEG, PNG or WebP photo.' }
		});
		const oversize = new File([new Uint8Array(409_601)], 'big.jpg', { type: 'image/jpeg' });
		expect(await act('setImage', makeEvent(r.asOwner, { itemId, image: oversize }))).toMatchObject({
			status: 400
		});
		const empty = new File([], 'empty.png', { type: 'image/png' });
		expect(await act('setImage', makeEvent(r.asOwner, { itemId, image: empty }))).toMatchObject({
			status: 400,
			data: { message: 'Choose a photo.' }
		});
		// Still exactly the one good photo.
		expect(await photoRows(r.restaurantId)).toHaveLength(1);
	});

	it('removes a photo', async () => {
		const r = await owner();
		const itemId = await addItem(r, 'Burger');
		await act('setImage', makeEvent(r.asOwner, { itemId, image: pngFile() }));

		expect(await act('removeImage', makeEvent(r.asOwner, { itemId }))).toEqual({
			message: 'Photo removed.'
		});
		expect(await photoRows(r.restaurantId)).toHaveLength(0);
		expect((await itemRow(itemId)).imageId).toBeNull();
		expect(await act('removeImage', makeEvent(r.asOwner, { itemId }))).toEqual({
			message: 'There was no photo.'
		});
	});

	it('refuses a 121-character item name, and stores nothing', async () => {
		const r = await owner();
		const result = await act(
			'createItem',
			makeEvent(r.asOwner, { categoryId: '', name: 'x'.repeat(121), price: '2.00' })
		);
		expect(result).toMatchObject({
			status: 400,
			data: { message: 'Keep the name under 120 characters.' }
		});
		expect(await db.select().from(menuItems)).toHaveLength(0);
	});
});
