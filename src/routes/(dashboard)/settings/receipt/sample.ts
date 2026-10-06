// THE PREVIEW'S SAMPLE SALE (tasks/settings-tax-payments-receipt T-31). The live
// preview on /settings/receipt is drawn by the till's OWN formatter,
// src/lib/pos/receipt.ts renderReceipt, which takes a SaleSnapshot — the shape
// the till stores for every completed sale. This file builds one from two
// sample lines — a dish on the default rate and a drink on a second live rate
// when the restaurant has one, so a receipt that mixes rates shows its per-rate
// rows — and one exact cash payment. NOTHING is stored: orderId and
// posSessionId are the string 'sample', and no table ever sees it.
//
// EVERY FIGURE COMES FROM THE MONEY MODULE (invariants 1 and 7): the totals
// from computeOrderTotals and the per-rate rows from taxBreakdown, with THE
// rounding rule, exactly as src/lib/pos/orders.ts completeSale does for a real
// sale; the line amounts through multiplyByInteger. The page then prints the
// stored strings and computes nothing — the tripwire in
// receipt-page.integration.test.ts pins that by name.
//
// RELATIVE IMPORTS, the src/routes/(dashboard)/menu/helpers.ts precedent: the
// unit project in vitest.config.ts has no $lib alias, and sample.test.ts runs
// there. The SaleSnapshot import is type-only and is erased.
import { minor, multiplyByInteger, ROUNDING_RULE } from '../../../../lib/money';
import {
	computeOrderTotals,
	serializeTotals,
	taxBreakdown,
	type TotalsLine
} from '../../../../lib/money/order-totals';
import type { TaxMode } from '../../../../lib/money/tax';
import { formatInvoiceNumber } from '../../../../lib/sync-ops';
import type { SaleSnapshot } from '../../../../lib/pos/store';

/** A live tax rate as the load lists it: the id and name print beside the number. */
export type SampleRate = { id: string; name: string; rateBp: number };

export type SampleSaleInput = {
	currencyCode: string;
	taxMode: TaxMode;
	/** `rates[0]` is the default; `rates[1]`, when present, a second live rate. */
	rates: ReadonlyArray<SampleRate>;
	/** The built-in Cash row, or null for a restaurant built by hand. */
	cash: { id: string; name: string } | null;
	now: Date;
};

const DISH_PRICE = minor(850n);
const DRINK_PRICE = minor(300n);
const DRINK_QUANTITY = 2n;

/**
 * Two lines — `Sample dish` ×1 on the default rate, `Sample drink` ×2 on the
 * second rate when there is one — no modifiers, no discount, paid in cash to
 * the cent (tendered = total, so there is no change to compute). Throws
 * RangeError when `rates` is empty: the preview is blocked until the owner has
 * chosen a default rate, so an empty list is a caller's bug, not a state.
 */
export function sampleSale(input: SampleSaleInput): SaleSnapshot {
	const dishRate = input.rates[0];
	if (dishRate === undefined) throw new RangeError('sampleSale needs at least one tax rate');
	const drinkRate = input.rates[1] ?? dishRate;

	// The SAME lines, in the SAME order, feed computeOrderTotals and taxBreakdown
	// (lineRates[i] describes totals.lines[i]), as completeSale does.
	const lines: TotalsLine[] = [
		{
			unitPriceMinor: DISH_PRICE,
			quantity: 1n,
			modifierDeltasMinor: [],
			taxRateBp: dishRate.rateBp,
			discountMinor: minor(0n)
		},
		{
			unitPriceMinor: DRINK_PRICE,
			quantity: DRINK_QUANTITY,
			modifierDeltasMinor: [],
			taxRateBp: drinkRate.rateBp,
			discountMinor: minor(0n)
		}
	];
	const totals = computeOrderTotals({ taxMode: input.taxMode, lines }, ROUNDING_RULE);
	const breakdown = taxBreakdown(
		totals,
		[
			{ rateBp: dishRate.rateBp, name: dishRate.name },
			{ rateBp: drinkRate.rateBp, name: drinkRate.name }
		],
		ROUNDING_RULE
	);
	const total = totals.total.toString();
	const nowIso = input.now.toISOString();

	return {
		payload: {
			orderId: 'sample',
			posSessionId: 'sample',
			orderType: 'dine_in',
			tableLabel: '4',
			note: null,
			taxMode: input.taxMode,
			currencyCode: input.currencyCode,
			menuVersion: 0,
			invoiceSeq: 1,
			invoiceNumber: formatInvoiceNumber('POS1', 1),
			openedAt: nowIso,
			lines: [
				{
					lineId: 'sample-1',
					lineNo: 1,
					menuItemId: 'sample-dish',
					itemName: 'Sample dish',
					quantity: 1,
					unitPriceMinor: DISH_PRICE.toString(),
					taxRateBp: dishRate.rateBp,
					taxRateId: dishRate.id,
					taxRateName: dishRate.name,
					discountMinor: '0',
					modifiers: []
				},
				{
					lineId: 'sample-2',
					lineNo: 2,
					menuItemId: 'sample-drink',
					itemName: 'Sample drink',
					quantity: 2,
					unitPriceMinor: DRINK_PRICE.toString(),
					taxRateBp: drinkRate.rateBp,
					taxRateId: drinkRate.id,
					taxRateName: drinkRate.name,
					discountMinor: '0',
					modifiers: []
				}
			],
			totals: serializeTotals(totals),
			payments: [
				{
					paymentId: 'sample',
					method: 'cash',
					amountMinor: total,
					tenderedMinor: total,
					changeMinor: '0',
					paymentMethodId: input.cash?.id ?? null,
					paymentMethodName: input.cash?.name ?? 'Cash'
				}
			]
		},
		lineAmountsMinor: [
			DISH_PRICE.toString(),
			multiplyByInteger(DRINK_PRICE, DRINK_QUANTITY).toString()
		],
		cashierName: 'Sample cashier',
		completedAt: nowIso,
		businessDate: nowIso.slice(0, 10),
		// Decimal strings, as the till stores them (T-19) and the formatter reads
		// them (T-23).
		taxBreakdown: breakdown.map((row) => ({
			name: row.name,
			rateBp: row.rateBp,
			taxMinor: row.tax.toString()
		}))
	};
}
