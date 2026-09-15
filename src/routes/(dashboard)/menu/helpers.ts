/**
 * Pure helpers for the menu page — the zod schemas, THE price parser and the
 * tax-rate label — in their own module so the unit project can reach them.
 * +page.server.ts imports the database client, which a plain-node Vitest project
 * cannot load; src/routes/login/helpers.ts is the precedent.
 *
 * NO MONEY ARITHMETIC ON A JAVASCRIPT NUMBER (invariant 1). A typed price is
 * converted ONCE, here, by integer string surgery that ends in BigInt() and the
 * money module's own minor() constructor. There is no floating-point step
 * anywhere between the owner's keystrokes and the bigint column. zod stays on the
 * server: nothing here is imported into a .svelte component.
 */
import { z } from 'zod';
import { minor, type Minor } from '../../../lib/money';

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

/**
 * "8.25%" for 825 basis points, "restaurant rate" for null. String surgery on the
 * integer's digits, so the page renders a label and computes nothing.
 */
export function formatTaxRate(bp: number | null): string {
	if (bp === null) return 'restaurant rate';
	const digits = String(bp).padStart(3, '0');
	const whole = digits.slice(0, -2);
	const hundredths = digits.slice(-2).replace(/0+$/, '');
	return hundredths ? `${whole}.${hundredths}%` : `${whole}%`;
}

const RATE_MESSAGE = 'The tax rate is whole basis points from 0 to 10000 — 825 means 8.25%.';
const basisPoints = z.coerce
	.number({ error: RATE_MESSAGE })
	.int(RATE_MESSAGE)
	.min(0, RATE_MESSAGE)
	.max(10000, RATE_MESSAGE);

/** A blank rate means "inherit the restaurant's rate", which is stored as null. */
export function parseOptionalRate(
	raw: unknown
): { ok: true; value: number | null } | { ok: false; message: string } {
	if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
		return { ok: true, value: null };
	}
	const parsed = basisPoints.safeParse(typeof raw === 'string' ? raw.trim() : raw);
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: RATE_MESSAGE };
}

const name = z
	.string()
	.trim()
	.min(1, 'Enter a name.')
	.max(200, 'Keep the name under 200 characters.');
const id = z.uuid('That entry no longer exists. Reload the page.');
const choices = z.coerce
	.number({ error: 'Enter a whole number of choices.' })
	.int('Enter a whole number of choices.')
	.min(0, 'Enter a whole number of choices.');

export const createCategorySchema = z.object({ name });
export const createItemSchema = z.object({ categoryId: id, name, price: z.string() });
/** A blank price on the edit form keeps the current one. */
export const updateItemSchema = z.object({ itemId: id, name, price: z.string() });
export const archiveItemSchema = z.object({ itemId: id });
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
