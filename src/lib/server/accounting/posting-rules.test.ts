import { describe, expect, it } from 'vitest';
import { computeOrderTotals } from '../../money/order-totals';
import { minor, sum, add, ROUNDING_RULE } from '../../money';
import { PAYMENT_METHODS } from '../../sync-ops';
import { CHART } from './chart';
import {
	POSTING_EVENTS,
	SALE_EVENTS,
	saleLines,
	cogsLines,
	overShortLines,
	overShortEvent,
	eventForMethod,
	linesBalance
} from './posting-rules';

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

describe('sale lines — the spec 22 and spec 24 examples', () => {
	it('spec 22 cash sale: subtotal 1000, discount 0, tax 100, total 1100', () => {
		expect(
			saleLines('cash_sale', {
				subtotal: minor(1000n),
				discount: minor(0n),
				tax: minor(100n),
				total: minor(1100n)
			})
		).toEqual([
			{ code: '1000', debit: 1100n },
			{ code: '4100', debit: 0n },
			{ code: '4000', credit: 1000n },
			{ code: '2100', credit: 100n }
		]);
	});

	it('the same totals with card_sale route to 1020 and with mobile_sale to 1030', () => {
		const t = {
			subtotal: minor(1000n),
			discount: minor(0n),
			tax: minor(100n),
			total: minor(1100n)
		};
		expect(saleLines('card_sale', t)[0]).toEqual({ code: '1020', debit: 1100n });
		expect(saleLines('mobile_sale', t)[0]).toEqual({ code: '1030', debit: 1100n });
		// The remaining three lines identical to the cash case.
		expect(saleLines('card_sale', t).slice(1)).toEqual([
			{ code: '4100', debit: 0n },
			{ code: '4000', credit: 1000n },
			{ code: '2100', credit: 100n }
		]);
	});

	it('spec 24 discount example: burger 10.00 - 10% + 10% tax posts 10.90 = 10.90', () => {
		const literal = {
			subtotal: minor(1000n),
			discount: minor(100n),
			tax: minor(90n),
			total: minor(990n)
		};
		expect(saleLines('cash_sale', literal)).toEqual([
			{ code: '1000', debit: 990n },
			{ code: '4100', debit: 100n },
			{ code: '4000', credit: 1000n },
			{ code: '2100', credit: 90n }
		]);
		expect(linesBalance(saleLines('cash_sale', literal))).toBe(true);
		// Same totals derived from computeOrderTotals.
		const derived = computeOrderTotals(
			{
				taxMode: 'exclusive',
				lines: [
					{
						unitPriceMinor: minor(1000n),
						quantity: 1n,
						modifierDeltasMinor: [],
						taxRateBp: 1000,
						discountMinor: minor(100n)
					}
				]
			},
			ROUNDING_RULE
		);
		expect({
			subtotal: derived.subtotal,
			discount: derived.discount,
			tax: derived.tax,
			total: derived.total
		}).toEqual(literal);
		expect(saleLines('cash_sale', derived)).toEqual(saleLines('cash_sale', literal));
	});
});

describe('cogs, over-short, event helpers', () => {
	it('cogsLines mirrors the two-line COGS entry', () => {
		expect(cogsLines(minor(300n))).toEqual([
			{ code: '5000', debit: 300n },
			{ code: '1200', credit: 300n }
		]);
	});

	it('shortage: negative difference posts Dr 6800 / Cr 1000 with the magnitude', () => {
		expect(overShortLines(minor(-1000n))).toEqual([
			{ code: '6800', debit: 1000n },
			{ code: '1000', credit: 1000n }
		]);
		expect(overShortEvent(minor(-1000n))).toBe('cash_shortage_at_close');
	});

	it('overage: positive difference posts Dr 1000 / Cr 6800', () => {
		expect(overShortLines(minor(1000n))).toEqual([
			{ code: '1000', debit: 1000n },
			{ code: '6800', credit: 1000n }
		]);
		expect(overShortEvent(minor(1000n))).toBe('cash_overage_at_close');
	});

	it('zero difference posts nothing', () => {
		expect(overShortLines(minor(0n))).toEqual([]);
		expect(overShortEvent(minor(0n))).toBeNull();
	});

	it('eventForMethod maps every wire method to a SaleEvent', () => {
		expect(eventForMethod('cash')).toBe('cash_sale');
		expect(eventForMethod('card')).toBe('card_sale');
		expect(eventForMethod('mobile')).toBe('mobile_sale');
		for (const m of PAYMENT_METHODS) {
			expect((SALE_EVENTS as readonly string[]).includes(eventForMethod(m))).toBe(true);
		}
		expect(() => eventForMethod('cheque' as never)).toThrow(RangeError);
	});
});

