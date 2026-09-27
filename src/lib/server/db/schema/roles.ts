import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	timestamp,
	index,
	uniqueIndex,
	unique,
	check,
	foreignKey,
	primaryKey
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// OWNER-EDITABLE ROLES (CLAUDE.md "Decisions already made", 2026-09-16).
// ------------------------------------------------------------------
// Spec 31 lists Advanced RBAC under Later; the user chose restaurant-scoped
// editable roles over the ten spec 8 POS keys. Roles are ARCHIVED, never
// deleted — audit_log and users may still reference them. The reserved name
// `Owner` (any case) is refused so a staff role label can never read "Owner"
// on the till. The ten permission keys live once in permissions/keys.ts and
// are validated by zod on every write; the prefix CHECK below forbids
// admin.* structurally without enumerating the POS list (a new POS key needs
// no migration).

export const roles = pgTable(
	'roles',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: uuid('restaurant_id')
			.notNull()
			.references(() => restaurants.id, { onDelete: 'restrict' }),
		name: text('name').notNull(),
		archivedAt: timestamp('archived_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('roles_restaurant_id_idx').on(t.restaurantId),
		uniqueIndex('roles_name_unique')
			.on(t.restaurantId, sql`lower(${t.name})`)
			.where(sql`${t.archivedAt} is null`),
		// UNIQUE CONSTRAINT, not uniqueIndex: drizzle-kit emits CREATE INDEX after
		// every FK, so a unique INDEX would not exist yet when role_permissions and
		// users add their composite FKs (42830). unique() lands inside CREATE TABLE.
		unique('roles_id_restaurant_unique').on(t.id, t.restaurantId),
		check('roles_name_length', sql`length(btrim(${t.name})) between 1 and 60`),
		check('roles_name_not_owner', sql`lower(btrim(${t.name})) <> 'owner'`)
	]
);

export const rolePermissions = pgTable(
	'role_permissions',
	{
		restaurantId: uuid('restaurant_id')
			.notNull()
			.references(() => restaurants.id, { onDelete: 'restrict' }),
		roleId: uuid('role_id').notNull(),
		permissionKey: text('permission_key').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		primaryKey({ name: 'role_permissions_pk', columns: [t.roleId, t.permissionKey] }),
		foreignKey({
			columns: [t.restaurantId, t.roleId],
			foreignColumns: [roles.restaurantId, roles.id],
			name: 'role_permissions_role_fk'
		}).onDelete('restrict'),
		index('role_permissions_restaurant_idx').on(t.restaurantId),
		// Forbids admin.* structurally; enumerates nothing, so a new POS key needs no migration.
		check('role_permissions_key_pos_only', sql`${t.permissionKey} like 'pos.%'`)
	]
);
