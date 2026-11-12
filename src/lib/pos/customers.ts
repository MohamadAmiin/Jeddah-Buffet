// THE TILL'S CUSTOMERS (tasks/customer-credit T-16) — who may be charged, what
// each owes, and whether one more bill fits under their limit.
//
// THE CACHE is ONE key of the existing `settings` store: `customers` holds
// { requestedAt, creditEnabled, customers }. There is deliberately NO new
// IndexedDB object store and NO version bump: a till that has opened a newer
// database version cannot run an older shell at all, and a production revert
// (2026-11-08) is exactly when that would strand every till with its unsynced
// sales. The key is not in KEPT_SETTING_KEYS, so bindDevice and forgetDevice
// clear it with the rest of the settings — names, phones and balances never
// outlive a re-registration or a revoked till's wipe.
//
// WHO MAY SEE IT. GET /api/pos/customers is guarded by the DEVICE; it cannot
// know who is signed in. So this module fetches only while the signed-in
// employee holds pos.payment, and the screens show the list to nobody else.
//
// THE LIMIT CHECK IS ADVISORY ON THE TILL. Offline the till knows only the last
// balance it fetched, so it adds what it has charged since: every credit sale
// of this till that the cached balance cannot yet include (localChargesFor).
// The server repeats the check under a lock and FLAGS an over-limit charge — it
// never rejects one, because the food has already left (invariant 5).
//
// Money: decimal strings on the wire and in the cache, bigint Minor in memory;
// every sum and difference goes through src/lib/money (invariant 1).
import { add, minor, subtract, type Minor } from '../money';
import {
	cacheSettings,
	forgetDevice,
	readCachedSetting,
	valueOf,
	withDb,
	type LocalOrder
} from './store';

export const CUSTOMERS_SETTING = 'customers';

/** One customer as GET /api/pos/customers sends them: exactly these six keys. */
export type CachedCustomer = {
	id: string;
	name: string;
	phone: string;
	/** Decimal string of minor units; null = no limit. */
	creditLimitMinor: string | null;
	/** Decimal string of minor units: what they owed when the list was fetched. */
	balanceMinor: string;
	/** Archived but still owing: the till may take their payment, never charge them. */
	payOnly: boolean;
};

export type CustomersCache = {
	/** ISO time the request was SENT. A sale synced after it is not in the balances. */
	requestedAt: string;
	/** The owner's Customer credit switch, as of that request. */
	creditEnabled: boolean;
	customers: CachedCustomer[];
};

const MINOR = /^-?[0-9]{1,15}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One customer from an untrusted value, copied to exactly the six keys, or null. */
function customerFrom(entry: unknown): CachedCustomer | null {
	if (!isRecord(entry)) return null;
	const { id, name, phone, creditLimitMinor, balanceMinor, payOnly } = entry;
	if (typeof id !== 'string' || id === '') return null;
	if (typeof name !== 'string' || name === '') return null;
	if (typeof phone !== 'string') return null;
	if (
		creditLimitMinor !== null &&
		(typeof creditLimitMinor !== 'string' || !MINOR.test(creditLimitMinor))
	) {
		return null;
	}
	if (typeof balanceMinor !== 'string' || !MINOR.test(balanceMinor)) return null;
	if (typeof payOnly !== 'boolean') return null;
	return { id, name, phone, creditLimitMinor, balanceMinor, payOnly };
}

/** The body of GET /api/pos/customers, cleaned; null when it is not that shape. */
export function customersFrom(
	body: unknown
): { creditEnabled: boolean; customers: CachedCustomer[] } | null {
	if (
		!isRecord(body) ||
		typeof body.creditEnabled !== 'boolean' ||
		!Array.isArray(body.customers)
	) {
		return null;
	}
	const customers: CachedCustomer[] = [];
	const seen = new Set<string>();
	for (const entry of body.customers as unknown[]) {
		const customer = customerFrom(entry);
		// A malformed or repeated entry is dropped; the rest of the list stands.
		if (customer === null || seen.has(customer.id)) continue;
		seen.add(customer.id);
		customers.push(customer);
	}
	return { creditEnabled: body.creditEnabled, customers };
}

