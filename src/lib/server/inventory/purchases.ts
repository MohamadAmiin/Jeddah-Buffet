// DELIVERIES — spec 19's purchases (tasks/inventory-cogs T-20, T-22).
//
// A delivery is entered in PURCHASE units, converted to BASE units with the
// unit's base_qty_per_unit, costed into the weighted average and posted
// Dr 1200 Inventory / Cr 1000 Cash on Hand | 1010 Bank | 2000 Accounts Payable
// (spec 19, 24). "Cash" means cash kept outside the till (CLAUDE.md,
// "Inventory 3"); the supplier is a free-text name — Accounts Payable is in the
// MVP, supplier management is not.
//
// Stock enters ONLY through applyMovements (invariant 6 — it recomputes the
// average; nothing here does), money ONLY through the posting rules and
// postEntry / postReversal (invariant 3). The business date is the owner's
// choice on the form, never derived from recorded_at (invariant 11).
//
// CORRECTIONS ARE REVERSALS, NEVER EDITS (invariant 2, spec 22). A header's
// journal_entry_id and reversal stamp are written ONCE; nothing ever updates its
// supplier, date, paid_by or total, and its lines are append-only (migration
// 0014). Every function takes the caller's tx, is restaurant-scoped, audits in
// that tx (invariant 10) and answers business refusals as { ok: false, reason }.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { ingredientPurchaseUnits, ingredients } from '../db/schema/inventory';
import { purchaseLines as purchaseLinesTable, purchases } from '../db/schema/purchases';
import { writeAudit } from '../audit';
import { postEntry } from '../accounting/journal';
import { purchaseEvent, purchaseLines, revaluationLines } from '../accounting/posting-rules';
import { ROUNDING_RULE, minor, sum, toBigInt, type Minor } from '../../money';
import { formatQty, mulQty, parseQty, type Qty } from '../../money/quantity';
import { applyMovements } from './movements';
import type { InventoryWriteContext } from './ingredients';

export const MAX_PURCHASE_LINES = 50;
export const PAID_BY = ['cash', 'bank', 'credit'] as const;
export type PaidBy = (typeof PAID_BY)[number];

export type PurchaseLineInput = {
	ingredientId: string;
	purchaseUnitId: string;
	unitQty: Qty;
	lineCostMinor: Minor;
};

export type RecordPurchaseInput = {
	supplierName: string;
	businessDate: string;
	paidBy: PaidBy;
	note?: string | null;
	lines: readonly PurchaseLineInput[];
};

export type RecordPurchaseResult =
	| { ok: true; purchaseId: string; revaluationMinor: Minor }
	| { ok: false; reason: 'no_lines' | 'too_many_lines' }
	| { ok: false; reason: 'invalid_line'; lineNo: number };

