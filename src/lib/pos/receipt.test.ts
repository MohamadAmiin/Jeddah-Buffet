import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SaleSnapshot } from './store';
import {
	formatBusinessDate,
	formatDateTime,
	renderKitchenTicket,
	renderReceipt,
	toPrintable,
	type PrintLine,
	type ReceiptInput
} from './receipt';

// The formatter is a pure function of the STORED snapshot: every figure below is
// the stored string formatted, never recomputed (invariants 1, 7; spec 17).

type Line = SaleSnapshot['payload']['lines'][number];
type Payment = SaleSnapshot['payload']['payments'][number];

function snapshot(over: {
	taxMode?: 'exclusive' | 'inclusive';
	totals?: SaleSnapshot['payload']['totals'];
	lines?: Line[];
	lineAmountsMinor?: string[];
	payments?: Payment[];
	orderType?: 'dine_in' | 'takeaway' | 'delivery';
	tableLabel?: string | null;
	note?: string | null;
	businessDate?: string | null;
	invoiceNumber?: string;
}): SaleSnapshot {
	const lines: Line[] = over.lines ?? [
		{
			lineId: 'l1',
			lineNo: 1,
			menuItemId: 'i1',
			itemName: 'Burger',
			quantity: 1,
			unitPriceMinor: '800',
			taxRateBp: 1000,
			discountMinor: '0',
			modifiers: []
		}
	];
	return {
		payload: {
			orderId: 'o1',
			posSessionId: 's1',
			orderType: over.orderType ?? 'takeaway',
			tableLabel: over.tableLabel ?? null,
			note: over.note ?? null,
			taxMode: over.taxMode ?? 'exclusive',
			currencyCode: 'USD',
			menuVersion: 3,
			invoiceSeq: 231,
			invoiceNumber: over.invoiceNumber ?? 'POS1-000231',
			openedAt: '2026-09-14T16:30:00Z',
			lines,
			totals: over.totals ?? {
				subtotalMinor: '800',
				discountMinor: '0',
				taxMinor: '80',
				totalMinor: '880'
			},
			payments: over.payments ?? [
				{
					paymentId: 'p1',
					method: 'cash',
					amountMinor: '880',
					tenderedMinor: '1000',
					changeMinor: '120'
				}
			]
		},
		lineAmountsMinor: over.lineAmountsMinor ?? ['800'],
		cashierName: 'Amina',
		completedAt: '2026-09-14T16:42:00Z',
		businessDate: over.businessDate === undefined ? '2026-09-14' : over.businessDate
	};
}

const header = {
	restaurantName: 'Maqaayadda Hodan',
	address: 'Makka Al-Mukarama Rd, Km4',
	phone: '61 555 0142',
	taxRegistrationNumber: null,
	footer: 'Mahadsanid! Thank you!'
};

function input(sale: SaleSnapshot): ReceiptInput {
	return { sale, header, timeZone: 'Africa/Mogadishu', deviceCode: 'POS1' };
}

const text = (lines: PrintLine[]) => lines.map((l) => l.text);
const find = (lines: PrintLine[], re: RegExp) => text(lines).find((t) => re.test(t));

describe('toPrintable', () => {
	it('maps the money formatter and typographic characters to ASCII, strips accents, defuses control bytes', () => {
		expect(toPrintable('−8.50')).toBe('-8.50');
		expect(toPrintable('8.50 USD')).toBe('8.50 USD');
		expect(toPrintable('Lo’')).toBe("Lo'");
		expect(toPrintable('“quoted” – — … 2×3')).toBe('"quoted" - - ... 2x3');
		expect(toPrintable('Café')).toBe('Cafe');
		expect(toPrintable('a\u001bpb')).toBe('a pb');
		expect(toPrintable('π')).toBe('?');
		expect(toPrintable('plain ASCII 123')).toBe('plain ASCII 123');
	});
});

