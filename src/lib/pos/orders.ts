// The local cart, completeSale in ONE IndexedDB transaction, and abandonSale.
//
// Money arithmetic in this file is exactly one call — cartTotals delegates to
// computeOrderTotals (invariant 1, 7). The completeSale transaction bundles
// the completed order row, the invoice number, the queue seq and the queue
// entry together: they land as one atomic write, and an aborted transaction
// (a caller error, a browser tab close) burns nothing (invariant 5, spec 6).

import { withDb, valueOf, signalUnsyncedChange, type LocalOrder } from './store';
import { computeOrderTotals, type OrderTotals } from '../money/order-totals';
import { changeDue } from '../money/change';
import { minor, ROUNDING_RULE, type Minor } from '../money';
import type { TaxMode } from '../money/tax';
import {
	PAYMENT_METHODS,
	type OpEnvelope,
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
	discountMinor: 0n;
	modifiers: CartModifier[];
};

export type Cart = {
	orderId: string;
	deviceId: string;
	orderType: 'dine_in' | 'takeaway';
	tableLabel: string | null;
	lines: CartLine[];
	openedAt: string;
};

/** Item shape addLine consumes — a subset of the menu snapshot after the
 * caller has converted priceMinor to bigint. */
export type MenuItemForCart = {
	id: string;
	name: string;
	priceMinor: bigint;
	taxRateBp: number | null;
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

export function newCart(
	deviceId: string,
	orderType: Cart['orderType'],
	tableLabel: string | null = null,
	now = new Date()
): Cart {
	let label: string | null = null;
	if (typeof tableLabel === 'string') {
		const trimmed = tableLabel.trim();
		if (trimmed.length > 32) throw new Error('table label is at most 32 characters');
		label = trimmed.length === 0 ? null : trimmed;
	}
	return {
		orderId: secureId(),
		deviceId,
		orderType,
		tableLabel: label,
		lines: [],
		openedAt: now.toISOString()
	};
}

function requireQuantity(quantity: number): void {
	if (!Number.isSafeInteger(quantity) || quantity < 1) {
		throw new Error('quantity must be a safe integer >= 1');
	}
}

export function addLine(
	cart: Cart,
	item: MenuItemForCart,
	restaurantTaxRateBp: number | null,
	modifiers: MenuModifierForCart[] = [],
	quantity = 1
): Cart {
	requireQuantity(quantity);
	const taxRateBp = item.taxRateBp ?? restaurantTaxRateBp;
	if (taxRateBp === null) {
		throw new Error('No tax rate is configured. The owner sets one on /settings.');
	}
	const line: CartLine = {
		lineId: secureId(),
		lineNo: cart.lines.length + 1,
		menuItemId: item.id,
		itemName: item.name,
		quantity,
		unitPriceMinor: item.priceMinor,
		taxRateBp,
		discountMinor: 0n,
		modifiers: modifiers.map((m) => ({
			modifierId: m.id,
			modifierName: m.name,
			priceDeltaMinor: m.priceDeltaMinor
		}))
	};
	return { ...cart, lines: [...cart.lines, line] };
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

export type CompleteSaleArgs = {
	cart: Cart;
	payment: { method: 'cash' | 'card' | 'mobile'; tenderedMinor: bigint | null };
	employeeId: string;
	deviceId: string;
	deviceCode: string;
	posSessionId: string;
	taxMode: TaxMode;
	currencyCode: string;
	menuVersion: number;
	now: Date;
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
	const changeMinor =
		args.payment.method === 'cash'
			? changeDue(minor(args.payment.tenderedMinor as bigint), totals.total)
			: null;
	const clientOpId = secureId();
	const paymentId = secureId();
	const occurredAt = args.now.toISOString();

	const payload: SaleCompletePayload = {
		orderId: args.cart.orderId,
		posSessionId: args.posSessionId,
		orderType: args.cart.orderType,
		tableLabel: args.cart.tableLabel,
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
				changeMinor: changeMinor === null ? null : changeMinor.toString()
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
							completedAt: occurredAt
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
