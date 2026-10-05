// THE TILL'S LOCAL STORE — the first IndexedDB code in this repository, and the
// shape the menu snapshot, the order store and the sync queue will be copied from.
//
// Spec 4: IndexedDB holds the employee list for PIN login and the restaurant
// settings the till needs offline. Spec 6: "Switching employees offline uses PIN
// hashes cached on the registered device", "Offline logins are recorded locally
// and synced to the audit log", and "The POS calls navigator.storage.persist()".
//
// This module lives in src/lib/pos and may import nothing from lib/server. The
// PIN check is the SAME isomorphic module the server calls (src/lib/pin) — a
// second implementation here would be a second opinion about whether a PIN is
// correct, and the two would drift the first time the cost factor changes.

import { verifyPin } from '../pin';
import type { OpEnvelope, OpKind, SaleCompletePayload, SyncResult } from '../sync-ops';
import {
	compareVersions,
	MENU_FORMAT,
	parseSnapshot,
	SnapshotError,
	type MenuSnapshot,
	type SnapshotCategory,
	type SnapshotItem,
	type SnapshotModifierGroup,
	type SnapshotTaxRate
} from './menu-snapshot';

const DB_NAME = 'matcami-pos';

// 3 since T-22 (tasks/pos-sales) added the order store, the sync queue, the
// invoice sequence and the session store (case 2 below).
const DB_VERSION = 3;

// Copied, not imported: these are T-14's event names in
// src/lib/server/audit/events.ts, and src/lib/pos may not import lib/server. The
// duplication is deliberate — and findable by searching for either string.
export const POS_PIN_SUCCESS = 'pos.pin.success';
export const POS_PIN_FAILED = 'pos.pin.failed';

/**
 * EXACTLY the seven keys GET /api/pos/employees returns, and no eighth. The field
 * stays `pinPhc`: the name is a tripwire against the server's audit writer, and
 * this is the one copy of the bundle that lives outside the server. It is null
 * for an employee with no PIN set. Never log it, render it or copy it anywhere.
 */
export type CachedEmployee = {
	id: string;
	displayName: string;
	isOwner: boolean;
	roleName: string;
	permissions: string[];
	isActive: boolean;
	pinPhc: string | null;
};

/**
 * One offline sign-in, kept until the sales plan's queue flushes it. clientOpId
 * is the attempt's device-generated key and this store's keyPath; occurredAt is
 * an ISO 8601 UTC string of the REAL moment, which audit_log.occurred_at keeps
 * distinct from the time the row is finally written.
 */
export type OfflineLogin = {
	clientOpId: string;
	/**
	 * The pos_devices uuid this sign-in happened on (bindDevice). The record keeps
	 * it for ever: whatever flushes it later must send it under THIS device, never
	 * under whichever device the tablet has been re-registered as since.
	 */
	deviceId: string;
	employeeId: string;
	event: string;
	occurredAt: string;
	outcome: 'success' | 'failed';
	synced: boolean;
	parked?: true;
};

/**
 * The sale's OWN numbers, kept on the completed order (menu-and-printing T-18):
 * the exact SaleCompletePayload the queue carries (invoice number included), the
 * per-line amounts the order screen showed, who sold it and when. Every receipt,
 * kitchen ticket and reprint is laid out from THIS and nothing else — never from
 * the cart with today's tax mode, never from a recomputation (invariant 7; the
 * risk panel's BLOCKER).
 */
export type SaleSnapshot = {
	payload: SaleCompletePayload;
	lineAmountsMinor: string[];
	cashierName: string;
	completedAt: string;
	businessDate: string | null;
	/** Per-rate tax, decimal strings, from `taxBreakdown` (the rows sum to
	 * `payload.totals.taxMinor`). OPTIONAL: sales completed before this plan
	 * have none, and the receipt then prints one tax line (T-23). */
	taxBreakdown?: Array<{ name: string | null; rateBp: number; taxMinor: string }>;
};

/** What has already been printed for an order; the drawer pulse is marked once. */
export type PrintedMarks = {
	receiptAt?: string;
	kitchenAt?: string;
	drawerAt?: string;
	reprints?: number;
};

/** One order on this till. `cart` is T-24's Cart; typed as a parameter so this
 * file does not import a module that does not exist yet. `sale` and `printed`
 * are optional: orders completed before T-18 carry neither (no DB_VERSION
 * change — they are fields of a stored object, not a store or an index). */
