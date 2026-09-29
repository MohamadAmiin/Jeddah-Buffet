import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { stockMovements } from '$lib/server/db/schema/inventory';
import { purchases, supplierPayments } from '$lib/server/db/schema/purchases';
import { journalEntries } from '$lib/server/db/schema/accounting';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import {
	addPurchaseUnit,
	createIngredient,
	paySupplier,
	recordPurchase,
	type InventoryWriteContext,
	type PaidBy
} from '$lib/server/inventory';
import { minor } from '$lib/money';
import { qty } from '$lib/money/quantity';
import { load, actions } from './+page.server';

// The /purchases/[id] page (tasks/inventory-cogs T-31), in the idiom of
// inventory-page.integration.test.ts.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(email = 'owner@cafe.com') {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: 'Cafe One',
			timeZone: 'Africa/Mogadishu'
		})
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const ctx: InventoryWriteContext = {
		restaurantId: restaurant.id,
		actorUserId: owner.id,
		ip: null,
		userAgent: null
	};
	await db.transaction((tx) =>
		updateSettings(
			tx,
			restaurant.id,
			{ currencyCode: 'USD' },
			{ actorUserId: owner.id, ip: null, userAgent: null }
		)
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, ctx };
}

/** A delivery of 2 bags of flour for 30.00, recorded through the module. */
async function delivery(ctx: InventoryWriteContext, paidBy: PaidBy): Promise<string> {
	return db.transaction(async (tx) => {
		const i = await createIngredient(tx, ctx, { name: 'Flour', baseUnit: 'g' });
		if (!i.ok) throw new Error(i.reason);
		const u = await addPurchaseUnit(tx, ctx, i.id, { name: 'bag', baseQtyPerUnit: qty(25000000n) });
		if (!u.ok) throw new Error(u.reason);
		const p = await recordPurchase(tx, ctx, {
			supplierName: 'Market',
			businessDate: '2026-09-28',
			paidBy,
			lines: [
				{
					ingredientId: i.id,
					purchaseUnitId: u.id,
					unitQty: qty(2000n),
					lineCostMinor: minor(3000n)
				}
			]
		});
		if (!p.ok) throw new Error(p.reason);
		return p.purchaseId;
	});
}

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Staff',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function makeEvent(user: Principal, id: string, form?: Record<string, string>): RequestEvent {
	const url = new URL(`http://localhost/purchases/${id}`);
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: { id },
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/purchases/[id]' },
		url
	} as unknown as RequestEvent;
}

type Thrown = { status?: number; location?: string };
async function thrownBy(run: () => unknown): Promise<Thrown | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return thrown as Thrown;
	}
}

type ActionName = keyof typeof actions;
function act(name: ActionName, event: RequestEvent) {
	return actions[name]!(event as Parameters<NonNullable<(typeof actions)[ActionName]>>[0]);
}

type Loaded = {
	purchase: {
		outstanding: string | null;
		reversed: boolean;
		reversalReason: string | null;
		canPay: boolean;
		openPayments: boolean;
	};
	lines: { quantity: string; baseQuantity: string; total: string }[];
	payments: { id: string; amount: string; paidFrom: string; reversed: boolean }[];
};

