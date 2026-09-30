// OPENING STOCK (tasks/inventory-cogs T-23; CLAUDE.md, "Inventory 1").
//
// Stock already on the shelf when the restaurant starts using the system, which
// the owner contributes: Dr 1200 Inventory / Cr 3000 Owner's Capital, event
// opening_stock. Spec 24 has no row for it (its nearest is "Owner invests money |
// Cash on Hand or Bank | Owner's Capital"); the amendment is recorded in
// CLAUDE.md. This is NOT a purchase — it never credits 1000, 1010 or 2000.
//
// Allowed once per ingredient, and only while the ingredient has NO stock
// movement at all: its quantity and cost become the first average. It enters
// the ledger as a movement through the one writer (invariant 6); the
// opening_stock_entries row is inserted LAST and is append-only (migration 0014).
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import {
	ingredientPurchaseUnits,
	ingredients,
	openingStockEntries,
	stockMovements
} from '../db/schema/inventory';
import { writeAudit } from '../audit';
import { postEntry } from '../accounting/journal';
import { openingStockLines } from '../accounting/posting-rules';
import { ROUNDING_RULE, toBigInt, type Minor } from '../../money';
import { formatQty, mulQty, parseQty, type Qty } from '../../money/quantity';
import { extendCost } from '../../money/costing';
import { applyMovements, lockIngredients } from './movements';
import type { InventoryWriteContext } from './ingredients';

export type OpeningStockInput = {
	ingredientId: string;
	purchaseUnitId: string;
	unitQty: Qty;
	unitCostMinor: Minor;
	businessDate: string;
};

export async function recordOpeningStock(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: OpeningStockInput
): Promise<
	| { ok: true; entryId: string }
	| {
			ok: false;
			reason:
				'not_found' | 'invalid_unit' | 'has_movements' | 'already_recorded' | 'invalid_amount';
	  }
> {
	// Scoped existence first, so an unknown or foreign id is an answer, not the
	// programming-error throw lockIngredients raises.
	const [exists] = await tx
		.select({ id: ingredients.id })
		.from(ingredients)
		.where(
			and(eq(ingredients.id, input.ingredientId), eq(ingredients.restaurantId, ctx.restaurantId))
		);
	if (!exists) return { ok: false, reason: 'not_found' };
	await lockIngredients(tx, ctx.restaurantId, [input.ingredientId]);

	const [moved] = await tx
		.select({ id: stockMovements.id })
		.from(stockMovements)
		.where(
			and(
				eq(stockMovements.restaurantId, ctx.restaurantId),
				eq(stockMovements.ingredientId, input.ingredientId)
			)
		)
		.limit(1);
	if (moved) return { ok: false, reason: 'has_movements' };
	const [recorded] = await tx
		.select({ id: openingStockEntries.id })
		.from(openingStockEntries)
		.where(
			and(
				eq(openingStockEntries.restaurantId, ctx.restaurantId),
				eq(openingStockEntries.ingredientId, input.ingredientId)
			)
		);
	if (recorded) return { ok: false, reason: 'already_recorded' };

	const [unit] = await tx
		.select({
			name: ingredientPurchaseUnits.name,
			baseQtyPerUnit: ingredientPurchaseUnits.baseQtyPerUnit
		})
		.from(ingredientPurchaseUnits)
		.where(
			and(
				eq(ingredientPurchaseUnits.id, input.purchaseUnitId),
				eq(ingredientPurchaseUnits.restaurantId, ctx.restaurantId),
				eq(ingredientPurchaseUnits.ingredientId, input.ingredientId),
				isNull(ingredientPurchaseUnits.archivedAt)
			)
		);
	if (!unit) return { ok: false, reason: 'invalid_unit' };
	if (
		typeof input.unitQty !== 'bigint' ||
		input.unitQty <= 0n ||
		typeof input.unitCostMinor !== 'bigint' ||
		input.unitCostMinor < 0n
	) {
		return { ok: false, reason: 'invalid_amount' };
	}

	const baseQtyPerUnit = parseQty(unit.baseQtyPerUnit);
	const baseQty = mulQty(input.unitQty, baseQtyPerUnit, ROUNDING_RULE);
	if (baseQty === 0n) return { ok: false, reason: 'invalid_amount' };
	const value = extendCost(input.unitQty, input.unitCostMinor, ROUNDING_RULE);
	const entryId = randomUUID();

	await applyMovements(
		tx,
		{
			restaurantId: ctx.restaurantId,
			sourceType: 'opening_stock',
			sourceId: entryId,
			businessDate: input.businessDate,
			occurredAt: new Date(),
			recordedByUserId: ctx.actorUserId
		},
		[
			{
				kind: 'inbound',
				type: 'opening_stock',
				ingredientId: input.ingredientId,
				qty: baseQty,
				costMinor: value
			}
		]
	);
	// null for a zero value: stock arrives, no money moves.
	await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: input.businessDate,
		event: 'opening_stock',
		sourceType: 'opening_stock',
		sourceId: entryId,
		memo: 'Opening stock',
		lines: openingStockLines(value)
	});

	await tx.insert(openingStockEntries).values({
		id: entryId,
		restaurantId: ctx.restaurantId,
		ingredientId: input.ingredientId,
		purchaseUnitName: unit.name,
		unitQty: formatQty(input.unitQty),
		baseQtyPerUnit: formatQty(baseQtyPerUnit),
		baseQty: formatQty(baseQty),
		unitCostMinor: toBigInt(input.unitCostMinor),
		valueMinor: toBigInt(value),
		businessDate: input.businessDate,
		recordedByUserId: ctx.actorUserId
	});
	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'opening_stock.recorded',
		details: {
			entryId,
			ingredientId: input.ingredientId,
			qty: formatQty(baseQty),
			valueMinor: value.toString()
		}
	});
	return { ok: true, entryId };
}
