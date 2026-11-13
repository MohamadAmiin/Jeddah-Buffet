import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { closeTestDb } from '$lib/server/db/test/db';
import {
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import type { Principal } from '$lib/server/auth/session';
import { setCreditEnabled } from '$lib/server/restaurants';
import { createCustomer } from '$lib/server/customers';
import { receiveCustomerPayment } from '$lib/server/customers/payments';
import { minor } from '$lib/money';
import { load } from './+page.server';
import { load as reportsLoad } from '../+page.server';

// /reports/credit and the credit rows of /reports (tasks/customer-credit T-23).
// MANDATORY (spec 29 — a permission check per route): admin.reports on the load.

afterAll(async () => {
	await closeTestDb();
});

const AT = new Date('2026-09-28T09:00:00Z');
const DAY = '2026-09-28';

function eventFor(
	f: SalesFixture,
	role: Principal['role'],
	path: string,
	search = ''
): RequestEvent {
	const principal: Principal = {
		userId: role === 'owner' ? f.ownerId : f.staffId,
		restaurantId: f.restaurantId,
		role,
		displayName: role === 'owner' ? 'Owner' : 'Staff',
		email: role === 'owner' ? 'owner@example.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
	const url = new URL(`http://localhost${path}${search}`);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user: principal, restaurantId: f.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url),
		route: { id: `/(dashboard)${path}` },
		url
	} as unknown as RequestEvent;
}

async function thrown(p: unknown): Promise<{ status?: number }> {
	try {
		await p;
	} catch (e) {
		return e as { status?: number };
	}
	throw new Error('expected the load to throw');
}

/** One credit sale (880), one cash sale (880) and a 500 cash customer payment. */
async function creditDay(): Promise<{ f: SalesFixture; customer: string }> {
	const f = await seedSalesRestaurant(db);
	const session = randomUUID();
	await openSessionAt(db, f, { posSessionId: session, openedAt: AT, openingCashMinor: 0n });
	await db.transaction((tx) =>
		setCreditEnabled(tx, f.restaurantId, true, {
			actorUserId: f.ownerId,
			ip: null,
			userAgent: null
		})
	);
	const created = await db.transaction((tx) =>
		createCustomer(
			tx,
			{ restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null },
			{ name: 'Ali Hassan', phone: '615000001', creditLimitMinor: null }
		)
	);
	if (!created.ok) throw new Error(created.reason);
	const line = {
		menuItemId: f.items.burger,
		itemName: 'Burger',
		quantity: 1,
		unitPriceMinor: 800n,
		taxRateBp: f.taxRateBp
	};
	await recordSaleAt(db, f, {
		posSessionId: session,
		occurredAt: new Date(AT.getTime() + 60_000),
		invoiceSeq: 1,
		method: 'credit',
		customer: { id: created.customerId, name: 'Ali Hassan' },
		orderType: 'dine_in',
		tableLabel: null,
		lines: [line]
	});
	await recordSaleAt(db, f, {
		posSessionId: session,
		occurredAt: new Date(AT.getTime() + 120_000),
		invoiceSeq: 2,
		method: 'cash',
		orderType: 'dine_in',
		tableLabel: null,
		lines: [line]
	});
	const at = new Date(AT.getTime() + 3_600_000);
	const paid = await db.transaction((tx) =>
		receiveCustomerPayment(
			tx,
			{
				restaurantId: f.restaurantId,
				actorUserId: f.staffId,
				deviceId: f.deviceId,
				clientOpId: randomUUID(),
				occurredAt: at,
				ip: null,
				userAgent: null
			},
			{
				paymentId: randomUUID(),
				customerId: created.customerId,
				posSessionId: session,
				method: 'cash',
				paymentMethodId: f.paymentMethods.cash.id,
				paymentMethodName: 'Cash',
				amountMinor: minor(500n),
				tenderedMinor: minor(500n),
				changeMinor: minor(0n),
				receivedAt: at
			}
		)
	);
	if (!paid.ok) throw new Error(paid.reason);
	return { f, customer: created.customerId };
}

