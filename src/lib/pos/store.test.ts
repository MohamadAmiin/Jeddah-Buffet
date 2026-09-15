// The unit project runs in `node`, which has no indexedDB: fake-indexeddb (a pinned
// devDependency) provides the global for THIS file only. The dedupe it tests is
// the real add()/ConstraintError behaviour, not a re-implementation of it.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { hashPin } from '../pin';
import {
	cacheEmployees,
	cacheSettings,
	openPosDb,
	readCachedEmployees,
	readCachedIdleSeconds,
	readCachedSetting,
	recordOfflineLogin,
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
});
