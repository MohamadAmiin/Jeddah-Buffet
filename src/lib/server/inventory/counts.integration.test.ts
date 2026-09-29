import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { closeSessionAt, openSessionAt, seedSalesRestaurant } from '../db/test/sales';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { ingredients, stockCountLines, stockCounts, stockMovements } from '../db/schema/inventory';
import { journalEntries } from '../db/schema/accounting';
import { posSyncOps } from '../db/schema/pos-sync';
import { onRestaurantCreated } from '../restaurants';
import { entryLines } from '../accounting/journal';
import { minor } from '../../money';
import { qty } from '../../money/quantity';
import { applyMovements, type MovementRequest } from './movements';
import { addPurchaseUnit, createIngredient, type InventoryWriteContext } from './ingredients';
import { recordOpeningStock } from './opening';
import { countBlockers, postCount } from './counts';

// Stock counts (tasks/inventory-cogs T-25). MANDATORY (spec 29 — one
// posting-rule test per business event: count shortfall and count surplus).

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name: string): Promise<InventoryWriteContext> {
	const [r] = await testDb().insert(restaurants).values({ name }).returning({ id: restaurants.id });
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, r.id, { restaurantName: name, timeZone: 'Africa/Mogadishu' })
	);
	const [owner] = await testDb()
		.insert(users)
		.values({
			restaurantId: r.id,
			role: 'owner',
			displayName: 'Owner',
			email: `${randomUUID()}@example.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });
	return { restaurantId: r.id, actorUserId: owner.id, ip: null, userAgent: null };
}

async function ingredient(c: InventoryWriteContext, name: string): Promise<string> {
	const r = await db.transaction((tx) => createIngredient(tx, c, { name, baseUnit: 'g' }));
	if (!r.ok) throw new Error(r.reason);
	return r.id;
}

/** Opening stock of `kg` kilograms at `perKg` cents a kilogram. */
async function openWith(
	c: InventoryWriteContext,
	id: string,
	kg: bigint,
	perKg: bigint
): Promise<void> {
	await db.transaction(async (tx) => {
		const unit = await addPurchaseUnit(tx, c, id, { name: 'kg', baseQtyPerUnit: qty(1000000n) });
		if (!unit.ok) throw new Error(unit.reason);
		const r = await recordOpeningStock(tx, c, {
			ingredientId: id,
			purchaseUnitId: unit.id,
			unitQty: qty(kg * 1000n),
			unitCostMinor: minor(perKg),
			businessDate: '2026-09-01'
		});
		if (!r.ok) throw new Error(r.reason);
	});
}

async function move(c: InventoryWriteContext, requests: MovementRequest[]): Promise<void> {
	await db.transaction((tx) =>
		applyMovements(
			tx,
			{
				restaurantId: c.restaurantId,
				sourceType: 'order',
				sourceId: randomUUID(),
				businessDate: '2026-09-27',
				occurredAt: new Date(),
				recordedByUserId: null
			},
			requests
		)
	);
}

function count(c: InventoryWriteContext, lines: [string, bigint][]) {
	return db.transaction((tx) =>
		postCount(tx, c, {
			businessDate: '2026-09-28',
			lines: lines.map(([ingredientId, counted]) => ({ ingredientId, countedQty: qty(counted) }))
		})
	);
}

async function entriesOf(countId: string) {
	const rows = await testDb()
		.select({ id: journalEntries.id, event: journalEntries.event })
		.from(journalEntries)
		.where(eq(journalEntries.sourceId, countId))
		.orderBy(journalEntries.event);
	return Promise.all(
		rows.map(async (r) => [
			r.event,
			(await entryLines(testDb(), r.id)).map((l) => [l.code, l.debit, l.credit])
		])
	);
}

async function rowCount(
	c: InventoryWriteContext,
	table: typeof stockCounts | typeof stockCountLines | typeof stockMovements | typeof journalEntries
) {
	const [row] = await testDb()
		.select({ n: sql<number>`count(*)::int` })
		.from(table)
		.where(eq(table.restaurantId, c.restaurantId));
	return row.n;
}

let ctx: InventoryWriteContext;
beforeEach(async () => {
	ctx = await makeRestaurant('Count Cafe');
});

describe('postCount', () => {
	it('tomato 10,000 g counted 9,970 g: shortfall 9, Dr 5100 9 / Cr 1200 9, line −30.000', async () => {
		const tomato = await ingredient(ctx, 'Tomato');
		await openWith(ctx, tomato, 10n, 300n);
		const r = await count(ctx, [[tomato, 9970000n]]);
		if (!r.ok) throw new Error(r.reason);
		expect([r.shortfallMinor, r.surplusMinor]).toEqual([9n, 0n]);

		const [move] = await testDb()
			.select({
				type: stockMovements.movementType,
				qty: stockMovements.qty,
				cost: stockMovements.costMinor
			})
			.from(stockMovements)
			.where(eq(stockMovements.sourceId, r.countId));
		expect(move).toEqual({ type: 'count_adjustment', qty: '-30.000', cost: -9n });
		expect(await entriesOf(r.countId)).toEqual([
			[
				'stock_count_shortfall',
				[
					['5100', 9n, 0n],
					['1200', 0n, 9n]
				]
			]
		]);
		const [line] = await testDb()
			.select({
				system: stockCountLines.systemQty,
				counted: stockCountLines.countedQty,
				difference: stockCountLines.differenceQty,
				cost: stockCountLines.costMinor
			})
			.from(stockCountLines)
			.where(eq(stockCountLines.countId, r.countId));
		expect(line).toEqual({
			system: '10000.000',
			counted: '9970.000',
			difference: '-30.000',
			cost: -9n
		});
	});

	it('a surplus from negative stock (T-10(g)): +7500, Dr 1200 7500 / Cr 5100 7500', async () => {
		const meat = await ingredient(ctx, 'Meat');
		await move(ctx, [
			{
				kind: 'inbound',
				type: 'purchase',
				ingredientId: meat,
				qty: qty(10000000n),
				costMinor: minor(5000n)
			}
		]);
		await move(ctx, [
			{ kind: 'out', type: 'sale_consumption', ingredientId: meat, qty: qty(20000000n) }
		]);
		const [before] = await testDb()
			.select({
				qty: ingredients.onHandQty,
				value: ingredients.inventoryValueMinor,
				avg: ingredients.avgUnitCostMicro
			})
			.from(ingredients)
			.where(eq(ingredients.id, meat));
		expect(before).toEqual({ qty: '-10000.000', value: -5000n, avg: 500000n });

		const r = await count(ctx, [[meat, 5000000n]]);
		if (!r.ok) throw new Error(r.reason);
		expect([r.shortfallMinor, r.surplusMinor]).toEqual([0n, 7500n]);
		expect(await entriesOf(r.countId)).toEqual([
			[
				'stock_count_surplus',
				[
					['1200', 7500n, 0n],
					['5100', 0n, 7500n]
				]
			]
		]);
	});

	it('a shortfall on one ingredient and a surplus on another: two entries; an unchanged line: no movement', async () => {
		const tomato = await ingredient(ctx, 'Tomato');
		const onion = await ingredient(ctx, 'Onion');
		const salt = await ingredient(ctx, 'Salt');
		await openWith(ctx, tomato, 10n, 300n);
		await openWith(ctx, onion, 10n, 200n);
		await openWith(ctx, salt, 1n, 100n);

		const r = await count(ctx, [
			[tomato, 9970000n],
			[onion, 10500000n],
			[salt, 1000000n]
		]);
		if (!r.ok) throw new Error(r.reason);
		expect([r.shortfallMinor, r.surplusMinor]).toEqual([9n, 100n]);
		expect((await entriesOf(r.countId)).map(([event]) => event)).toEqual([
			'stock_count_shortfall',
			'stock_count_surplus'
		]);
		const moves = await testDb()
			.select({ ingredientId: stockMovements.ingredientId })
			.from(stockMovements)
			.where(eq(stockMovements.sourceId, r.countId));
		expect(moves.map((m) => m.ingredientId).sort()).toEqual([onion, tomato].sort());
		const [saltLine] = await testDb()
			.select({ difference: stockCountLines.differenceQty, cost: stockCountLines.costMinor })
			.from(stockCountLines)
			.where(and(eq(stockCountLines.countId, r.countId), eq(stockCountLines.ingredientId, salt)));
		expect(saltLine).toEqual({ difference: '0.000', cost: 0n });
	});

	it('a count equal to the system quantity: one line, no movement, no entry', async () => {
		const tomato = await ingredient(ctx, 'Tomato');
		await openWith(ctx, tomato, 10n, 300n);
		const r = await count(ctx, [[tomato, 10000000n]]);
		if (!r.ok) throw new Error(r.reason);
		expect(await rowCount(ctx, stockCountLines)).toBe(1);
		expect(
			await testDb()
				.select({ id: stockMovements.id })
				.from(stockMovements)
				.where(eq(stockMovements.sourceId, r.countId))
		).toEqual([]);
		expect(await entriesOf(r.countId)).toEqual([]);
	});

	it('a surplus on an ingredient never delivered or opened is no_inbound_history, naming it', async () => {
		const basil = await ingredient(ctx, 'Basil');
		const tomato = await ingredient(ctx, 'Tomato');
		await openWith(ctx, tomato, 10n, 300n);
		expect(
			await count(ctx, [
				[tomato, 9000000n],
				[basil, 500000n]
			])
		).toEqual({ ok: false, reason: 'no_inbound_history', ingredientIds: [basil] });
		expect(await rowCount(ctx, stockCounts)).toBe(0);
	});

	it('duplicate lines, no lines and a negative count are refused', async () => {
		const tomato = await ingredient(ctx, 'Tomato');
		expect(
			await count(ctx, [
				[tomato, 1000n],
				[tomato, 2000n]
			])
		).toEqual({ ok: false, reason: 'duplicate_ingredient' });
		expect(await count(ctx, [])).toEqual({ ok: false, reason: 'no_lines' });
		expect(await count(ctx, [[tomato, -1n]])).toEqual({ ok: false, reason: 'invalid_qty' });
	});
});

describe('countBlockers (CLAUDE.md "Inventory 4")', () => {
	it('blocks while a session is open, then while a sale op is unrecorded; nothing is written', async () => {
		const f = await seedSalesRestaurant(db);
		const c: InventoryWriteContext = {
			restaurantId: f.restaurantId,
			actorUserId: f.ownerId,
			ip: null,
			userAgent: null
		};
		const tomato = await ingredient(c, 'Tomato');
		await openWith(c, tomato, 10n, 300n);

		const session = await openSessionAt(db, f, {
			posSessionId: randomUUID(),
			openedAt: new Date('2026-09-28T05:00:00Z'),
			openingCashMinor: 10000n
		});
		expect(await count(c, [[tomato, 9000000n]])).toEqual({
			ok: false,
			reason: 'blocked',
			openSessions: 1,
			unresolvedSales: 0
		});

		await closeSessionAt(db, f, {
			posSessionId: session.posSessionId,
			closedAt: new Date('2026-09-28T11:00:00Z'),
			countedCashMinor: 10000n
		});
		await testDb()
			.insert(posSyncOps)
			.values({
				restaurantId: f.restaurantId,
				deviceId: f.deviceId,
				receivedViaDeviceId: f.deviceId,
				clientOpId: randomUUID(),
				kind: 'sale.complete',
				status: 'unrecorded',
				flag: 'database_error',
				occurredAt: new Date('2026-09-28T10:00:00Z'),
				payload: {}
			});
		expect(await countBlockers(testDb(), f.restaurantId)).toEqual({
			openSessions: 0,
			unresolvedSales: 1
		});
		expect(await count(c, [[tomato, 9000000n]])).toEqual({
			ok: false,
			reason: 'blocked',
			openSessions: 0,
			unresolvedSales: 1
		});
		expect(await rowCount(c, stockCounts)).toBe(0);
		expect(await rowCount(c, stockCountLines)).toBe(0);

		// Resolved (retried or dismissed) ops no longer block.
		await testDb()
			.update(posSyncOps)
			.set({ resolvedAt: new Date(), resolution: 'dismissed' })
			.where(eq(posSyncOps.restaurantId, f.restaurantId));
		expect((await count(c, [[tomato, 9000000n]])).ok).toBe(true);
	});
});
