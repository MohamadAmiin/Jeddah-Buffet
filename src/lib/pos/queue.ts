// T-25 adds the flush below. `enqueue` is written by T-24 and is not
// rewritten. It runs INSIDE the caller's readwrite transaction (which must
// include 'sync_queue'); a retry of the same clientOpId is a NO-OP that keeps
// the first attempt's envelope.

import {
	countParked as countParkedFromStore,
	forgetDevice,
	inTransaction,
	markOfflineLoginParked,
	markOfflineLoginSynced,
	pruneCompletedOrders,
	signalUnsyncedChange,
	valueOf,
	withDb,
	type LocalOrder,
	type OfflineLogin,
	type QueueEntry
} from './store';
import type { OpEnvelope, OpKind, SyncResult } from '../sync-ops';
import { markSessionClosed, markSessionOpened } from './session';
import { abandonSale, type Cart } from './orders';

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

export type FlushOptions = {
	now?: () => number;
	schedule?: (delayMs: number, run: () => void) => () => void;
};

export type FlushSummary = {
	sent: number;
	outcome: 'drained' | 'offline' | 'network' | 'stopped';
};

export type FlushEvent =
	| {
			type: 'done';
			clientOpId: string;
			kind: OpKind;
			status: SyncResult['status'];
			body: SyncResult;
	  }
	| {
			type: 'rejected';
			clientOpId: string;
			kind: OpKind;
			http: 403 | 422;
			error: string;
			flag?: string;
	  }
	| { type: 'parked'; clientOpId: string; kind: OpKind; error: string }
	| {
			type: 'stopped';
			reason: 'network' | 'not_permitted' | 'session_has_unrecorded_ops';
			clientOpId?: string;
			count?: number;
			retryInMs?: number;
	  }
	| { type: 'revoked' }
	| { type: 'skew'; skewMs: number };

export class DeviceRevoked extends Error {
	constructor() {
		super('device revoked');
	}
}

let running: Promise<FlushSummary> | null = null;
let consecutiveNetworkFailures = 0;
let lastSkew: number | null = null;
let scheduledRetry: (() => void) | null = null;
const events = new EventTarget();

export function onFlushEvent(listener: (event: FlushEvent) => void): () => void {
	const handler = (e: Event) => listener((e as CustomEvent<FlushEvent>).detail);
	events.addEventListener('flush', handler);
	return () => events.removeEventListener('flush', handler);
}

export const onFlushResult = onFlushEvent;

export function parkedCount(): Promise<number> {
	return countParkedFromStore();
}

export function lastSkewMs(): number | null {
	return lastSkew;
}

export function onSkew(listener: (skewMs: number) => void): () => void {
	return onFlushEvent((event) => {
		if (event.type === 'skew') listener(event.skewMs);
	});
}

function emit(event: FlushEvent): void {
	events.dispatchEvent(new CustomEvent('flush', { detail: event }));
}

type ParsedResponse = {
	status: number;
	body: unknown;
	dateHeader: string | null;
};

async function post(
	fetchFn: typeof fetch,
	envelope: OpEnvelope<OpKind, unknown>
): Promise<ParsedResponse> {
	const response = await fetchFn('/api/pos/sync', {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(envelope)
	});
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	return {
		status: response.status,
		body,
		dateHeader: response.headers.get('date')
	};
}

function isDeviceRevoked403(parsed: ParsedResponse): boolean {
	if (parsed.status !== 403) return false;
	const body = parsed.body as { error?: unknown } | null;
	if (!body) return true;
	if (typeof body.error !== 'string') return true;
	return body.error !== 'not_permitted';
}

async function resurrectSendingEntries(): Promise<void> {
	await withDb((db) =>
		inTransaction(db, ['sync_queue'], 'readwrite', (tx) => {
			const store = tx.objectStore('sync_queue');
			const request = store.getAll();
			request.onsuccess = () => {
				const rows = request.result as QueueEntry[];
				for (const row of rows) {
					if (row.state === 'sending') {
						store.put({ ...row, state: 'pending' });
					}
				}
			};
		})
	);
}

