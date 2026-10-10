// The unit project runs in `node`, which has no indexedDB: fake-indexeddb (a pinned
// devDependency) provides the global for THIS file only — the store.test.ts idiom.
// Every case runs against the real settings store, with the database deleted
// before each one, so "nothing cached" is genuinely nothing.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT, type ReceiptLayout } from '../receipt-layout';
import { bindDevice, cacheSettings, readBoundDeviceId, readCachedSetting } from './store';
import {
	PAYMENT_METHODS_SETTING,
	RECEIPT_LAYOUT_SETTING,
	RECEIPT_LOGO_SETTING,
	confirmReceiptLogo,
	readConfirmedLogoPrinter,
	readConfirmedLogoSha,
	readPaymentMethods,
	readReceiptLayout,
	readReceiptLogo,
	refreshReceiptLogo,
	withdrawReceiptLogoConfirmation,
	type CachedPaymentMethod
} from './settings';

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

// The 16 × 2 logo T-20's route test serves (bitmap ff 00 81 7e), with the
// fingerprint T-12 computes for it: the sha256 of `16x2\n` followed by the
// four bytes. 4 bytes = 16 / 8 × 2.
const LOGO = {
	sha256: '76413a20db4a92b11606749459eace5b95cebd3ae13279d689866290cb1bfa2d',
	widthDots: 16,
	heightDots: 2,
	bitmap: '/wCBfg=='
};

const CASH: CachedPaymentMethod = {
	id: 'pm-cash',
	name: 'Cash',
	kind: 'cash',
	merchantNumber: null
};
const EVC: CachedPaymentMethod = {
	id: 'pm-evc',
	name: 'EVC Plus',
	kind: 'mobile',
	merchantNumber: '61 234 5678'
};

/** A layout like the default, as a fresh unfrozen object, with the given logo fingerprint. */
function layoutWith(logo: ReceiptLayout['logo']): ReceiptLayout {
	return {
		headerLines: [],
		footerLines: [],
		show: { ...DEFAULT_RECEIPT_LAYOUT.show },
		paymentNumbersHeading: null,
		logo
	};
}

const fingerprint = { sha256: LOGO.sha256, widthDots: LOGO.widthDots, heightDots: LOGO.heightDots };

/** A fake fetch that records every url it is asked for and answers with `respond`. */
function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
	const calls: string[] = [];
	const fetchFn = (async (url: string) => {
		calls.push(url);
		return respond(url);
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});

describe('readPaymentMethods', () => {
	it('answers [] when nothing is cached', async () => {
		expect(await readPaymentMethods()).toEqual([]);
	});

	it('returns the cached list in order', async () => {
		await cacheSettings([{ key: PAYMENT_METHODS_SETTING, value: [CASH, EVC] }]);

		expect(await readPaymentMethods()).toEqual([CASH, EVC]);
	});

	it('answers [] for a cached value that is not a list', async () => {
		await cacheSettings([{ key: PAYMENT_METHODS_SETTING, value: 'cash' }]);

		expect(await readPaymentMethods()).toEqual([]);
	});

	it('keeps only the valid entries, copied to exactly four keys', async () => {
		await cacheSettings([
			{
				key: PAYMENT_METHODS_SETTING,
				value: [
					CASH,
					{ id: 'pm-chq', name: 'Cheque', kind: 'cheque', merchantNumber: null },
					{ id: 'pm-nameless', kind: 'card', merchantNumber: null },
					{ id: '', name: 'Blank id', kind: 'card', merchantNumber: null },
					{ id: 'pm-num', name: 'Bad number', kind: 'mobile', merchantNumber: 61 },
					'EVC Plus',
					// An extra key from a different build is dropped on the way out.
					{ ...EVC, enabled: true, sortOrder: 3 }
				]
			}
		]);

		const methods = await readPaymentMethods();

		expect(methods).toEqual([CASH, EVC]);
		for (const method of methods) {
			expect(Object.keys(method).sort()).toEqual(['id', 'kind', 'merchantNumber', 'name']);
		}
	});
});