/** The cached list, or null when nothing usable is cached. */
export async function readCustomers(): Promise<CustomersCache | null> {
	const value = await readCachedSetting(CUSTOMERS_SETTING);
	if (!isRecord(value) || typeof value.requestedAt !== 'string') return null;
	if (Number.isNaN(Date.parse(value.requestedAt))) return null;
	const cleaned = customersFrom(value);
	if (cleaned === null) return null;
	return { requestedAt: value.requestedAt, ...cleaned };
}

/**
 * Fetch the list and cache it. Skipped — the old cache stays — unless the till
 * is online AND the signed-in employee holds pos.payment.
 *   403 → the device is no longer registered: forgetDevice(), then throw.
 *   any other failure → throw, and the old cache stays.
 * `requestedAt` is the time the request was SENT, never when it landed: a sale
 * that synced while the request was in flight may or may not be in the answer,
 * so localChargesFor keeps counting it.
 * Callers `void` this: a customer list must never hold up selling.
 */
export async function refreshCustomers(opts: {
	mayTakePayment: boolean;
	online: boolean;
	fetchFn?: typeof fetch;
	now?: () => Date;
	signal?: AbortSignal;
}): Promise<'refreshed' | 'skipped'> {
	if (!opts.mayTakePayment || !opts.online) return 'skipped';
	const fetchFn = opts.fetchFn ?? fetch;
	const requestedAt = (opts.now ?? (() => new Date()))().toISOString();

	const response = await fetchFn('/api/pos/customers', {
		credentials: 'same-origin',
		signal: opts.signal
	});
	if (response.status === 403) {
		await forgetDevice();
		throw new Error('GET /api/pos/customers answered 403: this device is not registered');
	}
	if (!response.ok) throw new Error(`GET /api/pos/customers answered ${response.status}`);

	const cleaned = customersFrom(await response.json());
	if (cleaned === null) throw new Error('GET /api/pos/customers sent an unexpected body');

	const cache: CustomersCache = { requestedAt, ...cleaned };
	await cacheSettings([{ key: CUSTOMERS_SETTING, value: cache }]);
	return 'refreshed';
}

/** refreshCustomers that gives up after `ms` and never throws: the pay screen
 * awaits it before the limit check, and must not hang on a weak link. */
export async function refreshCustomersWithin(
	ms: number,
	opts: Parameters<typeof refreshCustomers>[0]
): Promise<'refreshed' | 'skipped' | 'failed'> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await refreshCustomers({ ...opts, signal: controller.signal });
	} catch {
		return 'failed';
	} finally {
		clearTimeout(timer);
	}
}

const digits = (value: string) => value.replace(/\D/g, '');

/**
 * The customers matching what the cashier typed, in the cached (name) order: a
 * case-insensitive match on the name, or — when the query holds a digit — on
 * the phone's digits, so "615 00" finds "+252 61 500 0001". An empty query
 * returns everyone.
 */
export function searchCustomers<T extends { name: string; phone: string }>(
	list: readonly T[],
	query: string
): T[] {
	const text = query.trim().toLowerCase();
	if (text === '') return [...list];
	const wanted = digits(text);
	return list.filter(
		(c) =>
			c.name.toLowerCase().includes(text) ||
			(wanted !== '' && digits(c.phone).includes(wanted)) ||
			c.phone.toLowerCase().includes(text)
	);
}

/**
 * What this till has charged one customer that the cached balance cannot yet
 * include — the sum of its completed CREDIT sales to them that are
 *   (a) not yet synced, or
 *   (b) stored unrecorded on the server (the customer has the food; the owner
 *       has not yet recorded the sale), or
 *   (c) synced AFTER the cache was requested (or with no cache at all).
 * Whatever device id they were queued under. A sale the cache already includes
 * is not counted twice.
 */
