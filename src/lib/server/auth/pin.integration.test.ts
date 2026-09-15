import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { hashPin } from '../../pin';
import { registerDevice } from './pos-device';
import {
	MAX_FAILED_PIN_ATTEMPTS,
	PIN_LOCKOUT_MS,
	verifyEmployeePin,
	type PinAttemptContext
} from './pin';

const db = testDb();
const T0 = new Date('2026-09-15T12:00:00.000Z');

// A real 600,000-iteration hash costs ~90 ms, so the fixture PIN is hashed ONCE
// per file. The per-attempt verifications are the cost under test and are not
// "fixed" by lowering the iteration count.
let PIN_1234: string;

beforeAll(async () => {
	PIN_1234 = await hashPin('1234');
});

afterAll(async () => {
	await closeTestDb();
});

type Fixture = {
	restaurantId: string;
	ownerId: string;
	cashierId: string;
	deviceId: string;
	deviceCode: string;
};

/**
 * A restaurant, its owner, a cashier whose PIN is 1234, and a registered device —
 * the device is needed because ctx.deviceId lands in audit_log.device_id, whose
 * foreign key is RESTRICT.
 */
async function makeFixture(email = 'owner@cafe.com', failedPasswordCount = 0): Promise<Fixture> {
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
	const [cashier] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'cashier',
			displayName: 'Sam',
			pinHash: PIN_1234,
			failedPasswordCount
		})
		.returning();
	const device = await db.transaction((tx) =>
		registerDevice(tx, {
			restaurantId: restaurant.id,
			actorUserId: owner.id,
			label: 'Counter tablet'
		})
	);
	return {
		restaurantId: restaurant.id,
		ownerId: owner.id,
		cashierId: cashier.id,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode
	};
}

/** One attempt, wrapped the way T-19 will: the caller opens the transaction. */
function attempt(
	f: Fixture,
	pin: string,
	ctx: Partial<PinAttemptContext> = {},
	employeeId = f.cashierId
) {
	return db.transaction((tx) =>
		verifyEmployeePin(
			tx,
			{ restaurantId: f.restaurantId, employeeId, pin },
			{
				deviceId: f.deviceId,
				deviceCode: f.deviceCode,
				clientOpId: null,
				ip: '203.0.113.9',
				userAgent: 'till',
				now: T0,
				...ctx
			}
		)
	);
}

async function userRow(id: string) {
	const [row] = await db.select().from(users).where(eq(users.id, id));
	return row;
}

async function auditRows() {
	return db
		.select({
			event: auditLog.event,
			details: auditLog.details,
			actorUserId: auditLog.actorUserId,
			subjectUserId: auditLog.subjectUserId,
			deviceId: auditLog.deviceId,
			clientOpId: auditLog.clientOpId
		})
		.from(auditLog)
		.orderBy(auditLog.id);
}

