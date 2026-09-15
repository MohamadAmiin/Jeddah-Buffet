// MANDATORY (spec 29 — "Permission checks on every POS API")
//
// The behavioural half. route-guards.test.ts is a source-text tripwire and can be
// satisfied by a guard call sitting in a comment; THIS file drives the real hook
// and the real route modules against a real database, and is the actual evidence.

import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { hashPassword } from '$lib/server/auth/password';
import { createSession, SESSION_COOKIE } from '$lib/server/auth/session';
import { handleSession, handleGuard } from '../hooks.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/** Every non-public route id this branch defines. */
const DASHBOARD_ROUTE_IDS = [
	'/(dashboard)',
	'/(dashboard)/dashboard',
	'/(dashboard)/settings',
	'/(dashboard)/device',
	'/(dashboard)/employees'
];
const NON_PUBLIC_ROUTE_IDS = [...DASHBOARD_ROUTE_IDS, '/logout'];

async function makeUser(role: 'owner' | 'cashier' | 'waiter') {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	const [user] = await db
		.insert(users)
		.values(
			role === 'owner'
				? {
						restaurantId: restaurant.id,
						role,
						displayName: 'The Owner',
						email: `owner-${Date.now()}-${Math.round(performance.now())}@cafe.com`,
						passwordHash: await hashPassword('a correct password')
					}
				: // A cashier or waiter CANNOT be given credentials — the CHECK constraint
					// forbids it — so the row is inserted directly. That is the point: the
					// only way such a session could exist is a later plan creating one, and
					// these assertions prove the dashboard is closed to it in advance.
					{ restaurantId: restaurant.id, role, displayName: 'Staff' }
		)
		.returning();
	const { token } = await createSession(db, user.id);
	return { token, restaurantId: restaurant.id, userId: user.id };
}

