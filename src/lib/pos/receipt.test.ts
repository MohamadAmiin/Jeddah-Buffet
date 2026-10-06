import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RECEIPT_LAYOUT,
	RECEIPT_SHOW_KEYS,
	type ReceiptLayout,
	type ReceiptShow
} from '../receipt-layout';
import type { SaleSnapshot } from './store';
import {
	formatBusinessDate,
	formatDateTime,
	isImageLine,
	renderKitchenTicket,
	renderReceipt,
	renderTestPage,
	toPrintable,
	type PrintLine,
	type ReceiptInput,
	type TextLine
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
	/** The stored per-rate rows (T-19); absent = a sale completed before them. */
	taxBreakdown?: SaleSnapshot['taxBreakdown'];
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
		businessDate: over.businessDate === undefined ? '2026-09-14' : over.businessDate,
		...(over.taxBreakdown === undefined ? {} : { taxBreakdown: over.taxBreakdown })
	};
}

const header = {
	restaurantName: 'Maqaayadda Hodan',
	address: 'Makka Al-Mukarama Rd, Km4',
	phone: '61 555 0142',
	taxRegistrationNumber: null
};

/** Today's layout with the fixture footer, any field — or any one switch — overridden. */
function layoutWith(
	over: Partial<Omit<ReceiptLayout, 'show'>> & { show?: Partial<ReceiptShow> } = {}
): ReceiptLayout {
	return {
		...DEFAULT_RECEIPT_LAYOUT,
		footerLines: ['Mahadsanid! Thank you!'],
		...over,
		show: { ...DEFAULT_RECEIPT_LAYOUT.show, ...over.show }
	};
}

function input(sale: SaleSnapshot, over: Partial<Omit<ReceiptInput, 'sale'>> = {}): ReceiptInput {
	return {
		sale,
		header,
		timeZone: 'Africa/Mogadishu',
		deviceCode: 'POS1',
		layout: { ...DEFAULT_RECEIPT_LAYOUT, footerLines: ['Mahadsanid! Thank you!'] },
		paymentNumbers: [],
		logo: null,
		...over
	};
}

/** The text lines only: an image line has no text and no width to measure. */
const text = (lines: PrintLine[]) =>
	lines.filter((l): l is TextLine => !isImageLine(l)).map((l) => l.text);
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
		const total = lines
			.filter((l): l is TextLine => !isImageLine(l))
			.find((l) => /^TOTAL/.test(l.text))!;
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

// A line stored with its rate's NAME (T-19) — the same sale as the two tests
// above, so the figures are the same stored strings; only the label changes.
const vatLine: Line = {
	lineId: 'l1',
	lineNo: 1,
	menuItemId: 'i1',
	itemName: 'Burger',
	quantity: 1,
	unitPriceMinor: '800',
	taxRateBp: 1000,
	taxRateId: 'r-vat',
	taxRateName: 'VAT',
	discountMinor: '0',
	modifiers: []
};

describe('renderReceipt — MANDATORY (spec 29): a named rate in both modes', () => {
	it("exclusive: the rate's stored name labels the tax line — VAT 10.00%  0.80", () => {
		const lines = renderReceipt(input(snapshot({ lines: [vatLine] })), { width: 32 });
		expect(find(lines, /^VAT/)).toMatch(/^VAT 10\.00%\s+0\.80$/);
		expect(find(lines, /^Tax /)).toBeUndefined();
		expect(find(lines, /^Subtotal/)).toMatch(/^Subtotal\s+8\.00$/);
		expect(find(lines, /^TOTAL/)).toMatch(/^TOTAL\s+8\.80$/);
	});

	it('inclusive: Incl. VAT 10.00%  0.73', () => {
		const sale = snapshot({
			lines: [vatLine],
			taxMode: 'inclusive',
			totals: { subtotalMinor: '727', discountMinor: '0', taxMinor: '73', totalMinor: '800' }
		});
		const lines = renderReceipt(input(sale), { width: 32 });
		expect(find(lines, /^Incl\. VAT/)).toMatch(/^Incl\. VAT 10\.00%\s+0\.73$/);
		expect(find(lines, /^Incl\. tax/)).toBeUndefined();
		expect(find(lines, /^TOTAL/)).toMatch(/^TOTAL\s+8\.00$/);
	});
});

