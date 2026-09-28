// THE SYNC-OP CONTRACT — the ONE definition of what the till queues and the
// server records. Imported by src/lib/server/** (T-18's validator, T-21's
// handler), by src/lib/pos/** (the queue, the cart) and by src/routes/(pos)/**.
//
// It is ISOMORPHIC and imports NOTHING — no sibling module (not $lib/money and
// not $lib/pin), no $lib/*, no $app/*, no package, no `node:` builtin. Its job
// is to spell every wire literal in ONE place so the till, the sync endpoint
// and the database CHECK constraints cannot drift. This module does no
// arithmetic, no rounding, no I/O and no formatting beyond the invoice-number
// pair below.
//
// EVERY *Minor FIELD ON THE WIRE IS A DECIMAL STRING of the integer minor
// value: `"850"` is $8.50, `"0"` is zero cents, `"1949"` is $19.49. It is never
// a JavaScript `number` (a `bigint` is not JSON-serialisable — JSON.stringify
// throws on a `bigint`; a `number` would silently drop the money brand and,
// above 2^53, lose precision). The conversion to `Minor` happens in the
// consumer, at the boundary, with `minor(BigInt(value))` from src/lib/money —
// never here.

/** Every kind of op the till may enqueue. The order is the file-format order. */
export const OP_KINDS = [
	'session.open',
	'session.close',
	'sale.complete',
	'sale.abandoned',
	'pin.login'
] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** Order types (spec 13 MVP: dine-in and takeaway; home delivery is later). */
export const ORDER_TYPES = ['dine_in', 'takeaway'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** Tenders (CLAUDE.md decision (b), 2026-09-28). */
export const PAYMENT_METHODS = ['cash', 'card', 'mobile'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Order lifecycle: `open`, `billed`, `paid`, `voided`, `refunded`. */
export const ORDER_STATUSES = ['open', 'billed', 'paid', 'voided', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Item statuses (`sent` and `voided` exist for the CHECK; nothing writes them
 * in this slice — spec 14, CLAUDE.md invariant 9). */
export const LINE_STATUSES = ['new', 'sent', 'voided'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

/** Session lifecycle (spec 10). */
export const SESSION_STATUSES = ['open', 'closed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Server outcome for a sync op — see 00-overview.md flag classes. */
export const OP_STATUSES = ['accepted', 'recorded_flagged', 'unrecorded'] as const;
export type OpStatus = (typeof OP_STATUSES)[number];

/** SOFT flags never roll back: the sale is recorded IN FULL from the device's
 * numbers and the op is `recorded_flagged`. See CLAUDE.md decision (f). */
export const SOFT_FLAGS = [
	'employee_not_permitted',
	'employee_inactive',
	'employee_unknown',
	'totals_mismatch',
	'stale_menu_price',
	'session_closed',
	'clock_ahead'
] as const;
export type SoftFlag = (typeof SOFT_FLAGS)[number];

/** HARD flags roll back the transaction: the op is stored `unrecorded` with
 * its payload only — stored and flagged, never discarded (spec 6). */
export const HARD_FLAGS = [
	'invalid_payload',
	'price_tamper',
	'unknown_session',
	'unknown_item',
	'unknown_modifier',
	'invoice_collision',
	'database_error'
] as const;
export type HardFlag = (typeof HARD_FLAGS)[number];

/** The two spellings for the tax mode literal are pinned to
 * src/lib/money/tax.ts's TAX_MODES by the test in this directory (drift makes
 * `TaxMode extends SaleCompletePayload['taxMode']` degenerate to `never` and
 * fails `pnpm check`). This module imports NOTHING, so the spelling is
 * restated locally — the test does the cross-check. The database CHECK
 * `restaurant_settings_tax_mode_valid` holds the same two literals. */
type TaxMode = 'exclusive' | 'inclusive';

/** The envelope every op wears on the wire. Payload is per-kind. */
export type OpEnvelope<K extends OpKind, P> = {
	kind: K;
	clientOpId: string;
	deviceId: string;
	employeeId: string;
	occurredAt: string;
	seq: number;
	payload: P;
};

/** One line's chosen modifier at time of sale. */
export type SaleLineModifier = {
	modifierId: string;
	modifierName: string;
	// decimal string
	priceDeltaMinor: string;
};

/** One line of the guest check at time of sale (invariant 7: each line
 * snapshots its own unit price AND tax rate). */
export type SaleLine = {
	lineId: string;
	lineNo: number;
	menuItemId: string;
	itemName: string;
	quantity: number;
	// DECIMAL STRING of the integer minor value ("850" is $8.50) — never a number, never a bigint
	unitPriceMinor: string;
	taxRateBp: number;
	// decimal string
	discountMinor: string;
	modifiers: SaleLineModifier[];
};

/** One payment recorded against a sale. `tenderedMinor` and `changeMinor` are
 * meaningful for cash only; for card/mobile they are `null`. */
export type SalePayment = {
	paymentId: string;
	method: PaymentMethod;
	// decimal string
	amountMinor: string;
	// decimal string | null
	tenderedMinor: string | null;
	// decimal string | null
	changeMinor: string | null;
};

/** The completed sale — the op that carries a whole order in one message. */
export type SaleCompletePayload = {
	orderId: string;
	posSessionId: string;
	orderType: OrderType;
	tableLabel: string | null;
	taxMode: TaxMode;
	currencyCode: string;
	menuVersion: number;
	invoiceSeq: number;
	invoiceNumber: string;
	openedAt: string;
	lines: SaleLine[];
	totals: {
		// decimal string
		subtotalMinor: string;
		// decimal string
		discountMinor: string;
		// decimal string
		taxMinor: string;
		// decimal string
		totalMinor: string;
	};
	payments: SalePayment[];
};

/** Open a POS session with an opening cash float. */
export type SessionOpenPayload = {
	posSessionId: string;
	// decimal string
	openingCashMinor: string;
};

/** Close a POS session with the drawer's counted cash. */
export type SessionClosePayload = {
	posSessionId: string;
	// decimal string
	countedCashMinor: string;
};

/** A card/mobile sale the server rejected (403 or 422), or one the cashier
 * cancelled while pending — carries the burned invoice number so the server
 * can explain the hole in the gap-free sequence (invariant 5). */
export type SaleAbandonedPayload = {
	orderId: string;
	invoiceSeq: number;
	invoiceNumber: string;
	reason: 'rejected' | 'cancelled';
};

/** A PIN-login outcome recorded from the till. The employee is the envelope's
 * `employeeId`; a failed login carries the same envelope. */
export type PinLoginPayload = { outcome: 'success' | 'failed' };

/** The server's answer for `POST /api/pos/sync`. Fields beyond `status` are
 * populated for the ops that need them (session open/close return session
 * detail, sale.complete returns nothing extra). */
export type SyncResult = {
	clientOpId: string;
	status: 'accepted' | 'recorded_flagged' | 'unrecorded' | 'replayed';
	flag?: string;
	error?: string;
	posSessionId?: string;
	businessDate?: string;
	// decimal string
	expectedCashMinor?: string;
	// decimal string
	differenceMinor?: string;
};

const DEVICE_CODE_PATTERN = /^[A-Z0-9]{1,8}$/;
const INVOICE_NUMBER_PATTERN = /^([A-Z0-9]{1,8})-(\d{6})$/;
const INVOICE_SEQ_MIN = 1;
const INVOICE_SEQ_MAX = 999_999;
const INVOICE_SEQ_DIGITS = 6;

/** Format a device-scoped invoice number. Spec 6: `POS1-000001` shape, six
 * digits, one hyphen, upper-case device code. `formatInvoiceNumber('POS1', 6)`
 * returns `'POS1-000006'`. Throws `RangeError` on a contract violation so
 * callers can distinguish it from an I/O failure. */
export function formatInvoiceNumber(deviceCode: string, seq: number): string {
	if (typeof deviceCode !== 'string' || !DEVICE_CODE_PATTERN.test(deviceCode)) {
		throw new RangeError('device code must match /^[A-Z0-9]{1,8}$/');
	}
	if (!Number.isInteger(seq) || seq < INVOICE_SEQ_MIN || seq > INVOICE_SEQ_MAX) {
		throw new RangeError('invoice seq must be an integer from 1 to 999999');
	}
	return `${deviceCode}-${String(seq).padStart(INVOICE_SEQ_DIGITS, '0')}`;
}

/** Parse an invoice number. Never throws; returns `null` on any deviation.
 * `\d` is intentionally ASCII (no `u` flag), same reason src/lib/pin does it:
 * a full-width or Arabic-Indic digit must not parse. `$` without `m` also
 * refuses a trailing newline. Round-trips with `formatInvoiceNumber`. */
export function parseInvoiceNumber(value: string): { deviceCode: string; seq: number } | null {
	if (typeof value !== 'string') return null;
	const match = INVOICE_NUMBER_PATTERN.exec(value);
	if (!match) return null;
	const seq = Number(match[2]);
	if (seq < INVOICE_SEQ_MIN) return null;
	return { deviceCode: match[1], seq };
}
