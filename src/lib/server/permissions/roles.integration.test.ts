import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { testDb, closeTestDb } from '../db/test/db';
import type { DbTx } from '../db/client';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { seedRole, seedStaff } from '../db/test/seed';
import { CASHIER_KEYS, ALL_KEYS, type PosPermissionKey } from './keys';
import {
	archiveRole,
	assertLiveRole,
	createRole,
	getRole,
	listRoles,
	permissionsForUser,
	updateRole
} from './roles';

const db = testDb();

const concurrencyPool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await concurrencyPool.end();
	await closeTestDb();
});

const ctx = (actorUserId: string) => ({
	actorUserId,
	ip: null,
	userAgent: null
});

async function makeRestaurant(email = 'owner@roles.test') {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Roles Test Cafe' }).returning();

	if (!restaurant) throw new Error('Failed to create test restaurant.');

	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();

	if (!owner) throw new Error('Failed to create test owner.');

	return {
		restaurantId: restaurant.id,
		ownerId: owner.id
	};
}

async function auditRows(event: string, restaurantId: string) {
	return db
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.event, event), eq(auditLog.restaurantId, restaurantId)));
}

async function createTestRole(
	restaurantId: string,
	name = 'Kitchen',
	permissionKeys: readonly PosPermissionKey[] = ['pos.view_menu']
) {
	const [owner] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.restaurantId, restaurantId), eq(users.role, 'owner')))
		.limit(1);

	if (!owner) throw new Error('Test owner not found.');

	return db.transaction((tx) =>
		createRole(tx, restaurantId, { name, permissionKeys: [...permissionKeys] }, ctx(owner.id))
	);
}

describe('role reads and writes', () => {
	it('creates and lists a role with its permission keys', async () => {
		const a = await makeRestaurant();

		const result = await createTestRole(a.restaurantId, 'Kitchen', [
			'pos.send_to_kitchen',
			'pos.view_menu'
		]);

		expect(result).toEqual(expect.objectContaining({ ok: true }));

		if (!result.ok) throw new Error('Role creation failed.');

		const rows = await listRoles(db, a.restaurantId);
		const role = rows.find((row) => row.id === result.id);

		expect(role).toBeDefined();
		expect(role?.name).toBe('Kitchen');
		expect(role?.permissionKeys).toEqual(['pos.view_menu', 'pos.send_to_kitchen']);
		expect(role?.archivedAt).toBeNull();
		expect(role?.activeStaffCount).toBe(0);
		expect(role?.staffCount).toBe(0);

		const foreign = await makeRestaurant('foreign@roles.test');
		expect(await getRole(db, foreign.restaurantId, result.id)).toBeNull();
	});

	it('treats live names case-insensitively and frees the name after archive', async () => {
		const a = await makeRestaurant();

		const first = await createTestRole(a.restaurantId, 'Cashier');
		expect(first.ok).toBe(true);

		const duplicate = await createTestRole(a.restaurantId, 'cashier');
		expect(duplicate).toEqual({ ok: false, reason: 'duplicate_name' });

		if (!first.ok) throw new Error('Role creation failed.');

		const archived = await db.transaction((tx) =>
			archiveRole(tx, a.restaurantId, first.id, ctx(a.ownerId))
		);

		expect(archived).toEqual({ ok: true });

		const replacement = await createTestRole(a.restaurantId, 'CASHIER');
		expect(replacement.ok).toBe(true);
	});

	it.each(['Owner', 'owner', 'OWNER'])('rejects reserved role name %s', async (name) => {
		const a = await makeRestaurant();

		await expect(createTestRole(a.restaurantId, name)).resolves.toEqual({
			ok: false,
			reason: 'reserved_name'
		});
	});

	it('rejects an invalid name', async () => {
		const a = await makeRestaurant();

		await expect(createTestRole(a.restaurantId, 'x'.repeat(61))).resolves.toEqual({
			ok: false,
			reason: 'invalid_name'
		});
	});

	it.each([['admin.settings'] as const, ['pos.sel'] as const, [[]] as const])(
		'rejects invalid permission keys',
		async (permissionKeys) => {
			const a = await makeRestaurant();

			await expect(
				createTestRole(a.restaurantId, 'Invalid', permissionKeys as readonly PosPermissionKey[])
			).resolves.toEqual({
				ok: false,
				reason: 'invalid_keys'
			});
		}
	);
});

