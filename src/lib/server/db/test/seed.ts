import { sql } from 'drizzle-orm';
import { roles, rolePermissions } from '../schema/roles';
import { users } from '../schema/users';
import { CASHIER_KEYS, type PosPermissionKey } from '../../permissions/keys';
import type { Db, DbTx } from '../client';
type DbExecutor = Db | DbTx;

type SeedRoleOptions = {
	name: string;
	permissionKeys: readonly PosPermissionKey[];
};

type SeedStaffOptions = {
	displayName: string;
	roleId?: string;
	roleName?: string;
	permissionKeys?: readonly PosPermissionKey[];
	pinHash?: string | null;
	isActive?: boolean;
};

export async function seedRole(
	db: DbExecutor,
	restaurantId: string,
	input: SeedRoleOptions
): Promise<{ id: string }> {
	const [role] = await db
		.insert(roles)
		.values({
			restaurantId,
			name: input.name
		})
		.returning({ id: roles.id });

	if (!role) {
		throw new Error(`Failed to seed role "${input.name}".`);
	}

	if (input.permissionKeys.length > 0) {
		await db.insert(rolePermissions).values(
			input.permissionKeys.map((permissionKey) => ({
				restaurantId,
				roleId: role.id,
				permissionKey
			}))
		);
	}

	return role;
}

export async function seedStaff(
	db: DbExecutor,
	restaurantId: string,
	input: SeedStaffOptions
): Promise<{ id: string; roleId: string }> {
	let roleId = input.roleId;

	if (!roleId && input.roleName) {
		const [role] = await db
			.select({ id: roles.id })
			.from(roles)
			.where(
				sql`"roles"."restaurant_id" = ${restaurantId}
					AND lower(btrim("roles"."name")) = lower(btrim(${input.roleName}))
					AND "roles"."archived_at" IS NULL`
			)
			.limit(1);

		if (!role) {
			throw new Error(`No live role named "${input.roleName}" exists.`);
		}

		roleId = role.id;
	}

	if (!roleId) {
		const [existingRole] = await db
			.select({ id: roles.id })
			.from(roles)
			.where(
				sql`"roles"."restaurant_id" = ${restaurantId}
				AND lower(btrim("roles"."name")) = 'cashier'
				AND "roles"."archived_at" IS NULL`
			)
			.limit(1);

		if (existingRole) {
			roleId = existingRole.id;
		} else {
			const role = await seedRole(db, restaurantId, {
				name: 'Cashier',
				permissionKeys: input.permissionKeys ?? CASHIER_KEYS
			});

			roleId = role.id;
		}
	}

	const [staff] = await db
		.insert(users)
		.values({
			restaurantId,
			role: 'staff',
			roleId,
			displayName: input.displayName,
			email: null,
			passwordHash: null,
			pinHash: input.pinHash ?? null,
			isActive: input.isActive ?? true
		})
		.returning({ id: users.id });

	if (!staff) {
		throw new Error(`Failed to seed staff "${input.displayName}".`);
	}

	return { id: staff.id, roleId };
}
