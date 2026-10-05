// THE RECEIPT AND KITCHEN-TICKET FORMATTER (spec 11, 17; tasks/menu-and-printing
// T-23; tasks/settings-tax-payments-receipt T-23). Pure: it takes the sale's
// STORED snapshot (src/lib/pos/store.ts SaleSnapshot — the queued payload, the
// per-line amounts, the stored per-rate tax rows, cashier, time) plus what the
// CALLER passes in — the owner's receipt layout, the payment numbers and the
// logo, which src/lib/pos/printing.ts reads from the till's cache — and returns
// lines for the print agent to encode: printable ASCII text lines and, on a
// receipt, at most one image line. It reads no setting and computes nothing.
// It runs on the till, so it works offline.
//
// EVERY AMOUNT ON PAPER IS A STORED STRING FORMATTED, NEVER RECOMPUTED
// (invariants 1 and 7). This file imports none of the totals, change or tax
// helpers and no settings or menu reader (receipt.test.ts pins that by name):
// a reprint after a tax-mode change prints the sale's own figures, which are
// the ledger's. The per-rate tax rows are the sale's stored breakdown, printed
// as stored and in stored order — never summed here and never checked against
// the total: the money module made them add up when the sale was completed.
//
// WHAT THE OWNER MAY HIDE is decided here, not by the database (CLAUDE.md
// "Settings 4"): each of the layout's nine switches removes or replaces ONE
// line. The restaurant name, the invoice number, the date and time, the items,
// the subtotal, discount, tax and total, the payment, the COPY marks and the
// tax registration number when one is set have no switch and always print
// (spec 33 decision 3 stays open; this layout is the default pending it).
//
// RECEIPTS ARE A SEPARATE PROBLEM (CLAUDE.md, design-system §8): 32 or 48 fixed
// characters, no colour, monospace. A thermal printer in code page PC437 obeys
// control bytes and misprints anything outside 0x20–0x7E, so toPrintable maps
// the money formatter's U+2212 minus and U+00A0 space, curly quotes, dashes and
// accents to ASCII, turns control characters (an ESC pasted into a table label)
// into spaces, and every other character into '?' — BEFORE any width is measured.
// Every owner-written text — a header or footer line, the heading, a method or
// rate name — goes through it the same way.
import { formatAmount, moneyFormatFor } from '../money/format';
import { minor } from '../money';
// Aliased on import: the plan's tripwire greps every file this plan added for a
// number-conversion call token, and the parser's own name would match it by accident.
import { parseInvoiceNumber as parseInvoice, type OrderType } from '../sync-ops';
import type { ReceiptLayout, ReceiptPaymentNumber } from '../receipt-layout';
import { formatTaxRate } from './menu-view';
import type { SaleSnapshot } from './store';

/** One line of text for the agent to encode. */
export type TextLine = {
	text: string;
	bold?: boolean;
	/** `tall` = double height, full width; `double` = double width AND height, half the columns. */
	size?: 'normal' | 'tall' | 'double';
	align?: 'left' | 'center';
};

/**
 * The logo as plain 1-bit pixel data — the width in dots (a multiple of 8), the
 * height in dots and the packed rows as standard base64 — for a print agent of
 * version 2 or later to validate and encode itself (T-25). Never any other key.
 */
export type ImageLine = { image: { widthDots: number; heightDots: number; bitmap: string } };

export type PrintLine = TextLine | ImageLine;

export function isImageLine(line: PrintLine): line is ImageLine {
	return 'image' in line;
}

export type ReceiptWidth = 32 | 48;

export type ReceiptHeader = {
	restaurantName: string;
	address: string | null;
	phone: string | null;
	taxRegistrationNumber: string | null;
};

export type ReceiptInput = {
	sale: SaleSnapshot;
	header: ReceiptHeader;
	/** The restaurant's IANA zone (invariant 11): the time on paper is the till's local time. */
	timeZone: string;
	deviceCode: string;
	/** The owner's layout as the till cached it (T-21). `layout.logo` is only the fingerprint. */
	layout: ReceiptLayout;
	/** The payment-numbers block (Settings 6): the CURRENT settings, not sale data. */
	paymentNumbers: ReceiptPaymentNumber[];
	/**
	 * What prints at the top of a receipt, or null — null whenever the agent is
	 * below version 2, no logo is cached, or the owner has not confirmed the
	 * logo's test print (T-24). The kitchen ticket never carries it.
	 */
	logo: ImageLine['image'] | null;
};

