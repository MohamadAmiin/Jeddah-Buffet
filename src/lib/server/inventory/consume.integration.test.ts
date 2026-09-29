import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import {
	openSessionAt,
	pushOp,
	recordSaleAt,
	saleEnvelope,
	seedSalesRestaurant,
	type RecordSaleLine,
	type SalesFixture
} from '../db/test/sales';
import { ingredients, stockMovements } from '../db/schema/inventory';
import { journalEntries } from '../db/schema/accounting';
import { orders } from '../db/schema/orders';
import { modifiers } from '../db/schema/menu';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { entryLines } from '../accounting/journal';
import { createModifier } from '../menu';
import { minor } from '../../money';
import { qty } from '../../money/quantity';
import { applyMovements } from './movements';
import { createIngredient, type InventoryWriteContext } from './ingredients';
import { setRecipe } from './recipes';

// consumeForSale through the REAL payment transaction (tasks/inventory-cogs
// T-19): recordSale, and handleOp for the retry case.

afterAll(async () => {
	await closeTestDb();
});

let f: SalesFixture;
let ctx: InventoryWriteContext;
let session: { posSessionId: string; businessDate: string };
let seq = 0;

async function ingredient(name: string, baseUnit = 'g'): Promise<string> {
	const r = await db.transaction((tx) => createIngredient(tx, ctx, { name, baseUnit }));
	if (!r.ok) throw new Error(r.reason);
	return r.id;
}

async function buy(id: string, q: bigint, cost: bigint): Promise<void> {
	await db.transaction((tx) =>
		applyMovements(
			tx,
			{
				restaurantId: f.restaurantId,
				sourceType: 'purchase',
				sourceId: randomUUID(),
				businessDate: '2026-09-27',
				occurredAt: new Date('2026-09-27T09:00:00Z'),
				recordedByUserId: f.ownerId
			},
			[{ kind: 'inbound', type: 'purchase', ingredientId: id, qty: qty(q), costMinor: minor(cost) }]
		)
	);
}

async function recipe(
	owner: { kind: 'item' | 'modifier'; id: string },
	lines: [string, bigint][]
): Promise<void> {
	const r = await db.transaction((tx) =>
		setRecipe(tx, ctx, {
			owner,
			lines: lines.map(([ingredientId, q]) => ({ ingredientId, qty: qty(q) }))
		})
	);
	if (!r.ok) throw new Error(r.reason);
}

const burger = (quantity: number, mods: RecordSaleLine['modifiers'] = []): RecordSaleLine => ({
	menuItemId: f.items.burger,
	itemName: 'Burger',
	quantity,
	unitPriceMinor: 800n,
	taxRateBp: f.taxRateBp,
	modifiers: mods
});

function sell(lines: RecordSaleLine[]) {
	seq += 1;
	return recordSaleAt(db, f, {
		posSessionId: session.posSessionId,
		occurredAt: new Date('2026-09-28T06:00:00Z'),
		invoiceSeq: seq,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines
	});
}

async function movementsOf(orderId: string) {
	return testDb()
		.select({
			ingredientId: stockMovements.ingredientId,
			type: stockMovements.movementType,
			qty: stockMovements.qty,
			cost: stockMovements.costMinor,
			businessDate: stockMovements.businessDate,
			occurredAt: stockMovements.occurredAt
		})
		.from(stockMovements)
		.where(and(eq(stockMovements.sourceType, 'order'), eq(stockMovements.sourceId, orderId)));
}

async function cogsEntries(orderId: string) {
	return testDb()
		.select({ id: journalEntries.id })
		.from(journalEntries)
		.where(
			and(eq(journalEntries.sourceId, orderId), eq(journalEntries.event, 'cost_of_goods_sold'))
		);
}

async function cache(id: string) {
	const [row] = await testDb()
		.select({ qty: ingredients.onHandQty, value: ingredients.inventoryValueMinor })
		.from(ingredients)
		.where(eq(ingredients.id, id));
	return row;
}

beforeEach(async () => {
	f = await seedSalesRestaurant(db);
	ctx = { restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null };
	seq = 0;
	session = await openSessionAt(db, f, {
		posSessionId: randomUUID(),
		openedAt: new Date('2026-09-28T05:00:00Z'),
		openingCashMinor: 10000n
	});
});

