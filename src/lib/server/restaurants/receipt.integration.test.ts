import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { auditLog } from '../db/schema/audit';
import { receiptLines, receiptLogos } from '../db/schema/receipt';
import { getMenuVersion } from '../menu';
import { DEFAULT_RECEIPT_LAYOUT } from '../../receipt-layout';
import {
	getReceiptLayout,
	getRestaurantWithSettings,
	onRestaurantCreated,
	readReceiptLogo,
	removeReceiptLogo,
	replaceReceiptLines,
	setReceiptLogo,
	updateSettings,
	type SettingsChanges
} from './index';

// The receipt layout (tasks/settings-tax-payments-receipt T-12): the nine display
// switches and the payment-numbers heading through updateSettings, the header and
// footer lines, and the logo writer. Every change audits in its own transaction
// (invariant 10); a no-op writes nothing; none of it touches the menu version.

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/** Every restaurant the running case made, with its menu version once it existed. */
const made: Array<{ restaurantId: string; version: number }> = [];

// NO VERSION BUMP — "getMenuVersion is unchanged after every call above", checked
// after EVERY case for EVERY restaurant the case made (restaurant B included):
// the layout reaches the till in the settings bundle, not the menu snapshot.
// menu_version only ever increases, so an unchanged version at the end of a case
// means no call in it bumped. It runs before the setup file's next reset.
afterEach(async () => {
	for (const r of made.splice(0)) {
		expect(await getMenuVersion(db, r.restaurantId), 'menu version').toBe(r.version);
	}
});

async function makeRestaurant(name = 'Cafe One') {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, { restaurantName: name, timeZone: 'Africa/Mogadishu' })
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email: `owner-${restaurant.id}@cafe.com`,
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const r = {
		restaurantId: restaurant.id,
		ctx: { actorUserId: owner.id, ip: null, userAgent: null },
		version: await getMenuVersion(db, restaurant.id)
	};
	made.push(r);
	return r;
}

type R = Awaited<ReturnType<typeof makeRestaurant>>;

const auditRows = (event: string) =>
	db.select().from(auditLog).where(eq(auditLog.event, event)).orderBy(asc(auditLog.id));
const allAuditRows = () => db.select().from(auditLog);

const save = (r: R, changes: SettingsChanges) =>
	db.transaction((tx) => updateSettings(tx, r.restaurantId, changes, r.ctx));
const replace = (r: R, section: 'header' | 'footer', lines: string[]) =>
	db.transaction((tx) => replaceReceiptLines(tx, r.restaurantId, section, lines, r.ctx));
const setLogo = (r: R, logo: Parameters<typeof setReceiptLogo>[2]) =>
	db.transaction((tx) => setReceiptLogo(tx, r.restaurantId, logo, r.ctx));
const removeLogo = (r: R) => db.transaction((tx) => removeReceiptLogo(tx, r.restaurantId, r.ctx));

const lineRows = (restaurantId: string, section: 'header' | 'footer') =>
	db
		.select({ position: receiptLines.position, body: receiptLines.body })
		.from(receiptLines)
		.where(and(eq(receiptLines.restaurantId, restaurantId), eq(receiptLines.section, section)))
		.orderBy(asc(receiptLines.position));
const logoRows = (restaurantId: string) =>
	db.select().from(receiptLogos).where(eq(receiptLogos.restaurantId, restaurantId));

const FOUR_BYTES = new Uint8Array([0xff, 0x00, 0x81, 0x7e]);

