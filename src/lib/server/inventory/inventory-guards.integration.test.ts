import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';

// INVARIANT 2 IN THE DATABASE for the inventory records (spec 3; migration
// 0014, tasks/inventory-cogs T-08). For each of the five append-only tables:
// insert a valid row, then prove UPDATE and DELETE are each refused with the
// message raised by 0012's posted_record_append_only(), and that the row is
// unchanged afterwards. Raw pg, so the rejection is observed at its own layer.
// The per-test truncate in integration-setup.ts clears the rows; TRUNCATE is
// deliberately not blocked by these row-level triggers (0014's header).

const pool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await pool.end();
});

async function expectError(sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
	try {
		await pool.query(sql, params);
	} catch (error) {
		return error as pg.DatabaseError;
	}
	throw new Error(`Expected this statement to be rejected, but it succeeded:\n${sql}`);
}

async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T> {
	const { rows } = await pool.query<T>(sql, params);
	return rows[0];
}

type Fixture = { restaurantId: string; ownerId: string; ingredientId: string };

async function makeFixture(): Promise<Fixture> {
	const { id: restaurantId } = await one<{ id: string }>(
		'insert into restaurants (name) values ($1) returning id',
		['Guards Cafe']
	);
	const { id: ownerId } = await one<{ id: string }>(
		`insert into users (restaurant_id, role, display_name, email, password_hash)
		 values ($1, 'owner', 'Owner', 'guards@example.com', 'not-a-real-hash') returning id`,
		[restaurantId]
	);
	const { id: ingredientId } = await one<{ id: string }>(
		`insert into ingredients (restaurant_id, name, base_unit) values ($1, 'Flour', 'g')
		 returning id`,
		[restaurantId]
	);
	return { restaurantId, ownerId, ingredientId };
}

// Each case inserts one valid row and returns the table name and its id.
const cases: {
	table: string;
	insert: (f: Fixture) => Promise<string>;
	// A column the UPDATE tries to change.
	column: string;
	value: string;
}[] = [
	{
		table: 'stock_movements',
		column: 'qty',
		value: '99.000',
		insert: async (f) =>
			(
				await one<{ id: string }>(
					`insert into stock_movements (restaurant_id, ingredient_id, movement_type, qty,
					 cost_minor, source_type, source_id, business_date, occurred_at)
					 values ($1, $2, 'purchase', '1000.000', 550, 'purchase', gen_random_uuid(),
					 '2026-09-28', now()) returning id::text`,
					[f.restaurantId, f.ingredientId]
				)
			).id
	},
	{
		table: 'purchase_lines',
		column: 'line_cost_minor',
		value: '1',
		insert: async (f) => {
			const { id: purchaseId } = await one<{ id: string }>(
				`insert into purchases (restaurant_id, supplier_name, business_date, paid_by,
				 total_minor, recorded_by_user_id)
				 values ($1, 'Market', '2026-09-28', 'credit', 550, $2) returning id`,
				[f.restaurantId, f.ownerId]
			);
			return (
				await one<{ id: string }>(
					`insert into purchase_lines (restaurant_id, purchase_id, line_no, ingredient_id,
					 purchase_unit_name, unit_qty, base_qty_per_unit, base_qty, line_cost_minor)
					 values ($1, $2, 1, $3, 'kg', '1.000', '1000.000', '1000.000', 550) returning id`,
					[f.restaurantId, purchaseId, f.ingredientId]
				)
			).id;
		}
	},
	{
		table: 'stock_count_lines',
		column: 'counted_qty',
		value: '5.000',
		insert: async (f) => {
			const { id: countId } = await one<{ id: string }>(
				`insert into stock_counts (restaurant_id, business_date, counted_at, recorded_by_user_id)
				 values ($1, '2026-09-28', now(), $2) returning id`,
				[f.restaurantId, f.ownerId]
			);
			return (
				await one<{ id: string }>(
					`insert into stock_count_lines (restaurant_id, count_id, ingredient_id, system_qty,
					 counted_qty, difference_qty, cost_minor)
					 values ($1, $2, $3, '10.000', '8.000', '-2.000', -1) returning id`,
					[f.restaurantId, countId, f.ingredientId]
				)
			).id;
		}
	},
	{
		table: 'waste_entries',
		column: 'qty',
		value: '9.000',
		insert: async (f) =>
			(
				await one<{ id: string }>(
					`insert into waste_entries (restaurant_id, ingredient_id, qty, reason, business_date,
					 recorded_by_user_id) values ($1, $2, '1.000', 'spoilage', '2026-09-28', $3)
					 returning id`,
					[f.restaurantId, f.ingredientId, f.ownerId]
				)
			).id
	},
	{
		table: 'opening_stock_entries',
		column: 'value_minor',
		value: '1',
		insert: async (f) =>
			(
				await one<{ id: string }>(
					`insert into opening_stock_entries (restaurant_id, ingredient_id, purchase_unit_name,
					 unit_qty, base_qty_per_unit, base_qty, unit_cost_minor, value_minor, business_date,
					 recorded_by_user_id)
					 values ($1, $2, 'kg', '2.000', '1000.000', '2000.000', 550, 1100, '2026-09-28', $3)
					 returning id`,
					[f.restaurantId, f.ingredientId, f.ownerId]
				)
			).id
	}
];

describe('inventory records are append-only (invariant 2; migration 0014)', () => {
	for (const c of cases) {
		it(`${c.table}: UPDATE and DELETE are refused and the row is unchanged`, async () => {
			const f = await makeFixture();
			const id = await c.insert(f);
			const before = await one<Record<string, unknown>>(
				`select * from ${c.table} where id::text = $1`,
				[id]
			);

			const update = await expectError(
				`update ${c.table} set ${c.column} = $1 where id::text = $2`,
				[c.value, id]
			);
			expect(update.message).toBe(`${c.table} is append-only: UPDATE is not permitted`);

			const del = await expectError(`delete from ${c.table} where id::text = $1`, [id]);
			expect(del.message).toBe(`${c.table} is append-only: DELETE is not permitted`);

			const after = await one<Record<string, unknown>>(
				`select * from ${c.table} where id::text = $1`,
				[id]
			);
			expect(after).toEqual(before);
		});
	}
});
