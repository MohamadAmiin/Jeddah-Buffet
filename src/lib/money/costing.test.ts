import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUNDING_RULE, exact, exactEquals, minor, type Minor } from './index';
import { qty } from './quantity';
import {
	applyAtAverage,
	applyInbound,
	applyReversal,
	dishMargin,
	extendCost,
	recipeCostExact,
	unitCostMicro,
	valueAt,
	type Applied,
	type StockState
} from './costing';

// MANDATORY (spec 29 — money arithmetic and rounding). Quantities are
// thousandths (10,000.000 g is 10000000n), values are cents, averages are
// micro-cents per base unit. Every expected number was worked by hand in
// tasks/inventory-cogs/03-costing.md; a disagreement means the code is wrong.

const R = ROUNDING_RULE;

function s(q: bigint, value: bigint, avgMicro: bigint): StockState {
	return { qty: qty(q), value: minor(value), avgMicro };
}

function plain(a: Applied) {
	return {
		qty: a.state.qty as bigint,
		value: a.state.value as bigint,
		avgMicro: a.state.avgMicro,
		cost: a.costMinor as bigint,
		reval: a.revaluationMinor as bigint
	};
}

describe('the movement rules — worked cases', () => {
	it('(a) spec 16 in grams: 10 kg at $50 + 10 kg at $60 → $5.50/kg; 150 g out costs 82', () => {
		const a1 = applyInbound(s(10000000n, 5000n, 500000n), qty(10000000n), minor(6000n), R);
		expect(plain(a1)).toEqual({
			qty: 20000000n,
			value: 11000n,
			avgMicro: 550000n,
			cost: 6000n,
			reval: 0n
		});
		const a2 = applyAtAverage(a1.state, qty(150000n), 'out', R);
		// valueAt(19,850 g, 0.55¢/g) = 10,917.5 → 10,918.
		expect(plain(a2)).toEqual({
			qty: 19850000n,
			value: 10918n,
			avgMicro: 550000n,
			cost: -82n,
			reval: 0n
		});
	});

	it('(b) three buns for 100: the three sales cost 33, 34, 33 and leave zero value', () => {
		const bought = applyInbound(s(0n, 0n, 0n), qty(3000n), minor(100n), R);
		expect(plain(bought)).toEqual({
			qty: 3000n,
			value: 100n,
			avgMicro: 33333333n,
			cost: 100n,
			reval: 0n
		});
		let st = bought.state;
		const costs: bigint[] = [];
		for (let i = 0; i < 3; i++) {
			const a = applyAtAverage(st, qty(1000n), 'out', R);
			costs.push(a.costMinor);
			st = a.state;
		}
		expect(costs).toEqual([-33n, -34n, -33n]);
		expect(st.qty).toBe(0n);
		expect(st.value).toBe(0n);
	});

	it('(c) sugar, 5 kg for 200, drained 2 g at a time: every cent leaves, none is stranded', () => {
		let st = applyInbound(s(0n, 0n, 0n), qty(5000000n), minor(200n), R).state;
		expect(st.avgMicro).toBe(40000n);
		let total = 0n;
		for (let i = 0; i < 2500; i++) {
			const a = applyAtAverage(st, qty(2000n), 'out', R);
			expect(a.costMinor <= 0n).toBe(true);
			total += a.costMinor;
			st = a.state;
		}
		expect(st).toEqual({ qty: 0n, value: 0n, avgMicro: 40000n });
		expect(total).toBe(-200n);
	});

	it('(d) sold into negative stock, then the delivery re-values it at its own cost', () => {
		const sold = applyAtAverage(s(0n, 0n, 0n), qty(30000000n), 'out', R);
		expect(plain(sold)).toEqual({ qty: -30000000n, value: 0n, avgMicro: 0n, cost: 0n, reval: 0n });
		const delivered = applyInbound(sold.state, qty(50000000n), minor(25000n), R);
		expect(plain(delivered)).toEqual({
			qty: 20000000n,
			value: 10000n,
			avgMicro: 500000n,
			cost: 25000n,
			reval: -15000n
		});
	});

	it('(e) a reversal after consumption keeps the average and revalues the gap', () => {
		const a1 = applyInbound(s(20000000n, 2000n, 100000n), qty(5000000n), minor(5000n), R);
		expect(plain(a1)).toMatchObject({ qty: 25000000n, value: 7000n, avgMicro: 280000n });
		const a2 = applyAtAverage(a1.state, qty(15000000n), 'out', R);
		expect(plain(a2)).toMatchObject({ value: 2800n, cost: -4200n });
		const a3 = applyReversal(a2.state, qty(5000000n), minor(5000n), R);
		expect(plain(a3)).toEqual({
			qty: 5000000n,
			value: 1400n,
			avgMicro: 280000n,
			cost: -5000n,
			reval: 3600n
		});
	});

	it('(f) a reversal into otherwise-empty stock returns to zero without throwing', () => {
		const a1 = applyInbound(s(0n, 0n, 0n), qty(10000000n), minor(6000n), R);
		expect(plain(a1)).toMatchObject({ value: 6000n, avgMicro: 600000n });
		const a2 = applyReversal(a1.state, qty(10000000n), minor(6000n), R);
		expect(plain(a2)).toEqual({ qty: 0n, value: 0n, avgMicro: 600000n, cost: -6000n, reval: 0n });
	});

	it('(g) a count surplus from negative stock brings the value up to the target', () => {
		const a = applyAtAverage(s(-10000000n, -5000n, 500000n), qty(15000000n), 'in', R);
		expect(plain(a)).toEqual({
			qty: 5000000n,
			value: 2500n,
			avgMicro: 500000n,
			cost: 7500n,
			reval: 0n
		});
	});

	it('never mutates its input', () => {
		const input = s(1000n, 100n, 100000000n);
		const copy = { ...input };
		applyInbound(input, qty(1000n), minor(50n), R);
		applyAtAverage(input, qty(500n), 'out', R);
		applyReversal(input, qty(500n), minor(10n), R);
		expect(input).toEqual(copy);
	});
});