describe('consumeForSale inside recordSale', () => {
	it('two burgers: two sale_consumption movements, the caches and Dr 5000 265 / Cr 1200 265', async () => {
		const meat = await ingredient('Meat');
		const bun = await ingredient('Bun', 'pcs');
		await buy(meat, 2000000n, 1100n); // 2 kg for $11.00 → 0.55¢/g
		await buy(bun, 12000n, 600n); // 12 buns for $6.00 → 50¢ each
		await recipe({ kind: 'item', id: f.items.burger }, [
			[bun, 1000n],
			[meat, 150000n]
		]);

		const { orderId } = await sell([burger(2)]);

		const [order] = await testDb()
			.select({ paidAt: orders.paidAt })
			.from(orders)
			.where(eq(orders.id, orderId));
		const moves = await movementsOf(orderId);
		expect(moves).toHaveLength(2);
		expect(moves).toContainEqual({
			ingredientId: meat,
			type: 'sale_consumption',
			qty: '-300.000',
			cost: -165n,
			businessDate: session.businessDate,
			occurredAt: order.paidAt
		});
		expect(moves).toContainEqual({
			ingredientId: bun,
			type: 'sale_consumption',
			qty: '-2.000',
			cost: -100n,
			businessDate: session.businessDate,
			occurredAt: order.paidAt
		});
		expect(await cache(meat)).toEqual({ qty: '1700.000', value: 935n });
		expect(await cache(bun)).toEqual({ qty: '10.000', value: 500n });

		const entries = await cogsEntries(orderId);
		expect(entries).toHaveLength(1);
		expect(await entryLines(testDb(), entries[0].id)).toEqual([
			{ lineNo: 1, code: '5000', name: 'Cost of Goods Sold', debit: 265n, credit: 0n },
			{ lineNo: 2, code: '1200', name: 'Inventory', debit: 0n, credit: 265n }
		]);
	});

	it('a dish with no recipe: no movement, no COGS entry, the sale accepted', async () => {
		const { orderId } = await sell([
			{
				menuItemId: f.items.tea,
				itemName: 'Tea',
				quantity: 3,
				unitPriceMinor: 200n,
				taxRateBp: f.taxRateBp
			}
		]);
		expect(await movementsOf(orderId)).toEqual([]);
		expect(await cogsEntries(orderId)).toEqual([]);
	});

	it('into never-bought stock: cost 0, stock −300.000, the sale accepted, no COGS entry', async () => {
		const lettuce = await ingredient('Lettuce');
		await recipe({ kind: 'item', id: f.items.special }, [[lettuce, 300000n]]);
		const { orderId } = await sell([
			{
				menuItemId: f.items.special,
				itemName: 'Special',
				quantity: 1,
				unitPriceMinor: 999n,
				taxRateBp: f.taxRateBp
			}
		]);
		const moves = await movementsOf(orderId);
		expect(moves.map((m) => [m.qty, m.cost])).toEqual([['-300.000', 0n]]);
		expect(await cache(lettuce)).toEqual({ qty: '-300.000', value: 0n });
		expect(await cogsEntries(orderId)).toEqual([]);
	});

	it('an archived ingredient in the recipe is still consumed', async () => {
		const meat = await ingredient('Meat');
		await buy(meat, 1000000n, 550n);
		await recipe({ kind: 'item', id: f.items.burger }, [[meat, 150000n]]);
		// archiveIngredient refuses while a live recipe uses it; a concurrent
		// archive is the only way this state arises, so set it directly.
		await testDb()
			.update(ingredients)
			.set({ archivedAt: new Date() })
			.where(eq(ingredients.id, meat));
		const { orderId } = await sell([burger(1)]);
		expect((await movementsOf(orderId)).map((m) => m.qty)).toEqual(['-150.000']);
	});

	it('"No tomato" on the line: no tomato movement', async () => {
		const meat = await ingredient('Meat');
		const tomato = await ingredient('Tomato');
		await buy(meat, 1000000n, 550n);
		await buy(tomato, 1000000n, 300n);
		const [extra] = await testDb()
			.select({ groupId: modifiers.groupId })
			.from(modifiers)
			.where(eq(modifiers.id, f.modifiers.extraCheese));
		const noTomato = await db.transaction((tx) =>
			createModifier(tx, f.restaurantId, {
				groupId: extra.groupId,
				name: 'No tomato',
				priceDeltaMinor: 0n
			})
		);
		if (!noTomato.ok) throw new Error('modifier');
		const [settings] = await testDb()
			.select({ v: restaurantSettings.menuVersion })
			.from(restaurantSettings)
			.where(eq(restaurantSettings.restaurantId, f.restaurantId));
		f = { ...f, menuVersion: settings.v };
		await recipe({ kind: 'item', id: f.items.burger }, [
			[meat, 150000n],
			[tomato, 30000n]
		]);
		await recipe({ kind: 'modifier', id: noTomato.id }, [[tomato, -30000n]]);

		const { orderId } = await sell([
			burger(1, [{ modifierId: noTomato.id, modifierName: 'No tomato', priceDeltaMinor: 0n }])
		]);
		const moves = await movementsOf(orderId);
		expect(moves.map((m) => m.ingredientId)).toEqual([meat]);
		expect(await cache(tomato)).toEqual({ qty: '1000.000', value: 300n });
	});
});

describe('MANDATORY (spec 29) — offline sync: retries never create duplicates', () => {
	it('the same sale.complete twice through handleOp: one order, one set of movements, one COGS entry', async () => {
		const meat = await ingredient('Meat');
		await buy(meat, 2000000n, 1100n);
		await recipe({ kind: 'item', id: f.items.burger }, [[meat, 150000n]]);

		const envelope = saleEnvelope(f, {
			posSessionId: session.posSessionId,
			occurredAt: new Date('2026-09-28T06:00:00Z'),
			invoiceSeq: 1,
			method: 'cash',
			orderType: 'takeaway',
			tableLabel: null,
			lines: [burger(2)]
		});
		const orderId = (envelope.payload as { orderId: string }).orderId;

		const first = await pushOp(db, f, envelope);
		expect(first.http).toBe(200);
		if (first.http === 200) expect(first.body.status).toBe('accepted');
		const second = await pushOp(db, f, envelope);
		expect(second.http).toBe(200);
		if (second.http === 200) expect(second.body.status).toBe('replayed');

		const [orderCount] = await testDb()
			.select({ c: sql<number>`count(*)::int` })
			.from(orders)
			.where(eq(orders.id, orderId));
		expect(orderCount.c).toBe(1);
		expect(await movementsOf(orderId)).toHaveLength(1);
		expect(await cogsEntries(orderId)).toHaveLength(1);
		expect(await cache(meat)).toEqual({ qty: '1700.000', value: 935n });
	});
});
