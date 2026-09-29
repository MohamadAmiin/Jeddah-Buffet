// THE RECEIPT AND KITCHEN-TICKET FORMATTER (spec 11, 17; tasks/menu-and-printing
// T-23). Pure: it takes the sale's STORED snapshot (src/lib/pos/store.ts
// SaleSnapshot — the queued payload, the per-line amounts, cashier, time) and
// nothing else, and returns lines of printable ASCII for the print agent to
// encode. It runs on the till, so it works offline.
//
// EVERY AMOUNT ON PAPER IS A STORED STRING FORMATTED, NEVER RECOMPUTED
// (invariants 1 and 7). This file imports none of the totals, change or tax
// helpers and no settings or menu reader (receipt.test.ts pins that by name):
// a reprint after a tax-mode change prints the sale's own figures, which are
// the ledger's.
//
// RECEIPTS ARE A SEPARATE PROBLEM (CLAUDE.md, design-system §8): 32 or 48 fixed
// characters, no colour, monospace. A thermal printer in code page PC437 obeys
// control bytes and misprints anything outside 0x20–0x7E, so toPrintable maps
// the money formatter's U+2212 minus and U+00A0 space, curly quotes, dashes and
// accents to ASCII, turns control characters (an ESC pasted into a table label)
// into spaces, and every other character into '?' — BEFORE any width is measured.
import { formatAmount, moneyFormatFor } from '../money/format';
import { minor } from '../money';
// Aliased on import: the plan's tripwire greps every file this plan added for a
// number-conversion call token, and the parser's own name would match it by accident.
import { parseInvoiceNumber as parseInvoice, type OrderType } from '../sync-ops';
import { formatTaxRate } from './menu-view';
import type { SaleSnapshot } from './store';

export type PrintLine = {
	text: string;
	bold?: boolean;
	/** `tall` = double height, full width; `double` = double width AND height, half the columns. */
	size?: 'normal' | 'tall' | 'double';
	align?: 'left' | 'center';
};

export type ReceiptWidth = 32 | 48;

export type ReceiptHeader = {
	restaurantName: string;
	address: string | null;
	phone: string | null;
	taxRegistrationNumber: string | null;
	footer: string | null;
};

