import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireDevice } from '$lib/server/auth/pos-context';
import { imageResponse, readImage } from '$lib/server/menu/images';

// GET /api/menu/images/[id] — a menu photo's bytes for the till (spec 4, 5;
// tasks/menu-and-printing T-08). The snapshot from /api/menu carries only the
// id; the till fetches the picture here and lets the browser's HTTP cache keep
// it (the response is immutable and private), which is what makes photos
// best-effort offline without the service worker ever writing to Cache Storage
// (CLAUDE.md's service-worker policy, part 6, unchanged).
//
// DEVICE-AUTHENTICATED exactly as /api/menu is: 403 for a missing, unknown or
// revoked device BEFORE any read, and the tenant is the device row's restaurant
// — never the URL's. A photo id from another restaurant is a 404, not a leak.
// A malformed id is a 404 too (readImage never queries it), never a 500.

export const GET: RequestHandler = async (event) => {
	// FIRST: 403 for a missing, unknown or revoked device — before any read.
	const device = await requireDevice(event);

	const image = await readImage(db, device.restaurantId, event.params.id ?? '');
	if (!image) error(404, 'Not found');
	return imageResponse(image);
};
