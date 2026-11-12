// fake-indexeddb for THIS file only — the store.test.ts idiom.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { minor } from '../money';
import { bindDevice, cacheSettings, readBoundDeviceId, readCachedSetting } from './store';
import type { LocalOrder } from './store';
import {
	CUSTOMERS_SETTING,
	asOf,
	creditCheck,
	customersFrom,
	hasChargeable,
	localChargesFor,
	readCustomers,
	refreshCustomers,
	refreshCustomersWithin,
	searchCustomers,
	type CachedCustomer,
	type CustomersCache
} from './customers';

// The till's customers (tasks/customer-credit T-16): the cache, who may fetch
// it, the search, and the advisory limit check.

function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase('matcami-pos');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

beforeEach(async () => {
	await deleteDatabase();
});

const ALI: CachedCustomer = {
	id: 'c-ali',
	name: 'Ali Hassan',
	phone: '+252 61 500 0001',
	creditLimitMinor: '5000',
	balanceMinor: '0',
	payOnly: false
};
const SARA: CachedCustomer = {
	id: 'c-sara',
	name: 'Sara Omar',
	phone: '615000002',
	creditLimitMinor: null,
	balanceMinor: '1200',
	payOnly: false
};
const GONE: CachedCustomer = {
	id: 'c-gone',
	name: 'Gone Away',
	phone: '615000003',
	creditLimitMinor: null,
	balanceMinor: '880',
	payOnly: true
};

const BODY = { creditEnabled: true, customers: [ALI, SARA, GONE] };

function fetchReturning(status: number, body: unknown, calls: string[] = []): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		calls.push(String(input));
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

const format = (amount: bigint) => `$${(Number(amount) / 100).toFixed(2)}`;

/** A completed credit sale of this till to `customerId`. */
function creditSale(customerId: string, total: string, over: Partial<LocalOrder> = {}): LocalOrder {
	return {
		id: `o-${Math.abs(total.length)}-${customerId}-${over.syncedAt ?? 'x'}`,
		deviceId: 'd1',
		state: 'completed',
		cart: {},
		sale: {
			payload: {
				totals: { subtotalMinor: total, discountMinor: '0', taxMinor: '0', totalMinor: total },
				payments: [
					{
						paymentId: 'p',
						method: 'credit',
						customerId,
						amountMinor: total,
						tenderedMinor: null,
						changeMinor: null
					}
				]
			}
		} as unknown as LocalOrder['sale'],
		...over
	} as LocalOrder;
}

describe('refreshCustomers — who may fetch, and what is kept', () => {
	it('fetches and caches the list with the time the request was SENT', async () => {
		const calls: string[] = [];
		const result = await refreshCustomers({
			mayTakePayment: true,
			online: true,
			fetchFn: fetchReturning(200, BODY, calls),
			now: () => new Date('2026-11-12T14:05:00Z')
		});

		expect(result).toBe('refreshed');
		expect(calls).toEqual(['/api/pos/customers']);
		expect(await readCustomers()).toEqual({
			requestedAt: '2026-11-12T14:05:00.000Z',
			creditEnabled: true,
			customers: [ALI, SARA, GONE]
		});
	});

	it('MANDATORY: never fetches without pos.payment, or offline — and keeps the old cache', async () => {
		const calls: string[] = [];
		const fetchFn = fetchReturning(200, BODY, calls);
		expect(await refreshCustomers({ mayTakePayment: false, online: true, fetchFn })).toBe(
			'skipped'
		);
		expect(await refreshCustomers({ mayTakePayment: true, online: false, fetchFn })).toBe(
			'skipped'
		);
		expect(calls).toEqual([]);
		expect(await readCustomers()).toBeNull();
	});

	it('a failure keeps the old cache; a malformed body throws and keeps it too', async () => {
		await refreshCustomers({
			mayTakePayment: true,
			online: true,
			fetchFn: fetchReturning(200, BODY)
		});
		const before = await readCustomers();

		await expect(
			refreshCustomers({ mayTakePayment: true, online: true, fetchFn: fetchReturning(500, {}) })
		).rejects.toThrow('500');
		await expect(
			refreshCustomers({
				mayTakePayment: true,
				online: true,
				fetchFn: fetchReturning(200, { nope: 1 })
			})
		).rejects.toThrow('unexpected body');
		expect(await readCustomers()).toEqual(before);
	});

	it('a 403 forgets the device: the till is no longer registered', async () => {
		await bindDevice('device-1');
		await refreshCustomers({
			mayTakePayment: true,
			online: true,
			fetchFn: fetchReturning(200, BODY)
		});

		await expect(
			refreshCustomers({ mayTakePayment: true, online: true, fetchFn: fetchReturning(403, {}) })
		).rejects.toThrow('403');
		expect(await readBoundDeviceId()).toBeNull();
		// forgetDevice cleared the settings store: no customer data is left behind.
		expect(await readCustomers()).toBeNull();
	});

	it('MANDATORY: a re-registration clears the cached customers', async () => {
		await bindDevice('device-1');
		await refreshCustomers({
			mayTakePayment: true,
			online: true,
			fetchFn: fetchReturning(200, BODY)
		});
		expect(await readCustomers()).not.toBeNull();

		await bindDevice('device-2');

		expect(await readCachedSetting(CUSTOMERS_SETTING)).toBeUndefined();
		expect(await readCustomers()).toBeNull();
	});

	it('refreshCustomersWithin never throws', async () => {
		const failing = (async () => {
			throw new Error('network down');
		}) as typeof fetch;
		expect(
			await refreshCustomersWithin(50, { mayTakePayment: true, online: true, fetchFn: failing })
		).toBe('failed');
		expect(
			await refreshCustomersWithin(50, { mayTakePayment: false, online: true, fetchFn: failing })
		).toBe('skipped');
	});
});

