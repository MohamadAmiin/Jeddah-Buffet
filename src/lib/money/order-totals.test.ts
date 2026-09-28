import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ROUNDING_RULE,
	exact,
	minor,
	roundToMinor,
	subtract,
	type Minor,
	type RoundingRule
} from './index';
import { TAX_MODES, type TaxMode } from './tax';
import {
	computeOrderTotals,
	serializeTotals,
	totalsEqual,
	type OrderTotals,
	type TotalsLine
} from './order-totals';
import type { SaleCompletePayload } from '../sync-ops/index';

// The seeded LCG idiom of tax.test.ts and index.test.ts. Two seeds, one for
// each property test (order-totals cases and per-line coverage).
function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) & 0xffffffffn;
		return state;
	};
}
function between(next: () => bigint, lo: bigint, hi: bigint): bigint {
	const span = hi - lo + 1n;
	return lo + (next() % span);
}

function line(
	unit: number,
	rateBp: number,
	options: { quantity?: bigint; deltas?: number[]; discount?: number } = {}
): TotalsLine {
	return {
		unitPriceMinor: minor(BigInt(unit)),
		quantity: options.quantity ?? 1n,
		modifierDeltasMinor: (options.deltas ?? []).map((d) => minor(BigInt(d))),
		taxRateBp: rateBp,
		discountMinor: minor(BigInt(options.discount ?? 0))
	};
}

const R: RoundingRule = ROUNDING_RULE;

describe('computeOrderTotals — the worked examples (MANDATORY spec 29)', () => {
	it('spec 18 exclusive: 800 + 200 at 10%', () => {
		const t = computeOrderTotals(
			{ taxMode: 'exclusive', lines: [line(800, 1000), line(200, 1000)] },
			R
		);
		expect(t.subtotal).toBe(1000n);
		expect(t.discount).toBe(0n);
		expect(t.tax).toBe(100n);
		expect(t.total).toBe(1100n);
		expect(t.net).toBe(1000n);
		expect(t.lines[0].undiscountedNet).toEqual(exact(800n));
		expect(t.lines[0].net).toEqual(exact(800n));
		expect(t.lines[0].tax).toEqual(exact(80n));
		expect(t.lines[0].gross).toEqual(exact(880n));
	});

	it('spec 17 inclusive: 1100 at 10% — the customer pays 1100 and revenue is 1000', () => {
		const t = computeOrderTotals({ taxMode: 'inclusive', lines: [line(1100, 1000)] }, R);
		expect(t.subtotal).toBe(1000n);
		expect(t.discount).toBe(0n);
		expect(t.tax).toBe(100n);
		expect(t.total).toBe(1100n);
		expect(t.net).toBe(1000n);
	});

	it('the tie, inclusive: 999 at 20% — net is derived, never rounded', () => {
		const t = computeOrderTotals({ taxMode: 'inclusive', lines: [line(999, 2000)] }, R);
		expect(t.total).toBe(999n);
		expect(t.tax).toBe(167n);
		expect(t.net).toBe(832n);
		expect(t.subtotal).toBe(832n);
		expect(t.discount).toBe(0n);
		expect(t.subtotal - t.discount + t.tax).toBe(t.total);
		// Per-line net is exactly 832.5; rounding it on its own would give 833, and
		// 833 + 167 = 1000 ≠ 999 — the whole point of deriving net.
		expect(t.lines[0].net).toEqual(exact(1665n, 2n));
		expect(roundToMinor(t.lines[0].net, R)).toBe(833n);
	});

	it('the tie, inclusive: 1414 at 12% — 151.5 tax', () => {
		const t = computeOrderTotals({ taxMode: 'inclusive', lines: [line(1414, 1200)] }, R);
		expect(t.lines[0].tax).toEqual(exact(303n, 2n));
		expect(t.tax).toBe(roundToMinor(exact(303n, 2n), R));
		expect(t.tax).toBe(152n);
		expect(t.total).toBe(1414n);
		expect(t.net).toBe(subtract(t.total, t.tax));
		expect(t.subtotal).toBe(1262n);
		expect(t.subtotal - t.discount + t.tax).toBe(t.total);
	});

	it('rounded once on the sum, not per line: three lines of 333 at 8.25% exclusive', () => {
		const t = computeOrderTotals(
			{
				taxMode: 'exclusive',
				lines: [line(333, 825), line(333, 825), line(333, 825)]
			},
			R
		);
		expect(t.lines[0].tax).toEqual(exact(10989n, 400n));
		expect(t.tax).toBe(82n);
		// The per-line defect the derivation prevents.
		expect(3n * roundToMinor(t.lines[0].tax, R)).toBe(81n);
		expect(t.total).toBe(1081n);
		expect(t.net).toBe(999n);
		expect(t.subtotal).toBe(999n);
	});

	it('modifiers and quantity', () => {
		const t1 = computeOrderTotals(
			{ taxMode: 'exclusive', lines: [line(1000, 1000, { deltas: [-50], quantity: 3n })] },
			R
		);
		expect(t1.subtotal).toBe(2850n);
		expect(t1.tax).toBe(285n);
		expect(t1.total).toBe(3135n);
		expect(t1.discount).toBe(0n);

		const t2 = computeOrderTotals(
			{ taxMode: 'exclusive', lines: [line(850, 825, { deltas: [50], quantity: 2n })] },
			R
		);
		expect(t2.subtotal).toBe(1800n);
		expect(t2.tax).toBe(149n);
		expect(t2.total).toBe(1949n);
		expect(t2.net).toBe(1800n);
	});

	it('spec 24 discount: 1000 at 10% exclusive with 100 discount posts $10.90 = $10.90', () => {
		const t = computeOrderTotals(
			{ taxMode: 'exclusive', lines: [line(1000, 1000, { discount: 100 })] },
			R
		);
		expect(t.subtotal).toBe(1000n);
		expect(t.discount).toBe(100n);
		expect(t.tax).toBe(90n);
		expect(t.total).toBe(990n);
		expect(t.net).toBe(900n);
		expect(t.total + t.discount).toBe(t.subtotal + t.tax);
		expect(serializeTotals(t)).toEqual({
			subtotalMinor: '1000',
			discountMinor: '100',
			taxMinor: '90',
			totalMinor: '990'
		});
	});

	it('inclusive discount: 1100 at 10% inclusive with 110 gross discount', () => {
		const t = computeOrderTotals(
			{ taxMode: 'inclusive', lines: [line(1100, 1000, { discount: 110 })] },
			R
		);
		expect(t.subtotal).toBe(1000n);
		expect(t.discount).toBe(100n);
		expect(t.tax).toBe(90n);
		expect(t.total).toBe(990n);
		expect(t.net).toBe(900n);
		expect(t.total + t.discount).toBe(t.subtotal + t.tax);
	});

	it('a free item alone: zero everything, zero exacts', () => {
		const t = computeOrderTotals({ taxMode: 'exclusive', lines: [line(0, 1000)] }, R);
		expect(t.subtotal).toBe(0n);
		expect(t.discount).toBe(0n);
		expect(t.tax).toBe(0n);
		expect(t.total).toBe(0n);
		expect(t.net).toBe(0n);
		expect(t.lines[0].gross).toEqual(exact(0n));
	});

	it('rate 0 in both modes: no tax collected', () => {
		for (const taxMode of TAX_MODES as readonly TaxMode[]) {
			const t = computeOrderTotals({ taxMode, lines: [line(1000, 0)] }, R);
			expect(t.tax).toBe(0n);
			expect(t.total).toBe(1000n);
			expect(t.net).toBe(1000n);
			expect(t.subtotal).toBe(1000n);
		}
	});
});

