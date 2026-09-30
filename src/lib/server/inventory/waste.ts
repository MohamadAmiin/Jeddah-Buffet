// WASTE (spec 15, 24; tasks/inventory-cogs T-24).
//
// Goods thrown away leave stock at the weighted average through the one ledger
// writer (invariant 6) and post Dr 5100 Waste & Inventory Adjustments /
// Cr 1200 Inventory from the rule table (invariant 3). Waste that takes stock
// below zero is allowed — the reports flag negative stock, nothing prevents it.
// An ingredient never bought has average 0, so its waste costs nothing and posts
// no entry. The waste_entries row is inserted LAST and is append-only (migration
// 0014); a mistaken waste entry is not edited.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { ingredients, wasteEntries } from '../db/schema/inventory';
import { writeAudit } from '../audit';
import { postEntry } from '../accounting/journal';
import { wasteLines } from '../accounting/posting-rules';
import { negate, type Minor } from '../../money';
import { formatQty, type Qty } from '../../money/quantity';
import { applyMovements } from './movements';
import type { InventoryWriteContext } from './ingredients';

/** Spelled exactly as waste_entries_reason_valid. */
export const WASTE_REASONS = ['spoilage', 'preparation_error', 'breakage', 'other'] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export type WasteInput = {
	ingredientId: string;
	qty: Qty;
	reason: WasteReason;
	note?: string | null;
	businessDate: string;
};

export async function recordWaste(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: WasteInput
): Promise<
	| { ok: true; wasteId: string; costMinor: Minor }
	| { ok: false; reason: 'not_found' | 'ingredient_archived' | 'note_required' | 'invalid_qty' }
> {
	if (!(WASTE_REASONS as readonly string[]).includes(input.reason)) {
		throw new TypeError(`waste reason must be one of ${WASTE_REASONS.join(', ')}`);
	}
	if (typeof input.qty !== 'bigint' || input.qty <= 0n) return { ok: false, reason: 'invalid_qty' };
	const note = input.note?.trim() || null;
	if (input.reason === 'other' && (note === null || note.length < 3 || note.length > 200)) {
		return { ok: false, reason: 'note_required' };
	}

	const [ingredient] = await tx
		.select({ archivedAt: ingredients.archivedAt })
		.from(ingredients)
		.where(
			and(eq(ingredients.id, input.ingredientId), eq(ingredients.restaurantId, ctx.restaurantId))
		);
	if (!ingredient) return { ok: false, reason: 'not_found' };
	if (ingredient.archivedAt !== null) return { ok: false, reason: 'ingredient_archived' };

	const wasteId = randomUUID();
	const { costMinor } = await applyMovements(
		tx,
		{
			restaurantId: ctx.restaurantId,
			sourceType: 'waste_entry',
			sourceId: wasteId,
			businessDate: input.businessDate,
			occurredAt: new Date(),
			recordedByUserId: ctx.actorUserId
		},
		[{ kind: 'out', type: 'waste', ingredientId: input.ingredientId, qty: input.qty }]
	);
	// An 'out' never costs more than zero; null when the cost is 0.
	await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: input.businessDate,
		event: 'waste',
		sourceType: 'waste_entry',
		sourceId: wasteId,
		memo: `Waste: ${input.reason}`,
		lines: wasteLines(negate(costMinor))
	});

	await tx.insert(wasteEntries).values({
		id: wasteId,
		restaurantId: ctx.restaurantId,
		ingredientId: input.ingredientId,
		qty: formatQty(input.qty),
		reason: input.reason,
		note,
		businessDate: input.businessDate,
		recordedByUserId: ctx.actorUserId
	});
	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'waste.recorded',
		details: {
			wasteId,
			ingredientId: input.ingredientId,
			qty: formatQty(input.qty),
			reason: input.reason,
			costMinor: negate(costMinor).toString()
		}
	});
	return { ok: true, wasteId, costMinor: negate(costMinor) };
}
