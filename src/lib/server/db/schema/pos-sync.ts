import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	integer,
	bigint,
	jsonb,
	timestamp,
	index,
	uniqueIndex,
	check
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { posDevices } from './pos-devices';
import { users } from './users';

// The sync log — NOT one of invariant 2's posted records. status, flag,
// error, resolved_at, resolved_by_user_id and resolution are UPDATED by the
// owner's retry and dismiss actions (retryOp, dismissOp in T-21) and by
// nothing else; the append-only triggers of migration 0012 (T-09)
// deliberately do NOT cover this table.
//
// payload is kept for ever, so a sale that failed validation is never lost
// (spec 6: "stored and flagged for owner review, never discarded"). A retry
// replays it under the SAME client_op_id.
//
// The payload NEVER contains a PIN: the pin.login op carries only
// { outcome: 'success' | 'failed' } and the envelope's employeeId. A PIN
// reaching this column would be a PIN in the database in clear (invariant 12).
//
// (device_id, client_op_id) is THE idempotency key (invariant 5, spec 6):
// the handler looks it up first and replays the stored result, and the
// unique index catches a racing retry (SQLSTATE 23505 → replay).
//
// client_op_id is typed uuid — the till and the existing PIN page generate
// keys with crypto.randomUUID() — while the wire's OpEnvelope.clientOpId is
// a string. T-21 (handleOp) and T-27 (POST /api/pos/sync) MUST validate
// clientOpId AND deviceId as UUIDs (see UUID pattern in T-21) BEFORE touching
// pos_sync_ops, and answer 400 {error:'invalid_request'} otherwise — an
// envelope the server cannot key, the same class as a missing clientOpId or
// kind. Without that check a crafted non-UUID key would fail the op-row
// insert itself with SQLSTATE 22P02, so the op could not be stored even as
// 'unrecorded'.
//
// device_id is the device the op was STAMPED with, which may be revoked —
// after a revoke-and-re-register the successor's cookie flushes ops stamped
// with the old device, and the server records them under that device (its
// invoice namespace); received_via_device_id is the cookie's device.
//
// pos_session_id, order_id, invoice_seq and invoice_number are extracted
// from the payload AT RECEIPT so the review page (T-37), the session-close
// guard (T-20 detects an 'unrecorded' op that references the session and
// returns a typed refusal; T-21/T-27 answer 409
// {error:'session_has_unrecorded_ops', count}) and the invoice hint (T-28:
// max(invoice_seq) over all statuses) need no jsonb queries. They have NO
// foreign keys because an 'unrecorded' op names an order or session that
// was never written.
//
// status values: 'accepted' (recorded clean), 'recorded_flagged' (recorded
// in full with a soft flag in flag), 'unrecorded' (a hard failure; payload
// only; error says why).

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const posSyncOps = pgTable(
	'pos_sync_ops',
	{
		id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
		restaurantId: tenant(),
		deviceId: uuid('device_id')
			.notNull()
			.references(() => posDevices.id, { onDelete: 'restrict' }),
		receivedViaDeviceId: uuid('received_via_device_id')
			.notNull()
			.references(() => posDevices.id, { onDelete: 'restrict' }),
		clientOpId: uuid('client_op_id').notNull(),
		kind: text('kind').notNull(),
		employeeUserId: uuid('employee_user_id').references(() => users.id, { onDelete: 'restrict' }),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		status: text('status').notNull(),
		flag: text('flag'),
		error: text('error'),
		payload: jsonb('payload').notNull(),
		posSessionId: uuid('pos_session_id'),
		orderId: uuid('order_id'),
		invoiceSeq: integer('invoice_seq'),
		invoiceNumber: text('invoice_number'),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
			onDelete: 'restrict'
		}),
		resolution: text('resolution'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		// THE idempotency key. Not partial: client_op_id is NOT NULL here, unlike audit_log's.
		uniqueIndex('pos_sync_ops_device_client_op_unique').on(t.deviceId, t.clientOpId),
		// The review page's list: everything not clean and not yet resolved, newest last.
		index('pos_sync_ops_restaurant_unresolved_idx')
			.on(t.restaurantId, t.receivedAt)
			.where(sql`${t.status} <> 'accepted' and ${t.resolvedAt} is null`),
		index('pos_sync_ops_session_idx').on(t.posSessionId),
		index('pos_sync_ops_device_invoice_seq_idx').on(t.deviceId, t.invoiceSeq),
		check(
			'pos_sync_ops_kind_valid',
			sql`${t.kind} in ('session.open', 'session.close', 'sale.complete', 'sale.abandoned', 'pin.login')`
		),
		check(
			'pos_sync_ops_status_valid',
			sql`${t.status} in ('accepted', 'recorded_flagged', 'unrecorded')`
		),
		check(
			'pos_sync_ops_resolution_valid',
			sql`${t.resolution} is null or ${t.resolution} in ('retried', 'dismissed')`
		)
	]
);
