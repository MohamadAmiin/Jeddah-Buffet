// THE CROSS-TENANT AND PERMISSION SWEEP (tasks/settings-tax-payments-receipt
// T-34). Every page, module and route of this plan tested its own piece; this
// file asks the two questions across all of them at once.
//
// Can restaurant B touch restaurant A's tax rates, payment methods, receipt or
// logo — through any new form action, any id in a sale payload, or a device
// route? And does every load and action refuse a member of staff with 403?
//
//   - MANDATORY (spec 29 — a permission check on every route): the load and EVERY
//     action of /settings, /settings/tax, /settings/payments, /settings/receipt
//     and /menu answer 403 to a staff member, looping over Object.keys(actions)
//     so an action added later is covered too (invariant 8; spec 8: hiding a
//     button is not security). The two device routes answer the DEVICE's
//     restaurant and nothing else (invariant 12).
//   - MANDATORY (spec 29 — offline sync): a sale naming another restaurant's
//     payment method or tax rate is a HARD invalid_payload. A cash sale is stored
//     `unrecorded` with its whole payload — a fact, never discarded (spec 6,
//     invariant 5) — and a card sale fails closed with 422, storing nothing.
//     Nothing is posted for either (invariant 2).
//   - B's owner posting A's ids is refused; a forged `restaurantId` form field is
//     ignored by every action, because restaurantId comes from event.locals only.
//   - ESC (the ESC/POS command introducer) and BEL never reach a stored receipt
//     field: those fields print on paper, where a control byte is a command.
//   - Each successful action audits exactly what it changed, and every writer
//     audits INSIDE its own transaction: a rollback takes the row, the audit row
//     and the menu-version bump back together (invariant 10).
//
// An action REFUSES by returning fail(…); it does not throw. statusOf below only
// sees thrown errors — the 403 from requirePermission and requireDevice — so a
// refusal is read from the returned object's status (refusalOf).

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Actions, RequestEvent, ServerLoad } from '@sveltejs/kit';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import type { DbTx } from '$lib/server/db/client';
import type { Executor, Principal } from '$lib/server/auth/session';
import { seedStaff } from '$lib/server/db/test/seed';
import { cashMethodId, seedPaymentMethod, seedTaxRate } from '$lib/server/db/test/settings';
import {
	openSessionAt,
	pushOp,
	saleEnvelope,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { restaurantSettings } from '$lib/server/db/schema/restaurant-settings';
import { users } from '$lib/server/db/schema/users';
import { auditLog } from '$lib/server/db/schema/audit';
import { taxRates } from '$lib/server/db/schema/tax-rates';
import { paymentMethods } from '$lib/server/db/schema/payment-methods';
import { receiptLines, receiptLogos } from '$lib/server/db/schema/receipt';
import {
	menuCategories,
	menuImages,
	menuItemModifierGroups,
	menuItems,
	modifierGroups,
	modifiers
} from '$lib/server/db/schema/menu';
import { invoices, orders, payments } from '$lib/server/db/schema/orders';
import { journalEntries } from '$lib/server/db/schema/accounting';
import { posSyncOps } from '$lib/server/db/schema/pos-sync';
import { DEVICE_COOKIE, registerDevice } from '$lib/server/auth/pos-device';
import {
	archivePaymentMethod,
	createPaymentMethod,
	movePaymentMethod,
	onRestaurantCreated,
	removeReceiptLogo,
	replaceReceiptLines,
	setReceiptLogo,
	updatePaymentMethod,
	updateSettings,
	type UpdateSettingsContext
} from '$lib/server/restaurants';
import {
	archiveTaxRate,
	createCategory,
	createItem,
	createModifierGroup,
	createTaxRate,
	linkModifierGroup,
	setItemImage,
	updateTaxRate
} from '$lib/server/menu';
import { RECEIPT_SHOW_KEYS } from '$lib/receipt-layout';
import type { SaleCompletePayload } from '$lib/sync-ops';
import { load as generalLoad, actions as generalActions } from './+page.server';
import { load as taxLoad, actions as taxActions } from './tax/+page.server';
import { load as paymentsLoad, actions as paymentsActions } from './payments/+page.server';
import { load as receiptLoad, actions as receiptActions } from './receipt/+page.server';
import { load as menuLoad, actions as menuActions } from '../menu/+page.server';
import { GET as receiptLogoGet } from '../../api/pos/receipt-logo/+server';
import { GET as employeesGet } from '../../api/pos/employees/+server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

// ── Step 1: the fixture ──────────────────────────────────────────────────────

/** One restaurant of the pair, with every id the cases below post. */
type Side = {
	label: 'A' | 'B';
	restaurantId: string;
	ownerId: string;
	staffId: string;
	/** A LIVE rate ('Exempt' 0%) beside the default ('Tax' 10%): not the default
	 * and used by no item, so it may be made the default, edited or archived. */
	spareRateId: string;
	cashId: string;
	/** 'EVC Plus', kind mobile, merchant number 61 234 5678. */
	evcId: string;
	/** 'Card terminal', kind card: a second owner method, so Move down moves. */
	cardId: string;
	headerLine: string;
	logoByte: number;
	logoSha: string;
	categoryId: string;
	/** 'Tea': no category, no rate of its own (it follows the default). */
	itemId: string;
	/** 'Extras', linked to Tea; 'Sides', linked to nothing. */
	linkedGroupId: string;
	freeGroupId: string;
	deviceToken: string;
};

/**
 * Restaurant `label`, built as seedSalesRestaurant builds one: the restaurants
 * row FIRST, then onRestaurantCreated, in ONE transaction — the initializers run
 * only for a row that already exists.
 */
async function makeSide(label: 'A' | 'B', logoByte: number): Promise<Side> {
	const name = `Cafe ${label}`;
	const headerLine = `Welcome to ${name}`;
	return db.transaction(async (tx) => {
		const [r] = await tx.insert(restaurants).values({ name }).returning({ id: restaurants.id });
		await onRestaurantCreated(tx, r.id, { restaurantName: name, timeZone: 'UTC' });

		// Its own email: users_email_lower_unique is global, across restaurants.
		const [owner] = await tx
			.insert(users)
			.values({
				restaurantId: r.id,
				role: 'owner',
				displayName: `Owner ${label}`,
				email: `owner-${label.toLowerCase()}@sweep.test`,
				passwordHash: 'not-a-real-hash'
			})
			.returning({ id: users.id });
		const ctx: UpdateSettingsContext = { actorUserId: owner.id, ip: null, userAgent: null };
		const staff = await seedStaff(tx, r.id, { displayName: `Staff ${label}` });

		const settings = await updateSettings(
			tx,
			r.id,
			{ currencyCode: 'USD', taxMode: 'exclusive' },
			ctx
		);
		if (!settings.ok) throw new Error(`fixture ${label}: ${settings.reason}`);
		await seedTaxRate(tx, r.id, { rateBp: 1000, makeDefault: true }, ctx);
		const spareRateId = await seedTaxRate(tx, r.id, { name: 'Exempt', rateBp: 0 }, ctx);
		const evcId = await seedPaymentMethod(
			tx,
			r.id,
			{ name: 'EVC Plus', kind: 'mobile', merchantNumber: '61 234 5678' },
			ctx
		);
		const cardId = await seedPaymentMethod(tx, r.id, { name: 'Card terminal', kind: 'card' }, ctx);

		const header = await replaceReceiptLines(tx, r.id, 'header', [headerLine], ctx);
		if (!header.ok) throw new Error(`fixture ${label}: ${header.reason}`);
		const logo = await setReceiptLogo(
			tx,
			r.id,
			{ widthDots: 8, heightDots: 1, bitmap: Uint8Array.of(logoByte) },
			ctx
		);
		if (!logo.ok) throw new Error(`fixture ${label}: ${logo.reason}`);

		const category = await createCategory(tx, r.id, { name: 'Drinks' });
		const item = await createItem(tx, r.id, { name: 'Tea', priceMinor: 200n });
		if (!item.ok) throw new Error(`fixture ${label}: ${item.reason}`);
		const linked = await createModifierGroup(tx, r.id, { name: 'Extras' });
		const free = await createModifierGroup(tx, r.id, { name: 'Sides' });
		if (!linked.ok || !free.ok) throw new Error(`fixture ${label}: modifier group`);
		await linkModifierGroup(tx, r.id, item.id, linked.id);

		const device = await registerDevice(tx, {
			restaurantId: r.id,
			actorUserId: owner.id,
			label: 'Counter tablet'
		});

		return {
			label,
			restaurantId: r.id,
			ownerId: owner.id,
			staffId: staff.id,
			spareRateId,
			cashId: await cashMethodId(tx, r.id),
			evcId,
			cardId,
			headerLine,
			logoByte,
			logoSha: logo.sha256,
			categoryId: category.id,
			itemId: item.id,
			linkedGroupId: linked.id,
			freeGroupId: free.id,
			deviceToken: device.token
		};
	});
}

/**
 * A and B. Their logos differ by one byte: the plan's fixture gives both
 * 0xff, but the fingerprint covers only the shape and the bytes, so two equal
 * logos have equal fingerprints and "never answers A's sha256" could not fail.
 */
async function twoRestaurants(): Promise<{ a: Side; b: Side }> {
	const a = await makeSide('A', 0xff);
	const b = await makeSide('B', 0x0f);
	return { a, b };
}

// ── Step 2: the event builders ───────────────────────────────────────────────
// principal, makeEvent, statusOf and act are copied from
// src/routes/(dashboard)/menu/menu-page.integration.test.ts. makeEvent gains a
// routeId (the URL follows it) and multi-valued fields (the receipt page posts
// headerLines, footerLines and show several times each); act takes the page as
// well as the action, since five pages are under test. locals.restaurantId is
// the PRINCIPAL's — never a form field, which is what the forged-field case
// proves the actions honour.

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Staff',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

type FormValue = string | File | string[];
type Form = Record<string, FormValue>;

function makeEvent(routeId: string, user: Principal, form?: Form): RequestEvent {
	const url = new URL(`http://localhost${routeId.replace(/\/\([^)]*\)/g, '')}`);
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) {
		for (const entry of Array.isArray(value) ? value : [value]) body!.append(key, entry);
	}
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: routeId },
		url
	} as unknown as RequestEvent;
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