describe('readReceiptLayout', () => {
	it('falls back to the default layout, as a NEW object, when nothing is cached', async () => {
		const layout = await readReceiptLayout();

		expect(layout).toEqual(DEFAULT_RECEIPT_LAYOUT);
		expect(layout).not.toBe(DEFAULT_RECEIPT_LAYOUT);
		// The default is frozen; a reader must never hand out its arrays or `show`.
		expect(layout.headerLines).not.toBe(DEFAULT_RECEIPT_LAYOUT.headerLines);
		expect(layout.footerLines).not.toBe(DEFAULT_RECEIPT_LAYOUT.footerLines);
		expect(layout.show).not.toBe(DEFAULT_RECEIPT_LAYOUT.show);
		expect(Object.isFrozen(layout.footerLines)).toBe(false);
	});

	it('uses a pre-plan receiptFooter as footer line 1 when no layout is cached', async () => {
		await cacheSettings([{ key: 'receiptFooter', value: 'Mahadsanid!' }]);

		expect(await readReceiptLayout()).toEqual({
			...DEFAULT_RECEIPT_LAYOUT,
			footerLines: ['Mahadsanid!']
		});
	});

	it('ignores a blank or null pre-plan footer', async () => {
		await cacheSettings([{ key: 'receiptFooter', value: '  ' }]);
		expect((await readReceiptLayout()).footerLines).toEqual([]);

		await cacheSettings([{ key: 'receiptFooter', value: null }]);
		expect((await readReceiptLayout()).footerLines).toEqual([]);
	});

	it('returns a cached valid layout exactly, with the legacy footer beside it ignored', async () => {
		const layout: ReceiptLayout = {
			headerLines: ['Open daily 7-23', 'Hodan district'],
			footerLines: ['Mahadsanid!'],
			show: { ...DEFAULT_RECEIPT_LAYOUT.show, businessDate: false, unitPrice: false },
			paymentNumbersHeading: 'PAY BY MOBILE MONEY',
			logo: fingerprint
		};
		await cacheSettings([
			{ key: RECEIPT_LAYOUT_SETTING, value: layout },
			{ key: 'receiptFooter', value: 'An older footer' }
		]);

		expect(await readReceiptLayout()).toEqual(layout);
	});

	it('sanitises each field on its own and keeps the rest', async () => {
		await cacheSettings([
			{
				key: RECEIPT_LAYOUT_SETTING,
				value: {
					headerLines: 'x',
					footerLines: ['1', '2', '3', '4', '5', '6', '7'],
					show: { ...DEFAULT_RECEIPT_LAYOUT.show, cashier: 'yes', table: false },
					paymentNumbersHeading: 'Pay by phone',
					logo: { sha256: 'XYZ', widthDots: 16, heightDots: 2 }
				}
			}
		]);

		const layout = await readReceiptLayout();

		expect(layout.show.cashier).toBe(true);
		expect(layout.show.table).toBe(false);
		expect(layout.headerLines).toEqual([]);
		expect(layout.footerLines).toEqual(['1', '2', '3', '4', '5']);
		expect(layout.paymentNumbersHeading).toBe('Pay by phone');
		expect(layout.logo).toBeNull();
	});

	it('fills a missing or garbled show block, an empty heading and an empty line with the defaults', async () => {
		await cacheSettings([
			{
				key: RECEIPT_LAYOUT_SETTING,
				value: {
					headerLines: ['Open daily', ''],
					footerLines: [],
					show: 'all',
					paymentNumbersHeading: '',
					logo: fingerprint
				}
			}
		]);

		const layout = await readReceiptLayout();

		expect(layout.show).toEqual(DEFAULT_RECEIPT_LAYOUT.show);
		expect(layout.headerLines).toEqual([]);
		expect(layout.paymentNumbersHeading).toBeNull();
		expect(layout.logo).toEqual(fingerprint);
	});
});

