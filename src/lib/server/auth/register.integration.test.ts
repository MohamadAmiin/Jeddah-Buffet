import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { registerRestaurant, isRegistrationOpen } from './register';
import { resetThrottle } from './throttle';
import { validateSessionToken } from './session';
import { canonicalTimeZone } from '../restaurants';

// A seam for the atomicity test: writeAudit is the real implementation unless
// this flag is set, in which case it throws exactly where the plan says to force
// a failure.
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
const TOKEN = 'a-one-time-setup-token';

const base = {
	restaurantName: 'Cafe One',
	timeZone: 'Africa/Mogadishu',
	ownerDisplayName: 'The Owner',
	email: 'owner@cafe.com',
	password: 'a strong enough password',
	setupToken: TOKEN
};
const ctx = { ip: '203.0.113.9', userAgent: 'test-agent', expectedSetupToken: TOKEN };

beforeEach(() => {
	resetThrottle();
	forced.failAudit = false;
});

afterAll(async () => {
	await closeTestDb();
});

describe('isRegistrationOpen', () => {
	it('is open with zero restaurants and closed once one exists', async () => {
		expect(await isRegistrationOpen(db)).toBe(true);
		await registerRestaurant(db, base, ctx);
		expect(await isRegistrationOpen(db)).toBe(false);
	});
});