type Page = { routeId: string; load: ServerLoad; actions: Actions };

const PAGES = {
	settings: { routeId: '/(dashboard)/settings', load: generalLoad, actions: generalActions },
	tax: { routeId: '/(dashboard)/settings/tax', load: taxLoad, actions: taxActions },
	payments: {
		routeId: '/(dashboard)/settings/payments',
		load: paymentsLoad,
		actions: paymentsActions
	},
	receipt: { routeId: '/(dashboard)/settings/receipt', load: receiptLoad, actions: receiptActions },
	menu: { routeId: '/(dashboard)/menu', load: menuLoad, actions: menuActions }
} satisfies Record<string, Page>;

type PageKey = keyof typeof PAGES;
const PAGE_KEYS = Object.keys(PAGES) as PageKey[];

function act(key: PageKey, name: string, user: Principal, form: Form): Promise<unknown> {
	const page: Page = PAGES[key];
	const handler = page.actions[name];
	if (!handler) throw new Error(`${page.routeId} has no action "${name}"`);
	const event = makeEvent(page.routeId, user, form);
	return Promise.resolve(handler(event as Parameters<typeof handler>[0]));
}

/** An action's refusal — fail(…) RETURNS an ActionFailure — or null for a success. */
function refusalOf(result: unknown): { status: number; message: unknown } | null {
	const r = result as { status?: unknown; data?: { message?: unknown } } | null | undefined;
	return typeof r?.status === 'number' ? { status: r.status, message: r.data?.message } : null;
}

const asOwner = (s: Side) => principal(s.ownerId, s.restaurantId, 'owner');
const asStaff = (s: Side) => principal(s.staffId, s.restaurantId, 'staff');

// ── What the cases post ──────────────────────────────────────────────────────

/** A 1×1 PNG, 68 bytes (the /menu page test's photo). */
const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngFile = () =>
	new File([Buffer.from(PNG_BASE64, 'base64')], 'photo.png', { type: 'image/png' });

type ReceiptFields = {
	receiptAddress: string;
	receiptPhone: string;
	taxRegistrationNumber: string;
	paymentNumbersHeading: string;
	show: string[];
	headerLines: string[];
	footerLines: string[];
};

/**
 * The receipt page's WHOLE form as it stands in the fixture — the page posts
 * every field on every save, and an absent switch reads as OFF — with
 * `changes` applied.
 */