describe('MANDATORY (spec 29) — /reports/credit checks admin.reports', () => {
	it('a staff principal gets 403', async () => {
		const { f } = await creditDay();
		const error = await thrown(load(eventFor(f, 'staff', '/reports/credit') as never));
		expect(error.status).toBe(403);
	});

	it('rejects a bad date with 400', async () => {
		const { f } = await creditDay();
		const error = await thrown(
			load(eventFor(f, 'owner', '/reports/credit', '?from=28-09-2026') as never)
		);
		expect(error.status).toBe(400);
	});
});

describe('/reports/credit — the owner', () => {
	it('shows the charge, the payment and the totals per cashier, formatted', async () => {
		const { f, customer } = await creditDay();
		const data = (await load(
			eventFor(f, 'owner', '/reports/credit', `?from=${DAY}&to=${DAY}`) as never
		)) as {
			charged: string;
			receivedNet: string;
			byCashier: {
				cashier: string;
				charges: number;
				charged: string;
				payments: number;
				received: string;
			}[];
			charges: {
				invoiceNumber: string;
				customerName: string;
				customerId: string;
				amount: string;
				till: string;
			}[];
			payments: { kind: string; method: string; amount: string; customerName: string }[];
		};

		expect(data.charged).toBe('8.80');
		expect(data.receivedNet).toBe('5.00');
		expect(data.byCashier).toEqual([
			expect.objectContaining({
				cashier: 'Sam',
				charges: 1,
				charged: '8.80',
				payments: 1,
				received: '5.00'
			})
		]);
		expect(data.charges).toEqual([
			expect.objectContaining({
				invoiceNumber: `${f.deviceCode}-000001`,
				customerName: 'Ali Hassan',
				customerId: customer,
				amount: '8.80',
				till: f.deviceCode
			})
		]);
		expect(data.payments).toEqual([
			expect.objectContaining({
				kind: 'payment',
				method: 'Cash',
				amount: '5.00',
				customerName: 'Ali Hassan'
			})
		]);
	});

	it('is empty for a range with nothing in it', async () => {
		const { f } = await creditDay();
		const data = (await load(
			eventFor(f, 'owner', '/reports/credit', '?from=2026-01-01&to=2026-01-02') as never
		)) as { charges: unknown[]; payments: unknown[]; byCashier: unknown[] };
		expect(data).toMatchObject({ charges: [], payments: [], byCashier: [] });
	});
});

describe('/reports — the credit rows', () => {
	type Reports = {
		isEmpty: boolean;
		usesCredit: boolean;
		totals: { takings: string; soldOnCredit: string; netSales: string; tax: string };
		byTender: { method: string; label: string; amount: string }[];
		customerPayments: {
			rows: { label: string; received: string; net: string; negative: boolean }[];
			net: string;
		};
	};

	it('takings exclude the credit sale; sold on credit and customer payments have their own figures', async () => {
		const { f } = await creditDay();
		const data = (await reportsLoad(
			eventFor(f, 'owner', '/reports', `?date=${DAY}`) as never
		)) as Reports;

		expect(data.usesCredit).toBe(true);
		expect(data.totals.takings).toMatch(/8\.80/);
		expect(data.totals.soldOnCredit).toMatch(/8\.80/);
		expect(data.totals.netSales).toMatch(/16\.00/);
		expect(data.totals.tax).toMatch(/1\.60/);
		expect(data.byTender.map((t) => [t.method, t.label, t.amount])).toEqual([
			['cash', 'Cash', '8.80'],
			['card', 'Card', '0.00'],
			['mobile', 'Mobile', '0.00'],
			['credit', 'Customer credit (not received)', '8.80']
		]);
		expect(data.customerPayments.rows).toEqual([
			expect.objectContaining({ label: 'Cash', received: '5.00', net: '5.00', negative: false })
		]);
		expect(data.customerPayments.net).toMatch(/5\.00/);
	});

	it('a restaurant with no credit sees no credit figures', async () => {
		const f = await seedSalesRestaurant(db);
		const session = randomUUID();
		await openSessionAt(db, f, { posSessionId: session, openedAt: AT, openingCashMinor: 0n });
		const data = (await reportsLoad(
			eventFor(f, 'owner', '/reports', `?date=${DAY}`) as never
		)) as Reports;
		expect(data.usesCredit).toBe(false);
		expect(data.byTender.map((t) => t.method)).toEqual(['cash', 'card', 'mobile']);
		expect(data.customerPayments.rows).toEqual([]);
	});
});
