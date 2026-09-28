import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from './session';
import { users } from '../db/schema/users';
import { roles } from '../db/schema/roles';
import { writeAudit } from '../audit';
import { hashPin } from '../../pin';
import { assertLiveRole } from '../permissions/roles';

// THE DASHBOARD'S EMPLOYEE WRITE MODEL (spec 7, 31).
//
// Separate from employee-directory.ts ON PURPOSE: that file is the POS read model,
// which ships cached PIN hashes to a registered device. This one never reads a
// hash at all â€” hasPin is computed in SQL â€” and it is the only writer of pin_hash.
//
// PINs are hashed with the ISOMORPHIC src/lib/pin (PBKDF2-SHA256), never with
// hashPassword: spec 6 needs the same hash verified in the browser, from the bundle
// cached on the till, and argon2id has no browser build.
//
// users is not a posted record: invariant 2 covers orders, invoices, payments,
// stock movements and journal rows. Changing a PIN hash is an ordinary UPDATE, and
// it is audited in the same transaction (invariant 10).

export type EmployeeRow = {
	id: string;
	kind: 'owner' | 'staff';
	displayName: string;
	roleId: string | null;
	roleName: string | null;
	roleArchived: boolean;
	hasPin: boolean;
	isActive: boolean;
	lockedUntil: Date | null;
	failedPinCount: number;
};

type AuditContext = {
	actorUserId: string;
	ip: string | null;
	userAgent: string | null;
};

function employeeSelect(database: Executor, restaurantId: string) {
	return database
		.select({
			id: users.id,
			kind: users.role,
			displayName: users.displayName,
			roleId: users.roleId,
			roleName: sql<string | null>`
				case
					when ${users.role} = 'owner' then 'Owner'
					else ${roles.name}
				end
			`,
			roleArchived: sql<boolean>`${roles.archivedAt} is not null`,
			hasPin: sql<boolean>`${users.pinHash} is not null`,
			isActive: users.isActive,
			lockedUntil: sql<Date | null>`
				case
					when ${users.pinLockedUntil} > now() then ${users.pinLockedUntil}
					else null
				end
			`,
			failedPinCount: users.failedPinCount
		})
		.from(users)
		.leftJoin(roles, eq(roles.id, users.roleId))
		.where(eq(users.restaurantId, restaurantId));
}

/**
 * Everyone in the restaurant, with the owner first, then active staff by name,
 * then inactive staff by name.
 *
 * The PIN hash is never selected. hasPin is computed entirely in PostgreSQL.
 */
export async function listEmployees(
	database: Executor,
	restaurantId: string
): Promise<EmployeeRow[]> {
	return employeeSelect(database, restaurantId).orderBy(
		asc(
			sql<number>`
				case
					when ${users.role} = 'owner' then 0
					when ${users.isActive} = true then 1
					else 2
				end
			`
		),
		asc(users.displayName)
	);
}

/**
 * Return one employee in the restaurant, or null when the user does not belong
 * to this tenant.
 */
export async function getEmployee(
	database: Executor,
	restaurantId: string,
	userId: string
): Promise<EmployeeRow | null> {
	const rows = await database
		.select({
			id: users.id,
			kind: users.role,
			displayName: users.displayName,
			roleId: users.roleId,
			roleName: sql<string | null>`
				case
					when ${users.role} = 'owner' then 'Owner'
					else ${roles.name}
				end
			`,
			roleArchived: sql<boolean>`${roles.archivedAt} is not null`,
			hasPin: sql<boolean>`${users.pinHash} is not null`,
			isActive: users.isActive,
			lockedUntil: sql<Date | null>`
				case
					when ${users.pinLockedUntil} > now() then ${users.pinLockedUntil}
					else null
				end
			`,
			failedPinCount: users.failedPinCount
		})
		.from(users)
		.leftJoin(roles, eq(roles.id, users.roleId))
		.where(and(eq(users.restaurantId, restaurantId), eq(users.id, userId)))
		.limit(1);

	return rows[0] ?? null;
}

/**
 * Create a staff employee against an existing live role.
 *
 * The role is locked FOR SHARE by assertLiveRole for the duration of the
 * transaction, preventing the role from being archived while this employee is
 * being created.
 */
export async function createEmployee(
	tx: DbTx,
	restaurantId: string,
	input: { roleId: string; displayName: string; pin: string },
	ctx: AuditContext
): Promise<{ ok: true; id: string } | { ok: false; reason: 'role_not_live' }> {
	const role = await assertLiveRole(tx, restaurantId, input.roleId);

	if (!role) {
		return { ok: false, reason: 'role_not_live' };
	}

	const pinHash = await hashPin(input.pin);

	const [row] = await tx
		.insert(users)
		.values({
			restaurantId,
			role: 'staff',
			roleId: role.id,
			displayName: input.displayName,
			email: null,
			passwordHash: null,
			pinHash
		})
		.returning({ id: users.id });

	if (!row) {
		throw new Error('Failed to create employee.');
	}

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: row.id,
		event: 'employee.created',
		details: {
			roleName: role.name,
			displayName: input.displayName
		},
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return { ok: true, id: row.id };
}

