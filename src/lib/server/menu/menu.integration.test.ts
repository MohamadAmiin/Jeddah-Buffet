import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { menuItems } from '../db/schema/menu';
import { onRestaurantCreated } from '../restaurants';
import {
	archiveCategory,
	archiveItem,
	createCategory,
	createItem,
	createModifier,
	createModifierGroup,
	getMenuVersion,
	hasMenuItems,
	linkModifierGroup,
	listMenu,
	setItemAvailability,
	unlinkModifierGroup,
	updateItem,
	updateModifier
} from './index';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name = 'Cafe One') {
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
	return {
		restaurantId: restaurant.id,
		ctx: { actorUserId: owner.id, ip: null, userAgent: null },
		ownerId: owner.id
	};
}

/** A restaurant with one category and one 850n item, and the version that leaves. */
async function withItem() {
	const r = await makeRestaurant();
	const category = await db.transaction((tx) =>
		createCategory(tx, r.restaurantId, { name: 'Drinks' })
	);
	const item = await db.transaction((tx) =>
		createItem(tx, r.restaurantId, {
			categoryId: category.id,
			name: 'Tea',
			priceMinor: 850n
		})
	);
	if (!item.ok) throw new Error('fixture item was not created');
	return { ...r, categoryId: category.id, itemId: item.id };
}

const version = (restaurantId: string) => getMenuVersion(db, restaurantId);
const priceChanges = () =>
	db.select().from(auditLog).where(eq(auditLog.event, 'menu.price_changed'));

describe('the menu version bump', () => {
	it('bumps EXACTLY once per write, in order', async () => {
		const r = await makeRestaurant();
		expect(await version(r.restaurantId)).toBe(1);

		const category = await db.transaction((tx) =>
			createCategory(tx, r.restaurantId, { name: 'Drinks' })
		);
		expect(await version(r.restaurantId)).toBe(2);

		const item = await db.transaction((tx) =>
			createItem(tx, r.restaurantId, { categoryId: category.id, name: 'Tea', priceMinor: 850n })
		);
		if (!item.ok) throw new Error('item not created');
		expect(await version(r.restaurantId)).toBe(3);

		await db.transaction((tx) =>
			updateItem(tx, r.restaurantId, item.id, { priceMinor: 900n }, r.ctx)
		);
		expect(await version(r.restaurantId)).toBe(4);

		const group = await db.transaction((tx) =>
			createModifierGroup(tx, r.restaurantId, { name: 'Milk' })
		);
		if (!group.ok) throw new Error('group not created');
		expect(await version(r.restaurantId)).toBe(5);

		// Linked against a LIVE item, and archived last.
		await db.transaction((tx) => linkModifierGroup(tx, r.restaurantId, item.id, group.id));
		expect(await version(r.restaurantId)).toBe(6);

		await db.transaction((tx) => archiveItem(tx, r.restaurantId, item.id));
		expect(await version(r.restaurantId)).toBe(7);
	});

	it('does not bump, and writes no audit row, for a no-op update', async () => {
		const r = await withItem();
		const before = await version(r.restaurantId);

		const result = await db.transaction((tx) =>
			updateItem(tx, r.restaurantId, r.itemId, { name: 'Tea', priceMinor: 850n }, r.ctx)
		);

		expect(result).toEqual({ ok: true, changed: false });
		expect(await version(r.restaurantId)).toBe(before);
		expect(await priceChanges()).toHaveLength(0);
	});

	it('does not bump for an availability that is already set, or an unlink of nothing', async () => {
		const r = await withItem();
		const group = await db.transaction((tx) =>
			createModifierGroup(tx, r.restaurantId, { name: 'Milk' })
		);
		if (!group.ok) throw new Error('group not created');
		const before = await version(r.restaurantId);

		expect(
			await db.transaction((tx) => setItemAvailability(tx, r.restaurantId, r.itemId, true))
		).toEqual({ ok: true, changed: false });
		expect(
			await db.transaction((tx) => unlinkModifierGroup(tx, r.restaurantId, r.itemId, group.id))
		).toEqual({ ok: true, changed: false });
		expect(await version(r.restaurantId)).toBe(before);
	});
});

