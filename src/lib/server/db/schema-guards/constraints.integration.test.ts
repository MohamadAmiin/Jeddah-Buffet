import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { TAX_MODES } from '$lib/money/tax';
import { testDb, closeTestDb } from '../test/db';
import { menuItems } from '../schema/menu';

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
	await closeTestDb();
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

async function makeStaff(restaurantId: string, displayName = 'Staff'): Promise<string> {
	const { rows: roleRows } = await pool.query<{ id: string }>(
		`insert into roles (restaurant_id, name)
		 values ($1, 'Cashier')
		 returning id`,
		[restaurantId]
	);
	const roleId = roleRows[0].id;

	const { rows } = await pool.query<{ id: string }>(
		`insert into users (restaurant_id, role, display_name, role_id)
		 values ($1, 'staff', $2, $3)
		 returning id`,
		[restaurantId, displayName, roleId]
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

	it('rejects a staff member that has an email', async () => {
		const restaurantId = await makeRestaurant();
		const staffId = await makeStaff(restaurantId);
		const error = await expectError(
			`update users
			 set email = 'staff@cafe.com'
			 where id = $1`,
			[staffId]
		);
		expect(error.constraint).toBe('users_non_owner_has_no_credentials');
	});

	it('rejects a staff member that has a password hash', async () => {
		const restaurantId = await makeRestaurant();
		const staffId = await makeStaff(restaurantId);
		const error = await expectError(
			`update users
			 set password_hash = 'not-a-real-hash'
			 where id = $1`,
			[staffId]
		);
		expect(error.constraint).toBe('users_non_owner_has_no_credentials');
	});

	it('accepts a staff member with neither email nor password hash', async () => {
		const restaurantId = await makeRestaurant();
		const staffId = await makeStaff(restaurantId);
		const { rowCount } = await pool.query(
			`select id from users
			 where id = $1
			   and role = 'staff'
			   and role_id is not null
			   and email is null
			   and password_hash is null`,
			[staffId]
		);
		expect(rowCount).toBe(1);
	});

	it('accepts a staff member with a pin_hash and neither email nor password hash', async () => {
		const restaurantId = await makeRestaurant();
		const staffId = await makeStaff(restaurantId);
		await pool.query(
			`update users
			 set pin_hash = 'not-a-real-pin-hash'
			 where id = $1`,
			[staffId]
		);

		const { rowCount } = await pool.query(
			`select id from users
			 where id = $1
			   and role = 'staff'
			   and role_id is not null
			   and email is null
			   and password_hash is null
			   and pin_hash = 'not-a-real-pin-hash'`,
			[staffId]
		);
		expect(rowCount).toBe(1);
	});

	it('accepts an owner with both a password hash and a pin_hash', async () => {
		const restaurantId = await makeRestaurant();
		const { rowCount } = await pool.query(
			`insert into users (restaurant_id, role, display_name, email, password_hash, pin_hash)
			 values ($1, 'owner', 'Owner', 'owner@cafe.com', 'not-a-real-hash', 'not-a-real-pin-hash')`,
			[restaurantId]
		);
		expect(rowCount).toBe(1);
	});

	it('enforces owner has no role_id and staff has a role_id', async () => {
		const restaurantId = await makeRestaurant();

		const { rows } = await pool.query<{ id: string }>(
			`insert into roles (restaurant_id, name)
			 values ($1, 'Cashier')
			 returning id`,
			[restaurantId]
		);
		const roleId = rows[0].id;

		const staffError = await expectError(
			`insert into users (restaurant_id, role, display_name)
			 values ($1, 'staff', 'Staff')`,
			[restaurantId]
		);
		expect(staffError.constraint).toBe('users_owner_has_no_role_staff_has_one');

		const ownerError = await expectError(
			`insert into users (restaurant_id, role, display_name, email, password_hash, role_id)
			 values ($1, 'owner', 'Owner', 'owner@cafe.com', 'not-a-real-hash', $2)`,
			[restaurantId, roleId]
		);
		expect(ownerError.constraint).toBe('users_owner_has_no_role_staff_has_one');
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

describe('menu constraints (T-37)', () => {
	async function makeCategory(restaurantId: string, name = 'Drinks'): Promise<string> {
		const { rows } = await pool.query<{ id: string }>(
			'insert into menu_categories (restaurant_id, name) values ($1, $2) returning id',
			[restaurantId, name]
		);
		return rows[0].id;
	}

	async function makeItem(restaurantId: string, categoryId: string): Promise<string> {
		const { rows } = await pool.query<{ id: string }>(
			`insert into menu_items (restaurant_id, category_id, name, price_minor)
			 values ($1, $2, 'Tea', 850) returning id`,
			[restaurantId, categoryId]
		);
		return rows[0].id;
	}

	async function makeGroup(restaurantId: string): Promise<string> {
		const { rows } = await pool.query<{ id: string }>(
			`insert into modifier_groups (restaurant_id, name) values ($1, 'Milk') returning id`,
			[restaurantId]
		);
		return rows[0].id;
	}

	it('rejects a negative menu price', async () => {
		const r = await makeRestaurant();
		const c = await makeCategory(r);
		const error = await expectError(
			`insert into menu_items (restaurant_id, category_id, name, price_minor)
			 values ($1, $2, 'Tea', -1)`,
			[r, c]
		);
		expect(error.constraint).toBe('menu_items_price_minor_non_negative');
	});

	it('rejects an item tax rate above 10000 basis points', async () => {
		const r = await makeRestaurant();
		const c = await makeCategory(r);
		const error = await expectError(
			`insert into menu_items (restaurant_id, category_id, name, price_minor, tax_rate_bp)
			 values ($1, $2, 'Tea', 850, 10001)`,
			[r, c]
		);
		expect(error.constraint).toBe('menu_items_tax_rate_bp_range');
	});

	it("rejects an item in another restaurant's category", async () => {
		const a = await makeRestaurant('Restaurant A');
		const b = await makeRestaurant('Restaurant B');
		const categoryOfA = await makeCategory(a);
		const error = await expectError(
			`insert into menu_items (restaurant_id, category_id, name, price_minor)
			 values ($1, $2, 'Tea', 850)`,
			[b, categoryOfA]
		);
		expect(error.constraint).toBe('menu_items_category_fk');
	});

	it("rejects a modifier in another restaurant's group", async () => {
		const a = await makeRestaurant('Restaurant A');
		const b = await makeRestaurant('Restaurant B');
		const groupOfA = await makeGroup(a);
		const error = await expectError(
			`insert into modifiers (restaurant_id, group_id, name, price_delta_minor)
			 values ($1, $2, 'Oat milk', 50)`,
			[b, groupOfA]
		);
		expect(error.constraint).toBe('modifiers_group_fk');
	});

	it('rejects a second LIVE category of the same name in any case, and frees it once archived', async () => {
		const r = await makeRestaurant();
		const first = await makeCategory(r, 'Drinks');
		const error = await expectError(
			`insert into menu_categories (restaurant_id, name) values ($1, 'drinks')`,
			[r]
		);
		expect(error.constraint).toBe('menu_categories_name_unique');

		await pool.query('update menu_categories set archived_at = now() where id = $1', [first]);
		await makeCategory(r, 'drinks');
	});

	it('rejects a modifier group whose maximum is below its minimum', async () => {
		const r = await makeRestaurant();
		const error = await expectError(
			`insert into modifier_groups (restaurant_id, name, min_select, max_select)
			 values ($1, 'Milk', 2, 1)`,
			[r]
		);
		expect(error.constraint).toBe('modifier_groups_select_range');
	});

	it('rejects linking the same group to the same item twice', async () => {
		const r = await makeRestaurant();
		const item = await makeItem(r, await makeCategory(r));
		const group = await makeGroup(r);
		const link = `insert into menu_item_modifier_groups (restaurant_id, menu_item_id, modifier_group_id)
			values ($1, $2, $3)`;
		await pool.query(link, [r, item, group]);

		const error = await expectError(link, [r, item, group]);
		expect(error.constraint).toBe('menu_item_modifier_groups_pk');
	});

	it('accepts a negative modifier delta: "No cheese" is a legitimate discount on the item', async () => {
		const r = await makeRestaurant();
		const group = await makeGroup(r);
		await pool.query(
			`insert into modifiers (restaurant_id, group_id, name, price_delta_minor)
			 values ($1, $2, 'No cheese', -50)`,
			[r, group]
		);
	});

	it('returns price_minor through Drizzle as a bigint', async () => {
		const r = await makeRestaurant();
		const id = await makeItem(r, await makeCategory(r));

		const [row] = await testDb()
			.select({ priceMinor: menuItems.priceMinor })
			.from(menuItems)
			.where(eq(menuItems.id, id));

		expect(row.priceMinor).toBe(850n);
	});
});

describe('referential integrity', () => {
	it('refuses to delete a restaurant that has a user', async () => {
		const restaurantId = await makeRestaurant();
		await makeOwner(restaurantId, 'owner@cafe.com');
		const error = await expectError('delete from restaurants where id = $1', [restaurantId]);
		expect(error.code).toBe('23503');
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
		expect(error.code).toBe('23505');
		expect(error.constraint).toBe('audit_log_device_client_op_unique');

		const { rows } = await pool.query('select count(*)::int as n from audit_log');
		expect(rows[0].n).toBe(1);
	});

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

	it('refuses to delete a device that has an audit row, leaving the audit row intact', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId, 'owner@cafe.com');
		const deviceId = await makeDevice(restaurantId, ownerId);
		await insertDeviceAudit(restaurantId, deviceId, null);

		const error = await expectError('delete from pos_devices where id = $1', [deviceId]);
		expect(error.code).toBe('23503');
		expect(error.constraint).toBe('audit_log_device_id_pos_devices_id_fk');

		const { rows } = await pool.query('select count(*)::int as n from audit_log');
		expect(rows[0].n).toBe(1);
	});
});

describe('roles constraints', () => {
	async function makeRole(restaurantId: string, name: string): Promise<string> {
		const { rows } = await pool.query<{ id: string }>(
			`insert into roles (restaurant_id, name) values ($1, $2) returning id`,
			[restaurantId, name]
		);
		return rows[0].id;
	}

	it.each(['Owner', 'OWNER', ' owner ', 'OwNeR'])(
		'rejects a role named %j (roles_name_not_owner)',
		async (name) => {
			const restaurantId = await makeRestaurant();
			const error = await expectError(`insert into roles (restaurant_id, name) values ($1, $2)`, [
				restaurantId,
				name
			]);
			expect(error.constraint).toBe('roles_name_not_owner');
		}
	);

	it.each(['', '   '])('rejects a blank role name %j (roles_name_length)', async (name) => {
		const restaurantId = await makeRestaurant();
		const error = await expectError(`insert into roles (restaurant_id, name) values ($1, $2)`, [
			restaurantId,
			name
		]);
		expect(error.constraint).toBe('roles_name_length');
	});

	it('rejects two LIVE roles that differ only in case (roles_name_unique)', async () => {
		const restaurantId = await makeRestaurant();
		await makeRole(restaurantId, 'Cashier');
		const error = await expectError(`insert into roles (restaurant_id, name) values ($1, $2)`, [
			restaurantId,
			'cashier'
		]);
		expect(error.constraint).toBe('roles_name_unique');
	});

	it('frees the name once the live role is archived', async () => {
		const restaurantId = await makeRestaurant();
		const roleId = await makeRole(restaurantId, 'Cashier');
		await pool.query(`update roles set archived_at = now() where id = $1`, [roleId]);
		const { rowCount } = await pool.query(
			`insert into roles (restaurant_id, name) values ($1, 'Cashier')`,
			[restaurantId]
		);
		expect(rowCount).toBe(1);
	});

	it('rejects an admin.* permission key (role_permissions_key_pos_only)', async () => {
		const restaurantId = await makeRestaurant();
		const roleId = await makeRole(restaurantId, 'Cashier');
		const error = await expectError(
			`insert into role_permissions (restaurant_id, role_id, permission_key)
			 values ($1, $2, 'admin.settings')`,
			[restaurantId, roleId]
		);
		expect(error.constraint).toBe('role_permissions_key_pos_only');
	});

	it('refuses a user in restaurant B holding a role from restaurant A (users_role_fk)', async () => {
		const a = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const roleId = await makeRole(a, 'Cashier');
		const error = await expectError(
			`insert into users (restaurant_id, role, display_name, role_id)
			 values ($1, 'staff', 'Bob', $2)`,
			[b, roleId]
		);
		expect(error.code).toBe('23503');
		expect(error.constraint).toBe('users_role_fk');
	});

	it('refuses to delete a role a user still holds (users_role_fk)', async () => {
		const restaurantId = await makeRestaurant();
		const roleId = await makeRole(restaurantId, 'Cashier');
		await pool.query(
			`insert into users (restaurant_id, role, display_name, role_id)
			 values ($1, 'staff', 'Bob', $2)`,
			[restaurantId, roleId]
		);
		const error = await expectError(`delete from roles where id = $1`, [roleId]);
		expect(error.code).toBe('23503');
		expect(error.constraint).toBe('users_role_fk');
	});

	const SEED_DEFAULT_ROLES = `
		INSERT INTO "roles" ("restaurant_id", "name")
		SELECT r."id", v."name"
		FROM "restaurants" r CROSS JOIN (VALUES ('Cashier'), ('Waiter')) AS v("name")
		ON CONFLICT ("restaurant_id", lower("name")) WHERE "archived_at" IS NULL DO NOTHING`;

	const SEED_DEFAULT_ROLE_PERMISSIONS = `
		INSERT INTO "role_permissions" ("restaurant_id", "role_id", "permission_key")
		SELECT ro."restaurant_id", ro."id", k."key"
		FROM "roles" ro
		JOIN (VALUES
		  ('cashier', 'pos.sell'), ('cashier', 'pos.payment'), ('cashier', 'pos.print_receipt'),
		  ('cashier', 'pos.void_unsent_item'), ('cashier', 'pos.cash_payout'),
		  ('waiter', 'pos.create_order'), ('waiter', 'pos.view_menu'), ('waiter', 'pos.modify_order'),
		  ('waiter', 'pos.send_to_kitchen'), ('waiter','pos.transfer_table')
		) AS k("role_name", "key") ON lower(ro."name") = k."role_name"
		WHERE ro."archived_at" IS NULL
		ON CONFLICT ("role_id", "permission_key") DO NOTHING`;

	async function assertSeededRoles(restaurantId: string): Promise<void> {
		const { rows: roles } = await pool.query<{ id: string; name: string }>(
			`select id, name from roles
			 where restaurant_id = $1 and archived_at is null
			 order by name`,
			[restaurantId]
		);
		expect(roles.map((r) => r.name)).toEqual(['Cashier', 'Waiter']);

		const { rows: perms } = await pool.query<{ name: string; permission_key: string }>(
			`select ro.name, p.permission_key
			 from role_permissions p
			 join roles ro on ro.id = p.role_id
			 where ro.restaurant_id = $1 and ro.archived_at is null
			 order by ro.name, p.permission_key`,
			[restaurantId]
		);
		expect(perms).toHaveLength(10);
		expect(perms.every((p) => p.permission_key.startsWith('pos.'))).toBe(true);
		expect(perms.some((p) => p.permission_key.startsWith('admin.'))).toBe(false);
		expect(perms.filter((p) => p.name === 'Cashier').map((p) => p.permission_key)).toEqual([
			'pos.cash_payout',
			'pos.payment',
			'pos.print_receipt',
			'pos.sell',
			'pos.void_unsent_item'
		]);
		expect(perms.filter((p) => p.name === 'Waiter').map((p) => p.permission_key)).toEqual([
			'pos.create_order',
			'pos.modify_order',
			'pos.send_to_kitchen',
			'pos.transfer_table',
			'pos.view_menu'
		]);
	}

	it('seeds Cashier and Waiter with the ten POS keys, idempotently (migration 0009)', async () => {
		const restaurantId = await makeRestaurant('Seed Cafe');
		await pool.query(SEED_DEFAULT_ROLES);
		await pool.query(SEED_DEFAULT_ROLE_PERMISSIONS);
		await assertSeededRoles(restaurantId);

		await pool.query(SEED_DEFAULT_ROLES);
		await pool.query(SEED_DEFAULT_ROLE_PERMISSIONS);
		await assertSeededRoles(restaurantId);

		const { rows } = await pool.query<{ n: number }>(
			`select count(*)::int as n from roles where restaurant_id = $1`,
			[restaurantId]
		);
		expect(rows[0].n).toBe(2);
	});

	it('seeds each restaurant its own roles (tenant isolation)', async () => {
		const a = await makeRestaurant('Tenant A');
		const b = await makeRestaurant('Tenant B');
		await pool.query(SEED_DEFAULT_ROLES);
		await pool.query(SEED_DEFAULT_ROLE_PERMISSIONS);
		await assertSeededRoles(a);
		await assertSeededRoles(b);

		const { rows } = await pool.query<{ n: number }>(
			`select count(*)::int as n from roles r
			 join role_permissions p on p.role_id = r.id
			 where r.restaurant_id = $1 and p.restaurant_id <> $1`,
			[a]
		);
		expect(rows[0].n).toBe(0);
	});

	it('does not overwrite an archived Cashier when the seed runs again', async () => {
		const restaurantId = await makeRestaurant('Archive Cafe');
		await pool.query(SEED_DEFAULT_ROLES);
		await pool.query(SEED_DEFAULT_ROLE_PERMISSIONS);

		const {
			rows: [{ id: archivedId }]
		} = await pool.query<{ id: string }>(
			`select id from roles where restaurant_id = $1 and name = 'Cashier'`,
			[restaurantId]
		);

		await pool.query(`update roles set archived_at = now() where id = $1`, [archivedId]);

		await pool.query(SEED_DEFAULT_ROLES);
		await pool.query(SEED_DEFAULT_ROLE_PERMISSIONS);

		const { rows: archived } = await pool.query<{ name: string; archived_at: Date | null }>(
			`select name, archived_at from roles where id = $1`,
			[archivedId]
		);
		expect(archived[0].name).toBe('Cashier');
		expect(archived[0].archived_at).not.toBeNull();

		const { rows: live } = await pool.query<{ id: string }>(
			`select id from roles
			 where restaurant_id = $1 and name = 'Cashier' and archived_at is null`,
			[restaurantId]
		);

		expect(live).toHaveLength(1);
		expect(live[0].id).not.toBe(archivedId);
	});
});