export type CopyMark = { reprintedAt: string; by: string };
export type RenderOptions = { width: ReceiptWidth; copy?: CopyMark };

// ── Text ────────────────────────────────────────────────────────────────────

const ASCII_MAP: [RegExp, string][] = [
	[/−/g, '-'], // U+2212 MINUS SIGN — what formatAmount emits for a negative
	[/ /g, ' '], // U+00A0 NO-BREAK SPACE — what formatMoney puts before the code
	[/[‘’]/g, "'"],
	[/[“”]/g, '"'],
	[/[–—]/g, '-'],
	[/…/g, '...'],
	[/×/g, 'x']
];

/** Printable ASCII (0x20–0x7E) only. Idempotent. */
export function toPrintable(value: string): string {
	let text = value;
	for (const [pattern, replacement] of ASCII_MAP) text = text.replace(pattern, replacement);
	// Decompose accents (é → e + U+0301) and drop the combining marks.
	text = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
	// Control characters would COMMAND the printer: a space, never the byte.
	text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
	// Whatever is left outside printable ASCII prints as a question mark.
	return text.replace(/[^\x20-\x7e]/g, '?');
}

/** A stored decimal string of minor units → the money formatter's text, printable. */
function money(decimal: string, currencyCode: string): string {
	return toPrintable(formatAmount(minor(BigInt(decimal)), moneyFormatFor(currencyCode)));
}

// Month names keyed by the two-digit month of a YYYY-MM-DD string: no number
// conversion anywhere in this file, not even on a date part.
const MONTHS: Record<string, string> = {
	'01': 'Jan',
	'02': 'Feb',
	'03': 'Mar',
	'04': 'Apr',
	'05': 'May',
	'06': 'Jun',
	'07': 'Jul',
	'08': 'Aug',
	'09': 'Sep',
	'10': 'Oct',
	'11': 'Nov',
	'12': 'Dec'
};

/** `14 Sep 2026 19:42` in the restaurant's zone (en-US short months are three letters). */
export function formatDateTime(iso: string, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		day: '2-digit',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(new Date(iso));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return `${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')}`;
}

/** `2026-09-14` → `14 Sep 2026`, by splitting the string: no Date, no zone shift. */
export function formatBusinessDate(businessDate: string): string {
	const [year = '', month = '', day = ''] = businessDate.split('-');
	return `${day} ${MONTHS[month] ?? month} ${year}`;
}

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
	dine_in: 'Dine-in',
	takeaway: 'Takeaway',
	delivery: 'Delivery'
};

// ── Layout over already-printable text ───────────────────────────────────────

function rule(char: string, width: number): TextLine {
	return { text: char.repeat(width) };
}

/**
 * Word-wrap `text` into lines at most `width` wide. The text's own leading
 * spaces (a right-aligned quantity column) stay on the first line; continuation
 * lines are prefixed by `indent`.
 */
function wrap(text: string, width: number, indent = ''): string[] {
	const lines: string[] = [];
	const lead = /^ */.exec(text)?.[0] ?? '';
	const words = text
		.slice(lead.length)
		.split(' ')
		.filter((w) => w.length > 0);
	let current = '';
	let prefix = lead;
	const push = () => {
		lines.push(prefix + current);
		prefix = indent;
		current = '';
	};
	for (let word of words) {
		while (word.length > width - prefix.length) {
			// A word longer than the line: hard-split it.
			if (current) push();
			current = word.slice(0, width - prefix.length);
			word = word.slice(width - prefix.length);
			push();
		}
		if (current === '') current = word;
		else if (prefix.length + current.length + 1 + word.length <= width) current += ' ' + word;
		else {
			push();
			current = word;
		}
	}
	if (current || lines.length === 0) push();
	return lines;
}

