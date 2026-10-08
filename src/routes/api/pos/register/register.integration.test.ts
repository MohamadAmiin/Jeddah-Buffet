import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { sessions } from '$lib/server/db/schema/sessions';
import { posDevices } from '$lib/server/db/schema/pos-devices';
import { auditLog } from '$lib/server/db/schema/audit';
import { hashPassword } from '$lib/server/auth/password';
import { resetThrottle } from '$lib/server/auth/throttle';
import { SESSION_COOKIE, createSession } from '$lib/server/auth/session';
import { DEVICE_COOKIE, revokeDevice, validateDeviceToken } from '$lib/server/auth/pos-device';
import { POST } from './+server';

const db = testDb();
const PASSWORD = 'a correct password';
let PASSWORD_HASH: string;

beforeAll(async () => {
	PASSWORD_HASH = await hashPassword(PASSWORD);
});

// The ten-attempt login bucket is process-local and survives the database reset.
beforeEach(() => {
	resetThrottle();
});

afterAll(async () => {
	await closeTestDb();
});

async function makeOwner(email: string, name = 'Cafe One') {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: PASSWORD_HASH
		})
		.returning();
	return { restaurantId: restaurant.id, ownerId: owner.id };
}

type Call = { name: string; value: string; options: Record<string, unknown> };

