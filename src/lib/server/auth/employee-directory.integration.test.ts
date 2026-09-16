import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { hashPin, verifyPin } from '../../pin';
import { listPosEmployees } from './employee-directory';

const db = testDb();

// One real 600,000-iteration hash for the whole file.
let PIN_1234: string;

beforeAll(async () => {
	PIN_1234 = await hashPin('1234');
});

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name: string, email: string) {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: `${name} Owner`,
			email,
			passwordHash: 'not-a-real-hash',
			pinHash: PIN_1234
		})
		.returning();
	return { restaurantId: restaurant.id, ownerId: owner.id };
}

async function addEmployee(
	restaurantId: string,
	role: 'cashier' | 'waiter',
	displayName: string,
	opts: { pinHash?: string | null; isActive?: boolean } = {}
): Promise<string> {
	const [row] = await db
		.insert(users)
		.values({
			restaurantId,
			role,
			displayName,
			pinHash: opts.pinHash === undefined ? PIN_1234 : opts.pinHash,
			isActive: opts.isActive ?? true
		})
		.returning();
	return row.id;
}

describe('listPosEmployees', () => {
	it("returns one restaurant's employees and never another's", async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const b = await makeRestaurant('Cafe B', 'b@cafe.com');
		const cashierA = await addEmployee(a.restaurantId, 'cashier', 'Sam');
		const waiterA = await addEmployee(a.restaurantId, 'waiter', 'Ali');
		await addEmployee(b.restaurantId, 'cashier', 'Should Not Appear');

		const rows = await listPosEmployees(db, a.restaurantId);

		expect(rows.map((r) => r.id).sort()).toEqual([a.ownerId, cashierA, waiterA].sort());
		expect(rows.map((r) => r.displayName)).not.toContain('Should Not Appear');
	});

	it('excludes a deactivated employee and keeps an active one', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const gone = await addEmployee(a.restaurantId, 'cashier', 'Gone', { isActive: false });
		const waiter = await addEmployee(a.restaurantId, 'waiter', 'Ali');

		const ids = (await listPosEmployees(db, a.restaurantId)).map((r) => r.id);

		expect(ids).not.toContain(gone);
		expect(ids).toContain(waiter);
	});

	// Spec 7: the owner also has a POS PIN, used to approve sensitive actions — and
	// approvals must work offline, so the owner's hash is in the same bundle.
	it('includes the owner', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const rows = await listPosEmployees(db, a.restaurantId);

		expect(rows.find((r) => r.id === a.ownerId)?.role).toBe('owner');
	});

	it('returns an employee with no PIN set, with pinPhc null', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const fresh = await addEmployee(a.restaurantId, 'waiter', 'New Hire', { pinHash: null });

		const row = (await listPosEmployees(db, a.restaurantId)).find((r) => r.id === fresh);

		expect(row).toBeDefined();
		expect(row!.pinPhc).toBeNull();
	});

	it('orders by role, then name, so the list is stable between syncs', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await addEmployee(a.restaurantId, 'waiter', 'Zed');
		await addEmployee(a.restaurantId, 'cashier', 'Sam');
		await addEmployee(a.restaurantId, 'waiter', 'Ali');

		const rows = await listPosEmployees(db, a.restaurantId);

		expect(rows.map((r) => `${r.role}:${r.displayName}`)).toEqual([
			'owner:Cafe A Owner',
			'cashier:Sam',
			'waiter:Ali',
			'waiter:Zed'
		]);
	});

	// THE SHAPE LOCK. This fails the day somebody widens the query to select() and
	// quietly starts shipping the password hash to a tablet.
	it('returns exactly five keys per employee', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await addEmployee(a.restaurantId, 'cashier', 'Sam');

		const rows = await listPosEmployees(db, a.restaurantId);

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(['displayName', 'id', 'isActive', 'pinPhc', 'role']);
		}
	});

	// The bundle is usable offline: the same isomorphic verifyPin the till runs
	// accepts the cached hash for the right PIN and refuses a wrong one.
	it('ships a hash the offline till can verify with', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const cashier = await addEmployee(a.restaurantId, 'cashier', 'Sam');

		const row = (await listPosEmployees(db, a.restaurantId)).find((r) => r.id === cashier)!;

		expect(await verifyPin('1234', row.pinPhc!)).toBe(true);
		expect(await verifyPin('4321', row.pinPhc!)).toBe(false);
	});
});
