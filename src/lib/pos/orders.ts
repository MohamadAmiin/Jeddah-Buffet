// The local cart, completeSale in ONE IndexedDB transaction, and abandonSale.
//
// Every money figure in this file is a call into src/lib/money (invariants 1,
// 7): the totals come from computeOrderTotals (cartTotals), the per-rate tax
// breakdown from taxBreakdown, the change from changeDue, and the line amounts
// from the money module's add/multiplyByInteger (lineAmounts). Nothing rounds
// here. The completeSale transaction bundles the completed order row, the
// invoice number, the queue seq and the queue entry together: they land as one
// atomic write, and an aborted transaction (a caller error, a browser tab
// close) burns nothing (invariant 5, spec 6).

import { withDb, valueOf, signalUnsyncedChange, type LocalOrder } from './store';
import { computeOrderTotals, taxBreakdown, type OrderTotals } from '../money/order-totals';
import { changeDue } from '../money/change';
import { add, minor, multiplyByInteger, ROUNDING_RULE, sum, type Minor } from '../money';
import type { TaxMode } from '../money/tax';
import type { ResolvedTaxRate } from './menu-view';
import {
	PAYMENT_METHODS,
	type OpEnvelope,
	type OrderType,
	type SaleAbandonedPayload,
	type SaleCompletePayload
} from '../sync-ops';
import { takeNextInvoice, takeNextQueueSeq } from './invoice-sequence';
import { enqueue } from './queue';

export type CartModifier = {
	modifierId: string;
	modifierName: string;
	priceDeltaMinor: bigint;
};

export type CartLine = {
	lineId: string;
	lineNo: number;
	menuItemId: string;
	itemName: string;
	quantity: number;
	unitPriceMinor: bigint;
	taxRateBp: number;
	/** The named rate the line was added at (invariant 7). Null when the till's
	 * menu was a format-1 copy, in which case the server infers the rate (T-15).
	 * A cart saved by the previous build has neither key, so every reader
	 * writes `?? null`. */
	taxRateId: string | null;
	taxRateName: string | null;
	discountMinor: 0n;
	modifiers: CartModifier[];
};

export type Cart = {
	orderId: string;
	deviceId: string;
	/** From the wire contract: dine_in (the default), takeaway or delivery. */
	orderType: OrderType;
	tableLabel: string | null;
	/** An optional kitchen note, at most 140 characters (menu-and-printing T-22).
	 * Optional in the type: carts stored before this field have none. */
	note?: string | null;
	lines: CartLine[];
	openedAt: string;
};

/** Item shape addLine consumes — a subset of the menu snapshot after the
 * caller has converted priceMinor to bigint. It carries NO rate: the rate
 * arrives resolved (resolveTaxRate in menu-view.ts), so no caller can think
 * the item's own number is read here. */
export type MenuItemForCart = {
	id: string;
	name: string;
	priceMinor: bigint;
};

export type MenuModifierForCart = {
	id: string;
	name: string;
	priceDeltaMinor: bigint;
};

function secureId(): string {
	if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
		throw new Error('This device cannot record a sale securely. Open the till over https.');
	}
	return crypto.randomUUID();
}

/**
 * The table label as the till stores it: control characters removed (a pasted
 * ESC byte must never reach the receipt — the printer would obey it), trimmed,
 * at most 32 characters, and null when nothing is left.
 */
function cleanLabel(value: string | null): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
	if (trimmed.length > 32) throw new Error('table label is at most 32 characters');
	return trimmed.length === 0 ? null : trimmed;
}

export function newCart(
	deviceId: string,
	orderType: OrderType,
	tableLabel: string | null = null,
	now = new Date()
): Cart {
	return {
		orderId: secureId(),
		deviceId,
		orderType,
		tableLabel: orderType === 'dine_in' ? cleanLabel(tableLabel) : null,
		lines: [],
		openedAt: now.toISOString()
	};
}

function requireQuantity(quantity: number): void {
	if (!Number.isSafeInteger(quantity) || quantity < 1) {
		throw new Error('quantity must be a safe integer >= 1');
	}
}

/** The modifiers a line was added with, in one order, so the same choices
 * picked in another order compare equal. */
function modifierKey(modifiers: CartModifier[]): string {
	return modifiers
		.map((m) => `${m.modifierId}\u0000${m.modifierName}\u0000${m.priceDeltaMinor}`)
		.sort()
		.join('\u0001');
}

