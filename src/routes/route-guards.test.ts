// MANDATORY (spec 29 — "Permission checks on every POS API")
//
// Spec 29 names the POS API. The dashboard routes are the first routes that
// exist, invariant 8 says the rule covers EVERY route with reads included, and
// the walk below is written so the POS routes are covered automatically the day
// they are added.
//
// This file and route-guards.integration.test.ts are NOT redundant with the hook.
// The hook is one changed route id away from silently guarding nothing; these are
// what would notice. Do not delete them as duplicated effort.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// Imported from the SINGLE SOURCE that hooks.server.ts also imports and
// re-exports — never copied, or the two would drift and this test would start
// passing against a list that is no longer the one enforced. A relative path so
// the unit project needs no $lib alias.
import { PUBLIC_ROUTE_IDS, PUBLIC_ROUTE_PREFIXES, isPublicRouteId } from '../lib/public-routes';

const ROUTES_DIR = fileURLToPath(new URL('.', import.meta.url));

const SERVER_FILES = new Set(['+page.server.ts', '+layout.server.ts', '+server.ts']);
// requireDevice (src/lib/server/auth/pos-context.ts) is a real guard: it throws
// error(403) when the device cookie is missing, unknown or revoked. A
// device-authenticated route authenticates by registered device, not by user
// session, and without this entry every POS endpoint would fail the walk below
// despite being correctly guarded.
const GUARD_CALLS = ['requireUser', 'requireOwner', 'requirePermission', 'requireDevice'];

/** Discover server files. NEVER a hard-coded list — adding a route must be considered automatically. */
function findServerFiles(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			findServerFiles(full, found);
		} else if (SERVER_FILES.has(entry)) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Turn a file path into the route id SvelteKit would use: the directory path
 * relative to src/routes, with the leading slash, keeping (group) segments —
 * they ARE part of event.route.id.
 */
function routeIdOf(file: string): string {
	const rel = relative(ROUTES_DIR, file);
	const dir = rel.split(sep).slice(0, -1).join('/');
	return '/' + dir;
}

const serverFiles = findServerFiles(ROUTES_DIR);

describe('every route is guarded or deliberately public', () => {
	it('finds server files to check at all', () => {
		// A walk that silently found nothing would pass every assertion below.
		expect(serverFiles.length).toBeGreaterThan(0);
	});

	it.each(serverFiles.map((f) => [relative(ROUTES_DIR, f), f]))(
		'%s is in the public allow-list or calls a guard',
		(_label, file) => {
			const routeId = routeIdOf(file);
			if (isPublicRouteId(routeId)) return;

			const source = readFileSync(file, 'utf8');
			const guarded = GUARD_CALLS.some((call) => source.includes(call + '('));

			expect(
				guarded,
				`${relative(ROUTES_DIR, file)} (route id "${routeId}") has no permission check. ` +
					`Add one of ${GUARD_CALLS.join(', ')} — requireDevice for a route the POS device ` +
					'calls, the others for a dashboard route — or add the route id to PUBLIC_ROUTE_IDS ' +
					'in src/lib/public-routes.ts, deliberately, because that makes it reachable with no ' +
					'session.'
			).toBe(true);
		}
	);

	// A form action is a SEPARATELY REACHABLE POST endpoint. A page whose load is
	// guarded and whose action is not is wide open to anyone who posts to it
	// directly.
	it.each(
		serverFiles
			.filter((f) => readFileSync(f, 'utf8').includes('export const actions'))
			.map((f) => [relative(ROUTES_DIR, f), f])
	)('%s guards INSIDE its actions, not only in load', (_label, file) => {
		const source = readFileSync(file, 'utf8');
		const routeId = routeIdOf(file);
		if (isPublicRouteId(routeId)) return;

		// Everything from `export const actions` onward.
		const actionsBody = source.slice(source.indexOf('export const actions'));
		const guarded = GUARD_CALLS.some((call) => actionsBody.includes(call + '('));

		expect(
			guarded,
			`${relative(ROUTES_DIR, file)} exports actions but calls no guard inside them. ` +
				'A form action is a separately reachable POST endpoint (invariant 8).'
		).toBe(true);
	});

	it('the allow-list is small and explicit', () => {
		// If this grows, someone made a route public. That should be a deliberate,
		// reviewed act — hence a test that notices.
		//   '/(pos)/pos' — the till's landing screen; its credential is the device
		//     cookie plus a PIN, and it must render the registration screen when no
		//     device exists yet, so it cannot sit behind the dashboard login.
		//   '/api/pos/register' — authenticates from its body with the owner's
		//     email and password, like /login, and holds no session of its own.
		//   PUBLIC_ROUTE_PREFIXES '/(pos)/pos' — the till's child screens (pages
		//     only, never /api), for the same reason as the landing screen.
		expect([...PUBLIC_ROUTE_IDS].sort()).toEqual([
			'/',
			'/(pos)/pos',
			'/api/pos/register',
			'/login',
			'/register'
		]);
		expect([...PUBLIC_ROUTE_PREFIXES].sort()).toEqual(['/(pos)/pos']);
	});

	// The walk searches SOURCE TEXT, so it can be satisfied by a guard call sitting
	// in a comment or in dead code. It is a cheap TRIPWIRE, and the real evidence
	// lives elsewhere. Assert those files EXIST rather than asserting a constant
	// against itself, which was the previous version of this test and could not
	// fail:
	//   - permissions/guards.test.ts EXECUTES the three guards and asserts 403/303
	//   - route-guards.integration.test.ts drives the real hook
	//   - api/pos/permissions.integration.test.ts drives every POS API route
	//   - e2e/auth.spec.ts issues real HTTP requests
	it('defers to tests that actually execute the guards', () => {
		const here = fileURLToPath(new URL('.', import.meta.url));
		expect(existsSync(join(here, 'route-guards.integration.test.ts'))).toBe(true);
		expect(existsSync(join(here, 'api/pos/permissions.integration.test.ts'))).toBe(true);
		expect(existsSync(join(here, '../lib/server/permissions/guards.test.ts'))).toBe(true);
		expect(existsSync(join(here, '../../e2e/auth.spec.ts'))).toBe(true);
	});
});

