// consumeForSale — the inventory step of spec 13's payment transaction
// ("Deduct Inventory — recipes × quantity, incl. modifiers").
//
// recordSale (orders/pay.ts) calls it inside THE payment transaction, after the
// order, lines, payment and invoice rows are inserted and before the journal
// entries, and posts Dr 5000 Cost of Goods Sold / Cr 1200 Inventory for the
// returned cogsMinor whenever it is positive (spec 16: COGS on every sale). An
// offline sale runs the same transaction when it syncs (spec 13, 6).
//
// What it does, in the caller's tx:
//   1. reads the order's paid_at and its POS session's business date — the
//      movements carry the SESSION's business date, never a calendar date
//      (invariant 11), and paid_at as occurred_at (CLAUDE.md "Inventory 12");
//   2. reads the recipes of the sold items and chosen modifiers
//      (recipeIndexFor) and aggregates them, modifier deltas clamped at zero per
//      line (aggregateConsumption, CLAUDE.md "Inventory 11");
//   3. writes one sale_consumption movement per ingredient through the ONE
//      ledger writer (applyMovements), costed at the average current NOW — a
//      sale synced late is costed when it arrives (CLAUDE.md "Inventory 12");
//   4. returns the movements and the cost of goods sold, never negative.
//
// A dish with no recipe consumes nothing and posts no COGS. A sale recorded
// before its recipe existed never gains COGS later: posted records are permanent
// (invariant 2), so nothing back-fills them.
//
// IT NEVER THROWS FOR A BUSINESS REASON (invariant 4): an archived ingredient is
// consumed like any other, stock may go below zero (invariant 6: sales are never
// blocked, negative stock is flagged by the reports), an ingredient with no
// average costs zero. A throw here would roll a completed cash sale back into an
// `unrecorded` sync op and block the session close. It throws only for a
// programming error (the order row missing). It never catches, never opens a
// transaction, and never posts a journal entry — recordSale posts. Cost comes
// only from the ledger, never from a menu price.
import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { orders } from '../db/schema/orders';
import { posSessions } from '../db/schema/pos-sessions';
import { minor, negate, type Minor } from '../../money';
import type { SaleLine } from '../../sync-ops';
import { aggregateConsumption } from './consumption';
import { recipeIndexFor } from './recipes';
import { applyMovements, type MovementRequest, type StockMovementRow } from './movements';

export type ConsumeArgs = { restaurantId: string; orderId: string; lines: SaleLine[] };
export type ConsumeResult = { movements: StockMovementRow[]; cogsMinor: Minor };

export async function consumeForSale(tx: DbTx, args: ConsumeArgs): Promise<ConsumeResult> {
	const [order] = await tx
		.select({ businessDate: posSessions.businessDate, paidAt: orders.paidAt })
		.from(orders)
		.innerJoin(
			posSessions,
			and(
				eq(posSessions.id, orders.posSessionId),
				eq(posSessions.restaurantId, orders.restaurantId)
			)
		)
		.where(and(eq(orders.id, args.orderId), eq(orders.restaurantId, args.restaurantId)));
	if (!order) throw new Error('consumeForSale: order not found');

	const itemIds = [...new Set(args.lines.map((line) => line.menuItemId))];
	const modifierIds = [
		...new Set(args.lines.flatMap((line) => line.modifiers.map((m) => m.modifierId)))
	];
	const index = await recipeIndexFor(tx, args.restaurantId, itemIds, modifierIds);
	const used = aggregateConsumption(args.lines, index);
	if (used.size === 0) return { movements: [], cogsMinor: minor(0n) };

	const requests: MovementRequest[] = [...used].map(([ingredientId, qty]) => ({
		kind: 'out',
		type: 'sale_consumption',
		ingredientId,
		qty
	}));
	const { movements, costMinor } = await applyMovements(
		tx,
		{
			restaurantId: args.restaurantId,
			sourceType: 'order',
			sourceId: args.orderId,
			businessDate: order.businessDate,
			occurredAt: order.paidAt,
			recordedByUserId: null
		},
		requests
	);
	// An 'out' never carries a positive cost, so the negation is never negative.
	return { movements, cogsMinor: negate(costMinor) };
}
