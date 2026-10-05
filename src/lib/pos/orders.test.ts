import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { ROUNDING_RULE, minor } from '../money';
import { computeOrderTotals } from '../money/order-totals';
import type { TaxMode } from '../money/tax';
import { withDb, inTransaction, countUnsynced, type QueueEntry, type LocalOrder } from './store';
import { readSequence } from './invoice-sequence';
import type { ResolvedTaxRate } from './menu-view';
import {
	abandonSale,
	addLine,
	cartTotals,
	changeQuantity,
	completeSale,
	lineAmounts,
	newCart,
	removeLine,
	setNote,
	setOrderType,
	type Cart,
	type CartLine,
	type MenuItemForCart,
	type MenuModifierForCart
} from './orders';

const NOW = new Date('2026-09-28T10:00:00.000Z');

function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase('matcami-pos');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

beforeEach(async () => {
	await deleteDatabase();
});

// settings-tax-payments-receipt T-19: addLine takes the RESOLVED rate — number,
// id and name. LEGACY is what a format-1 menu copy resolves to (ids null).
const VAT: ResolvedTaxRate = { id: 'rate-vat', name: 'VAT', rateBp: 825 };
const REDUCED: ResolvedTaxRate = { id: 'rate-red', name: 'Reduced', rateBp: 500 };
const LEGACY: ResolvedTaxRate = { id: null, name: null, rateBp: 825 };

const tea: MenuItemForCart = {
	id: 'item-tea',
	name: 'Tea',
	priceMinor: 850n
};
const coffee: MenuItemForCart = {
	id: 'item-coffee',
	name: 'Coffee',
	priceMinor: 999n
};
const cream: MenuModifierForCart = {
	id: 'mod-cream',
	name: 'Cream',
	priceDeltaMinor: 50n
};

async function readQueue(): Promise<QueueEntry[]> {
	return withDb(async (db) => {
		return new Promise<QueueEntry[]>((resolve, reject) => {
			const request = db.transaction('sync_queue').objectStore('sync_queue').getAll();
			request.onsuccess = () => resolve(request.result as QueueEntry[]);
			request.onerror = () => reject(request.error);
		});
	});
}

async function readOrder(id: string): Promise<LocalOrder<Cart> | undefined> {
	return withDb(async (db) => {
		return new Promise<LocalOrder<Cart> | undefined>((resolve, reject) => {
			const request = db.transaction('orders').objectStore('orders').get(id);
			request.onsuccess = () => resolve(request.result as LocalOrder<Cart> | undefined);
			request.onerror = () => reject(request.error);
		});
	});
}

describe('cart primitives', () => {
	it('newCart trims table_label; empty becomes null; > 32 chars throws', () => {
		expect(newCart('device-A', 'dine_in', '   ', NOW).tableLabel).toBeNull();
		expect(newCart('device-A', 'dine_in', ' T 12 ', NOW).tableLabel).toBe('T 12');
		expect(() => newCart('device-A', 'dine_in', 'x'.repeat(33), NOW)).toThrow(/32 characters/);
		expect(newCart('device-A', 'dine_in', 'x'.repeat(32), NOW).tableLabel).toBe('x'.repeat(32));
	});

	it('addLine snapshots the resolved rate: number, id and name', () => {
		const c = newCart('device-A', 'takeaway', null, NOW);
		expect(addLine(c, tea, VAT).lines[0]).toMatchObject({
			taxRateBp: 825,
			taxRateId: 'rate-vat',
			taxRateName: 'VAT'
		});
		expect(addLine(c, tea, LEGACY).lines[0]).toMatchObject({
			taxRateBp: 825,
			taxRateId: null,
			taxRateName: null
		});
		// 0 is a rate, not "unset".
		expect(addLine(c, tea, { id: 'r0', name: 'Exempt', rateBp: 0 }).lines[0]).toMatchObject({
			taxRateBp: 0,
			taxRateId: 'r0',
			taxRateName: 'Exempt'
		});
		for (const rateBp of [8.25, -1, 10001]) {
			expect(() => addLine(c, tea, { id: null, name: null, rateBp })).toThrow(/basis points/);
		}
	});

	it('removeLine renumbers; changeQuantity is absolute', () => {
		let d = newCart('device-A', 'takeaway', null, NOW);
		d = addLine(d, tea, VAT);
		d = addLine(d, tea, VAT);
		d = addLine(d, tea, VAT);
		const middleId = d.lines[1].lineId;
		d = removeLine(d, middleId);
		expect(d.lines.map((l) => l.lineNo)).toEqual([1, 2]);
		d = changeQuantity(d, d.lines[0].lineId, 3);
		expect(d.lines[0].quantity).toBe(3);
	});
});

