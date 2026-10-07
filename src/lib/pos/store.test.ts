// The unit project runs in `node`, which has no indexedDB: fake-indexeddb (a pinned
// devDependency) provides the global for THIS file only. The dedupe it tests is
// the real add()/ConstraintError behaviour, not a re-implementation of it.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { hashPin } from '../pin';
import {
	bindDevice,
	cacheEmployees,
	cacheSettings,
	countParked,
	countUnsynced,
	forgetDevice,
	onUnsyncedChange,
	openPosDb,
	pruneCompletedOrders,
	readBoundDeviceId,
	readCachedEmployees,
	readCachedIdleSeconds,
	readCachedSetting,
	readMenu,
	readMenuSyncError,
	recordOfflineLogin,
	replaceMenu,
	syncMenu,
	upgradeRunsForTest,
	verifyCachedPin,
	withDb,
	inTransaction,
	valueOf,
	type CachedEmployee,
	type LocalOrder,
	type LocalSession,
	type OfflineLogin,
	type QueueEntry,
	type SequenceRow
} from './store';
import { parseSnapshot } from './menu-snapshot';

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

async function offlineLogins(): Promise<OfflineLogin[]> {
	const db = await openPosDb();
	try {
		return await new Promise((resolve, reject) => {
			const request = db.transaction('offline_logins').objectStore('offline_logins').getAll();
			request.onsuccess = () => resolve(request.result as OfflineLogin[]);
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

function employee(id: string, pinPhc: string | null = null): CachedEmployee {
	return {
		id,
		displayName: `Employee ${id}`,
		isOwner: false,
		roleName: 'Cashier',
		permissions: [],
		isActive: true,
		pinPhc
	};
}

const login = (clientOpId: string, occurredAt: string): OfflineLogin => ({
	clientOpId,
	deviceId: 'device-A',
	employeeId: 'e-1',
	event: 'pos.pin.success',
	occurredAt,
	outcome: 'success',
	synced: false
});

describe('the POS store', () => {
	// MANDATORY (spec 29 — offline sync: retries never create duplicates).
	it('records an offline login ONCE per clientOpId, keeping the first attempt’s time', async () => {
		await recordOfflineLogin(login('op-1', '2026-09-15T10:00:00.000Z'));
		await recordOfflineLogin(login('op-1', '2026-09-15T10:00:05.000Z'));

		let rows = await offlineLogins();
		expect(rows).toHaveLength(1);
		expect(rows[0].occurredAt).toBe('2026-09-15T10:00:00.000Z');

		await recordOfflineLogin(login('op-2', '2026-09-15T10:01:00.000Z'));
		rows = await offlineLogins();
		expect(rows).toHaveLength(2);
	});

	// MANDATORY (spec 29 — offline sync: retries never create duplicates). A
	// clear-and-replace, never a merge: a removed employee is GONE.
	it('replaces the employee list rather than merging into it', async () => {
		await cacheEmployees([employee('a'), employee('b'), employee('c')]);

		const [cached] = await readCachedEmployees();
		expect(Object.keys(cached).sort()).toEqual([
			'displayName',
			'id',
			'isActive',
			'isOwner',
			'permissions',
			'pinPhc',
			'roleName'
		]);
		expect(cached.roleName).toBe('Cashier');
		expect(cached.isOwner).toBe(false);
		expect(cached.permissions).toEqual([]);

		await cacheEmployees([employee('a'), employee('b'), employee('c')]);
		expect(await readCachedEmployees()).toHaveLength(3);

		await cacheEmployees([employee('a'), employee('b')]);
		const ids = (await readCachedEmployees()).map((e) => e.id).sort();
		expect(ids).toEqual(['a', 'b']);
	});

	it('normalizes an old employee cache row without throwing', async () => {
		const db = await openPosDb();

		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = db.transaction('employees', 'readwrite');
				transaction.objectStore('employees').put({
					id: 'legacy-owner',
					displayName: 'Legacy Owner',
					role: 'owner',
					isActive: true,
					pinPhc: null
				});

				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally {
			db.close();
		}

		await expect(readCachedEmployees()).resolves.toEqual([
			{
				id: 'legacy-owner',
				displayName: 'Legacy Owner',
				isOwner: true,
				roleName: 'Owner',
				permissions: [],
				isActive: true,
				pinPhc: null
			}
		]);
	});

	it('survives a reopen, and upgrades only on the first open', async () => {
		const before = upgradeRunsForTest();

		await cacheEmployees([employee('a')]);
		expect(upgradeRunsForTest()).toBe(before + 1);
		await cacheSettings([{ key: 'posIdleLockSeconds', value: 300 }]);

		const db = await openPosDb();
		db.close();

		expect(await readCachedEmployees()).toEqual([employee('a')]);
		expect(await readCachedSetting('posIdleLockSeconds')).toBe(300);
		expect(upgradeRunsForTest()).toBe(before + 1);
	});

	// The same isomorphic verifyPin the server calls, so the two verdicts cannot
	// diverge.
	it('verifies a PIN against the cached hash, and refuses what it cannot check', async () => {
		const phc = await hashPin('4321');
		await cacheEmployees([employee('with-pin', phc), employee('no-pin', null)]);

		expect(await verifyCachedPin('with-pin', '4321')).toBe(true);
		expect(await verifyCachedPin('with-pin', '9999')).toBe(false);
		expect(await verifyCachedPin('not-cached', '4321')).toBe(false);
		expect(await verifyCachedPin('no-pin', '4321')).toBe(false);
	});

	it('never invents an idle lock: null when nothing is cached, and null when null was', async () => {
		expect(await readCachedIdleSeconds()).toBeNull();

		await cacheSettings([{ key: 'posIdleLockSeconds', value: null }]);
		expect(await readCachedIdleSeconds()).toBeNull();

		await cacheSettings([{ key: 'posIdleLockSeconds', value: 300 }]);
		expect(await readCachedIdleSeconds()).toBe(300);
	});

	// A tablet moved from restaurant A to restaurant B must not sign A's staff in on
	// B's till from A's cached PIN hashes — and must neither lose nor re-attribute
	// A's unsynced offline records.
	it('drops the cached bundle when the device changes, and never touches offline_logins', async () => {
		expect(await bindDevice('device-A')).toBe('bound');
		await cacheEmployees([employee('a1', await hashPin('1111'))]);
		await cacheSettings([{ key: 'posIdleLockSeconds', value: 300 }]);
		await recordOfflineLogin(login('op-A', '2026-09-15T10:00:00.000Z'));

		// The same device again: nothing changes.
		expect(await bindDevice('device-A')).toBe('unchanged');
		expect(await readCachedEmployees()).toHaveLength(1);
		expect(await readCachedIdleSeconds()).toBe(300);

		// A different device: A's bundle is gone, A's offline record is not.
		expect(await bindDevice('device-B')).toBe('bound');
		expect(await readCachedEmployees()).toEqual([]);
		expect(await verifyCachedPin('a1', '1111')).toBe(false);
		expect(await readCachedIdleSeconds()).toBeNull();
		expect(await readBoundDeviceId()).toBe('device-B');
		const rows = await offlineLogins();
		expect(rows).toHaveLength(1);
		expect(rows[0].deviceId).toBe('device-A');
	});

	// A till the owner REVOKED must stop signing staff in offline the moment the
	// server says so (invariant 12): the bundle goes, the unsynced records stay.
	it('forgets the cached bundle on revocation and keeps the unsynced records', async () => {
		await bindDevice('device-A');
		await cacheEmployees([employee('a1', await hashPin('1111'))]);
		await cacheSettings([{ key: 'posIdleLockSeconds', value: 300 }]);
		await replaceMenu({
			version: 3,
			format: 2,
			restaurantId: 'restaurant-A',
			currency: 'USD',
			currencyExponent: 2,
			taxMode: 'exclusive',
			taxRateBp: 825,
			defaultTaxRate: null,
			categories: [],
			items: [],
			modifierGroups: []
		});
		await recordOfflineLogin(login('op-A', '2026-09-15T10:00:00.000Z'));

		await forgetDevice();

		expect(await readCachedEmployees()).toEqual([]);
		expect(await verifyCachedPin('a1', '1111')).toBe(false);
		expect(await readBoundDeviceId()).toBeNull();
		expect(await readCachedIdleSeconds()).toBeNull();
		expect(await readMenu()).toBeNull();
		expect((await offlineLogins()).map((r) => r.clientOpId)).toEqual(['op-A']);
	});

	// Invariant 5: the unsynced count is always on screen, so it must be exact. A
	// retry that wrote nothing neither counts nor signals.
	it('counts the unsynced records, and signals only when one was added', async () => {
		let signals = 0;
		const stop = onUnsyncedChange(() => signals++);
		expect(await countUnsynced()).toBe(0);

		await recordOfflineLogin(login('op-1', '2026-09-15T10:00:00.000Z'));
		expect([await countUnsynced(), signals]).toEqual([1, 1]);

		await recordOfflineLogin(login('op-1', '2026-09-15T10:00:05.000Z'));
		expect([await countUnsynced(), signals]).toEqual([1, 1]);

		await recordOfflineLogin(login('op-2', '2026-09-15T10:01:00.000Z'));
		expect([await countUnsynced(), signals]).toEqual([2, 2]);

		// Revocation forgets the bundle, never the unsynced work.
		await forgetDevice();
		expect(await countUnsynced()).toBe(2);

		stop();
		await recordOfflineLogin(login('op-3', '2026-09-15T10:02:00.000Z'));
		expect([await countUnsynced(), signals]).toEqual([3, 2]);
	});
});

// A tiny helper for the T-22 tests: put an arbitrary row into a store.
async function putRaw(store: string, value: unknown): Promise<void> {
	await withDb((db) =>
		inTransaction(db, [store], 'readwrite', (tx) => {
			tx.objectStore(store).put(value as never);
		})
	);
}

async function readAll<T>(store: string): Promise<T[]> {
	return await withDb(async (db) => {
		const request = db.transaction(store).objectStore(store).getAll();
		return (await valueOf(request)) as T[];
	});
}

async function openVersionTwo(): Promise<void> {
	// The version-2 layout, as the earlier release shipped it.
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open('matcami-pos', 2);
		request.onupgradeneeded = () => {
			const db = request.result;
			db.createObjectStore('employees', { keyPath: 'id' });
			db.createObjectStore('settings', { keyPath: 'key' });
			db.createObjectStore('offline_logins', { keyPath: 'clientOpId' });
			db.createObjectStore('menu', { keyPath: 'id' });
		};
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction('offline_logins', 'readwrite');
			tx.objectStore('offline_logins').put(login('op-existing-1', '2026-09-01T00:00:00.000Z'));
			tx.objectStore('offline_logins').put(login('op-existing-2', '2026-09-02T00:00:00.000Z'));
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error);
		};
		request.onerror = () => reject(request.error);
	});
}

