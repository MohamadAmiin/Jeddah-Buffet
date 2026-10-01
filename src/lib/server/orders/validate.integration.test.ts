import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { onRestaurantCreated, updateSettings } from '../restaurants';
import { registerDevice } from '../auth/pos-device';
import {
	createCategory,
	createItem,
	createModifierGroup,
	createModifier,
	createTaxRate,
	linkModifierGroup,
	readMenuSnapshot,
	updateItem,
	updateTaxRate,
	getMenuVersion
} from '../menu';
import { seedStaff } from '../db/test/seed';
import { seedTaxRate } from '../db/test/settings';
import { closeTestDb, testDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { posSessions } from '../db/schema/pos-sessions';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { validateSale, type SyncContext } from './validate';
import type { OpEnvelope } from '../../sync-ops';
import { minor, ROUNDING_RULE } from '../../money';
import { computeOrderTotals, serializeTotals } from '../../money/order-totals';
import { changeDue } from '../../money/change';

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
	oatMilkId: string;
	syrupId: string;
	cashierId: string;
	waiterId: string;
	menuVersion: number;
	/** The named default rate ('Tax' 10%, T-13), or null when the fixture has none. */
	taxRateId: string | null;
};

async function makeFixture(
	email = 'validate@example.com',
	opts: { defaultRate?: boolean } = {}
): Promise<Fixture> {
	const [r] = await testDb().insert(restaurants).values({ name: 'Cafe Val' }).returning({
		id: restaurants.id
	});
	const restaurantId = r.id;
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, restaurantId, { restaurantName: 'Cafe Val', timeZone: 'UTC' })
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

	// T-13: 'Tax' 10% is the named default unless the test asks for no rate at all.
	const taxRateId = await db.transaction(async (tx) => {
		const ctx = { actorUserId: ownerId, ip: null, userAgent: null };
		const id =
			opts.defaultRate === false
				? null
				: await seedTaxRate(tx, restaurantId, { rateBp: 1000, makeDefault: true }, ctx);
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

	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId, actorUserId: ownerId, label: 'Counter tablet' })
	);
	const deviceId = device.deviceId;
	const deviceCode = device.deviceCode;

	// Menu: category, Tea item, Milk group linked to Tea with Oat milk; Extras group NOT linked with Syrup.
	async function requireId<T>(p: Promise<T | { ok: false; reason?: string }>): Promise<string> {
		const r = (await p) as { ok: boolean; id?: string; reason?: string };
		if (!r.ok || typeof r.id !== 'string') {
			throw new Error(`menu helper returned ${JSON.stringify(r)}`);
		}
		return r.id;
	}
	const categoryId = await db.transaction((tx) =>
		requireId(createCategory(tx, restaurantId, { name: 'Drinks' }))
	);
	const teaId = await db.transaction((tx) =>
		requireId(createItem(tx, restaurantId, { categoryId, name: 'Tea', priceMinor: 850n }))
	);
	const milkGroupId = await db.transaction((tx) =>
		requireId(createModifierGroup(tx, restaurantId, { name: 'Milk', minSelect: 0, maxSelect: 1 }))
	);
	const oatMilkId = await db.transaction((tx) =>
		requireId(
			createModifier(tx, restaurantId, {
				groupId: milkGroupId,
				name: 'Oat milk',
				priceDeltaMinor: 50n
			})
		)
	);
	await db.transaction((tx) => linkModifierGroup(tx, restaurantId, teaId, milkGroupId, 1));
	const extrasGroupId = await db.transaction((tx) =>
		requireId(createModifierGroup(tx, restaurantId, { name: 'Extras', minSelect: 0, maxSelect: 1 }))
	);
	const syrupId = await db.transaction((tx) =>
		requireId(
			createModifier(tx, restaurantId, {
				groupId: extrasGroupId,
				name: 'Syrup',
				priceDeltaMinor: 100n
			})
		)
	);

	const [session] = await testDb()
		.insert(posSessions)
		.values({
			restaurantId,
			deviceId,
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
		deviceId,
		deviceCode,
		sessionId: session.id,
		teaId,
		oatMilkId,
		syrupId,
		cashierId: cashier.id,
		waiterId: waiter.id,
		menuVersion,
		taxRateId
	};
}

