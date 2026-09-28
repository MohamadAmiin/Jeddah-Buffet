// INGREDIENTS AND PURCHASE UNITS (spec 15; tasks/inventory-cogs T-17).
//
// An ingredient has ONE base unit (free text, 1–16 characters) and any number of
// purchase units, each converting to base units by base_qty_per_unit (CLAUDE.md,
// "Inventory 7"). Conventions of src/lib/server/menu: every function takes
// restaurantId explicitly (through ctx) and scopes every statement by it; writers
// take DbTx and never open a transaction; readers take Executor; business
// refusals are { ok: false, reason } results, programming errors throw.
//
// THE CACHES ARE READ-ONLY HERE. on_hand_qty, inventory_value_minor and
// avg_unit_cost_micro are written only by applyMovements (movements.ts,
// invariant 6); nothing in this file sets them.
//
// ARCHIVE, NEVER DELETE (invariant 2): movements reference the ingredient. An
// ingredient still used by a live recipe cannot be archived (CLAUDE.md,
// "Inventory 10"); one with stock can — the reports keep showing it.
//
// Every write carries its audit row in the same transaction (invariant 10).
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import {
	ingredientPurchaseUnits,
	ingredients,
	recipeLines,
	stockMovements
} from '../db/schema/inventory';
import { menuItems, modifiers } from '../db/schema/menu';
import { writeAudit, type AuditEvent } from '../audit';
import { minor, type Minor } from '../../money';
import { formatQty, parseQty, type Qty } from '../../money/quantity';

/** Every inventory write in tasks/inventory-cogs takes this. */
export type InventoryWriteContext = {
	restaurantId: string;
	actorUserId: string;
	ip: string | null;
	userAgent: string | null;
};

type NotFound = { ok: false; reason: 'not_found' };
const NOT_FOUND: NotFound = { ok: false, reason: 'not_found' };

/** True when `error` (or a cause in its chain) is a 23505 on `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
	let cause: unknown = error;
	for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
		const c = cause as { code?: unknown; constraint?: unknown; cause?: unknown };
		if (c.code === '23505' && c.constraint === constraint) return true;
		cause = c.cause;
	}
	return false;
}

/**
 * Run `write` inside a SAVEPOINT (a nested drizzle transaction) and turn a
 * unique violation on `constraint` into `null`, leaving the caller's
 * transaction usable. Anything else rethrows.
 */
async function unlessTaken<T>(
	tx: DbTx,
	constraint: string,
	write: (sp: DbTx) => Promise<T>
): Promise<T | null> {
	try {
		return await tx.transaction(write);
	} catch (error) {
		if (isUniqueViolation(error, constraint)) return null;
		throw error;
	}
}

