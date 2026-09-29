// validateSale — the sync handler's schema, hard failures and soft flags.
//
// Reads only; writes nothing; never mutates a payload number; never throws
// for a validation outcome. A genuine programming error throws and T-21 maps
// it to database_error.
//
// The hard/soft split is load-bearing (spec 6, invariant 5): SOFT flags
// record the sale in FULL from the device's numbers with the flag on
// orders.flag_reason and pos_sync_ops.flag; HARD failures roll back and land
// the op as `unrecorded` with the payload only. Everything marked SOFT here
// is stored by T-19 and flagged; everything HARD is refused by T-21 and
// (for card/mobile) returned as 422 or (for cash) stored as unrecorded.

import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DbTx } from '../db/client';
import { checkEmployee } from '../permissions/employee';
import { orders as _orders } from '../db/schema/orders';
import { posSessions } from '../db/schema/pos-sessions';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { menuItems, modifiers as modifiersTable, menuItemModifierGroups } from '../db/schema/menu';
import {
	SOFT_FLAGS,
	HARD_FLAGS,
	ORDER_TYPES,
	PAYMENT_METHODS,
	formatInvoiceNumber,
	type OpEnvelope,
	type OrderType,
	type SaleLine
} from '../../sync-ops';
import { TAX_MODES, type TaxMode } from '../../money/tax';
import { minor, type Minor, ROUNDING_RULE } from '../../money';
import { computeOrderTotals, totalsEqual } from '../../money/order-totals';
import { changeDue } from '../../money/change';

// A read-side import so 02-schema.md's orders table stays in the module graph.
void _orders;

export type SoftFlag = (typeof SOFT_FLAGS)[number];
export type HardFlag = (typeof HARD_FLAGS)[number];

export type SyncContext = {
	restaurantId: string;
	cookieDeviceId: string;
	opDeviceId: string;
	opDeviceCode: string;
	employeeId: string;
	employeeUserId: string | null;
	clientOpId: string;
	occurredAt: Date;
	receivedAt: Date;
	ip: string | null;
	userAgent: string | null;
};

export type ParsedSaleLineModifier = {
	modifierId: string;
	modifierName: string;
	priceDeltaMinor: Minor;
};

export type ParsedSaleLine = {
	lineId: string;
	lineNo: number;
	menuItemId: string;
	itemName: string;
	quantity: number;
	unitPriceMinor: Minor;
	taxRateBp: number;
	discountMinor: Minor;
	modifiers: ParsedSaleLineModifier[];
};

export type ParsedSale = {
	orderId: string;
	posSessionId: string;
	businessDate: string;
	orderType: OrderType;
	tableLabel: string | null;
	taxMode: TaxMode;
	currencyCode: string;
	menuVersion: number;
	invoiceSeq: number;
	invoiceNumber: string;
	openedAt: Date;
	lines: ParsedSaleLine[];
	totals: {
		subtotalMinor: Minor;
		discountMinor: Minor;
		taxMinor: Minor;
		totalMinor: Minor;
	};
	payment: {
		paymentId: string;
		method: 'cash' | 'card' | 'mobile';
		amountMinor: Minor;
		tenderedMinor: Minor | null;
		changeMinor: Minor | null;
	};
	session: {
		id: string;
		deviceId: string;
		businessDate: string;
		status: 'open' | 'closed';
	};
};

export type ValidateResult =
	| { ok: true; sale: ParsedSale; softFlags: SoftFlag[] }
	| { ok: false; hard: HardFlag; detail: string };

const MINOR = /^-?[0-9]{1,15}$/;
const minorString = z
	.string()
	.regex(MINOR, 'not a decimal minor string')
	.transform((s) => BigInt(s));
const nonNegativeMinor = minorString.refine((v) => v >= 0n, 'must not be negative');
const zeroMinor = z.literal('0').transform(() => 0n);

const modifierSchema = z.object({
	modifierId: z.string().uuid(),
	modifierName: z.string().min(1).max(120),
	priceDeltaMinor: minorString
});

const lineSchema = z.object({
	lineId: z.string().uuid(),
	lineNo: z.number().int().min(1),
	menuItemId: z.string().uuid(),
	itemName: z.string().min(1).max(120),
	quantity: z.number().int().min(1).max(999),
	unitPriceMinor: nonNegativeMinor,
	taxRateBp: z.number().int().min(0).max(10_000),
	discountMinor: zeroMinor,
	modifiers: z.array(modifierSchema).max(20)
});