describe('MANDATORY (spec 29) — 500 seeded orders x 3 sale events balance', () => {
	it('every generated sale entry has debits = credits, no negatives, no missing side', () => {
		const next = generator(20260928n);
		for (let i = 0; i < 500; i++) {
			const taxMode = i % 2 === 0 ? 'exclusive' : 'inclusive';
			const nLines = Number(between(next, 1n, 6n));
			const lines = [];
			for (let j = 0; j < nLines; j++) {
				const unitPriceMinor = minor(between(next, 0n, 100_000n));
				const quantity = between(next, 1n, 9n);
				const nDeltas = Number(between(next, 0n, 3n));
				const deltas = [];
				let deltaSum = 0n;
				for (let k = 0; k < nDeltas; k++) {
					const d = between(next, 0n, 2000n);
					deltas.push(minor(d));
					deltaSum += d;
				}
				const taxRateBp = Number(between(next, 0n, 10_000n));
				const base = (unitPriceMinor + deltaSum) * quantity;
				const discountMinor = minor(base > 0n ? between(next, 0n, base) : 0n);
				lines.push({
					unitPriceMinor,
					quantity,
					modifierDeltasMinor: deltas,
					taxRateBp,
					discountMinor
				});
			}
			const totals = computeOrderTotals({ taxMode, lines }, ROUNDING_RULE);
			for (const event of SALE_EVENTS) {
				const rule = saleLines(event, totals);
				expect(linesBalance(rule)).toBe(true);
				const debits = sum(rule.map((l) => l.debit ?? minor(0n)));
				const credits = sum(rule.map((l) => l.credit ?? minor(0n)));
				expect(debits).toBe(add(totals.total, totals.discount));
				expect(credits).toBe(add(totals.subtotal, totals.tax));
				for (const line of rule) {
					const amount = line.debit ?? line.credit ?? minor(0n);
					expect(amount).toBeGreaterThanOrEqual(0n);
					expect((line.debit === undefined) !== (line.credit === undefined)).toBe(true);
				}
			}
		}
	});
});

describe('code coverage and refusals', () => {
	it('every code the rules emit exists in CHART, no more', () => {
		const codes = new Set<string>();
		for (const e of SALE_EVENTS) {
			for (const line of saleLines(e, {
				subtotal: minor(1000n),
				discount: minor(0n),
				tax: minor(0n),
				total: minor(1000n)
			})) {
				codes.add(line.code);
			}
		}
		for (const line of cogsLines(minor(1n))) codes.add(line.code);
		for (const line of overShortLines(minor(-1n))) codes.add(line.code);
		for (const line of overShortLines(minor(1n))) codes.add(line.code);
		const chartCodes = new Set(CHART.map((r) => r.code));
		for (const code of codes) expect(chartCodes.has(code)).toBe(true);
		expect(codes).toEqual(
			new Set(['1000', '1020', '1030', '4100', '4000', '2100', '5000', '1200', '6800'])
		);
	});

	it('refuses negative sale amounts and negative cost', () => {
		expect(() =>
			saleLines('cash_sale', {
				subtotal: minor(0n),
				discount: minor(0n),
				tax: minor(0n),
				total: minor(-1n)
			})
		).toThrow(RangeError);
		expect(() => cogsLines(minor(-1n))).toThrow(RangeError);
	});

	it('POSTING_EVENTS spellings match the schema CHECK the constraints test pins', () => {
		expect([...POSTING_EVENTS]).toEqual([
			'cash_sale',
			'card_sale',
			'mobile_sale',
			'cost_of_goods_sold',
			'cash_shortage_at_close',
			'cash_overage_at_close'
		]);
	});
});
