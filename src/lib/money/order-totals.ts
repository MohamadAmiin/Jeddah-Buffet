// COMPUTE ORDER TOTALS — the one function that turns an order's lines into the
// five ledger integers a sale is recorded and posted from, shaped so that the
// sale's journal entry BALANCES BY CONSTRUCTION (invariant 3):
//   Dr total + Dr discount = Cr subtotal + Cr tax  (T-13's sale rule)
// with net = total − tax and subtotal = net + discount derived by integer
// arithmetic, never rounded a second time. Spec 17: full precision per line;
// rounded once on the invoice total, discount and tax; one rounding rule in one
// function.
//
// ISOMORPHIC and imported by the till (T-24, T-33), the server (T-18, T-19)
// and the report (T-35). Its ONLY imports are `./index` and `./tax`; not
// `$lib/...`, not `../sync-ops`, no path under `$lib/server` (ESLint errors
// on it in this directory), not a `node:` builtin, not a package. Reads no
// setting, resolves no null rate (choosing the line's rate — the item's own or
// the restaurant default — is the caller's job).
//
// This file rounds through roundToMinor only: computeOrderTotals rounds three
// times per order (total, tax, discount); taxBreakdown rounds once per rate
// group, CUMULATIVELY, so its rows split the tax computeOrderTotals rounded and
// add back to it exactly — it never rounds a line
// (tasks/settings-tax-payments-receipt T-09).

import {
	add,
	addExact,
	exact,
	minor,
	multiplyByInteger,
	roundToMinor,
	subtract,
	sum,
	sumExact,
	type Exact,
	type Minor,
	type RoundingRule
} from './index';
import { taxOnAmount, type TaxMode } from './tax';

export type TotalsLine = {
	/** The price STORED on the line, never re-read from the menu. */
	unitPriceMinor: Minor;
	/** A `bigint` count. `3n`, never `3`. */
	quantity: bigint;
	/** One entry per chosen modifier; negative deltas are legal. */
	modifierDeltasMinor: Minor[];
	/** The RESOLVED rate: the item's own or the restaurant's; 825 is 8.25%. */
	taxRateBp: number;
	/** A whole-line discount in minor units; `0n` everywhere in this plan. */
	discountMinor: Minor;
};

export type OrderTotals = {
	/** Cr 4000 Sales Revenue */
	subtotal: Minor;
	/** Dr 4100 Sales Discounts */
	discount: Minor;
	/** Cr 2100 Tax Payable */
	tax: Minor;
	/** Dr 1000 Cash on Hand / 1020 / 1030 — what the customer pays */
	total: Minor;
	/** total − tax; equals subtotal when there is no discount */
	net: Minor;
	lines: { undiscountedNet: Exact; net: Exact; tax: Exact; gross: Exact }[];
};

const subtractExact = (a: Exact, b: Exact): Exact =>
	addExact(a, exact(-b.numerator, b.denominator));

export function computeOrderTotals(
	input: { taxMode: TaxMode; lines: TotalsLine[] },
	rule: RoundingRule
): OrderTotals {
	const lines: OrderTotals['lines'] = [];
	for (const line of input.lines) {
		if (typeof line.quantity !== 'bigint') {
			throw new TypeError('quantity is a bigint (3n), never a number');
		}
		if (line.quantity < 1n) {
			throw new RangeError('quantity must be at least 1');
		}
		if (line.discountMinor < 0n) {
			throw new RangeError('line discount cannot be negative');
		}
		const unit = add(line.unitPriceMinor, sum(line.modifierDeltasMinor));
		const base = multiplyByInteger(unit, line.quantity);
		const amount = subtract(base, line.discountMinor);
		if (amount < 0n) throw new RangeError('discount exceeds the line');
		const undiscountedNet = taxOnAmount(exact(base), line.taxRateBp, input.taxMode).net;
		const { net, tax, gross } = taxOnAmount(exact(amount), line.taxRateBp, input.taxMode);
		lines.push({ undiscountedNet, net, tax, gross });
	}

	const total = roundToMinor(sumExact(lines.map((l) => l.gross)), rule);
	const tax = roundToMinor(sumExact(lines.map((l) => l.tax)), rule);
	const discount = roundToMinor(
		sumExact(lines.map((l) => subtractExact(l.undiscountedNet, l.net))),
		rule
	);
	const net = subtract(total, tax);
	const subtotal = add(net, discount);
	return { subtotal, discount, tax, total, net, lines };
}

/** Wire shape of SaleCompletePayload['totals'] (T-03). Each bigint as its
 * decimal string (`850n` → `'850'`); `bigint` cannot cross JSON. */
export function serializeTotals(t: OrderTotals): {
	subtotalMinor: string;
	discountMinor: string;
	taxMinor: string;
	totalMinor: string;
} {
	return {
		subtotalMinor: t.subtotal.toString(),
		discountMinor: t.discount.toString(),
		taxMinor: t.tax.toString(),
		totalMinor: t.total.toString()
	};
}

/** Server-side totals_mismatch check (T-18) and the till's totalsMatch guard
 * (T-24) both call this by name — deep equality on the four ledger fields.
 * `net` is implied by `total − tax`; `lines` is never compared. */
export function totalsEqual(
	a: Pick<OrderTotals, 'subtotal' | 'discount' | 'tax' | 'total'>,
	b: Pick<OrderTotals, 'subtotal' | 'discount' | 'tax' | 'total'>
): boolean {
	return (
		a.subtotal === b.subtotal && a.discount === b.discount && a.tax === b.tax && a.total === b.total
	);
}

export type TaxBreakdownRow = { rateBp: number; name: string | null; tax: Minor };

/**
 * The order's tax split by rate, for the receipt. `lineRates[i]` describes
 * `totals.lines[i]`. Lines are grouped by (rateBp, name) in first-appearance
 * order. Each group's EXACT tax is summed, and the groups are rounded
 * CUMULATIVELY with the one rule: r_k = roundToMinor(S_k, rule), where S_k
 * is the exact tax of groups 1..k, and row k = r_k − r_{k−1}. So the rows
 * add up to roundToMinor(S_n) = totals.tax by construction. It never rounds
 * a line, and it never rounds a group on its own. Pass the SAME rule
 * computeOrderTotals got (ROUNDING_RULE).
 */
export function taxBreakdown(
	totals: OrderTotals,
	lineRates: ReadonlyArray<{ rateBp: number; name: string | null }>,
	rule: RoundingRule
): TaxBreakdownRow[] {
	if (lineRates.length !== totals.lines.length) {
		throw new RangeError('taxBreakdown needs exactly one rate per order line');
	}
	const groups = new Map<string, { rateBp: number; name: string | null; exactTax: Exact }>();
	totals.lines.forEach((line, i) => {
		const { rateBp, name } = lineRates[i];
		const key = JSON.stringify([rateBp, name]);
		const group = groups.get(key);
		if (group) group.exactTax = addExact(group.exactTax, line.tax);
		else groups.set(key, { rateBp, name, exactTax: line.tax });
	});
	const rows: TaxBreakdownRow[] = [];
	let running = exact(0n);
	let previous = minor(0n);
	for (const group of groups.values()) {
		running = addExact(running, group.exactTax);
		const rounded = roundToMinor(running, rule);
		rows.push({ rateBp: group.rateBp, name: group.name, tax: subtract(rounded, previous) });
		previous = rounded;
	}
	if (previous !== totals.tax) {
		throw new Error(
			'taxBreakdown: the rows do not reconcile with totals.tax (same lines, same rule?)'
		);
	}
	return rows;
}