export type LocalOrder<C = unknown> = {
	id: string;
	deviceId: string;
	employeeId?: string;
	clientOpId?: string;
	state: 'cart' | 'completed' | 'abandoned';
	cart: C;
	invoiceSeq?: number;
	invoiceNumber?: string;
	completedAt?: string;
	syncedAt?: string;
	syncStatus?: 'accepted' | 'recorded_flagged' | 'unrecorded' | 'rejected';
	sale?: SaleSnapshot;
	printed?: PrintedMarks;
};

/** One queued operation. Every *Minor field in `envelope` is a decimal STRING
 * (bigint never survives JSON). */
export type QueueEntry = {
	clientOpId: string;
	deviceId: string;
	seq: number;
	kind: OpKind;
	envelope: OpEnvelope<OpKind, unknown>;
	state: 'pending' | 'sending' | 'done' | 'parked';
	attempts: number;
	lastError?: string;
	lastResult?: SyncResult;
};

/** Per-device counters. NEVER cleared by bindDevice or forgetDevice. */
export type SequenceRow = { deviceId: string; invoiceSeq: number; queueSeq: number };

/** The cashier shift this device is in, if any. */
export type LocalSession = {
	deviceId: string;
	posSessionId: string;
	employeeId: string;
	openingCashMinor: string;
	openedAt: string;
	businessDate?: string;
	state: 'opening' | 'open' | 'closing' | 'closed';
	countedCashMinor?: string;
	closedAt?: string;
	expectedCashMinor?: string;
	differenceMinor?: string;
	lastError?: string;
};

let upgrades = 0;

/** Test seam only — how many times upgrade() has run in this process. */
export function upgradeRunsForTest(): number {
	return upgrades;
}

function upgrade(db: IDBDatabase, oldVersion: number): void {
	upgrades++;

	// A fall-through switch on oldVersion, one case per version step. Each case
	// creates only what THAT version added and must NOT `break` — a browser two
	// versions behind runs every later case in order. Adding a store later means
	// adding `case 1:` below and bumping DB_VERSION; it never means editing case 0,
	// because a device already at version 1 will never run it again.
	switch (oldVersion) {
		case 0:
			db.createObjectStore('employees', { keyPath: 'id' });
			db.createObjectStore('settings', { keyPath: 'key' });
			db.createObjectStore('offline_logins', { keyPath: 'clientOpId' });
		// falls through
		case 1:
			// T-42: the menu snapshot. A till already at version 1 runs ONLY this case
			// and keeps its cached employees; a fresh till runs case 0, then this one.
			db.createObjectStore('menu', { keyPath: 'id' });
		// falls through
		case 2: {
			// T-22 (tasks/pos-sales): the sales stores. A till at version 2 runs ONLY
			// this case and keeps its employees, settings, menu and offline_logins.
			const orders = db.createObjectStore('orders', { keyPath: 'id' });
			orders.createIndex('status', 'state');
			orders.createIndex('deviceId', 'deviceId');
			const queue = db.createObjectStore('sync_queue', { keyPath: 'clientOpId' });
			queue.createIndex('seq', 'seq', { unique: true });
			queue.createIndex('deviceId', 'deviceId');
			queue.createIndex('state', 'state');
			db.createObjectStore('invoice_sequence', { keyPath: 'deviceId' });
			db.createObjectStore('session', { keyPath: 'deviceId' });
		}
		// falls through
	}
}

let persistenceAsked = false;

/**
 * Open the till's database, creating or upgrading it. A failure REJECTS with a
 * message naming the database: a silent open failure is a till that looks fine
 * and forgets everything. The first open of the page also asks the browser to
 * keep this storage (spec 6).
 */
export function openPosDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion);

		request.onsuccess = () => {
			if (!persistenceAsked) {
				persistenceAsked = true;
				void requestPersistentStorage();
			}
			resolve(request.result);
		};

		request.onerror = () =>
			reject(
				new Error(`Could not open the POS database "${DB_NAME}": ${request.error?.message ?? ''}`)
			);

		request.onblocked = () =>
			console.warn(
				`Opening the POS database "${DB_NAME}" is waiting for another tab to close its older connection`
			);
	});
}

/** Run `work` in one transaction and settle when that transaction completes. */
export function inTransaction(
	db: IDBDatabase,
	stores: string[],
	mode: IDBTransactionMode,
	work: (tx: IDBTransaction) => void
): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(stores, mode);

		tx.oncomplete = () => resolve();

		// The FAILING REQUEST's error, not tx.error: a request's error event reaches
		// the transaction BEFORE the transaction aborts, and tx.error is only set by
		// the abort — so tx.error here is still null, and a ConstraintError from add()
		// would arrive as a bare null that recordOfflineLogin cannot recognise.
		tx.onerror = (event) => reject((event.target as IDBRequest | null)?.error ?? tx.error);

		tx.onabort = () => reject(tx.error ?? new Error('The transaction was aborted'));

		work(tx);
	});
}

