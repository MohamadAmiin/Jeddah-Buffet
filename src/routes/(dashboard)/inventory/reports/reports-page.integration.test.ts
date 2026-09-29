import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	recordSaleAt,
	seedSalesRestaurant
} from '$lib/server/db/test/sales';
import type { Principal } from '$lib/server/auth/session';
import {
	addPurchaseUnit,
	createIngredient,
	recordOpeningStock,
	recordWaste,
	setRecipe,
	todayInZone,
	type InventoryWriteContext
} from '$lib/server/inventory';
import { minor } from '$lib/money';
import { qty } from '$lib/money/quantity';
import { load } from './+page.server';

// The /inventory/reports page (tasks/inventory-cogs T-33), in the idiom of
// inventory-page.integration.test.ts.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

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

function makeEvent(user: Principal, search = ''): RequestEvent {
	const url = new URL(`http://localhost/inventory/reports${search}`);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url),
		route: { id: '/(dashboard)/inventory/reports' },
		url
	} as unknown as RequestEvent;
}

type Thrown = { status?: number; body?: { message?: string } };
async function thrownBy(run: () => unknown): Promise<Thrown | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return thrown as Thrown;
	}
}

type ReportData = {
	from: string;
	to: string;
	consumption: { businessDate: string; name: string; qty: string; cost: string | null }[];
	waste: { businessDate: string; name: string; qty: string; reason: string; cost: string | null }[];
	cogs: {
		businessDate: string;
		sales: string | null;
		revaluation: string | null;
		total: string | null;
	}[];
	negative: { name: string; onHand: string }[];
	reconciliation: {
		stockValue: string | null;
		ledger1200: string | null;
		difference: string | null;
		differs: boolean;
	};
};

describe('the /inventory/reports page', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on the load', async () => {
		const f = await seedSalesRestaurant(db);
		const asStaff = principal(f.staffId, f.restaurantId, 'staff');
		expect((await thrownBy(() => load(makeEvent(asStaff) as never)))?.status).toBe(403);
	});

	it('a scripted day renders as formatted strings for the session business date', async () => {
		const f = await seedSalesRestaurant(db);
		const ctx: InventoryWriteContext = {
			restaurantId: f.restaurantId,
			actorUserId: f.ownerId,
			ip: null,
			userAgent: null
		};
		const meatId = await db.transaction(async (tx) => {
			const meat = await createIngredient(tx, ctx, { name: 'Meat', baseUnit: 'g' });
			const bun = await createIngredient(tx, ctx, { name: 'Bun', baseUnit: 'pcs' });
			if (!meat.ok || !bun.ok) throw new Error('ingredient');
			const kg = await addPurchaseUnit(tx, ctx, meat.id, {
				name: 'kg',
				baseQtyPerUnit: qty(1000000n)
			});
			if (!kg.ok) throw new Error('unit');
			const recipe = await setRecipe(tx, ctx, {
				owner: { kind: 'item', id: f.items.burger },
				lines: [
					{ ingredientId: meat.id, qty: qty(150000n) },
					{ ingredientId: bun.id, qty: qty(1000n) }
				]
			});
			if (!recipe.ok) throw new Error(recipe.reason);
			// 20 kg of meat at $1.00/kg; the bun is never bought.
			const opening = await recordOpeningStock(tx, ctx, {
				ingredientId: meat.id,
				purchaseUnitId: kg.id,
				unitQty: qty(20000n),
				unitCostMinor: minor(100n),
				businessDate: '2026-09-27'
			});
			if (!opening.ok) throw new Error(opening.reason);
			return meat.id;
		});

		const session = await openSessionAt(db, f, {
			posSessionId: randomUUID(),
			openedAt: new Date('2026-09-28T05:00:00Z'),
			openingCashMinor: 10000n
		});
		for (let i = 1; i <= 2; i++) {
			await recordSaleAt(db, f, {
				posSessionId: session.posSessionId,
				occurredAt: new Date(`2026-09-28T0${5 + i}:00:00Z`),
				invoiceSeq: i,
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
		await closeSessionAt(db, f, {
			posSessionId: session.posSessionId,
			closedAt: new Date('2026-09-28T11:00:00Z'),
			countedCashMinor: 10000n
		});
		const wasted = await db.transaction((tx) =>
			recordWaste(tx, ctx, {
				ingredientId: meatId,
				qty: qty(100000n),
				reason: 'spoilage',
				businessDate: session.businessDate
			})
		);
		if (!wasted.ok) throw new Error(wasted.reason);

		const asOwner = principal(f.ownerId, f.restaurantId, 'owner');
		const day = session.businessDate;
		const data = (await load(makeEvent(asOwner, `?from=${day}&to=${day}`) as never)) as ReportData;

		expect(data.from).toBe(day);
		expect(data.to).toBe(day);
		// Two burgers × 150 g at $1.00/kg = $0.30; two buns at no cost.
		expect(data.consumption).toEqual([
			expect.objectContaining({ businessDate: day, name: 'Bun', qty: '2.000 pcs', cost: '0.00' }),
			expect.objectContaining({ businessDate: day, name: 'Meat', qty: '300.000 g', cost: '0.30' })
		]);
		expect(data.waste).toEqual([
			expect.objectContaining({
				businessDate: day,
				name: 'Meat',
				qty: '100.000 g',
				reason: 'Spoilage',
				cost: '0.10'
			})
		]);
		expect(data.cogs).toEqual([
			expect.objectContaining({
				businessDate: day,
				sales: '0.30',
				revaluation: '0.00',
				total: '0.30'
			})
		]);
		expect(data.negative).toEqual([{ id: expect.any(String), name: 'Bun', onHand: '−2.000 pcs' }]);
		// $20.00 − $0.30 − $0.10 on the shelf, and 1200 agrees.
		expect(data.reconciliation).toMatchObject({
			stockValue: '19.60',
			ledger1200: '19.60',
			difference: '0.00',
			differs: false
		});
		expect(() => JSON.stringify(data)).not.toThrow();

		// A range that misses the day is empty, never an error.
		const before = (await load(
			makeEvent(asOwner, '?from=2026-09-01&to=2026-09-02') as never
		)) as ReportData;
		expect(before.consumption).toEqual([]);
		expect(before.cogs).toEqual([]);
	});

	it('defaults to the seven business days ending today, and refuses a bad range', async () => {
		const f = await seedSalesRestaurant(db);
		const asOwner = principal(f.ownerId, f.restaurantId, 'owner');
		const today = await todayInZone(db, f.restaurantId);

		const data = (await load(makeEvent(asOwner) as never)) as ReportData;
		expect(data.to).toBe(today);
		const [y, m, d] = today.split('-').map(Number);
		expect(data.from).toBe(new Date(Date.UTC(y, m - 1, d - 6)).toISOString().slice(0, 10));

		const message = 'Dates must be YYYY-MM-DD, from on or before to.';
		for (const search of ['?from=2026-9-1', '?to=2026-02-30', '?from=2026-09-10&to=2026-09-09']) {
			const thrown = await thrownBy(() => load(makeEvent(asOwner, search) as never));
			expect(thrown, search).toMatchObject({ status: 400, body: { message } });
		}
	});
});
