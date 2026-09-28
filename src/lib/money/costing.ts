// WEIGHTED-AVERAGE COSTING — ISOMORPHIC, bigint only (spec 16, 15, 22; spec 33
// decision 7; invariants 1, 6 and 7).
//
// The rules below are "Shared contracts → Costing" in
// tasks/inventory-cogs/00-overview.md, implemented exactly. They CONSERVE VALUE:
// the cost a movement carries is exactly the change in stock value it causes
// (plus, for the two rules that need one, a named revaluation), so the stock
// ledger and account 1200 Inventory can never drift apart by a stranded cent.
// Do not "simplify" a rule back to cost = qty × value ÷ quantity: that version
// posts zero cost on every 2 g of a 5 kg bag and leaves the bag's whole value in
// 1200 at zero stock.
//
// A state is { qty, value, avgMicro }: qty in thousandths of a base unit (Qty),
// value in minor units (Minor), and the average in MICRO minor units per base
// unit — $5.50 per kg of a gram ingredient is 0.55 cents per gram = 550000n
// (CLAUDE.md, "Inventory 6"). After every rule: avgMicro >= 0; qty = 0 ⇒ value = 0;
// qty > 0 ⇒ value >= 0 — the same three are CHECKs on the ingredients table.
//
// Rounding goes through roundToMinor and nothing else (invariant 7): valueAt and
// unitCostMicro each round once, and a rule calls each at most once per field.
//
// Imports only ./index, ./quantity and ./tax.
import { exact, minor, roundToMinor, toBigInt, type Minor, type RoundingRule } from './index';
import { QTY_SCALE, qty, type Qty } from './quantity';

/** Micro minor units per minor unit: the average's extra precision. */
export const MICRO = 1_000_000n;

export type StockState = { qty: Qty; value: Minor; avgMicro: bigint };
export type Applied = { state: StockState; costMinor: Minor; revaluationMinor: Minor };

function min(a: bigint, b: bigint): bigint {
	return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
	return a > b ? a : b;
}

/**
 * The value of a quantity at an average — THE one place a stock value is
 * rounded. Zero exactly when the quantity is zero, which is what lets the last
 * gram carry the last cent.
 */
export function valueAt(q: Qty, avgMicro: bigint, rule: RoundingRule): Minor {
	if (q === 0n) return minor(0n);
	return roundToMinor(exact(q * avgMicro, QTY_SCALE * MICRO), rule);
}

/** value ÷ quantity as micro minor units per base unit. Only for a positive quantity. */
export function unitCostMicro(value: Minor, q: Qty, rule: RoundingRule): bigint {
	if (q <= 0n) {
		throw new RangeError('an average is computed only from a positive quantity');
	}
	return toBigInt(roundToMinor(exact(value * QTY_SCALE * MICRO, q), rule));
}

function state(q: bigint, value: bigint, avgMicro: bigint): StockState {
	return { qty: qty(q), value: minor(value), avgMicro };
}

/**
 * Goods IN at a known cost — a delivery line or opening stock.
 *
 * Into positive stock it averages. Into zero or NEGATIVE stock it does not: a
 * negative weight has no meaning, and the goods already sold before this
 * delivery was entered were costed at an average that is now known to be wrong.
 * So the whole position is re-valued at THIS delivery's unit cost (full
 * precision, one rounding), and the gap between that and the old value plus the
 * delivery is the revaluation, posted to 5000 Cost of Goods Sold (CLAUDE.md,
 * "Inventory 2").
 */
export function applyInbound(
	s: StockState,
	inQty: Qty,
	costMinor: Minor,
	rule: RoundingRule
): Applied {
	if (!(inQty > 0n) || !(costMinor >= 0n)) {
		throw new TypeError('an inbound movement needs a positive quantity and a non-negative cost');
	}
	const nextQty = s.qty + inQty;
	if (s.qty > 0n) {
		const nextValue = minor(s.value + costMinor);
		return {
			state: state(nextQty, nextValue, unitCostMicro(nextValue, qty(nextQty), rule)),
			costMinor,
			revaluationMinor: minor(0n)
		};
	}
	const avgMicro = toBigInt(roundToMinor(exact(costMinor * QTY_SCALE * MICRO, inQty), rule));
	const nextValue =
		nextQty === 0n ? minor(0n) : roundToMinor(exact(nextQty * costMinor, inQty), rule);
	return {
		state: state(nextQty, nextValue, avgMicro),
		costMinor,
		revaluationMinor: minor(nextValue - (s.value + costMinor))
	};
}

/**
 * Goods moved AT THE AVERAGE: 'out' for sale consumption, waste, a count
 * shortfall and a comp; 'in' for a count surplus. The average does not change.
 *
 * The cost is the CHANGE in stock value — the value the remaining quantity has
 * at the average, minus the value held now — never quantity × average on its
 * own. So when the quantity reaches zero the value reaches zero with it: the
 * last gram carries the last cent, and no value is ever stranded in 1200 at
 * zero stock. An 'out' never adds value and an 'in' never removes it.
 */
export function applyAtAverage(
	s: StockState,
	moveQty: Qty,
	direction: 'out' | 'in',
	rule: RoundingRule
): Applied {
	if (!(moveQty > 0n)) {
		throw new TypeError('a movement at the average needs a positive quantity');
	}
	if (direction !== 'out' && direction !== 'in') {
		throw new TypeError(`unknown direction: ${String(direction)}`);
	}
	const nextQty = direction === 'out' ? s.qty - moveQty : s.qty + moveQty;
	const target = valueAt(qty(nextQty), s.avgMicro, rule);
	const cost = direction === 'out' ? min(0n, target - s.value) : max(0n, target - s.value);
	return {
		state: state(nextQty, s.value + cost, s.avgMicro),
		costMinor: minor(cost),
		revaluationMinor: minor(0n)
	};
}

/**
 * A delivery reversed at its ORIGINAL line cost (spec 22): the goods leave at
 * the price they came in at, which is what cancels the original entry.
 *
 * The average is recomputed only when BOTH the remaining quantity and the
 * remaining value are positive. From anything else it would be meaningless or
 * negative — and a negative average gives every later sale a positive cost, so
 * pay.ts would silently skip its COGS entry. In that case the average stays,
 * the stock is valued at it, and the gap is a revaluation to 5000 (CLAUDE.md,
 * "Inventory 2").
 */
export function applyReversal(
	s: StockState,
	outQty: Qty,
	originalCostMinor: Minor,
	rule: RoundingRule
): Applied {
	if (!(outQty > 0n) || !(originalCostMinor >= 0n)) {
		throw new TypeError('a reversal needs a positive quantity and a non-negative original cost');
	}
	const nextQty = s.qty - outQty;
	const raw = minor(s.value - originalCostMinor);
	const costMinor = minor(-originalCostMinor);
	if (nextQty > 0n && raw > 0n) {
		return {
			state: state(nextQty, raw, unitCostMicro(raw, qty(nextQty), rule)),
			costMinor,
			revaluationMinor: minor(0n)
		};
	}
	const nextValue = valueAt(qty(nextQty), s.avgMicro, rule);
	return {
		state: state(nextQty, nextValue, s.avgMicro),
		costMinor,
		revaluationMinor: minor(nextValue - raw)
	};
}
