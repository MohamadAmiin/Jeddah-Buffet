import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { menuItems } from '$lib/server/db/schema/menu';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { createCategory } from '$lib/server/menu';
import { applyMovements, createIngredient, setRecipe } from '$lib/server/inventory';
import { minor } from '$lib/money';
import { formatAmount, moneyFormatFor } from '$lib/money/format';
import { qty } from '$lib/money/quantity';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const CURRENCY_MESSAGE = 'Set the currency in Settings before adding prices.';

async function makeRestaurant({ currency }: { currency: boolean }) {
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
	if (currency) {
		await db.transaction((tx) =>
			updateSettings(
				tx,
				restaurant.id,
				{ currencyCode: 'USD' },
				{ actorUserId: owner.id, ip: null, userAgent: null }
			)
		);
	}
	const category = await db.transaction((tx) =>
		createCategory(tx, restaurant.id, { name: 'Drinks' })
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, categoryId: category.id };
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

function makeEvent(user: Principal, form?: Record<string, string>): RequestEvent {
	const url = new URL('http://localhost/menu');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/menu' },
		url
	} as unknown as RequestEvent;
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

type ActionName = keyof typeof actions;
function act(name: ActionName, event: RequestEvent) {
	return actions[name]!(event as Parameters<NonNullable<(typeof actions)[ActionName]>>[0]);
}

describe('the /menu page', () => {
	// MANDATORY (spec 29 — permission checks; this repository applies the rule to
	// every route): 403 from the load and from EVERY action, each a separately
	// reachable endpoint.
	it('refuses a cashier with 403 on the load and on every action', async () => {
		const r = await makeRestaurant({ currency: true });
		const cashier = await seedStaff(db, r.restaurantId, {
			displayName: 'Staff'
		});
		const asCashier = principal(cashier.id, r.restaurantId, 'staff');

		expect(await statusOf(() => load(makeEvent(asCashier) as never))).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			expect(
				await statusOf(() =>
					act(name, makeEvent(asCashier, { categoryId: r.categoryId, name: 'Tea', price: '1' }))
				),
				name
			).toBe(403);
		}
		expect(await db.select().from(menuItems)).toHaveLength(0);
	});

	it('stores a price of 8.50 as exactly 850n', async () => {
		const r = await makeRestaurant({ currency: true });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const result = await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '8.50', taxRateBp: '' })
		);

		expect(result).toEqual({ message: 'Tea added.' });
		const [row] = await db.select().from(menuItems).where(eq(menuItems.name, 'Tea'));
		expect(row.priceMinor).toBe(850n);
		expect(row.taxRateBp).toBeNull();
	});

	it('refuses a price with more decimals than the currency has, and stores nothing', async () => {
		const r = await makeRestaurant({ currency: true });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const result = await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '8.505' })
		);

		expect((result as { status?: number }).status).toBe(400);
		expect(await db.select().from(menuItems)).toHaveLength(0);
	});

	it('gates every price on the currency: no currency, no exponent, no write', async () => {
		const r = await makeRestaurant({ currency: false });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const data = (await load(makeEvent(asOwner) as never)) as { currency: unknown };
		expect(data.currency).toBeNull();

		const result = await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '8.50' })
		);
		expect(result).toMatchObject({ status: 400, data: { message: CURRENCY_MESSAGE } });
		expect(await db.select().from(menuItems)).toHaveLength(0);
	});

	it('sends the page formatted strings, never a bigint', async () => {
		const r = await makeRestaurant({ currency: true });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Tea', price: '1234.5' })
		);

		const data = await load(makeEvent(asOwner) as never);

		// JSON.stringify throws on a bigint, so this line is the assertion.
		const serialised = JSON.stringify(data);
		expect(serialised).toContain('"price":"1,234.50"');
		expect(serialised).toContain('"taxRate":"restaurant rate"');
	});

	// tasks/inventory-cogs T-34: cost and margin, read-only, from the ledger's
	// averages. Spec 16's burger (150 g meat at 0.55¢/g, a 25¢ bun, a 12¢ cheese
	// slice) costs 119.5 → 1.20; at $8.00 exclusive of 10% tax the net price is
	// 8.00, so the margin is 6.80 (T-11).
	it("shows each item's recipe cost and margin as formatted strings", async () => {
		const r = await makeRestaurant({ currency: true });
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		const ctx = { actorUserId: r.ownerId, ip: null, userAgent: null };
		await db.transaction((tx) =>
			updateSettings(tx, r.restaurantId, { taxMode: 'exclusive', taxRateBp: 1000 }, ctx)
		);
		await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Burger', price: '8.00', taxRateBp: '' })
		);
		await act(
			'createItem',
			makeEvent(asOwner, { categoryId: r.categoryId, name: 'Water', price: '1.00', taxRateBp: '' })
		);
		const [burger] = await db.select().from(menuItems).where(eq(menuItems.name, 'Burger'));

		const inv = { restaurantId: r.restaurantId, ...ctx, actorUserId: r.ownerId };
		await db.transaction(async (tx) => {
			const lines: { ingredientId: string; qty: ReturnType<typeof qty> }[] = [];
			for (const [name, unit, bought, cost, used] of [
				['Meat', 'g', 1000000n, 550n, 150000n],
				['Bun', 'pcs', 1000n, 25n, 1000n],
				['Cheese', 'slice', 1000n, 12n, 1000n]
			] as const) {
				const ingredient = await createIngredient(tx, inv, { name, baseUnit: unit });
				if (!ingredient.ok) throw new Error(ingredient.reason);
				await applyMovements(
					tx,
					{
						restaurantId: r.restaurantId,
						sourceType: 'purchase',
						sourceId: crypto.randomUUID(),
						businessDate: '2026-09-28',
						occurredAt: new Date(),
						recordedByUserId: r.ownerId
					},
					[
						{
							kind: 'inbound',
							type: 'purchase',
							ingredientId: ingredient.id,
							qty: qty(bought),
							costMinor: minor(cost)
						}
					]
				);
				lines.push({ ingredientId: ingredient.id, qty: qty(used) });
			}
			const set = await setRecipe(tx, inv, { owner: { kind: 'item', id: burger.id }, lines });
			if (!set.ok) throw new Error(set.reason);
		});

		const data = (await load(makeEvent(asOwner) as never)) as {
			items: { name: string; cost: { text: string } | null; margin: { text: string } | null }[];
		};
		const usd = moneyFormatFor('USD');
		const byName = new Map(data.items.map((item) => [item.name, item]));
		expect(byName.get('Burger')!.cost).toEqual({
			text: formatAmount(minor(120n), usd),
			negative: false
		});
		expect(byName.get('Burger')!.margin).toEqual({
			text: formatAmount(minor(680n), usd),
			negative: false,
			unset: false
		});
		expect(formatAmount(minor(120n), usd)).toBe('1.20');
		// An item with no recipe has no cost and no margin.
		expect(byName.get('Water')!.cost).toBeNull();
		expect(byName.get('Water')!.margin).toBeNull();
		expect(() => JSON.stringify(data)).not.toThrow();
	});
});
