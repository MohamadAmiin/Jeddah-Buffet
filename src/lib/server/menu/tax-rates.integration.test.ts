import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { menuItems } from '../db/schema/menu';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { taxRates } from '../db/schema/tax-rates';
import { onRestaurantCreated } from '../restaurants';
import {
	archiveItem,
	archiveTaxRate,
	assertLiveTaxRate,
	createItem,
	createTaxRate,
	getMenuVersion,
	listTaxRates,
	updateTaxRate
} from './index';

// The named tax-rate catalogue (tasks/settings-tax-payments-receipt T-10): every
// write bumps the menu version exactly once and audits in the same transaction;
// every refusal writes nothing; archive, never delete.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name = 'Cafe One') {
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
			email: `owner-${restaurant.id}@cafe.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	return {
		restaurantId: restaurant.id,
		ctx: { actorUserId: owner.id, ip: null, userAgent: null },
		ownerId: owner.id
	};
}

type R = Awaited<ReturnType<typeof makeRestaurant>>;

const version = (restaurantId: string) => getMenuVersion(db, restaurantId);
const auditRows = (event: string) => db.select().from(auditLog).where(eq(auditLog.event, event));
const rateRows = (restaurantId: string) =>
	db.select().from(taxRates).where(eq(taxRates.restaurantId, restaurantId));

function create(r: R, input: { name: string; rateBp: number }) {
	return db.transaction((tx) => createTaxRate(tx, r.restaurantId, input, r.ctx));
}

async function createdId(r: R, input: { name: string; rateBp: number }): Promise<string> {
	const result = await create(r, input);
	if (!result.ok) throw new Error(`fixture rate was not created: ${result.reason}`);
	return result.id;
}

function archive(r: R, taxRateId: string) {
	return db.transaction((tx) => archiveTaxRate(tx, r.restaurantId, taxRateId, r.ctx));
}

// DIRECT test-database writes until T-13: updateSettings gains defaultTaxRateId and
// updateItem gains taxRateId there. Neither bumps the version here.
async function setDefault(restaurantId: string, taxRateId: string) {
	await db
		.update(restaurantSettings)
		.set({ defaultTaxRateId: taxRateId })
		.where(eq(restaurantSettings.restaurantId, restaurantId));
}

async function pointItemAt(restaurantId: string, itemId: string, taxRateId: string) {
	await db
		.update(menuItems)
		.set({ taxRateId })
		.where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.id, itemId)));
}

async function makeItem(r: R, name = 'Tea'): Promise<string> {
	const item = await db.transaction((tx) =>
		createItem(tx, r.restaurantId, { name, priceMinor: 850n })
	);
	if (!item.ok) throw new Error('fixture item was not created');
	return item.id;
}

describe('createTaxRate', () => {
	it('creates a trimmed rate, bumps the version once and audits it', async () => {
		const r = await makeRestaurant();
		const before = await version(r.restaurantId);

		const result = await create(r, { name: '  VAT  ', rateBp: 500 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await version(r.restaurantId)).toBe(before + 1);

		expect(await listTaxRates(db, r.restaurantId)).toEqual([
			{
				id: result.id,
				name: 'VAT',
				rateBp: 500,
				sortOrder: 0,
				archivedAt: null,
				isDefault: false,
				liveItemCount: 0
			}
		]);

		const audits = await auditRows('tax_rate.created');
		expect(audits).toHaveLength(1);
		expect(audits[0].details).toEqual({ name: 'VAT', rateBp: 500 });
		expect(audits[0].restaurantId).toBe(r.restaurantId);
		expect(audits[0].actorUserId).toBe(r.ownerId);
	});

	it('never makes the first rate the default (risk 5)', async () => {
		const r = await makeRestaurant();
		await createdId(r, { name: 'VAT', rateBp: 500 });
		const [settings] = await db
			.select({ defaultTaxRateId: restaurantSettings.defaultTaxRateId })
			.from(restaurantSettings)
			.where(eq(restaurantSettings.restaurantId, r.restaurantId));
		expect(settings.defaultTaxRateId).toBeNull();
	});

	it('accepts 0% and 100%', async () => {
		const r = await makeRestaurant();
		const exempt = await create(r, { name: 'Exempt', rateBp: 0 });
		const full = await create(r, { name: 'Full', rateBp: 10000 });
		expect(exempt.ok).toBe(true);
		expect(full.ok).toBe(true);
		const rows = await listTaxRates(db, r.restaurantId);
		expect(rows.map((row) => [row.name, row.rateBp, row.sortOrder])).toEqual([
			['Exempt', 0, 0],
			['Full', 10000, 1]
		]);
	});

	it('refuses a bad name or rate and writes nothing', async () => {
		const r = await makeRestaurant();
		const before = await version(r.restaurantId);

		for (const name of ['', '   ', 'x'.repeat(41), 'VAT\u0007']) {
			expect(await create(r, { name, rateBp: 500 })).toEqual({
				ok: false,
				reason: 'invalid_name'
			});
		}
		for (const rateBp of [-1, 10001, 8.25, Number.NaN]) {
			expect(await create(r, { name: 'VAT', rateBp })).toEqual({
				ok: false,
				reason: 'invalid_rate'
			});
		}

		expect(await version(r.restaurantId)).toBe(before);
		expect(await rateRows(r.restaurantId)).toHaveLength(0);
		expect(await auditRows('tax_rate.created')).toHaveLength(0);
	});

	it('refuses a duplicate live name, case-insensitively, and leaves the transaction usable', async () => {
		const r = await makeRestaurant();
		await createdId(r, { name: 'VAT', rateBp: 500 });
		const before = await version(r.restaurantId);

		await db.transaction(async (tx) => {
			expect(await createTaxRate(tx, r.restaurantId, { name: 'vat', rateBp: 600 }, r.ctx)).toEqual({
				ok: false,
				reason: 'duplicate_name'
			});
			// The savepoint rolled back the insert, the bump and the audit row together.
			expect(await getMenuVersion(tx, r.restaurantId)).toBe(before);
			expect(
				await tx.select().from(auditLog).where(eq(auditLog.event, 'tax_rate.created'))
			).toHaveLength(1);

			// ...and the caller's transaction is still usable.
			const reduced = await createTaxRate(
				tx,
				r.restaurantId,
				{ name: 'Reduced', rateBp: 250 },
				r.ctx
			);
			expect(reduced.ok).toBe(true);
		});

		expect(await version(r.restaurantId)).toBe(before + 1);
		expect(await auditRows('tax_rate.created')).toHaveLength(2);
		expect((await rateRows(r.restaurantId)).map((row) => row.name).sort()).toEqual([
			'Reduced',
			'VAT'
		]);
	});

	it('lets an archived name be used again', async () => {
		const r = await makeRestaurant();
		const vat = await createdId(r, { name: 'VAT', rateBp: 500 });
		expect(await archive(r, vat)).toEqual({ ok: true });

		const again = await create(r, { name: 'VAT', rateBp: 500 });
		expect(again.ok).toBe(true);
	});
});

describe('updateTaxRate', () => {
	it('is a no-op for the same name and rate: no bump, no audit row', async () => {
		const r = await makeRestaurant();
		const vat = await createdId(r, { name: 'VAT', rateBp: 500 });
		const before = await version(r.restaurantId);

		const result = await db.transaction((tx) =>
			updateTaxRate(tx, r.restaurantId, vat, { name: 'VAT', rateBp: 500 }, r.ctx)
		);
		expect(result).toEqual({ ok: true, changed: false });
		expect(await version(r.restaurantId)).toBe(before);
		expect(await auditRows('tax_rate.updated')).toHaveLength(0);
	});

	it('renames and re-rates in ONE bump and ONE audit row', async () => {
		const r = await makeRestaurant();
		const vat = await createdId(r, { name: 'VAT', rateBp: 500 });
		const before = await version(r.restaurantId);

		const result = await db.transaction((tx) =>
			updateTaxRate(tx, r.restaurantId, vat, { name: 'Sales tax', rateBp: 600 }, r.ctx)
		);
		expect(result).toEqual({ ok: true, changed: true });
		expect(await version(r.restaurantId)).toBe(before + 1);

		const audits = await auditRows('tax_rate.updated');
		expect(audits).toHaveLength(1);
		expect(audits[0].details).toEqual({
			changes: {
				name: { old: 'VAT', new: 'Sales tax' },
				rateBp: { old: 500, new: 600 }
			}
		});

		const [row] = await listTaxRates(db, r.restaurantId);
		expect(row).toMatchObject({ id: vat, name: 'Sales tax', rateBp: 600 });
	});

	it('allows re-rating the default', async () => {
		const r = await makeRestaurant();
		const vat = await createdId(r, { name: 'VAT', rateBp: 500 });
		await setDefault(r.restaurantId, vat);
		const result = await db.transaction((tx) =>
			updateTaxRate(tx, r.restaurantId, vat, { rateBp: 700 }, r.ctx)
		);
		expect(result).toEqual({ ok: true, changed: true });
	});

	it('refuses an archived, foreign, malformed, invalid or duplicate target', async () => {
		const a = await makeRestaurant('A');
		const b = await makeRestaurant('B');
		const archived = await createdId(a, { name: 'Old', rateBp: 100 });
		expect(await archive(a, archived)).toEqual({ ok: true });
		const vat = await createdId(a, { name: 'VAT', rateBp: 500 });
		const reduced = await createdId(a, { name: 'Reduced', rateBp: 250 });
		const foreign = await createdId(b, { name: 'B rate', rateBp: 900 });
		const beforeA = await version(a.restaurantId);
		const beforeB = await version(b.restaurantId);

		await db.transaction(async (tx) => {
			const update = (id: string, changes: { name?: string; rateBp?: number }) =>
				updateTaxRate(tx, a.restaurantId, id, changes, a.ctx);

			expect(await update(archived, { name: 'Older' })).toEqual({
				ok: false,
				reason: 'archived'
			});
			expect(await update(foreign, { name: 'Mine now' })).toEqual({
				ok: false,
				reason: 'not_found'
			});
			expect(await update('not-a-uuid', { name: 'X' })).toEqual({
				ok: false,
				reason: 'not_found'
			});
			expect(await update(vat, { name: 'VAT\u001b' })).toEqual({
				ok: false,
				reason: 'invalid_name'
			});
			expect(await update(vat, { rateBp: 10001 })).toEqual({ ok: false, reason: 'invalid_rate' });
			expect(await update(reduced, { name: 'vat' })).toEqual({
				ok: false,
				reason: 'duplicate_name'
			});

			// No SQL error escaped: the transaction is still usable.
			expect(await getMenuVersion(tx, a.restaurantId)).toBe(beforeA);
		});

		expect(await version(a.restaurantId)).toBe(beforeA);
		expect(await version(b.restaurantId)).toBe(beforeB);
		expect(await auditRows('tax_rate.updated')).toHaveLength(0);
		const [bRow] = await listTaxRates(db, b.restaurantId);
		expect(bRow).toMatchObject({ id: foreign, name: 'B rate', rateBp: 900 });
	});
});

describe('archiveTaxRate', () => {
	it("refuses another restaurant's rate and a malformed id, writing nothing", async () => {
		const a = await makeRestaurant('A');
		const b = await makeRestaurant('B');
		const foreign = await createdId(b, { name: 'B rate', rateBp: 900 });
		const beforeA = await version(a.restaurantId);
		const beforeB = await version(b.restaurantId);

		expect(await archive(a, foreign)).toEqual({ ok: false, reason: 'not_found' });

		await db.transaction(async (tx) => {
			expect(await archiveTaxRate(tx, a.restaurantId, 'not-a-uuid', a.ctx)).toEqual({
				ok: false,
				reason: 'not_found'
			});
			// A following statement in the same transaction succeeds.
			const next = await createTaxRate(tx, a.restaurantId, { name: 'VAT', rateBp: 500 }, a.ctx);
			expect(next.ok).toBe(true);
		});

		const [bRow] = await listTaxRates(db, b.restaurantId);
		expect(bRow).toMatchObject({ id: foreign, archivedAt: null });
		expect(await version(a.restaurantId)).toBe(beforeA + 1); // the VAT create only
		expect(await version(b.restaurantId)).toBe(beforeB);
		expect(await auditRows('tax_rate.archived')).toHaveLength(0);
	});

	it('refuses the default, with no bump', async () => {
		const r = await makeRestaurant();
		const vat = await createdId(r, { name: 'VAT', rateBp: 500 });
		await setDefault(r.restaurantId, vat);
		const before = await version(r.restaurantId);

		expect(await archive(r, vat)).toEqual({ ok: false, reason: 'is_default' });
		expect(await version(r.restaurantId)).toBe(before);
		expect(await auditRows('tax_rate.archived')).toHaveLength(0);

		const [row] = await listTaxRates(db, r.restaurantId);
		expect(row.isDefault).toBe(true);
	});

	it('refuses a rate a LIVE item uses; an archived item does not block it', async () => {
		const r = await makeRestaurant();
		const special = await createdId(r, { name: 'Special', rateBp: 1500 });
		const itemId = await makeItem(r, 'Wine');
		await pointItemAt(r.restaurantId, itemId, special);
		// An item that INHERITS the default (tax_rate_id NULL) is not counted.
		await makeItem(r, 'Tea');
		const before = await version(r.restaurantId);

		expect((await listTaxRates(db, r.restaurantId))[0].liveItemCount).toBe(1);
		expect(await archive(r, special)).toEqual({
			ok: false,
			reason: 'in_use',
			liveItemCount: 1
		});
		expect(await version(r.restaurantId)).toBe(before);

		await db.transaction((tx) => archiveItem(tx, r.restaurantId, itemId));
		expect((await listTaxRates(db, r.restaurantId))[0].liveItemCount).toBe(0);
		expect(await archive(r, special)).toEqual({ ok: true });
	});

	it('archives: one bump, one audit row, listed last; a second archive is refused', async () => {
		const r = await makeRestaurant();
		const old = await createdId(r, { name: 'Old', rateBp: 100 });
		await createdId(r, { name: 'VAT', rateBp: 500 });
		const before = await version(r.restaurantId);

		expect(await archive(r, old)).toEqual({ ok: true });
		expect(await version(r.restaurantId)).toBe(before + 1);

		const audits = await auditRows('tax_rate.archived');
		expect(audits).toHaveLength(1);
		expect(audits[0].details).toEqual({ name: 'Old', rateBp: 100 });

		const rows = await listTaxRates(db, r.restaurantId);
		expect(rows.map((row) => row.name)).toEqual(['VAT', 'Old']);
		expect(rows[1].archivedAt).toBeInstanceOf(Date);

		expect(await archive(r, old)).toEqual({ ok: false, reason: 'already_archived' });
		expect(await version(r.restaurantId)).toBe(before + 1);
		expect(await auditRows('tax_rate.archived')).toHaveLength(1);
	});
});

describe('assertLiveTaxRate', () => {
	it('returns a live rate and null for an archived, foreign or malformed one', async () => {
		const a = await makeRestaurant('A');
		const b = await makeRestaurant('B');
		const vat = await createdId(a, { name: 'VAT', rateBp: 500 });
		const old = await createdId(a, { name: 'Old', rateBp: 100 });
		expect(await archive(a, old)).toEqual({ ok: true });
		const foreign = await createdId(b, { name: 'B rate', rateBp: 900 });

		await db.transaction(async (tx) => {
			expect(await assertLiveTaxRate(tx, a.restaurantId, vat)).toEqual({
				id: vat,
				name: 'VAT',
				rateBp: 500
			});
			expect(await assertLiveTaxRate(tx, a.restaurantId, old)).toBeNull();
			expect(await assertLiveTaxRate(tx, a.restaurantId, foreign)).toBeNull();
			expect(await assertLiveTaxRate(tx, a.restaurantId, 'nope')).toBeNull();
			// The malformed id ran no query: the transaction is still usable.
			expect(await assertLiveTaxRate(tx, a.restaurantId, vat)).not.toBeNull();
		});
	});
});

describe('listTaxRates order', () => {
	it('lists live rates by sort_order then name, then archived rates the same way', async () => {
		const r = await makeRestaurant();
		const zed = await createdId(r, { name: 'Zed', rateBp: 100 }); // sort 0
		const mid = await createdId(r, { name: 'Mid', rateBp: 200 }); // sort 1
		await createdId(r, { name: 'Beta', rateBp: 300 }); // sort 2
		const alpha = await createdId(r, { name: 'Alpha', rateBp: 400 }); // sort 3
		await createdId(r, { name: 'Extra', rateBp: 500 }); // sort 4
		// A tie on sort_order is broken by name (no writer sets sort_order yet).
		await db.update(taxRates).set({ sortOrder: 2 }).where(eq(taxRates.id, alpha));
		expect(await archive(r, mid)).toEqual({ ok: true });
		expect(await archive(r, zed)).toEqual({ ok: true });

		// The next live rate takes max(live sort_order) + 1 = 5.
		await createdId(r, { name: 'Last', rateBp: 600 });

		const rows = await listTaxRates(db, r.restaurantId);
		expect(rows.map((row) => [row.name, row.sortOrder, row.archivedAt === null])).toEqual([
			['Alpha', 2, true],
			['Beta', 2, true],
			['Extra', 4, true],
			['Last', 5, true],
			['Zed', 0, false],
			['Mid', 1, false]
		]);
	});
});

describe('the module surface', () => {
	it('has no delete path', async () => {
		const names = Object.keys(await import('./tax-rates'));
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((name) => /delete|remove/i.test(name))).toEqual([]);
	});

	it('does not re-export the version helper from index.ts', async () => {
		expect(Object.keys(await import('./index'))).not.toContain('withMenuVersionBump');
	});
});
