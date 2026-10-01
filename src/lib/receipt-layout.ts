// THE RECEIPT LAYOUT CONTRACT — ISOMORPHIC, and it imports NOTHING (the rule of
// src/lib/money, src/lib/sync-ops and src/lib/menu-images.ts): no sibling, no
// $lib, no Node builtin. The server writers (src/lib/server/restaurants/receipt.ts),
// the till's settings bundle, the till's receipt formatter (src/lib/pos/receipt.ts)
// and the dashboard's live preview all read these names from here, so they
// cannot drift (tasks/settings-tax-payments-receipt T-12).
//
// WHAT THE OWNER CHOOSES (spec 11; gate decision 4, CLAUDE.md "Settings 4"):
// up to five header and five footer lines, nine display switches, an optional
// heading above the payment-numbers block, and a logo. The nine switches are the
// COMPLETE hideable set. The lines that can never be hidden — the restaurant
// name, the invoice number, the date and time, the items, the subtotal,
// discount, tax and total, the payment, the COPY marks and a tax registration
// number when one is set — have no switch at all, and the formatter enforces
// that, not this file. Spec 33 open decision 3 (what a receipt must legally
// show) is STILL OPEN.
//
// THESE NUMBERS EQUAL THE DATABASE CHECKS of src/lib/server/db/schema/receipt.ts
// (T-05), spelled there and NOT imported, because drizzle-kit loads the schema
// outside Vite:
//   - RECEIPT_LINE_MAX            ↔ receipt_lines_body_valid (1–120 characters);
//   - RECEIPT_LINES_PER_SECTION   ↔ receipt_lines_position_range (1–5);
//   - LOGO_MAX_WIDTH_DOTS         ↔ receipt_logos_width_dots_valid (8–384, % 8 = 0);
//   - LOGO_MAX_HEIGHT_DOTS        ↔ receipt_logos_height_dots_range (1–160);
//   - logoByteSize                ↔ receipt_logos_byte_size_matches (width/8 × height).
// The 384 × 160 logo fits 58 mm and 80 mm paper (gate decision 7) and is at most
// 7,680 bytes.
//
// THE LOGO IS PLAIN PIXEL DATA: 1-bit raster rows, MSB first, 1 = black. Only the
// print agent turns it into printer command bytes (T-25), so no stored or uploaded
// byte can reach the printer as a command — the drawer pulse included
// (invariant 9).

/** The nine display switches, in the order every settings page lists them. */
export const RECEIPT_SHOW_KEYS = [
	'cashier',
	'table',
	'businessDate',
	'orderType',
	'unitPrice',
	'currencyLine',
	'deviceLine',
	'paymentNumbers',
	'taxBreakdown'
] as const;

export type ReceiptShow = Record<(typeof RECEIPT_SHOW_KEYS)[number], boolean>;

/** The logo's fingerprint and shape — never its bytes, which travel separately. */
export type ReceiptLogoMeta = { sha256: string; widthDots: number; heightDots: number };

export type ReceiptLayout = {
	headerLines: string[];
	footerLines: string[];
	show: ReceiptShow;
	/** The heading above the payment-numbers block; null = no heading. */
	paymentNumbersHeading: string | null;
	logo: ReceiptLogoMeta | null;
};

/** One line of the payment-numbers block: a method's name and its merchant number. */
export type ReceiptPaymentNumber = { name: string; number: string };

export const RECEIPT_LINE_MAX = 120;
export const RECEIPT_LINES_PER_SECTION = 5;
export const LOGO_MAX_WIDTH_DOTS = 384;
export const LOGO_MAX_HEIGHT_DOTS = 160;

// Object.freeze types its result Readonly<T>, but ReceiptLayout keeps plain
// arrays so every reader shares ONE type; the freeze is the runtime guard that
// stops a reader from editing the shared default in place.
function frozenLines(): string[] {
	return Object.freeze<string[]>([]) as string[];
}

/**
 * Today's receipt: every switch on, no header or footer lines, no heading and no
 * logo. Frozen, with its two arrays and `show`, so no reader can change it.
 */
export const DEFAULT_RECEIPT_LAYOUT: ReceiptLayout = Object.freeze({
	headerLines: frozenLines(),
	footerLines: frozenLines(),
	show: Object.freeze({
		cashier: true,
		table: true,
		businessDate: true,
		orderType: true,
		unitPrice: true,
		currencyLine: true,
		deviceLine: true,
		paymentNumbers: true,
		taxBreakdown: true
	}),
	paymentNumbersHeading: null,
	logo: null
});

/**
 * The payment-numbers block: each method that has a merchant number, in the
 * order given. A method whose number is null or '' is dropped.
 */
export function paymentNumbersFrom(
	methods: ReadonlyArray<{ name: string; merchantNumber: string | null }>
): ReceiptPaymentNumber[] {
	const numbers: ReceiptPaymentNumber[] = [];
	for (const method of methods) {
		if (method.merchantNumber === null || method.merchantNumber === '') continue;
		numbers.push({ name: method.name, number: method.merchantNumber });
	}
	return numbers;
}

/** The byte count of a packed logo: one byte per 8 dots of a row, times the rows. */
export function logoByteSize(widthDots: number, heightDots: number): number {
	return (widthDots / 8) * heightDots;
}

/**
 * True only when the width is an integer multiple of 8 from 8 to 384, the
 * height an integer from 1 to 160, and the byte count an integer equal to
 * logoByteSize(width, height) — the same shape the database CHECKs accept.
 */
export function isValidLogoShape(
	widthDots: number,
	heightDots: number,
	byteLength: number
): boolean {
	return (
		Number.isInteger(widthDots) &&
		widthDots >= 8 &&
		widthDots <= LOGO_MAX_WIDTH_DOTS &&
		widthDots % 8 === 0 &&
		Number.isInteger(heightDots) &&
		heightDots >= 1 &&
		heightDots <= LOGO_MAX_HEIGHT_DOTS &&
		Number.isInteger(byteLength) &&
		byteLength === logoByteSize(widthDots, heightDots)
	);
}
