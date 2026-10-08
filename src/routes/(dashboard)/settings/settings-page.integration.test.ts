// The GENERAL settings page (tasks/settings-tax-payments-receipt T-27): the
// restaurant's name, its time zone and its one currency. The tax mode, the default
// rate, the tenders and the receipt text each have their own page now, so this
// page must neither return them nor let a posted field reach their columns.
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { RequestEvent, ServerLoadEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { restaurantSettings } from '$lib/server/db/schema/restaurant-settings';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { seedStaff } from '$lib/server/db/test/seed';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name = 'Cafe One'): Promise<string> {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();

	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: name,
			timeZone: 'Africa/Mogadishu'
		})
	);

	return restaurant.id;
}

async function makeOwner(restaurantId: string): Promise<string> {
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId,
			role: 'owner',
			displayName: 'The Owner',
			email: 'owner@cafe.com',
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });

	return owner.id;
}

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Cashier',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function makeEvent(user: Principal, formEntries: Array<[string, string]> = []): RequestEvent {
	const url = new URL('http://localhost/settings');
	const body = new FormData();

	for (const [key, value] of formEntries) {
		body.append(key, value);
	}

	return {
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {}
		},
		getClientAddress: () => '203.0.113.5',
		locals: {
			user,
			restaurantId: user.restaurantId,
			sessionToken: null,
			posDevice: null
		},
		params: {},
		request: new Request(url, {
			method: 'POST',
			body
		}),
		route: { id: '/(dashboard)/settings' },
		url
	} as unknown as RequestEvent;
}

function loadEvent(user: Principal): ServerLoadEvent {
	return {
		...makeEvent(user),
		parent: async () => ({}),
		depends: () => {},
		untrack: <T>(fn: () => T) => fn()
	} as unknown as ServerLoadEvent;
}

function action(name: keyof typeof actions, event: RequestEvent) {
	const handler = actions[name];

	if (!handler) {
		throw new Error(`Missing action: ${name}`);
	}

	return handler(event as Parameters<typeof handler>[0]);
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return (error as { status?: number }).status;
	}
}

function messageOf(result: unknown): string | undefined {
	return (result as { data?: { message?: string } }).data?.message;
}

/** The three columns this page owns, and the two it must never touch again. */
async function settingsRow(restaurantId: string) {
	const [row] = await db
		.select({
			timeZone: restaurantSettings.timeZone,
			currencyCode: restaurantSettings.currencyCode,
			taxMode: restaurantSettings.taxMode,
			receiptAddress: restaurantSettings.receiptAddress
		})
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId));

	return row;
}

async function nameOf(restaurantId: string): Promise<string> {
	const [row] = await db
		.select({ name: restaurants.name })
		.from(restaurants)
		.where(eq(restaurants.id, restaurantId));

	return row.name;
}

async function settingsUpdatedCount(restaurantId: string): Promise<number> {
	const rows = await db
		.select({ id: auditLog.id })
		.from(auditLog)
		.where(and(eq(auditLog.event, 'settings.updated'), eq(auditLog.restaurantId, restaurantId)));

	return rows.length;
}

async function auditCount(restaurantId: string): Promise<number> {
	const rows = await db
		.select({ id: auditLog.id })
		.from(auditLog)
		.where(eq(auditLog.restaurantId, restaurantId));

	return rows.length;
}

const VALID_FORM: Array<[string, string]> = [
	['name', 'Cafe Two'],
	['timeZone', 'Asia/Riyadh'],
	['currencyCode', 'USD']
];

