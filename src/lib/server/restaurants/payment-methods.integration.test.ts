import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { paymentMethods } from '../db/schema/payment-methods';
import { registerRestaurant } from '../auth/register';
import { getMenuVersion } from '../menu';
import {
	archivePaymentMethod,
	createPaymentMethod,
	ensureCashMethod,
	listPaymentMethods,
	movePaymentMethod,
	onRestaurantCreated,
	updatePaymentMethod
} from './index';

// The payment-method catalogue (tasks/settings-tax-payments-receipt T-11): a
// built-in Cash row seeded at registration; owners add 'card' or 'mobile' methods
// only; the kind never changes; archive, never delete; every change audits in the
// same transaction and none of them touches the menu version.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/** Every restaurant the running case made, with its menu version once it existed. */
const made: Array<{ restaurantId: string; version: number }> = [];

// NO VERSION BUMP — the plan's "getMenuVersion is unchanged after every write
// above", checked after EVERY case for EVERY restaurant the case made (a second
// restaurant B included): no write in this module bumps the menu version, because
// methods are not in the menu snapshot. menu_version only ever increases, so an
// unchanged version at the end of a case means no write in it bumped. A failed
// expect here fails the case it follows, and it runs before the setup file's
// next reset, while the rows still exist.
afterEach(async () => {
	for (const r of made.splice(0)) {
		expect(await getMenuVersion(db, r.restaurantId), 'menu version').toBe(r.version);
	}
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
	const r = {
		restaurantId: restaurant.id,
		ctx: { actorUserId: owner.id, ip: null, userAgent: null },
		version: await getMenuVersion(db, restaurant.id)
	};
	made.push(r);
	return r;
}

type R = Awaited<ReturnType<typeof makeRestaurant>>;
type CreateInput = Parameters<typeof createPaymentMethod>[2];

const auditRows = (event: string) =>
	db.select().from(auditLog).where(eq(auditLog.event, event)).orderBy(asc(auditLog.id));
const methodRows = (restaurantId: string) =>
	db
		.select()
		.from(paymentMethods)
		.where(eq(paymentMethods.restaurantId, restaurantId))
		.orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));

function create(r: R, input: Partial<CreateInput> & { name: string }) {
	return db.transaction((tx) =>
		createPaymentMethod(
			tx,
			r.restaurantId,
			{ kind: 'mobile', merchantNumber: null, enabled: true, ...input },
			r.ctx
		)
	);
}

async function createdId(r: R, input: Partial<CreateInput> & { name: string }): Promise<string> {
	const result = await create(r, input);
	if (!result.ok) throw new Error(`fixture method was not created: ${result.reason}`);
	return result.id;
}

async function cashId(restaurantId: string): Promise<string> {
	const [row] = await db
		.select({ id: paymentMethods.id })
		.from(paymentMethods)
		.where(and(eq(paymentMethods.restaurantId, restaurantId), eq(paymentMethods.kind, 'cash')));
	return row.id;
}

const update = (r: R, id: string, changes: Parameters<typeof updatePaymentMethod>[3]) =>
	db.transaction((tx) => updatePaymentMethod(tx, r.restaurantId, id, changes, r.ctx));
const move = (r: R, id: string, direction: 'up' | 'down') =>
	db.transaction((tx) => movePaymentMethod(tx, r.restaurantId, id, direction, r.ctx));
const archive = (r: R, id: string) =>
	db.transaction((tx) => archivePaymentMethod(tx, r.restaurantId, id, r.ctx));

/** The live owner methods in list order, as `name:sortOrder`. */
async function ownerOrder(r: R): Promise<string[]> {
	return (await listPaymentMethods(db, r.restaurantId))
		.filter((m) => m.kind !== 'cash')
		.map((m) => `${m.name}:${m.sortOrder}`);
}

