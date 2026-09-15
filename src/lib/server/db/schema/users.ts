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

// THE PIN COLUMNS — pin_hash, failed_pin_count, pin_locked_until.
// ---------------------------------------------------------------
// Spec 6 requires employee PINs to be verified OFFLINE IN THE BROWSER from hashes
// cached on the registered device, so the PIN hash cannot reuse the argon2id that
// src/lib/server/auth/password.ts uses for passwords: WebCrypto has no Argon2, and
// node:crypto's argon2id has no browser build. The algorithm is decided (CLAUDE.md,
// "Decisions already made", 2026-09-15): PBKDF2-HMAC-SHA256 at 600,000 iterations
// through crypto.subtle.deriveBits, implemented once in the isomorphic
// src/lib/pin/ that the server and the offline till both import. Spec 7's "e.g.
// Argon2 or bcrypt" names examples, not a closed list; PBKDF2 at the OWASP work
// factor is a slow salted hash.
//
// pin_hash is a PHC-style string that carries its own parameters —
// $pbkdf2-sha256$i=600000$<salt>$<tag> — exactly as password_hash stores
// $argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>, so the iteration count can be raised
// later without invalidating stored hashes. That is why it is text, not bytea.
// Nothing here encodes PIN length: the 4–6 digit bound lives in the PIN module.
//
// failed_pin_count / pin_locked_until are a SEPARATE pair from
// failed_password_count / password_locked_until, and the two surfaces lock
// independently: five wrong PINs typed at the counter must not lock the owner out
// of the dashboard, and a password lockout must not stop the cashier taking money.
// The PIN verifier owns this pair and never touches the password pair.
//
// The OWNER MAY have a pin_hash: spec 7 gives the owner a POS PIN, used to approve
// sensitive actions (spec 8). pin_hash is therefore orthogonal to
// users_non_owner_has_no_credentials below, which is about email and password only.
//
// No CHECK is added for the PIN, deliberately — in particular not "a cashier must
// have a pin_hash": an employee is created before their PIN is set, and a CHECK
// that forbids a half-configured employee could only be undone by a second
// migration. All three columns are nullable or defaulted, so the migration applies
// to the existing owner row without touching it.
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
		pinHash: text('pin_hash'),
		failedPinCount: integer('failed_pin_count').notNull().default(0),
		pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
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
