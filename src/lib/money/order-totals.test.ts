import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ROUNDING_RULE,
	exact,
	minor,
	roundToMinor,
	subtract,
	sum,
	sumExact,
	type Minor,
	type RoundingRule
} from './index';
import { TAX_MODES, type TaxMode } from './tax';
import {
	computeOrderTotals,
	serializeTotals,
	taxBreakdown,
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

describe('taxBreakdown — per-rate tax that sums to the stored tax', () => {
	type Rate = { rateBp: number; name: string | null };
	const rate = (rateBp: number, name: string | null): Rate => ({ rateBp, name });

	// Each entry pairs an order line with the rate that describes it, so
	// rates[i] always describes lines[i]. The rule is passed explicitly, to both
	// calls: the breakdown splits what computeOrderTotals rounded with that rule.
	function split(taxMode: TaxMode, entries: Array<[TotalsLine, Rate]>, rule: RoundingRule) {
		const t = computeOrderTotals({ taxMode, lines: entries.map(([l]) => l) }, rule);
		const rows = taxBreakdown(
			t,
			entries.map(([, r]) => r),
			rule
		);
		return { t, rows };
	}

	it('MANDATORY (spec 29 — tax in both modes): exclusive, two rates', () => {
		const { t, rows } = split(
			'exclusive',
			[
				[line(850, 1000), rate(1000, 'VAT 10%')],
				[line(1000, 500), rate(500, 'VAT 5%')]
			],
			R
		);
		expect(t.tax).toBe(135n);
		expect(t.total).toBe(1985n);
		expect(rows).toEqual([
			{ rateBp: 1000, name: 'VAT 10%', tax: 85n },
			{ rateBp: 500, name: 'VAT 5%', tax: 50n }
		]);
	});

	it('MANDATORY (spec 29 — tax in both modes): inclusive, two rates', () => {
		const { t, rows } = split(
			'inclusive',
			[
				[line(1100, 1000), rate(1000, 'VAT 10%')],
				[line(1050, 500), rate(500, 'VAT 5%')]
			],
			R
		);
		expect(t.tax).toBe(150n);
		expect(t.total).toBe(2150n);
		expect(rows).toEqual([
			{ rateBp: 1000, name: 'VAT 10%', tax: 100n },
			{ rateBp: 500, name: 'VAT 5%', tax: 50n }
		]);
	});

	it('MANDATORY (spec 29 — money arithmetic and rounding): inclusive, where rounding each rate on its own mis-sums', () => {
		const { t, rows } = split(
			'inclusive',
			[
				[line(999, 2000), rate(2000, 'VAT 20%')],
				[line(1414, 1200), rate(1200, 'VAT 12%')]
			],
			R
		);
		expect(t.lines[0].tax).toEqual(exact(333n, 2n)); // 166.5
		expect(t.lines[1].tax).toEqual(exact(303n, 2n)); // 151.5
		expect(t.tax).toBe(318n);
		expect(t.total).toBe(2413n);
		expect(rows).toEqual([
			{ rateBp: 2000, name: 'VAT 20%', tax: 167n },
			{ rateBp: 1200, name: 'VAT 12%', tax: 151n }
		]);
		// Rounding each rate group on its own would give 167 + 152 = 319: one cent
		// more than the TAX line, the invoice and Cr 2100.
		expect(roundToMinor(t.lines[0].tax, R) + roundToMinor(t.lines[1].tax, R)).toBe(319n);
	});

	it('MANDATORY (spec 29 — money arithmetic and rounding): exclusive three-way ties, under both rules', () => {
		const entries: Array<[TotalsLine, Rate]> = [
			[line(105, 1000), rate(1000, 'A')],
			[line(210, 500), rate(500, 'B')],
			[line(350, 300), rate(300, 'C')]
		];
		const halfUp = split('exclusive', entries, R);
		for (const perLine of halfUp.t.lines) expect(perLine.tax).toEqual(exact(21n, 2n)); // 10.5
		expect(halfUp.t.tax).toBe(32n);
		expect(halfUp.rows).toEqual([
			{ rateBp: 1000, name: 'A', tax: 11n },
			{ rateBp: 500, name: 'B', tax: 10n },
			{ rateBp: 300, name: 'C', tax: 11n }
		]);
		// Rounding each group on its own would give 11 + 11 + 11 = 33.
		expect(halfUp.t.lines.reduce((acc, l) => acc + roundToMinor(l.tax, R), 0n)).toBe(33n);

		const halfEven = split('exclusive', entries, 'half-even');
		expect(halfEven.t.tax).toBe(32n);
		expect(halfEven.rows).toEqual([
			{ rateBp: 1000, name: 'A', tax: 10n },
			{ rateBp: 500, name: 'B', tax: 11n },
			{ rateBp: 300, name: 'C', tax: 11n }
		]);
	});

	it('the same rate under two names is two rows (exclusive)', () => {
		// Inclusive would give 48n and 47n, hence the named mode.
		const { t, rows } = split(
			'exclusive',
			[
				[line(1000, 500), rate(500, 'Levy')],
				[line(1000, 500), rate(500, 'VAT')]
			],
			R
		);
		expect(t.tax).toBe(100n);
		expect(rows).toEqual([
			{ rateBp: 500, name: 'Levy', tax: 50n },
			{ rateBp: 500, name: 'VAT', tax: 50n }
		]);
	});

	it('a group that reappears merges in first-appearance order, and a 0% group is kept (exclusive)', () => {
		// Inclusive would give 136n, hence the named mode.
		const { t, rows } = split(
			'exclusive',
			[
				[line(1000, 1000), rate(1000, 'VAT 10%')],
				[line(1000, 0), rate(0, 'Exempt')],
				[line(500, 1000), rate(1000, 'VAT 10%')]
			],
			R
		);
		expect(t.tax).toBe(150n);
		expect(rows).toEqual([
			{ rateBp: 1000, name: 'VAT 10%', tax: 150n },
			{ rateBp: 0, name: 'Exempt', tax: 0n }
		]);
	});

	it('one group is one row equal to the stored tax: three 333s at 8.25% exclusive', () => {
		const tax = rate(825, 'Tax');
		const { t, rows } = split(
			'exclusive',
			[
				[line(333, 825), tax],
				[line(333, 825), tax],
				[line(333, 825), tax]
			],
			R
		);
		expect(t.tax).toBe(82n);
		expect(rows).toEqual([{ rateBp: 825, name: 'Tax', tax: 82n }]);
	});

	it('null names (lines recorded before named rates) group together and stay apart from any name', () => {
		const twoNulls = split(
			'exclusive',
			[
				[line(1000, 825), rate(825, null)],
				[line(1000, 825), rate(825, null)]
			],
			R
		);
		expect(twoNulls.rows).toEqual([{ rateBp: 825, name: null, tax: 165n }]);

		const nullAndTheWordNull = split(
			'exclusive',
			[
				[line(1000, 825), rate(825, null)],
				[line(1000, 825), rate(825, 'null')]
			],
			R
		);
		expect(nullAndTheWordNull.rows).toEqual([
			{ rateBp: 825, name: null, tax: 83n },
			{ rateBp: 825, name: 'null', tax: 82n }
		]);

		const nullAndTax = split(
			'exclusive',
			[
				[line(1000, 825), rate(825, null)],
				[line(1000, 825), rate(825, 'Tax')]
			],
			R
		);
		expect(nullAndTax.rows).toEqual([
			{ rateBp: 825, name: null, tax: 83n },
			{ rateBp: 825, name: 'Tax', tax: 82n }
		]);
	});

	it('an empty order has an empty breakdown', () => {
		const t = computeOrderTotals({ taxMode: 'exclusive', lines: [] }, R);
		expect(taxBreakdown(t, [], R)).toEqual([]);
	});

	it('refuses a rate list of the wrong length, and totals rounded under another rule', () => {
		const short = computeOrderTotals(
			{ taxMode: 'exclusive', lines: [line(1000, 825), line(1000, 825)] },
			R
		);
		expect(() => taxBreakdown(short, [rate(825, 'Tax')], R)).toThrow(RangeError);

		const tax = rate(825, 'Tax');
		const t = computeOrderTotals(
			{ taxMode: 'exclusive', lines: [line(333, 825), line(333, 825), line(334, 825)] },
			'half-even'
		);
		expect(t.tax).toBe(82n); // exact 82.5, to the even neighbour
		expect(() => taxBreakdown(t, [tax, tax, tax], 'half-up')).toThrow(Error);
		expect(() => taxBreakdown(t, [tax, tax, tax], 'half-up')).toThrow(/do not reconcile/);
	});

	it('MANDATORY (spec 29 — tax in both modes; money arithmetic and rounding): 500 seeded carts, both modes, both rules', () => {
		const POOL: Rate[] = [
			rate(0, 'Exempt'),
			rate(500, 'VAT 5%'),
			rate(825, 'Tax'),
			rate(825, null),
			rate(1500, 'Alcohol duty')
		];
		const RULES: RoundingRule[] = ['half-up', 'half-even'];
		const next = generator(20261001n);
		const discountCoin = { head: 0, tail: 0 };
		for (let i = 0; i < 500; i++) {
			const nLines = Number(between(next, 1n, 8n));
			// The coin from the HIGH bits (the low bit alternates in this LCG).
			const head = (next() >> 16n) % 2n === 0n; // head → no discounts
			if (head) discountCoin.head++;
			else discountCoin.tail++;
			const lines: TotalsLine[] = [];
			const rates: Rate[] = [];
			for (let j = 0; j < nLines; j++) {
				const lineRate = POOL[Number(between(next, 0n, 4n))];
				const unit = between(next, 0n, 99_999n);
				const quantity = between(next, 1n, 9n);
				const base = unit * quantity;
				const discount = head ? 0n : between(next, 0n, base);
				lines.push({
					unitPriceMinor: minor(unit),
					quantity,
					modifierDeltasMinor: [],
					taxRateBp: lineRate.rateBp,
					discountMinor: minor(discount)
				});
				rates.push(lineRate);
			}
			// The distinct (rateBp, name) keys of the cart, in first-appearance order,
			// each with the indices of its lines.
			const groupIndices = new Map<string, number[]>();
			rates.forEach((r, index) => {
				const key = JSON.stringify([r.rateBp, r.name]);
				const indices = groupIndices.get(key);
				if (indices) indices.push(index);
				else groupIndices.set(key, [index]);
			});

			for (const taxMode of TAX_MODES as readonly TaxMode[]) {
				for (const rule of RULES) {
					const t = computeOrderTotals({ taxMode, lines }, rule);
					const rows = taxBreakdown(t, rates, rule);
					expect(sum(rows.map((r) => r.tax))).toBe(t.tax);
					for (const row of rows) expect(row.tax).toBeGreaterThanOrEqual(0n);
					expect(rows.length).toBe(groupIndices.size);
					expect(rows.map((r) => JSON.stringify([r.rateBp, r.name]))).toEqual([
						...groupIndices.keys()
					]);
					// Half away from zero on non-negative sums keeps every row strictly
					// within one minor unit of its group's exact tax. Under 'half-even' the
					// bound is ≤ 1, so it is not asserted there.
					if (rule === 'half-up') {
						for (const row of rows) {
							const indices = groupIndices.get(JSON.stringify([row.rateBp, row.name])) ?? [];
							const g = sumExact(indices.map((index) => t.lines[index].tax));
							const d = row.tax * g.denominator - g.numerator;
							expect(d > -g.denominator && d < g.denominator).toBe(true);
						}
					}
				}
			}
		}
		expect(discountCoin.head).toBeGreaterThan(0);
		expect(discountCoin.tail).toBeGreaterThan(0);
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