describe('a new restaurant', () => {
	it("starts with today's receipt: every switch on, no lines, no heading, no logo", async () => {
		const r = await makeRestaurant();
		expect(await getReceiptLayout(db, r.restaurantId)).toEqual(DEFAULT_RECEIPT_LAYOUT);
		const settings = (await getRestaurantWithSettings(db, r.restaurantId))!;
		expect(settings.receiptShow).toEqual(DEFAULT_RECEIPT_LAYOUT.show);
		expect(settings.receiptPaymentNumbersHeading).toBeNull();
		// ONE nested object, never the nine flat columns.
		expect(settings).not.toHaveProperty('receiptShowCashier');
		expect(settings).not.toHaveProperty('receiptTaxBreakdown');
	});

	it('getReceiptLayout throws for a restaurant with no settings row', async () => {
		const [row] = await db.insert(restaurants).values({ name: 'No Settings' }).returning();
		await expect(getReceiptLayout(db, row.id)).rejects.toThrow(
			`No settings row for restaurant ${row.id}`
		);
	});
});

describe('the receipt switches (updateSettings)', () => {
	it('changes only the submitted switches, with ONE settings.updated row; the same save again is a no-op', async () => {
		const r = await makeRestaurant();

		const result = await save(r, { receiptShow: { cashier: false, taxBreakdown: false } });
		expect(result).toEqual({
			ok: true,
			changed: true,
			changes: {
				'receiptShow.cashier': { old: true, new: false },
				'receiptShow.taxBreakdown': { old: true, new: false }
			}
		});

		const after = (await getRestaurantWithSettings(db, r.restaurantId))!;
		expect(after.receiptShow).toEqual({
			...DEFAULT_RECEIPT_LAYOUT.show,
			cashier: false,
			taxBreakdown: false
		});
		expect(after.timeZone).toBe('Africa/Mogadishu');
		expect((await getReceiptLayout(db, r.restaurantId)).show).toEqual(after.receiptShow);

		const rows = await auditRows('settings.updated');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({
			changes: {
				'receiptShow.cashier': { old: true, new: false },
				'receiptShow.taxBreakdown': { old: true, new: false }
			}
		});

		expect(await save(r, { receiptShow: { cashier: false, taxBreakdown: false } })).toEqual({
			ok: true,
			changed: false
		});
		expect(await auditRows('settings.updated')).toHaveLength(1);
	});

	it.each([
		['a non-boolean value', { receiptShow: { cashier: 'no' } as never }],
		['a key outside RECEIPT_SHOW_KEYS', { receiptShow: { logo: true } as never }],
		['an array', { receiptShow: [true] as never }],
		['null', { receiptShow: null as never }]
	])('refuses %s with invalid_receipt_field and writes nothing', async (_label, changes) => {
		const r = await makeRestaurant();
		expect(await save(r, changes)).toEqual({ ok: false, reason: 'invalid_receipt_field' });
		expect((await getRestaurantWithSettings(db, r.restaurantId))!.receiptShow).toEqual(
			DEFAULT_RECEIPT_LAYOUT.show
		);
		expect(await allAuditRows()).toHaveLength(0);
	});

	it('refuses the whole save when one switch is bad, even beside a good one', async () => {
		const r = await makeRestaurant();
		expect(
			await save(r, { name: 'Renamed', receiptShow: { table: false, cashier: 'no' } as never })
		).toEqual({ ok: false, reason: 'invalid_receipt_field' });
		const after = (await getRestaurantWithSettings(db, r.restaurantId))!;
		expect(after.name).toBe('Cafe One');
		expect(after.receiptShow.table).toBe(true);
		expect(await allAuditRows()).toHaveLength(0);
	});
});