/** True when `line` is the very thing `candidate` would add: the same item with
 * the same modifier choices, at the same snapshotted price and rate. Anything
 * that differs — other modifiers, or a price or rate a menu re-sync changed —
 * stays its own line, so every line keeps the one price and rate it prints. */
function isSameLine(line: CartLine, candidate: CartLine): boolean {
	return (
		line.menuItemId === candidate.menuItemId &&
		line.unitPriceMinor === candidate.unitPriceMinor &&
		line.taxRateBp === candidate.taxRateBp &&
		(line.taxRateId ?? null) === candidate.taxRateId &&
		(line.taxRateName ?? null) === candidate.taxRateName &&
		line.discountMinor === candidate.discountMinor &&
		modifierKey(line.modifiers) === modifierKey(candidate.modifiers)
	);
}

/**
 * Add an item, snapshotting the RESOLVED rate on it — number, id and name
 * (invariant 7). The caller resolves the rate (resolveTaxRate), which throws
 * for a missing one before this is reached; here the number only has to be a
 * rate at all. A rate of 0 is a rate, not "unset".
 *
 * Tapping an item the cart already holds — same item, same modifier choices,
 * same price and rate (isSameLine) — raises that line's quantity instead of
 * adding a second line (user decision 2026-10-07, replacing pos-sales T-33's
 * "two taps = two lines"). The line keeps its id and number. The till has no
 * sent-to-kitchen state on a cart line (kitchen tickets print at payment), so
 * nothing already sent can be merged into.
 */
export function addLine(
	cart: Cart,
	item: MenuItemForCart,
	rate: ResolvedTaxRate,
	modifiers: MenuModifierForCart[] = [],
	quantity = 1
): Cart {
	requireQuantity(quantity);
	if (!Number.isInteger(rate.rateBp) || rate.rateBp < 0 || rate.rateBp > 10000) {
		throw new Error('tax rate must be an integer number of basis points from 0 to 10000');
	}
	const line: CartLine = {
		lineId: secureId(),
		lineNo: cart.lines.length + 1,
		menuItemId: item.id,
		itemName: item.name,
		quantity,
		unitPriceMinor: item.priceMinor,
		taxRateBp: rate.rateBp,
		taxRateId: rate.id,
		taxRateName: rate.name,
		discountMinor: 0n,
		modifiers: modifiers.map((m) => ({
			modifierId: m.id,
			modifierName: m.name,
			priceDeltaMinor: m.priceDeltaMinor
		}))
	};
	const existing = cart.lines.find((l) => isSameLine(l, line));
	if (existing) {
		const merged = existing.quantity + quantity;
		requireQuantity(merged);
		return {
			...cart,
			lines: cart.lines.map((l) => (l.lineId === existing.lineId ? { ...l, quantity: merged } : l))
		};
	}
	return { ...cart, lines: [...cart.lines, line] };
}

/**
 * The line an `addLine` call created or grew, for the screen to select: the
 * line of `after` that is new, or whose quantity differs from `before`'s.
 * Null when nothing changed.
 */
export function touchedLineId(before: Cart, after: Cart): string | null {
	for (const line of after.lines) {
		const old = before.lines.find((l) => l.lineId === line.lineId);
		if (!old || old.quantity !== line.quantity) return line.lineId;
	}
	return null;
}

export function removeLine(cart: Cart, lineId: string): Cart {
	return {
		...cart,
		lines: cart.lines.filter((l) => l.lineId !== lineId).map((l, i) => ({ ...l, lineNo: i + 1 }))
	};
}

export function changeQuantity(cart: Cart, lineId: string, quantity: number): Cart {
	requireQuantity(quantity);
	return {
		...cart,
		lines: cart.lines.map((l) => (l.lineId === lineId ? { ...l, quantity } : l))
	};
}

export function saveCart(cart: Cart): Promise<void> {
	return withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction('orders', 'readwrite');
				tx.objectStore('orders').put({
					id: cart.orderId,
					deviceId: cart.deviceId,
					state: 'cart',
					cart
				} satisfies LocalOrder<Cart>);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('aborted'));
			})
	);
}

export function readCart(deviceId: string): Promise<Cart | null> {
	return withDb(async (db) => {
		const request = db.transaction('orders').objectStore('orders').index('status').getAll('cart');
		const rows = (await valueOf(request)) as LocalOrder<Cart>[];
		const carts = rows.filter((r) => r.deviceId === deviceId).map((r) => r.cart);
		if (carts.length === 0) return null;
		carts.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
		return carts[0];
	});
}