/** Centre `text` within `width` — as it is when it fits, else each wrapped line. */
function center(text: string, width: number): string[] {
	const pieces = text.length <= width ? [text] : wrap(text, width);
	return pieces.map((line) => {
		const pad = Math.max(0, Math.floor((width - line.length) / 2));
		return ' '.repeat(pad) + line;
	});
}

/** The fewest columns a label keeps beside a right-hand value before the value moves down. */
const MIN_LABEL_ROOM = 8;

/**
 * `left` on the left, `right` right-aligned to column `width`, on the FIRST line;
 * a left text too long for the room wraps onto continuation lines (prefixed by
 * `indent`) so the right side is never cut. A right text that leaves the label
 * fewer than MIN_LABEL_ROOM columns — a long cashier name on 32 columns — goes
 * on its own right-aligned line(s) under the label instead: no line is ever
 * wider than `width`, whatever the inputs (the agent refuses a wider line).
 */
function pair(left: string, right: string, width: number, indent = ''): string[] {
	const room = width - right.length - 1;
	if (room < MIN_LABEL_ROOM) {
		return [...wrap(left, width, indent), ...wrap(right, width).map((l) => l.padStart(width))];
	}
	const [first = '', ...rest] = wrap(left, room, indent);
	return [first.padEnd(width - right.length) + right, ...rest];
}

const line = (text: string, extra: Omit<TextLine, 'text'> = {}): TextLine => ({ text, ...extra });
const lines = (texts: string[], extra: Omit<TextLine, 'text'> = {}): TextLine[] =>
	texts.map((text) => line(text, extra));

function orderNo(sale: SaleSnapshot): string {
	const seq = parseInvoice(sale.payload.invoiceNumber)?.seq ?? sale.payload.invoiceSeq;
	return String(seq);
}

// ── The tax lines: stored rates and stored rows, never a sum ─────────────────

type TaxMode = SaleSnapshot['payload']['taxMode'];

/** A rate as a line stored it: the basis points taxed and the rate's name, if the till knew one. */
type StoredRate = { rateBp: number; name: string | null };

/** One stored per-rate row: the name, the rate and that rate's tax as a decimal string. */
type StoredRow = StoredRate & { taxMinor: string };

/**
 * The one (rate, name) pair every payload line shares, or null when the lines
 * differ in either — or there is no line. A line stored before this plan has no
 * name key, which reads as null.
 */
function sharedRate(sale: SaleSnapshot): StoredRate | null {
	let shared: StoredRate | null = null;
	for (const l of sale.payload.lines) {
		if (typeof l.taxRateBp !== 'number') return null;
		const name = l.taxRateName ?? null;
		if (shared === null) shared = { rateBp: l.taxRateBp, name };
		else if (shared.rateBp !== l.taxRateBp || shared.name !== name) return null;
	}
	return shared;
}

/**
 * The label of a tax line: exactly today's `Tax 10.00%` / `Incl. tax 10.00%`
 * for a rate stored without a name; `VAT 10.00%` / `Incl. VAT 10.00%` for a
 * named one. The name is owner-written text, so it goes through toPrintable.
 */
function taxLabel(rateBp: number, name: string | null, mode: TaxMode): string {
	const rate = formatTaxRate(rateBp);
	if (name === null || name === '')
		return mode === 'inclusive' ? `Incl. tax ${rate}` : `Tax ${rate}`;
	const printable = toPrintable(name);
	return mode === 'inclusive' ? `Incl. ${printable} ${rate}` : `${printable} ${rate}`;
}

/**
 * The sale's stored per-rate rows, when there are at least two and every one
 * is well formed — else null, and one tax line prints the stored total. This
 * is a check of SHAPE only, against a snapshot written by an older build or
 * garbled in storage: the rows are never summed or compared with the total
 * here (invariant 1) — the money module made them add up when the sale was
 * completed (invariant 7).
 */
function storedBreakdown(sale: SaleSnapshot): StoredRow[] | null {
	const rows: unknown = sale.taxBreakdown;
	if (!Array.isArray(rows) || rows.length < 2) return null;
	const out: StoredRow[] = [];
	for (const row of rows as unknown[]) {
		if (typeof row !== 'object' || row === null) return null;
		const { name, rateBp, taxMinor } = row as Record<string, unknown>;
		if (typeof rateBp !== 'number' || !Number.isInteger(rateBp)) return null;
		if (rateBp < 0 || rateBp > 10_000) return null;
		if (name !== null && typeof name !== 'string') return null;
		if (typeof taxMinor !== 'string' || !/^-?\d+$/.test(taxMinor)) return null;
		out.push({ name, rateBp, taxMinor });
	}
	return out;
}

