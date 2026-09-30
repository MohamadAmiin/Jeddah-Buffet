// MANDATORY (spec 29 — "Permission checks on every POS API")
//
// The behavioural half of the /api walk in route-guards.test.ts: that file checks
// the SOURCE for a guard call, which a comment could satisfy; this file drives the
// REAL handlers and asserts the status. Every POS API route is in the table below,
// and a route added later adds its row.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { randomUUID } from 'node:crypto';
import { seedStaff } from '$lib/server/db/test/seed';
import { POST as syncPost } from './sync/+server';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { posDevices } from '$lib/server/db/schema/pos-devices';
import { auditLog } from '$lib/server/db/schema/audit';
import type { Principal } from '$lib/server/auth/session';
import { resetThrottle } from '$lib/server/auth/throttle';
import { DEVICE_COOKIE, registerDevice, revokeDevice } from '$lib/server/auth/pos-device';
import { POST as pinPost } from './pin/+server';
import { GET as employeesGet } from './employees/+server';
import { POST as registerPost } from './register/+server';
import { GET as menuVersionGet } from '../menu/version/+server';
import { GET as menuGet } from '../menu/+server';
import { GET as imagesGet } from '../menu/images/[id]/+server';
import { actions as deviceActions } from '../../(dashboard)/device/+page.server';
import { db as appDb } from '$lib/server/db/client';
import { orders } from '$lib/server/db/schema/orders';
import { openSessionAt, saleEnvelope, seedSalesRestaurant } from '$lib/server/db/test/sales';

const db = testDb();

beforeEach(() => {
	resetThrottle();
});

afterAll(async () => {
	await closeTestDb();
});

type Seed = {
	restaurantId: string;
	ownerId: string;
	cashierId: string;
	activeDeviceId: string;
	revokedToken: string;
};

/** One restaurant with an owner, a cashier, one ACTIVE device and one REVOKED device. */
async function seed(): Promise<Seed> {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	// The onRestaurantCreated initializers add the settings row (a session
	// derives its business_date from the time zone), the two default roles
	// (Cashier / Waiter — seedStaff below finds Cashier instead of creating
	// one), and the 23 spec-23 accounts T-19's journal writer resolves codes
	// against.
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: 'Cafe One',
			timeZone: 'UTC'
		})
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email: 'owner@cafe.com',
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const cashier = await seedStaff(db, restaurant.id, {
		displayName: 'Sam'
	});

	const revoked = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId: restaurant.id, actorUserId: owner.id, label: 'Old till' })
	);
	await db.transaction((tx) =>
		revokeDevice(tx, {
			deviceId: revoked.deviceId,
			restaurantId: restaurant.id,
			actorUserId: owner.id
		})
	);
	const active = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId: restaurant.id, actorUserId: owner.id, label: 'Till' })
	);

	return {
		restaurantId: restaurant.id,
		ownerId: owner.id,
		cashierId: cashier.id,
		activeDeviceId: active.deviceId,
		revokedToken: revoked.token
	};
}

function makeEvent(
	routeId: string,
	method: string,
	body: unknown,
	cookies: Record<string, string>,
	locals: Partial<App.Locals> = {},
	params: Record<string, string> = {}
): RequestEvent {
	const jar = new Map(Object.entries(cookies));
	const url = new URL(`http://localhost${routeId.replace(/\/\([^)]*\)/g, '')}`);
	const init: RequestInit = { method, headers: { origin: 'http://localhost' } };
	if (body instanceof FormData) init.body = body;
	else if (body !== undefined) {
		init.body = JSON.stringify(body);
		init.headers = { ...init.headers, 'content-type': 'application/json' };
	}
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
		locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null, ...locals },
		params,
		platform: undefined,
		request: new Request(url, init),
		route: { id: routeId },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

/** The status a handler answered or threw. */
async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		const result = await run();
		return result instanceof Response ? result.status : (result as { status?: number }).status;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

async function sideEffects(s: Seed) {
	const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
	const [cashier] = await db
		.select({ failedPinCount: users.failedPinCount })
		.from(users)
		.where(eq(users.id, s.cashierId));
	return { auditRows: n, failedPinCount: cashier.failedPinCount };
}

// Every DEVICE-GUARDED POS route. A later plan's device-guarded route adds a row.
const DEVICE_GUARDED = [
	{
		routeId: '/api/pos/pin',
		method: 'POST',
		body: (s: Seed) => ({ employeeId: s.cashierId, pin: '1234' }),
		handler: pinPost
	},
	{
		routeId: '/api/pos/employees',
		method: 'GET',
		body: () => undefined,
		handler: employeesGet
	},
	{
		routeId: '/api/menu/version',
		method: 'GET',
		body: () => undefined,
		handler: menuVersionGet
	},
	{
		routeId: '/api/menu',
		method: 'GET',
		body: () => undefined,
		handler: menuGet
	},
	{
		routeId: '/api/menu/images/[id]',
		method: 'GET',
		body: () => undefined,
		params: () => ({ id: randomUUID() }),
		handler: imagesGet
	},
	{
		routeId: '/api/pos/sync',
		method: 'POST',
		body: (s: Seed) => ({
			kind: 'session.open',
			clientOpId: randomUUID(),
			deviceId: s.activeDeviceId,
			employeeId: s.cashierId,
			occurredAt: new Date().toISOString(),
			seq: 0,
			payload: { posSessionId: randomUUID(), openingCashMinor: '0' }
		}),
		handler: syncPost
	}
] as const;

