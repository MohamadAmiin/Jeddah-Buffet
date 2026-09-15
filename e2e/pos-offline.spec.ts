import { expect, test, type Page } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import {
	TILL_URL,
	createEmployee,
	enterPin,
	pickEmployee,
	registerDevice,
	registerRestaurant,
	signIn
} from './fixtures';

// THE OFFLINE PIN LOGIN (spec 6 and 7; invariants 5, 10 and 12).
//
// THIS PLAN DOES NOT BUILD THE SALES SYNC QUEUE OR ITS FLUSH — the gap is
// deliberate, not forgotten. Nothing here posts a locally recorded offline login
// back to the server, so this spec asserts none of the three flush behaviours,
// which are the SALES PLAN's obligation (and recorded as such by T-47):
//   1. coming back online writes exactly one audit_log row per offline login;
//   2. replaying the same idempotency key into audit_log.client_op_id writes none;
//   3. a record is sent only under the device it is stamped with.
// What IS asserted is the half this plan built: verification against the hashes
// cached on the device, the locally stored record, and idempotency AT THE LOCAL
// STORE — a real "a retry never duplicates" assertion on a real layer.
//
// Spellings are the CODE's (src/lib/pos/store.ts): the cached hash is `pinPhc`
// (not pinHash — the name is a tripwire against the audit writer), the record's
// key is `clientOpId` (camelCase; `client_op_id` is the audit_log COLUMN), and
// each record also carries the `deviceId` it was made on.

const OWNER = {
	name: 'The Offline Cafe',
	email: 'owner@offline.test',
	password: 'a strong enough password'
};

type OfflineRecord = {
	clientOpId: string;
	deviceId: string;
	employeeId: string;
	event: string;
	occurredAt: string;
	outcome: 'success' | 'failed';
	synced: false;
};

declare global {
	interface Window {
		__persistCalls: number;
	}
}

/** Every row of one store in the till's IndexedDB, read inside the page. */
function storeRows<T>(tillPage: Page, store: string): Promise<T[]> {
	return tillPage.evaluate(
		(name) =>
			new Promise<T[]>((resolve, reject) => {
				const open = indexedDB.open('matcami-pos');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const request = db.transaction(name).objectStore(name).getAll();
					request.onsuccess = () => {
						db.close();
						resolve(request.result as T[]);
					};
					request.onerror = () => reject(request.error);
				};
			}),
		store
	);
}

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeResetPool();
});

