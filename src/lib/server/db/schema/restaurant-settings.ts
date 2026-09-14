import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// One settings row per restaurant, so the foreign key IS the primary key.
//
// WHAT MUST NOT BE ADDED HERE, AND WHY
// ------------------------------------
// Tax mode, tax rate, currency, approval limits and idle-lock seconds are spec 33
// OPEN DECISIONS 3, 4 and 6. CLAUDE.md forbids baking an answer to an open
// decision into the schema, and a migration that has run cannot be hand-edited
// back (invariant 2). Do not add them here "with a sensible default".
//
// When they do arrive they land NULLABLE, with POS session-open gated on
// settingsComplete(), never with a column DEFAULT — a DEFAULT silently answers
// the open decision for every restaurant already registered, and the owner who
// never visited the settings page would open their first session with a tax mode
// nobody chose.
//
// onDelete: 'restrict' throughout this plan: a restaurant with any history must
// not be deletable, because audit rows reference it and those are append-only.
export const restaurantSettings = pgTable('restaurant_settings', {
	restaurantId: uuid('restaurant_id')
		.primaryKey()
		.references(() => restaurants.id, { onDelete: 'restrict' }),
	timeZone: text('time_zone').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
