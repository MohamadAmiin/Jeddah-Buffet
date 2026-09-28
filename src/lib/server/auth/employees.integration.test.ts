import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { roles } from '../db/schema/roles';
import { users } from '../db/schema/users';
import { seedRole, seedStaff } from '../db/test/seed';
import { CASHIER_KEYS, WAITER_KEYS } from '../permissions/keys';
import { auditLog } from '../db/schema/audit';
import type { Principal } from './session';
import { verifyPin } from '../../pin';
import {
	clearPinLockout,
	createEmployee,
	deactivateEmployee,
	employeeSetupStatus,
	getEmployee,
	listEmployees,
	reactivateEmployee,
	setEmployeePin,
	updateEmployee
} from './employees';
import { listPosEmployees } from './employee-directory';
import { MAX_FAILED_PIN_ATTEMPTS, verifyEmployeePin } from './pin';
import { registerDevice } from './pos-device';
import { load, actions } from '../../../routes/(dashboard)/employees/+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const ctx = (actorUserId: string) => ({ actorUserId, ip: null, userAgent: null });

async function makeRestaurant(email = 'owner@cafe.com') {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();

	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
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

async function roleId(restaurantId: string, name: string): Promise<string> {
	const [role] = await db
		.select({ id: roles.id })
		.from(roles)
		.where(
			and(eq(roles.restaurantId, restaurantId), eq(roles.name, name), isNull(roles.archivedAt))
		)
		.limit(1);

	if (!role) {
		throw new Error(`Missing live role ${name}.`);
	}

	return role.id;
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

/** A dashboard request: the principal and tenant the hook would have set, and an optional form body. */
function makeEvent(user: Principal, form?: Record<string, string>): RequestEvent {
	const url = new URL('http://localhost/employees');
	const body = form ? new FormData() : undefined;

	for (const [key, value] of Object.entries(form ?? {})) {
		body!.set(key, value);
	}

	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/employees' },
		url
	} as unknown as RequestEvent;
}

/** The status a load or action threw, or undefined when it returned. */
async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

function act(name: 'createEmployee', event: RequestEvent) {
	return actions[name]!(event as Parameters<NonNullable<(typeof actions)[typeof name]>>[0]);
}

async function byName(restaurantId: string, displayName: string) {
	return db
		.select()
		.from(users)
		.where(and(eq(users.restaurantId, restaurantId), eq(users.displayName, displayName)));
}

async function auditRows(event: string) {
	return db.select().from(auditLog).where(eq(auditLog.event, event));
}

describe('the /employees page', () => {
	it.each(['cashier', 'waiter'] as const)(
		'refuses a %s with 403 on the load and create action',
		async (role) => {
			const a = await makeRestaurant();
			const staff = await seedStaff(db, a.restaurantId, {
				roleName: role === 'cashier' ? 'Cashier' : 'Waiter',
				displayName: 'Staff'
			});
			const asStaff = principal(staff.id, a.restaurantId, 'staff');
			const selectedRoleId = await roleId(
				a.restaurantId,
				role === 'cashier' ? 'Cashier' : 'Waiter'
			);

			expect(await statusOf(() => load(makeEvent(asStaff) as never))).toBe(403);

			expect(
				await statusOf(() =>
					act(
						'createEmployee',
						makeEvent(asStaff, {
							roleId: selectedRoleId,
							displayName: 'Sam',
							pin: '1234'
						})
					)
				)
			).toBe(403);

			expect(await byName(a.restaurantId, 'Sam')).toHaveLength(0);
			expect(await db.select().from(auditLog)).toHaveLength(0);
		}
	);

	it('returns the exact safe load shape for the owner', async () => {
		const a = await makeRestaurant();

		await db.insert(restaurantSettings).values({
			restaurantId: a.restaurantId,
			timeZone: 'Africa/Mogadishu'
		});

		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

		await act(
			'createEmployee',
			makeEvent(asOwner, {
				roleId: await roleId(a.restaurantId, 'Cashier'),
				displayName: 'Sam',
				pin: '1234'
			})
		);

		const result = (await load(makeEvent(asOwner) as never)) as {
			employees: Array<{
				id: string;
				kind: string;
				displayName: string;
				roleName: string | null;
				roleArchived: boolean;
				hasPin: boolean;
				isActive: boolean;
				lockedUntil: Date | null;
				failedPinCount: number;
			}>;
			roles: Array<{ id: string; name: string }>;
			timeZone: string;
		};

		expect(Object.keys(result).sort()).toEqual(['employees', 'roles', 'timeZone']);

		expect(result.roles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'Cashier' }),
				expect.objectContaining({ name: 'Waiter' })
			])
		);

		expect(result.timeZone).toBeDefined();

		const employee = result.employees.find((row) => row.displayName === 'Sam');

		expect(employee).toBeDefined();
		expect(Object.keys(employee!).sort()).toEqual([
			'displayName',
			'failedPinCount',
			'hasPin',
			'id',
			'isActive',
			'kind',
			'lockedUntil',
			'roleArchived',
			'roleName'
		]);
		expect(employee).toMatchObject({
			displayName: 'Sam',
			roleName: 'Cashier',
			roleArchived: false,
			hasPin: true,
			isActive: true,
			lockedUntil: null,
			failedPinCount: 0
		});

		const serialised = JSON.stringify(result);
		expect(serialised).not.toContain('pinHash');
		expect(serialised).not.toContain('passwordHash');
		expect(serialised).not.toContain('pin_hash');
		expect(serialised).not.toContain('password_hash');
	});

	it('rejects creation with an archived role with 400 and the exact message', async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, cashierId));

		const result = await act(
			'createEmployee',
			makeEvent(asOwner, {
				roleId: cashierId,
				displayName: 'Sam',
				pin: '1234'
			})
		);

		expect((result as { status?: number }).status).toBe(400);
		expect((result as { data?: { message?: string } }).data?.message).toBe('Choose a role.');
		expect(await byName(a.restaurantId, 'Sam')).toHaveLength(0);
		expect(await auditRows('employee.created')).toHaveLength(0);
	});

	it.each(['123', '1234567', '12a4', ''])(
		'refuses a PIN of %j with 400 and creates no one',
		async (pin) => {
			const a = await makeRestaurant();
			const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
			const cashierId = await roleId(a.restaurantId, 'Cashier');

			const result = await act(
				'createEmployee',
				makeEvent(asOwner, {
					roleId: cashierId,
					displayName: 'Sam',
					pin
				})
			);

			expect((result as { status?: number }).status).toBe(400);
			expect(await byName(a.restaurantId, 'Sam')).toHaveLength(0);
			expect(await auditRows('employee.created')).toHaveLength(0);
		}
	);

	it.each(['1234', '123456'])(
		'accepts a PIN of %j, and the stored hash verifies it',
		async (pin) => {
			const a = await makeRestaurant();
			const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
			const waiterId = await roleId(a.restaurantId, 'Waiter');

			const result = await act(
				'createEmployee',
				makeEvent(asOwner, {
					roleId: waiterId,
					displayName: 'Sam',
					pin
				})
			);

			expect(result).toEqual({ message: 'Sam was added.' });

			const [sam] = await byName(a.restaurantId, 'Sam');
			expect(await verifyPin(pin, sam.pinHash!)).toBe(true);
		}
	);
});
describe('createEmployee', () => {
	it('rejects an archived role and writes no employee or audit row', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, cashierId));

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '4321' },
				ctx(a.ownerId)
			)
		);

		expect(result).toEqual({ ok: false, reason: 'role_not_live' });
		expect(await byName(a.restaurantId, 'Sam')).toHaveLength(0);
		expect(await auditRows('employee.created')).toHaveLength(0);
	});

	it('creates staff with the selected live role and exactly one audit row', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '4321' },
				ctx(a.ownerId)
			)
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const [sam] = await byName(a.restaurantId, 'Sam');

		expect(sam.role).toBe('staff');
		expect(sam.roleId).toBe(cashierId);
		expect(sam.email).toBeNull();
		expect(sam.passwordHash).toBeNull();
		expect(await verifyPin('4321', sam.pinHash!)).toBe(true);

		const rows = await auditRows('employee.created');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			roleName: 'Cashier',
			displayName: 'Sam'
		});
		expect(rows[0].subjectUserId).toBe(result.id);
		expect(rows[0].actorUserId).toBe(a.ownerId);
	});

	it('rolls back the employee and audit row together', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		await expect(
			db.transaction(async (tx) => {
				await createEmployee(
					tx,
					a.restaurantId,
					{ roleId: cashierId, displayName: 'Robin', pin: '4321' },
					ctx(a.ownerId)
				);
				throw new Error('forced failure');
			})
		).rejects.toThrow('forced failure');

		expect(await byName(a.restaurantId, 'Robin')).toHaveLength(0);
		expect(await auditRows('employee.created')).toHaveLength(0);
	});
});

