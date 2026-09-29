/**
 * Pure helpers for the delivery pages (tasks/inventory-cogs T-30, T-31) — the
 * zod schemas, the words for "paid by" and "paid from", the line-row reader
 * and the refusal messages — in their own module so the unit project can reach
 * them. Nothing here touches the database, and nothing here is imported into a
 * .svelte component: zod stays on the server.
 *
 * NO MONEY ARITHMETIC (invariant 1). A typed amount is read ONCE by the menu
 * page's parsePriceInput (imported, never copied) and a typed quantity by
 * parseQty; nothing here adds, rounds or compares money beyond "is it zero".
 */
import { z } from 'zod';
import type { Minor } from '../../../lib/money';
import { parseQty, type Qty } from '../../../lib/money/quantity';
import { parsePriceInput } from '../menu/helpers';

export { firstMessage } from '../menu/helpers';
export { amountText, qtyText, CURRENCY_MESSAGE } from '../inventory/helpers';

/** The form's cap on line rows; the module's own cap (50) is higher. */
export const MAX_FORM_LINES = 30;

/** The rows /purchases/new renders before the owner asks for more. */
export const INITIAL_FORM_LINES = 5;

export const PAID_BY_LABELS = {
	bank: 'Paid now — bank',
	cash: 'Paid now — cash',
	credit: 'On credit'
} as const;

export const PAID_FROM_LABELS = { bank: 'Bank', cash: 'Cash' } as const;

/** Assumption 3: cash on a delivery is cash kept outside the till. */
export const PAID_BY_HINT =
	'Cash means cash kept outside the till. Paying from the till drawer is a pay-out, which is not part of this release.';

export const HAS_PAYMENTS_MESSAGE = 'Reverse the payments on this delivery first.';
export const ALREADY_REVERSED_MESSAGE = 'This was already reversed.';
export const REASON_MESSAGE = 'Give a reason of 3 to 200 characters.';
export const DELIVERY_NOT_FOUND_MESSAGE = 'That delivery no longer exists. Reload the page.';
export const PAYMENT_NOT_FOUND_MESSAGE = 'That payment no longer exists. Reload the page.';

export function lineMessage(n: number): string {
	return `Line ${n}: choose an ingredient and one of its units, a quantity above zero and a total.`;
}

const businessDate = z.iso.date('Enter the business date as YYYY-MM-DD.');
const reason = z.string().trim().min(3, REASON_MESSAGE).max(200, REASON_MESSAGE);

export const createPurchaseSchema = z.object({
	supplierName: z
		.string()
		.trim()
		.min(1, 'Enter the supplier.')
		.max(120, 'Keep the supplier under 120 characters.'),
	businessDate,
	paidBy: z.enum(['bank', 'cash', 'credit'], 'Choose how the delivery was paid.'),
	note: z.string().trim().max(200, 'Keep the note under 200 characters.')
});

export const idSchema = z.uuid();

export const paySchema = z.object({
	amount: z.string(),
	paidFrom: z.enum(['bank', 'cash'], 'Choose where the money came from.'),
	businessDate
});

export const reversePaymentSchema = z.object({
	paymentId: z.uuid(PAYMENT_NOT_FOUND_MESSAGE),
	reason
});

export const reverseSchema = z.object({ reason });

/** A line row exactly as typed, handed back on a refusal so nothing is lost. */
export type LineValues = { unit: string; quantity: string; total: string };

/** A line the module can take, with the form row it came from. */
export type ParsedLine = {
	row: number;
	ingredientId: string;
	purchaseUnitId: string;
	unitQty: Qty;
	lineCostMinor: Minor;
};

/**
 * The value of one "Ingredient — unit" option: both ids, so the module is the
 * one that refuses a unit of another ingredient.
 */
export function unitOptionValue(ingredientId: string, unitId: string): string {
	return `${ingredientId}:${unitId}`;
}

const pairSchema = z.tuple([z.uuid(), z.uuid()]);

function positiveQty(raw: string): Qty | null {
	try {
		const value = parseQty(raw);
		return value > 0n ? value : null;
	} catch {
		return null;
	}
}

/**
 * Read the line rows (the fields repeat, so formData.getAll). A row with all
 * three fields blank is skipped; any other row must be whole, or the answer is
 * the FORM row number it sits on — the number the owner sees.
 */
export function readLines(
	form: FormData,
	exponent: number
):
	| { ok: true; values: LineValues[]; lines: ParsedLine[] }
	| { ok: false; values: LineValues[]; message: string } {
	const text = (name: string) =>
		form.getAll(name).map((value) => (typeof value === 'string' ? value : ''));
	const units = text('unit');
	const quantities = text('quantity');
	const totals = text('total');
	const count = Math.max(units.length, quantities.length, totals.length);
	const values: LineValues[] = [];
	for (let i = 0; i < count; i += 1) {
		values.push({ unit: units[i] ?? '', quantity: quantities[i] ?? '', total: totals[i] ?? '' });
	}
	if (count > MAX_FORM_LINES) {
		return {
			ok: false,
			values: values.slice(0, MAX_FORM_LINES),
			message: `A delivery has at most ${MAX_FORM_LINES} lines.`
		};
	}

	const lines: ParsedLine[] = [];
	for (const [index, row] of values.entries()) {
		if (row.unit.trim() === '' && row.quantity.trim() === '' && row.total.trim() === '') continue;
		const pair = pairSchema.safeParse(row.unit.split(':'));
		const unitQty = positiveQty(row.quantity);
		const total = parsePriceInput(row.total, exponent);
		if (!pair.success || unitQty === null || !total.ok) {
			return { ok: false, values, message: lineMessage(index + 1) };
		}
		lines.push({
			row: index + 1,
			ingredientId: pair.data[0],
			purchaseUnitId: pair.data[1],
			unitQty,
			lineCostMinor: total.minor
		});
	}
	if (lines.length === 0) return { ok: false, values, message: 'Add at least one line.' };
	return { ok: true, values, lines };
}