describe('guards', () => {
	it('refuse a non-positive quantity or a negative cost', () => {
		expect(() => applyInbound(s(0n, 0n, 0n), qty(0n), minor(1n), R)).toThrow(TypeError);
		expect(() => applyInbound(s(0n, 0n, 0n), qty(1n), minor(-1n), R)).toThrow(TypeError);
		expect(() => applyAtAverage(s(0n, 0n, 0n), qty(-1n), 'out', R)).toThrow(TypeError);
		expect(() => applyAtAverage(s(0n, 0n, 0n), qty(0n), 'in', R)).toThrow(TypeError);
		expect(() => applyReversal(s(5n, 5n, 0n), qty(1n), minor(-1n), R)).toThrow(TypeError);
		expect(() => unitCostMicro(minor(100n), qty(0n), R)).toThrow(RangeError);
	});

	it('valueAt is zero exactly at zero quantity', () => {
		expect(valueAt(qty(0n), 999999999n, R)).toBe(0n);
		expect(valueAt(qty(1000000n), 550000n, R)).toBe(550n);
	});
});

// The seeded LCG idiom of tax.test.ts and order-totals.test.ts.
function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) & 0xffffffffn;
		return state;
	};
}
function between(next: () => bigint, lo: bigint, hi: bigint): bigint {
	return lo + (next() % (hi - lo + 1n));
}

describe('the movement rules — MANDATORY property test (spec 29)', () => {
	it('conserves value and keeps the three invariants after every step of 5,000 sequences', () => {
		const next = generator(20260928n);
		const kinds = { inbound: 0, out: 0, in: 0, reversal: 0 };
		for (let seq = 0; seq < 5000; seq++) {
			let st = s(0n, 0n, 0n);
			const steps = between(next, 1n, 40n);
			for (let step = 0n; step < steps; step++) {
				// The HIGH bits choose the kind: the low bit of this LCG alternates.
				const kind = (['inbound', 'out', 'in', 'reversal'] as const)[Number((next() >> 16n) % 4n)];
				kinds[kind]++;
				const q = qty(between(next, 1n, 50000000n));
				const cost: Minor = minor(between(next, 0n, 100000n));
				const a =
					kind === 'inbound'
						? applyInbound(st, q, cost, R)
						: kind === 'reversal'
							? applyReversal(st, q, cost, R)
							: applyAtAverage(st, q, kind, R);
				const n = a.state;
				for (const v of [n.qty, n.value, n.avgMicro, a.costMinor, a.revaluationMinor]) {
					expect(typeof v).toBe('bigint');
				}
				expect(n.avgMicro >= 0n).toBe(true);
				if (n.qty === 0n) expect(n.value).toBe(0n);
				if (n.qty > 0n) expect(n.value >= 0n).toBe(true);
				expect(n.value - st.value).toBe(a.costMinor + a.revaluationMinor);
				if (kind === 'out') expect(a.costMinor <= 0n).toBe(true);
				if (kind === 'in') expect(a.costMinor >= 0n).toBe(true);
				st = n;
			}
		}
		// Every kind was exercised many times, so the property is not vacuous.
		for (const count of Object.values(kinds)) expect(count).toBeGreaterThan(10000);
	});
});