describe('setEmployeePin', () => {
	it('replaces the PIN, resets the lockout pair and audits the role name', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1111' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db
			.update(users)
			.set({
				failedPinCount: 5,
				pinLockedUntil: new Date(Date.now() + 300_000)
			})
			.where(eq(users.id, result.id));

		const pinResult = await db.transaction((tx) =>
			setEmployeePin(tx, a.restaurantId, result.id, '2222', ctx(a.ownerId))
		);

		expect(pinResult).toEqual({ ok: true });

		const [sam] = await db.select().from(users).where(eq(users.id, result.id));
		expect(await verifyPin('2222', sam.pinHash!)).toBe(true);
		expect(await verifyPin('1111', sam.pinHash!)).toBe(false);
		expect(sam.failedPinCount).toBe(0);
		expect(sam.pinLockedUntil).toBeNull();

		const rows = await auditRows('employee.pin_set');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({ roleName: 'Cashier' });
		expect(rows[0].subjectUserId).toBe(result.id);
	});

	it("uses 'Owner' as the owner's role label", async () => {
		const a = await makeRestaurant();

		const result = await db.transaction((tx) =>
			setEmployeePin(tx, a.restaurantId, a.ownerId, '2468', ctx(a.ownerId))
		);

		expect(result).toEqual({ ok: true });

		const rows = await auditRows('employee.pin_set');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({ roleName: 'Owner' });
	});

	it("refuses another restaurant's employee and touches nothing", async () => {
		const a = await makeRestaurant('a@cafe.com');
		const b = await makeRestaurant('b@cafe.com');
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1111' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const [before] = await db.select().from(users).where(eq(users.id, result.id));

		const pinResult = await db.transaction((tx) =>
			setEmployeePin(tx, b.restaurantId, result.id, '9999', ctx(b.ownerId))
		);

		expect(pinResult).toEqual({ ok: false, reason: 'not_found' });

		const [after] = await db.select().from(users).where(eq(users.id, result.id));
		expect(after.pinHash).toBe(before.pinHash);
		expect(await auditRows('employee.pin_set')).toHaveLength(0);
	});
});

