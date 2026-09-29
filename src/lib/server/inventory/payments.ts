// SUPPLIER PAYMENTS (spec 19, 24; tasks/inventory-cogs T-21).
//
// A delivery on credit (Dr 1200 / Cr 2000) is paid later: Dr 2000 Accounts
// Payable / Cr 1000 Cash on Hand | 1010 Bank. A wrong payment is REVERSED, never
// edited (invariant 2, spec 22): the payment row gets its once-written reversal
// stamp and postReversal writes the mirror entry, dated the day the reversal is
// made in the restaurant's zone (CLAUDE.md, "Inventory 9").
//
// LOCK ORDER: the purchase row FIRST, then the payment row — in both functions,
// and reversePurchase locks only the purchase row — so the three can never
// deadlock with each other. The purchase lock is also what serialises two
// payments racing for the same outstanding balance: the second one computes the
// balance after the first commits and is refused.
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { purchases, supplierPayments } from '../db/schema/purchases';
import { writeAudit } from '../audit';
import { postEntry, postReversal } from '../accounting/journal';
import { supplierPaymentLines } from '../accounting/posting-rules';
import { minor, toBigInt, type Minor } from '../../money';
import { todayInZone } from './business-date';
import type { InventoryWriteContext } from './ingredients';

export const PAID_FROM = ['cash', 'bank'] as const;
export type PaidFrom = (typeof PAID_FROM)[number];

/**
 * What is still owed on a delivery: total − Σ unreversed payments for a live
 * credit delivery; 0 for anything else (paid on delivery, or reversed). One query.
 */
export async function outstandingMinor(
	executor: Executor,
	restaurantId: string,
	purchaseId: string
): Promise<Minor> {
	const result = await executor.execute<{ outstanding: string | null }>(sql`
		select case
		         when p.paid_by = 'credit' and p.reversed_at is null
		         then p.total_minor - coalesce((
		           select sum(sp.amount_minor) from supplier_payments sp
		           where sp.purchase_id = p.id and sp.restaurant_id = p.restaurant_id
		             and sp.reversed_at is null), 0)
		         else 0
		       end::text as outstanding
		from purchases p
		where p.id = ${purchaseId} and p.restaurant_id = ${restaurantId}
	`);
	return minor(BigInt(result.rows[0]?.outstanding ?? '0'));
}

async function lockPurchase(tx: DbTx, restaurantId: string, purchaseId: string) {
	const [row] = await tx
		.select({
			id: purchases.id,
			paidBy: purchases.paidBy,
			reversedAt: purchases.reversedAt
		})
		.from(purchases)
		.where(and(eq(purchases.id, purchaseId), eq(purchases.restaurantId, restaurantId)))
		.for('update');
	return row ?? null;
}

export type PaySupplierInput = {
	purchaseId: string;
	amountMinor: Minor;
	paidFrom: PaidFrom;
	businessDate: string;
};

export async function paySupplier(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: PaySupplierInput
): Promise<
	| { ok: true; paymentId: string }
	| {
			ok: false;
			reason: 'not_found' | 'not_credit' | 'reversed' | 'exceeds_outstanding' | 'invalid_amount';
	  }
> {
	if (!(PAID_FROM as readonly string[]).includes(input.paidFrom)) {
		throw new TypeError(`paid from must be one of ${PAID_FROM.join(', ')}`);
	}
	const purchase = await lockPurchase(tx, ctx.restaurantId, input.purchaseId);
	if (!purchase) return { ok: false, reason: 'not_found' };
	if (purchase.paidBy !== 'credit') return { ok: false, reason: 'not_credit' };
	if (purchase.reversedAt !== null) return { ok: false, reason: 'reversed' };
	if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) {
		return { ok: false, reason: 'invalid_amount' };
	}
	// Under the purchase lock: a racing payment has committed or is waiting.
	const outstanding = await outstandingMinor(tx, ctx.restaurantId, input.purchaseId);
	if (input.amountMinor > outstanding) return { ok: false, reason: 'exceeds_outstanding' };

	const paymentId = randomUUID();
	await tx.insert(supplierPayments).values({
		id: paymentId,
		restaurantId: ctx.restaurantId,
		purchaseId: input.purchaseId,
		amountMinor: toBigInt(input.amountMinor),
		paidFrom: input.paidFrom,
		businessDate: input.businessDate,
		recordedByUserId: ctx.actorUserId
	});
	const entry = await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: input.businessDate,
		event: 'supplier_paid',
		sourceType: 'supplier_payment',
		sourceId: paymentId,
		memo: 'Supplier payment',
		lines: supplierPaymentLines(input.paidFrom, input.amountMinor)
	});
	if (entry) {
		await tx
			.update(supplierPayments)
			.set({ journalEntryId: entry.entryId })
			.where(
				and(
					eq(supplierPayments.id, paymentId),
					eq(supplierPayments.restaurantId, ctx.restaurantId),
					isNull(supplierPayments.journalEntryId)
				)
			);
	}
	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'supplier.paid',
		details: {
			paymentId,
			purchaseId: input.purchaseId,
			amountMinor: input.amountMinor.toString(),
			paidFrom: input.paidFrom
		}
	});
	return { ok: true, paymentId };
}

