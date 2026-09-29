import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant,
	type SalesFixture
} from '../db/test/sales';
import { stockMovements } from '../db/schema/inventory';
import { journalEntries } from '../db/schema/accounting';
import { ROUNDING_RULE, minor } from '../../money';
import { qty } from '../../money/quantity';
import { valueAt } from '../../money/costing';
import { addPurchaseUnit, createIngredient, type InventoryWriteContext } from './ingredients';
import { setRecipe } from './recipes';
import { recordOpeningStock } from './opening';
import { recordPurchase, reversePurchase } from './purchases';
import { recordWaste } from './waste';
import { postCount } from './counts';
import {
	cogsByDate,
	consumptionByDate,
	countDifferences,
	currentStock,
	listCounts,
	movementLog,
	negativeStock,
	reconciliation,
	wasteByDate
} from './reports';

// The inventory reports and the cache-vs-ledger tripwire (tasks/inventory-cogs
// T-26), over a scripted day driven through the real write paths.

afterAll(async () => {
	await closeTestDb();
});

let f: SalesFixture;
let ctx: InventoryWriteContext;
let meat: { id: string; unitId: string };
let bun: string;

async function setUp(): Promise<void> {
	f = await seedSalesRestaurant(db);
	ctx = { restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null };
	await db.transaction(async (tx) => {
		const m = await createIngredient(tx, ctx, { name: 'Meat', baseUnit: 'g' });
		const b = await createIngredient(tx, ctx, { name: 'Bun', baseUnit: 'pcs' });
		if (!m.ok || !b.ok) throw new Error('ingredient');
		const kg = await addPurchaseUnit(tx, ctx, m.id, { name: 'kg', baseQtyPerUnit: qty(1000000n) });
		if (!kg.ok) throw new Error('unit');
		meat = { id: m.id, unitId: kg.id };
		bun = b.id;
		const r = await setRecipe(tx, ctx, {
			owner: { kind: 'item', id: f.items.burger },
			lines: [
				{ ingredientId: meat.id, qty: qty(150000n) },
				{ ingredientId: bun, qty: qty(1000n) }
			]
		});
		if (!r.ok) throw new Error(r.reason);
		// Opening stock: 20 kg of meat at $1.00/kg.
		const o = await recordOpeningStock(tx, ctx, {
			ingredientId: meat.id,
			purchaseUnitId: meat.unitId,
			unitQty: qty(20000n),
			unitCostMinor: minor(100n),
			businessDate: '2026-09-27'
		});
		if (!o.ok) throw new Error(o.reason);
	});
}

function sellBurger(posSessionId: string, invoiceSeq: number, occurredAt: Date) {
	return recordSaleAt(db, f, {
		posSessionId,
		occurredAt,
		invoiceSeq,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines: [
			{
				menuItemId: f.items.burger,
				itemName: 'Burger',
				quantity: 1,
				unitPriceMinor: 800n,
				taxRateBp: f.taxRateBp
			}
		]
	});
}

beforeEach(setUp);

