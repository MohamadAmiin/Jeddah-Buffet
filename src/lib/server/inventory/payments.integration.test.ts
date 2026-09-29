import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { journalEntries } from '../db/schema/accounting';
import { supplierPayments } from '../db/schema/purchases';
import { onRestaurantCreated } from '../restaurants';
import { entryLines } from '../accounting/journal';
import { minor } from '../../money';
import { qty } from '../../money/quantity';
import { addPurchaseUnit, createIngredient, type InventoryWriteContext } from './ingredients';
import {
	getPurchase,
	listPurchases,
	recordPurchase,
	reversePurchase,
	type PaidBy
} from './purchases';
import { outstandingMinor, paySupplier, reverseSupplierPayment } from './payments';
import { todayInZone } from './business-date';

// Supplier payments (tasks/inventory-cogs T-21). MANDATORY (spec 29 — one
// posting-rule test per business event: supplier paid, and its reversal).

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name: string): Promise<InventoryWriteContext> {
	const [r] = await testDb().insert(restaurants).values({ name }).returning({ id: restaurants.id });
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, r.id, { restaurantName: name, timeZone: 'Asia/Tokyo' })
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

async function delivery(c: InventoryWriteContext, paidBy: PaidBy, cost: bigint): Promise<string> {
	return db.transaction(async (tx) => {
		const i = await createIngredient(tx, c, {
			name: `Meat ${randomUUID().slice(0, 6)}`,
			baseUnit: 'g'
		});
		if (!i.ok) throw new Error(i.reason);
		const u = await addPurchaseUnit(tx, c, i.id, { name: 'kg', baseQtyPerUnit: qty(1000000n) });
		if (!u.ok) throw new Error(u.reason);
		const p = await recordPurchase(tx, c, {
			supplierName: 'Market',
			businessDate: '2026-09-28',
			paidBy,
			lines: [
				{
					ingredientId: i.id,
					purchaseUnitId: u.id,
					unitQty: qty(10000n),
					lineCostMinor: minor(cost)
				}
			]
		});
		if (!p.ok) throw new Error(p.reason);
		return p.purchaseId;
	});
}

function pay(
	c: InventoryWriteContext,
	purchaseId: string,
	amount: bigint,
	paidFrom: 'cash' | 'bank' = 'bank'
) {
	return db.transaction((tx) =>
		paySupplier(tx, c, {
			purchaseId,
			amountMinor: minor(amount),
			paidFrom,
			businessDate: '2026-09-29'
		})
	);
}

async function balance(restaurantId: string, code: string): Promise<bigint> {
	const result = await testDb().execute<{ b: string }>(sql`
		select coalesce(sum(l.debit_minor - l.credit_minor), 0)::text as b
		from journal_entry_lines l join accounts a on a.id = l.account_id
		where l.restaurant_id = ${restaurantId} and a.code = ${code}
	`);
	return BigInt(result.rows[0].b);
}

async function paymentEntry(paymentId: string) {
	const [row] = await testDb()
		.select({ entry: supplierPayments.journalEntryId, reversal: supplierPayments.reversalEntryId })
		.from(supplierPayments)
		.where(eq(supplierPayments.id, paymentId));
	return row;
}

async function linesOf(entryId: string) {
	return (await entryLines(testDb(), entryId)).map((l) => [
		l.code,
		l.debit > 0n ? 'Dr' : 'Cr',
		l.debit > 0n ? l.debit : l.credit
	]);
}

async function entryCount(restaurantId: string): Promise<number> {
	const [row] = await testDb()
		.select({ c: sql<number>`count(*)::int` })
		.from(journalEntries)
		.where(eq(journalEntries.restaurantId, restaurantId));
	return row.c;
}

let ctx: InventoryWriteContext;
beforeEach(async () => {
	ctx = await makeRestaurant('Payable Cafe');
});
afterEach(async () => {
	// 2000 Accounts Payable (a credit balance) never goes below zero, and it
	// equals what the restaurant still owes on its credit deliveries.
	const owed = -(await balance(ctx.restaurantId, '2000'));
	expect(owed >= 0n).toBe(true);
	const list = await listPurchases(testDb(), ctx.restaurantId, { limit: 100 });
	expect(owed).toBe(list.reduce((total, p) => total + p.outstandingMinor, 0n));
});