describe('renderReceipt — MANDATORY (spec 29): tax in both modes, money on paper', () => {
	it('exclusive: prints the stored subtotal, tax at the shared rate and total, never recomputed', () => {
		const lines = renderReceipt(input(snapshot({})), { width: 32 });
		expect(find(lines, /^Subtotal/)).toMatch(/^Subtotal\s+8\.00$/);
		expect(find(lines, /^Tax /)).toMatch(/^Tax 10\.00%\s+0\.80$/);
		const total = lines.find((l) => /^TOTAL/.test(l.text))!;
		expect(total.text).toMatch(/^TOTAL\s+8\.80$/);
		expect(total.bold).toBe(true);
		expect(total.size).toBe('tall');
		expect(find(lines, /^CASH/)).toMatch(/^CASH\s+10\.00$/);
		expect(find(lines, /^CHANGE/)).toMatch(/^CHANGE\s+1\.20$/);
	});

	it('inclusive: prints exactly the stored figures — 7.27 / 0.73 / 8.00 for one 800 line at 1000 bp', () => {
		const sale = snapshot({
			taxMode: 'inclusive',
			totals: { subtotalMinor: '727', discountMinor: '0', taxMinor: '73', totalMinor: '800' }
		});
		const lines = renderReceipt(input(sale), { width: 32 });
		expect(find(lines, /^Subtotal/)).toMatch(/^Subtotal\s+7\.27$/);
		expect(find(lines, /^Incl\. tax/)).toMatch(/^Incl\. tax 10\.00%\s+0\.73$/);
		expect(find(lines, /^TOTAL/)).toMatch(/^TOTAL\s+8\.00$/);
	});

	it('prints the header, the order lines with their stored amounts, and the footer', () => {
		const lines = text(renderReceipt(input(snapshot({})), { width: 32 }));
		expect(lines[0]!.trim()).toBe('Maqaayadda Hodan');
		expect(lines.some((l) => l.trim() === 'Makka Al-Mukarama Rd, Km4')).toBe(true);
		expect(lines.some((l) => l.trim() === 'Tel 61 555 0142')).toBe(true);
		expect(find(renderReceipt(input(snapshot({})), { width: 32 }), /^Date\/Time/)).toBe(
			'Date/Time      14 Sep 2026 19:42'
		);
		expect(lines).toContain('Business date        14 Sep 2026');
		expect(lines).toContain('Invoice              POS1-000231');
		expect(lines).toContain('Order #231              Takeaway');
		expect(lines).toContain('Cashier                    Amina');
		expect(lines).toContain('  1 Burger                  8.00');
		expect(lines.some((l) => l.trim() === 'Mahadsanid! Thank you!')).toBe(true);
		expect(lines.some((l) => l.trim() === 'All amounts in USD')).toBe(true);
		expect(lines.some((l) => l.trim() === 'matcami POS  POS1')).toBe(true);
		// Not a copy: no banner, no reprint lines.
		expect(lines.some((l) => /COPY|Reprint/.test(l))).toBe(false);
	});

	it('dine-in with a table pairs the table with the cashier; no business date line when unknown', () => {
		const withTable = text(
			renderReceipt(
				input(snapshot({ orderType: 'dine_in', tableLabel: '4', businessDate: null })),
				{
					width: 32
				}
			)
		);
		expect(withTable).toContain('Order #231               Dine-in');
		expect(withTable).toContain('Table 4            Cashier Amina');
		expect(withTable.some((l) => l.startsWith('Business date'))).toBe(false);
	});

	it('a −50 modifier prints -0.50 (never U+2212, never a bare 0.50); a zero delta prints no amount; quantity > 1 shows the unit price', () => {
		const sale = snapshot({
			lines: [
				{
					lineId: 'l1',
					lineNo: 1,
					menuItemId: 'i1',
					itemName: 'Burger',
					quantity: 2,
					unitPriceMinor: '800',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: [
						{ modifierId: 'm1', modifierName: 'No cheese', priceDeltaMinor: '-50' },
						{ modifierId: 'm2', modifierName: 'Well done', priceDeltaMinor: '0' }
					]
				}
			],
			lineAmountsMinor: ['1500'],
			totals: { subtotalMinor: '1500', discountMinor: '0', taxMinor: '150', totalMinor: '1650' }
		});
		const lines = text(renderReceipt(input(sale), { width: 32 }));
		expect(lines).toContain('  2 Burger                 15.00');
		expect(lines).toContain('    + No cheese            -0.50');
		expect(lines).toContain('    + Well done                 ');
		expect(lines).toContain('    @ 8.00 each');
		expect(lines.some((l) => l.includes('−'))).toBe(false);
	});

	it('card and mobile print the tender with the amount and no change line; a discount prints negative', () => {
		const card = text(
			renderReceipt(
				input(
					snapshot({
						payments: [
							{
								paymentId: 'p',
								method: 'card',
								amountMinor: '880',
								tenderedMinor: null,
								changeMinor: null
							}
						]
					})
				),
				{ width: 32 }
			)
		);
		expect(card).toContain('CARD                        8.80');
		expect(card.some((l) => l.startsWith('CHANGE'))).toBe(false);
		const discounted = text(
			renderReceipt(
				input(
					snapshot({
						totals: {
							subtotalMinor: '800',
							discountMinor: '100',
							taxMinor: '70',
							totalMinor: '770'
						}
					})
				),
				{ width: 32 }
			)
		);
		expect(discounted).toContain('Discount                   -1.00');
	});

	it('mixed rates say so instead of printing one rate', () => {
		const sale = snapshot({
			lines: [
				{
					lineId: 'a',
					lineNo: 1,
					menuItemId: 'i1',
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: '200',
					taxRateBp: 500,
					discountMinor: '0',
					modifiers: []
				},
				{
					lineId: 'b',
					lineNo: 2,
					menuItemId: 'i2',
					itemName: 'Burger',
					quantity: 1,
					unitPriceMinor: '800',
					taxRateBp: 1000,
					discountMinor: '0',
					modifiers: []
				}
			],
			lineAmountsMinor: ['200', '800'],
			totals: { subtotalMinor: '1000', discountMinor: '0', taxMinor: '90', totalMinor: '1090' }
		});
		expect(find(renderReceipt(input(sale), { width: 32 }), /^Tax/)).toMatch(
			/^Tax \(mixed rates\)\s+0\.90$/
		);
	});
});

