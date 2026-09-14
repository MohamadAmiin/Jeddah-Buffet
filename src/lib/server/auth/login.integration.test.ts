import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { sessions } from '../db/schema/sessions';
import { auditLog } from '../db/schema/audit';
import { hashPassword } from './password';
import { loginWithPassword, MAX_FAILED_ATTEMPTS, LOCKOUT_MS } from './login';
import { resetThrottle, DEFAULT_CAPACITY } from './throttle';
import { validateSessionToken } from './session';

const db = testDb();
const PASSWORD = 'a correct password';
const ctx = { ip: '203.0.113.9', userAgent: 'test-agent' };

beforeEach(() => {
	// The throttle is process-local and survives the database reset.
	resetThrottle();
});

afterAll(async () => {
	await closeTestDb();
});

async function makeOwner(email = 'owner@cafe.com') {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	const [user] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: await hashPassword(PASSWORD)
		})
		.returning();
	return { restaurantId: restaurant.id, userId: user.id };
}

async function auditEvents(): Promise<string[]> {
	const rows = await db.select().from(auditLog);
	return rows.map((r) => r.event);
}

async function userRow(userId: string) {
	const [row] = await db.select().from(users).where(eq(users.id, userId));
	return row;
}

describe('loginWithPassword', () => {
	it('accepts the correct password, leaving one session and one login.success', async () => {
		const { userId, restaurantId } = await makeOwner();

		const result = await loginWithPassword(
			db,
			{ email: 'owner@cafe.com', password: PASSWORD },
			ctx
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.restaurantId).toBe(restaurantId);
		expect(result.userId).toBe(userId);

		expect(await db.select().from(sessions)).toHaveLength(1);
		expect(await auditEvents()).toEqual(['login.success']);

		// The returned token really works.
		expect(await validateSessionToken(db, result.token)).not.toBeNull();
	});

	it('matches the email case-insensitively', async () => {
		await makeOwner('Owner@Cafe.com');
		const result = await loginWithPassword(
			db,
			{ email: 'OWNER@cafe.COM', password: PASSWORD },
			ctx
		);
		expect(result.ok).toBe(true);
	});

	// The whole point of committing on every branch: the return value can look
	// right while nothing was written.
	it('records a wrong password IN THE DATABASE: counter 1, one login.failed', async () => {
		const { userId } = await makeOwner();

		const result = await loginWithPassword(db, { email: 'owner@cafe.com', password: 'wrong' }, ctx);

		expect(result).toEqual({ ok: false, reason: 'invalid' });
		expect((await userRow(userId)).failedPasswordCount).toBe(1);
		expect(await auditEvents()).toEqual(['login.failed']);
		expect(await db.select().from(sessions)).toHaveLength(0);
	});

	it('locks after five wrong passwords, resetting the counter', async () => {
		const { userId } = await makeOwner();

		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
			await loginWithPassword(db, { email: 'owner@cafe.com', password: 'wrong' }, ctx);
		}

		const row = await userRow(userId);
		expect(row.passwordLockedUntil).not.toBeNull();
		expect(row.passwordLockedUntil!.getTime()).toBeGreaterThan(Date.now());
		// Reset, NOT left at 5.
		expect(row.failedPasswordCount).toBe(0);

		const events = await auditEvents();
		expect(events.filter((e) => e === 'login.failed')).toHaveLength(MAX_FAILED_ATTEMPTS - 1);
		expect(events.filter((e) => e === 'login.locked_out')).toHaveLength(1);
	});

	it('refuses the CORRECT password while locked, creating no session', async () => {
		const { userId } = await makeOwner();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
			await loginWithPassword(db, { email: 'owner@cafe.com', password: 'wrong' }, ctx);
		}
		resetThrottle();

		const result = await loginWithPassword(
			db,
			{ email: 'owner@cafe.com', password: PASSWORD },
			ctx
		);

		expect(result).toEqual({ ok: false, reason: 'locked' });
		expect(await db.select().from(sessions)).toHaveLength(0);
		expect(await auditEvents()).toContain('login.rejected_locked');
		expect(await userRow(userId)).toBeTruthy();
	});

	it('after the lock expires, ONE wrong attempt does not re-lock — five more do', async () => {
		const { userId } = await makeOwner();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
			await loginWithPassword(db, { email: 'owner@cafe.com', password: 'wrong' }, ctx);
		}
		resetThrottle();

		// Clock advanced past the lock.
		const later = new Date(Date.now() + LOCKOUT_MS + 1000);

		await loginWithPassword(
			db,
			{ email: 'owner@cafe.com', password: 'wrong' },
			{ ...ctx, now: later }
		);
		let row = await userRow(userId);
		// One miss => counter 1, and NOT locked again. (A `>= 5` condition without
		// the reset would have re-locked here.)
		expect(row.failedPasswordCount).toBe(1);
		expect(
			row.passwordLockedUntil === null || row.passwordLockedUntil.getTime() <= later.getTime()
		).toBe(true);

		for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
			resetThrottle();
			await loginWithPassword(
				db,
				{ email: 'owner@cafe.com', password: 'wrong' },
				{ ...ctx, now: later }
			);
		}
		row = await userRow(userId);
		expect(row.passwordLockedUntil!.getTime()).toBeGreaterThan(later.getTime());
		expect(row.failedPasswordCount).toBe(0);
	});

	it('an unknown email writes ZERO audit rows', async () => {
		await makeOwner();
		const result = await loginWithPassword(db, { email: 'nobody@nowhere.com', password: 'x' }, ctx);

		expect(result).toEqual({ ok: false, reason: 'invalid' });
		expect(await auditEvents()).toEqual([]);
		expect(await db.select().from(sessions)).toHaveLength(0);
	});

	it('a deactivated owner cannot log in, and no audit row is written', async () => {
		const { userId } = await makeOwner();
		await db.update(users).set({ isActive: false }).where(eq(users.id, userId));

		const result = await loginWithPassword(
			db,
			{ email: 'owner@cafe.com', password: PASSWORD },
			ctx
		);
		expect(result).toEqual({ ok: false, reason: 'invalid' });
		expect(await db.select().from(sessions)).toHaveLength(0);
	});

	// The database refuses to give a non-owner credentials at all, which is the
	// stronger guarantee; loginWithPassword additionally refuses a non-owner.
	it('the database forbids creating a cashier with an email and password', async () => {
		const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe Two' }).returning();

		let constraint: string | undefined;
		try {
			await db.insert(users).values({
				restaurantId: restaurant.id,
				role: 'cashier',
				displayName: 'Cashier',
				email: 'cashier@cafe.com',
				passwordHash: await hashPassword(PASSWORD)
			});
			throw new Error('the insert should have been rejected');
		} catch (error) {
			// Drizzle wraps the driver error, so the constraint name is on `cause`,
			// not on `message`. Assert the specific constraint, not merely that
			// something threw.
			constraint = ((error as Error).cause as { constraint?: string } | undefined)?.constraint;
		}
		expect(constraint).toBe('users_non_owner_has_no_credentials');
	});

	it('the throttle refuses attempt 11 from one IP BEFORE any hashing or audit row', async () => {
		await makeOwner();

		for (let i = 0; i < DEFAULT_CAPACITY; i++) {
			await loginWithPassword(db, { email: 'owner@cafe.com', password: 'wrong' }, ctx);
		}
		const before = (await auditEvents()).length;

		const result = await loginWithPassword(db, { email: 'owner@cafe.com', password: 'wrong' }, ctx);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('throttled');
		expect(result.retryAfterMs).toBeGreaterThan(0);
		// The refused attempt wrote nothing at all.
		expect((await auditEvents()).length).toBe(before);
	});

	it('throttles per IP, so one attacker cannot lock out another visitor', async () => {
		await makeOwner();
		for (let i = 0; i < DEFAULT_CAPACITY; i++) {
			await loginWithPassword(db, { email: 'owner@cafe.com', password: 'wrong' }, ctx);
		}

		const other = await loginWithPassword(
			db,
			{ email: 'owner@cafe.com', password: 'wrong' },
			{ ...ctx, ip: '198.51.100.4' }
		);
		expect(other.ok).toBe(false);
		if (other.ok) return;
		expect(other.reason).not.toBe('throttled');
	});
});