function ctxFor(f: Fixture, employeeId: string, occurredAt = new Date()): SyncContext {
	return {
		restaurantId: f.restaurantId,
		cookieDeviceId: f.deviceId,
		opDeviceId: f.deviceId,
		opDeviceCode: f.deviceCode,
		employeeId,
		employeeUserId: employeeId,
		clientOpId: randomUUID(),
		occurredAt,
		receivedAt: new Date(),
		ip: null,
		userAgent: null
	};
}

type Payload = OpEnvelope<'sale.complete', unknown>;

function envelope(f: Fixture, overrides: Record<string, unknown> = {}): Payload {
	const base = {
		orderId: randomUUID(),
		posSessionId: f.sessionId,
		orderType: 'takeaway',
		tableLabel: null,
		taxMode: 'exclusive',
		currencyCode: 'USD',
		menuVersion: f.menuVersion,
		invoiceSeq: 1,
		invoiceNumber: `${f.deviceCode}-000001`,
		openedAt: new Date().toISOString(),
		lines: [
			{
				lineId: randomUUID(),
				lineNo: 1,
				menuItemId: f.teaId,
				itemName: 'Tea',
				quantity: 1,
				unitPriceMinor: '850',
				taxRateBp: 1000,
				discountMinor: '0',
				modifiers: [] as unknown[]
			}
		],
		totals: {
			subtotalMinor: '850',
			discountMinor: '0',
			taxMinor: '85',
			totalMinor: '935'
		},
		payments: [
			{
				paymentId: randomUUID(),
				method: 'cash',
				amountMinor: '935',
				tenderedMinor: '1000',
				changeMinor: '65'
			}
		]
	};
	const payload = { ...base, ...overrides };
	return {
		kind: 'sale.complete',
		clientOpId: randomUUID(),
		deviceId: f.deviceId,
		employeeId: 'ignored',
		occurredAt: new Date().toISOString(),
		seq: 1,
		payload
	} as Payload;
}

/**
 * A one-line cash sale of `item` at `taxRateBp` and `menuVersion`, totalled by the
 * money module exactly as the till totals it (computeOrderTotals + serializeTotals),
 * paid with a 100.00 note and the change changeDue computes.
 */
function oneLineCash(
	f: Fixture,
	item: { id: string; name: string; priceMinor: bigint },
	taxRateBp: number,
	menuVersion: number
): Payload {
	const totals = serializeTotals(
		computeOrderTotals(
			{
				taxMode: 'exclusive',
				lines: [
					{
						unitPriceMinor: minor(item.priceMinor),
						quantity: 1n,
						modifierDeltasMinor: [],
						taxRateBp,
						discountMinor: minor(0n)
					}
				]
			},
			ROUNDING_RULE
		)
	);
	const tendered = 10_000n;
	return envelope(f, {
		menuVersion,
		lines: [
			{
				lineId: randomUUID(),
				lineNo: 1,
				menuItemId: item.id,
				itemName: item.name,
				quantity: 1,
				unitPriceMinor: item.priceMinor.toString(),
				taxRateBp,
				discountMinor: '0',
				modifiers: []
			}
		],
		totals,
		payments: [
			{
				paymentId: randomUUID(),
				method: 'cash',
				amountMinor: totals.totalMinor,
				tenderedMinor: tendered.toString(),
				changeMinor: changeDue(minor(tendered), minor(BigInt(totals.totalMinor))).toString()
			}
		]
	});
}

let fx: Fixture;
beforeEach(async () => {
	fx = await makeFixture();
});

