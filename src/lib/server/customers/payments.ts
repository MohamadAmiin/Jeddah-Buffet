// CUSTOMER PAYMENTS (tasks/customer-credit T-11) — a customer pays back what
// they were charged, at the till, in an open shift.
//
// Dr 1000 Cash on Hand (cash — it goes into that shift's drawer and into its
// expected cash) | 1020 (card) | 1030 (mobile) / Cr 1100 Accounts Receivable.
// A wrong payment is REVERSED, never edited (invariant 2, spec 22): the row gets
// its once-written reversal stamp and postReversal writes the mirror entry.
//
// LOCK ORDER — the same in both functions, and the reason each exists:
//   1. the SHIFT row, FOR SHARE. closeSession holds it FOR UPDATE while it reads
//      expected cash and posts over/short, so a payment or a cash reversal either
//      commits before the close reads (and is counted), or waits and is refused
//      (session_closed / shift_closed). Without it a cash reversal could commit
//      into a shift that had just closed: 1000 credited twice, a shortage in 6800
//      that never happened, and nothing editable. FOR SHARE, never FOR UPDATE: a
//      concurrent sale's order insert takes a key-share lock on the shift, which
//      FOR UPDATE would block — and that sale may already hold the customer lock.
//   2. the CUSTOMER row, FOR UPDATE (lockCustomer). It serialises every writer of
//      one balance: the second computes the balance after the first commits.
//   3. the payment row, FOR UPDATE (a reversal only).
//
// A REVERSAL'S BUSINESS DATE (refines CLAUDE.md "Inventory 9"): a CASH reversal
// carries its shift's business date — the shift is open by rule, and the cash
// leaves that shift's drawer; a card or mobile reversal carries the day it is
// made in the restaurant's zone. Either way the payment stays on its own date
// and the reversal is its own row on its own date: last month never changes.
//
// A cash payment can be reversed ONLY while its shift is open. After the close
// the drawer has been counted against it; correcting it then is not built
// (tasks/customer-credit, scope OUT).
//
// Module rule: calls accounting/ and audit/ only. Every function takes the
// caller's tx, is scoped by restaurant, audits in that tx (invariant 10) and
// answers a business refusal as { ok: false, reason }.
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { customerPayments } from '../db/schema/customers';
import { paymentMethods } from '../db/schema/payment-methods';
import { writeAudit } from '../audit';
import { postEntry, postReversal } from '../accounting/journal';
import { customerPaymentLines } from '../accounting/posting-rules';
import { minor, subtract, toBigInt, type Minor } from '../../money';
import { changeDue } from '../../money/change';
import { CUSTOMER_PAYMENT_METHODS, type CustomerPaymentMethod } from '../../sync-ops';
import { balanceOf, lockCustomer, type CustomerWriteContext } from './index';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Who is receiving the payment, on which till, under which op. */
export type ReceiveContext = {
	restaurantId: string;
	/** The employee taking the money. */
	actorUserId: string;
	/** The registered till the op was recorded under. */
	deviceId: string;
	/** The op's key: the audit row carries it, so a retry finds its row. */
	clientOpId: string | null;
	occurredAt: Date;
	ip: string | null;
	userAgent: string | null;
};

export type ReceiveInput = {
	/** Device-generated; the row is stored under it. */
	paymentId: string;
	customerId: string;
	posSessionId: string;
	method: CustomerPaymentMethod;
	paymentMethodId: string | null;
	paymentMethodName: string | null;
	amountMinor: Minor;
	/** Cash only; null otherwise. */
	tenderedMinor: Minor | null;
	changeMinor: Minor | null;
	/** Device time of the tap. */
	receivedAt: Date;
};

export type ReceiveRefusal =
	| 'unknown_session'
	| 'session_device_mismatch'
	| 'session_closed'
	| 'unknown_customer'
	| 'tender_not_accepted'
	| 'invalid_amount'
	| 'cash_change'
	| 'exceeds_balance'
	| 'duplicate_payment';

/** The shift row under FOR SHARE: step 1 of the lock order. */
async function lockShift(
	tx: DbTx,
	restaurantId: string,
	posSessionId: string
): Promise<{ status: string; businessDate: string; deviceId: string } | null> {
	if (!UUID.test(posSessionId)) return null;
	const result = await tx.execute<{ status: string; business_date: string; device_id: string }>(sql`
		select s.status, s.business_date::text as business_date, s.device_id
		from pos_sessions s
		where s.id = ${posSessionId} and s.restaurant_id = ${restaurantId}
		for share
	`);
	const row = result.rows[0];
	return row
		? { status: row.status, businessDate: row.business_date, deviceId: row.device_id }
		: null;
}