describe('updateRole', () => {
	it('updates permission keys and writes the exact role.updated audit row', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen', ['pos.view_menu']);

		if (!created.ok) throw new Error('Role creation failed.');

		const result = await db.transaction((tx) =>
			updateRole(
				tx,
				a.restaurantId,
				created.id,
				{
					permissionKeys: ['pos.send_to_kitchen', 'pos.modify_order']
				},
				ctx(a.ownerId)
			)
		);

		expect(result).toEqual({ ok: true, changed: true });

		const role = await getRole(db, a.restaurantId, created.id);
		expect(role?.permissionKeys).toEqual(['pos.modify_order', 'pos.send_to_kitchen']);

		const rows = await auditRows('role.updated', a.restaurantId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.details).toEqual({
			changes: {
				permissionKeys: {
					old: ['pos.view_menu'],
					new: ['pos.send_to_kitchen', 'pos.modify_order']
				}
			}
		});
	});

	it('does not audit an identical update', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen', ['pos.view_menu']);

		if (!created.ok) throw new Error('Role creation failed.');

		const result = await db.transaction((tx) =>
			updateRole(
				tx,
				a.restaurantId,
				created.id,
				{ permissionKeys: ['pos.view_menu'] },
				ctx(a.ownerId)
			)
		);

		expect(result).toEqual({ ok: true, changed: false });
		expect(await auditRows('role.updated', a.restaurantId)).toHaveLength(0);
	});

	it('rolls back the role change and audit when the transaction fails afterward', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen', ['pos.view_menu']);

		if (!created.ok) throw new Error('Role creation failed.');

		await expect(
			db.transaction(async (tx) => {
				const result = await updateRole(
					tx,
					a.restaurantId,
					created.id,
					{ permissionKeys: ['pos.modify_order'] },
					ctx(a.ownerId)
				);

				expect(result).toEqual({ ok: true, changed: true });

				throw new Error('forced failure');
			})
		).rejects.toThrow('forced failure');

		const role = await getRole(db, a.restaurantId, created.id);
		expect(role?.permissionKeys).toEqual(['pos.view_menu']);
		expect(await auditRows('role.updated', a.restaurantId)).toHaveLength(0);
	});
});

describe('archiveRole', () => {
	it('refuses to archive a role held by active staff', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen');

		if (!created.ok) throw new Error('Role creation failed.');

		await db.insert(users).values({
			restaurantId: a.restaurantId,
			role: 'staff',
			roleId: created.id,
			displayName: 'Active Staff',
			pinHash: null,
			email: null,
			passwordHash: null,
			isActive: true
		});

		await expect(
			db.transaction((tx) => archiveRole(tx, a.restaurantId, created.id, ctx(a.ownerId)))
		).resolves.toEqual({
			ok: false,
			reason: 'in_use',
			activeStaffCount: 1
		});
	});

	it('allows archiving when only inactive staff hold the role', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen');

		if (!created.ok) throw new Error('Role creation failed.');

		await db.insert(users).values({
			restaurantId: a.restaurantId,
			role: 'staff',
			roleId: created.id,
			displayName: 'Inactive Staff',
			pinHash: null,
			email: null,
			passwordHash: null,
			isActive: false
		});

		await expect(
			db.transaction((tx) => archiveRole(tx, a.restaurantId, created.id, ctx(a.ownerId)))
		).resolves.toEqual({ ok: true });

		expect(await auditRows('role.archived', a.restaurantId)).toHaveLength(1);
	});

	it('returns already_archived on a second archive', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen');

		if (!created.ok) throw new Error('Role creation failed.');

		await db.transaction((tx) => archiveRole(tx, a.restaurantId, created.id, ctx(a.ownerId)));

		await expect(
			db.transaction((tx) => archiveRole(tx, a.restaurantId, created.id, ctx(a.ownerId)))
		).resolves.toEqual({
			ok: false,
			reason: 'already_archived'
		});
	});
});

describe('assertLiveRole', () => {
	it('returns the live role and null for archived, foreign, and unknown roles', async () => {
		const a = await makeRestaurant();
		const b = await makeRestaurant('foreign@roles.test');

		const created = await createTestRole(a.restaurantId, 'Kitchen');
		if (!created.ok) throw new Error('Role creation failed.');

		await expect(
			db.transaction((tx) => assertLiveRole(tx, a.restaurantId, created.id))
		).resolves.toEqual({
			id: created.id,
			name: 'Kitchen'
		});

		await db.transaction((tx) => archiveRole(tx, a.restaurantId, created.id, ctx(a.ownerId)));

		await expect(
			db.transaction((tx) => assertLiveRole(tx, a.restaurantId, created.id))
		).resolves.toBeNull();

		await expect(
			db.transaction((tx) => assertLiveRole(tx, b.restaurantId, created.id))
		).resolves.toBeNull();

		await expect(
			db.transaction((tx) =>
				assertLiveRole(tx, a.restaurantId, '00000000-0000-0000-0000-000000000000')
			)
		).resolves.toBeNull();
	});
});

