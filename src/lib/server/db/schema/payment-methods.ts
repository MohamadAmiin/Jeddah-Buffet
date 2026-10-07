import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	integer,
	boolean,
	timestamp,
	index,
	uniqueIndex,
	unique,
	check
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// PAYMENT METHODS per restaurant (spec 24, 26, 33 open decision 4;
// tasks/settings-tax-payments-receipt): OWNER-NAMED methods — EVC Plus, Zaad,
// eDahab, a card terminal — plus ONE built-in Cash row.
//
// THE KIND IS FIXED. It decides the ledger account through the spec 24 posting
// rules — cash → Dr 1000 Cash on Hand, card → Dr 1020 Payment Clearing – Card,
// mobile → Dr 1030 Payment Clearing – Mobile Money, with EVERY mobile method on
// 1030 and no per-provider account (per-provider totals come from
// payments.payment_method_id) — and the offline rule: only cash sells offline
// (invariant 5). The trigger payment_methods_kind_immutable (migration 0017,
// T-07) refuses a change of kind, so editing a method can never relabel the
// posted sales taken with it.
//
// KIND 'cash' IS RESERVED to the one built-in row. payment_methods_one_cash
// allows one per restaurant, and payment_methods_cash_rules keeps it enabled,
// live and without a merchant number. Owners create only 'card' or 'mobile': a
// cash-kind "EVC Plus" would sell offline, open the drawer, post Dr 1000 and
// short the drawer at close (6800 Cash Over/Short).
//
// ARCHIVED, NEVER DELETED (invariants 2 and 5). A pending card or mobile sale
// replaying after an edit must still resolve its method. The BEFORE DELETE
// trigger payment_methods_archive_only arrives in migration 0017 (T-07), and the
// foreign key into this table — payments_payment_method_fk — is ON DELETE
// RESTRICT.
//
// enabled has NO DEFAULT: every insert states it (Cash is always true — see
// payment_methods_cash_rules).
//
// The three kind literals are PAYMENT_METHODS in src/lib/sync-ops/index.ts,
// spelled identically and NOT imported: drizzle-kit loads this file outside
// Vite, the same reason restaurant-settings.ts gives for TAX_MODES. T-06's test
// pins the two lists together.
//
// There is NO bank-transfer kind (spec 24 has no row that debits 1010 Bank for a
// sale): a bank-run wallet is set up as a 'mobile' method.
//
// THE NAME AND THE MERCHANT NUMBER PRINT ON RECEIPTS, which is why their CHECKs
// refuse control characters (!~ '[[:cntrl:]]'): an ESC (0x1B) could start the
// drawer pulse ESC p on the printer, opening the drawer without a sale
// (invariant 9).

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const paymentMethods = pgTable(
	'payment_methods',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		name: text('name').notNull(),
		kind: text('kind').notNull(),
		merchantNumber: text('merchant_number'),
		// NO default: every insert states it (Cash is always true — see the CHECK).
		enabled: boolean('enabled').notNull(),
		sortOrder: integer('sort_order').notNull().default(0),
		archivedAt: archivedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('payment_methods_restaurant_id_idx').on(t.restaurantId),
		unique('payment_methods_id_restaurant_unique').on(t.id, t.restaurantId),
		// Target of payments_payment_method_fk — a unique CONSTRAINT, never uniqueIndex (42830).
		unique('payment_methods_id_restaurant_kind_unique').on(t.id, t.restaurantId, t.kind),
		uniqueIndex('payment_methods_one_cash')
			.on(t.restaurantId)
			.where(sql`${t.kind} = 'cash'`),
		uniqueIndex('payment_methods_name_unique')
			.on(t.restaurantId, sql`lower(${t.name})`)
			.where(sql`${t.archivedAt} is null`),
		check('payment_methods_kind_valid', sql`${t.kind} in ('cash', 'card', 'mobile')`),
		check(
			'payment_methods_name_valid',
			sql`char_length(${t.name}) between 1 and 40 and ${t.name} !~ '[[:cntrl:]]'`
		),
		check(
			'payment_methods_merchant_number_valid',
			sql`${t.merchantNumber} is null or (char_length(${t.merchantNumber}) between 1 and 40 and ${t.merchantNumber} !~ '[[:cntrl:]]')`
		),
		check(
			'payment_methods_cash_rules',
			sql`${t.kind} <> 'cash' or (${t.enabled} and ${t.archivedAt} is null and ${t.merchantNumber} is null)`
		)
	]
);
