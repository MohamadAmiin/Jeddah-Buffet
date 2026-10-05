// THE TAX SETTINGS PAGE (tasks/settings-tax-payments-receipt T-28): the tax
// mode, the named rates and the default. The owner types a percent; the page
// stores integer basis points through parsePercentToBp and never a float
// (invariant 1); every write bumps the menu version and audits in the action's
// one transaction (spec 5; invariant 10); a rate of another restaurant is never
// reachable (invariant 8).
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import type { RequestEvent, ServerLoadEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { restaurantSettings } from '$lib/server/db/schema/restaurant-settings';
import { taxRates } from '$lib/server/db/schema/tax-rates';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { seedStaff } from '$lib/server/db/test/seed';
import { seedTaxRate } from '$lib/server/db/test/settings';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { createItem, getMenuVersion } from '$lib/server/menu';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const RATE_MESSAGE =
	'Type the rate as a percent from 0 to 100 with at most two decimals — for example 5 or 8.25.';
const NOT_FOUND_MESSAGE = 'That rate no longer exists. Reload the page.';
const DEFAULT_MESSAGE = 'Choose a live rate of this restaurant.';

/** A well-formed id that belongs to nobody. */
const NOBODY = '00000000-0000-4000-8000-000000000000';

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
	const url = new URL('http://localhost/settings/tax');
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
		route: { id: '/(dashboard)/settings/tax' },
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

type ActionName = keyof typeof actions;

function action(name: ActionName, event: RequestEvent) {
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

function statusCodeOf(result: unknown): number | undefined {
	return (result as { status?: number }).status;
}

/** Every rate of the restaurant, live and archived, oldest sort order first. */
async function rateRows(restaurantId: string) {
	return db
		.select({
			id: taxRates.id,
			name: taxRates.name,
			rateBp: taxRates.rateBp,
			archivedAt: taxRates.archivedAt
		})
		.from(taxRates)
		.where(eq(taxRates.restaurantId, restaurantId))
		.orderBy(asc(taxRates.sortOrder), asc(taxRates.name));
}

async function settingsRow(restaurantId: string) {
	const [row] = await db
		.select({
			taxMode: restaurantSettings.taxMode,
			defaultTaxRateId: restaurantSettings.defaultTaxRateId
		})
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId));

	return row;
}

async function eventCount(restaurantId: string, event: string): Promise<number> {
	const rows = await db
		.select({ id: auditLog.id })
		.from(auditLog)
		.where(and(eq(auditLog.event, event), eq(auditLog.restaurantId, restaurantId)));

	return rows.length;
}

async function auditCount(restaurantId: string): Promise<number> {
	const rows = await db
		.select({ id: auditLog.id })
		.from(auditLog)
		.where(eq(auditLog.restaurantId, restaurantId));

	return rows.length;
}

/** A ready-made rate through the real writers (T-13's fixture); returns its id. */
function seedRate(
	restaurantId: string,
	actorUserId: string | null,
	input: { name: string; rateBp: number; makeDefault?: boolean }
): Promise<string> {
	return db.transaction((tx) =>
		seedTaxRate(tx, restaurantId, input, { actorUserId, ip: null, userAgent: null })
	);
}

async function owned(name = 'Cafe One') {
	const restaurantId = await makeRestaurant(name);
	const ownerId = await makeOwner(restaurantId);
	return { restaurantId, ownerId, owner: principal(ownerId, restaurantId, 'owner') };
}