describe('cartTotals', () => {
	it("delegates to computeOrderTotals; till's number IS the money module's", () => {
		let c = newCart('device-A', 'takeaway', null, NOW);
		c = addLine(c, tea, VAT, [cream], 2);
		c = addLine(c, coffee, VAT);
		const t = cartTotals(c, 'exclusive');
		const expected = computeOrderTotals(
			{
				taxMode: 'exclusive',
				lines: c.lines.map((l) => ({
					unitPriceMinor: minor(l.unitPriceMinor),
					quantity: BigInt(l.quantity),
					modifierDeltasMinor: l.modifiers.map((m) => minor(m.priceDeltaMinor)),
					taxRateBp: l.taxRateBp,
					discountMinor: minor(0n)
				}))
			},
			ROUNDING_RULE
		);
		expect(t).toEqual(expected);
		expect(t.subtotal).toBe(2799n);
		expect(t.tax).toBe(231n);
		expect(t.total).toBe(3030n);
	});
});

describe('completeSale', () => {
	async function buildCart(): Promise<Cart> {
		let c = newCart('device-A', 'takeaway', null, NOW);
		c = addLine(c, tea, VAT, [cream], 2);
		c = addLine(c, coffee, VAT);
		return c;
	}

	it('records a cash sale atomically: one order, one queue entry, invoice 1', async () => {
		const cart = await buildCart();
		const result = await completeSale({
			cart,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		expect(result.invoiceNumber).toBe('POS1-000001');
		expect(result.changeMinor).toBe(1970n);
		const order = await readOrder(cart.orderId);
		expect(order?.state).toBe('completed');
		expect(order?.invoiceSeq).toBe(1);
		expect(order?.employeeId).toBe('emp-1');
		expect(order?.clientOpId).toBe(result.clientOpId);
		const queue = await readQueue();
		expect(queue).toHaveLength(1);
		expect(queue[0].kind).toBe('sale.complete');
		expect(queue[0].seq).toBe(1);
		expect(queue[0].state).toBe('pending');
		expect(await readSequence('device-A')).toEqual({
			deviceId: 'device-A',
			invoiceSeq: 1,
			queueSeq: 1
		});
	});

	// menu-and-printing T-17: delivery rides in the queued payload unchanged.
	it("a delivery cart completes with orderType 'delivery' and tableLabel null in the queued payload", async () => {
		let cart = newCart('device-A', 'delivery', 'ignored', NOW);
		cart = addLine(cart, tea, VAT);
		const result = await completeSale({
			cart,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const queue = await readQueue();
		expect(queue).toHaveLength(1);
		const payload = queue[0].envelope.payload as { orderType: string; tableLabel: string | null };
		expect(payload.orderType).toBe('delivery');
		expect(payload.tableLabel).toBeNull();
		expect((await readOrder(cart.orderId))?.invoiceNumber).toBe(result.invoiceNumber);
	});

	// menu-and-printing T-18: the receipt's numbers live on the order, verbatim.
	it('stores the queued payload, the line amounts, the cashier and the business date on the completed order', async () => {
		const cart = await buildCart();
		const result = await completeSale({
			cart,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const order = await readOrder(cart.orderId);
		const [entry] = await readQueue();
		expect(order?.sale).toBeDefined();
		// Deep-equal to the queue entry's payload, invoice number included.
		expect(order?.sale?.payload).toEqual(entry.envelope.payload);
		expect(order?.sale?.payload.invoiceNumber).toBe(result.invoiceNumber);
		expect(order?.sale?.lineAmountsMinor).toEqual(lineAmounts(cart).map(String));
		expect(order?.sale?.cashierName).toBe('Sam');
		expect(order?.sale?.businessDate).toBe('2026-09-28');
		expect(order?.sale?.completedAt).toBe(NOW.toISOString());
		expect(order?.printed).toBeUndefined();
		// settings-tax-payments-receipt T-19: the per-rate breakdown, stored as
		// decimal strings beside the payload, equals the payload's stored tax.
		expect(order?.sale?.taxBreakdown).toEqual([{ name: 'VAT', rateBp: 825, taxMinor: '231' }]);
		expect(order?.sale?.payload.totals.taxMinor).toBe('231');
	});

	it('payload lines carry the rate id and name; a legacy line sends nulls', async () => {
		let cart = newCart('device-A', 'takeaway', null, NOW);
		cart = addLine(cart, tea, VAT);
		cart = addLine(cart, coffee, LEGACY);
		await completeSale({
			cart,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const [entry] = await readQueue();
		const { lines } = entry.envelope.payload as {
			lines: { taxRateBp: number; taxRateId: unknown; taxRateName: unknown }[];
		};
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ taxRateBp: 825, taxRateId: 'rate-vat', taxRateName: 'VAT' });
		expect(lines[1]).toMatchObject({ taxRateBp: 825, taxRateId: null, taxRateName: null });
	});

	it('a cart saved by the previous build sends null ids', async () => {
		const built = await buildCart();
		// The previous build's CartLine had neither key at all.
		const cart: Cart = {
			...built,
			lines: built.lines.map((l) => {
				const legacy: Partial<CartLine> = { ...l };
				delete legacy.taxRateId;
				delete legacy.taxRateName;
				return legacy as CartLine;
			})
		};
		expect('taxRateId' in cart.lines[0]).toBe(false);
		await completeSale({
			cart,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const [entry] = await readQueue();
		const { lines } = entry.envelope.payload as {
			lines: { taxRateId: unknown; taxRateName: unknown }[];
		};
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line.taxRateId).toBeNull();
			expect(line.taxRateName).toBeNull();
		}
		// The breakdown groups the nameless lines under one null-named row.
		expect((await readOrder(cart.orderId))?.sale?.taxBreakdown).toEqual([
			{ name: null, rateBp: 825, taxMinor: '231' }
		]);
	});

	it('completeSale carries the note in the queued payload, and null without one', async () => {
		const withNote = setNote(await buildCart(), 'no onions');
		await completeSale({
			cart: withNote,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const plain = await buildCart();
		await completeSale({
			cart: plain,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const notes = (await readQueue()).map(
			(q) => (q.envelope.payload as { orderId: string; note: string | null }).note
		);
		expect(notes.sort()).toEqual([null, 'no onions'].sort());
	});

	it('abortForTest leaves nothing behind — no order, no queue, no counter movement', async () => {
		const cart = await buildCart();
		await expect(
			completeSale(
				{
					cart,
					payment: {
						method: 'cash',
						tenderedMinor: 5000n,
						paymentMethodId: null,
						paymentMethodName: null
					},
					employeeId: 'emp-1',
					deviceId: 'device-A',
					deviceCode: 'POS1',
					posSessionId: 'ses-1',
					taxMode: 'exclusive',
					currencyCode: 'USD',
					menuVersion: 1,
					now: NOW,
					cashierName: 'Sam',
					businessDate: '2026-09-28'
				},
				true
			)
		).rejects.toThrow();
		expect(await readOrder(cart.orderId)).toBeUndefined();
		expect(await readQueue()).toHaveLength(0);
		expect(await readSequence('device-A')).toEqual({
			deviceId: 'device-A',
			invoiceSeq: 0,
			queueSeq: 0
		});
	});

	it('two sales get numbers 1 and 2 and different clientOpIds', async () => {
		const first = await completeSale({
			cart: await buildCart(),
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const second = await completeSale({
			cart: await buildCart(),
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		expect(first.invoiceNumber).toBe('POS1-000001');
		expect(second.invoiceNumber).toBe('POS1-000002');
		expect(first.clientOpId).not.toBe(second.clientOpId);
	});

	it('every *Minor in the envelope is a string', async () => {
		const cart = await buildCart();
		await completeSale({
			cart,
			payment: {
				method: 'cash',
				tenderedMinor: 5000n,
				paymentMethodId: 'pm-cash',
				paymentMethodName: 'Cash'
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const [entry] = await readQueue();
		expect(() => JSON.stringify(entry.envelope)).not.toThrow();
		const payload = entry.envelope.payload as {
			totals: { totalMinor: string };
			lines: { unitPriceMinor: string; discountMinor: string }[];
			payments: { amountMinor: string; tenderedMinor: string | null; changeMinor: string | null }[];
		};
		expect(payload.totals.totalMinor).toBe('3030');
		expect(payload.lines[0].unitPriceMinor).toBe('850');
		expect(payload.lines[0].discountMinor).toBe('0');
		expect(payload.payments[0]).toEqual({
			paymentId: expect.stringMatching(/[0-9a-f-]+/),
			method: 'cash',
			amountMinor: '3030',
			tenderedMinor: '5000',
			changeMinor: '1970',
			paymentMethodId: 'pm-cash',
			paymentMethodName: 'Cash'
		});
	});

	it('card sale queues with tenderedMinor null and changeMinor null; no arithmetic', async () => {
		const cart = await buildCart();
		const result = await completeSale({
			cart,
			payment: {
				method: 'card',
				tenderedMinor: null,
				paymentMethodId: 'pm-evc',
				paymentMethodName: 'EVC Plus'
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		expect(result.changeMinor).toBeNull();
		const [entry] = await readQueue();
		const payments = (entry.envelope.payload as { payments: unknown[] }).payments as {
			tenderedMinor: unknown;
			changeMinor: unknown;
			paymentMethodId: unknown;
			paymentMethodName: unknown;
		}[];
		expect(payments[0].tenderedMinor).toBeNull();
		expect(payments[0].changeMinor).toBeNull();
		expect(payments[0].paymentMethodId).toBe('pm-evc');
		expect(payments[0].paymentMethodName).toBe('EVC Plus');
	});

	it('cash short rejects before writing', async () => {
		const cart = await buildCart();
		await expect(
			completeSale({
				cart,
				payment: {
					method: 'cash',
					tenderedMinor: 100n,
					paymentMethodId: null,
					paymentMethodName: null
				},
				employeeId: 'emp-1',
				deviceId: 'device-A',
				deviceCode: 'POS1',
				posSessionId: 'ses-1',
				taxMode: 'exclusive',
				currencyCode: 'USD',
				menuVersion: 1,
				now: NOW,
				cashierName: 'Sam',
				businessDate: '2026-09-28'
			})
		).rejects.toThrow();
		expect(await readQueue()).toHaveLength(0);
	});
});

describe('abandonSale', () => {
	it('marks the order abandoned, cancels its still-pending entry, queues sale.abandoned', async () => {
		let c = newCart('device-A', 'takeaway', null, NOW);
		c = addLine(c, tea, VAT);
		const sale = await completeSale({
			cart: c,
			payment: {
				method: 'card',
				tenderedMinor: null,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const result = await abandonSale(sale.orderId, 'rejected', NOW);
		const order = await readOrder(sale.orderId);
		expect(order?.state).toBe('abandoned');
		expect(order?.invoiceNumber).toBe('POS1-000001');
		const queue = await readQueue();
		const abandon = queue.find((q) => q.kind === 'sale.abandoned');
		expect(abandon).toBeDefined();
		expect(abandon?.clientOpId).toBe(result.clientOpId);
		expect((abandon?.envelope.payload as { invoiceNumber: string }).invoiceNumber).toBe(
			'POS1-000001'
		);
		const original = queue.find((q) => q.clientOpId === sale.clientOpId);
		expect(original?.state).toBe('done');
		expect(original?.lastError).toBe('cancelled_before_send');
	});

	it('abandonSale of a `cart` order rejects', async () => {
		await expect(abandonSale('never-existed', 'cancelled')).rejects.toThrow();
	});
});

describe('unsynced count follows the queue', () => {
	it('one sale + one open + one (abandon) = 2 pending net', async () => {
		let c = newCart('device-A', 'takeaway', null, NOW);
		c = addLine(c, tea, VAT);
		await completeSale({
			cart: c,
			payment: {
				method: 'cash',
				tenderedMinor: 1000n,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		await withDb((db) =>
			inTransaction(db, ['sync_queue'], 'readwrite', (tx) => {
				tx.objectStore('sync_queue').put({
					clientOpId: 'op-open',
					deviceId: 'device-A',
					seq: 999,
					kind: 'session.open',
					envelope: {},
					state: 'pending',
					attempts: 0
				} as unknown as QueueEntry);
			})
		);
		expect(await countUnsynced()).toBe(2);
	});
});

describe('T-33 cart helpers', () => {
	const tea33: MenuItemForCart = { id: 'item-tea', name: 'Tea', priceMinor: 850n };
	const coffee33: MenuItemForCart = {
		id: 'item-coffee',
		name: 'Coffee',
		priceMinor: 1000n
	};
	const oat: MenuModifierForCart = { id: 'mod-oat', name: 'Oat', priceDeltaMinor: 50n };

	function doneWhenCart(): Cart {
		let cart = newCart('device-A', 'dine_in', null, NOW);
		cart = addLine(cart, tea33, VAT);
		cart = addLine(cart, coffee33, VAT, [oat]);
		return cart;
	}

	it('MANDATORY (spec 29): line amounts and totals in both tax modes agree', () => {
		const cart = doneWhenCart();
		expect(lineAmounts(cart)).toEqual([850n, 1050n]);
		expect(cart.lines.map((l) => l.taxRateBp)).toEqual([825, 825]);

		const exclusive = cartTotals(cart, 'exclusive');
		expect([exclusive.subtotal, exclusive.discount, exclusive.tax, exclusive.total]).toEqual([
			1900n,
			0n,
			157n,
			2057n
		]);
		const inclusive = cartTotals(cart, 'inclusive');
		expect([inclusive.subtotal, inclusive.discount, inclusive.tax, inclusive.total]).toEqual([
			1755n,
			0n,
			145n,
			1900n
		]);

		const summed = lineAmounts(cart).reduce((acc, v) => acc + v, 0n);
		expect(summed).toBe(exclusive.subtotal);
		expect(summed).toBe(inclusive.total);
	});

	// settings-tax-payments-receipt T-19. The exact line taxes are 70.125 and
	// 52.5 exclusive, and 64.78… and 50 inclusive: the rows prove the CUMULATIVE
	// rounding of the money module's taxBreakdown (70 then 123 − 70 = 53), not a
	// per-row rounding of 52.5 on its own.
	it('MANDATORY (spec 29): a two-rate cart: totals and breakdown in both tax modes', async () => {
		const twoRates = (): Cart => {
			let cart = newCart('device-A', 'dine_in', null, NOW);
			cart = addLine(cart, tea33, VAT);
			cart = addLine(cart, coffee33, REDUCED, [oat]);
			return cart;
		};

		const exclusive = cartTotals(twoRates(), 'exclusive');
		expect([exclusive.subtotal, exclusive.discount, exclusive.tax, exclusive.total]).toEqual([
			1900n,
			0n,
			123n,
			2023n
		]);
		const inclusive = cartTotals(twoRates(), 'inclusive');
		expect([inclusive.subtotal, inclusive.discount, inclusive.tax, inclusive.total]).toEqual([
			1785n,
			0n,
			115n,
			1900n
		]);

		const sold = async (taxMode: TaxMode) => {
			const cart = twoRates();
			await completeSale({
				cart,
				payment: {
					method: 'cash',
					tenderedMinor: 5000n,
					paymentMethodId: null,
					paymentMethodName: null
				},
				employeeId: 'emp-1',
				deviceId: 'device-A',
				deviceCode: 'POS1',
				posSessionId: 'ses-1',
				taxMode,
				currencyCode: 'USD',
				menuVersion: 1,
				now: NOW,
				cashierName: 'Sam',
				businessDate: '2026-09-28'
			});
			const sale = (await readOrder(cart.orderId))?.sale;
			expect(sale).toBeDefined();
			return { breakdown: sale!.taxBreakdown!, taxMinor: sale!.payload.totals.taxMinor };
		};

		const soldExclusive = await sold('exclusive');
		expect(soldExclusive.breakdown).toEqual([
			{ name: 'VAT', rateBp: 825, taxMinor: '70' },
			{ name: 'Reduced', rateBp: 500, taxMinor: '53' }
		]);
		const soldInclusive = await sold('inclusive');
		expect(soldInclusive.breakdown).toEqual([
			{ name: 'VAT', rateBp: 825, taxMinor: '65' },
			{ name: 'Reduced', rateBp: 500, taxMinor: '50' }
		]);
		for (const { breakdown, taxMinor } of [soldExclusive, soldInclusive]) {
			const rows = breakdown.reduce((acc, row) => acc + BigInt(row.taxMinor), 0n);
			expect(rows).toBe(BigInt(taxMinor));
		}
	});

	// menu-and-printing T-17.
	it('setOrderType drops the table for takeaway and delivery, keeps it for dine in, and leaves lines alone', () => {
		const cart = doneWhenCart();
		const seated = setOrderType(cart, 'dine_in', ' 4 ');
		expect(seated).toMatchObject({ orderType: 'dine_in', tableLabel: '4' });
		expect(seated.lines).toBe(cart.lines);

		const takeaway = setOrderType(seated, 'takeaway', '4');
		expect(takeaway).toMatchObject({ orderType: 'takeaway', tableLabel: null });
		const delivery = setOrderType(seated, 'delivery', '4');
		expect(delivery).toMatchObject({ orderType: 'delivery', tableLabel: null });
		expect(delivery.lines).toBe(cart.lines);
		expect(delivery.orderId).toBe(cart.orderId);

		expect(() => setOrderType(cart, 'dine_in', 'x'.repeat(33))).toThrow(/32/);
	});

	it('newCart and setOrderType strip control characters from the table label', () => {
		expect(newCart('device-A', 'dine_in', '4\u001b', NOW).tableLabel).toBe('4');
		expect(newCart('device-A', 'dine_in', '\u0000\u001b', NOW).tableLabel).toBeNull();
		expect(newCart('device-A', 'delivery', '4', NOW).tableLabel).toBeNull();
		const cart = doneWhenCart();
		expect(setOrderType(cart, 'dine_in', 'Win\u007fdow').tableLabel).toBe('Window');
	});

	// menu-and-printing T-22: the kitchen note.
	it('setNote cleans control characters, collapses spaces and caps at 140', () => {
		const cart = doneWhenCart();
		expect(setNote(cart, 'no\u001bchilli').note).toBe('no chilli');
		expect(setNote(cart, '  extra   sauce  ').note).toBe('extra sauce');
		expect(setNote(cart, '\u0000\u007f').note).toBeNull();
		expect(setNote(cart, '').note).toBeNull();
		expect(setNote(cart, 'x'.repeat(140)).note).toHaveLength(140);
		expect(() => setNote(cart, 'x'.repeat(141))).toThrow(/140/);
		expect(setNote(cart, 'no onions').lines).toBe(cart.lines);
	});

	it('two taps are two lines; quantity is absolute; removal renumbers', () => {
		let cart = newCart('device-A', 'dine_in', null, NOW);
		cart = addLine(cart, tea33, VAT);
		cart = addLine(cart, tea33, VAT);
		expect(cart.lines.map((l) => l.lineNo)).toEqual([1, 2]);

		cart = doneWhenCart();
		const teaLineId = cart.lines[0].lineId;
		cart = changeQuantity(cart, teaLineId, 3);
		expect(cart.lines[0].quantity).toBe(3);
		expect(lineAmounts(cart)).toEqual([2550n, 1050n]);
		expect(() => changeQuantity(cart, teaLineId, 0)).toThrow();

		cart = addLine(cart, tea33, VAT);
		cart = removeLine(cart, cart.lines[0].lineId);
		expect(cart.lines.map((l) => l.lineNo)).toEqual([1, 2]);
	});

	it('setOrderType trims, drops the table for takeaway, and leaves lines alone', () => {
		const cart = doneWhenCart();
		const seated = setOrderType(cart, 'dine_in', ' 12 ');
		expect(seated.orderType).toBe('dine_in');
		expect(seated.tableLabel).toBe('12');
		expect(seated.orderId).toBe(cart.orderId);
		expect(seated.lines.map((l) => l.lineId)).toEqual(cart.lines.map((l) => l.lineId));
		expect(setOrderType(cart, 'dine_in', '').tableLabel).toBeNull();
		expect(setOrderType(cart, 'takeaway', '12').tableLabel).toBeNull();
		expect(() => setOrderType(cart, 'dine_in', 'x'.repeat(33))).toThrow();
	});
});
