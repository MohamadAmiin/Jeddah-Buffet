import { randomBytes, createHash } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import type { Db, DbTx } from '../db/client';
import { sessions } from '../db/schema/sessions';
import { users, type UserRole } from '../db/schema/users';

/**
 * Any Drizzle handle — the pooled singleton or a transaction.
 *
 * Passed explicitly rather than reached for: the hook holds `db`, a login holds
 * its `tx`, and integration tests hold a handle on the TEST database. It is also
 * what keeps this module importable without $env/dynamic/private, which does not
 * resolve outside SvelteKit.
 */
export type Executor = Db | DbTx;

export const SESSION_COOKIE = 'matcami_dashboard_session';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_RENEW_WITHIN_MS = 15 * 24 * 60 * 60 * 1000; // slide when < 15 days remain

/**
 * The ONLY shape that ever leaves this module.
 *
 * The session goes into event.locals, the dashboard layout returns parts of it,
 * and SvelteKit serialises load data into the page HTML and into __data.json. A
 * `users.*` projection would therefore publish password_hash, the failure counter
 * and the lock timestamp into the browser's cache and history — and, once a later
 * plan adds employees, every employee's PIN hash with it.
 */
export type Principal = {
	userId: string;
	restaurantId: string;
	role: UserRole;
	displayName: string;
	email: string | null;
	sessionId: string;
	expiresAt: Date;
};

/** 32 random bytes, base64url. This value goes in the cookie and is never stored. */
export function generateSessionToken(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * The lowercase hex SHA-256 of the token — what the sessions.id column holds.
 *
 * The separation matters: a database leak then yields hashes, not usable
 * sessions, exactly as password hashes do.
 */
export function sessionIdFromToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a session and return the raw token ONCE.
 *
 * Takes the executor so a login commits its session, its counter reset and its
 * audit row together.
 */
export async function createSession(
	tx: Executor,
	userId: string,
	now: Date = new Date()
): Promise<{ token: string; expiresAt: Date }> {
	// Opportunistic cleanup — no cron, no background job (CLAUDE.md excludes
	// them), and the table is small.
	await tx.delete(sessions).where(lt(sessions.expiresAt, now));

	const token = generateSessionToken();
	const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);

	await tx.insert(sessions).values({
		id: sessionIdFromToken(token),
		userId,
		expiresAt,
		createdAt: now,
		lastSeenAt: now
	});

	return { token, expiresAt };
}

/**
 * Validate a cookie token and project it to a Principal, or null.
 *
 * `now` is injected so expiry and sliding can be tested without sleeping.
 */
export async function validateSessionToken(
	tx: Executor,
	token: string,
	now: Date = new Date()
): Promise<Principal | null> {
	const sessionId = sessionIdFromToken(token);

	// Columns named EXPLICITLY. Never select() the whole users row and narrow it
	// afterwards — see the Principal comment above.
	const rows = await tx
		.select({
			userId: users.id,
			restaurantId: users.restaurantId,
			role: users.role,
			displayName: users.displayName,
			email: users.email,
			isActive: users.isActive,
			sessionId: sessions.id,
			expiresAt: sessions.expiresAt
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.id, sessionId))
		.limit(1);

	const row = rows[0];
	if (!row) return null;

	if (row.expiresAt.getTime() <= now.getTime()) {
		await tx.delete(sessions).where(eq(sessions.id, sessionId));
		return null;
	}

	// Deactivating an employee ends their access on the NEXT REQUEST rather than
	// in 30 days.
	if (!row.isActive) return null;

	let expiresAt = row.expiresAt;
	if (row.expiresAt.getTime() - now.getTime() < SESSION_RENEW_WITHIN_MS) {
		expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
		await tx.update(sessions).set({ expiresAt, lastSeenAt: now }).where(eq(sessions.id, sessionId));
	}

	return {
		userId: row.userId,
		restaurantId: row.restaurantId,
		role: row.role,
		displayName: row.displayName,
		email: row.email,
		sessionId: row.sessionId,
		expiresAt
	};
}

export async function invalidateSession(tx: Executor, sessionId: string): Promise<void> {
	await tx.delete(sessions).where(eq(sessions.id, sessionId));
}

/** What a password reset calls: changing a password ends every other session. */
export async function invalidateAllForUser(tx: Executor, userId: string): Promise<void> {
	await tx.delete(sessions).where(eq(sessions.userId, userId));
}

/**
 * Set the session cookie using SvelteKit's DEFAULTS for httpOnly, sameSite and
 * secure — verified in the installed version as httpOnly: true, sameSite: 'lax',
 * and secure: true for every origin except http://localhost.
 *
 * Do not weaken any of them, and never store the token anywhere but the cookie.
 * sameSite 'lax' plus SvelteKit's origin check — which svelte.config.js
 * deliberately leaves at its default — is the CSRF story; there is no token field
 * in any form in this plan.
 */
export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date): void {
	cookies.set(SESSION_COOKIE, token, { path: '/', expires: expiresAt });
}

export function deleteSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

// TWO CONSTRAINTS THE POS PLANS INHERIT, recorded here because this is where they
// will be tempted to shortcut:
//
//   1. Principal is the DASHBOARD principal. POS and sync routes must resolve
//      their tenant from the registered device row and their actor from the
//      queued operation, NEVER from this cookie.
//
//   2. The sliding refresh belongs on dashboard requests only (T-17 calls it
//      there), so an owner's cookie left on a counter tablet cannot renew itself
//      indefinitely through POS traffic.
//
// Also unresolved, and the device plan's to decide: whether registering a POS
// device on a browser should forcibly end the owner's dashboard session on it.
