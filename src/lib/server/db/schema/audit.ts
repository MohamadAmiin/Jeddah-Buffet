import { desc, sql } from 'drizzle-orm';
import {
	pgTable,
	bigint,
	uuid,
	text,
	jsonb,
	timestamp,
	index,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { users } from './users';
import { posDevices } from './pos-devices';

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
//   device_id, client_op_id — no longer on this list: they LANDED, with the
//   partial UNIQUE (device_id, client_op_id), in tasks/pos-access-and-menu T-07,
//   BEFORE the first device-sourced audit row was written — that plan's PIN
//   logins and device registration are the first such rows. The append-only
//   trigger of migration 0004_audit_log_append_only.sql blocks UPDATE and DELETE
//   but not ALTER TABLE, which is why the columns could still be added, and why
//   they had to be added before any row they deduplicate existed: a duplicate
//   written first could never be removed. See the columns and the index below.
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

		// Which registered till produced this row. Null for every dashboard event.
		// RESTRICT, like every foreign key in this schema except sessions.user_id: a
		// device that has produced an audit row can never be deleted, which is exactly
		// why pos_devices revokes with a stamp rather than a DELETE. Nullable with no
		// DEFAULT — every row written before this column existed came from the
		// dashboard and has no device.
		deviceId: uuid('device_id').references(() => posDevices.id, { onDelete: 'restrict' }),
		// The device-generated idempotency key for the operation that produced this
		// row. Null for anything the server originated.
		clientOpId: text('client_op_id'),

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
		index('audit_log_restaurant_created_idx').on(table.restaurantId, desc(table.createdAt)),

		// THE IDEMPOTENCY KEY, enforced by the database (invariant 5, spec 6). The till
		// flushes a queued offline PIN-login event, the server commits it, and the
		// response is lost on the way back. The till retries — that is what a sync
		// queue does. With no key to deduplicate on, the second insert succeeds and
		// the audit log now says the cashier signed in twice at the same instant, and
		// because 0004's trigger blocks UPDATE and DELETE that duplicate is PERMANENT:
		// it cannot be merged, edited or removed, and every later "who was on the
		// till" answer is wrong for that shift.
		//
		// Partial on client_op_id IS NOT NULL, under PostgreSQL's default NULLS
		// DISTINCT, so the server-originated rows — which carry no key — never
		// collide. Do NOT "improve" this with NULLS NOT DISTINCT: the second
		// device-less audit row of any kind would then fail. A key is unique PER
		// DEVICE, not globally, which is why the index is on the pair — and why a row
		// with a client_op_id but no device_id is never deduplicated at all.
		uniqueIndex('audit_log_device_client_op_unique')
			.on(table.deviceId, table.clientOpId)
			.where(sql`${table.clientOpId} is not null`)
	]
);
