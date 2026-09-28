import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { withDb, type QueueEntry } from './store';
import {
	adoptServerSession,
	closeLocalSession,
	markSessionClosed,
	markSessionOpened,
	openLocalSession,
	readLocalSession,
	readSessionRow
} from './session';

const NOW = new Date('2026-09-28T08:00:00.000Z');

function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase('matcami-pos');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

async function readQueue(): Promise<QueueEntry[]> {
	return withDb(async (db) => {
		return new Promise<QueueEntry[]>((resolve, reject) => {
			const request = db.transaction('sync_queue').objectStore('sync_queue').getAll();
			request.onsuccess = () => resolve(request.result as QueueEntry[]);
			request.onerror = () => reject(request.error);
		});
	});
}

beforeEach(async () => {
	await deleteDatabase();
});

describe('the local session lifecycle', () => {
	it('open → markOpened → close → markClosed writes the right states and queues two ops', async () => {
		const open = await openLocalSession({
			deviceId: 'device-A',
			employeeId: 'emp-1',
			openingCashMinor: 50000n,
			now: NOW
		});
		let row = await readLocalSession('device-A');
		expect(row?.state).toBe('opening');
		expect(row?.openingCashMinor).toBe('50000');

		let queue = await readQueue();
		expect(queue).toHaveLength(1);
		expect(queue[0].kind).toBe('session.open');
		expect((queue[0].envelope.payload as { openingCashMinor: string }).openingCashMinor).toBe(
			'50000'
		);

		await expect(
			openLocalSession({
				deviceId: 'device-A',
				employeeId: 'emp-1',
				openingCashMinor: 50000n,
				now: NOW
			})
		).rejects.toThrow('session_already_open');

		const previous = await markSessionOpened('device-A', {
			posSessionId: 'srv-1',
			businessDate: '2026-09-28'
		});
		expect(previous.previousPosSessionId).toBe(open.posSessionId);
		row = await readLocalSession('device-A');
		expect(row?.state).toBe('open');
		expect(row?.posSessionId).toBe('srv-1');
		expect(row?.businessDate).toBe('2026-09-28');

		await closeLocalSession({
			deviceId: 'device-A',
			employeeId: 'emp-1',
			countedCashMinor: 123450n,
			now: NOW
		});
		queue = await readQueue();
		const close = queue.find((q) => q.kind === 'session.close');
		expect(close?.seq).toBe(2);
		expect((close?.envelope.payload as { countedCashMinor: string }).countedCashMinor).toBe(
			'123450'
		);

		await markSessionClosed(
			'device-A',
			{ expectedCashMinor: '123000', differenceMinor: '450' },
			NOW
		);
		expect(await readLocalSession('device-A')).toBeNull();
		const closed = await readSessionRow('device-A');
		expect(closed?.state).toBe('closed');
		expect(closed?.expectedCashMinor).toBe('123000');
		expect(closed?.differenceMinor).toBe('450');
	});
});

describe('adoptServerSession', () => {
	it('adopts a server-open session onto a closed local row', async () => {
		await openLocalSession({
			deviceId: 'device-A',
			employeeId: 'emp-1',
			openingCashMinor: 50000n,
			now: NOW
		});
		await markSessionOpened('device-A', { posSessionId: 'srv-1', businessDate: '2026-09-28' });
		await closeLocalSession({
			deviceId: 'device-A',
			employeeId: 'emp-1',
			countedCashMinor: 50000n,
			now: NOW
		});
		await markSessionClosed('device-A', { expectedCashMinor: '50000', differenceMinor: '0' }, NOW);
		expect((await readSessionRow('device-A'))?.state).toBe('closed');
		const outcome = await adoptServerSession('device-A', {
			posSessionId: 'srv-9',
			employeeId: 'emp-2',
			openingCashMinor: '60000',
			openedAt: '2026-09-29T08:00:00.000Z',
			businessDate: '2026-09-29'
		});
		expect(outcome).toBe('adopted');
		const live = await readLocalSession('device-A');
		expect(live?.state).toBe('open');
		expect(live?.posSessionId).toBe('srv-9');
		expect(live?.employeeId).toBe('emp-2');
		expect(live?.businessDate).toBe('2026-09-29');
	});

	it('null with an empty queue closes an open row; with a pending entry it does not', async () => {
		await openLocalSession({
			deviceId: 'device-A',
			employeeId: 'emp-1',
			openingCashMinor: 50000n,
			now: NOW
		});
		await markSessionOpened('device-A', { posSessionId: 'srv-1', businessDate: '2026-09-28' });
		// With the session.open still 'pending' in the queue, null → unchanged.
		const unchanged = await adoptServerSession('device-A', null);
		expect(unchanged).toBe('unchanged');
		// Mark that queue entry done, then null closes it.
		await withDb(async (db) => {
			return new Promise<void>((resolve, reject) => {
				const tx = db.transaction('sync_queue', 'readwrite');
				const request = tx.objectStore('sync_queue').getAll();
				request.onsuccess = () => {
					for (const row of request.result as QueueEntry[]) {
						tx.objectStore('sync_queue').put({ ...row, state: 'done' });
					}
				};
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		});
		const closed = await adoptServerSession('device-A', null);
		expect(closed).toBe('closed');
		expect(await readLocalSession('device-A')).toBeNull();
	});
});
