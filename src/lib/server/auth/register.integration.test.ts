import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { registerRestaurant, SIGNUP_DAILY_CAP, type RegisterContext } from './register';
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

const base = {
	restaurantName: 'Cafe One',
	timeZone: 'Africa/Mogadishu',
	ownerDisplayName: 'The Owner',
	email: 'owner@cafe.com',
	password: 'a strong enough password'
};
const ctx: RegisterContext = { mode: 'public', ip: '203.0.113.9', userAgent: 'test-agent' };
const operator: RegisterContext = { mode: 'operator', ip: null, userAgent: 'cli:test' };

// A distinct restaurant and email per call, so a test about the cap is never
// secretly a test about the email index.
let seq = 0;
const fresh = () => ({ ...base, restaurantName: `Cafe ${++seq}`, email: `owner${seq}@cafe.com` });

beforeEach(() => {
	resetThrottle();
	forced.failAudit = false;
});

afterAll(async () => {
	await closeTestDb();
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

	it('records the address key a public sign-up was counted under, and null for the operator', async () => {
		await registerRestaurant(db, fresh(), ctx);
		await registerRestaurant(db, fresh(), operator);

		const keys = (await db.select().from(auditLog))
			.filter((r) => r.event === 'restaurant.registered')
			.map((r) => (r.details as { signupKey: string | null }).signupKey);
		expect(keys).toHaveLength(2);
		expect(keys).toContain('203.0.113.9');
		expect(keys).toContain(null);
	});

	// ATOMICITY. If the audit row cannot be written, NOTHING is created — invariant
	// 10's same-transaction rule for registration.
	it('creates nothing at all when the audit write fails', async () => {
		forced.failAudit = true;

		await expect(registerRestaurant(db, base, ctx)).rejects.toThrow('forced audit failure');

		expect(await db.select().from(restaurants)).toHaveLength(0);
		expect(await db.select().from(restaurantSettings)).toHaveLength(0);
		expect(await db.select().from(users)).toHaveLength(0);
		expect(await db.select().from(auditLog)).toHaveLength(0);

		// And the failed attempt used up no sign-up: the same address still succeeds.
		forced.failAudit = false;
		expect((await registerRestaurant(db, base, ctx)).ok).toBe(true);
	});

	it('an invalid time zone creates nothing', async () => {
		const result = await registerRestaurant(db, { ...base, timeZone: 'Not/AZone' }, ctx);
		expect(result).toEqual({ ok: false, reason: 'invalid_time_zone' });
		expect(await db.select().from(restaurants)).toHaveLength(0);
		expect(await db.select().from(users)).toHaveLength(0);
	});

	// PUBLIC SIGN-UP: no first-run gate, no token.
	it('lets more companies sign up after the first', async () => {
		for (let i = 0; i < 3; i++) {
			const result = await registerRestaurant(db, fresh(), { ...ctx, ip: `198.51.100.${i + 10}` });
			expect(result.ok).toBe(true);
		}
		expect(await db.select().from(restaurants)).toHaveLength(3);
		expect(await db.select().from(users)).toHaveLength(3);
	});

	it('refuses a taken email in any letter case, and creates nothing for it', async () => {
		expect((await registerRestaurant(db, base, ctx)).ok).toBe(true);

		const again = await registerRestaurant(
			db,
			{ ...base, restaurantName: 'Cafe Two', email: 'OWNER@cafe.com' },
			{ ...ctx, ip: '198.51.100.20' }
		);

		expect(again).toEqual({ ok: false, reason: 'email_taken' });
		expect(await db.select().from(restaurants)).toHaveLength(1);
		expect(await db.select().from(restaurantSettings)).toHaveLength(1);
	});

	// CONCURRENCY. Genuinely committed transactions on separate connections.
	it('two concurrent sign-ups from different addresses both succeed', async () => {
		const [a, b] = await Promise.all([
			registerRestaurant(db, fresh(), { ...ctx, ip: '198.51.100.1' }),
			registerRestaurant(db, fresh(), { ...ctx, ip: '198.51.100.2' })
		]);

		expect(a.ok && b.ok).toBe(true);
		expect(await db.select().from(restaurants)).toHaveLength(2);
	});

	it('two concurrent sign-ups with the SAME email: one succeeds, one is refused', async () => {
		const [a, b] = await Promise.all([
			registerRestaurant(db, { ...base, restaurantName: 'A' }, { ...ctx, ip: '198.51.100.3' }),
			registerRestaurant(db, { ...base, restaurantName: 'B' }, { ...ctx, ip: '198.51.100.4' })
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
});

describe('the daily cap: 3 new companies per address per 24 hours', () => {
	it('allows the cap, then refuses the next and creates nothing for it', async () => {
		for (let i = 0; i < SIGNUP_DAILY_CAP; i++) {
			expect((await registerRestaurant(db, fresh(), ctx)).ok).toBe(true);
		}

		const over = await registerRestaurant(db, fresh(), ctx);

		expect(over).toEqual({ ok: false, reason: 'signup_limit' });
		expect(await db.select().from(restaurants)).toHaveLength(SIGNUP_DAILY_CAP);
		expect(await db.select().from(users)).toHaveLength(SIGNUP_DAILY_CAP);
	});

	it('counts per address: another address is unaffected', async () => {
		for (let i = 0; i < SIGNUP_DAILY_CAP; i++) await registerRestaurant(db, fresh(), ctx);

		const other = await registerRestaurant(db, fresh(), { ...ctx, ip: '198.51.100.99' });
		expect(other.ok).toBe(true);
	});

	it('gives a whole IPv6 /64 one allowance', async () => {
		for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2::3']) {
			expect((await registerRestaurant(db, fresh(), { ...ctx, ip })).ok).toBe(true);
		}

		const sameSlash64 = await registerRestaurant(db, fresh(), {
			...ctx,
			ip: '2001:db8:1:2:ffff::9'
		});
		expect(sameSlash64).toEqual({ ok: false, reason: 'signup_limit' });

		const nextSlash64 = await registerRestaurant(db, fresh(), { ...ctx, ip: '2001:db8:1:3::1' });
		expect(nextSlash64.ok).toBe(true);
	});

	it('treats an unreadable address as ONE shared key, not a way around the cap', async () => {
		for (let i = 0; i < SIGNUP_DAILY_CAP; i++) {
			expect((await registerRestaurant(db, fresh(), { ...ctx, ip: null })).ok).toBe(true);
		}
		const over = await registerRestaurant(db, fresh(), { ...ctx, ip: null });
		expect(over).toEqual({ ok: false, reason: 'signup_limit' });
	});

	it('counts a rolling 24 hours', async () => {
		const then = new Date('2026-09-10T10:00:00Z');
		for (let i = 0; i < SIGNUP_DAILY_CAP; i++) {
			expect((await registerRestaurant(db, fresh(), { ...ctx, now: then })).ok).toBe(true);
		}

		const within = new Date(then.getTime() + 23 * 60 * 60 * 1000);
		expect(await registerRestaurant(db, fresh(), { ...ctx, now: within })).toEqual({
			ok: false,
			reason: 'signup_limit'
		});

		const after = new Date(then.getTime() + 24 * 60 * 60 * 1000 + 60_000);
		expect((await registerRestaurant(db, fresh(), { ...ctx, now: after })).ok).toBe(true);
	});

	it('holds under concurrency: 10 simultaneous sign-ups from one address create exactly 3', async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, () => registerRestaurant(db, fresh(), ctx))
		);

		expect(results.filter((r) => r.ok)).toHaveLength(SIGNUP_DAILY_CAP);
		for (const r of results.filter((r) => !r.ok)) {
			expect((r as { reason: string }).reason).toBe('signup_limit');
		}
		expect(await db.select().from(restaurants)).toHaveLength(SIGNUP_DAILY_CAP);
	});
});

