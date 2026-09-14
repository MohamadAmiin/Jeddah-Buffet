import { error, type ServerLoad } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { db } from '$lib/server/db/client';
import { settingsComplete } from '$lib/server/restaurants';

export const load: ServerLoad = async (event) => {
	// Its own guard, even though the hook already guards the group and the layout
	// guards too (invariant 8: reads included).
	requirePermission(event, 'admin.settings');

	// From locals, which T-17 sets for dashboard routes ONLY. Never from a form
	// body or a URL parameter.
	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	// Computed through settingsComplete() rather than by checking that a settings
	// row exists. The row is created by registration, so an existence check would
	// always say "done" — and the moment a later plan adds a required setting such
	// as tax mode or currency, it would KEEP saying done while the restaurant is
	// not in fact configured, and the owner would open their first POS session with
	// a tax mode nobody chose. settingsComplete() is the extension point.
	const settings = await settingsComplete(db, restaurantId);

	return { settings };
};
