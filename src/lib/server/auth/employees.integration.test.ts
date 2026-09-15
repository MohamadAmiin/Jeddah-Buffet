import { describe, it, expect, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import type { Principal } from './session';
import { verifyPin } from '../../pin';
import { createEmployee, listEmployees, setEmployeePin } from './employees';
import { load, actions } from '../../../routes/(dashboard)/employees/+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const ctx = (actorUserId: string) => ({ actorUserId, ip: null, userAgent: null });

async function makeRestaurant(email = 'owner@cafe.com') {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
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

/** A dashboard request: the principal and tenant the hook would have set, and an optional form body. */
function makeEvent(user: Principal, form?: Record<string, string>): RequestEvent {
	const url = new URL('http://localhost/employees');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/employees' },
		url
	} as unknown as RequestEvent;
}

/** The status a load or action threw, or undefined when it returned. */
async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

function act(name: 'createEmployee' | 'setPin', event: RequestEvent) {
	return actions[name]!(event as Parameters<NonNullable<(typeof actions)[typeof name]>>[0]);
}

async function byName(restaurantId: string, displayName: string) {
	return db
		.select()
		.from(users)
		.where(and(eq(users.restaurantId, restaurantId), eq(users.displayName, displayName)));
}

async function auditRows(event: string) {
	return db.select().from(auditLog).where(eq(auditLog.event, event));
}

describe('the /employees page', () => {
	// MANDATORY (spec 29 — permission checks; this repository applies the rule to
	// every route). 403 exactly, from the load AND from both actions — each is a
	// separately reachable endpoint — and nothing written behind the refusal.
	it.each(['cashier', 'waiter'] as const)(
		'refuses a %s with 403 on the load and on both actions',
		async (role) => {
			const a = await makeRestaurant();
			const [staff] = await db
				.insert(users)
				.values({ restaurantId: a.restaurantId, role, displayName: 'Staff' })
				.returning();
			const asStaff = principal(staff.id, a.restaurantId, role);

			expect(await statusOf(() => load(makeEvent(asStaff) as never))).toBe(403);
			expect(
				await statusOf(() =>
					act(
						'createEmployee',
						makeEvent(asStaff, { role: 'cashier', displayName: 'Sam', pin: '1234' })
					)
				)
			).toBe(403);
			expect(
				await statusOf(() => act('setPin', makeEvent(asStaff, { userId: staff.id, pin: '1234' })))
			).toBe(403);

			expect(await byName(a.restaurantId, 'Sam')).toHaveLength(0);
			const [row] = await db.select().from(users).where(eq(users.id, staff.id));
			expect(row.pinHash).toBeNull();
			expect(await db.select().from(auditLog)).toHaveLength(0);
		}
	);

	it('never lets a PIN hash or a password hash reach the browser', async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
		await act(
			'createEmployee',
			makeEvent(asOwner, { role: 'cashier', displayName: 'Sam', pin: '1234' })
		);
		const [sam] = await byName(a.restaurantId, 'Sam');
		expect(sam.pinHash).not.toBeNull();

		// Exactly what SvelteKit serialises into the page HTML and __data.json.
		const serialised = JSON.stringify(await load(makeEvent(asOwner) as never));

		expect(serialised).not.toContain(sam.pinHash!);
		expect(serialised).not.toContain('not-a-real-hash');
		for (const key of ['pinHash', 'pin_hash', 'passwordHash']) {
			expect(serialised).not.toContain(key);
		}
		expect(serialised).toContain('"hasPin":true');
	});

	it.each(['123', '1234567', '12a4', ''])(
		'refuses a PIN of %j with 400 and creates no one',
		async (pin) => {
			const a = await makeRestaurant();
			const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

			const result = await act(
				'createEmployee',
				makeEvent(asOwner, { role: 'cashier', displayName: 'Sam', pin })
			);

			expect((result as { status?: number }).status).toBe(400);
			expect(await byName(a.restaurantId, 'Sam')).toHaveLength(0);
			expect(await auditRows('employee.created')).toHaveLength(0);
		}
	);

	it.each(['1234', '123456'])(
		'accepts a PIN of %j, and the stored hash verifies it',
		async (pin) => {
			const a = await makeRestaurant();
			const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

			const result = await act(
				'createEmployee',
				makeEvent(asOwner, { role: 'waiter', displayName: 'Sam', pin })
			);

			expect(result).toEqual({ message: 'Sam was added.' });
			const [sam] = await byName(a.restaurantId, 'Sam');
			expect(await verifyPin(pin, sam.pinHash!)).toBe(true);
		}
	);

	it("sets the owner's own approval PIN, leaving the owner's password alone", async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

		const result = await act('setPin', makeEvent(asOwner, { userId: a.ownerId, pin: '2468' }));

		expect(result).toEqual({ message: 'PIN set.' });
		const [owner] = await db.select().from(users).where(eq(users.id, a.ownerId));
		expect(await verifyPin('2468', owner.pinHash!)).toBe(true);
		expect(owner.email).toBe('owner@cafe.com');
		expect(owner.passwordHash).toBe('not-a-real-hash');
	});
});