describe('paySupplier', () => {
	it('pays 5000 of an 11000 credit delivery: Dr 2000 / Cr 1010, supplier_paid, 6000 outstanding', async () => {
		const purchaseId = await delivery(ctx, 'credit', 11000n);
		const paid = await pay(ctx, purchaseId, 5000n);
		if (!paid.ok) throw new Error(paid.reason);
		const { entry } = await paymentEntry(paid.paymentId);
		const [header] = await testDb()
			.select({ event: journalEntries.event, sourceType: journalEntries.sourceType })
			.from(journalEntries)
			.where(eq(journalEntries.id, entry!));
		expect(header).toEqual({ event: 'supplier_paid', sourceType: 'supplier_payment' });
		expect(await linesOf(entry!)).toEqual([
			['2000', 'Dr', 5000n],
			['1010', 'Cr', 5000n]
		]);
		expect(await outstandingMinor(testDb(), ctx.restaurantId, purchaseId)).toBe(6000n);
		const detail = await getPurchase(testDb(), ctx.restaurantId, purchaseId);
		expect(detail?.outstandingMinor).toBe(6000n);
		expect(detail?.payments.map((p) => [p.amountMinor, p.paidFrom])).toEqual([[5000n, 'bank']]);
	});

	it('a payment larger than what is owed is refused and writes nothing', async () => {
		const purchaseId = await delivery(ctx, 'credit', 11000n);
		await pay(ctx, purchaseId, 5000n);
		const before = await entryCount(ctx.restaurantId);
		expect(await pay(ctx, purchaseId, 7000n)).toEqual({ ok: false, reason: 'exceeds_outstanding' });
		expect(await pay(ctx, purchaseId, 0n)).toEqual({ ok: false, reason: 'invalid_amount' });
		expect(await entryCount(ctx.restaurantId)).toBe(before);
		expect(await outstandingMinor(testDb(), ctx.restaurantId, purchaseId)).toBe(6000n);
	});

	it('two concurrent payments of 6000 on 11000 − 5000: exactly one succeeds', async () => {
		const purchaseId = await delivery(ctx, 'credit', 11000n);
		await pay(ctx, purchaseId, 5000n);
		const results = await Promise.all([pay(ctx, purchaseId, 6000n), pay(ctx, purchaseId, 6000n)]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'exceeds_outstanding' }]);
		expect(await outstandingMinor(testDb(), ctx.restaurantId, purchaseId)).toBe(0n);
	});

	it('refuses a delivery paid on the spot (not_credit) and a reversed one (reversed)', async () => {
		const cashDelivery = await delivery(ctx, 'cash', 3000n);
		expect(await pay(ctx, cashDelivery, 1000n)).toEqual({ ok: false, reason: 'not_credit' });
		const reversedDelivery = await delivery(ctx, 'credit', 3000n);
		// Reversed through the real path (T-22): its Cr 2000 is mirrored, so the
		// afterEach's 2000 = outstanding check holds with no hand repair.
		const reversal = await db.transaction((tx) =>
			reversePurchase(tx, ctx, { purchaseId: reversedDelivery, reason: 'Entered by mistake' })
		);
		expect(reversal.ok).toBe(true);
		expect(await pay(ctx, reversedDelivery, 1000n)).toEqual({ ok: false, reason: 'reversed' });
	});
});

describe('reverseSupplierPayment', () => {
	it('mirrors the payment on today in the restaurant zone; the balance is owed again', async () => {
		const purchaseId = await delivery(ctx, 'credit', 11000n);
		const paid = await pay(ctx, purchaseId, 5000n);
		if (!paid.ok) throw new Error(paid.reason);
		expect(
			await db.transaction((tx) =>
				reverseSupplierPayment(tx, ctx, { paymentId: paid.paymentId, reason: '  Paid twice  ' })
			)
		).toEqual({ ok: true });

		const { entry, reversal } = await paymentEntry(paid.paymentId);
		expect(reversal).not.toBeNull();
		const [mirror] = await testDb()
			.select({
				reverses: journalEntries.reversesEntryId,
				businessDate: journalEntries.businessDate,
				event: journalEntries.event
			})
			.from(journalEntries)
			.where(eq(journalEntries.id, reversal!));
		expect(mirror).toEqual({
			reverses: entry,
			businessDate: await todayInZone(testDb(), ctx.restaurantId),
			event: 'supplier_paid'
		});
		expect(await linesOf(reversal!)).toEqual([
			['2000', 'Cr', 5000n],
			['1010', 'Dr', 5000n]
		]);
		expect(await outstandingMinor(testDb(), ctx.restaurantId, purchaseId)).toBe(11000n);
		const audits = await testDb()
			.select({ details: auditLog.details })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.restaurantId, ctx.restaurantId),
					eq(auditLog.event, 'supplier.payment_reversed')
				)
			);
		expect(audits).toEqual([
			{
				details: {
					paymentId: paid.paymentId,
					purchaseId,
					amountMinor: '5000',
					reason: 'Paid twice'
				}
			}
		]);

		const before = await entryCount(ctx.restaurantId);
		expect(
			await db.transaction((tx) =>
				reverseSupplierPayment(tx, ctx, { paymentId: paid.paymentId, reason: 'again' })
			)
		).toEqual({ ok: false, reason: 'already_reversed' });
		expect(await entryCount(ctx.restaurantId)).toBe(before);
	});

	it('refuses a reason shorter than 3 characters', async () => {
		const purchaseId = await delivery(ctx, 'credit', 11000n);
		const paid = await pay(ctx, purchaseId, 5000n);
		if (!paid.ok) throw new Error(paid.reason);
		expect(
			await db.transaction((tx) =>
				reverseSupplierPayment(tx, ctx, { paymentId: paid.paymentId, reason: ' x ' })
			)
		).toEqual({ ok: false, reason: 'invalid_reason' });
	});
});

describe('tenant isolation', () => {
	it("another restaurant's delivery and payment are not_found, and nothing is written", async () => {
		const other = await makeRestaurant('Other Cafe');
		const foreignPurchase = await delivery(other, 'credit', 11000n);
		const foreignPaid = await pay(other, foreignPurchase, 1000n);
		if (!foreignPaid.ok) throw new Error(foreignPaid.reason);
		const before = await entryCount(other.restaurantId);

		expect(await pay(ctx, foreignPurchase, 1000n)).toEqual({ ok: false, reason: 'not_found' });
		expect(
			await db.transaction((tx) =>
				reverseSupplierPayment(tx, ctx, { paymentId: foreignPaid.paymentId, reason: 'mine now' })
			)
		).toEqual({ ok: false, reason: 'not_found' });
		expect(await outstandingMinor(testDb(), ctx.restaurantId, foreignPurchase)).toBe(0n);
		expect(await entryCount(other.restaurantId)).toBe(before);
		expect(await outstandingMinor(testDb(), other.restaurantId, foreignPurchase)).toBe(10000n);
	});
});
