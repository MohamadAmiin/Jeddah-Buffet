// RECIPES (spec 15, 16; tasks/inventory-cogs T-18).
//
// A recipe line says how much of one ingredient, in base units, a menu item or a
// modifier uses. A modifier's line may be negative ("No tomato" takes the
// tomato away); an item's is positive. Modifiers change the recipe as well as the
// price, so the sale's deduction follows them (spec 15).
//
// RECIPES ARE CONFIGURATION, NOT POSTED RECORDS: setRecipe replaces an owner's
// rows (delete and insert in one transaction), as unlinkModifierGroup deletes a
// link on main. The change is audited (recipe.changed, before and after).
//
// THE POS NEVER SEES A RECIPE, AND COST NEVER ENTERS THE MENU SNAPSHOT. No
// menu_version bump happens here, and listMenu / readMenuSnapshot in
// src/lib/server/menu are untouched: the /menu page reads cost through
// recipeCosts, a separate reader, and merges it itself (T-34).
//
// COST comes from the ledger's cached weighted average (invariant 6) — never a
// number typed on a menu item — carried exactly per owner and rounded ONCE
// (invariant 7).
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { ingredients, recipeLines } from '../db/schema/inventory';
import { menuItems, modifiers } from '../db/schema/menu';
import { writeAudit } from '../audit';
import { ROUNDING_RULE, roundToMinor, type Exact, type Minor } from '../../money';
import { formatQty, parseQty, type Qty } from '../../money/quantity';
import { recipeCostExact } from '../../money/costing';
import type { RecipeIndex } from './consumption';
import type { InventoryWriteContext } from './ingredients';

export const MAX_RECIPE_LINES = 30;

export type RecipeOwner = { kind: 'item' | 'modifier'; id: string };
export type RecipeLineInput = { ingredientId: string; qty: Qty };

export type SetRecipeRefusal =
	| 'not_found'
	| 'owner_archived'
	| 'ingredient_not_found'
	| 'ingredient_archived'
	| 'duplicate_ingredient'
	| 'invalid_qty'
	| 'too_many_lines';

async function lockOwner(tx: DbTx, restaurantId: string, owner: RecipeOwner) {
	const table = owner.kind === 'item' ? menuItems : modifiers;
	const [row] = await tx
		.select({ name: table.name, archivedAt: table.archivedAt })
		.from(table)
		.where(and(eq(table.restaurantId, restaurantId), eq(table.id, owner.id)))
		.for('update');
	return row ?? null;
}

function ownerColumn(owner: RecipeOwner) {
	return owner.kind === 'item' ? recipeLines.menuItemId : recipeLines.modifierId;
}

/**
 * Replace an owner's recipe. An empty `lines` clears it. Refusals write nothing.
 */
export async function setRecipe(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: { owner: RecipeOwner; lines: readonly RecipeLineInput[] }
): Promise<{ ok: true } | { ok: false; reason: SetRecipeRefusal }> {
	const { owner, lines } = input;
	if (owner.kind !== 'item' && owner.kind !== 'modifier') {
		throw new TypeError(`unknown recipe owner kind: ${String(owner.kind)}`);
	}

	// Shape first — no SQL for a request that cannot be valid.
	if (lines.length > MAX_RECIPE_LINES) return { ok: false, reason: 'too_many_lines' };
	for (const line of lines) {
		if (typeof line.qty !== 'bigint') throw new TypeError('a recipe quantity is a Qty');
		const valid = owner.kind === 'item' ? line.qty > 0n : line.qty !== 0n;
		if (!valid) return { ok: false, reason: 'invalid_qty' };
	}
	const ingredientIds = lines.map((l) => l.ingredientId);
	if (new Set(ingredientIds).size !== ingredientIds.length) {
		return { ok: false, reason: 'duplicate_ingredient' };
	}

	const ownerRow = await lockOwner(tx, ctx.restaurantId, owner);
	if (!ownerRow) return { ok: false, reason: 'not_found' };
	if (ownerRow.archivedAt !== null) return { ok: false, reason: 'owner_archived' };

	if (ingredientIds.length > 0) {
		// FOR SHARE, in id order, in one statement: archiveIngredient takes FOR
		// UPDATE, so an ingredient cannot be archived while a recipe adopts it.
		const found = await tx
			.select({ id: ingredients.id, archivedAt: ingredients.archivedAt })
			.from(ingredients)
			.where(
				and(eq(ingredients.restaurantId, ctx.restaurantId), inArray(ingredients.id, ingredientIds))
			)
			.orderBy(ingredients.id)
			.for('share');
		if (found.length !== ingredientIds.length) {
			return { ok: false, reason: 'ingredient_not_found' };
		}
		if (found.some((row) => row.archivedAt !== null)) {
			return { ok: false, reason: 'ingredient_archived' };
		}
	}

	const where = and(
		eq(recipeLines.restaurantId, ctx.restaurantId),
		eq(ownerColumn(owner), owner.id)
	);
	const before = await tx
		.select({ ingredientId: recipeLines.ingredientId, qty: recipeLines.qty })
		.from(recipeLines)
		.where(where)
		.orderBy(asc(recipeLines.ingredientId));
	await tx.delete(recipeLines).where(where);
	if (lines.length > 0) {
		await tx.insert(recipeLines).values(
			lines.map((line) => ({
				restaurantId: ctx.restaurantId,
				menuItemId: owner.kind === 'item' ? owner.id : null,
				modifierId: owner.kind === 'modifier' ? owner.id : null,
				ingredientId: line.ingredientId,
				qty: formatQty(line.qty)
			}))
		);
	}

	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'recipe.changed',
		details: {
			ownerKind: owner.kind,
			ownerId: owner.id,
			ownerName: ownerRow.name,
			before: before.map((row) => ({ ingredientId: row.ingredientId, qty: row.qty })),
			after: [...lines]
				.sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1))
				.map((line) => ({ ingredientId: line.ingredientId, qty: formatQty(line.qty) }))
		}
	});
	return { ok: true };
}