async function readNextPending(): Promise<QueueEntry | null> {
	return withDb(async (db) => {
		const rows = (await valueOf(
			db.transaction('sync_queue').objectStore('sync_queue').getAll()
		)) as QueueEntry[];
		const pending = rows.filter((r) => r.state === 'pending').sort((a, b) => a.seq - b.seq);
		return pending[0] ?? null;
	});
}

async function markEntry(
	clientOpId: string,
	update: (row: QueueEntry) => QueueEntry
): Promise<void> {
	await withDb((db) =>
		inTransaction(db, ['sync_queue'], 'readwrite', (tx) => {
			const store = tx.objectStore('sync_queue');
			const request = store.get(clientOpId);
			request.onsuccess = () => {
				const row = request.result as QueueEntry | undefined;
				if (row) store.put(update(row));
			};
		})
	);
}

async function markOrderSynced(
	orderId: string,
	syncStatus: 'accepted' | 'recorded_flagged' | 'unrecorded' | 'rejected' | 'replayed',
	syncedAt: string
): Promise<void> {
	await withDb((db) =>
		inTransaction(db, ['orders'], 'readwrite', (tx) => {
			const store = tx.objectStore('orders');
			const request = store.get(orderId);
			request.onsuccess = () => {
				const row = request.result as LocalOrder<Cart> | undefined;
				if (!row) return;
				let cleaned: LocalOrder<Cart>['syncStatus'];
				if (syncStatus === 'replayed') {
					cleaned = row.syncStatus ?? 'accepted';
				} else {
					cleaned = syncStatus;
				}
				store.put({ ...row, syncedAt, syncStatus: cleaned });
			};
		})
	);
}

async function rewritePosSessionId(deviceId: string, oldId: string, newId: string): Promise<void> {
	if (oldId === newId) return;
	await withDb((db) =>
		inTransaction(db, ['sync_queue'], 'readwrite', (tx) => {
			const store = tx.objectStore('sync_queue');
			const request = store.index('deviceId').getAll(deviceId);
			request.onsuccess = () => {
				const rows = request.result as QueueEntry[];
				for (const row of rows) {
					if (row.state !== 'pending') continue;
					if (row.kind !== 'sale.complete' && row.kind !== 'session.close') continue;
					const payload = row.envelope.payload as { posSessionId?: unknown } | null;
					if (payload && payload.posSessionId === oldId) {
						const nextPayload = { ...(payload as object), posSessionId: newId };
						const nextEnvelope = { ...row.envelope, payload: nextPayload };
						store.put({ ...row, envelope: nextEnvelope as QueueEntry['envelope'] });
					}
				}
			};
		})
	);
}

async function readOfflineLoginsToFlush(): Promise<OfflineLogin[]> {
	return withDb(async (db) => {
		const rows = (await valueOf(
			db.transaction('offline_logins').objectStore('offline_logins').getAll()
		)) as OfflineLogin[];
		return rows
			.filter((row) => row.synced === false && row.parked !== true)
			.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
	});
}

