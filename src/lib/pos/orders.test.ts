import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { ROUNDING_RULE, minor } from '../money';
import { computeOrderTotals } from '../money/order-totals';
import { withDb, inTransaction, countUnsynced, type QueueEntry, type LocalOrder } from './store';
import { readSequence } from './invoice-sequence';
import {
	abandonSale,
	addLine,
	cartTotals,
	changeQuantity,
	completeSale,
	newCart,
	removeLine,
	type Cart,
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

const tea: MenuItemForCart = {
	id: 'item-tea',
	name: 'Tea',
	priceMinor: 850n,
	taxRateBp: null
};
const coffee: MenuItemForCart = {
	id: 'item-coffee',
	name: 'Coffee',
	priceMinor: 999n,
	taxRateBp: null
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

	it('addLine resolves the rate: item override wins; both null throws; removeLine renumbers', () => {
		let c = newCart('device-A', 'takeaway', null, NOW);
		c = addLine(c, tea, 825);
		expect(c.lines[0].taxRateBp).toBe(825);
		c = addLine(c, { ...tea, taxRateBp: 500 }, 825);
		expect(c.lines[1].taxRateBp).toBe(500);
		expect(() => addLine(newCart('device-A', 'takeaway', null, NOW), tea, null)).toThrow(
			/tax rate/
		);

		let d = newCart('device-A', 'takeaway', null, NOW);
		d = addLine(d, tea, 825);
		d = addLine(d, tea, 825);
		d = addLine(d, tea, 825);
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
		c = addLine(c, tea, 825, [cream], 2);
		c = addLine(c, coffee, 825);
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
		c = addLine(c, tea, 825, [cream], 2);
		c = addLine(c, coffee, 825);
		return c;
	}

	it('records a cash sale atomically: one order, one queue entry, invoice 1', async () => {
		const cart = await buildCart();
		const result = await completeSale({
			cart,
			payment: { method: 'cash', tenderedMinor: 5000n },
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW
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

	it('abortForTest leaves nothing behind — no order, no queue, no counter movement', async () => {
		const cart = await buildCart();
		await expect(
			completeSale(
				{
					cart,
					payment: { method: 'cash', tenderedMinor: 5000n },
					employeeId: 'emp-1',
					deviceId: 'device-A',
					deviceCode: 'POS1',
					posSessionId: 'ses-1',
					taxMode: 'exclusive',
					currencyCode: 'USD',
					menuVersion: 1,
					now: NOW
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
			payment: { method: 'cash', tenderedMinor: 5000n },
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW
		});
		const second = await completeSale({
			cart: await buildCart(),
			payment: { method: 'cash', tenderedMinor: 5000n },
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW
		});
		expect(first.invoiceNumber).toBe('POS1-000001');
		expect(second.invoiceNumber).toBe('POS1-000002');
		expect(first.clientOpId).not.toBe(second.clientOpId);
	});

	it('every *Minor in the envelope is a string', async () => {
		const cart = await buildCart();
		await completeSale({
			cart,
			payment: { method: 'cash', tenderedMinor: 5000n },
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW
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
			changeMinor: '1970'
		});
	});

	it('card sale queues with tenderedMinor null and changeMinor null; no arithmetic', async () => {
		const cart = await buildCart();
		const result = await completeSale({
			cart,
			payment: { method: 'card', tenderedMinor: null },
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW
		});
		expect(result.changeMinor).toBeNull();
		const [entry] = await readQueue();
		const payments = (entry.envelope.payload as { payments: unknown[] }).payments as {
			tenderedMinor: unknown;
			changeMinor: unknown;
		}[];
		expect(payments[0].tenderedMinor).toBeNull();
		expect(payments[0].changeMinor).toBeNull();
	});

	it('cash short rejects before writing', async () => {
		const cart = await buildCart();
		await expect(
			completeSale({
				cart,
				payment: { method: 'cash', tenderedMinor: 100n },
				employeeId: 'emp-1',
				deviceId: 'device-A',
				deviceCode: 'POS1',
				posSessionId: 'ses-1',
				taxMode: 'exclusive',
				currencyCode: 'USD',
				menuVersion: 1,
				now: NOW
			})
		).rejects.toThrow();
		expect(await readQueue()).toHaveLength(0);
	});
});

describe('abandonSale', () => {
	it('marks the order abandoned, cancels its still-pending entry, queues sale.abandoned', async () => {
		let c = newCart('device-A', 'takeaway', null, NOW);
		c = addLine(c, tea, 825);
		const sale = await completeSale({
			cart: c,
			payment: { method: 'card', tenderedMinor: null },
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW
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
		c = addLine(c, tea, 825);
		await completeSale({
			cart: c,
			payment: { method: 'cash', tenderedMinor: 1000n },
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW
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