test('the till signs employees in offline from cached hashes, and a retry never duplicates', async ({
	page,
	browser
}) => {
	// ── 1. three employees: switching between them is what is under test ────────
	await registerRestaurant(page, OWNER);
	await createEmployee(page, { displayName: 'The Cashier', role: 'cashier', pin: '4321' });
	await createEmployee(page, { displayName: 'The Waiter', role: 'waiter', pin: '5678' });
	await createEmployee(page, { displayName: 'The Runner', role: 'waiter', pin: '6789' });

	// ── 2. the till, with the persistence request COUNTED before the first load ──
	const till = await browser.newContext();
	await till.addInitScript(() => {
		window.__persistCalls = 0;
		const storage = navigator.storage;
		if (!storage?.persist) return;
		// The real method lives on StorageManager.prototype: bind it, then shadow it.
		const original = storage.persist.bind(storage);
		Object.defineProperty(storage, 'persist', {
			configurable: true,
			value: () => {
				window.__persistCalls += 1;
				return original();
			}
		});
	});
	const tillPage = await till.newPage();
	await signIn(tillPage, OWNER);
	await registerDevice(tillPage, OWNER);
	await tillPage.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

	// Spec 6 requires the till to ASK. Whether Chromium GRANTS it is browser policy —
	// a fresh context has no engagement — so the grant is reported, not asserted.
	// Polled: the first IndexedDB open — which is what asks — follows the directory fetch.
	await expect.poll(() => tillPage.evaluate(() => window.__persistCalls)).toBeGreaterThanOrEqual(1);
	test.info().annotations.push({
		type: 'persisted',
		description: String(await tillPage.evaluate(() => navigator.storage.persisted()))
	});

	// ── 3. the bundle landed, and holds no plaintext PIN ───────────────────────
	const bundle = await storeRows<{ id: string; displayName: string; pinPhc: string | null }>(
		tillPage,
		'employees'
	);
	const byName = new Map(bundle.map((e) => [e.displayName, e]));
	// The owner is on the till's list too (T-15), so the bundle is four long.
	expect(bundle).toHaveLength(4);
	for (const name of ['The Cashier', 'The Waiter', 'The Runner']) {
		expect(typeof byName.get(name)?.pinPhc).toBe('string');
	}
	// The ids are left out: a uuid's hex digits contain "4321" by chance often
	// enough to flake, and an id is not where a plaintext PIN would be written.
	const serialised = JSON.stringify(
		bundle.map((e) => Object.entries(e).filter(([key]) => key !== 'id'))
	);
	for (const pin of ['4321', '5678', '6789']) expect(serialised).not.toContain(pin);

	// ── 4. ONLINE: a server rejection is never retried against the cache ───────
	// Five wrong PINs lock The Runner (T-12, T-19: the fifth answers 423).
	await pickEmployee(tillPage, 'The Runner');
	for (let attempt = 0; attempt < 5; attempt++) await enterPin(tillPage, '0000');
	await expect(tillPage.getByRole('alert')).toContainText('Locked after 5 wrong attempts');
	// A reload forgets the on-screen countdown; the SERVER still holds the lock. The
	// cached hash says 6789 is right, so a till that fell back to the cache on a
	// server ANSWER would sign The Runner in here — an unlimited-guesses bypass of
	// the five-attempts rule. This is the one assertion that would catch it.
	await tillPage.reload();
	await enterPin(tillPage, '6789');
	await expect(tillPage.getByRole('alert')).toContainText('Locked after 5 wrong attempts');
	await expect(tillPage.getByRole('heading', { name: /Signed in/ })).toHaveCount(0);

	// ── 5. still online, The Cashier signs in — the panel we go offline from ────
	await tillPage.goto(TILL_URL);
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await expect(tillPage.getByRole('heading', { name: /Signed in as The Cashier/ })).toBeVisible();

	// ── 6. OFFLINE: the fallback fires, and the failed request is the proof ────
	const failedPinRequests: string[] = [];
	tillPage.on('requestfailed', (request) => {
		if (request.url().includes('/api/pos/pin')) failedPinRequests.push(request.url());
	});
	await till.setOffline(true);
	// Client-side navigation only, from here on: the screens are already loaded.
	await tillPage.getByRole('button', { name: 'Back to employee select' }).click();
	await expect(tillPage.getByText('this is the staff list saved on this device')).toBeVisible();

	await pickEmployee(tillPage, 'The Waiter');
	// Only the cached hash can produce this verdict with no network.
	await enterPin(tillPage, '0000');
	await expect(tillPage.getByRole('alert')).toContainText('That PIN is not right');
	await enterPin(tillPage, '5678');
	await expect(tillPage.getByRole('heading', { name: /Signed in as The Waiter/ })).toBeVisible();
	// The till ATTEMPTED the network and caught the throw — never assert the
	// opposite: a till that short-circuited on navigator.onLine would make the
	// online half above unreachable.
	expect(failedPinRequests.length).toBeGreaterThanOrEqual(1);

	// A second offline switch, wrong PIN then right, back to The Cashier.
	await tillPage.getByRole('button', { name: 'Back to employee select' }).click();
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '0000');
	await expect(tillPage.getByRole('alert')).toContainText('That PIN is not right');
	await enterPin(tillPage, '4321');
	await expect(tillPage.getByRole('heading', { name: /Signed in as The Cashier/ })).toBeVisible();

	// ── 7. the offline session survives a reload ──────────────────────────────
	// Spec 6's actual guarantee: a till that dies on refresh is not an offline till.
	await tillPage.reload();
	await expect(tillPage.getByRole('status')).toContainText('Offline');

	// ── 8. every offline attempt was recorded locally, with its own key ────────
	const records = await storeRows<OfflineRecord>(tillPage, 'offline_logins');
	const idOf = (name: string) => byName.get(name)!.id;
	const successes = records.filter((r) => r.outcome === 'success');
	expect(successes.map((r) => r.employeeId).sort()).toEqual(
		[idOf('The Waiter'), idOf('The Cashier')].sort()
	);
	// A wrong PIN offline is recorded too (invariant 10 names failed PINs; the phase-4
	// review's blocker, fixed in T-28's follow-up).
	const failures = records.filter((r) => r.outcome === 'failed');
	expect(failures).toHaveLength(2);
	expect(failures.every((r) => r.event === 'pos.pin.failed')).toBe(true);
	for (const record of records) {
		expect(record.clientOpId.length).toBeGreaterThan(0);
		expect(record.deviceId.length).toBeGreaterThan(0);
		expect(new Date(record.occurredAt).toISOString()).toBe(record.occurredAt);
		expect(record.synced).toBe(false);
	}
	// A device-generated id that repeats is not an idempotency key.
	expect(new Set(records.map((r) => r.clientOpId)).size).toBe(records.length);

	// ── 9. MANDATORY (spec 29 — offline retries never create duplicates) ──────
	// A retried write of the SAME clientOpId, byte-identical, through add() — never
	// put(), which would overwrite silently and look identical in a row count.
	const retried = records[0];
	const retry = await tillPage.evaluate(
		(record) =>
			new Promise<string>((resolve) => {
				const open = indexedDB.open('matcami-pos');
				open.onsuccess = () => {
					const db = open.result;
					const tx = db.transaction('offline_logins', 'readwrite');
					const request = tx.objectStore('offline_logins').add(record);
					request.onerror = (event) => {
						event.preventDefault();
						resolve(request.error?.name ?? 'unknown');
					};
					request.onsuccess = () => resolve('written');
					tx.oncomplete = () => db.close();
					tx.onabort = () => db.close();
				};
			}),
		retried
	);
	expect(retry).toBe('ConstraintError');
	const afterRetry = await storeRows<OfflineRecord>(tillPage, 'offline_logins');
	expect(afterRetry).toHaveLength(records.length);
	expect(afterRetry.find((r) => r.clientOpId === retried.clientOpId)!.occurredAt).toBe(
		retried.occurredAt
	);

	// ── 10. back online: unsynced work is never discarded (invariant 5) ────────
	await till.setOffline(false);
	await tillPage.goto(TILL_URL);
	expect(await storeRows<OfflineRecord>(tillPage, 'offline_logins')).toHaveLength(records.length);

	await till.close();
});