export function clearCart(deviceId: string): Promise<void> {
	return withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction('orders', 'readwrite');
				const store = tx.objectStore('orders');
				const request = store.index('status').openCursor('cart');
				request.onsuccess = () => {
					const cursor = request.result;
					if (cursor) {
						if ((cursor.value as { deviceId?: string }).deviceId === deviceId) {
							cursor.delete();
						}
						cursor.continue();
					}
				};
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('aborted'));
			})
	);
}

function toTotalsLine(l: CartLine) {
	return {
		unitPriceMinor: minor(l.unitPriceMinor),
		quantity: BigInt(l.quantity),
		modifierDeltasMinor: l.modifiers.map((m) => minor(m.priceDeltaMinor)),
		taxRateBp: l.taxRateBp,
		discountMinor: minor(0n) as Minor
	};
}

export function cartTotals(cart: Cart, taxMode: TaxMode): OrderTotals {
	return computeOrderTotals({ taxMode, lines: cart.lines.map(toTotalsLine) }, ROUNDING_RULE);
}

/**
 * The kitchen note as the till stores it: control characters become spaces (an
 * ESC byte must never reach the kitchen printer), runs of spaces collapse,
 * trimmed, at most 140 characters, and null when nothing is left.
 */
export function setNote(cart: Cart, note: string): Cart {
	const cleaned = note
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/ {2,}/g, ' ')
		.trim();
	if (cleaned.length > 140) throw new Error('the kitchen note is at most 140 characters');
	return { ...cart, note: cleaned === '' ? null : cleaned };
}

/** A new cart with the order type and table replaced; lines untouched.
 * Takeaway and delivery always drop the table. */
export function setOrderType(cart: Cart, orderType: OrderType, tableLabel: string | null): Cart {
	return {
		...cart,
		orderType,
		tableLabel: orderType === 'dine_in' ? cleanLabel(tableLabel) : null
	};
}

/** Each line's (unit price + Σ modifier deltas) × quantity, exact, unrounded.
 * computeOrderTotals derives the same integer internally but returns only
 * Exact tax figures, so the till recomputes it with the same three calls. */
export function lineAmounts(cart: Cart): Minor[] {
	return cart.lines.map((line) =>
		multiplyByInteger(
			add(minor(line.unitPriceMinor), sum(line.modifiers.map((m) => minor(m.priceDeltaMinor)))),
			BigInt(line.quantity)
		)
	);
}

export type CompleteSaleArgs = {
	cart: Cart;
	/** The tender's KIND and, for cash, what was handed over. `paymentMethodId`
	 * and `paymentMethodName` are the owner-named method the sale was taken with
	 * (settings-tax-payments-receipt T-19): both REQUIRED, so no caller can
	 * forget them; null means "this till does not know the method", and the
	 * server then resolves it by kind (T-15). */
	payment: {
		method: 'cash' | 'card' | 'mobile';
		tenderedMinor: bigint | null;
		paymentMethodId: string | null;
		paymentMethodName: string | null;
	};
	employeeId: string;
	deviceId: string;
	deviceCode: string;
	posSessionId: string;
	taxMode: TaxMode;
	currencyCode: string;
	menuVersion: number;
	now: Date;
	/** Kept on the local order for the receipt (menu-and-printing T-18). */
	cashierName: string;
	/** The session's business date, or null while the server has not assigned one. */
	businessDate: string | null;
};

export type CompleteSaleResult = {
	orderId: string;
	invoiceNumber: string;
	changeMinor: bigint | null;
	clientOpId: string;
};