describe('renderReceipt — MANDATORY (spec 29): the stored per-rate rows in both modes', () => {
	// Tea at Reduced 5%, Burger at VAT 10%: a recomputation would give 10 / 80;
	// the STORED rows say 11 / 79, and the stored rows are what prints.
	const REDUCED = { name: 'Reduced', rateBp: 500, taxMinor: '11' };
	const VAT = { name: 'VAT', rateBp: 1000, taxMinor: '79' };
	const twoRates = (over: {
		taxMode?: 'exclusive' | 'inclusive';
		taxBreakdown?: SaleSnapshot['taxBreakdown'];
	}) =>
		snapshot({
			taxMode: over.taxMode,
			lines: [
				{
					lineId: 'a',
					lineNo: 1,
					menuItemId: 'i1',
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: '200',
					taxRateBp: 500,
					taxRateId: 'r-reduced',
					taxRateName: 'Reduced',
					discountMinor: '0',
					modifiers: []
				},
				{ ...vatLine, lineId: 'b', lineNo: 2, menuItemId: 'i2' }
			],
			lineAmountsMinor: ['200', '800'],
			totals: { subtotalMinor: '1000', discountMinor: '0', taxMinor: '90', totalMinor: '1090' },
			taxBreakdown: over.taxBreakdown
		});

	it('exclusive: one row per stored row, as stored and in stored order, and no mixed-rates line', () => {
		const t = text(renderReceipt(input(twoRates({ taxBreakdown: [REDUCED, VAT] })), { width: 32 }));
		const subtotal = t.findIndex((l) => l.startsWith('Subtotal'));
		expect(subtotal).toBeGreaterThan(-1);
		expect(t[subtotal + 1]).toMatch(/^Reduced 5\.00%\s+0\.11$/);
		expect(t[subtotal + 2]).toMatch(/^VAT 10\.00%\s+0\.79$/);
		expect(t[subtotal + 3]).toBe('='.repeat(32));
		expect(t.some((l) => /mixed rates/.test(l))).toBe(false);
		expect(t.some((l) => /^Tax /.test(l))).toBe(false);
	});

	it('inclusive: Incl. Reduced 5.00% and Incl. VAT 10.00%', () => {
		const t = text(
			renderReceipt(input(twoRates({ taxMode: 'inclusive', taxBreakdown: [REDUCED, VAT] })), {
				width: 32
			})
		);
		expect(t.some((l) => /^Incl\. Reduced 5\.00%\s+0\.11$/.test(l))).toBe(true);
		expect(t.some((l) => /^Incl\. VAT 10\.00%\s+0\.79$/.test(l))).toBe(true);
		expect(t.some((l) => /mixed rates/.test(l))).toBe(false);
	});

	it('with the switch off, one Tax (mixed rates) line prints the stored total', () => {
		const lines = renderReceipt(
			input(twoRates({ taxBreakdown: [REDUCED, VAT] }), {
				layout: layoutWith({ show: { taxBreakdown: false } })
			}),
			{ width: 32 }
		);
		expect(find(lines, /^Tax/)).toMatch(/^Tax \(mixed rates\)\s+0\.90$/);
		expect(text(lines).some((l) => /^(Reduced|VAT)/.test(l))).toBe(false);
	});

	it('no stored rows (a sale from before T-19), a single row, or a row that is not an integer string → the mixed-rates line', () => {
		const cases: Array<SaleSnapshot['taxBreakdown']> = [
			undefined,
			[VAT],
			[REDUCED, { ...VAT, taxMinor: '1.5' }]
		];
		for (const taxBreakdown of cases) {
			const lines = renderReceipt(input(twoRates({ taxBreakdown })), { width: 32 });
			const label = JSON.stringify(taxBreakdown);
			expect(find(lines, /^Tax/), label).toMatch(/^Tax \(mixed rates\)\s+0\.90$/);
			expect(
				text(lines).filter((l) => /^(Tax|Reduced|VAT)/.test(l)),
				label
			).toHaveLength(1);
		}
	});
});

