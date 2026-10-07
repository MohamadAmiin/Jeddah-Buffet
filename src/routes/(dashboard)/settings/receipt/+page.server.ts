import { error, fail, type Actions, type RequestEvent, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { requirePermission } from '$lib/server/permissions';
import { db } from '$lib/server/db/client';
import type { Principal } from '$lib/server/auth/session';
import {
	getReceiptLayout,
	getRestaurantWithSettings,
	listPaymentMethods,
	readReceiptLogo,
	removeReceiptLogo,
	replaceReceiptLines,
	setReceiptLogo,
	updateSettings
} from '$lib/server/restaurants';
import { listTaxRates } from '$lib/server/menu';
import { requestContext } from '$lib/server/audit';
import { RECEIPT_SHOW_KEYS, paymentNumbersFrom, type ReceiptShow } from '$lib/receipt-layout';
import type { SaleSnapshot } from '$lib/pos/store';
import { sampleSale } from './sample';

// THE RECEIPT SETTINGS PAGE (tasks/settings-tax-payments-receipt T-31, gate
// decision 8): the receipt header text, up to five header and five footer
// lines, the nine display switches, the payment-numbers heading and the logo,
// with a live preview drawn by the till's own formatter.
//
// WHAT MAY BE HIDDEN is gate decision 4 (CLAUDE.md "Settings 4"): the nine
// switches are the complete hideable set, and the formatter
// src/lib/pos/receipt.ts enforces what never hides — the restaurant name, the
// invoice number, the date and time, the items, the totals, the payment, the
// COPY marks and the tax registration number when one is set. Spec 33 open
// decision 3 (what a receipt must legally show) is STILL OPEN; this page holds
// no answer to it.
//
// THE PAGE DOES NO MONEY ARITHMETIC (invariants 1 and 7). The preview's sample
// sale is built HERE, in the load, by ./sample through computeOrderTotals and
// taxBreakdown in src/lib/money; the page prints those stored strings through
// renderReceipt and rounds nothing.
//
// LAYOUT IS CONFIGURATION, NOT A POSTED RECORD (invariant 2): the only DELETEs
// behind this page are of receipt_lines rows replaced as a set and of the one
// receipt_logos row (T-12). THE LOGO IS PLAIN PIXEL DATA: the browser's bitmap
// is never forwarded unchecked — the canonical base64 check here, setReceiptLogo's
// isValidLogoShape and the receipt_logos_byte_size_matches CHECK are three walls
// in front of print agent v2's own (risk 6), and only the agent ever writes a
// printer command byte.
//
// Every load and every action checks admin.settings itself and takes
// restaurantId from locals, never from the form (invariant 8). Every writer
// audits in the action's ONE transaction (invariant 10): settings.updated,
// receipt.lines_updated, receipt.logo_updated, receipt.logo_removed. Nothing
// here bumps menu_version: the layout reaches the till in the settings bundle
// of GET /api/pos/employees (T-20), not in the menu snapshot.

const CURRENCY_BLOCK = 'Set the currency on General to see the preview.';
const MODE_BLOCK = 'Choose the tax mode on Tax to see the preview.';
const RATE_BLOCK = 'Choose a default tax rate on Tax to see the preview.';

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.settings');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	const layout = await getReceiptLayout(db, restaurantId);
	const stored = await readReceiptLogo(db, restaurantId);
	// The logo as the preview canvas and the hidden field carry it: standard base64.
	const logo = stored
		? {
				widthDots: stored.widthDots,
				heightDots: stored.heightDots,
				bitmap: Buffer.from(stored.bitmap).toString('base64')
			}
		: null;

	// Live methods only (listPaymentMethods' default), enabled, with a number —
	// exactly the block the till prints (T-20, T-23).
	const methods = await listPaymentMethods(db, restaurantId);
	const paymentNumbers = paymentNumbersFrom(methods.filter((method) => method.enabled));
	const cash = methods.find((method) => method.kind === 'cash') ?? null;

	const rates = await listTaxRates(db, restaurantId);
	const live = rates.filter((rate) => rate.archivedAt === null);
	const defaultRate = live.find((rate) => rate.isDefault) ?? null;
	const otherRate = live.find((rate) => !rate.isDefault) ?? null;

	// The sample needs a currency, a tax mode and a default rate; the first one
	// missing names the page that sets it. Nothing is defaulted (risk 5).
	let previewBlocked: string | null = null;
	let sample: SaleSnapshot | null = null;
	if (restaurant.currencyCode === null) previewBlocked = CURRENCY_BLOCK;
	else if (restaurant.taxMode === null) previewBlocked = MODE_BLOCK;
	else if (defaultRate === null) previewBlocked = RATE_BLOCK;
	else {
		sample = sampleSale({
			currencyCode: restaurant.currencyCode,
			taxMode: restaurant.taxMode,
			rates: [defaultRate, ...(otherRate ? [otherRate] : [])].map((rate) => ({
				id: rate.id,
				name: rate.name,
				rateBp: rate.rateBp
			})),
			cash: cash ? { id: cash.id, name: cash.name } : null,
			now: new Date()
		});
	}

	return {
		restaurantName: restaurant.name,
		timeZone: restaurant.timeZone,
		// Nullable columns rendered as empty fields, never a default.
		address: restaurant.receiptAddress ?? '',
		phone: restaurant.receiptPhone ?? '',
		taxRegistrationNumber: restaurant.taxRegistrationNumber ?? '',
		layout,
		logo,
		paymentNumbers,
		sample,
		previewBlocked
	};
};