describe('the built-in Cash row', () => {
	it('registration seeds exactly one Cash row', async () => {
		const result = await registerRestaurant(
			db,
			{
				restaurantName: 'Cafe Cash',
				timeZone: 'UTC',
				ownerDisplayName: 'The Owner',
				email: 'cash-owner@cafe.com',
				password: 'a strong enough password'
			},
			{ mode: 'operator', ip: null, userAgent: 'test' }
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				name: paymentMethods.name,
				kind: paymentMethods.kind,
				enabled: paymentMethods.enabled,
				sortOrder: paymentMethods.sortOrder,
				merchantNumber: paymentMethods.merchantNumber,
				archivedAt: paymentMethods.archivedAt
			})
			.from(paymentMethods)
			.where(eq(paymentMethods.restaurantId, result.restaurantId));
		expect(rows).toEqual([
			{
				name: 'Cash',
				kind: 'cash',
				enabled: true,
				sortOrder: 0,
				merchantNumber: null,
				archivedAt: null
			}
		]);
	});

	it('ensureCashMethod is idempotent', async () => {
		const r = await makeRestaurant();
		await db.transaction((tx) => ensureCashMethod(tx, r.restaurantId));
		await db.transaction((tx) => ensureCashMethod(tx, r.restaurantId));

		const cash = (await methodRows(r.restaurantId)).filter((m) => m.kind === 'cash');
		expect(cash).toHaveLength(1);
		expect(await auditRows('payment_method.created')).toHaveLength(0);
	});
});

describe('createPaymentMethod', () => {
	it('stores a trimmed merchant number after Cash, and audits it', async () => {
		const r = await makeRestaurant();
		const evc = await create(r, {
			name: 'EVC Plus',
			kind: 'mobile',
			merchantNumber: '  61 234 5678 ',
			enabled: true
		});
		expect(evc.ok).toBe(true);
		if (!evc.ok) return;

		const [row] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, evc.id));
		expect(row).toMatchObject({
			name: 'EVC Plus',
			kind: 'mobile',
			merchantNumber: '61 234 5678',
			enabled: true,
			sortOrder: 1,
			archivedAt: null
		});

		const created = await auditRows('payment_method.created');
		expect(created).toHaveLength(1);
		expect(created[0].restaurantId).toBe(r.restaurantId);
		expect(created[0].actorUserId).toBe(r.ctx.actorUserId);
		expect(created[0].details).toEqual({
			name: 'EVC Plus',
			kind: 'mobile',
			merchantNumber: '61 234 5678'
		});

		const zaad = await createdId(r, { name: 'Zaad' });
		const card = await createdId(r, { name: 'Card terminal', kind: 'card', merchantNumber: '' });
		const rows = await db
			.select({
				id: paymentMethods.id,
				sortOrder: paymentMethods.sortOrder,
				merchantNumber: paymentMethods.merchantNumber
			})
			.from(paymentMethods)
			.where(eq(paymentMethods.restaurantId, r.restaurantId));
		const byId = new Map(rows.map((x) => [x.id, x]));
		expect(byId.get(zaad)!.sortOrder).toBe(2);
		expect(byId.get(card)!).toMatchObject({ sortOrder: 3, merchantNumber: null });
	});

	it('refuses a cash or unknown kind and writes nothing', async () => {
		const r = await makeRestaurant();
		for (const kind of ['cash', 'bank']) {
			expect(await create(r, { name: 'Till money', kind: kind as never })).toEqual({
				ok: false,
				reason: 'invalid_kind'
			});
		}
		expect(await methodRows(r.restaurantId)).toHaveLength(1);
		expect(await auditRows('payment_method.created')).toHaveLength(0);
	});

	it('refuses a bad name or number and writes nothing', async () => {
		const r = await makeRestaurant();
		for (const name of ['', '   ', 'x'.repeat(41), 'EVC\u001b']) {
			expect(await create(r, { name })).toEqual({ ok: false, reason: 'invalid_name' });
		}
		for (const merchantNumber of ['6'.repeat(41), '61\n23']) {
			expect(await create(r, { name: 'Zaad', merchantNumber })).toEqual({
				ok: false,
				reason: 'invalid_number'
			});
		}
		expect(await methodRows(r.restaurantId)).toHaveLength(1);
		expect(await auditRows('payment_method.created')).toHaveLength(0);
	});

	it('throws on a non-boolean enabled (a programming error)', async () => {
		const r = await makeRestaurant();
		await expect(create(r, { name: 'Zaad', enabled: 'yes' as never })).rejects.toThrow(TypeError);
		expect(await methodRows(r.restaurantId)).toHaveLength(1);
	});

	it('refuses a live duplicate name in any case, Cash included, and keeps the transaction usable', async () => {
		const r = await makeRestaurant();
		const evc = await createdId(r, { name: 'EVC Plus' });

		await db.transaction(async (tx) => {
			const base = { kind: 'mobile' as const, merchantNumber: null, enabled: true };
			expect(
				await createPaymentMethod(tx, r.restaurantId, { ...base, name: 'evc plus' }, r.ctx)
			).toEqual({ ok: false, reason: 'duplicate_name' });
			expect(
				await createPaymentMethod(tx, r.restaurantId, { ...base, name: 'CASH' }, r.ctx)
			).toEqual({ ok: false, reason: 'duplicate_name' });
			// The savepoint kept the caller's transaction usable.
			const edahab = await createPaymentMethod(
				tx,
				r.restaurantId,
				{ ...base, name: 'eDahab' },
				r.ctx
			);
			expect(edahab.ok).toBe(true);
		});
		expect(await auditRows('payment_method.created')).toHaveLength(2);

		expect(await archive(r, evc)).toEqual({ ok: true });
		const again = await create(r, { name: 'EVC Plus' });
		expect(again.ok).toBe(true);
	});
});