describe('upgrade 2 -> 3 (T-22)', () => {
	it('creates the four new stores, keeps existing data, marks the seq index unique', async () => {
		await openVersionTwo();
		const before = upgradeRunsForTest();
		const db = await openPosDb();
		try {
			expect(Array.from(db.objectStoreNames).sort()).toEqual([
				'employees',
				'invoice_sequence',
				'menu',
				'offline_logins',
				'orders',
				'session',
				'settings',
				'sync_queue'
			]);
			const queueStore = db.transaction('sync_queue').objectStore('sync_queue');
			const indexNames = Array.from(queueStore.indexNames).sort();
			expect(indexNames).toEqual(['deviceId', 'seq', 'state']);
			expect(queueStore.index('seq').unique).toBe(true);
		} finally {
			db.close();
		}
		expect(upgradeRunsForTest() - before).toBe(1);
		expect(await offlineLogins()).toHaveLength(2);
	});
});

describe('wipes exempt the four new stores (T-22)', () => {
	it('bindDevice and forgetDevice leave orders, sync_queue, invoice_sequence and session alone', async () => {
		await putRaw('orders', {
			id: 'o-1',
			deviceId: 'device-A',
			state: 'completed',
			cart: {}
		} satisfies LocalOrder);
		await putRaw('sync_queue', {
			clientOpId: 'op-1',
			deviceId: 'device-A',
			seq: 1,
			kind: 'sale.complete',
			envelope: {},
			state: 'pending',
			attempts: 0
		} as unknown as QueueEntry);
		await putRaw('invoice_sequence', {
			deviceId: 'device-A',
			invoiceSeq: 7,
			queueSeq: 3
		} satisfies SequenceRow);
		await putRaw('session', {
			deviceId: 'device-A',
			posSessionId: 's-1',
			employeeId: 'e-1',
			openingCashMinor: '50000',
			openedAt: '2026-09-28T08:00:00.000Z',
			state: 'open'
		} satisfies LocalSession);

		await bindDevice('device-A');
		await cacheEmployees([employee('a')]);
		await bindDevice('device-B');
		await forgetDevice();

		expect(await readAll('orders')).toHaveLength(1);
		expect(await readAll('sync_queue')).toHaveLength(1);
		expect(await readAll('invoice_sequence')).toHaveLength(1);
		expect(await readAll('session')).toHaveLength(1);
		expect(await readCachedEmployees()).toEqual([]);
		expect(await readBoundDeviceId()).toBeNull();
	});
});

