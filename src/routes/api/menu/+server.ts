import { error, json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireDevice } from '$lib/server/auth/pos-context';
import { readMenuSnapshot } from '$lib/server/menu';
import { moneyFormatFor } from '$lib/money/format';
import { MENU_CACHE_HEADERS, ifNoneMatchMatches, menuEtag } from './etag';

// GET /api/menu — spec 5: on a version mismatch "the POS downloads the FULL menu
// snapshot and replaces its local copy". Change-only sync is on the Later list
// and on CLAUDE.md's do-not-build list: there is no ?from=, no diff, no "changed
// since" branch, and GET is the only method.
//
// DEVICE-AUTHENTICATED exactly as /api/menu/version is, through the same helper:
// 403 for a missing, unknown or revoked device, and the tenant is the device row's.
//
// ONE SNAPSHOT: the version and every row are read in one repeatable-read,
// read-only transaction, so the version on the payload is the version of the rows
// in it. The validator is the one GET /api/menu/version sends (./etag), so a device
// that holds this snapshot can revalidate either endpoint with the same string.
//
// BIGINT DOES NOT SURVIVE JSON.stringify — it throws, inside the request, as a 500
// that names no field. Every *Minor value is therefore mapped EXPLICITLY to a
// decimal STRING (never spread from a row, never widened to a number, which above
// 2^53 silently loses precision and hands the till one multiplication away from a
// float). The till keeps the string and applies BigInt() in one read accessor.
//
// TAX RATES: each item carries its own taxRateBp, and null there means "inherit
// the restaurant rate" — the top-level taxRateBp beside it, which is why that is in
// the payload at all. Both may be null while the owner has not chosen; the server
// never pre-resolves the fallback onto the item. The till shows prices and totals
// nothing in this plan; the rates travel now so the sales plan can snapshot a
// line's rate at the moment of sale (invariant 7) without a second round trip.

export const GET: RequestHandler = async (event) => {
	// FIRST: 403 for a missing, unknown or revoked device — before any read.
	const device = await requireDevice(event);

	const snapshot = await db.transaction((tx) => readMenuSnapshot(tx, device.restaurantId), {
		isolationLevel: 'repeatable read',
		accessMode: 'read only'
	});

	const etag = menuEtag(device.restaurantId, snapshot.version);
	const headers = { ETag: etag, ...MENU_CACHE_HEADERS };
	if (ifNoneMatchMatches(event.request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}

	// The exponent is NOT a column: it is derived from the code, here in the route —
	// the menu module stays clear of src/lib/money. A stored code the formatter
	// cannot render is a bad row: a 500, never a guessed exponent.
	let currencyExponent: number | null = null;
	if (snapshot.currencyCode !== null) {
		try {
			currencyExponent = moneyFormatFor(snapshot.currencyCode).exponent;
		} catch {
			error(500, 'The stored currency cannot be formatted');
		}
	}

	return json(
		{
			version: snapshot.version,
			// The till binds its copy to this: a tablet moved to another restaurant
			// replaces its menu even when the two version numbers happen to agree.
			restaurantId: device.restaurantId,
			takenAt: new Date().toISOString(),
			currency: snapshot.currencyCode,
			currencyExponent,
			taxMode: snapshot.taxMode,
			taxRateBp: snapshot.taxRateBp,
			categories: snapshot.categories.map((category) => ({
				id: category.id,
				name: category.name,
				sortOrder: category.sortOrder
			})),
			items: snapshot.items.map((item) => ({
				id: item.id,
				categoryId: item.categoryId,
				name: item.name,
				priceMinor: item.priceMinor.toString(),
				taxRateBp: item.taxRateBp,
				isAvailable: item.isAvailable,
				sortOrder: item.sortOrder,
				modifierGroupIds: snapshot.links
					.filter((link) => link.menuItemId === item.id)
					.map((link) => link.modifierGroupId)
			})),
			modifierGroups: snapshot.modifierGroups.map((group) => ({
				id: group.id,
				name: group.name,
				minSelect: group.minSelect,
				maxSelect: group.maxSelect,
				modifiers: snapshot.modifiers
					.filter((modifier) => modifier.groupId === group.id)
					.map((modifier) => ({
						id: modifier.id,
						name: modifier.name,
						priceDeltaMinor: modifier.priceDeltaMinor.toString()
					}))
			}))
		},
		{ headers }
	);
};
