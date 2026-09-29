import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { imageResponse, readImage } from '$lib/server/menu/images';

// GET /menu/images/[id] — a menu photo's bytes for the dashboard's /menu page
// (tasks/menu-and-printing T-08). The URL lives under /menu, never under /pos:
// the POS service worker's scope is a string prefix, and a dashboard route
// beginning with "pos" would fall under it (CLAUDE.md, service-worker policy,
// part 4).
//
// GUARDED BY THE ROUTE ITSELF (invariant 8, reads included): requirePermission
// FIRST, then the tenant from event.locals.restaurantId — the session's, never a
// query parameter — the same guard /menu's load uses. Another restaurant's photo
// id is a 404; a malformed id is a 404; nothing here is a 500 a visitor can
// provoke. The response is immutable and private: a photo row is never edited,
// so the owner's browser may keep it for a year.

export const GET: RequestHandler = async (event) => {
	requirePermission(event, 'admin.menu');
	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const image = await readImage(db, restaurantId, event.params.id ?? '');
	if (!image) error(404, 'Not found');
	return imageResponse(image);
};
