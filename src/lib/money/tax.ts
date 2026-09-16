// TAX, IN BOTH MODES (spec 17, 18; invariants 1 and 7).
//
// THE AMOUNT HANDED TO THIS MODULE IS ALREADY DISCOUNTED. Discount first, then tax
// the discounted amount (invariant 7). This file never applies or reads a
// discount: a second place that decides the order of operations would be a bug.
//
// It COMPUTES AND NEVER ROUNDS. Every result is an Exact that carries the
// remainder in its denominator; the caller sums the lines at full precision and
// calls roundToMinor ONCE, on the invoice total (spec 17). A per-line round here
// is exactly the defect the three-line test in tax.test.ts exists to catch.
//
// The rate is an integer in BASIS POINTS — 825 is 8.25% — and never a fraction.
// The mode is a required argument read at calculation time from the restaurant's
// setting (on the POS, from the cached menu snapshot). There is no default: a
// default here would answer the tax-mode question for every owner who never chose.
//
// Imported as '$lib/money/tax'. index.ts does not re-export this file: this file
// imports index.ts, and a cycle in the module everything imports is not worth a
// shorter import path.
import { addExact, exact, type Exact, type Minor } from './index';

/** One list for TypeScript, the settings zod schema and the database CHECK alike. */
export const TAX_MODES = ['exclusive', 'inclusive'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

// The two modes, named from TAX_MODES rather than spelled again here.
const [EXCLUSIVE, INCLUSIVE] = TAX_MODES;

export type LineTax = { net: Exact; tax: Exact; gross: Exact };

const BASIS_POINTS_PER_WHOLE = 10_000n;

/**
 * Guard and convert a rate ONCE. `pg` returns an integer column as a number, so
 * the rate arrives as one; anything but a whole number of basis points in
 * 0..10000 is refused with a message that says so, rather than as the bare
 * RangeError BigInt() would raise on a fraction.
 */
function basisPoints(rateBp: number): bigint {
	if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > 10_000) {
		throw new TypeError('tax rate is integer basis points (825 = 8.25%), never a fraction');
	}
	return BigInt(rateBp);
}

/**
 * Tax an exact amount — a discounted line is already an Exact, so it is taxed
 * without a rounding step in the middle.
 *
 * - exclusive: the amount is the net and the tax goes on top —
 *   tax = amount × bp / 10000, gross = net + tax.
 * - inclusive: the amount already contains the tax —
 *   tax = amount × bp / (10000 + bp), net = amount × 10000 / (10000 + bp),
 *   gross = amount.
 */
export function taxOnAmount(amount: Exact, rateBp: number, mode: TaxMode): LineTax {
	const bp = basisPoints(rateBp);
	const { numerator, denominator } = exact(amount.numerator, amount.denominator);

	if (mode === EXCLUSIVE) {
		const net = exact(numerator, denominator);
		const tax = exact(numerator * bp, denominator * BASIS_POINTS_PER_WHOLE);
		return { net, tax, gross: addExact(net, tax) };
	}
	if (mode === INCLUSIVE) {
		const whole = BASIS_POINTS_PER_WHOLE + bp;
		return {
			net: exact(numerator * BASIS_POINTS_PER_WHOLE, denominator * whole),
			tax: exact(numerator * bp, denominator * whole),
			gross: exact(numerator, denominator)
		};
	}
	// An unset mode (the column is nullable until the owner chooses) fails LOUDLY.
	throw new TypeError(`tax mode must be one of ${TAX_MODES.join(', ')}; it is not set`);
}

/** The whole-amount wrapper an order line calls: taxOnAmount(exact(amount), …) and nothing else. */
export function taxOnLine(amount: Minor, rateBp: number, mode: TaxMode): LineTax {
	return taxOnAmount(exact(amount), rateBp, mode);
}
