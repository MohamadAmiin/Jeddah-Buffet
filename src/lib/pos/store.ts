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

const DB_NAME = 'matcami-pos';
const DB_VERSION = 1;

// Copied, not imported: these are T-14's event names in
// src/lib/server/audit/events.ts, and src/lib/pos may not import lib/server. The
// duplication is deliberate — and findable by searching for either string.
export const POS_PIN_SUCCESS = 'pos.pin.success';
export const POS_PIN_FAILED = 'pos.pin.failed';

/**
 * EXACTLY the five keys GET /api/pos/employees returns, and no sixth. The field
 * stays `pinPhc`: the name is a tripwire against the server's audit writer, and
 * this is the one copy of the bundle that lives outside the server. It is null
 * for an employee with no PIN set. Never log it, render it or copy it anywhere.
 */
export type CachedEmployee = {
	id: string;
	displayName: string;
	role: 'owner' | 'cashier' | 'waiter';
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
	employeeId: string;
	event: string;
	occurredAt: string;
	outcome: 'success' | 'failed';
	synced: false;
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
			reject(new Error(`Opening the POS database "${DB_NAME}" is blocked by another tab`));
	});
}

/** Run `work` in one transaction and settle when that transaction completes. */
function inTransaction(
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

function valueOf<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Open, run, and always close — every operation below stands alone. */
async function withDb<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> {
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
					role: e.role,
					isActive: e.isActive,
					pinPhc: e.pinPhc
				});
			}
		})
	);
}

export function readCachedEmployees(): Promise<CachedEmployee[]> {
	return withDb((db) =>
		valueOf(
			db.transaction('employees', 'readonly').objectStore('employees').getAll() as IDBRequest<
				CachedEmployee[]
			>
		)
	);
}

/** Store the settings the till needs offline. A null value is stored AS null. */
export function cacheSettings(entries: Array<{ key: string; value: unknown }>): Promise<void> {
	return withDb((db) =>
		inTransaction(db, ['settings'], 'readwrite', (tx) => {
			const store = tx.objectStore('settings');
			for (const entry of entries) store.put({ key: entry.key, value: entry.value });
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

/**
 * Record an offline sign-in. add(), NEVER put(): a second add of the same
 * clientOpId rejects with ConstraintError, which is swallowed — and only that
 * error — so a retry of the same operation is a NO-OP that keeps the FIRST
 * attempt's occurredAt. put() would look identical in a row-count test and
 * quietly rewrite history. Every other error propagates.
 */
export async function recordOfflineLogin(record: OfflineLogin): Promise<void> {
	try {
		await withDb((db) =>
			inTransaction(db, ['offline_logins'], 'readwrite', (tx) => {
				tx.objectStore('offline_logins').add({ ...record });
			})
		);
	} catch (error) {
		if ((error as { name?: string } | null)?.name === 'ConstraintError') return;
		throw error;
	}
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

// NO SYNC QUEUE IS BUILT HERE. offline_logins rows are written and left with
// synced: false; the flush, the retry policy and the unsynced count on screen are
// the sales plan's work. The store's silence on that is deliberate, not an
// omission to fix.