describe('listEmployees and getEmployee', () => {
	it('orders owner, active staff by name, then inactive staff by name', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');
		const waiterId = await roleId(a.restaurantId, 'Waiter');

		const activeZed = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: waiterId, displayName: 'Zed', pin: '1234' },
				ctx(a.ownerId)
			)
		);
		const activeSam = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);
		const inactiveAmy = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Amy', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!activeZed.ok || !activeSam.ok || !inactiveAmy.ok) {
			throw new Error('Expected employee creation to succeed.');
		}

		await db.update(users).set({ isActive: false }).where(eq(users.id, inactiveAmy.id));

		const rows = await listEmployees(db, a.restaurantId);

		expect(rows.map((r) => [r.kind, r.displayName, r.roleName, r.hasPin])).toEqual([
			['owner', 'The Owner', 'Owner', false],
			['staff', 'Sam', 'Cashier', true],
			['staff', 'Zed', 'Waiter', true],
			['staff', 'Amy', 'Cashier', true]
		]);

		expect(rows[3].roleArchived).toBe(false);

		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual([
				'displayName',
				'failedPinCount',
				'hasPin',
				'id',
				'isActive',
				'kind',
				'lockedUntil',
				'roleArchived',
				'roleId',
				'roleName'
			]);
		}
	});

	it('reports an archived role without exposing the PIN hash', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, cashierId));

		const row = await getEmployee(db, a.restaurantId, result.id);

		expect(row).not.toBeNull();
		expect(row?.roleName).toBe('Cashier');
		expect(row?.roleArchived).toBe(true);
		expect(row).not.toHaveProperty('pinHash');

		const serialised = JSON.stringify(row);
		expect(serialised).not.toMatch(/hash|phc/i);
	});
});

