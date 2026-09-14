import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Principal } from '../auth/session';
import { ROLE_KEYS, type PermissionKey } from './keys';

export { CASHIER_KEYS, WAITER_KEYS, ADMIN_KEYS, ALL_KEYS, ROLE_KEYS } from './keys';
export type { PermissionKey } from './keys';

/**
 * A pure function over the role→keys map. Synchronous and cheap on purpose: these
 * guards read event.locals, which T-17's hook populates, and never query the
 * database — so calling one in EVERY load and EVERY action costs nothing and
 * nobody is tempted to skip it.
 */
export function hasPermission(principal: Principal | null, key: PermissionKey): boolean {
	if (!principal) return false;
	return ROLE_KEYS[principal.role].includes(key);
}

/** Build the ?next= value for a login redirect, encoded so an ampersand cannot truncate it. */
function nextParam(event: RequestEvent): string {
	return encodeURIComponent(event.url.pathname + event.url.search);
}

/**
 * Require ANY authenticated user. Redirects an anonymous caller to /login.
 *
 * A redirect rather than a 403 for the anonymous case: they have no identity yet,
 * so the answer is "sign in", not "you may not".
 */
export function requireUser(event: RequestEvent): Principal {
	const user = event.locals.user;
	if (!user) {
		redirect(303, `/login?next=${nextParam(event)}`);
	}
	return user;
}

/**
 * Require the OWNER identity specifically.
 *
 * Reserve this for actions spec 7 ties to the owner as a PERSON rather than to a
 * capability — registering a POS device, in a later plan. Everything that is
 * really "may use this feature" belongs to requirePermission.
 */
export function requireOwner(event: RequestEvent): Principal {
	const user = requireUser(event);
	if (user.role !== 'owner') {
		// 403, never 404. Spec 8 names it: "the server returns 403 Forbidden. So
		// hiding buttons in the frontend is not considered security."
		error(403, 'Forbidden');
	}
	return user;
}

/** Require a capability. 403 for an authenticated user who lacks it. */
export function requirePermission(event: RequestEvent, key: PermissionKey): Principal {
	const user = requireUser(event);
	if (!hasPermission(user, key)) {
		error(403, 'Forbidden');
	}
	return user;
}
