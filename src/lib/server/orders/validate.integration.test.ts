import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { archivePaymentMethod, onRestaurantCreated, updateSettings } from '../restaurants';
import { registerDevice } from '../auth/pos-device';
import {
	archiveItem,
	archiveTaxRate,
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
import {
	cashMethodId,
	defaultTaxRateOf,
	seedPaymentMethod,
	seedTaxRate
} from '../db/test/settings';
import { closeTestDb, testDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { posSessions } from '../db/schema/pos-sessions';
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

	// settings-tax-payments-receipt T-15: a card tender is a named payment method
	// now, not the retired accepts_card switch.
	it('a card payload with no card method is tender_not_accepted; once one is seeded it validates', async () => {
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
		expect(before).toEqual({ ok: false, hard: 'invalid_payload', detail: 'tender_not_accepted' });
		await db.transaction((tx) =>
			seedPaymentMethod(tx, fx.restaurantId, { name: 'Visa terminal', kind: 'card' })
		);
		const after = await db.transaction((tx) => validateSale(tx, ctxFor(fx, fx.cashierId), env));
		expect(after.ok).toBe(true);
		if (after.ok) expect(after.sale.payment.paymentMethodName).toBe('Visa terminal');
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

describe('validateSale — named methods and rates (settings-tax-payments-receipt T-15)', () => {
	const ownerCtx = (f: Fixture) => ({ actorUserId: f.ownerId, ip: null, userAgent: null });

	const validate = (f: Fixture, env: Payload) =>
		db.transaction((tx) => validateSale(tx, ctxFor(f, f.cashierId), env));

	/** Every refusal below is a HARD invalid_payload unless the test says otherwise. */
	const invalid = (detail: string) => ({ ok: false, hard: 'invalid_payload', detail });

	/** `envelope(f)` — the 935 cash sale — with its payment's fields replaced by `patch`. */
	function cashWith(f: Fixture, patch: Record<string, unknown>): Payload {
		const env = envelope(f);
		const payload = env.payload as { payments: Record<string, unknown>[] };
		payload.payments = [{ ...payload.payments[0], ...patch }];
		return env;
	}

	/** The same 935 sale paid by card or mobile (no tendered, no change), plus `patch`. */
	function paidBy(
		f: Fixture,
		method: 'card' | 'mobile',
		patch: Record<string, unknown> = {}
	): Payload {
		return envelope(f, {
			payments: [
				{
					paymentId: randomUUID(),
					method,
					amountMinor: '935',
					tenderedMinor: null,
					changeMinor: null,
					...patch
				}
			]
		});
	}

	/** `envelope(f, overrides)` with its one Tea line's fields replaced by `patch`. */
	function lineWith(
		f: Fixture,
		patch: Record<string, unknown>,
		overrides: Record<string, unknown> = {}
	): Payload {
		const env = envelope(f, overrides);
		const payload = env.payload as { lines: Record<string, unknown>[] };
		payload.lines = [{ ...payload.lines[0], ...patch }];
		return env;
	}

	function seedMethod(
		f: Fixture,
		input: { name: string; kind: 'card' | 'mobile'; enabled?: boolean }
	): Promise<string> {
		return db.transaction((tx) => seedPaymentMethod(tx, f.restaurantId, input, ownerCtx(f)));
	}

	/** A second, unrelated restaurant: its ids must never resolve for `fx`. */
	const restaurantB = () => makeFixture(`validate-b-${randomUUID()}@example.com`);

	// MANDATORY (spec 29 — offline sync; invariant 5): the payload every till queued
	// before this plan sends carries none of the four keys. It still validates
	// clean: the payment is attributed to the built-in Cash row, and the line to
	// the default rate, because the line's 1000 equals that rate's number.
	it('a pre-plan payload (none of the four keys) validates on the Cash row and the default rate', async () => {
		const env = envelope(fx);
		const payload = env.payload as {
			lines: Record<string, unknown>[];
			payments: Record<string, unknown>[];
		};
		for (const key of ['taxRateId', 'taxRateName']) {
			expect(key in payload.lines[0], key).toBe(false);
		}
		for (const key of ['paymentMethodId', 'paymentMethodName']) {
			expect(key in payload.payments[0], key).toBe(false);
		}
		const cashId = await cashMethodId(testDb(), fx.restaurantId);
		const rate = await defaultTaxRateOf(testDb(), fx.restaurantId);
		expect(rate).not.toBeNull();

		const result = await validate(fx, env);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.softFlags).toEqual([]);
			expect(result.sale.payment).toEqual({
				paymentId: payload.payments[0].paymentId,
				method: 'cash',
				paymentMethodId: cashId,
				paymentMethodName: 'Cash',
				amountMinor: 935n,
				tenderedMinor: 1000n,
				changeMinor: 65n
			});
			expect(result.sale.lines[0].taxRateId).toBe(rate!.id);
			expect(result.sale.lines[0].taxRateName).toBe(rate!.name);
		}
	});

	// Cash.
	it("cash naming the Cash row's id and the name 'Cash' validates", async () => {
		const cashId = await cashMethodId(testDb(), fx.restaurantId);
		const result = await validate(
			fx,
			cashWith(fx, { paymentMethodId: cashId, paymentMethodName: 'Cash' })
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.softFlags).toEqual([]);
			expect(result.sale.payment).toMatchObject({
				method: 'cash',
				paymentMethodId: cashId,
				paymentMethodName: 'Cash'
			});
		}
	});

	it("the till's name wins, trimmed: '  Cash drawer  ' is stored as 'Cash drawer'", async () => {
		const cashId = await cashMethodId(testDb(), fx.restaurantId);
		const result = await validate(
			fx,
			cashWith(fx, { paymentMethodId: cashId, paymentMethodName: '  Cash drawer  ' })
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.sale.payment.paymentMethodId).toBe(cashId);
			expect(result.sale.payment.paymentMethodName).toBe('Cash drawer');
		}
	});

	it('cash naming a card method is payment_method_kind_mismatch', async () => {
		const visaId = await seedMethod(fx, { name: 'Visa terminal', kind: 'card' });
		expect(await validate(fx, cashWith(fx, { paymentMethodId: visaId }))).toEqual(
			invalid('payment_method_kind_mismatch')
		);
	});

	it("cash naming restaurant B's Cash row is unknown_payment_method", async () => {
		const b = await restaurantB();
		const foreignCashId = await cashMethodId(testDb(), b.restaurantId);
		expect(await validate(fx, cashWith(fx, { paymentMethodId: foreignCashId }))).toEqual(
			invalid('unknown_payment_method')
		);
	});

	it('cash naming an invented id is unknown_payment_method', async () => {
		expect(await validate(fx, cashWith(fx, { paymentMethodId: randomUUID() }))).toEqual(
			invalid('unknown_payment_method')
		);
	});

	// Card and mobile: they have not completed on the till yet, so a method that is
	// archived or switched off is refused (decision (f) — a 422 the till turns into
	// sale.abandoned).
	it('card naming an enabled card method validates with its id and name; once archived, tender_not_accepted', async () => {
		const visaId = await seedMethod(fx, { name: 'Visa terminal', kind: 'card' });
		const named = { paymentMethodId: visaId, paymentMethodName: 'Visa terminal' };
		const live = await validate(fx, paidBy(fx, 'card', named));
		expect(live.ok).toBe(true);
		if (live.ok) {
			expect(live.softFlags).toEqual([]);
			expect(live.sale.payment).toMatchObject({
				method: 'card',
				paymentMethodId: visaId,
				paymentMethodName: 'Visa terminal'
			});
		}

		const archived = await db.transaction((tx) =>
			archivePaymentMethod(tx, fx.restaurantId, visaId, ownerCtx(fx))
		);
		expect(archived).toEqual({ ok: true });
		expect(await validate(fx, paidBy(fx, 'card', named))).toEqual(invalid('tender_not_accepted'));
	});

	it('mobile naming a method seeded disabled is tender_not_accepted', async () => {
		const zaadId = await seedMethod(fx, { name: 'Zaad', kind: 'mobile', enabled: false });
		expect(
			await validate(
				fx,
				paidBy(fx, 'mobile', { paymentMethodId: zaadId, paymentMethodName: 'Zaad' })
			)
		).toEqual(invalid('tender_not_accepted'));
	});

	it('mobile on the wire naming a CARD method is payment_method_kind_mismatch', async () => {
		const visaId = await seedMethod(fx, { name: 'Visa terminal', kind: 'card' });
		expect(await validate(fx, paidBy(fx, 'mobile', { paymentMethodId: visaId }))).toEqual(
			invalid('payment_method_kind_mismatch')
		);
	});

	// sort_order decides, not the name: 'Amex terminal' sorts first by name, but it
	// was added second, so createPaymentMethod gave it the higher sort_order.
	it("a card payload with no id resolves to the first live, enabled card method by sort_order ('Visa terminal')", async () => {
		const visaId = await seedMethod(fx, { name: 'Visa terminal', kind: 'card' });
		await seedMethod(fx, { name: 'Amex terminal', kind: 'card' });
		const result = await validate(fx, paidBy(fx, 'card'));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.sale.payment.paymentMethodId).toBe(visaId);
			expect(result.sale.payment.paymentMethodName).toBe('Visa terminal');
		}
	});

	it('a mobile payload with no id and every mobile method disabled is tender_not_accepted', async () => {
		await seedMethod(fx, { name: 'EVC Plus', kind: 'mobile', enabled: false });
		await seedMethod(fx, { name: 'Zaad', kind: 'mobile', enabled: false });
		expect(await validate(fx, paidBy(fx, 'mobile'))).toEqual(invalid('tender_not_accepted'));
	});

	// Names: what the receipt printed, so the DB bounds (1–40) and no control
	// characters, which would command an ESC/POS printer on a reprint.
	it('a payment method name holding a control character is refused on paymentMethodName', async () => {
		const result = await validate(fx, paidBy(fx, 'mobile', { paymentMethodName: 'EVC\u001bPlus' }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('invalid_payload');
			expect(result.detail).toContain('paymentMethodName');
		}
	});

	it('a 41-character payment method name is refused on paymentMethodName', async () => {
		const result = await validate(fx, paidBy(fx, 'mobile', { paymentMethodName: 'E'.repeat(41) }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('invalid_payload');
			expect(result.detail).toContain('paymentMethodName');
		}
	});

	it('a tax rate name holding a control character is refused on taxRateName', async () => {
		const result = await validate(fx, lineWith(fx, { taxRateName: 'V\u0007AT' }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.hard).toBe('invalid_payload');
			expect(result.detail).toContain('taxRateName');
		}
	});

	// Rates.
	it("a line naming the default rate as 'VAT' stores that id and the SENT name", async () => {
		const result = await validate(
			fx,
			lineWith(fx, { taxRateId: fx.taxRateId, taxRateName: 'VAT' })
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.softFlags).toEqual([]);
			expect(result.sale.lines[0]).toMatchObject({ taxRateId: fx.taxRateId, taxRateName: 'VAT' });
		}
	});

	it("a line naming the default rate with no name stores the row's name", async () => {
		const result = await validate(fx, lineWith(fx, { taxRateId: fx.taxRateId }));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.softFlags).toEqual([]);
			expect(result.sale.lines[0]).toMatchObject({ taxRateId: fx.taxRateId, taxRateName: 'Tax' });
		}
	});

	it("a line naming restaurant B's default rate is unknown_tax_rate", async () => {
		const b = await restaurantB();
		expect(await validate(fx, lineWith(fx, { taxRateId: b.taxRateId }))).toEqual(
			invalid('unknown_tax_rate')
		);
	});

	it('a line naming an invented rate id is unknown_tax_rate', async () => {
		expect(await validate(fx, lineWith(fx, { taxRateId: randomUUID() }))).toEqual(
			invalid('unknown_tax_rate')
		);
	});

	// The id is compared, not only the number: 'Reduced' 10% is not the item's rate.
	it('another live rate with the same number: price_tamper at the current version, stale and kept at an older one', async () => {
		const reduced = await db.transaction((tx) =>
			createTaxRate(tx, fx.restaurantId, { name: 'Reduced', rateBp: 1000 }, ownerCtx(fx))
		);
		if (!reduced.ok) throw new Error(`fixture rate was not created: ${reduced.reason}`);
		const current = await getMenuVersion(testDb(), fx.restaurantId);
		expect(current).toBeGreaterThan(fx.menuVersion);

		const atCurrent = lineWith(fx, { taxRateId: reduced.id }, { menuVersion: current });
		const lineId = (atCurrent.payload as { lines: { lineId: string }[] }).lines[0].lineId;
		expect(await validate(fx, atCurrent)).toEqual({
			ok: false,
			hard: 'price_tamper',
			detail: `line:${lineId}:tax_rate`
		});

		const older = await validate(fx, lineWith(fx, { taxRateId: reduced.id }));
		expect(older.ok).toBe(true);
		if (older.ok) {
			expect(older.softFlags).toContain('stale_menu_price');
			expect(older.sale.lines[0]).toMatchObject({
				taxRateId: reduced.id,
				taxRateName: 'Reduced'
			});
		}
	});

	// Spec 6: a stale till's offline cash sale of an archived item, on that item's
	// archived rate, still validates clean and stores the rate.
	it('spec 6: an archived item on its archived rate still sells, storing that rate', async () => {
		const soda = await db.transaction((tx) =>
			createTaxRate(tx, fx.restaurantId, { name: 'Soda tax', rateBp: 500 }, ownerCtx(fx))
		);
		if (!soda.ok) throw new Error(`fixture rate was not created: ${soda.reason}`);
		const item = await db.transaction((tx) =>
			createItem(tx, fx.restaurantId, { name: 'Old soda', priceMinor: 300n, taxRateId: soda.id })
		);
		if (!item.ok) throw new Error(`fixture item was not created: ${item.reason}`);
		expect(await db.transaction((tx) => archiveItem(tx, fx.restaurantId, item.id))).toEqual({
			ok: true,
			changed: true
		});
		// Allowed: only an archived item uses the rate.
		expect(
			await db.transaction((tx) => archiveTaxRate(tx, fx.restaurantId, soda.id, ownerCtx(fx)))
		).toEqual({ ok: true });
		const version = await getMenuVersion(testDb(), fx.restaurantId);

		const env = envelope(fx, {
			menuVersion: version,
			lines: [
				{
					lineId: randomUUID(),
					lineNo: 1,
					menuItemId: item.id,
					itemName: 'Old soda',
					quantity: 1,
					unitPriceMinor: '300',
					taxRateBp: 500,
					taxRateId: soda.id,
					discountMinor: '0',
					modifiers: []
				}
			],
			totals: { subtotalMinor: '300', discountMinor: '0', taxMinor: '15', totalMinor: '315' },
			payments: [
				{
					paymentId: randomUUID(),
					method: 'cash',
					amountMinor: '315',
					tenderedMinor: '400',
					changeMinor: '85'
				}
			]
		});
		const result = await validate(fx, env);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.softFlags).toEqual([]);
			expect(result.sale.lines[0]).toMatchObject({ taxRateId: soda.id, taxRateName: 'Soda tax' });
		}
	});

	// A pre-plan line is attributed to the item's rate ONLY when it was taxed at
	// that rate's number: at 900 against the default's 1000 it keeps no id.
	it('inference only when the number matches: a pre-plan line at 900 stores no rate id and no name', async () => {
		const result = await validate(
			fx,
			oneLineCash(fx, { id: fx.teaId, name: 'Tea', priceMinor: 850n }, 900, fx.menuVersion - 1)
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.softFlags).toContain('stale_menu_price');
			expect(result.sale.lines[0].taxRateId).toBeNull();
			expect(result.sale.lines[0].taxRateName).toBeNull();
		}
	});
});