describe('a scripted day', () => {
	it('every report agrees with the ledger, and 1200 equals the stock value', async () => {
		// A bank delivery of 5 kg of meat for $50.
		const delivery = await db.transaction((tx) =>
			recordPurchase(tx, ctx, {
				supplierName: 'Market',
				businessDate: '2026-09-28',
				paidBy: 'bank',
				lines: [
					{
						ingredientId: meat.id,
						purchaseUnitId: meat.unitId,
						unitQty: qty(5000n),
						lineCostMinor: minor(5000n)
					}
				]
			})
		);
		if (!delivery.ok) throw new Error('delivery');

		// Three burgers through the REAL payment transaction.
		const session = await openSessionAt(db, f, {
			posSessionId: randomUUID(),
			openedAt: new Date('2026-09-28T05:00:00Z'),
			openingCashMinor: 10000n
		});
		const orderIds: string[] = [];
		for (let i = 1; i <= 3; i++) {
			const sale = await sellBurger(
				session.posSessionId,
				i,
				new Date(`2026-09-28T0${5 + i}:00:00Z`)
			);
			orderIds.push(sale.orderId);
		}
		await closeSessionAt(db, f, {
			posSessionId: session.posSessionId,
			closedAt: new Date('2026-09-28T11:00:00Z'),
			countedCashMinor: 10000n
		});

		// Waste, a count, and the delivery reversed.
		const wasted = await db.transaction((tx) =>
			recordWaste(tx, ctx, {
				ingredientId: meat.id,
				qty: qty(500000n),
				reason: 'spoilage',
				businessDate: '2026-09-28'
			})
		);
		if (!wasted.ok) throw new Error(wasted.reason);
		const counted = await db.transaction((tx) =>
			postCount(tx, ctx, {
				businessDate: '2026-09-28',
				lines: [{ ingredientId: meat.id, countedQty: qty(24000000n) }]
			})
		);
		if (!counted.ok) throw new Error(counted.reason);
		const reversed = await db.transaction((tx) =>
			reversePurchase(tx, ctx, { purchaseId: delivery.purchaseId, reason: 'Wrong invoice' })
		);
		if (!reversed.ok) throw new Error(reversed.reason);

		// reconciliation: the tripwire is quiet.
		const rec = await reconciliation(testDb(), f.restaurantId);
		expect(rec.differenceMinor).toBe(0n);
		expect(rec.driftCount).toBe(0);
		expect(rec.stockValueMinor).toBe(rec.ledger1200Minor);

		// currentStock: each cache equals its ledger; meat per kg at the average.
		const stock = await currentStock(testDb(), f.restaurantId);
		for (const row of stock) {
			expect(row.drift).toBe(false);
			expect(row.onHandQty).toBe(row.ledgerQty);
			expect(row.valueMinor).toBe(row.ledgerValueMinor);
		}
		const meatRow = stock.find((r) => r.id === meat.id)!;
		expect(meatRow.perUnit).toEqual({
			unitName: 'kg',
			costMinor: valueAt(qty(1000000n), meatRow.avgMicro, ROUNDING_RULE)
		});
		// The bun was never bought: three sales took it negative, and it is flagged.
		expect(stock.find((r) => r.id === bun)!.negative).toBe(true);
		expect((await negativeStock(testDb(), f.restaurantId)).map((r) => r.id)).toEqual([bun]);

		// consumptionByDate for the session's business date = −Σ the sales' movements.
		const saleMoves = await testDb()
			.select({
				ingredientId: stockMovements.ingredientId,
				qty: sql<string>`sum(${stockMovements.qty})::text`,
				cost: sql<string>`sum(${stockMovements.costMinor})::text`
			})
			.from(stockMovements)
			.where(
				and(
					eq(stockMovements.restaurantId, f.restaurantId),
					eq(stockMovements.movementType, 'sale_consumption')
				)
			)
			.groupBy(stockMovements.ingredientId);
		const consumption = await consumptionByDate(
			testDb(),
			f.restaurantId,
			session.businessDate,
			session.businessDate
		);
		expect(consumption).toHaveLength(2);
		for (const row of consumption) {
			const m = saleMoves.find((s) => s.ingredientId === row.ingredientId)!;
			expect(-BigInt(m.cost)).toBe(row.costMinor);
		}
		expect(consumption.find((r) => r.ingredientId === meat.id)!.qty).toBe(450000n);

		// cogsByDate = Σ of the three COGS entries; the reversal's revaluation apart.
		const cogsEntries = await testDb().execute<{ total: string }>(sql`
			select coalesce(sum(l.debit_minor - l.credit_minor), 0)::text as total
			from journal_entries e join journal_entry_lines l on l.entry_id = e.id
			join accounts a on a.id = l.account_id
			where e.restaurant_id = ${f.restaurantId} and e.event = 'cost_of_goods_sold' and a.code = '5000'
		`);
		const cogs = await cogsByDate(testDb(), f.restaurantId, '2026-01-01', '2026-12-31');
		const totalCogs = cogs.reduce((t, r) => t + r.cogsMinor, 0n);
		const totalReval = cogs.reduce((t, r) => t + r.revaluationMinor, 0n);
		expect(totalCogs).toBe(BigInt(cogsEntries.rows[0].total));
		expect(totalCogs > 0n).toBe(true);
		// A positive revaluation (Dr 1200 / Cr 5000) lowers 5000's balance.
		expect(totalReval).toBe(-reversed.revaluationMinor);
		const [cogsCount] = await testDb()
			.select({ c: sql<number>`count(*)::int` })
			.from(journalEntries)
			.where(
				and(
					eq(journalEntries.restaurantId, f.restaurantId),
					eq(journalEntries.event, 'cost_of_goods_sold')
				)
			);
		expect(cogsCount.c).toBe(3);

		// wasteByDate and the count reports return what was entered.
		const wasteRows = await wasteByDate(testDb(), f.restaurantId, '2026-09-28', '2026-09-28');
		expect(wasteRows.map((w) => [w.wasteId, w.qty, w.reason, w.costMinor])).toEqual([
			[wasted.wasteId, 500000n, 'spoilage', wasted.costMinor]
		]);
		const lines = await countDifferences(testDb(), f.restaurantId, counted.countId);
		expect(lines).toHaveLength(1);
		expect(lines[0].countedQty).toBe(24000000n);
		expect(lines[0].differenceQty).toBe(lines[0].countedQty - lines[0].systemQty);
		const counts = await listCounts(testDb(), f.restaurantId);
		expect(counts.map((c) => [c.id, c.shortfallMinor, c.surplusMinor])).toEqual([
			[counted.countId, counted.shortfallMinor, counted.surplusMinor]
		]);

		// The movement log, newest first, holds every kind the day produced.
		const log = await movementLog(testDb(), f.restaurantId, meat.id);
		expect(new Set(log.map((m) => m.movementType))).toEqual(
			new Set(
				[
					'opening_stock',
					'purchase',
					'sale_consumption',
					'waste',
					'count_adjustment',
					'purchase_reversal'
				].concat(reversed.revaluationMinor !== 0n ? ['revaluation'] : [])
			)
		);
		for (let i = 1; i < log.length; i++) {
			expect(log[i - 1].occurredAt.getTime() >= log[i].occurredAt.getTime()).toBe(true);
		}
	});
});

