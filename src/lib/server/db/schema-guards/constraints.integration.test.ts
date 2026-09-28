import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { TAX_MODES } from '$lib/money/tax';
import {
	OP_KINDS,
	OP_STATUSES,
	ORDER_TYPES,
	PAYMENT_METHODS,
	ORDER_STATUSES,
	LINE_STATUSES,
	SESSION_STATUSES
} from '$lib/sync-ops';
import { testDb, closeTestDb } from '../test/db';
import { menuItems } from '../schema/menu';
import { orders, payments } from '../schema/orders';
import { posSessions } from '../schema/pos-sessions';

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

// T-13 exports POSTING_EVENTS from src/lib/server/accounting/posting-rules.ts;
// this local restates the fourteen literals (pos-sales' six plus
// tasks/inventory-cogs' eight) and is swapped for an import once T-13 has landed. Keeping it local now keeps the schema tests independent of the
// domain module that has not been written.
const POSTING_EVENTS = [
	'cash_sale',
	'card_sale',
	'mobile_sale',
	'cost_of_goods_sold',
	'cash_shortage_at_close',
	'cash_overage_at_close',
	'purchase_paid',
	'purchase_on_credit',
	'supplier_paid',
	'waste',
	'stock_count_shortfall',
	'stock_count_surplus',
	'inventory_revaluation',
	'opening_stock'
] as const;

// tasks/inventory-cogs T-13 exports JOURNAL_SOURCE_TYPES beside POSTING_EVENTS;
// restated here for the same reason.
const JOURNAL_SOURCE_TYPES = [
	'order',
	'pos_session',
	'purchase',
	'supplier_payment',
	'waste_entry',
	'stock_count',
	'opening_stock'
] as const;

type MakeSessionOverrides = {
	openingCashMinor?: number | bigint;
	status?: 'open' | 'closed';
	closedAt?: Date | null;
	closedByUserId?: string | null;
	closedFromDeviceId?: string | null;
	countedCashMinor?: number | bigint | null;
	expectedCashMinor?: number | bigint | null;
	differenceMinor?: number | bigint | null;
};

async function makeSession(
	restaurantId: string,
	deviceId: string,
	userId: string,
	overrides: MakeSessionOverrides = {}
): Promise<string> {
	const openingCashMinor = overrides.openingCashMinor ?? 50000;
	const status = overrides.status ?? 'open';
	const closedAt = overrides.closedAt ?? null;
	const closedByUserId = overrides.closedByUserId ?? null;
	const closedFromDeviceId = overrides.closedFromDeviceId ?? null;
	const countedCashMinor = overrides.countedCashMinor ?? null;
	const expectedCashMinor = overrides.expectedCashMinor ?? null;
	const differenceMinor = overrides.differenceMinor ?? null;

	const { rows } = await pool.query<{ id: string }>(
		`insert into pos_sessions (
			restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
			opening_cash_minor, status, closed_at, closed_by_user_id, closed_from_device_id,
			counted_cash_minor, expected_cash_minor, difference_minor
		) values ($1, $2, $3, now(), '2026-09-28', $4, $5, $6, $7, $8, $9, $10, $11)
		returning id`,
		[
			restaurantId,
			deviceId,
			userId,
			openingCashMinor,
			status,
			closedAt,
			closedByUserId,
			closedFromDeviceId,
			countedCashMinor,
			expectedCashMinor,
			differenceMinor
		]
	);
	return rows[0].id;
}

async function makeMenuItem(restaurantId: string, categoryName = 'Drinks'): Promise<string> {
	const { rows: categoryRows } = await pool.query<{ id: string }>(
		`insert into menu_categories (restaurant_id, name) values ($1, $2) returning id`,
		[restaurantId, categoryName]
	);
	const categoryId = categoryRows[0].id;
	const { rows: itemRows } = await pool.query<{ id: string }>(
		`insert into menu_items (restaurant_id, category_id, name, price_minor)
		 values ($1, $2, 'Tea', 850) returning id`,
		[restaurantId, categoryId]
	);
	return itemRows[0].id;
}

type MakeOrderOverrides = {
	orderType?: 'dine_in' | 'takeaway';
	tableLabel?: string | null;
	status?: 'open' | 'billed' | 'paid' | 'voided' | 'refunded';
	taxMode?: 'exclusive' | 'inclusive';
	currencyCode?: string;
	subtotalMinor?: number | bigint;
	discountMinor?: number | bigint;
	taxMinor?: number | bigint;
	totalMinor?: number | bigint;
};

async function makeOrder(
	restaurantId: string,
	sessionId: string,
	deviceId: string,
	userId: string,
	overrides: MakeOrderOverrides = {}
): Promise<string> {
	const orderType = overrides.orderType ?? 'takeaway';
	const tableLabel = overrides.tableLabel ?? null;
	const status = overrides.status ?? 'paid';
	const taxMode = overrides.taxMode ?? 'exclusive';
	const currencyCode = overrides.currencyCode ?? 'USD';
	const subtotal = overrides.subtotalMinor ?? 1000;
	const discount = overrides.discountMinor ?? 0;
	const tax = overrides.taxMinor ?? 100;
	const total = overrides.totalMinor ?? 1100;

	const { rows } = await pool.query<{ id: string }>(
		`insert into orders (
			restaurant_id, pos_session_id, device_id, employee_user_id, order_type, table_label,
			status, tax_mode, currency_code, menu_version, subtotal_minor, discount_minor,
			tax_minor, total_minor, opened_at, paid_at
		) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13, now(), now())
		returning id`,
		[
			restaurantId,
			sessionId,
			deviceId,
			userId,
			orderType,
			tableLabel,
			status,
			taxMode,
			currencyCode,
			subtotal,
			discount,
			tax,
			total
		]
	);
	return rows[0].id;
}

async function makeLine(
	restaurantId: string,
	orderId: string,
	menuItemId: string,
	overrides: {
		lineNo?: number;
		quantity?: number;
		unitPriceMinor?: number | bigint;
		taxRateBp?: number;
		status?: 'new' | 'sent' | 'voided';
		discountMinor?: number | bigint;
	} = {}
): Promise<string> {
	const lineNo = overrides.lineNo ?? 1;
	const quantity = overrides.quantity ?? 1;
	const unitPriceMinor = overrides.unitPriceMinor ?? 850;
	const taxRateBp = overrides.taxRateBp ?? 825;
	const status = overrides.status ?? 'new';
	const discountMinor = overrides.discountMinor ?? 0;

	const { rows } = await pool.query<{ id: string }>(
		`insert into order_lines (
			restaurant_id, order_id, line_no, menu_item_id, item_name, quantity,
			unit_price_minor, tax_rate_bp, discount_minor, status
		) values ($1, $2, $3, $4, 'Tea', $5, $6, $7, $8, $9)
		returning id`,
		[
			restaurantId,
			orderId,
			lineNo,
			menuItemId,
			quantity,
			unitPriceMinor,
			taxRateBp,
			discountMinor,
			status
		]
	);
	return rows[0].id;
}

