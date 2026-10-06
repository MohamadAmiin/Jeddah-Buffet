// WHAT THE TILL PRINTS, AND WHEN (spec 6, 11, 13; tasks/menu-and-printing
// T-30, T-31). Three rules govern this file, and nothing in it may bend them:
//
//   1. Printing happens AFTER the sale is complete on the device and NEVER
//      inside completeSale or the server's payment transaction (invariant 4).
//      The pay screen calls printOriginals only once completeSale has resolved,
//      and never awaits it before showing ● Paid. orders.ts does not import this
//      file (printing.test.ts pins that by source text).
//   2. Every print path asks canPrint first (T-18), so a card or mobile sale
//      prints NOTHING until the server has accepted it — fail closed
//      (invariant 5). The auto-printer prints those on the flush's 'done'.
//   3. The drawer pulse is sent once, for a CASH ORIGINAL only, within 30 s of
//      the sale — never on a reprint, never in a catch-up (invariant 9). The
//      cash sale's recorded row is the drawer's audit evidence (assumption 6).
//
// Every amount on paper comes from the order's stored SaleSnapshot through
// receipt.ts; this file computes nothing (invariants 1, 7). The owner's receipt
// layout and the enabled methods' merchant numbers are read HERE from the
// till's cache (settings.ts, T-21) and passed in: the formatter reads no setting
// (tasks/settings-tax-payments-receipt T-23).
//
// THE LOGO (T-24) goes through logoForAgent, below: only to an agent reporting
// a version that validates and encodes image lines, and onto a RECEIPT only
// after the owner confirmed its test print on /pos/printer. A receipt the agent
// refuses because of its image is sent once more without it (submitReceipt),
// so a logo never costs the customer a receipt. None of it touches the drawer
// clause, and the till never composes a printer byte.
import { paymentNumbersFrom } from '../receipt-layout';
import { canPrint, type CanPrint } from './can-print';
import type { Cart } from './orders';
import {
	agentPrintsImages,
	agentStatus,
	pulseDrawer,
	submitJob,
	type AgentStatus,
	type PrintJob,
	type SubmitResult
} from './print-client';
import { onFlushEvent } from './queue';
import {
	isImageLine,
	renderKitchenTicket,
	renderReceipt,
	type ImageLine,
	type ReceiptHeader,
	type ReceiptInput,
	type ReceiptWidth
} from './receipt';
import { readSessionRow } from './session';
import {
	readConfirmedLogoSha,
	readPaymentMethods,
	readReceiptLayout,
	readReceiptLogo
} from './settings';
import {
	inTransaction,
	readCachedSetting,
	valueOf,
	withDb,
	type LocalOrder,
	type PrintedMarks,
	type QueueEntry
} from './store';

export type PrintRefusal = Extract<CanPrint, { ok: false }>['reason'];

/** One printer's answer for one original or reprint. */
export type PrintOutcome =
	'queued' | 'duplicate' | 'already_printed' | { skipped: PrintRefusal } | { error: string };

export type DrawerOutcome =
	| 'opened'
	| 'duplicate'
	| 'not_requested'
	| 'not_cash'
	| 'already_opened'
	| 'too_late'
	| 'printer_unreachable'
	| { skipped: PrintRefusal }
	| { error: string };

export type OriginalsResult = {
	receipt: PrintOutcome;
	kitchen: PrintOutcome;
	drawer: DrawerOutcome;
};

export type PrintOptions = {
	fetchFn?: typeof fetch;
	now?: () => number;
};

/** The drawer opens only for a sale completed this many milliseconds ago or less. */
export const DRAWER_WINDOW_MS = 30_000;
/** The catch-up on start reprints originals missing for sales this recent. */
export const CATCH_UP_WINDOW_MS = 10 * 60 * 1000;

const isPrinted = (outcome: PrintOutcome) => outcome === 'queued' || outcome === 'duplicate';

// ── Reads ───────────────────────────────────────────────────────────────────

