import { describe, it, expect } from 'vitest';
import {
	add,
	addExact,
	allocate,
	exact,
	exactEquals,
	minor,
	multiplyByInteger,
	negate,
	roundToMinor,
	ROUNDING_RULE,
	subtract,
	sum,
	sumExact,
	toBigInt,
	type Minor
} from './index';

// A seeded linear-congruential generator (Numerical Recipes constants), in bigint,
// so a failing generated case reproduces exactly. No property-testing library:
// adding one is a decision nobody has made.
function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) % 4294967296n;
		return state;
	};
}

/** A uniform-enough bigint in [lo, hi]. */
function between(next: () => bigint, lo: bigint, hi: bigint): bigint {
	return lo + (next() % (hi - lo + 1n));
}

describe('allocate', () => {
	// MANDATORY (spec 29 — money arithmetic).
	it('splits 100 three ways as 34, 33, 33 and loses nothing', () => {
		const shares = allocate(minor(100n), 3);
		expect(shares).toEqual([34n, 33n, 33n]);
		expect(sum(shares)).toBe(100n);
	});

	// MANDATORY (spec 29): a refund is the reverse of the sale.
	it('splits −100 three ways as −34, −33, −33, symmetrically', () => {
		const shares = allocate(minor(-100n), 3);
		expect(shares).toEqual([-34n, -33n, -33n]);
		expect(sum(shares)).toBe(-100n);
	});

	// MANDATORY (spec 29 — property): allocation never loses or invents a minor unit.
	it('sums back to the total exactly, in exactly `parts` shares, for 500 generated cases', () => {
		const next = generator(20260915n);
		for (let i = 0; i < 500; i++) {
			const total = minor(between(next, -10_000_000n, 10_000_000n));
			const parts = Number(between(next, 1n, 20n));

			const shares = allocate(total, parts);

			expect(shares).toHaveLength(parts);
			expect(sum(shares)).toBe(total);
			// No share strays more than one minor unit from any other.
			const sorted = [...shares].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
			expect(sorted[sorted.length - 1] - sorted[0] <= 1n).toBe(true);
		}
	});

	it('refuses zero parts and a fractional number of parts', () => {
		expect(() => allocate(minor(100n), 0)).toThrow(RangeError);
		expect(() => allocate(minor(100n), 1.5)).toThrow(RangeError);
	});
});

describe('roundToMinor — THE rounding function', () => {
	// MANDATORY (spec 29 — rounding): the tie cases pin both rules.
	it('rounds an exact half by the rule it is given', () => {
		expect(roundToMinor(exact(5n, 2n), 'half-up')).toBe(3n); // 2.5 -> 3
		expect(roundToMinor(exact(5n, 2n), 'half-even')).toBe(2n); // 2.5 -> 2
		expect(roundToMinor(exact(7n, 2n), 'half-even')).toBe(4n); // 3.5 -> 4
		expect(roundToMinor(exact(-5n, 2n), 'half-up')).toBe(-3n); // ties AWAY from zero
		expect(roundToMinor(exact(-5n, 2n), 'half-even')).toBe(-2n);
	});

	// MANDATORY (spec 29): a non-tie does not care which rule is in force.
	it('rounds a non-tie to the nearer neighbour under either rule', () => {
		for (const rule of ['half-up', 'half-even'] as const) {
			expect(roundToMinor(exact(1992375n, 10000n), rule)).toBe(199n); // 199.2375
			expect(roundToMinor(exact(-1992375n, 10000n), rule)).toBe(-199n);
			expect(roundToMinor(exact(1997500n, 10000n), rule)).toBe(200n); // 199.75
			expect(roundToMinor(exact(850n), rule)).toBe(850n);
		}
	});

	it('is the recorded answer to open decision 3: half away from zero', () => {
		expect(ROUNDING_RULE).toBe('half-up');
	});

	it('refuses a rule it does not know', () => {
		expect(() => roundToMinor(exact(5n, 2n), 'up' as never)).toThrow(TypeError);
	});
});

describe('exact', () => {
	it('canonicalises: reduced, the sign on the numerator, a zero denominator refused', () => {
		expect(exact(2000n, 10000n)).toEqual({ numerator: 1n, denominator: 5n });
		expect(exact(1n, -2n)).toEqual({ numerator: -1n, denominator: 2n });
		expect(exact(0n, 7n)).toEqual({ numerator: 0n, denominator: 1n });
		expect(exact(850n)).toEqual({ numerator: 850n, denominator: 1n });
		expect(() => exact(1n, 0n)).toThrow(RangeError);
	});

	it('adds without letting the denominator grow', () => {
		expect(addExact(exact(1n, 3n), exact(1n, 6n))).toEqual(exact(1n, 2n));
		expect(exactEquals(addExact(exact(1n, 3n), exact(1n, 6n)), exact(1n, 2n))).toBe(true);
		expect(sumExact([])).toEqual(exact(0n));
		expect(sumExact([exact(1n, 4n), exact(1n, 4n), exact(1n, 2n)])).toEqual(exact(1n));
	});

	it('compares by value, even against a hand-built unreduced Exact', () => {
		expect(exactEquals({ numerator: 2n, denominator: 4n }, exact(1n, 2n))).toBe(true);
		expect(exactEquals(exact(1n, 3n), exact(1n, 2n))).toBe(false);
	});
});

describe('whole-unit arithmetic', () => {
	it('adds, subtracts, negates, sums and multiplies in bigint', () => {
		expect(add(minor(850n), minor(150n))).toBe(1000n);
		expect(subtract(minor(850n), minor(1000n))).toBe(-150n);
		expect(negate(minor(850n))).toBe(-850n);
		expect(sum([])).toBe(0n);
		expect(multiplyByInteger(minor(850n), 3n)).toBe(2550n);
		expect(toBigInt(minor(850n))).toBe(850n);
	});

	it('refuses a number where money belongs', () => {
		expect(() => minor(850 as unknown as bigint)).toThrow(TypeError);
	});

	it('brands ASSIGNMENT, not arithmetic', () => {
		const a = minor(850n);
		const b = minor(850n);
		// @ts-expect-error — a bare bigint is not a Minor; it must come through minor().
		const assigned: Minor = a + b;
		// @ts-expect-error — add takes Minor, and 850n is a plain bigint.
		const added = add(850n, 850n);
		// At runtime both are ordinary bigints; the guard above is the type checker's.
		expect(assigned).toBe(1700n);
		expect(added).toBe(1700n);
	});
});
