/**
 * Pure helpers for the inventory pages — zod schemas and the display mapping —
 * in their own module so the unit project can reach them (the menu page's
 * helpers.ts is the precedent). Nothing here touches the database, and nothing
 * here is imported into a .svelte component: zod stays on the server.
 *
 * THE PAGES DO NO ARITHMETIC (invariant 1). Every amount leaves the server as
 * the money formatter's string and every quantity as formatQty's; the one
 * display conversion of an average is the ledger's own valueAt, applied by the
 * reports module (currentStock.perUnit).
 */
import { z } from 'zod';
import type { Minor } from '../../../lib/money';
import { formatAmount, type MoneyFormat } from '../../../lib/money/format';
import { formatQty, parseQty, type Qty } from '../../../lib/money/quantity';

export { firstMessage } from '../menu/helpers';

/** The currency gate's sentence for a disabled money input. */
export const CURRENCY_MESSAGE = 'Set the currency in Settings before entering amounts.';

/** A formatted amount, or null while no currency is set (the page shows "—"). */
export function amountText(value: Minor, format: MoneyFormat | null): string | null {
	return format ? formatAmount(value, format) : null;
}

/** "2500.000 g" — the quantity with its unit. */
export function qtyText(value: Qty, unit: string): string {
	return `${formatQty(value)} ${unit}`;
}

export const createIngredientSchema = z.object({
	name: z.string().trim().min(1, 'Enter a name.').max(80, 'Keep the name under 80 characters.'),
	baseUnit: z
		.string()
		.trim()
		.min(1, 'Enter the unit recipes use, for example g, ml or pcs.')
		.max(16, 'Keep the unit under 16 characters.')
});

// ── /inventory/recipes (T-29) ────────────────────────────────────────────────

/** The most rows a recipe form may carry (setRecipe's MAX_RECIPE_LINES). */
export const RECIPE_MAX_ROWS = 30;

/** The owner of the recipe being saved: its kind and its id. */
export const recipeOwnerSchema = z.object({
	kind: z.enum(['item', 'modifier'], { error: 'Choose a menu item or a modifier.' }),
	ownerId: z.uuid({ error: 'Choose a menu item or a modifier.' })
});

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecipeRowsResult =
	| { ok: true; lines: { ingredientId: string; qty: Qty; row: number }[] }
	| { ok: false; message: string };

/**
 * The recipe form's rows, read positionally from the repeated `ingredientId` and
 * `qty` fields. A row with both fields blank is ignored; every other problem is
 * refused with a message naming the row as the page numbers it (1-based, blanks
 * included). Item rows must be positive; modifier rows may be negative but not
 * zero ("No tomato"). Each line keeps its row number so a later refusal from
 * setRecipe can be mapped back to it.
 */
export function parseRecipeRows(
	kind: 'item' | 'modifier',
	ingredientIds: readonly string[],
	qtys: readonly string[]
): RecipeRowsResult {
	const count = Math.max(ingredientIds.length, qtys.length);
	const lines: { ingredientId: string; qty: Qty; row: number }[] = [];
	const seen = new Map<string, number>();
	for (let index = 0; index < count; index += 1) {
		const row = index + 1;
		const ingredientId = (ingredientIds[index] ?? '').trim();
		const text = (qtys[index] ?? '').trim();
		if (ingredientId === '' && text === '') continue;
		if (ingredientId === '' || !UUID_SHAPE.test(ingredientId)) {
			return { ok: false, message: `Row ${row}: choose an ingredient.` };
		}
		if (text === '') return { ok: false, message: `Row ${row}: enter a quantity.` };
		let q: Qty;
		try {
			q = parseQty(text);
		} catch {
			return {
				ok: false,
				message: `Row ${row}: enter a quantity with at most three decimals, for example 2.5 or 0.030.`
			};
		}
		if (kind === 'item' && q <= 0n) {
			return { ok: false, message: `Row ${row}: an item's quantity must be more than zero.` };
		}
		if (q === 0n) return { ok: false, message: `Row ${row}: a quantity cannot be zero.` };
		const earlier = seen.get(ingredientId);
		if (earlier !== undefined) {
			return {
				ok: false,
				message: `Row ${row}: this ingredient is already on row ${earlier}. Put it on one row.`
			};
		}
		seen.set(ingredientId, row);
		lines.push({ ingredientId, qty: q, row });
		if (lines.length > RECIPE_MAX_ROWS) {
			return { ok: false, message: `A recipe has at most ${RECIPE_MAX_ROWS} ingredients.` };
		}
	}
	return { ok: true, lines };
}

// ── Waste, counts and the inventory reports (tasks/inventory-cogs T-32, T-33) ──

/** True when `value` is YYYY-MM-DD and names a real calendar day. */
export function isBusinessDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [y, m, d] = value.split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * A business date `days` away from `value` (negative goes back), by calendar
 * arithmetic on the date itself — never the server clock. `value` must already
 * satisfy isBusinessDate.
 */
