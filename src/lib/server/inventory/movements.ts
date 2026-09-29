// THE STOCK LEDGER WRITER (spec 3, 15, 16; invariant 6).
//
// ONE WRITER. applyMovements is the only code that inserts into stock_movements
// or writes the three cache columns on ingredients — on_hand_qty,
// inventory_value_minor, avg_unit_cost_micro. Every path goes through it: sale
// consumption, deliveries, reversals, opening stock, waste and counts. The caches
// are never the truth (the movements are); they are written here, only here, in
// the transaction that inserts the movements that changed them.
//
// ONE ORDERED LOCK. Its first statement locks EVERY affected ingredient row in a
// single `select … where id = any($ids) order by id for update`, reads the
// caches only from that result, and writes them under that lock, which is held
// until COMMIT. That prevents the two failures the risk panel ranked highest
// after the costing rules:
//   - a LOST UPDATE: a delivery saved while the till syncs a sale, both reading
//     the same cache and each writing an absolute value over the other's, so every
//     later sale is mis-costed;
//   - a DEADLOCK: one transaction locking in recipe order and another in delivery
//     line order. A deadlocked cash sale lands `unrecorded` in pos-sales. Locking
//     all rows at once, sorted by id, gives every transaction the same order.
// Never lock one ingredient at a time, and never read a cache column outside it.
//
// THE COSTING RULES are src/lib/money/costing.ts — applyInbound (delivery, opening
// stock), applyAtAverage 'out' (sale, waste, count shortfall, comp) and 'in'
// (count surplus), applyReversal (a delivery reversed at its original cost). A
// rule's non-zero revaluation becomes a second, zero-quantity 'revaluation' row.
//
// It never opens a transaction, never posts a journal entry (callers post from
// the returned sums) and never catches.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { ingredients, stockMovements } from '../db/schema/inventory';
import { ROUNDING_RULE, minor, sum, toBigInt, type Minor } from '../../money';
import { formatQty, parseQty, qty, type Qty } from '../../money/quantity';
import {
	applyAtAverage,
	applyInbound,
	applyReversal,
	type Applied,
	type StockState
} from '../../money/costing';

