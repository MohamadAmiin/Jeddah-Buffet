// THE MONEY FORMATTER — ISOMORPHIC, like the rest of src/lib/money (spec 17;
// invariants 1 and 7).
//
// It RENDERS AND NEVER ROUNDS: it shows the exact Minor it is handed. A value that
// needed rounding was rounded once, by roundToMinor, before it got here. The
// digits come from integer string surgery on the bigint — never from widening it
// to a floating-point number, which every locale-aware or fixed-decimal helper
// would do.
//
// THE SCREEN RULE, for every UI that shows money: it renders in --font-mono with
// tabular-nums, right-aligned — in Tailwind, `font-mono tabular-nums text-right`.
// The formatter owns the SIGN — a leading U+2212 MINUS SIGN, never a hyphen and
// never accounting parentheses. The component owns the COLOUR — `text-danger` on a
// negative. This module returns a string, never markup and never a class name.
import type { Minor } from './index';

export type MoneyFormat = { code: string; exponent: number };

/**
 * Spec 33 open decision 4's answer, recorded by T-03 of tasks/pos-access-and-menu
 * on 2026-09-15 in CLAUDE.md, "Decisions already made": USD (ISO 4217), minor-unit
 * exponent 2 — the user's words, "USD — 2 decimals". One currency in the MVP
 * (spec 17), so one entry. It is a table rather than a constant so the settings
 * form can refuse a code this formatter cannot render.
 */
export const SUPPORTED_CURRENCIES: Record<string, MoneyFormat> = {
	USD: { code: 'USD', exponent: 2 }
};

// A PRESENTATION CHOICE made by T-35, not a spec rule: spec 17 and spec 33 say
// nothing about numeral formatting, and this is the convention the rest of the
// English-language UI reads in. Named constants, so changing it is one line.
const DECIMAL_POINT = '.';
const GROUP_SEPARATOR = ',';
const MINUS_SIGN = '−'; // U+2212 MINUS SIGN, never the U+002D hyphen
const NO_BREAK_SPACE = ' ';

/** The recorded format for `code`; an unknown code is a RangeError, never a fallback. */
export function moneyFormatFor(code: string): MoneyFormat {
	const format = Object.hasOwn(SUPPORTED_CURRENCIES, code) ? SUPPORTED_CURRENCIES[code] : null;
	if (!format) throw new RangeError(`unsupported currency: ${code}`);
	return format;
}

/**
 * "1,234.56" and "−8.50" — for a column of money. `format` is REQUIRED: a default
 * would answer the currency question silently.
 *
 * The sign is taken from `amount < 0n` and the digits from the absolute value:
 * String(-850n) carries a hyphen, and (-850n) % 100n is -50n, so either shortcut
 * would leak a stray sign into the output.
 */
export function formatAmount(amount: Minor, format: MoneyFormat): string {
	const { exponent } = format;
	if (!Number.isSafeInteger(exponent) || exponent < 0) {
		throw new RangeError(`a minor-unit exponent is a whole number, not ${String(exponent)}`);
	}
	const negative = amount < 0n;
	const magnitude: bigint = negative ? -amount : amount;
	const scale = 10n ** BigInt(exponent);

	const major = (magnitude / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
	const body =
		exponent === 0
			? major
			: major + DECIMAL_POINT + (magnitude % scale).toString().padStart(exponent, '0');
	return negative ? MINUS_SIGN + body : body;
}

/**
 * "1,234.56 USD" — for an amount standing alone. The code goes AFTER the number,
 * behind a no-break space, so it cannot wrap onto its own line and a column of
 * amounts stays aligned on its digits with no per-currency symbol table.
 */
export function formatMoney(amount: Minor, format: MoneyFormat): string {
	return formatAmount(amount, format) + NO_BREAK_SPACE + format.code;
}