const INVALID_FIELD_MESSAGE =
	'Receipt text must be plain text: address and lines up to 120 characters, phone, tax number and heading up to 40.';
const TOO_MANY_LINES_MESSAGE = 'At most 5 lines in each of the header and the footer.';
const INVALID_LINE_MESSAGE = 'Each line is up to 120 characters of plain text.';
const LOGO_MESSAGE =
	'That logo is not a black-and-white image of at most 384 × 160 dots. Choose the file again.';
// The /settings page's fallback idiom: every action has a message for every
// reason its module can return, and an unlisted one still gets a sentence.
const SAVE_FALLBACK = 'The receipt could not be saved. Reload the page and try again.';

const MESSAGES: Record<string, string> = {
	invalid_receipt_field: INVALID_FIELD_MESSAGE,
	too_many_lines: TOO_MANY_LINES_MESSAGE,
	invalid_line: INVALID_LINE_MESSAGE
};

/** The sentence for a module refusal. */
function messageFor(refusal: { reason: string }): string {
	return MESSAGES[refusal.reason] ?? SAVE_FALLBACK;
}

/**
 * A module refusal thrown INSIDE db.transaction, so everything written before it
 * — the settings row a step earlier, say — rolls back with it. Caught outside
 * the transaction and turned into fail(400).
 */
class Refused extends Error {}

/** The restaurant in scope and the audit context — never read from the form. */
function scopeOf(event: RequestEvent, user: Principal) {
	// restaurantId comes from locals, NEVER from the form body — that is the
	// cross-tenant write the "writes to locals.restaurantId only" test exists to catch.
	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const { ip, userAgent } = requestContext(event);
	return { restaurantId, ctx: { actorUserId: user.userId, ip, userAgent } };
}

/** Every string entry of a multi-valued field; a File entry is dropped, never forwarded. */
function strings(form: FormData, name: string): string[] {
	return form.getAll(name).filter((value): value is string => typeof value === 'string');
}

/** A trimmed text field as the settings writer stores it: blank → null (clears the column). */
function clearable(value: string): string | null {
	return value.trim() === '' ? null : value;
}

// The text bounds and the control-character rule are the modules' (updateSettings
// and replaceReceiptLines); zod only insists that each field arrived as a string.
// Every field of this form is posted on every save: an absent one reads as blank.
const saveSchema = z.object({
	receiptAddress: z.string(),
	receiptPhone: z.string(),
	taxRegistrationNumber: z.string(),
	paymentNumbersHeading: z.string()
});
// 384 × 160 dots is 7,680 bytes, which is exactly 10,240 characters of base64.
const logoSchema = z.object({
	widthDots: z.coerce.number().int(),
	heightDots: z.coerce.number().int(),
	bitmap: z.string().max(10_240)
});

