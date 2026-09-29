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
import { formatQty, type Qty } from '../../../lib/money/quantity';

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
