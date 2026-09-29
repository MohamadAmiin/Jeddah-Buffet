import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { stockMovements } from '$lib/server/db/schema/inventory';
import { purchases } from '$lib/server/db/schema/purchases';
import { journalEntries } from '$lib/server/db/schema/accounting';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { addPurchaseUnit, createIngredient } from '$lib/server/inventory';
import { qty } from '$lib/money/quantity';
import { load } from './+page.server';
import { load as newLoad, actions as newActions } from './new/+page.server';

// The /purchases and /purchases/new pages (tasks/inventory-cogs T-30), in the
// idiom of inventory-page.integration.test.ts.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant() {
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
			email: 'owner@cafe.com',
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const ctx = { restaurantId: restaurant.id, actorUserId: owner.id, ip: null, userAgent: null };
	await db.transaction((tx) =>
		updateSettings(
			tx,
			restaurant.id,
			{ currencyCode: 'USD' },
			{ actorUserId: owner.id, ip: null, userAgent: null }
		)
	);
	const { ingredientId, unitId } = await db.transaction(async (tx) => {
		const i = await createIngredient(tx, ctx, { name: 'Flour', baseUnit: 'g' });
		if (!i.ok) throw new Error(i.reason);
		const u = await addPurchaseUnit(tx, ctx, i.id, { name: 'bag', baseQtyPerUnit: qty(25000000n) });
		if (!u.ok) throw new Error(u.reason);
		return { ingredientId: i.id, unitId: u.id };
	});
	return { restaurantId: restaurant.id, ownerId: owner.id, ingredientId, unitId };
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

/** Repeated fields (the line rows) are passed as arrays and appended in order. */
function makeEvent(user: Principal, form?: Record<string, string | string[]>): RequestEvent {
	const url = new URL('http://localhost/purchases/new');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) {
		for (const one of Array.isArray(value) ? value : [value]) body!.append(key, one);
	}
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/purchases/new' },
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

type NewActionName = keyof typeof newActions;
function act(name: NewActionName, event: RequestEvent) {
	return newActions[name]!(event as Parameters<NonNullable<(typeof newActions)[NewActionName]>>[0]);
}

function deliveryForm(r: { ingredientId: string; unitId: string }, extra = {}) {
	return {
		supplierName: '  Market  ',
		businessDate: '2026-09-28',
		paidBy: 'bank',
		note: '',
		unit: [`${r.ingredientId}:${r.unitId}`, ''],
		quantity: ['2', ''],
		total: ['30.00', ''],
		...extra
	};
}

describe('the /purchases pages', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on both loads and on every action, writing nothing', async () => {
		const r = await makeRestaurant();
		const staff = await seedStaff(db, r.restaurantId, { displayName: 'Staff' });
		const asStaff = principal(staff.id, r.restaurantId, 'staff');

		expect((await thrownBy(() => load(makeEvent(asStaff) as never)))?.status).toBe(403);
		expect((await thrownBy(() => newLoad(makeEvent(asStaff) as never)))?.status).toBe(403);
		for (const name of Object.keys(newActions) as NewActionName[]) {
			const thrown = await thrownBy(() => act(name, makeEvent(asStaff, deliveryForm(r))));
			expect(thrown?.status, name).toBe(403);
		}
		expect(await db.select().from(purchases)).toHaveLength(0);
		expect(await db.select().from(stockMovements)).toHaveLength(0);
	});

	it('create records a bank delivery with its movements and entry, then redirects 303', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const thrown = await thrownBy(() => act('create', makeEvent(asOwner, deliveryForm(r))));
		const [row] = await db
			.select()
			.from(purchases)
			.where(eq(purchases.restaurantId, r.restaurantId));
		expect(row).toMatchObject({
			supplierName: 'Market',
			businessDate: '2026-09-28',
			paidBy: 'bank',
			totalMinor: 3000n,
			note: null
		});
		expect(thrown).toMatchObject({ status: 303, location: `/purchases/${row.id}` });

		const movements = await db
			.select()
			.from(stockMovements)
			.where(and(eq(stockMovements.sourceType, 'purchase'), eq(stockMovements.sourceId, row.id)));
		expect(movements).toHaveLength(1);
		expect(movements[0]).toMatchObject({
			ingredientId: r.ingredientId,
			movementType: 'purchase',
			qty: '50000.000',
			costMinor: 3000n
		});
		const entries = await db
			.select()
			.from(journalEntries)
			.where(and(eq(journalEntries.sourceType, 'purchase'), eq(journalEntries.sourceId, row.id)));
		expect(entries).toHaveLength(1);
		expect(row.journalEntryId).toBe(entries[0].id);

		// The list shows it, as strings only.
		const list = (await load(makeEvent(asOwner) as never)) as {
			purchases: { id: string; paidBy: string; total: string; status: string }[];
		};
		expect(list.purchases).toEqual([
			expect.objectContaining({
				id: row.id,
				paidBy: 'Paid now — bank',
				total: '30.00',
				outstanding: null,
				status: 'settled'
			})
		]);
		expect(() => JSON.stringify(list)).not.toThrow();

		const form = (await newLoad(makeEvent(asOwner) as never)) as {
			unitOptions: { value: string; label: string }[];
		};
		expect(form.unitOptions).toEqual([
			{ value: `${r.ingredientId}:${r.unitId}`, label: 'Flour — bag' }
		]);
	});

	it('an invalid line returns its message with the values kept, and writes nothing', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		// Row 2 is filled in but has no quantity; row 1 is blank and ignored.
		const result = await act(
			'create',
			makeEvent(
				asOwner,
				deliveryForm(r, {
					unit: ['', `${r.ingredientId}:${r.unitId}`],
					quantity: ['', ''],
					total: ['', '12.50']
				})
			)
		);
		expect(result).toMatchObject({
			status: 400,
			data: {
				message:
					'Line 2: choose an ingredient and one of its units, a quantity above zero and a total.',
				values: {
					supplierName: '  Market  ',
					lines: [
						{ unit: '', quantity: '', total: '' },
						{ unit: `${r.ingredientId}:${r.unitId}`, quantity: '', total: '12.50' }
					]
				}
			}
		});

		// A unit id that is not the ingredient's is refused by the module.
		const foreign = await act(
			'create',
			makeEvent(
				asOwner,
				deliveryForm(r, { unit: [`${r.unitId}:${r.unitId}`], quantity: ['1'], total: ['1'] })
			)
		);
		expect(foreign).toMatchObject({
			status: 400,
			data: {
				message:
					'Line 1: choose an ingredient and one of its units, a quantity above zero and a total.'
			}
		});
		expect(await db.select().from(purchases)).toHaveLength(0);
		expect(await db.select().from(stockMovements)).toHaveLength(0);
	});
});
