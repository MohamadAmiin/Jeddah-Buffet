// Shared fixture for the reports/ integration tests.
//
// seedSalesRestaurant builds a full restaurant (settings, roles, chart of
// accounts, the built-in Cash plus one card and one mobile payment method,
// owner, one staff, one device, a small menu with a modifier); the
// three helpers below drive T-20's session and T-21's sale.complete envelope
// through recordSale, exactly the way the server sync path does. All money on
// the wire is a decimal string, in bigint after that. saleEnvelope sends the
// payment's method id and name and each line's rate id and name by default
// (settings-tax-payments-receipt T-16); `omitIds` builds the pre-plan payload.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { restaurants } from '../schema/restaurants';
import { restaurantSettings } from '../schema/restaurant-settings';
import { users } from '../schema/users';
import { onRestaurantCreated, updateSettings, type UpdateSettingsContext } from '../../restaurants';
import { registerDevice } from '../../auth/pos-device';
import {
	createCategory,
	createItem,
	createModifier,
	createModifierGroup,
	linkModifierGroup
} from '../../menu';
import { seedStaff } from './seed';
import { cashMethodId, defaultTaxRateOf, seedPaymentMethod, seedTaxRate } from './settings';
import { openSession, closeSession, type SessionContext } from '../../pos-sessions';
import { validateSale, type SyncContext } from '../../orders/validate';
import { recordSale } from '../../orders/pay';
import { handleOp } from '../../orders/sync';
import type { PosDeviceContext } from '../../auth/pos-context';
import { minor, ROUNDING_RULE } from '../../../money';
import { computeOrderTotals, serializeTotals } from '../../../money/order-totals';
import { changeDue } from '../../../money/change';
import {
	formatInvoiceNumber,
	type OpEnvelope,
	type OpKind,
	type OrderType
} from '../../../sync-ops';
import type { TaxMode } from '../../../money/tax';

export type SalesFixture = {
	restaurantId: string;
	ownerId: string;
	staffId: string;
	deviceId: string;
	deviceCode: string;
	/** The device cookie's value, for driving the real /api/pos/* handlers. */
	deviceToken: string;
	menuVersion: number;
	taxMode: TaxMode;
	/** The default rate's number — what the line builder below charges (T-13). */
	taxRateBp: number;
	/** The named default rate (T-16): saleEnvelope sends its id and name on every
	 * line unless a line names its own. */
	defaultTaxRate: { id: string; name: string };
	currencyCode: 'USD';
	/** One method per KIND (T-15): the built-in Cash row, 'Card' and 'Mobile money'. */
	paymentMethods: Record<'cash' | 'card' | 'mobile', { id: string; name: string }>;
	items: { burger: string; tea: string; special: string };
	modifiers: { extraCheese: string };
};

export type SeedSalesOptions = {
	taxMode?: TaxMode;
	taxRateBp?: number;
	timeZone?: string;
	restaurantName?: string;
	ownerEmail?: string;
};

async function requireId<T>(p: Promise<T | { ok: false; reason: string }>): Promise<string> {
	const r = (await p) as { ok?: boolean; id?: string; reason?: string };
	if (r.ok === false || typeof r.id !== 'string') {
		throw new Error(`menu helper failed: ${r.reason ?? '(no id)'}`);
	}
	return r.id;
}

