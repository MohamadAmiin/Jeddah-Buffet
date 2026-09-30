import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	formatInvoiceNumber,
	parseInvoiceNumber,
	OP_KINDS,
	OP_STATUSES,
	SOFT_FLAGS,
	HARD_FLAGS,
	ORDER_TYPES,
	PAYMENT_METHODS,
	ORDER_STATUSES,
	LINE_STATUSES,
	SESSION_STATUSES,
	type OpEnvelope,
	type SaleCompletePayload
} from './index';
import { TAX_MODES, type TaxMode } from '../money/tax';

// The same three-regex stripComments from src/lib/components/components.test.ts,
// restated here so this test never imports another test file.
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('formatInvoiceNumber', () => {
	it('pads to six digits and preserves the device code', () => {
		expect(formatInvoiceNumber('POS1', 6)).toBe('POS1-000006');
		expect(formatInvoiceNumber('POS1', 1)).toBe('POS1-000001');
		expect(formatInvoiceNumber('POS1', 999999)).toBe('POS1-999999');
		expect(formatInvoiceNumber('A', 42)).toBe('A-000042');
		expect(formatInvoiceNumber('ABCDEFGH', 7)).toBe('ABCDEFGH-000007');
	});

	it('throws RangeError on an out-of-range sequence', () => {
		expect(() => formatInvoiceNumber('POS1', 0)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('POS1', 1_000_000)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('POS1', 1.5)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('POS1', Number.NaN)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('POS1', -1)).toThrow(RangeError);
	});

	it('throws RangeError on a malformed device code', () => {
		expect(() => formatInvoiceNumber('pos1', 1)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('', 1)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('POS-1', 1)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('ABCDEFGHI', 1)).toThrow(RangeError);
		expect(() => formatInvoiceNumber('POS 1', 1)).toThrow(RangeError);
	});
});

describe('parseInvoiceNumber', () => {
	it('round-trips every valid pair', () => {
		for (const deviceCode of ['POS1', 'A', 'ABCDEFGH', 'T2']) {
			for (const seq of [1, 42, 999_999]) {
				expect(parseInvoiceNumber(formatInvoiceNumber(deviceCode, seq))).toEqual({
					deviceCode,
					seq
				});
			}
		}
	});

	it('returns null on any deviation and never throws', () => {
		expect(parseInvoiceNumber('POS1-1')).toBeNull();
		expect(parseInvoiceNumber('POS1-000000')).toBeNull();
		expect(parseInvoiceNumber('pos1-000001')).toBeNull();
		expect(parseInvoiceNumber('POS1-0000001')).toBeNull();
		expect(parseInvoiceNumber('POS1-00001')).toBeNull();
		expect(parseInvoiceNumber('')).toBeNull();
		expect(parseInvoiceNumber('POS1-000001\n')).toBeNull();
		// full-width digit '１' at the tail — must not parse
		expect(parseInvoiceNumber('POS1-00000１')).toBeNull();
		expect(parseInvoiceNumber('POS1-000001-2')).toBeNull();
		expect(parseInvoiceNumber(undefined as unknown as string)).toBeNull();
	});
});

describe('the lists', () => {
	it('pin every literal in the order the file format expects', () => {
		expect([...OP_KINDS]).toEqual([
			'session.open',
			'session.close',
			'sale.complete',
			'sale.abandoned',
			'pin.login'
		]);
		expect([...OP_STATUSES]).toEqual(['accepted', 'recorded_flagged', 'unrecorded']);
		expect([...ORDER_TYPES]).toEqual(['dine_in', 'takeaway', 'delivery']);
		expect([...PAYMENT_METHODS]).toEqual(['cash', 'card', 'mobile']);
		expect([...ORDER_STATUSES]).toEqual(['open', 'billed', 'paid', 'voided', 'refunded']);
		expect([...LINE_STATUSES]).toEqual(['new', 'sent', 'voided']);
		expect([...SESSION_STATUSES]).toEqual(['open', 'closed']);
	});

	it('has seven soft flags and seven hard flags with no overlap', () => {
		expect(SOFT_FLAGS).toHaveLength(7);
		expect(HARD_FLAGS).toHaveLength(7);
		const soft = new Set<string>(SOFT_FLAGS);
		for (const h of HARD_FLAGS) expect(soft.has(h)).toBe(false);
	});
});

describe('the tax-mode pin against src/lib/money/tax', () => {
	it('lists both spellings and pins the payload type to TaxMode', () => {
		expect([...TAX_MODES]).toEqual(['exclusive', 'inclusive']);
		// Compile-time drift guard. If SaleCompletePayload['taxMode'] and
		// money/tax's TaxMode ever fall out of sync, `sameTaxMode` degenerates to
		// `never` and this file fails `pnpm check`.
		const sameTaxMode: SaleCompletePayload['taxMode'] extends TaxMode
			? TaxMode extends SaleCompletePayload['taxMode']
				? true
				: never
			: never = true;
		expect(sameTaxMode).toBe(true);
	});
});

describe('wire safety', () => {
	it('survives JSON.stringify → JSON.parse deep-equal', () => {
		const envelope: OpEnvelope<'sale.complete', SaleCompletePayload> = {
			kind: 'sale.complete',
			clientOpId: '00000000-0000-4000-8000-000000000001',
			deviceId: 'device-uuid',
			employeeId: 'employee-uuid',
			occurredAt: '2026-09-28T12:34:56.000Z',
			seq: 1,
			payload: {
				orderId: 'order-uuid',
				posSessionId: 'session-uuid',
				orderType: 'takeaway',
				tableLabel: null,
				taxMode: 'exclusive',
				currencyCode: 'USD',
				menuVersion: 1,
				invoiceSeq: 1,
				invoiceNumber: 'POS1-000001',
				openedAt: '2026-09-28T12:00:00.000Z',
				lines: [
					{
						lineId: 'line-uuid',
						lineNo: 1,
						menuItemId: 'menu-item-uuid',
						itemName: 'Test item',
						quantity: 2,
						unitPriceMinor: '850',
						taxRateBp: 825,
						discountMinor: '0',
						modifiers: [
							{
								modifierId: 'modifier-uuid',
								modifierName: 'Extra',
								priceDeltaMinor: '50'
							}
						]
					}
				],
				totals: {
					// 1800 × 8.25% = 148.5, half away from zero → 149
					subtotalMinor: '1800',
					discountMinor: '0',
					taxMinor: '149',
					totalMinor: '1949'
				},
				payments: [
					{
						paymentId: 'payment-uuid',
						method: 'cash',
						amountMinor: '1949',
						tenderedMinor: '2000',
						changeMinor: '51'
					}
				]
			}
		};
		expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
	});

	it('is why the wire type is string: JSON.stringify throws on a bigint', () => {
		expect(() => JSON.stringify({ v: 850n })).toThrow(TypeError);
	});
});

describe('source text', () => {
	it('imports nothing, and says so in the header', () => {
		const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
		const stripped = stripComments(source);
		expect(stripped).not.toMatch(/^\s*import\b/m);
		expect(stripped).not.toMatch(/\bfrom\s+['"]/);
		expect(stripped).not.toMatch(/\bimport\(/);
		expect(stripped).not.toMatch(/\brequire\(/);
		// The header's promise must stay written down.
		expect(source).toContain('imports NOTHING');
	});
});
