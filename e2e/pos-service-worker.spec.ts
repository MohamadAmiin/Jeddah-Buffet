import { expect, test } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import { TILL_URL, registerDevice, registerRestaurant } from './fixtures';

// THIS PINS THE BLOCKER THE WHOLE PLAN WAS SHAPED AROUND. Do not delete it as
// redundant. kit.serviceWorker.register defaults to TRUE and registers at scope
// `/`, and route groups are not URL segments — so left alone, the till's worker
// would control /dashboard, and authenticated dashboard HTML and __data.json would
// sit in Cache Storage, which /logout does not clear, on a tablet that lives on a
// public counter. Every assertion below is load-bearing.
//
// The scope is `/pos` with NO trailing slash, and scope matching is a plain STRING
// prefix over the whole URL (the W3C "Match Service Worker Registration"
// algorithm; its own example is /maps matching /mapsearch — MDN's path-segment
// prose is wrong on this and the specification governs). `/pos/` would leave the
// till's landing screen `/pos` uncontrolled. If an assertion here fails and a
// trailing slash makes it pass, the slash is hiding the bug.
//
// The worker's recorded policy (CLAUDE.md, "Decisions already made", confirmed
// 2026-09-15): ONE precached app-shell document, `/pos`, served only when a
// navigation's fetch throws; nothing else is ever written to Cache Storage. This
// spec asserts that policy — not the network-only-navigations draft it replaced.
//
// ONE browser context for the whole test: Cache Storage is partitioned per
// context, so the dashboard visits and the till visits must share one or the cache
// assertion proves nothing.

const OWNER = {
	name: 'The Worker Cafe',
	email: 'owner@worker.test',
	password: 'a strong enough password'
};

/** Every dashboard URL this plan ships, plus /login. Adding a route is one line. */
const OUTSIDE_THE_TILL = ['/dashboard', '/login', '/device', '/settings', '/menu', '/employees'];

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeResetPool();
});

test('the till worker is scoped to /pos, controls nothing else, and caches nothing authenticated', async ({
	page,
	context
}) => {
	// ── 1. signed in, visit the authenticated pages whose HTML must never be cached
	await registerRestaurant(page, OWNER);
	await page.goto('/dashboard');
	await page.goto('/settings');

	// ── 2. the till registers exactly one worker, scoped to exactly /pos ─────────
	await page.goto(TILL_URL);
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	const scopes = await page.evaluate(async () =>
		(await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)
	);
	// One: a second means SvelteKit's automatic root-scoped registration is back.
	expect(scopes).toHaveLength(1);
	expect(new URL(scopes[0]).pathname).toBe('/pos');
	expect(new URL(page.url()).pathname.startsWith('/pos')).toBe(true);

	// ── 3. no page outside the till is controlled — /device above all ──────────
	// /device is the dashboard page most likely to sit open on the counter tablet,
	// and it is called /device rather than /pos-device precisely so a string-prefix
	// scope of /pos cannot reach it. Checked while still signed in.
	for (const path of OUTSIDE_THE_TILL) {
		await page.goto(path);
		expect(
			await page.evaluate(() => navigator.serviceWorker.controller === null),
			`${path} must not be controlled by the till's worker`
		).toBe(true);
	}

	// ── 4. the API and the navigation are answered by the SERVER: its answer changes
	await page.goto(TILL_URL);
	const directoryStatus = () =>
		page.evaluate(() =>
			fetch('/api/pos/employees', { credentials: 'include' }).then((r) => r.status)
		);
	expect(await directoryStatus()).toBe(403);
	await expect(page.getByRole('link', { name: 'Register this device' })).toBeVisible();

	await registerDevice(page, OWNER);

	// A cached 403 would still read 403; the same URL now shows employee-select.
	expect(await directoryStatus()).toBe(200);
	await page.goto(TILL_URL);
	await expect(page.getByRole('heading', { name: 'Who is signing in?' })).toBeVisible();

	// ── 5. Cache Storage holds nothing authenticated ──────────────────────────
	// Registration destroyed the dashboard session on this device (T-18) — this
	// plan's logout on a till.
	expect(
		(await context.cookies()).find((c) => c.name === 'matcami_dashboard_session')
	).toBeUndefined();
	const cached = await page.evaluate(async () => {
		const urls: string[] = [];
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			for (const request of await cache.keys()) urls.push(request.url);
		}
		return urls;
	});
	const paths = cached.map((url) => new URL(url).pathname);
	// A DENY list, never toHaveLength(0): the build's own immutable assets are
	// legitimately there.
	const offenders = paths.filter(
		(path) =>
			['/dashboard', '/settings', '/login', '/device', '/api/'].some((prefix) =>
				path.startsWith(prefix)
			) || path.endsWith('__data.json')
	);
	expect(offenders, offenders.join('; ')).toEqual([]);
	// The ONE document in the cache is the till's shell, /pos (the recorded policy).
	const documents = paths.filter(
		(path) => !path.startsWith('/_app/') && !/\.[a-z0-9]+$/i.test(path)
	);
	expect(documents).toEqual(['/pos']);

	// ── 6. the manifest is the till's, and launches into its own scope ─────────
	const href = await page.getAttribute('link[rel="manifest"]', 'href');
	expect(href).not.toBeNull();
	const manifest = await (await page.request.get(new URL(href!, page.url()).toString())).json();
	const scopePath = new URL(manifest.scope, page.url()).pathname;
	const startPath = new URL(manifest.start_url, page.url()).pathname;
	expect(scopePath).toBe('/pos');
	expect(startPath).toBe('/pos');
	expect([scopePath, startPath]).not.toContain('/');
	expect(manifest.display).toBe('fullscreen');
});
