import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../db/client';
import { onRestaurantCreated } from '../restaurants';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { seedStaff } from '../db/test/seed';
import { closeTestDb, testDb } from '../db/test/db';
import { checkEmployee } from './employee';

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurantWithOwner(name: string, email: string) {
	const [restaurantRow] = await testDb().insert(restaurants).values({ name }).returning({
		id: restaurants.id
	});
	const restaurantId = restaurantRow.id;
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, restaurantId, {
			restaurantName: name,
			timeZone: 'UTC'
		})
	);
	const [ownerRow] = await testDb()
		.insert(users)
		.values({
			restaurantId,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });
	return { restaurantId, ownerId: ownerRow.id };
}

describe('checkEmployee', () => {
	it('the owner passes any POS key check', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner(
			'Cafe Owner',
			'owner-emp@example.com'
		);
		expect(
			await checkEmployee(testDb(), restaurantId, ownerId, ['pos.sell', 'pos.payment'])
		).toEqual({
			ok: true
		});
	});

	it('a Cashier passes pos.sell + pos.payment; a Waiter does not', async () => {
		const { restaurantId } = await makeRestaurantWithOwner('Cafe Roles', 'roles-emp@example.com');
		const cashier = await seedStaff(db, restaurantId, { displayName: 'Sam', roleName: 'Cashier' });
		const waiter = await seedStaff(db, restaurantId, { displayName: 'Wren', roleName: 'Waiter' });

		expect(
			await checkEmployee(testDb(), restaurantId, cashier.id, ['pos.sell', 'pos.payment'])
		).toEqual({ ok: true });
		expect(
			await checkEmployee(testDb(), restaurantId, waiter.id, ['pos.sell', 'pos.payment'])
		).toEqual({ ok: false, reason: 'employee_not_permitted' });
		expect(await checkEmployee(testDb(), restaurantId, waiter.id, ['pos.view_menu'])).toEqual({
			ok: true
		});
	});

	it('an inactive employee fails with employee_inactive', async () => {
		const { restaurantId } = await makeRestaurantWithOwner('Cafe Off', 'inactive-emp@example.com');
		const dee = await seedStaff(db, restaurantId, {
			displayName: 'Dee',
			roleName: 'Cashier',
			isActive: false
		});
		expect(await checkEmployee(testDb(), restaurantId, dee.id, ['pos.sell'])).toEqual({
			ok: false,
			reason: 'employee_inactive'
		});
		expect(await checkEmployee(testDb(), restaurantId, dee.id, [])).toEqual({
			ok: false,
			reason: 'employee_inactive'
		});
	});

	it('another restaurant’s user reads as employee_unknown when scoped to this one', async () => {
		const a = await makeRestaurantWithOwner('Cafe A', 'a-emp@example.com');
		const b = await makeRestaurantWithOwner('Cafe B', 'b-emp@example.com');
		expect(await checkEmployee(testDb(), a.restaurantId, b.ownerId, ['pos.sell'])).toEqual({
			ok: false,
			reason: 'employee_unknown'
		});
	});

	it('a random uuid reads as employee_unknown', async () => {
		const { restaurantId } = await makeRestaurantWithOwner('Cafe Rand', 'rand-emp@example.com');
		expect(await checkEmployee(testDb(), restaurantId, randomUUID(), ['pos.sell'])).toEqual({
			ok: false,
			reason: 'employee_unknown'
		});
	});

	it('an empty keys list is an identity-only check and passes when active', async () => {
		const { restaurantId } = await makeRestaurantWithOwner('Cafe Empty', 'empty-emp@example.com');
		const sam = await seedStaff(db, restaurantId, { displayName: 'Sam', roleName: 'Cashier' });
		expect(await checkEmployee(testDb(), restaurantId, sam.id, [])).toEqual({ ok: true });
	});

	it('works inside a db.transaction (Executor accepts DbTx)', async () => {
		const { restaurantId, ownerId } = await makeRestaurantWithOwner(
			'Cafe Tx',
			'tx-emp@example.com'
		);
		let inside: { ok: boolean } | undefined;
		await db.transaction(async (tx) => {
			inside = await checkEmployee(tx, restaurantId, ownerId, ['pos.sell']);
		});
		expect(inside).toEqual({ ok: true });
	});
});