export function localChargesFor(
	orders: ReadonlyArray<Pick<LocalOrder, 'state' | 'syncedAt' | 'syncStatus' | 'sale'>>,
	customerId: string,
	requestedAt: string | null
): Minor {
	const cutoff = requestedAt === null ? Number.NaN : Date.parse(requestedAt);
	let total = minor(0n);
	for (const order of orders) {
		if (order.state !== 'completed' || !order.sale) continue;
		const payment = order.sale.payload.payments[0];
		if (!payment || payment.method !== 'credit' || payment.customerId !== customerId) continue;
		const synced = order.syncedAt === undefined ? Number.NaN : Date.parse(order.syncedAt);
		const included =
			order.syncStatus !== 'unrecorded' &&
			!Number.isNaN(synced) &&
			!Number.isNaN(cutoff) &&
			synced <= cutoff;
		if (included) continue;
		const amount = order.sale.payload.totals.totalMinor;
		if (MINOR.test(amount)) total = add(total, minor(BigInt(amount)));
	}
	return total;
}

/** Every local order, for localChargesFor. */
export function readLocalOrders(): Promise<LocalOrder[]> {
	return withDb(
		async (db) =>
			(await valueOf(db.transaction('orders').objectStore('orders').getAll())) as LocalOrder[]
	);
}

export type CreditCheck =
	| {
			ok: true;
			/** What the customer owes as far as this till knows (cached + local). */
			owedMinor: Minor;
			/** What is left under the limit BEFORE this bill; null = no limit. */
			availableMinor: Minor | null;
	  }
	| {
			ok: false;
			reason: 'credit_off' | 'pay_only' | 'over_limit';
			/** The refusal in the words the screen shows. */
			words: string;
			owedMinor: Minor;
			availableMinor: Minor | null;
	  };

/**
 * May this bill be charged to this customer? `formatted` turns an amount into
 * the money formatter's string for the refusal's words — this module never
 * formats money itself.
 */
export function creditCheck(input: {
	customer: CachedCustomer;
	billTotalMinor: Minor;
	localChargesMinor: Minor;
	creditEnabled: boolean;
	format: (amount: Minor) => string;
}): CreditCheck {
	const owed = add(minor(BigInt(input.customer.balanceMinor)), input.localChargesMinor);
	const limit =
		input.customer.creditLimitMinor === null
			? null
			: minor(BigInt(input.customer.creditLimitMinor));
	const available = limit === null ? null : subtract(limit, owed);

	if (!input.creditEnabled) {
		return {
			ok: false,
			reason: 'credit_off',
			words: 'Customer credit is switched off',
			owedMinor: owed,
			availableMinor: available
		};
	}
	if (input.customer.payOnly) {
		return {
			ok: false,
			reason: 'pay_only',
			words: `${input.customer.name} is archived: payment only`,
			owedMinor: owed,
			availableMinor: available
		};
	}
	if (available !== null && input.billTotalMinor > available) {
		const left = available > 0n ? available : minor(0n);
		return {
			ok: false,
			reason: 'over_limit',
			words: `Over the credit limit: ${input.format(left)} left, this bill is ${input.format(input.billTotalMinor)}`,
			owedMinor: owed,
			availableMinor: available
		};
	}
	return { ok: true, owedMinor: owed, availableMinor: available };
}

/** "as of 14:05" — the cache's own time, so a cached balance never reads as live. */
export function asOf(cache: Pick<CustomersCache, 'requestedAt'> | null, timeZone?: string): string {
	if (cache === null) return 'not loaded yet';
	const at = new Date(cache.requestedAt);
	if (Number.isNaN(at.getTime())) return 'not loaded yet';
	const time = new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		...(timeZone ? { timeZone } : {})
	}).format(at);
	return `as of ${time}`;
}

/** True when the cache holds someone the credit tender could charge. */
export function hasChargeable(cache: CustomersCache | null): boolean {
	return cache !== null && cache.creditEnabled && cache.customers.some((c) => !c.payOnly);
}