// ── The customer receipt (design/06-receipt.html, sample A) ─────────────────

export function renderReceipt(input: ReceiptInput, opts: RenderOptions): PrintLine[] {
	const w = opts.width;
	const { sale, header, layout } = input;
	const { payload } = sale;
	const { show } = layout;
	const cur = payload.currencyCode;
	const p = toPrintable;
	const out: PrintLine[] = [];

	// 1. The COPY banner — never hideable (spec 11).
	if (opts.copy) {
		out.push(rule('*', w));
		out.push(line('*' + center('COPY', w - 2)[0]!.padEnd(w - 2) + '*'));
		out.push(rule('*', w));
	}

	// 2. The logo, exactly as given and nothing added: the agent validates and
	//    encodes it (T-25). What prints is input.logo, never layout.logo.
	if (input.logo !== null) out.push({ image: input.logo });

	// 3. Who sold: the name and the tax registration number when set never hide;
	//    then the owner's header lines.
	out.push(...lines(center(p(header.restaurantName), w), { bold: true, align: 'center' }));
	if (header.address) out.push(...lines(center(p(header.address), w), { align: 'center' }));
	if (header.phone) out.push(...lines(center(p(`Tel ${header.phone}`), w), { align: 'center' }));
	if (header.taxRegistrationNumber) {
		out.push(
			...lines(center(p(`Tax no. ${header.taxRegistrationNumber}`), w), { align: 'center' })
		);
	}
	for (const text of layout.headerLines)
		out.push(...lines(center(p(text), w), { align: 'center' }));
	out.push(rule('-', w));

	// 4. When, and which sale: the date and time and the invoice number never hide.
	out.push(...lines(pair('Date/Time', formatDateTime(sale.completedAt, input.timeZone), w)));
	if (show.businessDate && sale.businessDate) {
		out.push(...lines(pair('Business date', formatBusinessDate(sale.businessDate), w)));
	}
	out.push(...lines(pair('Invoice', p(payload.invoiceNumber), w)));
	const order = `Order #${orderNo(sale)}`;
	if (show.orderType) out.push(...lines(pair(order, ORDER_TYPE_LABELS[payload.orderType], w)));
	else out.push(line(order));

	// 5. The table and the cashier, each behind its own switch.
	const cashier = p(sale.cashierName);
	if (payload.orderType === 'dine_in' && payload.tableLabel) {
		const table = p(`Table ${payload.tableLabel}`);
		if (show.table && show.cashier) out.push(...lines(pair(table, `Cashier ${cashier}`, w)));
		else if (show.table) out.push(...lines(wrap(table, w)));
		else if (show.cashier) out.push(...lines(pair('Cashier', cashier, w)));
	} else if (show.cashier) {
		out.push(...lines(pair('Cashier', cashier, w)));
	}

	// 6. The copy marks — never hideable — and the items.
	if (opts.copy) {
		out.push(...lines(pair('Reprinted', formatDateTime(opts.copy.reprintedAt, input.timeZone), w)));
		out.push(...lines(pair('Reprint by', p(opts.copy.by), w)));
	}
	out.push(rule('-', w));
	out.push(...lines(pair('QTY ITEM', 'AMOUNT', w)));
	out.push(rule('-', w));

	payload.lines.forEach((l, i) => {
		const qty = String(l.quantity).padStart(3);
		const amount = money(sale.lineAmountsMinor[i] ?? '0', cur);
		out.push(...lines(pair(`${qty} ${p(l.itemName)}`, amount, w, '    ')));
		for (const m of l.modifiers) {
			const delta = m.priceDeltaMinor === '0' ? '' : money(m.priceDeltaMinor, cur);
			out.push(...lines(pair(`    + ${p(m.modifierName)}`, delta, w, '      ')));
		}
		if (l.quantity > 1 && show.unitPrice) {
			out.push(line(`    @ ${money(l.unitPriceMinor, cur)} each`));
		}
	});

	// 7. The totals — never hideable. The tax: one line at the rate every line
	//    shares; the stored per-rate rows, as stored, when the rates differ, the
	//    switch is on and the sale stored them; else one line for the mixed rates.
	out.push(rule('-', w));
	out.push(...lines(pair('Subtotal', money(payload.totals.subtotalMinor, cur), w)));
	if (payload.totals.discountMinor !== '0') {
		out.push(...lines(pair('Discount', '-' + money(payload.totals.discountMinor, cur), w)));
	}
	const mode = payload.taxMode;
	const shared = sharedRate(sale);
	const rows = shared === null && show.taxBreakdown ? storedBreakdown(sale) : null;
	if (shared !== null) {
		const label = taxLabel(shared.rateBp, shared.name, mode);
		out.push(...lines(pair(label, money(payload.totals.taxMinor, cur), w)));
	} else if (rows !== null) {
		for (const row of rows) {
			const label = taxLabel(row.rateBp, row.name, mode);
			out.push(...lines(pair(label, money(row.taxMinor, cur), w)));
		}
	} else {
		const label = (mode === 'inclusive' ? 'Incl. tax' : 'Tax') + ' (mixed rates)';
		out.push(...lines(pair(label, money(payload.totals.taxMinor, cur), w)));
	}

	// 8. The total.
	out.push(rule('=', w));
	out.push(
		...lines(pair('TOTAL', money(payload.totals.totalMinor, cur), w), { bold: true, size: 'tall' })
	);
	out.push(rule('=', w));

	// 9. The payment — never hideable. Cash by KIND, as today; card and mobile
	//    under the method's STORED name, or the kind for a sale recorded before
	//    the name was stored.
	const payment = payload.payments[0];
	if (payment) {
		if (payment.method === 'cash') {
			out.push(...lines(pair('CASH', money(payment.tenderedMinor ?? payment.amountMinor, cur), w)));
			out.push(...lines(pair('CHANGE', money(payment.changeMinor ?? '0', cur), w)));
		} else {
			const name = payment.paymentMethodName;
			const label =
				typeof name === 'string' && name !== ''
					? p(name).toUpperCase()
					: payment.method === 'card'
						? 'CARD'
						: 'MOBILE';
			out.push(...lines(pair(label, money(payment.amountMinor, cur), w)));
		}
	}
	out.push(rule('-', w));

	// 10. The payment-numbers block (Settings 6): the owner's CURRENT numbers,
	//     cash sales included — not sale data, never part of the COPY figures.
	if (show.paymentNumbers && input.paymentNumbers.length > 0) {
		if (layout.paymentNumbersHeading) {
			out.push(...lines(center(p(layout.paymentNumbersHeading), w), { align: 'center' }));
		}
		for (const entry of input.paymentNumbers) {
			out.push(...lines(pair(p(entry.name), p(entry.number), w)));
		}
		out.push(rule('-', w));
	}

	// 11. The footer: the owner's lines, the two switched lines, the COPY
	//     sentence — never hideable.
	for (const text of layout.footerLines)
		out.push(...lines(center(p(text), w), { align: 'center' }));
	if (show.currencyLine) {
		out.push(...lines(center(`All amounts in ${p(cur)}`, w), { align: 'center' }));
	}
	if (show.deviceLine) {
		out.push(...lines(center(`matcami POS  ${p(input.deviceCode)}`, w), { align: 'center' }));
	}
	if (opts.copy) {
		out.push(
			...lines(
				center('This is a COPY of a receipt already issued. No new sale has been recorded.', w),
				{ align: 'center' }
			)
		);
		out.push(rule('*', w));
	}
	return out;
}