describe('verifyEmployeePin', () => {
	it('accepts the right PIN after four wrong ones and clears the counter', async () => {
		const f = await makeFixture();
		for (let i = 0; i < MAX_FAILED_PIN_ATTEMPTS - 1; i++) {
			expect(await attempt(f, '9999')).toEqual({ ok: false, reason: 'invalid' });
		}

		expect(await attempt(f, '1234')).toEqual({
			ok: true,
			employee: { id: f.cashierId, displayName: 'Sam', role: 'cashier' }
		});
		const row = await userRow(f.cashierId);
		expect(row.failedPinCount).toBe(0);
		expect(row.pinLockedUntil).toBeNull();
	});

	it('locks the employee for five minutes on the fifth wrong PIN, and resets the counter', async () => {
		const f = await makeFixture();
		for (let i = 0; i < MAX_FAILED_PIN_ATTEMPTS; i++) await attempt(f, '9999');

		const row = await userRow(f.cashierId);
		expect(Math.abs(row.pinLockedUntil!.getTime() - (T0.getTime() + PIN_LOCKOUT_MS))).toBeLessThan(
			1000
		);
		expect(row.failedPinCount).toBe(0);

		const rows = await auditRows();
		expect(rows.map((r) => r.event)).toEqual([
			'pos.pin.failed',
			'pos.pin.failed',
			'pos.pin.failed',
			'pos.pin.failed',
			'pos.pin.locked_out'
		]);
		expect(rows.slice(0, 4).map((r) => r.details)).toEqual(
			[1, 2, 3, 4].map((failedCount) => ({
				deviceCode: f.deviceCode,
				reason: 'bad_pin',
				failedCount
			}))
		);
		expect(rows[4].details).toEqual({
			deviceCode: f.deviceCode,
			failedCount: 5,
			lockedForMs: 300000
		});
		// A failed attempt is performed by nobody and is about the employee.
		expect(rows.every((r) => r.actorUserId === null && r.subjectUserId === f.cashierId)).toBe(true);
	});

	it('refuses even the correct PIN while locked, and accepts it once the lock has passed', async () => {
		const f = await makeFixture();
		for (let i = 0; i < MAX_FAILED_PIN_ATTEMPTS; i++) await attempt(f, '9999');

		const inside = await attempt(f, '1234', { now: new Date(T0.getTime() + 60_000) });
		expect(inside).toEqual({ ok: false, reason: 'locked', retryAfterMs: PIN_LOCKOUT_MS - 60_000 });

		const rows = await auditRows();
		expect(rows).toHaveLength(6);
		expect(rows[5].event).toBe('pos.pin.failed');
		expect(rows[5].details).toEqual({
			deviceCode: f.deviceCode,
			reason: 'rejected_locked',
			failedCount: 0
		});

		const after = await attempt(f, '1234', {
			now: new Date(T0.getTime() + PIN_LOCKOUT_MS + 1_000)
		});
		expect(after.ok).toBe(true);
		const row = await userRow(f.cashierId);
		expect(row.pinLockedUntil).toBeNull();
		expect(row.failedPinCount).toBe(0);
	});

	// The assertion that fails if writeAudit's device fields were skipped: every row
	// this module writes carries the device, and the op id when there is one.
	it('stamps the device and the client op id on every audit row it writes', async () => {
		const f = await makeFixture();
		const opId = crypto.randomUUID();

		await attempt(f, '1234', { clientOpId: opId });
		await attempt(f, '1234', { clientOpId: null });

		const rows = await auditRows();
		expect(
			rows.map((r) => ({ event: r.event, deviceId: r.deviceId, clientOpId: r.clientOpId }))
		).toEqual([
			{ event: 'pos.pin.success', deviceId: f.deviceId, clientOpId: opId },
			{ event: 'pos.pin.success', deviceId: f.deviceId, clientOpId: null }
		]);
		expect(rows[0].details).toEqual({ deviceCode: f.deviceCode, role: 'cashier' });
		expect(rows[0].actorUserId).toBe(f.cashierId);
	});

	// Proof the function did not sneak its own commit in: the caller's rollback
	// takes the counter change and the audit row with it.
	it("leaves nothing behind when the caller's transaction rolls back", async () => {
		const f = await makeFixture();

		await expect(
			db.transaction(async (tx) => {
				await verifyEmployeePin(
					tx,
					{ restaurantId: f.restaurantId, employeeId: f.cashierId, pin: '9999' },
					{
						deviceId: f.deviceId,
						deviceCode: f.deviceCode,
						clientOpId: null,
						ip: null,
						userAgent: null,
						now: T0
					}
				);
				throw new Error('the surrounding request failed');
			})
		).rejects.toThrow('the surrounding request failed');

		expect(await auditRows()).toHaveLength(0);
		expect((await userRow(f.cashierId)).failedPinCount).toBe(0);
	});

	// Five wrong PINs at the counter must not lock the owner out of the dashboard.
	it('never touches the password lockout pair', async () => {
		const f = await makeFixture('owner@cafe.com', 3);

		for (let i = 0; i < MAX_FAILED_PIN_ATTEMPTS; i++) await attempt(f, '9999');
		let row = await userRow(f.cashierId);
		expect(row.failedPasswordCount).toBe(3);
		expect(row.passwordLockedUntil).toBeNull();

		await attempt(f, '1234', { now: new Date(T0.getTime() + PIN_LOCKOUT_MS + 1_000) });
		row = await userRow(f.cashierId);
		expect(row.failedPasswordCount).toBe(3);
		expect(row.passwordLockedUntil).toBeNull();
	});

	it('answers an unknown id and another restaurant’s employee exactly like a wrong PIN, writing nothing', async () => {
		const a = await makeFixture('a@cafe.com');
		const b = await makeFixture('b@cafe.com');

		expect(await attempt(a, '1234', {}, crypto.randomUUID())).toEqual({
			ok: false,
			reason: 'invalid'
		});
		// B's cashier really has PIN 1234 — and is still refused through A's device.
		expect(await attempt(a, '1234', {}, b.cashierId)).toEqual({ ok: false, reason: 'invalid' });

		expect(await auditRows()).toHaveLength(0);
		expect((await userRow(b.cashierId)).failedPinCount).toBe(0);
	});

	it('refuses an inactive employee and one with no PIN set', async () => {
		const f = await makeFixture();
		const [inactive] = await db
			.insert(users)
			.values({
				restaurantId: f.restaurantId,
				role: 'waiter',
				displayName: 'Gone',
				pinHash: PIN_1234,
				isActive: false
			})
			.returning();
		const [noPin] = await db
			.insert(users)
			.values({ restaurantId: f.restaurantId, role: 'waiter', displayName: 'New' })
			.returning();

		expect(await attempt(f, '1234', {}, inactive.id)).toEqual({ ok: false, reason: 'invalid' });
		expect(await attempt(f, '1234', {}, noPin.id)).toEqual({ ok: false, reason: 'invalid' });
		expect(await auditRows()).toHaveLength(0);
	});
});
