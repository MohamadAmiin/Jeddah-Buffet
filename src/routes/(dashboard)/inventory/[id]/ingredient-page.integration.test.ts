import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import {
	ingredientPurchaseUnits,
	ingredients,
	openingStockEntries,
	recipeLines,
	stockMovements
} from '$lib/server/db/schema/inventory';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { archiveItem, createCategory, createItem } from '$lib/server/menu';
import {
	addPurchaseUnit,
	createIngredient,
	recordPurchase,
	type InventoryWriteContext
} from '$lib/server/inventory';
import { minor } from '$lib/money';
import { qty } from '$lib/money/quantity';
import { load, actions } from './+page.server';

// The /inventory/[id] page (tasks/inventory-cogs T-28), in the idiom of
// inventory-page.integration.test.ts.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

let seq = 0;
async function makeRestaurant(options: { currency?: boolean } = {}) {
	seq += 1;
	const name = `Cafe ${seq}`;
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, { restaurantName: name, timeZone: 'Africa/Mogadishu' })
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email: `owner${seq}@cafe.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	if (options.currency !== false) {
		await db.transaction((tx) =>
			updateSettings(
				tx,
				restaurant.id,
				{ currencyCode: 'USD' },
				{ actorUserId: owner.id, ip: null, userAgent: null }
			)
		);
	}
	const ctx: InventoryWriteContext = {
		restaurantId: restaurant.id,
		actorUserId: owner.id,
		ip: null,
		userAgent: null
	};
	return { restaurantId: restaurant.id, ownerId: owner.id, ctx };
}

/** An ingredient in grams with one purchase unit, a 1000 g bag. */
async function makeFlour(ctx: InventoryWriteContext) {
	return db.transaction(async (tx) => {
		const created = await createIngredient(tx, ctx, { name: 'Flour', baseUnit: 'g' });
		if (!created.ok) throw new Error('ingredient');
		const unit = await addPurchaseUnit(tx, ctx, created.id, {
			name: 'bag',
			baseQtyPerUnit: qty(1_000_000n)
		});
		if (!unit.ok) throw new Error('unit');
		return { ingredientId: created.id, unitId: unit.id };
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
	const url = new URL(`http://localhost/inventory/${id}`);
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: { id },
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/inventory/[id]' },
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

type PageData = {
	openingAllowed: boolean;
	hasMovements: boolean;
	today: string;
	units: { id: string; name: string; holds: string }[];
	movements: { type: string; glyph: string; qty: string; cost: string | null }[];
};
async function loadAs(user: Principal, id: string): Promise<PageData> {
	return (await load(makeEvent(user, id) as never)) as PageData;
}

async function auditCount(restaurantId: string, event: string): Promise<number> {
	const rows = await db
		.select({ id: auditLog.id })
		.from(auditLog)
		.where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.event, event)));
	return rows.length;
}

async function deliver(ctx: InventoryWriteContext, ingredientId: string, unitId: string) {
	const result = await db.transaction((tx) =>
		recordPurchase(tx, ctx, {
			supplierName: 'Market',
			businessDate: '2026-09-28',
			paidBy: 'cash',
			lines: [
				{ ingredientId, purchaseUnitId: unitId, unitQty: qty(2000n), lineCostMinor: minor(3000n) }
			]
		})
	);
	if (!result.ok) throw new Error('delivery');
}

const OPENING_FORM = { qty: '2', cost: '12.50', businessDate: '2026-09-01' };

