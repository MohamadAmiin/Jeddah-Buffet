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

/**
 * THREE values, not two, and the third is why this changed.
 *
 * The default used to be "system", represented by the ABSENCE of a cookie and of
 * an attribute. The product default is now LIGHT, so absence can no longer mean
 * system — absence means "no choice has been made", and the answer to that is
 * light. "system" therefore needs a value it can be stored as.
 */
export type Theme = 'light' | 'dark' | 'system';

/** What a viewer who has never chosen gets. */
export const DEFAULT_THEME: Theme = 'light';

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
	return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

/**
 * The attribute to stamp on <html>, or the EMPTY STRING.
 *
 * The empty string is the "system" state: no attribute at all, so the
 * @media (prefers-color-scheme: dark) block in tokens.css governs.
 *
 * `null` means NO COOKIE — the viewer has never chosen — and that resolves to
 * DEFAULT_THEME, which is light. This is the one line that makes light the product
 * default rather than a coin toss on the viewer's operating system. Someone who
 * wants their OS to decide can still ask for it; they just have to ask.
 */
export function themeAttribute(theme: Theme | null): string {
	const resolved = theme ?? DEFAULT_THEME;
	return resolved === 'system' ? '' : `data-theme="${resolved}"`;
}