// ── The kitchen ticket (design/06-receipt.html, sample B) ───────────────────

/** Text only: the kitchen ticket reads none of the layout, the payment numbers or the logo. */
export function renderKitchenTicket(input: ReceiptInput, opts: RenderOptions): TextLine[] {
	const w = opts.width;
	const half = Math.floor(w / 2);
	const { sale } = input;
	const { payload } = sale;
	const up = (text: string) => toPrintable(text).toUpperCase();
	const out: TextLine[] = [];

	/** Centred at double size when it fits half the columns, else at normal size. */
	const banner = (text: string) =>
		text.length <= half
			? lines(center(text, half), { size: 'double', bold: true, align: 'center' })
			: lines(center(text, w), { bold: true, align: 'center' });

	out.push(rule('=', w));
	if (opts.copy) out.push(...lines(center('*** COPY ***', w), { bold: true, align: 'center' }));
	out.push(...banner(`ORDER ${orderNo(sale)}`));
	if (payload.orderType === 'dine_in' && payload.tableLabel) {
		out.push(...banner(up(`TABLE ${payload.tableLabel}`)));
	} else {
		out.push(...banner(ORDER_TYPE_LABELS[payload.orderType].toUpperCase()));
	}
	out.push(rule('=', w));
	out.push(
		...lines(
			pair(
				up(`BY ${sale.cashierName}`),
				formatDateTime(sale.completedAt, input.timeZone).toUpperCase(),
				w
			)
		)
	);
	out.push(
		...lines(
			pair(
				ORDER_TYPE_LABELS[payload.orderType].toUpperCase(),
				up(`TERMINAL ${input.deviceCode}`),
				w
			)
		)
	);
	if (opts.copy) {
		out.push(
			...lines(
				pair('REPRINTED', formatDateTime(opts.copy.reprintedAt, input.timeZone).toUpperCase(), w)
			)
		);
		out.push(...lines(pair('REPRINT BY', up(opts.copy.by), w)));
	}
	out.push(rule('=', w));
	out.push(line('QTY  ITEM'));
	out.push(rule('-', w));
	for (const l of payload.lines) {
		out.push(...lines(wrap(`${String(l.quantity).padStart(4)} ${up(l.itemName)}`, w, '     ')));
		for (const m of l.modifiers)
			out.push(...lines(wrap(`     + ${up(m.modifierName)}`, w, '       ')));
	}
	out.push(rule('-', w));
	if (payload.note) {
		out.push(line('** NOTE **', { bold: true }));
		out.push(...lines(wrap(up(payload.note), w)));
	}
	out.push(rule('=', w));
	out.push(...lines(center('*** END OF TICKET ***', w), { align: 'center' }));
	out.push(rule('=', w));
	return out;
}