// MANDATORY (spec 29 — "Permission checks on every POS API"), made MECHANICAL: a
// route added by a later plan cannot skip the rule by forgetting it. The hook
// passes /api through to each route's own guard, so a +server.ts here that calls
// none of them is simply open.
describe('every /api route is guarded', () => {
	// existsSync: findServerFiles throws on a missing root.
	const API_DIR = join(ROUTES_DIR, 'api');
	const apiServerFiles = existsSync(API_DIR)
		? findServerFiles(API_DIR).filter((f) => f.endsWith(`${sep}+server.ts`))
		: [];

	// Exactly one /api route is public, and a second one is a test failure rather
	// than a discovery.
	it('has exactly one public /api route: /api/pos/register', () => {
		expect([...PUBLIC_ROUTE_IDS].filter((id) => id.startsWith('/api/'))).toEqual([
			'/api/pos/register'
		]);
	});

	// Every +server.ts under src/routes/api/, by route id. A task that adds an /api
	// route adds its id here IN THE SAME COMMIT — that is the point of this
	// assertion. A walk that silently found nothing would otherwise pass every
	// check below. What must NEVER appear is /api/pos/revoke: revocation is a
	// dashboard form action at /device, deliberately (T-21).
	it('finds exactly the /api routes the plan has shipped', () => {
		expect(apiServerFiles.map(routeIdOf).sort()).toEqual([
			'/api/menu/version',
			'/api/pos/employees',
			'/api/pos/pin',
			'/api/pos/register'
		]);
	});

	it.each(apiServerFiles.map((f) => [relative(ROUTES_DIR, f), f]))(
		'%s calls a guard',
		(_label, file) => {
			const routeId = routeIdOf(file);
			// THE ONE EXEMPTION, expressed through the public list so the two cannot
			// disagree: /api/pos/register authenticates from its BODY with the owner's
			// email and password (loginWithPassword), has no session and no device
			// cookie to check, and destroys the dashboard session it creates.
			if (PUBLIC_ROUTE_IDS.has(routeId)) return;

			const source = readFileSync(file, 'utf8');
			expect(
				GUARD_CALLS.some((call) => source.includes(call + '(')),
				`${relative(ROUTES_DIR, file)} (route id "${routeId}") calls none of ` +
					`${GUARD_CALLS.join(', ')}. The hook passes every /api request through to the ` +
					'route, so a route with no guard of its own answers anyone.'
			).toBe(true);
		}
	);
});