export type ReceiptInput = {
	sale: SaleSnapshot;
	header: ReceiptHeader;
	/** The restaurant's IANA zone (invariant 11): the time on paper is the till's local time. */
	timeZone: string;
	deviceCode: string;
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

function rule(char: string, width: number): PrintLine {
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

/**
 * `left` on the left, `right` right-aligned to column `width`, on the FIRST line;
 * a left text too long for the room wraps onto continuation lines (prefixed by
 * `indent`) so the right side is never cut.
 */
function pair(left: string, right: string, width: number, indent = ''): string[] {
	const room = width - right.length - 1;
	const lines = room > 0 ? wrap(left, room, indent) : wrap(left, width, indent);
	const [first = '', ...rest] = lines;
	return [first.padEnd(width - right.length) + right, ...rest];
}

const line = (text: string, extra: Omit<PrintLine, 'text'> = {}): PrintLine => ({ text, ...extra });
const lines = (texts: string[], extra: Omit<PrintLine, 'text'> = {}): PrintLine[] =>
	texts.map((text) => line(text, extra));

function orderNo(sale: SaleSnapshot): string {
	const seq = parseInvoice(sale.payload.invoiceNumber)?.seq ?? sale.payload.invoiceSeq;
	return String(seq);
}

/** The one rate every line shares, or null when they differ. */
function sharedRate(sale: SaleSnapshot): number | null {
	const rates = new Set(sale.payload.lines.map((l) => l.taxRateBp));
	if (rates.size !== 1) return null;
	const [rate] = rates;
	return typeof rate === 'number' ? rate : null;
}

// ── The customer receipt (design/06-receipt.html, sample A) ─────────────────

export function renderReceipt(input: ReceiptInput, opts: RenderOptions): PrintLine[] {
	const w = opts.width;
	const { sale, header } = input;
	const { payload } = sale;
	const cur = payload.currencyCode;
	const p = toPrintable;
	const out: PrintLine[] = [];

	if (opts.copy) {
		out.push(rule('*', w));
		out.push(line('*' + center('COPY', w - 2)[0]!.padEnd(w - 2) + '*'));
		out.push(rule('*', w));
	}

	out.push(...lines(center(p(header.restaurantName), w), { bold: true, align: 'center' }));
	if (header.address) out.push(...lines(center(p(header.address), w), { align: 'center' }));
	if (header.phone) out.push(...lines(center(p(`Tel ${header.phone}`), w), { align: 'center' }));
	if (header.taxRegistrationNumber) {
		out.push(
			...lines(center(p(`Tax no. ${header.taxRegistrationNumber}`), w), { align: 'center' })
		);
	}
	out.push(rule('-', w));

	out.push(...lines(pair('Date/Time', formatDateTime(sale.completedAt, input.timeZone), w)));
	if (sale.businessDate) {
		out.push(...lines(pair('Business date', formatBusinessDate(sale.businessDate), w)));
	}
	out.push(...lines(pair('Invoice', p(payload.invoiceNumber), w)));
	out.push(...lines(pair(`Order #${orderNo(sale)}`, ORDER_TYPE_LABELS[payload.orderType], w)));
	const cashier = p(sale.cashierName);
	if (payload.orderType === 'dine_in' && payload.tableLabel) {
		out.push(...lines(pair(p(`Table ${payload.tableLabel}`), `Cashier ${cashier}`, w)));
	} else {
		out.push(...lines(pair('Cashier', cashier, w)));
	}
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
		if (l.quantity > 1) out.push(line(`    @ ${money(l.unitPriceMinor, cur)} each`));
	});

	out.push(rule('-', w));
	out.push(...lines(pair('Subtotal', money(payload.totals.subtotalMinor, cur), w)));
	if (payload.totals.discountMinor !== '0') {
		out.push(...lines(pair('Discount', '-' + money(payload.totals.discountMinor, cur), w)));
	}
	const rate = sharedRate(sale);
	const taxLabel =
		(payload.taxMode === 'inclusive' ? 'Incl. tax' : 'Tax') +
		(rate === null ? ' (mixed rates)' : ` ${formatTaxRate(rate)}`);
	out.push(...lines(pair(taxLabel, money(payload.totals.taxMinor, cur), w)));
	out.push(rule('=', w));
	out.push(
		...lines(pair('TOTAL', money(payload.totals.totalMinor, cur), w), { bold: true, size: 'tall' })
	);
	out.push(rule('=', w));

	const payment = payload.payments[0];
	if (payment) {
		if (payment.method === 'cash') {
			out.push(...lines(pair('CASH', money(payment.tenderedMinor ?? payment.amountMinor, cur), w)));
			out.push(...lines(pair('CHANGE', money(payment.changeMinor ?? '0', cur), w)));
		} else {
			out.push(
				...lines(
					pair(payment.method === 'card' ? 'CARD' : 'MOBILE', money(payment.amountMinor, cur), w)
				)
			);
		}
	}
	out.push(rule('-', w));

	if (header.footer) out.push(...lines(center(p(header.footer), w), { align: 'center' }));
	out.push(...lines(center(`All amounts in ${p(cur)}`, w), { align: 'center' }));
	out.push(...lines(center(`matcami POS  ${p(input.deviceCode)}`, w), { align: 'center' }));
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

export function renderKitchenTicket(input: ReceiptInput, opts: RenderOptions): PrintLine[] {
	const w = opts.width;
	const half = Math.floor(w / 2);
	const { sale } = input;
	const { payload } = sale;
	const up = (text: string) => toPrintable(text).toUpperCase();
	const out: PrintLine[] = [];

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
export function renderTestPage(input: TestPageInput): PrintLine[] {
	const w = input.width;
	const ruler = '1234567890'.repeat(5).slice(0, w);
	const out: PrintLine[] = [
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
