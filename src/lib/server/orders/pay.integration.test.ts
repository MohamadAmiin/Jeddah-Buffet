import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { onRestaurantCreated, updateSettings } from '../restaurants';
import { registerDevice } from '../auth/pos-device';
import { createCategory, createItem, getMenuVersion, updateTaxRate } from '../menu';
import { seedStaff } from '../db/test/seed';
import { seedTaxRate } from '../db/test/settings';
import { closeTestDb, testDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { posSessions } from '../db/schema/pos-sessions';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { orders, orderLines, payments, invoices } from '../db/schema/orders';
import { accounts, journalEntries, journalEntryLines } from '../db/schema/accounting';
import { auditLog } from '../db/schema/audit';
import { validateSale, type SyncContext } from './validate';
import { recordSale } from './pay';
import type { OpEnvelope } from '../../sync-ops';

afterAll(async () => {
	await closeTestDb();
});

type Fixture = {
	restaurantId: string;
	ownerId: string;
	deviceId: string;
	deviceCode: string;
	sessionId: string;
	teaId: string;
	coffeeId: string;
	cashierId: string;
	waiterId: string;
	menuVersion: number;
	/** The restaurant's named default rate ('Tax' 10%), seeded by T-13's fixture. */
	taxRateId: string;
};

async function requireId<T>(p: Promise<T | { ok: false }>): Promise<string> {
	const r = (await p) as { ok: boolean; id?: string };
	if (!r.ok || typeof r.id !== 'string') throw new Error('menu helper failed');
	return r.id;
}

async function makeFixture(email: string): Promise<Fixture> {
	const [r] = await testDb().insert(restaurants).values({ name: 'Cafe Pay' }).returning({
		id: restaurants.id
	});
	const restaurantId = r.id;
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurantId, { restaurantName: 'Cafe Pay', timeZone: 'UTC' })
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
	const ownerId = owner.id;
	const taxRateId = await db.transaction(async (tx) => {
		const ctx = { actorUserId: ownerId, ip: null, userAgent: null };
		const id = await seedTaxRate(tx, restaurantId, { rateBp: 1000, makeDefault: true }, ctx);
		await updateSettings(
			tx,
			restaurantId,
			{
				taxMode: 'exclusive',
				currencyCode: 'USD',
				posIdleLockSeconds: 120
			},
			ctx
		);
		return id;
	});
	// Both card and mobile enabled directly, so the same fixture serves all three
	// tenders without a separate updateSettings call per test.
	await testDb()
		.update(restaurantSettings)
		.set({ acceptsCard: true, acceptsMobile: true })
		.where(eq(restaurantSettings.restaurantId, restaurantId));
	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId, actorUserId: ownerId, label: 'Counter' })
	);
	const categoryId = await db.transaction((tx) =>
		requireId(createCategory(tx, restaurantId, { name: 'Drinks' }))
	);
	const teaId = await db.transaction((tx) =>
		requireId(createItem(tx, restaurantId, { categoryId, name: 'Tea', priceMinor: 600n }))
	);
	const coffeeId = await db.transaction((tx) =>
		requireId(createItem(tx, restaurantId, { categoryId, name: 'Coffee', priceMinor: 200n }))
	);
	const [session] = await testDb()
		.insert(posSessions)
		.values({
			restaurantId,
			deviceId: device.deviceId,
			openedByUserId: ownerId,
			openedAt: new Date(),
			businessDate: '2026-09-28',
			openingCashMinor: 0n,
			status: 'open'
		})
		.returning({ id: posSessions.id });
	const cashier = await seedStaff(db, restaurantId, { displayName: 'Sam', roleName: 'Cashier' });
	const waiter = await seedStaff(db, restaurantId, { displayName: 'Wren', roleName: 'Waiter' });
	const menuVersion = await getMenuVersion(testDb(), restaurantId);
	return {
		restaurantId,
		ownerId,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode,
		sessionId: session.id,
		teaId,
		coffeeId,
		cashierId: cashier.id,
		waiterId: waiter.id,
		menuVersion,
		taxRateId
	};
}

