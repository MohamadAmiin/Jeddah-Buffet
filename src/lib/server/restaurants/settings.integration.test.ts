import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { auditLog } from '../db/schema/audit';
import {
	getRestaurantWithSettings,
	updateSettings,
	settingsComplete,
	onRestaurantCreated,
	canonicalTimeZone
} from './index';
import { exact, minor } from '../../money';
import { taxOnLine } from '../../money/tax';

const db = testDb();
const ctx = { actorUserId: null, ip: null, userAgent: null };

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(name = 'Cafe One', timeZone = 'Africa/Mogadishu'): Promise<string> {
	const [row] = await db.insert(restaurants).values({ name }).returning();
	// Registration runs in ONE transaction, so the initializers do too.
	await db.transaction((tx) => onRestaurantCreated(tx, row.id, { restaurantName: name, timeZone }));
	return row.id;
}

describe('getRestaurantWithSettings', () => {
	it('returns the name, time zone and creation date', async () => {
		const id = await makeRestaurant('Cafe One', 'Asia/Riyadh');
		const found = await getRestaurantWithSettings(db, id);
		expect(found).not.toBeNull();
		expect(found!.name).toBe('Cafe One');
		expect(found!.timeZone).toBe('Asia/Riyadh');
		expect(found!.createdAt).toBeInstanceOf(Date);
	});

	it('returns null for an unknown restaurant', async () => {
		expect(await getRestaurantWithSettings(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
	});
});

describe('updateSettings', () => {
	it('writes ONE audit row carrying the old and new name', async () => {
		const id = await makeRestaurant('Old Name');

		const result = await db.transaction((tx) => updateSettings(tx, id, { name: 'New Name' }, ctx));
		expect(result).toEqual({
			ok: true,
			changed: true,
			changes: { name: { old: 'Old Name', new: 'New Name' } }
		});

		const rows = await db.select().from(auditLog);
		expect(rows).toHaveLength(1);
		expect(rows[0].event).toBe('settings.updated');
		expect(rows[0].details).toEqual({ changes: { name: { old: 'Old Name', new: 'New Name' } } });

		const after = await getRestaurantWithSettings(db, id);
		expect(after!.name).toBe('New Name');
	});

	it('writes NO audit row when nothing actually changed', async () => {
		const id = await makeRestaurant('Same Name', 'Asia/Riyadh');

		const result = await db.transaction((tx) =>
			updateSettings(tx, id, { name: 'Same Name', timeZone: 'Asia/Riyadh' }, ctx)
		);
		expect(result).toEqual({ ok: true, changed: false });
		expect(await db.select().from(auditLog)).toHaveLength(0);
	});

	it('rejects an invalid time zone and writes nothing', async () => {
		const id = await makeRestaurant('Cafe One', 'Asia/Riyadh');

		const result = await db.transaction((tx) =>
			updateSettings(tx, id, { name: 'Changed Too', timeZone: 'Not/AZone' }, ctx)
		);
		expect(result).toEqual({ ok: false, reason: 'invalid_time_zone' });

		// The name change must NOT have landed either.
		const after = await getRestaurantWithSettings(db, id);
		expect(after!.name).toBe('Cafe One');
		expect(after!.timeZone).toBe('Asia/Riyadh');
		expect(await db.select().from(auditLog)).toHaveLength(0);
	});

	it('stores an alias time zone in its canonical form', async () => {
		const id = await makeRestaurant('Cafe One', 'UTC');

		await db.transaction((tx) => updateSettings(tx, id, { timeZone: 'Asia/Calcutta' }, ctx));

		const [row] = await db
			.select()
			.from(restaurantSettings)
			.where(eq(restaurantSettings.restaurantId, id));
		// Assert the CANONICAL form, not a hardcoded spelling: which of
		// Asia/Calcutta and Asia/Kolkata is canonical depends on the ICU version,
		// which is exactly why the validator works by construction.
		expect(row.timeZone).toBe(canonicalTimeZone('Asia/Calcutta'));
		expect(row.timeZone).toBe(canonicalTimeZone('Asia/Kolkata'));
	});

	it('accepts UTC, which a list-membership validator would have rejected', async () => {
		const id = await makeRestaurant('Cafe One', 'Asia/Riyadh');
		const result = await db.transaction((tx) => updateSettings(tx, id, { timeZone: 'UTC' }, ctx));
		expect(result.ok).toBe(true);
		const after = await getRestaurantWithSettings(db, id);
		expect(after!.timeZone).toBe('UTC');
	});

	// THE LOAD-BEARING CASE. Every later module's tests should copy it: explicit
	// tenant scoping is only real if crossing it does nothing.
	it('cannot read or update another restaurant’s settings', async () => {
		const a = await makeRestaurant('Restaurant A', 'Asia/Riyadh');
		const b = await makeRestaurant('Restaurant B', 'UTC');

		// A caller holding B's id sees B, never A.
		const seen = await getRestaurantWithSettings(db, b);
		expect(seen!.name).toBe('Restaurant B');
		expect(seen!.name).not.toBe('Restaurant A');

		// Updating with B's id must leave A untouched.
		await db.transaction((tx) => updateSettings(tx, b, { name: 'B Renamed' }, ctx));

		const aAfter = await getRestaurantWithSettings(db, a);
		expect(aAfter!.name).toBe('Restaurant A');
		expect(aAfter!.timeZone).toBe('Asia/Riyadh');

		// And the audit row belongs to B.
		const rows = await db.select().from(auditLog);
		expect(rows).toHaveLength(1);
		expect(rows[0].restaurantId).toBe(b);
	});

	it('rolls the settings change back with its audit row', async () => {
		const id = await makeRestaurant('Original');

		await expect(
			db.transaction(async (tx) => {
				await updateSettings(tx, id, { name: 'Doomed' }, ctx);
				throw new Error('the surrounding action failed');
			})
		).rejects.toThrow('the surrounding action failed');

		const after = await getRestaurantWithSettings(db, id);
		expect(after!.name).toBe('Original');
		expect(await db.select().from(auditLog)).toHaveLength(0);
	});
});

describe('settingsComplete', () => {
	// Registration sets the name and time zone and nothing else — there is no default
	// for the idle lock, the tax mode, the tax rate or the currency anywhere — so a
	// fresh restaurant is incomplete for exactly those four reasons, in this order.
	// T-08 added the first; T-36 APPENDED the other three.
	it('is incomplete straight after registration, missing the idle lock, tax and currency', async () => {
		const id = await makeRestaurant();
		expect(await settingsComplete(db, id)).toEqual({
			complete: false,
			missing: ['POS idle lock', 'tax mode', 'tax rate', 'currency']
		});
	});

	it('is complete once all four are chosen', async () => {
		const id = await makeRestaurant();
		const result = await db.transaction((tx) =>
			updateSettings(
				tx,
				id,
				{ taxMode: 'inclusive', taxRateBp: 825, currencyCode: 'USD', posIdleLockSeconds: 120 },
				ctx
			)
		);
		expect(result.ok).toBe(true);
		expect(await settingsComplete(db, id)).toEqual({ complete: true, missing: [] });
	});

	it('stays incomplete with only the three new settings chosen: the idle lock is still missing', async () => {
		const id = await makeRestaurant();
		await db.transaction((tx) =>
			updateSettings(tx, id, { taxMode: 'exclusive', taxRateBp: 825, currencyCode: 'USD' }, ctx)
		);
		expect(await settingsComplete(db, id)).toEqual({
			complete: false,
			missing: ['POS idle lock']
		});
	});

	it('reports a restaurant with no settings row as incomplete', async () => {
		const [row] = await db.insert(restaurants).values({ name: 'No Settings' }).returning();
		const result = await settingsComplete(db, row.id);
		expect(result.complete).toBe(false);
		expect(result.missing.length).toBeGreaterThan(0);
	});
});

describe('the POS idle lock setting (T-08)', () => {
	it('is written by updateSettings with ONE audit row, and leaves the missing list', async () => {
		const id = await makeRestaurant();

		const result = await db.transaction((tx) =>
			updateSettings(tx, id, { posIdleLockSeconds: 120 }, ctx)
		);
		expect(result).toEqual({
			ok: true,
			changed: true,
			changes: { posIdleLockSeconds: { old: null, new: 120 } }
		});
		// The idle lock has left the list; the three T-36 settings are still unchosen.
		expect(await settingsComplete(db, id)).toEqual({
			complete: false,
			missing: ['tax mode', 'tax rate', 'currency']
		});

		const rows = await db.select().from(auditLog);
		expect(rows).toHaveLength(1);
		expect(rows[0].event).toBe('settings.updated');
		expect(rows[0].details).toEqual({ changes: { posIdleLockSeconds: { old: null, new: 120 } } });
		expect((await getRestaurantWithSettings(db, id))!.posIdleLockSeconds).toBe(120);
	});

	// The mirror failure of the widened update: an idle-lock-only save must not
	// blank the time zone, which decides every sale's business date.
	it('leaves the time zone alone when only the idle lock changes', async () => {
		const id = await makeRestaurant('Cafe One', 'Asia/Riyadh');
		await db.transaction((tx) => updateSettings(tx, id, { posIdleLockSeconds: 300 }, ctx));

		const after = await getRestaurantWithSettings(db, id);
		expect(after!.timeZone).toBe('Asia/Riyadh');
		expect(after!.posIdleLockSeconds).toBe(300);
	});

	it.each([29, 1801, 90.5])('rejects %s seconds and writes nothing', async (seconds) => {
		const id = await makeRestaurant();

		const result = await db.transaction((tx) =>
			updateSettings(tx, id, { posIdleLockSeconds: seconds }, ctx)
		);
		expect(result).toEqual({ ok: false, reason: 'invalid_idle_lock' });
		expect(await db.select().from(auditLog)).toHaveLength(0);
		expect((await getRestaurantWithSettings(db, id))!.posIdleLockSeconds).toBeNull();
	});

	it('accepts both ends of the bound, 30 and 1800 seconds', async () => {
		const id = await makeRestaurant();
		expect(
			(await db.transaction((tx) => updateSettings(tx, id, { posIdleLockSeconds: 30 }, ctx))).ok
		).toBe(true);
		expect(
			(await db.transaction((tx) => updateSettings(tx, id, { posIdleLockSeconds: 1800 }, ctx))).ok
		).toBe(true);
		expect((await getRestaurantWithSettings(db, id))!.posIdleLockSeconds).toBe(1800);
	});

	it('treats re-submitting the stored value as a no-op with no audit row', async () => {
		const id = await makeRestaurant();
		await db.transaction((tx) => updateSettings(tx, id, { posIdleLockSeconds: 120 }, ctx));

		const again = await db.transaction((tx) =>
			updateSettings(tx, id, { posIdleLockSeconds: 120 }, ctx)
		);
		expect(again).toEqual({ ok: true, changed: false });
		expect(await db.select().from(auditLog)).toHaveLength(1);
	});
});

describe('the tax and currency settings (T-36)', () => {
	// MANDATORY (spec 29 — tax in BOTH modes): the mode genuinely travels from the
	// database into the calculation, and nothing in the path defaults it.
	it('carries each tax mode from the database into taxOnLine', async () => {
		const exclusiveId = await makeRestaurant('Exclusive Cafe');
		const inclusiveId = await makeRestaurant('Inclusive Cafe');
		await db.transaction((tx) =>
			updateSettings(tx, exclusiveId, { taxMode: 'exclusive', taxRateBp: 825 }, ctx)
		);
		await db.transaction((tx) =>
			updateSettings(tx, inclusiveId, { taxMode: 'inclusive', taxRateBp: 825 }, ctx)
		);

		const exclusive = (await getRestaurantWithSettings(db, exclusiveId))!;
		const inclusive = (await getRestaurantWithSettings(db, inclusiveId))!;
		expect(exclusive.taxMode).toBe('exclusive');
		expect(inclusive.taxMode).toBe('inclusive');

		// Exclusive: 1000 is the net and 82.5 goes on top.
		expect(taxOnLine(minor(1000n), exclusive.taxRateBp!, exclusive.taxMode!)).toEqual({
			net: exact(1000n),
			tax: exact(825000n, 10000n),
			gross: exact(10825000n, 10000n)
		});
		// Inclusive: 1000 already contains the tax.
		expect(taxOnLine(minor(1000n), inclusive.taxRateBp!, inclusive.taxMode!)).toEqual({
			net: exact(10000000n, 10825n),
			tax: exact(825000n, 10825n),
			gross: exact(1000n)
		});
	});

	it('writes ONE audit row carrying the old and new tax mode', async () => {
		const id = await makeRestaurant();

		await db.transaction((tx) => updateSettings(tx, id, { taxMode: 'exclusive' }, ctx));

		const rows = await db.select().from(auditLog);
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			changes: { taxMode: { old: null, new: 'exclusive' } }
		});
	});

	it('refuses a fractional tax rate and writes nothing — neither the column nor an audit row', async () => {
		const id = await makeRestaurant();

		const result = await db.transaction((tx) => updateSettings(tx, id, { taxRateBp: 8.25 }, ctx));

		expect(result).toEqual({ ok: false, reason: 'invalid_tax_rate' });
		expect(await db.select().from(auditLog)).toHaveLength(0);
		expect((await getRestaurantWithSettings(db, id))!.taxRateBp).toBeNull();
	});

	it.each([
		[{ taxMode: 'included' }, 'invalid_tax_mode'],
		[{ taxRateBp: -1 }, 'invalid_tax_rate'],
		[{ taxRateBp: 10_001 }, 'invalid_tax_rate'],
		[{ currencyCode: 'SOS' }, 'invalid_currency'],
		[{ currencyCode: 'usd' }, 'invalid_currency']
	] as const)('refuses %j with %s and writes nothing', async (changes, reason) => {
		const id = await makeRestaurant();

		const result = await db.transaction((tx) => updateSettings(tx, id, changes, ctx));

		expect(result).toEqual({ ok: false, reason });
		expect(await db.select().from(auditLog)).toHaveLength(0);
	});

	it('writes all three and a rename in ONE row of the settings table and ONE audit row', async () => {
		const id = await makeRestaurant('Old Name');

		await db.transaction((tx) =>
			updateSettings(
				tx,
				id,
				{ name: 'New Name', taxMode: 'exclusive', taxRateBp: 825, currencyCode: 'USD' },
				ctx
			)
		);

		const after = (await getRestaurantWithSettings(db, id))!;
		expect([after.name, after.taxMode, after.taxRateBp, after.currencyCode]).toEqual([
			'New Name',
			'exclusive',
			825,
			'USD'
		]);
		expect(after.timeZone).toBe('Africa/Mogadishu');
		const rows = await db.select().from(auditLog);
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			changes: {
				name: { old: 'Old Name', new: 'New Name' },
				taxMode: { old: null, new: 'exclusive' },
				taxRateBp: { old: null, new: 825 },
				currencyCode: { old: null, new: 'USD' }
			}
		});
	});
});

describe('onRestaurantCreated', () => {
	it('inserts the settings row with the canonical time zone', async () => {
		const [row] = await db.insert(restaurants).values({ name: 'Cafe' }).returning();
		await db.transaction((tx) =>
			onRestaurantCreated(tx, row.id, { restaurantName: 'Cafe', timeZone: 'Asia/Calcutta' })
		);

		const [settings] = await db
			.select()
			.from(restaurantSettings)
			.where(eq(restaurantSettings.restaurantId, row.id));
		expect(settings.timeZone).toBe(canonicalTimeZone('Asia/Calcutta'));
	});
});