export function valueOf<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Open, run, and always close — every operation below stands alone. */
export async function withDb<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> {
	const db = await openPosDb();

	try {
		return await use(db);
	} finally {
		db.close();
	}
}

/**
 * Replace the cached employee list with `employees` — a CLEAR AND REPLACE in one
 * readwrite transaction, never a merge: an employee the owner deactivated must
 * disappear from the till, and a merge would leave them signable-in forever.
 */
export function cacheEmployees(employees: CachedEmployee[]): Promise<void> {
	return withDb((db) =>
		inTransaction(db, ['employees'], 'readwrite', (tx) => {
			const store = tx.objectStore('employees');

			store.clear();

			for (const e of employees) {
				store.put({
					id: e.id,
					displayName: e.displayName,
					isOwner: e.isOwner,
					roleName: e.roleName,
					permissions: e.permissions,
					isActive: e.isActive,
					pinPhc: e.pinPhc
				});
			}
		})
	);
}

export async function readCachedEmployees(): Promise<CachedEmployee[]> {
	return withDb(async (db) => {
		const rows = (await valueOf(
			db.transaction('employees', 'readonly').objectStore('employees').getAll()
		)) as Array<Record<string, unknown>>;

		return rows.flatMap((row) => {
			const id = typeof row.id === 'string' ? row.id : null;
			const displayName = typeof row.displayName === 'string' ? row.displayName : null;
			const isActive = typeof row.isActive === 'boolean' ? row.isActive : null;

			const pinPhc = typeof row.pinPhc === 'string' || row.pinPhc === null ? row.pinPhc : null;

			// A malformed cached row must never crash offline sign-in.
			if (id === null || displayName === null || isActive === null) {
				return [];
			}

			// Normalize rows written by the previous cache shape.
			const role = typeof row.role === 'string' ? row.role : undefined;

			const isOwner = typeof row.isOwner === 'boolean' ? row.isOwner : role === 'owner';

			const roleName =
				typeof row.roleName === 'string'
					? row.roleName
					: role === 'owner'
						? 'Owner'
						: role === 'cashier'
							? 'Cashier'
							: role === 'waiter'
								? 'Waiter'
								: 'Staff';

			const permissions = Array.isArray(row.permissions)
				? row.permissions.filter(
						(permission): permission is string => typeof permission === 'string'
					)
				: [];

			return [
				{
					id,
					displayName,
					isOwner,
					roleName,
					permissions,
					isActive,
					pinPhc
				}
			];
		});
	});
}

/** Store the settings the till needs offline. A null value is stored AS null. */
export function cacheSettings(entries: Array<{ key: string; value: unknown }>): Promise<void> {
	return withDb((db) =>
		inTransaction(db, ['settings'], 'readwrite', (tx) => {
			const store = tx.objectStore('settings');

			for (const entry of entries) {
				store.put({ key: entry.key, value: entry.value });
			}
		})
	);
}

export function readCachedSetting(key: string): Promise<unknown> {
	return withDb(async (db) => {
		const record = (await valueOf(
			db.transaction('settings', 'readonly').objectStore('settings').get(key)
		)) as { key: string; value: unknown } | undefined;

		return record?.value;
	});
}

/**
 * The idle lock for the PIN screen, or null — null when nothing is cached AND
 * when null was cached. The setting is nullable with no default (CLAUDE.md,
 * decision of 2026-09-15): this never returns a number nobody stored.
 */
export async function readCachedIdleSeconds(): Promise<number | null> {
	const value = await readCachedSetting('posIdleLockSeconds');

	return typeof value === 'number' ? value : null;
}

/**
 * The settings key under which syncMenu remembers a snapshot it could NOT
 * parse (menu-and-printing T-15). Every caller of syncMenu swallows its errors
 * — an offline till must keep the menu it has — so without this a till running
 * old JavaScript against a newer server would freeze its menu in silence. The
 * layout shows it as permanent chrome while online; a good sync clears it.
 */
export const MENU_SYNC_ERROR_KEY = 'menuSyncError';