const paymentSchema = z
	.object({
		paymentId: z.string().uuid(),
		method: z.enum(PAYMENT_METHODS as unknown as [string, ...string[]]),
		amountMinor: nonNegativeMinor,
		tenderedMinor: minorString.nullable(),
		changeMinor: minorString.nullable()
	})
	.superRefine((p, ctx) => {
		const cash = p.method === 'cash';
		if (cash && (p.tenderedMinor === null || p.changeMinor === null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'cash needs tendered and change'
			});
		}
		if (!cash && (p.tenderedMinor !== null || p.changeMinor !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'only cash carries tendered and change'
			});
		}
	});

export const saleCompletePayloadSchema = z
	.object({
		orderId: z.string().uuid(),
		posSessionId: z.string().uuid(),
		// The readonly tuple straight from the wire contract: a value added there is
		// accepted here with no cast, and every consumer of ParsedSale is typed
		// OrderType, so a missing case fails to compile instead of hiding.
		orderType: z.enum(ORDER_TYPES),
		tableLabel: z.string().min(1).max(32).nullable(),
		taxMode: z.enum(TAX_MODES as unknown as [string, ...string[]]),
		currencyCode: z.string().regex(/^[A-Z]{3}$/),
		menuVersion: z.number().int().min(1),
		invoiceSeq: z.number().int().min(1).max(999_999),
		invoiceNumber: z.string().min(1).max(15),
		openedAt: z.string().datetime({ offset: true }),
		lines: z.array(lineSchema).min(1).max(200),
		totals: z.object({
			subtotalMinor: minorString,
			discountMinor: minorString,
			taxMinor: minorString,
			totalMinor: minorString
		}),
		payments: z.array(paymentSchema).length(1)
	})
	.superRefine((p, ctx) => {
		const ids = new Set(p.lines.map((l) => l.lineId));
		const nos = new Set(p.lines.map((l) => l.lineNo));
		if (ids.size !== p.lines.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['lines'],
				message: 'duplicate lineId'
			});
		}
		if (nos.size !== p.lines.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['lines'],
				message: 'duplicate lineNo'
			});
		}
	});

type ParsedPayload = z.output<typeof saleCompletePayloadSchema>;

function pushOnce(flags: SoftFlag[], flag: SoftFlag): void {
	if (!flags.includes(flag)) flags.push(flag);
}

