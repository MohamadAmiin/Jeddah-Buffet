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
	// Registration sets the name and time zone but leaves the POS idle lock null —
	// there is no default for it anywhere — so a fresh restaurant is incomplete for
	// exactly that one reason.
	it('is incomplete straight after registration, missing only the POS idle lock', async () => {
		const id = await makeRestaurant();
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
	it('is written by updateSettings with ONE audit row, and completes the settings', async () => {
		const id = await makeRestaurant();

		const result = await db.transaction((tx) =>
			updateSettings(tx, id, { posIdleLockSeconds: 120 }, ctx)
		);
		expect(result).toEqual({
			ok: true,
			changed: true,
			changes: { posIdleLockSeconds: { old: null, new: 120 } }
		});
		expect(await settingsComplete(db, id)).toEqual({ complete: true, missing: [] });

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