describe('computeOrderTotals — refusals', () => {
	it('rejects a number quantity, a zero quantity and a negative discount', () => {
		expect(() =>
			computeOrderTotals(
				{ taxMode: 'exclusive', lines: [line(100, 1000, { quantity: 2 as unknown as bigint })] },
				R
			)
		).toThrow(TypeError);
		expect(() =>
			computeOrderTotals({ taxMode: 'exclusive', lines: [line(100, 1000, { quantity: 0n })] }, R)
		).toThrow(RangeError);
		expect(() =>
			computeOrderTotals({ taxMode: 'exclusive', lines: [line(100, 1000, { discount: -1 })] }, R)
		).toThrow(RangeError);
	});

	it('rejects a discount that exceeds the line and deltas that outweigh the price', () => {
		expect(() =>
			computeOrderTotals({ taxMode: 'exclusive', lines: [line(100, 1000, { discount: 101 })] }, R)
		).toThrow(RangeError);
		expect(() =>
			computeOrderTotals({ taxMode: 'exclusive', lines: [line(100, 1000, { deltas: [-200] })] }, R)
		).toThrow(RangeError);
	});

	it('null rate and null mode reach taxOnAmount and throw', () => {
		expect(() =>
			computeOrderTotals(
				{
					taxMode: 'exclusive',
					lines: [{ ...line(100, 1000), taxRateBp: null as unknown as number }]
				},
				R
			)
		).toThrow(TypeError);
		expect(() =>
			computeOrderTotals({ taxMode: null as unknown as TaxMode, lines: [line(100, 1000)] }, R)
		).toThrow(TypeError);
	});

	it('rule undefined is refused by roundToMinor', () => {
		expect(() =>
			computeOrderTotals(
				{ taxMode: 'exclusive', lines: [line(100, 1000)] },
				undefined as unknown as RoundingRule
			)
		).toThrow(TypeError);
	});

	it('an empty lines array is five zeros and an empty lines list', () => {
		const t = computeOrderTotals({ taxMode: 'exclusive', lines: [] }, R);
		expect(t).toEqual({
			subtotal: 0n,
			discount: 0n,
			tax: 0n,
			total: 0n,
			net: 0n,
			lines: []
		});
	});
});