describe('updateEmployee', () => {
	it('renames and re-roles an employee and writes one audit with old/new values', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');
		const waiterId = await roleId(a.restaurantId, 'Waiter');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const updated = await db.transaction((tx) =>
			updateEmployee(
				tx,
				a.restaurantId,
				result.id,
				{ displayName: 'Samuel', roleId: waiterId },
				ctx(a.ownerId)
			)
		);

		expect(updated).toEqual({ ok: true, changed: true });

		const [row] = await db.select().from(users).where(eq(users.id, result.id));
		expect(row.displayName).toBe('Samuel');
		expect(row.roleId).toBe(waiterId);

		const rows = await auditRows('employee.updated');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			changes: {
				displayName: { old: 'Sam', new: 'Samuel' },
				role: { old: 'Cashier', new: 'Waiter' }
			}
		});
	});

	it('does not audit a no-op update', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const updated = await db.transaction((tx) =>
			updateEmployee(
				tx,
				a.restaurantId,
				result.id,
				{ displayName: 'Sam', roleId: cashierId },
				ctx(a.ownerId)
			)
		);

		expect(updated).toEqual({ ok: true, changed: false });
		expect(await auditRows('employee.updated')).toHaveLength(0);
	});

	it('refuses to update the owner and changes nothing', async () => {
		const a = await makeRestaurant();
		const waiterId = await roleId(a.restaurantId, 'Waiter');

		const result = await db.transaction((tx) =>
			updateEmployee(
				tx,
				a.restaurantId,
				a.ownerId,
				{ displayName: 'Changed', roleId: waiterId },
				ctx(a.ownerId)
			)
		);

		expect(result).toEqual({ ok: false, reason: 'owner' });

		const [owner] = await db.select().from(users).where(eq(users.id, a.ownerId));
		expect(owner.displayName).toBe('The Owner');
		expect(owner.roleId).toBeNull();
		expect(await auditRows('employee.updated')).toHaveLength(0);
	});

	it('refuses a foreign employee as not_found', async () => {
		const a = await makeRestaurant('a@cafe.com');
		const b = await makeRestaurant('b@cafe.com');
		const cashierId = await roleId(a.restaurantId, 'Cashier');
		const waiterId = await roleId(b.restaurantId, 'Waiter');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const updated = await db.transaction((tx) =>
			updateEmployee(
				tx,
				b.restaurantId,
				result.id,
				{ displayName: 'Changed', roleId: waiterId },
				ctx(b.ownerId)
			)
		);

		expect(updated).toEqual({ ok: false, reason: 'not_found' });
		expect(await auditRows('employee.updated')).toHaveLength(0);
	});

	it('refuses an archived target role', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');
		const waiterId = await roleId(a.restaurantId, 'Waiter');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, waiterId));

		const updated = await db.transaction((tx) =>
			updateEmployee(
				tx,
				a.restaurantId,
				result.id,
				{ displayName: 'Changed', roleId: waiterId },
				ctx(a.ownerId)
			)
		);

		expect(updated).toEqual({ ok: false, reason: 'role_not_live' });

		const [row] = await db.select().from(users).where(eq(users.id, result.id));
		expect(row.displayName).toBe('Sam');
		expect(row.roleId).toBe(cashierId);
		expect(await auditRows('employee.updated')).toHaveLength(0);
	});
});

describe('deactivateEmployee', () => {
	it('deactivates an employee, audits it, and removes them from the POS directory', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const before = await listPosEmployees(db, a.restaurantId);
		expect(before.some((employee) => employee.id === result.id)).toBe(true);

		const deactivated = await db.transaction((tx) =>
			deactivateEmployee(tx, a.restaurantId, result.id, ctx(a.ownerId))
		);

		expect(deactivated).toEqual({ ok: true, displayName: 'Sam' });

		const [employee] = await db.select().from(users).where(eq(users.id, result.id));
		expect(employee.isActive).toBe(false);

		const after = await listPosEmployees(db, a.restaurantId);
		expect(after.some((employee) => employee.id === result.id)).toBe(false);

		const rows = await auditRows('employee.deactivated');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			roleName: 'Cashier',
			displayName: 'Sam'
		});
		expect(rows[0].subjectUserId).toBe(result.id);
		expect(rows[0].actorUserId).toBe(a.ownerId);
	});

	it('returns already_inactive when deactivating an inactive employee again', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db.transaction((tx) => deactivateEmployee(tx, a.restaurantId, result.id, ctx(a.ownerId)));

		const second = await db.transaction((tx) =>
			deactivateEmployee(tx, a.restaurantId, result.id, ctx(a.ownerId))
		);

		expect(second).toEqual({ ok: false, reason: 'already_inactive' });
		expect(await auditRows('employee.deactivated')).toHaveLength(1);
	});

	it('refuses to deactivate the owner', async () => {
		const a = await makeRestaurant();

		const result = await db.transaction((tx) =>
			deactivateEmployee(tx, a.restaurantId, a.ownerId, ctx(a.ownerId))
		);

		expect(result).toEqual({ ok: false, reason: 'owner' });

		const [owner] = await db.select().from(users).where(eq(users.id, a.ownerId));
		expect(owner.isActive).toBe(true);
		expect(await auditRows('employee.deactivated')).toHaveLength(0);
	});
});

