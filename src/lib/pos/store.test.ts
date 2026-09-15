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
	forgetDevice,
	openPosDb,
	readBoundDeviceId,
	readCachedEmployees,
	readCachedIdleSeconds,
	readCachedSetting,
	readMenu,
	recordOfflineLogin,
	replaceMenu,
	upgradeRunsForTest,
	verifyCachedPin,
	type CachedEmployee,
	type OfflineLogin
} from './store';

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
	return { id, displayName: `Employee ${id}`, role: 'cashier', isActive: true, pinPhc };
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
		await cacheEmployees([employee('a'), employee('b'), employee('c')]);
		expect(await readCachedEmployees()).toHaveLength(3);

		await cacheEmployees([employee('a'), employee('b')]);
		const ids = (await readCachedEmployees()).map((e) => e.id).sort();
		expect(ids).toEqual(['a', 'b']);
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
			restaurantId: 'restaurant-A',
			currency: 'USD',
			currencyExponent: 2,
			taxMode: 'exclusive',
			taxRateBp: 825,
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
});