/** 3–200 characters after trimming, or null. Shared with reversePurchase. */
export function reversalReason(reason: string): string | null {
	const trimmed = typeof reason === 'string' ? reason.trim() : '';
	return trimmed.length >= 3 && trimmed.length <= 200 ? trimmed : null;
}

export async function reverseSupplierPayment(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: { paymentId: string; reason: string }
): Promise<
	{ ok: true } | { ok: false; reason: 'not_found' | 'already_reversed' | 'invalid_reason' }
> {
	const reason = reversalReason(input.reason);
	if (reason === null) return { ok: false, reason: 'invalid_reason' };

	const [found] = await tx
		.select({ purchaseId: supplierPayments.purchaseId })
		.from(supplierPayments)
		.where(
			and(
				eq(supplierPayments.id, input.paymentId),
				eq(supplierPayments.restaurantId, ctx.restaurantId)
			)
		);
	if (!found) return { ok: false, reason: 'not_found' };
	// Purchase first, then the payment: the one lock order of this module.
	await lockPurchase(tx, ctx.restaurantId, found.purchaseId);
	const [payment] = await tx
		.select({
			amountMinor: supplierPayments.amountMinor,
			journalEntryId: supplierPayments.journalEntryId
		})
		.from(supplierPayments)
		.where(
			and(
				eq(supplierPayments.id, input.paymentId),
				eq(supplierPayments.restaurantId, ctx.restaurantId)
			)
		)
		.for('update');

	// The stamp claims the reversal: exactly one row, or it was already reversed.
	const claimed = await tx
		.update(supplierPayments)
		.set({ reversedAt: new Date(), reversedByUserId: ctx.actorUserId, reversalReason: reason })
		.where(
			and(
				eq(supplierPayments.id, input.paymentId),
				eq(supplierPayments.restaurantId, ctx.restaurantId),
				isNull(supplierPayments.reversedAt)
			)
		)
		.returning({ id: supplierPayments.id });
	if (claimed.length !== 1) return { ok: false, reason: 'already_reversed' };

	if (payment.journalEntryId !== null) {
		const reversal = await postReversal(tx, {
			restaurantId: ctx.restaurantId,
			entryId: payment.journalEntryId,
			businessDate: await todayInZone(tx, ctx.restaurantId),
			memo: `Reversal: ${reason}`
		});
		await tx
			.update(supplierPayments)
			.set({ reversalEntryId: reversal.entryId })
			.where(
				and(
					eq(supplierPayments.id, input.paymentId),
					eq(supplierPayments.restaurantId, ctx.restaurantId),
					isNull(supplierPayments.reversalEntryId)
				)
			);
	}
	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'supplier.payment_reversed',
		details: {
			paymentId: input.paymentId,
			purchaseId: found.purchaseId,
			amountMinor: payment.amountMinor.toString(),
			reason
		}
	});
	return { ok: true };
}

export type SupplierPaymentView = {
	id: string;
	amountMinor: Minor;
	paidFrom: PaidFrom;
	businessDate: string;
	recordedAt: Date;
	reversedAt: Date | null;
	reversalReason: string | null;
};

/** A delivery's payments, oldest first. */
export async function paymentsFor(
	executor: Executor,
	restaurantId: string,
	purchaseId: string
): Promise<SupplierPaymentView[]> {
	const rows = await executor
		.select()
		.from(supplierPayments)
		.where(
			and(
				eq(supplierPayments.purchaseId, purchaseId),
				eq(supplierPayments.restaurantId, restaurantId)
			)
		)
		.orderBy(supplierPayments.recordedAt, supplierPayments.id);
	return rows.map((r) => ({
		id: r.id,
		amountMinor: minor(r.amountMinor),
		paidFrom: r.paidFrom as PaidFrom,
		businessDate: r.businessDate,
		recordedAt: r.recordedAt,
		reversedAt: r.reversedAt,
		reversalReason: r.reversalReason
	}));
}
