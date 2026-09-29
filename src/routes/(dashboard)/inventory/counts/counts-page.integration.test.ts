import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import {
	closeSessionAt,
	openSessionAt,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import { stockCountLines, stockCounts, stockMovements } from '$lib/server/db/schema/inventory';
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
import { load as loadCount } from './[id]/+page.server';

// The /inventory/counts and /inventory/counts/[id] pages (tasks/inventory-cogs
// T-32), in the idiom of inventory-page.integration.test.ts.

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

function makeEvent(
	user: Principal,
	form?: [string, string][],
	params: Record<string, string> = {}
): RequestEvent {
	const url = new URL('http://localhost/inventory/counts');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of form ?? []) body!.append(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params,
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/inventory/counts' },
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

function countForm(flourId: string, counted: string, today: string): [string, string][] {
	return [
		['ingredientId', flourId],
		['countedQty', counted],
		['note', ''],
		['businessDate', today]
	];
}

const BLOCKED = 'A shift is still open on the till. Close it before counting.';

describe('the /inventory/counts pages', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on both loads and on every action, writing nothing', async () => {
		const { f, flourId, today } = await withFlour();
		const asStaff = principal(f.staffId, f.restaurantId, 'staff');

		expect((await thrownBy(() => load(makeEvent(asStaff) as never)))?.status).toBe(403);
		expect(
			(
				await thrownBy(() =>
					loadCount(makeEvent(asStaff, undefined, { id: randomUUID() }) as never)
				)
			)?.status
		).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			const thrown = await thrownBy(() =>
				act(name, makeEvent(asStaff, countForm(flourId, '9500', today)))
			);
			expect(thrown?.status, name).toBe(403);
		}
		expect(await db.select().from(stockCounts)).toHaveLength(0);
		expect(
			await db
				.select()
				.from(stockMovements)
				.where(eq(stockMovements.movementType, 'count_adjustment'))
		).toHaveLength(0);
	});

	it('post waits for an open shift, then posts and shows its differences', async () => {
		const { f, flourId, today } = await withFlour();
		const asOwner = principal(f.ownerId, f.restaurantId, 'owner');

		const session = await openSessionAt(db, f, {
			posSessionId: randomUUID(),
			openedAt: new Date(),
			openingCashMinor: 10000n
		});

		const waiting = (await load(makeEvent(asOwner) as never)) as {
			blockers: string[];
			ingredients: { id: string; system: string }[];
		};
		expect(waiting.blockers).toEqual([BLOCKED]);
		expect(waiting.ingredients).toEqual([
			expect.objectContaining({ id: flourId, system: '10000.000 g' })
		]);

		const blocked = await act('post', makeEvent(asOwner, countForm(flourId, '9500', today)));
		expect(blocked).toMatchObject({ status: 409, data: { message: BLOCKED } });
		expect(await db.select().from(stockCounts)).toHaveLength(0);
		expect(await db.select().from(stockCountLines)).toHaveLength(0);

		await closeSessionAt(db, f, {
			posSessionId: session.posSessionId,
			closedAt: new Date(),
			countedCashMinor: 10000n
		});
		const open = (await load(makeEvent(asOwner) as never)) as { blockers: string[] };
		expect(open.blockers).toEqual([]);

		// Flour counted at 9.5 kg against 10 kg in the book: 500 g short, $1.00.
		const thrown = await thrownBy(() =>
			act('post', makeEvent(asOwner, countForm(flourId, '9500', today)))
		);
		const [count] = await db
			.select()
			.from(stockCounts)
			.where(eq(stockCounts.restaurantId, f.restaurantId));
		expect(thrown).toMatchObject({ status: 303, location: `/inventory/counts/${count.id}` });

		const detail = (await loadCount(makeEvent(asOwner, undefined, { id: count.id }) as never)) as {
			count: { businessDate: string; shortfall: string | null; surplus: string | null };
			lines: {
				name: string;
				system: string;
				counted: string;
				difference: string;
				differenceNegative: boolean;
				value: string | null;
				valueNegative: boolean;
			}[];
		};
		expect(detail.count).toMatchObject({ businessDate: today, shortfall: '1.00', surplus: '0.00' });
		expect(detail.lines).toEqual([
			expect.objectContaining({
				name: 'Flour',
				system: '10000.000 g',
				counted: '9500.000 g',
				difference: '−500.000 g',
				differenceNegative: true,
				value: '−1.00',
				valueNegative: true
			})
		]);
		expect(() => JSON.stringify(detail)).not.toThrow();

		// Another restaurant's count is not found; neither is a non-uuid id.
		const other = await withFlour();
		const asOtherOwner = principal(other.f.ownerId, other.f.restaurantId, 'owner');
		expect(
			(
				await thrownBy(() =>
					loadCount(makeEvent(asOtherOwner, undefined, { id: count.id }) as never)
				)
			)?.status
		).toBe(404);
		expect(
			(await thrownBy(() => loadCount(makeEvent(asOwner, undefined, { id: 'nope' }) as never)))
				?.status
		).toBe(404);
	});

	it('a surplus on an ingredient never stocked names it', async () => {
		const { f, today } = await withFlour();
		const asOwner = principal(f.ownerId, f.restaurantId, 'owner');
		const salt = await db.transaction((tx) =>
			createIngredient(
				tx,
				{ restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null },
				{ name: 'Salt', baseUnit: 'g' }
			)
		);
		if (!salt.ok) throw new Error('ingredient');
		const result = await act('post', makeEvent(asOwner, countForm(salt.id, '100', today)));
		expect(result).toMatchObject({
			status: 400,
			data: { message: 'Enter opening stock or a delivery first for: Salt.' }
		});
		const blank = await act('post', makeEvent(asOwner, countForm(salt.id, '', today)));
		expect(blank).toMatchObject({
			status: 400,
			data: { message: 'Enter a counted quantity for at least one ingredient.' }
		});
		expect(await db.select().from(stockCounts)).toHaveLength(0);
	});
});