describe('the hideable lines (Settings 4) — each switch alone removes or replaces exactly its line', () => {
	// Dine-in at table 4, a quantity-2 line (so the unit price prints), one
	// payment-number entry, width 32: every hideable line is on this receipt.
	const sale = snapshot({
		orderType: 'dine_in',
		tableLabel: '4',
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
				modifiers: []
			}
		],
		lineAmountsMinor: ['1600'],
		totals: { subtotalMinor: '1600', discountMinor: '0', taxMinor: '160', totalMinor: '1760' },
		payments: [
			{
				paymentId: 'p1',
				method: 'cash',
				amountMinor: '1760',
				tenderedMinor: '2000',
				changeMinor: '240'
			}
		]
	});
	const numbers = [{ name: 'EVC Plus', number: '61 234 5678' }];
	const render = (show: Partial<ReceiptShow> = {}) =>
		text(
			renderReceipt(input(sale, { layout: layoutWith({ show }), paymentNumbers: numbers }), {
				width: 32
			})
		);
	const base = render();
	/** The base receipt with `count` lines removed from the first line matching. */
	const without = (match: string | ((l: string) => boolean), count = 1) => {
		const at = base.findIndex((l) => (typeof match === 'string' ? l === match : match(l)));
		expect(at).toBeGreaterThan(-1);
		return [...base.slice(0, at), ...base.slice(at + count)];
	};
	/** The base receipt with one line replaced. */
	const replaced = (from: string, to: string) => {
		expect(base).toContain(from);
		return base.map((l) => (l === from ? to : l));
	};

	it('businessDate drops its line', () => {
		expect(render({ businessDate: false })).toEqual(without('Business date        14 Sep 2026'));
	});
	it('orderType leaves the bare order number', () => {
		expect(render({ orderType: false })).toEqual(
			replaced('Order #231               Dine-in', 'Order #231')
		);
	});
	it('table leaves the cashier alone on the line', () => {
		expect(render({ table: false })).toEqual(
			replaced('Table 4            Cashier Amina', 'Cashier                    Amina')
		);
	});
	it('cashier leaves the table alone on the line', () => {
		expect(render({ cashier: false })).toEqual(
			replaced('Table 4            Cashier Amina', 'Table 4')
		);
	});
	it('table and cashier both off drop the line; a takeaway with the cashier off has no cashier line', () => {
		expect(render({ table: false, cashier: false })).toEqual(
			without('Table 4            Cashier Amina')
		);
		const takeaway = text(
			renderReceipt(input(snapshot({}), { layout: layoutWith({ show: { cashier: false } }) }), {
				width: 32
			})
		);
		expect(takeaway.some((l) => l.startsWith('Cashier'))).toBe(false);
	});
	it('unitPrice drops the @ each line', () => {
		expect(render({ unitPrice: false })).toEqual(without('    @ 8.00 each'));
	});
	it('currencyLine and deviceLine each drop their centred line', () => {
		expect(render({ currencyLine: false })).toEqual(
			without((l) => l.trim() === 'All amounts in USD')
		);
		expect(render({ deviceLine: false })).toEqual(without((l) => l.trim() === 'matcami POS  POS1'));
	});
	it('paymentNumbers drops the pair and its rule', () => {
		const at = base.findIndex((l) => /^EVC Plus\s+61 234 5678$/.test(l));
		expect(at).toBeGreaterThan(-1);
		expect(base[at + 1]).toBe('-'.repeat(32));
		expect(render({ paymentNumbers: false })).toEqual(
			without((l) => /^EVC Plus\s+61 234 5678$/.test(l), 2)
		);
	});
	it('taxBreakdown changes nothing on a one-rate sale', () => {
		expect(render({ taxBreakdown: false })).toEqual(base);
	});
});