/** A route with a dynamic segment supplies its params; the rest have none. */
const paramsOf = (route: (typeof DEVICE_GUARDED)[number]): Record<string, string> =>
	'params' in route ? route.params() : {};

describe('MANDATORY (spec 29): every device-guarded POS API route', () => {
	it.each(DEVICE_GUARDED)('$routeId answers exactly 403 with no cookies at all', async (route) => {
		const s = await seed();
		const before = await sideEffects(s);

		const status = await statusOf(() =>
			route.handler(makeEvent(route.routeId, route.method, route.body(s), {}, {}, paramsOf(route)))
		);

		expect(status).toBe(403);
		expect(await sideEffects(s)).toEqual(before);
	});

	it.each(DEVICE_GUARDED)('$routeId answers exactly 403 to a revoked device', async (route) => {
		const s = await seed();
		const before = await sideEffects(s);

		const status = await statusOf(() =>
			route.handler(
				makeEvent(
					route.routeId,
					route.method,
					route.body(s),
					{ [DEVICE_COOKIE]: s.revokedToken },
					{},
					paramsOf(route)
				)
			)
		);

		expect(status).toBe(403);
		expect(await sideEffects(s)).toEqual(before);
	});
});

describe('MANDATORY (spec 29): the one POS API route with no device guard', () => {
	// /api/pos/register is excluded from (a) and (b) by construction — it
	// authenticates from its body — so its own rule is asserted instead, and the
	// table is complete rather than silently short.
	it('/api/pos/register answers exactly 403 to credentials that are not an owner’s', async () => {
		const s = await seed();
		const devicesBefore = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(posDevices)
			.where(eq(posDevices.restaurantId, s.restaurantId));

		const status = await statusOf(() =>
			registerPost(
				makeEvent(
					'/api/pos/register',
					'POST',
					{ email: 'nobody@cafe.com', password: 'whatever it is', label: 'Tablet' },
					{}
				)
			)
		);

		expect(status).toBe(403);
		const devicesAfter = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(posDevices)
			.where(eq(posDevices.restaurantId, s.restaurantId));
		expect(devicesAfter).toEqual(devicesBefore);
	});
});

describe('MANDATORY (spec 29): insufficient role with a valid session', () => {
	// (c) There is no /api/pos/* target for this case: the device-guarded routes are
	// authorised by the DEVICE, not by a role. The one POS surface with a role check
	// is revocation, a dashboard form action. A later plan adding a role-sensitive POS
	// endpoint adds its row here.
	it('the /device revoke action answers exactly 403 to a cashier, leaving the device active', async () => {
		const s = await seed();
		const cashier: Principal = {
			userId: s.cashierId,
			restaurantId: s.restaurantId,
			role: 'staff',
			displayName: 'Sam',
			email: null,
			sessionId: 's-1',
			expiresAt: new Date(Date.now() + 60_000)
		};
		const form = new FormData();
		form.set('deviceId', s.activeDeviceId);

		const status = await statusOf(() =>
			deviceActions.revoke!(
				makeEvent(
					'/(dashboard)/device',
					'POST',
					form,
					{},
					{
						user: cashier,
						restaurantId: s.restaurantId
					}
				) as Parameters<NonNullable<typeof deviceActions.revoke>>[0]
			)
		);

		expect(status).toBe(403);
		const [row] = await db.select().from(posDevices).where(eq(posDevices.id, s.activeDeviceId));
		expect(row.revokedAt).toBeNull();
	});
});

describe('MANDATORY (spec 29): /api/pos/sync checks the EMPLOYEE, and the tender decides the answer', () => {
	// The sync route is the role-sensitive POS endpoint the block above anticipates.
	// A card sale has not completed on the till yet, so an employee without
	// pos.payment is refused outright; a cash sale has already happened, so it is
	// recorded and flagged for the owner instead (CLAUDE.md decision (f)).
	it('a card sale by a waiter answers 403 and records nothing; a cash one is recorded_flagged', async () => {
		const f = await seedSalesRestaurant(appDb);
		const waiter = await seedStaff(appDb, f.restaurantId, {
			displayName: 'Robin',
			roleName: 'Waiter'
		});
		const posSessionId = randomUUID();
		await openSessionAt(appDb, f, {
			posSessionId,
			openedAt: new Date(Date.now() - 300_000),
			openingCashMinor: 0n
		});
		const sale = (method: 'cash' | 'card', invoiceSeq: number) =>
			saleEnvelope(f, {
				posSessionId,
				occurredAt: new Date(Date.now() - 60_000),
				invoiceSeq,
				method,
				orderType: 'takeaway',
				tableLabel: null,
				employeeId: waiter.id,
				lines: [
					{
						menuItemId: f.items.tea,
						itemName: 'Tea',
						quantity: 1,
						unitPriceMinor: 200n,
						taxRateBp: f.taxRateBp
					}
				]
			});
		const post = (body: unknown) =>
			syncPost(
				makeEvent('/api/pos/sync', 'POST', body, { [DEVICE_COOKIE]: f.deviceToken })
			) as Promise<Response>;

		const card = await post(sale('card', 1));
		expect(card.status).toBe(403);
		const [{ n: afterCard }] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(orders)
			.where(eq(orders.restaurantId, f.restaurantId));
		expect(afterCard).toBe(0);

		const cash = await post(sale('cash', 2));
		expect(cash.status).toBe(200);
		expect(await cash.json()).toMatchObject({
			status: 'recorded_flagged',
			flag: 'employee_not_permitted'
		});
	});
});
