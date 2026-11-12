import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { closeTestDb, testDb } from '$lib/server/db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import { customers, customerPayments } from '$lib/server/db/schema/customers';
import { auditLog } from '$lib/server/db/schema/audit';
import type { Principal } from '$lib/server/auth/session';
import { setCreditEnabled } from '$lib/server/restaurants';
import { balanceOf, createCustomer } from '$lib/server/customers';
import { receiveCustomerPayment } from '$lib/server/customers/payments';
import { minor } from '$lib/money';
import { load as listLoad } from './+page.server';
import { load as newLoad, actions as newActions } from './new/+page.server';
import { load as oneLoad, actions as oneActions } from './[id]/+page.server';

// The Customers pages (tasks/customer-credit T-21).
// MANDATORY (spec 29 — a permission check on every route): every load and every
// action answers 403 to anyone without admin.customers, and writes nothing.

afterAll(async () => {
	await closeTestDb();
});

const AT = new Date('2026-09-28T09:00:00Z');

function principal(f: SalesFixture, role: Principal['role']): Principal {
	return {
		userId: role === 'owner' ? f.ownerId : f.staffId,
		restaurantId: f.restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Sam',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function makeEvent(
	user: Principal,
	o: { id?: string; form?: Record<string, string>; search?: string } = {}
): RequestEvent {
	const path = o.id ? `/customers/${o.id}` : '/customers';
	const url = new URL(`http://localhost${path}${o.search ?? ''}`);
	const body = o.form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(o.form ?? {})) body!.append(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: o.id ? { id: o.id } : {},
		request: new Request(url, o.form ? { method: 'POST', body } : undefined),
		route: { id: o.id ? '/(dashboard)/customers/[id]' : '/(dashboard)/customers' },
		url
	} as unknown as RequestEvent;
}

type Thrown = { status?: number; location?: string };
async function thrownBy(run: () => unknown): Promise<Thrown | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return thrown as Thrown;
	}
}

type OneAction = keyof typeof oneActions;
const actOne = (name: OneAction, event: RequestEvent) =>
	oneActions[name]!(event as Parameters<NonNullable<(typeof oneActions)[OneAction]>>[0]);
const actNew = (event: RequestEvent) =>
	newActions.create!(event as Parameters<NonNullable<typeof newActions.create>>[0]);

async function seeded() {
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
	return { f, session };
}

async function addCustomer(f: SalesFixture, name = 'Ali Hassan', phone = '615000001') {
	const created = await db.transaction((tx) =>
		createCustomer(
			tx,
			{ restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null },
			{ name, phone, creditLimitMinor: null }
		)
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

async function pay(
	f: SalesFixture,
	session: string,
	customerId: string,
	amount: bigint,
	method: 'cash' | 'card'
): Promise<string> {
	const paymentId = randomUUID();
	// After the charges, as in life: the statement orders by time.
	const at = new Date(AT.getTime() + 3_600_000);
	const result = await db.transaction((tx) =>
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
				paymentId,
				customerId,
				posSessionId: session,
				method,
				paymentMethodId: f.paymentMethods[method].id,
				paymentMethodName: f.paymentMethods[method].name,
				amountMinor: minor(amount),
				tenderedMinor: method === 'cash' ? minor(amount) : null,
				changeMinor: method === 'cash' ? minor(0n) : null,
				receivedAt: at
			}
		)
	);
	if (!result.ok) throw new Error(result.reason);
	return paymentId;
}

const audits = (restaurantId: string, event: string) =>
	testDb()
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.event, event)));

