import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { users } from '../db/schema/users';
import { roles, rolePermissions } from '../db/schema/roles';
import { writeAudit } from '../audit';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import {
	ALL_KEYS,
	isPosPermissionKey,
	POS_KEYS,
	RESERVED_ROLE_NAMES,
	ROLE_NAME_MAX,
	type PermissionKey,
	type PosPermissionKey
} from './keys';

export type RoleRow = {
	id: string;
	name: string;
	permissionKeys: PosPermissionKey[];
	archivedAt: Date | null;
	activeStaffCount: number;
	staffCount: number;
};

export type RoleInput = {
	name: string;
	permissionKeys: PosPermissionKey[];
};

export type RoleWriteContext = {
	actorUserId: string;
	ip: string | null;
	userAgent: string | null;
};
async function roleRows(
	database: Executor,
	restaurantId: string,
	includeArchived: boolean
): Promise<RoleRow[]> {
	const roleRows = await database
		.select({
			id: roles.id,
			name: roles.name,
			archivedAt: roles.archivedAt
		})
		.from(roles)
		.where(
			includeArchived
				? eq(roles.restaurantId, restaurantId)
				: and(eq(roles.restaurantId, restaurantId), isNull(roles.archivedAt))
		)
		.orderBy(sql`CASE WHEN ${roles.archivedAt} IS NULL THEN 0 ELSE 1 END`, asc(roles.name));

	if (roleRows.length === 0) return [];

	const roleIds = roleRows.map((role) => role.id);

	const permissionRows = await database
		.select({
			roleId: rolePermissions.roleId,
			permissionKey: rolePermissions.permissionKey
		})
		.from(rolePermissions)
		.where(
			sql`${rolePermissions.restaurantId} = ${restaurantId}
                AND ${rolePermissions.roleId} IN (${sql.join(
									roleIds.map((id) => sql`${id}`),
									sql`, `
								)})`
		);

	const staffCounts = await database
		.select({
			roleId: users.roleId,
			staffCount: sql<number>`count(*)::int`,
			activeStaffCount: sql<number>`count(*) FILTER (WHERE ${users.isActive} = true)::int`
		})
		.from(users)
		.where(
			sql`${users.restaurantId} = ${restaurantId}
                AND ${users.roleId} IN (${sql.join(
									roleIds.map((id) => sql`${id}`),
									sql`, `
								)})`
		)
		.groupBy(users.roleId);

	const permissionsByRole = new Map<string, PosPermissionKey[]>();
	for (const roleId of roleIds) {
		permissionsByRole.set(roleId, []);
	}

	for (const row of permissionRows) {
		if (isPosPermissionKey(row.permissionKey)) {
			permissionsByRole.get(row.roleId)?.push(row.permissionKey);
		}
	}

	const countsByRole = new Map(
		staffCounts.map((row) => [
			row.roleId,
			{
				staffCount: Number(row.staffCount),
				activeStaffCount: Number(row.activeStaffCount)
			}
		])
	);

	return roleRows.map((role) => {
		const counts = countsByRole.get(role.id) ?? {
			staffCount: 0,
			activeStaffCount: 0
		};

		const permissionSet = new Set(permissionsByRole.get(role.id) ?? []);
		const permissionKeys = POS_KEYS.filter((key) => permissionSet.has(key));

		return {
			id: role.id,
			name: role.name,
			permissionKeys,
			archivedAt: role.archivedAt,
			activeStaffCount: counts.activeStaffCount,
			staffCount: counts.staffCount
		};
	});
}

export async function listRoles(
	database: Executor,
	restaurantId: string,
	opts?: { includeArchived?: boolean }
): Promise<RoleRow[]> {
	return roleRows(database, restaurantId, opts?.includeArchived ?? false);
}

export async function getRole(
	database: Executor,
	restaurantId: string,
	roleId: string
): Promise<RoleRow | null> {
	const rows = await roleRows(database, restaurantId, true);
	return rows.find((role) => role.id === roleId) ?? null;
}
export async function createRole(
	tx: DbTx,
	restaurantId: string,
	input: RoleInput,
	ctx: RoleWriteContext
): Promise<
	| { ok: true; id: string }
	| { ok: false; reason: 'invalid_name' | 'reserved_name' | 'duplicate_name' | 'invalid_keys' }
