import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { ingredients, openingStockEntries, stockMovements } from '../db/schema/inventory';
import { journalEntries } from '../db/schema/accounting';
import { onRestaurantCreated } from '../restaurants';
import { entryLines } from '../accounting/journal';
import { minor } from '../../money';
import { qty } from '../../money/quantity';
import { addPurchaseUnit, createIngredient, type InventoryWriteContext } from './ingredients';
import { recordPurchase } from './purchases';
import { recordOpeningStock } from './opening';

// Opening stock (tasks/inventory-cogs T-23). MANDATORY (spec 29 — one
// posting-rule test per business event: opening stock, Dr 1200 / Cr 3000).

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

async function ingredientWithUnit(c: InventoryWriteContext, name: string) {
	return db.transaction(async (tx) => {
		const i = await createIngredient(tx, c, { name, baseUnit: 'g' });
		if (!i.ok) throw new Error(i.reason);
		const u = await addPurchaseUnit(tx, c, i.id, { name: 'kg', baseQtyPerUnit: qty(1000000n) });
		if (!u.ok) throw new Error(u.reason);
		return { id: i.id, unitId: u.id };
	});
}

function opening(
	c: InventoryWriteContext,
	ingredientId: string,
	purchaseUnitId: string,
	unitQty: bigint,
	unitCost: bigint
) {
	return db.transaction((tx) =>
		recordOpeningStock(tx, c, {
			ingredientId,
			purchaseUnitId,
			unitQty: qty(unitQty),
			unitCostMinor: minor(unitCost),
			businessDate: '2026-09-01'
		})
	);
}

async function count(
	table: typeof stockMovements | typeof openingStockEntries | typeof journalEntries
) {
	const [row] = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(table)
		.where(eq(table.restaurantId, ctx.restaurantId));
	return row.c;
}

let ctx: InventoryWriteContext;
beforeEach(async () => {
	ctx = await makeRestaurant('Opening Cafe');
});

describe('recordOpeningStock', () => {
	it('50 kg of meat at $5.00/kg → 50,000 g, $250, 0.5¢/g; Dr 1200 25000 / Cr 3000 25000', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const r = await opening(ctx, meat.id, meat.unitId, 50000n, 500n);
		if (!r.ok) throw new Error(r.reason);

		const [cache] = await testDb()
			.select({
				qty: ingredients.onHandQty,
				value: ingredients.inventoryValueMinor,
				avg: ingredients.avgUnitCostMicro
			})
			.from(ingredients)
			.where(eq(ingredients.id, meat.id));
		expect(cache).toEqual({ qty: '50000.000', value: 25000n, avg: 500000n });

		const [entry] = await testDb()
			.select({
				id: journalEntries.id,
				event: journalEntries.event,
				source: journalEntries.sourceType
			})
			.from(journalEntries)
			.where(eq(journalEntries.sourceId, r.entryId));
		expect([entry.event, entry.source]).toEqual(['opening_stock', 'opening_stock']);
		expect((await entryLines(testDb(), entry.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
			['1200', 25000n, 0n],
			['3000', 0n, 25000n]
		]);

		const [row] = await testDb()
			.select()
			.from(openingStockEntries)
			.where(eq(openingStockEntries.id, r.entryId));
		expect(row).toMatchObject({
			purchaseUnitName: 'kg',
			unitQty: '50.000',
			baseQtyPerUnit: '1000.000',
			baseQty: '50000.000',
			unitCostMinor: 500n,
			valueMinor: 25000n,
			businessDate: '2026-09-01'
		});
	});

	it('a second opening entry for the same ingredient is has_movements (checked first)', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		await opening(ctx, meat.id, meat.unitId, 1000n, 500n);
		expect(await opening(ctx, meat.id, meat.unitId, 1000n, 500n)).toEqual({
			ok: false,
			reason: 'has_movements'
		});
	});

	it('opening stock after a delivery is has_movements', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		await db.transaction((tx) =>
			recordPurchase(tx, ctx, {
				supplierName: 'Market',
				businessDate: '2026-09-28',
				paidBy: 'cash',
				lines: [
					{
						ingredientId: meat.id,
						purchaseUnitId: meat.unitId,
						unitQty: qty(1000n),
						lineCostMinor: minor(500n)
					}
				]
			})
		);
		expect(await opening(ctx, meat.id, meat.unitId, 1000n, 500n)).toEqual({
			ok: false,
			reason: 'has_movements'
		});
	});

	it('a zero unit cost moves stock and posts no journal entry', async () => {
		const salt = await ingredientWithUnit(ctx, 'Salt');
		const r = await opening(ctx, salt.id, salt.unitId, 2000n, 0n);
		expect(r.ok).toBe(true);
		expect(await count(stockMovements)).toBe(1);
		expect(await count(journalEntries)).toBe(0);
		expect(await count(openingStockEntries)).toBe(1);
	});

	it('refusals write nothing: invalid_unit, not_found, invalid_amount', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const flour = await ingredientWithUnit(ctx, 'Flour');
		const other = await makeRestaurant('Other Cafe');
		const foreign = await ingredientWithUnit(other, 'Saffron');

		expect(await opening(ctx, meat.id, flour.unitId, 1000n, 500n)).toEqual({
			ok: false,
			reason: 'invalid_unit'
		});
		expect(await opening(ctx, foreign.id, foreign.unitId, 1000n, 500n)).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await opening(ctx, meat.id, meat.unitId, 0n, 500n)).toEqual({
			ok: false,
			reason: 'invalid_amount'
		});
		expect(await count(stockMovements)).toBe(0);
		expect(await count(openingStockEntries)).toBe(0);
		expect(await count(journalEntries)).toBe(0);
	});
});
