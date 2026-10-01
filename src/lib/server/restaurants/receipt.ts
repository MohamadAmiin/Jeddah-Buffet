// THE RECEIPT LAYOUT (spec 11, 4, 3; tasks/settings-tax-payments-receipt T-12):
// the header and footer lines, the logo, and the column map behind the nine
// display switches. The switches and the payment-numbers heading are settings
// columns, so their ONE writer stays updateSettings in ./index; this file gives it
// the map (RECEIPT_SHOW_COLUMNS) and the reader (receiptShowFrom).
//
// What a receipt must legally show is spec 33 open decision 3, STILL OPEN. The
// switches are the complete hideable set (gate decision 4), and the lines that can
// never be hidden are enforced by the till's formatter (T-23), not here.
//
// NO PRINTER COMMAND BYTE IS EVER STORED (invariant 9: opening the drawer without
// a sale needs the owner's PIN). Lines are trimmed text with no control character,
// so an ESC can never ride on them and start the drawer pulse ESC p. The logo is a
// 1-bit raster of an exact, validated shape — plain pixel data that only the print
// agent turns into ESC/POS (T-25); bytes passed through could carry 1B 70 00 19 FA
// and open the drawer on every reprint (risk 6). Neither the bitmap nor any base64
// of it goes into an audit row: the fingerprint is the logo's only trace there.
//
// NOTHING HERE BUMPS menu_version. The layout is not in the menu snapshot; it
// reaches the till in the settings bundle of GET /api/pos/employees (T-20).
//
// NOTHING HERE TOUCHES A POSTED RECORD (invariant 2). The only DELETEs are of
// receipt_lines rows (a section replaced as a set) and of the one receipt_logos
// row — layout configuration that nothing references.
//
// Conventions of src/lib/server/permissions/roles.ts and
// src/lib/server/inventory/ingredients.ts: restaurantId explicit on every
// statement; writers take DbTx and never open a transaction; readers take
// Executor; every check runs before any SQL; every change audits in the same
// transaction (invariant 10); a no-op writes nothing.
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
// TYPE-ONLY: index.ts re-exports this file, so a runtime import back would be a cycle.
import type { UpdateSettingsContext } from './index';
import { receiptLines, receiptLogos } from '../db/schema/receipt';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { writeAudit } from '../audit';
import {
	RECEIPT_LINE_MAX,
	RECEIPT_LINES_PER_SECTION,
	RECEIPT_SHOW_KEYS,
	isValidLogoShape,
	type ReceiptLayout,
	type ReceiptShow
} from '../../receipt-layout';

/** The control-character test updateSettings applies to receipt text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Each ReceiptShow key → the restaurantSettings property T-05 declared. Typed so
 * a missing key fails to compile.
 */
export const RECEIPT_SHOW_COLUMNS = {
	cashier: 'receiptShowCashier',
	table: 'receiptShowTable',
	businessDate: 'receiptShowBusinessDate',
	orderType: 'receiptShowOrderType',
	unitPrice: 'receiptShowUnitPrice',
	currencyLine: 'receiptShowCurrencyLine',
	deviceLine: 'receiptShowDeviceLine',
	paymentNumbers: 'receiptShowPaymentNumbers',
	taxBreakdown: 'receiptTaxBreakdown'
} as const satisfies Record<
	(typeof RECEIPT_SHOW_KEYS)[number],
	keyof typeof restaurantSettings.$inferSelect
>;

type ReceiptShowColumn = (typeof RECEIPT_SHOW_COLUMNS)[keyof typeof RECEIPT_SHOW_COLUMNS];

/**
 * The nine switch columns as a select shape, keyed by their restaurantSettings
 * property — the mapped type makes a missing or extra column fail to compile.
 * getReceiptLayout and getRestaurantWithSettings select through it.
 */
