import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { ingredients, stockMovements } from '../db/schema/inventory';
import { onRestaurantCreated } from '../restaurants';
import { ROUNDING_RULE, minor } from '../../money';
import { parseQty, qty, type Qty } from '../../money/quantity';
import { unitCostMicro } from '../../money/costing';
import {
	MOVEMENT_SOURCES,
	MOVEMENT_TYPES,
	applyMovements,
	lockIngredients,
	type MovementContext,
	type MovementRequest
} from './movements';
import { todayInZone } from './business-date';

// THE LEDGER WRITER against the real database (tasks/inventory-cogs T-16).

const pool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await pool.end();
	await closeTestDb();
});

async function makeRestaurant(
	name = 'Ledger Cafe',
	timeZone = 'Africa/Mogadishu'
): Promise<string> {
	const [row] = await testDb()
		.insert(restaurants)
		.values({ name })
		.returning({ id: restaurants.id });
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, row.id, { restaurantName: name, timeZone })
	);
	return row.id;
}

async function makeIngredient(restaurantId: string, name: string): Promise<string> {
	const [row] = await testDb()
		.insert(ingredients)
		.values({ restaurantId, name, baseUnit: 'g' })
		.returning({ id: ingredients.id });
	return row.id;
}

function ctx(
	restaurantId: string,
	sourceType: MovementContext['sourceType'] = 'purchase'
): MovementContext {
	return {
		restaurantId,
		sourceType,
		sourceId: randomUUID(),
		businessDate: '2026-09-28',
		occurredAt: new Date(),
		recordedByUserId: null
	};
}

async function cache(id: string) {
	const [row] = await testDb()
		.select({
			qty: ingredients.onHandQty,
			value: ingredients.inventoryValueMinor,
			avg: ingredients.avgUnitCostMicro
		})
		.from(ingredients)
		.where(eq(ingredients.id, id));
	return row;
}

async function ledger(id: string): Promise<{ qty: string; cost: string; rows: number }> {
	const result = await testDb().execute<{ qty: string; cost: string; rows: number }>(sql`
		select coalesce(sum(qty), 0)::numeric(12,3)::text as qty,
		       coalesce(sum(cost_minor), 0)::text as cost,
		       count(*)::int as rows
		from stock_movements where ingredient_id = ${id}
	`);
	return result.rows[0];
}

async function movementCount(): Promise<number> {
	const [row] = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(stockMovements);
	return row.c;
}

const inbound = (ingredientId: string, q: bigint, cost: bigint): MovementRequest => ({
	kind: 'inbound',
	type: 'purchase',
	ingredientId,
	qty: qty(q),
	costMinor: minor(cost)
});
const out = (ingredientId: string, q: bigint): MovementRequest => ({
	kind: 'out',
	type: 'sale_consumption',
	ingredientId,
	qty: qty(q)
});

let restaurantId: string;
beforeEach(async () => {
	restaurantId = await makeRestaurant();
});

