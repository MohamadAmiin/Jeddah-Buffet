import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	bigint,
	integer,
	date,
	timestamp,
	index,
	uniqueIndex,
	unique,
	check,
	foreignKey,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// SPEC 22/24: three tables — a per-restaurant chart of accounts and the paired
// journal_entries / journal_entry_lines. Entries are generated from business
// events by the spec 24 posting-rule table (src/lib/server/accounting/posting-
// rules.ts, T-13) and written by the journal writer (T-14) — nobody types a
// debit by hand.
//
// INVARIANT 3 (journal entries balance in the database, checked AT COMMIT)
// is NOT enforced in THIS file: drizzle-kit cannot express a CONSTRAINT
// TRIGGER … DEFERRABLE INITIALLY DEFERRED, so the balance trigger arrives in
// custom migration 0012 (T-09). The CHECKs below guarantee each line is well-
// formed (non-negative and exactly one side); the balance itself is proven at
// COMMIT by 0012.
//
// INVARIANT 2 (posted records are permanent): the append-only triggers that
// forbid UPDATE and DELETE on both tables also arrive in migration 0012. In
// application code, a repair script or a future migration NOTHING is allowed
// to UPDATE or DELETE a row of journal_entries or journal_entry_lines — a
// mistake is corrected with a REVERSING entry plus a new correct one.
//
// MONEY is integer minor units in bigint mode 'bigint' (invariant 1):
// debit_minor 1100 is $11.00. src/lib/server/db/client.ts installs no type
// parsers, so pg hands int8 back as a string and mode 'bigint' makes it a
// JavaScript bigint. Money in any other type is forbidden by the schema guard
// in schema.test.ts, which keys on the _minor suffix.
//
// reverses_entry_id points a reversing entry at the entry it cancels. It is
// written ONLY by postReversal (src/lib/server/accounting/journal.ts,
// tasks/inventory-cogs T-14), and the partial unique index
// journal_entries_reverses_entry_unique allows exactly one reversal per entry,
// so a double-submitted reversal fails with 23505. ON DELETE RESTRICT so the
// target cannot vanish.
//
// Every value set is text + a named CHECK, never a Postgres enum: adding a
// value later is one reversible constraint swap (DROP / ADD CONSTRAINT), and
// the repo already paid once for the enum rebuild in migration 0010.

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const accounts = pgTable(
	'accounts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		// Spec 23's four-digit code, e.g. '1000'. Text, so '1000' never becomes 1000.
		code: text('code').notNull(),
		name: text('name').notNull(),
		type: text('type').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		// Target of ON CONFLICT (restaurant_id, code) DO NOTHING in ensureChart (T-12)
		// and the 0012 backfill (T-09).
		unique('accounts_restaurant_code_unique').on(t.restaurantId, t.code),
		// Target of journal_entry_lines_account_fk — a UNIQUE CONSTRAINT, not an index.
		unique('accounts_id_restaurant_unique').on(t.id, t.restaurantId),
		index('accounts_restaurant_id_idx').on(t.restaurantId),
		check('accounts_code_format', sql`${t.code} ~ '^[0-9]{4}$'`),
		check(
			'accounts_type_valid',
			sql`${t.type} in ('asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense')`
		)
	]
);

export const journalEntries = pgTable(
	'journal_entries',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		// The POS session's business date (invariant 11), passed in by the writer —
		// never created_at::date.
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		// The spec 24 business event that generated the entry. The literals are
		// POSTING_EVENTS in src/lib/server/accounting/posting-rules.ts (T-13); the
		// constraints test pins the two lists together.
		event: text('event').notNull(),
		sourceType: text('source_type').notNull(),
		// The order or POS session the entry came from. No FK: the source lives in a
		// different aggregate and an entry must outlive any later change to it.
		sourceId: uuid('source_id').notNull(),
		memo: text('memo').notNull(),
		// Written only by postReversal (T-14); one reversal per entry.
		reversesEntryId: uuid('reverses_entry_id').references((): AnyPgColumn => journalEntries.id, {
			onDelete: 'restrict'
		}),
		postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
		createdAt: createdAt()
	},
	(t) => [
		// Target of journal_entry_lines_entry_fk.
		unique('journal_entries_id_restaurant_unique').on(t.id, t.restaurantId),
		index('journal_entries_restaurant_business_date_idx').on(t.restaurantId, t.businessDate),
		index('journal_entries_source_idx').on(t.sourceType, t.sourceId),
		check(
			'journal_entries_event_valid',
			sql`${t.event} in ('cash_sale', 'card_sale', 'mobile_sale', 'cost_of_goods_sold', 'cash_shortage_at_close', 'cash_overage_at_close', 'purchase_paid', 'purchase_on_credit', 'supplier_paid', 'waste', 'stock_count_shortfall', 'stock_count_surplus', 'inventory_revaluation', 'opening_stock')`
		),
		check(
			'journal_entries_source_type_valid',
			sql`${t.sourceType} in ('order', 'pos_session', 'purchase', 'supplier_payment', 'waste_entry', 'stock_count', 'opening_stock')`
		),
		// One reversal per entry: a double-submitted reversal fails with 23505.
		uniqueIndex('journal_entries_reverses_entry_unique')
			.on(t.reversesEntryId)
			.where(sql`${t.reversesEntryId} is not null`)
	]
);

export const journalEntryLines = pgTable(
	'journal_entry_lines',
	{
		id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
		restaurantId: tenant(),
		entryId: uuid('entry_id').notNull(),
		accountId: uuid('account_id').notNull(),
		lineNo: integer('line_no').notNull(),
		// Exactly one of the two is positive (journal_entry_lines_one_side). Minor
		// units in bigint (invariant 1). sql`0`, not 0n — see the phase idioms.
		debitMinor: bigint('debit_minor', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		creditMinor: bigint('credit_minor', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.entryId],
			foreignColumns: [journalEntries.restaurantId, journalEntries.id],
			name: 'journal_entry_lines_entry_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [t.restaurantId, t.accountId],
			foreignColumns: [accounts.restaurantId, accounts.id],
			name: 'journal_entry_lines_account_fk'
		}).onDelete('restrict'),
		unique('journal_entry_lines_entry_line_no_unique').on(t.entryId, t.lineNo),
		index('journal_entry_lines_account_idx').on(t.accountId),
		index('journal_entry_lines_entry_idx').on(t.entryId),
		check('journal_entry_lines_non_negative', sql`${t.debitMinor} >= 0 and ${t.creditMinor} >= 0`),
		check('journal_entry_lines_one_side', sql`(${t.debitMinor} = 0) <> (${t.creditMinor} = 0)`)
	]
);