function ctxFor(fx: Fixture, employeeId: string): SyncContext {
	return {
		restaurantId: fx.restaurantId,
		cookieDeviceId: fx.deviceId,
		opDeviceId: fx.deviceId,
		opDeviceCode: fx.deviceCode,
		employeeId,
		employeeUserId: employeeId,
		clientOpId: randomUUID(),
		occurredAt: new Date(),
		receivedAt: new Date(),
		ip: null,
		userAgent: null
	};
}

type Payload = OpEnvelope<'sale.complete', unknown>;

function twoLineCashEnvelope(fx: Fixture): Payload {
	// One 600 x 1 + one 200 x 2 = 1000 subtotal at 10% = 100 tax = 1100 total.
	return {
		kind: 'sale.complete',
		clientOpId: randomUUID(),
		deviceId: fx.deviceId,
		employeeId: 'ignored',
		occurredAt: new Date().toISOString(),
		seq: 1,
		payload: {
			orderId: randomUUID(),
			posSessionId: fx.sessionId,
			orderType: 'takeaway',
			tableLabel: null,
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: fx.menuVersion,
			invoiceSeq: 1,
			invoiceNumber: `${fx.deviceCode}-000001`,
			openedAt: new Date().toISOString(),
			lines: [
				{
					lineId: randomUUID(),
					lineNo: 1,
					menuItemId: fx.teaId,
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: '600',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: []
				},
				{
					lineId: randomUUID(),
					lineNo: 2,
					menuItemId: fx.coffeeId,
					itemName: 'Coffee',
					quantity: 2,
					unitPriceMinor: '200',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: []
				}
			],
			totals: {
				subtotalMinor: '1000',
				discountMinor: '0',
				taxMinor: '100',
				totalMinor: '1100'
			},
			payments: [
				{
					paymentId: randomUUID(),
					method: 'cash',
					amountMinor: '1100',
					tenderedMinor: '2000',
					changeMinor: '900'
				}
			]
		}
	};
}

async function recordThrough(
	fx: Fixture,
	env: Payload,
	employeeId: string
): Promise<{ orderId: string; invoiceNumber: string; entryIds: string[] }> {
	return db.transaction(async (tx) => {
		const ctx = ctxFor(fx, employeeId);
		const v = await validateSale(tx, ctx, env);
		if (!v.ok) throw new Error(v.hard);
		return recordSale(tx, ctx, v.sale, v.softFlags);
	});
}

async function entryLines(entryId: string) {
	return await testDb()
		.select({
			code: accounts.code,
			debit: journalEntryLines.debitMinor,
			credit: journalEntryLines.creditMinor,
			lineNo: journalEntryLines.lineNo
		})
		.from(journalEntryLines)
		.innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
		.where(eq(journalEntryLines.entryId, entryId));
}

let fx: Fixture;
beforeEach(async () => {
	fx = await makeFixture(`pay-${randomUUID()}@example.com`);
});