describe('price changes are audited (spec 3)', () => {
	it('writes ONE menu.price_changed row for an item, 850 -> 900, as strings', async () => {
		const r = await withItem();

		await db.transaction((tx) =>
			updateItem(tx, r.restaurantId, r.itemId, { priceMinor: 900n }, r.ctx)
		);

		const rows = await priceChanges();
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			target: 'item',
			targetId: r.itemId,
			name: 'Tea',
			oldPriceMinor: '850',
			newPriceMinor: '900'
		});
		expect(rows[0].restaurantId).toBe(r.restaurantId);
		expect(rows[0].actorUserId).toBe(r.ownerId);
	});

	it("writes the same event for a modifier, with target 'modifier' and the MODIFIER's id", async () => {
		const r = await makeRestaurant();
		const group = await db.transaction((tx) =>
			createModifierGroup(tx, r.restaurantId, { name: 'Cheese' })
		);
		if (!group.ok) throw new Error('group not created');
		const modifier = await db.transaction((tx) =>
			createModifier(tx, r.restaurantId, {
				groupId: group.id,
				name: 'Extra cheese',
				priceDeltaMinor: 50n
			})
		);
		if (!modifier.ok) throw new Error('modifier not created');

		await db.transaction((tx) =>
			updateModifier(tx, r.restaurantId, modifier.id, { priceDeltaMinor: -50n }, r.ctx)
		);

		const rows = await priceChanges();
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			target: 'modifier',
			targetId: modifier.id,
			name: 'Extra cheese',
			oldPriceMinor: '50',
			newPriceMinor: '-50'
		});
	});

	// Invariant 10: the change, its audit row and the bump are one transaction.
	it('rolls back the price, the audit row and the version together', async () => {
		const r = await withItem();
		const before = await version(r.restaurantId);

		await expect(
			db.transaction(async (tx) => {
				await updateItem(tx, r.restaurantId, r.itemId, { priceMinor: 900n }, r.ctx);
				throw new Error('the surrounding action failed');
			})
		).rejects.toThrow('the surrounding action failed');

		expect(await priceChanges()).toHaveLength(0);
		const [row] = await db.select().from(menuItems).where(eq(menuItems.id, r.itemId));
		expect(row.priceMinor).toBe(850n);
		expect(await version(r.restaurantId)).toBe(before);
	});

	it('refuses a price that is a number, not a bigint', async () => {
		const r = await withItem();
		await expect(
			db.transaction((tx) =>
				updateItem(tx, r.restaurantId, r.itemId, { priceMinor: 900 as unknown as bigint }, r.ctx)
			)
		).rejects.toThrow(TypeError);
	});
});

describe('archive, never delete (invariant 2)', () => {
	it('archives an item: the row stays, listMenu stops returning it', async () => {
		const r = await withItem();

		await db.transaction((tx) => archiveItem(tx, r.restaurantId, r.itemId));

		const [row] = await db.select().from(menuItems).where(eq(menuItems.id, r.itemId));
		expect(row.archivedAt).toBeInstanceOf(Date);
		const menu = await listMenu(db, r.restaurantId);
		expect(menu.items.map((i) => i.id)).not.toContain(r.itemId);
	});

	it('has no code path that deletes a menu item', () => {
		const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
		expect(source).not.toContain('.delete(menuItems)');
		expect(source).not.toContain('.delete(menuCategories)');
		expect(source).not.toContain('.delete(modifiers)');
		expect(source).not.toContain('.delete(modifierGroups)');
	});

	it('refuses to archive a category that still holds a live item', async () => {
		const r = await withItem();
		expect(await db.transaction((tx) => archiveCategory(tx, r.restaurantId, r.categoryId))).toEqual(
			{ ok: false, reason: 'not_empty' }
		);
	});
});

describe('tenant scoping', () => {
	it("changes nothing when restaurant B's id is paired with restaurant A's item", async () => {
		const a = await withItem();
		const b = await makeRestaurant('Cafe Two');
		const aBefore = await version(a.restaurantId);
		const bBefore = await version(b.restaurantId);

		expect(
			await db.transaction((tx) =>
				updateItem(tx, b.restaurantId, a.itemId, { priceMinor: 1n }, b.ctx)
			)
		).toEqual({ ok: false, reason: 'not_found' });
		expect(await db.transaction((tx) => archiveItem(tx, b.restaurantId, a.itemId))).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(
			await db.transaction((tx) =>
				createItem(tx, b.restaurantId, { categoryId: a.categoryId, name: 'X', priceMinor: 1n })
			)
		).toEqual({ ok: false, reason: 'not_found' });

		const [row] = await db.select().from(menuItems).where(eq(menuItems.id, a.itemId));
		expect(row.priceMinor).toBe(850n);
		expect(row.archivedAt).toBeNull();
		expect(await version(a.restaurantId)).toBe(aBefore);
		expect(await version(b.restaurantId)).toBe(bBefore);
		expect(await priceChanges()).toHaveLength(0);
	});
});

describe('hasMenuItems (T-43)', () => {
	it('is true only while the restaurant has a LIVE item — archiving the last one makes it false', async () => {
		const r = await makeRestaurant();
		expect(await hasMenuItems(db, r.restaurantId)).toBe(false);

		const category = await db.transaction((tx) =>
			createCategory(tx, r.restaurantId, { name: 'Drinks' })
		);
		const item = await db.transaction((tx) =>
			createItem(tx, r.restaurantId, { categoryId: category.id, name: 'Tea', priceMinor: 850n })
		);
		if (!item.ok) throw new Error('item not created');
		expect(await hasMenuItems(db, r.restaurantId)).toBe(true);

		await db.transaction((tx) => archiveItem(tx, r.restaurantId, item.id));
		expect(await hasMenuItems(db, r.restaurantId)).toBe(false);
	});

	it("does not count another restaurant's item", async () => {
		const a = await withItem();
		const b = await makeRestaurant('Cafe Two');

		expect(await hasMenuItems(db, a.restaurantId)).toBe(true);
		expect(await hasMenuItems(db, b.restaurantId)).toBe(false);
	});
});
