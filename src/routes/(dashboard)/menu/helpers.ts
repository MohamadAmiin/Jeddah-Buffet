/**
 * Pure helpers for the menu page — the zod schemas, THE price parser, and the
 * item's tax-rate choice and label — in their own module so the unit project can
 * reach them. +page.server.ts imports the database client, which a plain-node
 * Vitest project cannot load; src/routes/login/helpers.ts is the precedent.
 *
 * NO MONEY ARITHMETIC ON A JAVASCRIPT NUMBER (invariant 1). A typed price is
 * converted ONCE, here, by integer string surgery that ends in BigInt() and the
 * money module's own minor() constructor. There is no floating-point step
 * anywhere between the owner's keystrokes and the bigint column. zod stays on the
 * server: nothing here is imported into a .svelte component.
 */
import { z } from 'zod';
import { minor, type Minor } from '../../../lib/money';
// $lib/money/tax by its relative path: the unit project resolves no $lib alias.
import { formatTaxRate } from '../../../lib/money/tax';

// `\d` without the u flag is ASCII-only, which is what rejects full-width digits.
const PRICE_SHAPE = /^\d+(\.\d+)?$/;

/**
 * THE parser of typed money in this application. $lib/money exports none on
 * purpose, and the formatter's round-trip parser lives only in its test file.
 * A second parser anywhere — another route, a component, a later plan — is the
 * bug this name exists to make findable.
 *
 * `signed` admits a leading minus (the ASCII hyphen or U+2212), for a modifier's
 * price delta: "No cheese" is a legitimate negative. A menu price is never
 * negative, so the default refuses it.
 */
export function parsePriceInput(
	raw: string,
	exponent: number,
	options: { signed?: boolean } = {}
): { ok: true; minor: Minor } | { ok: false; message: string } {
	if (!Number.isSafeInteger(exponent) || exponent < 0) {
		throw new RangeError(`a minor-unit exponent is a whole number, not ${String(exponent)}`);
	}
	const parsed = z.string().trim().safeParse(raw);
	if (!parsed.success || parsed.data === '') return { ok: false, message: 'Enter a price.' };

	let digits = parsed.data;
	let sign = '';
	if (options.signed && (digits.startsWith('-') || digits.startsWith('−'))) {
		sign = '-';
		digits = digits.slice(1);
	}
	if (!PRICE_SHAPE.test(digits)) {
		return {
			ok: false,
			message: 'Enter the price as digits with an optional decimal point, for example 8.50.'
		};
	}
	const [major, fraction = ''] = digits.split('.');
	if (fraction.length > exponent) {
		return {
			ok: false,
			message:
				exponent === 0
					? 'This currency has no minor units: enter a whole number.'
					: `Use at most ${exponent} digits after the decimal point.`
		};
	}
	return { ok: true, minor: minor(BigInt(sign + major + fraction.padEnd(exponent, '0'))) };
}

const TAX_RATE_CHOICE_MESSAGE = 'That tax rate no longer exists. Reload the page.';
const taxRateChoice = z.string().trim().pipe(z.uuid(TAX_RATE_CHOICE_MESSAGE));

/**
 * The item panel's tax-rate select (tasks/settings-tax-payments-receipt T-32).
 * A blank, null or absent choice is "Default" — stored as null, so the item
 * FOLLOWS the restaurant's default rate even after the owner switches it. Any
 * other value must be the uuid of a named rate, which PINS the item to that rate;
 * the menu module then checks it is live and this restaurant's. The two are
 * different choices and are never collapsed into each other. No number is
 * parsed here: a rate is a row, not a figure typed on this page.
 */
export function parseTaxRateChoice(
	raw: unknown
): { ok: true; value: string | null } | { ok: false; message: string } {
	if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
		return { ok: true, value: null };
	}
	const parsed = taxRateChoice.safeParse(raw);
	return parsed.success
		? { ok: true, value: parsed.data }
		: { ok: false, message: TAX_RATE_CHOICE_MESSAGE };
}

/**
 * The label a tile shows for an item's rate: "Default (Tax 10.00%)" while the
 * item follows the restaurant's default (or "Default (not chosen yet)" while the
 * owner has picked none), else the named rate it is pinned to, "Exempt 0.00%".
 * The percent is the money module's formatTaxRate; nothing is computed here.
 * 'Unknown rate' is a guard, not a state: listMenu returns live items only and a
 * live item never points at an archived rate (archiveTaxRate refuses `in_use`).
 */
export function itemTaxRateLabel(
	taxRateId: string | null,
	rates: ReadonlyArray<{ id: string; name: string; rateBp: number }>,
	defaultRate: { name: string; rateBp: number } | null
): string {
	if (taxRateId === null) {
		return defaultRate
			? `Default (${defaultRate.name} ${formatTaxRate(defaultRate.rateBp)})`
			: 'Default (not chosen yet)';
	}
	const rate = rates.find((candidate) => candidate.id === taxRateId);
	return rate ? `${rate.name} ${formatTaxRate(rate.rateBp)}` : 'Unknown rate';
}

// 120, not 200: the sale validator caps itemName and modifierName at 120
// (src/lib/server/orders/validate.ts), so a longer name would make every cash
// sale of that item a HARD invalid_payload landing `unrecorded`. Control
// characters are refused for the receipt: an ESC byte in a name could command
// the printer (tasks/menu-and-printing, risk "bytes that are not text").
// One rule for categories, items, modifier groups and modifiers alike.
const name = z
	.string()
	.trim()
	.min(1, 'Enter a name.')
	.max(120, 'Keep the name under 120 characters.')
	.refine(
		(v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v),
		'Remove the control characters from the name.'
	);
const id = z.uuid('That entry no longer exists. Reload the page.');
/** A blank select value is "No category" (null); anything else must be a uuid. */
export const optionalCategory = z
	.string()
	.trim()
	.transform((v) => (v === '' ? null : v))
	.pipe(z.uuid('That category no longer exists. Reload the page.').nullable());
const choices = z.coerce
	.number({ error: 'Enter a whole number of choices.' })
	.int('Enter a whole number of choices.')
	.min(0, 'Enter a whole number of choices.');

export const createCategorySchema = z.object({ name });
export const renameCategorySchema = z.object({ categoryId: id, name });
export const archiveCategorySchema = z.object({ categoryId: id });
export const createItemSchema = z.object({ categoryId: optionalCategory, name, price: z.string() });
/** A blank price on the edit form keeps the current one; a blank category moves the item to none. */
export const updateItemSchema = z.object({
	itemId: id,
	name,
	price: z.string(),
	categoryId: optionalCategory
});
export const archiveItemSchema = z.object({ itemId: id });
export const itemIdSchema = z.object({ itemId: id });
export const availabilitySchema = z.object({ itemId: id, available: z.enum(['yes', 'no']) });
export const createModifierGroupSchema = z
	.object({ name, minSelect: choices, maxSelect: choices })
	.refine((group) => group.maxSelect >= group.minSelect, {
		message: 'The most a guest may pick cannot be fewer than the least.'
	});
export const createModifierSchema = z.object({ groupId: id, name, priceDelta: z.string() });
export const linkSchema = z.object({ itemId: id, groupId: id });

export function firstMessage(error: z.ZodError): string {
	return error.issues[0]?.message ?? 'Check the form.';
}