/**
 * Update an employee's display name and/or role.
 *
 * Owners are a fixed identity and cannot be changed through this staff editor.
 * A role change requires the target role to still be live.
 */
export async function updateEmployee(
	tx: DbTx,
	restaurantId: string,
	userId: string,
	changes: { displayName: string; roleId: string },
	ctx: AuditContext
): Promise<
	{ ok: true; changed: boolean } | { ok: false; reason: 'not_found' | 'owner' | 'role_not_live' }
> {
	const [employee] = await tx
		.select({
			id: users.id,
			role: users.role,
			displayName: users.displayName,
			roleId: users.roleId
		})
		.from(users)
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.for('update')
		.limit(1);

	if (!employee) {
		return { ok: false, reason: 'not_found' };
	}

	if (employee.role === 'owner') {
		return { ok: false, reason: 'owner' };
	}

	const nextDisplayName = changes.displayName.trim();
	const roleChanged = employee.roleId !== changes.roleId;

	let currentRoleName: string | null = null;
	let nextRoleName: string | null = null;

	if (roleChanged) {
		if (employee.roleId) {
			const [currentRole] = await tx
				.select({ name: roles.name })
				.from(roles)
				.where(and(eq(roles.id, employee.roleId), eq(roles.restaurantId, restaurantId)))
				.limit(1);

			currentRoleName = currentRole?.name ?? null;
		}

		const targetRole = await assertLiveRole(tx, restaurantId, changes.roleId);

		if (!targetRole) {
			return { ok: false, reason: 'role_not_live' };
		}

		nextRoleName = targetRole.name;
	}

	const displayNameChanged = nextDisplayName !== employee.displayName;

	if (!displayNameChanged && !roleChanged) {
		return { ok: true, changed: false };
	}

	const auditChanges: Record<string, { old: unknown; new: unknown }> = {};

	if (displayNameChanged) {
		auditChanges.displayName = {
			old: employee.displayName,
			new: nextDisplayName
		};
	}

	if (roleChanged) {
		auditChanges.role = {
			old: currentRoleName,
			new: nextRoleName
		};
	}

	await tx
		.update(users)
		.set({
			displayName: nextDisplayName,
			roleId: changes.roleId,
			updatedAt: sql`now()`
		})
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)));

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: userId,
		event: 'employee.updated',
		details: {
			changes: auditChanges
		},
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return { ok: true, changed: true };
}

export async function deactivateEmployee(
	tx: DbTx,
	restaurantId: string,
	userId: string,
	ctx: AuditContext
): Promise<
	| { ok: true; displayName: string }
	| { ok: false; reason: 'not_found' | 'owner' | 'already_inactive' }
> {
	const [employee] = await tx
		.select({
			id: users.id,
			role: users.role,
			roleId: users.roleId,
			displayName: users.displayName,
			isActive: users.isActive
		})
		.from(users)
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.for('update')
		.limit(1);

	if (!employee) {
		return { ok: false, reason: 'not_found' };
	}

	if (employee.role === 'owner') {
		return { ok: false, reason: 'owner' };
	}

	if (!employee.isActive) {
		return { ok: false, reason: 'already_inactive' };
	}

	const [role] = employee.roleId
		? await tx
				.select({ name: roles.name })
				.from(roles)
				.where(and(eq(roles.id, employee.roleId), eq(roles.restaurantId, restaurantId)))
				.limit(1)
		: [];

	const roleName = role?.name;

	if (!roleName) {
		throw new Error('Staff employee has no role name.');
	}

	await tx
		.update(users)
		.set({
			isActive: false,
			updatedAt: sql`now()`
		})
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)));

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: userId,
		event: 'employee.deactivated',
		details: {
			roleName,
			displayName: employee.displayName
		},
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return { ok: true, displayName: employee.displayName };
}

export async function reactivateEmployee(
	tx: DbTx,
	restaurantId: string,
	userId: string,
	input: { roleId?: string },
	ctx: AuditContext
): Promise<
	| { ok: true; displayName: string }
	| {
			ok: false;
			reason: 'not_found' | 'owner' | 'already_active' | 'role_not_live';
	  }
