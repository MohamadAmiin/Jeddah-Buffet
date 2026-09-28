// The per-device invoice sequence + a tablet-wide queue sequence.
//
// Invariant 5: invoice numbers come from the device's gap-free sequence,
// online or offline. The server never renumbers and there is no global
// sequence. The counter is keyed by the pos_devices UUID, not by the display
// prefix POS1 (a code that repeats in every restaurant).
//
// takeNextInvoice and takeNextQueueSeq run INSIDE the caller's readwrite
// transaction. The one place a number is taken is inside the transaction
// that also writes the sale and its queue entry (T-24's completeSale), so a
// number can never be taken without a sale to record it — spec 6 gap-free.

import { formatInvoiceNumber } from '../sync-ops';
import { valueOf, withDb, type SequenceRow } from './store';

export function takeNextInvoice(
	tx: IDBTransaction,
	deviceId: string,
	deviceCode: string
): Promise<{ seq: number; number: string }> {
	return new Promise((resolve, reject) => {
		const getRequest = tx.objectStore('invoice_sequence').get(deviceId);
		getRequest.onsuccess = () => {
			const row = (getRequest.result as SequenceRow | undefined) ?? {
				deviceId,
				invoiceSeq: 0,
				queueSeq: 0
			};
			const next = row.invoiceSeq + 1;
			let number: string;
			try {
				number = formatInvoiceNumber(deviceCode, next);
			} catch (error) {
				// Format BEFORE put: a number that cannot be formatted (seq > 999999,
				// bad code) rejects with nothing written to the counter.
				reject(error);
				return;
			}
			const putRequest = tx.objectStore('invoice_sequence').put({ ...row, invoiceSeq: next });
			putRequest.onsuccess = () => resolve({ seq: next, number });
			putRequest.onerror = () => reject(putRequest.error);
		};
		getRequest.onerror = () => reject(getRequest.error);
	});
}

export function takeNextQueueSeq(tx: IDBTransaction, deviceId: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const allRequest = tx.objectStore('invoice_sequence').getAll();
		allRequest.onsuccess = () => {
			const rows = (allRequest.result as SequenceRow[]) ?? [];
			const highest = rows.reduce((m, r) => (r.queueSeq > m ? r.queueSeq : m), 0);
			const next = highest + 1;
			const row = rows.find((r) => r.deviceId === deviceId) ?? {
				deviceId,
				invoiceSeq: 0,
				queueSeq: 0
			};
			const putRequest = tx.objectStore('invoice_sequence').put({ ...row, queueSeq: next });
			putRequest.onsuccess = () => resolve(next);
			putRequest.onerror = () => reject(putRequest.error);
		};
		allRequest.onerror = () => reject(allRequest.error);
	});
}

export async function adoptServerHint(deviceId: string, lastInvoiceSeq: number): Promise<number> {
	if (!Number.isSafeInteger(lastInvoiceSeq) || lastInvoiceSeq < 0) {
		throw new TypeError('lastInvoiceSeq must be a non-negative safe integer');
	}
	return withDb(
		(db) =>
			new Promise<number>((resolve, reject) => {
				const tx = db.transaction(['invoice_sequence', 'sync_queue'], 'readwrite');
				let result = 0;
				let row: SequenceRow = { deviceId, invoiceSeq: 0, queueSeq: 0 };
				let highestQueued = 0;

				const rowRequest = tx.objectStore('invoice_sequence').get(deviceId);
				rowRequest.onsuccess = () => {
					row = (rowRequest.result as SequenceRow | undefined) ?? row;
				};
				const queueRequest = tx.objectStore('sync_queue').index('deviceId').getAll(deviceId);
				queueRequest.onsuccess = () => {
					const entries = queueRequest.result as Array<{
						envelope?: {
							kind?: string;
							payload?: { invoiceSeq?: unknown };
						};
					}>;
					for (const entry of entries) {
						const kind = entry.envelope?.kind;
						if (kind !== 'sale.complete' && kind !== 'sale.abandoned') continue;
						const seq = entry.envelope?.payload?.invoiceSeq;
						if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > highestQueued) {
							highestQueued = seq;
						}
					}
					result = Math.max(row.invoiceSeq, lastInvoiceSeq, highestQueued);
					if (result > row.invoiceSeq) {
						tx.objectStore('invoice_sequence').put({ ...row, invoiceSeq: result });
					}
				};
				tx.oncomplete = () => resolve(result);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
			})
	);
}

export function readSequence(deviceId: string): Promise<SequenceRow> {
	return withDb(async (db) => {
		const tx = db.transaction('invoice_sequence', 'readonly');
		const request = tx.objectStore('invoice_sequence').get(deviceId);
		const row = (await valueOf(request)) as SequenceRow | undefined;
		return row ?? { deviceId, invoiceSeq: 0, queueSeq: 0 };
	});
}
