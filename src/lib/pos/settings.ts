// THE TILL'S CACHED SETTINGS — the settings bundle's payment methods, receipt
// layout and logo, cached for offline use. Every reader tolerates a missing or
// garbled value and returns a safe fallback, never a throw. The cache may have
// been written by an older build, or not at all.
// (tasks/settings-tax-payments-receipt T-21; spec 4, 6, 11.)
//
// WHERE THE VALUES COME FROM. The landing screen (src/routes/(pos)/pos/+page.svelte)
// stores `settings.paymentMethods` and `settings.receipt` from GET
// /api/pos/employees AS THEY ARRIVED, under the three keys below; the logo's
// BYTES come from GET /api/pos/receipt-logo, fetched by refreshReceiptLogo only
// when the bundle's fingerprint differs from the cached one. The readers
// sanitise on the way OUT, so a value written by an older build — or none at
// all — is recognised and replaced by a fallback, never trusted (invariant 5):
// no methods cached → `[]`, and the pay screen offers Cash only (T-22); no
// layout cached → today's receipt, with a pre-plan `receiptFooter` as footer
// line 1; a bad logo → null, and the receipt prints without it (T-23, T-24).
// A reader still rejects when IndexedDB itself cannot be opened (a private
// window, storage refused), exactly as every store.ts reader does; callers
// `.catch` that, as the landing screen does.
//
// IndexedDB, not the HTTP cache or the service worker, is where the logo lives:
// the route answers `cache-control: no-store`, and the worker never
// runtime-caches anything (CLAUDE.md, service-worker policy, part 6). Printing
// therefore never touches the network (spec 11).
//
// This module writes ONLY `settings` keys — never `orders`, `sync_queue`,
// `invoice_sequence`, `session` or `offline_logins` (invariant 5) — and
// bindDevice / forgetDevice clear the whole `settings` store, these keys
// included, so a revoked or re-registered device keeps nothing (invariant 12).
// Card and mobile still fail closed offline; nothing here changes that.
//
// Nothing from the server side: this file must work offline, and eslint's
// no-restricted-imports rule for src/lib/pos enforces that boundary. The receipt
// contract is the isomorphic src/lib/receipt-layout.ts (T-12).

import { cacheSettings, forgetDevice, inTransaction, readCachedSetting, withDb } from './store';
import { PAYMENT_METHODS, type PaymentMethod } from '../sync-ops';
import {
	DEFAULT_RECEIPT_LAYOUT,
	RECEIPT_LINES_PER_SECTION,
	RECEIPT_SHOW_KEYS,
	isValidLogoShape,
	type ReceiptLayout,
	type ReceiptLogoMeta,
	type ReceiptShow
} from '../receipt-layout';

/**
 * The three settings-store keys this module owns (00-overview.md, "Till"), plus
 * LOGO_CONFIRMED_KEY below — the logo confirmation gate (T-24).
 */
export const PAYMENT_METHODS_SETTING = 'paymentMethods';
export const RECEIPT_LAYOUT_SETTING = 'receiptLayout';
export const RECEIPT_LOGO_SETTING = 'receiptLogo';

/**
 * The pre-plan footer an older landing screen cached from the bundle's legacy
 * `receiptFooter` key, which migration 0018 RETIRED with its column (T-33); no
 * build writes it any more. Read ONLY when no layout is cached: a till whose
 * cache is from before this plan has a footer and nothing else.
 */
const LEGACY_RECEIPT_FOOTER_SETTING = 'receiptFooter';

/**
 * One enabled, live payment method as the bundle ships it — exactly the four
 * keys GET /api/pos/employees sends. `kind` is what every fail-closed branch
 * keys on (cash sells offline; card and mobile do not); `merchantNumber` is the
 * restaurant's own number customers send money to, printed on the receipt.
 */
export type CachedPaymentMethod = {
	id: string;
	name: string;
	kind: 'cash' | 'card' | 'mobile';
	merchantNumber: string | null;
};

