import { error, fail, type Actions, type RequestEvent, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { requirePermission } from '$lib/server/permissions';
import { db } from '$lib/server/db/client';
import type { Principal } from '$lib/server/auth/session';
import { getRestaurantWithSettings, updateSettings } from '$lib/server/restaurants';
import { archiveTaxRate, createTaxRate, listTaxRates, updateTaxRate } from '$lib/server/menu';
import { requestContext } from '$lib/server/audit';
import { formatTaxRate, parsePercentToBp, TAX_MODES } from '$lib/money/tax';

// THE TAX SETTINGS PAGE (tasks/settings-tax-payments-receipt T-28, gate decision
// 8): the tax mode, the NAMED rates and which one is the default — spec 33 open
// decision 3's answered parts, moved here from /settings by T-27.
//
// A rate is typed as a PERCENT and parsed ONCE, by parsePercentToBp in the money
// module (digit-string arithmetic, no float — invariant 1); this file never turns
// a string into a number. Nothing here defaults the mode or seeds a rate: both
// read "Not chosen" until the owner picks (risk 5). Every write goes through the
// module that owns it — createTaxRate / updateTaxRate / archiveTaxRate (menu/,
// T-10) and updateSettings (restaurants/, T-13) — each of which bumps the menu
// version and audits inside the action's ONE transaction (spec 5; invariant 10).
// Editing or archiving a rate changes no past sale: every order line stores the
// rate it was sold at (spec 17; invariant 2).

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.settings');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	const rates = await listTaxRates(db, restaurantId);

	return {
		// Null until the owner chooses — rendered as "Not chosen", never a default.
		taxMode: restaurant.taxMode,
		taxModes: [...TAX_MODES],
		defaultTaxRateId: restaurant.defaultTaxRateId,
		rates: rates.map((rate) => {
			const formatted = formatTaxRate(rate.rateBp);
			return {
				id: rate.id,
				name: rate.name,
				rateBp: rate.rateBp,
				// String surgery on the formatter's output ('8.25%' → '8.25'), not arithmetic.
				percent: formatted.slice(0, -1),
				label: `${rate.name} ${formatted}`,
				isDefault: rate.isDefault,
				liveItemCount: rate.liveItemCount,
				archived: rate.archivedAt !== null
			};
		})
	};
};

const RATE_MESSAGE =
	'Type the rate as a percent from 0 to 100 with at most two decimals — for example 5 or 8.25.';
// The /settings page's fallback idiom: every action has a message for every
// reason its module can return, and an unlisted one still gets a sentence.
const RATE_FALLBACK = 'That rate could not be saved. Reload the page and try again.';
const NAME_MESSAGE = 'Enter a name of 1 to 40 characters with no control characters.';
const NOT_FOUND_MESSAGE = 'That rate no longer exists. Reload the page.';
const DEFAULT_MESSAGE = 'Choose a live rate of this restaurant.';
const MODE_MESSAGE = 'Choose prices exclude tax or prices include tax.';

const MESSAGES: Record<string, string> = {
	invalid_name: NAME_MESSAGE,
	invalid_rate: RATE_MESSAGE,
	duplicate_name: 'A rate with that name already exists.',
	not_found: NOT_FOUND_MESSAGE,
	archived: 'That rate is archived.',
	already_archived: 'That rate is archived.',
	is_default: 'This is the default rate. Make another rate the default first.',
	invalid_tax_rate: DEFAULT_MESSAGE,
	invalid_tax_mode: MODE_MESSAGE
};

/** The sentence for a module refusal; `in_use` carries its own count. */
function messageFor(refusal: { reason: string; liveItemCount?: number }): string {
	if (refusal.reason === 'in_use') {
		return `Used by ${refusal.liveItemCount} menu item(s) — move them to another rate first.`;
	}
	return MESSAGES[refusal.reason] ?? RATE_FALLBACK;
}

/** The message for a form that failed zod, by the field that failed. */
function fieldMessage(issue: { path: PropertyKey[] } | undefined): string {
	if (issue?.path.includes('taxRateId')) return NOT_FOUND_MESSAGE;
	if (issue?.path.includes('percent')) return RATE_MESSAGE;
	return NAME_MESSAGE;
}

/**
 * A module refusal thrown INSIDE db.transaction, so everything written before it
 * — a rate created a step earlier, say — rolls back with it. Caught outside the
 * transaction and turned into fail(400).
 */
class Refused extends Error {}

