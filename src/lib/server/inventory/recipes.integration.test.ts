import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { recipeLines } from '../db/schema/inventory';
import { onRestaurantCreated } from '../restaurants';
import {
	archiveItem,
	createCategory,
	createItem,
	createModifier,
	createModifierGroup
} from '../menu';
import { exact, exactEquals, minor } from '../../money';
import { qty } from '../../money/quantity';
import { applyMovements } from './movements';
import { archiveIngredient, createIngredient, type InventoryWriteContext } from './ingredients';
import { readRecipes, recipeCosts, recipeIndexFor, setRecipe } from './recipes';

// Recipes (tasks/inventory-cogs T-18).

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
	return { restaurantId: r.id, actorUserId: owner.id, ip: null, userAgent: null };
}

async function ingredient(
	ctx: InventoryWriteContext,
	name: string,
	baseUnit = 'g'
): Promise<string> {
	const r = await db.transaction((tx) => createIngredient(tx, ctx, { name, baseUnit }));
	if (!r.ok) throw new Error(r.reason);
	return r.id;
}

/** Give an ingredient an average by buying `q` thousandths for `cost` cents. */
async function buy(ctx: InventoryWriteContext, id: string, q: bigint, cost: bigint): Promise<void> {
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
			[{ kind: 'inbound', type: 'purchase', ingredientId: id, qty: qty(q), costMinor: minor(cost) }]
		)
	);
}

type Menu = { burger: string; noTomato: string };
async function makeMenu(ctx: InventoryWriteContext): Promise<Menu> {
	return db.transaction(async (tx) => {
		const cat = await createCategory(tx, ctx.restaurantId, { name: 'Mains' });
		const item = await createItem(tx, ctx.restaurantId, {
			categoryId: cat.id,
			name: 'Burger',
			priceMinor: 800n
		});
		const group = await createModifierGroup(tx, ctx.restaurantId, { name: 'Changes' });
		if (!item.ok || !group.ok) throw new Error('menu');
		const mod = await createModifier(tx, ctx.restaurantId, {
			groupId: group.id,
			name: 'No tomato',
			priceDeltaMinor: 0n
		});
		if (!mod.ok) throw new Error('modifier');
		return { burger: item.id, noTomato: mod.id };
	});
}

async function recipeRowCount(restaurantId: string): Promise<number> {
	const [row] = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(recipeLines)
		.where(eq(recipeLines.restaurantId, restaurantId));
	return row.c;
}

async function recipeAudits(restaurantId: string) {
	return testDb()
		.select({ details: auditLog.details })
		.from(auditLog)
		.where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.event, 'recipe.changed')))
		.orderBy(auditLog.id);
}

let ctx: InventoryWriteContext;
let menu: Menu;
let bun: string;
let meat: string;
let cheese: string;
let tomato: string;
beforeEach(async () => {
	ctx = await makeRestaurant('Recipe Cafe');
	menu = await makeMenu(ctx);
	bun = await ingredient(ctx, 'Bun', 'pcs');
	meat = await ingredient(ctx, 'Meat');
	cheese = await ingredient(ctx, 'Cheese', 'slice');
	tomato = await ingredient(ctx, 'Tomato');
});

const item = () => ({ kind: 'item' as const, id: menu.burger });