async function audit(tx: DbTx, ctx: InventoryWriteContext, event: AuditEvent): Promise<void> {
	await writeAudit(tx, {
		...event,
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
}

async function lockIngredientRow(tx: DbTx, restaurantId: string, id: string) {
	const [row] = await tx
		.select({
			id: ingredients.id,
			name: ingredients.name,
			baseUnit: ingredients.baseUnit,
			archivedAt: ingredients.archivedAt
		})
		.from(ingredients)
		.where(and(eq(ingredients.restaurantId, restaurantId), eq(ingredients.id, id)))
		.for('update');
	return row ?? null;
}

export async function createIngredient(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: { name: string; baseUnit: string }
): Promise<{ ok: true; id: string } | { ok: false; reason: 'name_taken' }> {
	const name = input.name.trim();
	const baseUnit = input.baseUnit.trim();
	const id = await unlessTaken(tx, 'ingredients_name_unique', async (sp) => {
		const [row] = await sp
			.insert(ingredients)
			.values({ restaurantId: ctx.restaurantId, name, baseUnit })
			.returning({ id: ingredients.id });
		return row.id;
	});
	if (id === null) return { ok: false, reason: 'name_taken' };
	await audit(tx, ctx, {
		event: 'ingredient.created',
		details: { ingredientId: id, name, baseUnit }
	});
	return { ok: true, id };
}

export async function updateIngredient(
	tx: DbTx,
	ctx: InventoryWriteContext,
	id: string,
	input: { name?: string; baseUnit?: string }
): Promise<
	| { ok: true; changed: boolean }
	| { ok: false; reason: 'not_found' | 'name_taken' | 'has_movements' }
> {
	const current = await lockIngredientRow(tx, ctx.restaurantId, id);
	if (!current || current.archivedAt !== null) return NOT_FOUND;

	const set: { name?: string; baseUnit?: string } = {};
	const name = input.name?.trim();
	const baseUnit = input.baseUnit?.trim();
	if (name !== undefined && name !== current.name) set.name = name;
	if (baseUnit !== undefined && baseUnit !== current.baseUnit) {
		// Every stored quantity is in the base unit: once one exists, changing the
		// unit would silently change the meaning of every movement.
		const [moved] = await tx
			.select({ one: sql<number>`1` })
			.from(stockMovements)
			.where(
				and(eq(stockMovements.restaurantId, ctx.restaurantId), eq(stockMovements.ingredientId, id))
			)
			.limit(1);
		if (moved) return { ok: false, reason: 'has_movements' };
		set.baseUnit = baseUnit;
	}
	if (Object.keys(set).length === 0) return { ok: true, changed: false };

	const done = await unlessTaken(tx, 'ingredients_name_unique', async (sp) => {
		await sp
			.update(ingredients)
			.set({ ...set, updatedAt: new Date() })
			.where(and(eq(ingredients.restaurantId, ctx.restaurantId), eq(ingredients.id, id)));
		return true;
	});
	if (done === null) return { ok: false, reason: 'name_taken' };

	const changes: Record<string, { old: unknown; new: unknown }> = {};
	if (set.name !== undefined) changes.name = { old: current.name, new: set.name };
	if (set.baseUnit !== undefined) changes.baseUnit = { old: current.baseUnit, new: set.baseUnit };
	await audit(tx, ctx, { event: 'ingredient.updated', details: { ingredientId: id, changes } });
	return { ok: true, changed: true };
}

/** The names of the live menu items and modifiers whose recipes use an ingredient. */
async function liveRecipeOwners(tx: Executor, restaurantId: string, id: string): Promise<string[]> {
	const items = await tx
		.selectDistinct({ name: menuItems.name })
		.from(recipeLines)
		.innerJoin(
			menuItems,
			and(eq(menuItems.id, recipeLines.menuItemId), eq(menuItems.restaurantId, restaurantId))
		)
		.where(
			and(
				eq(recipeLines.restaurantId, restaurantId),
				eq(recipeLines.ingredientId, id),
				isNull(menuItems.archivedAt)
			)
		);
	const mods = await tx
		.selectDistinct({ name: modifiers.name })
		.from(recipeLines)
		.innerJoin(
			modifiers,
			and(eq(modifiers.id, recipeLines.modifierId), eq(modifiers.restaurantId, restaurantId))
		)
		.where(
			and(
				eq(recipeLines.restaurantId, restaurantId),
				eq(recipeLines.ingredientId, id),
				isNull(modifiers.archivedAt)
			)
		);
	return [...items, ...mods].map((r) => r.name).sort();
}

export async function archiveIngredient(
	tx: DbTx,
	ctx: InventoryWriteContext,
	id: string
): Promise<{ ok: true } | NotFound | { ok: false; reason: 'in_recipe'; owners: string[] }> {
	const current = await lockIngredientRow(tx, ctx.restaurantId, id);
	if (!current || current.archivedAt !== null) return NOT_FOUND;
	const owners = await liveRecipeOwners(tx, ctx.restaurantId, id);
	if (owners.length > 0) return { ok: false, reason: 'in_recipe', owners };

	const now = new Date();
	await tx
		.update(ingredients)
		.set({ archivedAt: now, updatedAt: now })
		.where(and(eq(ingredients.restaurantId, ctx.restaurantId), eq(ingredients.id, id)));
	await audit(tx, ctx, {
		event: 'ingredient.archived',
		details: { ingredientId: id, name: current.name }
	});
	return { ok: true };
}

export async function addPurchaseUnit(
	tx: DbTx,
	ctx: InventoryWriteContext,
	ingredientId: string,
	input: { name: string; baseQtyPerUnit: Qty }
): Promise<
	| { ok: true; id: string }
	| { ok: false; reason: 'not_found' | 'name_taken' | 'ingredient_archived' }
> {
	if (typeof input.baseQtyPerUnit !== 'bigint' || input.baseQtyPerUnit <= 0n) {
		throw new TypeError('a purchase unit factor is a positive Qty');
	}
	// FOR SHARE is enough: the unit row is new, the ingredient only must not be
	// archived under us.
	const [ingredient] = await tx
		.select({ archivedAt: ingredients.archivedAt })
		.from(ingredients)
		.where(and(eq(ingredients.restaurantId, ctx.restaurantId), eq(ingredients.id, ingredientId)))
		.for('share');
	if (!ingredient) return NOT_FOUND;
	if (ingredient.archivedAt !== null) return { ok: false, reason: 'ingredient_archived' };

	const name = input.name.trim();
	const baseQtyPerUnit = formatQty(input.baseQtyPerUnit);
	const id = await unlessTaken(tx, 'ingredient_purchase_units_name_unique', async (sp) => {
		const [row] = await sp
			.insert(ingredientPurchaseUnits)
			.values({ restaurantId: ctx.restaurantId, ingredientId, name, baseQtyPerUnit })
			.returning({ id: ingredientPurchaseUnits.id });
		return row.id;
	});
	if (id === null) return { ok: false, reason: 'name_taken' };
	await audit(tx, ctx, {
		event: 'purchase_unit.added',
		details: { ingredientId, unitName: name, baseQtyPerUnit }
	});
	return { ok: true, id };
}

export async function archivePurchaseUnit(
	tx: DbTx,
	ctx: InventoryWriteContext,
	unitId: string
): Promise<{ ok: true } | NotFound> {
	const [unit] = await tx
		.select({
			ingredientId: ingredientPurchaseUnits.ingredientId,
			name: ingredientPurchaseUnits.name
		})
		.from(ingredientPurchaseUnits)
		.where(
			and(
				eq(ingredientPurchaseUnits.restaurantId, ctx.restaurantId),
				eq(ingredientPurchaseUnits.id, unitId),
				isNull(ingredientPurchaseUnits.archivedAt)
			)
		)
		.for('update');
	if (!unit) return NOT_FOUND;
	await tx
		.update(ingredientPurchaseUnits)
		.set({ archivedAt: new Date() })
		.where(
			and(
				eq(ingredientPurchaseUnits.restaurantId, ctx.restaurantId),
				eq(ingredientPurchaseUnits.id, unitId)
			)
		);
	await audit(tx, ctx, {
		event: 'purchase_unit.archived',
		details: { ingredientId: unit.ingredientId, unitName: unit.name }
	});
	return { ok: true };
}

// ── Readers ─────────────────────────────────────────────────────────────────

export type PurchaseUnitView = { id: string; name: string; baseQtyPerUnit: Qty };
export type IngredientView = {
	id: string;
	name: string;
	baseUnit: string;
	onHandQty: Qty;
	valueMinor: Minor;
	avgMicro: bigint;
	archivedAt: Date | null;
	purchaseUnits: PurchaseUnitView[];
};

async function readIngredients(
	executor: Executor,
	restaurantId: string,
	where: { id?: string; includeArchived: boolean }
): Promise<IngredientView[]> {
	const conditions = [eq(ingredients.restaurantId, restaurantId)];
	if (where.id !== undefined) conditions.push(eq(ingredients.id, where.id));
	if (!where.includeArchived) conditions.push(isNull(ingredients.archivedAt));
	const rows = await executor
		.select()
		.from(ingredients)
		.where(and(...conditions))
		.orderBy(asc(sql`lower(${ingredients.name})`), asc(ingredients.id));
	if (rows.length === 0) return [];

	const units = await executor
		.select({
			id: ingredientPurchaseUnits.id,
			ingredientId: ingredientPurchaseUnits.ingredientId,
			name: ingredientPurchaseUnits.name,
			baseQtyPerUnit: ingredientPurchaseUnits.baseQtyPerUnit
		})
		.from(ingredientPurchaseUnits)
		.where(
			and(
				eq(ingredientPurchaseUnits.restaurantId, restaurantId),
				inArray(
					ingredientPurchaseUnits.ingredientId,
					rows.map((r) => r.id)
				),
				isNull(ingredientPurchaseUnits.archivedAt)
			)
		)
		.orderBy(asc(ingredientPurchaseUnits.name));

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		baseUnit: r.baseUnit,
		onHandQty: parseQty(r.onHandQty),
		valueMinor: minor(r.inventoryValueMinor),
		avgMicro: r.avgUnitCostMicro,
		archivedAt: r.archivedAt,
		purchaseUnits: units
			.filter((u) => u.ingredientId === r.id)
			.map((u) => ({ id: u.id, name: u.name, baseQtyPerUnit: parseQty(u.baseQtyPerUnit) }))
	}));
}

export function listIngredients(
	executor: Executor,
	restaurantId: string,
	options: { includeArchived: boolean }
): Promise<IngredientView[]> {
	return readIngredients(executor, restaurantId, { includeArchived: options.includeArchived });
}

export async function getIngredient(
	executor: Executor,
	restaurantId: string,
	id: string
): Promise<IngredientView | null> {
	const [row] = await readIngredients(executor, restaurantId, { id, includeArchived: true });
	return row ?? null;
}