/** The remembered parse failure's message, or null for anything else. */
export async function readMenuSyncError(): Promise<string | null> {
	const value = await readCachedSetting(MENU_SYNC_ERROR_KEY);

	return typeof value === 'string' ? value : null;
}

const BOUND_DEVICE_KEY = 'deviceId';

/**
 * Bind this browser's cache to the registered device the server just named — the
 * pos_devices uuid from GET /api/pos/employees. A device CODE (POS1) repeats in
 * every restaurant, so it cannot bind anything.
 *
 * When the device CHANGES — a tablet moved to another restaurant, or registered
 * again — everything cached for the old device is dropped in the SAME transaction
 * that records the new binding: the employees, whose cached PIN hashes would
 * otherwise sign the old restaurant's staff in on the new till offline, and the
 * settings (the idle lock, and the menu version kept there). offline_logins is
 * NEVER touched: each row carries the device it was recorded on, and an unsynced
 * record is kept, never deleted (invariant 5). `orders`, `sync_queue`,
 * `invoice_sequence` and `session` are NEVER touched here, for the same reason
 * as `offline_logins`: an unsynced sale is a recorded fact stamped with the
 * device it was made on (invariant 5), and a wiped invoice counter would hand
 * out a number that is already queued (00-overview.md, the 'invoice counter in
 * a store the device wipes' risk).
 *
 * (Requested by the public-sign-up planning session on the user's behalf: once
 * anyone can create a restaurant, a tablet can change hands between companies.)
 */
export function bindDevice(deviceId: string): Promise<'unchanged' | 'bound'> {
	return withDb(async (db) => {
		let outcome: 'unchanged' | 'bound' = 'unchanged';

		await inTransaction(db, ['employees', 'settings', 'menu'], 'readwrite', (tx) => {
			const settings = tx.objectStore('settings');
			const current = settings.get(BOUND_DEVICE_KEY);

			current.onsuccess = () => {
				const stored = (current.result as { value?: unknown } | undefined)?.value;

				if (stored === deviceId) return;

				outcome = 'bound';

				tx.objectStore('employees').clear();

				// The old device's menu goes too: its prices and tax rates belong to the
				// restaurant the tablet no longer serves.
				tx.objectStore('menu').clear();

				settings.clear();
				settings.put({ key: BOUND_DEVICE_KEY, value: deviceId });
			};
		});

		return outcome;
	});
}

/** The device this cache is bound to, or null before the first successful fetch. */
export async function readBoundDeviceId(): Promise<string | null> {
	const value = await readCachedSetting(BOUND_DEVICE_KEY);

	return typeof value === 'string' ? value : null;
}

/**
 * Forget the device: clear the cached employees and their PIN hashes, the settings
 * (the bound device id among them, the idle lock, the menu version) and the menu,
 * in ONE transaction. Called whenever the server answers 403 to a device-guarded
 * request, meaning the device is unknown or REVOKED. A till the owner revoked
 * (invariant 12) must not go on signing staff in offline from hashes it still
 * holds once the server has told it so. With no bound device, the PIN screen's
 * offline path refuses. offline_logins is NEVER touched: those records are
 * unsynced work, each stamped with the device it was made on (invariant 5).
 * `orders`, `sync_queue`, `invoice_sequence` and `session` are NEVER touched
 * here, for the same reason as `offline_logins`: an unsynced sale is a
 * recorded fact stamped with the device it was made on (invariant 5), and a
 * wiped invoice counter would hand out a number that is already queued
 * (00-overview.md, the 'invoice counter in a store the device wipes' risk).
 */
export function forgetDevice(): Promise<void> {
	return withDb((db) =>
		inTransaction(db, ['employees', 'settings', 'menu'], 'readwrite', (tx) => {
			tx.objectStore('employees').clear();
			tx.objectStore('settings').clear();
			tx.objectStore('menu').clear();
		})
	);
}

/**
 * Check a PIN against the hash cached for `employeeId`, with the SAME isomorphic
 * verifyPin the server uses. An employee not in the cache, and a cached employee
 * with no PIN set, are `false` without calling verifyPin — never a throw. There
 * is no isActive re-check: the server only ships active employees, and
 * cacheEmployees clears and replaces, so a deactivated one is gone after the next
 * successful directory fetch.
 */
export async function verifyCachedPin(employeeId: string, pin: string): Promise<boolean> {
	const employee = await withDb(
		(db) =>
			valueOf(
				db.transaction('employees', 'readonly').objectStore('employees').get(employeeId)
			) as Promise<CachedEmployee | undefined>
	);

	if (!employee || employee.pinPhc === null) return false;

	return verifyPin(pin, employee.pinPhc);
}

