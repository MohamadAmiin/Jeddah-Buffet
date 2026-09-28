import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { onRestaurantCreated, updateSettings } from '../restaurants';
import { registerDevice } from '../auth/pos-device';
import { seedStaff } from '../db/test/seed';
import { closeTestDb, testDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { posSessions } from '../db/schema/pos-sessions';
import { orders, payments } from '../db/schema/orders';
import { posSyncOps } from '../db/schema/pos-sync';
import { journalEntries, journalEntryLines, accounts } from '../db/schema/accounting';
import { auditLog } from '../db/schema/audit';
import { minor } from '../../money';
import {
	SessionAlreadyClosed,
	SessionHasUnrecordedOps,
	SessionNotFound,
	closeSession,
	expectedCash,
	openSession,
	type SessionContext
} from './index';

afterAll(async () => {
	await closeTestDb();
});

type Fixture = {
	restaurantId: string;
	ownerId: string;
	deviceId: string;
	deviceCode: string;
	cashierId: string;
};

async function makeFixture(email: string): Promise<Fixture> {
	const [r] = await testDb().insert(restaurants).values({ name: 'Cafe Sess' }).returning({
		id: restaurants.id
	});
	const restaurantId = r.id;
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurantId, { restaurantName: 'Cafe Sess', timeZone: 'UTC' })
	);
	const [owner] = await testDb()
		.insert(users)
		.values({
			restaurantId,
			role: 'owner',
			displayName: 'Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });
	await db.transaction((tx) =>
		updateSettings(
			tx,
			restaurantId,
			{
				taxMode: 'exclusive',
				taxRateBp: 1000,
				currencyCode: 'USD',
				posIdleLockSeconds: 120
			},
			{ actorUserId: owner.id, ip: null, userAgent: null }
		)
	);
	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId, actorUserId: owner.id, label: 'Counter' })
	);
	const cashier = await seedStaff(db, restaurantId, { displayName: 'Sam', roleName: 'Cashier' });
	return {
		restaurantId,
		ownerId: owner.id,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode,
		cashierId: cashier.id
	};
}

function ctxFor(fx: Fixture, actorId: string, occurredAt = new Date()): SessionContext {
	return {
		restaurantId: fx.restaurantId,
		cookieDeviceId: fx.deviceId,
		opDeviceId: fx.deviceId,
		opDeviceCode: fx.deviceCode,
		employeeId: actorId,
		employeeUserId: actorId,
		clientOpId: randomUUID(),
		occurredAt,
		receivedAt: new Date(),
		ip: null,
		userAgent: null
	};
}

async function insertPaidCashOrder(
	fx: Fixture,
	sessionId: string,
	amountMinor: bigint,
	method: 'cash' | 'card' = 'cash'
): Promise<string> {
	const [orderRow] = await testDb()
		.insert(orders)
		.values({
			restaurantId: fx.restaurantId,
			posSessionId: sessionId,
			deviceId: fx.deviceId,
			employeeUserId: fx.cashierId,
			orderType: 'takeaway',
			status: 'paid',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			subtotalMinor: amountMinor,
			discountMinor: 0n,
			taxMinor: 0n,
			totalMinor: amountMinor,
			openedAt: new Date(),
			paidAt: new Date()
		})
		.returning({ id: orders.id });
	await testDb()
		.insert(payments)
		.values({
			restaurantId: fx.restaurantId,
			orderId: orderRow.id,
			method,
			amountMinor,
			tenderedMinor: method === 'cash' ? amountMinor : null,
			changeMinor: method === 'cash' ? 0n : null,
			paidAt: new Date()
		});
	return orderRow.id;
}

let fx: Fixture;
beforeEach(async () => {
	fx = await makeFixture(`sess-${randomUUID()}@example.com`);
});