/**
 * The recipes consumeForSale needs for one sale: item id → ingredient → qty and
 * modifier id → ingredient → qty, restaurant-scoped.
 */
export async function recipeIndexFor(
	executor: Executor,
	restaurantId: string,
	itemIds: readonly string[],
	modifierIds: readonly string[]
): Promise<RecipeIndex> {
	const index: RecipeIndex = { items: new Map(), modifiers: new Map() };
	const put = (
		map: Map<string, Map<string, Qty>>,
		owner: string,
		ingredient: string,
		q: string
	) => {
		let byIngredient = map.get(owner);
		if (!byIngredient) map.set(owner, (byIngredient = new Map()));
		byIngredient.set(ingredient, parseQty(q));
	};

	if (itemIds.length > 0) {
		const rows = await executor
			.select({
				owner: recipeLines.menuItemId,
				ingredientId: recipeLines.ingredientId,
				qty: recipeLines.qty
			})
			.from(recipeLines)
			.where(
				and(
					eq(recipeLines.restaurantId, restaurantId),
					inArray(recipeLines.menuItemId, [...new Set(itemIds)])
				)
			);
		for (const row of rows) put(index.items, row.owner!, row.ingredientId, row.qty);
	}
	if (modifierIds.length > 0) {
		const rows = await executor
			.select({
				owner: recipeLines.modifierId,
				ingredientId: recipeLines.ingredientId,
				qty: recipeLines.qty
			})
			.from(recipeLines)
			.where(
				and(
					eq(recipeLines.restaurantId, restaurantId),
					inArray(recipeLines.modifierId, [...new Set(modifierIds)])
				)
			);
		for (const row of rows) put(index.modifiers, row.owner!, row.ingredientId, row.qty);
	}
	return index;
}

export type RecipeLineView = {
	ownerKind: 'item' | 'modifier';
	ownerId: string;
	ingredientId: string;
	ingredientName: string;
	baseUnit: string;
	qty: Qty;
};

/** Every recipe line of the restaurant, for the editor (T-29). */
export async function readRecipes(
	executor: Executor,
	restaurantId: string
): Promise<RecipeLineView[]> {
	const rows = await executor
		.select({
			menuItemId: recipeLines.menuItemId,
			modifierId: recipeLines.modifierId,
			ingredientId: recipeLines.ingredientId,
			ingredientName: ingredients.name,
			baseUnit: ingredients.baseUnit,
			qty: recipeLines.qty
		})
		.from(recipeLines)
		.innerJoin(
			ingredients,
			and(
				eq(ingredients.id, recipeLines.ingredientId),
				eq(ingredients.restaurantId, recipeLines.restaurantId)
			)
		)
		.where(eq(recipeLines.restaurantId, restaurantId))
		.orderBy(asc(ingredients.name));
	return rows.map((row) => ({
		ownerKind: row.menuItemId !== null ? 'item' : 'modifier',
		ownerId: (row.menuItemId ?? row.modifierId)!,
		ingredientId: row.ingredientId,
		ingredientName: row.ingredientName,
		baseUnit: row.baseUnit,
		qty: parseQty(row.qty)
	}));
}

/**
 * Each item's and modifier's recipe cost at the current cached averages, keyed
 * by owner id: exact, and rounded ONCE. A modifier's cost may be negative ("No
 * tomato" saves the tomato). An owner with no recipe is absent from the map.
 */
export async function recipeCosts(
	executor: Executor,
	restaurantId: string
): Promise<Map<string, { costExact: Exact; costMinor: Minor }>> {
	const rows = await executor
		.select({
			menuItemId: recipeLines.menuItemId,
			modifierId: recipeLines.modifierId,
			qty: recipeLines.qty,
			avgMicro: ingredients.avgUnitCostMicro
		})
		.from(recipeLines)
		.innerJoin(
			ingredients,
			and(
				eq(ingredients.id, recipeLines.ingredientId),
				eq(ingredients.restaurantId, recipeLines.restaurantId)
			)
		)
		.where(eq(recipeLines.restaurantId, restaurantId));

	const byOwner = new Map<string, { qty: Qty; avgMicro: bigint }[]>();
	for (const row of rows) {
		const owner = (row.menuItemId ?? row.modifierId)!;
		const list = byOwner.get(owner) ?? [];
		list.push({ qty: parseQty(row.qty), avgMicro: row.avgMicro });
		byOwner.set(owner, list);
	}
	const costs = new Map<string, { costExact: Exact; costMinor: Minor }>();
	for (const [owner, lines] of byOwner) {
		const costExact = recipeCostExact(lines);
		costs.set(owner, { costExact, costMinor: roundToMinor(costExact, ROUNDING_RULE) });
	}
	return costs;
}
