import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedSalesRestaurant, type SalesFixture } from '$lib/server/db/test/sales';
import { auditLog } from '$lib/server/db/schema/audit';
import { journalEntries } from '$lib/server/db/schema/accounting';
import { stockMovements, wasteEntries } from '$lib/server/db/schema/inventory';
import type { Principal } from '$lib/server/auth/session';
import {
	addPurchaseUnit,
	createIngredient,
	recordOpeningStock,
	todayInZone,
	type InventoryWriteContext
} from '$lib/server/inventory';
import { minor } from '$lib/money';
import { qty } from '$lib/money/quantity';
import { load, actions } from './+page.server';

// The /inventory/waste page (tasks/inventory-cogs T-32), in the idiom of
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

function makeEvent(user: Principal, form?: Record<string, string>): RequestEvent {
	const url = new URL('http://localhost/inventory/waste');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/inventory/waste' },
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

/** A restaurant with Flour: 10 kg of opening stock at $2.00/kg. */
async function withFlour(): Promise<{ f: SalesFixture; flourId: string; today: string }> {
	const f = await seedSalesRestaurant(db);
	const ctx: InventoryWriteContext = {
		restaurantId: f.restaurantId,
		actorUserId: f.ownerId,
		ip: null,
		userAgent: null
	};
	const flourId = await db.transaction(async (tx) => {
		const flour = await createIngredient(tx, ctx, { name: 'Flour', baseUnit: 'g' });
		if (!flour.ok) throw new Error('ingredient');
		const kg = await addPurchaseUnit(tx, ctx, flour.id, {
			name: 'kg',
			baseQtyPerUnit: qty(1000000n)
		});
		if (!kg.ok) throw new Error('unit');
		const opening = await recordOpeningStock(tx, ctx, {
			ingredientId: flour.id,
			purchaseUnitId: kg.id,
			unitQty: qty(10000n),
			unitCostMinor: minor(200n),
			businessDate: '2026-09-27'
		});
		if (!opening.ok) throw new Error(opening.reason);
		return flour.id;
	});
	return { f, flourId, today: await todayInZone(db, f.restaurantId) };
}

describe('the /inventory/waste page', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on the load and on every action, writing nothing', async () => {
		const { f, flourId, today } = await withFlour();
		const asStaff = principal(f.staffId, f.restaurantId, 'staff');

		expect((await thrownBy(() => load(makeEvent(asStaff) as never)))?.status).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			const thrown = await thrownBy(() =>
				act(
					name,
					makeEvent(asStaff, {
						ingredientId: flourId,
						qty: '500',
						reason: 'spoilage',
						note: '',
						businessDate: today
					})
				)
			);
			expect(thrown?.status, name).toBe(403);
		}
		expect(await db.select().from(wasteEntries)).toHaveLength(0);
		expect(
			await db.select().from(stockMovements).where(eq(stockMovements.movementType, 'waste'))
		).toHaveLength(0);
	});

	it('record writes the waste, its movement and its entry, then redirects 303', async () => {
		const { f, flourId, today } = await withFlour();
		const asOwner = principal(f.ownerId, f.restaurantId, 'owner');

		const thrown = await thrownBy(() =>
			act(
				'record',
				makeEvent(asOwner, {
					ingredientId: flourId,
					qty: '500',
					reason: 'spoilage',
					note: '',
					businessDate: today
				})
			)
		);
		expect(thrown).toMatchObject({ status: 303, location: '/inventory/waste' });

		const [waste] = await db
			.select()
			.from(wasteEntries)
			.where(eq(wasteEntries.restaurantId, f.restaurantId));
		expect(waste).toMatchObject({ ingredientId: flourId, reason: 'spoilage', businessDate: today });
		const movements = await db
			.select()
			.from(stockMovements)
			.where(
				and(eq(stockMovements.sourceType, 'waste_entry'), eq(stockMovements.sourceId, waste.id))
			);
		expect(movements).toHaveLength(1);
		// 500 g at $2.00/kg is $1.00 out of stock.
		expect(movements[0].costMinor).toBe(-100n);
		const entries = await db
			.select()
			.from(journalEntries)
			.where(and(eq(journalEntries.event, 'waste'), eq(journalEntries.sourceId, waste.id)));
		expect(entries).toHaveLength(1);
		const audits = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.restaurantId, f.restaurantId), eq(auditLog.event, 'waste.recorded')));
		expect(audits).toHaveLength(1);

		const data = (await load(makeEvent(asOwner) as never)) as {
			today: string;
			entries: { name: string; qty: string; reason: string; cost: string | null }[];
		};
		expect(data.today).toBe(today);
		expect(data.entries).toEqual([
			expect.objectContaining({
				name: 'Flour',
				qty: '500.000 g',
				reason: 'Spoilage',
				cost: '1.00'
			})
		]);
		expect(() => JSON.stringify(data)).not.toThrow();
	});

	it('"Other" without a note answers its message and writes nothing', async () => {
		const { f, flourId, today } = await withFlour();
		const asOwner = principal(f.ownerId, f.restaurantId, 'owner');

		const result = await act(
			'record',
			makeEvent(asOwner, {
				ingredientId: flourId,
				qty: '500',
				reason: 'other',
				note: ' ',
				businessDate: today
			})
		);
		expect(result).toMatchObject({
			status: 400,
			data: {
				message: 'Say what happened in a note of 3 to 200 characters when the reason is Other.'
			}
		});
		const badDate = await act(
			'record',
			makeEvent(asOwner, {
				ingredientId: flourId,
				qty: '500',
				reason: 'spoilage',
				note: '',
				businessDate: '2026-9-1'
			})
		);
		expect(badDate).toMatchObject({ status: 400 });
		expect(await db.select().from(wasteEntries)).toHaveLength(0);
	});
});