describe('the constants are the CHECK literals', () => {
	it('MOVEMENT_TYPES and MOVEMENT_SOURCES match stock_movements_type_valid / _source_valid', () => {
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
});

describe('applyMovements', () => {
	it('spec 16 in grams: 10 kg at $50, 10 kg at $60, 150 g out → costs 5000, 6000, −82', async () => {
		const meat = await makeIngredient(restaurantId, 'Meat');
		await db.transaction(async (tx) => {
			await applyMovements(tx, ctx(restaurantId), [inbound(meat, 10000000n, 5000n)]);
			await applyMovements(tx, ctx(restaurantId), [inbound(meat, 10000000n, 6000n)]);
			const sale = await applyMovements(tx, ctx(restaurantId, 'order'), [out(meat, 150000n)]);
			expect(sale.costMinor).toBe(-82n);
		});
		const rows = await testDb()
			.select({ type: stockMovements.movementType, cost: stockMovements.costMinor })
			.from(stockMovements)
			.where(eq(stockMovements.ingredientId, meat))
			.orderBy(stockMovements.id);
		expect(rows).toEqual([
			{ type: 'purchase', cost: 5000n },
			{ type: 'purchase', cost: 6000n },
			{ type: 'sale_consumption', cost: -82n }
		]);
		expect(await cache(meat)).toEqual({ qty: '19850.000', value: 10918n, avg: 550000n });
	});

	it('sold into negative stock, then delivered: a purchase row AND a revaluation row', async () => {
		const meat = await makeIngredient(restaurantId, 'Meat');
		let revaluation = 0n;
		await db.transaction(async (tx) => {
			await applyMovements(tx, ctx(restaurantId, 'order'), [out(meat, 30000000n)]);
			const delivery = await applyMovements(tx, ctx(restaurantId), [
				inbound(meat, 50000000n, 25000n)
			]);
			revaluation = delivery.revaluationMinor;
			expect(delivery.costMinor).toBe(25000n);
		});
		expect(revaluation).toBe(-15000n);
		const rows = await testDb()
			.select({
				type: stockMovements.movementType,
				qty: stockMovements.qty,
				cost: stockMovements.costMinor
			})
			.from(stockMovements)
			.where(eq(stockMovements.ingredientId, meat))
			.orderBy(stockMovements.id);
		expect(rows).toEqual([
			{ type: 'sale_consumption', qty: '-30000.000', cost: 0n },
			{ type: 'purchase', qty: '50000.000', cost: 25000n },
			{ type: 'revaluation', qty: '0.000', cost: -15000n }
		]);
		expect(await cache(meat)).toEqual({ qty: '20000.000', value: 10000n, avg: 500000n });
	});

	it('after 200 seeded requests across three ingredients, every cache equals Σ its movements', async () => {
		const ids = [
			await makeIngredient(restaurantId, 'A'),
			await makeIngredient(restaurantId, 'B'),
			await makeIngredient(restaurantId, 'C')
		];
		let state = 20260928n;
		const next = () => {
			state = (state * 1664525n + 1013904223n) & 0xffffffffn;
			return state;
		};
		let made = 0;
		while (made < 200) {
			const batch: MovementRequest[] = [];
			const size = Number((next() >> 16n) % 8n) + 1;
			for (let i = 0; i < size && made < 200; i++, made++) {
				const ingredientId = ids[Number((next() >> 16n) % 3n)];
				const q: Qty = qty((next() % 5000000n) + 1n);
				const cost = minor(next() % 10000n);
				const k = Number((next() >> 16n) % 4n);
				batch.push(
					k === 0
						? { kind: 'inbound', type: 'purchase', ingredientId, qty: q, costMinor: cost }
						: k === 1
							? { kind: 'out', type: 'sale_consumption', ingredientId, qty: q }
							: k === 2
								? { kind: 'in', type: 'count_adjustment', ingredientId, qty: q }
								: {
										kind: 'reversal',
										type: 'purchase_reversal',
										ingredientId,
										qty: q,
										originalCostMinor: cost
									}
				);
			}
			await db.transaction(async (tx) => {
				await applyMovements(tx, ctx(restaurantId), batch);
			});
		}
		for (const id of ids) {
			const c = await cache(id);
			const l = await ledger(id);
			expect(c.qty).toBe(l.qty);
			expect(c.value.toString()).toBe(l.cost);
		}
	});

	it('CONCURRENCY: a sale locking [bun, meat] and a delivery [meat, bun] both commit, no 40P01', async () => {
		const bun = await makeIngredient(restaurantId, 'Bun');
		const meat = await makeIngredient(restaurantId, 'Meat');
		await db.transaction(async (tx) => {
			await applyMovements(tx, ctx(restaurantId), [
				inbound(bun, 100000n, 2500n),
				inbound(meat, 10000000n, 5500n)
			]);
		});

		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const sale = db.transaction(async (tx) => {
			// The sale shape, [bun, meat]: take BOTH locks in the one ordered
			// statement, hold them while "the sale" is built, then write. (Locking
			// one ingredient first and the other later is exactly the pattern the
			// one-lock rule forbids — it is what deadlocks against the delivery.)
			await lockIngredients(tx, restaurantId, [bun, meat]);
			await sleep(300);
			await applyMovements(tx, ctx(restaurantId, 'order'), [out(bun, 2000n), out(meat, 150000n)]);
		});
		await sleep(50);
		const deliveryStarted = Date.now();
		let deliveryWaited = 0;
		const delivery = db
			.transaction(async (tx) => {
				await applyMovements(tx, ctx(restaurantId), [
					inbound(meat, 5000000n, 3000n),
					inbound(bun, 50000n, 1250n)
				]);
			})
			.then(() => {
				deliveryWaited = Date.now() - deliveryStarted;
			});
		const results = await Promise.allSettled([sale, delivery]);
		for (const r of results) {
			expect(r.status, r.status === 'rejected' ? String(r.reason) : '').toBe('fulfilled');
		}
		// The delivery really contended: it blocked on the sale's locks until COMMIT.
		expect(deliveryWaited).toBeGreaterThanOrEqual(200);

		for (const id of [bun, meat]) {
			const c = await cache(id);
			const l = await ledger(id);
			expect(c.qty).toBe(l.qty);
			expect(c.value.toString()).toBe(l.cost);
		}
		// Both ingredients stayed positive, so each average is Σcost ÷ Σqty exactly.
		for (const id of [bun, meat]) {
			const c = await cache(id);
			const l = await ledger(id);
			const q = parseQty(l.qty);
			expect(c.avg).toBe(unitCostMicro(minor(BigInt(l.cost)), q, ROUNDING_RULE));
		}
	});

	it('LOCK ORDER: the writer locks every row in id order, in one statement, before it waits', async () => {
		// The race above proves no lost update, but not the ORDER of the locks: its
		// sale holds both rows before the delivery arrives. This probe does. C holds
		// the HIGHER id; the writer is handed [higher, lower] (request order is the
		// reverse of id order). Taken in one id-ordered statement, the writer locks
		// the LOWER row first and then blocks on the higher one — so D's NOWAIT on
		// the lower row must fail with 55P03. A writer that locked one row at a
		// time in request order would be blocked on `higher` holding nothing, and
		// D's NOWAIT would succeed.
		const a = await makeIngredient(restaurantId, 'First');
		const b = await makeIngredient(restaurantId, 'Second');
		const [lower, higher] = [a, b].sort();
		await db.transaction((tx) =>
			applyMovements(tx, ctx(restaurantId), [
				inbound(lower, 1000n, 10n),
				inbound(higher, 1000n, 10n)
			])
		);

		const holder = await pool.connect();
		const prober = await pool.connect();
		try {
			await holder.query('begin');
			await holder.query('select 1 from ingredients where id = $1 for update', [higher]);

			const writer = db.transaction((tx) =>
				applyMovements(tx, ctx(restaurantId, 'order'), [out(higher, 100n), out(lower, 100n)])
			);
			await new Promise((resolve) => setTimeout(resolve, 150));

			let probeCode: string | undefined;
			try {
				await prober.query('select 1 from ingredients where id = $1 for update nowait', [lower]);
			} catch (error) {
				probeCode = (error as { code?: string }).code;
			}
			expect(probeCode).toBe('55P03');

			await holder.query('commit');
			await writer;
		} finally {
			// Never leave the holder's transaction open on a failed assertion — the
			// writer would wait on it forever. A rollback after the commit is a no-op.
			await holder.query('rollback').catch(() => undefined);
			holder.release();
			prober.release();
		}
		expect((await cache(lower)).qty).toBe('0.900');
		expect((await cache(higher)).qty).toBe('0.900');
	});

	it("another restaurant's ingredient throws and writes nothing", async () => {
		const other = await makeRestaurant('Other Cafe');
		const foreign = await makeIngredient(other, 'Salt');
		const before = await movementCount();
		await expect(
			db.transaction(async (tx) => {
				await applyMovements(tx, ctx(restaurantId), [inbound(foreign, 1000n, 10n)]);
			})
		).rejects.toThrow(`ingredient not found: ${foreign}`);
		expect(await movementCount()).toBe(before);
		expect(await cache(foreign)).toEqual({ qty: '0.000', value: 0n, avg: 0n });
	});

	it('a zero quantity throws TypeError before any SQL: no lock is taken', async () => {
		const flour = await makeIngredient(restaurantId, 'Flour');
		await db.transaction(async (tx) => {
			await expect(applyMovements(tx, ctx(restaurantId), [out(flour, 0n)])).rejects.toBeInstanceOf(
				TypeError
			);
			// Still inside the transaction: if a FOR UPDATE had been taken, this
			// update from another connection would block past its lock timeout.
			const client = await pool.connect();
			try {
				await client.query(`set lock_timeout = '1s'`);
				const r = await client.query(`update ingredients set name = 'Flour 2' where id = $1`, [
					flour
				]);
				expect(r.rowCount).toBe(1);
			} finally {
				client.release();
			}
		});
	});

	it('an empty request list returns zero sums without touching the database', async () => {
		await db.transaction(async (tx) => {
			expect(await applyMovements(tx, ctx(restaurantId), [])).toEqual({
				movements: [],
				costMinor: 0n,
				revaluationMinor: 0n
			});
		});
	});
});

describe('todayInZone', () => {
	it("returns today's date in the restaurant's zone, computed in SQL", async () => {
		const tokyo = await makeRestaurant('Tokyo Cafe', 'Asia/Tokyo');
		const expected = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(
			new Date()
		);
		expect(await todayInZone(testDb(), tokyo)).toBe(expected);
	});
});