export async function recordPurchase(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: RecordPurchaseInput
): Promise<RecordPurchaseResult> {
	if (!(PAID_BY as readonly string[]).includes(input.paidBy)) {
		throw new TypeError(`paid by must be one of ${PAID_BY.join(', ')}`);
	}
	if (input.lines.length === 0) return { ok: false, reason: 'no_lines' };
	if (input.lines.length > MAX_PURCHASE_LINES) return { ok: false, reason: 'too_many_lines' };
	const invalid = (index: number) => ({
		ok: false as const,
		reason: 'invalid_line' as const,
		lineNo: index + 1
	});

	// The units, scoped to the restaurant, with their ingredient's archive state.
	const unitIds = [...new Set(input.lines.map((l) => l.purchaseUnitId))];
	const units = await tx
		.select({
			id: ingredientPurchaseUnits.id,
			ingredientId: ingredientPurchaseUnits.ingredientId,
			name: ingredientPurchaseUnits.name,
			baseQtyPerUnit: ingredientPurchaseUnits.baseQtyPerUnit,
			unitArchivedAt: ingredientPurchaseUnits.archivedAt,
			ingredientArchivedAt: ingredients.archivedAt
		})
		.from(ingredientPurchaseUnits)
		.innerJoin(
			ingredients,
			and(
				eq(ingredients.id, ingredientPurchaseUnits.ingredientId),
				eq(ingredients.restaurantId, ingredientPurchaseUnits.restaurantId)
			)
		)
		.where(
			and(
				eq(ingredientPurchaseUnits.restaurantId, ctx.restaurantId),
				inArray(ingredientPurchaseUnits.id, unitIds)
			)
		);
	const unitById = new Map(units.map((u) => [u.id, u]));

	const lines: (PurchaseLineInput & { unitName: string; baseQtyPerUnit: Qty; baseQty: Qty })[] = [];
	for (const [index, line] of input.lines.entries()) {
		const unit = unitById.get(line.purchaseUnitId);
		if (
			!unit ||
			unit.unitArchivedAt !== null ||
			unit.ingredientArchivedAt !== null ||
			unit.ingredientId !== line.ingredientId
		) {
			return invalid(index);
		}
		if (typeof line.unitQty !== 'bigint' || line.unitQty <= 0n) return invalid(index);
		if (typeof line.lineCostMinor !== 'bigint' || line.lineCostMinor < 0n) return invalid(index);
		const baseQtyPerUnit = parseQty(unit.baseQtyPerUnit);
		const baseQty = mulQty(line.unitQty, baseQtyPerUnit, ROUNDING_RULE);
		if (baseQty === 0n) return invalid(index);
		lines.push({ ...line, unitName: unit.name, baseQtyPerUnit, baseQty });
	}

	const purchaseId = randomUUID();
	const supplierName = input.supplierName.trim();
	const total = sum(lines.map((l) => l.lineCostMinor));

	await tx.insert(purchases).values({
		id: purchaseId,
		restaurantId: ctx.restaurantId,
		supplierName,
		businessDate: input.businessDate,
		paidBy: input.paidBy,
		totalMinor: toBigInt(total),
		note: input.note?.trim() || null,
		recordedByUserId: ctx.actorUserId
	});
	await tx.insert(purchaseLinesTable).values(
		lines.map((line, index) => ({
			restaurantId: ctx.restaurantId,
			purchaseId,
			lineNo: index + 1,
			ingredientId: line.ingredientId,
			purchaseUnitName: line.unitName,
			unitQty: formatQty(line.unitQty),
			baseQtyPerUnit: formatQty(line.baseQtyPerUnit),
			baseQty: formatQty(line.baseQty),
			lineCostMinor: toBigInt(line.lineCostMinor)
		}))
	);

	// Two lines of one ingredient are two requests, applied in line order.
	const { revaluationMinor } = await applyMovements(
		tx,
		{
			restaurantId: ctx.restaurantId,
			sourceType: 'purchase',
			sourceId: purchaseId,
			businessDate: input.businessDate,
			occurredAt: new Date(),
			recordedByUserId: ctx.actorUserId
		},
		lines.map((line) => ({
			kind: 'inbound' as const,
			type: 'purchase' as const,
			ingredientId: line.ingredientId,
			qty: line.baseQty,
			costMinor: line.lineCostMinor
		}))
	);

	// A zero total posts nothing (postEntry returns null): stock moved, money did not.
	const entry = await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: input.businessDate,
		event: purchaseEvent(input.paidBy),
		sourceType: 'purchase',
		sourceId: purchaseId,
		memo: `Delivery from ${supplierName}`,
		lines: purchaseLines(input.paidBy, total)
	});
	if (revaluationMinor !== 0n) {
		// A delivery into zero or negative stock re-values the goods already sold at
		// this delivery's price; the gap goes to 5000 (CLAUDE.md, "Inventory 2").
		await postEntry(tx, {
			restaurantId: ctx.restaurantId,
			businessDate: input.businessDate,
			event: 'inventory_revaluation',
			sourceType: 'purchase',
			sourceId: purchaseId,
			memo: `Revaluation on delivery from ${supplierName}`,
			lines: revaluationLines(revaluationMinor)
		});
	}
	if (entry) {
		await tx
			.update(purchases)
			.set({ journalEntryId: entry.entryId })
			.where(
				and(
					eq(purchases.id, purchaseId),
					eq(purchases.restaurantId, ctx.restaurantId),
					isNull(purchases.journalEntryId)
				)
			);
	}

	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'purchase.recorded',
		details: {
			purchaseId,
			supplierName,
			paidBy: input.paidBy,
			totalMinor: total.toString(),
			lineCount: lines.length
		}
	});
	return { ok: true, purchaseId, revaluationMinor };
}

