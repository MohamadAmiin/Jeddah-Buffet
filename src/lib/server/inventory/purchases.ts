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
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { ingredientPurchaseUnits, ingredients } from '../db/schema/inventory';
import {
	purchaseLines as purchaseLinesTable,
	purchases,
	supplierPayments
} from '../db/schema/purchases';
import { writeAudit } from '../audit';
import { postEntry, postReversal } from '../accounting/journal';
import { purchaseEvent, purchaseLines, revaluationLines } from '../accounting/posting-rules';
import { ROUNDING_RULE, minor, sum, toBigInt, type Minor } from '../../money';
import { formatQty, mulQty, parseQty, type Qty } from '../../money/quantity';
import { applyMovements } from './movements';
import type { InventoryWriteContext } from './ingredients';
import {
	outstandingMinor,
	paymentsFor,
	reversalReason,
	type SupplierPaymentView
} from './payments';
import { todayInZone } from './business-date';

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

// ── Reversal (T-22) ─────────────────────────────────────────────────────────

/**
 * Reverse a whole delivery (spec 22): the goods leave at their ORIGINAL line
 * costs — never the current average — through the one ledger writer, and the
 * delivery's entry is mirrored by postReversal, both dated TODAY in the
 * restaurant's zone (CLAUDE.md, "Inventory 9"). Nothing is edited: the header
 * gets its once-written reversal stamp, everything else is a new row.
 *
 * Order matters. The purchase row is locked FOR UPDATE, then the stamp is a
 * conditional UPDATE that must affect exactly one row BEFORE any movement is
 * written: a racing second call fails at the lock check or the stamp and never
 * writes a movement. A credit delivery with an unreversed payment is refused;
 * the owner reverses the payments first.
 *
 * If taking the goods out leaves stock the average cannot describe, the ledger
 * returns a revaluation, posted as a NEW inventory_revaluation entry to 5000
 * (CLAUDE.md, "Inventory 2"). The delivery's own earlier revaluation entry, if
 * it had one, is deliberately NOT reversed: the new revaluation re-balances
 * stock value against 1200 from the state the ledger is in NOW, which already
 * includes that earlier one.
 */
export async function reversePurchase(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: { purchaseId: string; reason: string }
): Promise<
	| { ok: true; revaluationMinor: Minor }
	| { ok: false; reason: 'not_found' | 'already_reversed' | 'has_payments' | 'invalid_reason' }
> {
	const reason = reversalReason(input.reason);
	if (reason === null) return { ok: false, reason: 'invalid_reason' };

	const [purchase] = await tx
		.select({
			totalMinor: purchases.totalMinor,
			reversedAt: purchases.reversedAt,
			journalEntryId: purchases.journalEntryId
		})
		.from(purchases)
		.where(and(eq(purchases.id, input.purchaseId), eq(purchases.restaurantId, ctx.restaurantId)))
		.for('update');
	if (!purchase) return { ok: false, reason: 'not_found' };
	if (purchase.reversedAt !== null) return { ok: false, reason: 'already_reversed' };

	const [openPayment] = await tx
		.select({ id: supplierPayments.id })
		.from(supplierPayments)
		.where(
			and(
				eq(supplierPayments.purchaseId, input.purchaseId),
				eq(supplierPayments.restaurantId, ctx.restaurantId),
				isNull(supplierPayments.reversedAt)
			)
		)
		.limit(1);
	if (openPayment) return { ok: false, reason: 'has_payments' };

	// The stamp claims the reversal before anything else is written.
	const claimed = await tx
		.update(purchases)
		.set({ reversedAt: new Date(), reversedByUserId: ctx.actorUserId, reversalReason: reason })
		.where(
			and(
				eq(purchases.id, input.purchaseId),
				eq(purchases.restaurantId, ctx.restaurantId),
				isNull(purchases.reversedAt)
			)
		)
		.returning({ id: purchases.id });
	if (claimed.length !== 1) return { ok: false, reason: 'already_reversed' };

	const today = await todayInZone(tx, ctx.restaurantId);
	const lines = await tx
		.select({
			ingredientId: purchaseLinesTable.ingredientId,
			baseQty: purchaseLinesTable.baseQty,
			lineCostMinor: purchaseLinesTable.lineCostMinor
		})
		.from(purchaseLinesTable)
		.where(
			and(
				eq(purchaseLinesTable.purchaseId, input.purchaseId),
				eq(purchaseLinesTable.restaurantId, ctx.restaurantId)
			)
		)
		.orderBy(asc(purchaseLinesTable.lineNo));
	const { revaluationMinor } = await applyMovements(
		tx,
		{
			restaurantId: ctx.restaurantId,
			sourceType: 'purchase',
			sourceId: input.purchaseId,
			businessDate: today,
			occurredAt: new Date(),
			recordedByUserId: ctx.actorUserId
		},
		lines.map((line) => ({
			kind: 'reversal' as const,
			type: 'purchase_reversal' as const,
			ingredientId: line.ingredientId,
			qty: parseQty(line.baseQty),
			originalCostMinor: minor(line.lineCostMinor)
		}))
	);

	if (purchase.journalEntryId !== null) {
		const mirror = await postReversal(tx, {
			restaurantId: ctx.restaurantId,
			entryId: purchase.journalEntryId,
			businessDate: today,
			memo: `Reversal: ${reason}`
		});
		await tx
			.update(purchases)
			.set({ reversalEntryId: mirror.entryId })
			.where(
				and(
					eq(purchases.id, input.purchaseId),
					eq(purchases.restaurantId, ctx.restaurantId),
					isNull(purchases.reversalEntryId)
				)
			);
	}
	if (revaluationMinor !== 0n) {
		await postEntry(tx, {
			restaurantId: ctx.restaurantId,
			businessDate: today,
			event: 'inventory_revaluation',
			sourceType: 'purchase',
			sourceId: input.purchaseId,
			memo: 'Revaluation after delivery reversal',
			lines: revaluationLines(revaluationMinor)
		});
	}

	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'purchase.reversed',
		details: {
			purchaseId: input.purchaseId,
			totalMinor: purchase.totalMinor.toString(),
			reason,
			revaluationMinor: revaluationMinor.toString()
		}
	});
	return { ok: true, revaluationMinor };
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
	/** Still owed on a live credit delivery; 0 otherwise (T-21). */
	outstandingMinor: Minor;
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
			reversedAt: purchases.reversedAt,
			// Same rule as outstandingMinor (payments.ts), as a column so the list
			// is one query. Qualified by hand: drizzle leaves columns unqualified in a
			// single-table select, and "id" inside the subquery would be sp.id.
			outstanding: sql<string>`(case
				when "purchases"."paid_by" = 'credit' and "purchases"."reversed_at" is null
				then "purchases"."total_minor" - coalesce((
					select sum(sp.amount_minor) from supplier_payments sp
					where sp.purchase_id = "purchases"."id"
					  and sp.restaurant_id = "purchases"."restaurant_id"
					  and sp.reversed_at is null), 0)
				else 0 end)::text`
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
		reversed: r.reversedAt !== null,
		outstandingMinor: minor(BigInt(r.outstanding))
	}));
}

export type PurchaseDetail = PurchaseSummary & {
	payments: SupplierPaymentView[];
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
		outstandingMinor: await outstandingMinor(executor, restaurantId, id),
		payments: await paymentsFor(executor, restaurantId, id),
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
