import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// One settings row per restaurant, so the foreign key IS the primary key.
//
// WHAT MUST NOT BE ADDED HERE, AND WHY
// ------------------------------------
// Tax mode, tax rate and currency arrive in their own task (tasks/pos-access-and-
// menu T-36), now that spec 33 open decisions 3 and 4 have recorded answers in
// CLAUDE.md; approval limits are still open decision 6. None of them lands here
// ahead of that task, and none ever lands "with a sensible default": CLAUDE.md
// forbids baking an answer into the schema, and a migration that has run cannot
// be hand-edited back (invariant 2).
//
// When they do arrive they land NULLABLE, with POS session-open gated on
// settingsComplete(), never with a column DEFAULT — a DEFAULT silently answers
// the open decision for every restaurant already registered, and the owner who
// never visited the settings page would open their first session with a tax mode
// nobody chose.
//
// pos_idle_lock_seconds HAS LANDED, exactly that way (T-08, per the decision
// recorded on 2026-09-15): NULLABLE, with NO column DEFAULT and no fallback number
// in code either — a fallback is a column default wearing a disguise. Spec 7's
// "default 2 minutes" is the value an owner would type, not one the system
// assumes. settingsComplete() reports it missing until the owner sets it, and
// updateSettings() is its one audited writer, bounded 30–1800 seconds.
//
// onDelete: 'restrict' throughout this plan: a restaurant with any history must
// not be deletable, because audit rows reference it and those are append-only.
export const restaurantSettings = pgTable('restaurant_settings', {
	restaurantId: uuid('restaurant_id')
		.primaryKey()
		.references(() => restaurants.id, { onDelete: 'restrict' }),
	timeZone: text('time_zone').notNull(),
	// Seconds of inactivity before the POS returns to employee-select (spec 7).
	// Null until the owner chooses — deliberately, see above.
	posIdleLockSeconds: integer('pos_idle_lock_seconds'),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
