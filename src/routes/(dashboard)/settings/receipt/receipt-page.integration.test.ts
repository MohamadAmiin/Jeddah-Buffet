// THE RECEIPT SETTINGS PAGE (tasks/settings-tax-payments-receipt T-31): the
// header text, the lines, the nine switches, the heading and the logo, saved
// in one transaction each and audited there (invariant 10); the layout is
// configuration, not a posted record (invariant 2); a forged logo never
// reaches the table (risk 6); the page does no money arithmetic (invariants
// 1, 7); another restaurant is never reachable (invariant 8).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import type { RequestEvent, ServerLoadEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { restaurantSettings } from '$lib/server/db/schema/restaurant-settings';
import { receiptLines, receiptLogos } from '$lib/server/db/schema/receipt';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { seedStaff } from '$lib/server/db/test/seed';
import { seedPaymentMethod, seedTaxRate } from '$lib/server/db/test/settings';
import type { Principal } from '$lib/server/auth/session';
import { onRestaurantCreated, updateSettings } from '$lib/server/restaurants';
import { encodeBitmap } from '$lib/receipt-logo';
import { RECEIPT_SHOW_KEYS, type ReceiptLayout, type ReceiptShow } from '$lib/receipt-layout';
import type { SaleSnapshot } from '$lib/pos/store';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

const TOO_MANY_LINES_MESSAGE = 'At most 5 lines in each of the header and the footer.';
const INVALID_LINE_MESSAGE = 'Each line is up to 120 characters of plain text.';
const INVALID_FIELD_MESSAGE =
	'Receipt text must be plain text: address and lines up to 120 characters, phone, tax number and heading up to 40.';
const LOGO_MESSAGE =
	'That logo is not a black-and-white image of at most 384 × 160 dots. Choose the file again.';

/** A 16 × 2 logo: two rows of two bytes each. */
const LOGO_A = Uint8Array.of(0xff, 0x00, 0xff, 0x00);
const LOGO_B = Uint8Array.of(0x00, 0xff, 0x00, 0xff);

/** T-12's fingerprint: the shape AND the bytes, never the bytes alone. */
function fingerprint(widthDots: number, heightDots: number, bytes: Uint8Array): string {
	return createHash('sha256').update(`${widthDots}x${heightDots}\n`).update(bytes).digest('hex');
}

async function makeRestaurant(name = 'Cafe One'): Promise<string> {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();

	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: name,
			timeZone: 'Africa/Mogadishu'
		})
	);

	return restaurant.id;
}

async function makeOwner(restaurantId: string, email = 'owner@cafe.com'): Promise<string> {
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId,
			role: 'owner',
			displayName: 'The Owner',
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: users.id });

	return owner.id;
}

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Cashier',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

function makeEvent(user: Principal, formEntries: Array<[string, string]> = []): RequestEvent {
	const url = new URL('http://localhost/settings/receipt');
	const body = new FormData();

	for (const [key, value] of formEntries) {
		body.append(key, value);
	}

	return {
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {}
		},
		getClientAddress: () => '203.0.113.5',
		locals: {
			user,
			restaurantId: user.restaurantId,
			sessionToken: null,
			posDevice: null
		},
		params: {},
		request: new Request(url, {
			method: 'POST',
			body
		}),
		route: { id: '/(dashboard)/settings/receipt' },
		url
	} as unknown as RequestEvent;
}

function loadEvent(user: Principal): ServerLoadEvent {
	return {
		...makeEvent(user),
		parent: async () => ({}),
		depends: () => {},
		untrack: <T>(fn: () => T) => fn()
	} as unknown as ServerLoadEvent;
}

type ActionName = keyof typeof actions;

function action(name: ActionName, event: RequestEvent) {
	const handler = actions[name];

	if (!handler) {
		throw new Error(`Missing action: ${name}`);
	}

	return handler(event as Parameters<typeof handler>[0]);
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return (error as { status?: number }).status;
	}
}

function messageOf(result: unknown): string | undefined {
	return (result as { data?: { message?: string } }).data?.message;
}

function statusCodeOf(result: unknown): number | undefined {
	return (result as { status?: number }).status;
}