function receiptForm(s: Side, changes: Partial<ReceiptFields> = {}): Form {
	const fields: ReceiptFields = {
		receiptAddress: '',
		receiptPhone: '',
		taxRegistrationNumber: '',
		paymentNumbersHeading: '',
		show: [...RECEIPT_SHOW_KEYS],
		headerLines: [s.headerLine],
		footerLines: [],
		...changes
	};
	return fields;
}

type ActionCase = { form: (s: Side) => Form; before?: (s: Side) => Promise<void> };

/**
 * One SUCCESSFUL form per action of every page — what the owner of `s` would
 * post, each changing something. The 403 sweep posts it as staff; the forged-field
 * sweep posts it as B's owner with a forged restaurantId. A case below fails
 * when a page gains an action that has no row here.
 */
const VALID: Record<PageKey, Record<string, ActionCase>> = {
	settings: {
		default: {
			form: (s) => ({ name: `Cafe ${s.label} renamed`, timeZone: 'UTC', currencyCode: 'USD' })
		}
	},
	tax: {
		mode: { form: () => ({ taxMode: 'inclusive' }) },
		setDefault: { form: (s) => ({ taxRateId: s.spareRateId }) },
		create: { form: () => ({ name: 'Reduced', percent: '5' }) },
		update: { form: (s) => ({ taxRateId: s.spareRateId, name: 'Exempt goods', percent: '0' }) },
		archive: { form: (s) => ({ taxRateId: s.spareRateId, name: 'Exempt' }) }
	},
	payments: {
		create: {
			form: () => ({ name: 'Zaad', kind: 'mobile', merchantNumber: '63 000 0000', enabled: 'yes' })
		},
		update: {
			form: (s) => ({
				methodId: s.evcId,
				name: 'EVC Plus',
				merchantNumber: '61 999 9999',
				enabled: 'yes'
			})
		},
		move: { form: (s) => ({ methodId: s.evcId, direction: 'down' }) },
		archive: { form: (s) => ({ methodId: s.evcId, name: 'EVC Plus' }) }
	},
	receipt: {
		save: { form: (s) => receiptForm(s, { receiptAddress: '1 Market Street' }) },
		logo: {
			form: () => ({
				widthDots: '8',
				heightDots: '1',
				bitmap: Buffer.from([0x3c]).toString('base64')
			})
		},
		removeLogo: { form: () => ({}) }
	},
	menu: {
		createCategory: { form: () => ({ name: 'Hot food' }) },
		createItem: { form: () => ({ categoryId: '', name: 'Coffee', price: '1.50', taxRateId: '' }) },
		updateItem: {
			form: (s) => ({ itemId: s.itemId, name: 'Tea', price: '2.50', categoryId: '', taxRateId: '' })
		},
		archiveItem: { form: (s) => ({ itemId: s.itemId }) },
		createModifierGroup: { form: () => ({ name: 'Sauces', minSelect: '0', maxSelect: '1' }) },
		createModifier: {
			form: (s) => ({ groupId: s.linkedGroupId, name: 'Extra honey', priceDelta: '0.50' })
		},
		linkGroup: { form: (s) => ({ itemId: s.itemId, groupId: s.freeGroupId }) },
		unlinkGroup: { form: (s) => ({ itemId: s.itemId, groupId: s.linkedGroupId }) },
		renameCategory: { form: (s) => ({ categoryId: s.categoryId, name: 'Cold drinks' }) },
		archiveCategory: { form: (s) => ({ categoryId: s.categoryId }) },
		setAvailability: { form: (s) => ({ itemId: s.itemId, available: 'no' }) },
		setImage: { form: (s) => ({ itemId: s.itemId, image: pngFile() }) },
		removeImage: {
			// A photo to remove: without one the action has nothing to write.
			before: async (s) => {
				const bytes = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'));
				await db.transaction((tx) =>
					setItemImage(tx, s.restaurantId, s.itemId, { bytes, contentType: 'image/png' })
				);
			},
			form: (s) => ({ itemId: s.itemId })
		}
	}
};

// The pages' own sentences for the refusals asserted below (each a constant in
// that page's +page.server.ts). Asserting the sentence, not only the 400, proves
// the refusal came from the check under test rather than from a malformed form.
const RATE_NOT_FOUND = 'That rate no longer exists. Reload the page.';
const RATE_NOT_LIVE = 'Choose a live rate of this restaurant.';
const METHOD_NOT_FOUND = 'That payment method no longer exists. Reload the page.';
const ITEM_RATE_GONE = 'That tax rate is no longer available.';
const NAME_REFUSED = 'Enter a name of 1 to 40 characters with no control characters.';
const NUMBER_REFUSED = 'The merchant number is up to 40 characters with no control characters.';
const LINE_REFUSED = 'Each line is up to 120 characters of plain text.';
const FIELD_REFUSED =
	'Receipt text must be plain text: address and lines up to 120 characters, phone, tax number and heading up to 40.';

// ── Snapshots ────────────────────────────────────────────────────────────────

async function countOf(table: PgTable): Promise<number> {
	const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
	return row.n;
}

/** Step 3's snapshot: the row counts of the new tables and the audit log, and
 * both restaurants' settings rows in full. */
async function snapshot(a: Side, b: Side) {
	return {
		taxRates: await countOf(taxRates),
		paymentMethods: await countOf(paymentMethods),
		receiptLines: await countOf(receiptLines),
		receiptLogos: await countOf(receiptLogos),
		auditLog: await countOf(auditLog),
		settings: await db
			.select()
			.from(restaurantSettings)
			.where(inArray(restaurantSettings.restaurantId, [a.restaurantId, b.restaurantId]))
			.orderBy(asc(restaurantSettings.restaurantId))
	};
}

async function auditCountOf(restaurantId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(auditLog)
		.where(eq(auditLog.restaurantId, restaurantId));
	return row.n;
}

/** Every row of one restaurant that these pages read or write (`select *`),
 * and how many audit rows it has. */
