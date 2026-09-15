import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { requirePermission } from '$lib/server/permissions';
import { db } from '$lib/server/db/client';
import {
	getRestaurantWithSettings,
	updateSettings,
	timeZoneSuggestions
} from '$lib/server/restaurants';
import { requestContext } from '$lib/server/audit';
import { TAX_MODES } from '$lib/money/tax';
import { SUPPORTED_CURRENCIES } from '$lib/money/format';

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.settings');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	return {
		name: restaurant.name,
		timeZone: restaurant.timeZone,
		// SUGGESTIONS ONLY. The validator is isValidTimeZone, which works by
		// construction — this list omits UTC, Asia/Kolkata, Europe/Kyiv and others
		// that are perfectly valid.
		timeZones: timeZoneSuggestions(),
		// Null until the owner chooses — rendered as an empty field, never a default.
		taxMode: restaurant.taxMode,
		taxRateBp: restaurant.taxRateBp,
		currencyCode: restaurant.currencyCode,
		taxModes: [...TAX_MODES],
		supportedCurrencies: Object.keys(SUPPORTED_CURRENCIES)
	};
};

const TAX_MODE_MESSAGE = 'Choose a tax mode of exclusive or inclusive.';
const TAX_RATE_MESSAGE = 'The tax rate is whole basis points — 825 means 8.25%.';
const CURRENCY_MESSAGE = 'That currency code is not one this system can format.';

const settingsSchema = z.object({
	name: z.string().trim().min(1, 'Enter the restaurant name').max(200),
	timeZone: z.string().trim().min(1, 'Choose a time zone').max(100),
	// OPTIONAL, all three: a blank field means "not submitted, leave it alone",
	// never "clear it" (optionalField below). updateSettings validates each again.
	taxMode: z.enum(TAX_MODES, { error: TAX_MODE_MESSAGE }).optional(),
	taxRateBp: z.coerce
		.number({ error: TAX_RATE_MESSAGE })
		.int(TAX_RATE_MESSAGE)
		.min(0, TAX_RATE_MESSAGE)
		.max(10000, TAX_RATE_MESSAGE)
		.optional(),
	currencyCode: z
		.string()
		.trim()
		.toUpperCase()
		.refine((code) => Object.hasOwn(SUPPORTED_CURRENCIES, code), CURRENCY_MESSAGE)
		.optional()
});

/** A blank or absent optional field is "not submitted": undefined, BEFORE parsing. */
function optionalField(value: FormDataEntryValue | null): FormDataEntryValue | undefined {
	if (value === null) return undefined;
	return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

export const actions: Actions = {
	default: async (event) => {
		// Guarded AGAIN, in the action itself. A form action is a separately
		// reachable POST endpoint; guarding only the load leaves it open, and
		// invariant 8 says a form action with no permission check is unfinished.
		const user = requirePermission(event, 'admin.settings');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();
		const parsed = settingsSchema.safeParse({
			name: form.get('name'),
			timeZone: form.get('timeZone'),
			taxMode: optionalField(form.get('taxMode')),
			taxRateBp: optionalField(form.get('taxRateBp')),
			currencyCode: optionalField(form.get('currencyCode'))
		});

		if (!parsed.success) {
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Check the form.' });
		}

		const { ip, userAgent } = requestContext(event);

		// restaurantId comes from locals, NEVER from the form body — that is the
		// cross-tenant write T-16's test exists to catch.
		const result = await db.transaction((tx) =>
			updateSettings(
				tx,
				restaurantId,
				{
					name: parsed.data.name,
					timeZone: parsed.data.timeZone,
					taxMode: parsed.data.taxMode,
					taxRateBp: parsed.data.taxRateBp,
					currencyCode: parsed.data.currencyCode
				},
				{ actorUserId: user.userId, ip, userAgent }
			)
		);

		if (!result.ok) {
			const messages: Partial<Record<typeof result.reason, string>> = {
				invalid_time_zone: 'That time zone is not recognised.',
				invalid_tax_mode: TAX_MODE_MESSAGE,
				invalid_tax_rate: TAX_RATE_MESSAGE,
				invalid_currency: CURRENCY_MESSAGE
			};
			return fail(400, {
				message: messages[result.reason] ?? 'Those settings could not be saved.'
			});
		}

		// updateSettings returns early when nothing changed, so say so rather than
		// "Saved" — otherwise the audit log and the user's memory disagree about
		// whether anything happened.
		return { message: result.changed ? 'Settings saved.' : 'No changes to save.' };
	}
};