export async function seedSalesRestaurant(
	database: Db,
	opts: SeedSalesOptions = {}
): Promise<SalesFixture> {
	const taxMode: TaxMode = opts.taxMode ?? 'exclusive';
	const taxRateBp = opts.taxRateBp ?? 1000;
	const timeZone = opts.timeZone ?? 'Africa/Mogadishu';
	const restaurantName = opts.restaurantName ?? `Sales ${randomUUID().slice(0, 8)}`;
	const ownerEmail = opts.ownerEmail ?? `sales-${randomUUID()}@example.com`;

	return database.transaction(async (tx) => {
		const [r] = await tx.insert(restaurants).values({ name: restaurantName }).returning({
			id: restaurants.id
		});
		const restaurantId = r.id;

		await onRestaurantCreated(tx, restaurantId, { restaurantName, timeZone });

		const ctx: UpdateSettingsContext = { actorUserId: null, ip: null, userAgent: null };
		// T-13: the rate is a named default ('Tax'); every item below inherits it.
		await seedTaxRate(tx, restaurantId, { rateBp: taxRateBp, makeDefault: true }, ctx);
		const settingsResult = await updateSettings(
			tx,
			restaurantId,
			{
				taxMode,
				currencyCode: 'USD',
				posIdleLockSeconds: 120
			},
			ctx
		);
		if (!settingsResult.ok) {
			throw new Error(`updateSettings failed: ${settingsResult.reason}`);
		}
		// T-15: card and mobile are named payment methods now, not the retired
		// accepts_card / accepts_mobile switches; Cash is built in (seedCashMethod).
		const cardMethodId = await seedPaymentMethod(
			tx,
			restaurantId,
			{ name: 'Card', kind: 'card' },
			ctx
		);
		const mobileMethodId = await seedPaymentMethod(
			tx,
			restaurantId,
			{ name: 'Mobile money', kind: 'mobile' },
			ctx
		);
		// T-16: the default rate's id and name, which saleEnvelope sends on each line.
		const defaultRate = await defaultTaxRateOf(tx, restaurantId);
		if (defaultRate === null) {
			throw new Error('seedSalesRestaurant: the restaurant has no default tax rate');
		}

		const [owner] = await tx
			.insert(users)
			.values({
				restaurantId,
				role: 'owner',
				displayName: 'Owner',
				email: ownerEmail,
				passwordHash: 'not-a-real-hash'
			})
			.returning({ id: users.id });

		const staff = await seedStaff(tx, restaurantId, {
			displayName: 'Sam',
			roleName: 'Cashier'
		});

		const device = await registerDevice(tx, {
			restaurantId,
			actorUserId: owner.id,
			label: 'Counter tablet'
		});

		const foodId = await requireId(createCategory(tx, restaurantId, { name: 'Food' }));
		const drinksId = await requireId(createCategory(tx, restaurantId, { name: 'Drinks' }));

		const burgerId = await requireId(
			createItem(tx, restaurantId, { categoryId: foodId, name: 'Burger', priceMinor: 800n })
		);
		const teaId = await requireId(
			createItem(tx, restaurantId, { categoryId: drinksId, name: 'Tea', priceMinor: 200n })
		);
		const specialId = await requireId(
			createItem(tx, restaurantId, { categoryId: foodId, name: 'Special', priceMinor: 999n })
		);

		const extrasGroupId = await requireId(
			createModifierGroup(tx, restaurantId, { name: 'Extras' })
		);
		const extraCheeseId = await requireId(
			createModifier(tx, restaurantId, {
				groupId: extrasGroupId,
				name: 'Extra cheese',
				priceDeltaMinor: 50n
			})
		);
		await linkModifierGroup(tx, restaurantId, burgerId, extrasGroupId, 0);

		const [settingsRow] = await tx
			.select({ menuVersion: restaurantSettings.menuVersion })
			.from(restaurantSettings)
			.where(eq(restaurantSettings.restaurantId, restaurantId));
		const menuVersion = settingsRow.menuVersion;

		return {
			restaurantId,
			ownerId: owner.id,
			staffId: staff.id,
			deviceId: device.deviceId,
			deviceCode: device.deviceCode,
			deviceToken: device.token,
			menuVersion,
			taxMode,
			taxRateBp,
			defaultTaxRate: { id: defaultRate.id, name: defaultRate.name },
			currencyCode: 'USD' as const,
			paymentMethods: {
				cash: { id: await cashMethodId(tx, restaurantId), name: 'Cash' },
				card: { id: cardMethodId, name: 'Card' },
				mobile: { id: mobileMethodId, name: 'Mobile money' }
			},
			items: { burger: burgerId, tea: teaId, special: specialId },
			modifiers: { extraCheese: extraCheeseId }
		};
	});
}

/** A second registered device: one device holds at most one open session, so a
 * session that must stay open alongside another needs its own till. */
export async function withSecondDevice(database: Db, f: SalesFixture): Promise<SalesFixture> {
	const device = await database.transaction((tx) =>
		registerDevice(tx, {
			restaurantId: f.restaurantId,
			actorUserId: f.ownerId,
			label: 'Second tablet'
		})
	);
	return {
		...f,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode,
		deviceToken: device.token
	};
}