/**
 * The cached logo: its fingerprint, its shape, and the bitmap as the standard
 * base64 string GET /api/pos/receipt-logo sent. The till never decodes it; the
 * print agent validates and decodes it (T-25).
 */
export type CachedReceiptLogo = {
	sha256: string;
	widthDots: number;
	heightDots: number;
	bitmap: string;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value);
}

function isPaymentMethodKind(value: unknown): value is PaymentMethod {
	return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * The cached payment methods, in the bundle's order (cash first), or `[]` when
 * nothing usable is cached. Each entry must have a non-empty string `id` and
 * `name`, a `kind` in PAYMENT_METHODS and a `merchantNumber` that is a string
 * or null; any other entry is dropped, and the kept ones are copied to exactly
 * those four keys. `[]` means "no list cached", and the pay screen then offers
 * Cash only (T-22) — a stale or absent cache never stops a cash sale.
 */
export async function readPaymentMethods(): Promise<CachedPaymentMethod[]> {
	const value = await readCachedSetting(PAYMENT_METHODS_SETTING);

	if (!Array.isArray(value)) return [];

	const methods: CachedPaymentMethod[] = [];

	for (const entry of value as unknown[]) {
		if (!isRecord(entry)) continue;

		const { id, name, kind, merchantNumber } = entry;

		if (typeof id !== 'string' || id === '') continue;
		if (typeof name !== 'string' || name === '') continue;
		if (!isPaymentMethodKind(kind)) continue;
		if (typeof merchantNumber !== 'string' && merchantNumber !== null) continue;

		methods.push({ id, name, kind, merchantNumber });
	}

	return methods;
}

/** An array of non-empty strings, capped at the section's maximum; else `[]`. */
function linesFrom(value: unknown): string[] {
	if (!Array.isArray(value)) return [];

	const lines = value as unknown[];

	if (!lines.every((line): line is string => typeof line === 'string' && line !== '')) return [];

	return lines.slice(0, RECEIPT_LINES_PER_SECTION);
}

/** Each switch's cached boolean, or the default's `true` when it is missing or not a boolean. */
function showFrom(value: unknown): ReceiptShow {
	const source: Record<string, unknown> = isRecord(value) ? value : {};
	const show: ReceiptShow = { ...DEFAULT_RECEIPT_LAYOUT.show };

	for (const key of RECEIPT_SHOW_KEYS) {
		const flag = source[key];
		if (typeof flag === 'boolean') show[key] = flag;
	}

	return show;
}

/** The logo's fingerprint and shape: a 64-hex sha256 and integer dots. */
function isLogoMeta(value: unknown): value is ReceiptLogoMeta {
	return (
		isRecord(value) &&
		typeof value.sha256 === 'string' &&
		SHA256_HEX.test(value.sha256) &&
		isInteger(value.widthDots) &&
		isInteger(value.heightDots)
	);
}

/**
 * The cached receipt layout, sanitised field by field, or the fallback for a
 * cache written before this plan. ALWAYS a new object — DEFAULT_RECEIPT_LAYOUT
 * is frozen and shared, and no reader may hand out its arrays.
 *
 * - A cached plain object: `headerLines`/`footerLines` must be arrays of
 *   non-empty strings (capped at RECEIPT_LINES_PER_SECTION), else `[]`; `show`
 *   takes each switch's boolean, or the default's `true` when that key is
 *   missing or not a boolean; `paymentNumbersHeading` is a non-empty string or
 *   null; `logo` passes isLogoMeta, else null.
 * - Otherwise, the pre-plan cache: the default layout with the legacy
 *   `receiptFooter` as footer line 1 when it holds a non-blank string, else no
 *   footer. When a layout IS cached, the legacy key is ignored even if it is
 *   still present: a build from before T-33 cached both, and the legacy value
 *   is one /settings/receipt never edited.
 */
export async function readReceiptLayout(): Promise<ReceiptLayout> {
	const cached = await readCachedSetting(RECEIPT_LAYOUT_SETTING);

	if (isRecord(cached)) {
		const heading = cached.paymentNumbersHeading;
		const logo = cached.logo;

		return {
			headerLines: linesFrom(cached.headerLines),
			footerLines: linesFrom(cached.footerLines),
			show: showFrom(cached.show),
			paymentNumbersHeading: typeof heading === 'string' && heading !== '' ? heading : null,
			logo: isLogoMeta(logo)
				? { sha256: logo.sha256, widthDots: logo.widthDots, heightDots: logo.heightDots }
				: null
		};
	}

	const legacy = await readCachedSetting(LEGACY_RECEIPT_FOOTER_SETTING);

	return {
		...DEFAULT_RECEIPT_LAYOUT,
		headerLines: [],
		footerLines: typeof legacy === 'string' && legacy.trim() !== '' ? [legacy] : [],
		show: { ...DEFAULT_RECEIPT_LAYOUT.show }
	};
}

/**
 * The byte count a base64 string decodes to, or -1 when it is not standard
 * padded base64 (the alphabet, a length that is a multiple of 4, at most two
 * trailing `=`). Arithmetic on a string's LENGTH, not on money: every 4
 * characters carry 3 bytes, less one per trailing `=`.
 */
function base64ByteLength(s: string): number {
	if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return -1;

	const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;

	return (s.length / 4) * 3 - padding;
}

/**
 * The one check a logo passes to be cached or served from the cache: the
 * fingerprint and integer dots (isLogoMeta), a string bitmap, and a shape the
 * print agent and the database accept, with the base64 decoding to EXACTLY
 * widthDots / 8 × heightDots bytes. Anything else is null — never a throw.
 */
function logoFrom(value: unknown): CachedReceiptLogo | null {
	if (!isRecord(value)) return null;

	const { sha256, widthDots, heightDots, bitmap } = value;

	if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null;
	if (!isInteger(widthDots) || !isInteger(heightDots)) return null;
	if (typeof bitmap !== 'string') return null;
	if (!isValidLogoShape(widthDots, heightDots, base64ByteLength(bitmap))) return null;

	return { sha256, widthDots, heightDots, bitmap };
}

/**
 * The cached logo, or null when none is cached or the cached value fails
 * logoFrom's checks. The bitmap stays the base64 string the route sent.
 */
export async function readReceiptLogo(): Promise<CachedReceiptLogo | null> {
	return logoFrom(await readCachedSetting(RECEIPT_LOGO_SETTING));
}

/**
 * Bring the cached logo in line with the bundle's fingerprint, fetching the
 * bytes ONLY when they differ:
 * - no logo in the layout → the cache is cleared, with no fetch;
 * - the cached sha equals the layout's → nothing to do, with no fetch;
 * - otherwise GET /api/pos/receipt-logo (the device cookie is HttpOnly and
 *   travels on its own). A network throw propagates and the old logo stays.
 *   403 → the device is unknown or REVOKED: forget everything cached for it,
 *   then throw (syncMenu's precedent — a revoked till keeps nothing). 404 →
 *   the owner removed the logo after the bundle was built: cache null. Any
 *   other failure → throw, and the old logo stays. 200 → cache exactly what the
 *   route RETURNED if it passes logoFrom, even when its sha differs from the
 *   layout's because the owner replaced the logo between the two requests (the
 *   next bundle will agree with it); a body that fails the checks throws and
 *   keeps the old logo.
 *
 * Callers `void` this and swallow its errors: a logo must never hold up the
 * employee list, the PIN screen or the menu sync, and a missing logo prints a
 * receipt without it until the next sign-in or reconnect retries.
 */
export async function refreshReceiptLogo(
	layout: ReceiptLayout,
	fetchFn: typeof fetch = fetch
): Promise<void> {
	if (layout.logo === null) {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: null }]);
		return;
	}

	if ((await readReceiptLogo())?.sha256 === layout.logo.sha256) return;

	const response = await fetchFn('/api/pos/receipt-logo', { credentials: 'same-origin' });

	if (response.status === 403) {
		await forgetDevice();
		throw new Error('GET /api/pos/receipt-logo answered 403: this device is not registered');
	}

	if (response.status === 404) {
		await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: null }]);
		return;
	}

	if (!response.ok) {
		throw new Error(`GET /api/pos/receipt-logo answered ${response.status}`);
	}

	const logo = logoFrom(await response.json());

	if (logo === null) {
		throw new Error('GET /api/pos/receipt-logo sent an unexpected body');
	}

	await cacheSettings([{ key: RECEIPT_LOGO_SETTING, value: logo }]);
}

