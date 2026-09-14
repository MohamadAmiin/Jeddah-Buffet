import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { sessions } from '../db/schema/sessions';
import {
	createSession,
	validateSessionToken,
	invalidateSession,
	invalidateAllForUser,
	sessionIdFromToken,
	generateSessionToken
} from './session';

const db = testDb();
const DAY = 24 * 60 * 60 * 1000;

afterAll(async () => {
	await closeTestDb();
});

async function makeOwner(email = 'owner@cafe.com', name = 'Cafe One') {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	const [user] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	return { restaurantId: restaurant.id, userId: user.id };
}

describe('session lifecycle', () => {
	it('creates a session and validates it into a Principal', async () => {
		const { restaurantId, userId } = await makeOwner();
		const { token, expiresAt } = await createSession(db, userId);

		const principal = await validateSessionToken(db, token);
		expect(principal).not.toBeNull();
		expect(principal!.userId).toBe(userId);
		expect(principal!.restaurantId).toBe(restaurantId);
		expect(principal!.role).toBe('owner');
		expect(principal!.displayName).toBe('The Owner');
		expect(principal!.email).toBe('owner@cafe.com');
		expect(principal!.sessionId).toBe(sessionIdFromToken(token));
		expect(principal!.expiresAt.getTime()).toBe(expiresAt.getTime());
	});

	it('stores the HASH of the token, never the token itself', async () => {
		const { userId } = await makeOwner();
		const { token } = await createSession(db, userId);

		const rows = await db.select().from(sessions);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(sessionIdFromToken(token));
		expect(rows[0].id).not.toBe(token);
		expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/);
	});

	it('returns null for a token that was never issued', async () => {
		await makeOwner();
		expect(await validateSessionToken(db, generateSessionToken())).toBeNull();
	});

	it('returns null for an expired session AND deletes its row', async () => {
		const { userId } = await makeOwner();
		const { token } = await createSession(db, userId);

		// 31 days later: past the 30-day lifetime.
		const later = new Date(Date.now() + 31 * DAY);
		expect(await validateSessionToken(db, token, later)).toBeNull();

		const rows = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionIdFromToken(token)));
		expect(rows).toHaveLength(0);
	});

	it('returns null when the user is deactivated', async () => {
		const { userId } = await makeOwner();
		const { token } = await createSession(db, userId);

		await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
		expect(await validateSessionToken(db, token)).toBeNull();
	});

	it('extends a session with 14 days left, and moves last_seen_at', async () => {
		const { userId } = await makeOwner();
		const { token, expiresAt } = await createSession(db, userId);
		const sessionId = sessionIdFromToken(token);
		const [before] = await db.select().from(sessions).where(eq(sessions.id, sessionId));

		// 16 days in => 14 days remain, inside the 15-day slide threshold.
		const now = new Date(Date.now() + 16 * DAY);
		const principal = await validateSessionToken(db, token, now);

		expect(principal).not.toBeNull();
		expect(principal!.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime());

		const [after] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(after.expiresAt.getTime()).toBe(principal!.expiresAt.getTime());
		expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
	});

	it('does NOT extend a session with 20 days left', async () => {
		const { userId } = await makeOwner();
		const { token, expiresAt } = await createSession(db, userId);
		const sessionId = sessionIdFromToken(token);

		// 10 days in => 20 days remain, outside the threshold.
		const now = new Date(Date.now() + 10 * DAY);
		const principal = await validateSessionToken(db, token, now);

		expect(principal).not.toBeNull();
		expect(principal!.expiresAt.getTime()).toBe(expiresAt.getTime());

		const [after] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(after.expiresAt.getTime()).toBe(expiresAt.getTime());
	});

	it('invalidateSession removes exactly that session', async () => {
		const { userId } = await makeOwner();
		const a = await createSession(db, userId);
		const b = await createSession(db, userId);

		await invalidateSession(db, sessionIdFromToken(a.token));

		expect(await validateSessionToken(db, a.token)).toBeNull();
		expect(await validateSessionToken(db, b.token)).not.toBeNull();
	});

	it('invalidateAllForUser removes that user’s sessions and nobody else’s', async () => {
		const one = await makeOwner('one@cafe.com', 'Cafe One');
		const two = await makeOwner('two@cafe.com', 'Cafe Two');
		const oneToken = (await createSession(db, one.userId)).token;
		const alsoOne = (await createSession(db, one.userId)).token;
		const twoToken = (await createSession(db, two.userId)).token;

		await invalidateAllForUser(db, one.userId);

		expect(await validateSessionToken(db, oneToken)).toBeNull();
		expect(await validateSessionToken(db, alsoOne)).toBeNull();
		expect(await validateSessionToken(db, twoToken)).not.toBeNull();
	});

	it('deletes expired sessions opportunistically when a new one is created', async () => {
		const { userId } = await makeOwner();
		const stale = await createSession(db, userId);
		// Force it into the past.
		await db
			.update(sessions)
			.set({ expiresAt: new Date(Date.now() - DAY) })
			.where(eq(sessions.id, sessionIdFromToken(stale.token)));

		await createSession(db, userId);

		const rows = await db.select().from(sessions);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).not.toBe(sessionIdFromToken(stale.token));
	});

	// THE TEST THAT MUST NEVER BE DELETED. SvelteKit serialises load data into the
	// page HTML and into __data.json, so widening this projection would publish
	// password_hash — and later every employee's PIN hash — to the browser.
	it('the Principal carries no credential or lockout field', async () => {
		const { userId } = await makeOwner();
		const { token } = await createSession(db, userId);
		const principal = await validateSessionToken(db, token);

		const forbidden = /hash|password|pin|locked|failed/i;

		for (const key of Object.keys(principal!)) {
			expect(key, `Principal exposes "${key}"`).not.toMatch(forbidden);
		}
		// Also over the serialised form, which is what actually reaches the browser.
		expect(JSON.stringify(principal)).not.toMatch(forbidden);

		expect(Object.keys(principal!).sort()).toEqual([
			'displayName',
			'email',
			'expiresAt',
			'restaurantId',
			'role',
			'sessionId',
			'userId'
		]);
	});
});
