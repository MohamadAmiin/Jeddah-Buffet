// A CUSTOMER PAYS AT THE TILL (tasks/customer-credit T-19) — the device side.
//
// Receiving a payment is a REQUEST: only the server knows what the customer
// owes, so it needs a connection, and the server may refuse it. The danger is
// the moment in between. The cashier is holding the customer's money; if the
// answer is lost the till must NOT look as if nothing happened, or the cashier
// taps again and the books hold two payments for one.
//
// So the till keeps its OWN record of every payment it has sent, on the op's
// queue entry, written in the SAME IndexedDB transaction as the enqueue:
//   - PENDING  — sent or about to be, no answer yet. Permanent on screen, no
//     Cancel (the server may already hold it), and no second payment for that
//     customer until it is answered. It is retried under the SAME key, so the
//     server records it once however many times it arrives.
//   - CONFIRMED — the server recorded it and answered with the balance it
//     stored. Only now does the receipt print and, for cash within 30 seconds
//     of the tap, the drawer open (printing.ts).
//   - REFUSED  — the server said no (more than is owed, a closed shift, no
//     permission). Nothing was recorded and nothing prints; it stays on screen
//     until the cashier confirms the money went back to the customer.
//
// This module never prints and never imports printing.ts; printing.ts reads
// what is recorded here.
import { add, minor, type Minor } from '../money';
import type { CustomerPaymentMethod, CustomerPaymentPayload, OpEnvelope } from '../sync-ops';
import { takeNextQueueSeq } from './invoice-sequence';
import { enqueue } from './queue';
import {
	inTransaction,
	signalUnsyncedChange,
	valueOf,
	withDb,
	type LocalCustomerPayment,
	type QueueEntry
} from './store';

export type CustomerPaymentState = 'pending' | 'confirmed' | 'refused';

/** One payment as the screens and the printer see it. Money as decimal strings. */
export type CustomerPaymentView = {
	clientOpId: string;
	paymentId: string;
	deviceId: string;
	customerId: string;
	customerName: string;
	customerPhone: string;
	method: CustomerPaymentMethod;
	methodName: string;
	cashierName: string;
	amountMinor: string;
	tenderedMinor: string | null;
	changeMinor: string | null;
	tappedAt: string;
	state: CustomerPaymentState;
	/** Confirmed only: what the customer still owes, as the SERVER stored it. */
	balanceAfterMinor: string | null;
	/** Refused only: the server's one-word reason. */
	refusal: string | null;
	printedAt: string | null;
	drawerAt: string | null;
	reprints: number;
	acknowledgedAt: string | null;
};

function secureId(): string {
	if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
		throw new Error('This device cannot record a payment securely. Open the till over https.');
	}
	return crypto.randomUUID();
}

/** The view of one queue entry, or null when it is not a customer payment. */
export function viewOf(entry: QueueEntry): CustomerPaymentView | null {
	if (entry.kind !== 'customer.payment' || !entry.customerPayment) return null;
	const payload = entry.envelope.payload as CustomerPaymentPayload;
	const record = entry.customerPayment;
	// DONE with an error is a refusal; DONE without one is the server's yes.
	// Anything else — pending, sending, parked — is still unanswered.
	const refused = entry.state === 'done' && entry.lastError !== undefined;
	const confirmed = entry.state === 'done' && !refused;
	const after = entry.lastResult?.balanceAfterMinor;
	return {
		clientOpId: entry.clientOpId,
		paymentId: payload.paymentId,
		deviceId: entry.deviceId,
		customerId: payload.customerId,
		customerName: record.customerName,
		customerPhone: record.customerPhone,
		method: payload.method,
		methodName: record.methodName,
		cashierName: record.cashierName,
		amountMinor: payload.amountMinor,
		tenderedMinor: payload.tenderedMinor,
		changeMinor: payload.changeMinor,
		tappedAt: record.tappedAt,
		state: confirmed ? 'confirmed' : refused ? 'refused' : 'pending',
		balanceAfterMinor: confirmed && typeof after === 'string' ? after : null,
		refusal: refused ? (entry.lastError ?? '').replace(/^rejected:/, '') : null,
		printedAt: record.printedAt ?? null,
		drawerAt: record.drawerAt ?? null,
		reprints: record.reprints ?? 0,
		acknowledgedAt: record.acknowledgedAt ?? null
	};
}