type LoadData = {
	restaurantName: string;
	timeZone: string;
	address: string;
	phone: string;
	taxRegistrationNumber: string;
	layout: ReceiptLayout;
	logo: { widthDots: number; heightDots: number; bitmap: string } | null;
	paymentNumbers: Array<{ name: string; number: string }>;
	sample: SaleSnapshot | null;
	previewBlocked: string | null;
};

async function loadData(user: Principal): Promise<LoadData> {
	return (await load(loadEvent(user))) as LoadData;
}

/** The `show` entries for every switch except the ones named. */
function showAllBut(...hidden: Array<keyof ReceiptShow>): Array<[string, string]> {
	return RECEIPT_SHOW_KEYS.filter((key) => !hidden.includes(key)).map((key) => ['show', key]);
}

/** A complete save form: the three header fields, the heading, lines and switches. */
function saveForm(over: {
	address?: string;
	phone?: string;
	taxNumber?: string;
	heading?: string;
	headerLines?: string[];
	footerLines?: string[];
	hidden?: Array<keyof ReceiptShow>;
}): Array<[string, string]> {
	return [
		['receiptAddress', over.address ?? ''],
		['receiptPhone', over.phone ?? ''],
		['taxRegistrationNumber', over.taxNumber ?? ''],
		['paymentNumbersHeading', over.heading ?? ''],
		...(over.headerLines ?? []).map((line): [string, string] => ['headerLines', line]),
		...(over.footerLines ?? []).map((line): [string, string] => ['footerLines', line]),
		...showAllBut(...(over.hidden ?? []))
	];
}

function logoForm(widthDots: number, heightDots: number, bitmap: string): Array<[string, string]> {
	return [
		['widthDots', String(widthDots)],
		['heightDots', String(heightDots)],
		['bitmap', bitmap]
	];
}

async function settingsRow(restaurantId: string) {
	const [row] = await db
		.select({
			receiptAddress: restaurantSettings.receiptAddress,
			receiptPhone: restaurantSettings.receiptPhone,
			taxRegistrationNumber: restaurantSettings.taxRegistrationNumber,
			receiptPaymentNumbersHeading: restaurantSettings.receiptPaymentNumbersHeading,
			menuVersion: restaurantSettings.menuVersion,
			receiptShowCashier: restaurantSettings.receiptShowCashier,
			receiptShowTable: restaurantSettings.receiptShowTable,
			receiptShowBusinessDate: restaurantSettings.receiptShowBusinessDate,
			receiptShowOrderType: restaurantSettings.receiptShowOrderType,
			receiptShowUnitPrice: restaurantSettings.receiptShowUnitPrice,
			receiptShowCurrencyLine: restaurantSettings.receiptShowCurrencyLine,
			receiptShowDeviceLine: restaurantSettings.receiptShowDeviceLine,
			receiptShowPaymentNumbers: restaurantSettings.receiptShowPaymentNumbers,
			receiptTaxBreakdown: restaurantSettings.receiptTaxBreakdown
		})
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId));
	return row;
}

/** Every stored line of the restaurant, header first, in position order. */
async function lineRows(restaurantId: string) {
	return db
		.select({
			section: receiptLines.section,
			position: receiptLines.position,
			body: receiptLines.body
		})
		.from(receiptLines)
		.where(eq(receiptLines.restaurantId, restaurantId))
		.orderBy(asc(receiptLines.section), asc(receiptLines.position));
}

async function logoRows(restaurantId: string) {
	return db
		.select({
			widthDots: receiptLogos.widthDots,
			heightDots: receiptLogos.heightDots,
			byteSize: receiptLogos.byteSize,
			bitmap: receiptLogos.bitmap,
			sha256: receiptLogos.sha256
		})
		.from(receiptLogos)
		.where(eq(receiptLogos.restaurantId, restaurantId));
}

async function eventRows(restaurantId: string, event: string) {
	return db
		.select({ id: auditLog.id, details: auditLog.details })
		.from(auditLog)
		.where(and(eq(auditLog.event, event), eq(auditLog.restaurantId, restaurantId)));
}

async function eventCount(restaurantId: string, event: string): Promise<number> {
	return (await eventRows(restaurantId, event)).length;
}

async function auditCount(restaurantId: string): Promise<number> {
	const rows = await db
		.select({ id: auditLog.id })
		.from(auditLog)
		.where(eq(auditLog.restaurantId, restaurantId));

	return rows.length;
}

