import { desc } from 'drizzle-orm';
import { pgTable, bigint, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { users } from './users';

// Spec 3: "Sensitive actions are audit-logged: logins, failed PINs, voids,
// refunds, discounts, comps, approvals, cash drawer opens and price changes."
// Invariant 10 adds the house rule: the audit row is written in the SAME
// transaction as the action it records. T-07 makes this table append-only in the
// database itself.
//
// NOT ADDED HERE, and expected rather than forgotten:
//
//   approver_user_id, reason_code — spec 8 requires the action, employee,
//   approver and reason stored together, but approvals are the POS approvals
//   plan's work and nothing in THIS plan can produce one. Adding nullable
//   columns later is a trivial migration.
//
//   device_id, client_op_id — the offline sync plan must add both, plus a
//   partial UNIQUE (device_id, client_op_id), BEFORE the first device-sourced
//   audit row is written, or a retried sync writes a duplicate that the
//   append-only trigger then makes permanent. The trigger T-07 installs blocks
//   UPDATE and DELETE, not ALTER TABLE, so the columns can still be added — but
//   only before the bad rows exist.
export const auditLog = pgTable(
	'audit_log',
	{
		// mode: 'bigint' returns JavaScript bigint values, not number. That is the
		// correct choice for this project — invariant 1's habit of never letting a
		// large integer become a float starts here — but it means test assertions
		// compare against 1n, not 1. Do not "simplify" it to mode: 'number'.
		id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),

		// Required and non-nullable. There is no tenant-less audit row: an
		// unknown-email login attempt has no restaurant to belong to and is the
		// throttle's business and the server log's, never the audit log's.
		restaurantId: uuid('restaurant_id')
			.notNull()
			.references(() => restaurants.id, { onDelete: 'restrict' }),

		// Who DID it. Null for an unauthenticated or operator-script event.
		actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),

		// Who it was ABOUT. A failed login is performed by nobody and is about the
		// owner whose email was tried. Without this column the only id available is
		// the victim's, and it lands in actor_user_id — so a later "actions by
		// employee" report blames the attacked owner for the attack.
		subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'restrict' }),

		event: text('event').notNull(),
		details: jsonb('details').notNull().default({}),
		ip: text('ip'),
		userAgent: text('user_agent'),

		// WHEN THE THING HAPPENED, which is not always when the row was written.
		// Spec 6 requires offline logins to be recorded on the device and synced
		// later; without this column such a row is stamped with the sync time and the
		// real time is lost. Nothing in this plan writes a value other than "now",
		// and that is fine — the column exists so the offline plan does not have to
		// alter a table whose rows cannot be updated.
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

		// When the row was written.
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// Created now, while the table is empty. audit_log is the fastest-growing
		// table in the system from day one, and every owner-facing view of it filters
		// by restaurant and orders by time descending. Adding this later on a live
		// table needs CREATE INDEX CONCURRENTLY, which cannot run inside a
		// transaction block — and Drizzle's migrator wraps each run in one, so it
		// would become an out-of-band manual step in a maintenance window.
		index('audit_log_restaurant_created_idx').on(table.restaurantId, desc(table.createdAt))
	]
);