// One signal: "the unsynced count may have changed". Module scope, so every screen
// of the page hears it; the connection bar re-counts on it.
const unsyncedChanges = new EventTarget();

/**
 * Record an offline sign-in. add(), NEVER put(): a second add of the same
 * clientOpId rejects with ConstraintError, which is swallowed — and only that
 * error — so a retry of the same operation is a NO-OP that keeps the FIRST
 * attempt's occurredAt. put() would look identical in a row-count test and
 * quietly rewrite history. Every other error propagates. A write that added a row
 * signals onUnsyncedChange; a no-op retry does not.
 */
export async function recordOfflineLogin(record: OfflineLogin): Promise<void> {
	try {
		await withDb((db) =>
			inTransaction(db, ['offline_logins'], 'readwrite', (tx) => {
				tx.objectStore('offline_logins').add({ ...record });
			})
		);
	} catch (error) {
		// The retry added nothing, so the count did not change: no signal.
		if ((error as { name?: string } | null)?.name === 'ConstraintError') return;

		throw error;
	}

	signalUnsyncedChange();
}

/**
 * THE unsynced count that the connection bar shows. ONE number over TWO
 * stores: offline_logins rows still `synced: false` PLUS sync_queue rows
 * whose state is neither `'done'` nor `'parked'`. `'parked'` is deliberately
 * excluded — a parked op is not waiting for a connection, it is waiting for
 * the owner; `countParked()` shows it as its own chrome so it is never a
 * second "unsynced" number (spec 6, invariant 5).
 */
export function countUnsynced(): Promise<number> {
	return withDb(
		(db) =>
			new Promise<number>((resolve, reject) => {
				const tx = db.transaction(['offline_logins', 'sync_queue'], 'readonly');
				let logins = 0;
				let queued = 0;
				const loginsRequest = tx.objectStore('offline_logins').getAll();
				loginsRequest.onsuccess = () => {
					const rows = loginsRequest.result as Array<{
						synced?: unknown;
						parked?: unknown;
					}>;
					logins = rows.filter((row) => row.synced === false && row.parked !== true).length;
				};
				const queueRequest = tx.objectStore('sync_queue').getAll();
				queueRequest.onsuccess = () => {
					const rows = queueRequest.result as Array<{ state?: unknown }>;
					queued = rows.filter((row) => row.state !== 'done' && row.state !== 'parked').length;
				};
				tx.oncomplete = () => resolve(logins + queued);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
			})
	);
}

/** Sync_queue rows in state `'parked'` PLUS offline_logins with parked=true. */
export function countParked(): Promise<number> {
	return withDb(
		(db) =>
			new Promise<number>((resolve, reject) => {
				const tx = db.transaction(['sync_queue', 'offline_logins'], 'readonly');
				let queued = 0;
				let logins = 0;
				const queueRequest = tx.objectStore('sync_queue').index('state').count('parked');
				queueRequest.onsuccess = () => {
					queued = queueRequest.result;
				};
				const loginsRequest = tx.objectStore('offline_logins').getAll();
				loginsRequest.onsuccess = () => {
					const rows = loginsRequest.result as Array<{ parked?: unknown }>;
					logins = rows.filter((row) => row.parked === true).length;
				};
				tx.oncomplete = () => resolve(queued + logins);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
			})
	);
}

/** T-25: mark an offline_logins row synced after a successful POST. */
export function markOfflineLoginSynced(clientOpId: string): Promise<void> {
	return withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction('offline_logins', 'readwrite');
				const store = tx.objectStore('offline_logins');
				const request = store.get(clientOpId);
				request.onsuccess = () => {
					const row = request.result as OfflineLogin | undefined;
					if (row) store.put({ ...row, synced: true });
				};
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
			})
	);
}

/** T-25: park an offline_logins row when the server refuses it out of contract. */
export function markOfflineLoginParked(clientOpId: string): Promise<void> {
	return withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction('offline_logins', 'readwrite');
				const store = tx.objectStore('offline_logins');
				const request = store.get(clientOpId);
				request.onsuccess = () => {
					const row = request.result as OfflineLogin | undefined;
					if (row) store.put({ ...row, parked: true });
				};
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
			})
	);
}

/**
 * Call `listener` whenever the unsynced count may have changed, so a screen
 * re-counts instead of keeping a tally of its own. Returns the unsubscribe.
 */
export function onUnsyncedChange(listener: () => void): () => void {
	unsyncedChanges.addEventListener('change', listener);

	return () => unsyncedChanges.removeEventListener('change', listener);
}

