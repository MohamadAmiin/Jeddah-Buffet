import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { recipeLines } from '$lib/server/db/schema/inventory';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { createCategory, createItem } from '$lib/server/menu';
import { createIngredient } from '$lib/server/inventory';
import { load, actions } from './+page.server';

// The /inventory/recipes page (tasks/inventory-cogs T-29), in the idiom of
// inventory-page.integration.test.ts.

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
	await db.transaction((tx) =>
		updateSettings(
			tx,
			restaurant.id,
			{ currencyCode: 'USD' },
			{ actorUserId: owner.id, ip: null, userAgent: null }
		)
	);
	const ctx = { restaurantId: restaurant.id, actorUserId: owner.id, ip: null, userAgent: null };
	const itemId = await db.transaction(async (tx) => {
		const category = await createCategory(tx, restaurant.id, { name: 'Mains' });
		const item = await createItem(tx, restaurant.id, {
			categoryId: category.id,
			name: 'Burger',
			priceMinor: 850n
		});
		if (!item.ok) throw new Error('item not created');
		return item.id;
	});
	const ingredient = async (name: string, baseUnit: string) => {
		const created = await db.transaction((tx) => createIngredient(tx, ctx, { name, baseUnit }));
		if (!created.ok) throw new Error('ingredient not created');
		return created.id;
	};
	const bunId = await ingredient('Bun', 'pcs');
	const beefId = await ingredient('Beef', 'g');
	return { restaurantId: restaurant.id, ownerId: owner.id, itemId, bunId, beefId };
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

type FormInput = Record<string, string | string[]>;

function makeEvent(user: Principal, form?: FormInput, search = ''): RequestEvent {
	const url = new URL(`http://localhost/inventory/recipes${search}`);
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
		route: { id: '/(dashboard)/inventory/recipes' },
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

async function recipeRows(restaurantId: string) {
	return db.select().from(recipeLines).where(eq(recipeLines.restaurantId, restaurantId));
}

async function recipeAudits(restaurantId: string) {
	return db
		.select({ event: auditLog.event })
		.from(auditLog)
		.where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.event, 'recipe.changed')));
}

describe('the /inventory/recipes page', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on the load and on every action, writing nothing', async () => {
		const r = await makeRestaurant();
		const staff = await seedStaff(db, r.restaurantId, { displayName: 'Staff' });
		const asStaff = principal(staff.id, r.restaurantId, 'staff');

		expect((await thrownBy(() => load(makeEvent(asStaff) as never)))?.status).toBe(403);
		expect(
			(await thrownBy(() => load(makeEvent(asStaff, undefined, `?item=${r.itemId}`) as never)))
				?.status
		).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			const thrown = await thrownBy(() =>
				act(
					name,
					makeEvent(asStaff, {
						kind: 'item',
						ownerId: r.itemId,
						ingredientId: [r.bunId],
						qty: ['1']
					})
				)
			);
			expect(thrown?.status, name).toBe(403);
		}
		expect(await recipeRows(r.restaurantId)).toHaveLength(0);
		expect(await recipeAudits(r.restaurantId)).toHaveLength(0);
	});

	it('save replaces the recipe, writes recipe.changed, and redirects 303 to the owner', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const first = await thrownBy(() =>
			act(
				'save',
				makeEvent(asOwner, {
					kind: 'item',
					ownerId: r.itemId,
					ingredientId: [r.bunId, '', r.beefId],
					qty: ['1', '', '150']
				})
			)
		);
		expect(first).toMatchObject({
			status: 303,
			location: `/inventory/recipes?item=${r.itemId}`
		});
		expect(await recipeRows(r.restaurantId)).toHaveLength(2);

		const second = await thrownBy(() =>
			act(
				'save',
				makeEvent(asOwner, {
					kind: 'item',
					ownerId: r.itemId,
					ingredientId: [r.beefId],
					qty: ['120.5']
				})
			)
		);
		expect(second).toMatchObject({ status: 303 });
		const rows = await recipeRows(r.restaurantId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			menuItemId: r.itemId,
			ingredientId: r.beefId,
			qty: '120.500'
		});
		expect(await recipeAudits(r.restaurantId)).toHaveLength(2);
	});

	it('an invalid row answers its message and writes nothing', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const result = await act(
			'save',
			makeEvent(asOwner, {
				kind: 'item',
				ownerId: r.itemId,
				ingredientId: [r.bunId, r.beefId],
				qty: ['1', '-1']
			})
		);
		expect(result).toMatchObject({
			status: 400,
			data: { message: "Row 2: an item's quantity must be more than zero." }
		});
		expect(await recipeRows(r.restaurantId)).toHaveLength(0);
		expect(await recipeAudits(r.restaurantId)).toHaveLength(0);

		// A foreign or unknown owner is not_found, and still writes nothing.
		const missing = await act(
			'save',
			makeEvent(asOwner, {
				kind: 'item',
				ownerId: '00000000-0000-4000-8000-000000000000',
				ingredientId: [r.bunId],
				qty: ['1']
			})
		);
		expect(missing).toMatchObject({ status: 404 });
		expect(await recipeRows(r.restaurantId)).toHaveLength(0);
	});

	it('the load selects the owner, ignores an unknown id, and sends strings only', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		await thrownBy(() =>
			act(
				'save',
				makeEvent(asOwner, {
					kind: 'item',
					ownerId: r.itemId,
					ingredientId: [r.bunId],
					qty: ['2']
				})
			)
		);

		type Data = {
			categories: { items: { id: string; hasRecipe: boolean; cost: string | null }[] }[];
			selected: { id: string; rows: { ingredientId: string; qty: string }[] } | null;
		};
		const data = (await load(makeEvent(asOwner, undefined, `?item=${r.itemId}`) as never)) as Data;
		expect(data.selected?.id).toBe(r.itemId);
		expect(data.selected?.rows).toEqual([
			expect.objectContaining({ ingredientId: r.bunId, qty: '2.000' })
		]);
		expect(data.categories[0].items[0]).toMatchObject({
			id: r.itemId,
			hasRecipe: true,
			cost: '0.00'
		});
		// JSON.stringify throws on a bigint: the page receives strings only.
		expect(() => JSON.stringify(data)).not.toThrow();

		const unknown = (await load(
			makeEvent(asOwner, undefined, '?item=not-a-uuid') as never
		)) as Data;
		expect(unknown.selected).toBeNull();
	});
});