describe('readReceiptLogo', () => {
	it('answers null when nothing is cached', async () => {
		expect(await readReceiptLogo()).toBeNull();
	});

	it('returns the cached logo', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);

		expect(await readReceiptLogo()).toEqual(LOGO);
	});

	it('answers null for a bitmap of the wrong length (3 bytes for a 16 × 2 logo)', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: { ...LOGO, bitmap: '/wCB' } }]);

		expect(await readReceiptLogo()).toBeNull();
	});

	it('answers null for a fingerprint that is not 64 hex characters', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: { ...LOGO, sha256: 'XYZ' } }]);

		expect(await readReceiptLogo()).toBeNull();
	});

	it('answers null for a width that is not a multiple of 8', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: { ...LOGO, widthDots: 12 } }]);

		expect(await readReceiptLogo()).toBeNull();
	});

	it('answers null for a bitmap that is not standard padded base64', async () => {
		for (const bitmap of ['/wCBfg', '/wCBfg=', '/wCB-g==', '/wCBfg===']) {
			await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: { ...LOGO, bitmap } }]);

			expect(await readReceiptLogo(), bitmap).toBeNull();
		}
	});
});

describe('refreshReceiptLogo', () => {
	it('clears the cache without fetching when the layout has no logo', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		const { calls, fetchFn } = fakeFetch(() => jsonResponse(LOGO));

		await refreshReceiptLogo(layoutWith(null), fetchFn);

		expect(calls).toEqual([]);
		expect(await readReceiptLogo()).toBeNull();
	});

	it('does not fetch when the cached fingerprint equals the layout’s', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		const { calls, fetchFn } = fakeFetch(() => jsonResponse(LOGO));

		await refreshReceiptLogo(layoutWith(fingerprint), fetchFn);

		expect(calls).toEqual([]);
		expect(await readReceiptLogo()).toEqual(LOGO);
	});

	it('fetches the bytes once when the fingerprint differs, and caches what the route returned', async () => {
		const { calls, fetchFn } = fakeFetch(() => jsonResponse(LOGO));

		await refreshReceiptLogo(layoutWith(fingerprint), fetchFn);

		expect(calls).toEqual(['/api/pos/receipt-logo']);
		expect(await readReceiptLogo()).toEqual(LOGO);

		// The owner replaced the logo between the bundle and the fetch: the route's
		// answer is stored as returned, and the next bundle will agree with it.
		const replaced = { ...LOGO, sha256: 'a'.repeat(64), bitmap: 'AAAAAQ==' };
		const second = fakeFetch(() => jsonResponse(replaced));
		await refreshReceiptLogo(
			layoutWith({ ...fingerprint, sha256: 'b'.repeat(64) }),
			second.fetchFn
		);

		expect(second.calls).toEqual(['/api/pos/receipt-logo']);
		expect(await readReceiptLogo()).toEqual(replaced);
	});

	it('keeps the old logo when the network throws', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		const { fetchFn } = fakeFetch(() => {
			throw new TypeError('Failed to fetch');
		});

		await expect(
			refreshReceiptLogo(layoutWith({ ...fingerprint, sha256: 'b'.repeat(64) }), fetchFn)
		).rejects.toThrow(/Failed to fetch/);

		expect(await readReceiptLogo()).toEqual(LOGO);
	});

	it('clears the cache and resolves on 404: the owner removed the logo after the bundle', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		const { fetchFn } = fakeFetch(() => jsonResponse({ error: 'no_logo' }, 404));

		await refreshReceiptLogo(layoutWith({ ...fingerprint, sha256: 'b'.repeat(64) }), fetchFn);

		expect(await readReceiptLogo()).toBeNull();
	});

	it('forgets the device on 403: a revoked till keeps nothing', async () => {
		await bindDevice('device-A');
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		const { fetchFn } = fakeFetch(() => new Response('Forbidden', { status: 403 }));

		await expect(
			refreshReceiptLogo(layoutWith({ ...fingerprint, sha256: 'b'.repeat(64) }), fetchFn)
		).rejects.toThrow(/403/);

		expect(await readBoundDeviceId()).toBeNull();
		expect(await readReceiptLogo()).toBeNull();
	});

	it('keeps the old logo on any other failure status', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		const { fetchFn } = fakeFetch(() => new Response('Server error', { status: 500 }));

		await expect(
			refreshReceiptLogo(layoutWith({ ...fingerprint, sha256: 'b'.repeat(64) }), fetchFn)
		).rejects.toThrow(/500/);

		expect(await readReceiptLogo()).toEqual(LOGO);
	});

	it('rejects a 200 whose byte length is off by one, and keeps the old logo', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		const { fetchFn } = fakeFetch(() =>
			jsonResponse({ ...LOGO, sha256: 'b'.repeat(64), bitmap: '/wCBfgA=' })
		);

		await expect(
			refreshReceiptLogo(layoutWith({ ...fingerprint, sha256: 'b'.repeat(64) }), fetchFn)
		).rejects.toThrow(/unexpected body/);

		expect(await readReceiptLogo()).toEqual(LOGO);
	});
});

