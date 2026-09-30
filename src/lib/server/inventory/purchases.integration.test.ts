import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { ingredients, stockMovements } from '../db/schema/inventory';
import { purchases, purchaseLines } from '../db/schema/purchases';
import { journalEntries } from '../db/schema/accounting';
import { onRestaurantCreated } from '../restaurants';
import { entryLines, postEntry } from '../accounting/journal';
import { cogsLines } from '../accounting/posting-rules';
import { minor } from '../../money';
import { qty } from '../../money/quantity';
import { applyMovements } from './movements';
import {
	addPurchaseUnit,
	archivePurchaseUnit,
	createIngredient,
	type InventoryWriteContext
} from './ingredients';
import { listPurchases, recordPurchase, reversePurchase, type PaidBy } from './purchases';
import { paySupplier, reverseSupplierPayment } from './payments';
import { todayInZone } from './business-date';

// Deliveries (tasks/inventory-cogs T-20): the real path, from purchase units to
// movements to journal entries. MANDATORY (spec 29 — one posting-rule test per
// business event, through the real path).

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

async function ingredientWithUnit(
	c: InventoryWriteContext,
	name: string,
	unit = 'kg',
	factor = 1000000n
): Promise<{ id: string; unitId: string }> {
	return db.transaction(async (tx) => {
		const i = await createIngredient(tx, c, { name, baseUnit: 'g' });
		if (!i.ok) throw new Error(i.reason);
		const u = await addPurchaseUnit(tx, c, i.id, { name: unit, baseQtyPerUnit: qty(factor) });
		if (!u.ok) throw new Error(u.reason);
		return { id: i.id, unitId: u.id };
	});
}

function deliver(
	c: InventoryWriteContext,
	paidBy: PaidBy,
	lines: { ingredientId: string; purchaseUnitId: string; unitQty: bigint; cost: bigint }[]
) {
	return db.transaction((tx) =>
		recordPurchase(tx, c, {
			supplierName: '  Market  ',
			businessDate: '2026-09-28',
			paidBy,
			lines: lines.map((l) => ({
				ingredientId: l.ingredientId,
				purchaseUnitId: l.purchaseUnitId,
				unitQty: qty(l.unitQty),
				lineCostMinor: minor(l.cost)
			}))
		})
	);
}

/** Σ debit − Σ credit on one account of the restaurant. */
async function balance(restaurantId: string, code: string): Promise<bigint> {
	const result = await testDb().execute<{ b: string }>(sql`
		select coalesce(sum(l.debit_minor - l.credit_minor), 0)::text as b
		from journal_entry_lines l join accounts a on a.id = l.account_id
		where l.restaurant_id = ${restaurantId} and a.code = ${code}
	`);
	return BigInt(result.rows[0].b);
}

async function stockValue(restaurantId: string): Promise<bigint> {
	const result = await testDb().execute<{ v: string }>(sql`
		select coalesce(sum(inventory_value_minor), 0)::text as v
		from ingredients where restaurant_id = ${restaurantId}
	`);
	return BigInt(result.rows[0].v);
}