async function rowsOf(restaurantId: string) {
	return {
		restaurant: await db.select().from(restaurants).where(eq(restaurants.id, restaurantId)),
		settings: await db
			.select()
			.from(restaurantSettings)
			.where(eq(restaurantSettings.restaurantId, restaurantId)),
		taxRates: await db
			.select()
			.from(taxRates)
			.where(eq(taxRates.restaurantId, restaurantId))
			.orderBy(asc(taxRates.id)),
		paymentMethods: await db
			.select()
			.from(paymentMethods)
			.where(eq(paymentMethods.restaurantId, restaurantId))
			.orderBy(asc(paymentMethods.id)),
		receiptLines: await db
			.select()
			.from(receiptLines)
			.where(eq(receiptLines.restaurantId, restaurantId))
			.orderBy(asc(receiptLines.section), asc(receiptLines.position)),
		receiptLogos: await db
			.select()
			.from(receiptLogos)
			.where(eq(receiptLogos.restaurantId, restaurantId)),
		menuCategories: await db
			.select()
			.from(menuCategories)
			.where(eq(menuCategories.restaurantId, restaurantId))
			.orderBy(asc(menuCategories.id)),
		menuItems: await db
			.select()
			.from(menuItems)
			.where(eq(menuItems.restaurantId, restaurantId))
			.orderBy(asc(menuItems.id)),
		menuImages: await db
			.select()
			.from(menuImages)
			.where(eq(menuImages.restaurantId, restaurantId))
			.orderBy(asc(menuImages.id)),
		modifierGroups: await db
			.select()
			.from(modifierGroups)
			.where(eq(modifierGroups.restaurantId, restaurantId))
			.orderBy(asc(modifierGroups.id)),
		modifiers: await db
			.select()
			.from(modifiers)
			.where(eq(modifiers.restaurantId, restaurantId))
			.orderBy(asc(modifiers.id)),
		links: await db
			.select()
			.from(menuItemModifierGroups)
			.where(eq(menuItemModifierGroups.restaurantId, restaurantId))
			.orderBy(asc(menuItemModifierGroups.menuItemId), asc(menuItemModifierGroups.modifierGroupId)),
		auditRows: await auditCountOf(restaurantId)
	};
}

async function lastAuditId(): Promise<bigint> {
	const [row] = await db
		.select({ id: sql<string>`coalesce(max(${auditLog.id}), 0)::text` })
		.from(auditLog);
	return BigInt(row.id);
}

/** Every audit row written after `mark`, in order, as { restaurantId, event }. */
function auditSince(mark: bigint) {
	return db
		.select({ restaurantId: auditLog.restaurantId, event: auditLog.event })
		.from(auditLog)
		.where(gt(auditLog.id, mark))
		.orderBy(asc(auditLog.id));
}

async function auditTotal(database: Executor): Promise<number> {
	const [row] = await database.select({ n: sql<number>`count(*)::int` }).from(auditLog);
	return row.n;
}

async function menuVersionOf(database: Executor, restaurantId: string): Promise<number> {
	const [row] = await database
		.select({ version: restaurantSettings.menuVersion })
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId));
	return row.version;
}

// ── Step 3: 403 everywhere ───────────────────────────────────────────────────

describe('MANDATORY (spec 29): every load and every action answers 403 to staff', () => {
	const rows = PAGE_KEYS.map((key) => ({
		key,
		path: PAGES[key].routeId.slice('/(dashboard)'.length)
	}));

	it.each(rows)('$path: the load and every action refuse B’s staff member', async ({ key }) => {
		const { a, b } = await twoRestaurants();
		const page: Page = PAGES[key];
		const staff = asStaff(b);
		const before = await snapshot(a, b);

		expect(await statusOf(() => page.load(makeEvent(page.routeId, staff) as never))).toBe(403);
		// Object.keys, never a list typed here: an action added later is covered too.
		// Each posts the very form that SUCCEEDS for the owner (the forged-field case).
		for (const name of Object.keys(page.actions)) {
			const form = VALID[key][name]?.form(b) ?? {};
			expect(await statusOf(() => act(key, name, staff, form)), `${key}.${name}`).toBe(403);
		}

		expect(await snapshot(a, b)).toEqual(before);
	});
});

// ── Step 4: cross-tenant ─────────────────────────────────────────────────────

describe('cross-tenant: B’s owner can never reach A’s rows', () => {
	const FOREIGN_IDS: Array<{
		key: PageKey;
		action: string;
		form: (a: Side, b: Side) => Form;
		message: string;
	}> = [
		{
			key: 'tax',
			action: 'setDefault',
			form: (a) => ({ taxRateId: a.spareRateId }),
			message: RATE_NOT_LIVE
		},
		{
			key: 'tax',
			action: 'update',
			form: (a) => ({ taxRateId: a.spareRateId, name: 'Stolen', percent: '1' }),
			message: RATE_NOT_FOUND
		},
		{
			key: 'tax',
			action: 'archive',
			form: (a) => ({ taxRateId: a.spareRateId, name: 'Exempt' }),
			message: RATE_NOT_FOUND
		},
		{
			key: 'payments',
			action: 'update',
			form: (a) => ({ methodId: a.evcId, name: 'Stolen', merchantNumber: '1', enabled: 'yes' }),
			message: METHOD_NOT_FOUND
		},
		{
			key: 'payments',
			action: 'move',
			form: (a) => ({ methodId: a.evcId, direction: 'down' }),
			message: METHOD_NOT_FOUND
		},
		{
			key: 'payments',
			action: 'archive',
			form: (a) => ({ methodId: a.evcId, name: 'EVC Plus' }),
			message: METHOD_NOT_FOUND
		},
		{
			key: 'menu',
			action: 'createItem',
			form: (a) => ({ categoryId: '', name: 'Coffee', price: '1.50', taxRateId: a.spareRateId }),
			message: ITEM_RATE_GONE
		},
		{
			key: 'menu',
			action: 'updateItem',
			// B's OWN item, so the only foreign thing in the form is A's rate.
			form: (a, b) => ({
				itemId: b.itemId,
				name: 'Tea',
				price: '',
				categoryId: '',
				taxRateId: a.spareRateId
			}),
			message: ITEM_RATE_GONE
		}
	];

	// ONE fixture for every attempt: a refusal writes nothing, so each attempt is
	// compared with the same untouched baseline.
	it('every action that takes an id refuses one of A’s and writes nothing', async () => {
		const { a, b } = await twoRestaurants();
		const aRows = await rowsOf(a.restaurantId);
		const aAudit = await auditCountOf(a.restaurantId);
		const bRows = await rowsOf(b.restaurantId);

		for (const { key, action, form, message } of FOREIGN_IDS) {
			const result = await act(key, action, asOwner(b), form(a, b));

			const label = `${key} ${action}`;
			expect(refusalOf(result), label).toEqual({ status: 400, message });
			expect(await rowsOf(a.restaurantId), label).toEqual(aRows);
			expect(await auditCountOf(a.restaurantId), label).toBe(aAudit);
			expect(await rowsOf(b.restaurantId), label).toEqual(bRows);
		}
	});

	it('the forged-field table below covers every action of every page', () => {
		for (const key of PAGE_KEYS) {
			expect(Object.keys(VALID[key]).sort(), key).toEqual(Object.keys(PAGES[key].actions).sort());
		}
	});

	const FORGED = PAGE_KEYS.flatMap((key) =>
		Object.keys(VALID[key]).map((action) => ({ key, action }))
	);

	it.each(FORGED)(
		'$key $action with a forged restaurantId field writes to B only',
		async ({ key, action }) => {
			const { a, b } = await twoRestaurants();
			const valid = VALID[key][action];
			await valid.before?.(b);
			const aRows = await rowsOf(a.restaurantId);
			const aAudit = await auditCountOf(a.restaurantId);
			const bRows = await rowsOf(b.restaurantId);

			const result = await act(key, action, asOwner(b), {
				...valid.form(b),
				restaurantId: a.restaurantId
			});

			expect(refusalOf(result)).toBeNull();
			// Whatever the action wrote landed in B…
			expect(await rowsOf(b.restaurantId)).not.toEqual(bRows);
			// …and A's rows and A's audit count did not move.
			expect(await rowsOf(a.restaurantId)).toEqual(aRows);
			expect(await auditCountOf(a.restaurantId)).toBe(aAudit);
		}
	);
});