describe('createEmployee', () => {
	it.each(['cashier', 'waiter'] as const)(
		'creates a %s with NULL email and NULL password hash, and a PIN hash',
		async (role) => {
			const a = await makeRestaurant();

			await db.transaction((tx) =>
				createEmployee(
					tx,
					a.restaurantId,
					{ role, displayName: 'Sam', pin: '4321' },
					ctx(a.ownerId)
				)
			);

			const [sam] = await byName(a.restaurantId, 'Sam');
			expect(sam.role).toBe(role);
			expect(sam.email).toBeNull();
			expect(sam.passwordHash).toBeNull();
			expect(await verifyPin('4321', sam.pinHash!)).toBe(true);
		}
	);

	it('writes exactly one employee.created row, in the SAME transaction as the insert', async () => {
		const a = await makeRestaurant();

		const { id } = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ role: 'cashier', displayName: 'Sam', pin: '4321' },
				ctx(a.ownerId)
			)
		);
		const rows = await auditRows('employee.created');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({ role: 'cashier', displayName: 'Sam' });
		expect(rows[0].subjectUserId).toBe(id);
		expect(rows[0].actorUserId).toBe(a.ownerId);

		// A failure AFTER the audit write rolls both back: the row and its audit entry
		// commit together or not at all.
		await expect(
			db.transaction(async (tx) => {
				await createEmployee(
					tx,
					a.restaurantId,
					{ role: 'waiter', displayName: 'Robin', pin: '4321' },
					ctx(a.ownerId)
				);
				throw new Error('forced failure');
			})
		).rejects.toThrow('forced failure');
		expect(await byName(a.restaurantId, 'Robin')).toHaveLength(0);
		expect(await auditRows('employee.created')).toHaveLength(1);
	});
});

describe('setEmployeePin', () => {
	it('replaces the PIN, resets the PIN lockout pair and audits employee.pin_set', async () => {
		const a = await makeRestaurant();
		const { id } = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ role: 'cashier', displayName: 'Sam', pin: '1111' },
				ctx(a.ownerId)
			)
		);
		await db
			.update(users)
			.set({ failedPinCount: 5, pinLockedUntil: new Date(Date.now() + 300_000) })
			.where(eq(users.id, id));

		const result = await db.transaction((tx) =>
			setEmployeePin(tx, a.restaurantId, id, '2222', ctx(a.ownerId))
		);

		expect(result).toEqual({ ok: true });
		const [sam] = await db.select().from(users).where(eq(users.id, id));
		expect(await verifyPin('2222', sam.pinHash!)).toBe(true);
		expect(await verifyPin('1111', sam.pinHash!)).toBe(false);
		expect(sam.failedPinCount).toBe(0);
		expect(sam.pinLockedUntil).toBeNull();
		const rows = await auditRows('employee.pin_set');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({ role: 'cashier' });
		expect(rows[0].subjectUserId).toBe(id);
	});

	it("refuses another restaurant's employee and touches nothing", async () => {
		const a = await makeRestaurant('a@cafe.com');
		const b = await makeRestaurant('b@cafe.com');
		const { id } = await db.transaction((tx) =>
			createEmployee(
				tx,
				a.restaurantId,
				{ role: 'cashier', displayName: 'Sam', pin: '1111' },
				ctx(a.ownerId)
			)
		);
		const [before] = await db.select().from(users).where(eq(users.id, id));

		const result = await db.transaction((tx) =>
			setEmployeePin(tx, b.restaurantId, id, '9999', ctx(b.ownerId))
		);

		expect(result).toEqual({ ok: false, reason: 'not_found' });
		const [after] = await db.select().from(users).where(eq(users.id, id));
		expect(after.pinHash).toBe(before.pinHash);
		expect(await auditRows('employee.pin_set')).toHaveLength(0);
	});
});

describe('listEmployees', () => {
	it('lists everyone, the owner included, by role then name — with hasPin, never a hash', async () => {
		const a = await makeRestaurant();
		for (const [role, displayName] of [
			['waiter', 'Zed'],
			['cashier', 'Sam']
		] as const) {
			await db.transaction((tx) =>
				createEmployee(tx, a.restaurantId, { role, displayName, pin: '1234' }, ctx(a.ownerId))
			);
		}

		const rows = await listEmployees(db, a.restaurantId);

		expect(rows.map((r) => [r.role, r.displayName, r.hasPin])).toEqual([
			['owner', 'The Owner', false],
			['cashier', 'Sam', true],
			['waiter', 'Zed', true]
		]);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(['displayName', 'hasPin', 'id', 'isActive', 'role']);
		}
	});
});
