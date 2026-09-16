import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext, writeAudit } from '$lib/server/audit';
import { getRegisteredDevice, revokeDevice } from '$lib/server/auth/pos-device';
import {
	getRestaurantWithSettings,
	settingsComplete,
	updateSettings
} from '$lib/server/restaurants';

// THE DASHBOARD'S POS DEVICE PAGE — at /device, and deliberately NOT /pos and not
// any path beginning with the characters "pos". /pos belongs to the till, and the
// till's service worker is scoped to /pos, where scope matching is a plain STRING
// prefix: a dashboard page at a path starting "pos" would be controlled by that
// worker and could have its authenticated HTML served from Cache Storage after
// /logout. The rail item that leads here is still labelled "POS"; only its URL
// differs, on purpose.
//
// Revocation lives HERE, as a form action, and there is no /api/pos/revoke. Spec 7
// places the control on the dashboard ("The owner can revoke a device from the
// dashboard"), so the actor is a dashboard session; a form action gets SvelteKit's
// built-in origin check for free on its form-encoded body; and one revocation path
// cannot drift from a second.

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.devices');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	// The restaurant's MOST RECENT device, revoked or not: the page decides what a
	// revoked row means (registered = device && revokedAt === null), and filtering it
	// out here would make revokedAt permanently null and that predicate dead code.
	const row = await getRegisteredDevice(db, restaurantId);
	// The launch gate: settingsComplete() is the one list of what a till needs
	// before it may be opened, and the idle lock is settable on this page.
	const settings = await settingsComplete(db, restaurantId);
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	// AN EXPLICIT OBJECT LITERAL, never a spread row: pos_devices holds the token
	// hash, and SvelteKit serialises load data into the page HTML and __data.json.
	return {
		device: row
			? {
					id: row.id,
					deviceCode: row.deviceCode,
					label: row.label,
					registeredAt: row.registeredAt,
					lastSeenAt: row.lastSeenAt,
					revokedAt: row.revokedAt
				}
			: null,
		settings: { complete: settings.complete, missing: settings.missing },
		// Passed through as stored — null until the owner chooses. No fallback
		// number: a fallback is a column default wearing a disguise.
		idleLockSeconds: restaurant.posIdleLockSeconds,
		// The restaurant's own clock for the dates on this page (invariant 11), which
		// also keeps the server-rendered text and the hydrated text identical.
		timeZone: restaurant.timeZone
	};
};

const idleLockSchema = z.object({
	posIdleLockSeconds: z.coerce.number().int().min(30).max(1800)
});

const IDLE_LOCK_RANGE_MESSAGE = 'Choose between 30 seconds and 30 minutes.';

const revokeSchema = z.object({ deviceId: z.string().uuid() });

export const actions: Actions = {
	revoke: async (event) => {
		// Guarded AGAIN, inside the action: a form action is a separately reachable
		// POST endpoint (invariant 8), and the principal is needed for the stamp.
		const user = requirePermission(event, 'admin.devices');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();
		const parsed = revokeSchema.safeParse({ deviceId: form.get('deviceId') });
		if (!parsed.success) return fail(400, { message: 'Choose a device to revoke.' });

		const { ip, userAgent } = requestContext(event);

		// ONE transaction: the stamp and its audit row commit together or not at all
		// (invariant 10). revokeDevice scopes by id AND this restaurant AND "not yet
		// revoked", stamps revoked_at and revoked_by_user_id together, and never
		// deletes the row — the registration and its revocation are the trail of who
		// had a till cookie and when.
		const revoked = await db.transaction(async (tx) => {
			const stamped = await revokeDevice(tx, {
				deviceId: parsed.data.deviceId,
				restaurantId,
				actorUserId: user.userId
			});
			// Already revoked, another restaurant's, or unknown: change nothing and write
			// no audit row.
			if (!stamped) return null;

			// details is exactly T-14's { deviceCode, label }, both from revokeDevice's
			// return. No deviceId: this is a dashboard event by a dashboard session, and
			// audit_log.device_id is "null for every dashboard event".
			await writeAudit(tx, {
				restaurantId,
				actorUserId: user.userId,
				subjectUserId: null,
				event: 'pos.device.revoked',
				details: { deviceCode: stamped.deviceCode, label: stamped.label },
				ip,
				userAgent
			});
			return stamped;
		});

		// Nothing clears a cookie here: the device cookie is on the tablet, not in this
		// browser. The revocation takes effect on the tablet's NEXT request, because
		// validateDeviceToken refuses a row whose revoked_at is set.
		return {
			message: revoked
				? 'Device revoked. It can no longer show the PIN screen.'
				: 'That device was already revoked.'
		};
	},

	setIdleLock: async (event) => {
		// admin.settings, a DIFFERENT key from the load's admin.devices: this writes a
		// restaurant setting. Guarded here, in the action — a form action is a
		// separately reachable POST endpoint (invariant 8).
		const user = requirePermission(event, 'admin.settings');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();
		const parsed = idleLockSchema.safeParse({
			posIdleLockSeconds: form.get('posIdleLockSeconds')
		});
		if (!parsed.success) return fail(400, { message: IDLE_LOCK_RANGE_MESSAGE });

		const { ip, userAgent } = requestContext(event);

		// updateSettings() and NOTHING else: it writes the settings.updated audit row
		// in this same transaction (invariant 10). A direct
		// tx.update(restaurantSettings) would change the setting with no audit row.
		const result = await db.transaction((tx) =>
			updateSettings(
				tx,
				restaurantId,
				{ posIdleLockSeconds: parsed.data.posIdleLockSeconds },
				{ actorUserId: user.userId, ip, userAgent }
			)
		);

		if (!result.ok) {
			return fail(400, {
				message:
					result.reason === 'invalid_idle_lock'
						? IDLE_LOCK_RANGE_MESSAGE
						: 'That setting could not be saved.'
			});
		}
		return { message: result.changed ? 'Auto-lock saved.' : 'No change to save.' };
	}
};