describe('reactivateEmployee', () => {
	it('refuses reactivation when the employee still holds an archived role', async () => {
		const a = await makeRestaurant();
		const waiterId = await roleId(a.restaurantId, 'Waiter');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: waiterId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db.transaction((tx) => deactivateEmployee(tx, a.restaurantId, result.id, ctx(a.ownerId)));

		await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, waiterId));

		const reactivated = await db.transaction((tx) =>
			reactivateEmployee(tx, a.restaurantId, result.id, {}, ctx(a.ownerId))
		);

		expect(reactivated).toEqual({ ok: false, reason: 'role_not_live' });

		const [employee] = await db.select().from(users).where(eq(users.id, result.id));
		expect(employee.isActive).toBe(false);
		expect(employee.roleId).toBe(waiterId);
		expect(await auditRows('employee.reactivated')).toHaveLength(0);
		expect(await auditRows('employee.updated')).toHaveLength(0);
	});

	it('reactivates with a new live role and writes one reactivated plus one role-change audit', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');
		const waiterId = await roleId(a.restaurantId, 'Waiter');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: waiterId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db.transaction((tx) => deactivateEmployee(tx, a.restaurantId, result.id, ctx(a.ownerId)));

		await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, waiterId));

		const reactivated = await db.transaction((tx) =>
			reactivateEmployee(tx, a.restaurantId, result.id, { roleId: cashierId }, ctx(a.ownerId))
		);

		expect(reactivated).toEqual({ ok: true, displayName: 'Sam' });

		const [employee] = await db.select().from(users).where(eq(users.id, result.id));
		expect(employee.isActive).toBe(true);
		expect(employee.roleId).toBe(cashierId);

		const reactivatedRows = await auditRows('employee.reactivated');
		expect(reactivatedRows).toHaveLength(1);
		expect(reactivatedRows[0].details).toEqual({
			roleName: 'Cashier',
			displayName: 'Sam'
		});

		const updatedRows = await auditRows('employee.updated');
		expect(updatedRows).toHaveLength(1);
		expect(updatedRows[0].details).toEqual({
			changes: {
				role: {
					old: 'Waiter',
					new: 'Cashier'
				}
			}
		});
	});

	it('returns already_active for an employee who is already active', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const reactivated = await db.transaction((tx) =>
			reactivateEmployee(tx, a.restaurantId, result.id, {}, ctx(a.ownerId))
		);

		expect(reactivated).toEqual({ ok: false, reason: 'already_active' });
		expect(await auditRows('employee.reactivated')).toHaveLength(0);
	});
});