describe('setRecipe', () => {
	it('sets, replaces and clears a recipe, auditing before and after each time', async () => {
		const set = (lines: { ingredientId: string; qty: bigint }[]) =>
			db.transaction((tx) =>
				setRecipe(tx, ctx, {
					owner: item(),
					lines: lines.map((l) => ({ ingredientId: l.ingredientId, qty: qty(l.qty) }))
				})
			);

		expect(
			await set([
				{ ingredientId: bun, qty: 1000n },
				{ ingredientId: meat, qty: 150000n },
				{ ingredientId: cheese, qty: 1000n }
			])
		).toEqual({ ok: true });
		expect(await recipeRowCount(ctx.restaurantId)).toBe(3);

		expect(
			await set([
				{ ingredientId: bun, qty: 1000n },
				{ ingredientId: meat, qty: 120000n }
			])
		).toEqual({ ok: true });
		expect(await recipeRowCount(ctx.restaurantId)).toBe(2);

		expect(await set([])).toEqual({ ok: true });
		expect(await recipeRowCount(ctx.restaurantId)).toBe(0);

		const audits = (await recipeAudits(ctx.restaurantId)).map(
			(a) => a.details as { ownerName: string; before: unknown[]; after: unknown[] }
		);
		expect(audits.map((a) => [a.ownerName, a.before.length, a.after.length])).toEqual([
			['Burger', 0, 3],
			['Burger', 3, 2],
			['Burger', 2, 0]
		]);
		expect(audits[1].after).toContainEqual({ ingredientId: meat, qty: '120.000' });
	});

	it('accepts a negative modifier line; refuses a negative item line', async () => {
		expect(
			await db.transaction((tx) =>
				setRecipe(tx, ctx, {
					owner: { kind: 'modifier', id: menu.noTomato },
					lines: [{ ingredientId: tomato, qty: qty(-30000n) }]
				})
			)
		).toEqual({ ok: true });
		expect(
			await db.transaction((tx) =>
				setRecipe(tx, ctx, { owner: item(), lines: [{ ingredientId: tomato, qty: qty(-1000n) }] })
			)
		).toEqual({ ok: false, reason: 'invalid_qty' });
	});

	it('each refusal reason, and a refusal writes nothing', async () => {
		const other = await makeRestaurant('Other Cafe');
		const foreignMenu = await makeMenu(other);
		const archivedIngredient = await ingredient(ctx, 'Old spice');
		await db.transaction((tx) => archiveIngredient(tx, ctx, archivedIngredient));
		const auditsBefore = (await recipeAudits(ctx.restaurantId)).length;

		const attempt = (owner: { kind: 'item' | 'modifier'; id: string }, lines: [string, bigint][]) =>
			db.transaction((tx) =>
				setRecipe(tx, ctx, {
					owner,
					lines: lines.map(([ingredientId, q]) => ({ ingredientId, qty: qty(q) }))
				})
			);

		expect(await attempt({ kind: 'item', id: foreignMenu.burger }, [[bun, 1000n]])).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await attempt(item(), [[randomUUID(), 1000n]])).toEqual({
			ok: false,
			reason: 'ingredient_not_found'
		});
		expect(await attempt(item(), [[archivedIngredient, 1000n]])).toEqual({
			ok: false,
			reason: 'ingredient_archived'
		});
		expect(
			await attempt(item(), [
				[bun, 1000n],
				[bun, 2000n]
			])
		).toEqual({ ok: false, reason: 'duplicate_ingredient' });
		expect(await attempt({ kind: 'modifier', id: menu.noTomato }, [[tomato, 0n]])).toEqual({
			ok: false,
			reason: 'invalid_qty'
		});
		const many = Array.from({ length: 31 }, (): [string, bigint] => [randomUUID(), 1000n]);
		expect(await attempt(item(), many)).toEqual({ ok: false, reason: 'too_many_lines' });

		await db.transaction((tx) => archiveItem(tx, ctx.restaurantId, menu.burger));
		expect(await attempt(item(), [[bun, 1000n]])).toEqual({ ok: false, reason: 'owner_archived' });

		expect(await recipeRowCount(ctx.restaurantId)).toBe(0);
		expect((await recipeAudits(ctx.restaurantId)).length).toBe(auditsBefore);
	});
});

describe('readers', () => {
	beforeEach(async () => {
		await db.transaction(async (tx) => {
			await setRecipe(tx, ctx, {
				owner: item(),
				lines: [
					{ ingredientId: bun, qty: qty(1000n) },
					{ ingredientId: meat, qty: qty(150000n) },
					{ ingredientId: cheese, qty: qty(1000n) }
				]
			});
			await setRecipe(tx, ctx, {
				owner: { kind: 'modifier', id: menu.noTomato },
				lines: [{ ingredientId: tomato, qty: qty(-30000n) }]
			});
		});
	});

	it('recipeIndexFor returns the shape aggregateConsumption expects', async () => {
		const index = await recipeIndexFor(testDb(), ctx.restaurantId, [menu.burger], [menu.noTomato]);
		expect(index.items).toEqual(
			new Map([
				[
					menu.burger,
					new Map([
						[bun, 1000n],
						[meat, 150000n],
						[cheese, 1000n]
					])
				]
			])
		);
		expect(index.modifiers).toEqual(new Map([[menu.noTomato, new Map([[tomato, -30000n]])]]));
		// Another restaurant sees nothing of it.
		const other = await makeRestaurant('Other Cafe');
		const empty = await recipeIndexFor(
			testDb(),
			other.restaurantId,
			[menu.burger],
			[menu.noTomato]
		);
		expect(empty.items.size + empty.modifiers.size).toBe(0);
	});

	it('readRecipes lists every line with its owner and ingredient', async () => {
		const lines = await readRecipes(testDb(), ctx.restaurantId);
		expect(lines).toHaveLength(4);
		expect(lines).toContainEqual({
			ownerKind: 'modifier',
			ownerId: menu.noTomato,
			ingredientId: tomato,
			ingredientName: 'Tomato',
			baseUnit: 'g',
			qty: -30000n
		});
	});

	it('recipeCosts: the burger at meat 0.55¢/g, bun 25¢, cheese 12¢ costs 119.5 → 120', async () => {
		await buy(ctx, meat, 1000000n, 550n); // 1,000 g for $5.50 → 550000 µ¢/g
		await buy(ctx, bun, 1000n, 25n); // 1 bun for 25¢ → 25000000
		await buy(ctx, cheese, 1000n, 12n); // 1 slice for 12¢ → 12000000
		const costs = await recipeCosts(testDb(), ctx.restaurantId);
		const burger = costs.get(menu.burger)!;
		expect(exactEquals(burger.costExact, exact(239n, 2n))).toBe(true);
		expect(burger.costMinor).toBe(120n);
		// The modifier's tomato has no average yet: it saves nothing.
		expect(costs.get(menu.noTomato)!.costMinor).toBe(0n);
	});
});
