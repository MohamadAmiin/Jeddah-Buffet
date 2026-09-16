import { expect, test } from '@playwright/test';
import { resetDb, closeResetPool, acquireRunLock } from '../src/lib/server/db/test/reset';

// DATABASE CHOICE, stated as the task requires: this spec runs against the TEST
// database (matcami_test), not development data. playwright.config.ts points the
// preview server's DATABASE_URL at TEST_DATABASE_URL, and the reset below clears
// it, so the journey starts from zero companies and a fresh daily sign-up cap.
// Running against development data would destroy it.
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
	// at a random step with a symptom that points nowhere near the cause.
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeResetPool();
});

test('the owner registers, works, signs out and signs back in', async ({
	page,
	context,
	browser
}) => {
	// ── 0. /login points the way to sign-up ────────────────────────────────────
	// Labelled 0 so every existing `// ── N. … ──` label stays byte-identical. The
	// link follows the SIGNUP switch; step 7a asserts it is still there once a
	// company exists.
	await page.goto('/login');
	await page.getByRole('link', { name: 'Set up your restaurant' }).click();
	await expect(page).toHaveURL(/\/register$/);

	// ── 1. /register is reachable, and anyone can sign up ──────────────────────
	await page.goto('/register');
	await expect(page.getByRole('heading', { name: 'Set up your restaurant' })).toBeVisible();

	// ── 1a. …and it points back to sign-in ─────────────────────────────────────
	// A pattern, not '/login': the href comes from resolve(), which may render a
	// relative path such as ./login in the server HTML.
	await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', /\/login$/);

	// ── 2. sign up, and land on /dashboard ─────────────────────────────────────
	// No setup token: sign-up is public (decided 2026-09-15).
	await expect(page.getByLabel('Setup token')).toHaveCount(0);
	await page.getByLabel('Restaurant name').fill(RESTAURANT);
	await page.getByLabel('Time zone').fill('Africa/Mogadishu');
	await page.getByLabel('Your name').fill('The Owner');
	await page.getByLabel('Email').fill(EMAIL);
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Confirm password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create restaurant' }).click();

	await expect(page).toHaveURL(/\/dashboard$/);

	// ── 3. the overview shows the restaurant and the checklist ─────────────────
	await expect(page.getByRole('heading', { name: RESTAURANT })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Getting set up' })).toBeVisible();
	// None of the six steps is done yet — not even the settings step: registration
	// sets the name and time zone but leaves the POS idle lock unset, and
	// settingsComplete() requires it (T-08), so that step reads "Still needed: POS
	// idle lock." `exact` matters: each step renders the phrase twice — a visible
	// badge and a screen-reader-only " — not started" — so a loose match counts
	// twelve.
	await expect(page.getByText('Restaurant settings')).toBeVisible();
	await expect(page.getByText('not started', { exact: true })).toHaveCount(6);
	// The Menu rail row is a real link now (T-39, confirmed by T-43), not a disabled
	// "Soon" row. `exact`: the checklist's "Open menu" link would match a loose name.
	await expect(page.getByRole('link', { name: 'Menu', exact: true })).toBeVisible();

	// ── 3a. the bare host, WITH a session ──────────────────────────────────────
	// Labelled 3a deliberately: it leaves every existing `// ── N. … ──` label
	// byte-identical. `/` is a signpost, and which way it points depends on whether
	// the visitor is signed in. smoke.spec.ts covers the signed-OUT direction; this
	// is the other one, and it needs a session, so it belongs here.
	await page.goto('/');
	await expect(page).toHaveURL(/\/dashboard$/);

	// ── 3b. the theme control ──────────────────────────────────────────────────
	// Labelled 3b deliberately: it leaves every existing `// ── N. … ──` label
	// byte-identical, so a reviewer can see at a glance that no assertion moved.
	await expect(page.getByRole('button', { name: 'Light' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'System' })).toBeVisible();

	// No cookie yet, so the DEFAULT applies — and the default is LIGHT, stamped by
	// the server. It used to be "system", represented by no attribute at all, which
	// handed a dark-mode operating system a dark dashboard nobody had asked for.
	expect(await page.locator('html').getAttribute('data-theme')).toBe('light');

	// Immediately, without a reload: asserting after a navigation would prove
	// nothing about the click.
	await page.getByRole('button', { name: 'Dark' }).click();
	expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');

	const themeCookie = (await context.cookies()).find((c) => c.name === 'matcami_theme');
	expect(themeCookie, 'the theme preference must be persisted in a cookie').toBeDefined();
	expect(themeCookie?.value).toBe('dark');
	expect(themeCookie?.path).toBe('/');
	expect(themeCookie?.sameSite).toBe('Lax');
	// Secure only over HTTPS: this suite runs on http://localhost:4173, where a
	// Secure cookie would be discarded by the browser. Same conditional shape the
	// session-cookie step below uses.
	if (new URL(page.url()).protocol === 'https:') {
		expect(themeCookie?.secure).toBe(true);
	}

	// Only the RAW body can distinguish a server stamp from a client-side one:
	// after hydration the toggle would have set the same attribute either way.
	// This is the assertion protecting against a flash of the wrong theme.
	const ssr = await page.request.get('/dashboard');
	expect(ssr.status()).toBe(200);
	expect(await ssr.text()).toMatch(/<html[^>]*data-theme="dark"/);

	await page.reload();

	// System WRITES `system` and removes the attribute — two different things, and
	// both must happen. The cookie is written rather than expired: with light as the
	// default, an absent cookie means "never chose" and resolves to light, so
	// deleting it would return the viewer to light instead of to their OS.
	await page.getByRole('button', { name: 'System' }).click();
	expect(await page.locator('html').getAttribute('data-theme')).toBeNull();
	const systemCookie = (await context.cookies()).find((c) => c.name === 'matcami_theme');
	expect(systemCookie?.value, 'System must be stored, not represented by absence').toBe('system');

	// And it must SURVIVE a round trip: the server has to stamp nothing for it.
	const ssrSystem = await page.request.get('/dashboard');
	expect(await ssrSystem.text()).not.toMatch(/<html[^>]*data-theme=/);

	// An explicit LIGHT choice must beat a DARK operating system. Assert the
	// COMPUTED token, not the attribute: the attribute is written by the toggle
	// regardless of any CSS, so asserting it is identical with or without the
	// emulation and says nothing about the cascade. The computed value is what
	// proves the `:root:not([data-theme="light"])` guard in tokens.css does its job.
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.getByRole('button', { name: 'Light' }).click();
	expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
	const bg = await page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim()
	);
	expect(bg).toBe('#e9edf0');

	// Reset the emulation so the later steps do not run under one they never asked for.
	await page.emulateMedia({ colorScheme: null });

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
	// The tax and currency settings (T-36), saved by the same form.
	await page.getByLabel('Tax mode').fill('exclusive');
	await page.getByLabel('Tax rate (basis points)').fill('825');
	await page.getByLabel('Currency code').fill('USD');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('alert')).toContainText('Settings saved.');
	await expect(page.getByRole('heading', { name: RENAMED })).toBeVisible();

	// The checklist now names ONLY the idle lock: tax and currency have left the
	// list. The idle lock is saved on /device, which this journey never visits, so
	// the settings step legitimately stays "not started" — do not assert that it
	// flips to done, and do not assert that the count drops.
	await page.goto('/dashboard');
	await expect(page.getByText('Still needed: POS idle lock.')).toBeVisible();

	// ── 7. sign out, landing on /login ─────────────────────────────────────────
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);

	// ── 7a. /login still points to sign-up after a company exists ──────────────
	// Public sign-up: the link follows the SIGNUP switch, not the company count.
	// The heading first, so the assertion runs on a page that has rendered.
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Set up your restaurant' })).toBeVisible();

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

	// ── 11. /register stays open ───────────────────────────────────────────────
	//
	// TWO behaviours, and which one you see depends on whether you are signed in.
	// The hook redirects a signed-in visitor away from /register. Signed out, the
	// form answers even though a company exists: sign-up is public.

	// Signed in: redirected to /dashboard.
	await page.goto('/register');
	await expect(page).toHaveURL(/\/dashboard$/);

	// Signed out: the sign-up form itself.
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);

	const response = await page.goto('/register');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('button', { name: 'Create restaurant' })).toBeVisible();

	// ── 12. a SECOND company signs up, and sees only its own name ──────────────
	// A fresh browser context, so nothing of the first owner's session carries over.
	const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
	const second = await other.newPage();
	await second.goto('/register');
	await second.getByLabel('Restaurant name').fill('The Second Cafe');
	await second.getByLabel('Time zone').fill('Africa/Mogadishu');
	await second.getByLabel('Your name').fill('The Second Owner');
	await second.getByLabel('Email').fill('owner2@e2e.test');
	await second.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await second.getByLabel('Confirm password').fill(PASSWORD);
	await second.getByRole('button', { name: 'Create restaurant' }).click();

	await expect(second).toHaveURL(/\/dashboard$/);
	await expect(second.getByRole('heading', { name: 'The Second Cafe' })).toBeVisible();
	await expect(second.getByRole('heading', { name: RENAMED })).toHaveCount(0);
	await other.close();
});
