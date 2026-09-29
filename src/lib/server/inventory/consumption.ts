// aggregateConsumption — recipes × sale lines, in base units (spec 13 "Deduct
// Inventory — recipes × quantity, incl. modifiers"; spec 15).
//
// PURE: no database, no I/O. consumeForSale (T-19) calls it inside THE payment
// transaction, so it never throws for a business reason (invariant 4): an item
// with no recipe and an unknown modifier contribute nothing, and a sale is never
// refused for stock (invariant 6). It throws only for a programming error — a
// line quantity that is not a safe integer, which pos-sales' validator already
// rules out.
//
// MODIFIER DELTAS ARE CLAMPED AT ZERO PER LINE AND PER INGREDIENT, before the
// line quantity multiplies them (CLAUDE.md, "Inventory 11"): "No tomato" on an
// item without tomato takes nothing, and "No tomato" on one burger never
// cancels the tomato of another line. A modifier can never create stock.
import type { SaleLine } from '../../sync-ops';
import { addQty, qty, type Qty } from '../../money/quantity';

/** Owner id → ingredient id → quantity in base units (modifier quantities may be negative). */
export type RecipeIndex = {
	items: Map<string, Map<string, Qty>>;
	modifiers: Map<string, Map<string, Qty>>;
};

const NONE: ReadonlyMap<string, Qty> = new Map();

export function aggregateConsumption(
	lines: readonly SaleLine[],
	recipes: RecipeIndex
): Map<string, Qty> {
	const totals = new Map<string, Qty>();
	for (const line of lines) {
		if (!Number.isSafeInteger(line.quantity)) {
			throw new TypeError(`a sale line quantity is a safe integer, got ${String(line.quantity)}`);
		}
		const lineQty = BigInt(line.quantity);
		const itemRecipe = recipes.items.get(line.menuItemId) ?? NONE;
		const modifierRecipes = line.modifiers.map((m) => recipes.modifiers.get(m.modifierId) ?? NONE);

		const ingredientIds = new Set<string>(itemRecipe.keys());
		for (const recipe of modifierRecipes) for (const id of recipe.keys()) ingredientIds.add(id);

		for (const ingredientId of ingredientIds) {
			let base: bigint = itemRecipe.get(ingredientId) ?? 0n;
			for (const recipe of modifierRecipes) base += recipe.get(ingredientId) ?? 0n;
			if (base <= 0n) continue; // clamped at zero, per line and per ingredient
			const used = qty(base * lineQty);
			totals.set(ingredientId, addQty(totals.get(ingredientId) ?? qty(0n), used));
		}
	}
	for (const [ingredientId, total] of totals) {
		if (total === 0n) totals.delete(ingredientId);
	}
	return totals;
}
