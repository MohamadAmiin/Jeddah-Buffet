import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { users } from './users';

// The registered POS device (spec 7): the owner signs in ON the device with email
// and password once, the server issues a long-lived HttpOnly + Secure device
// cookie, and from then on that browser may show the PIN screen. The owner can
// revoke it from the dashboard. One device today (spec 33 open decision 1); the
// device_code column is what makes terminal 2 a data change rather than a rewrite.
//
// NO "one active device per restaurant" CONSTRAINT, deliberately. Open decision 1
// defaults to one device, and the whole point of device_code is that a second
// terminal is a new row with the next code. The MVP's one-device rule is enforced
// where a person can be told why — the registration route answers 409 while an
// active device exists — not by an index a second terminal would need a migration
// to drop. Do not "tighten" this.
//
// NO updated_at, deliberately. Nothing updates a device row except the two stamps
// below — last_seen_at, and the revoked_at / revoked_by_user_id pair — and each
// carries its own timestamp (and, for revocation, its own actor).
export const posDevices = pgTable(
	'pos_devices',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: uuid('restaurant_id')
			.notNull()
			.references(() => restaurants.id, { onDelete: 'restrict' }),
		// The invoice prefix. 'POS1' today; 'POS2' is a data change, not a rewrite.
		//
		// Spec 6's device invoice numbers read POS1-000001, so this code is printed on
		// receipts: the CHECK below allows 1–8 uppercase letters and digits, which
		// fits a 32-character receipt line. The registration module assigns it — the
		// literal 'POS1', uppercase, for the first device — and a code is BURNED once
		// used: the unique index below is deliberately NOT partial on revoked_at, so
		// after revoking POS1 the next registration takes POS2. Reusing POS1 would let
		// POS1-000001 name two different sales from two different devices.
		deviceCode: text('device_code').notNull(),
		// Human label shown in the dashboard device list, e.g. 'Counter tablet'.
		label: text('label').notNull(),
		// NOT the cookie value: the lowercase hex SHA-256 of the random device token,
		// exactly as sessions.id is for the auth session. 64 characters. The browser
		// holds the token in the device cookie and the database holds only this hash,
		// so a database leak yields hashes rather than usable devices. The
		// registration module owns the derivation and the cookie attributes.
		tokenHash: text('token_hash').notNull(),
		registeredByUserId: uuid('registered_by_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
		// REVOCATION IS THIS STAMP, NEVER A DELETE. audit_log.device_id references this
		// table with ON DELETE RESTRICT, so a device that has ever produced an audit
		// row cannot be deleted at all — and must not be, or the trail of who was
		// signed in on which till loses its subject. "Active" means revoked_at is
		// null, and every query that decides whether a device may show the PIN screen
		// filters on exactly that.
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
			onDelete: 'restrict'
		})
	},
	(table) => [
		uniqueIndex('pos_devices_token_hash_unique').on(table.tokenHash),
		uniqueIndex('pos_devices_restaurant_device_code_unique').on(
			table.restaurantId,
			table.deviceCode
		),
		check('pos_devices_device_code_format', sql`${table.deviceCode} ~ '^[A-Z0-9]{1,8}$'`),
		index('pos_devices_restaurant_id_idx').on(table.restaurantId)
	]
);