describe('openSession (T-20)', () => {
	it('opens a fresh session with business_date derived in SQL', async () => {
		const result = await db.transaction((tx) =>
			openSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: randomUUID(),
				openingCashMinor: minor(50000n)
			})
		);
		expect(result.attached).toBe(false);
		expect(result.openingCashMinor).toBe(50000n);
		expect(result.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('a second open ATTACHES to the existing open row; only one pos_sessions row exists', async () => {
		const posSessionId = randomUUID();
		const first = await db.transaction((tx) =>
			openSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId,
				openingCashMinor: minor(50000n)
			})
		);
		const second = await db.transaction((tx) =>
			openSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: randomUUID(),
				openingCashMinor: minor(99999n)
			})
		);
		expect(second.attached).toBe(true);
		expect(second.posSessionId).toBe(first.posSessionId);
		expect(second.openingCashMinor).toBe(50000n);

		const rows = await testDb()
			.select()
			.from(posSessions)
			.where(eq(posSessions.restaurantId, fx.restaurantId));
		expect(rows).toHaveLength(1);

		const opened = await testDb()
			.select({ details: auditLog.details })
			.from(auditLog)
			.where(
				and(eq(auditLog.restaurantId, fx.restaurantId), eq(auditLog.event, 'pos.session.opened'))
			);
		expect(opened).toHaveLength(2);
		const attachedFlags = opened.map((r) => (r.details as { attached: boolean }).attached).sort();
		expect(attachedFlags).toEqual([false, true]);
	});

	it('a session opened in America/New_York at 03:30 UTC on the 29th lands on 09-28', async () => {
		await db.transaction((tx) =>
			updateSettings(
				tx,
				fx.restaurantId,
				{ timeZone: 'America/New_York' },
				{ actorUserId: fx.ownerId, ip: null, userAgent: null }
			)
		);
		const at = new Date('2026-09-29T03:30:00Z');
		const result = await db.transaction((tx) =>
			openSession(tx, ctxFor(fx, fx.cashierId, at), {
				posSessionId: randomUUID(),
				openingCashMinor: minor(0n)
			})
		);
		expect(result.businessDate).toBe('2026-09-28');
	});

	it('Asia/Tokyo at 16:30 UTC on the 28th lands on the 29th; UTC at 23:59:59 stays on the 28th', async () => {
		await db.transaction((tx) =>
			updateSettings(
				tx,
				fx.restaurantId,
				{ timeZone: 'Asia/Tokyo' },
				{ actorUserId: fx.ownerId, ip: null, userAgent: null }
			)
		);
		const tokyo = await db.transaction((tx) =>
			openSession(tx, ctxFor(fx, fx.cashierId, new Date('2026-09-28T16:30:00Z')), {
				posSessionId: randomUUID(),
				openingCashMinor: minor(0n)
			})
		);
		expect(tokyo.businessDate).toBe('2026-09-29');

		const other = await makeFixture(`sess-utc-${randomUUID()}@example.com`);
		const utc = await db.transaction((tx) =>
			openSession(tx, ctxFor(other, other.cashierId, new Date('2026-09-28T23:59:59Z')), {
				posSessionId: randomUUID(),
				openingCashMinor: minor(0n)
			})
		);
		expect(utc.businessDate).toBe('2026-09-28');
	});
});