describe('updatePaymentMethod', () => {
	it('changes the number, enabled and the name in ONE audited write; the same values are a no-op', async () => {
		const r = await makeRestaurant();
		const id = await createdId(r, { name: 'EVC Plus', merchantNumber: '611111111' });

		expect(
			await update(r, id, { name: ' Hormuud EVC ', merchantNumber: '612222222', enabled: false })
		).toEqual({ ok: true, changed: true });

		const [row] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
		expect(row).toMatchObject({
			name: 'Hormuud EVC',
			kind: 'mobile',
			merchantNumber: '612222222',
			enabled: false
		});

		const updated = await auditRows('payment_method.updated');
		expect(updated).toHaveLength(1);
		const details = updated[0].details as { changes: Record<string, unknown> };
		expect(Object.keys(details.changes).sort()).toEqual(['enabled', 'merchantNumber', 'name']);
		expect(details.changes).toEqual({
			name: { old: 'EVC Plus', new: 'Hormuud EVC' },
			merchantNumber: { old: '611111111', new: '612222222' },
			enabled: { old: true, new: false }
		});

		expect(
			await update(r, id, { name: 'Hormuud EVC', merchantNumber: '612222222', enabled: false })
		).toEqual({ ok: true, changed: false });
		expect(await auditRows('payment_method.updated')).toHaveLength(1);

		// '' clears the number.
		expect(await update(r, id, { merchantNumber: '' })).toEqual({ ok: true, changed: true });
		const [cleared] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
		expect(cleared.merchantNumber).toBeNull();
	});

	it('refuses Cash, an archived method, a foreign id and a malformed id', async () => {
		const r = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const archived = await createdId(r, { name: 'Old terminal', kind: 'card' });
		expect(await archive(r, archived)).toEqual({ ok: true });
		const foreign = await createdId(b, { name: 'Zaad' });

		expect(await update(r, await cashId(r.restaurantId), { name: 'Money' })).toEqual({
			ok: false,
			reason: 'is_cash'
		});
		expect(await update(r, archived, { name: 'New terminal' })).toEqual({
			ok: false,
			reason: 'archived'
		});
		expect(await update(r, foreign, { name: 'Mine now' })).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await update(r, 'x', { name: 'Anything' })).toEqual({
			ok: false,
			reason: 'not_found'
		});

		const [bRow] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, foreign));
		expect(bRow.name).toBe('Zaad');
		expect(await auditRows('payment_method.updated')).toHaveLength(0);
	});

	it('refuses a bad name, a bad number and a live duplicate', async () => {
		const r = await makeRestaurant();
		const id = await createdId(r, { name: 'EVC Plus' });
		await createdId(r, { name: 'Zaad' });

		expect(await update(r, id, { name: 'EVC\u0007' })).toEqual({
			ok: false,
			reason: 'invalid_name'
		});
		expect(await update(r, id, { merchantNumber: '61\n23' })).toEqual({
			ok: false,
			reason: 'invalid_number'
		});
		expect(await update(r, id, { name: 'ZAAD' })).toEqual({
			ok: false,
			reason: 'duplicate_name'
		});
		expect(await auditRows('payment_method.updated')).toHaveLength(0);
	});

	it('ignores a forged kind: the kind is fixed in the module', async () => {
		const r = await makeRestaurant();
		const id = await createdId(r, { name: 'Card', kind: 'card' });

		expect(await update(r, id, { name: 'Card 2', kind: 'mobile' } as never)).toEqual({
			ok: true,
			changed: true
		});
		const [row] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
		expect(row).toMatchObject({ name: 'Card 2', kind: 'card' });
		const [audit] = await auditRows('payment_method.updated');
		expect(Object.keys((audit.details as { changes: object }).changes)).toEqual(['name']);
	});

	it('the kind is fixed in the database: a raw UPDATE raises', async () => {
		const r = await makeRestaurant();
		const id = await createdId(r, { name: 'Card', kind: 'card' });

		// testDb() is the OWNER pool: only migration 0017's trigger
		// payment_methods_kind_immutable can refuse this statement.
		const error = await db
			.execute(sql`update payment_methods set kind = 'mobile' where id = ${id}`)
			.then(
				() => null,
				(e: unknown) => e
			);
		const messages: string[] = [];
		for (let e = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
			messages.push(e.message);
		}
		expect(messages.join('\n')).toMatch(
			/payment_methods\.kind is fixed: card cannot become mobile/
		);
		const [row] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
		expect(row.kind).toBe('card');
	});
});

