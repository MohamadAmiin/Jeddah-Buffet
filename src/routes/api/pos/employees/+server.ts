import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireDevice } from '$lib/server/auth/pos-context';
import { listPosEmployees } from '$lib/server/auth/employee-directory';
import { getRestaurantWithSettings } from '$lib/server/restaurants';

// GET /api/pos/employees — the till's employee-select list, and its settings.
//
// WHY THE PIN HASH IS IN THIS RESPONSE (`pinPhc` on every entry). Spec 6 requires
// offline employee switching from PIN hashes cached on the registered device, so
// the bundle has to reach the device. RESEARCH.md beside the plan records the GAP,
// and the owner ACCEPTED it (CLAUDE.md, "Decisions already made"): a 4–6 digit PIN
// has at most 10^6 values, so whoever holds the tablet holds the hashes and
// unlimited offline guesses, and no hash algorithm changes that. The compensating
// controls: this bundle is served ONLY to a registered device (requireDevice,
// below — a GET is not exempt from invariant 8, and this read ships
// password-equivalent material); the owner can revoke that device from the
// dashboard; and every action that moves money needs an owner-PIN approval.
// Do not soften or drop this comment.
//
// The tenant is the DEVICE ROW's, and never a query parameter, a body or the
// request's dashboard tenant — the hook leaves that null outside /(dashboard) so a
// route that reaches for it by habit fails loudly instead of serving the wrong
// restaurant.

export const GET: RequestHandler = async (event) => {
	// FIRST: 403 for a missing, unknown or revoked device cookie.
	const device = await requireDevice(event);

	// T-15's read model IS the projection — five keys per entry, active employees
	// of this restaurant only, owner included, PIN-less employees returned with
	// pinPhc null. Returned as-is: not widened, not narrowed, not re-mapped, and the
	// field keeps its name, because the name is a tripwire against writeAudit.
	const employees = await listPosEmployees(db, device.restaurantId);

	// THE ONLY TRANSPORT this plan gives the till for a restaurant setting. The till
	// has no server load by design, so without this block no idle timer could ever
	// run. The idle lock is NULLABLE with no default anywhere (CLAUDE.md, decision of
	// 2026-09-15): null travels as null — a number substituted here would silently
	// answer the setting for every restaurant whose owner never chose one.
	const restaurant = await getRestaurantWithSettings(db, device.restaurantId);
	const settings = { posIdleLockSeconds: restaurant?.posIdleLockSeconds ?? null };

	// no-store: neither the browser's HTTP cache nor any intermediary keeps this
	// body. The till caches it deliberately in IndexedDB — a different store, with
	// a different lifetime and navigator.storage.persist() behind it.
	// device.id — the pos_devices uuid — is what the till binds its cache to (a code
	// like POS1 repeats in every restaurant). When it changes, the till drops every
	// bundle cached for the old device, so a tablet moved to another restaurant can
	// never sign the old restaurant's staff in from their cached PIN hashes.
	return json(
		{ device: { id: device.deviceId }, employees, settings },
		{ status: 200, headers: { 'cache-control': 'no-store' } }
	);
};