/** Today in the restaurant's zone, computed in SQL (invariant 11). A private
 * copy of inventory/business-date.ts: customers/ may not import inventory/. */
async function todayInZone(executor: Executor, restaurantId: string): Promise<string> {
	const result = await executor.execute<{ today: string }>(sql`
		select to_char(now() at time zone s.time_zone, 'YYYY-MM-DD') as today
		from restaurant_settings s
		where s.restaurant_id = ${restaurantId}
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`restaurant settings not found: ${restaurantId}`);
	return row.today;
}

/** The method row a customer payment was taken with: live and enabled, of the
 * payment's kind, never the credit row. The Customer credit switch is
 * irrelevant here — switching credit off never stops a customer paying. */
async function resolveMethod(
	tx: DbTx,
	restaurantId: string,
	method: CustomerPaymentMethod,
	paymentMethodId: string | null
): Promise<{ id: string; name: string } | null> {
	const live = and(
		eq(paymentMethods.restaurantId, restaurantId),
		eq(paymentMethods.kind, method),
		isNull(paymentMethods.archivedAt),
		eq(paymentMethods.enabled, true)
	);
	if (paymentMethodId !== null) {
		if (!UUID.test(paymentMethodId)) return null;
		const [row] = await tx
			.select({ id: paymentMethods.id, name: paymentMethods.name })
			.from(paymentMethods)
			.where(and(live, eq(paymentMethods.id, paymentMethodId)))
			.limit(1);
		return row ?? null;
	}
	// No id: the Cash row for cash; the first live, enabled method of the kind.
	const [row] = await tx
		.select({ id: paymentMethods.id, name: paymentMethods.name })
		.from(paymentMethods)
		.where(live)
		.orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name), asc(paymentMethods.id))
		.limit(1);
	return row ?? null;
}

/**
 * Receive a payment against a customer's balance. An ARCHIVED customer who
 * still owes is accepted: a debt must stay collectable.
 */
export async function receiveCustomerPayment(
	tx: DbTx,
	ctx: ReceiveContext,
	input: ReceiveInput
): Promise<
	| { ok: true; balanceAfterMinor: Minor; businessDate: string }
	| { ok: false; reason: ReceiveRefusal }
> {
	if (!(CUSTOMER_PAYMENT_METHODS as readonly string[]).includes(input.method)) {
		// `credit` included: a debt is never paid with credit.
		return { ok: false, reason: 'tender_not_accepted' };
	}
	if (!UUID.test(input.paymentId) || !UUID.test(input.customerId)) {
		return { ok: false, reason: 'unknown_customer' };
	}

	// 1 — the shift, FOR SHARE. Decide "open" under the lock.
	const shift = await lockShift(tx, ctx.restaurantId, input.posSessionId);
	if (!shift) return { ok: false, reason: 'unknown_session' };
	// The shift must be the op's OWN till's, as a sale's must (validate.ts step 3):
	// cash received at one till may never be counted in another till's drawer —
	// that would post a shortage against a different cashier's shift.
	if (shift.deviceId !== ctx.deviceId) return { ok: false, reason: 'session_device_mismatch' };
	if (shift.status !== 'open') return { ok: false, reason: 'session_closed' };

	// 2 — the customer, FOR UPDATE. Everything below reads a settled balance.
	const customer = await lockCustomer(tx, ctx.restaurantId, input.customerId);
	if (!customer) return { ok: false, reason: 'unknown_customer' };

	const [existing] = await tx
		.select({ id: customerPayments.id })
		.from(customerPayments)
		.where(eq(customerPayments.id, input.paymentId))
		.limit(1);
	if (existing) return { ok: false, reason: 'duplicate_payment' };

	const method = await resolveMethod(tx, ctx.restaurantId, input.method, input.paymentMethodId);
	if (!method) return { ok: false, reason: 'tender_not_accepted' };

	const amount = input.amountMinor;
	if (typeof amount !== 'bigint' || amount <= 0n) return { ok: false, reason: 'invalid_amount' };
	if (input.method === 'cash') {
		const tendered = input.tenderedMinor;
		const change = input.changeMinor;
		if (tendered === null || change === null || tendered < amount) {
			return { ok: false, reason: 'cash_change' };
		}
		if (change !== changeDue(tendered, amount)) return { ok: false, reason: 'cash_change' };
	} else if (input.tenderedMinor !== null || input.changeMinor !== null) {
		return { ok: false, reason: 'cash_change' };
	}

	// No prepaid balances: a customer cannot pay more than they owe.
	const balance = await balanceOf(tx, ctx.restaurantId, input.customerId);
	if (amount > balance) return { ok: false, reason: 'exceeds_balance' };
	const balanceAfter = subtract(balance, amount);

	// The entry FIRST, so the row is inserted WITH its journal_entry_id and no
	// UPDATE ever follows (customer_payments_guard allows only the reversal stamp).
	const entry = await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: shift.businessDate,
		event: 'customer_payment_received',
		sourceType: 'customer_payment',
		sourceId: input.paymentId,
		memo: 'Customer payment',
		lines: customerPaymentLines(input.method, amount)
	});
	// amount > 0, so the writer kept both lines.
	if (!entry) throw new Error('a customer payment posted no journal entry');

	// The till's name wins when it is storable; the row's otherwise.
	const wireName = input.paymentMethodName?.trim() ?? '';
	const methodName =
		wireName.length >= 1 && wireName.length <= 40 && !CONTROL.test(wireName)
			? wireName
			: method.name;

	await tx.insert(customerPayments).values({
		id: input.paymentId,
		restaurantId: ctx.restaurantId,
		customerId: input.customerId,
		amountMinor: toBigInt(amount),
		method: input.method,
		paymentMethodId: method.id,
		paymentMethodName: methodName,
		tenderedMinor: input.tenderedMinor === null ? null : toBigInt(input.tenderedMinor),
		changeMinor: input.changeMinor === null ? null : toBigInt(input.changeMinor),
		balanceAfterMinor: toBigInt(balanceAfter),
		posSessionId: input.posSessionId,
		deviceId: ctx.deviceId,
		recordedByUserId: ctx.actorUserId,
		businessDate: shift.businessDate,
		receivedAt: input.receivedAt,
		journalEntryId: entry.entryId
	});

	// Also the evidence for this payment's drawer pulse when the tender is cash.
	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		deviceId: ctx.deviceId,
		clientOpId: ctx.clientOpId,
		occurredAt: ctx.occurredAt,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'customer.payment_received',
		details: {
			paymentId: input.paymentId,
			customerId: input.customerId,
			amountMinor: amount.toString(),
			method: input.method,
			paymentMethodId: method.id,
			posSessionId: input.posSessionId,
			balanceAfterMinor: balanceAfter.toString()
		}
	});
	return { ok: true, balanceAfterMinor: balanceAfter, businessDate: shift.businessDate };
}

/** 3–200 characters after trimming, or null. */
export function reversalReason(reason: string): string | null {
	const trimmed = typeof reason === 'string' ? reason.trim() : '';
	return trimmed.length >= 3 && trimmed.length <= 200 ? trimmed : null;
}

/**
 * Reverse a customer payment (owner, dashboard). The customer owes the amount
 * again; the mirror entry is Dr 1100 / Cr 1000 | 1020 | 1030.
 */
export async function reverseCustomerPayment(
	tx: DbTx,
	ctx: CustomerWriteContext,
	input: { paymentId: string; reason: string }
): Promise<
	| { ok: true; reversalBusinessDate: string }
	| { ok: false; reason: 'not_found' | 'already_reversed' | 'invalid_reason' | 'shift_closed' }
> {
	const reason = reversalReason(input.reason);
	if (reason === null) return { ok: false, reason: 'invalid_reason' };
	if (!UUID.test(input.paymentId)) return { ok: false, reason: 'not_found' };

	// Unlocked: only to learn which shift and customer to lock. method,
	// pos_session_id and customer_id never change (customer_payments_guard).
	const [found] = await tx
		.select({
			customerId: customerPayments.customerId,
			method: customerPayments.method,
			posSessionId: customerPayments.posSessionId
		})
		.from(customerPayments)
		.where(
			and(
				eq(customerPayments.id, input.paymentId),
				eq(customerPayments.restaurantId, ctx.restaurantId)
			)
		)
		.limit(1);
	if (!found) return { ok: false, reason: 'not_found' };

	// 1 — a CASH payment's shift, FOR SHARE: it must still be open, decided under
	// the lock closeSession takes FOR UPDATE.
	let reversalBusinessDate: string;
	if (found.method === 'cash') {
		const shift = await lockShift(tx, ctx.restaurantId, found.posSessionId);
		if (!shift || shift.status !== 'open') return { ok: false, reason: 'shift_closed' };
		reversalBusinessDate = shift.businessDate;
	} else {
		reversalBusinessDate = await todayInZone(tx, ctx.restaurantId);
	}

	// 2 — the customer, then 3 — the payment row.
	await lockCustomer(tx, ctx.restaurantId, found.customerId);
	const [payment] = await tx
		.select({
			amountMinor: customerPayments.amountMinor,
			journalEntryId: customerPayments.journalEntryId,
			reversedAt: customerPayments.reversedAt
		})
		.from(customerPayments)
		.where(
			and(
				eq(customerPayments.id, input.paymentId),
				eq(customerPayments.restaurantId, ctx.restaurantId)
			)
		)
		.for('update');
	if (!payment) return { ok: false, reason: 'not_found' };
	if (payment.reversedAt !== null) return { ok: false, reason: 'already_reversed' };

	// The mirror entry FIRST, so the whole reversal group is written in ONE update
	// (customer_payments_reversal_fields is all-or-none).
	const reversal = await postReversal(tx, {
		restaurantId: ctx.restaurantId,
		entryId: payment.journalEntryId,
		businessDate: reversalBusinessDate,
		memo: `Reversal: ${reason}`
	});
	const claimed = await tx
		.update(customerPayments)
		.set({
			reversedAt: new Date(),
			reversedByUserId: ctx.actorUserId,
			reversalReason: reason,
			reversalEntryId: reversal.entryId,
			reversalBusinessDate
		})
		.where(
			and(
				eq(customerPayments.id, input.paymentId),
				eq(customerPayments.restaurantId, ctx.restaurantId),
				isNull(customerPayments.reversedAt)
			)
		)
		.returning({ id: customerPayments.id });
	if (claimed.length !== 1) throw new Error('the customer payment was reversed under its own lock');

	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'customer.payment_reversed',
		details: {
			paymentId: input.paymentId,
			customerId: found.customerId,
			amountMinor: payment.amountMinor.toString(),
			reason,
			reversalBusinessDate
		}
	});
	return { ok: true, reversalBusinessDate };
}

/** What a replayed `customer.payment` op answers with: the balance stored with
 * the payment, never a fresh one. Null when no such payment exists. */
export async function storedBalanceAfter(
	executor: Executor,
	restaurantId: string,
	paymentId: string
): Promise<Minor | null> {
	if (!UUID.test(paymentId)) return null;
	const [row] = await executor
		.select({ balanceAfterMinor: customerPayments.balanceAfterMinor })
		.from(customerPayments)
		.where(and(eq(customerPayments.id, paymentId), eq(customerPayments.restaurantId, restaurantId)))
		.limit(1);
	return row ? minor(row.balanceAfterMinor) : null;
}

export type CustomerPaymentView = {
	id: string;
	customerId: string;
	amountMinor: Minor;
	method: CustomerPaymentMethod;
	paymentMethodName: string;
	businessDate: string;
	receivedAt: Date;
	posSessionId: string;
	/** Its shift is still open — the only time a CASH payment can be reversed. */
	shiftOpen: boolean;
	reversed: boolean;
	reversalReason: string | null;
};

/** One customer's payments, newest first — the dashboard's Reverse controls. */
export async function paymentsOf(
	executor: Executor,
	restaurantId: string,
	customerId: string
): Promise<CustomerPaymentView[]> {
	if (!UUID.test(customerId)) return [];
	const result = await executor.execute<{
		id: string;
		customer_id: string;
		amount: string;
		method: CustomerPaymentMethod;
		payment_method_name: string;
		business_date: string;
		received_at: Date | string;
		pos_session_id: string;
		shift_open: boolean;
		reversed: boolean;
		reversal_reason: string | null;
	}>(sql`
		select cp.id, cp.customer_id, cp.amount_minor::text as amount, cp.method,
		       cp.payment_method_name, cp.business_date::text as business_date, cp.received_at,
		       cp.pos_session_id, s.status = 'open' as shift_open,
		       cp.reversed_at is not null as reversed, cp.reversal_reason
		from customer_payments cp
		join pos_sessions s on s.id = cp.pos_session_id and s.restaurant_id = cp.restaurant_id
		where cp.restaurant_id = ${restaurantId} and cp.customer_id = ${customerId}
		order by cp.received_at desc, cp.id
	`);
	return result.rows.map((row) => ({
		id: row.id,
		customerId: row.customer_id,
		amountMinor: minor(BigInt(row.amount)),
		method: row.method,
		paymentMethodName: row.payment_method_name,
		businessDate: row.business_date,
		receivedAt: new Date(row.received_at),
		posSessionId: row.pos_session_id,
		shiftOpen: row.shift_open,
		reversed: row.reversed,
		reversalReason: row.reversal_reason
	}));
}