describe('MANDATORY (spec 29) — the Customers pages check admin.customers', () => {
	it('refuses staff with 403 on all three loads and on every action, writing nothing', async () => {
		const { f, session } = await seeded();
		const id = await addCustomer(f);
		await charge(f, session, id, 1);
		const paymentId = await pay(f, session, id, 500n, 'card');
		const staff = principal(f, 'staff');

		expect((await thrownBy(() => listLoad(makeEvent(staff) as never)))?.status).toBe(403);
		expect((await thrownBy(() => newLoad(makeEvent(staff) as never)))?.status).toBe(403);
		expect((await thrownBy(() => oneLoad(makeEvent(staff, { id }) as never)))?.status).toBe(403);

		const created = await thrownBy(() =>
			actNew(makeEvent(staff, { form: { name: 'Sneaky', phone: '615999999', creditLimit: '' } }))
		);
		expect(created?.status).toBe(403);
		const forms: Record<OneAction, Record<string, string>> = {
			update: { name: 'Changed', phone: '615000009', creditLimit: '' },
			archive: {},
			restore: {},
			reversePayment: { paymentId, reason: 'Keyed twice' }
		};
		for (const name of Object.keys(oneActions) as OneAction[]) {
			const thrown = await thrownBy(() =>
				actOne(name, makeEvent(staff, { id, form: forms[name] }))
			);
			expect(thrown?.status, name).toBe(403);
		}

		const rows = await testDb()
			.select()
			.from(customers)
			.where(eq(customers.restaurantId, f.restaurantId));
		expect(rows.map((r) => [r.name, r.phone, r.archivedAt])).toEqual([
			['Ali Hassan', '615000001', null]
		]);
		const [payment] = await testDb()
			.select()
			.from(customerPayments)
			.where(eq(customerPayments.id, paymentId));
		expect(payment.reversedAt).toBeNull();
	});

	it("another restaurant's customer is 404 on the load and in every action; nothing changes", async () => {
		const a = await seeded();
		const b = await seeded();
		const theirs = await addCustomer(b.f, 'Theirs', '615000777');
		await charge(b.f, b.session, theirs, 1);
		const theirPayment = await pay(b.f, b.session, theirs, 500n, 'card');
		const owner = principal(a.f, 'owner');

		expect((await thrownBy(() => oneLoad(makeEvent(owner, { id: theirs }) as never)))?.status).toBe(
			404
		);
		expect((await thrownBy(() => oneLoad(makeEvent(owner, { id: 'nope' }) as never)))?.status).toBe(
			404
		);
		const update = await actOne(
			'update',
			makeEvent(owner, { id: theirs, form: { name: 'Mine', phone: '615000001', creditLimit: '' } })
		);
		expect(update).toMatchObject({ status: 404 });
		expect(await actOne('archive', makeEvent(owner, { id: theirs, form: {} }))).toMatchObject({
			status: 404
		});
		const reverse = await actOne(
			'reversePayment',
			makeEvent(owner, { id: theirs, form: { paymentId: theirPayment, reason: 'Not mine' } })
		);
		expect(reverse).toMatchObject({ status: 404 });

		const [row] = await testDb().select().from(customers).where(eq(customers.id, theirs));
		expect(row).toMatchObject({ name: 'Theirs', archivedAt: null });
		expect(await balanceOf(db, b.f.restaurantId, theirs)).toBe(380n);
	});
});