describe('general settings page', () => {
	// MANDATORY (spec 29 — a permission check per route). The load AND the action:
	// a form action is a separately reachable POST endpoint (invariant 8).
	it('returns 403 for a cashier on the load and on the default action', async () => {
		const restaurantId = await makeRestaurant();
		const staff = await seedStaff(db, restaurantId, { displayName: 'Cashier' });
		const cashier = principal(staff.id, restaurantId, 'staff');

		expect(await statusOf(() => load(loadEvent(cashier)))).toBe(403);
		expect(await statusOf(() => action('default', makeEvent(cashier, VALID_FORM)))).toBe(403);

		// Nothing written: the name, the settings row and the audit log are as they were.
		expect(await nameOf(restaurantId)).toBe('Cafe One');
		expect(await settingsRow(restaurantId)).toMatchObject({
			timeZone: 'Africa/Mogadishu',
			currencyCode: null
		});
		expect(await settingsUpdatedCount(restaurantId)).toBe(0);
	});

	it('saves the name, time zone and currency with one settings.updated audit row', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');
		const before = await settingsUpdatedCount(restaurantId);

		const result = await action('default', makeEvent(owner, VALID_FORM));

		expect(result).toEqual({ message: 'Settings saved.' });
		expect(await nameOf(restaurantId)).toBe('Cafe Two');
		expect(await settingsRow(restaurantId)).toMatchObject({
			timeZone: 'Asia/Riyadh',
			currencyCode: 'USD'
		});
		expect(await settingsUpdatedCount(restaurantId)).toBe(before + 1);

		// The same values again: nothing changed, so no second audit row.
		const again = await action('default', makeEvent(owner, VALID_FORM));

		expect(again).toEqual({ message: 'No changes to save.' });
		expect(await settingsUpdatedCount(restaurantId)).toBe(before + 1);
	});

	it('ignores the fields that moved to other pages', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const result = await action(
			'default',
			makeEvent(owner, [
				['name', 'Cafe Renamed'],
				['timeZone', 'Africa/Mogadishu'],
				['taxMode', 'inclusive'],
				['receiptAddress', 'Km4']
			])
		);

		expect(result).toEqual({ message: 'Settings saved.' });
		expect(await nameOf(restaurantId)).toBe('Cafe Renamed');
		// Each moved column is untouched: still NULL, exactly as registration left it.
		expect(await settingsRow(restaurantId)).toMatchObject({
			taxMode: null,
			receiptAddress: null
		});
	});

	it('refuses a currency it cannot format', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');
		const before = await settingsUpdatedCount(restaurantId);

		const result = await action(
			'default',
			makeEvent(owner, [
				['name', 'Cafe Two'],
				['timeZone', 'Asia/Riyadh'],
				['currencyCode', 'EUR']
			])
		);

		expect((result as { status: number }).status).toBe(400);
		expect(messageOf(result)).toBe('That currency code is not one this system can format.');

		// Nothing changed — not even the name and time zone posted beside it.
		expect(await nameOf(restaurantId)).toBe('Cafe One');
		expect(await settingsRow(restaurantId)).toMatchObject({
			timeZone: 'Africa/Mogadishu',
			currencyCode: null
		});
		expect(await settingsUpdatedCount(restaurantId)).toBe(before);
	});

	it('writes to locals.restaurantId only', async () => {
		const a = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const ownerId = await makeOwner(a);
		const ownerOfA = principal(ownerId, a, 'owner');
		const auditOfBBefore = await auditCount(b);

		const result = await action(
			'default',
			makeEvent(ownerOfA, [
				['restaurantId', b],
				['name', 'Cafe A Renamed'],
				['timeZone', 'Africa/Mogadishu']
			])
		);

		expect(result).toEqual({ message: 'Settings saved.' });
		expect(await nameOf(a)).toBe('Cafe A Renamed');
		expect(await nameOf(b)).toBe('Cafe B');
		expect(await auditCount(b)).toBe(auditOfBBefore);
	});

	it('the load carries no tax, tender or receipt key', async () => {
		const restaurantId = await makeRestaurant();
		const ownerId = await makeOwner(restaurantId);
		const owner = principal(ownerId, restaurantId, 'owner');

		const data = (await load(loadEvent(owner))) as Record<string, unknown>;

		expect(Object.keys(data).sort()).toEqual([
			'currencyCode',
			'name',
			'supportedCurrencies',
			'timeZone',
			'timeZones'
		]);
		expect(data.name).toBe('Cafe One');
		expect(data.timeZone).toBe('Africa/Mogadishu');
		expect(data.currencyCode).toBeNull();
		expect(data.supportedCurrencies).toEqual(['USD']);
	});
});
