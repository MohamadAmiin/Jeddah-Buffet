import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent, ServerLoadEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { roles } from '$lib/server/db/schema/roles';
import { auditLog } from '$lib/server/db/schema/audit';
import { seedStaff } from '$lib/server/db/test/seed';
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
		displayName: role === 'owner' ? 'The Owner' : 'Staff',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function makeEvent(
	user: Principal,
	employeeId: string,
	form?: Record<string, string>
): RequestEvent {
	const url = new URL(`http://localhost/employees/${employeeId}`);
	const body = form ? new FormData() : undefined;

	for (const [key, value] of Object.entries(form ?? {})) {
		body!.set(key, value);
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
		params: { id: employeeId },
		request: new Request(url, {
			method: 'POST',
			body: body ?? new URLSearchParams()
		}),
		route: { id: '/(dashboard)/employees/[id]' },
		url
	} as unknown as RequestEvent;
}

function loadEvent(user: Principal, employeeId: string): ServerLoadEvent {
	return {
		...makeEvent(user, employeeId),
		parent: async () => ({}),
		depends: () => {},
		untrack: <T>(fn: () => T) => fn()
	} as unknown as ServerLoadEvent;
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return (error as { status?: number }).status;
	}
}

function action(name: keyof typeof actions, event: RequestEvent) {
	const handler = actions[name];
	if (!handler) {
		throw new Error(`Missing action: ${name}`);
	}

	return handler(event as Parameters<typeof handler>[0]);
}

describe('/employees/[id] route guard', () => {
	it('requires admin.employees for load and every action', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier'
		});

		const cashier = principal(staff.id, restaurantId, 'staff');

		expect(await statusOf(() => load(loadEvent(cashier, staff.id)))).toBe(403);
		expect(
			await statusOf(() =>
				action(
					'update',
					makeEvent(cashier, staff.id, {
						displayName: 'Changed',
						roleId: staff.roleId
					})
				)
			)
		).toBe(403);
		expect(
			await statusOf(() =>
				action(
					'setPin',
					makeEvent(cashier, staff.id, {
						pin: '1234'
					})
				)
			)
		).toBe(403);
		expect(await statusOf(() => action('clearLockout', makeEvent(cashier, staff.id)))).toBe(403);
		expect(await statusOf(() => action('deactivate', makeEvent(cashier, staff.id)))).toBe(403);
		expect(
			await statusOf(() =>
				action(
					'reactivate',
					makeEvent(cashier, staff.id, {
						roleId: staff.roleId
					})
				)
			)
		).toBe(403);

		expect(ownerId).toBeTruthy();
	});
});

describe('/employees/[id] load', () => {
	it('returns 404 for an employee from another restaurant', async () => {
		const restaurantA = await makeRestaurant('Cafe A');
		const ownerA = await makeOwner(restaurantA);

		const restaurantB = await makeRestaurant('Cafe B');
		const staffB = await seedStaff(db, restaurantB, {
			displayName: 'Other Restaurant'
		});

		const result = await statusOf(() =>
			load(loadEvent(principal(ownerA, restaurantA, 'owner'), staffB.id))
		);

		expect(result).toBe(404);
	});

	it('loads the owner as kind owner', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);

		const result = (await load(loadEvent(principal(ownerId, restaurantId, 'owner'), ownerId))) as {
			employee: { kind: string; roleId: string | null; roleName: string | null };
		};

		expect(result.employee.kind).toBe('owner');
		expect(result.employee.roleId).toBeNull();
		expect(result.employee.roleName).toBe('Owner');
	});

	it('does not expose credential or hash fields', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Safe Employee',
			pinHash: 'not-a-real-pin-hash'
		});

		const result = await load(loadEvent(principal(ownerId, restaurantId, 'owner'), staff.id));

		expect(JSON.stringify(result)).not.toMatch(/hash|phc|email|password/i);
	});
});