/** A minimal RequestEvent good enough for the hook. */
function makeEvent(routeId: string, token?: string, method = 'GET'): RequestEvent {
	const url = new URL(`http://localhost${routeId.replace(/\/\([^)]*\)/g, '') || '/'}`);
	const cookieJar = new Map<string, string>();
	if (token) cookieJar.set(SESSION_COOKIE, token);

	return {
		cookies: {
			get: (name: string) => cookieJar.get(name),
			getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
			set: (name: string, value: string) => cookieJar.set(name, value),
			delete: (name: string) => cookieJar.delete(name),
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '203.0.113.5',
		locals: {} as App.Locals,
		params: {},
		platform: undefined,
		request: new Request(url, { method }),
		route: { id: routeId },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

/**
 * Compose the two real handlers by hand. `sequence` needs SvelteKit's internal
 * request store, which exists only inside a real request; the handlers themselves
 * do not, so this drives the genuine logic rather than a copy of it.
 */
async function runBothHandlers(event: RequestEvent): Promise<Response> {
	return handleSession({
		event,
		resolve: (e) =>
			handleGuard({ event: e, resolve: async () => new Response('ok', { status: 200 }) })
	});
}

/** Run the hook and report what it did: a redirect, an error status, or pass-through. */
async function runHook(
	routeId: string,
	token?: string
): Promise<{ status: number; location?: string }> {
	const event = makeEvent(routeId, token);
	try {
		await runBothHandlers(event);
		return { status: 200 };
	} catch (thrown) {
		const e = thrown as { status?: number; location?: string; body?: { message?: string } };
		if (e.status === undefined) {
			// Not a SvelteKit redirect/error — surface it rather than reporting 500.
			throw thrown;
		}
		return { status: e.status, location: e.location };
	}
}

describe('MANDATORY (spec 29): every non-public route refuses an anonymous request', () => {
	it.each(NON_PUBLIC_ROUTE_IDS)('%s redirects an anonymous request to /login', async (routeId) => {
		const result = await runHook(routeId);
		expect(result.status).toBe(303);
		expect(result.location).toMatch(/^\/login\?next=/);
	});

	it.each([...['/', '/login', '/register']])('%s answers without a session', async (routeId) => {
		const result = await runHook(routeId);
		expect(result.status).toBe(200);
	});
});

describe('MANDATORY (spec 29): every (dashboard) route returns 403 for a non-owner', () => {
	it.each(
		DASHBOARD_ROUTE_IDS.flatMap((routeId) =>
			(['cashier', 'waiter'] as const).map((role) => [routeId, role] as const)
		)
	)('%s returns 403 for a %s, not 404 and not a redirect', async (routeId, role) => {
		const { token } = await makeUser(role);
		const result = await runHook(routeId, token);

		// 403 EXACTLY. Not 404 ("hiding" the route), not 303 (which would read as
		// "sign in" to someone who already has).
		expect(result.status).toBe(403);
		expect(result.location).toBeUndefined();
	});

	// T-23's Done-when names "a direct POST to the action". A form action is a
	// separately reachable POST endpoint, so assert the METHOD too — the makeEvent
	// helper already took a method parameter that nothing passed.
	it.each(DASHBOARD_ROUTE_IDS)('%s returns 403 for a cashier POSTing directly', async (routeId) => {
		const { token } = await makeUser('cashier');
		const event = makeEvent(routeId, token, 'POST');
		let status: number | undefined;
		try {
			await runBothHandlers(event);
		} catch (thrown) {
			status = (thrown as { status?: number }).status;
		}
		expect(status).toBe(403);
	});

	it.each(DASHBOARD_ROUTE_IDS)('%s lets the owner through', async (routeId) => {
		const { token } = await makeUser('owner');
		const result = await runHook(routeId, token);
		expect(result.status).toBe(200);
	});
});

describe('session handling in the hook', () => {
	it('sets locals.restaurantId for dashboard routes only', async () => {
		const { token, restaurantId } = await makeUser('owner');

		const dashboardEvent = makeEvent('/(dashboard)/dashboard', token);
		await runBothHandlers(dashboardEvent);
		expect(dashboardEvent.locals.restaurantId).toBe(restaurantId);
		expect(dashboardEvent.locals.user?.role).toBe('owner');

		// Outside the dashboard it stays null, so a future POS route that reaches for
		// it by habit fails loudly instead of inheriting the wrong tenant.
		const otherEvent = makeEvent('/', token);
		await runBothHandlers(otherEvent);
		expect(otherEvent.locals.user).not.toBeNull();
		expect(otherEvent.locals.restaurantId).toBeNull();
	});

	it('sends a signed-in visitor away from /login and /register', async () => {
		const { token } = await makeUser('owner');
		for (const routeId of ['/login', '/register']) {
			const result = await runHook(routeId, token);
			expect(result.status).toBe(303);
			expect(result.location).toBe('/dashboard');
		}
	});

	it('leaves an unmatched route alone for SvelteKit to 404', async () => {
		const event = makeEvent('/', undefined);
		(event.route as { id: string | null }).id = null;
		const response = await handleSession({
			event,
			resolve: (e) =>
				handleGuard({ event: e, resolve: async () => new Response('not found', { status: 404 }) })
		});
		expect(response.status).toBe(404);
	});

	it('ignores a cookie that is not a valid session, without throwing', async () => {
		const result = await runHook('/', 'not-a-real-token');
		expect(result.status).toBe(200);
	});
});

describe('GET /logout is not a thing', () => {
	// A logout reachable by GET is triggerable by any image tag on any page.
	//
	// Assert the STATUS the load actually produces, not the module's shape. The
	// earlier version of this test checked that no `load` was exported, on the
	// premise that SvelteKit then answers 405 — which is false for a GET
	// (page_methods includes GET, so it renders the page and throws
	// "Missing +page.svelte component"). That premise made the test pass while the
	// real response was a 500.
	it('GET /logout is refused with 405', async () => {
		const mod = await import('./logout/+page.server');
		expect(mod.actions).toBeDefined();
		expect(mod.load).toBeDefined();

		let status: number | undefined;
		try {
			await (mod.load as (e: unknown) => unknown)(makeEvent('/logout'));
		} catch (thrown) {
			status = (thrown as { status?: number }).status;
		}
		expect(status).toBe(405);
	});
});

// T-17: /pos and /api/pos, opened DELIBERATELY. "Public" means "no dashboard
// session required" — the till's credential is the device cookie plus a PIN.
describe('MANDATORY (spec 29): the POS surfaces in the hook', () => {
	it('/(pos)/pos answers without a session — not a 303 to /login', async () => {
		expect(await runHook('/(pos)/pos')).toEqual({ status: 200 });
	});

	it('the screens under /(pos)/pos answer without a session too', async () => {
		expect(await runHook('/(pos)/pos/register')).toEqual({ status: 200 });
	});

	it('the dashboard is NOT widened: anonymous still redirects to /login', async () => {
		const result = await runHook('/(dashboard)/dashboard');
		expect(result.status).toBe(303);
		expect(result.location).toMatch(/^\/login\?next=/);
	});

	// The 403 for a missing device is the ROUTE's job (requireDevice), not the
	// hook's. A 303 here would hand a fetch() caller an HTML login page.
	it('/api/pos/pin passes through the hook with no session', async () => {
		const result = await runHook('/api/pos/pin');
		expect(result.status).not.toBe(303);
		expect(result.status).toBe(200);
	});

	it('refuses a cross-origin POST to /api with 403, and passes a same-origin one', async () => {
		const withOrigin = (origin: string) => {
			const event = makeEvent('/api/pos/pin', undefined, 'POST');
			(event as { request: Request }).request = new Request(event.url, {
				method: 'POST',
				headers: { origin }
			});
			return event;
		};

		let status: number | undefined;
		try {
			await runBothHandlers(withOrigin('https://evil.test'));
		} catch (thrown) {
			status = (thrown as { status?: number }).status;
		}
		expect(status).toBe(403);

		const response = await runBothHandlers(withOrigin('http://localhost'));
		expect(response.status).toBe(200);
	});

	// A signed-in owner reaching the till is the registration flow, not a mistake.
	it('/(pos)/pos lets a signed-in owner through instead of bouncing to /dashboard', async () => {
		const { token } = await makeUser('owner');
		expect(await runHook('/(pos)/pos', token)).toEqual({ status: 200 });
	});

	it('gives a POS request no dashboard tenant and never renews the owner cookie', async () => {
		const { token } = await makeUser('owner');

		const cookiesSetOn = async (routeId: string) => {
			const event = makeEvent(routeId, token);
			const names: string[] = [];
			const set = event.cookies.set.bind(event.cookies);
			event.cookies.set = ((name: string, value: string, options: never) => {
				names.push(name);
				return set(name, value, options);
			}) as typeof event.cookies.set;
			await runBothHandlers(event);
			return { event, names };
		};

		const pos = await cookiesSetOn('/(pos)/pos');
		expect(pos.event.locals.user).not.toBeNull();
		expect(pos.event.locals.restaurantId).toBeNull();
		expect(pos.names).not.toContain(SESSION_COOKIE);

		// The comparison that makes the assertion above mean something: on a
		// dashboard route the same session IS renewed.
		const dashboard = await cookiesSetOn('/(dashboard)/dashboard');
		expect(dashboard.names).toContain(SESSION_COOKIE);
	});
});
