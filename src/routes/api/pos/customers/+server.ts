import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireDevice } from '$lib/server/auth/pos-context';
import { getCreditMethod } from '$lib/server/restaurants';
import { listCustomers } from '$lib/server/customers';

// GET /api/pos/customers — the customers a till may charge and collect from
// (tasks/customer-credit T-13).
//
// DEVICE-GUARDED exactly like /api/pos/receipt-logo: 403 for a missing, unknown
// or revoked device BEFORE any read (invariant 8 — a read is not exempt), and the
// tenant is the DEVICE ROW's restaurant (invariant 12). The route takes no
// parameter at all, so there is no id to forge.
//
// WHO IS LISTED: every live customer (payOnly false), plus each ARCHIVED customer
// who still owes (payOnly true) — a debt must stay collectable, so the till can
// take their payment, but it never offers them as a credit tender.
//
// `creditEnabled` is the owner's Customer credit switch, sent with every refresh
// so a signed-in till drops the credit tender soon after the owner switches it
// off. It never gates the list: switching credit off stops new charges, not a
// customer paying what they owe.
//
// EXACTLY six keys per customer, mapped by name and never spread. Money is a
// decimal string of minor units, like every amount on the till's wire.
//
// The device check says nothing about WHO is signed in (CLAUDE.md, decision
// (g)), so the till itself asks only while the signed-in employee holds
// pos.payment and shows the list to nobody else. That is UX; the residual —
// names, phones and balances sit in a registered till's storage — is an accepted
// risk recorded in tasks/customer-credit/00-overview.md.
//
// no-store: the till keeps its copy in IndexedDB. The route is under /api,
// outside the service worker's /pos scope, and must stay that way.

export const GET: RequestHandler = async (event) => {
	// FIRST: 403 for a missing, unknown or revoked device cookie — before any read.
	const device = await requireDevice(event);

	const credit = await getCreditMethod(db, device.restaurantId);
	const customers = await listCustomers(db, device.restaurantId, { include: 'collectable' });

	return json(
		{
			creditEnabled: credit?.enabled === true,
			customers: customers.map((c) => ({
				id: c.id,
				name: c.name,
				phone: c.phone,
				creditLimitMinor: c.creditLimitMinor === null ? null : c.creditLimitMinor.toString(),
				balanceMinor: c.balanceMinor.toString(),
				payOnly: c.archivedAt !== null
			}))
		},
		{ status: 200, headers: { 'cache-control': 'no-store' } }
	);
};
