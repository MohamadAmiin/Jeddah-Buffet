import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, like, sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { hashPin } from '$lib/pin';
import { DEVICE_COOKIE, registerDevice, revokeDevice } from '$lib/server/auth/pos-device';
import { POST } from './+server';

const db = testDb();

// One real 600,000-iteration hash for the whole file.
let PIN_1234: string;

beforeAll(async () => {
	PIN_1234 = await hashPin('1234');
});

afterAll(async () => {
	await closeTestDb();
});

type Fixture = {
	restaurantId: string;
	ownerId: string;
	cashierId: string;
	deviceId: string;
	token: string;
};

async function makeFixture(email = 'owner@cafe.com'): Promise<Fixture> {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const [cashier] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'cashier',
			displayName: 'Sam',
			pinHash: PIN_1234,
			failedPasswordCount: 2
		})
		.returning();
	const { deviceId, token } = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId: restaurant.id, actorUserId: owner.id, label: 'Till' })
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, cashierId: cashier.id, deviceId, token };
}

function makeEvent(body: unknown, cookies: Record<string, string>): RequestEvent {
	const jar = new Map(Object.entries(cookies));
	const url = new URL('http://localhost/api/pos/pin');
	return {
		cookies: {
			get: (name: string) => jar.get(name),
			getAll: () => [...jar].map(([name, value]) => ({ name, value })),
			set: (name: string, value: string) => jar.set(name, value),
			delete: (name: string) => jar.delete(name),
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '203.0.113.5',
		locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null },
		params: {},
		platform: undefined,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'http://localhost' },
			body: JSON.stringify(body)
		}),
		route: { id: '/api/pos/pin' },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

/** POST, reporting the status and the parsed body — or the thrown status for a refusal. */
async function post(
	body: unknown,
	cookies: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> | null }> {
	try {
		const response = await POST(makeEvent(body, cookies));
		return { status: response.status, body: await response.json() };
	} catch (thrown) {
		const status = (thrown as { status?: number }).status;
		if (status === undefined) throw thrown;
		return { status, body: null };
	}
}

const withDevice = (f: Fixture) => ({ [DEVICE_COOKIE]: f.token });

async function pinRows(clientOpId?: string) {
	return db
		.select({ event: auditLog.event, details: auditLog.details, clientOpId: auditLog.clientOpId })
		.from(auditLog)
		.where(
			clientOpId
				? and(like(auditLog.event, 'pos.pin.%'), eq(auditLog.clientOpId, clientOpId))
				: like(auditLog.event, 'pos.pin.%')
		)
		.orderBy(auditLog.id);
}

async function countAudit(): Promise<number> {
	const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
	return row.n;
}

async function cashier(f: Fixture) {
	const [row] = await db.select().from(users).where(eq(users.id, f.cashierId));
	return row;
}