// ── The test page (T-29) ────────────────────────────────────────────────────

export type TestPageInput = {
	width: ReceiptWidth;
	restaurantName: string;
	deviceCode: string;
	/** ISO instant of the test, printed in the restaurant's zone. */
	now: string;
	timeZone: string;
	printer: 'receipt' | 'kitchen';
};

/**
 * What the owner prints from /pos/printer to prove pairing works: the name,
 * TEST PRINT, the printer's role and column count, the terminal, the time,
 * and a ruler of exactly `width` characters so a wrong paper width is visible
 * at a glance (a 48-column page on 58 mm paper wraps or clips the ruler).
 */
export function renderTestPage(input: TestPageInput): TextLine[] {
	const w = input.width;
	const ruler = '1234567890'.repeat(5).slice(0, w);
	const out: TextLine[] = [
		...lines(center('matcami', w), { bold: true, align: 'center' }),
		...lines(center('TEST PRINT', w), { bold: true, size: 'tall', align: 'center' }),
		rule('-', w),
		...lines(center(`${input.printer.toUpperCase()} PRINTER`, w), { align: 'center' }),
		...lines(center(`${w} COLUMNS`, w), { align: 'center' }),
		...lines(center(toPrintable(input.restaurantName), w), { align: 'center' }),
		...lines(center(`TERMINAL ${toPrintable(input.deviceCode)}`, w), { align: 'center' }),
		...lines(center(formatDateTime(input.now, input.timeZone), w), { align: 'center' }),
		rule('-', w),
		line(ruler),
		rule('-', w),
		...lines(center('IF YOU CAN READ THIS,', w), { align: 'center' }),
		...lines(center('PRINTING WORKS', w), { align: 'center' })
	];
	return out.map((l) => ({ ...l, text: toPrintable(l.text) }));
}
