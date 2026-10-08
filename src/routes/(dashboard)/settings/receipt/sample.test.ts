// The preview's sample sale (tasks/settings-tax-payments-receipt T-31): its
// figures come from the money module in BOTH tax modes, its per-rate rows add
// up to its stored tax, and the till's own formatter draws it at both widths.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT } from '../../../../lib/receipt-layout';
import { isImageLine, renderReceipt, type TextLine } from '../../../../lib/pos/receipt';
import { sampleSale, type SampleRate } from './sample';

const TAX: SampleRate = { id: 'rate-tax', name: 'Tax', rateBp: 1000 };
const EXEMPT: SampleRate = { id: 'rate-exempt', name: 'Exempt', rateBp: 0 };
const CASH = { id: 'method-cash', name: 'Cash' };
const NOW = new Date('2026-10-06T10:15:00.000Z');
const MODES = ['exclusive', 'inclusive'] as const;

function sample(rates: SampleRate[], taxMode: (typeof MODES)[number] = 'exclusive') {
	return sampleSale({ currencyCode: 'USD', taxMode, rates, cash: CASH, now: NOW });
}

/** The rows' tax summed in the TEST, with BigInt — the sample never sums them. */
function sumOfRows(rows: ReadonlyArray<{ taxMinor: string }>): string {
	return rows.reduce((acc, row) => acc + BigInt(row.taxMinor), 0n).toString();
}

describe('sampleSale', () => {
	// MANDATORY (spec 29 — tax calculated in both modes).
	describe.each(MODES)('in %s mode', (taxMode) => {
		it('stores two per-rate rows whose tax sums to the stored tax with Tax 10.00% and Exempt 0.00%', () => {
			const sale = sample([TAX, EXEMPT], taxMode);

			expect(sale.taxBreakdown).toHaveLength(2);
			expect(sale.taxBreakdown).toMatchObject([
				{ name: 'Tax', rateBp: 1000 },
				{ name: 'Exempt', rateBp: 0, taxMinor: '0' }
			]);
			expect(sumOfRows(sale.taxBreakdown!)).toBe(sale.payload.totals.taxMinor);

			// The dish (850) carries the tax; the drink (2 × 300) is exempt.
			// Exclusive: 85 on top. Inclusive: 850 × 1000 / 11000 = 77.27 → 77.
			expect(sale.payload.totals).toEqual(
				taxMode === 'exclusive'
					? { subtotalMinor: '1450', discountMinor: '0', taxMinor: '85', totalMinor: '1535' }
					: { subtotalMinor: '1373', discountMinor: '0', taxMinor: '77', totalMinor: '1450' }
			);
		});

		it('stores one row equal to the stored tax with a single rate', () => {
			const sale = sample([TAX], taxMode);

			expect(sale.taxBreakdown).toHaveLength(1);
			expect(sale.taxBreakdown![0]).toMatchObject({ name: 'Tax', rateBp: 1000 });
			expect(sale.taxBreakdown![0].taxMinor).toBe(sale.payload.totals.taxMinor);

			// Both lines at 10%: exclusive 85 + 60; inclusive 77.27 + 54.55 = 131.82 → 132.
			expect(sale.payload.totals).toEqual(
				taxMode === 'exclusive'
					? { subtotalMinor: '1450', discountMinor: '0', taxMinor: '145', totalMinor: '1595' }
					: { subtotalMinor: '1318', discountMinor: '0', taxMinor: '132', totalMinor: '1450' }
			);
		});

		it.each([32, 48] as const)(
			'renders through the till formatter at %i columns with no line wider than the paper',
			(width) => {
				const sale = sample([TAX, EXEMPT], taxMode);
				const lines = renderReceipt(
					{
						sale,
						header: {
							restaurantName: 'Cafe One',
							address: 'Makka Al-Mukarama Rd, Km4',
							phone: '61 555 0142',
							taxRegistrationNumber: null
						},
						timeZone: 'Africa/Mogadishu',
						deviceCode: 'POS1',
						layout: DEFAULT_RECEIPT_LAYOUT,
						paymentNumbers: [{ name: 'EVC Plus', number: '61 234 5678' }],
						logo: null
					},
					{ width }
				);
				const text = lines.filter((line): line is TextLine => !isImageLine(line));

				expect(text.length).toBeGreaterThan(0);
				expect(text.every((line) => line.text.length <= width)).toBe(true);
				expect(text.some((line) => line.text.includes('Sample dish'))).toBe(true);
				expect(text.some((line) => line.text.includes('Sample drink'))).toBe(true);
				// Two rates on one receipt: the stored rows print, one per rate — under
				// the formatter's inclusive-mode label `Incl. <name> <rate>` when prices
				// include tax.
				const label = taxMode === 'inclusive' ? 'Incl. ' : '';
				expect(text.some((line) => line.text.startsWith(`${label}Tax 10.00%`))).toBe(true);
				expect(text.some((line) => line.text.startsWith(`${label}Exempt 0.00%`))).toBe(true);
			}
		);
	});

	it('carries each line with its rate id and name, and the amounts the receipt prints', () => {
		const sale = sample([TAX, EXEMPT]);

		expect(sale.payload.lines).toMatchObject([
			{ itemName: 'Sample dish', quantity: 1, taxRateBp: 1000, taxRateId: 'rate-tax' },
			{ itemName: 'Sample drink', quantity: 2, taxRateBp: 0, taxRateId: 'rate-exempt' }
		]);
		expect(sale.payload.lines.map((line) => line.taxRateName)).toEqual(['Tax', 'Exempt']);
		expect(sale.lineAmountsMinor).toEqual(['850', '600']);
		expect(sale.payload.taxMode).toBe('exclusive');
		expect(sale.payload.currencyCode).toBe('USD');
	});

	it('is paid in cash to the cent, under the Cash method when there is one', () => {
		const sale = sample([TAX]);
		const total = sale.payload.totals.totalMinor;

		expect(sale.payload.payments).toEqual([
			{
				paymentId: 'sample',
				method: 'cash',
				amountMinor: total,
				tenderedMinor: total,
				changeMinor: '0',
				paymentMethodId: 'method-cash',
				paymentMethodName: 'Cash'
			}
		]);

		const noCash = sampleSale({
			currencyCode: 'USD',
			taxMode: 'exclusive',
			rates: [TAX],
			cash: null,
			now: NOW
		});
		expect(noCash.payload.payments[0]).toMatchObject({
			paymentMethodId: null,
			paymentMethodName: 'Cash'
		});
	});

	it('is never a stored sale: a sample order on a sample session, dated now', () => {
		const sale = sample([TAX]);

		expect(sale.payload.orderId).toBe('sample');
		expect(sale.payload.posSessionId).toBe('sample');
		expect(sale.payload.invoiceNumber).toBe('POS1-000001');
		expect(sale.payload.invoiceSeq).toBe(1);
		expect(sale.payload).toMatchObject({ orderType: 'dine_in', tableLabel: '4', menuVersion: 0 });
		expect(sale.cashierName).toBe('Sample cashier');
		expect(sale.completedAt).toBe('2026-10-06T10:15:00.000Z');
		expect(sale.payload.openedAt).toBe('2026-10-06T10:15:00.000Z');
		expect(sale.businessDate).toBe('2026-10-06');
	});

	it('throws RangeError when there is no rate', () => {
		expect(() => sample([])).toThrow(RangeError);
	});
});
