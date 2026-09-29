import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { ingredients, stockMovements, wasteEntries } from '../db/schema/inventory';
import { journalEntries } from '../db/schema/accounting';
import { onRestaurantCreated } from '../restaurants';
import { entryLines } from '../accounting/journal';
import { minor } from '../../money';
import { qty } from '../../money/quantity';
import {
	addPurchaseUnit,
	archiveIngredient,
	createIngredient,
	type InventoryWriteContext
} from './ingredients';
import { recordOpeningStock } from './opening';
import { recordWaste, type WasteInput } from './waste';

// Waste (tasks/inventory-cogs T-24). MANDATORY (spec 29 — one posting-rule test
// per business event: waste, Dr 5100 / Cr 1200).

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

function waste(c: InventoryWriteContext, input: Omit<WasteInput, 'businessDate'>) {
	return db.transaction((tx) => recordWaste(tx, c, { ...input, businessDate: '2026-09-28' }));
}

async function count(table: typeof stockMovements | typeof wasteEntries | typeof journalEntries) {
	const [row] = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(table)
		.where(eq(table.restaurantId, ctx.restaurantId));
	return row.c;
}

let ctx: InventoryWriteContext;
beforeEach(async () => {
	ctx = await makeRestaurant('Waste Cafe');
});

describe('recordWaste', () => {
	it('2 kg of tomato wasted from 10 kg at $3.00/kg: cost 600, Dr 5100 600 / Cr 1200 600', async () => {
		const tomato = await ingredient(ctx, 'Tomato');
		await db.transaction(async (tx) => {
			const unit = await addPurchaseUnit(tx, ctx, tomato, {
				name: 'kg',
				baseQtyPerUnit: qty(1000000n)
			});
			if (!unit.ok) throw new Error(unit.reason);
			const r = await recordOpeningStock(tx, ctx, {
				ingredientId: tomato,
				purchaseUnitId: unit.id,
				unitQty: qty(10000n),
				unitCostMinor: minor(300n),
				businessDate: '2026-09-01'
			});
			if (!r.ok) throw new Error(r.reason);
		});

		const r = await waste(ctx, { ingredientId: tomato, qty: qty(2000000n), reason: 'spoilage' });
		if (!r.ok) throw new Error(r.reason);
		expect(r.costMinor).toBe(600n);

		const [move] = await testDb()
			.select({
				type: stockMovements.movementType,
				qty: stockMovements.qty,
				cost: stockMovements.costMinor
			})
			.from(stockMovements)
			.where(eq(stockMovements.sourceId, r.wasteId));
		expect(move).toEqual({ type: 'waste', qty: '-2000.000', cost: -600n });

		const [entry] = await testDb()
			.select({ id: journalEntries.id, event: journalEntries.event })
			.from(journalEntries)
			.where(eq(journalEntries.sourceId, r.wasteId));
		expect(entry.event).toBe('waste');
		expect((await entryLines(testDb(), entry.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
			['5100', 600n, 0n],
			['1200', 0n, 600n]
		]);

		const [cache] = await testDb()
			.select({ qty: ingredients.onHandQty, value: ingredients.inventoryValueMinor })
			.from(ingredients)
			.where(eq(ingredients.id, tomato));
		expect(cache).toEqual({ qty: '8000.000', value: 2400n });

		const [row] = await testDb().select().from(wasteEntries).where(eq(wasteEntries.id, r.wasteId));
		expect(row).toMatchObject({ qty: '2000.000', reason: 'spoilage', note: null });
	});

	it('waste on an ingredient never bought: qty −1.000, cost 0, no journal entry', async () => {
		const basil = await ingredient(ctx, 'Basil');
		const r = await waste(ctx, { ingredientId: basil, qty: qty(1000n), reason: 'breakage' });
		if (!r.ok) throw new Error(r.reason);
		expect(r.costMinor).toBe(0n);
		const [move] = await testDb()
			.select({ qty: stockMovements.qty, cost: stockMovements.costMinor })
			.from(stockMovements)
			.where(eq(stockMovements.sourceId, r.wasteId));
		expect(move).toEqual({ qty: '-1.000', cost: 0n });
		expect(await count(journalEntries)).toBe(0);
	});

	it("'other' needs a 3–200 character note", async () => {
		const basil = await ingredient(ctx, 'Basil');
		const ok = await waste(ctx, {
			ingredientId: basil,
			qty: qty(1000n),
			reason: 'other',
			note: '  Dropped on the floor  '
		});
		expect(ok.ok).toBe(true);
		const [row] = await testDb().select({ note: wasteEntries.note }).from(wasteEntries);
		expect(row.note).toBe('Dropped on the floor');
	});

	it('refusals write nothing: note_required, ingredient_archived, not_found, invalid_qty', async () => {
		const basil = await ingredient(ctx, 'Basil');
		const old = await ingredient(ctx, 'Old herb');
		await db.transaction((tx) => archiveIngredient(tx, ctx, old));
		const other = await makeRestaurant('Other Cafe');
		const foreign = await ingredient(other, 'Saffron');

		expect(await waste(ctx, { ingredientId: basil, qty: qty(1000n), reason: 'other' })).toEqual({
			ok: false,
			reason: 'note_required'
		});
		expect(
			await waste(ctx, { ingredientId: basil, qty: qty(1000n), reason: 'other', note: 'no' })
		).toEqual({ ok: false, reason: 'note_required' });
		expect(await waste(ctx, { ingredientId: old, qty: qty(1000n), reason: 'spoilage' })).toEqual({
			ok: false,
			reason: 'ingredient_archived'
		});
		expect(
			await waste(ctx, { ingredientId: foreign, qty: qty(1000n), reason: 'spoilage' })
		).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await waste(ctx, { ingredientId: basil, qty: qty(0n), reason: 'spoilage' })).toEqual({
			ok: false,
			reason: 'invalid_qty'
		});
		expect(await count(stockMovements)).toBe(0);
		expect(await count(wasteEntries)).toBe(0);
		expect(await count(journalEntries)).toBe(0);
	});
});
