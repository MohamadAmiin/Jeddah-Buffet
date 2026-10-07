import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireDevice } from '$lib/server/auth/pos-context';
import { readReceiptLogo } from '$lib/server/restaurants';

// GET /api/pos/receipt-logo — the receipt logo's bytes for the till (spec 11, 4;
// tasks/settings-tax-payments-receipt T-20). The settings bundle from
// /api/pos/employees carries only the logo's fingerprint { sha256, widthDots,
// heightDots }; the till fetches the bitmap here, and only when that fingerprint
// differs from the one it has cached (T-21).
//
// DEVICE-GUARDED exactly like /api/menu/images/[id]: 403 for a missing, unknown
// or revoked device BEFORE any read (invariant 8 — a read is not exempt), and the
// tenant is the DEVICE ROW's restaurant (invariant 12) — the route takes no
// parameter at all, so there is no id to forge and nothing to leak.
//
// no-store, NOT the immutable/private caching the menu photos use: the till keeps
// the bytes in IndexedDB (T-21), which is what makes the logo print offline, and
// the browser's HTTP cache would only hold a copy a replaced logo leaves stale.
// The route is under /api, outside the service worker's /pos scope, so the worker
// never sees it — and it must not be taught to (CLAUDE.md, service-worker policy,
// part 6: the shell is the only document ever written to Cache Storage).
//
// The bitmap is PLAIN PIXEL DATA (1-bit rows, MSB first), base64 with padding —
// exactly what the print agent's parseJob accepts (T-25). The agent, never the
// server or the till, turns it into printer command bytes (risk 6).

export const GET: RequestHandler = async (event) => {
	// FIRST: 403 for a missing, unknown or revoked device cookie — before any read.
	const device = await requireDevice(event);

	const logo = await readReceiptLogo(db, device.restaurantId);

	const headers = { 'cache-control': 'no-store' };
	// json(), not error(404): the till parses the body to tell "no logo" (clear
	// its cached one) from a failure (keep it).
	if (!logo) return json({ error: 'no_logo' }, { status: 404, headers });

	return json(
		{
			sha256: logo.sha256,
			widthDots: logo.widthDots,
			heightDots: logo.heightDots,
			bitmap: Buffer.from(logo.bitmap).toString('base64')
		},
		{ status: 200, headers }
	);
};