function validateBeforeTx(args: CompleteSaleArgs): void {
	const { cart, payment, deviceId } = args;
	if (cart.lines.length === 0) throw new Error('cart.lines is empty');
	if (cart.deviceId !== deviceId) throw new Error('cart.deviceId does not match');
	for (const line of cart.lines) {
		requireQuantity(line.quantity);
		if (typeof line.unitPriceMinor !== 'bigint' || line.unitPriceMinor < 0n) {
			throw new Error(`line ${line.lineNo}.unitPriceMinor invalid`);
		}
		if (line.discountMinor !== 0n) throw new Error(`line ${line.lineNo}.discountMinor must be 0n`);
		for (const m of line.modifiers) {
			if (typeof m.priceDeltaMinor !== 'bigint') {
				throw new Error(`line ${line.lineNo} modifier priceDeltaMinor must be bigint`);
			}
		}
	}
	if (!(PAYMENT_METHODS as readonly string[]).includes(payment.method)) {
		throw new Error(`payment.method invalid`);
	}
	if (payment.method === 'cash') {
		if (typeof payment.tenderedMinor !== 'bigint') {
			throw new Error('cash payment needs tenderedMinor bigint');
		}
	} else if (payment.tenderedMinor !== null) {
		throw new Error('card/mobile tenderedMinor must be null');
	}
}

export async function completeSale(
	args: CompleteSaleArgs,
	abortForTest = false
): Promise<CompleteSaleResult> {
	validateBeforeTx(args);
	const totals = cartTotals(args.cart, args.taxMode);
	// The per-rate split of totals.tax, for the receipt — from the SAME lines in
	// the SAME order (taxBreakdown pairs lineRates[i] with totals.lines[i]); its
	// rows sum to totals.tax by construction (invariant 7: one rounding rule, in
	// the money module). Computed BEFORE the transaction opens, like every other
	// figure here. A line saved by the previous build has no name key.
	const breakdown = taxBreakdown(
		totals,
		args.cart.lines.map((l) => ({ rateBp: l.taxRateBp, name: l.taxRateName ?? null })),
		ROUNDING_RULE
	);
	const changeMinor =
		args.payment.method === 'cash'
			? changeDue(minor(args.payment.tenderedMinor as bigint), totals.total)
			: null;
	const clientOpId = secureId();
	const paymentId = secureId();
	const occurredAt = args.now.toISOString();
	// The per-line amounts the order screen showed — the same money-module path,
	// kept on the order so a receipt never recomputes them (invariant 7).
	const amounts = lineAmounts(args.cart);

	const payload: SaleCompletePayload = {
		orderId: args.cart.orderId,
		posSessionId: args.posSessionId,
		orderType: args.cart.orderType,
		tableLabel: args.cart.tableLabel,
		// T-22: the kitchen note rides in the payload; a cart without one sends null.
		note: args.cart.note ?? null,
		taxMode: args.taxMode,
		currencyCode: args.currencyCode,
		menuVersion: args.menuVersion,
		invoiceSeq: 0,
		invoiceNumber: '',
		openedAt: args.cart.openedAt,
		lines: args.cart.lines.map((l) => ({
			lineId: l.lineId,
			lineNo: l.lineNo,
			menuItemId: l.menuItemId,
			itemName: l.itemName,
			quantity: l.quantity,
			unitPriceMinor: l.unitPriceMinor.toString(),
			taxRateBp: l.taxRateBp,
			// settings-tax-payments-receipt T-19: the named rate, optional on the
			// wire (T-14). This till always sends both keys — null when the rate
			// came from a format-1 copy or the cart was saved by the previous build.
			taxRateId: l.taxRateId ?? null,
			taxRateName: l.taxRateName ?? null,
			discountMinor: '0',
			modifiers: l.modifiers.map((m) => ({
				modifierId: m.modifierId,
				modifierName: m.modifierName,
				priceDeltaMinor: m.priceDeltaMinor.toString()
			}))
		})),
		totals: {
			subtotalMinor: totals.subtotal.toString(),
			discountMinor: totals.discount.toString(),
			taxMinor: totals.tax.toString(),
			totalMinor: totals.total.toString()
		},
		payments: [
			{
				paymentId,
				method: args.payment.method,
				amountMinor: totals.total.toString(),
				tenderedMinor:
					args.payment.method === 'cash' ? (args.payment.tenderedMinor as bigint).toString() : null,
				changeMinor: changeMinor === null ? null : changeMinor.toString(),
				// The owner-named method (T-14, optional on the wire): sent as null
				// when this till does not know it, the way `note` is sent.
				paymentMethodId: args.payment.paymentMethodId,
				paymentMethodName: args.payment.paymentMethodName
			}
		]
	};

	const result = await withDb(
		(db) =>
			new Promise<CompleteSaleResult>((resolve, reject) => {
				const tx = db.transaction(['orders', 'sync_queue', 'invoice_sequence'], 'readwrite');
				let resolved: CompleteSaleResult | null = null;
				(async () => {
					try {
						const invoice = await takeNextInvoice(tx, args.deviceId, args.deviceCode);
						const seq = await takeNextQueueSeq(tx, args.deviceId);
						payload.invoiceSeq = invoice.seq;
						payload.invoiceNumber = invoice.number;
						tx.objectStore('orders').put({
							id: args.cart.orderId,
							deviceId: args.deviceId,
							employeeId: args.employeeId,
							clientOpId,
							state: 'completed',
							cart: args.cart,
							invoiceSeq: invoice.seq,
							invoiceNumber: invoice.number,
							completedAt: occurredAt,
							// THE SAME payload object the queue entry carries — invoice number
							// already set — so the receipt prints exactly what the books get
							// (menu-and-printing T-18). No second computation of any total.
							sale: {
								payload,
								lineAmountsMinor: amounts.map((a) => a.toString()),
								cashierName: args.cashierName,
								completedAt: occurredAt,
								businessDate: args.businessDate,
								// Decimal strings: a bigint cannot cross JSON, and IndexedDB keeps
								// the string the receipt prints (T-23 reads it).
								taxBreakdown: breakdown.map((row) => ({
									name: row.name,
									rateBp: row.rateBp,
									taxMinor: row.tax.toString()
								}))
							}
						} satisfies LocalOrder<Cart>);
						const envelope: OpEnvelope<'sale.complete', SaleCompletePayload> = {
							kind: 'sale.complete',
							clientOpId,
							deviceId: args.deviceId,
							employeeId: args.employeeId,
							occurredAt,
							seq,
							payload
						};
						await enqueue(tx, {
							clientOpId,
							deviceId: args.deviceId,
							seq,
							kind: 'sale.complete',
							envelope,
							state: 'pending',
							attempts: 0
						});
						resolved = {
							orderId: args.cart.orderId,
							invoiceNumber: invoice.number,
							changeMinor,
							clientOpId
						};
						if (abortForTest) tx.abort();
					} catch (thrown) {
						tx.abort();
						reject(thrown);
					}
				})();
				tx.oncomplete = () => {
					if (resolved) resolve(resolved);
					else reject(new Error('transaction committed without resolve'));
				};
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('aborted'));
			})
	);
	signalUnsyncedChange();
	return result;
}

