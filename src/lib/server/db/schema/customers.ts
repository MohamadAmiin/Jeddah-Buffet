import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	bigint,
	date,
	timestamp,
	index,
	uniqueIndex,
	unique,
	check,
	foreignKey
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { users } from './users';
import { journalEntries } from './accounting';
import { paymentMethods } from './payment-methods';
import { posSessions } from './pos-sessions';
import { posDevices } from './pos-devices';

// CUSTOMER CREDIT (tasks/customer-credit, decided 2026-11-12): a registered
// customer eats now and pays later. Accounts Receivable is on spec 31's "Later"
// list; the user chose to build it, so this is a recorded departure from the
// spec, and 1100 Accounts Receivable is the one account spec 23 does not name.
//
// A CHARGE is not in this file: it is an ordinary sale whose `payments` row has
// method 'credit' and names the customer (schema/orders.ts), recorded by THE
// payment transaction (Dr 1100 / Cr 4000, Cr 2100). This file holds who may be
// charged (`customers`) and what they paid back (`customer_payments`,
// Dr 1000 | 1020 | 1030 / Cr 1100).
//
// THE BALANCE IS NEVER STORED. What a customer owes is the sum of their credit
// `payments` minus the sum of their unreversed `customer_payments`, read with
// two scalar subqueries (src/lib/server/customers/). A stored balance would be a
// second truth beside the ledger.
//
// WRITTEN ONCE (invariant 2). A customer payment is inserted WITH its
// journal_entry_id; the only later write is the reversal group, set together,
// once (trigger customer_payments_guard, custom migration 0022). A wrong payment
// is corrected by a reversal with a reason, never an edit. Customers are
// archived, never deleted (trigger, 0022).
//
// MONEY is bigint minor units (invariant 1).

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'restrict' });
const entryRef = (name: string) =>
	uuid(name).references(() => journalEntries.id, { onDelete: 'restrict' });

export const customers = pgTable(
	'customers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		name: text('name').notNull(),
		phone: text('phone').notNull(),
		// NULL = no limit. The limit is the control that stands where an owner PIN
		// would (the user's choice, 2026-11-12); a charge that arrives over it is
		// recorded and flagged, never rejected (invariant 5).
		creditLimitMinor: bigint('credit_limit_minor', { mode: 'bigint' }),
		archivedAt: timestamp('archived_at', { withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('customers_restaurant_id_idx').on(t.restaurantId),
		// Target of the composite keys into this table — a unique CONSTRAINT, never
		// a uniqueIndex (42830).
		unique('customers_id_restaurant_unique').on(t.id, t.restaurantId),
		// One LIVE customer per phone; archiving frees the number.
		uniqueIndex('customers_phone_unique')
			.on(t.restaurantId, t.phone)
			.where(sql`${t.archivedAt} is null`),
		check(
			'customers_name_valid',
			sql`char_length(${t.name}) between 1 and 80 and ${t.name} !~ '[[:cntrl:]]'`
		),
		check(
			'customers_phone_valid',
			sql`char_length(${t.phone}) between 3 and 32 and ${t.phone} !~ '[[:cntrl:]]'`
		),
		check(
			'customers_credit_limit_minor_non_negative',
			sql`${t.creditLimitMinor} is null or ${t.creditLimitMinor} >= 0`
		)
	]
);

export const customerPayments = pgTable(
	'customer_payments',
	{
		// Device-generated (the op's paymentId), so a replayed op finds its row.
		id: uuid('id').primaryKey(),
		restaurantId: tenant(),
		customerId: uuid('customer_id').notNull(),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		// The KIND: cash, card or mobile — never credit. Its own pinned list.
		method: text('method').notNull(),
		paymentMethodId: uuid('payment_method_id').notNull(),
		paymentMethodName: text('payment_method_name').notNull(),
		// Cash only, as on payments.
		tenderedMinor: bigint('tendered_minor', { mode: 'bigint' }),
		changeMinor: bigint('change_minor', { mode: 'bigint' }),
		// What the customer still owed after this payment, computed once under the
		// customer lock. The receipt and every replayed answer read it from here.
		balanceAfterMinor: bigint('balance_after_minor', { mode: 'bigint' }).notNull(),
		posSessionId: uuid('pos_session_id').notNull(),
		deviceId: uuid('device_id')
			.notNull()
			.references(() => posDevices.id, { onDelete: 'restrict' }),
		recordedByUserId: userRef('recorded_by_user_id').notNull(),
		// The shift's business date (invariant 11), never created_at::date.
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		// Device time of the tap.
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
		createdAt: createdAt(),
		journalEntryId: entryRef('journal_entry_id').notNull(),
		// The reversal group: all NULL, or all set, once.
		reversedAt: timestamp('reversed_at', { withTimezone: true }),
		reversedByUserId: userRef('reversed_by_user_id'),
		reversalReason: text('reversal_reason'),
		reversalEntryId: entryRef('reversal_entry_id'),
		// A cash reversal carries its shift's business date (the shift is open by
		// rule); a card or mobile reversal the day it is made.
		reversalBusinessDate: date('reversal_business_date', { mode: 'string' })
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.customerId],
			foreignColumns: [customers.restaurantId, customers.id],
			name: 'customer_payments_customer_fk'
		}).onDelete('restrict'),
		// The KIND on the payment must be the kind of the method row it names.
		foreignKey({
			columns: [t.restaurantId, t.paymentMethodId, t.method],
			foreignColumns: [paymentMethods.restaurantId, paymentMethods.id, paymentMethods.kind],
			name: 'customer_payments_payment_method_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [t.restaurantId, t.posSessionId],
			foreignColumns: [posSessions.restaurantId, posSessions.id],
			name: 'customer_payments_session_fk'
		}).onDelete('restrict'),
		// The balance read: every payment of one customer.
		index('customer_payments_customer_idx').on(t.restaurantId, t.customerId),
		// Expected cash at shift close.
		index('customer_payments_session_idx').on(t.posSessionId),
		// "Customer payments received" by business date.
		index('customer_payments_business_date_idx').on(t.restaurantId, t.businessDate),
		check('customer_payments_amount_positive', sql`${t.amountMinor} > 0`),
		check('customer_payments_method_valid', sql`${t.method} in ('cash', 'card', 'mobile')`),
		check(
			'customer_payments_payment_method_name_length',
			sql`char_length(${t.paymentMethodName}) between 1 and 40`
		),
		check(
			'customer_payments_cash_fields',
			sql`(${t.method} = 'cash' and ${t.tenderedMinor} is not null and ${t.changeMinor} is not null and ${t.tenderedMinor} >= ${t.amountMinor} and ${t.changeMinor} = ${t.tenderedMinor} - ${t.amountMinor}) or (${t.method} <> 'cash' and ${t.tenderedMinor} is null and ${t.changeMinor} is null)`
		),
		check('customer_payments_balance_after_non_negative', sql`${t.balanceAfterMinor} >= 0`),
		check(
			'customer_payments_reversal_fields',
			sql`(${t.reversedAt} is null) = (${t.reversedByUserId} is null) and (${t.reversedAt} is null) = (${t.reversalReason} is null) and (${t.reversedAt} is null) = (${t.reversalEntryId} is null) and (${t.reversedAt} is null) = (${t.reversalBusinessDate} is null) and (${t.reversalReason} is null or char_length(btrim(${t.reversalReason})) between 3 and 200)`
		)
	]
);