export function flush(
	fetchFn: typeof fetch = fetch,
	opts: FlushOptions = {}
): Promise<FlushSummary> {
	if (running) return running;
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		return Promise.resolve({ sent: 0, outcome: 'offline' } as const);
	}
	if (scheduledRetry) {
		scheduledRetry();
		scheduledRetry = null;
	}

	const now = opts.now ?? Date.now;
	const schedule =
		opts.schedule ??
		((delay: number, run: () => void) => {
			const id = setTimeout(run, delay);
			return () => clearTimeout(id);
		});

	const runPromise = (async (): Promise<FlushSummary> => {
		let sent = 0;
		try {
			await resurrectSendingEntries();

			// Step A — offline logins.
			const logins = await readOfflineLoginsToFlush();
			for (const login of logins) {
				const envelope: OpEnvelope<'pin.login', { outcome: 'success' | 'failed' }> = {
					kind: 'pin.login',
					clientOpId: login.clientOpId,
					deviceId: login.deviceId,
					employeeId: login.employeeId,
					occurredAt: login.occurredAt,
					seq: 0,
					payload: { outcome: login.outcome }
				};
				let parsed: ParsedResponse;
				try {
					parsed = await post(fetchFn, envelope);
				} catch {
					const delay = Math.min(60_000, 1_000 * 2 ** ++consecutiveNetworkFailures);
					scheduledRetry = schedule(delay, () => {
						void flush(fetchFn, opts).catch(() => {});
					});
					emit({
						type: 'stopped',
						reason: 'network',
						clientOpId: login.clientOpId,
						retryInMs: delay
					});
					return { sent, outcome: 'network' };
				}
				consecutiveNetworkFailures = 0;
				checkSkew(parsed, now);
				if (parsed.status === 200) {
					await markOfflineLoginSynced(login.clientOpId);
					signalUnsyncedChange();
					sent += 1;
					continue;
				}
				if (parsed.status === 409 || parsed.status === 400 || parsed.status === 415) {
					await markOfflineLoginParked(login.clientOpId);
					emit({
						type: 'parked',
						clientOpId: login.clientOpId,
						kind: 'pin.login',
						error: `HTTP ${parsed.status}`
					});
					signalUnsyncedChange();
					continue;
				}
				if (isDeviceRevoked403(parsed)) {
					await handleRevoked();
					throw new DeviceRevoked();
				}
				// 403 not_permitted or 422 aren't in-contract for pin.login → park.
				await markOfflineLoginParked(login.clientOpId);
				emit({
					type: 'parked',
					clientOpId: login.clientOpId,
					kind: 'pin.login',
					error: `HTTP ${parsed.status}`
				});
				signalUnsyncedChange();
			}

			// Step B — the queue.
			while (true) {
				const entry = await readNextPending();
				if (!entry) break;
				await markEntry(entry.clientOpId, (row) => ({ ...row, state: 'sending' }));
				let parsed: ParsedResponse;
				try {
					parsed = await post(fetchFn, entry.envelope);
				} catch {
					await markEntry(entry.clientOpId, (row) => ({
						...row,
						state: 'pending',
						attempts: row.attempts + 1,
						lastError: 'network'
					}));
					const delay = Math.min(60_000, 1_000 * 2 ** ++consecutiveNetworkFailures);
					scheduledRetry = schedule(delay, () => {
						void flush(fetchFn, opts).catch(() => {});
					});
					emit({
						type: 'stopped',
						reason: 'network',
						clientOpId: entry.clientOpId,
						retryInMs: delay
					});
					signalUnsyncedChange();
					return { sent, outcome: 'network' };
				}
				consecutiveNetworkFailures = 0;
				checkSkew(parsed, now);

				if (parsed.status === 200) {
					const body = (parsed.body ?? {}) as SyncResult;
					const status = (body.status ?? 'accepted') as SyncResult['status'];
					await markEntry(entry.clientOpId, (row) => ({
						...row,
						state: 'done',
						lastResult: body,
						lastError: undefined
					}));
					const syncedAt = new Date(now()).toISOString();
					if (entry.kind === 'sale.complete') {
						// The order row is marked synced BEFORE 'done' is announced, so a
						// listener that reads the order on the event — the auto-printer,
						// whose canPrint needs the card sale's syncStatus — sees it
						// (menu-and-printing T-30).
						const orderId = (entry.envelope.payload as { orderId?: string }).orderId;
						if (orderId) await markOrderSynced(orderId, status, syncedAt);
					}
					emit({ type: 'done', clientOpId: entry.clientOpId, kind: entry.kind, status, body });
					if (entry.kind === 'sale.abandoned') {
						// Do NOT overwrite the sale's syncStatus — the sale was already
						// marked 'rejected' by the 403/422 handler when we chose to abandon it;
						// only stamp syncedAt.
						const orderId = (entry.envelope.payload as { orderId?: string }).orderId;
						if (orderId) {
							await withDb((db) =>
								inTransaction(db, ['orders'], 'readwrite', (tx) => {
									const store = tx.objectStore('orders');
									const request = store.get(orderId);
									request.onsuccess = () => {
										const row = request.result as LocalOrder<Cart> | undefined;
										if (row) store.put({ ...row, syncedAt });
									};
								})
							);
						}
					} else if (entry.kind === 'session.open') {
						const posSessionId =
							(body.posSessionId as string | undefined) ??
							(entry.envelope.payload as { posSessionId: string }).posSessionId;
						const previous = await markSessionOpened(entry.envelope.deviceId, {
							posSessionId,
							businessDate: (body.businessDate as string | undefined) ?? null
						});
						if (previous.previousPosSessionId !== posSessionId) {
							await rewritePosSessionId(
								entry.envelope.deviceId,
								previous.previousPosSessionId,
								posSessionId
							);
						}
					} else if (entry.kind === 'session.close') {
						await markSessionClosed(entry.envelope.deviceId, {
							expectedCashMinor: (body.expectedCashMinor as string | undefined) ?? null,
							differenceMinor: (body.differenceMinor as string | undefined) ?? null
						});
					}
					signalUnsyncedChange();
					sent += 1;
					continue;
				}

				if (parsed.status === 403) {
					if (isDeviceRevoked403(parsed)) {
						await markEntry(entry.clientOpId, (row) => ({ ...row, state: 'pending' }));
						await handleRevoked();
						throw new DeviceRevoked();
					}
					// not_permitted.
					const kind = entry.kind;
					if (kind === 'sale.complete') {
						await markEntry(entry.clientOpId, (row) => ({
							...row,
							state: 'done',
							lastError: 'not_permitted'
						}));
						emit({
							type: 'rejected',
							clientOpId: entry.clientOpId,
							kind,
							http: 403,
							error: 'not_permitted'
						});
						const orderId = (entry.envelope.payload as { orderId?: string }).orderId;
						if (orderId) {
							await markOrderSynced(orderId, 'rejected', new Date(now()).toISOString());
							try {
								await abandonSale(orderId, 'rejected');
							} catch {
								/* order already abandoned */
							}
						}
						signalUnsyncedChange();
						sent += 1;
						continue;
					}
					if (kind === 'session.close') {
						await markEntry(entry.clientOpId, (row) => ({
							...row,
							state: 'pending',
							lastError: 'not_permitted'
						}));
						emit({
							type: 'rejected',
							clientOpId: entry.clientOpId,
							kind,
							http: 403,
							error: 'not_permitted'
						});
						emit({
							type: 'stopped',
							reason: 'not_permitted',
							clientOpId: entry.clientOpId
						});
						return { sent, outcome: 'stopped' };
					}
					await markEntry(entry.clientOpId, (row) => ({
						...row,
						state: 'parked',
						lastError: 'not_permitted'
					}));
					emit({ type: 'parked', clientOpId: entry.clientOpId, kind, error: 'not_permitted' });
					signalUnsyncedChange();
					continue;
				}

				if (parsed.status === 422) {
					const body = (parsed.body ?? {}) as { flag?: string };
					if (entry.kind === 'sale.complete') {
						await markEntry(entry.clientOpId, (row) => ({
							...row,
							state: 'done',
							lastError: `rejected:${body.flag ?? ''}`
						}));
						emit({
							type: 'rejected',
							clientOpId: entry.clientOpId,
							kind: entry.kind,
							http: 422,
							error: 'rejected',
							flag: body.flag
						});
						const orderId = (entry.envelope.payload as { orderId?: string }).orderId;
						if (orderId) {
							await markOrderSynced(orderId, 'rejected', new Date(now()).toISOString());
							try {
								await abandonSale(orderId, 'rejected');
							} catch {
								/* already abandoned */
							}
						}
						signalUnsyncedChange();
						sent += 1;
						continue;
					}
					await markEntry(entry.clientOpId, (row) => ({
						...row,
						state: 'parked',
						lastError: `rejected:${body.flag ?? ''}`
					}));
					emit({
						type: 'parked',
						clientOpId: entry.clientOpId,
						kind: entry.kind,
						error: `rejected:${body.flag ?? ''}`
					});
					signalUnsyncedChange();
					continue;
				}

				if (parsed.status === 409) {
					const body = (parsed.body ?? {}) as { error?: string; count?: number };
					if (body.error === 'foreign_device') {
						await markEntry(entry.clientOpId, (row) => ({
							...row,
							state: 'parked',
							lastError: 'foreign_device'
						}));
						emit({
							type: 'parked',
							clientOpId: entry.clientOpId,
							kind: entry.kind,
							error: 'foreign_device'
						});
						signalUnsyncedChange();
						continue;
					}
					if (body.error === 'session_has_unrecorded_ops') {
						const count = typeof body.count === 'number' ? body.count : 0;
						await markEntry(entry.clientOpId, (row) => ({
							...row,
							state: 'pending',
							lastError: `session_has_unrecorded_ops:${count}`
						}));
						emit({
							type: 'stopped',
							reason: 'session_has_unrecorded_ops',
							clientOpId: entry.clientOpId,
							count
						});
						signalUnsyncedChange();
						return { sent, outcome: 'stopped' };
					}
					await markEntry(entry.clientOpId, (row) => ({
						...row,
						state: 'parked',
						lastError: `HTTP 409 ${body.error ?? ''}`
					}));
					emit({
						type: 'parked',
						clientOpId: entry.clientOpId,
						kind: entry.kind,
						error: `HTTP 409 ${body.error ?? ''}`
					});
					signalUnsyncedChange();
					continue;
				}

				if (parsed.status === 400 || parsed.status === 415) {
					await markEntry(entry.clientOpId, (row) => ({
						...row,
						state: 'parked',
						lastError: 'invalid_request'
					}));
					emit({
						type: 'parked',
						clientOpId: entry.clientOpId,
						kind: entry.kind,
						error: 'invalid_request'
					});
					signalUnsyncedChange();
					continue;
				}

				// Network-class fallback (5xx, unknown status).
				await markEntry(entry.clientOpId, (row) => ({
					...row,
					state: 'pending',
					attempts: row.attempts + 1,
					lastError: `HTTP ${parsed.status}`
				}));
				const delay = Math.min(60_000, 1_000 * 2 ** ++consecutiveNetworkFailures);
				scheduledRetry = schedule(delay, () => {
					void flush(fetchFn, opts).catch(() => {});
				});
				emit({
					type: 'stopped',
					reason: 'network',
					clientOpId: entry.clientOpId,
					retryInMs: delay
				});
				signalUnsyncedChange();
				return { sent, outcome: 'network' };
			}

			if (sent > 0) {
				try {
					await pruneCompletedOrders(30, now());
				} catch {
					/* prune failure never blocks the summary */
				}
			}

			return { sent, outcome: 'drained' };
		} finally {
			running = null;
		}
	})();

	running = runPromise;
	return runPromise;
}

function checkSkew(parsed: ParsedResponse, now: () => number): void {
	if (!parsed.dateHeader) return;
	const parsedDate = Date.parse(parsed.dateHeader);
	if (Number.isNaN(parsedDate)) return;
	const skew = parsedDate - now();
	lastSkew = skew;
	emit({ type: 'skew', skewMs: skew });
}

async function handleRevoked(): Promise<void> {
	try {
		await forgetDevice();
	} catch {
		/* forget failure shouldn't hide the revocation */
	}
	emit({ type: 'revoked' });
}