describe('clearPinLockout', () => {
	it('clears a five-attempt lockout and allows the correct PIN immediately', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const device = await db.transaction((tx) =>
			registerDevice(tx, {
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId,
				label: 'Counter tablet'
			})
		);

		const now = new Date();

		for (let i = 0; i < MAX_FAILED_PIN_ATTEMPTS; i++) {
			const attempt = await db.transaction((tx) =>
				verifyEmployeePin(
					tx,
					{
						restaurantId: a.restaurantId,
						employeeId: result.id,
						pin: '9999'
					},
					{
						deviceId: device.deviceId,
						deviceCode: device.deviceCode,
						clientOpId: null,
						ip: null,
						userAgent: 'till',
						now
					}
				)
			);

			expect(attempt).toEqual(
				i === MAX_FAILED_PIN_ATTEMPTS - 1
					? { ok: false, reason: 'locked', retryAfterMs: 300000 }
					: { ok: false, reason: 'invalid' }
			);
		}

		const cleared = await db.transaction((tx) =>
			clearPinLockout(tx, a.restaurantId, result.id, ctx(a.ownerId))
		);

		expect(cleared).toEqual({ ok: true, wasLocked: true });

		const [employee] = await db.select().from(users).where(eq(users.id, result.id));
		expect(employee.failedPinCount).toBe(0);
		expect(employee.pinLockedUntil).toBeNull();

		const afterClear = await db.transaction((tx) =>
			verifyEmployeePin(
				tx,
				{
					restaurantId: a.restaurantId,
					employeeId: result.id,
					pin: '1234'
				},
				{
					deviceId: device.deviceId,
					deviceCode: device.deviceCode,
					clientOpId: null,
					ip: null,
					userAgent: 'till',
					now
				}
			)
		);

		expect(afterClear).toEqual({
			ok: true,
			employee: {
				id: result.id,
				displayName: 'Sam',
				isOwner: false,
				roleName: 'Cashier'
			}
		});

		const rows = await auditRows('employee.lockout_cleared');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			displayName: 'Sam',
			failedCount: 0,
			wasLocked: true
		});

		for (const key of Object.keys(rows[0].details as Record<string, unknown>)) {
			expect(key).not.toMatch(/pass|pin|token|hash|secret|cookie|authorization/i);
		}
	});

	it('returns nothing_to_clear when there is no active lockout or failed count', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		const cleared = await db.transaction((tx) =>
			clearPinLockout(tx, a.restaurantId, result.id, ctx(a.ownerId))
		);

		expect(cleared).toEqual({ ok: false, reason: 'nothing_to_clear' });
		expect(await auditRows('employee.lockout_cleared')).toHaveLength(0);
	});

	it('can clear a non-zero failed count before a lock is reached', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db.update(users).set({ failedPinCount: 2 }).where(eq(users.id, result.id));

		const cleared = await db.transaction((tx) =>
			clearPinLockout(tx, a.restaurantId, result.id, ctx(a.ownerId))
		);

		expect(cleared).toEqual({ ok: true, wasLocked: false });

		const rows = await auditRows('employee.lockout_cleared');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			displayName: 'Sam',
			failedCount: 2,
			wasLocked: false
		});
	});
});

describe('employeeSetupStatus', () => {
	it('is false when there are no staff', async () => {
		const a = await makeRestaurant();

		expect(await employeeSetupStatus(db, a.restaurantId)).toEqual({
			staffWithPin: false
		});
	});

	it('is false when staff exists but has no PIN', async () => {
		const a = await makeRestaurant();

		await seedStaff(db, a.restaurantId, {
			roleName: 'Cashier',
			displayName: 'Sam',
			pinHash: null
		});

		expect(await employeeSetupStatus(db, a.restaurantId)).toEqual({
			staffWithPin: false
		});
	});

	it('is false when the only PIN holder is inactive', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		const result = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		if (!result.ok) throw new Error('Expected employee creation to succeed.');

		await db.update(users).set({ isActive: false }).where(eq(users.id, result.id));

		expect(await employeeSetupStatus(db, a.restaurantId)).toEqual({
			staffWithPin: false
		});
	});

	it('is true when an active staff member has a PIN', async () => {
		const a = await makeRestaurant();
		const cashierId = await roleId(a.restaurantId, 'Cashier');

		await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(a.ownerId)
			)
		);

		expect(await employeeSetupStatus(db, a.restaurantId)).toEqual({
			staffWithPin: true
		});
	});

	it("ignores the owner's PIN", async () => {
		const a = await makeRestaurant();

		await db.transaction((tx) =>
			setEmployeePin(tx, a.restaurantId, a.ownerId, '1234', ctx(a.ownerId))
		);

		expect(await employeeSetupStatus(db, a.restaurantId)).toEqual({
			staffWithPin: false
		});
	});

	it("ignores another restaurant's staff", async () => {
		const a = await makeRestaurant('a@cafe.com');
		const b = await makeRestaurant('b@cafe.com');
		const cashierId = await roleId(b.restaurantId, 'Cashier');

		await db.transaction((tx) =>
			createEmployee(
				tx,
				b.restaurantId,
				{ roleId: cashierId, displayName: 'Sam', pin: '1234' },
				ctx(b.ownerId)
			)
		);

		expect(await employeeSetupStatus(db, a.restaurantId)).toEqual({
			staffWithPin: false
		});
	});
});