async function owned(name = 'Cafe One', email = 'owner@cafe.com') {
	const restaurantId = await makeRestaurant(name);
	const ownerId = await makeOwner(restaurantId, email);
	return { restaurantId, ownerId, owner: principal(ownerId, restaurantId, 'owner') };
}

const NO_ACTOR = { actorUserId: null, ip: null, userAgent: null };

/** The nine switches as the row stores them: every one true but those named. */
function switches(hidden: Array<keyof ReceiptShow> = []) {
	return {
		receiptShowCashier: !hidden.includes('cashier'),
		receiptShowTable: !hidden.includes('table'),
		receiptShowBusinessDate: !hidden.includes('businessDate'),
		receiptShowOrderType: !hidden.includes('orderType'),
		receiptShowUnitPrice: !hidden.includes('unitPrice'),
		receiptShowCurrencyLine: !hidden.includes('currencyLine'),
		receiptShowDeviceLine: !hidden.includes('deviceLine'),
		receiptShowPaymentNumbers: !hidden.includes('paymentNumbers'),
		receiptTaxBreakdown: !hidden.includes('taxBreakdown')
	};
}

describe('receipt settings page', () => {
	// MANDATORY (spec 29 — a permission check per route): 403 from the load and
	// from EVERY action, each a separately reachable endpoint (invariant 8). The
	// loop over Object.keys(actions) covers a fourth action without editing this.
	it('refuses a cashier with 403 on the load and on every action', async () => {
		const restaurantId = await makeRestaurant();
		const staff = await seedStaff(db, restaurantId, { displayName: 'Cashier' });
		const cashier = principal(staff.id, restaurantId, 'staff');
		const auditBefore = await auditCount(restaurantId);

		expect(await statusOf(() => load(loadEvent(cashier)))).toBe(403);
		for (const name of Object.keys(actions) as ActionName[]) {
			expect(
				await statusOf(() =>
					action(
						name,
						makeEvent(cashier, [
							...saveForm({ address: 'Km4', headerLines: ['Open daily'] }),
							...logoForm(16, 2, encodeBitmap(LOGO_A))
						])
					)
				),
				name
			).toBe(403);
		}

		// Nothing written: no line, no logo, no settings change, no audit row.
		expect(await lineRows(restaurantId)).toEqual([]);
		expect(await logoRows(restaurantId)).toEqual([]);
		expect(await settingsRow(restaurantId)).toMatchObject({ receiptAddress: null, ...switches() });
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('saves lines, switches and the heading in one transaction', async () => {
		const { restaurantId, owner } = await owned();
		const before = await settingsRow(restaurantId);

		const entries = saveForm({
			headerLines: ['Open daily 7-23', '', '  Free wifi  '],
			footerLines: ['Mahadsanid!'],
			hidden: ['businessDate'],
			heading: 'PAY BY MOBILE MONEY'
		});
		const result = await action('save', makeEvent(owner, entries));

		expect(result).toEqual({ message: 'Receipt saved.' });
		// Trimmed, blanks dropped, renumbered 1..n — the writer's rule.
		expect(await lineRows(restaurantId)).toEqual([
			{ section: 'footer', position: 1, body: 'Mahadsanid!' },
			{ section: 'header', position: 1, body: 'Open daily 7-23' },
			{ section: 'header', position: 2, body: 'Free wifi' }
		]);
		expect(await settingsRow(restaurantId)).toMatchObject({
			receiptPaymentNumbersHeading: 'PAY BY MOBILE MONEY',
			// The layout is not in the menu snapshot: no bump.
			menuVersion: before.menuVersion,
			...switches(['businessDate'])
		});
		expect(await eventCount(restaurantId, 'settings.updated')).toBe(1);
		expect(await eventCount(restaurantId, 'receipt.lines_updated')).toBe(2);

		// The load reads it all back, and the till's view of it (getReceiptLayout).
		const data = await loadData(owner);
		expect(data.layout.headerLines).toEqual(['Open daily 7-23', 'Free wifi']);
		expect(data.layout.footerLines).toEqual(['Mahadsanid!']);
		expect(data.layout.show).toEqual({
			cashier: true,
			table: true,
			businessDate: false,
			orderType: true,
			unitPrice: true,
			currencyLine: true,
			deviceLine: true,
			paymentNumbers: true,
			taxBreakdown: true
		});
		expect(data.layout.paymentNumbersHeading).toBe('PAY BY MOBILE MONEY');

		// An identical second save: nothing changed, nothing audited.
		const auditBefore = await auditCount(restaurantId);
		const again = await action('save', makeEvent(owner, entries));
		expect(again).toEqual({ message: 'No changes to save.' });
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('saves the header text, and clears a field posted blank', async () => {
		const { restaurantId, owner } = await owned();

		const saved = await action(
			'save',
			makeEvent(
				owner,
				saveForm({
					address: 'Makka Al-Mukarama Rd, Km4',
					phone: '61 555 0142',
					taxNumber: 'TIN 12345'
				})
			)
		);
		expect(saved).toEqual({ message: 'Receipt saved.' });
		expect(await settingsRow(restaurantId)).toMatchObject({
			receiptAddress: 'Makka Al-Mukarama Rd, Km4',
			receiptPhone: '61 555 0142',
			taxRegistrationNumber: 'TIN 12345'
		});
		expect(await loadData(owner)).toMatchObject({
			address: 'Makka Al-Mukarama Rd, Km4',
			phone: '61 555 0142',
			taxRegistrationNumber: 'TIN 12345'
		});

		const cleared = await action(
			'save',
			makeEvent(owner, saveForm({ address: 'Makka Al-Mukarama Rd, Km4', phone: '  ' }))
		);
		expect(cleared).toEqual({ message: 'Receipt saved.' });
		expect(await settingsRow(restaurantId)).toMatchObject({
			receiptAddress: 'Makka Al-Mukarama Rd, Km4',
			receiptPhone: null,
			taxRegistrationNumber: null
		});
	});

	it('rolls everything back when one part is refused', async () => {
		const { restaurantId, owner } = await owned();
		const auditBefore = await auditCount(restaurantId);

		// A new address beside six header lines: the lines are refused AFTER the
		// settings row was written, and the one transaction takes the address with it.
		const tooMany = await action(
			'save',
			makeEvent(
				owner,
				saveForm({
					address: 'New address',
					headerLines: ['One', 'Two', 'Three', 'Four', 'Five', 'Six']
				})
			)
		);
		expect(statusCodeOf(tooMany)).toBe(400);
		expect(messageOf(tooMany)).toBe(TOO_MANY_LINES_MESSAGE);
		expect(await settingsRow(restaurantId)).toMatchObject({ receiptAddress: null });
		expect(await lineRows(restaurantId)).toEqual([]);

		// A 41-character heading: the settings writer refuses, nothing else runs.
		const longHeading = await action(
			'save',
			makeEvent(owner, saveForm({ heading: 'H'.repeat(41), headerLines: ['Open daily'] }))
		);
		expect(statusCodeOf(longHeading)).toBe(400);
		expect(messageOf(longHeading)).toBe(INVALID_FIELD_MESSAGE);
		expect(await lineRows(restaurantId)).toEqual([]);
		expect(await settingsRow(restaurantId)).toMatchObject({ receiptPaymentNumbersHeading: null });

		// An ESC in a footer line could start the drawer pulse: refused.
		const control = await action(
			'save',
			makeEvent(owner, saveForm({ headerLines: ['Open daily'], footerLines: ['Bye\u001b'] }))
		);
		expect(statusCodeOf(control)).toBe(400);
		expect(messageOf(control)).toBe(INVALID_LINE_MESSAGE);
		expect(await lineRows(restaurantId)).toEqual([]);

		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('saves, replaces and removes the logo', async () => {
		const { restaurantId, owner } = await owned();
		const shaA = fingerprint(16, 2, LOGO_A);
		const shaB = fingerprint(16, 2, LOGO_B);

		const saved = await action('logo', makeEvent(owner, logoForm(16, 2, encodeBitmap(LOGO_A))));
		expect(saved).toEqual({ message: 'Logo saved.' });
		let rows = await logoRows(restaurantId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ widthDots: 16, heightDots: 2, byteSize: 4, sha256: shaA });
		expect(Array.from(rows[0].bitmap)).toEqual(Array.from(LOGO_A));
		expect(await eventCount(restaurantId, 'receipt.logo_updated')).toBe(1);

		// The load carries the bytes as base64, and the layout the fingerprint.
		const data = await loadData(owner);
		expect(data.logo).toEqual({ widthDots: 16, heightDots: 2, bitmap: encodeBitmap(LOGO_A) });
		expect(data.layout.logo).toEqual({ sha256: shaA, widthDots: 16, heightDots: 2 });

		// Replace: still ONE row, now the second bitmap's fingerprint, audited again.
		const replaced = await action('logo', makeEvent(owner, logoForm(16, 2, encodeBitmap(LOGO_B))));
		expect(replaced).toEqual({ message: 'Logo saved.' });
		rows = await logoRows(restaurantId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ widthDots: 16, heightDots: 2, sha256: shaB });
		expect(Array.from(rows[0].bitmap)).toEqual(Array.from(LOGO_B));
		const updates = await eventRows(restaurantId, 'receipt.logo_updated');
		expect(updates).toHaveLength(2);
		expect(updates.map((row) => (row.details as { sha256: string }).sha256)).toEqual(
			expect.arrayContaining([shaA, shaB])
		);

		const removed = await action('removeLogo', makeEvent(owner));
		expect(removed).toEqual({ message: 'Logo removed.' });
		expect(await logoRows(restaurantId)).toEqual([]);
		const removals = await eventRows(restaurantId, 'receipt.logo_removed');
		expect(removals).toHaveLength(1);
		expect(removals[0].details).toEqual({ sha256: shaB });
		expect((await loadData(owner)).logo).toBeNull();

		const again = await action('removeLogo', makeEvent(owner));
		expect(again).toEqual({ message: 'There was no logo.' });
		expect(await eventCount(restaurantId, 'receipt.logo_removed')).toBe(1);
	});

	it('refuses a forged logo and stores nothing', async () => {
		const { restaurantId, owner } = await owned();
		const auditBefore = await auditCount(restaurantId);

		const forged: Array<[string, Array<[string, string]>]> = [
			['five bytes for 16 x 2', logoForm(16, 2, encodeBitmap(Uint8Array.of(1, 2, 3, 4, 5)))],
			['a width of 12', logoForm(12, 2, encodeBitmap(Uint8Array.of(1, 2, 3)))],
			['a height of 161', logoForm(16, 161, encodeBitmap(new Uint8Array(2 * 161)))],
			['non-canonical base64', logoForm(16, 2, 'gP8')],
			['no bitmap at all', logoForm(16, 2, '')],
			[
				'a width that is not a number',
				[
					['widthDots', 'wide'],
					['heightDots', '2'],
					['bitmap', encodeBitmap(LOGO_A)]
				]
			]
		];
		for (const [label, entries] of forged) {
			const result = await action('logo', makeEvent(owner, entries));
			expect(statusCodeOf(result), label).toBe(400);
			expect(messageOf(result), label).toBe(LOGO_MESSAGE);
		}

		expect(await logoRows(restaurantId)).toEqual([]);
		expect(await auditCount(restaurantId)).toBe(auditBefore);
	});

	it('writes to locals.restaurantId only', async () => {
		const a = await owned('Cafe A', 'owner-a@cafe.com');
		const b = await owned('Cafe B', 'owner-b@cafe.com');
		const auditOfBBefore = await auditCount(b.restaurantId);

		// A's owner names B in the form; the form is never where the restaurant comes from.
		const saved = await action(
			'save',
			makeEvent(a.owner, [
				['restaurantId', b.restaurantId],
				...saveForm({ address: 'Km4', headerLines: ['Open daily'] })
			])
		);
		expect(saved).toEqual({ message: 'Receipt saved.' });
		const logo = await action(
			'logo',
			makeEvent(a.owner, [
				['restaurantId', b.restaurantId],
				...logoForm(16, 2, encodeBitmap(LOGO_A))
			])
		);
		expect(logo).toEqual({ message: 'Logo saved.' });

		expect(await lineRows(a.restaurantId)).toEqual([
			{ section: 'header', position: 1, body: 'Open daily' }
		]);
		expect(await logoRows(a.restaurantId)).toHaveLength(1);
		expect(await settingsRow(a.restaurantId)).toMatchObject({ receiptAddress: 'Km4' });

		expect(await lineRows(b.restaurantId)).toEqual([]);
		expect(await logoRows(b.restaurantId)).toEqual([]);
		expect(await settingsRow(b.restaurantId)).toMatchObject({ receiptAddress: null });
		expect(await auditCount(b.restaurantId)).toBe(auditOfBBefore);
	});

	it('the load lists only enabled numbers and blocks the preview until tax is set', async () => {
		const { restaurantId, ownerId, owner } = await owned();
		const ctx = { actorUserId: ownerId, ip: null, userAgent: null };
		await db.transaction(async (tx) => {
			await seedPaymentMethod(tx, restaurantId, {
				name: 'EVC Plus',
				kind: 'mobile',
				merchantNumber: '61 234 5678',
				enabled: true
			});
			await seedPaymentMethod(tx, restaurantId, {
				name: 'Zaad',
				kind: 'mobile',
				merchantNumber: '63 345 6789',
				enabled: false
			});
			await seedPaymentMethod(tx, restaurantId, { name: 'Card', kind: 'card', enabled: true });
		});

		// No currency yet: the first missing setting names its page.
		let data = await loadData(owner);
		expect(Object.keys(data).sort()).toEqual([
			'address',
			'layout',
			'logo',
			'paymentNumbers',
			'phone',
			'previewBlocked',
			'restaurantName',
			'sample',
			'taxRegistrationNumber',
			'timeZone'
		]);
		expect(data.restaurantName).toBe('Cafe One');
		expect(data.timeZone).toBe('Africa/Mogadishu');
		// Enabled and numbered only: the disabled Zaad and the numberless Card are absent.
		expect(data.paymentNumbers).toEqual([{ name: 'EVC Plus', number: '61 234 5678' }]);
		expect(data.previewBlocked).toBe('Set the currency on General to see the preview.');
		expect(data.sample).toBeNull();

		await db.transaction((tx) => updateSettings(tx, restaurantId, { currencyCode: 'USD' }, ctx));
		data = await loadData(owner);
		expect(data.previewBlocked).toBe('Choose the tax mode on Tax to see the preview.');
		expect(data.sample).toBeNull();

		await db.transaction((tx) => updateSettings(tx, restaurantId, { taxMode: 'exclusive' }, ctx));
		data = await loadData(owner);
		expect(data.previewBlocked).toBe('Choose a default tax rate on Tax to see the preview.');
		expect(data.sample).toBeNull();

		// A default rate: the sample sale exists, built from the money module.
		await db.transaction((tx) =>
			seedTaxRate(tx, restaurantId, { rateBp: 1000, makeDefault: true }, ctx)
		);
		data = await loadData(owner);
		expect(data.previewBlocked).toBeNull();
		expect(data.sample?.payload.lines).toHaveLength(2);
		expect(data.sample?.payload).toMatchObject({ currencyCode: 'USD', taxMode: 'exclusive' });
		expect(data.sample?.payload.lines.map((line) => line.taxRateName)).toEqual(['Tax', 'Tax']);
		expect(data.sample?.payload.payments[0]).toMatchObject({
			method: 'cash',
			paymentMethodName: 'Cash'
		});
		expect(data.sample?.taxBreakdown).toHaveLength(1);

		// A second live rate puts the drink on it, so the preview shows a mixed receipt.
		await db.transaction((tx) =>
			seedTaxRate(tx, restaurantId, { name: 'Exempt', rateBp: 0 }, NO_ACTOR)
		);
		data = await loadData(owner);
		expect(data.sample?.payload.lines.map((line) => line.taxRateName)).toEqual(['Tax', 'Exempt']);
		expect(data.sample?.taxBreakdown).toHaveLength(2);
	});
});

// The page prints the sample's STORED strings through the till's formatter and
// never computes a figure (invariants 1, 7): the money helpers are absent from
// the markup BY NAME, as is every number-conversion call.
describe('the receipt page does no money arithmetic', () => {
	it('+page.svelte', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		for (const banned of [
			'parseFloat',
			'.toFixed(',
			'Number(',
			'roundToMinor(',
			'computeOrderTotals(',
			'taxBreakdown('
		]) {
			expect(source.includes(banned), `+page.svelte contains ${banned}`).toBe(false);
		}
	});
});