describe('the payment-numbers heading (updateSettings)', () => {
	it("is stored trimmed, and '' clears it to null", async () => {
		const r = await makeRestaurant();

		const set = await save(r, { receiptPaymentNumbersHeading: '  PAY BY MOBILE MONEY  ' });
		expect(set).toEqual({
			ok: true,
			changed: true,
			changes: { receiptPaymentNumbersHeading: { old: null, new: 'PAY BY MOBILE MONEY' } }
		});
		expect(
			(await getRestaurantWithSettings(db, r.restaurantId))!.receiptPaymentNumbersHeading
		).toBe('PAY BY MOBILE MONEY');
		expect((await getReceiptLayout(db, r.restaurantId)).paymentNumbersHeading).toBe(
			'PAY BY MOBILE MONEY'
		);

		const cleared = await save(r, { receiptPaymentNumbersHeading: '' });
		expect(cleared).toEqual({
			ok: true,
			changed: true,
			changes: { receiptPaymentNumbersHeading: { old: 'PAY BY MOBILE MONEY', new: null } }
		});
		expect(
			(await getRestaurantWithSettings(db, r.restaurantId))!.receiptPaymentNumbersHeading
		).toBeNull();
		expect(await auditRows('settings.updated')).toHaveLength(2);
	});

	it.each([
		['41 characters', 'x'.repeat(41)],
		['a tab', 'A\tB']
	])('refuses %s with invalid_receipt_field and writes nothing', async (_label, heading) => {
		const r = await makeRestaurant();
		expect(await save(r, { receiptPaymentNumbersHeading: heading })).toEqual({
			ok: false,
			reason: 'invalid_receipt_field'
		});
		expect(
			(await getRestaurantWithSettings(db, r.restaurantId))!.receiptPaymentNumbersHeading
		).toBeNull();
		expect(await allAuditRows()).toHaveLength(0);
	});

	it('accepts exactly 40 characters', async () => {
		const r = await makeRestaurant();
		expect((await save(r, { receiptPaymentNumbersHeading: 'x'.repeat(40) })).ok).toBe(true);
		expect(
			(await getRestaurantWithSettings(db, r.restaurantId))!.receiptPaymentNumbersHeading
		).toBe('x'.repeat(40));
	});
});

describe('replaceReceiptLines', () => {
	it('trims, drops blank lines, keeps the order at positions 1..n, and audits once', async () => {
		const r = await makeRestaurant();

		const result = await replace(r, 'header', ['Open daily 7-23', '  ', ' Free wifi ']);
		expect(result).toEqual({ ok: true, changed: true });

		expect((await getReceiptLayout(db, r.restaurantId)).headerLines).toEqual([
			'Open daily 7-23',
			'Free wifi'
		]);
		expect(await lineRows(r.restaurantId, 'header')).toEqual([
			{ position: 1, body: 'Open daily 7-23' },
			{ position: 2, body: 'Free wifi' }
		]);

		const rows = await auditRows('receipt.lines_updated');
		expect(rows).toHaveLength(1);
		expect(rows[0].restaurantId).toBe(r.restaurantId);
		expect(rows[0].actorUserId).toBe(r.ctx.actorUserId);
		expect(rows[0].details).toEqual({
			section: 'header',
			old: [],
			new: ['Open daily 7-23', 'Free wifi']
		});

		// The same lines again — before trimming, too — change nothing.
		expect(await replace(r, 'header', ['Open daily 7-23', 'Free wifi'])).toEqual({
			ok: true,
			changed: false
		});
		expect(await replace(r, 'header', ['  Open daily 7-23', '', 'Free wifi  '])).toEqual({
			ok: true,
			changed: false
		});
		expect(await auditRows('receipt.lines_updated')).toHaveLength(1);

		// The footer is untouched.
		expect(await lineRows(r.restaurantId, 'footer')).toEqual([]);
		expect((await getReceiptLayout(db, r.restaurantId)).footerLines).toEqual([]);
	});

	it('replaces a section as a set, recording the old and new lines', async () => {
		const r = await makeRestaurant();
		await replace(r, 'footer', ['Thank you', 'Come again']);
		expect(await replace(r, 'footer', ['Mahadsanid!'])).toEqual({ ok: true, changed: true });

		expect(await lineRows(r.restaurantId, 'footer')).toEqual([
			{ position: 1, body: 'Mahadsanid!' }
		]);
		const rows = await auditRows('receipt.lines_updated');
		expect(rows.map((row) => row.details)).toEqual([
			{ section: 'footer', old: [], new: ['Thank you', 'Come again'] },
			{ section: 'footer', old: ['Thank you', 'Come again'], new: ['Mahadsanid!'] }
		]);
	});

	it('[] deletes the section', async () => {
		const r = await makeRestaurant();
		await replace(r, 'footer', ['Thank you']);
		expect(await replace(r, 'footer', [])).toEqual({ ok: true, changed: true });
		expect(await lineRows(r.restaurantId, 'footer')).toEqual([]);
		expect((await auditRows('receipt.lines_updated')).at(-1)!.details).toEqual({
			section: 'footer',
			old: ['Thank you'],
			new: []
		});
	});

	it('accepts five lines of 120 characters', async () => {
		const r = await makeRestaurant();
		const lines = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(120));
		expect(await replace(r, 'header', lines)).toEqual({ ok: true, changed: true });
		expect((await getReceiptLayout(db, r.restaurantId)).headerLines).toEqual(lines);
	});

	it.each([
		['six non-blank lines', ['1', '2', '3', '4', '5', '6'], 'too_many_lines'],
		['121 characters', ['x'.repeat(121)], 'invalid_line'],
		['an ESC', ['a\u001bb'], 'invalid_line']
	] as const)('refuses %s and writes nothing', async (_label, lines, reason) => {
		const r = await makeRestaurant();
		await replace(r, 'header', ['Kept']);
		expect(await replace(r, 'header', [...lines])).toEqual({ ok: false, reason });
		expect(await lineRows(r.restaurantId, 'header')).toEqual([{ position: 1, body: 'Kept' }]);
		expect(await auditRows('receipt.lines_updated')).toHaveLength(1);
	});

	it('six lines of which one is blank are five', async () => {
		const r = await makeRestaurant();
		expect(await replace(r, 'header', ['1', '2', ' ', '3', '4', '5'])).toEqual({
			ok: true,
			changed: true
		});
	});

	it('throws a TypeError for a section that is neither header nor footer', async () => {
		const r = await makeRestaurant();
		await expect(replace(r, 'body' as never, ['x'])).rejects.toThrow(TypeError);
		expect(await allAuditRows()).toHaveLength(0);
	});
});

