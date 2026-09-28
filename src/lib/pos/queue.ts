// T-25 adds the flush below. `enqueue` is written by T-24 and is not
// rewritten. It runs INSIDE the caller's readwrite transaction (which must
// include 'sync_queue'); a retry of the same clientOpId is a NO-OP that keeps
// the first attempt's envelope.

import { valueOf, type QueueEntry } from './store';

export async function enqueue(
	tx: IDBTransaction,
	entry: QueueEntry
): Promise<'added' | 'duplicate'> {
	const store = tx.objectStore('sync_queue');
	const existing = await valueOf(store.getKey(entry.clientOpId));
	if (existing !== undefined) return 'duplicate';
	return new Promise<'added'>((resolve, reject) => {
		const request = store.add(entry);
		request.onsuccess = () => resolve('added');
		request.onerror = () => reject(request.error);
	});
}