describe('validateSale (T-18)', () => {
	it('accepts a well-formed cash sale by a cashier', async () => {
		const result = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), envelope(fx))
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.softFlags).toEqual([]);
			expect(result.sale.totals.totalMinor).toBe(935n);
			expect(result.sale.session.businessDate).toBe('2026-09-28');
		}
	});

	it('rejects a non-zero line discount as invalid_payload', async () => {
		const env = envelope(fx);
		(env.payload as { lines: { discountMinor: string }[] }).lines[0].discountMinor = '5';
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('invalid_payload');
			expect(result.detail).toContain('discountMinor');
		}
	});

	it('rejects zero quantity as invalid_payload', async () => {
		const env = envelope(fx);
		(env.payload as { lines: { quantity: number }[] }).lines[0].quantity = 0;
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(false);
	});

	// menu-and-printing T-09: delivery is a tag paid at the till, exactly like
	// takeaway — the validator adds no rule tying the table label to the type.
	it('accepts a delivery sale', async () => {
		const result = await db.transaction((tx) =>
			validateSale(
				tx,
				ctxFor(fx, fx.cashierId),
				envelope(fx, { orderType: 'delivery', tableLabel: null })
			)
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.sale.orderType).toBe('delivery');
			expect(result.sale.tableLabel).toBeNull();
			expect(result.softFlags).toEqual([]);
		}
	});

	// MANDATORY (invariant 5 — an offline sale is a fact): the format every till
	// queued before menu-and-printing T-22 — no `note` key at all — still records.
	it('a payload with no note key validates with note null', async () => {
		const env = envelope(fx);
		expect('note' in (env.payload as object)).toBe(false);
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.sale.note).toBeNull();
	});

	it("a note is cleaned: 'no\\u001bchilli' → 'no chilli'; a blank one becomes null", async () => {
		const cleaned = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), envelope(fx, { note: 'no\u001bchilli' }))
		);
		expect(cleaned.ok).toBe(true);
		if (cleaned.ok) expect(cleaned.sale.note).toBe('no chilli');
		const blank = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), envelope(fx, { note: '   ' }))
		);
		expect(blank.ok).toBe(true);
		if (blank.ok) expect(blank.sale.note).toBeNull();
	});

	it('a 141-character note is invalid_payload', async () => {
		const result = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), envelope(fx, { note: 'x'.repeat(141) }))
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.hard).toBe('invalid_payload');
	});

	it('an unknown order type is invalid_payload', async () => {
		const result = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), envelope(fx, { orderType: 'home_delivery' }))
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('invalid_payload');
			expect(result.detail).toContain('orderType');
		}
	});

	it('flags a price at the SAME menu version as price_tamper', async () => {
		const env = envelope(fx, {
			lines: [
				{
					lineId: randomUUID(),
					lineNo: 1,
					menuItemId: fx.teaId,
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: '1',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: []
				}
			],
			totals: { subtotalMinor: '1', discountMinor: '0', taxMinor: '0', totalMinor: '1' },
			payments: [
				{
					paymentId: randomUUID(),
					method: 'cash',
					amountMinor: '1',
					tenderedMinor: '1',
					changeMinor: '0'
				}
			]
		});
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('price_tamper');
			expect(result.detail).toContain('unit_price');
		}
	});

	it('a differing price at an OLDER menu version is stale_menu_price (soft)', async () => {
		const oldVersion = await getMenuVersion(testDb(), fx.restaurantId);
		await db.transaction((tx) =>
			updateItem(
				tx,
				fx.restaurantId,
				fx.teaId,
				{ priceMinor: 900n },
				{ actorUserId: fx.ownerId, ip: null, userAgent: null }
			)
		);
		const env = envelope(fx, { menuVersion: oldVersion });
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.softFlags).toContain('stale_menu_price');
	});

	it('a totals mismatch is a soft flag; the sale is still parsed', async () => {
		const env = envelope(fx, {
			totals: { subtotalMinor: '850', discountMinor: '0', taxMinor: '86', totalMinor: '936' },
			payments: [
				{
					paymentId: randomUUID(),
					method: 'cash',
					amountMinor: '936',
					tenderedMinor: '1000',
					changeMinor: '64'
				}
			]
		});
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.softFlags).toContain('totals_mismatch');
	});

	it('an unknown menu item lands as unknown_item', async () => {
		const env = envelope(fx);
		const alien = randomUUID();
		(env.payload as { lines: { menuItemId: string }[] }).lines[0].menuItemId = alien;
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('unknown_item');
			expect(result.detail).toBe(alien);
		}
	});

	it('a modifier from a group NOT linked to the item is unknown_modifier', async () => {
		const env = envelope(fx, {
			lines: [
				{
					lineId: randomUUID(),
					lineNo: 1,
					menuItemId: fx.teaId,
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: '850',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: [
						{
							modifierId: fx.syrupId,
							modifierName: 'Syrup',
							priceDeltaMinor: '100'
						}
					]
				}
			],
			totals: {
				subtotalMinor: '950',
				discountMinor: '0',
				taxMinor: '95',
				totalMinor: '1045'
			},
			payments: [
				{
					paymentId: randomUUID(),
					method: 'cash',
					amountMinor: '1045',
					tenderedMinor: '2000',
					changeMinor: '955'
				}
			]
		});
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('unknown_modifier');
			expect(result.detail).toContain(fx.syrupId);
		}
	});

	it('a linked modifier is accepted', async () => {
		const env = envelope(fx, {
			lines: [
				{
					lineId: randomUUID(),
					lineNo: 1,
					menuItemId: fx.teaId,
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: '850',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: [
						{
							modifierId: fx.oatMilkId,
							modifierName: 'Oat milk',
							priceDeltaMinor: '50'
						}
					]
				}
			],
			totals: {
				subtotalMinor: '900',
				discountMinor: '0',
				taxMinor: '90',
				totalMinor: '990'
			},
			payments: [
				{
					paymentId: randomUUID(),
					method: 'cash',
					amountMinor: '990',
					tenderedMinor: '1000',
					changeMinor: '10'
				}
			]
		});
		const result = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(result.ok).toBe(true);
	});

	it('card without accepts_card set is invalid_payload; after opting in it passes', async () => {
		const env = envelope(fx, {
			payments: [
				{
					paymentId: randomUUID(),
					method: 'card',
					amountMinor: '935',
					tenderedMinor: null,
					changeMinor: null
				}
			]
		});
		const before = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(before.ok).toBe(false);
		if (!before.ok) {
			expect(before.hard).toBe('invalid_payload');
			expect(before.detail).toBe('tender_not_accepted');
		}
		await testDb()
			.update(restaurantSettings)
			.set({ acceptsCard: true })
			.where(eq(restaurantSettings.restaurantId, fx.restaurantId));
		const after = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(after.ok).toBe(true);
	});

	it('a clock ahead by more than 5 minutes soft-flags clock_ahead', async () => {
		const future = new Date(Date.now() + 10 * 60 * 1000);
		const result = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId, future), envelope(fx))
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.softFlags).toContain('clock_ahead');
	});

	it('a waiter soft-flags employee_not_permitted; a random uuid soft-flags employee_unknown', async () => {
		const wr = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.waiterId), envelope(fx))
		);
		expect(wr.ok).toBe(true);
		if (wr.ok) expect(wr.softFlags).toContain('employee_not_permitted');

		const unk = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, randomUUID()), envelope(fx))
		);
		expect(unk.ok).toBe(true);
		if (unk.ok) expect(unk.softFlags).toContain('employee_unknown');
	});

	it('a mismatched invoice number is invoice_number_mismatch; an unknown session is unknown_session', async () => {
		const badNumber = envelope(fx, { invoiceNumber: 'POS9-000001' });
		const bnRes = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), badNumber)
		);
		expect(bnRes.ok).toBe(false);
		if (!bnRes.ok) expect(bnRes.detail).toBe('invoice_number_mismatch');

		const badSession = envelope(fx, { posSessionId: randomUUID() });
		const bsRes = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), badSession)
		);
		expect(bsRes.ok).toBe(false);
		if (!bsRes.ok) expect(bsRes.hard).toBe('unknown_session');
	});

	it('a closed session soft-flags session_closed', async () => {
		await testDb()
			.update(posSessions)
			.set({
				status: 'closed',
				closedAt: new Date(),
				closedByUserId: fx.ownerId,
				closedFromDeviceId: fx.deviceId,
				countedCashMinor: 0n,
				expectedCashMinor: 0n,
				differenceMinor: 0n
			})
			.where(eq(posSessions.id, fx.sessionId));
		const result = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), envelope(fx))
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.softFlags).toContain('session_closed');
	});
});

