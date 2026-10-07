import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	integer,
	timestamp,
	index,
	uniqueIndex,
	unique,
	check
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// NAMED TAX RATES per restaurant (spec 17; tasks/settings-tax-payments-receipt):
// "VAT 5%", "Exempt 0%", "Alcohol duty 15%". ONE tax per order line — rates are
// never stacked; a line is taxed at exactly one of these.
//
// rate_bp is integer BASIS POINTS (825 = 8.25%), a rate and not money, so an
// integer and never a float or a fraction (invariant 1). 0 is a legitimate rate:
// "no tax charged" is a choice the owner makes, not an absence.
//
// THE DEFAULT IS NOT A COLUMN HERE. It is the single pointer
// restaurant_settings.default_tax_rate_id, so the database cannot hold two
// defaults — a boolean "is_default" flag could be true on two rows at once.
//
// NO RATE IS EVER SEEDED OR ASSUMED. Registration creates none, and a NULL
// default_tax_rate_id means the owner has not chosen; settingsComplete() reports
// it missing. A silent 0% default would post sales with no tax that no reversing
// entry could recover.
//
// ARCHIVED, NEVER DELETED (invariants 2 and 5). A rate id a till cached last week
// must still resolve when its offline sale syncs. The BEFORE DELETE trigger
// tax_rates_archive_only arrives in migration 0017 (T-07), and every foreign key
// into this table — menu_items_tax_rate_fk, restaurant_settings_default_tax_rate_fk,
// order_lines_tax_rate_fk — is a composite (restaurant_id, id) key ON DELETE
// RESTRICT.
//
// EVERY WRITE BUMPS restaurant_settings.menu_version in the same transaction
// (T-10), because a rate reaches the till inside the versioned menu snapshot
// (spec 5); a till holding an old rate would send every later sale as a HARD
// price_tamper.
//
// THE NAME PRINTS ON RECEIPTS, which is why tax_rates_name_valid refuses control
// characters (!~ '[[:cntrl:]]'): an ESC (0x1B) in a name could start the drawer
// pulse ESC p on the printer, opening the drawer without a sale (invariant 9).

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const taxRates = pgTable(
	'tax_rates',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		name: text('name').notNull(),
		rateBp: integer('rate_bp').notNull(),
		sortOrder: integer('sort_order').notNull().default(0),
		archivedAt: archivedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('tax_rates_restaurant_id_idx').on(t.restaurantId),
		// Target of menu_items_tax_rate_fk, restaurant_settings_default_tax_rate_fk and
		// order_lines_tax_rate_fk — a unique CONSTRAINT, never uniqueIndex (42830).
		unique('tax_rates_id_restaurant_unique').on(t.id, t.restaurantId),
		uniqueIndex('tax_rates_name_unique')
			.on(t.restaurantId, sql`lower(${t.name})`)
			.where(sql`${t.archivedAt} is null`),
		check(
			'tax_rates_name_valid',
			sql`char_length(${t.name}) between 1 and 40 and ${t.name} !~ '[[:cntrl:]]'`
		),
		check('tax_rates_rate_bp_range', sql`${t.rateBp} between 0 and 10000`)
	]
);