describe('permissionsForUser', () => {
	it('returns all permissions for the owner', async () => {
		const a = await makeRestaurant();

		const result = await permissionsForUser(db, a.restaurantId, a.ownerId);

		expect([...result]).toEqual(ALL_KEYS);
	});

	it('returns exactly the role permissions for Cashier staff', async () => {
		const a = await makeRestaurant();

		await db.transaction((tx) =>
			seedRole(tx, a.restaurantId, {
				name: 'Cashier',
				permissionKeys: CASHIER_KEYS
			})
		);

		const staff = await db.transaction((tx) =>
			seedStaff(tx, a.restaurantId, {
				roleName: 'Cashier',
				displayName: 'Cashier'
			})
		);

		const result = await permissionsForUser(db, a.restaurantId, staff.id);

		expect(new Set(result)).toEqual(new Set(CASHIER_KEYS));
	});

	it('returns empty for inactive and unknown users and foreign tenant access', async () => {
		const a = await makeRestaurant();
		const b = await makeRestaurant('foreign@roles.test');

		await db.transaction((tx) =>
			seedRole(tx, a.restaurantId, {
				name: 'Cashier',
				permissionKeys: CASHIER_KEYS
			})
		);

		const staff = await db.transaction((tx) =>
			seedStaff(tx, a.restaurantId, {
				roleName: 'Cashier',
				displayName: 'Inactive'
			})
		);

		await db.update(users).set({ isActive: false }).where(eq(users.id, staff.id));

		expect(await permissionsForUser(db, a.restaurantId, staff.id)).toEqual(new Set());

		expect(
			await permissionsForUser(db, a.restaurantId, '00000000-0000-0000-0000-000000000000')
		).toEqual(new Set());

		expect(await permissionsForUser(db, b.restaurantId, staff.id)).toEqual(new Set());
	});
});

describe('role locking concurrency', () => {
	it('blocks assertLiveRole behind archive lock and then observes the archived role', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen');

		if (!created.ok) throw new Error('Role creation failed.');

		const clientA = await concurrencyPool.connect();
		const clientB = await concurrencyPool.connect();

		try {
			await clientA.query('BEGIN');
			await clientA.query('SELECT id FROM roles WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [
				created.id,
				a.restaurantId
			]);

			const dbB = drizzle(clientB);
			await clientB.query('BEGIN');

			const blocked = assertLiveRole(dbB as unknown as DbTx, a.restaurantId, created.id);

			const blockedState = await Promise.race([
				blocked.then(() => 'resolved' as const),
				new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100))
			]);

			expect(blockedState).toBe('pending');

			await clientA.query(
				'UPDATE roles SET archived_at = now(), updated_at = now() WHERE id = $1',
				[created.id]
			);
			await clientA.query('COMMIT');

			await expect(blocked).resolves.toBeNull();
			await clientB.query('COMMIT');
		} finally {
			await clientA.query('ROLLBACK').catch(() => undefined);
			await clientB.query('ROLLBACK').catch(() => undefined);
			clientA.release();
			clientB.release();
		}
	});

	it('keeps archive blocked while assertLiveRole holds FOR SHARE, then sees the new staff', async () => {
		const a = await makeRestaurant();
		const created = await createTestRole(a.restaurantId, 'Kitchen');

		if (!created.ok) throw new Error('Role creation failed.');

		const clientA = await concurrencyPool.connect();
		const clientB = await concurrencyPool.connect();

		try {
			await clientB.query('BEGIN');
			const dbB = drizzle(clientB);

			const liveRole = await assertLiveRole(dbB as unknown as DbTx, a.restaurantId, created.id);

			expect(liveRole).toEqual({
				id: created.id,
				name: 'Kitchen'
			});

			await clientA.query('BEGIN');
			const dbA = drizzle(clientA);

			const archivePromise = archiveRole(
				dbA as unknown as DbTx,
				a.restaurantId,
				created.id,
				ctx(a.ownerId)
			);

			await new Promise((resolve) => setTimeout(resolve, 100));

			await clientB.query(
				`INSERT INTO users
                    (restaurant_id, role, role_id, display_name, email, password_hash, pin_hash, is_active)
                 VALUES ($1, 'staff', $2, 'Concurrent Staff', NULL, NULL, NULL, true)`,
				[a.restaurantId, created.id]
			);

			await clientB.query('COMMIT');

			await expect(archivePromise).resolves.toEqual({
				ok: false,
				reason: 'in_use',
				activeStaffCount: 1
			});

			await clientA.query('ROLLBACK');
		} finally {
			await clientA.query('ROLLBACK').catch(() => undefined);
			await clientB.query('ROLLBACK').catch(() => undefined);
			clientA.release();
			clientB.release();
		}
	});
});