describe('recordSale (T-19) — MANDATORY (spec 29) posting rules per event', () => {
	it('a cash sale records order + lines + payment + invoice + one balanced entry + one audit row', async () => {
		const env = twoLineCashEnvelope(fx);
		const result = await recordThrough(fx, env, fx.cashierId);
		expect(result.entryIds).toHaveLength(1);

		const [orderRow] = await testDb()
			.select()
			.from(orders)
			.where(eq(orders.id, (env.payload as { orderId: string }).orderId));
		expect(orderRow.status).toBe('paid');
		expect(orderRow.subtotalMinor).toBe(1000n);
		expect(orderRow.taxMinor).toBe(100n);
		expect(orderRow.totalMinor).toBe(1100n);
		expect(orderRow.flagReason).toBeNull();

		const lines = await testDb()
			.select()
			.from(orderLines)
			.where(eq(orderLines.orderId, orderRow.id));
		expect(lines).toHaveLength(2);

		const [payRow] = await testDb()
			.select()
			.from(payments)
			.where(eq(payments.orderId, orderRow.id));
		expect(payRow.amountMinor).toBe(1100n);
		expect(payRow.tenderedMinor).toBe(2000n);
		expect(payRow.changeMinor).toBe(900n);

		const [invoiceRow] = await testDb()
			.select()
			.from(invoices)
			.where(eq(invoices.orderId, orderRow.id));
		expect(invoiceRow.invoiceSeq).toBe(1);
		expect(invoiceRow.invoiceNumber).toBe(`${fx.deviceCode}-000001`);
		expect(invoiceRow.totalMinor).toBe(1100n);
		expect(invoiceRow.deviceId).toBe(fx.deviceId);

		const [entry] = await testDb()
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.sourceId, orderRow.id));
		expect(entry.event).toBe('cash_sale');
		expect(entry.sourceType).toBe('order');
		expect(entry.businessDate).toBe('2026-09-28');
		expect(entry.memo).toBe(`Sale ${invoiceRow.invoiceNumber}`);

		const jLines = await entryLines(entry.id);
		expect(jLines).toHaveLength(3);
		const byCode = Object.fromEntries(jLines.map((l) => [l.code, l]));
		expect(byCode['1000'].debit).toBe(1100n);
		expect(byCode['4000'].credit).toBe(1000n);
		expect(byCode['2100'].credit).toBe(100n);

		const audit = await testDb()
			.select({
				event: auditLog.event,
				clientOpId: auditLog.clientOpId,
				actorUserId: auditLog.actorUserId,
				details: auditLog.details
			})
			.from(auditLog)
			.where(and(eq(auditLog.restaurantId, fx.restaurantId), eq(auditLog.event, 'sale.recorded')));
		expect(audit).toHaveLength(1);
		expect(audit[0].actorUserId).toBe(fx.cashierId);
		expect(audit[0].clientOpId).toBeTruthy();
		const details = audit[0].details as { totalMinor: string; invoiceNumber: string };
		expect(details.totalMinor).toBe('1100');
		expect(details.invoiceNumber).toBe(invoiceRow.invoiceNumber);
	});

	// MANDATORY (spec 29 — one posting-rule test per business event). Spec 24 keys
	// the sale rules by TENDER: a delivery cash sale is a cash_sale, Dr 1000 total /
	// Cr 4000 subtotal / Cr 2100 tax, no new event and no new account
	// (menu-and-printing T-09; CLAUDE.md decision (a)).
	it('a delivery cash sale posts exactly as any cash sale', async () => {
		const env = twoLineCashEnvelope(fx);
		const payload = env.payload as {
			orderId: string;
			orderType: string;
			tableLabel: string | null;
		};
		payload.orderType = 'delivery';
		payload.tableLabel = null;
		const result = await recordThrough(fx, env, fx.cashierId);
		expect(result.entryIds).toHaveLength(1);

		const [orderRow] = await testDb().select().from(orders).where(eq(orders.id, payload.orderId));
		expect(orderRow.orderType).toBe('delivery');
		expect(orderRow.tableLabel).toBeNull();
		expect(orderRow.status).toBe('paid');

		const [entry] = await testDb()
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.sourceId, orderRow.id));
		expect(entry.event).toBe('cash_sale');
		const jLines = await entryLines(entry.id);
		expect(jLines).toHaveLength(3);
		const byCode = Object.fromEntries(jLines.map((l) => [l.code, l]));
		expect(byCode['1000'].debit).toBe(orderRow.totalMinor);
		expect(byCode['4000'].credit).toBe(orderRow.subtotalMinor);
		expect(byCode['2100'].credit).toBe(orderRow.taxMinor);
		const debits = jLines.reduce((acc, l) => acc + l.debit, 0n);
		const credits = jLines.reduce((acc, l) => acc + l.credit, 0n);
		expect(debits).toBe(credits);

		const audit = await testDb()
			.select({ details: auditLog.details })
			.from(auditLog)
			.where(and(eq(auditLog.restaurantId, fx.restaurantId), eq(auditLog.event, 'sale.recorded')));
		expect(audit).toHaveLength(1);
		expect((audit[0].details as { orderType: string }).orderType).toBe('delivery');
	});

	// menu-and-printing T-22: the kitchen note lands on the order; a payload
	// without the key (every pre-T-22 till) records with note NULL.
	it('records the kitchen note on the order, and NULL when the payload has no note key', async () => {
		const noted = twoLineCashEnvelope(fx);
		(noted.payload as { note?: string }).note = 'no chilli';
		await recordThrough(fx, noted, fx.cashierId);
		const [withNote] = await testDb()
			.select({ note: orders.note })
			.from(orders)
			.where(eq(orders.id, (noted.payload as { orderId: string }).orderId));
		expect(withNote.note).toBe('no chilli');

		const plain = twoLineCashEnvelope(fx);
		(plain.payload as { invoiceSeq: number; invoiceNumber: string }).invoiceSeq = 2;
		(plain.payload as { invoiceSeq: number; invoiceNumber: string }).invoiceNumber =
			`${fx.deviceCode}-000002`;
		expect('note' in (plain.payload as object)).toBe(false);
		await recordThrough(fx, plain, fx.cashierId);
		const [without] = await testDb()
			.select({ note: orders.note })
			.from(orders)
			.where(eq(orders.id, (plain.payload as { orderId: string }).orderId));
		expect(without.note).toBeNull();
	});

	it('the same sale by card routes the debit to 1020; by mobile to 1030', async () => {
		for (const [method, code] of [
			['card', '1020'],
			['mobile', '1030']
		] as const) {
			const local = await makeFixture(`pay-${method}-${randomUUID()}@example.com`);
			const env = twoLineCashEnvelope(local);
			(env.payload as { payments: unknown[] }).payments = [
				{
					paymentId: randomUUID(),
					method,
					amountMinor: '1100',
					tenderedMinor: null,
					changeMinor: null
				}
			];
			const result = await recordThrough(local, env, local.cashierId);
			const [entry] = await testDb()
				.select()
				.from(journalEntries)
				.where(eq(journalEntries.id, result.entryIds[0]));
			expect(entry.event).toBe(`${method}_sale`);
			const jLines = await entryLines(entry.id);
			const debitLine = jLines.find((l) => l.debit > 0n)!;
			expect(debitLine.code).toBe(code);
			expect(debitLine.debit).toBe(1100n);
		}
	});
});