/** Spelled exactly as stock_movements_type_valid. */
export const MOVEMENT_TYPES = [
	'purchase',
	'purchase_reversal',
	'opening_stock',
	'sale_consumption',
	'waste',
	'count_adjustment',
	'comp',
	'revaluation'
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Spelled exactly as stock_movements_source_valid. */
export const MOVEMENT_SOURCES = [
	'purchase',
	'order',
	'waste_entry',
	'stock_count',
	'opening_stock'
] as const;
export type MovementSource = (typeof MOVEMENT_SOURCES)[number];

export type MovementRequest =
	| {
			kind: 'inbound';
			type: 'purchase' | 'opening_stock';
			ingredientId: string;
			qty: Qty;
			costMinor: Minor;
	  }
	| {
			kind: 'out';
			type: 'sale_consumption' | 'waste' | 'count_adjustment' | 'comp';
			ingredientId: string;
			qty: Qty;
	  }
	| { kind: 'in'; type: 'count_adjustment'; ingredientId: string; qty: Qty }
	| {
			kind: 'reversal';
			type: 'purchase_reversal';
			ingredientId: string;
			qty: Qty;
			originalCostMinor: Minor;
	  };

export type MovementContext = {
	restaurantId: string;
	sourceType: MovementSource;
	sourceId: string;
	/** 'YYYY-MM-DD' — the caller's business date, never derived here (invariant 11). */
	businessDate: string;
	occurredAt: Date;
	recordedByUserId: string | null;
};

export type LockedIngredient = {
	id: string;
	name: string;
	state: StockState;
	archivedAt: Date | null;
	hasInboundHistory: boolean;
};

export type StockMovementRow = typeof stockMovements.$inferSelect;

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lock the given ingredients of one restaurant, in ONE statement ordered by id,
 * FOR UPDATE, and return their current state. A missing id is a programming
 * error or tampering — no business path sends an unknown id — so it throws.
 */
export async function lockIngredients(
	tx: DbTx,
	restaurantId: string,
	ids: readonly string[]
): Promise<Map<string, LockedIngredient>> {
	const sorted = [...new Set(ids)].sort();
	const locked = new Map<string, LockedIngredient>();
	if (sorted.length === 0) return locked;

	const rows = await tx
		.select({
			id: ingredients.id,
			name: ingredients.name,
			onHandQty: ingredients.onHandQty,
			valueMinor: ingredients.inventoryValueMinor,
			avgMicro: ingredients.avgUnitCostMicro,
			archivedAt: ingredients.archivedAt,
			// Spelled with explicit qualifiers: drizzle renders columns unqualified
			// in a single-table select, and an unqualified "id" inside the subquery
			// would resolve to stock_movements.id.
			hasInboundHistory: sql<boolean>`exists (
				select 1 from stock_movements sm
				where sm.ingredient_id = "ingredients"."id"
				  and sm.movement_type in ('purchase', 'opening_stock')
			)`
		})
		.from(ingredients)
		.where(and(eq(ingredients.restaurantId, restaurantId), inArray(ingredients.id, sorted)))
		.orderBy(ingredients.id)
		.for('update', { of: ingredients });

	for (const row of rows) {
		locked.set(row.id, {
			id: row.id,
			name: row.name,
			state: {
				qty: parseQty(row.onHandQty),
				value: minor(row.valueMinor),
				avgMicro: row.avgMicro
			},
			archivedAt: row.archivedAt,
			hasInboundHistory: row.hasInboundHistory
		});
	}
	for (const id of sorted) {
		if (!locked.has(id)) throw new Error(`ingredient not found: ${id}`);
	}
	return locked;
}

function validate(ctx: MovementContext, requests: readonly MovementRequest[]): void {
	if (!BUSINESS_DATE.test(ctx.businessDate)) {
		throw new TypeError(`businessDate must be YYYY-MM-DD; got ${ctx.businessDate}`);
	}
	for (const r of requests) {
		if (typeof r.qty !== 'bigint' || r.qty <= 0n) {
			throw new TypeError(
				`a movement quantity must be a positive Qty (ingredient ${r.ingredientId})`
			);
		}
		if (r.kind === 'inbound' && !(r.costMinor >= 0n)) {
			throw new TypeError('an inbound cost must be a non-negative Minor');
		}
		if (r.kind === 'reversal' && !(r.originalCostMinor >= 0n)) {
			throw new TypeError('a reversal cost must be a non-negative Minor');
		}
	}
}

/**
 * Apply movements to the ledger: lock, cost, insert, write the caches once.
 * Requests are applied in the order given; the same ingredient may appear more
 * than once (two delivery lines). Returns the inserted rows, the summed cost of
 * the requested movements and the summed revaluation.
 */
export async function applyMovements(
	tx: DbTx,
	ctx: MovementContext,
	requests: readonly MovementRequest[]
): Promise<{ movements: StockMovementRow[]; costMinor: Minor; revaluationMinor: Minor }> {
	validate(ctx, requests);
	if (requests.length === 0) {
		return { movements: [], costMinor: minor(0n), revaluationMinor: minor(0n) };
	}

	const locked = await lockIngredients(
		tx,
		ctx.restaurantId,
		requests.map((r) => r.ingredientId)
	);
	const working = new Map<string, StockState>(
		[...locked].map(([id, ingredient]) => [id, ingredient.state])
	);

	const base = {
		restaurantId: ctx.restaurantId,
		sourceType: ctx.sourceType,
		sourceId: ctx.sourceId,
		businessDate: ctx.businessDate,
		occurredAt: ctx.occurredAt,
		recordedByUserId: ctx.recordedByUserId
	};
	const rows: (typeof stockMovements.$inferInsert)[] = [];
	// The totals are collected and summed by the money module (invariant 1).
	const costs: Minor[] = [];
	const revaluations: Minor[] = [];

	for (const r of requests) {
		const state = working.get(r.ingredientId)!;
		let applied: Applied;
		let signedQty: Qty;
		switch (r.kind) {
			case 'inbound':
				applied = applyInbound(state, r.qty, r.costMinor, ROUNDING_RULE);
				signedQty = r.qty;
				break;
			case 'out':
				applied = applyAtAverage(state, r.qty, 'out', ROUNDING_RULE);
				signedQty = qty(-r.qty);
				break;
			case 'in':
				applied = applyAtAverage(state, r.qty, 'in', ROUNDING_RULE);
				signedQty = r.qty;
				break;
			case 'reversal':
				applied = applyReversal(state, r.qty, r.originalCostMinor, ROUNDING_RULE);
				signedQty = qty(-r.qty);
				break;
			default:
				throw new TypeError(`unknown movement kind: ${String((r as { kind: unknown }).kind)}`);
		}
		working.set(r.ingredientId, applied.state);

		rows.push({
			...base,
			ingredientId: r.ingredientId,
			movementType: r.type,
			qty: formatQty(signedQty),
			costMinor: toBigInt(applied.costMinor)
		});
		costs.push(applied.costMinor);

		if (applied.revaluationMinor !== 0n) {
			rows.push({
				...base,
				ingredientId: r.ingredientId,
				movementType: 'revaluation',
				qty: formatQty(qty(0n)),
				costMinor: toBigInt(applied.revaluationMinor)
			});
			revaluations.push(applied.revaluationMinor);
		}
	}

	const movements = await tx.insert(stockMovements).values(rows).returning();

	for (const [id, state] of working) {
		await tx
			.update(ingredients)
			.set({
				onHandQty: formatQty(state.qty),
				inventoryValueMinor: toBigInt(state.value),
				avgUnitCostMicro: state.avgMicro,
				updatedAt: sql`now()`
			})
			.where(and(eq(ingredients.id, id), eq(ingredients.restaurantId, ctx.restaurantId)));
	}

	return {
		movements,
		costMinor: sum(costs),
		revaluationMinor: sum(revaluations)
	};
}