describe('the tripwire', () => {
	it('a corrupted cache shows as drift on that ingredient, and in driftCount', async () => {
		// The owner connection bypasses the one writer on purpose, to prove the
		// report notices — nothing in the app can do this.
		await testDb().execute(sql`
			update ingredients set on_hand_qty = on_hand_qty + 1 where id = ${meat.id}
		`);
		const stock = await currentStock(testDb(), f.restaurantId);
		expect(stock.find((r) => r.id === meat.id)!.drift).toBe(true);
		expect(stock.find((r) => r.id === bun)!.drift).toBe(false);
		expect((await reconciliation(testDb(), f.restaurantId)).driftCount).toBe(1);
	});
});

describe('business date, not calendar date (invariant 11)', () => {
	it('a sale at 01:30 local in a session opened the evening before belongs to that evening', async () => {
		// Africa/Mogadishu is UTC+3: opened 28th 18:00 local, sold 29th 01:30 local.
		const session = await openSessionAt(db, f, {
			posSessionId: randomUUID(),
			openedAt: new Date('2026-09-28T15:00:00Z'),
			openingCashMinor: 10000n
		});
		expect(session.businessDate).toBe('2026-09-28');
		await sellBurger(session.posSessionId, 1, new Date('2026-09-28T22:30:00Z'));

		const evening = await consumptionByDate(testDb(), f.restaurantId, '2026-09-28', '2026-09-28');
		const nextDay = await consumptionByDate(testDb(), f.restaurantId, '2026-09-29', '2026-09-29');
		expect(evening.find((r) => r.ingredientId === meat.id)!.qty).toBe(150000n);
		expect(nextDay).toEqual([]);
		const cogs = await cogsByDate(testDb(), f.restaurantId, '2026-09-28', '2026-09-29');
		expect(cogs.map((r) => r.businessDate)).toEqual(['2026-09-28']);
	});
});
