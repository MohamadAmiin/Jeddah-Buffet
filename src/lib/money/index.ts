// THE MONEY CORE — ISOMORPHIC, integer minor units in bigint (spec 17; invariants
// 1 and 7).
//
// Imported by src/lib/server/**, by src/lib/pos/** and by src/routes/(pos)/**, so
// it imports NOTHING: no sibling, no $lib/server, no $app, no package and no node:
// builtin. Pure TypeScript and bigint.
//
// Money is a whole number of minor units: $8.50 is 850. No floating point touches
// a value here, and exactly ONE function in the repository turns a fractional
// minor unit into a whole one — roundToMinor, below. A second rounding helper
// anywhere is a bug.
//
// A bigint never crosses JSON: JSON.stringify throws on one. An amount leaving
// through an API or entering an audit details object is converted with
// .toString() at that boundary — never widened to a number.

declare const MINOR: unique symbol;

/**
 * A whole number of minor units — 850n is $8.50. The brand is compile-time only:
 * it blocks ASSIGNMENT of a plain bigint (or a number) where money is required,
 * so a value has to come back through minor() or one of the functions below. It
 * does not block raw arithmetic: `a + b` on two Minor values type-checks and
 * yields a plain bigint, which then cannot be assigned back to a Minor.
 */
export type Minor = bigint & { readonly [MINOR]: true };

/** The ONLY constructor of a Minor. */
export function minor(value: bigint): Minor {
	if (typeof value !== 'bigint') {
		throw new TypeError('money is a bigint of minor units (850n is $8.50), never a number');
	}
	return value as Minor;
}

/** Unwrap a Minor for a drizzle bigint({ mode: 'bigint' }) column. */
export function toBigInt(value: Minor): bigint {
	return value;
}

export function add(a: Minor, b: Minor): Minor {
	return minor(a + b);
}

export function subtract(a: Minor, b: Minor): Minor {
	return minor(a - b);
}

/** Seeded with 0n, never 0: bigint + number throws at RUNTIME, not at compile time. */
export function sum(values: readonly Minor[]): Minor {
	return minor(values.reduce<bigint>((total, value) => total + value, 0n));
}

export function negate(a: Minor): Minor {
	return minor(-a);
}

/** Quantity × unit price. `count` is a bigint because bigint * number throws. */
export function multiplyByInteger(amount: Minor, count: bigint): Minor {
	return minor(amount * count);
}

/**
 * An EXACT rational amount of minor units. Tax is carried at full precision per
 * line and rounded once, on the invoice total (spec 17), so a line's tax is an
 * Exact, not a Minor.
 */
export type Exact = { readonly numerator: bigint; readonly denominator: bigint };

function abs(value: bigint): bigint {
	return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
	let x = abs(a);
	let y = abs(b);
	while (y !== 0n) {
		[x, y] = [y, x % y];
	}
	return x;
}

/**
 * The canonical form: a positive denominator, the sign on the numerator, and both
 * divided by their greatest common divisor. Reducing is not tidiness —
 * a/b + c/d = (ad + cb)/(bd), so twenty unreduced lines over 10000n would carry a
 * denominator of 10000n ** 20n — and it is what makes structural equality valid.
 */
export function exact(numerator: bigint, denominator: bigint = 1n): Exact {
	if (denominator === 0n) {
		throw new RangeError('an exact amount cannot have a zero denominator');
	}
	const sign = denominator < 0n ? -1n : 1n;
	const divisor = gcd(numerator, denominator);
	return {
		numerator: (sign * numerator) / divisor,
		denominator: (sign * denominator) / divisor
	};
}

export function addExact(a: Exact, b: Exact): Exact {
	return exact(
		a.numerator * b.denominator + b.numerator * a.denominator,
		a.denominator * b.denominator
	);
}

export function sumExact(values: readonly Exact[]): Exact {
	return values.reduce((total, value) => addExact(total, value), exact(0n));
}

/** Equality of value. Both sides are re-canonicalised, so a hand-built Exact compares correctly too. */
export function exactEquals(a: Exact, b: Exact): boolean {
	const x = exact(a.numerator, a.denominator);
	const y = exact(b.numerator, b.denominator);
	return x.numerator === y.numerator && x.denominator === y.denominator;
}

export type RoundingRule = 'half-up' | 'half-even';

/**
 * THE rounding function: the only place in the repository where a fractional
 * minor unit becomes a whole one. bigint only — truncate toward zero, then compare
 * twice the remainder with the denominator.
 *
 * On an exact tie, 'half-up' goes AWAY FROM ZERO, so −0.5 becomes −1 and a
 * reversing entry cancels the entry it reverses exactly; 'half-even' goes to the
 * even neighbour. Anything that is not a tie rounds to the nearer neighbour under
 * either rule.
 *
 * `rule` is REQUIRED, with no default: a default parameter is how an open decision
 * gets answered silently, and it would hide every call site from grep. Pass
 * ROUNDING_RULE.
 */
export function roundToMinor(value: Exact, rule: RoundingRule): Minor {
	if (rule !== 'half-up' && rule !== 'half-even') {
		throw new TypeError(`unknown rounding rule: ${String(rule)}`);
	}
	const { numerator, denominator } = exact(value.numerator, value.denominator);
	const quotient = numerator / denominator; // truncates toward zero
	const remainder = numerator - quotient * denominator; // carries the numerator's sign
	const twice = 2n * abs(remainder);
	if (twice < denominator) return minor(quotient);

	const awayFromZero = quotient + (numerator < 0n ? -1n : 1n);
	if (twice > denominator || rule === 'half-up') return minor(awayFromZero);
	// An exact tie under 'half-even': the even neighbour.
	return minor(quotient % 2n === 0n ? quotient : awayFromZero);
}

/**
 * Spec 33 open decision 3's rounding answer, recorded by T-03 of
 * tasks/pos-access-and-menu on 2026-09-15 in CLAUDE.md, "Decisions already made":
 * tax carried at full precision per line, rounded ONCE on the invoice total, a tie
 * going half AWAY FROM ZERO. The user accepted it in the words "Yes, all defaults
 * (Recommended)". Every call site passes this constant. Changing it is a
 * DECISION, not a refactor: it changes every total recorded from then on.
 */
export const ROUNDING_RULE: RoundingRule = 'half-up';

/**
 * Split `total` into `parts` shares that sum back to it EXACTLY — largest
 * remainder: each share gets the truncated base, and one minor unit carrying the
 * remainder's SIGN goes to each of the first |remainder| shares. 100n across 3 is
 * [34n, 33n, 33n]; −100n across 3 is [−34n, −33n, −33n], because a refund is the
 * reverse of the sale. There is no weighted variant: that belongs to the
 * split-bill task that needs one.
 */
export function allocate(total: Minor, parts: number): Minor[] {
	if (!Number.isInteger(parts) || parts < 1) {
		throw new RangeError('allocate needs a whole number of parts, at least 1');
	}
	const count = BigInt(parts);
	const base = total / count; // truncates toward zero
	const remainder = total - base * count;
	const unit = remainder < 0n ? -1n : 1n;
	const extra = abs(remainder);
	return Array.from({ length: parts }, (_, index) =>
		minor(BigInt(index) < extra ? base + unit : base)
	);
}