describe('never hideable (Settings 4; spec 33 decision 3 stays open)', () => {
	it('with every switch off, a COPY still carries the name, Tax no., Date/Time, Invoice, the item, the totals, the payment and the COPY marks', () => {
		const allOff = Object.fromEntries(RECEIPT_SHOW_KEYS.map((key) => [key, false])) as ReceiptShow;
		const lines = renderReceipt(
			input(snapshot({ orderType: 'dine_in', tableLabel: '4' }), {
				header: { ...header, taxRegistrationNumber: 'TIN-1' },
				layout: layoutWith({
					show: allOff,
					headerLines: ['Open daily 7-23'],
					paymentNumbersHeading: 'PAY BY MOBILE MONEY'
				}),
				paymentNumbers: [{ name: 'EVC Plus', number: '61 234 5678' }]
			}),
			{ width: 32, copy: { reprintedAt: '2026-09-14T17:05:00Z', by: 'Farhiya' } }
		);
		const t = text(lines);
		const trimmed = t.map((l) => l.trim());
		expect(trimmed).toContain('Maqaayadda Hodan');
		expect(trimmed).toContain('Tax no. TIN-1');
		expect(t.some((l) => l.startsWith('Date/Time'))).toBe(true);
		expect(t).toContain('Invoice              POS1-000231');
		expect(t).toContain('  1 Burger                  8.00');
		expect(find(lines, /^Subtotal/)).toMatch(/^Subtotal\s+8\.00$/);
		expect(find(lines, /^Tax /)).toMatch(/^Tax 10\.00%\s+0\.80$/);
		expect(find(lines, /^TOTAL/)).toMatch(/^TOTAL\s+8\.80$/);
		expect(find(lines, /^CASH/)).toMatch(/^CASH\s+10\.00$/);
		expect(find(lines, /^CHANGE/)).toMatch(/^CHANGE\s+1\.20$/);
		expect(t.slice(0, 3)).toEqual([
			'*'.repeat(32),
			'*             COPY             *',
			'*'.repeat(32)
		]);
		expect(t).toContain('Reprinted      14 Sep 2026 20:05');
		expect(t).toContain('Reprint by               Farhiya');
		expect(t.some((l) => l.includes('This is a COPY of a receipt'))).toBe(true);
		// The owner's own header line is not a switch: it still prints.
		expect(trimmed).toContain('Open daily 7-23');
		// And every hideable line is gone.
		expect(t).toContain('Order #231');
		expect(t.some((l) => /^(Business date|Table|Cashier)/.test(l))).toBe(false);
		expect(
			t.some((l) => /Dine-in|@ .* each|All amounts in|matcami POS|PAY BY|EVC Plus/.test(l))
		).toBe(false);
	});
});

describe('the payment line', () => {
	it('prints a card or mobile payment under its STORED method name in upper case, or the kind when none was stored; cash stays CASH / CHANGE', () => {
		const pay = (payment: Payment) =>
			text(renderReceipt(input(snapshot({ payments: [payment] })), { width: 32 }));
		const base = { paymentId: 'p', amountMinor: '880', tenderedMinor: null, changeMinor: null };
		expect(
			pay({ ...base, method: 'mobile', paymentMethodId: 'pm1', paymentMethodName: 'EVC Plus' })
		).toContain('EVC PLUS                    8.80');
		expect(
			pay({ ...base, method: 'card', paymentMethodId: 'pm2', paymentMethodName: 'Visa terminal' })
		).toContain('VISA TERMINAL               8.80');
		expect(pay({ ...base, method: 'mobile' })).toContain('MOBILE                      8.80');
		expect(
			pay({ ...base, method: 'card', paymentMethodId: null, paymentMethodName: null })
		).toContain('CARD                        8.80');
		// Cash prints by KIND, whatever the Cash row is called (Risk 1).
		const cash = pay({
			paymentId: 'p',
			method: 'cash',
			amountMinor: '880',
			tenderedMinor: '1000',
			changeMinor: '120',
			paymentMethodId: 'pm0',
			paymentMethodName: 'Cash'
		});
		expect(cash).toContain('CASH                       10.00');
		expect(cash).toContain('CHANGE                      1.20');
	});
});