/** The restaurant in scope and the audit context — never read from the form. */
function scopeOf(event: RequestEvent, user: Principal) {
	// restaurantId comes from locals, NEVER from the form body — that is the
	// cross-tenant write the "never touches another restaurant" test exists to catch.
	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const { ip, userAgent } = requestContext(event);
	return { restaurantId, ctx: { actorUserId: user.userId, ip, userAgent } };
}

const modeSchema = z.object({ taxMode: z.enum(TAX_MODES) });
const rateIdSchema = z.object({ taxRateId: z.uuid() });
// The name's bounds and the percent's shape are checked by the module and by
// parsePercentToBp: zod only insists that each arrived as a string.
const createSchema = z.object({ name: z.string().trim(), percent: z.string() });
const updateSchema = z.object({
	taxRateId: z.uuid(),
	name: z.string().trim(),
	percent: z.string()
});

// Named actions only: a page with named actions may not also have `default`
// (SvelteKit throws at the first POST), so the default-rate action is setDefault.
export const actions: Actions = {
	mode: async (event) => {
		// Guarded AGAIN, in the action itself: a form action is a separately
		// reachable POST endpoint (invariant 8).
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = modeSchema.safeParse({ taxMode: form.get('taxMode') });
		if (!parsed.success) return fail(400, { message: MODE_MESSAGE });

		const result = await db.transaction((tx) =>
			updateSettings(tx, restaurantId, { taxMode: parsed.data.taxMode }, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: result.changed ? 'Tax mode saved.' : 'No changes to save.' };
	},

	setDefault: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = rateIdSchema.safeParse({ taxRateId: form.get('taxRateId') });
		if (!parsed.success) return fail(400, { message: DEFAULT_MESSAGE });

		// T-13: updateSettings locks the rate FOR SHARE, refuses a missing, foreign
		// or archived one with invalid_tax_rate, and bumps menu_version on a change.
		const result = await db.transaction((tx) =>
			updateSettings(tx, restaurantId, { defaultTaxRateId: parsed.data.taxRateId }, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: result.changed ? 'Default rate saved.' : 'No changes to save.' };
	},

	create: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = createSchema.safeParse({
			name: form.get('name'),
			percent: form.get('percent')
		});
		if (!parsed.success) return fail(400, { message: fieldMessage(parsed.error.issues[0]) });

		// THE one conversion of the typed percent, in the money module (invariant 1).
		const rateBp = parsePercentToBp(parsed.data.percent);
		if (rateBp === null) return fail(400, { message: RATE_MESSAGE });

		const name = parsed.data.name;
		const makeDefault = form.get('makeDefault') === 'yes';

		// ONE transaction for the rate and, when asked, the default: a refused
		// default throws Refused and rolls the new rate back with it.
		try {
			await db.transaction(async (tx) => {
				const created = await createTaxRate(tx, restaurantId, { name, rateBp }, ctx);
				if (!created.ok) throw new Refused(messageFor(created));
				if (makeDefault) {
					const chosen = await updateSettings(
						tx,
						restaurantId,
						{ defaultTaxRateId: created.id },
						ctx
					);
					if (!chosen.ok) throw new Refused(messageFor(chosen));
				}
			});
		} catch (thrown) {
			if (thrown instanceof Refused) return fail(400, { message: thrown.message });
			throw thrown;
		}

		return {
			message: makeDefault ? `${name} added and made the default rate.` : `${name} added.`
		};
	},

	update: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = updateSchema.safeParse({
			taxRateId: form.get('taxRateId'),
			name: form.get('name'),
			percent: form.get('percent')
		});
		if (!parsed.success) return fail(400, { message: fieldMessage(parsed.error.issues[0]) });

		const rateBp = parsePercentToBp(parsed.data.percent);
		if (rateBp === null) return fail(400, { message: RATE_MESSAGE });

		const name = parsed.data.name;
		const result = await db.transaction((tx) =>
			updateTaxRate(tx, restaurantId, parsed.data.taxRateId, { name, rateBp }, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: result.changed ? `${name} saved.` : 'No changes to save.' };
	},

	archive: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = rateIdSchema.safeParse({ taxRateId: form.get('taxRateId') });
		if (!parsed.success) return fail(400, { message: NOT_FOUND_MESSAGE });

		// The hidden name is for the MESSAGE only; the write is keyed on the id.
		const posted = form.get('name');
		const name = typeof posted === 'string' && posted.trim() !== '' ? posted.trim() : 'Rate';

		const result = await db.transaction((tx) =>
			archiveTaxRate(tx, restaurantId, parsed.data.taxRateId, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: `${name} archived.` };
	}
};
