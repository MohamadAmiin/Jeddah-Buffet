// The till's LocalSession lifecycle. Every state transition happens inside
// one IndexedDB transaction that also enqueues the corresponding op (spec
// 10; R6). openLocalSession, markSessionOpened, closeLocalSession,
// markSessionClosed, readLocalSession, readSessionRow, adoptServerSession.

import { withDb, valueOf, signalUnsyncedChange, type LocalSession } from './store';
import { takeNextQueueSeq } from './invoice-sequence';
import { enqueue } from './queue';
import type { OpEnvelope, SessionClosePayload, SessionOpenPayload } from '../sync-ops';

function secureId(): string {
	if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
		throw new Error('This device cannot open a shift securely.');
	}
	return crypto.randomUUID();
}

export async function openLocalSession(args: {
	deviceId: string;
	employeeId: string;
	openingCashMinor: bigint;
	now: Date;
}): Promise<{ posSessionId: string; clientOpId: string }> {
	if (args.openingCashMinor < 0n) throw new Error('openingCashMinor cannot be negative');
	const posSessionId = secureId();
	const clientOpId = secureId();
	const occurredAt = args.now.toISOString();

	await withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction(['session', 'sync_queue', 'invoice_sequence'], 'readwrite');
				(async () => {
					try {
						const row = (await valueOf(tx.objectStore('session').get(args.deviceId))) as
							LocalSession | undefined;
						if (row && row.state !== 'closed') {
							throw new Error('session_already_open');
						}
						const record: LocalSession = {
							deviceId: args.deviceId,
							posSessionId,
							employeeId: args.employeeId,
							openingCashMinor: args.openingCashMinor.toString(),
							openedAt: occurredAt,
							state: 'opening'
						};
						tx.objectStore('session').put(record);
						const seq = await takeNextQueueSeq(tx, args.deviceId);
						const envelope: OpEnvelope<'session.open', SessionOpenPayload> = {
							kind: 'session.open',
							clientOpId,
							deviceId: args.deviceId,
							employeeId: args.employeeId,
							occurredAt,
							seq,
							payload: {
								posSessionId,
								openingCashMinor: args.openingCashMinor.toString()
							}
						};
						await enqueue(tx, {
							clientOpId,
							deviceId: args.deviceId,
							seq,
							kind: 'session.open',
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
	return { posSessionId, clientOpId };
}

export async function markSessionOpened(
	deviceId: string,
	result: { posSessionId: string; businessDate: string | null }
): Promise<{ previousPosSessionId: string }> {
	return withDb(
		(db) =>
			new Promise<{ previousPosSessionId: string }>((resolve, reject) => {
				const tx = db.transaction('session', 'readwrite');
				let previous = '';
				(async () => {
					try {
						const row = (await valueOf(tx.objectStore('session').get(deviceId))) as
							LocalSession | undefined;
						if (!row) throw new Error('no local session');
						previous = row.posSessionId;
						tx.objectStore('session').put({
							...row,
							state: 'open',
							posSessionId: result.posSessionId,
							businessDate: result.businessDate ?? row.businessDate,
							lastError: undefined
						});
					} catch (thrown) {
						tx.abort();
						reject(thrown);
					}
				})();
				tx.oncomplete = () => resolve({ previousPosSessionId: previous });
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('aborted'));
			})
	);
}

export async function closeLocalSession(args: {
	deviceId: string;
	employeeId: string;
	countedCashMinor: bigint;
	now: Date;
}): Promise<{ clientOpId: string }> {
	if (args.countedCashMinor < 0n) throw new Error('countedCashMinor cannot be negative');
	const clientOpId = secureId();
	const occurredAt = args.now.toISOString();
	await withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction(['session', 'sync_queue', 'invoice_sequence'], 'readwrite');
				(async () => {
					try {
						const row = (await valueOf(tx.objectStore('session').get(args.deviceId))) as
							LocalSession | undefined;
						if (!row || row.state !== 'open') throw new Error('no_open_session');
						tx.objectStore('session').put({
							...row,
							state: 'closing',
							countedCashMinor: args.countedCashMinor.toString()
						});
						const seq = await takeNextQueueSeq(tx, args.deviceId);
						const envelope: OpEnvelope<'session.close', SessionClosePayload> = {
							kind: 'session.close',
							clientOpId,
							deviceId: args.deviceId,
							employeeId: args.employeeId,
							occurredAt,
							seq,
							payload: {
								posSessionId: row.posSessionId,
								countedCashMinor: args.countedCashMinor.toString()
							}
						};
						await enqueue(tx, {
							clientOpId,
							deviceId: args.deviceId,
							seq,
							kind: 'session.close',
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

export async function markSessionClosed(
	deviceId: string,
	result: { expectedCashMinor: string | null; differenceMinor: string | null },
	now = new Date()
): Promise<void> {
	await withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction('session', 'readwrite');
				(async () => {
					try {
						const row = (await valueOf(tx.objectStore('session').get(deviceId))) as
							LocalSession | undefined;
						if (!row) throw new Error('no local session');
						tx.objectStore('session').put({
							...row,
							state: 'closed',
							closedAt: now.toISOString(),
							expectedCashMinor: result.expectedCashMinor ?? undefined,
							differenceMinor: result.differenceMinor ?? undefined,
							lastError: undefined
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
}

export function readLocalSession(deviceId: string): Promise<LocalSession | null> {
	return withDb(async (db) => {
		const row = (await valueOf(db.transaction('session').objectStore('session').get(deviceId))) as
			LocalSession | undefined;
		if (!row) return null;
		if (row.state === 'closed') return null;
		return row;
	});
}

export function readSessionRow(deviceId: string): Promise<LocalSession | null> {
	return withDb(async (db) => {
		const row = (await valueOf(db.transaction('session').objectStore('session').get(deviceId))) as
			LocalSession | undefined;
		return row ?? null;
	});
}

export async function adoptServerSession(
	deviceId: string,
	serverOpen: {
		posSessionId: string;
		employeeId: string;
		openingCashMinor: string;
		openedAt: string;
		businessDate: string | null;
	} | null
): Promise<'adopted' | 'closed' | 'unchanged'> {
	return withDb(
		(db) =>
			new Promise<'adopted' | 'closed' | 'unchanged'>((resolve, reject) => {
				const tx = db.transaction(['session', 'sync_queue'], 'readwrite');
				let outcome: 'adopted' | 'closed' | 'unchanged' = 'unchanged';
				(async () => {
					try {
						const row = (await valueOf(tx.objectStore('session').get(deviceId))) as
							LocalSession | undefined;
						if (serverOpen) {
							const local = row ?? null;
							if (
								local === null ||
								local.state === 'closed' ||
								(local.state === 'open' && local.posSessionId !== serverOpen.posSessionId)
							) {
								tx.objectStore('session').put({
									deviceId,
									posSessionId: serverOpen.posSessionId,
									employeeId: serverOpen.employeeId,
									openingCashMinor: serverOpen.openingCashMinor,
									openedAt: serverOpen.openedAt,
									businessDate: serverOpen.businessDate ?? undefined,
									state: 'open'
								});
								outcome = 'adopted';
							} else if (local.state === 'opening' || local.state === 'closing') {
								outcome = 'unchanged';
							} else {
								outcome = 'unchanged';
							}
						} else {
							if (!row || row.state !== 'open') {
								outcome = 'unchanged';
								return;
							}
							const queueRows = (await valueOf(
								tx.objectStore('sync_queue').index('deviceId').getAll(deviceId)
							)) as Array<{ state?: string }>;
							const hasInFlight = queueRows.some(
								(q) => q.state === 'pending' || q.state === 'sending'
							);
							if (hasInFlight) {
								outcome = 'unchanged';
								return;
							}
							tx.objectStore('session').put({ ...row, state: 'closed' });
							outcome = 'closed';
						}
					} catch (thrown) {
						tx.abort();
						reject(thrown);
					}
				})();
				tx.oncomplete = () => resolve(outcome);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('aborted'));
			})
	);
}
