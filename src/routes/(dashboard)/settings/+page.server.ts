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
		timeZones: timeZoneSuggestions()
	};
};

const settingsSchema = z.object({
	name: z.string().trim().min(1, 'Enter the restaurant name').max(200),
	timeZone: z.string().trim().min(1, 'Choose a time zone').max(100)
});

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
			timeZone: form.get('timeZone')
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
				{ name: parsed.data.name, timeZone: parsed.data.timeZone },
				{ actorUserId: user.userId, ip, userAgent }
			)
		);

		if (!result.ok) {
			return fail(400, {
				message:
					result.reason === 'invalid_time_zone'
						? 'That time zone is not recognised.'
						: 'Those settings could not be saved.'
			});
		}

		// updateSettings returns early when nothing changed, so say so rather than
		// "Saved" — otherwise the audit log and the user's memory disagree about
		// whether anything happened.
		return { message: result.changed ? 'Settings saved.' : 'No changes to save.' };
	}
};
