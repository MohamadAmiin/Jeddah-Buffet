import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RequestEvent, ServerLoadEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { roles, rolePermissions } from '$lib/server/db/schema/roles';
import { auditLog } from '$lib/server/db/schema/audit';
import { seedStaff, seedRole } from '$lib/server/db/test/seed';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name = 'Cafe One'): Promise<string> {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();

	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: name,
			timeZone: 'Africa/Mogadishu'
		})
	);

	return restaurant.id;
}

async function makeOwner(restaurantId: string): Promise<string> {
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId,
			role: 'owner',
			displayName: 'The Owner',
			email: 'owner@cafe.com',
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });

	return owner.id;
}

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Cashier',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function makeEvent(user: Principal, formEntries: Array<[string, string]> = []): RequestEvent {
	const url = new URL('http://localhost/employees/roles');
	const body = new FormData();

	for (const [key, value] of formEntries) {
		body.append(key, value);
	}

	return {
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {}
		},
		getClientAddress: () => '203.0.113.5',
		locals: {
			user,
			restaurantId: user.restaurantId,
			sessionToken: null,
			posDevice: null
		},
		params: {},
		request: new Request(url, {
			method: 'POST',
			body
		}),
		route: { id: '/(dashboard)/employees/roles' },
		url
	} as unknown as RequestEvent;
}

function loadEvent(user: Principal): ServerLoadEvent {
	return {
		...makeEvent(user),
		parent: async () => ({}),
		depends: () => {},
		untrack: <T>(fn: () => T) => fn()
	} as unknown as ServerLoadEvent;
}

function action(name: keyof typeof actions, event: RequestEvent) {
	const handler = actions[name];

	if (!handler) {
		throw new Error(`Missing action: ${name}`);
	}

	return handler(event as Parameters<typeof handler>[0]);
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return (error as { status?: number }).status;
	}
}

function messageOf(result: unknown): string | undefined {
	return (result as { data?: { message?: string } }).data?.message;
}

async function expectDatabaseError(
	sql: string,
	params: unknown[] = []
): Promise<{ code?: string; constraint?: string }> {
	const client = await db.$client.connect();

	try {
		await client.query(sql, params);
		throw new Error(`Expected database statement to fail:\n${sql}`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('Expected database statement')) {
			throw error;
		}

		const databaseError = error as { code?: string; constraint?: string };
		return databaseError;
	} finally {
		client.release();
	}
}