/** Public trigger for the change event — completeSale, abandonSale,
 * openLocalSession, closeLocalSession and the flush call it after every
 * commit that changes the count. */
export function signalUnsyncedChange(): void {
	unsyncedChanges.dispatchEvent(new Event('change'));
}

/** Assumption 13: synced sales are pruned from the device after 30 days.
 * Deletes only LOCAL copies of sales the server has already answered for
 * (never touches a server row; invariant 2). */
export function pruneCompletedOrders(
	olderThanDays = 30,
	now: number = Date.now()
): Promise<number> {
	return withDb(
		(db) =>
			new Promise<number>((resolve, reject) => {
				const cutoff = now - olderThanDays * 86_400_000;
				let removed = 0;
				const tx = db.transaction(['orders', 'sync_queue'], 'readwrite');
				const ordersStore = tx.objectStore('orders');
				const queueStore = tx.objectStore('sync_queue');
				const ordersRequest = ordersStore.getAll();
				ordersRequest.onsuccess = () => {
					const rows = ordersRequest.result as Array<{
						id?: string;
						state?: unknown;
						syncedAt?: unknown;
					}>;
					const toDelete = rows.filter((row) => {
						if (row.state !== 'completed') return false;
						if (typeof row.syncedAt !== 'string') return false;
						const at = Date.parse(row.syncedAt);
						return Number.isFinite(at) && at < cutoff;
					});
					const orderIds = new Set(
						toDelete.map((row) => row.id).filter((id): id is string => typeof id === 'string')
					);
					removed = orderIds.size;
					for (const id of orderIds) {
						ordersStore.delete(id);
					}
					const doneRequest = queueStore.index('state').getAll('done');
					doneRequest.onsuccess = () => {
						const queueRows = doneRequest.result as Array<{
							clientOpId?: string;
							envelope?: { payload?: { orderId?: string } };
						}>;
						for (const row of queueRows) {
							const orderId = row.envelope?.payload?.orderId;
							if (
								typeof orderId === 'string' &&
								orderIds.has(orderId) &&
								typeof row.clientOpId === 'string'
							) {
								queueStore.delete(row.clientOpId);
							}
						}
					};
				};
				tx.oncomplete = () => resolve(removed);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
			})
	);
}

/**
 * Ask the browser to keep this origin's storage (spec 6): an evicted IndexedDB is
 * unsynced work destroyed. Checks persisted() first so a till that already holds
 * the grant does not ask again, and returns the browser's answer so a screen can
 * warn when it refused. Needs a secure context (https, or localhost).
 */
export async function requestPersistentStorage(): Promise<boolean> {
	if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;

	if (await navigator.storage.persisted()) return true;

	return await navigator.storage.persist();
}

// ── THE MENU SNAPSHOT (T-42; spec 5) ─────────────────────────────────────────────
//
// The version and the restaurant it belongs to live in the settings store, as
// { key: 'menuVersion' } and { key: 'menuRestaurantId' } — there is no separate
// store for them. The rows live in the menu store, keyed `<kind>:<id>`, each
// Minor field kept as the EXACT decimal string the payload carried: the replace
// is a dumb copy, and a bad conversion can never be persisted. (IndexedDB could
// store a bigint; keeping the string is a choice, not a limitation.)
//
// NO MONEY ARITHMETIC. The till stores and displays in this plan. Totalling a bill
// belongs to the sales plan, which must import src/lib/money — the ONE rounding
// rule spec 17 requires, used by POS, server and reports alike — and never copy
// any of it into src/lib/pos.

const MENU_VERSION_KEY = 'menuVersion';
const MENU_RESTAURANT_KEY = 'menuRestaurantId';

/**
 * The format of the cached menu copy (MENU_FORMAT in menu-snapshot.ts): null when
 * there is no copy, the header's `format` when it is a number, and 1 otherwise — a
 * copy written by a build before named tax rates has no `format` key at all.
 */
async function readCachedMenuFormat(): Promise<number | null> {
	const row = (await withDb((db) =>
		valueOf(db.transaction('menu', 'readonly').objectStore('menu').get('snapshot'))
	)) as { data?: { format?: unknown } } | undefined;

	if (!row) return null;

	return typeof row.data?.format === 'number' ? row.data.format : 1;
}