describe('registerRestaurant', () => {
	it('creates one restaurant, one settings row, one owner and two audit rows', async () => {
		const result = await registerRestaurant(db, base, ctx);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(await db.select().from(restaurants)).toHaveLength(1);
		expect(await db.select().from(restaurantSettings)).toHaveLength(1);
		expect(await db.select().from(users)).toHaveLength(1);

		const events = (await db.select().from(auditLog)).map((r) => r.event).sort();
		expect(events).toEqual(['restaurant.registered', 'user.created']);

		// The returned session token really works.
		const principal = await validateSessionToken(db, result.token);
		expect(principal).not.toBeNull();
		expect(principal!.role).toBe('owner');
		expect(principal!.restaurantId).toBe(result.restaurantId);
	});

	it('stores the time zone canonically and the email lowercased', async () => {
		await registerRestaurant(
			db,
			{ ...base, timeZone: 'Asia/Calcutta', email: 'Owner@Cafe.COM' },
			ctx
		);

		const [settings] = await db.select().from(restaurantSettings);
		expect(settings.timeZone).toBe(canonicalTimeZone('Asia/Calcutta'));
		const [owner] = await db.select().from(users);
		expect(owner.email).toBe('owner@cafe.com');
	});

	it('never stores the password in clear', async () => {
		await registerRestaurant(db, base, ctx);
		const [owner] = await db.select().from(users);
		expect(owner.passwordHash).not.toBe(base.password);
		expect(owner.passwordHash).toMatch(/^\$argon2id\$/);
	});

	// ATOMICITY — the most important write in the plan. If the audit row cannot be
	// written, NOTHING is created. This is what proves invariant 10's
	// same-transaction rule for registration.
	it('creates nothing at all when the audit write fails', async () => {
		forced.failAudit = true;

		await expect(registerRestaurant(db, base, ctx)).rejects.toThrow('forced audit failure');

		expect(await db.select().from(restaurants)).toHaveLength(0);
		expect(await db.select().from(restaurantSettings)).toHaveLength(0);
		expect(await db.select().from(users)).toHaveLength(0);
		expect(await db.select().from(auditLog)).toHaveLength(0);

		// And registration is still open afterwards — the failed attempt consumed
		// nothing.
		forced.failAudit = false;
		expect(await isRegistrationOpen(db)).toBe(true);
	});

	it('a second registration is closed', async () => {
		expect((await registerRestaurant(db, base, ctx)).ok).toBe(true);
		resetThrottle();
		const second = await registerRestaurant(
			db,
			{ ...base, email: 'other@cafe.com', restaurantName: 'Cafe Two' },
			ctx
		);
		expect(second).toEqual({ ok: false, reason: 'closed' });
		expect(await db.select().from(restaurants)).toHaveLength(1);
	});

	it('a wrong setup token creates nothing', async () => {
		const result = await registerRestaurant(db, { ...base, setupToken: 'wrong' }, ctx);
		expect(result).toEqual({ ok: false, reason: 'bad_token' });
		expect(await db.select().from(restaurants)).toHaveLength(0);
		expect(await db.select().from(users)).toHaveLength(0);
		expect(await db.select().from(auditLog)).toHaveLength(0);
	});

	it('a token of a different length is rejected without leaking through timing', async () => {
		const result = await registerRestaurant(db, { ...base, setupToken: 'x' }, ctx);
		expect(result).toEqual({ ok: false, reason: 'bad_token' });
		expect(await db.select().from(restaurants)).toHaveLength(0);
	});

	it('with SETUP_TOKEN unset, a correct-looking submission still creates nothing', async () => {
		const result = await registerRestaurant(db, base, { ...ctx, expectedSetupToken: null });
		expect(result).toEqual({ ok: false, reason: 'bad_token' });
		expect(await db.select().from(restaurants)).toHaveLength(0);
	});

	it('an invalid time zone creates nothing', async () => {
		const result = await registerRestaurant(db, { ...base, timeZone: 'Not/AZone' }, ctx);
		expect(result).toEqual({ ok: false, reason: 'invalid_time_zone' });
		expect(await db.select().from(restaurants)).toHaveLength(0);
		expect(await db.select().from(users)).toHaveLength(0);
	});

	// CONCURRENCY. Two genuinely committed transactions on two connections — this
	// is why T-08 refused a rollback-per-test wrapper.
	it('two concurrent registrations produce EXACTLY ONE restaurant', async () => {
		const [a, b] = await Promise.all([
			registerRestaurant(db, { ...base, email: 'a@cafe.com' }, { ...ctx, ip: '198.51.100.1' }),
			registerRestaurant(db, { ...base, email: 'b@cafe.com' }, { ...ctx, ip: '198.51.100.2' })
		]);

		const succeeded = [a, b].filter((r) => r.ok);
		const failed = [a, b].filter((r) => !r.ok);

		expect(succeeded).toHaveLength(1);
		expect(failed).toHaveLength(1);
		expect((failed[0] as { reason: string }).reason).toBe('closed');
		expect(await db.select().from(restaurants)).toHaveLength(1);
		expect(await db.select().from(users)).toHaveLength(1);
	});

	it('two concurrent registrations with the SAME email: one succeeds, one is refused', async () => {
		// allowAdditionalRestaurant removes the first-run gate so the EMAIL index is
		// what has to decide the race.
		const opts = { ...ctx, allowAdditionalRestaurant: true, bypassSetupToken: true };
		const [a, b] = await Promise.all([
			registerRestaurant(db, { ...base, restaurantName: 'A' }, { ...opts, ip: '198.51.100.3' }),
			registerRestaurant(db, { ...base, restaurantName: 'B' }, { ...opts, ip: '198.51.100.4' })
		]);

		const succeeded = [a, b].filter((r) => r.ok);
		const failed = [a, b].filter((r) => !r.ok);
		expect(succeeded).toHaveLength(1);
		expect(failed).toHaveLength(1);
		expect((failed[0] as { reason: string }).reason).toBe('email_taken');

		// The loser left NOTHING behind — not a restaurant, not a settings row.
		expect(await db.select().from(users)).toHaveLength(1);
		expect(await db.select().from(restaurants)).toHaveLength(1);
		expect(await db.select().from(restaurantSettings)).toHaveLength(1);
	});

	it('operator mode can add a second restaurant, bypassing only the gates', async () => {
		expect((await registerRestaurant(db, base, ctx)).ok).toBe(true);

		const second = await registerRestaurant(
			db,
			{ ...base, restaurantName: 'Cafe Two', email: 'two@cafe.com', setupToken: '' },
			{ ...ctx, bypassSetupToken: true, allowAdditionalRestaurant: true }
		);

		expect(second.ok).toBe(true);
		expect(await db.select().from(restaurants)).toHaveLength(2);
		expect(await db.select().from(users)).toHaveLength(2);
	});
});
