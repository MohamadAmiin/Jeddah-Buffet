// Whether the navigation rail is collapsed. ISOMORPHIC — read by the dashboard
// layout's server load and written by the rail's own toggle, which is why it sits
// in src/lib/ rather than src/lib/server/. src/lib/theme.ts is the precedent.
//
// matcami_rail IS NOT A SESSION COOKIE. Invariant 12 governs
// matcami_dashboard_session: HttpOnly, Secure, SameSite, never localStorage. This
// one holds no secret, is never read for authorisation, and is deliberately
// readable by client JavaScript because the client is what writes it. Never let it
// influence a guard, a redirect or a permission decision.
//
// A COOKIE rather than localStorage, for one reason: the server can read it during
// `load` and render the rail already collapsed. localStorage is only readable after
// hydration, so the rail would render wide and then snap shut — the same flash of
// the wrong state the theme cookie exists to avoid.

export const RAIL_COOKIE = 'matcami_rail';
export const RAIL_MAX_AGE_SECONDS = 31536000; // one year

/**
 * Narrow an untrusted cookie value to a boolean.
 *
 * Anything that is not exactly 'collapsed' is expanded. A cookie value is
 * attacker-supplied, and the safe default is the state that shows every label.
 */
export function parseRail(value: string | undefined): boolean {
	return value === 'collapsed';
}
