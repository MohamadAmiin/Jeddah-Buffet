// The theme preference. ISOMORPHIC — imported by the server hook and by the client
// control alike, which is why it sits in src/lib/ and not in src/lib/server/ or
// src/lib/pos/. src/lib/public-routes.ts is the existing precedent: a small module
// the hook and a test both import without dragging in the database client or $env.
//
// matcami_theme IS NOT A SESSION COOKIE. Invariant 12 governs
// matcami_dashboard_session (SESSION_COOKIE in $lib/server/auth/session): HttpOnly,
// Secure, SameSite, never localStorage. This one holds no secret, is never read for
// authorisation, and is deliberately readable by client JavaScript because the
// client is what writes it. Do not give it the session cookie's lifetime or flags,
// do not set it from the server, and never let it influence a guard, a redirect or
// a permission decision.

export const THEME_COOKIE = 'matcami_theme';
export const THEME_MAX_AGE_SECONDS = 31536000; // one year, for the client to use

export type Theme = 'light' | 'dark';

/**
 * Narrow an untrusted string to a Theme, or null.
 *
 * A cookie value is ATTACKER-SUPPLIED: anyone who can run script on the origin, or
 * hand the owner a crafted link on a shared machine, controls it — and it is about
 * to be interpolated into the opening tag of every page. By the time themeAttribute
 * runs, this has already reduced the input to one of two literals or null, so that
 * function can only ever emit one of three fixed strings. Never skip it because a
 * value "looks fine".
 */
export function parseTheme(value: string | undefined): Theme | null {
	return value === 'light' || value === 'dark' ? value : null;
}

/**
 * The attribute to stamp on <html>, or the EMPTY STRING.
 *
 * The empty string IS the "system" state: no attribute at all, so the
 * @media (prefers-color-scheme: dark) block in tokens.css governs. There is
 * deliberately no third Theme value for "system" — absence is how system is
 * represented, in the cookie and in the DOM alike.
 */
export function themeAttribute(theme: Theme | null): string {
	return theme === null ? '' : `data-theme="${theme}"`;
}