describe('costing source tripwire', () => {
	it('uses no float, no Number(), no Math. and imports only ./index, ./quantity and ./tax', () => {
		const source = readFileSync(new URL('./costing.ts', import.meta.url), 'utf8');
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		const froms = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		for (const from of froms) expect(['./index', './quantity', './tax']).toContain(from);
		const bare = code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
		expect(bare).not.toMatch(/\bNumber\(/);
		expect(bare).not.toMatch(/\bparseFloat\b/);
		expect(bare).not.toMatch(/\btoFixed\b/);
		expect(bare).not.toMatch(/\bMath\./);
		expect(bare).not.toMatch(/\b\d+\.\d+\b/);
	});
});

describe('recipe cost, dish margin and extended cost (T-11) — MANDATORY (spec 29)', () => {
	// Spec 16's burger: 150 g meat at 0.55¢/g, 1 bun at 25¢, 1 cheese at 12¢.
	const burger = recipeCostExact([
		{ qty: qty(150000n), avgMicro: 550000n },
		{ qty: qty(1000n), avgMicro: 25000000n },
		{ qty: qty(1000n), avgMicro: 12000000n }
	]);

	it('extendCost: purchase units × unit cost, rounded once', () => {
		expect(extendCost(qty(2500n), minor(550n), R)).toBe(1375n);
		expect(extendCost(qty(333n), minor(100n), R)).toBe(33n);
		expect(() => extendCost(qty(-1n), minor(100n), R)).toThrow(TypeError);
		expect(() => extendCost(qty(1n), minor(-100n), R)).toThrow(TypeError);
	});

	it('recipeCostExact carries the cost exactly: 82.5 + 25 + 12 = 119.5', () => {
		expect(exactEquals(burger, exact(239n, 2n))).toBe(true);
	});

	it('dishMargin, tax EXCLUSIVE: $8.00 at 10% → net 800, cost 120, margin 680', () => {
		expect(
			dishMargin(
				{ priceMinor: minor(800n), taxRateBp: 1000, taxMode: 'exclusive', costExact: burger },
				R
			)
		).toEqual({ costMinor: 120n, netPriceMinor: 800n, marginMinor: 680n });
	});

	it('dishMargin, tax INCLUSIVE: $8.80 at 10% → net 800, cost 120, margin 680', () => {
		expect(
			dishMargin(
				{ priceMinor: minor(880n), taxRateBp: 1000, taxMode: 'inclusive', costExact: burger },
				R
			)
		).toEqual({ costMinor: 120n, netPriceMinor: 800n, marginMinor: 680n });
	});

	it('dishMargin, inclusive 20% on 999: net 832.5 → 833, margin 713 (net − cost, not rounded again)', () => {
		const m = dishMargin(
			{ priceMinor: minor(999n), taxRateBp: 2000, taxMode: 'inclusive', costExact: burger },
			R
		);
		expect(m).toEqual({ costMinor: 120n, netPriceMinor: 833n, marginMinor: 713n });
		expect(m.netPriceMinor - m.costMinor).toBe(m.marginMinor);
	});

	it('dishMargin with no tax mode throws, as taxOnLine does', () => {
		expect(() =>
			dishMargin(
				{ priceMinor: minor(800n), taxRateBp: 1000, taxMode: null as never, costExact: burger },
				R
			)
		).toThrow(TypeError);
	});

	it('the average display rule: one kilogram of a gram ingredient at 0.55¢/g is $5.50', () => {
		expect(valueAt(qty(1000000n), 550000n, R)).toBe(550n);
	});
});
