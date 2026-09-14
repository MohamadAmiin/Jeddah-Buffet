/**
 * Route ids that answer WITHOUT a session. Everything else is denied by default.
 *
 * THE SINGLE SOURCE. src/hooks.server.ts imports and re-exports it, and
 * src/routes/route-guards.test.ts imports it — neither copies it, or the two
 * would drift and the guard test would start passing against a list that is no
 * longer the one enforced.
 *
 * It lives here, rather than in hooks.server.ts, so the test can read it without
 * pulling in the database client and $env/dynamic/private.
 *
 * Adding an entry makes a route reachable with no session at all. That should be
 * a deliberate, reviewed act; route-guards.test.ts asserts the exact contents so
 * a casual addition fails.
 */
export const PUBLIC_ROUTE_IDS: ReadonlySet<string> = new Set(['/', '/login', '/register']);