describe('throttle and operator mode', () => {
	it('public mode is ALWAYS throttled: the 11th attempt from one address in 10 minutes is refused', async () => {
		// Invalid time zones get past the throttle and stop before any hashing or
		// insert, so these ten spend throttle tokens without touching the cap.
		for (let i = 0; i < 10; i++) {
			const result = await registerRestaurant(db, { ...fresh(), timeZone: 'Not/AZone' }, ctx);
			expect(result).toEqual({ ok: false, reason: 'invalid_time_zone' });
		}

		const eleventh = await registerRestaurant(db, fresh(), ctx);

		expect(eleventh.ok).toBe(false);
		expect((eleventh as { reason: string }).reason).toBe('throttled');
		expect((eleventh as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
		expect(await db.select().from(restaurants)).toHaveLength(0);
	});

	it('operator mode skips the throttle and the cap, and does not use up a public allowance', async () => {
		const sameAddress: RegisterContext = { ...operator, ip: '203.0.113.9' };
		for (let i = 0; i < 12; i++) {
			expect((await registerRestaurant(db, fresh(), sameAddress)).ok).toBe(true);
		}
		expect(await db.select().from(restaurants)).toHaveLength(12);

		// Operator rows carry signupKey null, so the public cap never counts them.
		expect((await registerRestaurant(db, fresh(), ctx)).ok).toBe(true);
	});
});
