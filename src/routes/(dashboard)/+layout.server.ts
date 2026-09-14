import type { ServerLoad } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { db } from '$lib/server/db/client';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { RAIL_COOKIE, parseRail } from '$lib/rail';

export const load: ServerLoad = async (event) => {
	// admin.settings is the capability that means "may use the management
	// dashboard" in this plan. The hook already guards the group; this is the
	// second, independent layer — a hook is one refactor away from not matching a
	// route id it used to match (invariant 8).
	const user = requirePermission(event, 'admin.settings');

	const restaurant = event.locals.restaurantId
		? await getRestaurantWithSettings(db, event.locals.restaurantId)
		: null;

	// AN EXPLICIT OBJECT LITERAL. Never spread locals.user: SvelteKit serialises
	// load data into the page HTML and into __data.json, so a widened projection
	// would publish whatever Principal grows into. T-12 already narrows the query;
	// this is the second layer.
	return {
		restaurantName: restaurant?.name ?? null,
		displayName: user.displayName,
		role: user.role,
		// Read here so the rail renders in its final state on the first frame. Read
		// only — this load never writes the cookie, and the value never reaches a
		// guard or a permission decision.
		railCollapsed: parseRail(event.cookies.get(RAIL_COOKIE))
	};
};
