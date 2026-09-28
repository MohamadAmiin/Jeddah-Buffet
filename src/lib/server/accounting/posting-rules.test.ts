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
	linesBalance,
	purchaseEvent,
	purchaseLines,
	supplierPaymentLines,
	wasteLines,
	countShortfallLines,
	countSurplusLines,
	revaluationLines,
	openingStockLines
} from './posting-rules';
import { JOURNAL_SOURCE_TYPES } from './journal';

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
		// tasks/inventory-cogs T-13's eight rules.
		for (const paidBy of ['cash', 'bank', 'credit'] as const) {
			for (const line of purchaseLines(paidBy, minor(1n))) codes.add(line.code);
		}
		for (const paidFrom of ['cash', 'bank'] as const) {
			for (const line of supplierPaymentLines(paidFrom, minor(1n))) codes.add(line.code);
		}
		for (const line of wasteLines(minor(1n))) codes.add(line.code);
		for (const line of countShortfallLines(minor(1n))) codes.add(line.code);
		for (const line of countSurplusLines(minor(1n))) codes.add(line.code);
		for (const line of revaluationLines(minor(-1n))) codes.add(line.code);
		for (const line of revaluationLines(minor(1n))) codes.add(line.code);
		for (const line of openingStockLines(minor(1n))) codes.add(line.code);
		const chartCodes = new Set(CHART.map((r) => r.code));
		for (const code of codes) expect(chartCodes.has(code)).toBe(true);
		expect(codes).toEqual(
			new Set([
				'1000',
				'1010',
				'1020',
				'1030',
				'1200',
				'2000',
				'2100',
				'3000',
				'4000',
				'4100',
				'5000',
				'5100',
				'6800'
			])
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
			'cash_overage_at_close',
			'purchase_paid',
			'purchase_on_credit',
			'supplier_paid',
			'waste',
			'stock_count_shortfall',
			'stock_count_surplus',
			'inventory_revaluation',
			'opening_stock'
		]);
	});

	it('JOURNAL_SOURCE_TYPES spellings match the schema CHECK the constraints test pins', () => {
		expect([...JOURNAL_SOURCE_TYPES]).toEqual([
			'order',
			'pos_session',
			'purchase',
			'supplier_payment',
			'waste_entry',
			'stock_count',
			'opening_stock'
		]);
	});
});

describe('MANDATORY (spec 29) — one posting-rule test per inventory business event (tasks/inventory-cogs T-13)', () => {
	it('purchase paid by cash: Dr 1200 / Cr 1000, event purchase_paid', () => {
		expect(purchaseLines('cash', minor(11000n))).toEqual([
			{ code: '1200', debit: 11000n },
			{ code: '1000', credit: 11000n }
		]);
		expect(purchaseEvent('cash')).toBe('purchase_paid');
	});

	it('purchase paid by bank: Dr 1200 / Cr 1010, event purchase_paid', () => {
		expect(purchaseLines('bank', minor(11000n))).toEqual([
			{ code: '1200', debit: 11000n },
			{ code: '1010', credit: 11000n }
		]);
		expect(purchaseEvent('bank')).toBe('purchase_paid');
	});

	it('purchase on credit: Dr 1200 / Cr 2000, event purchase_on_credit', () => {
		expect(purchaseLines('credit', minor(11000n))).toEqual([
			{ code: '1200', debit: 11000n },
			{ code: '2000', credit: 11000n }
		]);
		expect(purchaseEvent('credit')).toBe('purchase_on_credit');
	});

	it('supplier paid: Dr 2000 / Cr 1000 (cash) or 1010 (bank)', () => {
		expect(supplierPaymentLines('cash', minor(5000n))).toEqual([
			{ code: '2000', debit: 5000n },
			{ code: '1000', credit: 5000n }
		]);
		expect(supplierPaymentLines('bank', minor(5000n))).toEqual([
			{ code: '2000', debit: 5000n },
			{ code: '1010', credit: 5000n }
		]);
	});

	it('waste: Dr 5100 / Cr 1200', () => {
		expect(wasteLines(minor(82n))).toEqual([
			{ code: '5100', debit: 82n },
			{ code: '1200', credit: 82n }
		]);
	});

	it('stock count shortfall Dr 5100 / Cr 1200; surplus Dr 1200 / Cr 5100', () => {
		expect(countShortfallLines(minor(300n))).toEqual([
			{ code: '5100', debit: 300n },
			{ code: '1200', credit: 300n }
		]);
		expect(countSurplusLines(minor(300n))).toEqual([
			{ code: '1200', debit: 300n },
			{ code: '5100', credit: 300n }
		]);
	});

	it('inventory revaluation (signed, against 5000)', () => {
		expect(revaluationLines(minor(-15000n))).toEqual([
			{ code: '5000', debit: 15000n },
			{ code: '1200', credit: 15000n }
		]);
		expect(revaluationLines(minor(3600n))).toEqual([
			{ code: '1200', debit: 3600n },
			{ code: '5000', credit: 3600n }
		]);
		expect(revaluationLines(minor(0n))).toEqual([]);
	});

	it("opening stock: Dr 1200 / Cr 3000 Owner's Capital", () => {
		expect(openingStockLines(minor(25000n))).toEqual([
			{ code: '1200', debit: 25000n },
			{ code: '3000', credit: 25000n }
		]);
	});

	it('every non-signed rule refuses a negative amount with TypeError', () => {
		const neg = minor(-1n);
		expect(() => purchaseLines('cash', neg)).toThrow(TypeError);
		expect(() => supplierPaymentLines('bank', neg)).toThrow(TypeError);
		expect(() => wasteLines(neg)).toThrow(TypeError);
		expect(() => countShortfallLines(neg)).toThrow(TypeError);
		expect(() => countSurplusLines(neg)).toThrow(TypeError);
		expect(() => openingStockLines(neg)).toThrow(TypeError);
	});

	it('every rule balances over 1,000 seeded amounts', () => {
		const next = generator(20260930n);
		for (let i = 0; i < 1000; i++) {
			const a = minor(between(next, 0n, 10_000_000n));
			const signed = minor(between(next, -10_000_000n, 10_000_000n));
			for (const lines of [
				purchaseLines('cash', a),
				purchaseLines('bank', a),
				purchaseLines('credit', a),
				supplierPaymentLines('cash', a),
				supplierPaymentLines('bank', a),
				wasteLines(a),
				countShortfallLines(a),
				countSurplusLines(a),
				revaluationLines(signed),
				openingStockLines(a)
			]) {
				expect(linesBalance(lines)).toBe(true);
			}
		}
	});
});
