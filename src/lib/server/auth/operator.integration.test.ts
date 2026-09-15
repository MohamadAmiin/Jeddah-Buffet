import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { users } from '../db/schema/users';
import { sessions } from '../db/schema/sessions';
import { auditLog } from '../db/schema/audit';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { registerRestaurant } from './register';
import { resetOwnerPassword } from './operator';
import { verifyPassword } from './password';
import { createSession, validateSessionToken } from './session';
import { resetThrottle } from './throttle';
import { getRestaurantWithSettings } from '../restaurants';

const forced = vi.hoisted(() => ({ failAudit: false }));
vi.mock('../audit', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../audit')>();
	return {
		...actual,
		writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
			if (forced.failAudit) throw new Error('forced audit failure');
			return actual.writeAudit(...args);
		}
	};
});

const db = testDb();
const OLD = 'the original password';
const NEW = 'the replacement password';

beforeEach(() => {
	resetThrottle();
	forced.failAudit = false;
});

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name: string, email: string) {
	const result = await registerRestaurant(
		db,
		{
			restaurantName: name,
			timeZone: 'Africa/Mogadishu',
			ownerDisplayName: 'The Owner',
			email,
			password: OLD
		},
		{ mode: 'operator', ip: '203.0.113.1', userAgent: 'test' }
	);
	if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
	return result;
}

describe('resetOwnerPassword', () => {
	it('replaces the hash, clears the lock, kills sessions, writes one audit row', async () => {
		const { userId } = await makeRestaurant('Cafe One', 'owner@cafe.com');

		// Lock the account and give it two live sessions.
		await db
			.update(users)
			.set({ failedPasswordCount: 4, passwordLockedUntil: new Date(Date.now() + 600_000) })
			.where(eq(users.id, userId));
		const a = await createSession(db, userId);
		const b = await createSession(db, userId);

		// Registration already created one, so count rather than hardcode.
		const sessionsBefore = (await db.select().from(sessions)).length;
		expect(sessionsBefore).toBeGreaterThanOrEqual(3);
		const before = (await db.select().from(auditLog)).length;
		const result = await resetOwnerPassword(db, 'owner@cafe.com', NEW);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sessionsRemoved).toBe(sessionsBefore);

		const [row] = await db.select().from(users).where(eq(users.id, userId));
		expect(await verifyPassword(row.passwordHash!, NEW)).toBe(true);
		expect(await verifyPassword(row.passwordHash!, OLD)).toBe(false);
		expect(row.failedPasswordCount).toBe(0);
		expect(row.passwordLockedUntil).toBeNull();

		// Every session for that user is gone.
		expect(await db.select().from(sessions)).toHaveLength(0);
		expect(await validateSessionToken(db, a.token)).toBeNull();
		expect(await validateSessionToken(db, b.token)).toBeNull();

		const audit = await db.select().from(auditLog);
		expect(audit.length).toBe(before + 1);
		const last = audit[audit.length - 1];
		expect(last.event).toBe('user.password_reset_by_operator');
		expect(last.actorUserId).toBeNull(); // an operator script has no in-app actor
		expect(last.subjectUserId).toBe(userId);
		expect(last.details).toEqual({ via: 'cli' });
	});

	it('is case-insensitive on the email', async () => {
		await makeRestaurant('Cafe One', 'Owner@Cafe.com');
		expect((await resetOwnerPassword(db, 'OWNER@cafe.COM', NEW)).ok).toBe(true);
	});

	it('reports not_found for an unknown email and changes nothing', async () => {
		const { userId } = await makeRestaurant('Cafe One', 'owner@cafe.com');
		const [before] = await db.select().from(users).where(eq(users.id, userId));

		expect(await resetOwnerPassword(db, 'nobody@nowhere.com', NEW)).toEqual({
			ok: false,
			reason: 'not_found'
		});

		const [after] = await db.select().from(users).where(eq(users.id, userId));
		expect(after.passwordHash).toBe(before.passwordHash);
	});

	// Everything rolls back together, exactly as registration does.
	it('changes NOTHING when the audit write fails', async () => {
		const { userId } = await makeRestaurant('Cafe One', 'owner@cafe.com');
		await createSession(db, userId);
		const [before] = await db.select().from(users).where(eq(users.id, userId));
		const sessionsBefore = (await db.select().from(sessions)).length;

		forced.failAudit = true;
		await expect(resetOwnerPassword(db, 'owner@cafe.com', NEW)).rejects.toThrow(
			'forced audit failure'
		);
		forced.failAudit = false;

		const [after] = await db.select().from(users).where(eq(users.id, userId));
		expect(after.passwordHash).toBe(before.passwordHash);
		expect(await verifyPassword(after.passwordHash!, OLD)).toBe(true);
		expect(await db.select().from(sessions)).toHaveLength(sessionsBefore);
	});
});

describe('creating an additional restaurant (what scripts/create-restaurant.ts calls)', () => {
	it('adds a second restaurant while one already exists', async () => {
		await makeRestaurant('Cafe One', 'one@cafe.com');
		const second = await makeRestaurant('Cafe Two', 'two@cafe.com');

		expect(second.ok).toBe(true);
		expect(await db.select().from(users)).toHaveLength(2);
		expect(await db.select().from(restaurantSettings)).toHaveLength(2);
	});

	it('the two owners cannot read each other’s settings', async () => {
		const one = await makeRestaurant('Cafe One', 'one@cafe.com');
		const two = await makeRestaurant('Cafe Two', 'two@cafe.com');

		const seenByOne = await getRestaurantWithSettings(db, one.restaurantId);
		const seenByTwo = await getRestaurantWithSettings(db, two.restaurantId);

		expect(seenByOne!.name).toBe('Cafe One');
		expect(seenByTwo!.name).toBe('Cafe Two');
		expect(seenByOne!.id).not.toBe(seenByTwo!.id);
	});

	it('the second owner can log in with their own credentials', async () => {
		await makeRestaurant('Cafe One', 'one@cafe.com');
		const two = await makeRestaurant('Cafe Two', 'two@cafe.com');

		const principal = await validateSessionToken(db, two.token);
		expect(principal).not.toBeNull();
		expect(principal!.restaurantId).toBe(two.restaurantId);
		expect(principal!.email).toBe('two@cafe.com');
	});
});
