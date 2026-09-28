import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { ingredients, recipeLines } from '../db/schema/inventory';
import { onRestaurantCreated } from '../restaurants';
import { archiveItem, createCategory, createItem } from '../menu';
import { minor } from '../../money';
import { qty } from '../../money/quantity';
import { applyMovements } from './movements';
import {
	addPurchaseUnit,
	archiveIngredient,
	archivePurchaseUnit,
	createIngredient,
	getIngredient,
	listIngredients,
	updateIngredient,
	type InventoryWriteContext
} from './ingredients';

// Ingredients and purchase units (tasks/inventory-cogs T-17).

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name: string): Promise<InventoryWriteContext> {
	const [r] = await testDb().insert(restaurants).values({ name }).returning({ id: restaurants.id });
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, r.id, { restaurantName: name, timeZone: 'Africa/Mogadishu' })
	);
	const [owner] = await testDb()
		.insert(users)
		.values({
			restaurantId: r.id,
			role: 'owner',
			displayName: 'Owner',
			email: `${randomUUID()}@example.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });
	return { restaurantId: r.id, actorUserId: owner.id, ip: '127.0.0.1', userAgent: 'vitest' };
}

async function auditRows(restaurantId: string, event: string) {
	return testDb()
		.select({ details: auditLog.details, actor: auditLog.actorUserId })
		.from(auditLog)
		.where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.event, event)));
}

async function auditCount(): Promise<number> {
	const [row] = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(auditLog);
	return row.c;
}

async function create(ctx: InventoryWriteContext, name: string, baseUnit = 'g'): Promise<string> {
	const r = await db.transaction((tx) => createIngredient(tx, ctx, { name, baseUnit }));
	if (!r.ok) throw new Error(r.reason);
	return r.id;
}

let ctx: InventoryWriteContext;
beforeEach(async () => {
	ctx = await makeRestaurant('Pantry Cafe');
});

describe('createIngredient', () => {
	it('creates the row with zero caches and an ingredient.created audit row', async () => {
		const id = await create(ctx, '  Flour  ');
		const view = await getIngredient(testDb(), ctx.restaurantId, id);
		expect(view).toMatchObject({
			name: 'Flour',
			baseUnit: 'g',
			onHandQty: 0n,
			valueMinor: 0n,
			avgMicro: 0n,
			archivedAt: null,
			purchaseUnits: []
		});
		const rows = await auditRows(ctx.restaurantId, 'ingredient.created');
		expect(rows).toEqual([
			{ details: { ingredientId: id, name: 'Flour', baseUnit: 'g' }, actor: ctx.actorUserId }
		]);
	});

	it("'Meat' then 'meat' is name_taken; archiving the first frees the name", async () => {
		const meat = await create(ctx, 'Meat');
		expect(
			await db.transaction((tx) => createIngredient(tx, ctx, { name: 'meat', baseUnit: 'g' }))
		).toEqual({ ok: false, reason: 'name_taken' });
		expect(await db.transaction((tx) => archiveIngredient(tx, ctx, meat))).toEqual({ ok: true });
		expect(await create(ctx, 'meat')).toBeTruthy();
	});

	it('a name_taken refusal leaves the surrounding transaction usable', async () => {
		await create(ctx, 'Salt');
		await db.transaction(async (tx) => {
			expect(await createIngredient(tx, ctx, { name: 'SALT', baseUnit: 'g' })).toEqual({
				ok: false,
				reason: 'name_taken'
			});
			expect((await createIngredient(tx, ctx, { name: 'Pepper', baseUnit: 'g' })).ok).toBe(true);
		});
		const names = (
			await listIngredients(testDb(), ctx.restaurantId, { includeArchived: false })
		).map((i) => i.name);
		expect(names).toEqual(['Pepper', 'Salt']);
	});
});

describe('updateIngredient', () => {
	it('a rename writes one audit row with the old and new name', async () => {
		const id = await create(ctx, 'Flour');
		expect(
			await db.transaction((tx) => updateIngredient(tx, ctx, id, { name: 'Bread flour' }))
		).toEqual({ ok: true, changed: true });
		expect(await auditRows(ctx.restaurantId, 'ingredient.updated')).toEqual([
			{
				details: { ingredientId: id, changes: { name: { old: 'Flour', new: 'Bread flour' } } },
				actor: ctx.actorUserId
			}
		]);
		expect(
			await db.transaction((tx) => updateIngredient(tx, ctx, id, { name: 'Bread flour' }))
		).toEqual({ ok: true, changed: false });
	});

	it('the base unit may change before any movement, never after', async () => {
		const id = await create(ctx, 'Oil', 'ml');
		expect(await db.transaction((tx) => updateIngredient(tx, ctx, id, { baseUnit: 'l' }))).toEqual({
			ok: true,
			changed: true
		});
		await db.transaction((tx) =>
			applyMovements(
				tx,
				{
					restaurantId: ctx.restaurantId,
					sourceType: 'purchase',
					sourceId: randomUUID(),
					businessDate: '2026-09-28',
					occurredAt: new Date(),
					recordedByUserId: ctx.actorUserId
				},
				[
					{
						kind: 'inbound',
						type: 'purchase',
						ingredientId: id,
						qty: qty(1000n),
						costMinor: minor(10n)
					}
				]
			)
		);
		expect(await db.transaction((tx) => updateIngredient(tx, ctx, id, { baseUnit: 'ml' }))).toEqual(
			{
				ok: false,
				reason: 'has_movements'
			}
		);
	});

	it('renaming onto a live name is name_taken', async () => {
		await create(ctx, 'Sugar');
		const id = await create(ctx, 'Salt');
		expect(await db.transaction((tx) => updateIngredient(tx, ctx, id, { name: 'sugar' }))).toEqual({
			ok: false,
			reason: 'name_taken'
		});
	});
});

describe('archiveIngredient', () => {
	it('is refused while a live menu item uses it, and allowed once the item is archived', async () => {
		const cheese = await create(ctx, 'Cheese', 'slice');
		const itemId = await db.transaction(async (tx) => {
			const cat = await createCategory(tx, ctx.restaurantId, { name: 'Mains' });
			const item = await createItem(tx, ctx.restaurantId, {
				categoryId: cat.id,
				name: 'Cheeseburger',
				priceMinor: 800n
			});
			if (!item.ok) throw new Error('item');
			return item.id;
		});
		await testDb().insert(recipeLines).values({
			restaurantId: ctx.restaurantId,
			menuItemId: itemId,
			ingredientId: cheese,
			qty: '1.000'
		});

		expect(await db.transaction((tx) => archiveIngredient(tx, ctx, cheese))).toEqual({
			ok: false,
			reason: 'in_recipe',
			owners: ['Cheeseburger']
		});
		await db.transaction((tx) => archiveItem(tx, ctx.restaurantId, itemId));
		expect(await db.transaction((tx) => archiveIngredient(tx, ctx, cheese))).toEqual({ ok: true });
		expect(await auditRows(ctx.restaurantId, 'ingredient.archived')).toEqual([
			{ details: { ingredientId: cheese, name: 'Cheese' }, actor: ctx.actorUserId }
		]);
		expect(
			(await listIngredients(testDb(), ctx.restaurantId, { includeArchived: false })).length
		).toBe(0);
		expect(
			(await listIngredients(testDb(), ctx.restaurantId, { includeArchived: true })).length
		).toBe(1);
	});
});

describe('purchase units', () => {
	it('adds kg = 1000.000 g; a second live KG is name_taken; archiving frees it', async () => {
		const flour = await create(ctx, 'Flour');
		const added = await db.transaction((tx) =>
			addPurchaseUnit(tx, ctx, flour, { name: 'kg', baseQtyPerUnit: qty(1000000n) })
		);
		expect(added.ok).toBe(true);
		expect(
			await db.transaction((tx) =>
				addPurchaseUnit(tx, ctx, flour, { name: 'KG', baseQtyPerUnit: qty(1000000n) })
			)
		).toEqual({ ok: false, reason: 'name_taken' });

		const view = await getIngredient(testDb(), ctx.restaurantId, flour);
		expect(view?.purchaseUnits).toEqual([
			{ id: (added as { id: string }).id, name: 'kg', baseQtyPerUnit: 1000000n }
		]);
		expect(await auditRows(ctx.restaurantId, 'purchase_unit.added')).toEqual([
			{
				details: { ingredientId: flour, unitName: 'kg', baseQtyPerUnit: '1000.000' },
				actor: ctx.actorUserId
			}
		]);

		expect(
			await db.transaction((tx) => archivePurchaseUnit(tx, ctx, (added as { id: string }).id))
		).toEqual({ ok: true });
		expect(
			(
				await db.transaction((tx) =>
					addPurchaseUnit(tx, ctx, flour, { name: 'KG', baseQtyPerUnit: qty(1000000n) })
				)
			).ok
		).toBe(true);
	});

	it('an archived ingredient takes no new purchase unit', async () => {
		const flour = await create(ctx, 'Flour');
		await db.transaction((tx) => archiveIngredient(tx, ctx, flour));
		expect(
			await db.transaction((tx) =>
				addPurchaseUnit(tx, ctx, flour, { name: 'bag', baseQtyPerUnit: qty(25000000n) })
			)
		).toEqual({ ok: false, reason: 'ingredient_archived' });
	});
});

describe('tenant isolation', () => {
	it("every function given another restaurant's id answers not_found and writes nothing", async () => {
		const other = await makeRestaurant('Other Cafe');
		const foreign = await create(other, 'Saffron');
		const unit = await db.transaction((tx) =>
			addPurchaseUnit(tx, other, foreign, { name: 'jar', baseQtyPerUnit: qty(5000n) })
		);
		const before = await auditCount();

		expect(await db.transaction((tx) => updateIngredient(tx, ctx, foreign, { name: 'X' }))).toEqual(
			{
				ok: false,
				reason: 'not_found'
			}
		);
		expect(await db.transaction((tx) => archiveIngredient(tx, ctx, foreign))).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(
			await db.transaction((tx) =>
				addPurchaseUnit(tx, ctx, foreign, { name: 'tin', baseQtyPerUnit: qty(1000n) })
			)
		).toEqual({ ok: false, reason: 'not_found' });
		expect(
			await db.transaction((tx) => archivePurchaseUnit(tx, ctx, (unit as { id: string }).id))
		).toEqual({ ok: false, reason: 'not_found' });
		expect(await getIngredient(testDb(), ctx.restaurantId, foreign)).toBeNull();

		expect(await auditCount()).toBe(before);
		const [row] = await testDb()
			.select({ name: ingredients.name, archivedAt: ingredients.archivedAt })
			.from(ingredients)
			.where(eq(ingredients.id, foreign));
		expect(row).toEqual({ name: 'Saffron', archivedAt: null });
	});
});