describe('the /inventory/[id] page', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on the load and on every action, writing nothing', async () => {
		const r = await makeRestaurant();
		const flour = await makeFlour(r.ctx);
		const staff = await seedStaff(db, r.restaurantId, { displayName: 'Staff' });
		const asStaff = principal(staff.id, r.restaurantId, 'staff');
		const auditsBefore = await db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(eq(auditLog.restaurantId, r.restaurantId));

		expect(
			(await thrownBy(() => load(makeEvent(asStaff, flour.ingredientId) as never)))?.status
		).toBe(403);
		const form = {
			name: 'Rye',
			baseUnit: 'kg',
			baseQtyPerUnit: '5',
			unitId: flour.unitId,
			purchaseUnitId: flour.unitId,
			...OPENING_FORM
		};
		for (const name of Object.keys(actions) as ActionName[]) {
			const thrown = await thrownBy(() => act(name, makeEvent(asStaff, flour.ingredientId, form)));
			expect(thrown?.status, name).toBe(403);
		}

		const [row] = await db.select().from(ingredients).where(eq(ingredients.id, flour.ingredientId));
		expect(row).toMatchObject({ name: 'Flour', baseUnit: 'g', archivedAt: null });
		const units = await db
			.select()
			.from(ingredientPurchaseUnits)
			.where(eq(ingredientPurchaseUnits.ingredientId, flour.ingredientId));
		expect(units).toHaveLength(1);
		expect(units[0].archivedAt).toBeNull();
		expect(await db.select().from(stockMovements)).toHaveLength(0);
		expect(await db.select().from(openingStockEntries)).toHaveLength(0);
		const auditsAfter = await db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(eq(auditLog.restaurantId, r.restaurantId));
		expect(auditsAfter).toHaveLength(auditsBefore.length);
	});

	it("answers 404 for another restaurant's ingredient, and not_found in an action", async () => {
		const a = await makeRestaurant();
		const b = await makeRestaurant();
		const flour = await makeFlour(a.ctx);
		const asB = principal(b.ownerId, b.restaurantId, 'owner');

		expect((await thrownBy(() => load(makeEvent(asB, flour.ingredientId) as never)))?.status).toBe(
			404
		);
		expect((await thrownBy(() => load(makeEvent(asB, 'not-a-uuid') as never)))?.status).toBe(404);
		expect(
			await act('update', makeEvent(asB, flour.ingredientId, { name: 'Stolen' }))
		).toMatchObject({
			status: 400,
			data: { message: 'That ingredient no longer exists. Reload the page.' }
		});
		expect(await act('archive', makeEvent(asB, flour.ingredientId, {}))).toMatchObject({
			status: 400,
			data: { message: 'That ingredient no longer exists. Reload the page.' }
		});
		const [row] = await db.select().from(ingredients).where(eq(ingredients.id, flour.ingredientId));
		expect(row).toMatchObject({ name: 'Flour', archivedAt: null });
	});

	it('update renames with an audit row; a taken name and a moved base unit are refused', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const flour = await makeFlour(r.ctx);
		await db.transaction((tx) => createIngredient(tx, r.ctx, { name: 'Sugar', baseUnit: 'g' }));

		const thrown = await thrownBy(() =>
			act(
				'update',
				makeEvent(asOwner, flour.ingredientId, { name: ' Bread flour ', baseUnit: 'kg' })
			)
		);
		expect(thrown).toMatchObject({ status: 303, location: `/inventory/${flour.ingredientId}` });
		const [row] = await db.select().from(ingredients).where(eq(ingredients.id, flour.ingredientId));
		expect(row).toMatchObject({ name: 'Bread flour', baseUnit: 'kg' });
		expect(await auditCount(r.restaurantId, 'ingredient.updated')).toBe(1);

		expect(
			await act('update', makeEvent(asOwner, flour.ingredientId, { name: 'sugar' }))
		).toMatchObject({
			status: 400,
			data: { message: 'An ingredient with this name already exists.' }
		});
		expect(
			await act('update', makeEvent(asOwner, flour.ingredientId, { name: ' ' }))
		).toMatchObject({ status: 400 });

		await deliver(r.ctx, flour.ingredientId, flour.unitId);
		expect(
			await act(
				'update',
				makeEvent(asOwner, flour.ingredientId, { name: 'Bread flour', baseUnit: 'g' })
			)
		).toMatchObject({
			status: 400,
			data: { message: 'The base unit cannot change once stock has moved.' }
		});
		// The disabled field is not submitted: the name alone still changes.
		const renamed = await thrownBy(() =>
			act('update', makeEvent(asOwner, flour.ingredientId, { name: 'Flour' }))
		);
		expect(renamed).toMatchObject({ status: 303 });
		const [after] = await db
			.select()
			.from(ingredients)
			.where(eq(ingredients.id, flour.ingredientId));
		expect(after).toMatchObject({ name: 'Flour', baseUnit: 'kg' });
	});

	it('addUnit and archiveUnit write their rows and audit rows; refusals say why', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const flour = await makeFlour(r.ctx);

		const added = await thrownBy(() =>
			act(
				'addUnit',
				makeEvent(asOwner, flour.ingredientId, { name: 'Sack', baseQtyPerUnit: '25000' })
			)
		);
		expect(added).toMatchObject({ status: 303, location: `/inventory/${flour.ingredientId}` });
		const [sack] = await db
			.select()
			.from(ingredientPurchaseUnits)
			.where(
				and(
					eq(ingredientPurchaseUnits.ingredientId, flour.ingredientId),
					eq(ingredientPurchaseUnits.name, 'Sack')
				)
			);
		expect(sack.baseQtyPerUnit).toBe('25000.000');
		expect(await auditCount(r.restaurantId, 'purchase_unit.added')).toBe(2);

		expect(
			await act(
				'addUnit',
				makeEvent(asOwner, flour.ingredientId, { name: 'Sack', baseQtyPerUnit: '1' })
			)
		).toMatchObject({
			status: 400,
			data: { message: 'This ingredient already has a unit with this name.' }
		});
		for (const bad of ['0', '-1', 'abc', '1.2345']) {
			expect(
				await act(
					'addUnit',
					makeEvent(asOwner, flour.ingredientId, { name: 'Tin', baseQtyPerUnit: bad })
				)
			).toMatchObject({
				status: 400,
				data: {
					message: 'Enter a quantity above zero with at most three decimals, for example 2.5.'
				}
			});
		}

		const archived = await thrownBy(() =>
			act('archiveUnit', makeEvent(asOwner, flour.ingredientId, { unitId: sack.id }))
		);
		expect(archived).toMatchObject({ status: 303 });
		const [gone] = await db
			.select()
			.from(ingredientPurchaseUnits)
			.where(eq(ingredientPurchaseUnits.id, sack.id));
		expect(gone.archivedAt).not.toBeNull();
		expect(await auditCount(r.restaurantId, 'purchase_unit.archived')).toBe(1);
		expect((await loadAs(asOwner, flour.ingredientId)).units.map((u) => u.name)).toEqual(['bag']);

		// Archived already, or another ingredient's unit: not this page's to archive.
		const sugar = await db.transaction(async (tx) => {
			const s = await createIngredient(tx, r.ctx, { name: 'Sugar', baseUnit: 'g' });
			if (!s.ok) throw new Error('sugar');
			return s.id;
		});
		for (const unitId of [sack.id, flour.unitId]) {
			const target = unitId === sack.id ? flour.ingredientId : sugar;
			expect(await act('archiveUnit', makeEvent(asOwner, target, { unitId }))).toMatchObject({
				status: 400,
				data: { message: 'That unit no longer exists. Reload the page.' }
			});
		}
		const [bag] = await db
			.select()
			.from(ingredientPurchaseUnits)
			.where(eq(ingredientPurchaseUnits.id, flour.unitId));
		expect(bag.archivedAt).toBeNull();
	});

	it('archive is refused while a live recipe uses it, then archives and redirects to /inventory', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const flour = await makeFlour(r.ctx);
		const itemId = await db.transaction(async (tx) => {
			const cat = await createCategory(tx, r.restaurantId, { name: 'Bakery' });
			const item = await createItem(tx, r.restaurantId, {
				categoryId: cat.id,
				name: 'Bread',
				priceMinor: 300n
			});
			if (!item.ok) throw new Error('item');
			return item.id;
		});
		await db.insert(recipeLines).values({
			restaurantId: r.restaurantId,
			menuItemId: itemId,
			ingredientId: flour.ingredientId,
			qty: '250.000'
		});

		expect(await act('archive', makeEvent(asOwner, flour.ingredientId, {}))).toMatchObject({
			status: 400,
			data: { message: 'Remove it from these recipes first: Bread.' }
		});

		await db.transaction((tx) => archiveItem(tx, r.restaurantId, itemId));
		const thrown = await thrownBy(() => act('archive', makeEvent(asOwner, flour.ingredientId, {})));
		expect(thrown).toMatchObject({ status: 303, location: '/inventory' });
		const [row] = await db.select().from(ingredients).where(eq(ingredients.id, flour.ingredientId));
		expect(row.archivedAt).not.toBeNull();
		expect(await auditCount(r.restaurantId, 'ingredient.archived')).toBe(1);
		// The page still opens for an archived ingredient; it offers no opening stock.
		expect((await loadAs(asOwner, flour.ingredientId)).openingAllowed).toBe(false);
	});

	it('openingStock records the entry, its movement and its audit row, once', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const flour = await makeFlour(r.ctx);

		const before = await loadAs(asOwner, flour.ingredientId);
		expect(before.openingAllowed).toBe(true);
		expect(before.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		expect(
			await act(
				'openingStock',
				makeEvent(asOwner, flour.ingredientId, {
					...OPENING_FORM,
					purchaseUnitId: flour.unitId,
					businessDate: '2026-02-30'
				})
			)
		).toMatchObject({ status: 400, data: { message: 'Enter the business date as YYYY-MM-DD.' } });
		expect(
			await act(
				'openingStock',
				makeEvent(asOwner, flour.ingredientId, {
					...OPENING_FORM,
					purchaseUnitId: flour.unitId,
					cost: '1.234'
				})
			)
		).toMatchObject({
			status: 400,
			data: { message: 'Use at most 2 digits after the decimal point.' }
		});
		const sugarUnit = await db.transaction(async (tx) => {
			const s = await createIngredient(tx, r.ctx, { name: 'Sugar', baseUnit: 'g' });
			if (!s.ok) throw new Error('sugar');
			const u = await addPurchaseUnit(tx, r.ctx, s.id, {
				name: 'bag',
				baseQtyPerUnit: qty(1_000_000n)
			});
			if (!u.ok) throw new Error('unit');
			return u.id;
		});
		expect(
			await act(
				'openingStock',
				makeEvent(asOwner, flour.ingredientId, { ...OPENING_FORM, purchaseUnitId: sugarUnit })
			)
		).toMatchObject({
			status: 400,
			data: { message: "Choose one of this ingredient's purchase units." }
		});
		expect(await db.select().from(openingStockEntries)).toHaveLength(0);

		const thrown = await thrownBy(() =>
			act(
				'openingStock',
				makeEvent(asOwner, flour.ingredientId, { ...OPENING_FORM, purchaseUnitId: flour.unitId })
			)
		);
		expect(thrown).toMatchObject({ status: 303, location: `/inventory/${flour.ingredientId}` });
		const [entry] = await db
			.select()
			.from(openingStockEntries)
			.where(eq(openingStockEntries.ingredientId, flour.ingredientId));
		expect(entry).toMatchObject({
			purchaseUnitName: 'bag',
			unitQty: '2.000',
			baseQty: '2000.000',
			unitCostMinor: 1250n,
			valueMinor: 2500n,
			businessDate: '2026-09-01'
		});
		expect(await auditCount(r.restaurantId, 'opening_stock.recorded')).toBe(1);

		const after = await loadAs(asOwner, flour.ingredientId);
		expect(after.openingAllowed).toBe(false);
		expect(after.movements).toEqual([
			expect.objectContaining({
				glyph: '○',
				type: 'Opening stock',
				qty: '2000.000 g',
				cost: '25.00'
			})
		]);
		expect(() => JSON.stringify(after)).not.toThrow();

		expect(
			await act(
				'openingStock',
				makeEvent(asOwner, flour.ingredientId, { ...OPENING_FORM, purchaseUnitId: flour.unitId })
			)
		).toMatchObject({
			status: 400,
			data: {
				message:
					'Opening stock can only be recorded before any stock has moved for this ingredient.'
			}
		});
	});

	it('after a delivery, openingAllowed is false and openingStock answers has_movements', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const flour = await makeFlour(r.ctx);
		await deliver(r.ctx, flour.ingredientId, flour.unitId);

		const data = await loadAs(asOwner, flour.ingredientId);
		expect(data.openingAllowed).toBe(false);
		expect(data.hasMovements).toBe(true);
		expect(data.movements[0]).toMatchObject({ glyph: '+', type: 'Delivery', qty: '2000.000 g' });

		expect(
			await act(
				'openingStock',
				makeEvent(asOwner, flour.ingredientId, { ...OPENING_FORM, purchaseUnitId: flour.unitId })
			)
		).toMatchObject({
			status: 400,
			data: {
				message:
					'Opening stock can only be recorded before any stock has moved for this ingredient.'
			}
		});
		expect(await db.select().from(openingStockEntries)).toHaveLength(0);
	});

	it('openingStock is refused with the currency sentence while no currency is set', async () => {
		const r = await makeRestaurant({ currency: false });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const flour = await makeFlour(r.ctx);
		expect(
			await act(
				'openingStock',
				makeEvent(asOwner, flour.ingredientId, { ...OPENING_FORM, purchaseUnitId: flour.unitId })
			)
		).toMatchObject({
			status: 400,
			data: { message: 'Set the currency in Settings before entering amounts.' }
		});
		expect(await db.select().from(openingStockEntries)).toHaveLength(0);
	});
});