describe('/employees/[id] actions', () => {
	it('updates a staff member', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Old Name'
		});

		const result = await action(
			'update',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id, {
				displayName: 'New Name',
				roleId: staff.roleId
			})
		);

		expect(result).toEqual({ message: 'Saved.' });

		const [row] = await db
			.select({ displayName: users.displayName })
			.from(users)
			.where(eq(users.id, staff.id));

		expect(row.displayName).toBe('New Name');
	});

	it('returns Nothing to save when update changes nothing', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Same Name'
		});

		const result = await action(
			'update',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id, {
				displayName: 'Same Name',
				roleId: staff.roleId
			})
		);

		expect(result).toEqual({ message: 'Nothing to save.' });
	});

	it('sets a PIN', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier'
		});

		const result = await action(
			'setPin',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id, {
				pin: '1234'
			})
		);

		expect(result).toEqual({ message: 'PIN set.' });

		const [row] = await db
			.select({
				pinHash: users.pinHash,
				failedPinCount: users.failedPinCount,
				pinLockedUntil: users.pinLockedUntil
			})
			.from(users)
			.where(eq(users.id, staff.id));

		expect(row.pinHash).toBeTruthy();
		expect(row.failedPinCount).toBe(0);
		expect(row.pinLockedUntil).toBeNull();
	});

	it('clears a PIN lockout', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Locked Staff'
		});

		const lockedUntil = new Date(Date.now() + 10 * 60_000);

		await db
			.update(users)
			.set({
				failedPinCount: 5,
				pinLockedUntil: lockedUntil
			})
			.where(eq(users.id, staff.id));

		const result = await action(
			'clearLockout',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id)
		);

		expect(result).toEqual({ message: 'Lockout cleared.' });

		const [row] = await db
			.select({
				failedPinCount: users.failedPinCount,
				pinLockedUntil: users.pinLockedUntil
			})
			.from(users)
			.where(eq(users.id, staff.id));

		expect(row.failedPinCount).toBe(0);
		expect(row.pinLockedUntil).toBeNull();
	});

	it('deactivates a staff member', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier'
		});

		const result = await action(
			'deactivate',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id)
		);

		expect(result).toEqual({
			message: 'Cashier was deactivated. The till drops them the next time it loads the staff list.'
		});

		const [row] = await db
			.select({ isActive: users.isActive })
			.from(users)
			.where(eq(users.id, staff.id));

		expect(row.isActive).toBe(false);
	});

	it('reactivates a staff member with its live role', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier',
			isActive: false
		});

		const result = await action(
			'reactivate',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id)
		);

		expect(result).toEqual({
			message: 'Cashier was reactivated.'
		});

		const [row] = await db
			.select({ isActive: users.isActive })
			.from(users)
			.where(eq(users.id, staff.id));

		expect(row.isActive).toBe(true);
	});

	it('rejects owner update, deactivate, and reactivate', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);

		const update = await action(
			'update',
			makeEvent(principal(ownerId, restaurantId, 'owner'), ownerId, {
				displayName: 'Changed Owner',
				roleId: '00000000-0000-0000-0000-000000000000'
			})
		);
		expect(update).toMatchObject({
			status: 400,
			data: { message: 'The owner is not edited here.' }
		});

		const deactivate = await action(
			'deactivate',
			makeEvent(principal(ownerId, restaurantId, 'owner'), ownerId)
		);
		expect(deactivate).toMatchObject({
			status: 400,
			data: { message: 'The owner is not edited here.' }
		});

		const reactivate = await action(
			'reactivate',
			makeEvent(principal(ownerId, restaurantId, 'owner'), ownerId)
		);
		expect(reactivate).toMatchObject({
			status: 400,
			data: { message: 'The owner is not edited here.' }
		});
	});

	it('allows the owner to set a PIN and clear a lockout', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);

		const pin = await action(
			'setPin',
			makeEvent(principal(ownerId, restaurantId, 'owner'), ownerId, {
				pin: '1234'
			})
		);
		expect(pin).toEqual({ message: 'PIN set.' });

		await db
			.update(users)
			.set({
				failedPinCount: 5,
				pinLockedUntil: new Date(Date.now() + 10 * 60_000)
			})
			.where(eq(users.id, ownerId));

		const clear = await action(
			'clearLockout',
			makeEvent(principal(ownerId, restaurantId, 'owner'), ownerId)
		);
		expect(clear).toEqual({ message: 'Lockout cleared.' });
	});

	it('refuses reactivation when the current role is archived, then accepts a live role', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier',
			isActive: false
		});

		await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, staff.roleId));

		const archived = await action(
			'reactivate',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id)
		);

		expect(archived).toMatchObject({
			status: 400,
			data: { message: 'Choose a role first: Cashier is archived.' }
		});

		const [liveRole] = await db
			.select({ id: roles.id })
			.from(roles)
			.where(eq(roles.name, 'Waiter'))
			.limit(1);

		const reactivated = await action(
			'reactivate',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id, {
				roleId: liveRole.id
			})
		);

		expect(reactivated).toEqual({ message: 'Cashier was reactivated.' });
	});

	it('returns the expected clear-lockout error when there is nothing to clear', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier'
		});

		const result = await action(
			'clearLockout',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id)
		);

		expect(result).toMatchObject({
			status: 400,
			data: { message: 'There is no lockout to clear.' }
		});
	});
});

describe('/employees/[id] audit behavior', () => {
	it('writes employee changes without credential fields in audit details', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const staff = await seedStaff(db, restaurantId, {
			displayName: 'Cashier'
		});

		await action(
			'update',
			makeEvent(principal(ownerId, restaurantId, 'owner'), staff.id, {
				displayName: 'Updated Cashier',
				roleId: staff.roleId
			})
		);

		const [row] = await db
			.select({ details: auditLog.details })
			.from(auditLog)
			.orderBy(auditLog.occurredAt)
			.limit(1);

		expect(JSON.stringify(row.details)).not.toMatch(
			/pass|pin|token|hash|secret|cookie|authorization/i
		);
	});
});
