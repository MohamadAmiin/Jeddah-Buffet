import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';

// A constraint that exists only in a schema file proves nothing. These assertions
// run real inserts against the real database and check the ERROR, not merely that
// something threw — otherwise a test passes because an unrelated failure happened
// first.
//
// Connects with TEST_DATABASE_URL (the owner), like the rest of the integration
// project. The per-test truncate in integration-setup.ts gives each case a clean
// slate.
const pool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await pool.end();
});

/** Run SQL and return the PostgreSQL error, failing if it unexpectedly succeeded. */
async function expectError(sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
	try {
		await pool.query(sql, params);
	} catch (error) {
		return error as pg.DatabaseError;
	}
	throw new Error(`Expected this statement to be rejected, but it succeeded:\n${sql}`);
}

async function makeRestaurant(name = 'Cafe One'): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		'insert into restaurants (name) values ($1) returning id',
		[name]
	);
	return rows[0].id;
}

async function makeOwner(restaurantId: string, email: string): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into users (restaurant_id, role, display_name, email, password_hash)
		 values ($1, 'owner', 'Owner', $2, 'not-a-real-hash') returning id`,
		[restaurantId, email]
	);
	return rows[0].id;
}

describe('users constraints', () => {
	it('rejects two emails differing only in case (lower(email) unique index)', async () => {
		const a = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		await makeOwner(a, 'Owner@Cafe.com');

		const error = await expectError(
			`insert into users (restaurant_id, role, display_name, email, password_hash)
			 values ($1, 'owner', 'Owner', 'owner@cafe.com', 'not-a-real-hash')`,
			[b]
		);
		expect(error.constraint).toBe('users_email_lower_unique');
	});

	it('rejects a second owner in the same restaurant (spec 31)', async () => {
		const restaurantId = await makeRestaurant();
		await makeOwner(restaurantId, 'first@cafe.com');

		const error = await expectError(
			`insert into users (restaurant_id, role, display_name, email, password_hash)
			 values ($1, 'owner', 'Second Owner', 'second@cafe.com', 'not-a-real-hash')`,
			[restaurantId]
		);
		expect(error.constraint).toBe('users_one_owner_per_restaurant');
	});

	it('rejects an owner with no email', async () => {
		const restaurantId = await makeRestaurant();
		const error = await expectError(
			`insert into users (restaurant_id, role, display_name, email, password_hash)
			 values ($1, 'owner', 'Owner', null, 'not-a-real-hash')`,
			[restaurantId]
		);
		expect(error.constraint).toBe('users_owner_has_credentials');
	});

	it('rejects an owner with no password hash', async () => {
		const restaurantId = await makeRestaurant();
		const error = await expectError(
			`insert into users (restaurant_id, role, display_name, email, password_hash)
			 values ($1, 'owner', 'Owner', 'owner@cafe.com', null)`,
			[restaurantId]
		);
		expect(error.constraint).toBe('users_owner_has_credentials');
	});

	// This is the constraint that stops a later Employees plan quietly giving a
	// cashier a password, which any route guarded only by "is there a session"
	// would then accept.
	it('rejects a cashier that has an email', async () => {
		const restaurantId = await makeRestaurant();
		const error = await expectError(
			`insert into users (restaurant_id, role, display_name, email, password_hash)
			 values ($1, 'cashier', 'Cashier', 'cashier@cafe.com', null)`,
			[restaurantId]
		);
		expect(error.constraint).toBe('users_non_owner_has_no_credentials');
	});

	it('rejects a waiter that has a password hash', async () => {
		const restaurantId = await makeRestaurant();
		const error = await expectError(
			`insert into users (restaurant_id, role, display_name, email, password_hash)
			 values ($1, 'waiter', 'Waiter', null, 'not-a-real-hash')`,
			[restaurantId]
		);
		expect(error.constraint).toBe('users_non_owner_has_no_credentials');
	});

	it('accepts a cashier with neither email nor password hash', async () => {
		const restaurantId = await makeRestaurant();
		const { rowCount } = await pool.query(
			`insert into users (restaurant_id, role, display_name) values ($1, 'cashier', 'Cashier')`,
			[restaurantId]
		);
		expect(rowCount).toBe(1);
	});
});

describe('referential integrity', () => {
	it('refuses to delete a restaurant that has a user', async () => {
		const restaurantId = await makeRestaurant();
		await makeOwner(restaurantId, 'owner@cafe.com');
		const error = await expectError('delete from restaurants where id = $1', [restaurantId]);
		expect(error.code).toBe('23503'); // foreign_key_violation
		expect(error.constraint).toBe('users_restaurant_id_restaurants_id_fk');
	});

	it('refuses to delete a restaurant that has a settings row', async () => {
		const restaurantId = await makeRestaurant();
		await pool.query('insert into restaurant_settings (restaurant_id, time_zone) values ($1, $2)', [
			restaurantId,
			'UTC'
		]);
		const error = await expectError('delete from restaurants where id = $1', [restaurantId]);
		expect(error.constraint).toBe('restaurant_settings_restaurant_id_restaurants_id_fk');
	});

	it('refuses to delete a restaurant that has an audit row', async () => {
		const restaurantId = await makeRestaurant();
		await pool.query(
			`insert into audit_log (restaurant_id, event, details, occurred_at)
			 values ($1, 'test.event', '{}'::jsonb, now())`,
			[restaurantId]
		);
		const error = await expectError('delete from restaurants where id = $1', [restaurantId]);
		expect(error.constraint).toBe('audit_log_restaurant_id_restaurants_id_fk');
	});

	it('cascades sessions when a user is deleted', async () => {
		const restaurantId = await makeRestaurant();
		const userId = await makeOwner(restaurantId, 'owner@cafe.com');
		await pool.query(
			`insert into sessions (id, user_id, expires_at) values ($1, $2, now() + interval '30 days')`,
			['a'.repeat(64), userId]
		);

		await pool.query('delete from users where id = $1', [userId]);
		const { rows } = await pool.query('select count(*)::int as n from sessions');
		expect(rows[0].n).toBe(0);
	});

	// An employee who has done anything cannot be deleted, only deactivated: the
	// audit row's actor_user_id is RESTRICT, so the delete is refused outright.
	it('refuses to delete a user who has audit rows, leaving the audit intact', async () => {
		const restaurantId = await makeRestaurant();
		const userId = await makeOwner(restaurantId, 'owner@cafe.com');
		await pool.query(
			`insert into audit_log (restaurant_id, actor_user_id, event, details, occurred_at)
			 values ($1, $2, 'login.success', '{}'::jsonb, now())`,
			[restaurantId, userId]
		);

		const error = await expectError('delete from users where id = $1', [userId]);
		expect(error.code).toBe('23503');
		expect(error.constraint).toBe('audit_log_actor_user_id_users_id_fk');

		const { rows } = await pool.query('select count(*)::int as n from audit_log');
		expect(rows[0].n).toBe(1);
	});
});

describe('audit_log is append-only (invariant 2)', () => {
	async function seedAuditRow(): Promise<void> {
		const restaurantId = await makeRestaurant();
		await pool.query(
			`insert into audit_log (restaurant_id, event, details, occurred_at)
			 values ($1, 'test.event', '{}'::jsonb, now())`,
			[restaurantId]
		);
	}

	// MANDATORY — both operations must be exercised. The trigger covers UPDATE and
	// DELETE, and a test of only one would pass with a half-written trigger.
	it('rejects UPDATE', async () => {
		await seedAuditRow();
		const error = await expectError(`update audit_log set event = 'tampered'`);
		expect(error.message).toContain('audit_log is append-only');
		expect(error.message).toContain('UPDATE');
	});

	it('rejects DELETE', async () => {
		await seedAuditRow();
		const error = await expectError('delete from audit_log');
		expect(error.message).toContain('audit_log is append-only');
		expect(error.message).toContain('DELETE');
	});

	it('still accepts INSERT — it is append-only, not read-only', async () => {
		const restaurantId = await makeRestaurant();
		const { rowCount } = await pool.query(
			`insert into audit_log (restaurant_id, event, details, occurred_at)
			 values ($1, 'test.event', '{}'::jsonb, now())`,
			[restaurantId]
		);
		expect(rowCount).toBe(1);
	});
});