async function makePayment(
	restaurantId: string,
	orderId: string,
	method: 'cash' | 'card' | 'mobile' = 'cash',
	amount: number | bigint = 1100,
	tendered: number | bigint | null = 2000,
	change: number | bigint | null = 900
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into payments (
			restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
		) values ($1, $2, $3, $4, $5, $6, now()) returning id`,
		[restaurantId, orderId, method, amount, tendered, change]
	);
	return rows[0].id;
}

async function makeInvoice(
	restaurantId: string,
	orderId: string,
	deviceId: string,
	seq = 1,
	number = 'POS1-000001'
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into invoices (
			restaurant_id, order_id, device_id, invoice_seq, invoice_number, total_minor, issued_at
		) values ($1, $2, $3, $4, $5, 1100, now()) returning id`,
		[restaurantId, orderId, deviceId, seq, number]
	);
	return rows[0].id;
}

async function makeAccount(
	restaurantId: string,
	code = '1000',
	name = 'Cash on Hand',
	type = 'asset'
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into accounts (restaurant_id, code, name, type)
		 values ($1, $2, $3, $4) returning id`,
		[restaurantId, code, name, type]
	);
	return rows[0].id;
}

/** withRollback: every insert into journal_entries or journal_entry_lines
 * MUST run through this — after T-09, an autocommitted entry with no lines
 * is rejected at its own COMMIT by the deferred trigger. */
async function withRollback(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query('begin');
		try {
			await fn(client);
		} finally {
			await client.query('rollback');
		}
	} finally {
		client.release();
	}
}

async function makeEntry(client: pg.PoolClient, restaurantId: string): Promise<string> {
	const { rows } = await client.query<{ id: string }>(
		`insert into journal_entries (
			restaurant_id, business_date, event, source_type, source_id, memo
		) values ($1, '2026-09-28', 'cash_sale', 'order', gen_random_uuid(), 'test')
		returning id`,
		[restaurantId]
	);
	return rows[0].id;
}

describe('value sets are pinned to the isomorphic constants (T-08)', () => {
	it('lists match the wire contract, verbatim', () => {
		expect([...ORDER_TYPES]).toEqual(['dine_in', 'takeaway']);
		expect([...PAYMENT_METHODS]).toEqual(['cash', 'card', 'mobile']);
		expect([...ORDER_STATUSES]).toEqual(['open', 'billed', 'paid', 'voided', 'refunded']);
		expect([...LINE_STATUSES]).toEqual(['new', 'sent', 'voided']);
		expect([...SESSION_STATUSES]).toEqual(['open', 'closed']);
		expect([...OP_KINDS]).toEqual([
			'session.open',
			'session.close',
			'sale.complete',
			'sale.abandoned',
			'pin.login'
		]);
		expect([...OP_STATUSES]).toEqual(['accepted', 'recorded_flagged', 'unrecorded']);
		expect([...TAX_MODES]).toEqual(['exclusive', 'inclusive']);
	});

	it('rejects a value outside orders.order_type with the named CHECK', async () => {
		const r = await makeRestaurant('vs-order-type');
		const o = await makeOwner(r, 'vs-order-type@example.com');
		const d = await makeDevice(r, o);
		const s = await makeSession(r, d, o);
		const error = await expectError(
			`insert into orders (
				restaurant_id, pos_session_id, device_id, employee_user_id, order_type, status,
				tax_mode, currency_code, menu_version, subtotal_minor, tax_minor, total_minor,
				opened_at, paid_at
			) values ($1, $2, $3, $4, 'delivery', 'paid', 'exclusive', 'USD', 1, 1000, 100, 1100,
				now(), now())`,
			[r, s, d, o]
		);
		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('orders_order_type_valid');
	});

	it('rejects a value outside pos_sessions.status', async () => {
		const r = await makeRestaurant('vs-session-status');
		const o = await makeOwner(r, 'vs-session-status@example.com');
		const d = await makeDevice(r, o);
		// 'suspended' fails both pos_sessions_status_valid AND
		// pos_sessions_closed_fields, and Postgres reports whichever one it
		// evaluates first — that order is not specified. Assert on the failure
		// class and that at least one of the two named constraints reported it.
		const error = await expectError(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'suspended')`,
			[r, d, o]
		);
		expect(error.code).toBe('23514');
		expect(['pos_sessions_status_valid', 'pos_sessions_closed_fields']).toContain(error.constraint);
	});

	it('rejects a value outside pos_sync_ops.kind and pos_sync_ops.status', async () => {
		const r = await makeRestaurant('vs-sync-ops');
		const o = await makeOwner(r, 'vs-sync-ops@example.com');
		const d = await makeDevice(r, o);
		const badKind = await expectError(
			`insert into pos_sync_ops (
				restaurant_id, device_id, received_via_device_id, client_op_id, kind, status,
				occurred_at, payload
			) values ($1, $2, $2, gen_random_uuid(), 'sale.void', 'accepted', now(),
				'{"outcome":"success"}'::jsonb)`,
			[r, d]
		);
		expect(badKind.code).toBe('23514');
		expect(badKind.constraint).toBe('pos_sync_ops_kind_valid');

		const badStatus = await expectError(
			`insert into pos_sync_ops (
				restaurant_id, device_id, received_via_device_id, client_op_id, kind, status,
				occurred_at, payload
			) values ($1, $2, $2, gen_random_uuid(), 'pin.login', 'rejected', now(),
				'{"outcome":"success"}'::jsonb)`,
			[r, d]
		);
		expect(badStatus.code).toBe('23514');
		expect(badStatus.constraint).toBe('pos_sync_ops_status_valid');

		const badResolution = await expectError(
			`insert into pos_sync_ops (
				restaurant_id, device_id, received_via_device_id, client_op_id, kind, status,
				resolution, occurred_at, payload
			) values ($1, $2, $2, gen_random_uuid(), 'pin.login', 'accepted', 'ignored', now(),
				'{"outcome":"success"}'::jsonb)`,
			[r, d]
		);
		expect(badResolution.code).toBe('23514');
		expect(badResolution.constraint).toBe('pos_sync_ops_resolution_valid');
	});

	it('rejects an invalid journal_entries.event and source_type', async () => {
		const r = await makeRestaurant('vs-event');
		await withRollback(async (client) => {
			try {
				await client.query(
					`insert into journal_entries (restaurant_id, business_date, event, source_type,
					 source_id, memo) values ($1, '2026-09-28', 'refund', 'order', gen_random_uuid(),
					 'test')`,
					[r]
				);
				throw new Error('expected 23514');
			} catch (error) {
				expect((error as pg.DatabaseError).code).toBe('23514');
				expect((error as pg.DatabaseError).constraint).toBe('journal_entries_event_valid');
			}
		});

		await withRollback(async (client) => {
			try {
				await client.query(
					`insert into journal_entries (restaurant_id, business_date, event, source_type,
					 source_id, memo) values ($1, '2026-09-28', 'cash_sale', 'expense',
					 gen_random_uuid(), 'test')`,
					[r]
				);
				throw new Error('expected 23514');
			} catch (error) {
				expect((error as pg.DatabaseError).code).toBe('23514');
				expect((error as pg.DatabaseError).constraint).toBe('journal_entries_source_type_valid');
			}
		});
	});

	it('accepts the six spec 23 account types and rejects one outside', async () => {
		const r = await makeRestaurant('vs-account-types');
		let code = 1000;
		for (const type of [
			'asset',
			'liability',
			'equity',
			'revenue',
			'cost_of_sales',
			'expense'
		] as const) {
			const { rowCount } = await pool.query(
				`insert into accounts (restaurant_id, code, name, type) values ($1, $2, $3, $4)`,
				[r, String(code++), type, type]
			);
			expect(rowCount).toBe(1);
		}
		const error = await expectError(
			`insert into accounts (restaurant_id, code, name, type)
			 values ($1, '9999', 'Contra', 'contra')`,
			[r]
		);
		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('accounts_type_valid');
	});

	it('POSTING_EVENTS restated locally matches the fourteen wire literals', () => {
		expect([...POSTING_EVENTS]).toEqual([
			'cash_sale',
			'card_sale',
			'mobile_sale',
			'cost_of_goods_sold',
			'cash_shortage_at_close',
			'cash_overage_at_close',
			'purchase_paid',
			'purchase_on_credit',
			'supplier_paid',
			'waste',
			'stock_count_shortfall',
			'stock_count_surplus',
			'inventory_revaluation',
			'opening_stock'
		]);
	});

	it('journal_entries accepts every POSTING_EVENTS and JOURNAL_SOURCE_TYPES value', async () => {
		const r = await makeRestaurant('vs-journal-all');
		await withRollback(async (client) => {
			for (const event of POSTING_EVENTS) {
				const { rowCount } = await client.query(
					`insert into journal_entries (restaurant_id, business_date, event, source_type,
					 source_id, memo) values ($1, '2026-09-28', $2, 'order', gen_random_uuid(), 'test')`,
					[r, event]
				);
				expect(rowCount).toBe(1);
			}
			for (const sourceType of JOURNAL_SOURCE_TYPES) {
				const { rowCount } = await client.query(
					`insert into journal_entries (restaurant_id, business_date, event, source_type,
					 source_id, memo) values ($1, '2026-09-28', 'cash_sale', $2, gen_random_uuid(), 'test')`,
					[r, sourceType]
				);
				expect(rowCount).toBe(1);
			}
		});
	});
});