describe('the logo', () => {
	it('stores a 16 x 2 logo, serves the same bytes, and lists only its fingerprint and shape', async () => {
		const r = await makeRestaurant();

		const result = await setLogo(r, { widthDots: 16, heightDots: 2, bitmap: FOUR_BYTES });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

		const read = await readReceiptLogo(db, r.restaurantId);
		expect(read).toEqual({
			sha256: result.sha256,
			widthDots: 16,
			heightDots: 2,
			bitmap: FOUR_BYTES
		});
		expect(Array.from(read!.bitmap)).toEqual(Array.from(FOUR_BYTES));

		expect((await getReceiptLayout(db, r.restaurantId)).logo).toEqual({
			sha256: result.sha256,
			widthDots: 16,
			heightDots: 2
		});

		const rows = await auditRows('receipt.logo_updated');
		expect(rows).toHaveLength(1);
		// The fingerprint is the logo's only trace in the log — never its bytes.
		expect(rows[0].details).toEqual({ sha256: result.sha256, widthDots: 16, heightDots: 2 });
	});

	it('the same logo again returns the same fingerprint with no second audit row', async () => {
		const r = await makeRestaurant();
		const first = await setLogo(r, { widthDots: 16, heightDots: 2, bitmap: FOUR_BYTES });
		const again = await setLogo(r, {
			widthDots: 16,
			heightDots: 2,
			bitmap: new Uint8Array(FOUR_BYTES)
		});
		expect(again).toEqual(first);
		expect(await auditRows('receipt.logo_updated')).toHaveLength(1);
	});

	it('the same bytes at another shape get another fingerprint, and replace the logo', async () => {
		const r = await makeRestaurant();
		const wide = await setLogo(r, { widthDots: 16, heightDots: 2, bitmap: FOUR_BYTES });
		const long = await setLogo(r, { widthDots: 32, heightDots: 1, bitmap: FOUR_BYTES });
		expect(wide.ok && long.ok).toBe(true);
		if (!wide.ok || !long.ok) return;
		expect(long.sha256).not.toBe(wide.sha256);

		const rows = await logoRows(r.restaurantId);
		expect(rows).toHaveLength(1);
		expect([rows[0].widthDots, rows[0].heightDots, rows[0].sha256]).toEqual([32, 1, long.sha256]);
		expect(await auditRows('receipt.logo_updated')).toHaveLength(2);
	});

	it.each([
		[
			'a width that is not a multiple of 8',
			{ widthDots: 12, heightDots: 1, bitmap: new Uint8Array(2) }
		],
		['161 rows', { widthDots: 8, heightDots: 161, bitmap: new Uint8Array(161) }],
		['a bitmap one byte short', { widthDots: 16, heightDots: 2, bitmap: new Uint8Array(3) }]
	])('refuses %s with invalid_logo and writes nothing', async (_label, logo) => {
		const r = await makeRestaurant();
		expect(await setLogo(r, logo)).toEqual({ ok: false, reason: 'invalid_logo' });
		expect(await logoRows(r.restaurantId)).toHaveLength(0);
		expect(await allAuditRows()).toHaveLength(0);
	});

	it('removing it audits once; removing again changes nothing', async () => {
		const r = await makeRestaurant();
		const set = await setLogo(r, { widthDots: 16, heightDots: 2, bitmap: FOUR_BYTES });
		if (!set.ok) throw new Error('fixture logo was not stored');

		expect(await removeLogo(r)).toEqual({ ok: true, changed: true });
		expect(await logoRows(r.restaurantId)).toHaveLength(0);
		expect(await readReceiptLogo(db, r.restaurantId)).toBeNull();
		expect((await getReceiptLayout(db, r.restaurantId)).logo).toBeNull();
		const rows = await auditRows('receipt.logo_removed');
		expect(rows).toHaveLength(1);
		expect(rows[0].details).toEqual({ sha256: set.sha256 });

		expect(await removeLogo(r)).toEqual({ ok: true, changed: false });
		expect(await auditRows('receipt.logo_removed')).toHaveLength(1);
	});
});