> {
	const name = input.name.trim();

	if (name.length < 1 || name.length > ROLE_NAME_MAX) {
		return { ok: false, reason: 'invalid_name' };
	}

	if (RESERVED_ROLE_NAMES.includes(name.toLowerCase())) {
		return { ok: false, reason: 'reserved_name' };
	}

	const permissionKeys = [...new Set(input.permissionKeys)];

	if (permissionKeys.length === 0 || permissionKeys.some((key) => !isPosPermissionKey(key))) {
		return { ok: false, reason: 'invalid_keys' };
	}

	try {
		const [role] = await tx
			.insert(roles)
			.values({
				restaurantId,
				name
			})
			.returning({ id: roles.id });

		if (!role) {
			throw new Error('Failed to create role.');
		}

		await tx.insert(rolePermissions).values(
			permissionKeys.map((permissionKey) => ({
				restaurantId,
				roleId: role.id,
				permissionKey
			}))
		);

		await writeAudit(tx, {
			event: 'role.created',
			details: {
				name,
				permissionKeys
			},
			restaurantId,
			actorUserId: ctx.actorUserId,
			subjectUserId: null,
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});

		return { ok: true, id: role.id };
	} catch (error) {
		let cause: unknown = error;

		for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
			if (
				'code' in cause &&
				cause.code === '23505' &&
				'constraint' in cause &&
				cause.constraint === 'roles_name_unique'
			) {
				return { ok: false, reason: 'duplicate_name' };
			}

			cause = 'cause' in cause ? cause.cause : undefined;
		}

		throw error;
	}
}
export async function updateRole(
	tx: DbTx,
	restaurantId: string,
	roleId: string,
	changes: Partial<RoleInput>,
	ctx: RoleWriteContext
): Promise<
	| { ok: true; changed: boolean }
	| {
			ok: false;
			reason:
				| 'not_found'
				| 'archived'
				| 'invalid_name'
				| 'reserved_name'
				| 'duplicate_name'
				| 'invalid_keys';
	  }
> {
	const [role] = await tx
		.select({
			id: roles.id,
			name: roles.name,
			archivedAt: roles.archivedAt
		})
		.from(roles)
		.where(and(eq(roles.id, roleId), eq(roles.restaurantId, restaurantId)))
		.for('update')
		.limit(1);

	if (!role) {
		return { ok: false, reason: 'not_found' };
	}

	if (role.archivedAt !== null) {
		return { ok: false, reason: 'archived' };
	}

	let nextName = role.name;
	let nextPermissionKeys: PosPermissionKey[] | null = null;

	if (changes.name !== undefined) {
		nextName = changes.name.trim();

		if (nextName.length < 1 || nextName.length > ROLE_NAME_MAX) {
			return { ok: false, reason: 'invalid_name' };
		}

		if (RESERVED_ROLE_NAMES.includes(nextName.toLowerCase())) {
			return { ok: false, reason: 'reserved_name' };
		}
	}

	if (changes.permissionKeys !== undefined) {
		const permissionKeys = [...new Set(changes.permissionKeys)];

		if (permissionKeys.length === 0 || permissionKeys.some((key) => !isPosPermissionKey(key))) {
			return { ok: false, reason: 'invalid_keys' };
		}

		nextPermissionKeys = permissionKeys;
	}

	let oldPermissionKeys: PosPermissionKey[] = [];

	if (nextPermissionKeys !== null) {
		const permissionRows = await tx
			.select({ permissionKey: rolePermissions.permissionKey })
			.from(rolePermissions)
			.where(
				and(eq(rolePermissions.restaurantId, restaurantId), eq(rolePermissions.roleId, roleId))
			);

		oldPermissionKeys = POS_KEYS.filter((key) =>
			permissionRows.some((row) => row.permissionKey === key)
		);
	}

	const nameChanged = nextName !== role.name;
	const permissionsChanged =
		nextPermissionKeys !== null &&
		(nextPermissionKeys.length !== oldPermissionKeys.length ||
			nextPermissionKeys.some((key, index) => key !== oldPermissionKeys[index]));

	if (!nameChanged && !permissionsChanged) {
		return { ok: true, changed: false };
	}

	try {
		if (nameChanged) {
			await tx
				.update(roles)
				.set({
					name: nextName,
					updatedAt: new Date()
				})
				.where(and(eq(roles.id, roleId), eq(roles.restaurantId, restaurantId)));
		}

		if (permissionsChanged && nextPermissionKeys !== null) {
			await tx
				.delete(rolePermissions)
				.where(
					and(eq(rolePermissions.restaurantId, restaurantId), eq(rolePermissions.roleId, roleId))
				);

			await tx.insert(rolePermissions).values(
				nextPermissionKeys.map((permissionKey) => ({
					restaurantId,
					roleId,
					permissionKey
				}))
			);

			if (!nameChanged) {
				await tx
					.update(roles)
					.set({ updatedAt: new Date() })
					.where(and(eq(roles.id, roleId), eq(roles.restaurantId, restaurantId)));
			}
		}

		const auditChanges: Record<string, { old: unknown; new: unknown }> = {};

		if (nameChanged) {
			auditChanges.name = {
				old: role.name,
				new: nextName
			};
		}

		if (permissionsChanged && nextPermissionKeys !== null) {
			auditChanges.permissionKeys = {
				old: oldPermissionKeys,
				new: nextPermissionKeys
			};
		}

		await writeAudit(tx, {
			event: 'role.updated',
			details: {
				changes: auditChanges
			},
			restaurantId,
			actorUserId: ctx.actorUserId,
			subjectUserId: null,
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});

		return { ok: true, changed: true };
	} catch (error) {
		let cause: unknown = error;

		for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
			if (
				'code' in cause &&
				cause.code === '23505' &&
				'constraint' in cause &&
				cause.constraint === 'roles_name_unique'
			) {
				return { ok: false, reason: 'duplicate_name' };
			}

			cause = 'cause' in cause ? cause.cause : undefined;
		}

		throw error;
	}
}
export async function archiveRole(
	tx: DbTx,
	restaurantId: string,
	roleId: string,
	ctx: RoleWriteContext
): Promise<
	| { ok: true }
	| { ok: false; reason: 'not_found' | 'already_archived' }
	| { ok: false; reason: 'in_use'; activeStaffCount: number }