export async function validateSale(
	tx: DbTx,
	ctx: SyncContext,
	envelope: OpEnvelope<'sale.complete', unknown>
): Promise<ValidateResult> {
	// Step 1 — schema.
	const parsed = saleCompletePayloadSchema.safeParse(envelope.payload);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		const detail = `${first.path.join('.')}: ${first.message}`;
		return { ok: false, hard: 'invalid_payload', detail };
	}
	const payload = parsed.data as ParsedPayload;

	// Step 2 — invoice number matches device sequence.
	if (payload.invoiceNumber !== formatInvoiceNumber(ctx.opDeviceCode, payload.invoiceSeq)) {
		return { ok: false, hard: 'invalid_payload', detail: 'invoice_number_mismatch' };
	}

	// Step 3 — session exists, belongs to op device, may be closed.
	const [session] = await tx
		.select({
			id: posSessions.id,
			deviceId: posSessions.deviceId,
			businessDate: posSessions.businessDate,
			status: posSessions.status
		})
		.from(posSessions)
		.where(
			and(eq(posSessions.id, payload.posSessionId), eq(posSessions.restaurantId, ctx.restaurantId))
		)
		.limit(1);
	if (!session) {
		return { ok: false, hard: 'unknown_session', detail: payload.posSessionId };
	}
	if (session.deviceId !== ctx.opDeviceId) {
		return { ok: false, hard: 'invalid_payload', detail: 'session_device_mismatch' };
	}
	const softFlags: SoftFlag[] = [];
	if (session.status !== 'open') pushOnce(softFlags, 'session_closed');

	// Step 4 — settings.
	const [settings] = await tx
		.select({
			taxMode: restaurantSettings.taxMode,
			taxRateBp: restaurantSettings.taxRateBp,
			currencyCode: restaurantSettings.currencyCode,
			menuVersion: restaurantSettings.menuVersion,
			acceptsCard: restaurantSettings.acceptsCard,
			acceptsMobile: restaurantSettings.acceptsMobile
		})
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, ctx.restaurantId))
		.limit(1);
	if (!settings) {
		return { ok: false, hard: 'database_error', detail: 'settings_missing' };
	}

	// Step 5 — items (no archived filter; spec 6: an archived item still sold).
	const itemIds = Array.from(new Set(payload.lines.map((l) => l.menuItemId)));
	const itemRows = await tx
		.select({
			id: menuItems.id,
			priceMinor: menuItems.priceMinor,
			taxRateBp: menuItems.taxRateBp
		})
		.from(menuItems)
		.where(and(eq(menuItems.restaurantId, ctx.restaurantId), inArray(menuItems.id, itemIds)));
	const itemById = new Map(itemRows.map((r) => [r.id, r]));
	for (const id of itemIds) {
		if (!itemById.has(id)) {
			return { ok: false, hard: 'unknown_item', detail: id };
		}
	}

	// Step 6 — modifiers: every (menuItemId, modifierId) pair must belong to a
	// group linked to that item.
	const modifierIds = Array.from(
		new Set(payload.lines.flatMap((l) => l.modifiers.map((m) => m.modifierId)))
	);
	const modifierMenuPairs = new Set<string>();
	const modifierByRef = new Map<string, { id: string; priceDeltaMinor: bigint }>();
	if (modifierIds.length > 0) {
		const rows = await tx
			.select({
				modifierId: modifiersTable.id,
				priceDeltaMinor: modifiersTable.priceDeltaMinor,
				menuItemId: menuItemModifierGroups.menuItemId
			})
			.from(modifiersTable)
			.innerJoin(
				menuItemModifierGroups,
				and(
					eq(menuItemModifierGroups.modifierGroupId, modifiersTable.groupId),
					eq(menuItemModifierGroups.restaurantId, modifiersTable.restaurantId)
				)
			)
			.where(
				and(
					eq(modifiersTable.restaurantId, ctx.restaurantId),
					inArray(modifiersTable.id, modifierIds)
				)
			);
		for (const row of rows) {
			modifierMenuPairs.add(`${row.menuItemId}:${row.modifierId}`);
			modifierByRef.set(row.modifierId, {
				id: row.modifierId,
				priceDeltaMinor: row.priceDeltaMinor
			});
		}
	}
	for (const line of payload.lines) {
		for (const mod of line.modifiers) {
			if (!modifierMenuPairs.has(`${line.menuItemId}:${mod.modifierId}`)) {
				return {
					ok: false,
					hard: 'unknown_modifier',
					detail: `${line.lineId}:${mod.modifierId}`
				};
			}
		}
	}

	// Step 7 — accepted tenders. null counts as off.
	const method = payload.payments[0].method as 'cash' | 'card' | 'mobile';
	if (method === 'card' && settings.acceptsCard !== true) {
		return { ok: false, hard: 'invalid_payload', detail: 'tender_not_accepted' };
	}
	if (method === 'mobile' && settings.acceptsMobile !== true) {
		return { ok: false, hard: 'invalid_payload', detail: 'tender_not_accepted' };
	}

	// Step 8 — price / tax-rate / tax-mode comparison. A difference at the SAME
	// version is HARD price_tamper; at a DIFFERENT version it's SOFT stale_menu_price.
	let firstDiff: string | null = null;
	for (const line of payload.lines) {
		const item = itemById.get(line.menuItemId)!;
		if (line.unitPriceMinor !== item.priceMinor) {
			firstDiff = `line:${line.lineId}:unit_price`;
			break;
		}
		for (const mod of line.modifiers) {
			const known = modifierByRef.get(mod.modifierId);
			if (known && mod.priceDeltaMinor !== known.priceDeltaMinor) {
				firstDiff = `line:${line.lineId}:modifier:${mod.modifierId}`;
				break;
			}
		}
		if (firstDiff) break;
		const resolvedRate = item.taxRateBp ?? settings.taxRateBp;
		if (resolvedRate === null || line.taxRateBp !== resolvedRate) {
			firstDiff = `line:${line.lineId}:tax_rate`;
			break;
		}
	}
	if (!firstDiff && payload.taxMode !== settings.taxMode) {
		firstDiff = 'tax_mode';
	}
	if (firstDiff) {
		if (payload.menuVersion === settings.menuVersion) {
			return { ok: false, hard: 'price_tamper', detail: firstDiff };
		}
		pushOnce(softFlags, 'stale_menu_price');
	}

	// Step 9 — totals recomputed from the payload's own lines and mode.
	const recomputed = computeOrderTotals(
		{
			taxMode: payload.taxMode as TaxMode,
			lines: payload.lines.map((l) => ({
				unitPriceMinor: minor(l.unitPriceMinor),
				quantity: BigInt(l.quantity),
				modifierDeltasMinor: l.modifiers.map((m) => minor(m.priceDeltaMinor)),
				taxRateBp: l.taxRateBp,
				discountMinor: minor(0n)
			}))
		},
		ROUNDING_RULE
	);
	const wireTotals = {
		subtotal: minor(payload.totals.subtotalMinor),
		discount: minor(payload.totals.discountMinor),
		tax: minor(payload.totals.taxMinor),
		total: minor(payload.totals.totalMinor)
	};
	if (!totalsEqual(recomputed, wireTotals)) {
		pushOnce(softFlags, 'totals_mismatch');
	}

	// Step 10 — payment shape and cash arithmetic.
	const payment = payload.payments[0];
	if (payment.amountMinor !== payload.totals.totalMinor) {
		return { ok: false, hard: 'invalid_payload', detail: 'payment_amount' };
	}
	if (method === 'cash') {
		const tendered = payment.tenderedMinor as bigint;
		const change = payment.changeMinor as bigint;
		if (tendered < payment.amountMinor) {
			return { ok: false, hard: 'invalid_payload', detail: 'cash_change' };
		}
		if (change !== changeDue(minor(tendered), minor(payment.amountMinor))) {
			return { ok: false, hard: 'invalid_payload', detail: 'cash_change' };
		}
	}

	// Step 11 — clock skew.
	if (ctx.occurredAt.getTime() - ctx.receivedAt.getTime() > 5 * 60 * 1000) {
		pushOnce(softFlags, 'clock_ahead');
	}

	// Step 12 — employee. checkEmployee never throws for a failed check.
	const check = await checkEmployee(tx, ctx.restaurantId, ctx.employeeId, [
		'pos.sell',
		'pos.payment'
	]);
	if (check.ok === false) {
		pushOnce(softFlags, check.reason);
	}

	// Step 13 — build the ParsedSale.
	const sale: ParsedSale = {
		orderId: payload.orderId,
		posSessionId: payload.posSessionId,
		businessDate: session.businessDate,
		orderType: payload.orderType,
		tableLabel: payload.tableLabel,
		taxMode: payload.taxMode as TaxMode,
		currencyCode: payload.currencyCode,
		menuVersion: payload.menuVersion,
		invoiceSeq: payload.invoiceSeq,
		invoiceNumber: payload.invoiceNumber,
		openedAt: new Date(payload.openedAt),
		lines: payload.lines.map((l) => ({
			lineId: l.lineId,
			lineNo: l.lineNo,
			menuItemId: l.menuItemId,
			itemName: l.itemName,
			quantity: l.quantity,
			unitPriceMinor: minor(l.unitPriceMinor),
			taxRateBp: l.taxRateBp,
			discountMinor: minor(l.discountMinor),
			modifiers: l.modifiers.map((m) => ({
				modifierId: m.modifierId,
				modifierName: m.modifierName,
				priceDeltaMinor: minor(m.priceDeltaMinor)
			}))
		})),
		totals: {
			subtotalMinor: minor(payload.totals.subtotalMinor),
			discountMinor: minor(payload.totals.discountMinor),
			taxMinor: minor(payload.totals.taxMinor),
			totalMinor: minor(payload.totals.totalMinor)
		},
		payment: {
			paymentId: payment.paymentId,
			method,
			amountMinor: minor(payment.amountMinor),
			tenderedMinor: payment.tenderedMinor === null ? null : minor(payment.tenderedMinor),
			changeMinor: payment.changeMinor === null ? null : minor(payment.changeMinor)
		},
		session: {
			id: session.id,
			deviceId: session.deviceId,
			businessDate: session.businessDate,
			status: session.status as 'open' | 'closed'
		}
	};

	return { ok: true, sale, softFlags };
}

/** For T-19: back to the wire shape when calling consumeForSale. */
export function toSaleLines(lines: ParsedSaleLine[]): SaleLine[] {
	return lines.map((l) => ({
		lineId: l.lineId,
		lineNo: l.lineNo,
		menuItemId: l.menuItemId,
		itemName: l.itemName,
		quantity: l.quantity,
		unitPriceMinor: l.unitPriceMinor.toString(),
		taxRateBp: l.taxRateBp,
		discountMinor: l.discountMinor.toString(),
		modifiers: l.modifiers.map((m) => ({
			modifierId: m.modifierId,
			modifierName: m.modifierName,
			priceDeltaMinor: m.priceDeltaMinor.toString()
		}))
	}));
}
