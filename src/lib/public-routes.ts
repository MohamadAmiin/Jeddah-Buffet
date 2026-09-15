/**
 * Route ids that answer WITHOUT a DASHBOARD session. Everything else is denied by
 * default.
 *
 * THE SINGLE SOURCE. src/hooks.server.ts imports and re-exports it, and
 * src/routes/route-guards.test.ts imports it — neither copies it, or the two
 * would drift and the guard test would start passing against a list that is no
 * longer the one enforced.
 *
 * It lives here, rather than in hooks.server.ts, so the test can read it without
 * pulling in the database client and $env/dynamic/private.
 *
 * Adding an entry makes a route reachable with no dashboard session at all. That
 * should be a deliberate, reviewed act; route-guards.test.ts asserts the exact
 * contents so a casual addition fails.
 *
 * "PUBLIC" MEANS "NO DASHBOARD SESSION REQUIRED" — NOT UNAUTHENTICATED. A POS page
 * is reachable with no dashboard cookie because its credential is the long-lived
 * HttpOnly device cookie plus an employee PIN, and because the till must still
 * render its device-registration screen when no device cookie exists at all —
 * impossible if the hook first redirected the browser to /login.
 */
export const PUBLIC_ROUTE_IDS: ReadonlySet<string> = new Set([
	'/',
	'/login',
	'/register',
	// The POS shell index. Route GROUPS are not URL segments, so this id is the
	// page at src/routes/(pos)/pos/ that T-23 creates, serving the URL /pos.
	'/(pos)/pos',
	// Credential-authenticated, exactly like /login: it takes the owner's email
	// and password in the body and answers with no session of its own. It is the
	// ONE /api route that is not device-guarded, and T-22 asserts it by name.
	'/api/pos/register'
]);

/** Route ids UNDER these are public too — the POS screens T-24..T-26 add. Pages only, never /api. */
export const PUBLIC_ROUTE_PREFIXES: readonly string[] = ['/(pos)/pos'];

/** True for an id in PUBLIC_ROUTE_IDS, or one nested under a PUBLIC_ROUTE_PREFIXES entry. */
export function isPublicRouteId(id: string): boolean {
	if (PUBLIC_ROUTE_IDS.has(id)) return true;
	return PUBLIC_ROUTE_PREFIXES.some((prefix) => id.startsWith(prefix + '/'));
}