async function entriesFor(purchaseId: string) {
	const rows = await testDb()
		.select({ id: journalEntries.id, event: journalEntries.event })
		.from(journalEntries)
		.where(eq(journalEntries.sourceId, purchaseId))
		.orderBy(journalEntries.event, sql`${journalEntries.reversesEntryId} is not null`);
	return Promise.all(
		rows.map(async (r) => ({
			event: r.event,
			lines: (await entryLines(testDb(), r.id)).map((l) => [
				l.code,
				l.debit > 0n ? 'Dr' : 'Cr',
				l.debit > 0n ? l.debit : l.credit
			])
		}))
	);
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

let ctx: InventoryWriteContext;
beforeEach(async () => {
	ctx = await makeRestaurant('Delivery Cafe');
});
afterEach(async () => {
	// After every case: 1200 Inventory equals the value the ledger holds, and
	// 2000 Accounts Payable equals what is still owed on credit deliveries.
	expect(await balance(ctx.restaurantId, '1200')).toBe(await stockValue(ctx.restaurantId));
	const owed = (await listPurchases(testDb(), ctx.restaurantId, { limit: 1000 })).reduce(
		(total, p) => total + p.outstandingMinor,
		0n
	);
	expect(-(await balance(ctx.restaurantId, '2000'))).toBe(owed);
});

describe('recordPurchase', () => {
	it('spec 16: 10 kg at $50 then 10 kg at $60, by bank → 20,000 g, $110, 0.55¢/g', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const first = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 10000n, cost: 5000n }
		]);
		const second = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 10000n, cost: 6000n }
		]);
		if (!first.ok || !second.ok) throw new Error('refused');
		expect(await cache(meat.id)).toEqual({ qty: '20000.000', value: 11000n, avg: 550000n });
		expect(await entriesFor(first.purchaseId)).toEqual([
			{
				event: 'purchase_paid',
				lines: [
					['1200', 'Dr', 5000n],
					['1010', 'Cr', 5000n]
				]
			}
		]);
		expect(await entriesFor(second.purchaseId)).toEqual([
			{
				event: 'purchase_paid',
				lines: [
					['1200', 'Dr', 6000n],
					['1010', 'Cr', 6000n]
				]
			}
		]);
		const [header] = await testDb()
			.select({ supplier: purchases.supplierName, entry: purchases.journalEntryId })
			.from(purchases)
			.where(eq(purchases.id, first.purchaseId));
		expect(header.supplier).toBe('Market');
		expect(header.entry).not.toBeNull();
	});

	it('on credit → Dr 1200 / Cr 2000 purchase_on_credit; by cash → Cr 1000 purchase_paid', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const line = {
			ingredientId: meat.id,
			purchaseUnitId: meat.unitId,
			unitQty: 10000n,
			cost: 5000n
		};
		const credit = await deliver(ctx, 'credit', [line]);
		const cash = await deliver(ctx, 'cash', [line]);
		if (!credit.ok || !cash.ok) throw new Error('refused');
		expect(await entriesFor(credit.purchaseId)).toEqual([
			{
				event: 'purchase_on_credit',
				lines: [
					['1200', 'Dr', 5000n],
					['2000', 'Cr', 5000n]
				]
			}
		]);
		expect(await entriesFor(cash.purchaseId)).toEqual([
			{
				event: 'purchase_paid',
				lines: [
					['1200', 'Dr', 5000n],
					['1000', 'Cr', 5000n]
				]
			}
		]);
	});

	it('into negative stock: purchase + revaluation movements, and inventory_revaluation Dr 5000 15000', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		await db.transaction((tx) =>
			applyMovements(
				tx,
				{
					restaurantId: ctx.restaurantId,
					sourceType: 'order',
					sourceId: randomUUID(),
					businessDate: '2026-09-27',
					occurredAt: new Date(),
					recordedByUserId: null
				},
				[{ kind: 'out', type: 'sale_consumption', ingredientId: meat.id, qty: qty(30000000n) }]
			)
		);
		const delivery = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 50000n, cost: 25000n }
		]);
		if (!delivery.ok) throw new Error('refused');
		expect(delivery.revaluationMinor).toBe(-15000n);
		const moves = await testDb()
			.select({
				type: stockMovements.movementType,
				qty: stockMovements.qty,
				cost: stockMovements.costMinor
			})
			.from(stockMovements)
			.where(eq(stockMovements.sourceId, delivery.purchaseId))
			.orderBy(stockMovements.id);
		expect(moves).toEqual([
			{ type: 'purchase', qty: '50000.000', cost: 25000n },
			{ type: 'revaluation', qty: '0.000', cost: -15000n }
		]);
		expect(await entriesFor(delivery.purchaseId)).toEqual([
			{
				event: 'inventory_revaluation',
				lines: [
					['5000', 'Dr', 15000n],
					['1200', 'Cr', 15000n]
				]
			},
			{
				event: 'purchase_paid',
				lines: [
					['1200', 'Dr', 25000n],
					['1010', 'Cr', 25000n]
				]
			}
		]);
		// Before the delivery the sale posted no COGS (cost 0), so here 1200 holds
		// 25000 − 15000 = 10000, which is the stock's value.
		expect(await cache(meat.id)).toEqual({ qty: '20000.000', value: 10000n, avg: 500000n });
	});

	it('two lines of one ingredient: two purchase movements, one entry for the total', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const d = await deliver(ctx, 'credit', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 10000n, cost: 5000n },
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 10000n, cost: 6000n }
		]);
		if (!d.ok) throw new Error('refused');
		const moves = await testDb()
			.select({ type: stockMovements.movementType, cost: stockMovements.costMinor })
			.from(stockMovements)
			.where(eq(stockMovements.sourceId, d.purchaseId))
			.orderBy(stockMovements.id);
		expect(moves).toEqual([
			{ type: 'purchase', cost: 5000n },
			{ type: 'purchase', cost: 6000n }
		]);
		expect(await entriesFor(d.purchaseId)).toEqual([
			{
				event: 'purchase_on_credit',
				lines: [
					['1200', 'Dr', 11000n],
					['2000', 'Cr', 11000n]
				]
			}
		]);
		const lineRows = await testDb()
			.select({ lineNo: purchaseLines.lineNo, baseQty: purchaseLines.baseQty })
			.from(purchaseLines)
			.where(eq(purchaseLines.purchaseId, d.purchaseId))
			.orderBy(purchaseLines.lineNo);
		expect(lineRows).toEqual([
			{ lineNo: 1, baseQty: '10000.000' },
			{ lineNo: 2, baseQty: '10000.000' }
		]);
	});

	it('a zero-cost delivery moves stock and posts nothing; journal_entry_id stays null', async () => {
		const salt = await ingredientWithUnit(ctx, 'Salt');
		const d = await deliver(ctx, 'cash', [
			{ ingredientId: salt.id, purchaseUnitId: salt.unitId, unitQty: 1000n, cost: 0n }
		]);
		if (!d.ok) throw new Error('refused');
		expect(await cache(salt.id)).toEqual({ qty: '1000.000', value: 0n, avg: 0n });
		expect(await entriesFor(d.purchaseId)).toEqual([]);
		const [header] = await testDb()
			.select({ entry: purchases.journalEntryId })
			.from(purchases)
			.where(eq(purchases.id, d.purchaseId));
		expect(header.entry).toBeNull();
	});

	it('refuses a foreign, archived or mismatched unit with its line number, writing nothing', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const flour = await ingredientWithUnit(ctx, 'Flour', 'bag', 25000000n);
		const archived = await ingredientWithUnit(ctx, 'Rice', 'sack');
		await db.transaction((tx) => archivePurchaseUnit(tx, ctx, archived.unitId));
		const other = await makeRestaurant('Other Cafe');
		const foreign = await ingredientWithUnit(other, 'Saffron');
		const good = { ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 1000n, cost: 100n };

		expect(
			await deliver(ctx, 'cash', [
				good,
				{ ingredientId: foreign.id, purchaseUnitId: foreign.unitId, unitQty: 1000n, cost: 1n }
			])
		).toEqual({ ok: false, reason: 'invalid_line', lineNo: 2 });
		expect(
			await deliver(ctx, 'cash', [
				{ ingredientId: archived.id, purchaseUnitId: archived.unitId, unitQty: 1000n, cost: 1n }
			])
		).toEqual({ ok: false, reason: 'invalid_line', lineNo: 1 });
		expect(
			await deliver(ctx, 'cash', [
				good,
				good,
				{ ingredientId: meat.id, purchaseUnitId: flour.unitId, unitQty: 1000n, cost: 1n }
			])
		).toEqual({ ok: false, reason: 'invalid_line', lineNo: 3 });
		expect(await deliver(ctx, 'cash', [])).toEqual({ ok: false, reason: 'no_lines' });
		// 0.001 of a unit whose factor rounds it to nothing.
		const pinch = await ingredientWithUnit(ctx, 'Pepper', 'pinch', 1n);
		expect(
			await deliver(ctx, 'cash', [
				{ ingredientId: pinch.id, purchaseUnitId: pinch.unitId, unitQty: 1n, cost: 1n }
			])
		).toEqual({ ok: false, reason: 'invalid_line', lineNo: 1 });

		for (const table of [purchases, purchaseLines, stockMovements, journalEntries]) {
			const [row] = await testDb()
				.select({ c: sql<number>`count(*)::int` })
				.from(table)
				.where(and(eq(table.restaurantId, ctx.restaurantId)));
			expect(row.c).toBe(0);
		}
	});
});