describe('computeOrderTotals — MANDATORY property test (spec 29)', () => {
	it('holds every identity across 2000 seeded cases in both modes and coin outcomes', () => {
		const next = generator(20260928n);
		const modeCount = { exclusive: 0, inclusive: 0 };
		const discountCoin = { head: 0, tail: 0 };
		for (let i = 0; i < 2000; i++) {
			// Draw the mode from the HIGH bits (low bit alternates in this LCG).
			const modeBit = (next() >> 16n) % 2n;
			const taxMode: TaxMode = modeBit === 0n ? 'exclusive' : 'inclusive';
			modeCount[taxMode]++;
			const nLines = Number(between(next, 1n, 6n));
			const coin = (next() >> 16n) % 2n === 0n; // head → no discounts
			if (coin) discountCoin.head++;
			else discountCoin.tail++;
			const lines: TotalsLine[] = [];
			for (let j = 0; j < nLines; j++) {
				const rateBp = Number(between(next, 0n, 10_000n));
				const nDeltas = Number(between(next, 0n, 3n));
				const deltas: bigint[] = [];
				let deltaSum = 0n;
				for (let k = 0; k < nDeltas; k++) {
					const d = between(next, -500n, 500n);
					deltas.push(d);
					deltaSum += d;
				}
				let unit = between(next, 0n, 99_999n);
				if (unit + deltaSum < 0n) unit = -deltaSum;
				const quantity = between(next, 1n, 9n);
				const base = (unit + deltaSum) * quantity;
				const discount = coin ? 0n : between(next, 0n, base);
				lines.push({
					unitPriceMinor: minor(unit),
					quantity,
					modifierDeltasMinor: deltas.map((d) => minor(d)),
					taxRateBp: rateBp,
					discountMinor: minor(discount)
				});
			}
			const t = computeOrderTotals({ taxMode, lines }, R);
			expect(t.subtotal - t.discount + t.tax).toBe(t.total);
			expect(t.net + t.tax).toBe(t.total);
			expect(t.discount === 0n).toBe(lines.every((l) => l.discountMinor === 0n));
			expect(t.total + t.discount).toBe(t.subtotal + t.tax);
			for (const perLine of t.lines) {
				expect(perLine.gross.denominator).toBeLessThanOrEqual(20000n);
				expect(perLine.net.denominator).toBeLessThanOrEqual(20000n);
				expect(perLine.tax.denominator).toBeLessThanOrEqual(20000n);
				expect(perLine.undiscountedNet.denominator).toBeLessThanOrEqual(20000n);
			}
			// Half-even holds identities (i), (ii) and (iv) by construction too.
			const halfEven = computeOrderTotals({ taxMode, lines }, 'half-even');
			expect(halfEven.subtotal - halfEven.discount + halfEven.tax).toBe(halfEven.total);
			expect(halfEven.net + halfEven.tax).toBe(halfEven.total);
			expect(halfEven.total + halfEven.discount).toBe(halfEven.subtotal + halfEven.tax);
		}
		expect(modeCount.exclusive).toBeGreaterThan(0);
		expect(modeCount.inclusive).toBeGreaterThan(0);
		expect(discountCoin.head).toBeGreaterThan(500);
		expect(discountCoin.tail).toBeGreaterThan(500);
	});
});

describe('serializeTotals and totalsEqual', () => {
	const build = (m: {
		subtotal: bigint;
		discount: bigint;
		tax: bigint;
		total: bigint;
	}): OrderTotals => ({
		subtotal: minor(m.subtotal),
		discount: minor(m.discount),
		tax: minor(m.tax),
		total: minor(m.total),
		net: minor(m.total - m.tax),
		lines: []
	});

	it('serializeTotals matches the SaleCompletePayload wire shape', () => {
		const t = build({ subtotal: 1000n, discount: 100n, tax: 90n, total: 990n });
		const wire: SaleCompletePayload['totals'] = serializeTotals(t);
		expect(wire).toEqual({
			subtotalMinor: '1000',
			discountMinor: '100',
			taxMinor: '90',
			totalMinor: '990'
		});
	});

	it('totalsEqual is true for identical values and false when any field differs by 1n', () => {
		const t = build({ subtotal: 1000n, discount: 0n, tax: 100n, total: 1100n });
		expect(totalsEqual(t, t)).toBe(true);
		expect(totalsEqual(t, { ...t, subtotal: minor(1001n) as Minor })).toBe(false);
		expect(totalsEqual(t, { ...t, discount: minor(1n) as Minor })).toBe(false);
		expect(totalsEqual(t, { ...t, tax: minor(99n) as Minor })).toBe(false);
		expect(totalsEqual(t, { ...t, total: minor(1099n) as Minor })).toBe(false);
	});
});

describe('order-totals source tripwire', () => {
	it('rounds only through roundToMinor and imports only ./index and ./tax', () => {
		const source = readFileSync(new URL('./order-totals.ts', import.meta.url), 'utf8');
		const stripped = source
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');
		expect(stripped).not.toMatch(/\bNumber\(/);
		expect(stripped).not.toMatch(/\bparseFloat\b/);
		expect(stripped).not.toMatch(/\btoFixed\b/);
		expect(stripped).not.toMatch(/\bMath\./);
		expect(stripped).not.toMatch(/\d\.\d/);
		const froms = [...stripped.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		expect(new Set(froms)).toEqual(new Set(['./index', './tax']));
	});
});
