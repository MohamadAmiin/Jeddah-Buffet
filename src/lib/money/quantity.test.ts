import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUNDING_RULE } from './index';
import {
	QTY_MAX,
	addQty,
	formatQty,
	mulQty,
	negQty,
	parseQty,
	qty,
	subQty,
	sumQty,
	type Qty
} from './quantity';

// MANDATORY (spec 29 — money arithmetic and rounding): every ingredient cost is a
// quantity multiplied by an average, so a quantity that parses, prints or rounds
// wrongly is a wrong cost.

// The seeded LCG idiom of tax.test.ts and order-totals.test.ts.
function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) & 0xffffffffn;
		return state;
	};
}

describe('parseQty', () => {
	it('parses whole numbers, decimals, leading zeros, negatives and surrounding space', () => {
		expect(parseQty('2')).toBe(2000n);
		expect(parseQty('2.5')).toBe(2500n);
		expect(parseQty('0.030')).toBe(30n);
		expect(parseQty('-30.000')).toBe(-30000n);
		expect(parseQty('  7.25  ')).toBe(7250n);
	});

	it.each(['1,5', '1e3', '1.2345', '', ' ', '-', '1 000', '.5', '5.'])(
		'refuses %j with a message stating the accepted shape',
		(text) => {
			expect(() => parseQty(text)).toThrow(TypeError);
			expect(() => parseQty(text)).toThrow(/digits with at most three decimals/);
		}
	);

	it('refuses a value outside numeric(12,3)', () => {
		expect(() => parseQty('1000000000')).toThrow(RangeError);
	});
});

describe('formatQty', () => {
	it('always prints three decimals with a leading zero and sign', () => {
		expect(formatQty(qty(2500n))).toBe('2.500');
		expect(formatQty(qty(-30n))).toBe('-0.030');
		expect(formatQty(qty(0n))).toBe('0.000');
		expect(formatQty(qty(QTY_MAX))).toBe('999999999.999');
	});

	it('round-trips through parseQty for 1,000 seeded values across ±QTY_MAX', () => {
		const next = generator(20260929n);
		for (let i = 0; i < 1000; i++) {
			// Two 32-bit draws make a value wide enough to span numeric(12,3).
			const wide = (next() << 32n) | next();
			const magnitude = wide % (QTY_MAX + 1n);
			const q = qty((next() >> 16n) % 2n === 0n ? magnitude : -magnitude);
			expect(parseQty(formatQty(q))).toBe(q);
		}
	});
});

describe('qty and the arithmetic', () => {
	it('qty() refuses a number and anything outside ±QTY_MAX', () => {
		expect(() => qty(QTY_MAX + 1n)).toThrow(RangeError);
		expect(() => qty(-QTY_MAX - 1n)).toThrow(RangeError);
		expect(() => qty(1 as unknown as bigint)).toThrow(TypeError);
		expect(qty(QTY_MAX)).toBe(QTY_MAX);
	});

	it('adds, subtracts, negates and sums exactly', () => {
		const a = qty(1500n);
		const b = qty(250n);
		expect(addQty(a, b)).toBe(1750n);
		expect(subQty(b, a)).toBe(-1250n);
		expect(negQty(a)).toBe(-1500n);
		expect(sumQty([])).toBe(0n);
		expect(sumQty([a, b, negQty(b)])).toBe(1500n);
	});

	it('mulQty rounds once, half away from zero', () => {
		// 2.5 × 1000.000 = 2500.000
		expect(mulQty(qty(2500n), qty(1000000n), ROUNDING_RULE)).toBe(2500000n);
		// 0.333 × 0.333 = 0.110889 → 0.111
		expect(mulQty(qty(333n), qty(333n), ROUNDING_RULE)).toBe(111n);
		// −0.333 × 0.333 = −0.110889 → −0.111
		expect(mulQty(qty(-333n), qty(333n), ROUNDING_RULE)).toBe(-111n);
		// 0.5 × 0.001 = 0.0005 → a tie, away from zero: 0.001
		const tie: Qty = mulQty(qty(500n), qty(1n), ROUNDING_RULE);
		expect(tie).toBe(1n);
	});
});

describe('quantity source tripwire', () => {
	it('uses no float, no Number(), no Math. and imports only ./index', () => {
		const source = readFileSync(new URL('./quantity.ts', import.meta.url), 'utf8');
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		// Import specifiers are read before string literals are blanked out.
		const froms = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		expect(froms).toEqual(['./index']);
		// A decimal inside a message string is not arithmetic; blank strings out.
		const bare = code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
		expect(bare).not.toMatch(/\bNumber\(/);
		expect(bare).not.toMatch(/\bparseFloat\b/);
		expect(bare).not.toMatch(/\btoFixed\b/);
		expect(bare).not.toMatch(/\bMath\./);
		expect(bare).not.toMatch(/\b\d+\.\d+\b/);
	});
});
