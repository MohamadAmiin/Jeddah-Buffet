/**
 * Pure helpers for the login route, in their own module so they can be unit
 * tested. +page.server.ts imports the database client, which reaches
 * $env/dynamic/private and cannot be loaded by a plain-node Vitest project.
 */

/**
 * Validate a `?next=` value before redirecting to it.
 *
 * SvelteKit's redirect() passes `location.toString()` straight through with NO
 * validation, so an unvalidated value is an OPEN REDIRECT: a phishing mail
 * linking /login?next=https://evil.example gets the owner to log in correctly and
 * then lands them on a look-alike "session expired, sign in again" page.
 *
 * Accepted only when BOTH hold:
 *   - it matches /^\/(?![/\\])/ — a single leading slash not followed by another
 *     slash or a backslash, so //evil.example and /\evil.example are refused;
 *   - it resolves to the same origin.
 */
export function safeNext(next: string | null | undefined, origin: string): string {
	const fallback = '/dashboard';
	if (!next) return fallback;
	if (!/^\/(?![/\\])/.test(next)) return fallback;

	try {
		if (new URL(next, origin).origin !== origin) return fallback;
	} catch {
		return fallback;
	}
	return next;
}

/**
 * The payload a failed login returns to the page.
 *
 * NEVER `return fail(400, { ...data })`. The idiomatic spread serialises the
 * whole submitted body into the action response and into __data.json, from where
 * it reaches the browser cache, the history entry and any error tooling that
 * captures page data — password included.
 *
 * The message is deliberately the SAME for a wrong password and a locked account,
 * so the response cannot be used to discover which addresses are registered or
 * which accounts are currently locked.
 */
export const GENERIC_LOGIN_ERROR = 'Email or password is incorrect';

export function loginFailPayload(
	email: string,
	options: { retryAfterMs?: number } = {}
): { email: string; message: string; retryAfterMs?: number } {
	const payload: { email: string; message: string; retryAfterMs?: number } = {
		email,
		message: GENERIC_LOGIN_ERROR
	};
	// retryAfterMs is about the CALLER's own behaviour, so it is safe to disclose —
	// and only present when the throttle refused the request.
	if (options.retryAfterMs !== undefined) payload.retryAfterMs = options.retryAfterMs;
	return payload;
}
