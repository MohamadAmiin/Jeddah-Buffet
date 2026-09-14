import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

// The tenant. Every other table in this system carries restaurant_id NOT NULL and
// every server module takes restaurantId as an explicit parameter — there is no
// ambient tenant. That is what makes row-level security a later migration rather
// than a rewrite.
//
// There is deliberately NO `status` column. Restaurant suspension belongs to a
// SaaS variant the user did not choose, and an inert enum nobody sets is worse
// than no column at all.
export const restaurants = pgTable('restaurants', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
