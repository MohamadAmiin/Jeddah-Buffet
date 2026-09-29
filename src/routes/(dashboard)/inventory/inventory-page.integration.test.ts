import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { ingredients } from '$lib/server/db/schema/inventory';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { load, actions } from './+page.server';

// The /inventory page (tasks/inventory-cogs T-27), in the idiom of
// menu-page.integration.test.ts.

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
	return { restaurantId: restaurant.id, ownerId: owner.id };
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
	const url = new URL('http://localhost/inventory');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/inventory' },
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

describe('the /inventory page', () => {
	// MANDATORY (spec 29 — permission checks, applied to every route here).
	it('refuses staff with 403 on the load and on every action, writing nothing', async () => {
		const r = await makeRestaurant();
		const staff = await seedStaff(db, r.restaurantId, { displayName: 'Staff' });
		const asStaff = principal(staff.id, r.restaurantId, 'staff');

		expect((await thrownBy(() => load(makeEvent(asStaff) as never)))?.status).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			const thrown = await thrownBy(() =>
				act(name, makeEvent(asStaff, { name: 'Flour', baseUnit: 'g' }))
			);
			expect(thrown?.status, name).toBe(403);
		}
		expect(await db.select().from(ingredients)).toHaveLength(0);
	});

	it('createIngredient writes the row and its audit row, then redirects 303 to it', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');

		const thrown = await thrownBy(() =>
			act('createIngredient', makeEvent(asOwner, { name: '  Flour ', baseUnit: 'g' }))
		);
		const [row] = await db
			.select()
			.from(ingredients)
			.where(eq(ingredients.restaurantId, r.restaurantId));
		expect(row).toMatchObject({ name: 'Flour', baseUnit: 'g' });
		expect(thrown).toMatchObject({ status: 303, location: `/inventory/${row.id}` });
		const audits = await db
			.select({ event: auditLog.event })
			.from(auditLog)
			.where(
				and(eq(auditLog.restaurantId, r.restaurantId), eq(auditLog.event, 'ingredient.created'))
			);
		expect(audits).toHaveLength(1);

		const again = await act(
			'createIngredient',
			makeEvent(asOwner, { name: 'flour', baseUnit: 'g' })
		);
		expect(again).toMatchObject({
			status: 400,
			data: { message: 'An ingredient with this name already exists.' }
		});
		const blank = await act('createIngredient', makeEvent(asOwner, { name: ' ', baseUnit: 'g' }));
		expect(blank).toMatchObject({ status: 400 });
	});

	it('a corrupted cache shows as drift and raises the mismatch alert', async () => {
		const r = await makeRestaurant();
		const asOwner = principal(r.ownerId, r.restaurantId, 'owner');
		await thrownBy(() =>
			act('createIngredient', makeEvent(asOwner, { name: 'Flour', baseUnit: 'g' }))
		);

		const clean = (await load(makeEvent(asOwner) as never)) as {
			ingredients: { drift: boolean; onHand: string }[];
			mismatch: unknown;
		};
		expect(clean.mismatch).toBeNull();
		expect(clean.ingredients[0]).toMatchObject({ drift: false, onHand: '0.000 g' });

		// The owner connection bypasses the one writer on purpose.
		await db.execute(
			sql`update ingredients set on_hand_qty = on_hand_qty + 1 where restaurant_id = ${r.restaurantId}`
		);
		const data = (await load(makeEvent(asOwner) as never)) as {
			ingredients: { drift: boolean }[];
			mismatch: { difference: string; driftCount: number } | null;
		};
		expect(data.ingredients[0].drift).toBe(true);
		expect(data.mismatch).toEqual({ difference: '0.00', driftCount: 1 });
		// JSON.stringify throws on a bigint: the page receives strings only.
		expect(() => JSON.stringify(data)).not.toThrow();
	});
});