describe('pos_sessions constraints (T-08)', () => {
	it('allows only one open session per device', async () => {
		const r = await makeRestaurant('sess-one-open');
		const o = await makeOwner(r, 'sess-one-open@example.com');
		const d1 = await makeDevice(r, o);
		const s1 = await makeSession(r, d1, o);

		const duplicate = await expectError(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'open')`,
			[r, d1, o]
		);
		expect(duplicate.code).toBe('23505');
		expect(duplicate.constraint).toBe('pos_sessions_one_open_per_device');

		// Close the first session, then a new open one is fine on the same device.
		await pool.query(
			`update pos_sessions set status = 'closed', closed_at = now(),
			 closed_by_user_id = $2, closed_from_device_id = $3,
			 counted_cash_minor = 50000, expected_cash_minor = 50000, difference_minor = 0
			 where id = $1`,
			[s1, o, d1]
		);
		const { rowCount } = await pool.query(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'open')`,
			[r, d1, o]
		);
		expect(rowCount).toBe(1);

		// A different device holds its own open session concurrently.
		const d2 = await makeDevice(r, o, 'POS2', 'b'.repeat(64));
		const { rowCount: rc2 } = await pool.query(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'open')`,
			[r, d2, o]
		);
		expect(rc2).toBe(1);
	});

	it('closed_fields requires all six close fields together', async () => {
		const r = await makeRestaurant('sess-closed-fields');
		const o = await makeOwner(r, 'sess-closed-fields@example.com');
		const d = await makeDevice(r, o);

		// closed status but no closed_at
		const noClosedAt = await expectError(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'closed')`,
			[r, d, o]
		);
		expect(noClosedAt.code).toBe('23514');
		expect(noClosedAt.constraint).toBe('pos_sessions_closed_fields');

		// difference_minor null while status = 'closed'
		const noDiff = await expectError(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status, closed_at, closed_by_user_id, closed_from_device_id,
				counted_cash_minor, expected_cash_minor
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'closed', now(), $3, $2, 50000, 50000)`,
			[r, d, o]
		);
		expect(noDiff.code).toBe('23514');
		expect(noDiff.constraint).toBe('pos_sessions_closed_fields');

		// closed with everything but closed_from_device_id
		const noLineage = await expectError(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status, closed_at, closed_by_user_id,
				counted_cash_minor, expected_cash_minor, difference_minor
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'closed', now(), $3, 50000, 50000, 0)`,
			[r, d, o]
		);
		expect(noLineage.code).toBe('23514');
		expect(noLineage.constraint).toBe('pos_sessions_closed_fields');

		// open with closed_at set
		const openWithClosedAt = await expectError(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status, closed_at
			) values ($1, $2, $3, now(), '2026-09-28', 50000, 'open', now())`,
			[r, d, o]
		);
		expect(openWithClosedAt.code).toBe('23514');
		expect(openWithClosedAt.constraint).toBe('pos_sessions_closed_fields');
	});

	it('opening_cash_minor >= 0 is enforced', async () => {
		const r = await makeRestaurant('sess-opening-neg');
		const o = await makeOwner(r, 'sess-opening-neg@example.com');
		const d = await makeDevice(r, o);
		const error = await expectError(
			`insert into pos_sessions (
				restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
				opening_cash_minor, status
			) values ($1, $2, $3, now(), '2026-09-28', -1, 'open')`,
			[r, d, o]
		);
		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('pos_sessions_opening_cash_non_negative');
	});

	it('business_date is a plain YYYY-MM-DD string through Drizzle', async () => {
		const r = await makeRestaurant('sess-business-date');
		const o = await makeOwner(r, 'sess-business-date@example.com');
		const d = await makeDevice(r, o);
		const s = await makeSession(r, d, o);

		const { rows: raw } = await pool.query<{ d: string }>(
			`select business_date::text as d from pos_sessions where id = $1`,
			[s]
		);
		expect(raw[0].d).toBe('2026-09-28');

		const [row] = await testDb()
			.select({ d: posSessions.businessDate })
			.from(posSessions)
			.where(eq(posSessions.id, s));
		expect(row.d).toBe('2026-09-28');
	});
});

describe('orders, payments and invoices constraints (T-08)', () => {
	it('orders_totals_identity enforces subtotal - discount + tax = total', async () => {
		const r = await makeRestaurant('orders-totals');
		const o = await makeOwner(r, 'orders-totals@example.com');
		const d = await makeDevice(r, o);
		const s = await makeSession(r, d, o);
		const error = await expectError(
			`insert into orders (
				restaurant_id, pos_session_id, device_id, employee_user_id, order_type, status,
				tax_mode, currency_code, menu_version, subtotal_minor, discount_minor, tax_minor,
				total_minor, opened_at, paid_at
			) values ($1, $2, $3, $4, 'takeaway', 'paid', 'exclusive', 'USD', 1, 1000, 0, 100, 1000,
				now(), now())`,
			[r, s, d, o]
		);
		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('orders_totals_identity');

		// With a real discount the identity holds and the row is accepted.
		const orderId = await makeOrder(r, s, d, o, {
			subtotalMinor: 1000,
			discountMinor: 100,
			taxMinor: 90,
			totalMinor: 990
		});
		expect(orderId).toBeTruthy();
	});

	it('table_label length 1..32, and currency_code ^[A-Z]{3}$', async () => {
		const r = await makeRestaurant('orders-checks');
		const o = await makeOwner(r, 'orders-checks@example.com');
		const d = await makeDevice(r, o);
		const s = await makeSession(r, d, o);

		const tooLong = await expectError(
			`insert into orders (
				restaurant_id, pos_session_id, device_id, employee_user_id, order_type, table_label,
				status, tax_mode, currency_code, menu_version, subtotal_minor, tax_minor, total_minor,
				opened_at, paid_at
			) values ($1, $2, $3, $4, 'dine_in', $5, 'paid', 'exclusive', 'USD', 1, 1000, 100, 1100,
				now(), now())`,
			[r, s, d, o, 'x'.repeat(33)]
		);
		expect(tooLong.constraint).toBe('orders_table_label_length');

		const empty = await expectError(
			`insert into orders (
				restaurant_id, pos_session_id, device_id, employee_user_id, order_type, table_label,
				status, tax_mode, currency_code, menu_version, subtotal_minor, tax_minor, total_minor,
				opened_at, paid_at
			) values ($1, $2, $3, $4, 'dine_in', '', 'paid', 'exclusive', 'USD', 1, 1000, 100, 1100,
				now(), now())`,
			[r, s, d, o]
		);
		expect(empty.constraint).toBe('orders_table_label_length');

		const badCurrency = await expectError(
			`insert into orders (
				restaurant_id, pos_session_id, device_id, employee_user_id, order_type, status,
				tax_mode, currency_code, menu_version, subtotal_minor, tax_minor, total_minor,
				opened_at, paid_at
			) values ($1, $2, $3, $4, 'takeaway', 'paid', 'exclusive', 'usd', 1, 1000, 100, 1100,
				now(), now())`,
			[r, s, d, o]
		);
		expect(badCurrency.constraint).toBe('orders_currency_code_format');
	});

	it('an order whose session belongs to another restaurant is refused (tenant isolation)', async () => {
		const rA = await makeRestaurant('orders-tenant-A');
		const oA = await makeOwner(rA, 'orders-tenant-a@example.com');
		const dA = await makeDevice(rA, oA);
		const sA = await makeSession(rA, dA, oA);
		const rB = await makeRestaurant('orders-tenant-B');
		const oB = await makeOwner(rB, 'orders-tenant-b@example.com');
		const dB = await makeDevice(rB, oB, 'POS2', 'c'.repeat(64));

		const error = await expectError(
			`insert into orders (
				restaurant_id, pos_session_id, device_id, employee_user_id, order_type, status,
				tax_mode, currency_code, menu_version, subtotal_minor, tax_minor, total_minor,
				opened_at, paid_at
			) values ($1, $2, $3, $4, 'takeaway', 'paid', 'exclusive', 'USD', 1, 1000, 100, 1100,
				now(), now())`,
			[rB, sA, dB, oB]
		);
		expect(error.code).toBe('23503');
		expect(error.constraint).toBe('orders_session_fk');
	});

	it('payments_cash_fields enforces cash vs card/mobile shape', async () => {
		const r = await makeRestaurant('payments-cash');
		const o = await makeOwner(r, 'payments-cash@example.com');
		const d = await makeDevice(r, o);
		const s = await makeSession(r, d, o);
		const orderId = await makeOrder(r, s, d, o);

		const changeWrong = await expectError(
			`insert into payments (
				restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
			) values ($1, $2, 'cash', 1100, 2000, 800, now())`,
			[r, orderId]
		);
		expect(changeWrong.constraint).toBe('payments_cash_fields');

		const tenderedShort = await expectError(
			`insert into payments (
				restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
			) values ($1, $2, 'cash', 1100, 1000, -100, now())`,
			[r, orderId]
		);
		expect(tenderedShort.constraint).toBe('payments_cash_fields');

		const cardWithTendered = await expectError(
			`insert into payments (
				restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
			) values ($1, $2, 'card', 1100, 1100, 0, now())`,
			[r, orderId]
		);
		expect(cardWithTendered.constraint).toBe('payments_cash_fields');

		const cashNullTendered = await expectError(
			`insert into payments (
				restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
			) values ($1, $2, 'cash', 1100, null, null, now())`,
			[r, orderId]
		);
		expect(cashNullTendered.constraint).toBe('payments_cash_fields');

		const amountNegative = await expectError(
			`insert into payments (
				restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
			) values ($1, $2, 'card', -1, null, null, now())`,
			[r, orderId]
		);
		expect(amountNegative.constraint).toBe('payments_amount_minor_non_negative');
	});

	it('MANDATORY (spec 29 offline sync — the invoice half): the namespace is per device', async () => {
		const r = await makeRestaurant('invoices-device-namespace');
		const o = await makeOwner(r, 'invoices-device-namespace@example.com');
		const d1 = await makeDevice(r, o);
		const d2 = await makeDevice(r, o, 'POS2', 'e'.repeat(64));
		const s = await makeSession(r, d1, o);
		const orderA = await makeOrder(r, s, d1, o);
		const orderB = await makeOrder(r, s, d1, o);
		const orderC = await makeOrder(r, s, d2, o);

		await makeInvoice(r, orderA, d1, 1, 'POS1-000001');

		const numberDup = await expectError(
			`insert into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number,
				 total_minor, issued_at)
				 values ($1, $2, $3, 2, 'POS1-000001', 1100, now())`,
			[r, orderB, d1]
		);
		expect(numberDup.code).toBe('23505');
		expect(numberDup.constraint).toBe('invoices_device_number_unique');

		// Same number on a different device: namespace is per device (invariant 5).
		const { rowCount } = await pool.query(
			`insert into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number,
				 total_minor, issued_at)
				 values ($1, $2, $3, 1, 'POS1-000001', 1100, now())`,
			[r, orderC, d2]
		);
		expect(rowCount).toBe(1);

		// Two invoices for one order.
		const twoInvoices = await expectError(
			`insert into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number,
				 total_minor, issued_at)
				 values ($1, $2, $3, 3, 'POS1-000003', 1100, now())`,
			[r, orderA, d1]
		);
		expect(twoInvoices.constraint).toBe('invoices_order_unique');

		// Same seq twice on one device with different numbers.
		await makeInvoice(r, orderB, d1, 2, 'POS1-000002');
		const orderD = await makeOrder(r, s, d1, o);
		const seqDup = await expectError(
			`insert into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number,
				 total_minor, issued_at)
				 values ($1, $2, $3, 2, 'POS1-000004', 1100, now())`,
			[r, orderD, d1]
		);
		expect(seqDup.constraint).toBe('invoices_device_seq_unique');

		const seqZero = await expectError(
			`insert into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number,
				 total_minor, issued_at)
				 values ($1, $2, $3, 0, 'POS1-000000', 1100, now())`,
			[r, orderD, d1]
		);
		expect(seqZero.constraint).toBe('invoices_seq_range');

		const badFormat = await expectError(
			`insert into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number,
				 total_minor, issued_at)
				 values ($1, $2, $3, 3, 'POS1-1', 1100, now())`,
			[r, orderD, d1]
		);
		expect(badFormat.constraint).toBe('invoices_number_format');

		const lowerCase = await expectError(
			`insert into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number,
				 total_minor, issued_at)
				 values ($1, $2, $3, 3, 'pos1-000003', 1100, now())`,
			[r, orderD, d1]
		);
		expect(lowerCase.constraint).toBe('invoices_number_format');
	});

	it('order_lines constraints: quantity, tax range, uniqueness, tenant', async () => {
		const r = await makeRestaurant('order-lines');
		const o = await makeOwner(r, 'order-lines@example.com');
		const d = await makeDevice(r, o);
		const s = await makeSession(r, d, o);
		const orderId = await makeOrder(r, s, d, o);
		const menuItemId = await makeMenuItem(r);
		await makeLine(r, orderId, menuItemId, { lineNo: 1 });

		const zeroQty = await expectError(
			`insert into order_lines (restaurant_id, order_id, line_no, menu_item_id, item_name,
			 quantity, unit_price_minor, tax_rate_bp, discount_minor, status)
			 values ($1, $2, 2, $3, 'Tea', 0, 850, 825, 0, 'new')`,
			[r, orderId, menuItemId]
		);
		expect(zeroQty.constraint).toBe('order_lines_quantity_positive');

		const tooHighRate = await expectError(
			`insert into order_lines (restaurant_id, order_id, line_no, menu_item_id, item_name,
			 quantity, unit_price_minor, tax_rate_bp, discount_minor, status)
			 values ($1, $2, 3, $3, 'Tea', 1, 850, 10001, 0, 'new')`,
			[r, orderId, menuItemId]
		);
		expect(tooHighRate.constraint).toBe('order_lines_tax_rate_bp_range');

		const dupLineNo = await expectError(
			`insert into order_lines (restaurant_id, order_id, line_no, menu_item_id, item_name,
			 quantity, unit_price_minor, tax_rate_bp, discount_minor, status)
			 values ($1, $2, 1, $3, 'Tea', 1, 850, 825, 0, 'new')`,
			[r, orderId, menuItemId]
		);
		expect(dupLineNo.constraint).toBe('order_lines_order_line_no_unique');

		const negPrice = await expectError(
			`insert into order_lines (restaurant_id, order_id, line_no, menu_item_id, item_name,
			 quantity, unit_price_minor, tax_rate_bp, discount_minor, status)
			 values ($1, $2, 4, $3, 'Tea', 1, -1, 825, 0, 'new')`,
			[r, orderId, menuItemId]
		);
		expect(negPrice.constraint).toBe('order_lines_unit_price_minor_non_negative');

		// tenant isolation
		const rOther = await makeRestaurant('order-lines-other');
		const oOther = await makeOwner(rOther, 'order-lines-other@example.com');
		const menuItemOther = await makeMenuItem(rOther);
		const tenantMismatch = await expectError(
			`insert into order_lines (restaurant_id, order_id, line_no, menu_item_id, item_name,
			 quantity, unit_price_minor, tax_rate_bp, discount_minor, status)
			 values ($1, $2, 5, $3, 'Tea', 1, 850, 825, 0, 'new')`,
			[r, orderId, menuItemOther]
		);
		expect(tenantMismatch.code).toBe('23503');
		expect(tenantMismatch.constraint).toBe('order_lines_menu_item_fk');
		expect(oOther).toBeTruthy();
	});

	it('MANDATORY (spec 29 — money bigint): Drizzle reads bigints for money columns', async () => {
		const r = await makeRestaurant('bigint-round-trip');
		const o = await makeOwner(r, 'bigint-round-trip@example.com');
		const d = await makeDevice(r, o);
		const s = await makeSession(r, d, o);
		const orderId = await makeOrder(r, s, d, o);
		await makePayment(r, orderId, 'cash', 1100, 2000, 900);

		const [orderRow] = await testDb()
			.select({ total: orders.totalMinor })
			.from(orders)
			.where(eq(orders.id, orderId));
		expect(orderRow.total).toBe(1100n);
		expect(typeof orderRow.total).toBe('bigint');

		const [paymentRow] = await testDb()
			.select({ change: payments.changeMinor })
			.from(payments)
			.where(eq(payments.orderId, orderId));
		expect(paymentRow.change).toBe(900n);
	});
});

describe('pos_sync_ops constraints (T-08)', () => {
	it('MANDATORY (spec 29 — offline sync: retries never create duplicates)', async () => {
		const r = await makeRestaurant('sync-ops-idempotency');
		const o = await makeOwner(r, 'sync-ops-idempotency@example.com');
		const d = await makeDevice(r, o);
		const d2 = await makeDevice(r, o, 'POS2', 'f'.repeat(64));
		const clientOpId = crypto.randomUUID();

		const { rowCount } = await pool.query(
			`insert into pos_sync_ops (restaurant_id, device_id, received_via_device_id, client_op_id,
			 kind, status, occurred_at, payload)
			 values ($1, $2, $2, $3, 'pin.login', 'accepted', now(),
			 '{"outcome":"success"}'::jsonb)`,
			[r, d, clientOpId]
		);
		expect(rowCount).toBe(1);

		const duplicate = await expectError(
			`insert into pos_sync_ops (restaurant_id, device_id, received_via_device_id, client_op_id,
			 kind, status, occurred_at, payload)
			 values ($1, $2, $2, $3, 'pin.login', 'accepted', now(),
			 '{"outcome":"success"}'::jsonb)`,
			[r, d, clientOpId]
		);
		expect(duplicate.code).toBe('23505');
		expect(duplicate.constraint).toBe('pos_sync_ops_device_client_op_unique');

		const { rows: countRows } = await pool.query<{ c: string }>(
			`select count(*)::text as c from pos_sync_ops where device_id = $1 and client_op_id = $2`,
			[d, clientOpId]
		);
		expect(countRows[0].c).toBe('1');

		// Same client_op_id on a different device: accepted.
		const { rowCount: onOther } = await pool.query(
			`insert into pos_sync_ops (restaurant_id, device_id, received_via_device_id, client_op_id,
			 kind, status, occurred_at, payload)
			 values ($1, $2, $2, $3, 'pin.login', 'accepted', now(),
			 '{"outcome":"success"}'::jsonb)`,
			[r, d2, clientOpId]
		);
		expect(onOther).toBe(1);
	});

	it('payload NOT NULL is enforced', async () => {
		const r = await makeRestaurant('sync-ops-payload-null');
		const o = await makeOwner(r, 'sync-ops-payload-null@example.com');
		const d = await makeDevice(r, o);
		const error = await expectError(
			`insert into pos_sync_ops (restaurant_id, device_id, received_via_device_id, client_op_id,
			 kind, status, occurred_at, payload)
			 values ($1, $2, $2, gen_random_uuid(), 'pin.login', 'accepted', now(), null)`,
			[r, d]
		);
		expect(error.code).toBe('23502');
	});

	it('a revoked device may still be named on an op — the queued fact stands', async () => {
		const r = await makeRestaurant('sync-ops-revoked');
		const o = await makeOwner(r, 'sync-ops-revoked@example.com');
		const d = await makeDevice(r, o);
		await pool.query(
			`update pos_devices set revoked_at = now(), revoked_by_user_id = $2 where id = $1`,
			[d, o]
		);
		const { rowCount } = await pool.query(
			`insert into pos_sync_ops (restaurant_id, device_id, received_via_device_id, client_op_id,
			 kind, status, occurred_at, payload)
			 values ($1, $2, $2, gen_random_uuid(), 'pin.login', 'accepted', now(),
			 '{"outcome":"success"}'::jsonb)`,
			[r, d]
		);
		expect(rowCount).toBe(1);
	});

	it('accepts_card and accepts_mobile land null with no default, and toggle freely', async () => {
		const r = await makeRestaurant('sync-ops-settings');
		await pool.query(
			`insert into restaurant_settings (restaurant_id, time_zone) values ($1, 'UTC')`,
			[r]
		);
		const { rows } = await pool.query<{
			accepts_card: boolean | null;
			accepts_mobile: boolean | null;
		}>(`select accepts_card, accepts_mobile from restaurant_settings where restaurant_id = $1`, [
			r
		]);
		expect(rows[0].accepts_card).toBeNull();
		expect(rows[0].accepts_mobile).toBeNull();

		const on = await pool.query(
			`update restaurant_settings set accepts_card = true, accepts_mobile = false
			 where restaurant_id = $1`,
			[r]
		);
		expect(on.rowCount).toBe(1);
		const off = await pool.query(
			`update restaurant_settings set accepts_card = null, accepts_mobile = null
			 where restaurant_id = $1`,
			[r]
		);
		expect(off.rowCount).toBe(1);
	});
});

describe('accounting constraints (T-08)', () => {
	it('accounts_code_format enforces four digits, and the uniqueness is per restaurant', async () => {
		const r = await makeRestaurant('accounts-format');
		const short = await expectError(
			`insert into accounts (restaurant_id, code, name, type)
			 values ($1, '100', 'Bad', 'asset')`,
			[r]
		);
		expect(short.constraint).toBe('accounts_code_format');

		const long = await expectError(
			`insert into accounts (restaurant_id, code, name, type)
			 values ($1, '10000', 'Bad', 'asset')`,
			[r]
		);
		expect(long.constraint).toBe('accounts_code_format');

		const alpha = await expectError(
			`insert into accounts (restaurant_id, code, name, type)
			 values ($1, '1A00', 'Bad', 'asset')`,
			[r]
		);
		expect(alpha.constraint).toBe('accounts_code_format');

		await makeAccount(r, '1000', 'Cash on Hand', 'asset');
		const dup = await expectError(
			`insert into accounts (restaurant_id, code, name, type)
			 values ($1, '1000', 'Cash on Hand', 'asset')`,
			[r]
		);
		expect(dup.code).toBe('23505');
		expect(dup.constraint).toBe('accounts_restaurant_code_unique');

		// Same code in a different restaurant: fine.
		const rOther = await makeRestaurant('accounts-format-other');
		const otherId = await makeAccount(rOther, '1000');
		expect(otherId).toBeTruthy();
	});

	it('MANDATORY (spec 29 — well-formed lines): one_side and non_negative', async () => {
		const r = await makeRestaurant('journal-lines');
		const accountId = await makeAccount(r, '1000');

		await withRollback(async (client) => {
			const entryId = await makeEntry(client, r);
			try {
				await client.query(
					`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
					 debit_minor, credit_minor) values ($1, $2, $3, 1, 5, 5)`,
					[r, entryId, accountId]
				);
				throw new Error('expected 23514');
			} catch (error) {
				expect((error as pg.DatabaseError).code).toBe('23514');
				expect((error as pg.DatabaseError).constraint).toBe('journal_entry_lines_one_side');
			}
		});

		await withRollback(async (client) => {
			const entryId = await makeEntry(client, r);
			try {
				await client.query(
					`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
					 debit_minor, credit_minor) values ($1, $2, $3, 1, 0, 0)`,
					[r, entryId, accountId]
				);
				throw new Error('expected 23514');
			} catch (error) {
				expect((error as pg.DatabaseError).constraint).toBe('journal_entry_lines_one_side');
			}
		});

		await withRollback(async (client) => {
			const entryId = await makeEntry(client, r);
			try {
				await client.query(
					`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
					 debit_minor, credit_minor) values ($1, $2, $3, 1, -1, 0)`,
					[r, entryId, accountId]
				);
				throw new Error('expected 23514');
			} catch (error) {
				expect((error as pg.DatabaseError).constraint).toBe('journal_entry_lines_non_negative');
			}
		});
	});

	it('journal_entry_lines FKs and uniqueness: entry_line_no, cross-tenant rejection, accepted pair', async () => {
		const rA = await makeRestaurant('journal-fks-A');
		const rB = await makeRestaurant('journal-fks-B');
		const accountA = await makeAccount(rA, '1000');
		const accountBcode = await makeAccount(rB, '1000');

		await withRollback(async (client) => {
			const entryId = await makeEntry(client, rA);

			// Cross-tenant account_id — inside a SAVEPOINT so the transaction can
			// keep running after the FK violation aborts it.
			await client.query('savepoint sp_account_fk');
			try {
				await client.query(
					`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
					 debit_minor, credit_minor) values ($1, $2, $3, 1, 100, 0)`,
					[rA, entryId, accountBcode]
				);
				throw new Error('expected 23503');
			} catch (error) {
				expect((error as pg.DatabaseError).code).toBe('23503');
				expect((error as pg.DatabaseError).constraint).toBe('journal_entry_lines_account_fk');
				await client.query('rollback to savepoint sp_account_fk');
			}
			await client.query('release savepoint sp_account_fk');

			// duplicate (entry_id, line_no)
			const { rowCount: firstLine } = await client.query(
				`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
				 debit_minor, credit_minor) values ($1, $2, $3, 1, 1100, 0)`,
				[rA, entryId, accountA]
			);
			expect(firstLine).toBe(1);
			await client.query('savepoint sp_dup_line_no');
			try {
				await client.query(
					`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
					 debit_minor, credit_minor) values ($1, $2, $3, 1, 0, 1100)`,
					[rA, entryId, accountA]
				);
				throw new Error('expected 23505');
			} catch (error) {
				expect((error as pg.DatabaseError).code).toBe('23505');
				expect((error as pg.DatabaseError).constraint).toBe(
					'journal_entry_lines_entry_line_no_unique'
				);
				await client.query('rollback to savepoint sp_dup_line_no');
			}
			await client.query('release savepoint sp_dup_line_no');

			// A balanced pair reads back as bigints (through raw pg's text cast).
			const revenueA = await makeAccount(rA, '4000', 'Sales Revenue', 'revenue');
			const { rowCount: creditLine } = await client.query(
				`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
				 debit_minor, credit_minor) values ($1, $2, $3, 2, 0, 1100)`,
				[rA, entryId, revenueA]
			);
			expect(creditLine).toBe(1);
			const { rows: debitRows } = await client.query<{ debit_text: string }>(
				`select debit_minor::text as debit_text from journal_entry_lines
				 where entry_id = $1 and line_no = 1`,
				[entryId]
			);
			expect(debitRows[0].debit_text).toBe('1100');
		});
	});
});

// tasks/inventory-cogs T-16 exports MOVEMENT_TYPES and MOVEMENT_SOURCES from
// src/lib/server/inventory/movements.ts; restated here so the schema tests do
// not depend on the ledger writer, and pinned to the CHECK literals below.
const MOVEMENT_TYPES = [
	'purchase',
	'purchase_reversal',
	'opening_stock',
	'sale_consumption',
	'waste',
	'count_adjustment',
	'comp',
	'revaluation'
] as const;
const MOVEMENT_SOURCES = [
	'purchase',
	'order',
	'waste_entry',
	'stock_count',
	'opening_stock'
] as const;

async function makeIngredient(
	restaurantId: string,
	name = 'Flour',
	overrides: { onHandQty?: string; valueMinor?: number | bigint; avgMicro?: number | bigint } = {}
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into ingredients (restaurant_id, name, base_unit, on_hand_qty,
		 inventory_value_minor, avg_unit_cost_micro)
		 values ($1, $2, 'g', $3, $4, $5) returning id`,
		[
			restaurantId,
			name,
			overrides.onHandQty ?? '0.000',
			overrides.valueMinor ?? 0,
			overrides.avgMicro ?? 0
		]
	);
	return rows[0].id;
}