describe('recordSale (T-19) — soft flags and rollback', () => {
	it('a soft flag from validateSale is written to flag_reason and a sale.flagged audit row follows', async () => {
		const env = twoLineCashEnvelope(fx);
		await recordThrough(fx, env, fx.waiterId);
		const [orderRow] = await testDb()
			.select()
			.from(orders)
			.where(eq(orders.id, (env.payload as { orderId: string }).orderId));
		expect(orderRow.flagReason).toBe('employee_not_permitted');
		const flagged = await testDb()
			.select({
				clientOpId: auditLog.clientOpId,
				details: auditLog.details
			})
			.from(auditLog)
			.where(and(eq(auditLog.restaurantId, fx.restaurantId), eq(auditLog.event, 'sale.flagged')));
		expect(flagged).toHaveLength(1);
		expect(flagged[0].clientOpId).toBeNull();
		const details = flagged[0].details as { flags: string[] };
		expect(details.flags).toEqual(['employee_not_permitted']);
	});

	it('a missing chart of accounts rolls back the whole transaction — nothing left behind', async () => {
		const [r] = await testDb()
			.insert(restaurants)
			.values({ name: 'No Chart Cafe' })
			.returning({ id: restaurants.id });
		const restaurantId = r.id;
		await testDb().insert(restaurantSettings).values({
			restaurantId,
			timeZone: 'UTC',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			acceptsCard: false,
			acceptsMobile: false
		});
		// T-13: the named default rate, through the real writers. Neither touches
		// accounts, so the missing chart stays the ONLY failure left. Before
		// createItem and before getMenuVersion below: seedTaxRate bumps the version.
		const taxRateId = await db.transaction((tx) =>
			seedTaxRate(
				tx,
				restaurantId,
				{ rateBp: 1000, makeDefault: true },
				{ actorUserId: null, ip: null, userAgent: null }
			)
		);
		const [owner] = await testDb()
			.insert(users)
			.values({
				restaurantId,
				role: 'owner',
				displayName: 'Owner',
				email: `no-chart-${randomUUID()}@example.com`,
				passwordHash: 'not-a-real-hash'
			})
			.returning({ id: users.id });
		const device = await db.transaction((tx) =>
			registerDevice(tx, { restaurantId, actorUserId: owner.id, label: 'Counter' })
		);
		const categoryId = await db.transaction((tx) =>
			requireId(createCategory(tx, restaurantId, { name: 'Drinks' }))
		);
		const teaId = await db.transaction((tx) =>
			requireId(createItem(tx, restaurantId, { categoryId, name: 'Tea', priceMinor: 600n }))
		);
		const [session] = await testDb()
			.insert(posSessions)
			.values({
				restaurantId,
				deviceId: device.deviceId,
				openedByUserId: owner.id,
				openedAt: new Date(),
				businessDate: '2026-09-28',
				openingCashMinor: 0n,
				status: 'open'
			})
			.returning({ id: posSessions.id });
		const cashier = await seedStaff(db, restaurantId, { displayName: 'Sam' });
		const menuVersion = await getMenuVersion(testDb(), restaurantId);

		const noChartFx: Fixture = {
			restaurantId,
			ownerId: owner.id,
			deviceId: device.deviceId,
			deviceCode: device.deviceCode,
			sessionId: session.id,
			teaId,
			coffeeId: teaId,
			cashierId: cashier.id,
			waiterId: cashier.id,
			menuVersion,
			taxRateId
		};

		const env: Payload = {
			kind: 'sale.complete',
			clientOpId: randomUUID(),
			deviceId: device.deviceId,
			employeeId: 'ignored',
			occurredAt: new Date().toISOString(),
			seq: 1,
			payload: {
				orderId: randomUUID(),
				posSessionId: session.id,
				orderType: 'takeaway',
				tableLabel: null,
				taxMode: 'exclusive',
				currencyCode: 'USD',
				menuVersion,
				invoiceSeq: 1,
				invoiceNumber: `${device.deviceCode}-000001`,
				openedAt: new Date().toISOString(),
				lines: [
					{
						lineId: randomUUID(),
						lineNo: 1,
						menuItemId: teaId,
						itemName: 'Tea',
						quantity: 1,
						unitPriceMinor: '600',
						taxRateBp: 1000,
						discountMinor: '0',
						modifiers: []
					}
				],
				totals: {
					subtotalMinor: '600',
					discountMinor: '0',
					taxMinor: '60',
					totalMinor: '660'
				},
				payments: [
					{
						paymentId: randomUUID(),
						method: 'cash',
						amountMinor: '660',
						tenderedMinor: '1000',
						changeMinor: '340'
					}
				]
			}
		};

		// The SPECIFIC error: accountIdByCode's "…; run ensureChart". A bare
		// toThrow() would also pass on a price_tamper, never reaching the chart.
		await expect(recordThrough(noChartFx, env, cashier.id)).rejects.toThrow(/run ensureChart/);

		const orderCount = await testDb()
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.restaurantId, restaurantId));
		expect(orderCount).toHaveLength(0);
		const invoiceCount = await testDb()
			.select({ id: invoices.id })
			.from(invoices)
			.where(eq(invoices.restaurantId, restaurantId));
		expect(invoiceCount).toHaveLength(0);
		const paymentCount = await testDb()
			.select({ id: payments.id })
			.from(payments)
			.where(eq(payments.restaurantId, restaurantId));
		expect(paymentCount).toHaveLength(0);
		const journalCount = await testDb()
			.select({ id: journalEntries.id })
			.from(journalEntries)
			.where(eq(journalEntries.restaurantId, restaurantId));
		expect(journalCount).toHaveLength(0);
	});
});