> {
	const [employee] = await tx
		.select({
			id: users.id,
			role: users.role,
			roleId: users.roleId,
			displayName: users.displayName,
			isActive: users.isActive
		})
		.from(users)
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.for('update')
		.limit(1);

	if (!employee) {
		return { ok: false, reason: 'not_found' };
	}

	if (employee.role === 'owner') {
		return { ok: false, reason: 'owner' };
	}

	if (employee.isActive) {
		return { ok: false, reason: 'already_active' };
	}

	const targetRoleId = input.roleId ?? employee.roleId;

	if (!targetRoleId) {
		return { ok: false, reason: 'role_not_live' };
	}

	const targetRole = await assertLiveRole(tx, restaurantId, targetRoleId);

	if (!targetRole) {
		return { ok: false, reason: 'role_not_live' };
	}

	const roleChanged = employee.roleId !== targetRole.id;
	let currentRoleName: string | null = null;

	if (roleChanged && employee.roleId) {
		const [currentRole] = await tx
			.select({ name: roles.name })
			.from(roles)
			.where(and(eq(roles.id, employee.roleId), eq(roles.restaurantId, restaurantId)))
			.limit(1);

		currentRoleName = currentRole?.name ?? null;
	}

	await tx
		.update(users)
		.set({
			isActive: true,
			...(roleChanged ? { roleId: targetRole.id } : {}),
			updatedAt: sql`now()`
		})
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)));

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: userId,
		event: 'employee.reactivated',
		details: {
			roleName: targetRole.name,
			displayName: employee.displayName
		},
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	if (roleChanged) {
		await writeAudit(tx, {
			restaurantId,
			actorUserId: ctx.actorUserId,
			subjectUserId: userId,
			event: 'employee.updated',
			details: {
				changes: {
					role: {
						old: currentRoleName,
						new: targetRole.name
					}
				}
			},
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});
	}

	return { ok: true, displayName: employee.displayName };
}

export async function clearPinLockout(
	tx: DbTx,
	restaurantId: string,
	userId: string,
	ctx: AuditContext
): Promise<
	{ ok: true; wasLocked: boolean } | { ok: false; reason: 'not_found' | 'nothing_to_clear' }
> {
	const [employee] = await tx
		.select({
			id: users.id,
			displayName: users.displayName,
			failedPinCount: users.failedPinCount,
			pinLockedUntil: users.pinLockedUntil
		})
		.from(users)
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.for('update')
		.limit(1);

	if (!employee) {
		return { ok: false, reason: 'not_found' };
	}

	const now = new Date();
	const wasLocked =
		employee.pinLockedUntil !== null && employee.pinLockedUntil.getTime() > now.getTime();

	if (employee.failedPinCount === 0 && !wasLocked) {
		return { ok: false, reason: 'nothing_to_clear' };
	}

	const failedCount = employee.failedPinCount;

	await tx
		.update(users)
		.set({
			failedPinCount: 0,
			pinLockedUntil: null,
			updatedAt: sql`now()`
		})
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)));

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: userId,
		event: 'employee.lockout_cleared',
		details: {
			displayName: employee.displayName,
			failedCount,
			wasLocked
		},
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return { ok: true, wasLocked };
}

/**
 * Whether at least one ACTIVE staff employee has a PIN.
 *
 * The owner's PIN deliberately does not count toward employee onboarding.
 */
export async function employeeSetupStatus(
	database: Executor,
	restaurantId: string
): Promise<{ staffWithPin: boolean }> {
	const rows = await database
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(users.restaurantId, restaurantId),
				eq(users.role, 'staff'),
				eq(users.isActive, true),
				isNotNull(users.pinHash)
			)
		)
		.limit(1);

	return { staffWithPin: rows.length > 0 };
}

/**
 * Set (or replace) an employee's PIN â€” the owner's own included, which is how
 * the owner's approval PIN (spec 7, 8) gets set.
 *
 * The PIN lockout pair is reset with it, so a new PIN never arrives already
 * locked. The owner's email and password_hash are not touched.
 *
 * No PIN hash is selected or placed into the audit details.
 */
export async function setEmployeePin(
	tx: DbTx,
	restaurantId: string,
	userId: string,
	pin: string,
	ctx: AuditContext
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
	const [target] = await tx
		.select({
			id: users.id,
			role: users.role,
			roleName: roles.name
		})
		.from(users)
		.leftJoin(roles, eq(roles.id, users.roleId))
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.limit(1);

	if (!target) {
		return { ok: false, reason: 'not_found' };
	}

	const pinHash = await hashPin(pin);

	const [row] = await tx
		.update(users)
		.set({
			pinHash,
			failedPinCount: 0,
			pinLockedUntil: null,
			updatedAt: sql`now()`
		})
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.returning({ id: users.id });

	if (!row) {
		return { ok: false, reason: 'not_found' };
	}

	const roleName = target.role === 'owner' ? 'Owner' : target.roleName;

	if (!roleName) {
		throw new Error('Staff employee has no role name.');
	}

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: row.id,
		event: 'employee.pin_set',
		details: { roleName },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return { ok: true };
}
