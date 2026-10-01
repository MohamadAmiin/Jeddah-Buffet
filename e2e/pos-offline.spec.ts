import { expect, test } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import {
	TILL_URL,
	closeDbRows,
	createEmployee,
	dbRows,
	enterPin,
	pickEmployee,
	registerDevice,
	registerRestaurant,
	signIn,
	storeRows
} from './fixtures';

// THE OFFLINE PIN LOGIN (spec 6 and 7; invariants 5, 10 and 12).
//
// The sales plan (tasks/pos-sales, T-25) built the flush of offline_logins through
// POST /api/pos/sync as `pin.login` ops. This spec therefore asserts BOTH halves:
// the local half (verification against cached hashes, the locally stored record,
// idempotency at the local store — step 9) and, from step 10, the server half:
//   1. coming back online writes exactly one audit_log row per offline login —
//      pos.pin.offline_success or pos.pin.offline_failed — under the device the
//      record was stamped with and at the record's own occurredAt;
//   2. flushing again, and replaying the same envelope, writes none;
//   3. after a revoke and a re-registration as POS2, a new offline login syncs
//      under POS2's device_id while the old rows keep POS1's.
// MANDATORY (spec 29 — offline sync: retries never create duplicates).
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
	synced: boolean;
};

declare global {
	interface Window {
		__persistCalls: number;
	}
}

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeDbRows();
	await closeResetPool();
});