export const RECEIPT_SHOW_SELECTION: { [C in ReceiptShowColumn]: (typeof restaurantSettings)[C] } =
	{
		receiptShowCashier: restaurantSettings.receiptShowCashier,
		receiptShowTable: restaurantSettings.receiptShowTable,
		receiptShowBusinessDate: restaurantSettings.receiptShowBusinessDate,
		receiptShowOrderType: restaurantSettings.receiptShowOrderType,
		receiptShowUnitPrice: restaurantSettings.receiptShowUnitPrice,
		receiptShowCurrencyLine: restaurantSettings.receiptShowCurrencyLine,
		receiptShowDeviceLine: restaurantSettings.receiptShowDeviceLine,
		receiptShowPaymentNumbers: restaurantSettings.receiptShowPaymentNumbers,
		receiptTaxBreakdown: restaurantSettings.receiptTaxBreakdown
	};

/** A ReceiptShow, keyed RECEIPT_SHOW_KEYS-first, from a selected settings row. */
export function receiptShowFrom(row: { [C in ReceiptShowColumn]: boolean }): ReceiptShow {
	const show = {} as ReceiptShow;
	for (const key of RECEIPT_SHOW_KEYS) show[key] = row[RECEIPT_SHOW_COLUMNS[key]];
	return show;
}

/**
 * The restaurant's receipt layout: the nine switches, the heading, both sections'
 * lines in position order, and the logo's fingerprint and shape — NEVER its
 * bitmap (readReceiptLogo serves the bytes).
 */
export async function getReceiptLayout(
	database: Executor,
	restaurantId: string
): Promise<ReceiptLayout> {
	const [settings] = await database
		.select({
			show: RECEIPT_SHOW_SELECTION,
			paymentNumbersHeading: restaurantSettings.receiptPaymentNumbersHeading
		})
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId))
		.limit(1);
	if (!settings) throw new Error(`No settings row for restaurant ${restaurantId}`);

	const lines = await database
		.select({ section: receiptLines.section, body: receiptLines.body })
		.from(receiptLines)
		.where(eq(receiptLines.restaurantId, restaurantId))
		.orderBy(asc(receiptLines.section), asc(receiptLines.position));

	const [logo] = await database
		.select({
			sha256: receiptLogos.sha256,
			widthDots: receiptLogos.widthDots,
			heightDots: receiptLogos.heightDots
		})
		.from(receiptLogos)
		.where(eq(receiptLogos.restaurantId, restaurantId))
		.limit(1);

	return {
		headerLines: lines.filter((line) => line.section === 'header').map((line) => line.body),
		footerLines: lines.filter((line) => line.section === 'footer').map((line) => line.body),
		show: receiptShowFrom(settings.show),
		paymentNumbersHeading: settings.paymentNumbersHeading,
		logo: logo ?? null
	};
}

/**
 * Replace one section's lines as a set. Each line is trimmed, blank lines are
 * dropped and the order is kept; the survivors are stored at positions 1..n.
 * The same lines are a no-op: no write, no audit row.
 */
export async function replaceReceiptLines(
	tx: DbTx,
	restaurantId: string,
	section: 'header' | 'footer',
	lines: string[],
	ctx: UpdateSettingsContext
): Promise<
	{ ok: true; changed: boolean } | { ok: false; reason: 'too_many_lines' | 'invalid_line' }
> {
	// A programming error, not a refusal: the contract has no reason for it.
	const sectionIn: unknown = section;
	if (sectionIn !== 'header' && sectionIn !== 'footer') {
		throw new TypeError(`receipt section must be 'header' or 'footer', got ${String(sectionIn)}`);
	}

	// Every check runs before any SQL.
	const next: string[] = [];
	for (const line of lines as unknown[]) {
		if (typeof line !== 'string') return { ok: false, reason: 'invalid_line' };
		const trimmed = line.trim();
		if (trimmed !== '') next.push(trimmed);
	}
	if (next.some((line) => CONTROL.test(line) || line.length > RECEIPT_LINE_MAX)) {
		return { ok: false, reason: 'invalid_line' };
	}
	if (next.length > RECEIPT_LINES_PER_SECTION) return { ok: false, reason: 'too_many_lines' };

	// Lock the settings row: two concurrent saves of the same section would
	// otherwise both delete and both insert, and collide on receipt_lines_pk.
	const locked = await tx
		.select({ restaurantId: restaurantSettings.restaurantId })
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId))
		.for('update');
	if (locked.length === 0) throw new Error(`No settings row for restaurant ${restaurantId}`);

	const inSection = and(
		eq(receiptLines.restaurantId, restaurantId),
		eq(receiptLines.section, section)
	);
	const current = (
		await tx
			.select({ body: receiptLines.body })
			.from(receiptLines)
			.where(inSection)
			.orderBy(asc(receiptLines.position))
	).map((row) => row.body);

	if (current.length === next.length && current.every((body, i) => body === next[i])) {
		return { ok: true, changed: false };
	}

	await tx.delete(receiptLines).where(inSection);
	if (next.length > 0) {
		await tx
			.insert(receiptLines)
			.values(next.map((body, i) => ({ restaurantId, section, position: i + 1, body })));
	}
	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		event: 'receipt.lines_updated',
		details: { section, old: current, new: next },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
	return { ok: true, changed: true };
}