describe('movePaymentMethod', () => {
	it('moves a method up and renumbers; refuses Cash; does nothing at the top', async () => {
		const r = await makeRestaurant();
		const a = await createdId(r, { name: 'A' });
		await createdId(r, { name: 'B' });
		const c = await createdId(r, { name: 'C' });
		expect(await ownerOrder(r)).toEqual(['A:1', 'B:2', 'C:3']);

		expect(await move(r, c, 'up')).toEqual({ ok: true, changed: true });
		expect(await ownerOrder(r)).toEqual(['A:1', 'C:2', 'B:3']);
		const moved = await auditRows('payment_method.updated');
		expect(moved).toHaveLength(1);
		expect(moved[0].details).toEqual({ changes: { sortOrder: { old: 3, new: 2 } } });

		expect(await move(r, a, 'up')).toEqual({ ok: true, changed: false });
		expect(await ownerOrder(r)).toEqual(['A:1', 'C:2', 'B:3']);
		expect(await auditRows('payment_method.updated')).toHaveLength(1);

		expect(await move(r, await cashId(r.restaurantId), 'down')).toEqual({
			ok: false,
			reason: 'is_cash'
		});
	});

	it('moves a method down from a fresh A, B, C; does nothing at the bottom', async () => {
		const r = await makeRestaurant();
		const a = await createdId(r, { name: 'A' });
		await createdId(r, { name: 'B' });
		const c = await createdId(r, { name: 'C' });

		expect(await move(r, a, 'down')).toEqual({ ok: true, changed: true });
		expect(await ownerOrder(r)).toEqual(['B:1', 'A:2', 'C:3']);
		const moved = await auditRows('payment_method.updated');
		expect(moved).toHaveLength(1);
		expect(moved[0].details).toEqual({ changes: { sortOrder: { old: 1, new: 2 } } });

		expect(await move(r, c, 'down')).toEqual({ ok: true, changed: false });
		expect(await auditRows('payment_method.updated')).toHaveLength(1);
	});

	it('renumbers ties and gaps to 1..n', async () => {
		const r = await makeRestaurant();
		const a = await createdId(r, { name: 'A' });
		const b = await createdId(r, { name: 'B' });
		const c = await createdId(r, { name: 'C' });
		// Configuration, not a posted record: a direct write makes the gap and the tie.
		await db.update(paymentMethods).set({ sortOrder: 7 }).where(eq(paymentMethods.id, a));
		await db.update(paymentMethods).set({ sortOrder: 7 }).where(eq(paymentMethods.id, b));
		await db.update(paymentMethods).set({ sortOrder: 9 }).where(eq(paymentMethods.id, c));

		expect(await move(r, c, 'up')).toEqual({ ok: true, changed: true });
		expect(await ownerOrder(r)).toEqual(['A:1', 'C:2', 'B:3']);
	});

	it('refuses an archived method, a foreign id and a malformed id', async () => {
		const r = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const old = await createdId(r, { name: 'Old' });
		await createdId(r, { name: 'Live' });
		expect(await archive(r, old)).toEqual({ ok: true });
		const foreign = await createdId(b, { name: 'Zaad' });

		expect(await move(r, old, 'up')).toEqual({ ok: false, reason: 'archived' });
		expect(await move(r, foreign, 'up')).toEqual({ ok: false, reason: 'not_found' });
		await db.transaction(async (tx) => {
			expect(await movePaymentMethod(tx, r.restaurantId, 'nope', 'up', r.ctx)).toEqual({
				ok: false,
				reason: 'not_found'
			});
			// No SQL error: the transaction is still usable.
			expect(await listPaymentMethods(tx, r.restaurantId)).toHaveLength(2);
		});
		expect(await auditRows('payment_method.updated')).toHaveLength(0);
	});
});