/** A fake RequestEvent with a Map cookie jar that records every set and delete. */
function makeEvent(
	body: unknown,
	opts: { contentType?: string; cookies?: Record<string, string> } = {}
) {
	const jar = new Map(Object.entries(opts.cookies ?? {}));
	const set: Call[] = [];
	const deleted: string[] = [];
	const url = new URL('http://localhost/api/pos/register');
	const event = {
		cookies: {
			get: (name: string) => jar.get(name),
			getAll: () => [...jar].map(([name, value]) => ({ name, value })),
			set: (name: string, value: string, options: Record<string, unknown>) => {
				jar.set(name, value);
				set.push({ name, value, options });
			},
			delete: (name: string) => {
				jar.delete(name);
				deleted.push(name);
			},
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '203.0.113.5',
		locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null },
		params: {},
		platform: undefined,
		request: new Request(url, {
			method: 'POST',
			headers: {
				'content-type': opts.contentType ?? 'application/json',
				origin: 'http://localhost'
			},
			body: typeof body === 'string' ? body : JSON.stringify(body)
		}),
		route: { id: '/api/pos/register' },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
	return { event, set, deleted };
}

async function register(body: unknown, opts?: Parameters<typeof makeEvent>[1]) {
	const call = makeEvent(body, opts);
	const response = await POST(call.event);
	return { ...call, status: response.status, body: await response.json() };
}

const countWhere = async (
	table: typeof posDevices | typeof sessions,
	where: ReturnType<typeof eq>
) => {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(table)
		.where(where);
	return row.n;
};

describe('POST /api/pos/register', () => {
	// MANDATORY (spec 29 — a permission check test on every POS API route). A
	// cashier row cannot hold credentials (users_non_owner_has_no_credentials), so
	// the rule is proved the other way round: credentials only ever register a
	// device for THEIR OWN restaurant, and unknown credentials get exactly 403.
	it('registers only for the owner’s own restaurant, and refuses unknown credentials with 403', async () => {
		const a = await makeOwner('a@cafe.com', 'Cafe A');
		const b = await makeOwner('b@cafe.com', 'Cafe B');

		const viaB = await register({ email: 'b@cafe.com', password: PASSWORD, label: 'B tablet' });
		expect(viaB.status).toBe(201);
		expect(await countWhere(posDevices, eq(posDevices.restaurantId, b.restaurantId))).toBe(1);
		expect(await countWhere(posDevices, eq(posDevices.restaurantId, a.restaurantId))).toBe(0);

		const unknown = await register({ email: 'nobody@cafe.com', password: PASSWORD, label: 'X' });
		expect(unknown.status).toBe(403);
		expect(unknown.body).toEqual({ error: 'invalid_credentials' });
		expect(await countWhere(posDevices, eq(posDevices.restaurantId, a.restaurantId))).toBe(0);
	});

	it('refuses a wrong password with 403, one login.failed row, and a counted failure', async () => {
		const { ownerId } = await makeOwner('owner@cafe.com');

		const wrong = await register({
			email: 'owner@cafe.com',
			password: 'not the password',
			label: 'Counter tablet'
		});

		expect(wrong.status).toBe(403);
		expect(wrong.body).toEqual({ error: 'invalid_credentials' });
		const rows = await db
			.select({ event: auditLog.event, subject: auditLog.subjectUserId })
			.from(auditLog);
		expect(rows).toEqual([{ event: 'login.failed', subject: ownerId }]);
		const [owner] = await db.select().from(users).where(eq(users.id, ownerId));
		expect(owner.failedPasswordCount).toBe(1);
	});

	it('registers POS1, audits it with the device id, and leaves the owner no session', async () => {
		const { restaurantId, ownerId } = await makeOwner('owner@cafe.com');
		// A live dashboard session in this browser, so the "zero sessions" assertion
		// can actually fail.
		const { token: existing } = await createSession(db, ownerId);

		const ok = await register(
			{ email: 'owner@cafe.com', password: PASSWORD, label: 'Front counter' },
			{ cookies: { [SESSION_COOKIE]: existing } }
		);

		expect(ok.status).toBe(201);
		expect(Object.keys(ok.body)).toEqual(['deviceId', 'deviceCode', 'label']);
		expect(ok.body).toMatchObject({ deviceCode: 'POS1', label: 'Front counter' });

		const devices = await db
			.select()
			.from(posDevices)
			.where(eq(posDevices.restaurantId, restaurantId));
		expect(devices).toHaveLength(1);
		// The uuid, because POS1 repeats in every restaurant.
		expect(ok.body.deviceId).toBe(devices[0].id);
		expect(devices[0].deviceCode).toBe('POS1');
		expect(devices[0].revokedAt).toBeNull();

		const registered = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.event, 'pos.device.registered'));
		expect(registered).toHaveLength(1);
		expect(registered[0].details).toEqual({ deviceCode: 'POS1', label: 'Front counter' });
		expect(registered[0].deviceId).toBe(devices[0].id);
		expect(registered[0].clientOpId).toBeNull();

		expect(await countWhere(sessions, eq(sessions.userId, ownerId))).toBe(0);

		// The token went into the device cookie and nowhere else.
		const cookie = ok.set.find((c) => c.name === DEVICE_COOKIE)!;
		expect(cookie.options).toMatchObject({ path: '/' });
		expect(await validateDeviceToken(db, cookie.value)).toMatchObject({ deviceCode: 'POS1' });
		expect(ok.deleted).toContain(SESSION_COOKIE);
		expect(JSON.stringify(ok.body)).not.toContain(cookie.value);
	});

	// MANY TILLS PER RESTAURANT (decision of 2026-10-08, departing from spec 31's
	// one-device MVP): a second counter device is an ordinary registration, the
	// first stays live, and each takes the next unused code.
	it('registers a second till as POS2 while the first stays live, each with its own cookie', async () => {
		const { restaurantId } = await makeOwner('owner@cafe.com');
		const first = await register({
			email: 'owner@cafe.com',
			password: PASSWORD,
			label: 'Counter tablet'
		});
		const firstToken = first.set.find((c) => c.name === DEVICE_COOKIE)!.value;

		// A DIFFERENT browser: no device cookie presented.
		const second = await register({
			email: 'owner@cafe.com',
			password: PASSWORD,
			label: 'Bar tablet'
		});
		expect(second.status).toBe(201);
		expect(second.body.deviceCode).toBe('POS2');
		const secondToken = second.set.find((c) => c.name === DEVICE_COOKIE)!.value;
		expect(secondToken).not.toBe(firstToken);

		// Both live, both their own device, both audited.
		expect(await validateDeviceToken(db, firstToken)).toMatchObject({ deviceCode: 'POS1' });
		expect(await validateDeviceToken(db, secondToken)).toMatchObject({ deviceCode: 'POS2' });
		expect(await countWhere(posDevices, eq(posDevices.restaurantId, restaurantId))).toBe(2);
		expect(
			await db.select().from(auditLog).where(eq(auditLog.event, 'pos.device.registered'))
		).toHaveLength(2);
	});

	// A code is BURNED once used: POS1-000001 must never name two sales from two
	// different devices, so a revoked till's successor takes the next number.
	it('never reuses a revoked code — after POS1 is revoked the next till is POS2', async () => {
		const { restaurantId, ownerId } = await makeOwner('owner@cafe.com');
		await register({ email: 'owner@cafe.com', password: PASSWORD, label: 'Tablet one' });
		const [device] = await db
			.select({ id: posDevices.id })
			.from(posDevices)
			.where(eq(posDevices.restaurantId, restaurantId));
		await db.transaction((tx) =>
			revokeDevice(tx, { deviceId: device.id, restaurantId, actorUserId: ownerId })
		);

		const next = await register({
			email: 'owner@cafe.com',
			password: PASSWORD,
			label: 'Tablet two'
		});
		expect(next.status).toBe(201);
		expect(next.body.deviceCode).toBe('POS2');
		const rows = await db
			.select()
			.from(posDevices)
			.where(eq(posDevices.restaurantId, restaurantId));
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.revokedAt === null).map((r) => r.deviceCode)).toEqual(['POS2']);
	});

	// The ONE 409 left: the browser that already IS a live till — of this very
	// restaurant. Registering over its cookie would orphan the row it names.
	it("refuses to register over the restaurant's OWN live till with 409, and touches nothing", async () => {
		const { restaurantId } = await makeOwner('owner@cafe.com');
		const first = await register({
			email: 'owner@cafe.com',
			password: PASSWORD,
			label: 'Counter tablet'
		});
		const token = first.set.find((c) => c.name === DEVICE_COOKIE)!.value;

		const again = await register(
			{ email: 'owner@cafe.com', password: PASSWORD, label: 'Counter tablet again' },
			{ cookies: { [DEVICE_COOKIE]: token } }
		);

		expect(again.status).toBe(409);
		expect(again.body).toEqual({ error: 'device_already_registered' });
		expect(again.set.find((c) => c.name === DEVICE_COOKIE)).toBeUndefined();
		expect(await validateDeviceToken(db, token)).toMatchObject({ deviceCode: 'POS1' });
		expect(await countWhere(posDevices, eq(posDevices.restaurantId, restaurantId))).toBe(1);
		expect(
			await db.select().from(auditLog).where(eq(auditLog.event, 'pos.device.registered'))
		).toHaveLength(1);
	});

	it('refuses a non-JSON body with 415 and a body missing the label with 400', async () => {
		await makeOwner('owner@cafe.com');

		const plain = await register('email=owner@cafe.com', { contentType: 'text/plain' });
		expect(plain.status).toBe(415);

		const noLabel = await register({ email: 'owner@cafe.com', password: PASSWORD });
		expect(noLabel.status).toBe(400);
		expect(noLabel.body).toEqual({ error: 'invalid_request' });
	});

	it('ignores a deviceCode in the body — the server allocates it', async () => {
		await makeOwner('owner@cafe.com');

		const result = await register({
			email: 'owner@cafe.com',
			password: PASSWORD,
			label: 'Counter tablet',
			deviceCode: 'POS9'
		});

		expect(result.status).toBe(201);
		expect(result.body.deviceCode).toBe('POS1');
	});

	// A cross-company DEVICE TAKEOVER: restaurant B's owner, standing at restaurant
	// A's registered tablet, must not be able to turn it into B's till.
	it("refuses to register over another restaurant's LIVE till, and touches nothing", async () => {
		const a = await makeOwner('a@cafe.com', 'Cafe A');
		const b = await makeOwner('b@cafe.com', 'Cafe B');
		const first = await register({ email: 'a@cafe.com', password: PASSWORD, label: 'A till' });
		const tokenOfA = first.set.find((c) => c.name === DEVICE_COOKIE)!.value;

		const takeover = await register(
			{ email: 'b@cafe.com', password: PASSWORD, label: 'B till' },
			{ cookies: { [DEVICE_COOKIE]: tokenOfA } }
		);

		expect(takeover.status).toBe(409);
		expect(takeover.body).toEqual({ error: 'device_already_registered' });
		// No cookie set, A's device still live and still A's, nothing for B.
		expect(takeover.set.find((c) => c.name === DEVICE_COOKIE)).toBeUndefined();
		expect(await validateDeviceToken(db, tokenOfA)).toMatchObject({
			restaurantId: a.restaurantId,
			deviceCode: 'POS1'
		});
		expect(await countWhere(posDevices, eq(posDevices.restaurantId, b.restaurantId))).toBe(0);
		expect(await countWhere(sessions, eq(sessions.userId, b.ownerId))).toBe(0);
	});

	it('registers a tablet whose old cookie was REVOKED: its owner released it first', async () => {
		const a = await makeOwner('a@cafe.com', 'Cafe A');
		const b = await makeOwner('b@cafe.com', 'Cafe B');
		const first = await register({ email: 'a@cafe.com', password: PASSWORD, label: 'A till' });
		const tokenOfA = first.set.find((c) => c.name === DEVICE_COOKIE)!.value;
		const [deviceOfA] = await db
			.select({ id: posDevices.id })
			.from(posDevices)
			.where(eq(posDevices.restaurantId, a.restaurantId));
		await db.transaction((tx) =>
			revokeDevice(tx, {
				deviceId: deviceOfA.id,
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId
			})
		);

		const moved = await register(
			{ email: 'b@cafe.com', password: PASSWORD, label: 'B till' },
			{ cookies: { [DEVICE_COOKIE]: tokenOfA } }
		);

		expect(moved.status).toBe(201);
		expect(moved.body.deviceCode).toBe('POS1');
		expect(await countWhere(posDevices, eq(posDevices.restaurantId, b.restaurantId))).toBe(1);
	});
});