describe('the payment-numbers block (Settings 6)', () => {
	const numbers = [
		{ name: 'EVC Plus', number: '61 234 5678' },
		{ name: 'Zaad', number: '63 345 6789' }
	];
	const render = (over: Partial<Omit<ReceiptInput, 'sale'>>) =>
		text(renderReceipt(input(snapshot({}), over), { width: 32 }));

	it('prints the centred heading and each entry, after the payment and before the footer, closed by a rule', () => {
		const t = render({
			layout: layoutWith({ paymentNumbersHeading: 'PAY BY MOBILE MONEY' }),
			paymentNumbers: numbers
		});
		const change = t.findIndex((l) => l.startsWith('CHANGE'));
		expect(change).toBeGreaterThan(-1);
		expect(t[change + 1]).toBe('-'.repeat(32));
		expect(t[change + 2]).toBe('      PAY BY MOBILE MONEY');
		expect(t[change + 3]).toMatch(/^EVC Plus\s+61 234 5678$/);
		expect(t[change + 4]).toMatch(/^Zaad\s+63 345 6789$/);
		expect(t[change + 5]).toBe('-'.repeat(32));
		expect(t[change + 6]!.trim()).toBe('Mahadsanid! Thank you!');
	});

	it('no heading line when the heading is null; an empty list prints no block and no extra rule', () => {
		const noHeading = render({ paymentNumbers: numbers });
		const change = noHeading.findIndex((l) => l.startsWith('CHANGE'));
		expect(noHeading[change + 1]).toBe('-'.repeat(32));
		expect(noHeading[change + 2]).toMatch(/^EVC Plus\s+61 234 5678$/);
		expect(noHeading.some((l) => l.includes('PAY BY'))).toBe(false);

		const empty = render({
			layout: layoutWith({ paymentNumbersHeading: 'PAY BY MOBILE MONEY' }),
			paymentNumbers: []
		});
		const at = empty.findIndex((l) => l.startsWith('CHANGE'));
		expect(empty[at + 1]).toBe('-'.repeat(32));
		expect(empty[at + 2]!.trim()).toBe('Mahadsanid! Thank you!');
		expect(empty.some((l) => l.includes('PAY BY'))).toBe(false);
		expect(empty).toEqual(render({}));
	});
});