describe('POST /api/pos/pin', () => {
	// MANDATORY (spec 29 — a permission check test on every POS API route).
	it('answers exactly 403 with no device cookie, and to a revoked device, writing nothing', async () => {
		const f = await makeFixture();
		const body = { employeeId: f.cashierId, pin: '1234' };

		expect((await post(body, {})).status).toBe(403);

		await db.transaction((tx) =>
			revokeDevice(tx, {
				deviceId: f.deviceId,
				restaurantId: f.restaurantId,
				actorUserId: f.ownerId
			})
		);
		expect((await post(body, withDevice(f))).status).toBe(403);

		expect(await countAudit()).toBe(0);
	});

	// MANDATORY (spec 29 — offline sync: retries never create duplicates). The same
	// body twice, key included: the second answer is the first answer, one row, one
	// counter move — for 200, 401 and 423.
	it('replays a retried attempt instead of repeating it — success, wrong PIN and lockout', async () => {
		const f = await makeFixture();

		// 200
		const okKey = crypto.randomUUID();
		const ok1 = await post(
			{ employeeId: f.cashierId, pin: '1234', clientOpId: okKey },
			withDevice(f)
		);
		const ok2 = await post(
			{ employeeId: f.cashierId, pin: '1234', clientOpId: okKey },
			withDevice(f)
		);
		expect(ok1).toEqual({
			status: 200,
			body: { employeeId: f.cashierId, displayName: 'Sam', role: 'cashier' }
		});
		expect(ok2).toEqual(ok1);
		expect(await pinRows(okKey)).toHaveLength(1);

		// 401 — the counter moves once, not twice.
		const badKey = crypto.randomUUID();
		const bad1 = await post(
			{ employeeId: f.cashierId, pin: '9999', clientOpId: badKey },
			withDevice(f)
		);
		const bad2 = await post(
			{ employeeId: f.cashierId, pin: '9999', clientOpId: badKey },
			withDevice(f)
		);
		expect(bad1).toEqual({ status: 401, body: { error: 'invalid_pin' } });
		expect(bad2).toEqual(bad1);
		expect(await pinRows(badKey)).toHaveLength(1);
		expect((await cashier(f)).failedPinCount).toBe(1);

		// 423 — three more distinct misses, then the fifth, which locks; its retry
		// answers 423 too. The remaining time is recomputed from the stored lock
		// (T-19 step 6), so it can only shrink by the moments between the calls.
		for (let i = 0; i < 3; i++) {
			await post(
				{ employeeId: f.cashierId, pin: '9999', clientOpId: crypto.randomUUID() },
				withDevice(f)
			);
		}
		const lockKey = crypto.randomUUID();
		const lock1 = await post(
			{ employeeId: f.cashierId, pin: '9999', clientOpId: lockKey },
			withDevice(f)
		);
		const lock2 = await post(
			{ employeeId: f.cashierId, pin: '9999', clientOpId: lockKey },
			withDevice(f)
		);
		expect(lock1.status).toBe(423);
		expect(lock2.status).toBe(423);
		expect(lock1.body!.error).toBe('locked_out');
		expect(lock2.body!.error).toBe('locked_out');
		expect(lock1.body!.retryAfterMs).toBe(300000);
		const drift = (lock1.body!.retryAfterMs as number) - (lock2.body!.retryAfterMs as number);
		expect(drift).toBeGreaterThanOrEqual(0);
		expect(drift).toBeLessThan(1000);
		expect(await pinRows(lockKey)).toHaveLength(1);
		expect((await pinRows(lockKey))[0].event).toBe('pos.pin.locked_out');
	});

	it('dedupes per key, not per body — and does not dedupe an unkeyed caller', async () => {
		const f = await makeFixture();

		await post(
			{ employeeId: f.cashierId, pin: '1234', clientOpId: crypto.randomUUID() },
			withDevice(f)
		);
		await post(
			{ employeeId: f.cashierId, pin: '1234', clientOpId: crypto.randomUUID() },
			withDevice(f)
		);
		expect(await pinRows()).toHaveLength(2);

		await post({ employeeId: f.cashierId, pin: '1234' }, withDevice(f));
		await post({ employeeId: f.cashierId, pin: '1234' }, withDevice(f));
		expect(await pinRows()).toHaveLength(4);
	});

	// Two retries racing: both may miss the lookup, and the database's unique index
	// decides. Either way the answers match and exactly one row exists.
	it('answers two concurrent retries of one attempt identically, with one row', async () => {
		const f = await makeFixture();
		const key = crypto.randomUUID();
		const body = { employeeId: f.cashierId, pin: '9999', clientOpId: key };

		const [a, b] = await Promise.all([post(body, withDevice(f)), post(body, withDevice(f))]);

		expect(a).toEqual({ status: 401, body: { error: 'invalid_pin' } });
		expect(b).toEqual(a);
		expect(await pinRows(key)).toHaveLength(1);
		expect((await cashier(f)).failedPinCount).toBe(1);
	});

	it('signs a cashier in with the right PIN, writing one pos.pin.success row', async () => {
		const f = await makeFixture();

		const result = await post({ employeeId: f.cashierId, pin: '1234' }, withDevice(f));

		expect(result).toEqual({
			status: 200,
			body: { employeeId: f.cashierId, displayName: 'Sam', role: 'cashier' }
		});
		expect((await pinRows()).map((r) => r.event)).toEqual(['pos.pin.success']);
	});

	it('locks after five wrong PINs and refuses the right one while locked', async () => {
		const f = await makeFixture();
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			const r = await post(
				{ employeeId: f.cashierId, pin: '9999', clientOpId: crypto.randomUUID() },
				withDevice(f)
			);
			statuses.push(r.status);
		}
		expect(statuses).toEqual([401, 401, 401, 401, 423]);

		const events = (await pinRows()).map((r) => r.event);
		expect(events.filter((e) => e === 'pos.pin.failed')).toHaveLength(4);
		expect(events.filter((e) => e === 'pos.pin.locked_out')).toHaveLength(1);

		const sixth = await post(
			{ employeeId: f.cashierId, pin: '1234', clientOpId: crypto.randomUUID() },
			withDevice(f)
		);
		expect(sixth.status).toBe(423);

		const row = await cashier(f);
		expect(row.failedPinCount).toBe(0);
		expect(row.pinLockedUntil).not.toBeNull();
		expect(row.failedPasswordCount).toBe(2);
	});

	it("answers another restaurant's employee exactly like a wrong PIN, touching nothing", async () => {
		const a = await makeFixture('a@cafe.com');
		const b = await makeFixture('b@cafe.com');

		const result = await post({ employeeId: b.cashierId, pin: '1234' }, withDevice(a));

		expect(result).toEqual({ status: 401, body: { error: 'invalid_pin' } });
		expect(await countAudit()).toBe(0);
		expect((await cashier(b)).failedPinCount).toBe(0);
	});

	it.each(['123', '1234567'])('refuses a PIN of %s with 400 (spec 7: 4-6 digits)', async (pin) => {
		const f = await makeFixture();
		expect((await post({ employeeId: f.cashierId, pin }, withDevice(f))).status).toBe(400);
	});

	it('never returns a PIN hash, a password hash or an email', async () => {
		const f = await makeFixture();
		const bodies = [
			await post({ employeeId: f.cashierId, pin: '1234' }, withDevice(f)),
			await post({ employeeId: f.cashierId, pin: '9999' }, withDevice(f))
		].map((r) => JSON.stringify(r.body));

		for (const body of bodies) {
			for (const key of ['pinPhc', 'pinHash', 'passwordHash', 'email']) {
				expect(body).not.toContain(`"${key}"`);
			}
		}
	});
});
