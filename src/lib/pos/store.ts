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
import {
	compareVersions,
	parseSnapshot,
	type MenuSnapshot,
	type SnapshotCategory,
	type SnapshotItem,
	type SnapshotModifierGroup
} from './menu-snapshot';

const DB_NAME = 'matcami-pos';
// 2 since T-42 added the menu store (case 1 below).
const DB_VERSION = 2;

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
		case 1:
			// T-42: the menu snapshot. A till already at version 1 runs ONLY this case
			// and keeps its cached employees; a fresh till runs case 0, then this one.
			db.createObjectStore('menu', { keyPath: 'id' });
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
 * record is kept, never deleted (invariant 5).
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

// ── THE MENU SNAPSHOT (T-42; spec 5) ─────────────────────────────────────────────
//
// The version and the restaurant it belongs to live in the settings store, as
// { key: 'menuVersion' } and { key: 'menuRestaurantId' } — there is no separate
// store for them. The rows live in the menu store, keyed `<kind>:<id>`, each
// *Minor field kept as the EXACT decimal string the payload carried: the replace
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
	const versionResponse = await fetchFn('/api/menu/version', { credentials: 'same-origin' });
	if (!versionResponse.ok) {
		throw new Error(`GET /api/menu/version answered ${versionResponse.status}`);
	}
	const server = (await versionResponse.json()) as { version?: unknown; restaurantId?: unknown };
	if (typeof server.version !== 'number' || typeof server.restaurantId !== 'string') {
		throw new Error('GET /api/menu/version sent an unexpected body');
	}

	// A copy that belongs to ANOTHER restaurant — a tablet that changed hands — is no
	// copy at all, even when the two version numbers happen to agree.
	const localRestaurant = await readCachedSetting(MENU_RESTAURANT_KEY);
	const localVersion = await readCachedSetting(MENU_VERSION_KEY);
	const local =
		localRestaurant === server.restaurantId && typeof localVersion === 'number'
			? localVersion
			: null;
	if (compareVersions(local, server.version) === 'up-to-date') return 'up-to-date';

	const snapshotResponse = await fetchFn('/api/menu', { credentials: 'same-origin' });
	if (!snapshotResponse.ok) throw new Error(`GET /api/menu answered ${snapshotResponse.status}`);
	// Parsed BEFORE the transaction opens: a malformed payload writes nothing.
	const snapshot = parseSnapshot(await snapshotResponse.json());
	await replaceMenu(snapshot);
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
					menu.put({
						id: 'snapshot',
						kind: 'snapshot',
						data: {
							currency: snapshot.currency,
							currencyExponent: snapshot.currencyExponent,
							taxMode: snapshot.taxMode,
							taxRateBp: snapshot.taxRateBp
						}
					});
					for (const category of snapshot.categories) {
						menu.put({ id: `category:${category.id}`, kind: 'category', data: category });
					}
					for (const item of snapshot.items) {
						menu.put({ id: `item:${item.id}`, kind: 'item', data: item });
					}
					for (const group of snapshot.modifierGroups) {
						menu.put({ id: `group:${group.id}`, kind: 'group', data: group });
					}
					const settings = tx.objectStore('settings');
					settings.put({ key: MENU_VERSION_KEY, value: snapshot.version });
					settings.put({ key: MENU_RESTAURANT_KEY, value: snapshot.restaurantId });
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
	restaurantId: string;
	currency: string | null;
	currencyExponent: number | null;
	taxMode: string | null;
	taxRateBp: number | null;
	categories: SnapshotCategory[];
	items: Array<Omit<SnapshotItem, 'priceMinor'> & { priceMinor: bigint }>;
	modifierGroups: Array<
		Omit<SnapshotModifierGroup, 'modifiers'> & {
			modifiers: Array<{ id: string; name: string; priceDeltaMinor: bigint }>;
		}
	>;
};

type MenuRow = { id: string; kind: string; data: unknown };

/**
 * The local menu, or null before the first replace. THE ONE PLACE a menu amount
 * is converted: the stored decimal strings become bigint here, through BigInt(),
 * never through a number.
 */
export async function readMenu(): Promise<LocalMenu | null> {
	const version = await readCachedSetting(MENU_VERSION_KEY);
	const restaurantId = await readCachedSetting(MENU_RESTAURANT_KEY);
	if (typeof version !== 'number' || typeof restaurantId !== 'string') return null;

	const rows = (await withDb((db) =>
		valueOf(db.transaction('menu', 'readonly').objectStore('menu').getAll())
	)) as MenuRow[];
	const of = <T>(kind: string) =>
		rows.filter((row) => row.kind === kind).map((row) => row.data as T);
	const header =
		of<Pick<LocalMenu, 'currency' | 'currencyExponent' | 'taxMode' | 'taxRateBp'>>('snapshot')[0];
	if (!header) return null;

	const bySortOrder = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder;
	return {
		version,
		restaurantId,
		...header,
		categories: of<SnapshotCategory>('category').sort(bySortOrder),
		items: of<SnapshotItem>('item')
			.sort(bySortOrder)
			.map((item) => ({ ...item, priceMinor: BigInt(item.priceMinor) })),
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
// synced: false; the flush, the retry policy and the unsynced count on screen are
// the sales plan's work. The store's silence on that is deliberate, not an
// omission to fix.
