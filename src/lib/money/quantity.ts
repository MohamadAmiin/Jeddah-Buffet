// INGREDIENT QUANTITIES — ISOMORPHIC, bigint THOUSANDTHS of a base unit (spec 15,
// 17; invariants 1 and 7).
//
// Ingredient quantities are the one fixed-point value the schema permits:
// numeric(12,3), named *_qty. numeric(12,3) holds EXACTLY three decimals, so a
// quantity is carried here as a whole number of thousandths — 1500n is 1.500 g —
// and every sum, difference and product is exact integer arithmetic. No float
// ever touches one: a quantity is multiplied into money (recipe × average cost),
// so a float here is a float in the books.
//
// pg returns numeric as a STRING. It is parsed ONCE, by parseQty, at the boundary
// where a row is read, and written back with formatQty; nowhere else converts a
// quantity to or from text.
//
// A product of two quantities has six decimals and must come back to three.
// That is a rounding, and invariant 7 allows exactly one rounding function in the
// repository: mulQty goes through roundToMinor and unwraps the Minor brand with
// toBigInt — a quantity is not money, but the rule that rounds it is the same
// one. A second rounding helper here would be the bug spec 17 exists to prevent.
//
// Imported as '$lib/money/quantity'. It imports only ./index.
import { exact, roundToMinor, toBigInt, type Exact, type RoundingRule } from './index';

declare const QTY: unique symbol;

/** Thousandths of a base unit — 2500n is 2.500. Compile-time brand, like Minor. */
export type Qty = bigint & { readonly [QTY]: true };

export const QTY_SCALE = 1000n;

/** The numeric(12,3) bound, in thousandths: 999,999,999.999. */
export const QTY_MAX = 999_999_999_999n;

/** The ONLY constructor of a Qty. */
export function qty(value: bigint): Qty {
	if (typeof value !== 'bigint') {
		throw new TypeError('a quantity is a bigint of thousandths (2500n is 2.500), never a number');
	}
	if (value > QTY_MAX || value < -QTY_MAX) {
		throw new RangeError(`a quantity must fit numeric(12,3): ${value} thousandths is out of range`);
	}
	return value as Qty;
}

const QTY_SHAPE = /^(-?)(\d+)(?:\.(\d{1,3}))?$/;

/**
 * Parse pg's numeric text (or a form field) into thousandths. Built from the
 * digit strings — BigInt('2.5') throws, and a detour through a number would
 * round. '2' → 2000n, '0.030' → 30n, '-30.000' → -30000n.
 */
export function parseQty(text: string): Qty {
	const match = typeof text === 'string' ? QTY_SHAPE.exec(text.trim()) : null;
	if (!match) {
		throw new TypeError(
			`a quantity is digits with at most three decimals, e.g. 2.5 or 0.030 — got ${JSON.stringify(text)}`
		);
	}
	const [, sign, whole, fraction = ''] = match;
	const magnitude = BigInt(whole) * QTY_SCALE + BigInt(fraction.padEnd(3, '0'));
	return qty(sign === '-' ? -magnitude : magnitude);
}

/** Always three decimals: 2500n → '2.500', -30n → '-0.030', 0n → '0.000'. */
export function formatQty(q: Qty): string {
	const negative = q < 0n;
	const magnitude = negative ? -q : q;
	const whole = magnitude / QTY_SCALE;
	const fraction = (magnitude % QTY_SCALE).toString().padStart(3, '0');
	return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function addQty(a: Qty, b: Qty): Qty {
	return qty(a + b);
}

export function subQty(a: Qty, b: Qty): Qty {
	return qty(a - b);
}

export function negQty(a: Qty): Qty {
	return qty(-a);
}

/** Seeded with 0n, never 0: bigint + number throws at runtime. */
export function sumQty(values: readonly Qty[]): Qty {
	return qty(values.reduce<bigint>((total, value) => total + value, 0n));
}

/** a × b, back to thousandths, rounded ONCE by roundToMinor. */
export function mulQty(a: Qty, b: Qty, rule: RoundingRule): Qty {
	return qty(toBigInt(roundToMinor(exact(a * b, QTY_SCALE), rule)));
}

/** The quantity as an exact rational number of base units. */
export function qtyExact(q: Qty): Exact {
	return exact(q, QTY_SCALE);
}
