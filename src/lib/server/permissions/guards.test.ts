// MANDATORY (spec 29 — "Permission checks on every POS API")
//
// These EXECUTE requireUser, requireOwner and requirePermission and assert the
// status each one throws. Without them the three functions that produce every 403
// in this codebase were only ever matched as SOURCE TEXT by
// src/routes/route-guards.test.ts, and the behavioural test exercises the hook —
// a separate code path that 403s /(dashboard) route ids on its own, never
// consulting the permission key map.
//
// The consequence, which is why this file exists: deleting `error(403, 'Forbidden')`
// from requirePermission used to leave the entire suite green. The first route
// outside /(dashboard) that relies on its own guard — a POS +server.ts, or a
// top-level page beside /logout — would then serve every authenticated caller.

import { describe, it, expect } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Principal } from '../auth/session';
import { requireUser, requireOwner, requirePermission, hasPermission } from './index';
import { ADMIN_KEYS, CASHIER_KEYS } from './keys';

function principal(role: Principal['role']): Principal {
	return {
		userId: 'u-1',
		restaurantId: 'r-1',
		role,
		displayName: 'Someone',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function event(user: Principal | null, path = '/settings', search = ''): RequestEvent {
	return {
		locals: { user, restaurantId: user?.restaurantId ?? null, sessionToken: null },
		url: new URL(`http://localhost${path}${search}`)
	} as unknown as RequestEvent;
}

/** Run a guard and report what it threw, rather than whether it threw. */
function outcome(fn: () => unknown): { status?: number; location?: string; returned?: unknown } {
	try {
		return { returned: fn() };
	} catch (thrown) {
		const e = thrown as { status?: number; location?: string };
		return { status: e.status, location: e.location };
	}
}

describe('requireUser', () => {
	it('redirects an anonymous caller to /login with an encoded next', () => {
		const result = outcome(() => requireUser(event(null, '/settings', '?tab=a&x=1')));
		expect(result.status).toBe(303);
		// Encoded, so an ampersand cannot truncate the target.
		expect(result.location).toBe('/login?next=%2Fsettings%3Ftab%3Da%26x%3D1');
	});

	it('returns the principal for any authenticated role', () => {
		for (const role of ['owner', 'cashier', 'waiter'] as const) {
			const result = outcome(() => requireUser(event(principal(role))));
			expect(result.status).toBeUndefined();
			expect((result.returned as Principal).role).toBe(role);
		}
	});
});

describe('requireOwner', () => {
	it('redirects an anonymous caller rather than 403-ing them', () => {
		// They have no identity yet, so the answer is "sign in", not "you may not".
		expect(outcome(() => requireOwner(event(null))).status).toBe(303);
	});

	it.each(['cashier', 'waiter'] as const)('throws 403 for a %s', (role) => {
		const result = outcome(() => requireOwner(event(principal(role))));
		expect(result.status).toBe(403);
		// 403 EXACTLY — not 404 to "hide" the route (spec 8 names 403), and not a
		// redirect, which would read as "sign in" to someone who already has.
		expect(result.location).toBeUndefined();
	});

	it('lets the owner through', () => {
		expect(outcome(() => requireOwner(event(principal('owner')))).status).toBeUndefined();
	});
});

describe('requirePermission', () => {
	it('redirects an anonymous caller', () => {
		expect(outcome(() => requirePermission(event(null), 'admin.settings')).status).toBe(303);
	});

	it.each(['cashier', 'waiter'] as const)('throws 403 for a %s on every admin.* key', (role) => {
		for (const key of ADMIN_KEYS) {
			const result = outcome(() => requirePermission(event(principal(role)), key));
			expect(result.status, `${role} was allowed ${key}`).toBe(403);
			expect(result.location).toBeUndefined();
		}
	});

	it('lets the owner through on every admin.* key', () => {
		for (const key of ADMIN_KEYS) {
			expect(
				outcome(() => requirePermission(event(principal('owner')), key)).status
			).toBeUndefined();
		}
	});

	it('throws 403 when the role holds OTHER keys but not this one', () => {
		// A waiter holds five POS keys and still must not hold a cashier's.
		const result = outcome(() => requirePermission(event(principal('waiter')), CASHIER_KEYS[0]));
		expect(result.status).toBe(403);
		expect(hasPermission(principal('waiter'), CASHIER_KEYS[0])).toBe(false);
	});

	it('lets a cashier through on a key they DO hold', () => {
		expect(
			outcome(() => requirePermission(event(principal('cashier')), CASHIER_KEYS[0])).status
		).toBeUndefined();
	});
});
