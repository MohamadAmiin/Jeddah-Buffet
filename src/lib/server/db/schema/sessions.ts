import { pgTable, text, uuid, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

// sessions deliberately has NO restaurant_id. A session belongs to a user, the
// user belongs to a restaurant, and duplicating the tenant here would create two
// places that can disagree. T-09's schema guard lists this table as an explicit
// exemption, with this sentence as the reason.
export const sessions = pgTable(
	'sessions',
	{
		// NOT the cookie value. This is the lowercase hex SHA-256 of the random token
		// that is in the cookie, so a database leak yields hashes rather than usable
		// sessions — exactly as password hashes do. T-12 owns that derivation; the
		// schema just needs a 64-character text primary key.
		id: text('id').primaryKey(),

		// Cascade is correct HERE AND ONLY HERE: a session is not a business record,
		// and deleting a user should not leave a live session behind. Every other
		// foreign key in this plan is restrict.
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('sessions_user_id_idx').on(table.userId),
		index('sessions_expires_at_idx').on(table.expiresAt)
	]
);
