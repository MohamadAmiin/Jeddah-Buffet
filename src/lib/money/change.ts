// CHANGE AND QUICK-TENDER KEYS — the one place the till subtracts a tender
// from an order total. Isomorphic; called by the pay screen (T-34) to show
// the change and the quick-tender keys, by completeSale (T-24) to fill
// SalePayment.changeMinor for a cash payment, and by the server's validator
// (T-18) to check that a cash payment's changeMinor equals
// tenderedMinor - amountMinor. No Svelte component does this subtraction
// itself (invariant 1). Reads no setting. Rounds nothing — the total came
// from computeOrderTotals and the tender is a whole minor unit already.

import { minor, subtract, type Minor } from './index';

/** The change owed to the customer for a cash payment. Throws when
 * `tendered < total` — a shortfall is refused, never a negative change. */
export function changeDue(tendered: Minor, total: Minor): Minor {
	if (tendered < total) {
		throw new RangeError('tendered is less than the amount due');
	}
	return subtract(tendered, total);
}

/** The one-tap cash keys the pay screen offers: the exact total, then the
 * next whole major unit above it, the next round 5 of the major unit and the
 * next round 10 — de-duplicated, ascending, always 1..4 entries with entry 0
 * the exact total. `exponent` comes from moneyFormatFor(code).exponent in
 * src/lib/money/format.ts at the call site (100 for USD, exponent 2). */
export function quickTenders(total: Minor, exponent: number): Minor[] {
	if (!Number.isSafeInteger(exponent) || exponent < 0) {
		throw new RangeError('exponent must be a non-negative integer');
	}
	if (total < 0n) {
		throw new RangeError('total cannot be negative');
	}
	if (total === 0n) return [minor(0n)];
	const major = 10n ** BigInt(exponent);
	// bigint division truncates toward zero; the + 1n makes each rounded key
	// STRICTLY above the total (2000 → 2100, not 2000).
	const nextAbove = (step: bigint): Minor => minor(((total as bigint) / step + 1n) * step);
	const candidates: Minor[] = [
		total,
		nextAbove(major),
		nextAbove(5n * major),
		nextAbove(10n * major)
	];
	return [...new Set(candidates)];
}