function readEntries(): Promise<QueueEntry[]> {
	return withDb(
		async (db) =>
			(await valueOf(
				db.transaction('sync_queue').objectStore('sync_queue').getAll()
			)) as QueueEntry[]
	);
}

/** Every customer payment this till has sent, newest first. */
export async function listCustomerPayments(): Promise<CustomerPaymentView[]> {
	return (await readEntries())
		.map(viewOf)
		.filter((view): view is CustomerPaymentView => view !== null)
		.sort((a, b) => b.tappedAt.localeCompare(a.tappedAt));
}

export async function readCustomerPayment(clientOpId: string): Promise<CustomerPaymentView | null> {
	const entry = await withDb(
		async (db) =>
			(await valueOf(db.transaction('sync_queue').objectStore('sync_queue').get(clientOpId))) as
				QueueEntry | undefined
	);
	return entry ? viewOf(entry) : null;
}

/** The customer's payment that has no answer yet, if any. */
export function pendingFor(
	payments: readonly CustomerPaymentView[],
	customerId: string
): CustomerPaymentView | null {
	return payments.find((p) => p.customerId === customerId && p.state === 'pending') ?? null;
}

/** What still needs the cashier's eyes: unanswered, or refused and not yet acknowledged. */
export function needsAttention(payments: readonly CustomerPaymentView[]): CustomerPaymentView[] {
	return payments.filter(
		(p) => p.state === 'pending' || (p.state === 'refused' && p.acknowledgedAt === null)
	);
}

export type StartPaymentArgs = {
	deviceId: string;
	employeeId: string;
	cashierName: string;
	posSessionId: string | null;
	online: boolean;
	customer: { id: string; name: string; phone: string };
	method: CustomerPaymentMethod;
	paymentMethodId: string | null;
	methodName: string;
	amountMinor: Minor;
	/** Cash only. */
	tenderedMinor: Minor | null;
	changeMinor: Minor | null;
	now: Date;
};

export type StartPaymentResult =
	| { ok: true; clientOpId: string; paymentId: string }
	| {
			ok: false;
			reason: 'offline' | 'no_shift' | 'pending_for_customer' | 'invalid_amount';
			words: string;
	  };

/**
 * Record the payment on this till and queue it — one transaction over the queue
 * and its sequence, so there is never an op without its record. Refused, with
 * the reason in words, when the till is offline, no shift is open, the amount is
 * not positive, or this customer already has a payment waiting for its answer.
 */