export function shiftBusinessDate(value: string, days: number): string {
	const [y, m, d] = value.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "−2.500 g": a quantity whose negative carries the typographic minus. */
export function signedQtyText(value: Qty, unit: string): string {
	return qtyText(value, unit).replace(/^-/, '−');
}

/** Spelled exactly as the module's WASTE_REASONS (waste_entries_reason_valid). */
export const WASTE_REASON_VALUES = ['spoilage', 'preparation_error', 'breakage', 'other'] as const;

export const WASTE_REASON_LABELS: Record<(typeof WASTE_REASON_VALUES)[number], string> = {
	spoilage: 'Spoilage',
	preparation_error: 'Preparation error',
	breakage: 'Breakage',
	other: 'Other'
};

/** The label for a stored reason, or the stored text when it is unknown. */
export function wasteReasonText(reason: string): string {
	return (WASTE_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}

const businessDateField = z
	.string()
	.trim()
	.refine(isBusinessDate, 'Enter the business date as YYYY-MM-DD.');

export const wasteSchema = z
	.object({
		ingredientId: z.uuid('Choose an ingredient.'),
		qty: z.string().trim().min(1, 'Enter a quantity above zero.').max(20, 'Check the quantity.'),
		reason: z.enum(WASTE_REASON_VALUES, 'Choose a reason.'),
		note: z.string().trim().max(200, 'Keep the note under 200 characters.'),
		businessDate: businessDateField
	})
	.refine((w) => w.reason !== 'other' || w.note.length >= 3, {
		message: 'Say what happened in a note of 3 to 200 characters when the reason is Other.',
		path: ['note']
	});

export const countSchema = z.object({
	note: z.string().trim().max(200, 'Keep the note under 200 characters.'),
	businessDate: businessDateField
});

// ── /inventory/[id] (tasks/inventory-cogs T-28) ─────────────────────────────

/** The route parameter: anything but a uuid is simply not an ingredient here. */
export const ingredientIdSchema = z.uuid();

export const updateIngredientSchema = z.object({
	name: createIngredientSchema.shape.name,
	// Absent when the field is disabled (stock has moved): the name alone changes.
	baseUnit: createIngredientSchema.shape.baseUnit.optional()
});

export const addUnitSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, 'Enter the unit name, for example bag or case.')
		.max(24, 'Keep the unit name under 24 characters.'),
	baseQtyPerUnit: z
		.string()
		.trim()
		.min(1, 'Enter how many base units one of these holds.')
		.max(20, 'Check the quantity.')
});

export const archiveUnitSchema = z.object({
	unitId: z.uuid('That unit no longer exists. Reload the page.')
});

export const openingStockSchema = z.object({
	purchaseUnitId: z.uuid('Choose a purchase unit.'),
	qty: z.string().trim().min(1, 'Enter a quantity above zero.').max(20, 'Check the quantity.'),
	cost: z.string().max(20, 'Check the cost.'),
	businessDate: z.string().trim().refine(isBusinessDate, 'Enter the business date as YYYY-MM-DD.')
});

/** A typed quantity above zero, or the sentence that says why not. */
export function parsePositiveQty(
	text: string
): { ok: true; qty: Qty } | { ok: false; message: string } {
	const message = 'Enter a quantity above zero with at most three decimals, for example 2.5.';
	let q: Qty;
	try {
		q = parseQty(text);
	} catch {
		return { ok: false, message };
	}
	return q > 0n ? { ok: true, qty: q } : { ok: false, message };
}

/**
 * A movement type in words, with its glyph (the plan's list; `comp` is not on
 * it and takes the outbound `−`). Colour never carries the meaning: the words do.
 */
export const MOVEMENT_LABELS: Record<string, { glyph: string; words: string }> = {
	purchase: { glyph: '+', words: 'Delivery' },
	purchase_reversal: { glyph: '↩', words: 'Delivery reversed' },
	opening_stock: { glyph: '○', words: 'Opening stock' },
	sale_consumption: { glyph: '−', words: 'Sale' },
	waste: { glyph: '✕', words: 'Waste' },
	count_adjustment: { glyph: '≈', words: 'Count' },
	comp: { glyph: '−', words: 'Comp' },
	revaluation: { glyph: '↕', words: 'Revaluation' }
};

export function movementLabel(type: string): { glyph: string; words: string } {
	return MOVEMENT_LABELS[type] ?? { glyph: '•', words: type };
}

/** Where a movement came from, in words (stock_movements_source_valid). */
export function movementSourceText(sourceType: string): string {
	const words: Record<string, string> = {
		purchase: 'Delivery',
		order: 'Sale',
		waste_entry: 'Waste entry',
		stock_count: 'Stock count',
		opening_stock: 'Opening stock'
	};
	return words[sourceType] ?? sourceType;
}
