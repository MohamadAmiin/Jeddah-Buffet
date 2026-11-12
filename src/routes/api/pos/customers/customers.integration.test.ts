import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { closeTestDb } from '$lib/server/db/test/db';
import {
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import { DEVICE_COOKIE, revokeDevice } from '$lib/server/auth/pos-device';
import { setCreditEnabled } from '$lib/server/restaurants';
import { archiveCustomer, createCustomer } from '$lib/server/customers';
import { receiveCustomerPayment, reverseCustomerPayment } from '$lib/server/customers/payments';
import { minor } from '$lib/money';
import { GET } from './+server';

// GET /api/pos/customers (tasks/customer-credit T-13).
// MANDATORY (spec 29 — a permission check on every POS API route): a registered,
// unrevoked device only (invariant 8), for the DEVICE ROW's restaurant only.

afterAll(async () => {
	await closeTestDb();
});

const AT = new Date('2026-09-28T09:00:00Z');

function makeEvent(cookies: Record<string, string>): RequestEvent {
	const routeId = '/api/pos/customers';
	const jar = new Map(Object.entries(cookies));
	const url = new URL(`http://localhost${routeId}`);
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
		request: new Request(url),
		route: { id: routeId },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

type Listed = {
	id: string;
	name: string;
	phone: string;
	creditLimitMinor: string | null;
	balanceMinor: string;
	payOnly: boolean;
};
type Body = { creditEnabled: boolean; customers: Listed[] };

async function get(cookies: Record<string, string>) {
	try {
		const response = await GET(makeEvent(cookies) as Parameters<typeof GET>[0]);
		return {
			status: response.status,
			body: JSON.parse(await response.text()) as Body,
			headers: response.headers
		};
	} catch (thrown) {
		const status = (thrown as { status?: number }).status;
		if (status === undefined) throw thrown;
		return { status, body: null, headers: null };
	}
}

const ctxOf = (f: SalesFixture) => ({
	restaurantId: f.restaurantId,
	actorUserId: f.ownerId,
	ip: null,
	userAgent: null
});

async function addCustomer(
	f: SalesFixture,
	name: string,
	phone: string,
	limit: bigint | null = null
): Promise<string> {
	const created = await db.transaction((tx) =>
		createCustomer(tx, ctxOf(f), {
			name,
			phone,
			creditLimitMinor: limit === null ? null : minor(limit)
		})
	);
	if (!created.ok) throw new Error(created.reason);
	return created.customerId;
}

/** Charge one burger (880) to the customer. */
async function charge(f: SalesFixture, session: string, customerId: string, seq: number) {
	await recordSaleAt(db, f, {
		posSessionId: session,
		occurredAt: new Date(AT.getTime() + seq * 60_000),
		invoiceSeq: seq,
		method: 'credit',
		customer: { id: customerId },
		orderType: 'dine_in',
		tableLabel: null,
		lines: [
			{
				menuItemId: f.items.burger,
				itemName: 'Burger',
				quantity: 1,
				unitPriceMinor: 800n,
				taxRateBp: f.taxRateBp
			}
		]
	});
}

async function seeded() {
	const f = await seedSalesRestaurant(db);
	const session = randomUUID();
	await openSessionAt(db, f, { posSessionId: session, openedAt: AT, openingCashMinor: 0n });
	return { f, session };
}

describe('MANDATORY (spec 29) — GET /api/pos/customers is device-guarded', () => {
	it('answers 403 with no device cookie, an unknown one and a revoked one', async () => {
		const { f } = await seeded();
		await addCustomer(f, 'Ali', '615000001');

		expect((await get({})).status).toBe(403);
		expect((await get({ [DEVICE_COOKIE]: 'not-a-token' })).status).toBe(403);

		await db.transaction((tx) =>
			revokeDevice(tx, {
				restaurantId: f.restaurantId,
				deviceId: f.deviceId,
				actorUserId: f.ownerId
			})
		);
		expect((await get({ [DEVICE_COOKIE]: f.deviceToken })).status).toBe(403);
	});

	it("never returns another restaurant's customers", async () => {
		const a = await seeded();
		const b = await seeded();
		await addCustomer(a.f, 'Ali of A', '615000001');
		await addCustomer(b.f, 'Sara of B', '615000002');

		const fromA = await get({ [DEVICE_COOKIE]: a.f.deviceToken });
		const fromB = await get({ [DEVICE_COOKIE]: b.f.deviceToken });

		expect(fromA.body!.customers.map((c) => c.name)).toEqual(['Ali of A']);
		expect(fromB.body!.customers.map((c) => c.name)).toEqual(['Sara of B']);
	});
});

describe('GET /api/pos/customers — the list', () => {
	it('lists live customers by name with exactly six keys, money as decimal strings, and is never cached', async () => {
		const { f, session } = await seeded();
		const sara = await addCustomer(f, 'Sara', '615000002', 5000n);
		await addCustomer(f, 'ali', '615000001');
		await charge(f, session, sara, 1);

		const { status, body, headers } = await get({ [DEVICE_COOKIE]: f.deviceToken });

		expect(status).toBe(200);
		expect(headers!.get('cache-control')).toBe('no-store');
		expect(Object.keys(body!).sort()).toEqual(['creditEnabled', 'customers']);
		expect(body!.customers).toEqual([
			{
				id: expect.any(String),
				name: 'ali',
				phone: '615000001',
				creditLimitMinor: null,
				balanceMinor: '0',
				payOnly: false
			},
			{
				id: sara,
				name: 'Sara',
				phone: '615000002',
				creditLimitMinor: '5000',
				balanceMinor: '880',
				payOnly: false
			}
		]);
		for (const c of body!.customers) {
			expect(Object.keys(c).sort()).toEqual([
				'balanceMinor',
				'creditLimitMinor',
				'id',
				'name',
				'payOnly',
				'phone'
			]);
		}
	});

	it('carries the owner’s Customer credit switch; OFF never empties the list', async () => {
		const { f } = await seeded();
		await addCustomer(f, 'Ali', '615000001');
		const settings = { actorUserId: f.ownerId, ip: null, userAgent: null };

		expect((await get({ [DEVICE_COOKIE]: f.deviceToken })).body!.creditEnabled).toBe(false);

		await db.transaction((tx) => setCreditEnabled(tx, f.restaurantId, true, settings));
		expect((await get({ [DEVICE_COOKIE]: f.deviceToken })).body!.creditEnabled).toBe(true);

		await db.transaction((tx) => setCreditEnabled(tx, f.restaurantId, false, settings));
		const off = await get({ [DEVICE_COOKIE]: f.deviceToken });
		expect(off.body!.creditEnabled).toBe(false);
		expect(off.body!.customers).toHaveLength(1);
	});

	it('an archived customer at zero is not listed; one who still owes is listed pay-only', async () => {
		const { f, session } = await seeded();
		const gone = await addCustomer(f, 'Gone', '615000001');
		const owes = await addCustomer(f, 'Owes', '615000002');
		await db.transaction((tx) => archiveCustomer(tx, ctxOf(f), gone));

		// Owes: charged, paid in full by mobile, archived, then the payment reversed.
		await charge(f, session, owes, 1);
		const paymentId = randomUUID();
		const received = await db.transaction((tx) =>
			receiveCustomerPayment(
				tx,
				{
					restaurantId: f.restaurantId,
					actorUserId: f.staffId,
					deviceId: f.deviceId,
					clientOpId: randomUUID(),
					occurredAt: AT,
					ip: null,
					userAgent: null
				},
				{
					paymentId,
					customerId: owes,
					posSessionId: session,
					method: 'mobile',
					paymentMethodId: f.paymentMethods.mobile.id,
					paymentMethodName: 'Mobile money',
					amountMinor: minor(880n),
					tenderedMinor: null,
					changeMinor: null,
					receivedAt: AT
				}
			)
		);
		expect(received.ok).toBe(true);
		expect(await db.transaction((tx) => archiveCustomer(tx, ctxOf(f), owes))).toEqual({ ok: true });
		expect(
			await db.transaction((tx) =>
				reverseCustomerPayment(tx, ctxOf(f), { paymentId, reason: 'Wrong customer' })
			)
		).toMatchObject({ ok: true });

		const { body } = await get({ [DEVICE_COOKIE]: f.deviceToken });
		expect(body!.customers).toEqual([
			{
				id: owes,
				name: 'Owes',
				phone: '615000002',
				creditLimitMinor: null,
				balanceMinor: '880',
				payOnly: true
			}
		]);
	});
});
