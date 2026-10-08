import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RECEIPT_LAYOUT,
	LOGO_MAX_HEIGHT_DOTS,
	LOGO_MAX_WIDTH_DOTS,
	RECEIPT_LINE_MAX,
	RECEIPT_LINES_PER_SECTION,
	RECEIPT_SHOW_KEYS,
	isValidLogoShape,
	logoByteSize,
	paymentNumbersFrom
} from './receipt-layout';

// The isomorphic receipt contract (tasks/settings-tax-payments-receipt T-12).

describe('the receipt switches', () => {
	it('are the nine hideable fields of gate decision 4, in order', () => {
		expect([...RECEIPT_SHOW_KEYS]).toEqual([
			'cashier',
			'table',
			'businessDate',
			'orderType',
			'unitPrice',
			'currencyLine',
			'deviceLine',
			'paymentNumbers',
			'taxBreakdown'
		]);
	});
});

describe('DEFAULT_RECEIPT_LAYOUT', () => {
	it("is today's receipt: every switch on, no lines, no heading, no logo", () => {
		expect(Object.keys(DEFAULT_RECEIPT_LAYOUT.show)).toEqual([...RECEIPT_SHOW_KEYS]);
		expect(Object.values(DEFAULT_RECEIPT_LAYOUT.show).every((value) => value === true)).toBe(true);
		const { show, ...rest } = DEFAULT_RECEIPT_LAYOUT;
		expect(show).toBeDefined();
		expect(rest).toEqual({
			headerLines: [],
			footerLines: [],
			paymentNumbersHeading: null,
			logo: null
		});
	});

	it('is frozen, with its two arrays and its switches', () => {
		expect(Object.isFrozen(DEFAULT_RECEIPT_LAYOUT)).toBe(true);
		expect(Object.isFrozen(DEFAULT_RECEIPT_LAYOUT.headerLines)).toBe(true);
		expect(Object.isFrozen(DEFAULT_RECEIPT_LAYOUT.footerLines)).toBe(true);
		expect(Object.isFrozen(DEFAULT_RECEIPT_LAYOUT.show)).toBe(true);
	});
});

describe('paymentNumbersFrom', () => {
	it('keeps the order and drops a method with no number or an empty one', () => {
		expect(
			paymentNumbersFrom([
				{ name: 'Cash', merchantNumber: null },
				{ name: 'EVC Plus', merchantNumber: '61 234 5678' },
				{ name: 'X', merchantNumber: '' },
				{ name: 'Zaad', merchantNumber: '63 345 6789' }
			])
		).toEqual([
			{ name: 'EVC Plus', number: '61 234 5678' },
			{ name: 'Zaad', number: '63 345 6789' }
		]);
	});
});

describe('the limits equal the database CHECKs (T-05)', () => {
	it('pins the line and logo bounds', () => {
		expect(RECEIPT_LINE_MAX).toBe(120);
		expect(RECEIPT_LINES_PER_SECTION).toBe(5);
		expect(LOGO_MAX_WIDTH_DOTS).toBe(384);
		expect(LOGO_MAX_HEIGHT_DOTS).toBe(160);
	});

	it('logoByteSize(384, 160) is 7,680 bytes', () => {
		expect(logoByteSize(384, 160)).toBe(7680);
	});
});

describe('isValidLogoShape', () => {
	it.each([
		[8, 1, 1],
		[16, 2, 4],
		[384, 160, 7680]
	])('accepts %i x %i dots in %i bytes', (width, height, bytes) => {
		expect(isValidLogoShape(width, height, bytes)).toBe(true);
	});

	it.each([
		[12, 1, 2],
		[392, 1, 49],
		[0, 1, 0],
		[8, 0, 0],
		[8, 161, 161],
		[8, 2, 1],
		[8.5, 1, 1],
		[384, 160, 7679]
	])('refuses %s x %s dots in %s bytes', (width, height, bytes) => {
		expect(isValidLogoShape(width, height, bytes)).toBe(false);
	});
});

// The isomorphic rule: no sibling, no $lib, no Node builtin — comments stripped
// first, because the header talks about importing. Copied from
// src/lib/menu-images.test.ts.
describe('src/lib/receipt-layout.ts', () => {
	it('imports nothing', () => {
		const source = readFileSync(new URL('./receipt-layout.ts', import.meta.url), 'utf8');
		expect(source).toContain('imports NOTHING');
		const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		expect(stripped).not.toMatch(/^\s*import\b/m);
		expect(stripped).not.toMatch(/\bfrom\s+['"]/);
		expect(stripped).not.toMatch(/\bimport\(/);
		expect(stripped).not.toMatch(/\brequire\(/);
	});
});