export async function startCustomerPayment(args: StartPaymentArgs): Promise<StartPaymentResult> {
	if (!args.online) {
		return { ok: false, reason: 'offline', words: 'Receiving a payment needs a connection' };
	}
	if (args.posSessionId === null) {
		return { ok: false, reason: 'no_shift', words: 'Open a shift before receiving a payment' };
	}
	if (typeof args.amountMinor !== 'bigint' || args.amountMinor <= 0n) {
		return {
			ok: false,
			reason: 'invalid_amount',
			words: 'Enter the amount the customer is paying'
		};
	}
	const posSessionId = args.posSessionId;
	const clientOpId = secureId();
	const paymentId = secureId();
	const tappedAt = args.now.toISOString();
	const cash = args.method === 'cash';

	const payload: CustomerPaymentPayload = {
		paymentId,
		customerId: args.customer.id,
		posSessionId,
		method: args.method,
		paymentMethodId: args.paymentMethodId,
		paymentMethodName: args.methodName,
		amountMinor: args.amountMinor.toString(),
		tenderedMinor: cash && args.tenderedMinor !== null ? args.tenderedMinor.toString() : null,
		changeMinor: cash && args.changeMinor !== null ? args.changeMinor.toString() : null,
		receivedAt: tappedAt
	};
	const record: LocalCustomerPayment = {
		customerName: args.customer.name,
		customerPhone: args.customer.phone,
		methodName: args.methodName,
		cashierName: args.cashierName,
		tappedAt
	};

	const outcome = await withDb(
		(db) =>
			new Promise<'added' | 'pending_for_customer'>((resolve, reject) => {
				const tx = db.transaction(['sync_queue', 'invoice_sequence'], 'readwrite');
				let result: 'added' | 'pending_for_customer' = 'added';
				tx.oncomplete = () => resolve(result);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('the payment was not recorded'));
				void (async () => {
					try {
						// Checked INSIDE the transaction: two taps cannot both pass.
						const all = (await valueOf(tx.objectStore('sync_queue').getAll())) as QueueEntry[];
						const waiting = all
							.map(viewOf)
							.some(
								(v) => v !== null && v.customerId === args.customer.id && v.state === 'pending'
							);
						if (waiting) {
							result = 'pending_for_customer';
							return;
						}
						const seq = await takeNextQueueSeq(tx, args.deviceId);
						const envelope: OpEnvelope<'customer.payment', CustomerPaymentPayload> = {
							kind: 'customer.payment',
							clientOpId,
							deviceId: args.deviceId,
							employeeId: args.employeeId,
							occurredAt: tappedAt,
							seq,
							payload
						};
						await enqueue(tx, {
							clientOpId,
							deviceId: args.deviceId,
							seq,
							kind: 'customer.payment',
							envelope,
							state: 'pending',
							attempts: 0,
							customerPayment: record
						});
					} catch (error) {
						try {
							tx.abort();
						} catch {
							/* already finished */
						}
						reject(error);
					}
				})();
			})
	);
	if (outcome === 'pending_for_customer') {
		return {
			ok: false,
			reason: 'pending_for_customer',
			words: `A payment from ${args.customer.name} is still waiting for the server`
		};
	}
	signalUnsyncedChange();
	return { ok: true, clientOpId, paymentId };
}

/** Merge marks into one payment's record: ONE readwrite transaction, read then put. */
export function markCustomerPayment(
	clientOpId: string,
	patch: Partial<
		Pick<LocalCustomerPayment, 'printedAt' | 'drawerAt' | 'reprints' | 'acknowledgedAt'>
	>
): Promise<void> {
	return withDb((db) =>
		inTransaction(db, ['sync_queue'], 'readwrite', (tx) => {
			const store = tx.objectStore('sync_queue');
			const request = store.get(clientOpId);
			request.onsuccess = () => {
				const row = request.result as QueueEntry | undefined;
				if (!row || row.kind !== 'customer.payment' || !row.customerPayment) return;
				store.put({ ...row, customerPayment: { ...row.customerPayment, ...patch } });
			};
		})
	);
}

/** The cashier confirms a REFUSED payment's money went back to the customer. */
export async function acknowledgeRefusal(
	clientOpId: string,
	now: Date = new Date()
): Promise<void> {
	await markCustomerPayment(clientOpId, { acknowledgedAt: now.toISOString() });
	signalUnsyncedChange();
}

/** The balance before the payment: after + amount, by the money module. */
export function balanceBefore(view: CustomerPaymentView): Minor | null {
	if (view.balanceAfterMinor === null) return null;
	return add(minor(BigInt(view.balanceAfterMinor)), minor(BigInt(view.amountMinor)));
}

const REFUSAL_WORDS: Record<string, string> = {
	not_permitted: 'this employee may not take payments',
	exceeds_balance: 'it is more than the customer owes',
	session_closed: 'the shift is closed',
	unknown_session: 'the server does not know this shift',
	unknown_customer: 'the server does not know this customer',
	tender_not_accepted: 'that payment method is switched off',
	invalid_amount: 'the amount is not valid',
	cash_change: 'the tendered amount and change do not add up',
	duplicate_payment: 'it was already recorded'
};

/** A refusal in the cashier's words; an unknown reason still gets a sentence. */
export function refusalWords(reason: string | null): string {
	return REFUSAL_WORDS[reason ?? ''] ?? 'the server refused it';
}