describe('widths — 32 and 48, hostile input', () => {
	const hostile = snapshot({
		orderType: 'dine_in',
		tableLabel: 'Window seat by the big old mango tree 12',
		lines: [
			{
				lineId: 'l1',
				lineNo: 1,
				menuItemId: 'i1',
				itemName: 'x'.repeat(60) + ' ' + 'y'.repeat(59),
				quantity: 3,
				unitPriceMinor: '800',
				taxRateBp: 1000,
				discountMinor: '0',
				modifiers: [
					{ modifierId: 'm1', modifierName: 'No cheese', priceDeltaMinor: '-50' },
					{
						modifierId: 'm2',
						modifierName: 'Extra sauce — café style \u001b',
						priceDeltaMinor: '50'
					},
					{ modifierId: 'm3', modifierName: 'Well done', priceDeltaMinor: '0' }
				]
			}
		],
		lineAmountsMinor: ['2400'],
		totals: { subtotalMinor: '2400', discountMinor: '0', taxMinor: '240', totalMinor: '2640' },
		note: 'no onions please, and pack the sauce separately because the guest is allergic'
	});

	it.each([32, 48] as const)('every line fits width %i and is printable ASCII', (width) => {
		for (const render of [renderReceipt, renderKitchenTicket]) {
			for (const copy of [undefined, { reprintedAt: '2026-09-14T17:05:00Z', by: 'Amina' }]) {
				const lines = render(input(hostile), { width, copy });
				expect(lines.length).toBeGreaterThan(5);
				for (const l of lines) {
					const max = l.size === 'double' ? Math.floor(width / 2) : width;
					expect(l.text.length, l.text).toBeLessThanOrEqual(max);
					expect(l.text, l.text).toMatch(/^[\x20-\x7e]*$/);
				}
			}
		}
	});

	it('a 40-character table label still keeps the cashier on the paper', () => {
		const lines = text(renderReceipt(input(hostile), { width: 32 }));
		expect(lines.some((l) => /Cashier Amina$/.test(l))).toBe(true);
	});
});