// Named actions only: a page with named actions may not also have `default`
// (SvelteKit throws at the first POST), so the main form's action is `save`.
export const actions: Actions = {
	save: async (event) => {
		// Guarded AGAIN, in the action itself: a form action is a separately
		// reachable POST endpoint (invariant 8).
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = saveSchema.safeParse({
			receiptAddress: form.get('receiptAddress') ?? '',
			receiptPhone: form.get('receiptPhone') ?? '',
			taxRegistrationNumber: form.get('taxRegistrationNumber') ?? '',
			paymentNumbersHeading: form.get('paymentNumbersHeading') ?? ''
		});
		if (!parsed.success) return fail(400, { message: INVALID_FIELD_MESSAGE });

		// Checkbox semantics: a switch absent from the form is OFF; a value that is
		// not one of the nine keys is ignored.
		const shown = new Set(strings(form, 'show'));
		const receiptShow = Object.fromEntries(
			RECEIPT_SHOW_KEYS.map((key) => [key, shown.has(key)])
		) as ReceiptShow;
		const headerLines = strings(form, 'headerLines');
		const footerLines = strings(form, 'footerLines');

		// ONE transaction for the settings row and both sections: a refusal
		// anywhere throws Refused and rolls back everything written before it.
		let changed = false;
		try {
			await db.transaction(async (tx) => {
				const settings = await updateSettings(
					tx,
					restaurantId,
					{
						receiptAddress: clearable(parsed.data.receiptAddress),
						receiptPhone: clearable(parsed.data.receiptPhone),
						taxRegistrationNumber: clearable(parsed.data.taxRegistrationNumber),
						receiptShow,
						receiptPaymentNumbersHeading: clearable(parsed.data.paymentNumbersHeading)
					},
					ctx
				);
				if (!settings.ok) throw new Refused(messageFor(settings));
				const header = await replaceReceiptLines(tx, restaurantId, 'header', headerLines, ctx);
				if (!header.ok) throw new Refused(messageFor(header));
				const footer = await replaceReceiptLines(tx, restaurantId, 'footer', footerLines, ctx);
				if (!footer.ok) throw new Refused(messageFor(footer));
				changed = settings.changed || header.changed || footer.changed;
			});
		} catch (thrown) {
			if (thrown instanceof Refused) return fail(400, { message: thrown.message });
			throw thrown;
		}

		return { message: changed ? 'Receipt saved.' : 'No changes to save.' };
	},

	logo: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = logoSchema.safeParse({
			widthDots: form.get('widthDots'),
			heightDots: form.get('heightDots'),
			bitmap: form.get('bitmap')
		});
		if (!parsed.success) return fail(400, { message: LOGO_MESSAGE });

		const { widthDots, heightDots, bitmap } = parsed.data;
		// CANONICAL base64 only. Buffer decodes leniently — missing padding, stray
		// characters — so the bytes are re-encoded and must round-trip to the very
		// string that was posted; anything else is refused before any SQL.
		const bytes = Buffer.from(bitmap, 'base64');
		if (bytes.toString('base64') !== bitmap) return fail(400, { message: LOGO_MESSAGE });

		// setReceiptLogo checks the shape (isValidLogoShape) and the database
		// checks it again (receipt_logos_byte_size_matches).
		const result = await db.transaction((tx) =>
			setReceiptLogo(
				tx,
				restaurantId,
				{ widthDots, heightDots, bitmap: new Uint8Array(bytes) },
				ctx
			)
		);
		if (!result.ok) return fail(400, { message: LOGO_MESSAGE });

		return { message: 'Logo saved.' };
	},

	removeLogo: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const result = await db.transaction((tx) => removeReceiptLogo(tx, restaurantId, ctx));

		return { message: result.changed ? 'Logo removed.' : 'There was no logo.' };
	}
};