export function syncContext(
	f: SalesFixture,
	o: { clientOpId: string; occurredAt: Date; employeeId?: string }
): SyncContext {
	return {
		restaurantId: f.restaurantId,
		cookieDeviceId: f.deviceId,
		opDeviceId: f.deviceId,
		opDeviceCode: f.deviceCode,
		employeeId: o.employeeId ?? f.staffId,
		employeeUserId: o.employeeId ?? f.staffId,
		clientOpId: o.clientOpId,
		occurredAt: o.occurredAt,
		receivedAt: o.occurredAt,
		ip: '203.0.113.5',
		userAgent: 'vitest'
	};
}

function toSessionContext(sc: SyncContext): SessionContext {
	return { ...sc };
}

export async function openSessionAt(
	database: Db,
	f: SalesFixture,
	o: {
		posSessionId: string;
		openedAt: Date;
		openingCashMinor: bigint;
		employeeId?: string;
	}
): Promise<{ posSessionId: string; businessDate: string }> {
	return database.transaction(async (tx) => {
		const ctx = syncContext(f, {
			clientOpId: randomUUID(),
			occurredAt: o.openedAt,
			employeeId: o.employeeId
		});
		const result = await openSession(tx, toSessionContext(ctx), {
			posSessionId: o.posSessionId,
			openingCashMinor: minor(o.openingCashMinor)
		});
		return { posSessionId: result.posSessionId, businessDate: result.businessDate };
	});
}

export async function closeSessionAt(
	database: Db,
	f: SalesFixture,
	o: {
		posSessionId: string;
		closedAt: Date;
		countedCashMinor: bigint;
		employeeId?: string;
	}
): Promise<void> {
	await database.transaction(async (tx) => {
		const ctx = syncContext(f, {
			clientOpId: randomUUID(),
			occurredAt: o.closedAt,
			employeeId: o.employeeId
		});
		await closeSession(tx, toSessionContext(ctx), {
			posSessionId: o.posSessionId,
			countedCashMinor: minor(o.countedCashMinor)
		});
	});
}

export type RecordSaleLine = {
	menuItemId: string;
	itemName: string;
	quantity: number;
	unitPriceMinor: bigint;
	taxRateBp: number;
	/** The named rate the line was taxed under (T-16); defaults to the fixture's
	 * default rate. Not sent at all with `omitIds`. */
	taxRateId?: string | null;
	taxRateName?: string | null;
	modifiers?: { modifierId: string; modifierName: string; priceDeltaMinor: bigint }[];
};

export type RecordSaleOptions = {
	posSessionId: string;
	occurredAt: Date;
	invoiceSeq: number;
	method: 'cash' | 'card' | 'mobile';
	orderType: OrderType;
	tableLabel: string | null;
	/** Written into the payload ONLY when present, so the fixture can still
	 * produce the pre-T-22 format (no `note` key at all). */
	note?: string | null;
	employeeId?: string;
	/** The named method that took the payment (T-16); it must be of kind `method`.
	 * Defaults to the fixture's method of that kind. Not sent at all with `omitIds`. */
	paymentMethod?: { id: string; name: string };
	/** The pre-plan payload format (settings-tax-payments-receipt T-14): none of the
	 * four optional keys — the payment's method id and name, each line's rate id and
	 * name — is written into the payload. */
	omitIds?: boolean;
	lines: RecordSaleLine[];
};