describe('countUnsynced and countParked (T-22)', () => {
	it('excludes parked from the unsynced total; sending is counted', async () => {
		await recordOfflineLogin(login('op-login-1', '2026-09-28T09:00:00.000Z'));
		await recordOfflineLogin(login('op-login-2', '2026-09-28T09:00:01.000Z'));
		for (const [i, state] of ['pending', 'pending', 'pending', 'parked', 'done'].entries()) {
			await putRaw('sync_queue', {
				clientOpId: `op-q-${i + 1}`,
				deviceId: 'device-A',
				seq: i + 1,
				kind: 'sale.complete',
				envelope: {},
				state,
				attempts: 0
			} as unknown as QueueEntry);
		}
		expect(await countUnsynced()).toBe(5);
		expect(await countParked()).toBe(1);
		await putRaw('sync_queue', {
			clientOpId: 'op-q-sending',
			deviceId: 'device-A',
			seq: 99,
			kind: 'sale.complete',
			envelope: {},
			state: 'sending',
			attempts: 0
		} as unknown as QueueEntry);
		expect(await countUnsynced()).toBe(6);
	});
});

describe('pruneCompletedOrders (T-22)', () => {
	it('removes completed synced orders older than the cutoff and their done queue rows', async () => {
		const now = Date.parse('2026-09-28T12:00:00Z');
		const day = 86_400_000;
		await putRaw('orders', {
			id: 'A',
			deviceId: 'device-A',
			state: 'completed',
			syncedAt: new Date(now - 31 * day).toISOString(),
			cart: {}
		} satisfies LocalOrder);
		await putRaw('orders', {
			id: 'B',
			deviceId: 'device-A',
			state: 'completed',
			syncedAt: new Date(now - 29 * day).toISOString(),
			cart: {}
		} satisfies LocalOrder);
		await putRaw('orders', {
			id: 'C',
			deviceId: 'device-A',
			state: 'completed',
			cart: {}
		} satisfies LocalOrder);
		await putRaw('orders', {
			id: 'D',
			deviceId: 'device-A',
			state: 'cart',
			cart: {}
		} satisfies LocalOrder);
		await putRaw('sync_queue', {
			clientOpId: 'op-A',
			deviceId: 'device-A',
			seq: 1,
			kind: 'sale.complete',
			envelope: { payload: { orderId: 'A' } },
			state: 'done',
			attempts: 1
		} as unknown as QueueEntry);
		await putRaw('sync_queue', {
			clientOpId: 'op-B',
			deviceId: 'device-A',
			seq: 2,
			kind: 'sale.complete',
			envelope: { payload: { orderId: 'B' } },
			state: 'done',
			attempts: 1
		} as unknown as QueueEntry);
		await putRaw('sync_queue', {
			clientOpId: 'op-Aa',
			deviceId: 'device-A',
			seq: 3,
			kind: 'sale.abandoned',
			envelope: { payload: { orderId: 'A' } },
			state: 'done',
			attempts: 1
		} as unknown as QueueEntry);
		const removed = await pruneCompletedOrders(30, now);
		expect(removed).toBe(1);
		const remainingOrders = (await readAll<LocalOrder>('orders')).map((o) => o.id).sort();
		expect(remainingOrders).toEqual(['B', 'C', 'D']);
		const remainingQueue = (await readAll<QueueEntry>('sync_queue'))
			.map((q) => q.clientOpId)
			.sort();
		expect(remainingQueue).toEqual(['op-B']);
	});
});