test('the till signs employees in offline from cached hashes, and a retry never duplicates', async ({
	page,
	browser
}) => {
	// PBKDF2 at 600,000 iterations runs on every PIN, online and offline.
	test.setTimeout(180_000);

	// ── 1. three employees: switching between them is what is under test ────────
	await registerRestaurant(page, OWNER);
	await createEmployee(page, { displayName: 'The Cashier', role: 'cashier', pin: '4321' });
	await createEmployee(page, { displayName: 'The Waiter', role: 'waiter', pin: '5678' });
	await createEmployee(page, { displayName: 'The Runner', role: 'waiter', pin: '6789' });
	// The idle lock: without it the till never restores a signed-in employee on
	// reload (T-26), and step 7's reload is exactly that restore.
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'POS device', exact: true })
		.click();
	await expect(page).toHaveURL(/\/device$/);
	await page.getByLabel('Auto-lock after (seconds)').fill('120');
	await page.getByRole('button', { name: 'Save auto-lock' }).click();
	await expect(page.getByRole('alert')).toContainText('Auto-lock saved.');
	// Leave /device: step 11 reaches it again by its rail link and needs a fresh load.
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'Overview', exact: true })
		.click();

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
	// Wait for it: the first IndexedDB open (which asks to persist) can come from
	// the till bar's own reads, before the employee directory has been written.
	await expect.poll(async () => (await storeRows(tillPage, 'employees')).length).toBe(4);
	const bundle = await storeRows<{
		id: string;
		displayName: string;
		isOwner: boolean;
		roleName: string;
		permissions: string[];
		isActive: boolean;
		pinPhc: string | null;
	}>(tillPage, 'employees');
	const byName = new Map(bundle.map((e) => [e.displayName, e]));
	// The owner is on the till's list too (T-15), so the bundle is four long.
	expect(bundle).toHaveLength(4);

	for (const name of ['The Cashier', 'The Waiter', 'The Runner']) {
		const employee = byName.get(name);
		expect(employee?.roleName).toBe(name === 'The Cashier' ? 'Cashier' : 'Waiter');
		expect(employee?.isOwner).toBe(false);
		expect(employee?.permissions).toEqual(
			name === 'The Cashier'
				? [
						'pos.sell',
						'pos.payment',
						'pos.print_receipt',
						'pos.void_unsent_item',
						'pos.cash_payout'
					]
				: [
						'pos.create_order',
						'pos.view_menu',
						'pos.modify_order',
						'pos.send_to_kitchen',
						'pos.transfer_table'
					]
		);
	}

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
	await expect(tillPage).toHaveURL(/\/pos\/pin/);

	// ── 5. still online, The Cashier signs in — the panel we go offline from ────
	await tillPage.goto(TILL_URL);
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByTestId('till-employee')).toContainText('The Cashier · Cashier');
	// Online attempts are the server's to record: nothing is waiting on the till.
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'0 unsynced'
	);

	// ── 6. OFFLINE: the fallback fires, and the failed request is the proof ─────
	const failedPinRequests: string[] = [];
	tillPage.on('requestfailed', (request) => {
		if (request.url().includes('/api/pos/pin')) failedPinRequests.push(request.url());
	});
	await till.setOffline(true);
	// Landing on /pos IS signing out; offline, the worker's shell answers it.
	await tillPage.goto(TILL_URL);
	await expect(tillPage.getByText('this is the staff list saved on this device')).toBeVisible();

	await pickEmployee(tillPage, 'The Waiter');
	// Only the cached hash can produce this verdict with no network.
	await enterPin(tillPage, '0000');
	await expect(tillPage.getByRole('alert')).toContainText('That PIN is not right');
	// Invariant 5: the unsynced count is on screen, and it moved with no reload.
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'1 unsynced'
	);
	await enterPin(tillPage, '5678');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByTestId('till-employee')).toContainText('The Waiter · Waiter');
	// The till ATTEMPTED the network and caught the throw — never assert the
	// opposite: a till that short-circuited on navigator.onLine would make the
	// online half above unreachable.
	expect(failedPinRequests.length).toBeGreaterThanOrEqual(1);

	// A second offline switch, wrong PIN then right, back to The Cashier.
	await tillPage.goto(TILL_URL);
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '0000');
	await expect(tillPage.getByRole('alert')).toContainText('That PIN is not right');
	await enterPin(tillPage, '4321');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByTestId('till-employee')).toContainText('The Cashier · Cashier');

	// ── 7. the offline session survives a reload ──────────────────────────────
	// Spec 6's actual guarantee: a till that dies on refresh is not an offline till.
	await tillPage.reload();
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'Offline'
	);
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'4 unsynced'
	);
	await expect(tillPage.getByRole('heading', { name: 'Who is signing in?' })).toHaveCount(0);
	await expect(tillPage.getByTestId('till-employee')).toContainText('The Cashier · Cashier');

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

	// ── 10. back online: every offline login lands in audit_log exactly once ───
	const pinBodies: string[] = [];
	tillPage.on('request', (r) => {
		if (r.method() === 'POST' && r.url().endsWith('/api/pos/sync'))
			pinBodies.push(r.postData() ?? '');
	});
	await till.setOffline(false);
	await tillPage.goto(TILL_URL);
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'0 unsynced'
	);
	const auditRows = await dbRows<{
		client_op_id: string;
		event: string;
		device_id: string;
		occurred_at_iso: string;
	}>(
		`select client_op_id, event, device_id,
			to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at_iso
		 from audit_log where client_op_id = any($1::text[]) order by client_op_id`,
		[records.map((r) => r.clientOpId)]
	);
	expect(auditRows).toHaveLength(records.length);
	for (const record of records) {
		const matching = auditRows.filter((row) => row.client_op_id === record.clientOpId);
		expect(matching).toHaveLength(1);
		expect(matching[0].event).toBe(
			record.outcome === 'success' ? 'pos.pin.offline_success' : 'pos.pin.offline_failed'
		);
		expect(matching[0].device_id).toBe(record.deviceId);
		expect(matching[0].occurred_at_iso).toBe(record.occurredAt);
	}
	const offlinePinRows = () =>
		dbRows<{ n: string }>(
			"select count(*)::text as n from audit_log where event in ('pos.pin.offline_success', 'pos.pin.offline_failed')"
		).then((rows) => rows[0].n);
	expect(await offlinePinRows()).toBe('4');

	// MANDATORY (spec 29): a reload flush, an online-event flush and a byte-identical
	// replay each leave audit_log exactly as it is.
	const auditCount = () =>
		dbRows<{ n: string }>('select count(*)::text as n from audit_log').then((rows) => rows[0].n);
	const before = await auditCount();
	await tillPage.reload();
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'0 unsynced'
	);
	expect(await auditCount()).toBe(before);
	await till.setOffline(true);
	await till.setOffline(false);
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'0 unsynced'
	);
	expect(await auditCount()).toBe(before);
	const pinBody = pinBodies.find((b) => b.includes('"pin.login"'));
	expect(pinBody).toBeDefined();
	const replayed = await tillPage.evaluate(
		(b) =>
			fetch('/api/pos/sync', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: b
			}).then((r) => r.json()),
		pinBody!
	);
	expect(replayed.status).toBe('replayed');
	expect(await auditCount()).toBe(before);

	// ── 11. REVOKED: the till forgets its bundle and refuses offline sign-ins ───
	// Invariant 12: the owner can revoke the device. Once the server has told the
	// till so, it must not go on signing staff in offline from the PIN hashes it
	// still holds. The accepted stolen-tablet GAP covers a till that never
	// reconnects, not one that has been told. The unsynced records stay.
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'POS device', exact: true })
		.click();
	await page.getByText('Revoke this device…').click();
	await page.getByRole('button', { name: 'Revoke device' }).click();
	await expect(page.getByRole('alert')).toContainText('Device revoked');

	await tillPage.goto(TILL_URL);
	await expect(tillPage.getByRole('alert')).toContainText('registration was revoked');
	expect(await storeRows(tillPage, 'employees')).toEqual([]);

	await tillPage.goto(`/pos/pin?employee=${idOf('The Cashier')}`);
	// The bundle is forgotten, so the screen cannot name who the PIN is for.
	await expect(tillPage.getByRole('heading', { name: /^Enter the PIN\b/ })).toBeVisible();
	await till.setOffline(true);
	await enterPin(tillPage, '4321');
	await expect(tillPage.getByRole('alert')).toContainText('cannot check a PIN offline');
	await expect(tillPage.getByRole('heading', { name: /Signed in/ })).toHaveCount(0);
	// Flushed in step 10 and marked synced, never removed; the refused attempt added none.
	expect(
		(await storeRows<OfflineRecord>(tillPage, 'offline_logins')).filter((r) => r.synced === false)
	).toHaveLength(0);
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'0 unsynced'
	);

	// ── 12. re-registered as POS2: a new offline login syncs under POS2 ────────
	await till.setOffline(false);
	await registerDevice(tillPage, OWNER, 'Second tablet');
	const devices = await dbRows<{ id: string; device_code: string }>(
		'select id, device_code from pos_devices order by registered_at'
	);
	expect(devices.map((d) => d.device_code)).toEqual(['POS1', 'POS2']);
	const [pos1Id, pos2Id] = devices.map((d) => d.id);

	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await till.setOffline(true);
	await tillPage.goto(TILL_URL);
	await pickEmployee(tillPage, 'The Waiter');
	await enterPin(tillPage, '5678');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'1 unsynced'
	);
	const newRecords = (await storeRows<OfflineRecord>(tillPage, 'offline_logins')).filter(
		(r) => r.synced === false
	);
	expect(newRecords).toHaveLength(1);
	expect(newRecords[0].deviceId).toBe(pos2Id);

	await till.setOffline(false);
	await expect(tillPage.getByRole('status', { name: 'Connection and sync' })).toContainText(
		'0 unsynced'
	);
	const deviceOf = async (clientOpId: string) =>
		(
			await dbRows<{ device_id: string }>(
				'select device_id from audit_log where client_op_id = $1',
				[clientOpId]
			)
		).map((r) => r.device_id);
	expect(await deviceOf(newRecords[0].clientOpId)).toEqual([pos2Id]);
	for (const record of records) expect(await deviceOf(record.clientOpId)).toEqual([pos1Id]);
	expect(await offlinePinRows()).toBe('5');

	await till.close();
});
