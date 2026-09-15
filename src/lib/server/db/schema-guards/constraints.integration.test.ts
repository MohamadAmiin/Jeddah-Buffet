import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { TAX_MODES } from '$lib/money/tax';

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

async function makeDevice(
	restaurantId: string,
	ownerId: string,
	code = 'POS1',
	tokenHash = 'a'.repeat(64)
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into pos_devices (restaurant_id, device_code, label, token_hash, registered_by_user_id)
		 values ($1, $2, 'Counter tablet', $3, $4) returning id`,
		[restaurantId, code, tokenHash, ownerId]
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

	// users_non_owner_has_no_credentials is about email and password ONLY: a
	// cashier's credential is a PIN, and a pin_hash must not trip it.
	it('accepts a cashier with a pin_hash and neither email nor password hash', async () => {
		const restaurantId = await makeRestaurant();
		const { rowCount } = await pool.query(
			`insert into users (restaurant_id, role, display_name, pin_hash)
			 values ($1, 'cashier', 'Cashier', 'not-a-real-pin-hash')`,
			[restaurantId]
		);
		expect(rowCount).toBe(1);
	});

	// Spec 7: "The owner also has a POS PIN, used to approve sensitive actions."
	it('accepts an owner with both a password hash and a pin_hash', async () => {
		const restaurantId = await makeRestaurant();
		const { rowCount } = await pool.query(
			`insert into users (restaurant_id, role, display_name, email, password_hash, pin_hash)
			 values ($1, 'owner', 'Owner', 'owner@cafe.com', 'not-a-real-hash', 'not-a-real-pin-hash')`,
			[restaurantId]
		);
		expect(rowCount).toBe(1);
	});
});

describe('restaurant_settings constraints', () => {
	async function makeSettings(): Promise<string> {
		const restaurantId = await makeRestaurant();
		await pool.query(
			`insert into restaurant_settings (restaurant_id, time_zone) values ($1, 'Africa/Mogadishu')`,
			[restaurantId]
		);
		return restaurantId;
	}

	it("rejects a tax mode that is neither 'exclusive' nor 'inclusive'", async () => {
		const id = await makeSettings();
		const error = await expectError(
			`update restaurant_settings set tax_mode = 'included' where restaurant_id = $1`,
			[id]
		);
		expect(error.constraint).toBe('restaurant_settings_tax_mode_valid');
	});

	it.each([-1, 10001])('rejects a tax rate of %i basis points', async (bp) => {
		const id = await makeSettings();
		const error = await expectError(
			`update restaurant_settings set tax_rate_bp = $2 where restaurant_id = $1`,
			[id, bp]
		);
		expect(error.constraint).toBe('restaurant_settings_tax_rate_bp_range');
	});

	it('rejects a currency code that is not three uppercase letters', async () => {
		const id = await makeSettings();
		const error = await expectError(
			`update restaurant_settings set currency_code = 'sos' where restaurant_id = $1`,
			[id]
		);
		expect(error.constraint).toBe('restaurant_settings_currency_code_format');
	});

	it('lets all three be unset, and accepts valid values at both ends of the range', async () => {
		const id = await makeSettings();
		await pool.query(
			`update restaurant_settings set tax_mode = null, tax_rate_bp = null, currency_code = null
			 where restaurant_id = $1`,
			[id]
		);
		for (const bp of [0, 825, 10000]) {
			await pool.query(
				`update restaurant_settings set tax_mode = 'inclusive', tax_rate_bp = $2, currency_code = 'USD'
				 where restaurant_id = $1`,
				[id, bp]
			);
		}
		const { rows } = await pool.query(
			`select tax_mode, tax_rate_bp, currency_code from restaurant_settings where restaurant_id = $1`,
			[id]
		);
		expect(rows[0]).toEqual({ tax_mode: 'inclusive', tax_rate_bp: 10000, currency_code: 'USD' });
	});

	// TAX_MODES and the CHECK's two literals are connected by no type system, so
	// they are pinned together here, against the real database.
	it('allows exactly the tax modes the money module knows', async () => {
		expect(TAX_MODES).toEqual(['exclusive', 'inclusive']);
		const id = await makeSettings();
		for (const mode of TAX_MODES) {
			await pool.query(`update restaurant_settings set tax_mode = $2 where restaurant_id = $1`, [
				id,
				mode
			]);
		}
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

describe('pos_devices and the device idempotency key', () => {
	const OP_ID = '8d8ac610-566d-4ef0-9c22-186b2a5ed793';

	function insertDeviceAudit(
		restaurantId: string,
		deviceId: string | null,
		clientOpId: string | null
	) {
		return pool.query(
			`insert into audit_log (restaurant_id, event, details, occurred_at, device_id, client_op_id)
			 values ($1, 'test.device_event', '{}'::jsonb, now(), $2, $3)`,
			[restaurantId, deviceId, clientOpId]
		);
	}

	// MANDATORY (spec 29 — offline sync: retries never create duplicates). The
	// database half of the rule: the same device replaying the same client op id is
	// refused, so a retried sync can never leave a second — and, because audit_log
	// is append-only, permanent — row behind.
	it('rejects a second audit row with the same device and client op id', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId, 'owner@cafe.com');
		const deviceId = await makeDevice(restaurantId, ownerId);
		await insertDeviceAudit(restaurantId, deviceId, OP_ID);

		const error = await expectError(
			`insert into audit_log (restaurant_id, event, details, occurred_at, device_id, client_op_id)
			 values ($1, 'test.device_event', '{}'::jsonb, now(), $2, $3)`,
			[restaurantId, deviceId, OP_ID]
		);
		expect(error.code).toBe('23505'); // unique_violation
		expect(error.constraint).toBe('audit_log_device_client_op_unique');

		const { rows } = await pool.query('select count(*)::int as n from audit_log');
		expect(rows[0].n).toBe(1);
	});

	// MANDATORY (spec 29 — the same rule, the other direction). Rows with no key —
	// every dashboard and server-originated row — must keep being written, and a key
	// is unique PER DEVICE, not globally.
	it('accepts key-less rows from one device, and the same key from another device', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId, 'owner@cafe.com');
		const deviceA = await makeDevice(restaurantId, ownerId, 'POS1', 'a'.repeat(64));
		const deviceB = await makeDevice(restaurantId, ownerId, 'POS2', 'b'.repeat(64));

		await insertDeviceAudit(restaurantId, deviceA, null);
		await insertDeviceAudit(restaurantId, deviceA, null);
		const { rows: keyless } = await pool.query(
			'select count(*)::int as n from audit_log where device_id = $1 and client_op_id is null',
			[deviceA]
		);
		expect(keyless[0].n).toBe(2);

		await insertDeviceAudit(restaurantId, deviceA, OP_ID);
		const { rowCount } = await insertDeviceAudit(restaurantId, deviceB, OP_ID);
		expect(rowCount).toBe(1);
	});

	it('rejects a second device with the same token hash', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId, 'owner@cafe.com');
		await makeDevice(restaurantId, ownerId, 'POS1', 'c'.repeat(64));

		const error = await expectError(
			`insert into pos_devices (restaurant_id, device_code, label, token_hash, registered_by_user_id)
			 values ($1, 'POS2', 'Second tablet', $2, $3)`,
			[restaurantId, 'c'.repeat(64), ownerId]
		);
		expect(error.code).toBe('23505');
		expect(error.constraint).toBe('pos_devices_token_hash_unique');
	});

	// Pins T-05's decision that an invoice prefix is BURNED once used: reusing POS1
	// after a revoke would let POS1-000001 name two different sales.
	it('rejects a second POS1 in the same restaurant even after the first is revoked', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId, 'owner@cafe.com');
		const first = await makeDevice(restaurantId, ownerId, 'POS1', 'd'.repeat(64));
		await pool.query(
			'update pos_devices set revoked_at = now(), revoked_by_user_id = $2 where id = $1',
			[first, ownerId]
		);

		const error = await expectError(
			`insert into pos_devices (restaurant_id, device_code, label, token_hash, registered_by_user_id)
			 values ($1, 'POS1', 'Replacement tablet', $2, $3)`,
			[restaurantId, 'e'.repeat(64), ownerId]
		);
		expect(error.code).toBe('23505');
		expect(error.constraint).toBe('pos_devices_restaurant_device_code_unique');
	});

	it('rejects a device code that is not 1-8 uppercase letters and digits', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId, 'owner@cafe.com');

		const error = await expectError(
			`insert into pos_devices (restaurant_id, device_code, label, token_hash, registered_by_user_id)
			 values ($1, 'pos 1', 'Counter tablet', $2, $3)`,
			[restaurantId, 'f'.repeat(64), ownerId]
		);
		expect(error.constraint).toBe('pos_devices_device_code_format');
	});

	// Revocation is a stamp, never a delete: a device that produced an audit row can
	// never be removed, and the trail keeps its subject.
	it('refuses to delete a device that has an audit row, leaving the audit row intact', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId, 'owner@cafe.com');
		const deviceId = await makeDevice(restaurantId, ownerId);
		await insertDeviceAudit(restaurantId, deviceId, null);

		const error = await expectError('delete from pos_devices where id = $1', [deviceId]);
		expect(error.code).toBe('23503'); // foreign_key_violation
		expect(error.constraint).toBe('audit_log_device_id_pos_devices_id_fk');

		const { rows } = await pool.query('select count(*)::int as n from audit_log');
		expect(rows[0].n).toBe(1);
	});
});