describe('a menu snapshot that fails to parse (menu-and-printing T-15)', () => {
	const goodItem = {
		id: 'i1',
		categoryId: null,
		imageId: null,
		name: 'Tea',
		priceMinor: '850',
		taxRateBp: null,
		isAvailable: true,
		sortOrder: 0,
		modifierGroupIds: []
	};
	const snapshotPayload = (version: number, items: unknown[]) => ({
		version,
		format: 2,
		restaurantId: 'restaurant-A',
		takenAt: '2026-09-29T09:00:00.000Z',
		currency: 'USD',
		currencyExponent: 2,
		taxMode: 'exclusive',
		taxRateBp: 1000,
		categories: [],
		items,
		modifierGroups: []
	});
	const serverAt = (version: number, items: unknown[]) =>
		(async (url: string) =>
			new Response(
				JSON.stringify(
					url === '/api/menu/version'
						? { version, restaurantId: 'restaurant-A' }
						: snapshotPayload(version, items)
				),
				{ status: 200 }
			)) as unknown as typeof fetch;

	it('is remembered while the old menu is kept, and a good sync clears it', async () => {
		await replaceMenu(parseSnapshot(snapshotPayload(7, [goodItem])));
		expect(await readMenuSyncError()).toBeNull();

		// A newer version whose item carries a JSON number where money must be a string.
		await expect(syncMenu(serverAt(8, [{ ...goodItem, priceMinor: 900 }]))).rejects.toThrow(
			/priceMinor/
		);
		expect((await readMenu())!.version).toBe(7);
		expect(await readMenuSyncError()).toMatch(/items\[0\]\.priceMinor/);

		expect(await syncMenu(serverAt(8, [goodItem]))).toBe('replaced');
		expect((await readMenu())!.version).toBe(8);
		expect(await readMenuSyncError()).toBeNull();
	});

	it('is cleared by an up-to-date answer as well', async () => {
		await replaceMenu(parseSnapshot(snapshotPayload(7, [goodItem])));
		await expect(syncMenu(serverAt(8, [{ ...goodItem, priceMinor: 900 }]))).rejects.toThrow();
		expect(await readMenuSyncError()).not.toBeNull();

		// The server went back to the version this till holds.
		expect(await syncMenu(serverAt(7, [goodItem]))).toBe('up-to-date');
		expect(await readMenuSyncError()).toBeNull();
	});
});