// ── Step 5: control characters ───────────────────────────────────────────────

describe('a control character never reaches a stored receipt field', () => {
	// ESC is the ESC/POS command introducer (ESC p is the drawer pulse); BEL is
	// another control byte a printer may act on. Both well inside every length cap.
	const POISONS = ['EVC\u001bp', 'VAT\u0007'];
	const fiveLines = (k: number, bad: string) =>
		[1, 2, 3, 4, 5].map((i) => (i === k ? bad : `Line ${i}`));

	const FIELDS: Array<{
		field: string;
		key: PageKey;
		action: string;
		form: (a: Side, bad: string) => Form;
		message: string;
	}> = [
		{
			field: 'the rate name (create)',
			key: 'tax',
			action: 'create',
			form: (_a, bad) => ({ name: bad, percent: '5' }),
			message: NAME_REFUSED
		},
		{
			field: 'the rate name (update)',
			key: 'tax',
			action: 'update',
			form: (a, bad) => ({ taxRateId: a.spareRateId, name: bad, percent: '0' }),
			message: NAME_REFUSED
		},
		{
			field: 'the method name (create)',
			key: 'payments',
			action: 'create',
			form: (_a, bad) => ({ name: bad, kind: 'mobile', merchantNumber: '', enabled: 'yes' }),
			message: NAME_REFUSED
		},
		{
			field: 'the merchant number (create)',
			key: 'payments',
			action: 'create',
			form: (_a, bad) => ({ name: 'Zaad', kind: 'mobile', merchantNumber: bad, enabled: 'yes' }),
			message: NUMBER_REFUSED
		},
		{
			field: 'the method name (update)',
			key: 'payments',
			action: 'update',
			form: (a, bad) => ({
				methodId: a.evcId,
				name: bad,
				merchantNumber: '61 234 5678',
				enabled: 'yes'
			}),
			message: NAME_REFUSED
		},
		{
			field: 'the merchant number (update)',
			key: 'payments',
			action: 'update',
			form: (a, bad) => ({
				methodId: a.evcId,
				name: 'EVC Plus',
				merchantNumber: bad,
				enabled: 'yes'
			}),
			message: NUMBER_REFUSED
		},
		...[1, 2, 3, 4, 5].map((k) => ({
			field: `header line ${k}`,
			key: 'receipt' as const,
			action: 'save',
			form: (a: Side, bad: string) => receiptForm(a, { headerLines: fiveLines(k, bad) }),
			message: LINE_REFUSED
		})),
		...[1, 2, 3, 4, 5].map((k) => ({
			field: `footer line ${k}`,
			key: 'receipt' as const,
			action: 'save',
			form: (a: Side, bad: string) => receiptForm(a, { footerLines: fiveLines(k, bad) }),
			message: LINE_REFUSED
		})),
		{
			field: 'the payment-numbers heading',
			key: 'receipt',
			action: 'save',
			form: (a, bad) => receiptForm(a, { paymentNumbersHeading: bad }),
			message: FIELD_REFUSED
		},
		// The receipt fields that moved to /settings/receipt (T-31).
		{
			field: 'the address',
			key: 'receipt',
			action: 'save',
			form: (a, bad) => receiptForm(a, { receiptAddress: bad }),
			message: FIELD_REFUSED
		},
		{
			field: 'the phone',
			key: 'receipt',
			action: 'save',
			form: (a, bad) => receiptForm(a, { receiptPhone: bad }),
			message: FIELD_REFUSED
		},
		{
			field: 'the tax registration number',
			key: 'receipt',
			action: 'save',
			form: (a, bad) => receiptForm(a, { taxRegistrationNumber: bad }),
			message: FIELD_REFUSED
		}
	];

	// ONE fixture for every attempt: a refusal writes nothing, so each attempt is
	// compared with the same untouched baseline — step 3's snapshot, and A's rows.
	it('every text field this plan added, and the moved receipt fields, refuse ESC and BEL', async () => {
		const { a, b } = await twoRestaurants();
		const before = await snapshot(a, b);
		const aRows = await rowsOf(a.restaurantId);

		for (const { field, key, action, form, message } of FIELDS) {
			for (const bad of POISONS) {
				const result = await act(key, action, asOwner(a), form(a, bad));

				const label = `${field} ${JSON.stringify(bad)}`;
				expect(refusalOf(result), label).toEqual({ status: 400, message });
				expect(await snapshot(a, b), label).toEqual(before);
				expect(await rowsOf(a.restaurantId), label).toEqual(aRows);
			}
		}
	});
});

// ── Step 6: audit, exactly ───────────────────────────────────────────────────