async function makeModifier(restaurantId: string): Promise<string> {
	const { rows: groupRows } = await pool.query<{ id: string }>(
		`insert into modifier_groups (restaurant_id, name) values ($1, 'Extras') returning id`,
		[restaurantId]
	);
	const { rows } = await pool.query<{ id: string }>(
		`insert into modifiers (restaurant_id, group_id, name, price_delta_minor)
		 values ($1, $2, 'No cheese', -50) returning id`,
		[restaurantId, groupRows[0].id]
	);
	return rows[0].id;
}

function insertMovement(
	restaurantId: string,
	ingredientId: string,
	movementType: string,
	qty: string,
	costMinor: number,
	sourceType = 'purchase'
): Promise<pg.QueryResult> {
	return pool.query(
		`insert into stock_movements (restaurant_id, ingredient_id, movement_type, qty, cost_minor,
		 source_type, source_id, business_date, occurred_at)
		 values ($1, $2, $3, $4, $5, $6, gen_random_uuid(), '2026-09-28', now())`,
		[restaurantId, ingredientId, movementType, qty, costMinor, sourceType]
	);
}

describe('inventory constraints (inventory-cogs T-07)', () => {
	it('MOVEMENT_TYPES and MOVEMENT_SOURCES restated locally match the wire literals', () => {
		expect([...MOVEMENT_TYPES]).toEqual([
			'purchase',
			'purchase_reversal',
			'opening_stock',
			'sale_consumption',
			'waste',
			'count_adjustment',
			'comp',
			'revaluation'
		]);
		expect([...MOVEMENT_SOURCES]).toEqual([
			'purchase',
			'order',
			'waste_entry',
			'stock_count',
			'opening_stock'
		]);
	});

	it('stock_movements accepts every MOVEMENT_TYPES and MOVEMENT_SOURCES value and rejects others', async () => {
		const r = await makeRestaurant('inv-movement-sets');
		const i = await makeIngredient(r);
		const sample: Record<(typeof MOVEMENT_TYPES)[number], [string, number]> = {
			purchase: ['1.000', 100],
			purchase_reversal: ['-1.000', -100],
			opening_stock: ['1.000', 100],
			sale_consumption: ['-1.000', -100],
			waste: ['-1.000', -100],
			count_adjustment: ['1.000', 100],
			comp: ['-1.000', -100],
			revaluation: ['0.000', 5]
		};
		for (const type of MOVEMENT_TYPES) {
			const [qty, cost] = sample[type];
			const { rowCount } = await insertMovement(r, i, type, qty, cost);
			expect(rowCount).toBe(1);
		}
		for (const source of MOVEMENT_SOURCES) {
			const { rowCount } = await insertMovement(r, i, 'purchase', '1.000', 1, source);
			expect(rowCount).toBe(1);
		}

		const badType = await expectError(
			`insert into stock_movements (restaurant_id, ingredient_id, movement_type, qty, cost_minor,
			 source_type, source_id, business_date, occurred_at)
			 values ($1, $2, 'theft', '-1.000', -1, 'purchase', gen_random_uuid(), '2026-09-28', now())`,
			[r, i]
		);
		expect(badType.code).toBe('23514');
		expect(['stock_movements_type_valid', 'stock_movements_sign_by_type']).toContain(
			badType.constraint
		);

		const badSource = await expectError(
			`insert into stock_movements (restaurant_id, ingredient_id, movement_type, qty, cost_minor,
			 source_type, source_id, business_date, occurred_at)
			 values ($1, $2, 'purchase', '1.000', 1, 'expense', gen_random_uuid(), '2026-09-28', now())`,
			[r, i]
		);
		expect(badSource.code).toBe('23514');
		expect(badSource.constraint).toBe('stock_movements_source_valid');
	});

	it('ingredients: the three costing CHECKs', async () => {
		const r = await makeRestaurant('inv-costing-checks');

		const negativeAvg = await expectError(
			`insert into ingredients (restaurant_id, name, base_unit, avg_unit_cost_micro)
			 values ($1, 'Salt', 'g', -1)`,
			[r]
		);
		expect(negativeAvg.code).toBe('23514');
		expect(negativeAvg.constraint).toBe('ingredients_avg_non_negative');

		const zeroQtyValue = await expectError(
			`insert into ingredients (restaurant_id, name, base_unit, on_hand_qty, inventory_value_minor)
			 values ($1, 'Sugar', 'g', '0.000', 5)`,
			[r]
		);
		expect(zeroQtyValue.code).toBe('23514');
		expect(zeroQtyValue.constraint).toBe('ingredients_zero_qty_zero_value');

		const negativeValue = await expectError(
			`insert into ingredients (restaurant_id, name, base_unit, on_hand_qty, inventory_value_minor)
			 values ($1, 'Rice', 'g', '1.000', -1)`,
			[r]
		);
		expect(negativeValue.code).toBe('23514');
		expect(negativeValue.constraint).toBe('ingredients_positive_qty_non_negative_value');

		// Negative stock may hold a negative value (sold before its delivery was entered).
		const negativeStock = await makeIngredient(r, 'Oil', { onHandQty: '-2.000', valueMinor: -30 });
		expect(negativeStock).toBeTruthy();
	});

	it('ingredients_name_unique is case-insensitive among live rows; archiving frees the name', async () => {
		const r = await makeRestaurant('inv-name-unique');
		const meat = await makeIngredient(r, 'Meat');
		const dup = await expectError(
			`insert into ingredients (restaurant_id, name, base_unit) values ($1, 'meat', 'g')`,
			[r]
		);
		expect(dup.code).toBe('23505');
		expect(dup.constraint).toBe('ingredients_name_unique');

		await pool.query('update ingredients set archived_at = now() where id = $1', [meat]);
		const again = await makeIngredient(r, 'meat');
		expect(again).toBeTruthy();
	});

	it('recipe_lines: exactly one owner, and the sign rule by owner', async () => {
		const r = await makeRestaurant('inv-recipe-lines');
		const item = await makeMenuItem(r);
		const modifier = await makeModifier(r);
		const i = await makeIngredient(r, 'Cheese');

		const both = await expectError(
			`insert into recipe_lines (restaurant_id, menu_item_id, modifier_id, ingredient_id, qty)
			 values ($1, $2, $3, $4, '1.000')`,
			[r, item, modifier, i]
		);
		expect(both.code).toBe('23514');
		expect(both.constraint).toBe('recipe_lines_one_owner');

		const neither = await expectError(
			`insert into recipe_lines (restaurant_id, ingredient_id, qty) values ($1, $2, '1.000')`,
			[r, i]
		);
		expect(neither.code).toBe('23514');
		expect(neither.constraint).toBe('recipe_lines_one_owner');

		const negativeItemLine = await expectError(
			`insert into recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty)
			 values ($1, $2, $3, '-1.000')`,
			[r, item, i]
		);
		expect(negativeItemLine.code).toBe('23514');
		expect(negativeItemLine.constraint).toBe('recipe_lines_qty_sign');

		const { rowCount } = await pool.query(
			`insert into recipe_lines (restaurant_id, modifier_id, ingredient_id, qty)
			 values ($1, $2, $3, '-30.000')`,
			[r, modifier, i]
		);
		expect(rowCount).toBe(1);
	});

	it('stock_movements_sign_by_type rejects a positive consumption and a revaluation that moves goods', async () => {
		const r = await makeRestaurant('inv-sign-by-type');
		const i = await makeIngredient(r);

		const positiveConsumption = await expectError(
			`insert into stock_movements (restaurant_id, ingredient_id, movement_type, qty, cost_minor,
			 source_type, source_id, business_date, occurred_at)
			 values ($1, $2, 'sale_consumption', '1.000', 0, 'order', gen_random_uuid(), '2026-09-28', now())`,
			[r, i]
		);
		expect(positiveConsumption.code).toBe('23514');
		expect(positiveConsumption.constraint).toBe('stock_movements_sign_by_type');

		const revaluationWithGoods = await expectError(
			`insert into stock_movements (restaurant_id, ingredient_id, movement_type, qty, cost_minor,
			 source_type, source_id, business_date, occurred_at)
			 values ($1, $2, 'revaluation', '1.000', 5, 'purchase', gen_random_uuid(), '2026-09-28', now())`,
			[r, i]
		);
		expect(revaluationWithGoods.code).toBe('23514');
		expect(revaluationWithGoods.constraint).toBe('stock_movements_sign_by_type');

		const { rowCount } = await insertMovement(r, i, 'revaluation', '0.000', 5);
		expect(rowCount).toBe(1);
	});

	it("waste_entries_note_for_other requires a note when the reason is 'other'", async () => {
		const r = await makeRestaurant('inv-waste-note');
		const o = await makeOwner(r, 'inv-waste-note@example.com');
		const i = await makeIngredient(r);
		const error = await expectError(
			`insert into waste_entries (restaurant_id, ingredient_id, qty, reason, business_date,
			 recorded_by_user_id) values ($1, $2, '1.000', 'other', '2026-09-28', $3)`,
			[r, i, o]
		);
		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('waste_entries_note_for_other');
	});

	it('stock_count_lines_difference holds difference = counted − system', async () => {
		const r = await makeRestaurant('inv-count-difference');
		const o = await makeOwner(r, 'inv-count-difference@example.com');
		const i = await makeIngredient(r);
		const { rows } = await pool.query<{ id: string }>(
			`insert into stock_counts (restaurant_id, business_date, counted_at, recorded_by_user_id)
			 values ($1, '2026-09-28', now(), $2) returning id`,
			[r, o]
		);
		const error = await expectError(
			`insert into stock_count_lines (restaurant_id, count_id, ingredient_id, system_qty,
			 counted_qty, difference_qty, cost_minor) values ($1, $2, $3, '10.000', '8.000', '2.000', 0)`,
			[r, rows[0].id, i]
		);
		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('stock_count_lines_difference');
	});

	it('opening_stock_entries_ingredient_unique allows one opening entry per ingredient', async () => {
		const r = await makeRestaurant('inv-opening-unique');
		const o = await makeOwner(r, 'inv-opening-unique@example.com');
		const i = await makeIngredient(r);
		const insert = `insert into opening_stock_entries (restaurant_id, ingredient_id,
			purchase_unit_name, unit_qty, base_qty_per_unit, base_qty, unit_cost_minor, value_minor,
			business_date, recorded_by_user_id)
			values ($1, $2, 'kg', '2.000', '1000.000', '2000.000', 550, 1100, '2026-09-28', $3)`;
		await pool.query(insert, [r, i, o]);
		const error = await expectError(insert, [r, i, o]);
		expect(error.code).toBe('23505');
		expect(error.constraint).toBe('opening_stock_entries_ingredient_unique');
	});

	it('purchases_reversal_fields refuses a reversal stamp without a reason', async () => {
		const r = await makeRestaurant('inv-purchase-reversal');
		const o = await makeOwner(r, 'inv-purchase-reversal@example.com');
		const error = await expectError(
			`insert into purchases (restaurant_id, supplier_name, business_date, paid_by, total_minor,
			 recorded_by_user_id, reversed_at, reversed_by_user_id)
			 values ($1, 'Market', '2026-09-28', 'cash', 1100, $2, now(), $2)`,
			[r, o]
		);
		expect(error.code).toBe('23514');
		expect(error.constraint).toBe('purchases_reversal_fields');
	});

	it('journal_entries_reverses_entry_unique allows one reversal per entry', async () => {
		const r = await makeRestaurant('inv-one-reversal');
		const cash = await makeAccount(r, '1000');
		const inventory = await makeAccount(r, '1200', 'Inventory', 'asset');
		await withRollback(async (client) => {
			const insertEntry = async (reverses: string | null): Promise<string> => {
				const { rows } = await client.query<{ id: string }>(
					`insert into journal_entries (restaurant_id, business_date, event, source_type,
					 source_id, memo, reverses_entry_id)
					 values ($1, '2026-09-28', 'purchase_paid', 'purchase', gen_random_uuid(), 'test', $2)
					 returning id`,
					[r, reverses]
				);
				const id = rows[0].id;
				// Balanced lines, so the deferred balance trigger would pass: the
				// unique index is the only thing that can fail below.
				await client.query(
					`insert into journal_entry_lines (restaurant_id, entry_id, account_id, line_no,
					 debit_minor, credit_minor) values ($1, $2, $3, 1, 1100, 0), ($1, $2, $4, 2, 0, 1100)`,
					[r, id, reverses ? cash : inventory, reverses ? inventory : cash]
				);
				return id;
			};
			const original = await insertEntry(null);
			await insertEntry(original);
			try {
				await insertEntry(original);
				throw new Error('expected 23505');
			} catch (error) {
				expect((error as pg.DatabaseError).code).toBe('23505');
				expect((error as pg.DatabaseError).constraint).toBe(
					'journal_entries_reverses_entry_unique'
				);
			}
		});
	});

	it("journal_entries accepts 'purchase_paid' from 'purchase' and rejects source 'expense'", async () => {
		const r = await makeRestaurant('inv-journal-sources');
		await withRollback(async (client) => {
			const { rowCount } = await client.query(
				`insert into journal_entries (restaurant_id, business_date, event, source_type,
				 source_id, memo) values ($1, '2026-09-28', 'purchase_paid', 'purchase',
				 gen_random_uuid(), 'test')`,
				[r]
			);
			expect(rowCount).toBe(1);
			try {
				await client.query(
					`insert into journal_entries (restaurant_id, business_date, event, source_type,
					 source_id, memo) values ($1, '2026-09-28', 'purchase_paid', 'expense',
					 gen_random_uuid(), 'test')`,
					[r]
				);
				throw new Error('expected 23514');
			} catch (error) {
				expect((error as pg.DatabaseError).code).toBe('23514');
				expect((error as pg.DatabaseError).constraint).toBe('journal_entries_source_type_valid');
			}
		});
	});
});
