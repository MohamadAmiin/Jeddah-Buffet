import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	integer,
	boolean,
	timestamp,
	check,
	foreignKey
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { taxRates } from './tax-rates';

// One settings row per restaurant, so the foreign key IS the primary key.
//
// WHAT MUST NOT BE ADDED HERE, AND WHY
// ------------------------------------
// No setting lands "with a sensible default": CLAUDE.md forbids baking an answer
// into the schema, and a migration that has run cannot be hand-edited back
// (invariant 2). Approval limits are still open decision 6 and do not land here.
//
// A setting that answers a decision lands NULLABLE, with POS session-open gated on
// settingsComplete(), never with a column DEFAULT — a DEFAULT silently answers
// the decision for every restaurant already registered, and the owner who never
// visited the settings page would open their first session with a tax mode nobody
// chose.
//
// tax_mode, default_tax_rate_id and currency_code HAVE LANDED, exactly that way:
// nullable, no DEFAULT, no fallback in code, and each CHECK below lets a NULL
// through, because unset is legitimate until the owner chooses. tax_mode and
// currency_code landed with T-36 once T-03 recorded spec 33 open decisions 3 and
// 4 on 2026-09-15; default_tax_rate_id lands exactly like tax_mode
// (tasks/settings-tax-payments-receipt T-03): it points at the owner's DEFAULT
// named rate in tax_rates, NULL means the owner has not chosen, and from T-13
// settingsComplete() reports 'tax rate' until a default is set.
//
// tax_rate_bp is RETIRED (tasks/settings-tax-payments-receipt): migration 0017
// copies an existing value into the default named rate "Tax", and T-33 drops the
// column in migration 0018.
//
// pos_idle_lock_seconds HAS LANDED, exactly that way (T-08, per the decision
// recorded on 2026-09-15): NULLABLE, with NO column DEFAULT and no fallback number
// in code either — a fallback is a column default wearing a disguise. Spec 7's
// "default 2 minutes" is the value an owner would type, not one the system
// assumes. settingsComplete() reports it missing until the owner sets it, and
// updateSettings() is its one audited writer, bounded 30–1800 seconds.
//
// menu_version is NOT covered by the rule above, and its DEFAULT 1 is not a
// "sensible default" in that sense (T-37). That rule forbids a default that
// silently answers an open decision — tax, currency, approval limits, the idle
// lock. A menu version answers no decision: it is the counter the POS compares
// against /api/menu/version (spec 5), a NULL version would mean nothing, and every
// restaurant starts at 1. It lives on this row rather than on restaurants because
// restaurants holds identity — the name on receipts, the "opened on" date — and a
// counter bumped on every price edit would make restaurants.updated_at stop
// meaning "the restaurant record changed"; this row is already the restaurant's
// mutable operational state, and spec 4 lists restaurant settings beside the menu
// as what the POS caches. The menu module bumps it IN SQL, in the same transaction
// as every menu write, and never touches updated_at, which pairs with the
// settings.updated audit event.
//
// RECEIPT HEADER TEXT (tasks/menu-and-printing T-20): receipt_address,
// receipt_phone, tax_registration_number and receipt_footer are OPTIONAL text
// the owner may print on every receipt. They are not decisions, so
// settingsComplete() does not report them; spec 33 open decision 3 (what a
// receipt must legally show) is STILL OPEN, and these four are the default
// layout's fields pending a local accountant — a legal requirement changes
// src/lib/pos/receipt.ts and these settings, not the ledger. Nullable, no
// DEFAULT, bounded by the CHECKs below; written only by updateSettings.
// tax_registration_number is an identifier, not money: schema.test.ts
// exempts it from the money-name rule by name.
//
// onDelete: 'restrict' throughout this plan: a restaurant with any history must
// not be deletable, because audit rows reference it and those are append-only.
export const restaurantSettings = pgTable(
	'restaurant_settings',
	{
		restaurantId: uuid('restaurant_id')
			.primaryKey()
			.references(() => restaurants.id, { onDelete: 'restrict' }),
		timeZone: text('time_zone').notNull(),
		// Seconds of inactivity before the POS returns to employee-select (spec 7).
		// Null until the owner chooses — deliberately, see above.
		posIdleLockSeconds: integer('pos_idle_lock_seconds'),
		// Spec 17 and spec 33 open decision 3: the owner picks 'exclusive' or
		// 'inclusive'; nothing hardcodes one.
		taxMode: text('tax_mode'),
		// RETIRED: the old single rate in integer basis points. 0017 copies an
		// existing value into the default named rate "Tax"; T-33 drops the column.
		taxRateBp: integer('tax_rate_bp'),
		// The owner's DEFAULT named rate (tax_rates). NULL = not chosen yet — no
		// DEFAULT and no fallback, like tax_mode; see the note above this table.
		defaultTaxRateId: uuid('default_tax_rate_id'),
		// Spec 33 open decision 4: an ISO 4217 code the money formatter can render.
		currencyCode: text('currency_code'),
		// RETIRED: both columns are REPLACED by payment_methods
		// (tasks/settings-tax-payments-receipt) — owner-named methods, each with a
		// fixed kind 'card' or 'mobile', beside one built-in Cash row. Migration
		// 0017 turns a true into one enabled method of that kind (NULL or false
		// into nothing), T-33 drops both columns in migration 0018, and no new
		// code may read them.
		acceptsCard: boolean('accepts_card'),
		acceptsMobile: boolean('accepts_mobile'),
		// Receipt header text (T-20) — optional, nullable, no default; see above.
		receiptAddress: text('receipt_address'),
		receiptPhone: text('receipt_phone'),
		taxRegistrationNumber: text('tax_registration_number'),
		receiptFooter: text('receipt_footer'),
		// The menu snapshot's version (spec 5) — see the note above this table.
		menuVersion: integer('menu_version').notNull().default(1),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		foreignKey({
			columns: [table.restaurantId, table.defaultTaxRateId],
			foreignColumns: [taxRates.restaurantId, taxRates.id],
			name: 'restaurant_settings_default_tax_rate_fk'
		}).onDelete('restrict'),
		// The two literals are TAX_MODES in src/lib/money/tax.ts, spelled identically.
		// Not imported: drizzle-kit loads this file outside Vite and cannot resolve
		// $lib. constraints.integration.test.ts pins the two lists together.
		check(
			'restaurant_settings_tax_mode_valid',
			sql`${table.taxMode} is null or ${table.taxMode} in ('exclusive', 'inclusive')`
		),
		check(
			'restaurant_settings_tax_rate_bp_range',
			sql`${table.taxRateBp} is null or (${table.taxRateBp} >= 0 and ${table.taxRateBp} <= 10000)`
		),
		check(
			'restaurant_settings_currency_code_format',
			sql`${table.currencyCode} is null or ${table.currencyCode} ~ '^[A-Z]{3}$'`
		),
		// Receipt text: NULL or 1..N characters — an empty string is not a value.
		check(
			'restaurant_settings_receipt_address_length',
			sql`${table.receiptAddress} is null or char_length(${table.receiptAddress}) between 1 and 120`
		),
		check(
			'restaurant_settings_receipt_phone_length',
			sql`${table.receiptPhone} is null or char_length(${table.receiptPhone}) between 1 and 40`
		),
		check(
			'restaurant_settings_tax_registration_number_length',
			sql`${table.taxRegistrationNumber} is null or char_length(${table.taxRegistrationNumber}) between 1 and 40`
		),
		check(
			'restaurant_settings_receipt_footer_length',
			sql`${table.receiptFooter} is null or char_length(${table.receiptFooter}) between 1 and 120`
		)
	]
);
