// Spec 24's posting-rule table as code. Every business event maps to a FIXED
// set of debit and credit lines; nobody types a debit. These functions emit
// zero-amount lines as they are — the journal writer drops them — and never
// round: they receive integers already rounded once by computeOrderTotals.
//
// Invariant 1: every arithmetic step on a Minor goes through src/lib/money;
// no raw + or - on a Minor anywhere in this file.

import { minor, negate, sum, add, type Minor } from '../../money';
import type { SalePayment } from '../../sync-ops';
import { CHART } from './chart';

export const POSTING_EVENTS = [
	'cash_sale',
	'card_sale',
	'mobile_sale',
	'cost_of_goods_sold',
	'cash_shortage_at_close',
	'cash_overage_at_close'
] as const;
export type PostingEvent = (typeof POSTING_EVENTS)[number];

export const SALE_EVENTS = ['cash_sale', 'card_sale', 'mobile_sale'] as const;
export type SaleEvent = (typeof SALE_EVENTS)[number];

/** Exactly ONE of debit / credit is present; the amount is a Minor and may be 0n. */
export type RuleLine = { code: string; debit?: Minor; credit?: Minor };

export type SaleTotals = {
	subtotal: Minor;
	discount: Minor;
	tax: Minor;
	total: Minor;
};

const CODE = {
	CASH_ON_HAND: '1000',
	CLEARING_CARD: '1020',
	CLEARING_MOBILE: '1030',
	INVENTORY: '1200',
	TAX_PAYABLE: '2100',
	SALES_REVENUE: '4000',
	SALES_DISCOUNTS: '4100',
	COGS: '5000',
	CASH_OVER_SHORT: '6800'
} as const;

// Fail at module load rather than at the first sale.
{
	const chartCodes = new Set(CHART.map((r) => r.code));
	for (const code of Object.values(CODE)) {
		if (!chartCodes.has(code)) {
			throw new Error(`posting rule names account ${code}, which is not in CHART`);
		}
	}
}

const TENDER_ACCOUNT: Record<SaleEvent, string> = {
	cash_sale: CODE.CASH_ON_HAND,
	card_sale: CODE.CLEARING_CARD,
	mobile_sale: CODE.CLEARING_MOBILE
};

/** Spec 24's "Cash sale", "Card / mobile sale" and "Sale with discount" in one
 * function. Balances by construction because
 * subtotal - discount + tax = total (T-10). */
export function saleLines(event: SaleEvent, t: SaleTotals): RuleLine[] {
	if (!(SALE_EVENTS as readonly string[]).includes(event)) {
		throw new RangeError(`not a sale event: ${event}`);
	}
	if (t.subtotal < 0n || t.discount < 0n || t.tax < 0n || t.total < 0n) {
		throw new RangeError('sale amounts cannot be negative — a refund is a different rule');
	}
	return [
		{ code: TENDER_ACCOUNT[event], debit: t.total },
		{ code: CODE.SALES_DISCOUNTS, debit: t.discount },
		{ code: CODE.SALES_REVENUE, credit: t.subtotal },
		{ code: CODE.TAX_PAYABLE, credit: t.tax }
	];
}

/** Spec 24 "Cost of food sold": Dr 5000 / Cr 1200. */
export function cogsLines(cost: Minor): RuleLine[] {
	if (cost < 0n) {
		throw new RangeError('cost cannot be negative');
	}
	return [
		{ code: CODE.COGS, debit: cost },
		{ code: CODE.INVENTORY, credit: cost }
	];
}

/** Spec 24 "Cash shortage/overage at session close". difference = counted -
 * expected: negative posts Dr 6800 / Cr 1000; positive posts Dr 1000 / Cr 6800;
 * zero posts nothing. */
export function overShortLines(difference: Minor): RuleLine[] {
	if (difference < 0n) {
		const magnitude = negate(difference);
		return [
			{ code: CODE.CASH_OVER_SHORT, debit: magnitude },
			{ code: CODE.CASH_ON_HAND, credit: magnitude }
		];
	}
	if (difference > 0n) {
		return [
			{ code: CODE.CASH_ON_HAND, debit: difference },
			{ code: CODE.CASH_OVER_SHORT, credit: difference }
		];
	}
	return [];
}

export function eventForMethod(method: SalePayment['method']): SaleEvent {
	switch (method) {
		case 'cash':
			return 'cash_sale';
		case 'card':
			return 'card_sale';
		case 'mobile':
			return 'mobile_sale';
		default:
			throw new RangeError(`unknown payment method: ${String(method)}`);
	}
}

export function overShortEvent(difference: Minor): PostingEvent | null {
	if (difference < 0n) return 'cash_shortage_at_close';
	if (difference > 0n) return 'cash_overage_at_close';
	return null;
}

/** Σdebit === Σcredit — check for tests and for T-14's callers, not a repair.
 * Uses sum from src/lib/money, never a raw + on a Minor (invariant 1). */
export function linesBalance(lines: readonly RuleLine[]): boolean {
	const debits = sum(lines.map((l) => l.debit ?? minor(0n)));
	const credits = sum(lines.map((l) => l.credit ?? minor(0n)));
	// `add(a, negate(b))` avoids a raw comparison of two Minors that might have
	// arisen from different summations; bigint value equality works the same.
	return add(debits, negate(credits)) === minor(0n);
}