describe('employees roles page', () => {
	it('returns 403 for a cashier on load and all three actions', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier'
		});

		const cashier = principal(staff.id, restaurantId, 'staff');

		expect(await statusOf(() => load(loadEvent(cashier)))).toBe(403);

		expect(
			await statusOf(() =>
				action(
					'create',
					makeEvent(cashier, [
						['name', 'Runner'],
						['permissionKeys', 'pos.create_order']
					])
				)
			)
		).toBe(403);

		expect(
			await statusOf(() =>
				action(
					'update',
					makeEvent(cashier, [
						['roleId', staff.roleId],
						['name', 'Runner'],
						['permissionKeys', 'pos.create_order']
					])
				)
			)
		).toBe(403);

		expect(
			await statusOf(() => action('archive', makeEvent(cashier, [['roleId', staff.roleId]])))
		).toBe(403);

		expect(ownerId).toBeDefined();
	});

	it('rejects admin.settings with 400 before writing a role', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'Admin Attempt'],
				['permissionKeys', 'admin.settings']
			])
		);

		expect((result as { status: number }).status).toBe(400);
		expect(messageOf(result)).toBe('Pick at least one permission.');

		const [role] = await db
			.select({ id: roles.id })
			.from(roles)
			.where(eq(roles.name, 'Admin Attempt'))
			.limit(1);

		expect(role).toBeUndefined();
	});

	it('rejects admin.settings directly in the database', async () => {
		const restaurantId = await makeRestaurant();
		const role = await seedRole(db, restaurantId, {
			name: 'Cashier Copy',
			permissionKeys: ['pos.sell']
		});

		const error = await expectDatabaseError(
			`insert into role_permissions (restaurant_id, role_id, permission_key)
             values ($1, $2, 'admin.settings')`,
			[restaurantId, role.id]
		);

		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('role_permissions_key_pos_only');
	});

	it('rejects the reserved Owner role name', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'Owner'],
				['permissionKeys', 'pos.sell']
			])
		);

		expect((result as { status: number }).status).toBe(400);
		expect(messageOf(result)).toBe('Owner is reserved for the owner.');
	});

	it('rejects a duplicate live role name', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		await seedRole(db, restaurantId, {
			name: 'Runner',
			permissionKeys: ['pos.create_order']
		});

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'runner'],
				['permissionKeys', 'pos.view_menu']
			])
		);

		expect((result as { status: number }).status).toBe(400);
		expect(messageOf(result)).toBe('A role with that name already exists.');
	});

	it('creates a role with its permission keys and returns the success alert message', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'Runner'],
				['permissionKeys', 'pos.create_order'],
				['permissionKeys', 'pos.send_to_kitchen']
			])
		);

		expect(result).toEqual({ message: 'Role created.' });

		const [role] = await db
			.select({ id: roles.id, name: roles.name })
			.from(roles)
			.where(eq(roles.name, 'Runner'))
			.limit(1);

		expect(role?.name).toBe('Runner');

		const permissions = await db
			.select({ permissionKey: rolePermissions.permissionKey })
			.from(rolePermissions)
			.where(eq(rolePermissions.roleId, role!.id));

		expect(permissions.map((row) => row.permissionKey).sort()).toEqual([
			'pos.create_order',
			'pos.send_to_kitchen'
		]);
	});

	it('updates role keys and writes exactly one role.updated audit row', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const role = await seedRole(db, restaurantId, {
			name: 'Runner',
			permissionKeys: ['pos.create_order']
		});

		const before = await db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(eq(auditLog.event, 'role.updated'));

		const result = await action(
			'update',
			makeEvent(owner, [
				['roleId', role.id],
				['name', 'Runner'],
				['permissionKeys', 'pos.send_to_kitchen'],
				['permissionKeys', 'pos.transfer_table']
			])
		);

		expect(result).toEqual({ message: 'Role saved.' });

		const permissions = await db
			.select({ permissionKey: rolePermissions.permissionKey })
			.from(rolePermissions)
			.where(eq(rolePermissions.roleId, role.id));

		expect(permissions.map((row) => row.permissionKey).sort()).toEqual([
			'pos.send_to_kitchen',
			'pos.transfer_table'
		]);

		const after = await db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(eq(auditLog.event, 'role.updated'));

		expect(after).toHaveLength(before.length + 1);
	});

	it('blocks archiving a role held by active staff', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const role = await seedRole(db, restaurantId, {
			name: 'Runner',
			permissionKeys: ['pos.create_order']
		});

		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Runner',
			roleId: role.id
		});

		const result = await action('archive', makeEvent(owner, [['roleId', role.id]]));

		expect((result as { status: number }).status).toBe(400);
		expect(messageOf(result)).toBe(
			'1 active staff hold this role. Move them to another role first.'
		);

		const [unchanged] = await db
			.select({ archivedAt: roles.archivedAt })
			.from(roles)
			.where(eq(roles.id, role.id));

		expect(unchanged?.archivedAt).toBeNull();
		expect(staff.roleId).toBe(role.id);
	});

	it('archives a role after its holder is deactivated and frees the name', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const role = await seedRole(db, restaurantId, {
			name: 'Runner',
			permissionKeys: ['pos.create_order']
		});

		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Runner',
			roleId: role.id
		});

		await db.update(users).set({ isActive: false }).where(eq(users.id, staff.id));

		const result = await action('archive', makeEvent(owner, [['roleId', role.id]]));

		expect(result).toEqual({ message: 'Role archived.' });

		const [archived] = await db
			.select({ archivedAt: roles.archivedAt })
			.from(roles)
			.where(eq(roles.id, role.id));

		expect(archived?.archivedAt).not.toBeNull();

		const replacement = await seedRole(db, restaurantId, {
			name: 'Runner',
			permissionKeys: ['pos.view_menu']
		});

		expect(replacement.id).not.toBe(role.id);
	});
});
