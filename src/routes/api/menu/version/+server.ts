import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireDevice } from '$lib/server/auth/pos-context';
import { getMenuVersion } from '$lib/server/menu';
import { MENU_CACHE_HEADERS, ifNoneMatchMatches, menuEtag } from '../etag';

// GET /api/menu/version — spec 5: "GET /api/menu/version → 183 … HTTP caching
// (ETag) makes the version check nearly free". The till compares this integer
// with its own and downloads the FULL snapshot (GET /api/menu) only when they
// differ.
//
// DEVICE-AUTHENTICATED (invariants 8 and 12): requireDevice is the first line, and
// answers 403 for a missing, unknown or revoked device cookie. The tenant is the
// DEVICE ROW's — locals.restaurantId is null here by design, and no query
// parameter is read — so a till can never be served another restaurant's version.
//
// THE POS SERVICE WORKER IS NETWORK-ONLY FOR /api (T-27), so this endpoint is
// never answered out of Cache Storage. A cache-first worker here would defeat the
// only refresh mechanism spec 5 defines: the till would compare its stale cached
// version with itself and conclude, forever, that nothing had changed.
//
// GET only: there is no POST, PUT or DELETE on this route.

export const GET: RequestHandler = async (event) => {
	// FIRST: 403 for a missing, unknown or revoked device — before any read.
	const device = await requireDevice(event);

	const version = await getMenuVersion(db, device.restaurantId);
	const etag = menuEtag(device.restaurantId, version);
	const headers = { ETag: etag, ...MENU_CACHE_HEADERS };

	if (ifNoneMatchMatches(event.request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}
	// The restaurant travels beside the version so the till can tell a moved
	// tablet's menu from a current one: it replaces its copy on either mismatch.
	return json({ version, restaurantId: device.restaurantId }, { headers });
};