describe('audit, exactly (invariant 10)', () => {
	const allButCashier = RECEIPT_SHOW_KEYS.filter((k) => k !== 'cashier');

	const AUDITED: Array<{
		label: string;
		key: PageKey;
		action: string;
		form: (a: Side) => Form;
		expected: string[];
	}> = [
		{
			label: '/settings default',
			key: 'settings',
			action: 'default',
			form: VALID.settings.default.form,
			expected: ['settings.updated']
		},
		{
			label: 'tax mode',
			key: 'tax',
			action: 'mode',
			form: VALID.tax.mode.form,
			expected: ['settings.updated']
		},
		{
			label: 'tax setDefault',
			key: 'tax',
			action: 'setDefault',
			form: VALID.tax.setDefault.form,
			expected: ['settings.updated']
		},
		{
			label: 'tax create',
			key: 'tax',
			action: 'create',
			form: VALID.tax.create.form,
			expected: ['tax_rate.created']
		},
		{
			label: 'tax create, "Make this the default rate" checked',
			key: 'tax',
			action: 'create',
			form: () => ({ name: 'Reduced', percent: '5', makeDefault: 'yes' }),
			expected: ['tax_rate.created', 'settings.updated']
		},
		{
			label: 'tax update',
			key: 'tax',
			action: 'update',
			form: VALID.tax.update.form,
			expected: ['tax_rate.updated']
		},
		{
			label: 'tax archive',
			key: 'tax',
			action: 'archive',
			form: VALID.tax.archive.form,
			expected: ['tax_rate.archived']
		},
		{
			label: 'payments create',
			key: 'payments',
			action: 'create',
			form: VALID.payments.create.form,
			expected: ['payment_method.created']
		},
		{
			label: 'payments update',
			key: 'payments',
			action: 'update',
			form: VALID.payments.update.form,
			expected: ['payment_method.updated']
		},
		{
			label: 'payments archive',
			key: 'payments',
			action: 'archive',
			form: VALID.payments.archive.form,
			expected: ['payment_method.archived']
		},
		{
			// movePaymentMethod renumbers every live owner method 1..n, but writes ONE
			// payment_method.updated row — for the moved method, with its old and new
			// position (src/lib/server/restaurants/payment-methods.ts). Exactly one.
			label: 'payments move',
			key: 'payments',
			action: 'move',
			form: VALID.payments.move.form,
			expected: ['payment_method.updated']
		},
		{
			label: 'receipt save: a switch',
			key: 'receipt',
			action: 'save',
			form: (a) => receiptForm(a, { show: allButCashier }),
			expected: ['settings.updated']
		},
		{
			label: 'receipt save: the heading',
			key: 'receipt',
			action: 'save',
			form: (a) => receiptForm(a, { paymentNumbersHeading: 'Pay by mobile' }),
			expected: ['settings.updated']
		},
		{
			label: 'receipt save: a header field',
			key: 'receipt',
			action: 'save',
			form: (a) => receiptForm(a, { receiptPhone: '+252 61 000 0000' }),
			expected: ['settings.updated']
		},
		{
			label: 'receipt save: the header lines',
			key: 'receipt',
			action: 'save',
			form: (a) => receiptForm(a, { headerLines: ['Open every day'] }),
			expected: ['receipt.lines_updated']
		},
		{
			label: 'receipt save: the footer lines',
			key: 'receipt',
			action: 'save',
			form: (a) => receiptForm(a, { footerLines: ['Thank you'] }),
			expected: ['receipt.lines_updated']
		},
		{
			label: 'receipt save: switch, heading, header field and both sections at once',
			key: 'receipt',
			action: 'save',
			form: (a) =>
				receiptForm(a, {
					show: allButCashier,
					paymentNumbersHeading: 'Pay by mobile',
					receiptAddress: '1 Market Street',
					headerLines: ['Open every day'],
					footerLines: ['Thank you']
				}),
			expected: ['settings.updated', 'receipt.lines_updated', 'receipt.lines_updated']
		},
		{
			label: 'receipt logo',
			key: 'receipt',
			action: 'logo',
			form: VALID.receipt.logo.form,
			expected: ['receipt.logo_updated']
		},
		{
			label: 'receipt removeLogo',
			key: 'receipt',
			action: 'removeLogo',
			form: VALID.receipt.removeLogo.form,
			expected: ['receipt.logo_removed']
		},
		{
			label: '/menu updateItem with a new rate',
			key: 'menu',
			action: 'updateItem',
			form: (a) => ({
				itemId: a.itemId,
				name: 'Tea',
				price: '',
				categoryId: '',
				taxRateId: a.spareRateId
			}),
			expected: ['menu.item_tax_rate_changed']
		}
	];

	it.each(AUDITED)(
		'$label adds exactly its audit rows, all A’s',
		async ({ key, action, form, expected }) => {
			const { a } = await twoRestaurants();
			const mark = await lastAuditId();

			const result = await act(key, action, asOwner(a), form(a));

			expect(refusalOf(result)).toBeNull();
			expect(await auditSince(mark)).toEqual(
				expected.map((event) => ({ restaurantId: a.restaurantId, event }))
			);
		}
	);

	it('/settings default: a resubmit that changes nothing adds no row', async () => {
		const { a } = await twoRestaurants();
		const form = VALID.settings.default.form(a);
		await act('settings', 'default', asOwner(a), form);
		const mark = await lastAuditId();

		const again = await act('settings', 'default', asOwner(a), form);

		expect(again).toEqual({ message: 'No changes to save.' });
		expect(await auditSince(mark)).toEqual([]);
	});

	it('every writer audits inside its own transaction: a rollback takes the row, the audit row and the version bump', async () => {
		const { a, b } = await twoRestaurants();
		const ctx: UpdateSettingsContext = { actorUserId: a.ownerId, ip: null, userAgent: null };
		const id = a.restaurantId;
		// `bumps`: the writer changes what the till's menu snapshot carries, so it
		// bumps menu_version in the same transaction (spec 5, risk 4); payment
		// methods and the receipt reach the till in the settings bundle and never do.
		const WRITERS: Array<{ name: string; bumps: boolean; run: (tx: DbTx) => Promise<unknown> }> = [
			{
				name: 'createTaxRate',
				bumps: true,
				run: (tx) => createTaxRate(tx, id, { name: 'Reduced', rateBp: 500 }, ctx)
			},
			{
				name: 'updateTaxRate',
				bumps: true,
				run: (tx) => updateTaxRate(tx, id, a.spareRateId, { name: 'Exempt goods' }, ctx)
			},
			{
				name: 'archiveTaxRate',
				bumps: true,
				run: (tx) => archiveTaxRate(tx, id, a.spareRateId, ctx)
			},
			{
				name: 'createPaymentMethod',
				bumps: false,
				run: (tx) =>
					createPaymentMethod(
						tx,
						id,
						{ name: 'Zaad', kind: 'mobile', merchantNumber: null, enabled: true },
						ctx
					)
			},
			{
				name: 'updatePaymentMethod',
				bumps: false,
				run: (tx) => updatePaymentMethod(tx, id, a.evcId, { merchantNumber: '61 999 9999' }, ctx)
			},
			{
				name: 'movePaymentMethod',
				bumps: false,
				run: (tx) => movePaymentMethod(tx, id, a.evcId, 'down', ctx)
			},
			{
				name: 'archivePaymentMethod',
				bumps: false,
				run: (tx) => archivePaymentMethod(tx, id, a.evcId, ctx)
			},
			{
				name: 'replaceReceiptLines',
				bumps: false,
				run: (tx) => replaceReceiptLines(tx, id, 'footer', ['Thank you'], ctx)
			},
			{
				name: 'setReceiptLogo',
				bumps: false,
				run: (tx) =>
					setReceiptLogo(tx, id, { widthDots: 8, heightDots: 1, bitmap: Uint8Array.of(0x3c) }, ctx)
			},
			{
				name: 'removeReceiptLogo',
				bumps: false,
				run: (tx) => removeReceiptLogo(tx, id, ctx)
			},
			{
				name: 'updateSettings with defaultTaxRateId',
				bumps: true,
				run: (tx) => updateSettings(tx, id, { defaultTaxRateId: a.spareRateId }, ctx)
			}
		];

		for (const writer of WRITERS) {
			const aRows = await rowsOf(a.restaurantId);
			const bRows = await rowsOf(b.restaurantId);
			const audit = await auditTotal(db);
			const version = await menuVersionOf(db, id);
			const inside: { result?: unknown; audit?: number; version?: number } = {};

			await expect(
				db.transaction(async (tx) => {
					inside.result = await writer.run(tx);
					inside.audit = await auditTotal(tx);
					inside.version = await menuVersionOf(tx, id);
					throw new Error('rollback');
				}),
				writer.name
			).rejects.toThrow('rollback');

			// Inside the transaction the change, its ONE audit row and (when `bumps`)
			// the version bump were all there…
			expect(inside.result, writer.name).toMatchObject({ ok: true });
			expect(inside.audit, writer.name).toBe(audit + 1);
			expect(inside.version, writer.name).toBe(version + (writer.bumps ? 1 : 0));
			// …and the rollback took every one of them back.
			expect(await rowsOf(a.restaurantId), writer.name).toEqual(aRows);
			expect(await rowsOf(b.restaurantId), writer.name).toEqual(bRows);
			expect(await auditTotal(db), writer.name).toBe(audit);
			expect(await menuVersionOf(db, id), writer.name).toBe(version);
		}
	});
});