// ── Readers ─────────────────────────────────────────────────────────────────

export type PurchaseSummary = {
	id: string;
	supplierName: string;
	businessDate: string;
	paidBy: PaidBy;
	totalMinor: Minor;
	recordedAt: Date;
	reversed: boolean;
};

export async function listPurchases(
	executor: Executor,
	restaurantId: string,
	options: { limit: number }
): Promise<PurchaseSummary[]> {
	const rows = await executor
		.select({
			id: purchases.id,
			supplierName: purchases.supplierName,
			businessDate: purchases.businessDate,
			paidBy: purchases.paidBy,
			totalMinor: purchases.totalMinor,
			recordedAt: purchases.recordedAt,
			reversedAt: purchases.reversedAt
		})
		.from(purchases)
		.where(eq(purchases.restaurantId, restaurantId))
		.orderBy(desc(purchases.recordedAt), desc(purchases.id))
		.limit(options.limit);
	return rows.map((r) => ({
		id: r.id,
		supplierName: r.supplierName,
		businessDate: r.businessDate,
		paidBy: r.paidBy as PaidBy,
		totalMinor: minor(r.totalMinor),
		recordedAt: r.recordedAt,
		reversed: r.reversedAt !== null
	}));
}

export type PurchaseDetail = PurchaseSummary & {
	note: string | null;
	reversedAt: Date | null;
	reversalReason: string | null;
	journalEntryId: string | null;
	reversalEntryId: string | null;
	lines: {
		lineNo: number;
		ingredientId: string;
		ingredientName: string;
		purchaseUnitName: string;
		unitQty: Qty;
		baseQtyPerUnit: Qty;
		baseQty: Qty;
		lineCostMinor: Minor;
	}[];
};

export async function getPurchase(
	executor: Executor,
	restaurantId: string,
	id: string
): Promise<PurchaseDetail | null> {
	const [header] = await executor
		.select()
		.from(purchases)
		.where(and(eq(purchases.id, id), eq(purchases.restaurantId, restaurantId)));
	if (!header) return null;
	const lines = await executor
		.select({
			lineNo: purchaseLinesTable.lineNo,
			ingredientId: purchaseLinesTable.ingredientId,
			ingredientName: ingredients.name,
			purchaseUnitName: purchaseLinesTable.purchaseUnitName,
			unitQty: purchaseLinesTable.unitQty,
			baseQtyPerUnit: purchaseLinesTable.baseQtyPerUnit,
			baseQty: purchaseLinesTable.baseQty,
			lineCostMinor: purchaseLinesTable.lineCostMinor
		})
		.from(purchaseLinesTable)
		.innerJoin(
			ingredients,
			and(
				eq(ingredients.id, purchaseLinesTable.ingredientId),
				eq(ingredients.restaurantId, purchaseLinesTable.restaurantId)
			)
		)
		.where(
			and(eq(purchaseLinesTable.purchaseId, id), eq(purchaseLinesTable.restaurantId, restaurantId))
		)
		.orderBy(asc(purchaseLinesTable.lineNo));
	return {
		id: header.id,
		supplierName: header.supplierName,
		businessDate: header.businessDate,
		paidBy: header.paidBy as PaidBy,
		totalMinor: minor(header.totalMinor),
		recordedAt: header.recordedAt,
		reversed: header.reversedAt !== null,
		note: header.note,
		reversedAt: header.reversedAt,
		reversalReason: header.reversalReason,
		journalEntryId: header.journalEntryId,
		reversalEntryId: header.reversalEntryId,
		lines: lines.map((l) => ({
			lineNo: l.lineNo,
			ingredientId: l.ingredientId,
			ingredientName: l.ingredientName,
			purchaseUnitName: l.purchaseUnitName,
			unitQty: parseQty(l.unitQty),
			baseQtyPerUnit: parseQty(l.baseQtyPerUnit),
			baseQty: parseQty(l.baseQty),
			lineCostMinor: minor(l.lineCostMinor)
		}))
	};
}