describe('the cache is cleaned on the way in and out', () => {
	it('keeps exactly the six keys, drops a malformed or repeated customer, keeps the rest', () => {
		const cleaned = customersFrom({
			creditEnabled: false,
			customers: [
				{ ...ALI, secret: 'x' },
				{ ...SARA, balanceMinor: 12 },
				{ ...SARA, id: '' },
				ALI,
				{ ...GONE, creditLimitMinor: 'lots' },
				GONE
			]
		});
		expect(cleaned).toEqual({ creditEnabled: false, customers: [ALI, GONE] });
		expect(customersFrom({ customers: [] })).toBeNull();
		expect(customersFrom(null)).toBeNull();
	});

	it('a garbled cache reads as nothing cached', async () => {
		await cacheSettings([{ key: CUSTOMERS_SETTING, value: { requestedAt: 'never', ...BODY } }]);
		expect(await readCustomers()).toBeNull();
		await cacheSettings([{ key: CUSTOMERS_SETTING, value: 'x' }]);
		expect(await readCustomers()).toBeNull();
	});

	it('hasChargeable: needs credit on and a customer who is not pay-only', () => {
		const cache: CustomersCache = { requestedAt: '2026-11-12T14:05:00.000Z', ...BODY };
		expect(hasChargeable(cache)).toBe(true);
		expect(hasChargeable({ ...cache, creditEnabled: false })).toBe(false);
		expect(hasChargeable({ ...cache, customers: [GONE] })).toBe(false);
		expect(hasChargeable(null)).toBe(false);
	});
});

describe('searchCustomers', () => {
	const list = [ALI, SARA, GONE];
	it('matches the name without regard to case, and the phone by its digits', () => {
		expect(searchCustomers(list, 'ali').map((c) => c.id)).toEqual(['c-ali']);
		expect(searchCustomers(list, 'OMAR').map((c) => c.id)).toEqual(['c-sara']);
		expect(searchCustomers(list, '61 500').map((c) => c.id)).toEqual(['c-ali', 'c-sara', 'c-gone']);
		expect(searchCustomers(list, '0001').map((c) => c.id)).toEqual(['c-ali']);
		expect(searchCustomers(list, '+252').map((c) => c.id)).toEqual(['c-ali']);
	});
	it('an empty query returns everyone, in the cached order; no match returns nobody', () => {
		expect(searchCustomers(list, '  ').map((c) => c.id)).toEqual(['c-ali', 'c-sara', 'c-gone']);
		expect(searchCustomers(list, 'zzz')).toEqual([]);
	});
});