// ── Step 7: sync payload ids ─────────────────────────────────────────────────

describe('MANDATORY (spec 29 — offline sync): a sale naming another restaurant’s id', () => {
	async function salesPair() {
		const fA = await seedSalesRestaurant(db, { ownerEmail: 'sales-a@sweep.test' });
		const fB = await seedSalesRestaurant(db, { ownerEmail: 'sales-b@sweep.test' });
		const posSessionId = randomUUID();
		await openSessionAt(db, fA, {
			posSessionId,
			openedAt: new Date(Date.now() - 300_000),
			openingCashMinor: 0n
		});
		return { fA, fB, posSessionId };
	}

	function teaSale(f: SalesFixture, posSessionId: string, method: 'cash' | 'card', seq: number) {
		return saleEnvelope(f, {
			posSessionId,
			occurredAt: new Date(Date.now() - 60_000),
			invoiceSeq: seq,
			method,
			orderType: 'takeaway',
			tableLabel: null,
			lines: [
				{
					menuItemId: f.items.tea,
					itemName: 'Tea',
					quantity: 1,
					unitPriceMinor: 200n,
					taxRateBp: f.taxRateBp
				}
			]
		});
	}

	/** What was posted for the order: invariant 2 — nothing, for a refused sale. */
	async function postedFor(orderId: string) {
		const n = () => sql<number>`count(*)::int`;
		const [o] = await db.select({ n: n() }).from(orders).where(eq(orders.id, orderId));
		const [p] = await db.select({ n: n() }).from(payments).where(eq(payments.orderId, orderId));
		const [i] = await db.select({ n: n() }).from(invoices).where(eq(invoices.orderId, orderId));
		// journal_entries has no order_id: an entry points at its order through
		// source_type / source_id (src/lib/server/db/schema/accounting.ts).
		const [j] = await db
			.select({ n: n() })
			.from(journalEntries)
			.where(and(eq(journalEntries.sourceType, 'order'), eq(journalEntries.sourceId, orderId)));
		return { orders: o.n, payments: p.n, invoices: i.n, journalEntries: j.n };
	}
	const NOTHING = { orders: 0, payments: 0, invoices: 0, journalEntries: 0 };

	async function storedOp(f: SalesFixture, clientOpId: string) {
		return db
			.select()
			.from(posSyncOps)
			.where(and(eq(posSyncOps.deviceId, f.deviceId), eq(posSyncOps.clientOpId, clientOpId)));
	}

	it('a cash sale carrying B’s payment method id is stored unrecorded with its payload, and posts nothing', async () => {
		const { fA, fB, posSessionId } = await salesPair();
		const bAudit = await auditCountOf(fB.restaurantId);
		const env = teaSale(fA, posSessionId, 'cash', 1);
		const payload = env.payload as SaleCompletePayload;
		payload.payments[0].paymentMethodId = fB.paymentMethods.mobile.id;

		const result = await pushOp(db, fA, env);

		expect(result).toEqual({
			http: 200,
			body: {
				clientOpId: env.clientOpId,
				status: 'unrecorded',
				flag: 'invalid_payload',
				error: 'unknown_payment_method'
			}
		});
		// Stored and flagged, never discarded (spec 6): the WHOLE envelope, under A.
		const [op] = await storedOp(fA, env.clientOpId);
		expect(op).toMatchObject({
			restaurantId: fA.restaurantId,
			status: 'unrecorded',
			flag: 'invalid_payload',
			error: 'unknown_payment_method'
		});
		expect(op.payload).toEqual(env);
		expect(await postedFor(payload.orderId)).toEqual(NOTHING);
		expect(await auditCountOf(fB.restaurantId)).toBe(bAudit);
	});

	it('a cash sale whose line names B’s tax rate is stored unrecorded with its payload, and posts nothing', async () => {
		const { fA, fB, posSessionId } = await salesPair();
		const env = teaSale(fA, posSessionId, 'cash', 2);
		const payload = env.payload as SaleCompletePayload;
		payload.lines[0].taxRateId = fB.defaultTaxRate.id;

		const result = await pushOp(db, fA, env);

		expect(result).toEqual({
			http: 200,
			body: {
				clientOpId: env.clientOpId,
				status: 'unrecorded',
				flag: 'invalid_payload',
				error: 'unknown_tax_rate'
			}
		});
		const [op] = await storedOp(fA, env.clientOpId);
		expect(op).toMatchObject({
			restaurantId: fA.restaurantId,
			status: 'unrecorded',
			flag: 'invalid_payload',
			error: 'unknown_tax_rate'
		});
		expect(op.payload).toEqual(env);
		expect(await postedFor(payload.orderId)).toEqual(NOTHING);
	});

	it('a CARD sale carrying B’s method id fails closed with 422 and stores nothing', async () => {
		const { fA, fB, posSessionId } = await salesPair();
		const env = teaSale(fA, posSessionId, 'card', 3);
		const payload = env.payload as SaleCompletePayload;
		// A holds an enabled card method of its own (seedSalesRestaurant's 'Card').
		payload.payments[0].paymentMethodId = fB.paymentMethods.card.id;

		const result = await pushOp(db, fA, env);

		expect(result).toEqual({ http: 422, body: { error: 'rejected', flag: 'invalid_payload' } });
		expect(await storedOp(fA, env.clientOpId)).toEqual([]);
		expect(await postedFor(payload.orderId)).toEqual(NOTHING);
	});
});

