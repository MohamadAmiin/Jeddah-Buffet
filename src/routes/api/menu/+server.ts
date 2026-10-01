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
// TAX RATES ARE NAMED AND RESOLVED (tasks/settings-tax-payments-receipt T-13).
// `format: 2` marks this shape. `defaultTaxRate` is the restaurant's named default
// `{ id, name, rateBp }`, or null while the owner has not picked one; each item's
// `taxRate` is the rate the till must charge for it — the item's own named rate,
// else the default, else null — resolved by readMenuSnapshot, archived rates
// included (spec 6). A line snapshots the rate's number, id and name at the moment
// of sale (invariant 7).
//
// The LEGACY keys stay for tills still running an older shell: the top-level
// `taxRateBp` is the default's number (`defaultTaxRate?.rateBp ?? null`) and each
// item's `taxRateBp` is its RESOLVED number (`taxRate?.rateBp ?? null`). An old
// till treats a non-null item number as the item's own rate, which is exactly the
// resolved rate, so it charges what the server will validate. A till that knows
// format 2 (MENU_FORMAT in src/lib/pos/menu-snapshot.ts, T-18) replaces a copy in
// an older format even at an equal version (risk 4). Nothing here falls back to a
// number when no rate resolves: null stays null (risk 5).
//
// PHOTOS: a photo travels as its id (imageId, or null); the till fetches the
// bytes from /api/menu/images/[id]. The snapshot never carries bytes.

// Must equal MENU_FORMAT in src/lib/pos/menu-snapshot.ts (T-18); a till holding an
// older format replaces its copy even at an equal version (risk 4).
const MENU_FORMAT = 2;

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
			format: MENU_FORMAT,
			// The till binds its copy to this: a tablet moved to another restaurant
			// replaces its menu even when the two version numbers happen to agree.
			restaurantId: device.restaurantId,
			takenAt: new Date().toISOString(),
			currency: snapshot.currencyCode,
			currencyExponent,
			taxMode: snapshot.taxMode,
			defaultTaxRate: snapshot.defaultTaxRate,
			// Legacy (pre-format-2 tills): the default's number, or null.
			taxRateBp: snapshot.defaultTaxRate?.rateBp ?? null,
			categories: snapshot.categories.map((category) => ({
				id: category.id,
				name: category.name,
				sortOrder: category.sortOrder
			})),
			items: snapshot.items.map((item) => ({
				id: item.id,
				categoryId: item.categoryId,
				imageId: item.imageId,
				name: item.name,
				priceMinor: item.priceMinor.toString(),
				taxRate: item.taxRate,
				// Legacy (pre-format-2 tills): the RESOLVED number, or null.
				taxRateBp: item.taxRate?.rateBp ?? null,
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