describe('the /purchases/[id] page', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on the load and on every action, writing nothing', async () => {
		const r = await makeRestaurant();
		const purchaseId = await delivery(r.ctx, 'credit');
		const [payment] = await db.transaction(async (tx) => {
			const paid = await paySupplier(tx, r.ctx, {
				purchaseId,
				amountMinor: minor(1000n),
				paidFrom: 'bank',
				businessDate: '2026-09-28'
			});
			if (!paid.ok) throw new Error(paid.reason);
			return [paid.paymentId];
		});
		const staff = await seedStaff(db, r.restaurantId, { displayName: 'Staff' });
		const asStaff = principal(staff.id, r.restaurantId, 'staff');
		const movementsBefore = (await db.select().from(stockMovements)).length;
		const entriesBefore = (await db.select().from(journalEntries)).length;

		expect((await thrownBy(() => load(makeEvent(asStaff, purchaseId) as never)))?.status).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			const thrown = await thrownBy(() =>
				act(
					name,
					makeEvent(asStaff, purchaseId, {
						amount: '5.00',
						paidFrom: 'cash',
						businessDate: '2026-09-28',
						paymentId: payment,
						reason: 'wrong supplier'
					})
				)
			);
			expect(thrown?.status, name).toBe(403);
		}
		expect(await db.select().from(supplierPayments)).toHaveLength(1);
		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
		expect(row.reversedAt).toBeNull();
		const [pay] = await db.select().from(supplierPayments);
		expect(pay.reversedAt).toBeNull();
		expect(await db.select().from(stockMovements)).toHaveLength(movementsBefore);
		expect(await db.select().from(journalEntries)).toHaveLength(entriesBefore);
	});

	it('pays, refuses to reverse while a payment is open, reverses the payment, then the delivery', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const purchaseId = await delivery(r.ctx, 'credit');

		const before = (await load(makeEvent(asOwner, purchaseId) as never)) as Loaded;
		expect(before.purchase).toMatchObject({
			outstanding: '30.00',
			canPay: true,
			openPayments: false,
			reversed: false
		});
		expect(before.lines).toEqual([
			expect.objectContaining({ quantity: '2.000', baseQuantity: '50000.000 g', total: '30.00' })
		]);
		expect(() => JSON.stringify(before)).not.toThrow();

		// More than is owed is refused.
		const tooMuch = await act(
			'pay',
			makeEvent(asOwner, purchaseId, {
				amount: '30.01',
				paidFrom: 'bank',
				businessDate: '2026-09-29'
			})
		);
		expect(tooMuch).toMatchObject({
			status: 400,
			data: { message: 'That is more than is still owed on this delivery.' }
		});

		const paid = await thrownBy(() =>
			act(
				'pay',
				makeEvent(asOwner, purchaseId, {
					amount: '10.00',
					paidFrom: 'cash',
					businessDate: '2026-09-29'
				})
			)
		);
		expect(paid).toMatchObject({ status: 303, location: `/purchases/${purchaseId}` });
		const [payment] = await db.select().from(supplierPayments);
		expect(payment).toMatchObject({
			amountMinor: 1000n,
			paidFrom: 'cash',
			businessDate: '2026-09-29'
		});
		const afterPay = (await load(makeEvent(asOwner, purchaseId) as never)) as Loaded;
		expect(afterPay.purchase).toMatchObject({ outstanding: '20.00', openPayments: true });
		expect(afterPay.payments).toEqual([
			expect.objectContaining({
				id: payment.id,
				amount: '10.00',
				paidFrom: 'Cash',
				reversed: false
			})
		]);

		const blocked = await act(
			'reverse',
			makeEvent(asOwner, purchaseId, { reason: 'wrong supplier' })
		);
		expect(blocked).toMatchObject({
			status: 400,
			data: { message: 'Reverse the payments on this delivery first.' }
		});

		const shortReason = await act(
			'reversePayment',
			makeEvent(asOwner, purchaseId, { paymentId: payment.id, reason: 'x' })
		);
		expect(shortReason).toMatchObject({ status: 400 });

		const unpaid = await thrownBy(() =>
			act(
				'reversePayment',
				makeEvent(asOwner, purchaseId, { paymentId: payment.id, reason: 'paid twice' })
			)
		);
		expect(unpaid).toMatchObject({ status: 303, location: `/purchases/${purchaseId}` });
		const again = await act(
			'reversePayment',
			makeEvent(asOwner, purchaseId, { paymentId: payment.id, reason: 'paid twice' })
		);
		expect(again).toMatchObject({ status: 400, data: { message: 'This was already reversed.' } });

		const reversed = await thrownBy(() =>
			act('reverse', makeEvent(asOwner, purchaseId, { reason: 'wrong supplier' }))
		);
		expect(reversed).toMatchObject({ status: 303, location: `/purchases/${purchaseId}` });
		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
		expect(row.reversedAt).not.toBeNull();
		expect(row.reversalReason).toBe('wrong supplier');
		expect(row.reversalEntryId).not.toBeNull();

		const second = await act('reverse', makeEvent(asOwner, purchaseId, { reason: 'once more' }));
		expect(second).toMatchObject({
			status: 400,
			data: { message: 'This was already reversed.' }
		});

		const after = (await load(makeEvent(asOwner, purchaseId) as never)) as Loaded;
		expect(after.purchase).toMatchObject({
			reversed: true,
			reversalReason: 'wrong supplier',
			outstanding: null,
			canPay: false,
			openPayments: false
		});
		expect(after.payments[0]).toMatchObject({ reversed: true });
	});

	it('answers 404 for another restaurant’s delivery, and not_found in an action', async () => {
		const mine = await makeRestaurant();
		const theirs = await makeRestaurant('other@cafe.com');
		const theirPurchase = await delivery(theirs.ctx, 'credit');
		const asOwner = principal(mine.ownerId, mine.restaurantId, 'owner');

		expect((await thrownBy(() => load(makeEvent(asOwner, theirPurchase) as never)))?.status).toBe(
			404
		);
		expect((await thrownBy(() => load(makeEvent(asOwner, 'not-a-uuid') as never)))?.status).toBe(
			404
		);
		const reverse = await act('reverse', makeEvent(asOwner, theirPurchase, { reason: 'mine now' }));
		expect(reverse).toMatchObject({
			status: 404,
			data: { message: 'That delivery no longer exists. Reload the page.' }
		});
		const pay = await act(
			'pay',
			makeEvent(asOwner, theirPurchase, {
				amount: '1.00',
				paidFrom: 'bank',
				businessDate: '2026-09-29'
			})
		);
		expect(pay).toMatchObject({ status: 404 });
		const [row] = await db.select().from(purchases).where(eq(purchases.id, theirPurchase));
		expect(row.reversedAt).toBeNull();
		expect(await db.select().from(supplierPayments)).toHaveLength(0);
	});
});