describe('COPY', () => {
	it('a reprint starts with the banner, names the reprint, and repeats the original figures exactly', () => {
		const sale = snapshot({});
		const original = renderReceipt(input(sale), { width: 32 });
		const copy = renderReceipt(input(sale), {
			width: 32,
			copy: { reprintedAt: '2026-09-14T17:05:00Z', by: 'Farhiya' }
		});
		const t = text(copy);
		expect(t.slice(0, 3)).toEqual([
			'*'.repeat(32),
			'*             COPY             *',
			'*'.repeat(32)
		]);
		expect(t).toContain('Reprinted      14 Sep 2026 20:05');
		expect(t).toContain('Reprint by               Farhiya');
		expect(t.some((l) => l.includes('This is a COPY of a receipt'))).toBe(true);
		const figures = (lines: PrintLine[]) =>
			text(lines).filter((l) =>
				/^(\s*\d+ |Subtotal|Tax|Incl|TOTAL|CASH|CHANGE|CARD|MOBILE)/.test(l)
			);
		expect(figures(copy)).toEqual(figures(original));
	});
});

describe('renderKitchenTicket', () => {
	it('is upper case, has ORDER n at double size, the note block, and no amounts', () => {
		const lines = renderKitchenTicket(
			input(
				snapshot({
					orderType: 'dine_in',
					tableLabel: '4',
					note: 'no onions',
					lines: [
						{
							lineId: 'l1',
							lineNo: 1,
							menuItemId: 'i1',
							itemName: 'Burger',
							quantity: 1,
							unitPriceMinor: '800',
							taxRateBp: 1000,
							discountMinor: '0',
							modifiers: [{ modifierId: 'm1', modifierName: 'No cheese', priceDeltaMinor: '-50' }]
						}
					]
				})
			),
			{ width: 48 }
		);
		const order = lines.find((l) => /ORDER 231/.test(l.text))!;
		expect(order.size).toBe('double');
		expect(order.text.length).toBeLessThanOrEqual(24);
		expect(lines.find((l) => /TABLE 4/.test(l.text))?.size).toBe('double');
		const t = text(lines);
		expect(t.some((l) => /^BY AMINA\s+14 SEP 2026 19:42$/.test(l))).toBe(true);
		expect(t.some((l) => /^DINE-IN\s+TERMINAL POS1$/.test(l))).toBe(true);
		expect(t).toContain('   1 BURGER');
		expect(t).toContain('     + NO CHEESE');
		expect(t).toContain('** NOTE **');
		expect(t).toContain('NO ONIONS');
		expect(t.some((l) => l.includes('*** END OF TICKET ***'))).toBe(true);
		for (const l of t) {
			expect(l, l).not.toMatch(/\d\.\d{2}\b/);
			expect(l, l).toBe(l.toUpperCase());
		}
	});

	it('a copy ticket says *** COPY ***; a takeaway prints its type as the banner; no note block without a note', () => {
		const t = text(
			renderKitchenTicket(input(snapshot({ orderType: 'takeaway' })), {
				width: 32,
				copy: { reprintedAt: '2026-09-14T17:05:00Z', by: 'Amina' }
			})
		);
		expect(t.some((l) => l.includes('*** COPY ***'))).toBe(true);
		expect(t.some((l) => /^\s*TAKEAWAY\s*$/.test(l))).toBe(true);
		expect(t).not.toContain('** NOTE **');
	});
});

describe('dates', () => {
	it('formats the sale time in the restaurant zone and the business date by string surgery', () => {
		expect(formatDateTime('2026-09-14T16:42:00Z', 'Africa/Mogadishu')).toBe('14 Sep 2026 19:42');
		expect(formatDateTime('2026-09-14T23:30:00Z', 'UTC')).toBe('14 Sep 2026 23:30');
		expect(formatBusinessDate('2026-09-14')).toBe('14 Sep 2026');
		expect(formatBusinessDate('2026-01-02')).toBe('02 Jan 2026');
	});
});

describe("source tripwire — the formatter cannot recompute or read today's settings", () => {
	it('imports and calls none of the arithmetic or settings paths', () => {
		const source = readFileSync(new URL('./receipt.ts', import.meta.url), 'utf8');
		for (const banned of [
			'cartTotals',
			'computeOrderTotals',
			'changeDue',
			'taxOnLine',
			'readMenu',
			'readCachedSetting',
			'parseFloat',
			'.toFixed(',
			'Number(',
			'Math.round'
		]) {
			expect(source.includes(banned), banned).toBe(false);
		}
	});
});