describe('validateSale — named tax rates (T-13)', () => {
	const ctx = (f: Fixture) => ({ actorUserId: f.ownerId, ip: null, userAgent: null });
	const tea = (f: Fixture) => ({ id: f.teaId, name: 'Tea', priceMinor: 850n });

	async function reducedRate(f: Fixture): Promise<string> {
		const created = await db.transaction((tx) =>
			createTaxRate(tx, f.restaurantId, { name: 'Reduced', rateBp: 500 }, ctx(f))
		);
		if (!created.ok) throw new Error(`fixture rate was not created: ${created.reason}`);
		return created.id;
	}

	// The rule is written twice — readMenuSnapshot (menu/) and validateSale's Step 8
	// (orders/, which may not import menu/). This pins the two copies together: a
	// till that charges exactly what the snapshot says is never flagged.
	it('validator and snapshot agree: every snapshot item at its resolved rate validates clean', async () => {
		const reducedId = await reducedRate(fx);
		const water = await db.transaction((tx) =>
			createItem(tx, fx.restaurantId, { name: 'Water', priceMinor: 100n, taxRateId: reducedId })
		);
		if (!water.ok) throw new Error('fixture item was not created');

		const snapshot = await readMenuSnapshot(testDb(), fx.restaurantId);
		expect(
			snapshot.items.map((item) => [item.name, item.taxRate?.name, item.taxRate?.rateBp])
		).toEqual([
			['Tea', 'Tax', 1000],
			['Water', 'Reduced', 500]
		]);
		for (const item of snapshot.items) {
			const result = await db.transaction((tx) =>
				validateSale(
					tx,
					ctxFor(fx, fx.cashierId),
					oneLineCash(fx, item, item.taxRate!.rateBp, snapshot.version)
				)
			);
			expect(result.ok, item.name).toBe(true);
			if (result.ok) expect(result.softFlags, item.name).toEqual([]);
		}
	});

	// Risk 4: a rate edit bumps the version, so the till's older sale at the old
	// rate is a SOFT stale_menu_price — never a HARD price_tamper left unrecorded.
	it('a rate edit is stale at the old version, tamper at the new one, clean at the new rate', async () => {
		const oldVersion = fx.menuVersion;
		const edited = await db.transaction((tx) =>
			updateTaxRate(tx, fx.restaurantId, fx.taxRateId!, { rateBp: 1100 }, ctx(fx))
		);
		expect(edited).toEqual({ ok: true, changed: true });
		const newVersion = await getMenuVersion(testDb(), fx.restaurantId);
		expect(newVersion).toBe(oldVersion + 1);

		const stale = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), oneLineCash(fx, tea(fx), 1000, oldVersion))
		);
		expect(stale.ok).toBe(true);
		if (stale.ok) expect(stale.softFlags).toContain('stale_menu_price');

		const tamper = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), oneLineCash(fx, tea(fx), 1000, newVersion))
		);
		expect(tamper.ok).toBe(false);
		if (!tamper.ok) {
			expect(tamper.hard).toBe('price_tamper');
			expect(tamper.detail.endsWith(':tax_rate')).toBe(true);
		}

		const clean = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), oneLineCash(fx, tea(fx), 1100, newVersion))
		);
		expect(clean.ok).toBe(true);
		if (clean.ok) expect(clean.softFlags).toEqual([]);
	});

	it('switching the default makes an old-version sale at the old rate stale, not tamper', async () => {
		const reducedId = await reducedRate(fx);
		const oldVersion = await getMenuVersion(testDb(), fx.restaurantId);
		const switched = await db.transaction((tx) =>
			updateSettings(tx, fx.restaurantId, { defaultTaxRateId: reducedId }, ctx(fx))
		);
		expect(switched.ok).toBe(true);
		expect(await getMenuVersion(testDb(), fx.restaurantId)).toBe(oldVersion + 1);

		const result = await db.transaction((tx) =>
			validateSale(tx, ctxFor(fx, fx.cashierId), oneLineCash(fx, tea(fx), 1000, oldVersion))
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.softFlags).toContain('stale_menu_price');
	});

	// Risk 5: no rate resolves — no default, no rate on the item — and nothing falls
	// back to a number, so at the SAME version the line's rate is a HARD difference.
	it('with no default and no item rate, a sale at the same version is HARD price_tamper', async () => {
		const bare = await makeFixture(`validate-no-rate-${randomUUID()}@example.com`, {
			defaultRate: false
		});
		expect(bare.taxRateId).toBeNull();
		const snapshot = await readMenuSnapshot(testDb(), bare.restaurantId);
		expect(snapshot.defaultTaxRate).toBeNull();
		expect(snapshot.items.every((item) => item.taxRate === null)).toBe(true);

		const result = await db.transaction((tx) =>
			validateSale(tx, ctxFor(bare, bare.cashierId), envelope(bare))
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('price_tamper');
			expect(result.detail.endsWith(':tax_rate')).toBe(true);
		}
	});
});