describe('the Customers pages — the owner', () => {
	it('adds a customer with a typed limit, lists them with what they owe, and the total', async () => {
		const { f, session } = await seeded();
		const owner = principal(f, 'owner');

		const created = await thrownBy(() =>
			actNew(
				makeEvent(owner, {
					form: { name: ' Ali  Hassan ', phone: '615000001', creditLimit: '50.00' }
				})
			)
		);
		expect(created?.status).toBe(303);
		const id = created!.location!.split('/').pop()!;
		const [row] = await testDb().select().from(customers).where(eq(customers.id, id));
		expect(row).toMatchObject({ name: 'Ali Hassan', phone: '615000001', creditLimitMinor: 5000n });
		expect(await audits(f.restaurantId, 'customer.created')).toHaveLength(1);

		await charge(f, session, id, 1);
		const data = (await listLoad(makeEvent(owner) as never)) as {
			totalOwed: string;
			tripwire: unknown;
			customers: { name: string; limit: string | null; balance: string; owes: boolean }[];
		};
		expect(data.customers).toEqual([
			expect.objectContaining({ name: 'Ali Hassan', limit: '50.00', balance: '8.80', owes: true })
		]);
		expect(data.totalOwed).toBe('8.80');
		// Balances and account 1100 agree: no warning.
		expect(data.tripwire).toBeNull();
	});

	it('refuses a bad limit, an empty name and a taken phone, handing the typed values back', async () => {
		const { f } = await seeded();
		await addCustomer(f, 'Ali', '615000001');
		const owner = principal(f, 'owner');
		const attempt = (form: Record<string, string>) => actNew(makeEvent(owner, { form }));

		expect(await attempt({ name: 'Sara', phone: '615000002', creditLimit: 'lots' })).toMatchObject({
			status: 400,
			data: { values: { name: 'Sara', creditLimit: 'lots' } }
		});
		expect(await attempt({ name: '  ', phone: '615000002', creditLimit: '' })).toMatchObject({
			status: 400
		});
		expect(await attempt({ name: 'Twin', phone: '615000001', creditLimit: '' })).toMatchObject({
			status: 400,
			data: { message: 'Another customer already has that phone number.' }
		});
		expect(await testDb().select().from(customers)).toHaveLength(1);
	});

	it('shows the statement with a running balance, and reverses a card payment with a reason', async () => {
		const { f, session } = await seeded();
		const id = await addCustomer(f);
		await charge(f, session, id, 1); // 880
		const paymentId = await pay(f, session, id, 500n, 'card');
		const owner = principal(f, 'owner');

		type Loaded = {
			customer: { balance: string };
			statement: {
				kind: string;
				what: string;
				amount: string;
				balance: string;
				reversible: boolean;
				paymentId: string | null;
			}[];
		};
		const before = (await oneLoad(makeEvent(owner, { id }) as never)) as Loaded;
		expect(before.customer.balance).toBe('3.80');
		expect(before.statement.map((r) => [r.kind, r.amount, r.balance])).toEqual([
			['charge', '8.80', '8.80'],
			['payment', '−5.00', '3.80']
		]);
		expect(before.statement[0].what).toBe(`Invoice ${f.deviceCode}-000001`);
		expect(before.statement[1]).toMatchObject({ reversible: true, paymentId });

		const short = await actOne(
			'reversePayment',
			makeEvent(owner, { id, form: { paymentId, reason: 'x' } })
		);
		expect(short).toMatchObject({ status: 400 });

		const reversed = await thrownBy(() =>
			actOne('reversePayment', makeEvent(owner, { id, form: { paymentId, reason: 'Keyed twice' } }))
		);
		expect(reversed?.status).toBe(303);

		const after = (await oneLoad(makeEvent(owner, { id }) as never)) as Loaded;
		expect(after.customer.balance).toBe('8.80');
		expect(after.statement.map((r) => [r.kind, r.amount, r.balance])).toEqual([
			['charge', '8.80', '8.80'],
			['payment', '−5.00', '3.80'],
			['reversal', '5.00', '8.80']
		]);
		expect(after.statement[1]).toMatchObject({ reversible: false, paymentId: null });
		expect(after.statement[2].what).toBe('Reversal — Keyed twice');
		expect(await audits(f.restaurantId, 'customer.payment_reversed')).toHaveLength(1);

		const again = await actOne(
			'reversePayment',
			makeEvent(owner, { id, form: { paymentId, reason: 'Again' } })
		);
		expect(again).toMatchObject({
			status: 400,
			data: { message: 'This payment was already reversed.' }
		});
	});

	it('a cash payment is not reversible once its shift is closed, and the action says why', async () => {
		const { f, session } = await seeded();
		const id = await addCustomer(f);
		await charge(f, session, id, 1);
		const paymentId = await pay(f, session, id, 500n, 'cash');
		await closeSessionAt(db, f, {
			posSessionId: session,
			closedAt: new Date(AT.getTime() + 7_200_000),
			countedCashMinor: 500n
		});
		const owner = principal(f, 'owner');

		const data = (await oneLoad(makeEvent(owner, { id }) as never)) as {
			statement: { kind: string; reversible: boolean; paymentId: string | null }[];
		};
		expect(data.statement[1]).toMatchObject({ kind: 'payment', reversible: false, paymentId });

		const result = await actOne(
			'reversePayment',
			makeEvent(owner, { id, form: { paymentId, reason: 'Keyed twice' } })
		);
		expect(result).toMatchObject({
			status: 400,
			data: { message: "This cash payment's shift is closed, so it can no longer be reversed." }
		});
	});

	it('edits, refuses to archive a customer who owes, archives one who does not, and restores', async () => {
		const { f, session } = await seeded();
		const owes = await addCustomer(f, 'Owes', '615000001');
		const clear = await addCustomer(f, 'Clear', '615000002');
		await charge(f, session, owes, 1);
		const owner = principal(f, 'owner');

		const edited = await thrownBy(() =>
			actOne(
				'update',
				makeEvent(owner, {
					id: clear,
					form: { name: 'Clear Sky', phone: '615000002', creditLimit: '20' }
				})
			)
		);
		expect(edited?.status).toBe(303);
		const [row] = await testDb().select().from(customers).where(eq(customers.id, clear));
		expect(row).toMatchObject({ name: 'Clear Sky', creditLimitMinor: 2000n });

		expect(await actOne('archive', makeEvent(owner, { id: owes, form: {} }))).toMatchObject({
			status: 400
		});
		expect(
			(await thrownBy(() => actOne('archive', makeEvent(owner, { id: clear, form: {} }))))?.status
		).toBe(303);

		const live = (await listLoad(makeEvent(owner) as never)) as { customers: { name: string }[] };
		expect(live.customers.map((c) => c.name)).toEqual(['Owes']);
		const all = (await listLoad(makeEvent(owner, { search: '?archived=1' }) as never)) as {
			customers: { name: string; archived: boolean }[];
		};
		expect(all.customers.map((c) => [c.name, c.archived])).toEqual([
			['Clear Sky', true],
			['Owes', false]
		]);

		expect(
			(await thrownBy(() => actOne('restore', makeEvent(owner, { id: clear, form: {} }))))?.status
		).toBe(303);
		expect(await audits(f.restaurantId, 'customer.archived')).toHaveLength(1);
		expect(await audits(f.restaurantId, 'customer.restored')).toHaveLength(1);
	});
});