/**
 * Refresh the local menu: compare versions, and on a mismatch download the FULL
 * snapshot and replace the local copy (spec 5; no change-only sync). Every network
 * await happens BEFORE the IndexedDB transaction opens — a transaction commits on
 * its own as soon as the event loop turns with nothing outstanding against it, so
 * an await fetch inside it would end it early and commit half a menu. Any failure
 * leaves the old copy and the old version exactly as they were: an offline till
 * keeps the menu it has.
 */
export async function syncMenu(fetchFn: typeof fetch = fetch): Promise<'up-to-date' | 'replaced'> {
	// credentials: the device cookie is HttpOnly — it travels on the request and is
	// never readable by this code.
	const versionResponse = await fetchFn('/api/menu/version', {
		credentials: 'same-origin'
	});

	if (versionResponse.status === 403) {
		// Unknown or revoked: forget everything cached for this device.
		await forgetDevice();
		throw new Error('GET /api/menu/version answered 403: this device is not registered');
	}

	if (!versionResponse.ok) {
		throw new Error(`GET /api/menu/version answered ${versionResponse.status}`);
	}

	const server = (await versionResponse.json()) as {
		version?: unknown;
		restaurantId?: unknown;
	};

	if (typeof server.version !== 'number' || typeof server.restaurantId !== 'string') {
		throw new Error('GET /api/menu/version sent an unexpected body');
	}

	// A copy that belongs to ANOTHER restaurant — a tablet that changed hands — is no
	// copy at all, even when the two version numbers happen to agree.
	const localRestaurant = await readCachedSetting(MENU_RESTAURANT_KEY);
	const localVersion = await readCachedSetting(MENU_VERSION_KEY);

	// A copy in another FORMAT is no copy either, by the same rule. A till that
	// synced the new server with an OLD shell stored a format-1 copy AT THE NEW
	// VERSION. Trusting it would send every line without a rate id until the next
	// menu edit (tasks/settings-tax-payments-receipt, risk 4). compareVersions stays
	// a pure version comparison: the format is decided here, before it.
	const local =
		localRestaurant === server.restaurantId &&
		typeof localVersion === 'number' &&
		(await readCachedMenuFormat()) === MENU_FORMAT
			? localVersion
			: null;

	if (compareVersions(local, server.version) === 'up-to-date') {
		await cacheSettings([{ key: MENU_SYNC_ERROR_KEY, value: null }]);
		return 'up-to-date';
	}

	const snapshotResponse = await fetchFn('/api/menu', {
		credentials: 'same-origin'
	});

	if (snapshotResponse.status === 403) {
		await forgetDevice();
		throw new Error('GET /api/menu answered 403: this device is not registered');
	}

	if (!snapshotResponse.ok) {
		throw new Error(`GET /api/menu answered ${snapshotResponse.status}`);
	}

	// Parsed BEFORE the transaction opens: a malformed payload writes nothing to the
	// menu — but the FAILURE is remembered, so the layout can say the menu is stale.
	let snapshot: MenuSnapshot;
	try {
		snapshot = parseSnapshot(await snapshotResponse.json());
	} catch (thrown) {
		if (thrown instanceof SnapshotError) {
			await cacheSettings([{ key: MENU_SYNC_ERROR_KEY, value: thrown.message }]);
		}
		throw thrown;
	}

	await replaceMenu(snapshot);
	await cacheSettings([{ key: MENU_SYNC_ERROR_KEY, value: null }]);

	return 'replaced';
}

/**
 * Replace the local menu with `snapshot`: the rows AND the version, in ONE
 * transaction over the menu and settings stores, so the till can never hold one
 * without the other. If the version were written separately and that write failed,
 * the till would believe it was current while holding the previous menu — and spec
 * 5 has no repair path for that.
 *
 * `abortForTest` is a test seam only: it aborts after every write, to prove a
 * failure leaves the OLD version and the OLD rows.
 */