// ── The logo confirmation gate (T-24) ───────────────────────────────────────

/**
 * The fingerprint of the logo the owner watched print correctly on a test page
 * from /pos/printer ("The logo printed correctly"). A RECEIPT carries the logo
 * only while the cached logo's `sha256` equals this value (printing.ts
 * logoForAgent). Why a gate at all: on a printer that does not implement
 * `GS v 0` the raster bytes are read as ordinary data and could, by chance,
 * contain the drawer pulse (tasks/settings-tax-payments-receipt RESEARCH.md) —
 * so the one unconfirmed print happens on the printer page, in front of the
 * owner, never on a customer's receipt. A new logo has a new fingerprint and
 * needs a new confirmation; bindDevice / forgetDevice clear this key with the
 * rest of the store, so a re-registered till asks again; and
 * withdrawReceiptLogoConfirmation, below, takes it back after a failed test
 * print and whenever a pairing is saved or forgotten.
 */
const LOGO_CONFIRMED_KEY = 'receiptLogoConfirmed';

/** The confirmed logo's fingerprint — a 64-hex string — or null when unset or garbled. */
export async function readConfirmedLogoSha(): Promise<string | null> {
	const value = await readCachedSetting(LOGO_CONFIRMED_KEY);

	return typeof value === 'string' && SHA256_HEX.test(value) ? value : null;
}