describe('tenants', () => {
	it("restaurant B's layout is untouched by A's writes", async () => {
		const a = await makeRestaurant('Cafe A');
		const b = await makeRestaurant('Cafe B');
		await replace(b, 'footer', ['B footer']);

		await save(a, {
			receiptShow: { cashier: false, deviceLine: false },
			receiptPaymentNumbersHeading: 'PAY HERE'
		});
		await replace(a, 'header', ['A header']);
		await replace(a, 'footer', ['A footer']);
		await setLogo(a, { widthDots: 16, heightDots: 2, bitmap: FOUR_BYTES });

		expect(await getReceiptLayout(db, b.restaurantId)).toEqual({
			...DEFAULT_RECEIPT_LAYOUT,
			footerLines: ['B footer']
		});
		const bSettings = (await getRestaurantWithSettings(db, b.restaurantId))!;
		expect(bSettings.receiptShow).toEqual(DEFAULT_RECEIPT_LAYOUT.show);
		expect(bSettings.receiptPaymentNumbersHeading).toBeNull();
		expect(await readReceiptLogo(db, b.restaurantId)).toBeNull();

		// And A's own layout carries every write.
		const aLayout = await getReceiptLayout(db, a.restaurantId);
		expect(aLayout.headerLines).toEqual(['A header']);
		expect(aLayout.footerLines).toEqual(['A footer']);
		expect(aLayout.show.cashier).toBe(false);
		expect(aLayout.paymentNumbersHeading).toBe('PAY HERE');
		expect(aLayout.logo?.widthDots).toBe(16);

		// B has no logo to remove, and removing it does not reach A's.
		expect(await removeLogo(b)).toEqual({ ok: true, changed: false });
		expect(await readReceiptLogo(db, a.restaurantId)).not.toBeNull();
	});
});