describe('tax settings page', () => {
	// MANDATORY (spec 29 — a permission check per route): 403 from the load and
	// from EVERY action, each a separately reachable endpoint (invariant 8). The
	// loop over Object.keys(actions) covers a sixth action without editing this.
	it('refuses a cashier with 403 on the load and on every action', async () => {
		const restaurantId = await makeRestaurant();
		const staff = await seedStaff(db, restaurantId, { displayName: 'Cashier' });
		const cashier = principal(staff.id, restaurantId, 'staff');
		const versionBefore = await getMenuVersion(db, restaurantId);
		const auditBefore = await auditCount(restaurantId);

		expect(await statusOf(() => load(loadEvent(cashier)))).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			expect(
				await statusOf(() =>
					action(
						name,
						makeEvent(cashier, [
							['taxMode', 'inclusive'],
							['taxRateId', NOBODY],
							['name', 'VAT'],
							['percent', '5'],
							['makeDefault', 'yes']
						])
					)
				),
				name
			).toBe(403);
		}

		// Nothing written: no rate, no mode, no bump, no audit row.
		expect(await rateRows(restaurantId)).toHaveLength(0);
		expect(await settingsRow(restaurantId)).toEqual({ taxMode: null, defaultTaxRateId: null });
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	// MANDATORY (spec 29 — tax): the typed percent becomes integer basis points.
	it('stores 8.25 as 825 basis points', async () => {
		const { restaurantId, owner } = await owned();
		const versionBefore = await getMenuVersion(db, restaurantId);

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'VAT'],
				['percent', '8.25']
			])
		);

		expect(result).toEqual({ message: 'VAT added.' });
		const rows = await rateRows(restaurantId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'VAT', rateBp: 825, archivedAt: null });
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore + 1);
		expect(await eventCount(restaurantId, 'tax_rate.created')).toBe(1);
		// Not the default: a rate is never assumed (risk 5).
		expect((await settingsRow(restaurantId)).defaultTaxRateId).toBeNull();
	});

	it('stores 0 as a real 0% rate', async () => {
		const { restaurantId, owner } = await owned();

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'Exempt'],
				['percent', '0']
			])
		);

		expect(result).toEqual({ message: 'Exempt added.' });
		expect(await rateRows(restaurantId)).toMatchObject([{ name: 'Exempt', rateBp: 0 }]);
	});

	it('refuses 8.255, 101 and 5,5 with the rate message, and stores nothing', async () => {
		const { restaurantId, owner } = await owned();
		const versionBefore = await getMenuVersion(db, restaurantId);
		const auditBefore = await auditCount(restaurantId);

		for (const percent of ['8.255', '101', '5,5']) {
			const result = await action(
				'create',
				makeEvent(owner, [
					['name', 'Odd'],
					['percent', percent]
				])
			);
			expect(statusCodeOf(result), percent).toBe(400);
			expect(messageOf(result), percent).toBe(RATE_MESSAGE);
		}

		expect(await rateRows(restaurantId)).toHaveLength(0);
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('adds a rate and makes it the default in one transaction', async () => {
		const { restaurantId, owner } = await owned();
		const versionBefore = await getMenuVersion(db, restaurantId);
		const settingsUpdatedBefore = await eventCount(restaurantId, 'settings.updated');

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'Tax'],
				['percent', '10'],
				['makeDefault', 'yes']
			])
		);

		expect(result).toEqual({ message: 'Tax added and made the default rate.' });
		const rows = await rateRows(restaurantId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'Tax', rateBp: 1000 });
		expect((await settingsRow(restaurantId)).defaultTaxRateId).toBe(rows[0].id);
		// Exactly two bumps: one for the create, one for the default — both by contract.
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore + 2);
		expect(await eventCount(restaurantId, 'tax_rate.created')).toBe(1);
		expect(await eventCount(restaurantId, 'settings.updated')).toBe(settingsUpdatedBefore + 1);
	});

	it('a refused create with makeDefault writes nothing', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		await seedRate(restaurantId, ownerId, { name: 'Tax', rateBp: 1000 });
		const versionBefore = await getMenuVersion(db, restaurantId);
		const auditBefore = await auditCount(restaurantId);

		// createTaxRate refuses the duplicate before the default step runs; the
		// single transaction (Do 2) is what rolls a created rate back otherwise.
		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'Tax'],
				['percent', '5'],
				['makeDefault', 'yes']
			])
		);

		expect(statusCodeOf(result)).toBe(400);
		expect(messageOf(result)).toBe('A rate with that name already exists.');
		expect(await rateRows(restaurantId)).toHaveLength(1);
		expect((await settingsRow(restaurantId)).defaultTaxRateId).toBeNull();
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('saves the tax mode', async () => {
		const { restaurantId, owner } = await owned();
		const versionBefore = await getMenuVersion(db, restaurantId);

		const saved = await action('mode', makeEvent(owner, [['taxMode', 'inclusive']]));
		expect(saved).toEqual({ message: 'Tax mode saved.' });
		expect((await settingsRow(restaurantId)).taxMode).toBe('inclusive');
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore + 1);

		// The same mode again: nothing changed, so no second bump.
		const again = await action('mode', makeEvent(owner, [['taxMode', 'inclusive']]));
		expect(again).toEqual({ message: 'No changes to save.' });
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore + 1);

		const refused = await action('mode', makeEvent(owner, [['taxMode', 'both']]));
		expect(statusCodeOf(refused)).toBe(400);
		expect(messageOf(refused)).toBe('Choose prices exclude tax or prices include tax.');
		expect((await settingsRow(restaurantId)).taxMode).toBe('inclusive');
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore + 1);
	});

	it('switches the default, and refuses an archived rate', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const first = await seedRate(restaurantId, ownerId, {
			name: 'Tax',
			rateBp: 1000,
			makeDefault: true
		});
		const second = await seedRate(restaurantId, ownerId, { name: 'Exempt', rateBp: 0 });

		const switched = await action('setDefault', makeEvent(owner, [['taxRateId', second]]));
		expect(switched).toEqual({ message: 'Default rate saved.' });
		expect((await settingsRow(restaurantId)).defaultTaxRateId).toBe(second);

		const again = await action('setDefault', makeEvent(owner, [['taxRateId', second]]));
		expect(again).toEqual({ message: 'No changes to save.' });

		// The first rate is no longer the default and no item uses it: archive it,
		// then try to make it the default again.
		const archived = await action(
			'archive',
			makeEvent(owner, [
				['taxRateId', first],
				['name', 'Tax']
			])
		);
		expect(archived).toEqual({ message: 'Tax archived.' });

		const refused = await action('setDefault', makeEvent(owner, [['taxRateId', first]]));
		expect(statusCodeOf(refused)).toBe(400);
		expect(messageOf(refused)).toBe(DEFAULT_MESSAGE);
		expect((await settingsRow(restaurantId)).defaultTaxRateId).toBe(second);

		const malformed = await action('setDefault', makeEvent(owner, [['taxRateId', 'not-an-id']]));
		expect(statusCodeOf(malformed)).toBe(400);
		expect(messageOf(malformed)).toBe(DEFAULT_MESSAGE);
	});

	it('renames and re-rates a rate; a re-save of the same values says No changes to save. and bumps nothing', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const id = await seedRate(restaurantId, ownerId, { name: 'Tax', rateBp: 1000 });
		const versionBefore = await getMenuVersion(db, restaurantId);

		const saved = await action(
			'update',
			makeEvent(owner, [
				['taxRateId', id],
				['name', 'VAT'],
				['percent', '5']
			])
		);
		expect(saved).toEqual({ message: 'VAT saved.' });
		expect(await rateRows(restaurantId)).toMatchObject([{ id, name: 'VAT', rateBp: 500 }]);
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore + 1);
		expect(await eventCount(restaurantId, 'tax_rate.updated')).toBe(1);

		const again = await action(
			'update',
			makeEvent(owner, [
				['taxRateId', id],
				['name', 'VAT'],
				['percent', '5']
			])
		);
		expect(again).toEqual({ message: 'No changes to save.' });
		expect(await getMenuVersion(db, restaurantId)).toBe(versionBefore + 1);
		expect(await eventCount(restaurantId, 'tax_rate.updated')).toBe(1);

		// A third decimal is refused, never rounded (invariant 7).
		const refused = await action(
			'update',
			makeEvent(owner, [
				['taxRateId', id],
				['name', 'VAT'],
				['percent', '5.555']
			])
		);
		expect(statusCodeOf(refused)).toBe(400);
		expect(messageOf(refused)).toBe(RATE_MESSAGE);
		expect(await rateRows(restaurantId)).toMatchObject([{ id, name: 'VAT', rateBp: 500 }]);
	});

	it('refuses to archive the default rate, and a rate a live item uses', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const theDefault = await seedRate(restaurantId, ownerId, {
			name: 'Tax',
			rateBp: 1000,
			makeDefault: true
		});
		const used = await seedRate(restaurantId, ownerId, { name: 'Exempt', rateBp: 0 });
		await db.transaction(async (tx) => {
			const item = await createItem(tx, restaurantId, {
				name: 'Water',
				priceMinor: 100n,
				taxRateId: used
			});
			if (!item.ok) throw new Error(`createItem: ${item.reason}`);
		});

		const isDefault = await action(
			'archive',
			makeEvent(owner, [
				['taxRateId', theDefault],
				['name', 'Tax']
			])
		);
		expect(statusCodeOf(isDefault)).toBe(400);
		expect(messageOf(isDefault)).toBe(
			'This is the default rate. Make another rate the default first.'
		);

		const inUse = await action(
			'archive',
			makeEvent(owner, [
				['taxRateId', used],
				['name', 'Exempt']
			])
		);
		expect(statusCodeOf(inUse)).toBe(400);
		expect(messageOf(inUse)).toBe('Used by 1 menu item(s) — move them to another rate first.');

		// Both still live.
		expect(await rateRows(restaurantId)).toMatchObject([
			{ id: theDefault, archivedAt: null },
			{ id: used, archivedAt: null }
		]);
		expect(await eventCount(restaurantId, 'tax_rate.archived')).toBe(0);
	});

	it('archives an unused rate', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const theDefault = await seedRate(restaurantId, ownerId, {
			name: 'Tax',
			rateBp: 1000,
			makeDefault: true
		});
		const spare = await seedRate(restaurantId, ownerId, { name: 'Service', rateBp: 500 });

		const result = await action(
			'archive',
			makeEvent(owner, [
				['taxRateId', spare],
				['name', 'Service']
			])
		);
		expect(result).toEqual({ message: 'Service archived.' });
		expect(await eventCount(restaurantId, 'tax_rate.archived')).toBe(1);

		const data = (await load(loadEvent(owner))) as {
			rates: Array<{ id: string; archived: boolean; isDefault: boolean }>;
		};
		expect(data.rates.find((rate) => rate.id === spare)).toMatchObject({
			archived: true,
			isDefault: false
		});
		expect(data.rates.find((rate) => rate.id === theDefault)).toMatchObject({
			archived: false,
			isDefault: true
		});

		// Archived is archived: a second attempt says so.
		const again = await action(
			'archive',
			makeEvent(owner, [
				['taxRateId', spare],
				['name', 'Service']
			])
		);
		expect(statusCodeOf(again)).toBe(400);
		expect(messageOf(again)).toBe('That rate is archived.');
	});

	it('never touches another restaurant', async () => {
		const a = await owned('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const rateOfA = await seedRate(a.restaurantId, a.ownerId, {
			name: 'Tax',
			rateBp: 1000,
			makeDefault: true
		});
		const rateOfB = await seedRate(b, null, { name: 'Tax', rateBp: 1000, makeDefault: true });
		const auditOfBBefore = await auditCount(b);

		const update = await action(
			'update',
			makeEvent(a.owner, [
				['taxRateId', rateOfB],
				['name', 'Hijacked'],
				['percent', '99']
			])
		);
		expect(statusCodeOf(update)).toBe(400);
		expect(messageOf(update)).toBe(NOT_FOUND_MESSAGE);

		const archive = await action(
			'archive',
			makeEvent(a.owner, [
				['taxRateId', rateOfB],
				['name', 'Tax']
			])
		);
		expect(statusCodeOf(archive)).toBe(400);
		expect(messageOf(archive)).toBe(NOT_FOUND_MESSAGE);

		const setDefault = await action('setDefault', makeEvent(a.owner, [['taxRateId', rateOfB]]));
		expect(statusCodeOf(setDefault)).toBe(400);
		expect(messageOf(setDefault)).toBe(DEFAULT_MESSAGE);

		// B's rate and audit log are as they were; A's default did not move.
		expect(await rateRows(b)).toMatchObject([
			{ id: rateOfB, name: 'Tax', rateBp: 1000, archivedAt: null }
		]);
		expect(await auditCount(b)).toBe(auditOfBBefore);
		expect((await settingsRow(a.restaurantId)).defaultTaxRateId).toBe(rateOfA);
		expect((await settingsRow(b)).defaultTaxRateId).toBe(rateOfB);
	});

	it('the load sends percent strings', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const id = await seedRate(restaurantId, ownerId, {
			name: 'Tax',
			rateBp: 825,
			makeDefault: true
		});

		const data = (await load(loadEvent(owner))) as Record<string, unknown>;

		expect(Object.keys(data).sort()).toEqual(['defaultTaxRateId', 'rates', 'taxMode', 'taxModes']);
		expect(data.taxMode).toBeNull();
		expect(data.taxModes).toEqual(['exclusive', 'inclusive']);
		expect(data.defaultTaxRateId).toBe(id);
		expect(data.rates).toEqual([
			{
				id,
				name: 'Tax',
				rateBp: 825,
				percent: '8.25',
				label: 'Tax 8.25%',
				isDefault: true,
				liveItemCount: 0,
				archived: false
			}
		]);
	});
});

// A source tripwire (the /menu helpers.test.ts idiom): no floating-point step
// may appear anywhere in this route — the percent is parsed by the money module.
describe('the tax route holds no float step', () => {
	it.each(['+page.svelte', '+page.server.ts'])('%s', (file) => {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
		for (const banned of ['parseFloat', 'toFixed', 'Number(', '* 100', '/ 100']) {
			expect(source.includes(banned), `${file} contains ${banned}`).toBe(false);
		}
	});
});