/**
 * Record that the owner saw the logo with this fingerprint print correctly.
 * Refuses anything but a 64-hex string with a TypeError — synchronously, before
 * any write — so a garbled value can never be stored as a confirmation.
 */
export function confirmReceiptLogo(sha256: string): Promise<void> {
	if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
		throw new TypeError("confirmReceiptLogo takes the logo's 64-hex sha256");
	}

	return cacheSettings([{ key: LOGO_CONFIRMED_KEY, value: sha256 }]);
}

/**
 * Withdraw the confirmation: receipts print without the logo until the owner
 * confirms a test print again. A confirmation vouches for the printer it was
 * watched on, and the gate cannot tell one printer from another, so it is taken
 * back whenever that printer may no longer be the one in use (Risk 6;
 * invariant 9 — a printer without `GS v 0` could read the raster as a drawer
 * pulse):
 * - WITH a fingerprint ("It did not print correctly" on /pos/printer), only a
 *   confirmation of THAT logo is deleted — the answer is about the logo the
 *   test page carried — and any other value is left as it is;
 * - WITHOUT one (a pairing saved or forgotten, print-client.ts), whatever is
 *   confirmed is deleted.
 * The cached logo stays, so test pages still carry it. One readwrite
 * transaction reads, compares and deletes (bindDevice's shape), so the value
 * compared is the value deleted.
 */
export function withdrawReceiptLogoConfirmation(sha256?: string): Promise<void> {
	return withDb((db) =>
		inTransaction(db, ['settings'], 'readwrite', (tx) => {
			const store = tx.objectStore('settings');

			if (sha256 === undefined) {
				store.delete(LOGO_CONFIRMED_KEY);
				return;
			}

			const current = store.get(LOGO_CONFIRMED_KEY);

			current.onsuccess = () => {
				const stored = (current.result as { value?: unknown } | undefined)?.value;

				if (stored === sha256) store.delete(LOGO_CONFIRMED_KEY);
			};
		})
	);
}