export function saleEnvelope(
	f: SalesFixture,
	o: RecordSaleOptions
): OpEnvelope<'sale.complete', unknown> {
	const linesForTotals = o.lines.map((l) => ({
		unitPriceMinor: minor(l.unitPriceMinor),
		quantity: BigInt(l.quantity),
		taxRateBp: l.taxRateBp,
		discountMinor: minor(0n),
		modifierDeltasMinor: (l.modifiers ?? []).map((m) => minor(m.priceDeltaMinor))
	}));
	const totals = computeOrderTotals({ taxMode: f.taxMode, lines: linesForTotals }, ROUNDING_RULE);
	const serialised = serializeTotals(totals);
	const orderId = randomUUID();
	const payloadLines = o.lines.map((l, i) => ({
		lineId: randomUUID(),
		lineNo: i + 1,
		menuItemId: l.menuItemId,
		itemName: l.itemName,
		quantity: l.quantity,
		unitPriceMinor: l.unitPriceMinor.toString(),
		taxRateBp: l.taxRateBp,
		// Spread conditionally, as `note` is: with omitIds the keys are absent.
		...(o.omitIds
			? {}
			: {
					taxRateId: l.taxRateId ?? f.defaultTaxRate.id,
					taxRateName: l.taxRateName ?? f.defaultTaxRate.name
				}),
		discountMinor: '0',
		modifiers: (l.modifiers ?? []).map((m) => ({
			modifierId: m.modifierId,
			modifierName: m.modifierName,
			priceDeltaMinor: m.priceDeltaMinor.toString()
		}))
	}));
	const totalMinor = BigInt(serialised.totalMinor);
	let tenderedMinor: string | null = null;
	let changeMinor: string | null = null;
	if (o.method === 'cash') {
		const rounded = ((totalMinor + 99n) / 100n) * 100n; // next whole major unit
		const tendered = rounded < 100n ? 100n : rounded;
		tenderedMinor = tendered.toString();
		changeMinor = changeDue(minor(tendered), minor(totalMinor)).toString();
	}
	const paymentMethod = o.paymentMethod ?? f.paymentMethods[o.method];
	const payment = {
		paymentId: randomUUID(),
		method: o.method,
		...(o.omitIds
			? {}
			: { paymentMethodId: paymentMethod.id, paymentMethodName: paymentMethod.name }),
		amountMinor: serialised.totalMinor,
		tenderedMinor,
		changeMinor
	};
	const openedAt = new Date(o.occurredAt.getTime() - 10 * 60 * 1000);
	return {
		kind: 'sale.complete',
		clientOpId: randomUUID(),
		deviceId: f.deviceId,
		employeeId: o.employeeId ?? f.staffId,
		occurredAt: o.occurredAt.toISOString(),
		seq: o.invoiceSeq,
		payload: {
			orderId,
			posSessionId: o.posSessionId,
			orderType: o.orderType,
			tableLabel: o.tableLabel,
			...('note' in o ? { note: o.note } : {}),
			taxMode: f.taxMode,
			currencyCode: f.currencyCode,
			menuVersion: f.menuVersion,
			invoiceSeq: o.invoiceSeq,
			invoiceNumber: formatInvoiceNumber(f.deviceCode, o.invoiceSeq),
			openedAt: openedAt.toISOString(),
			lines: payloadLines,
			totals: serialised,
			payments: [payment]
		}
	};
}

export async function recordSaleAt(
	database: Db,
	f: SalesFixture,
	o: RecordSaleOptions
): Promise<{
	orderId: string;
	invoiceNumber: string;
	totals: { totalMinor: string };
	softFlags: string[];
}> {
	const envelope = saleEnvelope(f, o);
	return database.transaction(async (tx) => {
		const ctx = syncContext(f, {
			clientOpId: envelope.clientOpId,
			occurredAt: new Date(envelope.occurredAt as string),
			employeeId: o.employeeId
		});
		const v = await validateSale(tx, ctx, envelope);
		if (!v.ok) {
			throw new Error(`validateSale rejected: ${v.hard} (${v.detail ?? '-'})`);
		}
		const r = await recordSale(tx, ctx, v.sale, v.softFlags);
		return {
			orderId: r.orderId,
			invoiceNumber: r.invoiceNumber,
			totals: v.sale.totals as unknown as { totalMinor: string },
			softFlags: v.softFlags as unknown as string[]
		};
	});
}

/** Drives one op through handleOp, exactly as POST /api/pos/sync would. */
export async function pushOp(
	database: Db,
	f: SalesFixture,
	envelope: OpEnvelope<OpKind, unknown>
): Promise<Awaited<ReturnType<typeof handleOp>>> {
	const deviceCtx: PosDeviceContext = {
		restaurantId: f.restaurantId,
		deviceId: f.deviceId,
		deviceCode: f.deviceCode
	};
	return handleOp(database, deviceCtx, { ip: '203.0.113.5', userAgent: 'vitest' }, envelope);
}
