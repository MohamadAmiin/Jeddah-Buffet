import { expect, test } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import { DEVICE_COOKIE } from '../src/lib/server/auth/pos-device';
import {
	TILL_URL,
	createCashier,
	pickEmployee,
	registerDevice,
	registerRestaurant,
	signIn
} from './fixtures';

// THE POS ACCESS JOURNEY (spec 7; invariants 8 and 12): the owner registers the
// till FROM the till, the till's dashboard session is destroyed, and a cashier
// signs in with a PIN.
//
// A NEW FILE, deliberately, not an extension of auth.spec.ts: that journey ends
// signed out, after a second company has signed up in another context, so
// grafting this one onto its end means signing back in first and pushes one test
// past 400 lines — where a failure anywhere in the auth half hides the POS half.
// Two files stay independently diagnosable, and both take the same cross-process
// run lock (acquireRunLock) before truncating matcami_test, so they can run
// together.
//
// Runs against the PRODUCTION BUILD (pnpm build && pnpm preview), in the
// configuration that ships: the till's context does NOT block service workers.

const OWNER = {
	name: 'The Till Cafe',
	email: 'owner@till.test',
	password: 'a strong enough password'
};

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeResetPool();
});

test('the owner registers the till from the till, and a cashier signs in with a PIN', async ({
	page,
	browser
}) => {
	// ── 1. register; a fresh restaurant has completed NONE of the six steps ──────
	await registerRestaurant(page, OWNER);
	// Six, not five: registration leaves the idle lock, tax mode, tax rate and
	// currency unset (T-08, T-36), and nothing has created an employee, a device, a
	// menu item, a table or a session. `exact`: each step renders the phrase twice.
	await expect(page.getByText('not started', { exact: true })).toHaveCount(6);

	// ── 2. the POS page, reached by its rail LABEL, shows no device ─────────────
	// The label is POS and the href is /device, on purpose (T-30): /pos belongs to
	// the till, and no dashboard route may begin with "pos" (T-45 step 8).
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'POS device', exact: true })
		.click();
	await expect(page).toHaveURL(/\/device$/);
	await expect(page.getByText('POS1')).toHaveCount(0);

	// ── 3. the till: its own context, with the shipped service worker ───────────
	const till = await browser.newContext();
	const tillPage = await till.newPage();
	await tillPage.goto(TILL_URL);
	// Registration is asynchronous: wait once, so a later load cannot race an
	// activating worker.
	await tillPage.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	// A REAL dashboard session on the counter device — step 5 proves it is destroyed.
	await signIn(tillPage, OWNER);

	// ── 4. register the device ──────────────────────────────────────────────────
	await registerDevice(tillPage, OWNER);
	const deviceCookie = (await till.cookies()).find((c) => c.name === DEVICE_COOKIE);
	expect(deviceCookie, 'the device cookie should exist').toBeDefined();
	expect(deviceCookie!.httpOnly).toBe(true);
	expect(deviceCookie!.sameSite).toBe('Lax');
	// localhost is exempt from the secure-context rule, which is why Secure is
	// asserted only over https — never dropped to make local testing easier.
	if (new URL(tillPage.url()).protocol === 'https:') {
		expect(deviceCookie!.secure).toBe(true);
	}
	// Invariant 12: no token of any kind in client-readable storage.
	const storage = await tillPage.evaluate(() => ({
		local: Object.entries(localStorage).map(([k, v]) => `${k}=${v}`),
		session: Object.entries(sessionStorage).map(([k, v]) => `${k}=${v}`)
	}));
	for (const entries of [storage.local, storage.session]) {
		expect(entries.join('|')).not.toMatch(new RegExp(`${DEVICE_COOKIE}|session`, 'i'));
	}

	// ── 5. the dashboard session on that device is GONE ────────────────────────
	expect(
		(await till.cookies()).find((c) => c.name === 'matcami_dashboard_session')
	).toBeUndefined();
	await tillPage.goto('/dashboard');
	await expect(tillPage).toHaveURL(/\/login\?next=/);
	// The owner's own session, in the office, is untouched.
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/dashboard$/);
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'POS device', exact: true })
		.click();
	await expect(page.getByText('POS1')).toBeVisible();

	// ── 6. the cashier, then a PIN sign-in at the till ─────────────────────────
	await createCashier(page, { displayName: 'The Cashier', pin: '654321' });
	await tillPage.goto(TILL_URL);
	await pickEmployee(tillPage, 'The Cashier');
	const pinScreen = tillPage.url();

	// A wrong PIN first, TYPED on the hardware keyboard after one tap: digits,
	// Backspace and Enter do what the keys on the screen do — and Enter signs in
	// even though the tapped key still has focus (it must not tap that key again).
	await tillPage.getByRole('button', { name: '9', exact: true }).click();
	await tillPage.keyboard.type('9998');
	await expect(tillPage.getByText('5 digits entered')).toBeAttached();
	await tillPage.keyboard.press('Backspace');
	await expect(tillPage.getByText('4 digits entered')).toBeAttached();
	await tillPage.keyboard.press('Enter');
	// An error, and the till does not move.
	await expect(tillPage.getByRole('alert')).toContainText('That PIN is not right');
	await expect(tillPage.getByText('0 digits entered')).toBeAttached();
	// Escape clears what was typed.
	await tillPage.keyboard.type('12');
	await expect(tillPage.getByText('2 digits entered')).toBeAttached();
	await tillPage.keyboard.press('Escape');
	await expect(tillPage.getByText('0 digits entered')).toBeAttached();
	expect(tillPage.url()).toBe(pinScreen);

	// A wrong PIN of the full six digits is checked at the sixth digit, with no
	// Sign in and no Enter.
	await tillPage.keyboard.type('999999');
	// The attempt has been answered once the digits are cleared again.
	await expect(tillPage.getByText('0 digits entered')).toBeAttached();
	await expect(tillPage.getByRole('alert')).toContainText('That PIN is not right');
	expect(tillPage.url()).toBe(pinScreen);

	// The right one: the sixth digit signs in by itself.
	await tillPage.keyboard.type('654321');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByTestId('till-employee')).toContainText('The Cashier · Cashier');

	// ── 7. the checklist moved by EXACTLY one step: six minus one ──────────────
	// Only "Register the POS device" was completed here. Settings still lack the
	// idle lock, tax and currency; Employees is ready after one cashier with a PIN; there is
	// no menu item; tables and POS sessions are not built in this plan.
	await page.goto('/dashboard');
	await expect(page.getByText('not started', { exact: true })).toHaveCount(4);

	await till.close();
});