/**
 * Store the restaurant's logo: a 1-bit raster, MSB first, 1 = black, of an exact
 * shape (isValidLogoShape). The same logo again is a no-op: no write, no audit.
 */
export async function setReceiptLogo(
	tx: DbTx,
	restaurantId: string,
	logo: { widthDots: number; heightDots: number; bitmap: Uint8Array },
	ctx: UpdateSettingsContext
): Promise<{ ok: true; sha256: string } | { ok: false; reason: 'invalid_logo' }> {
	const { widthDots, heightDots, bitmap } = logo;
	// Before any SQL. The instanceof guard keeps a missing bitmap a refusal, not a crash.
	if (
		!(bitmap instanceof Uint8Array) ||
		!isValidLogoShape(widthDots, heightDots, bitmap.byteLength)
	) {
		return { ok: false, reason: 'invalid_logo' };
	}

	// The fingerprint covers the SHAPE as well as the bytes: the same bytes at a
	// different shape print a different picture, and the till refreshes its cached
	// logo only when this value changes (T-21) — so it must change with the shape.
	const sha256 = createHash('sha256')
		.update(`${widthDots}x${heightDots}\n`)
		.update(bitmap)
		.digest('hex');

	const [current] = await tx
		.select({ sha256: receiptLogos.sha256 })
		.from(receiptLogos)
		.where(eq(receiptLogos.restaurantId, restaurantId))
		.for('update')
		.limit(1);
	if (current?.sha256 === sha256) return { ok: true, sha256 };

	await tx
		.insert(receiptLogos)
		.values({ restaurantId, widthDots, heightDots, byteSize: bitmap.byteLength, bitmap, sha256 })
		.onConflictDoUpdate({
			target: receiptLogos.restaurantId,
			set: {
				widthDots,
				heightDots,
				byteSize: bitmap.byteLength,
				bitmap,
				sha256,
				updatedAt: new Date()
			}
		});
	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		event: 'receipt.logo_updated',
		details: { sha256, widthDots, heightDots },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
	return { ok: true, sha256 };
}

/** Remove the restaurant's logo. No logo is a no-op: no audit row. */
export async function removeReceiptLogo(
	tx: DbTx,
	restaurantId: string,
	ctx: UpdateSettingsContext
): Promise<{ ok: true; changed: boolean }> {
	const removed = await tx
		.delete(receiptLogos)
		.where(eq(receiptLogos.restaurantId, restaurantId))
		.returning({ sha256: receiptLogos.sha256 });
	if (removed.length === 0) return { ok: true, changed: false };

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		event: 'receipt.logo_removed',
		details: { sha256: removed[0].sha256 },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
	return { ok: true, changed: true };
}

/** The logo with its bytes, for GET /api/pos/receipt-logo (T-20), or null. */
export async function readReceiptLogo(
	database: Executor,
	restaurantId: string
): Promise<{ sha256: string; widthDots: number; heightDots: number; bitmap: Uint8Array } | null> {
	const [row] = await database
		.select({
			sha256: receiptLogos.sha256,
			widthDots: receiptLogos.widthDots,
			heightDots: receiptLogos.heightDots,
			bitmap: receiptLogos.bitmap
		})
		.from(receiptLogos)
		.where(eq(receiptLogos.restaurantId, restaurantId))
		.limit(1);
	return row ?? null;
}