> {
	const [role] = await tx
		.select({
			id: roles.id,
			name: roles.name,
			archivedAt: roles.archivedAt
		})
		.from(roles)
		.where(and(eq(roles.id, roleId), eq(roles.restaurantId, restaurantId)))
		.for('update')
		.limit(1);

	if (!role) {
		return { ok: false, reason: 'not_found' };
	}

	if (role.archivedAt !== null) {
		return { ok: false, reason: 'already_archived' };
	}

	const [countRow] = await tx
		.select({
			activeStaffCount: sql<number>`count(*)::int`
		})
		.from(users)
		.where(
			and(eq(users.restaurantId, restaurantId), eq(users.roleId, roleId), eq(users.isActive, true))
		);

	const activeStaffCount = Number(countRow?.activeStaffCount ?? 0);

	if (activeStaffCount > 0) {
		return { ok: false, reason: 'in_use', activeStaffCount };
	}

	await tx
		.update(roles)
		.set({
			archivedAt: new Date(),
			updatedAt: new Date()
		})
		.where(and(eq(roles.id, roleId), eq(roles.restaurantId, restaurantId)));

	await writeAudit(tx, {
		event: 'role.archived',
		details: {
			name: role.name
		},
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return { ok: true };
}
/** The role row, locked FOR SHARE for the rest of the transaction, or null when missing, foreign or archived. */
export async function assertLiveRole(
	tx: DbTx,
	restaurantId: string,
	roleId: string
): Promise<{ id: string; name: string } | null> {
	const [role] = await tx
		.select({
			id: roles.id,
			name: roles.name
		})
		.from(roles)
		.where(
			and(eq(roles.id, roleId), eq(roles.restaurantId, restaurantId), isNull(roles.archivedAt))
		)
		.for('share')
		.limit(1);

	return role ?? null;
}

export async function permissionsForUser(
	database: Executor,
	restaurantId: string,
	userId: string
): Promise<ReadonlySet<PermissionKey>> {
	const [user] = await database
		.select({
			role: users.role,
			roleId: users.roleId
		})
		.from(users)
		.where(
			and(eq(users.id, userId), eq(users.restaurantId, restaurantId), eq(users.isActive, true))
		)
		.limit(1);

	if (!user) {
		return new Set<PermissionKey>();
	}

	if (user.role === 'owner') {
		return new Set<PermissionKey>(ALL_KEYS);
	}

	if (user.role !== 'staff' || !user.roleId) {
		return new Set<PermissionKey>();
	}

	const permissionRows = await database
		.select({
			permissionKey: rolePermissions.permissionKey
		})
		.from(rolePermissions)
		.where(
			and(eq(rolePermissions.restaurantId, restaurantId), eq(rolePermissions.roleId, user.roleId))
		);

	const permissions = new Set<PermissionKey>();

	for (const row of permissionRows) {
		if (isPosPermissionKey(row.permissionKey)) {
			permissions.add(row.permissionKey);
		}
	}

	return permissions;
}