export async function abandonSale(
	orderId: string,
	reason: 'rejected' | 'cancelled',
	now = new Date()
): Promise<{ clientOpId: string }> {
	const clientOpId = secureId();
	const occurredAt = now.toISOString();
	await withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction(['orders', 'sync_queue', 'invoice_sequence'], 'readwrite');
				(async () => {
					try {
						const order = (await valueOf(tx.objectStore('orders').get(orderId))) as
							LocalOrder<Cart> | undefined;
						if (
							!order ||
							order.state !== 'completed' ||
							typeof order.invoiceSeq !== 'number' ||
							typeof order.invoiceNumber !== 'string' ||
							typeof order.employeeId !== 'string' ||
							typeof order.clientOpId !== 'string'
						) {
							throw new Error('order is not a completed sale');
						}
						tx.objectStore('orders').put({ ...order, state: 'abandoned' });
						const originalEntry = (await valueOf(
							tx.objectStore('sync_queue').get(order.clientOpId)
						)) as { state: string } | undefined;
						if (originalEntry && originalEntry.state === 'pending') {
							tx.objectStore('sync_queue').put({
								...originalEntry,
								state: 'done',
								lastError: 'cancelled_before_send'
							});
						}
						const seq = await takeNextQueueSeq(tx, order.deviceId);
						const envelope: OpEnvelope<'sale.abandoned', SaleAbandonedPayload> = {
							kind: 'sale.abandoned',
							clientOpId,
							deviceId: order.deviceId,
							employeeId: order.employeeId,
							occurredAt,
							seq,
							payload: {
								orderId,
								invoiceSeq: order.invoiceSeq,
								invoiceNumber: order.invoiceNumber,
								reason
							}
						};
						await enqueue(tx, {
							clientOpId,
							deviceId: order.deviceId,
							seq,
							kind: 'sale.abandoned',
							envelope,
							state: 'pending',
							attempts: 0
						});
					} catch (thrown) {
						tx.abort();
						reject(thrown);
					}
				})();
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('aborted'));
			})
	);
	signalUnsyncedChange();
	return { clientOpId };
}