describe('recordSale (T-19) — 0% and inclusive-20% coverage', () => {
	it('a 0% line drops the zero 2100 line: entry has exactly two lines that balance', async () => {
		const env: Payload = twoLineCashEnvelope(fx);
		(env.payload as { lines: unknown[] }).lines = [
			{
				lineId: randomUUID(),
				lineNo: 1,
				menuItemId: fx.teaId,
				itemName: 'Tea',
				quantity: 1,
				unitPriceMinor: '600',
				taxRateBp: 0,
				discountMinor: '0',
				modifiers: []
			}
		];
		(env.payload as { totals: unknown }).totals = {
			subtotalMinor: '600',
			discountMinor: '0',
			taxMinor: '0',
			totalMinor: '600'
		};
		(env.payload as { payments: unknown[] }).payments = [
			{
				paymentId: randomUUID(),
				method: 'cash',
				amountMinor: '600',
				tenderedMinor: '1000',
				changeMinor: '400'
			}
		];
		// The line's taxRateBp of 0 differs from the default rate's 1000, so re-rate
		// the default to 0% (T-13: a named rate, edited with updateTaxRate) and send
		// the sale at the version that edit produced, so validateSale sees no
		// difference at all.
		await db.transaction((tx) =>
			updateTaxRate(
				tx,
				fx.restaurantId,
				fx.taxRateId,
				{ rateBp: 0 },
				{ actorUserId: fx.ownerId, ip: null, userAgent: null }
			)
		);
		const freshMv = await getMenuVersion(testDb(), fx.restaurantId);
		(env.payload as { menuVersion: number }).menuVersion = freshMv;

		const result = await recordThrough(fx, env, fx.cashierId);
		const jLines = await entryLines(result.entryIds[0]);
		expect(jLines).toHaveLength(2);
		const byCode = Object.fromEntries(jLines.map((l) => [l.code, l]));
		expect(byCode['1000'].debit).toBe(600n);
		expect(byCode['4000'].credit).toBe(600n);
	});

	it('inclusive 20% on a 999 line balances at COMMIT', async () => {
		await db.transaction(async (tx) => {
			const ctx = { actorUserId: fx.ownerId, ip: null, userAgent: null };
			await updateSettings(tx, fx.restaurantId, { taxMode: 'inclusive' }, ctx);
			await updateTaxRate(tx, fx.restaurantId, fx.taxRateId, { rateBp: 2000 }, ctx);
		});
		const freshMv = await getMenuVersion(testDb(), fx.restaurantId);
		const env: Payload = {
			kind: 'sale.complete',
			clientOpId: randomUUID(),
			deviceId: fx.deviceId,
			employeeId: 'ignored',
			occurredAt: new Date().toISOString(),
			seq: 1,
			payload: {
				orderId: randomUUID(),
				posSessionId: fx.sessionId,
				orderType: 'takeaway',
				tableLabel: null,
				taxMode: 'inclusive',
				currencyCode: 'USD',
				menuVersion: freshMv,
				invoiceSeq: 1,
				invoiceNumber: `${fx.deviceCode}-000001`,
				openedAt: new Date().toISOString(),
				lines: [
					{
						lineId: randomUUID(),
						lineNo: 1,
						menuItemId: fx.teaId,
						itemName: 'Tea',
						quantity: 1,
						unitPriceMinor: '999',
						taxRateBp: 2000,
						discountMinor: '0',
						modifiers: []
					}
				],
				totals: {
					subtotalMinor: '832',
					discountMinor: '0',
					taxMinor: '167',
					totalMinor: '999'
				},
				payments: [
					{
						paymentId: randomUUID(),
						method: 'cash',
						amountMinor: '999',
						tenderedMinor: '1000',
						changeMinor: '1'
					}
				]
			}
		};
		// The line's unit price (999) differs from the item's stored 600. Raw
		// SQL because updateItem() would bump menu_version and the payload's
		// captured version would drift; the settings menu_version bump above
		// is enough to keep validateSale happy in stale_menu_price mode.
		await testDb().execute(sql`update menu_items set price_minor = 999 where id = ${fx.teaId}`);
		const result = await recordThrough(fx, env, fx.cashierId);
		const jLines = await entryLines(result.entryIds[0]);
		const byCode = Object.fromEntries(jLines.map((l) => [l.code, l]));
		expect(byCode['1000'].debit).toBe(999n);
		expect(byCode['4000'].credit).toBe(832n);
		expect(byCode['2100'].credit).toBe(167n);
	});
});
