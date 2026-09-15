import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, check } from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

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
// tax_mode, tax_rate_bp and currency_code HAVE LANDED, exactly that way (T-36,
// once T-03 recorded spec 33 open decisions 3 and 4 on 2026-09-15): nullable, no
// DEFAULT, and each CHECK below lets a NULL through, because unset is legitimate
// until the owner chooses.
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
		// ONE rate per restaurant, in integer BASIS POINTS (825 = 8.25%). A rate, not
		// money, so integer — not a _minor bigint. Postgres silently rounds a decimal
		// into an integer column, so the real guards are the settings form's zod
		// .int() and updateSettings' Number.isSafeInteger check.
		taxRateBp: integer('tax_rate_bp'),
		// Spec 33 open decision 4: an ISO 4217 code the money formatter can render.
		currencyCode: text('currency_code'),
		// The menu snapshot's version (spec 5) — see the note above this table.
		menuVersion: integer('menu_version').notNull().default(1),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
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
		)
	]
);