describe('the logo confirmation key (T-24)', () => {
	// The settings-store key the gate is keyed on (00-overview.md, "Printing"):
	// written only by confirmReceiptLogo, deleted by withdrawReceiptLogoConfirmation
	// (and the device wipes), read only by readConfirmedLogoSha.
	const KEY = 'receiptLogoConfirmed';

	it('answers null when nothing was confirmed', async () => {
		expect(await readConfirmedLogoSha()).toBeNull();
	});

	it('answers null for a garbled value: not a string, or not 64 lower-case hex characters', async () => {
		for (const value of [
			null,
			42,
			true,
			'XYZ',
			'A'.repeat(64),
			'a'.repeat(63),
			'a'.repeat(65),
			{ sha256: 'a'.repeat(64) },
			['a'.repeat(64)]
		]) {
			await cacheSettings([{ key: KEY, value }]);

			expect(await readConfirmedLogoSha(), JSON.stringify(value)).toBeNull();
		}
	});

	it('confirmReceiptLogo refuses anything but a 64-hex string with a TypeError, before any write', async () => {
		expect(() => confirmReceiptLogo('x', 'legacy')).toThrow(TypeError);
		expect(() => confirmReceiptLogo('A'.repeat(64), 'legacy')).toThrow(TypeError);
		expect(() => confirmReceiptLogo('a'.repeat(63), 'legacy')).toThrow(TypeError);
		expect(() => confirmReceiptLogo(42 as unknown as string, 'legacy')).toThrow(TypeError);

		expect(await readConfirmedLogoSha()).toBeNull();
	});

	it('a 64-hex value round-trips, and a later confirmation replaces it', async () => {
		await confirmReceiptLogo(LOGO.sha256, 'legacy');
		expect(await readConfirmedLogoSha()).toBe(LOGO.sha256);

		await confirmReceiptLogo('b'.repeat(64), 'legacy');
		expect(await readConfirmedLogoSha()).toBe('b'.repeat(64));
	});

	it('withdrawReceiptLogoConfirmation with the confirmed fingerprint deletes the key, and the cached logo stays', async () => {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: LOGO }]);
		await confirmReceiptLogo(LOGO.sha256, 'legacy');

		await withdrawReceiptLogoConfirmation(LOGO.sha256);

		expect(await readConfirmedLogoSha()).toBeNull();
		// Deleted, not overwritten.
		expect(await readCachedSetting(KEY)).toBeUndefined();
		// Test pages still carry the logo; only receipts lose it.
		expect(await readReceiptLogo()).toEqual(LOGO);
	});

	it('withdrawReceiptLogoConfirmation with a DIFFERENT fingerprint leaves the confirmation as it is', async () => {
		await confirmReceiptLogo(LOGO.sha256, 'legacy');

		await withdrawReceiptLogoConfirmation('b'.repeat(64));

		expect(await readConfirmedLogoSha()).toBe(LOGO.sha256);
	});

	it('withdrawReceiptLogoConfirmation without a fingerprint deletes whatever is confirmed, and resolves when nothing is', async () => {
		await withdrawReceiptLogoConfirmation();
		await withdrawReceiptLogoConfirmation(LOGO.sha256);
		expect(await readConfirmedLogoSha()).toBeNull();

		await confirmReceiptLogo('b'.repeat(64), 'legacy');
		await withdrawReceiptLogoConfirmation();

		expect(await readConfirmedLogoSha()).toBeNull();
		expect(await readCachedSetting(KEY)).toBeUndefined();
	});

	// print-agent-installer T-14: a confirmation vouches for ONE printer.
	it('records the printer it was watched on; an empty or overlong printer key is refused before any write', async () => {
		expect(() => confirmReceiptLogo(LOGO.sha256, '')).toThrow(TypeError);
		expect(() => confirmReceiptLogo(LOGO.sha256, 'x'.repeat(301))).toThrow(TypeError);
		expect(() => confirmReceiptLogo(LOGO.sha256, 7 as unknown as string)).toThrow(TypeError);
		expect(await readConfirmedLogoSha()).toBeNull();
		expect(await readConfirmedLogoPrinter()).toBeNull();

		await confirmReceiptLogo(LOGO.sha256, '192.168.1.50:9100:48');
		expect(await readConfirmedLogoSha()).toBe(LOGO.sha256);
		expect(await readConfirmedLogoPrinter()).toBe('192.168.1.50:9100:48');
	});

	it('withdrawing takes the printer key with the fingerprint — both modes', async () => {
		await confirmReceiptLogo(LOGO.sha256, '192.168.1.50:9100:48');
		await withdrawReceiptLogoConfirmation();
		expect(await readConfirmedLogoSha()).toBeNull();
		expect(await readConfirmedLogoPrinter()).toBeNull();

		await confirmReceiptLogo(LOGO.sha256, '192.168.1.50:9100:48');
		await withdrawReceiptLogoConfirmation('b'.repeat(64));
		expect(await readConfirmedLogoPrinter()).toBe('192.168.1.50:9100:48');
		await withdrawReceiptLogoConfirmation(LOGO.sha256);
		expect(await readConfirmedLogoSha()).toBeNull();
		expect(await readConfirmedLogoPrinter()).toBeNull();
	});
});

describe('a device change', () => {
	it('drops the cached methods, layout, logo and the logo confirmation', async () => {
		await bindDevice('device-A');
		await cacheSettings([
			{ key: PAYMENT_METHODS_SETTING, value: [CASH, EVC] },
			{
				key: RECEIPT_LAYOUT_SETTING,
				value: { ...layoutWith(fingerprint), footerLines: ['Mahadsanid!'] }
			},
			{ key: RECEIPT_LOGO_SETTING, value: LOGO }
		]);
		await confirmReceiptLogo(LOGO.sha256, 'legacy');
		expect(await readPaymentMethods()).toEqual([CASH, EVC]);
		expect(await readReceiptLogo()).toEqual(LOGO);
		expect(await readConfirmedLogoSha()).toBe(LOGO.sha256);

		await bindDevice('device-B');

		expect(await readPaymentMethods()).toEqual([]);
		expect(await readReceiptLogo()).toBeNull();
		expect(await readReceiptLayout()).toEqual(DEFAULT_RECEIPT_LAYOUT);
		// A re-registered till asks for the test print again (the gate's key is per device).
		expect(await readConfirmedLogoSha()).toBeNull();
		expect(await readConfirmedLogoPrinter()).toBeNull();
	});
});
