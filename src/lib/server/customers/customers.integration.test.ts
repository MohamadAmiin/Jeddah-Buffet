import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { onRestaurantCreated } from '../restaurants';
import { minor } from '../../money';
import {
	archiveCustomer,
	balanceOf,
	cleanCustomerPhone,
	createCustomer,
	getCustomer,
	listCustomers,
	lockCustomer,
	receivableTripwire,
	restoreCustomer,
	statement,
	updateCustomer,
	type CustomerWriteContext
} from './index';

// Customers (tasks/customer-credit T-08): the catalogue — create, edit, archive,
// restore, tenant isolation, audit. The balance, the statement and the 1100
// tripwire are proved with REAL charges and payments in
// src/lib/server/orders/credit-sale.integration.test.ts (T-10) and
// ./payments.integration.test.ts (T-11), once their writers exist.

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name: string): Promise<CustomerWriteContext> {
	const [r] = await testDb().insert(restaurants).values({ name }).returning({ id: restaurants.id });
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, r.id, { restaurantName: name, timeZone: 'Africa/Mogadishu' })
	);
	const [owner] = await testDb()
		.insert(users)
		.values({
			restaurantId: r.id,
			role: 'owner',
			displayName: 'Owner',
			email: `${randomUUID()}@example.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });
	return { restaurantId: r.id, actorUserId: owner.id, ip: '203.0.113.9', userAgent: 'vitest' };
}

async function make(
	c: CustomerWriteContext,
	name = 'Ali Hassan',
	phone = '615000001',
	limit: bigint | null = null
): Promise<string> {
	const result = await db.transaction((tx) =>
		createCustomer(tx, c, {
			name,
			phone,
			creditLimitMinor: limit === null ? null : minor(limit)
		})
	);
	if (!result.ok) throw new Error(result.reason);
	return result.customerId;
}

async function audit(restaurantId: string, event: string) {
	return testDb()
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.event, event)));
}

describe('customers: create and edit', () => {
	it('creates a customer with a cleaned name and phone, a limit, and its audit row', async () => {
		const c = await makeRestaurant('cust-create');
		const id = await make(c, '  Ali \n Hassan ', ' 61 500 0001 ', 5000n);

		const row = await getCustomer(db, c.restaurantId, id);
		expect(row).toMatchObject({
			name: 'Ali Hassan',
			phone: '61 500 0001',
			creditLimitMinor: 5000n,
			archivedAt: null,
			balanceMinor: 0n
		});

		const rows = await audit(c.restaurantId, 'customer.created');
		expect(rows).toHaveLength(1);
		expect(rows[0].actorUserId).toBe(c.actorUserId);
		expect(rows[0].details).toEqual({
			customerId: id,
			name: 'Ali Hassan',
			phone: '61 500 0001',
			creditLimitMinor: '5000'
		});
	});

	it('no limit is stored as NULL and reads as null', async () => {
		const c = await makeRestaurant('cust-nolimit');
		const id = await make(c);
		expect((await getCustomer(db, c.restaurantId, id))?.creditLimitMinor).toBeNull();
	});

	it('refuses an empty name, a bad phone and a negative limit, writing nothing', async () => {
		const c = await makeRestaurant('cust-refuse');
		const attempt = (name: string, phone: string, limit: bigint | null) =>
			db.transaction((tx) =>
				createCustomer(tx, c, {
					name,
					phone,
					creditLimitMinor: limit === null ? null : minor(limit)
				})
			);
		expect(await attempt(' \n ', '615000001', null)).toEqual({ ok: false, reason: 'invalid_name' });
		expect(await attempt('Ali', '61', null)).toEqual({ ok: false, reason: 'invalid_phone' });
		expect(await attempt('Ali', '6'.repeat(33), null)).toEqual({
			ok: false,
			reason: 'invalid_phone'
		});
		expect(await attempt('Ali', '615000001', -1n)).toEqual({ ok: false, reason: 'invalid_limit' });
		expect(await listCustomers(db, c.restaurantId, { include: 'all' })).toEqual([]);
		expect(await audit(c.restaurantId, 'customer.created')).toHaveLength(0);
	});

	it('a name longer than 80 code points is cut, never refused', async () => {
		const c = await makeRestaurant('cust-long');
		const id = await make(c, 'x'.repeat(120));
		expect((await getCustomer(db, c.restaurantId, id))?.name).toBe('x'.repeat(80));
	});

	it('one LIVE customer per phone: a second is refused and the transaction stays usable', async () => {
		const c = await makeRestaurant('cust-phone');
		await make(c, 'Ali', '615000001');
		const second = await db.transaction(async (tx) => {
			const refused = await createCustomer(tx, c, {
				name: 'Twin',
				phone: '615000001',
				creditLimitMinor: null
			});
			// The savepoint rolled back; the outer transaction can still write.
			const other = await createCustomer(tx, c, {
				name: 'Other',
				phone: '615000002',
				creditLimitMinor: null
			});
			return { refused, other };
		});
		expect(second.refused).toEqual({ ok: false, reason: 'phone_taken' });
		expect(second.other.ok).toBe(true);
		expect(await audit(c.restaurantId, 'customer.created')).toHaveLength(2);
	});

	it('another restaurant may hold the same phone', async () => {
		const a = await makeRestaurant('cust-a');
		const b = await makeRestaurant('cust-b');
		await make(a, 'Ali', '615000001');
		expect(await make(b, 'Ali', '615000001')).toBeTruthy();
	});

	it('an edit records exactly what changed; an unchanged edit writes nothing', async () => {
		const c = await makeRestaurant('cust-edit');
		const id = await make(c, 'Ali', '615000001', 5000n);

		const same = await db.transaction((tx) =>
			updateCustomer(tx, c, id, {
				name: 'Ali',
				phone: '615000001',
				creditLimitMinor: minor(5000n)
			})
		);
		expect(same).toEqual({ ok: true, changed: false });
		expect(await audit(c.restaurantId, 'customer.updated')).toHaveLength(0);

		const changed = await db.transaction((tx) =>
			updateCustomer(tx, c, id, { name: 'Ali Hassan', phone: '615000001', creditLimitMinor: null })
		);
		expect(changed).toEqual({ ok: true, changed: true });
		const rows = await audit(c.restaurantId, 'customer.updated');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			customerId: id,
			changes: {
				name: { old: 'Ali', new: 'Ali Hassan' },
				creditLimitMinor: { old: '5000', new: null }
			}
		});
	});

	it('an edit onto a taken phone is refused', async () => {
		const c = await makeRestaurant('cust-edit-phone');
		await make(c, 'Ali', '615000001');
		const id = await make(c, 'Sara', '615000002');
		const result = await db.transaction((tx) =>
			updateCustomer(tx, c, id, { name: 'Sara', phone: '615000001', creditLimitMinor: null })
		);
		expect(result).toEqual({ ok: false, reason: 'phone_taken' });
		expect((await getCustomer(db, c.restaurantId, id))?.phone).toBe('615000002');
	});

	it('cleanCustomerPhone keeps digits, plus and spaces; drops control characters', () => {
		expect(cleanCustomerPhone(' +252 61\t500 ')).toBe('+252 61 500');
		expect(cleanCustomerPhone('61\u001b5000')).toBe('61 5000');
		expect(cleanCustomerPhone('6')).toBeNull();
	});
});

describe('customers: archive and restore', () => {
	it('archives a customer who owes nothing; they leave the live list and stay in "all"', async () => {
		const c = await makeRestaurant('cust-archive');
		const id = await make(c);

		expect(await db.transaction((tx) => archiveCustomer(tx, c, id))).toEqual({ ok: true });
		expect(await listCustomers(db, c.restaurantId)).toEqual([]);
		// Owes nothing: not on the till's list either.
		expect(await listCustomers(db, c.restaurantId, { include: 'collectable' })).toEqual([]);
		const all = await listCustomers(db, c.restaurantId, { include: 'all' });
		expect(all.map((r) => r.id)).toEqual([id]);
		expect(all[0].archivedAt).toBeInstanceOf(Date);
		expect(await audit(c.restaurantId, 'customer.archived')).toHaveLength(1);

		expect(await db.transaction((tx) => archiveCustomer(tx, c, id))).toEqual({
			ok: false,
			reason: 'already_archived'
		});
	});

	it('archiving frees the phone; restore is refused while a live customer holds it', async () => {
		const c = await makeRestaurant('cust-restore');
		const first = await make(c, 'Ali', '615000001');
		await db.transaction((tx) => archiveCustomer(tx, c, first));
		const second = await make(c, 'Ali the second', '615000001');

		expect(await db.transaction((tx) => restoreCustomer(tx, c, first))).toEqual({
			ok: false,
			reason: 'phone_taken'
		});

		await db.transaction((tx) => archiveCustomer(tx, c, second));
		expect(await db.transaction((tx) => restoreCustomer(tx, c, first))).toEqual({ ok: true });
		expect((await getCustomer(db, c.restaurantId, first))?.archivedAt).toBeNull();
		expect(await audit(c.restaurantId, 'customer.restored')).toHaveLength(1);

		expect(await db.transaction((tx) => restoreCustomer(tx, c, first))).toEqual({
			ok: false,
			reason: 'not_archived'
		});
	});
});

describe('customers: restaurant scoping', () => {
	it("MANDATORY (invariant 8): another restaurant's customer is invisible to every function", async () => {
		const a = await makeRestaurant('cust-scope-a');
		const b = await makeRestaurant('cust-scope-b');
		const id = await make(a, 'Ali', '615000001', 5000n);

		expect(await getCustomer(db, b.restaurantId, id)).toBeNull();
		expect(await balanceOf(db, b.restaurantId, id)).toBe(0n);
		expect(await statement(db, b.restaurantId, id)).toEqual([]);
		expect(await listCustomers(db, b.restaurantId, { include: 'all' })).toEqual([]);
		expect(await db.transaction((tx) => lockCustomer(tx, b.restaurantId, id))).toBeNull();
		expect(
			await db.transaction((tx) =>
				updateCustomer(tx, b, id, { name: 'Mine', phone: '615000009', creditLimitMinor: null })
			)
		).toEqual({ ok: false, reason: 'not_found' });
		expect(await db.transaction((tx) => archiveCustomer(tx, b, id))).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await db.transaction((tx) => restoreCustomer(tx, b, id))).toEqual({
			ok: false,
			reason: 'not_found'
		});
		// Untouched.
		expect((await getCustomer(db, a.restaurantId, id))?.name).toBe('Ali');
	});

	it('a restaurant with no charges has a matching, zero tripwire', async () => {
		const c = await makeRestaurant('cust-tripwire');
		await make(c);
		expect(await receivableTripwire(db, c.restaurantId)).toEqual({
			sumOfBalances: 0n,
			ledger1100: 0n,
			matches: true
		});
	});
});