describe('archivePaymentMethod', () => {
	it('archives (enabled unchanged), hides it from the live list, and refuses twice and Cash', async () => {
		const r = await makeRestaurant();
		// One method of EACH enabled value, so an archive that also switches the
		// method off (or on) fails here: "leave `enabled` unchanged" (plan step 7).
		const on = await createdId(r, { name: 'EVC Plus', enabled: true });
		const off = await createdId(r, { name: 'Zaad', enabled: false });

		expect(await archive(r, on)).toEqual({ ok: true });
		expect(await archive(r, off)).toEqual({ ok: true });
		const [onRow] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, on));
		expect(onRow.archivedAt).toBeInstanceOf(Date);
		expect(onRow.enabled).toBe(true);
		const [offRow] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, off));
		expect(offRow.archivedAt).toBeInstanceOf(Date);
		expect(offRow.enabled).toBe(false);

		const archived = await auditRows('payment_method.archived');
		expect(archived.map((a) => a.details)).toEqual([
			{ name: 'EVC Plus', kind: 'mobile' },
			{ name: 'Zaad', kind: 'mobile' }
		]);

		const live = (await listPaymentMethods(db, r.restaurantId)).map((m) => m.id);
		expect(live).not.toContain(on);
		expect(live).not.toContain(off);
		const all = (await listPaymentMethods(db, r.restaurantId, { includeArchived: true })).map(
			(m) => m.id
		);
		expect(all).toContain(on);
		expect(all).toContain(off);

		expect(await archive(r, on)).toEqual({ ok: false, reason: 'already_archived' });
		expect(await archive(r, await cashId(r.restaurantId))).toEqual({
			ok: false,
			reason: 'is_cash'
		});
		expect(await auditRows('payment_method.archived')).toHaveLength(2);
	});

	it('refuses a foreign id and a malformed id, leaving the transaction usable', async () => {
		const r = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const foreign = await createdId(b, { name: 'Zaad' });

		expect(await archive(r, foreign)).toEqual({ ok: false, reason: 'not_found' });
		const [bRow] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, foreign));
		expect(bRow.archivedAt).toBeNull();

		await db.transaction(async (tx) => {
			expect(await archivePaymentMethod(tx, r.restaurantId, 'not-a-uuid', r.ctx)).toEqual({
				ok: false,
				reason: 'not_found'
			});
			expect(await listPaymentMethods(tx, r.restaurantId)).toHaveLength(1);
		});
		expect(await auditRows('payment_method.archived')).toHaveLength(0);
	});
});

describe('listPaymentMethods', () => {
	it('puts Cash first, then sort order, then name, and never returns another restaurant', async () => {
		const r = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const zaad = await createdId(r, { name: 'Zaad' });
		const card = await createdId(r, { name: 'Card', kind: 'card', enabled: false });
		const evc = await createdId(r, { name: 'EVC Plus', merchantNumber: '611111111' });
		await createdId(b, { name: 'eDahab' });
		// A tie on sort_order falls back to the name.
		await db.update(paymentMethods).set({ sortOrder: 5 }).where(eq(paymentMethods.id, zaad));
		await db.update(paymentMethods).set({ sortOrder: 5 }).where(eq(paymentMethods.id, evc));
		// Card ties Cash's 0 and sorts before 'Cash' by name, so only the cash-first
		// term can put Cash ahead of it.
		await db.update(paymentMethods).set({ sortOrder: 0 }).where(eq(paymentMethods.id, card));

		const list = await listPaymentMethods(db, r.restaurantId);
		expect(list.map((m) => m.name)).toEqual(['Cash', 'Card', 'EVC Plus', 'Zaad']);
		expect(list[0]).toEqual({
			id: await cashId(r.restaurantId),
			name: 'Cash',
			kind: 'cash',
			merchantNumber: null,
			enabled: true,
			sortOrder: 0,
			archivedAt: null
		});
		// Disabled methods are listed; filtering to enabled ones is the bundle's job.
		expect(list.find((m) => m.id === card)).toMatchObject({ kind: 'card', enabled: false });
		expect(list.find((m) => m.id === evc)).toMatchObject({ merchantNumber: '611111111' });
		expect(list.map((m) => m.name)).not.toContain('eDahab');
	});
});

describe('no delete path', () => {
	it('exports nothing that deletes or removes a method', async () => {
		const names = Object.keys(await import('./payment-methods'));
		expect(names.filter((name) => /delete|remove/i.test(name))).toEqual([]);
	});
});
