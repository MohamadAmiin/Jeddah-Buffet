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
import { PUBLIC_ROUTE_IDS } from '../lib/public-routes';

const ROUTES_DIR = fileURLToPath(new URL('.', import.meta.url));

const SERVER_FILES = new Set(['+page.server.ts', '+layout.server.ts', '+server.ts']);
const GUARD_CALLS = ['requireUser', 'requireOwner', 'requirePermission'];

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
			if (PUBLIC_ROUTE_IDS.has(routeId)) return;

			const source = readFileSync(file, 'utf8');
			const guarded = GUARD_CALLS.some((call) => source.includes(call + '('));

			expect(
				guarded,
				`${relative(ROUTES_DIR, file)} (route id "${routeId}") has no permission check. ` +
					`Add one of ${GUARD_CALLS.join(', ')}, or add the route id to PUBLIC_ROUTE_IDS in ` +
					'src/hooks.server.ts — deliberately, because that makes it reachable with no session.'
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
		if (PUBLIC_ROUTE_IDS.has(routeId)) return;

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
		expect([...PUBLIC_ROUTE_IDS].sort()).toEqual(['/', '/login', '/register']);
	});

	// The walk searches SOURCE TEXT, so it can be satisfied by a guard call sitting
	// in a comment or in dead code. It is a cheap TRIPWIRE, and the real evidence
	// lives elsewhere. Assert those files EXIST rather than asserting a constant
	// against itself, which was the previous version of this test and could not
	// fail:
	//   - permissions/guards.test.ts EXECUTES the three guards and asserts 403/303
	//   - route-guards.integration.test.ts drives the real hook
	//   - e2e/auth.spec.ts issues real HTTP requests
	it('defers to tests that actually execute the guards', () => {
		const here = fileURLToPath(new URL('.', import.meta.url));
		expect(existsSync(join(here, 'route-guards.integration.test.ts'))).toBe(true);
		expect(existsSync(join(here, '../lib/server/permissions/guards.test.ts'))).toBe(true);
		expect(existsSync(join(here, '../../e2e/auth.spec.ts'))).toBe(true);
	});
});
