import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { roles } from '../db/schema/roles';
import { hashPin, verifyPin } from '../../pin';
import { listPosEmployees } from './employee-directory';
import { CASHIER_KEYS, POS_KEYS, WAITER_KEYS } from '../permissions/keys';
import { seedRole, seedStaff } from '../db/test/seed';
import { and, eq } from 'drizzle-orm';

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

	await seedRole(db, restaurant.id, {
		name: 'Cashier',
		permissionKeys: CASHIER_KEYS
	});

	await seedRole(db, restaurant.id, {
		name: 'Waiter',
		permissionKeys: WAITER_KEYS
	});

	return { restaurantId: restaurant.id, ownerId: owner.id };
}

async function addEmployee(
	restaurantId: string,
	role: 'cashier' | 'waiter',
	displayName: string,
	opts: { pinHash?: string | null; isActive?: boolean } = {}
): Promise<string> {
	const seeded = await seedStaff(db, restaurantId, {
		displayName,
		roleName: role === 'cashier' ? 'Cashier' : 'Waiter',
		pinHash: opts.pinHash === undefined ? PIN_1234 : opts.pinHash,
		isActive: opts.isActive ?? true
	});

	return seeded.id;
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

	it('includes the owner with isOwner true, Owner roleName, and all ten POS permissions', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const rows = await listPosEmployees(db, a.restaurantId);
		const owner = rows.find((r) => r.id === a.ownerId);

		expect(owner).toBeDefined();
		expect(owner!.isOwner).toBe(true);
		expect(owner!.roleName).toBe('Owner');
		expect(owner!.permissions).toEqual([...POS_KEYS]);
	});

	it('returns an employee with no PIN set, with pinPhc null', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const fresh = await addEmployee(a.restaurantId, 'waiter', 'New Hire', { pinHash: null });

		const row = (await listPosEmployees(db, a.restaurantId)).find((r) => r.id === fresh);

		expect(row).toBeDefined();
		expect(row!.pinPhc).toBeNull();
	});

	it('orders owner first, then roleName, then displayName', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await addEmployee(a.restaurantId, 'waiter', 'Zed');
		await addEmployee(a.restaurantId, 'cashier', 'Sam');
		await addEmployee(a.restaurantId, 'waiter', 'Ali');

		const rows = await listPosEmployees(db, a.restaurantId);

		expect(rows.map((r) => `${r.roleName}:${r.displayName}`)).toEqual([
			'Owner:Cafe A Owner',
			'Cashier:Sam',
			'Waiter:Ali',
			'Waiter:Zed'
		]);
	});

	it('returns exactly seven keys per employee', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await addEmployee(a.restaurantId, 'cashier', 'Sam');

		const rows = await listPosEmployees(db, a.restaurantId);

		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual([
				'displayName',
				'id',
				'isActive',
				'isOwner',
				'permissions',
				'pinPhc',
				'roleName'
			]);
		}
	});

	it('returns exactly the five Cashier permissions for a Cashier', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const cashier = await addEmployee(a.restaurantId, 'cashier', 'Sam');

		const row = (await listPosEmployees(db, a.restaurantId)).find((r) => r.id === cashier);

		expect(row).toBeDefined();
		expect(row!.isOwner).toBe(false);
		expect(row!.roleName).toBe('Cashier');
		expect(row!.permissions).toEqual([...CASHIER_KEYS]);
	});

	it('reflects a changed role on the next list', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const cashier = await addEmployee(a.restaurantId, 'cashier', 'Sam');
		const [targetRole] = await db
			.select({ id: roles.id })
			.from(roles)
			.where(and(eq(roles.restaurantId, a.restaurantId), eq(roles.name, 'Waiter')));

		expect(targetRole).toBeDefined();

		await db.update(users).set({ roleId: targetRole!.id }).where(eq(users.id, cashier));

		const row = (await listPosEmployees(db, a.restaurantId)).find((r) => r.id === cashier);

		expect(row).toBeDefined();
		expect(row!.roleName).toBe('Waiter');
		expect(row!.permissions).toEqual([...WAITER_KEYS]);
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