async function setting(key: string): Promise<string | null> {
	const value = await readCachedSetting(key).catch(() => null);
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The receipt header from the settings the till cached at sign-in (T-21). The
 * footer is no longer here: the legacy `receiptFooter` reaches paper as footer
 * line 1 through readReceiptLayout's fallback until a layout is cached.
 */
export async function readReceiptHeader(): Promise<ReceiptHeader> {
	const [restaurantName, address, phone, taxRegistrationNumber] = await Promise.all([
		setting('restaurantName'),
		setting('receiptAddress'),
		setting('receiptPhone'),
		setting('taxRegistrationNumber')
	]);
	return {
		restaurantName: restaurantName ?? 'Restaurant',
		address,
		phone,
		taxRegistrationNumber
	};
}

export function readOrder(orderId: string): Promise<LocalOrder<Cart> | null> {
	return withDb(async (db) => {
		const row = (await valueOf(db.transaction('orders').objectStore('orders').get(orderId))) as
			LocalOrder<Cart> | undefined;
		return row ?? null;
	});
}

function readAllOrders(): Promise<LocalOrder<Cart>[]> {
	return withDb(
		async (db) =>
			(await valueOf(db.transaction('orders').objectStore('orders').getAll())) as LocalOrder<Cart>[]
	);
}

function readQueueEntry(clientOpId: string): Promise<QueueEntry | null> {
	return withDb(async (db) => {
		const row = (await valueOf(
			db.transaction('sync_queue').objectStore('sync_queue').get(clientOpId)
		)) as QueueEntry | undefined;
		return row ?? null;
	});
}

/**
 * The business date on paper: the one kept on the sale, or — for a sale made
 * before the server had assigned one — the device's session row when it is
 * the same session and has one by now. Otherwise none is printed (invariant 11:
 * never the calendar date).
 */
async function businessDateFor(order: LocalOrder<Cart>): Promise<string | null> {
	const sale = order.sale;
	if (!sale) return null;
	if (sale.businessDate) return sale.businessDate;
	const session = await readSessionRow(order.deviceId).catch(() => null);
	if (session && session.posSessionId === sale.payload.posSessionId && session.businessDate) {
		return session.businessDate;
	}
	return null;
}

// ── The logo (T-24) ─────────────────────────────────────────────────────────

export type LogoForAgent = {
	/** A logo is cached on this till. */
	cached: boolean;
	/** The cached logo's sha256 is the one the owner confirmed on /pos/printer. */
	confirmed: boolean;
	/** What goes on the page, or null. Never spread from the cache, which carries `sha256`. */
	logo: ImageLine['image'] | null;
};

/**
 * THE LOGO CONFIRMATION GATE. The cached logo (settings.ts — IndexedDB only,
 * never the network, so an offline till prints its copy) goes on a page only
 * when the agent reports a version that validates and encodes image lines
 * (agentPrintsImages — an older agent would refuse the whole job), and on a
 * RECEIPT only after the owner has watched a test page print it correctly and
 * pressed "The logo printed correctly" on /pos/printer, which stores its sha256
 * (settings.ts confirmReceiptLogo). A test page carries it whenever the agent
 * can print it: that one unconfirmed print happens in front of the owner. Why:
 * on a printer that does not implement `GS v 0` the raster bytes are read as
 * ordinary data and could, by chance, contain the drawer pulse (RESEARCH.md);
 * a receipt never takes that chance. The three fields are copied EXPLICITLY —
 * the agent refuses an image object with any key beyond widthDots, heightDots
 * and bitmap (T-25).
 */
export async function logoForAgent(
	status: AgentStatus,
	purpose: 'receipt' | 'test'
): Promise<LogoForAgent> {
	const [cached, confirmedSha] = await Promise.all([
		readReceiptLogo().catch(() => null),
		readConfirmedLogoSha().catch(() => null)
	]);
	if (cached === null) return { cached: false, confirmed: false, logo: null };
	const confirmed = confirmedSha === cached.sha256;
	if (!agentPrintsImages(status)) return { cached: true, confirmed, logo: null };
	if (purpose === 'receipt' && !confirmed) return { cached: true, confirmed, logo: null };
	return {
		cached: true,
		confirmed,
		logo: { widthDots: cached.widthDots, heightDots: cached.heightDots, bitmap: cached.bitmap }
	};
}

async function receiptInput(order: LocalOrder<Cart>, status: AgentStatus): Promise<ReceiptInput> {
	const sale = order.sale;
	if (!sale) throw new Error('order has no sale snapshot');
	const [header, timeZone, deviceCode, businessDate, layout, methods, logo] = await Promise.all([
		readReceiptHeader(),
		setting('timeZone'),
		setting('deviceCode'),
		businessDateFor(order),
		readReceiptLayout(),
		readPaymentMethods(),
		logoForAgent(status, 'receipt')
	]);
	return {
		sale: { ...sale, businessDate },
		header,
		timeZone: timeZone ?? 'UTC',
		deviceCode: deviceCode ?? '',
		layout,
		// The CURRENT settings, not sale data: a reprint prints today's numbers,
		// and they are never part of the COPY figures (Settings 6).
		paymentNumbers: paymentNumbersFrom(methods),
		// The cached logo through the gate above: null for an agent below version
		// 2, for no cached logo, and for a logo the owner has not confirmed.
		logo: logo.logo
	};
}

/**
 * Send a RECEIPT job — an original or a reprint, never the kitchen ticket.
 * When the agent refuses it as a bad job AND it carries an image line, send it
 * ONCE more with the image removed, under the SAME id, and answer with that:
 * a logo never costs the customer a receipt. The id is safe to reuse because
 * the agent parses the job BEFORE its queue records the id (print-agent/src/
 * server.ts, the /jobs route: parseJob throws 422 ahead of submitJob), so the
 * refused job left nothing behind and nothing prints twice.
 */
async function submitReceipt(job: PrintJob, fetchFn: typeof fetch): Promise<SubmitResult> {
	const answer = await submitJob(job, fetchFn);
	if (typeof answer === 'object' && answer.error === 'bad_job' && job.lines.some(isImageLine)) {
		return submitJob({ ...job, lines: job.lines.filter((l) => !isImageLine(l)) }, fetchFn);
	}
	return answer;
}

/**
 * ONE readwrite transaction on `orders`: read the row, merge the marks, put.
 * The same shape as the queue's markOrderSynced, so neither write can lose
 * the other's fields.
 */
export function markPrinted(orderId: string, patch: Partial<PrintedMarks>): Promise<void> {
	return withDb((db) =>
		inTransaction(db, ['orders'], 'readwrite', (tx) => {
			const store = tx.objectStore('orders');
			const request = store.get(orderId);
			request.onsuccess = () => {
				const row = request.result as LocalOrder<Cart> | undefined;
				if (!row) return;
				store.put({ ...row, printed: { ...row.printed, ...patch } });
			};
		})
	);
}

// ── Originals ───────────────────────────────────────────────────────────────

/**
 * Print the receipt and the kitchen ticket for a completed sale, and — for a
 * cash original within 30 s, when asked — open the drawer. Idempotent: what
 * the marks say was printed is not sent again, and the agent de-duplicates by
 * job id besides.
 */
export async function printOriginals(
	orderId: string,
	opts: { drawer: boolean } & PrintOptions
): Promise<OriginalsResult> {
	const fetchFn = opts.fetchFn ?? fetch;
	const now = opts.now ?? (() => Date.now());
	const order = await readOrder(orderId);
	if (!order) {
		const error = { error: 'unknown_order' };
		return { receipt: error, kitchen: error, drawer: error };
	}
	const can = canPrint(order);
	if (!can.ok) {
		const skipped = { skipped: can.reason };
		return { receipt: skipped, kitchen: skipped, drawer: skipped };
	}
	const sale = order.sale!;
	const state = await agentStatus(fetchFn);
	if (state.state !== 'ready') {
		const error = { error: state.state };
		return { receipt: error, kitchen: error, drawer: error };
	}
	const printers = state.status.printers;
	const receiptWidth: ReceiptWidth = printers.receipt.width;
	const kitchenWidth: ReceiptWidth = printers.kitchen?.width ?? printers.receipt.width;
	const input = await receiptInput(order, state.status);
	const marks = order.printed ?? {};
	const stamp = () => new Date(now()).toISOString();

	let receipt: PrintOutcome = 'already_printed';
	if (!marks.receiptAt) {
		receipt = await submitReceipt(
			{
				id: `${orderId}:receipt:0`,
				printer: 'receipt',
				lines: renderReceipt(input, { width: receiptWidth }),
				cut: true
			},
			fetchFn
		);
		if (isPrinted(receipt)) await markPrinted(orderId, { receiptAt: stamp() });
	}

	let kitchen: PrintOutcome = 'already_printed';
	if (!marks.kitchenAt) {
		kitchen = await submitJob(
			{
				id: `${orderId}:kitchen:0`,
				printer: 'kitchen',
				lines: renderKitchenTicket(input, { width: kitchenWidth }),
				cut: true
			},
			fetchFn
		);
		if (isPrinted(kitchen)) await markPrinted(orderId, { kitchenAt: stamp() });
	}

	// THE DRAWER CLAUSE — every condition, in one place (invariant 9). Nothing
	// else in this file, and nothing in reprint or the catch-up, sends a pulse.
	let drawer: DrawerOutcome = 'not_requested';
	if (opts.drawer) {
		if (sale.payload.payments[0]?.method !== 'cash') drawer = 'not_cash';
		else if (marks.drawerAt) drawer = 'already_opened';
		else if (now() - Date.parse(sale.completedAt) > DRAWER_WINDOW_MS) drawer = 'too_late';
		else {
			const pulsed = await pulseDrawer(
				{ id: `${orderId}:drawer`, completedAt: sale.completedAt },
				fetchFn
			);
			drawer = pulsed;
			if (pulsed === 'opened' || pulsed === 'duplicate') {
				await markPrinted(orderId, { drawerAt: stamp() });
			}
		}
	}

	return { receipt, kitchen, drawer };
}

// ── Reprints ────────────────────────────────────────────────────────────────

/**
 * Reprint marked COPY (spec 11). The reprint counter is bumped BEFORE the send
 * so a retry after a lost answer takes a new id rather than colliding with a
 * job the agent may already hold. NEVER a drawer pulse.
 */
export async function reprint(
	orderId: string,
	kind: 'receipt' | 'kitchen',
	by: string,
	opts: PrintOptions = {}
): Promise<PrintOutcome> {
	const fetchFn = opts.fetchFn ?? fetch;
	const now = opts.now ?? (() => Date.now());
	const order = await readOrder(orderId);
	if (!order) return { error: 'unknown_order' };
	const can = canPrint(order);
	if (!can.ok) return { skipped: can.reason };
	const state = await agentStatus(fetchFn);
	if (state.state !== 'ready') return { error: state.state };
	const printers = state.status.printers;
	const width: ReceiptWidth =
		kind === 'kitchen'
			? (printers.kitchen?.width ?? printers.receipt.width)
			: printers.receipt.width;
	const n = (order.printed?.reprints ?? 0) + 1;
	await markPrinted(orderId, { reprints: n });
	const input = await receiptInput(order, state.status);
	const copy = { reprintedAt: new Date(now()).toISOString(), by };
	const lines =
		kind === 'receipt'
			? renderReceipt(input, { width, copy })
			: renderKitchenTicket(input, { width, copy });
	const job: PrintJob = { id: `${orderId}:${kind}:r${n}`, printer: kind, lines, cut: true };
	return kind === 'receipt' ? submitReceipt(job, fetchFn) : submitJob(job, fetchFn);
}

// ── The auto-printer ────────────────────────────────────────────────────────

const AUTO_PRINT_STATUSES = new Set(['accepted', 'recorded_flagged', 'replayed']);

/**
 * Print the originals every recent completed sale is still missing — a till
 * that restarted mid-print, an agent that was down for a minute. Never the
 * drawer: a catch-up that opened it would be a drawer opened without a sale.
 */
export async function catchUp(opts: PrintOptions = {}): Promise<string[]> {
	const now = opts.now ?? (() => Date.now());
	const orders = await readAllOrders();
	const printed: string[] = [];
	for (const order of orders) {
		if (order.state !== 'completed' || !order.sale) continue;
		const age = now() - Date.parse(order.sale.completedAt);
		if (!(age >= 0 && age <= CATCH_UP_WINDOW_MS) && age > CATCH_UP_WINDOW_MS) continue;
		if (order.printed?.receiptAt && order.printed?.kitchenAt) continue;
		if (!canPrint(order).ok) continue;
		await printOriginals(order.id, { drawer: false, ...opts });
		printed.push(order.id);
	}
	return printed;
}

/**
 * Subscribe to the flush: a card or mobile sale prints the moment the server
 * confirms it. Runs the catch-up once. Returns the unsubscribe function.
 */
export function startAutoPrint(opts: PrintOptions = {}): () => void {
	void catchUp(opts).catch(() => {});
	return onFlushEvent((event) => {
		if (event.type !== 'done' || event.kind !== 'sale.complete') return;
		if (!AUTO_PRINT_STATUSES.has(event.status)) return;
		void (async () => {
			const entry = await readQueueEntry(event.clientOpId);
			const orderId = (entry?.envelope.payload as { orderId?: string } | undefined)?.orderId;
			if (!orderId) return;
			const order = await readOrder(orderId);
			const method = order?.sale?.payload.payments[0]?.method;
			if (method !== 'card' && method !== 'mobile') return;
			await printOriginals(orderId, { drawer: false, ...opts });
		})().catch(() => {});
	});
}

// ── Recent sales (T-31) ─────────────────────────────────────────────────────

/** This device's completed and abandoned sales, newest first, for /pos/sales. */
export async function listRecentSales(deviceId: string, limit = 100): Promise<LocalOrder<Cart>[]> {
	const orders = await readAllOrders();
	return orders
		.filter(
			(order) =>
				order.deviceId === deviceId && (order.state === 'completed' || order.state === 'abandoned')
		)
		.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
		.slice(0, limit);
}

export type SaleStatusMark = {
	glyph: '●' | '◆' | '◐' | '✕' | '↩' | '○';
	text: string;
	tone: 'ok' | 'pending' | 'danger' | 'neutral';
};

/** One glyph AND one sentence per sale: colour never carries the meaning alone. */
export function saleStatusMark(order: LocalOrder<Cart>): SaleStatusMark {
	if (order.syncStatus === 'rejected') {
		return { glyph: '✕', text: 'Refused — no receipt', tone: 'danger' };
	}
	if (order.state === 'abandoned') return { glyph: '↩', text: 'Cancelled', tone: 'neutral' };
	if (!order.sale) {
		return { glyph: '○', text: 'Sold before printing was set up', tone: 'neutral' };
	}
	const method = order.sale.payload.payments[0]?.method;
	if (method === 'cash') {
		// A completed cash sale is a fact, whatever the server said: still printable.
		return order.syncStatus === 'unrecorded'
			? { glyph: '◆', text: "Recorded for the owner's review", tone: 'pending' }
			: { glyph: '●', text: 'Paid', tone: 'ok' };
	}
	if (order.syncStatus === 'accepted' || order.syncStatus === 'recorded_flagged') {
		return { glyph: '●', text: 'Paid', tone: 'ok' };
	}
	return { glyph: '◐', text: 'Awaiting confirmation — no receipt yet', tone: 'pending' };
}

/** Why a sale cannot be reprinted, in the words the disabled button shows; null when it can. */
export function reprintRefusal(order: LocalOrder<Cart>): string | null {
	const can = canPrint(order);
	if (can.ok) return null;
	switch (can.reason) {
		case 'awaiting_confirmation':
			return "Awaiting the server's confirmation";
		case 'refused':
			return 'Refused — no receipt';
		case 'no_snapshot':
			return 'Sold before printing was set up';
		case 'abandoned':
			return order.syncStatus === 'rejected' ? 'Refused — no receipt' : 'Cancelled — no receipt';
		case 'not_completed':
			return 'Not a completed sale';
	}
}
