import { expect, test } from '@playwright/test';
import { resetDb, closeResetPool, acquireRunLock } from '../src/lib/server/db/test/reset';
import { E2E_SETUP_TOKEN } from '../playwright.config';

// DATABASE CHOICE, stated as the task requires: this spec runs against the TEST
// database (matcami_test), not development data. playwright.config.ts points the
// preview server's DATABASE_URL at TEST_DATABASE_URL and fixes SETUP_TOKEN, and
// the reset below clears it. That is necessary because the first step of the
// journey only works when ZERO restaurants exist — running against development
// data would either fail or destroy it.
//
// Runs against the PRODUCTION BUILD. SvelteKit's origin check is inert under
// `vite dev`, so a dev-server run would prove nothing about the CSRF behaviour
// invariant 12 depends on, and service workers — which the POS will need — do not
// exist there either.
//
// ONE test with sequential steps, not several sharing state through the database:
// the journey is order-dependent by nature, and independent tests that secretly
// depend on execution order are the flakiest thing a suite can contain.

const RESTAURANT = 'The E2E Cafe';
const RENAMED = 'The E2E Bistro';
const EMAIL = 'owner@e2e.test';
const PASSWORD = 'a strong enough password';

test.beforeAll(async () => {
	// Wait for any concurrent integration run: both share matcami_test and both
	// truncate it. Without this, a simultaneous `pnpm test` makes this journey fail
	// at step 2 with "Registration is closed: a restaurant already exists" — a
	// symptom that points nowhere near the cause.
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeResetPool();
});

test('the owner registers, works, signs out and signs back in', async ({ page, context }) => {
	// ── 1. /register is reachable, because no restaurant exists ────────────────
	await page.goto('/register');
	await expect(page.getByRole('heading', { name: 'Set up your restaurant' })).toBeVisible();

	// ── 2. submit with a valid setup token, and land on /dashboard ─────────────
	await page.getByLabel('Restaurant name').fill(RESTAURANT);
	await page.getByLabel('Time zone').fill('Africa/Mogadishu');
	await page.getByLabel('Your name').fill('The Owner');
	await page.getByLabel('Email').fill(EMAIL);
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Confirm password').fill(PASSWORD);
	await page.getByLabel('Setup token').fill(E2E_SETUP_TOKEN);
	await page.getByRole('button', { name: 'Create restaurant' }).click();

	await expect(page).toHaveURL(/\/dashboard$/);

	// ── 3. the overview shows the restaurant and the checklist ─────────────────
	await expect(page.getByRole('heading', { name: RESTAURANT })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Getting set up' })).toBeVisible();
	// The settings step is done; the other five are not started. `exact` matters:
	// each step renders the phrase twice — a visible badge and a screen-reader-only
	// " — not started" — so a loose match counts ten.
	await expect(page.getByText('Restaurant settings')).toBeVisible();
	await expect(page.getByText('not started', { exact: true })).toHaveCount(5);

	// ── 4. the session token is NOT in browser storage (invariant 12) ──────────
	// Only a real browser can confirm this, which is why it is asserted here.
	const storage = await page.evaluate(() => ({
		local: Object.entries(localStorage).map(([k, v]) => `${k}=${v}`),
		session: Object.entries(sessionStorage).map(([k, v]) => `${k}=${v}`)
	}));
	expect(storage.local.join('|')).not.toMatch(/matcami_dashboard_session|session/i);
	expect(storage.session.join('|')).not.toMatch(/matcami_dashboard_session|session/i);

	// ── 5. the cookie's flags ──────────────────────────────────────────────────
	const cookie = (await context.cookies()).find((c) => c.name === 'matcami_dashboard_session');
	expect(cookie, 'the session cookie should exist').toBeDefined();
	expect(cookie!.httpOnly).toBe(true);
	expect(cookie!.sameSite).toBe('Lax');
	expect(cookie!.path).toBe('/');
	// On http://localhost SvelteKit deliberately omits Secure — it is set for every
	// other origin. Asserted conditionally rather than absolutely.
	// PRODUCTION MUST BE HTTPS: a Secure cookie delivered over plain HTTP from any
	// non-localhost origin is discarded by the browser, which produces a silent
	// endless login loop. See docs/deployment.md.
	if (new URL(page.url()).protocol === 'https:') {
		expect(cookie!.secure).toBe(true);
	}

	// ── 6. change the restaurant name in settings, and see it in the header ────
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Restaurant settings' })).toBeVisible();
	await page.getByLabel('Restaurant name').fill(RENAMED);
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('alert')).toContainText('Settings saved.');
	await expect(page.getByRole('heading', { name: RENAMED })).toBeVisible();

	// ── 7. sign out, landing on /login ─────────────────────────────────────────
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);

	// ── 8. /dashboard now redirects to /login WITH a next parameter ────────────
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/login\?next=/);

	// ── 9. sign in with the same credentials, landing on /dashboard ────────────
	await page.getByLabel('Email').fill(EMAIL);
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();

	await expect(page).toHaveURL(/\/dashboard$/);
	await expect(page.getByRole('heading', { name: RENAMED })).toBeVisible();

	// ── 10. GET /logout is refused over REAL HTTP ──────────────────────────────
	// Asserted here because only a real request proves the status. Before the
	// explicit 405 load, a signed-in GET returned 500 with
	// "Missing +page.svelte component for route /logout" in the server log.
	const logoutGet = await page.request.get('/logout');
	expect(logoutGet.status()).toBe(405);
	// ...and the session still works afterwards: a GET must not log anyone out.
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/dashboard$/);

	// ── 11. /register is closed ────────────────────────────────────────────────
	//
	// TWO behaviours, and which one you see depends on whether you are signed in.
	// The plan's journey expects a 404 here, but the HOOK runs before T-19's load:
	// a signed-in visitor is redirected away from /register (T-17 step 4) and never
	// reaches the load that would 404. Both are specified; assert both rather than
	// pretend the order is different.

	// Signed in: redirected to /dashboard.
	await page.goto('/register');
	await expect(page).toHaveURL(/\/dashboard$/);

	// Signed out: a genuine 404, because a restaurant now exists.
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);

	const response = await page.goto('/register');
	expect(response?.status()).toBe(404);
});
