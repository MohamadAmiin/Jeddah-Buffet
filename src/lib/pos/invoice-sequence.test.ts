import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openPosDb, withDb, inTransaction, type QueueEntry } from './store';
import {
	adoptServerHint,
	readSequence,
	takeNextInvoice,
	takeNextQueueSeq
} from './invoice-sequence';

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

async function inTx<T>(stores: string[], work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
	const db = await openPosDb();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(stores, 'readwrite');
			let result: T;
			work(tx)
				.then((v) => {
					result = v;
				})
				.catch(reject);
			tx.oncomplete = () => resolve(result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error ?? new Error('aborted'));
		});
	} finally {
		db.close();
	}
}

describe('takeNextInvoice', () => {
	it('increments by one and formats POS1-000001, 000002, 000003', async () => {
		const a = await inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-A', 'POS1'));
		const b = await inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-A', 'POS1'));
		const c = await inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-A', 'POS1'));
		expect(a).toEqual({ seq: 1, number: 'POS1-000001' });
		expect(b).toEqual({ seq: 2, number: 'POS1-000002' });
		expect(c).toEqual({ seq: 3, number: 'POS1-000003' });
		expect(await readSequence('device-A')).toEqual({
			deviceId: 'device-A',
			invoiceSeq: 3,
			queueSeq: 0
		});
	});

	it('an aborted transaction leaves the counter where it was', async () => {
		// Take one number then abort.
		await expect(
			(async () => {
				const db = await openPosDb();
				try {
					await new Promise<void>((resolve, reject) => {
						const tx = db.transaction('invoice_sequence', 'readwrite');
						takeNextInvoice(tx, 'device-A', 'POS1')
							.then(() => tx.abort())
							.catch(reject);
						tx.oncomplete = () => resolve();
						tx.onabort = () => reject(tx.error ?? new Error('aborted'));
						tx.onerror = () => reject(tx.error);
					});
				} finally {
					db.close();
				}
			})()
		).rejects.toThrow();
		expect((await readSequence('device-A')).invoiceSeq).toBe(0);
		const next = await inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-A', 'POS1'));
		expect(next).toEqual({ seq: 1, number: 'POS1-000001' });
	});
});

describe('takeNextQueueSeq', () => {
	it('is tablet-wide across devices', async () => {
		const one = await inTx(['invoice_sequence'], (tx) => takeNextQueueSeq(tx, 'device-A'));
		const two = await inTx(['invoice_sequence'], (tx) => takeNextQueueSeq(tx, 'device-A'));
		const three = await inTx(['invoice_sequence'], (tx) => takeNextQueueSeq(tx, 'device-B'));
		expect([one, two, three]).toEqual([1, 2, 3]);
		expect((await readSequence('device-A')).queueSeq).toBe(2);
		expect((await readSequence('device-B')).queueSeq).toBe(3);
	});
});

describe('adoptServerHint', () => {
	it('a lower hint never rewinds the counter', async () => {
		await withDb((db) =>
			inTransaction(db, ['invoice_sequence'], 'readwrite', (tx) => {
				tx.objectStore('invoice_sequence').put({
					deviceId: 'device-A',
					invoiceSeq: 7,
					queueSeq: 0
				});
			})
		);
		const result = await adoptServerHint('device-A', 5);
		expect(result).toBe(7);
		expect((await readSequence('device-A')).invoiceSeq).toBe(7);
	});

	it('a queued higher invoiceSeq wins over the hint', async () => {
		await withDb((db) =>
			inTransaction(db, ['invoice_sequence', 'sync_queue'], 'readwrite', (tx) => {
				tx.objectStore('invoice_sequence').put({
					deviceId: 'device-A',
					invoiceSeq: 7,
					queueSeq: 0
				});
				tx.objectStore('sync_queue').put({
					clientOpId: 'op-x',
					deviceId: 'device-A',
					seq: 1,
					kind: 'sale.complete',
					envelope: { kind: 'sale.complete', payload: { invoiceSeq: 10 } },
					state: 'pending',
					attempts: 0
				} as unknown as QueueEntry);
			})
		);
		expect(await adoptServerHint('device-A', 9)).toBe(10);
		const next = await inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-A', 'POS1'));
		expect(next).toEqual({ seq: 11, number: 'POS1-000011' });
	});

	it('a fresh device with a hint jumps forward', async () => {
		expect(await adoptServerHint('device-C', 41)).toBe(41);
		const next = await inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-C', 'POS1'));
		expect(next).toEqual({ seq: 42, number: 'POS1-000042' });
	});

	it('a counter at 999999 refuses the next take without moving', async () => {
		await withDb((db) =>
			inTransaction(db, ['invoice_sequence'], 'readwrite', (tx) => {
				tx.objectStore('invoice_sequence').put({
					deviceId: 'device-A',
					invoiceSeq: 999_999,
					queueSeq: 0
				});
			})
		);
		await expect(
			inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-A', 'POS1'))
		).rejects.toThrow(RangeError);
		expect((await readSequence('device-A')).invoiceSeq).toBe(999_999);
	});

	it('a bad device code rejects and never moves the counter', async () => {
		await expect(
			inTx(['invoice_sequence'], (tx) => takeNextInvoice(tx, 'device-A', 'pos1'))
		).rejects.toThrow(RangeError);
		expect((await readSequence('device-A')).invoiceSeq).toBe(0);
	});

	it('refuses a negative or non-integer hint', async () => {
		await expect(adoptServerHint('device-A', -1)).rejects.toThrow(TypeError);
		await expect(adoptServerHint('device-A', 1.5)).rejects.toThrow(TypeError);
	});
});
