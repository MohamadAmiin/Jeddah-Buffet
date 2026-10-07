// THE PAYMENT METHODS PAGE (tasks/settings-tax-payments-receipt T-29): named
// card and mobile methods beside the one built-in Cash row. The kind is fixed
// at creation and never cash (invariants 3 and 5: the kind picks the ledger
// account and the offline rule); a method is archived, never deleted
// (invariant 2); every write audits in the action's one transaction
// (invariant 10); a method of another restaurant is never reachable
// (invariant 8).
import { afterAll, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { RequestEvent, ServerLoadEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { paymentMethods } from '$lib/server/db/schema/payment-methods';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { seedStaff } from '$lib/server/db/test/seed';
import { cashMethodId, seedPaymentMethod } from '$lib/server/db/test/settings';
import type { Principal } from '$lib/server/auth/session';
import { DEVICE_COOKIE, registerDevice } from '$lib/server/auth/pos-device';
import { onRestaurantCreated } from '$lib/server/restaurants';
import { GET as employeesGet } from '../../../api/pos/employees/+server';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const KIND_MESSAGE = 'Choose Card terminal or Mobile money. Cash is built in.';
const NOT_FOUND_MESSAGE = 'That payment method no longer exists. Reload the page.';
const IS_CASH_MESSAGE = 'Cash is built in: it cannot be renamed, moved, switched off or archived.';

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
	const url = new URL('http://localhost/settings/payments');
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
		route: { id: '/(dashboard)/settings/payments' },
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

/** The till's GET /api/pos/employees, authenticated by the device cookie only (the employees test's idiom). */
function deviceEvent(token: string): RequestEvent {
	const jar = new Map([[DEVICE_COOKIE, token]]);
	const url = new URL('http://localhost/api/pos/employees');
	return {
		cookies: {
			get: (name: string) => jar.get(name),
			getAll: () => [...jar].map(([name, value]) => ({ name, value })),
			set: (name: string, value: string) => jar.set(name, value),
			delete: (name: string) => jar.delete(name),
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '203.0.113.5',
		locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null },
		params: {},
		platform: undefined,
		request: new Request(url),
		route: { id: '/api/pos/employees' },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
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

type LoadData = {
	cash: { id: string; name: string } | null;
	methods: Array<{
		id: string;
		name: string;
		kind: string;
		kindLabel: string;
		merchantNumber: string | null;
		enabled: boolean;
		first: boolean;
		last: boolean;
	}>;
	archived: Array<{ id: string; name: string; kindLabel: string }>;
};

async function loadData(user: Principal): Promise<LoadData> {
	return (await load(loadEvent(user))) as LoadData;
}

/** Every method of the restaurant, live and archived: Cash first, then sort order, then name. */
async function methodRows(restaurantId: string) {
	return db
		.select({
			id: paymentMethods.id,
			name: paymentMethods.name,
			kind: paymentMethods.kind,
			merchantNumber: paymentMethods.merchantNumber,
			enabled: paymentMethods.enabled,
			sortOrder: paymentMethods.sortOrder,
			archivedAt: paymentMethods.archivedAt
		})
		.from(paymentMethods)
		.where(eq(paymentMethods.restaurantId, restaurantId))
		.orderBy(
			sql`${paymentMethods.kind} = 'cash' desc`,
			asc(paymentMethods.sortOrder),
			asc(paymentMethods.name)
		);
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

/** A ready-made owner method through the real writer (T-15's fixture); returns its id. */
function seedMethod(
	restaurantId: string,
	actorUserId: string | null,
	input: {
		name: string;
		kind: 'card' | 'mobile';
		merchantNumber?: string | null;
		enabled?: boolean;
	}
): Promise<string> {
	return db.transaction((tx) =>
		seedPaymentMethod(tx, restaurantId, input, { actorUserId, ip: null, userAgent: null })
	);
}

async function owned(name = 'Cafe One') {
	const restaurantId = await makeRestaurant(name);
	const ownerId = await makeOwner(restaurantId);
	return { restaurantId, ownerId, owner: principal(ownerId, restaurantId, 'owner') };
}

/** The Cash row as the built-in rules keep it: enabled, live, numberless, first. */
const CASH_ROW = {
	name: 'Cash',
	kind: 'cash',
	merchantNumber: null,
	enabled: true,
	sortOrder: 0,
	archivedAt: null
};

describe('payment methods settings page', () => {
	// MANDATORY (spec 29 — a permission check per route): 403 from the load and
	// from EVERY action, each a separately reachable endpoint (invariant 8). The
	// loop over Object.keys(actions) covers a fifth action without editing this.
	it('refuses a cashier with 403 on the load and on every action', async () => {
		const restaurantId = await makeRestaurant();
		const staff = await seedStaff(db, restaurantId, { displayName: 'Cashier' });
		const cashier = principal(staff.id, restaurantId, 'staff');
		const auditBefore = await auditCount(restaurantId);

		expect(await statusOf(() => load(loadEvent(cashier)))).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			expect(
				await statusOf(() =>
					action(
						name,
						makeEvent(cashier, [
							['methodId', NOBODY],
							['name', 'EVC Plus'],
							['kind', 'mobile'],
							['merchantNumber', '61 234 5678'],
							['enabled', 'yes'],
							['direction', 'up']
						])
					)
				),
				name
			).toBe(403);
		}

		// Nothing written: the built-in Cash row alone, and no audit row.
		expect(await methodRows(restaurantId)).toMatchObject([CASH_ROW]);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('adds EVC Plus as a mobile method with its number', async () => {
		const { restaurantId, owner } = await owned();

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'EVC Plus'],
				['kind', 'mobile'],
				['merchantNumber', '61 234 5678'],
				['enabled', 'yes']
			])
		);

		expect(result).toEqual({ message: 'EVC Plus added.' });
		const rows = await methodRows(restaurantId);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject(CASH_ROW);
		expect(rows[1]).toMatchObject({
			name: 'EVC Plus',
			kind: 'mobile',
			merchantNumber: '61 234 5678',
			enabled: true,
			sortOrder: 1,
			archivedAt: null
		});
		expect(await eventCount(restaurantId, 'payment_method.created')).toBe(1);

		// The load's shape: the Cash row, the live owner methods with their place
		// in the list, and the archived ones.
		const data = await loadData(owner);
		expect(Object.keys(data).sort()).toEqual(['archived', 'cash', 'methods']);
		expect(data.cash).toEqual({ id: rows[0].id, name: 'Cash' });
		expect(data.methods).toEqual([
			{
				id: rows[1].id,
				name: 'EVC Plus',
				kind: 'mobile',
				kindLabel: 'Mobile money',
				merchantNumber: '61 234 5678',
				enabled: true,
				first: true,
				last: true
			}
		]);
		expect(data.archived).toEqual([]);
	});

	it('refuses kind cash and kind cheque, and stores nothing', async () => {
		const { restaurantId, owner } = await owned();
		const auditBefore = await auditCount(restaurantId);

		for (const kind of ['cash', 'cheque']) {
			const result = await action(
				'create',
				makeEvent(owner, [
					['name', 'Petty cash'],
					['kind', kind],
					['merchantNumber', ''],
					['enabled', 'yes']
				])
			);
			expect(statusCodeOf(result), kind).toBe(400);
			expect(messageOf(result), kind).toBe(KIND_MESSAGE);
		}

		// Still exactly one row of kind cash for the restaurant — the built-in one.
		const rows = await methodRows(restaurantId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject(CASH_ROW);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('refuses a duplicate name, case-insensitively', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		await seedMethod(restaurantId, ownerId, { name: 'EVC Plus', kind: 'mobile' });
		const auditBefore = await auditCount(restaurantId);

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'evc plus'],
				['kind', 'mobile'],
				['merchantNumber', '61 234 5678'],
				['enabled', 'yes']
			])
		);

		expect(statusCodeOf(result)).toBe(400);
		expect(messageOf(result)).toBe('A payment method with that name already exists.');
		expect(await methodRows(restaurantId)).toHaveLength(2);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('refuses a control character in the name', async () => {
		const { restaurantId, owner } = await owned();
		const auditBefore = await auditCount(restaurantId);

		// An ESC in a name that prints on every receipt could start the drawer pulse.
		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'EVC\u001b'],
				['kind', 'mobile'],
				['merchantNumber', ''],
				['enabled', 'yes']
			])
		);

		expect(statusCodeOf(result)).toBe(400);
		expect(messageOf(result)).toBe(
			'Enter a name of 1 to 40 characters with no control characters.'
		);
		expect(await methodRows(restaurantId)).toHaveLength(1);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('refuses a control character in the merchant number', async () => {
		const { restaurantId, owner } = await owned();

		const result = await action(
			'create',
			makeEvent(owner, [
				['name', 'EVC Plus'],
				['kind', 'mobile'],
				['merchantNumber', '61\u001b234'],
				['enabled', 'yes']
			])
		);

		expect(statusCodeOf(result)).toBe(400);
		expect(messageOf(result)).toBe(
			'The merchant number is up to 40 characters with no control characters.'
		);
		expect(await methodRows(restaurantId)).toHaveLength(1);
	});

	it('ignores a forged kind on update', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const id = await seedMethod(restaurantId, ownerId, {
			name: 'EVC Plus',
			kind: 'mobile',
			merchantNumber: '61 234 5678'
		});

		// A posted kind is never read: the save goes through, and the kind stays.
		const result = await action(
			'update',
			makeEvent(owner, [
				['methodId', id],
				['kind', 'card'],
				['name', 'EVC Plus'],
				['merchantNumber', '61 999 0000'],
				['enabled', 'yes']
			])
		);

		expect(result).toEqual({ message: 'EVC Plus saved.' });
		expect(await methodRows(restaurantId)).toMatchObject([
			CASH_ROW,
			{ id, name: 'EVC Plus', kind: 'mobile', merchantNumber: '61 999 0000', enabled: true }
		]);
		expect(await eventCount(restaurantId, 'payment_method.updated')).toBe(1);
	});

	it('an unticked box switches a method off', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const id = await seedMethod(restaurantId, ownerId, {
			name: 'EVC Plus',
			kind: 'mobile',
			merchantNumber: '61 234 5678',
			enabled: true
		});

		// No `enabled` field at all: an unticked checkbox posts nothing.
		const off = await action(
			'update',
			makeEvent(owner, [
				['methodId', id],
				['name', 'EVC Plus'],
				['merchantNumber', '61 234 5678']
			])
		);
		expect(off).toEqual({ message: 'EVC Plus saved.' });
		expect(await methodRows(restaurantId)).toMatchObject([CASH_ROW, { id, enabled: false }]);

		// The same values again: nothing changed, nothing audited.
		const again = await action(
			'update',
			makeEvent(owner, [
				['methodId', id],
				['name', 'EVC Plus'],
				['merchantNumber', '61 234 5678']
			])
		);
		expect(again).toEqual({ message: 'No changes to save.' });
		expect(await eventCount(restaurantId, 'payment_method.updated')).toBe(1);

		// The load says so, in words a glyph will pair with.
		expect((await loadData(owner)).methods).toMatchObject([{ id, enabled: false }]);
	});

	it('refuses every change to Cash', async () => {
		const { restaurantId, owner } = await owned();
		const cashId = await cashMethodId(db, restaurantId);
		const auditBefore = await auditCount(restaurantId);

		const update = await action(
			'update',
			makeEvent(owner, [
				['methodId', cashId],
				['name', 'Petty cash'],
				['merchantNumber', '61 234 5678']
			])
		);
		expect(statusCodeOf(update)).toBe(400);
		expect(messageOf(update)).toBe(IS_CASH_MESSAGE);

		const move = await action(
			'move',
			makeEvent(owner, [
				['methodId', cashId],
				['direction', 'down']
			])
		);
		expect(statusCodeOf(move)).toBe(400);
		expect(messageOf(move)).toBe(IS_CASH_MESSAGE);

		const archive = await action(
			'archive',
			makeEvent(owner, [
				['methodId', cashId],
				['name', 'Cash']
			])
		);
		expect(statusCodeOf(archive)).toBe(400);
		expect(messageOf(archive)).toBe(IS_CASH_MESSAGE);

		// The Cash row is as the built-in rules keep it, and nothing was audited.
		expect(await methodRows(restaurantId)).toMatchObject([{ id: cashId, ...CASH_ROW }]);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('moves a method down and back up', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const evc = await seedMethod(restaurantId, ownerId, { name: 'EVC Plus', kind: 'mobile' });
		const zaad = await seedMethod(restaurantId, ownerId, { name: 'Zaad', kind: 'mobile' });
		expect(await methodRows(restaurantId)).toMatchObject([
			CASH_ROW,
			{ id: evc, sortOrder: 1 },
			{ id: zaad, sortOrder: 2 }
		]);

		const down = await action(
			'move',
			makeEvent(owner, [
				['methodId', evc],
				['direction', 'down']
			])
		);
		expect(down).toEqual({ message: 'Order saved.' });
		expect(await methodRows(restaurantId)).toMatchObject([
			CASH_ROW,
			{ id: zaad, sortOrder: 1 },
			{ id: evc, sortOrder: 2 }
		]);
		expect((await loadData(owner)).methods).toMatchObject([
			{ id: zaad, first: true, last: false },
			{ id: evc, first: false, last: true }
		]);

		const up = await action(
			'move',
			makeEvent(owner, [
				['methodId', evc],
				['direction', 'up']
			])
		);
		expect(up).toEqual({ message: 'Order saved.' });
		expect(await methodRows(restaurantId)).toMatchObject([
			CASH_ROW,
			{ id: evc, sortOrder: 1 },
			{ id: zaad, sortOrder: 2 }
		]);

		// The first one up: nothing moves, nothing is written.
		const edge = await action(
			'move',
			makeEvent(owner, [
				['methodId', evc],
				['direction', 'up']
			])
		);
		expect(edge).toEqual({ message: 'Already at that end of the list.' });
		expect(await methodRows(restaurantId)).toMatchObject([
			CASH_ROW,
			{ id: evc, sortOrder: 1 },
			{ id: zaad, sortOrder: 2 }
		]);
		expect(await eventCount(restaurantId, 'payment_method.updated')).toBe(2);

		const sideways = await action(
			'move',
			makeEvent(owner, [
				['methodId', evc],
				['direction', 'left']
			])
		);
		expect(statusCodeOf(sideways)).toBe(400);
	});

	it('archiving hides a method from the till bundle', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const device = await db.transaction((tx) =>
			registerDevice(tx, { restaurantId, actorUserId: ownerId, label: 'Till' })
		);
		const evc = await seedMethod(restaurantId, ownerId, {
			name: 'EVC Plus',
			kind: 'mobile',
			merchantNumber: '61 234 5678'
		});
		const zaad = await seedMethod(restaurantId, ownerId, {
			name: 'Zaad',
			kind: 'mobile',
			merchantNumber: '63 345 6789'
		});

		const result = await action(
			'archive',
			makeEvent(owner, [
				['methodId', zaad],
				['name', 'Zaad']
			])
		);
		expect(result).toEqual({ message: 'Zaad archived.' });
		expect(await eventCount(restaurantId, 'payment_method.archived')).toBe(1);

		// The till's settings bundle (T-20) carries the enabled, LIVE methods only.
		const response = await employeesGet(deviceEvent(device.token));
		expect(response.status).toBe(200);
		const body = JSON.parse(await response.text()) as {
			settings: { paymentMethods: Array<{ id: string; name: string }> };
		};
		expect(body.settings.paymentMethods.map((m) => m.name)).toEqual(['Cash', 'EVC Plus']);
		expect(body.settings.paymentMethods.map((m) => m.id)).not.toContain(zaad);

		// The load lists it under archived, with its kind in words.
		const data = await loadData(owner);
		expect(data.methods.map((m) => m.id)).toEqual([evc]);
		expect(data.archived).toEqual([{ id: zaad, name: 'Zaad', kindLabel: 'Mobile money' }]);

		// Archived is archived: a second attempt says so, and the row is unchanged.
		const again = await action(
			'archive',
			makeEvent(owner, [
				['methodId', zaad],
				['name', 'Zaad']
			])
		);
		expect(statusCodeOf(again)).toBe(400);
		expect(messageOf(again)).toBe('That payment method is archived.');
		expect(await eventCount(restaurantId, 'payment_method.archived')).toBe(1);

		// So is a rename or a move of it.
		const update = await action(
			'update',
			makeEvent(owner, [
				['methodId', zaad],
				['name', 'Zaad'],
				['merchantNumber', '63 000 0000'],
				['enabled', 'yes']
			])
		);
		expect(statusCodeOf(update)).toBe(400);
		expect(messageOf(update)).toBe('That payment method is archived.');
	});

	it('never touches another restaurant', async () => {
		const a = await owned('Cafe A');
		const b = await makeRestaurant('Cafe B');
		const zaadOfB = await seedMethod(b, null, {
			name: 'Zaad',
			kind: 'mobile',
			merchantNumber: '63 345 6789'
		});
		const rowsOfBBefore = await methodRows(b);
		const auditOfBBefore = await auditCount(b);

		const update = await action(
			'update',
			makeEvent(a.owner, [
				['methodId', zaadOfB],
				['name', 'Hijacked'],
				['merchantNumber', '61 000 0000'],
				['enabled', 'yes']
			])
		);
		expect(statusCodeOf(update)).toBe(400);
		expect(messageOf(update)).toBe(NOT_FOUND_MESSAGE);

		const move = await action(
			'move',
			makeEvent(a.owner, [
				['methodId', zaadOfB],
				['direction', 'up']
			])
		);
		expect(statusCodeOf(move)).toBe(400);
		expect(messageOf(move)).toBe(NOT_FOUND_MESSAGE);

		const archive = await action(
			'archive',
			makeEvent(a.owner, [
				['methodId', zaadOfB],
				['name', 'Zaad']
			])
		);
		expect(statusCodeOf(archive)).toBe(400);
		expect(messageOf(archive)).toBe(NOT_FOUND_MESSAGE);

		// A malformed id is the same refusal, before any SQL.
		const malformed = await action('archive', makeEvent(a.owner, [['methodId', 'not-an-id']]));
		expect(statusCodeOf(malformed)).toBe(400);
		expect(messageOf(malformed)).toBe(NOT_FOUND_MESSAGE);

		// B's rows and audit log are as they were; A still has only its Cash row.
		expect(await methodRows(b)).toEqual(rowsOfBBefore);
		expect(await auditCount(b)).toBe(auditOfBBefore);
		expect(await methodRows(a.restaurantId)).toMatchObject([CASH_ROW]);
		expect((await loadData(a.owner)).methods).toEqual([]);
	});
});
