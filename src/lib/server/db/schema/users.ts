import { sql } from 'drizzle-orm';
import {
	pgTable,
	pgEnum,
	uuid,
	text,
	boolean,
	integer,
	timestamp,
	uniqueIndex,
	index,
	check
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// Spec 31's three roles. No Manager: open decision 5 defaults to owner PIN only,
// and CLAUDE.md's do-not-build list excludes the Manager role.
export const userRole = pgEnum('user_role', ['owner', 'cashier', 'waiter']);

// A union type derived from the enum, so later code never compares against a bare
// string literal that a typo can break.
export type UserRole = (typeof userRole.enumValues)[number];

// THERE IS DELIBERATELY NO `pin_hash` COLUMN.
// -------------------------------------------
// Spec 6 requires employee PINs to be verified OFFLINE IN THE BROWSER from hashes
// cached on the registered device. The POS plan must therefore choose an algorithm
// available in WebCrypto or WASM, which may not be the server-side argon2id
// parameters T-10 uses for passwords. A column with no writer, no reader and no
// decided format would hard-code the wrong assumption into the first migration.
// Adding a nullable column later is metadata-only. Do not "fix" this omission.
//
// For the same reason the lockout counters are named failed_password_count and
// password_locked_until rather than generic names: the PIN plan adds its own pair,
// and the two surfaces lock independently. Five wrong PINs typed by a waiter at
// the counter must not lock the owner out of the dashboard.
export const users = pgTable(
	'users',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: uuid('restaurant_id')
			.notNull()
			.references(() => restaurants.id, { onDelete: 'restrict' }),
		role: userRole('role').notNull(),
		displayName: text('display_name').notNull(),
		email: text('email'),
		passwordHash: text('password_hash'),
		isActive: boolean('is_active').notNull().default(true),
		failedPasswordCount: integer('failed_password_count').notNull().default(0),
		passwordLockedUntil: timestamp('password_locked_until', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// Email is a GLOBAL login identity, unique across all restaurants, matched
		// case-insensitively.
		uniqueIndex('users_email_lower_unique')
			.on(sql`lower(${table.email})`)
			.where(sql`${table.email} is not null`),

		// Exactly one owner per restaurant (spec 31).
		uniqueIndex('users_one_owner_per_restaurant')
			.on(table.restaurantId)
			.where(sql`${table.role} = 'owner'`),

		// An owner must be able to log in.
		check(
			'users_owner_has_credentials',
			sql`${table.role} <> 'owner' or (${table.email} is not null and ${table.passwordHash} is not null)`
		),

		// And nobody else may. Spec 7 gives email and password to the Owner/Admin and
		// PINs to the cashier and waiter. Without this second constraint a later
		// Employees plan could quietly give a cashier a password, and any route
		// guarded only by "is there a session" would then accept them.
		check(
			'users_non_owner_has_no_credentials',
			sql`${table.role} = 'owner' or (${table.email} is null and ${table.passwordHash} is null)`
		),

		index('users_restaurant_id_idx').on(table.restaurantId)
	]
);