describe('the logo line', () => {
	const logo = { widthDots: 8, heightDots: 1, bitmap: 'gA==' };

	it('is the first line of a receipt, exactly the given object; after the banner on a COPY; never on a kitchen ticket', () => {
		const lines = renderReceipt(input(snapshot({}), { logo }), { width: 32 });
		expect(lines[0]).toEqual({ image: { widthDots: 8, heightDots: 1, bitmap: 'gA==' } });
		expect(lines.filter(isImageLine)).toHaveLength(1);

		const copy = renderReceipt(input(snapshot({}), { logo }), {
			width: 32,
			copy: { reprintedAt: '2026-09-14T17:05:00Z', by: 'Farhiya' }
		});
		expect(text(copy).slice(0, 3)).toEqual([
			'*'.repeat(32),
			'*             COPY             *',
			'*'.repeat(32)
		]);
		expect(copy.slice(0, 3).some(isImageLine)).toBe(false);
		expect(copy[3]).toEqual({ image: { widthDots: 8, heightDots: 1, bitmap: 'gA==' } });

		expect(
			renderKitchenTicket(input(snapshot({}), { logo }), { width: 32 }).some(isImageLine)
		).toBe(false);
		expect(
			renderReceipt(input(snapshot({}), { logo: null }), { width: 32 }).some(isImageLine)
		).toBe(false);
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

	// The right-hand column is free text too: an employee's display name is up to
	// 200 characters (employees/+page.server.ts), and it lands on the receipt as
	// the cashier and as the reprinter. Every combination must stay inside the width.
	const LONG_NAME = 'Abdirahman Mohamed Abdullahi Hassan Ali Warsame Farah Nur Cabdi Xasan Yuusuf';
	const names = ['Amina', 'Farhiya Abdullahi Yusuf', LONG_NAME, 'X'.repeat(200)];

	// Owner-written text reaches the receipt from more places now (T-23): header
	// and footer lines of 120 characters, a 40-character heading, a 40-character
	// method name beside a 40-character number, and 40-character rate names on
	// the stored per-rate rows. Every one is hostile here — with a control byte,
	// a dash and an accent in the lines.
	const LONG_LINE = ('Soo dhawoow — Café \u001b ' + 'x'.repeat(120)).slice(0, 120);
	const RATE_A = 'R'.repeat(40);
	const RATE_B = 'S'.repeat(40);
	const hostileRates: SaleSnapshot = {
		...hostile,
		payload: {
			...hostile.payload,
			lines: [
				{ ...hostile.payload.lines[0]!, taxRateId: 'r-a', taxRateName: RATE_A },
				{
					lineId: 'l2',
					lineNo: 2,
					menuItemId: 'i2',
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: '200',
					taxRateBp: 500,
					taxRateId: 'r-b',
					taxRateName: RATE_B,
					discountMinor: '0',
					modifiers: []
				}
			],
			totals: { subtotalMinor: '2600', discountMinor: '0', taxMinor: '250', totalMinor: '2850' }
		},
		lineAmountsMinor: ['2400', '200'],
		taxBreakdown: [
			{ name: RATE_A, rateBp: 1000, taxMinor: '240' },
			{ name: RATE_B, rateBp: 500, taxMinor: '10' }
		]
	};
	const hostileLayout = layoutWith({
		headerLines: [LONG_LINE, LONG_LINE],
		footerLines: [LONG_LINE, 'Café Zócalo'],
		paymentNumbersHeading: 'H'.repeat(40)
	});
	const hostileNumbers = [{ name: 'M'.repeat(40), number: '1234567890'.repeat(4) }];
	const hostileLogo = { widthDots: 8, heightDots: 1, bitmap: 'gA==' };

	it.each([32, 48] as const)('every line fits width %i and is printable ASCII', (width) => {
		for (const render of [renderReceipt, renderKitchenTicket]) {
			for (const sale of [hostile, hostileRates]) {
				for (const cashierName of names) {
					for (const by of [undefined, ...names]) {
						const copy = by === undefined ? undefined : { reprintedAt: '2026-09-14T17:05:00Z', by };
						const lines = render(
							input(
								{ ...sale, cashierName },
								{ layout: hostileLayout, paymentNumbers: hostileNumbers, logo: hostileLogo }
							),
							{ width, copy }
						);
						expect(lines.length).toBeGreaterThan(5);
						for (const l of lines) {
							if (isImageLine(l)) continue;
							const max = l.size === 'double' ? Math.floor(width / 2) : width;
							expect(
								l.text.length,
								`${width}/${cashierName.length}/${by?.length}: ${l.text}`
							).toBeLessThanOrEqual(max);
							expect(l.text, l.text).toMatch(/^[\x20-\x7e]*$/);
						}
					}
				}
			}
		}
	});

	it('the hostile layout reaches the paper, wrapped and printable: Cafe for Café, the long lines, both rate rows, the method and its number', () => {
		const t = text(
			renderReceipt(
				input(hostileRates, { layout: hostileLayout, paymentNumbers: hostileNumbers }),
				{ width: 32 }
			)
		);
		expect(t.some((l) => l.trim() === 'Cafe Zocalo')).toBe(true);
		// The 120-character line wraps and each piece is centred: the first piece
		// is the four words before the x's (the ESC became a space), padded.
		expect(t.some((l) => l.trim() === 'Soo dhawoow - Cafe')).toBe(true);
		expect(t.some((l) => l.includes('\u001b') || l.includes('—') || l.includes('é'))).toBe(false);
		// A 40-character rate name wraps inside the label room; the amount stays on the first line.
		expect(t.some((l) => /^R{27} +2\.40$/.test(l))).toBe(true);
		expect(t.some((l) => /^R{13} 10\.00%$/.test(l))).toBe(true);
		expect(t.some((l) => /^S{27} +0\.10$/.test(l))).toBe(true);
		expect(t.some((l) => /^S{13} 5\.00%$/.test(l))).toBe(true);
		// The heading and the method name hard-split at the width; the number goes right-aligned under the name.
		expect(t).toContain('H'.repeat(32));
		expect(t).toContain('M'.repeat(32));
		expect(t).toContain('M'.repeat(8));
		expect(t).toContain('12345678901234567890123456789012');
		expect(t).toContain('34567890'.padStart(32));
	});

	it('a long cashier name moves to its own right-aligned line and no label is ever split', () => {
		const name = 'Farhiya Abdullahi Yusuf';
		// Dine-in: the table label keeps its line; "Cashier <name>" (31 chars) goes below it, right-aligned.
		const dineIn = text(renderReceipt(input({ ...hostile, cashierName: name }), { width: 32 }));
		expect(dineIn).toContain(`Cashier ${name}`.padStart(32));
		expect(dineIn.some((l) => l.startsWith('Table Window seat'))).toBe(true);
		// Takeaway, 23 characters: the label still shares the line (8 columns are left for it).
		const takeaway = (cashierName: string) =>
			text(
				renderReceipt(
					input({
						...hostile,
						cashierName,
						payload: { ...hostile.payload, orderType: 'takeaway', tableLabel: null }
					}),
					{ width: 32 }
				)
			);
		expect(takeaway(name)).toContain(`Cashier  ${name}`);
		// Takeaway, 28 characters: the bare label on its own line, the name right-aligned under it.
		const longer = 'Mohamed Abdullahi Hassan Ali';
		const lines = takeaway(longer);
		const at = lines.indexOf('Cashier');
		expect(at).toBeGreaterThan(-1);
		expect(lines[at + 1]).toBe(longer.padStart(32));
		expect(lines.some((l) => /^Cas\b/.test(l) || /^hie/.test(l))).toBe(false);
		// A short name shares the label's line as before.
		expect(takeaway('Amina').some((l) => /^Cashier\s+Amina$/.test(l))).toBe(true);
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

describe('renderTestPage (T-29)', () => {
	for (const width of [32, 48] as const) {
		it(`at ${width}: every line fits, the ruler is exactly ${width} long, all printable ASCII`, () => {
			// The page is PrintLine[] since T-24; without a logo it holds text lines only.
			const lines = renderTestPage({
				width,
				restaurantName: 'Café Zócalo — “Home”',
				deviceCode: 'POS1',
				now: '2026-09-29T07:15:00Z',
				timeZone: 'Africa/Mogadishu',
				printer: 'kitchen'
			}).filter((l): l is TextLine => !isImageLine(l));
			expect(lines.length).toBeGreaterThan(8);
			for (const l of lines) {
				expect(l.text.length, l.text).toBeLessThanOrEqual(width);
				expect(l.text, l.text).toMatch(/^[\x20-\x7e]*$/);
			}
			const ruler = lines.find((l) => l.text.startsWith('1234567890'))!;
			expect(ruler.text).toHaveLength(width);
			expect(ruler.text).toBe('1234567890'.repeat(5).slice(0, width));
			const t = lines.map((l) => l.text.trim());
			expect(t).toContain('TEST PRINT');
			expect(t).toContain('KITCHEN PRINTER');
			expect(t).toContain(`${width} COLUMNS`);
			expect(t).toContain('Cafe Zocalo - "Home"');
			expect(t).toContain('TERMINAL POS1');
			expect(t).toContain('29 Sep 2026 10:15');
			expect(lines.find((l) => l.text.trim() === 'TEST PRINT')?.size).toBe('tall');
		});
	}
});

describe('renderTestPage with the logo (T-24)', () => {
	const page = {
		width: 32 as const,
		restaurantName: 'Maqaayadda Hodan',
		deviceCode: 'POS1',
		now: '2026-09-29T07:15:00Z',
		timeZone: 'Africa/Mogadishu',
		printer: 'receipt' as const
	};
	const logo = { widthDots: 8, heightDots: 1, bitmap: 'gA==' };

	it('prints the image FIRST, exactly as given, and the same text lines after it', () => {
		const withLogo = renderTestPage({ ...page, logo });
		expect(withLogo[0]).toEqual({ image: { widthDots: 8, heightDots: 1, bitmap: 'gA==' } });
		expect(withLogo.filter(isImageLine)).toHaveLength(1);
		expect(withLogo.slice(1)).toEqual(renderTestPage(page));
		expect(withLogo.slice(1).some(isImageLine)).toBe(false);
	});

	it('a null or an absent logo gives no image line, and the same page', () => {
		expect(renderTestPage({ ...page, logo: null }).some(isImageLine)).toBe(false);
		expect(renderTestPage(page).some(isImageLine)).toBe(false);
		expect(renderTestPage({ ...page, logo: null })).toEqual(renderTestPage(page));
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
			'Math.round',
			// T-23: the per-rate rows are STORED by the sale (T-19) and the layout,
			// numbers and logo are passed in by printing.ts — never computed or read here.
			'taxBreakdown(',
			'readReceiptLayout',
			'readPaymentMethods',
			'readReceiptLogo'
		]) {
			expect(source.includes(banned), banned).toBe(false);
		}
	});
});