describe('expectedCash and closeSession (T-20)', () => {
	async function openAndFill() {
		const open = await db.transaction((tx) =>
			openSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: randomUUID(),
				openingCashMinor: minor(50000n)
			})
		);
		await insertPaidCashOrder(fx, open.posSessionId, 150000n);
		return open;
	}

	it('MANDATORY (spec 29): shortage posts Dr 6800 / Cr 1000 with the magnitude', async () => {
		const open = await openAndFill();
		const result = await db.transaction((tx) =>
			closeSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: open.posSessionId,
				countedCashMinor: minor(199000n)
			})
		);
		expect(result.expectedCashMinor).toBe(200000n);
		expect(result.differenceMinor).toBe(-1000n);

		const [entry] = await testDb()
			.select()
			.from(journalEntries)
			.where(
				and(
					eq(journalEntries.restaurantId, fx.restaurantId),
					eq(journalEntries.sourceId, open.posSessionId)
				)
			);
		expect(entry.event).toBe('cash_shortage_at_close');
		expect(entry.sourceType).toBe('pos_session');
		expect(entry.memo).toBe('Session close');

		const jLines = await testDb()
			.select({
				code: accounts.code,
				debit: journalEntryLines.debitMinor,
				credit: journalEntryLines.creditMinor
			})
			.from(journalEntryLines)
			.innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
			.where(eq(journalEntryLines.entryId, entry.id));
		const byCode = Object.fromEntries(jLines.map((l) => [l.code, l]));
		expect(byCode['6800'].debit).toBe(1000n);
		expect(byCode['1000'].credit).toBe(1000n);

		const [sessionRow] = await testDb()
			.select()
			.from(posSessions)
			.where(eq(posSessions.id, open.posSessionId));
		expect(sessionRow.status).toBe('closed');
		expect(sessionRow.countedCashMinor).toBe(199000n);
		expect(sessionRow.expectedCashMinor).toBe(200000n);
		expect(sessionRow.differenceMinor).toBe(-1000n);
		expect(sessionRow.closedFromDeviceId).toBe(fx.deviceId);
	});

	it('MANDATORY (spec 29): overage posts Dr 1000 / Cr 6800', async () => {
		const open = await openAndFill();
		const result = await db.transaction((tx) =>
			closeSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: open.posSessionId,
				countedCashMinor: minor(201000n)
			})
		);
		expect(result.differenceMinor).toBe(1000n);
		const [entry] = await testDb()
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.sourceId, open.posSessionId));
		expect(entry.event).toBe('cash_overage_at_close');
		const jLines = await testDb()
			.select({
				code: accounts.code,
				debit: journalEntryLines.debitMinor,
				credit: journalEntryLines.creditMinor
			})
			.from(journalEntryLines)
			.innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
			.where(eq(journalEntryLines.entryId, entry.id));
		const byCode = Object.fromEntries(jLines.map((l) => [l.code, l]));
		expect(byCode['1000'].debit).toBe(1000n);
		expect(byCode['6800'].credit).toBe(1000n);
	});

	it('an exact count posts NO journal entry', async () => {
		const open = await openAndFill();
		const result = await db.transaction((tx) =>
			closeSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: open.posSessionId,
				countedCashMinor: minor(200000n)
			})
		);
		expect(result.differenceMinor).toBe(0n);
		const entries = await testDb()
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.sourceId, open.posSessionId));
		expect(entries).toHaveLength(0);
	});

	it('expectedCash counts only paid orders with method = cash', async () => {
		const open = await openAndFill();
		await insertPaidCashOrder(fx, open.posSessionId, 50000n, 'card');
		const expected = await expectedCash(testDb(), fx.restaurantId, open.posSessionId);
		expect(expected).toBe(200000n);
	});

	it('an unrecorded op blocks close; resolving it lets close through', async () => {
		const open = await openAndFill();
		await testDb().insert(posSyncOps).values({
			restaurantId: fx.restaurantId,
			deviceId: fx.deviceId,
			receivedViaDeviceId: fx.deviceId,
			clientOpId: randomUUID(),
			kind: 'sale.complete',
			status: 'unrecorded',
			error: 'database_error',
			occurredAt: new Date(),
			payload: {},
			posSessionId: open.posSessionId
		});
		await expect(
			db.transaction((tx) =>
				closeSession(tx, ctxFor(fx, fx.cashierId), {
					posSessionId: open.posSessionId,
					countedCashMinor: minor(200000n)
				})
			)
		).rejects.toBeInstanceOf(SessionHasUnrecordedOps);

		const [row] = await testDb()
			.select({ status: posSessions.status })
			.from(posSessions)
			.where(eq(posSessions.id, open.posSessionId));
		expect(row.status).toBe('open');

		await testDb()
			.update(posSyncOps)
			.set({
				resolvedAt: new Date(),
				resolvedByUserId: fx.ownerId,
				resolution: 'dismissed'
			})
			.where(
				and(
					eq(posSyncOps.restaurantId, fx.restaurantId),
					eq(posSyncOps.posSessionId, open.posSessionId)
				)
			);

		const result = await db.transaction((tx) =>
			closeSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: open.posSessionId,
				countedCashMinor: minor(200000n)
			})
		);
		expect(result.differenceMinor).toBe(0n);
	});

	it("closing twice throws SessionAlreadyClosed; another restaurant's id throws SessionNotFound", async () => {
		const open = await openAndFill();
		await db.transaction((tx) =>
			closeSession(tx, ctxFor(fx, fx.cashierId), {
				posSessionId: open.posSessionId,
				countedCashMinor: minor(200000n)
			})
		);
		await expect(
			db.transaction((tx) =>
				closeSession(tx, ctxFor(fx, fx.cashierId), {
					posSessionId: open.posSessionId,
					countedCashMinor: minor(200000n)
				})
			)
		).rejects.toBeInstanceOf(SessionAlreadyClosed);

		await expect(
			db.transaction((tx) =>
				closeSession(tx, ctxFor(fx, fx.cashierId), {
					posSessionId: randomUUID(),
					countedCashMinor: minor(0n)
				})
			)
		).rejects.toBeInstanceOf(SessionNotFound);
	});

	it('a second registered device may close a session that a first opened', async () => {
		const open = await openAndFill();
		const secondDevice = await db.transaction((tx) =>
			registerDevice(tx, {
				restaurantId: fx.restaurantId,
				actorUserId: fx.ownerId,
				label: 'Second tablet'
			})
		);
		const otherCtx: SessionContext = {
			...ctxFor(fx, fx.cashierId),
			cookieDeviceId: secondDevice.deviceId,
			// opDeviceId stays the original device (the op was recorded there);
			// closed_from_device_id is the cookie's device.
			opDeviceId: fx.deviceId,
			opDeviceCode: fx.deviceCode
		};
		const result = await db.transaction((tx) =>
			closeSession(tx, otherCtx, {
				posSessionId: open.posSessionId,
				countedCashMinor: minor(200000n)
			})
		);
		expect(result.differenceMinor).toBe(0n);
		const [row] = await testDb()
			.select({ closedFromDeviceId: posSessions.closedFromDeviceId })
			.from(posSessions)
			.where(eq(posSessions.id, open.posSessionId));
		expect(row.closedFromDeviceId).toBe(secondDevice.deviceId);
	});
});

describe('null clock', () => {
	it('does nothing beside its own docs (sanity)', async () => {
		const now = await testDb().execute(sql`select 1 as one`);
		expect((now.rows[0] as { one: number }).one).toBe(1);
	});
});