export function replaceMenu(snapshot: MenuSnapshot, abortForTest = false): Promise<void> {
	return withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction(['menu', 'settings'], 'readwrite');

				tx.oncomplete = () => resolve();

				tx.onerror = (event) => reject((event.target as IDBRequest | null)?.error ?? tx.error);

				tx.onabort = () => reject(tx.error ?? new Error('The menu replace was aborted'));

				try {
					const menu = tx.objectStore('menu');

					menu.clear();

					// `format` is what syncMenu checks: a copy in another format is replaced
					// even at an equal version. Each item row is stored as is, so its
					// `taxRate` goes with it.
					menu.put({
						id: 'snapshot',
						kind: 'snapshot',
						data: {
							format: snapshot.format,
							currency: snapshot.currency,
							currencyExponent: snapshot.currencyExponent,
							taxMode: snapshot.taxMode,
							taxRateBp: snapshot.taxRateBp,
							defaultTaxRate: snapshot.defaultTaxRate
						}
					});

					for (const category of snapshot.categories) {
						menu.put({
							id: `category:${category.id}`,
							kind: 'category',
							data: category
						});
					}

					for (const item of snapshot.items) {
						menu.put({
							id: `item:${item.id}`,
							kind: 'item',
							data: item
						});
					}

					for (const group of snapshot.modifierGroups) {
						menu.put({
							id: `group:${group.id}`,
							kind: 'group',
							data: group
						});
					}

					const settings = tx.objectStore('settings');

					settings.put({
						key: MENU_VERSION_KEY,
						value: snapshot.version
					});

					settings.put({
						key: MENU_RESTAURANT_KEY,
						value: snapshot.restaurantId
					});

					if (abortForTest) tx.abort();
				} catch (error) {
					tx.abort();
					reject(error);
				}
			})
	);
}

export type LocalMenu = {
	version: number;
	/** MENU_FORMAT of the copy; 1 for a copy written by a build before named tax rates. */
	format: number;
	restaurantId: string;
	currency: string | null;
	currencyExponent: number | null;
	taxMode: string | null;
	taxRateBp: number | null;
	/** The restaurant's named default rate, or null (none picked, or a format-1 copy). */
	defaultTaxRate: SnapshotTaxRate | null;
	categories: SnapshotCategory[];
	items: Array<Omit<SnapshotItem, 'priceMinor'> & { priceMinor: bigint }>;
	modifierGroups: Array<
		Omit<SnapshotModifierGroup, 'modifiers'> & {
			modifiers: Array<{
				id: string;
				name: string;
				priceDeltaMinor: bigint;
			}>;
		}
	>;
};

type MenuRow = {
	id: string;
	kind: string;
	data: unknown;
};

/**
 * The local menu, or null before the first replace. THE ONE PLACE a menu amount
 * is converted: the stored decimal strings become bigint here, through BigInt(),
 * never through a number.
 *
 * It also reads a copy written by the PREVIOUS build, whose header has no
 * `format`/`defaultTaxRate` and whose item rows have no `taxRate`: that copy reads
 * as format 1 with null rates, and an offline till keeps selling from it through
 * resolveTaxRate's fallback to the legacy numbers (invariant 5). syncMenu replaces
 * it at the next version check.
 */
export async function readMenu(): Promise<LocalMenu | null> {
	const version = await readCachedSetting(MENU_VERSION_KEY);
	const restaurantId = await readCachedSetting(MENU_RESTAURANT_KEY);

	if (typeof version !== 'number' || typeof restaurantId !== 'string') {
		return null;
	}

	const rows = (await withDb((db) =>
		valueOf(db.transaction('menu', 'readonly').objectStore('menu').getAll())
	)) as MenuRow[];

	const of = <T>(kind: string) =>
		rows.filter((row) => row.kind === kind).map((row) => row.data as T);

	const header = of<
		Pick<LocalMenu, 'currency' | 'currencyExponent' | 'taxMode' | 'taxRateBp'> & {
			format?: unknown;
			defaultTaxRate?: SnapshotTaxRate | null;
		}
	>('snapshot')[0];

	if (!header) return null;

	const bySortOrder = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder;

	return {
		version,
		restaurantId,
		...header,
		format: typeof header.format === 'number' ? header.format : 1,
		defaultTaxRate: header.defaultTaxRate ?? null,
		categories: of<SnapshotCategory>('category').sort(bySortOrder),
		items: of<SnapshotItem>('item')
			.sort(bySortOrder)
			.map((item) => ({
				...item,
				taxRate: item.taxRate ?? null,
				priceMinor: BigInt(item.priceMinor)
			})),
		modifierGroups: of<SnapshotModifierGroup>('group').map((group) => ({
			...group,
			modifiers: group.modifiers.map((modifier) => ({
				...modifier,
				priceDeltaMinor: BigInt(modifier.priceDeltaMinor)
			}))
		}))
	};
}

// NO SYNC QUEUE IS BUILT HERE. offline_logins rows are written and left with
// synced: false, and counted on screen (countUnsynced); the flush and its retry
// policy are the sales plan's work. The flush belongs in this module and must
// signal the change the way recordOfflineLogin does, and the sales plan's own queue
// must add its rows to countUnsynced, so the till shows ONE count of everything
// still unsynced.