describe('reversePurchase', () => {
	const reverse = (purchaseId: string, reason = 'Entered by mistake') =>
		db.transaction((tx) => reversePurchase(tx, ctx, { purchaseId, reason }));

	async function mirrorOf(purchaseId: string) {
		const [header] = await testDb()
			.select({ entry: purchases.journalEntryId, reversal: purchases.reversalEntryId })
			.from(purchases)
			.where(eq(purchases.id, purchaseId));
		const [mirror] = await testDb()
			.select({
				reverses: journalEntries.reversesEntryId,
				businessDate: journalEntries.businessDate
			})
			.from(journalEntries)
			.where(eq(journalEntries.id, header.reversal!));
		return { header, mirror };
	}

	it('an unconsumed delivery into empty stock: back to zero, mirror Dr 1010 / Cr 1200', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const d = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 10000n, cost: 6000n }
		]);
		if (!d.ok) throw new Error('refused');
		expect(await reverse(d.purchaseId)).toEqual({ ok: true, revaluationMinor: 0n });

		const moves = await testDb()
			.select({
				type: stockMovements.movementType,
				qty: stockMovements.qty,
				cost: stockMovements.costMinor
			})
			.from(stockMovements)
			.where(
				and(
					eq(stockMovements.sourceId, d.purchaseId),
					eq(stockMovements.movementType, 'purchase_reversal')
				)
			);
		expect(moves).toEqual([{ type: 'purchase_reversal', qty: '-10000.000', cost: -6000n }]);
		expect(await cache(meat.id)).toMatchObject({ qty: '0.000', value: 0n });

		const { header, mirror } = await mirrorOf(d.purchaseId);
		expect(mirror).toEqual({
			reverses: header.entry,
			businessDate: await todayInZone(testDb(), ctx.restaurantId)
		});
		expect(
			(await entryLines(testDb(), header.reversal!)).map((l) => [
				l.code,
				l.debit > 0n ? 'Dr' : 'Cr',
				l.debit > 0n ? l.debit : l.credit
			])
		).toEqual([
			['1200', 'Cr', 6000n],
			['1010', 'Dr', 6000n]
		]);
	});

	it('after consumption (T-10(e)): cost −5000 at the original price, revaluation +3600', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const first = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 20000n, cost: 2000n }
		]);
		const second = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 5000n, cost: 5000n }
		]);
		if (!first.ok || !second.ok) throw new Error('refused');
		expect(await cache(meat.id)).toEqual({ qty: '25000.000', value: 7000n, avg: 280000n });

		// 15,000 g sold, with the COGS entry recordSale would post for it.
		await db.transaction(async (tx) => {
			const orderId = randomUUID();
			const sale = await applyMovements(
				tx,
				{
					restaurantId: ctx.restaurantId,
					sourceType: 'order',
					sourceId: orderId,
					businessDate: '2026-09-28',
					occurredAt: new Date(),
					recordedByUserId: null
				},
				[{ kind: 'out', type: 'sale_consumption', ingredientId: meat.id, qty: qty(15000000n) }]
			);
			expect(sale.costMinor).toBe(-4200n);
			await postEntry(tx, {
				restaurantId: ctx.restaurantId,
				businessDate: '2026-09-28',
				event: 'cost_of_goods_sold',
				sourceType: 'order',
				sourceId: orderId,
				memo: 'COGS',
				lines: cogsLines(minor(4200n))
			});
		});

		expect(await reverse(second.purchaseId)).toEqual({ ok: true, revaluationMinor: 3600n });
		const moves = await testDb()
			.select({
				type: stockMovements.movementType,
				qty: stockMovements.qty,
				cost: stockMovements.costMinor
			})
			.from(stockMovements)
			.where(eq(stockMovements.sourceId, second.purchaseId))
			.orderBy(stockMovements.id);
		expect(moves).toEqual([
			{ type: 'purchase', qty: '5000.000', cost: 5000n },
			{ type: 'purchase_reversal', qty: '-5000.000', cost: -5000n },
			{ type: 'revaluation', qty: '0.000', cost: 3600n }
		]);
		expect(await cache(meat.id)).toEqual({ qty: '5000.000', value: 1400n, avg: 280000n });
		const events = (await entriesFor(second.purchaseId)).map((e) => [e.event, e.lines]);
		expect(events).toEqual([
			[
				'inventory_revaluation',
				[
					['1200', 'Dr', 3600n],
					['5000', 'Cr', 3600n]
				]
			],
			[
				'purchase_paid',
				[
					['1200', 'Dr', 5000n],
					['1010', 'Cr', 5000n]
				]
			],
			[
				'purchase_paid',
				[
					['1200', 'Cr', 5000n],
					['1010', 'Dr', 5000n]
				]
			]
		]);
	});

	it('a credit delivery with an open payment: has_payments until the payment is reversed', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const d = await deliver(ctx, 'credit', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 10000n, cost: 11000n }
		]);
		if (!d.ok) throw new Error('refused');
		const paid = await db.transaction((tx) =>
			paySupplier(tx, ctx, {
				purchaseId: d.purchaseId,
				amountMinor: minor(5000n),
				paidFrom: 'bank',
				businessDate: '2026-09-28'
			})
		);
		if (!paid.ok) throw new Error(paid.reason);
		const [before] = await testDb()
			.select({ c: sql<number>`count(*)::int` })
			.from(stockMovements)
			.where(eq(stockMovements.restaurantId, ctx.restaurantId));

		expect(await reverse(d.purchaseId)).toEqual({ ok: false, reason: 'has_payments' });
		const [after] = await testDb()
			.select({ c: sql<number>`count(*)::int` })
			.from(stockMovements)
			.where(eq(stockMovements.restaurantId, ctx.restaurantId));
		expect(after.c).toBe(before.c);

		await db.transaction((tx) =>
			reverseSupplierPayment(tx, ctx, { paymentId: paid.paymentId, reason: 'Paid in error' })
		);
		expect(await reverse(d.purchaseId)).toEqual({ ok: true, revaluationMinor: 0n });
	});

	it('two concurrent reversals: one ok, the other already_reversed; one mirror, one set of movements', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const d = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 10000n, cost: 6000n }
		]);
		if (!d.ok) throw new Error('refused');
		const results = await Promise.all([reverse(d.purchaseId), reverse(d.purchaseId)]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'already_reversed' }]);

		const [mirrors] = await testDb()
			.select({ c: sql<number>`count(*)::int` })
			.from(journalEntries)
			.where(
				and(
					eq(journalEntries.sourceId, d.purchaseId),
					sql`${journalEntries.reversesEntryId} is not null`
				)
			);
		expect(mirrors.c).toBe(1);
		const [reversals] = await testDb()
			.select({ c: sql<number>`count(*)::int` })
			.from(stockMovements)
			.where(
				and(
					eq(stockMovements.sourceId, d.purchaseId),
					eq(stockMovements.movementType, 'purchase_reversal')
				)
			);
		expect(reversals.c).toBe(1);
	});

	it('refuses a short reason, an unknown delivery, and a second reversal', async () => {
		const meat = await ingredientWithUnit(ctx, 'Meat');
		const d = await deliver(ctx, 'bank', [
			{ ingredientId: meat.id, purchaseUnitId: meat.unitId, unitQty: 1000n, cost: 600n }
		]);
		if (!d.ok) throw new Error('refused');
		expect(await reverse(d.purchaseId, 'no')).toEqual({ ok: false, reason: 'invalid_reason' });
		expect(await reverse(randomUUID())).toEqual({ ok: false, reason: 'not_found' });
		const other = await makeRestaurant('Other Cafe');
		expect(
			await db.transaction((tx) =>
				reversePurchase(tx, other, { purchaseId: d.purchaseId, reason: 'not mine' })
			)
		).toEqual({ ok: false, reason: 'not_found' });
		expect((await reverse(d.purchaseId)).ok).toBe(true);
		expect(await reverse(d.purchaseId)).toEqual({ ok: false, reason: 'already_reversed' });
	});
});