// ── Step 8: the device routes ────────────────────────────────────────────────

describe('MANDATORY (spec 29): the device routes answer the device’s restaurant only', () => {
	/**
	 * A GET as src/routes/api/pos/permissions.integration.test.ts's makeEvent builds
	 * it: the device cookie, plus `locals`. The cases put A's OWNER and A's tenant
	 * into locals — the hook never sets a tenant outside (dashboard), but a route
	 * that read one by habit would then serve A — and the answer must still be B's.
	 */
	function deviceEvent(
		routeId: string,
		token: string | null,
		locals: Partial<App.Locals> = {}
	): RequestEvent {
		const jar = new Map<string, string>(token ? [[DEVICE_COOKIE, token]] : []);
		const url = new URL(`http://localhost${routeId}`);
		return {
			cookies: {
				get: (name: string) => jar.get(name),
				getAll: () => [...jar].map(([name, value]) => ({ name, value })),
				set: (name: string, value: string) => jar.set(name, value),
				delete: (name: string) => jar.delete(name),
				serialize: () => ''
			},
			fetch: globalThis.fetch,
			getClientAddress: () => '203.0.113.5',
			locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null, ...locals },
			params: {},
			platform: undefined,
			request: new Request(url, { method: 'GET', headers: { origin: 'http://localhost' } }),
			route: { id: routeId },
			setHeaders: () => {},
			url,
			isDataRequest: false,
			isSubRequest: false,
			isRemoteRequest: false
		} as unknown as RequestEvent;
	}
	const aSignedIn = (a: Side): Partial<App.Locals> => ({
		user: asOwner(a),
		restaurantId: a.restaurantId
	});

	it('both answer 403 to a request with no device cookie', async () => {
		await twoRestaurants();
		for (const [routeId, handler] of [
			['/api/pos/receipt-logo', receiptLogoGet],
			['/api/pos/employees', employeesGet]
		] as const) {
			expect(await statusOf(() => handler(deviceEvent(routeId, null))), routeId).toBe(403);
		}
	});

	it('GET /api/pos/receipt-logo answers B’s logo to B’s device, then 404 once it is removed — never A’s', async () => {
		const { a, b } = await twoRestaurants();
		expect(b.logoSha).not.toBe(a.logoSha);

		const first = await receiptLogoGet(
			deviceEvent('/api/pos/receipt-logo', b.deviceToken, aSignedIn(a))
		);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			sha256: b.logoSha,
			widthDots: 8,
			heightDots: 1,
			bitmap: Buffer.from([b.logoByte]).toString('base64')
		});

		await db.transaction((tx) =>
			removeReceiptLogo(tx, b.restaurantId, { actorUserId: b.ownerId, ip: null, userAgent: null })
		);

		const second = await receiptLogoGet(
			deviceEvent('/api/pos/receipt-logo', b.deviceToken, aSignedIn(a))
		);
		expect(second.status).toBe(404);
		expect(await second.json()).toEqual({ error: 'no_logo' });
		// A's logo is still stored, and B's device was never given it.
		const [aLogo] = await db
			.select({ sha256: receiptLogos.sha256 })
			.from(receiptLogos)
			.where(eq(receiptLogos.restaurantId, a.restaurantId));
		expect(aLogo?.sha256).toBe(a.logoSha);
	});

	it('GET /api/pos/employees gives B’s device B’s payment methods and B’s receipt only', async () => {
		const { a, b } = await twoRestaurants();

		const response = await employeesGet(
			deviceEvent('/api/pos/employees', b.deviceToken, aSignedIn(a))
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			settings: {
				paymentMethods: Array<{ id: string }>;
				receipt: { headerLines: string[]; logo: { sha256: string } | null };
			};
		};
		const ids = body.settings.paymentMethods.map((method) => method.id);
		// B's enabled, live methods — Cash first, then the owner's order.
		expect(ids).toEqual([b.cashId, b.evcId, b.cardId]);
		for (const id of [a.cashId, a.evcId, a.cardId]) expect(ids).not.toContain(id);
		expect(body.settings.receipt.headerLines).toEqual([b.headerLine]);
		expect(body.settings.receipt.logo?.sha256).toBe(b.logoSha);
	});
});