describe('localChargesFor — what the cached balance cannot yet include', () => {
	const REQUESTED = '2026-11-12T14:00:00.000Z';

	it('counts an unsynced charge, a charge synced after the cache was requested, and an unrecorded one', () => {
		const orders = [
			creditSale('c-ali', '3000'), // not synced
			creditSale('c-ali', '700', { syncedAt: '2026-11-12T14:01:00.000Z', syncStatus: 'accepted' }),
			creditSale('c-ali', '50', { syncedAt: '2026-11-12T13:00:00.000Z', syncStatus: 'unrecorded' })
		];
		expect(localChargesFor(orders, 'c-ali', REQUESTED)).toBe(3750n);
	});

	it('does not count a charge the cached balance already includes', () => {
		const orders = [
			creditSale('c-ali', '3000', { syncedAt: '2026-11-12T13:59:00.000Z', syncStatus: 'accepted' }),
			creditSale('c-ali', '100', {
				syncedAt: '2026-11-12T13:58:00.000Z',
				syncStatus: 'recorded_flagged'
			})
		];
		expect(localChargesFor(orders, 'c-ali', REQUESTED)).toBe(0n);
	});

	it('with no cache at all, every charge counts', () => {
		const orders = [
			creditSale('c-ali', '3000', { syncedAt: '2026-11-12T13:59:00.000Z', syncStatus: 'accepted' })
		];
		expect(localChargesFor(orders, 'c-ali', null)).toBe(3000n);
	});

	it('ignores other customers, other tenders, carts and abandoned orders', () => {
		const cash = creditSale('c-ali', '900');
		(
			cash.sale as unknown as { payload: { payments: { method: string }[] } }
		).payload.payments[0].method = 'cash';
		const orders = [
			creditSale('c-sara', '3000'),
			cash,
			creditSale('c-ali', '400', { state: 'cart' }),
			creditSale('c-ali', '500', { state: 'abandoned' }),
			{ id: 'x', deviceId: 'd1', state: 'completed', cart: {} } as LocalOrder
		];
		expect(localChargesFor(orders, 'c-ali', REQUESTED)).toBe(0n);
	});
});

describe('creditCheck — the till-side limit', () => {
	const base = { creditEnabled: true, format, localChargesMinor: minor(0n) };

	it('MANDATORY: limit 50.00 — a 30.00 bill fits; a second 30.00 is refused, whether the first is unsynced or just synced', () => {
		const first = creditCheck({ ...base, customer: ALI, billTotalMinor: minor(3000n) });
		expect(first).toEqual({ ok: true, owedMinor: 0n, availableMinor: 5000n });

		// The first 30.00 is local: unsynced, or synced after the cache was requested.
		const second = creditCheck({
			...base,
			customer: ALI,
			billTotalMinor: minor(3000n),
			localChargesMinor: minor(3000n)
		});
		expect(second).toEqual({
			ok: false,
			reason: 'over_limit',
			words: 'Over the credit limit: $20.00 left, this bill is $30.00',
			owedMinor: 3000n,
			availableMinor: 2000n
		});

		// Once a refresh REQUESTED after the sync shows 30.00, nothing is local.
		const refreshed = creditCheck({
			...base,
			customer: { ...ALI, balanceMinor: '3000' },
			billTotalMinor: minor(2000n)
		});
		expect(refreshed).toEqual({ ok: true, owedMinor: 3000n, availableMinor: 2000n });
	});

	it('exactly at the limit fits; one cent over does not; already over shows 0 left', () => {
		expect(creditCheck({ ...base, customer: ALI, billTotalMinor: minor(5000n) }).ok).toBe(true);
		expect(creditCheck({ ...base, customer: ALI, billTotalMinor: minor(5001n) }).ok).toBe(false);
		const over = creditCheck({
			...base,
			customer: { ...ALI, balanceMinor: '6000' },
			billTotalMinor: minor(100n)
		});
		expect(over).toMatchObject({
			ok: false,
			words: 'Over the credit limit: $0.00 left, this bill is $1.00',
			availableMinor: -1000n
		});
	});

	it('no limit always fits', () => {
		expect(creditCheck({ ...base, customer: SARA, billTotalMinor: minor(9_999_999n) })).toEqual({
			ok: true,
			owedMinor: 1200n,
			availableMinor: null
		});
	});

	it('a pay-only (archived) customer is never chargeable; credit switched off refuses everyone', () => {
		expect(creditCheck({ ...base, customer: GONE, billTotalMinor: minor(100n) })).toMatchObject({
			ok: false,
			reason: 'pay_only',
			words: 'Gone Away is archived: payment only'
		});
		expect(
			creditCheck({ ...base, creditEnabled: false, customer: SARA, billTotalMinor: minor(100n) })
		).toMatchObject({ ok: false, reason: 'credit_off', words: 'Customer credit is switched off' });
	});
});

describe('asOf', () => {
	it('prints the time the balances were fetched, so a cached balance never reads as live', () => {
		expect(asOf({ requestedAt: '2026-11-12T14:05:00.000Z' }, 'UTC')).toBe('as of 14:05');
		expect(asOf({ requestedAt: '2026-11-12T14:05:00.000Z' }, 'Africa/Mogadishu')).toBe(
			'as of 17:05'
		);
		expect(asOf(null)).toBe('not loaded yet');
		expect(asOf({ requestedAt: 'x' })).toBe('not loaded yet');
	});
});
