import type { ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { listCustomers, receivableTripwire } from '$lib/server/customers';
import { amountText } from './helpers';
import { scope } from './scope.server';

// THE CUSTOMERS LIST (tasks/customer-credit T-21). The load checks
// admin.customers first (invariant 8); the tenant comes from locals. Every amount
// leaves as the formatter's string; the page computes nothing.
//
// THE TRIPWIRE: the sum of every customer's balance beside the net of account
// 1100 Accounts Receivable. They are equal by construction; a difference means a
// row reached one side without the other, and the page says so in words.

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.customers');
	const { restaurantId, format } = await scope(event.locals);
	const showArchived = event.url.searchParams.get('archived') === '1';

	const rows = await listCustomers(db, restaurantId, { include: showArchived ? 'all' : 'live' });
	const tripwire = await receivableTripwire(db, restaurantId);

	return {
		showArchived,
		currency: format ? { code: format.code } : null,
		totalOwed: amountText(tripwire.sumOfBalances, format),
		tripwire: tripwire.matches
			? null
			: {
					balances: amountText(tripwire.sumOfBalances, format),
					ledger: amountText(tripwire.ledger1100, format)
				},
		customers: rows.map((row) => ({
			id: row.id,
			name: row.name,
			phone: row.phone,
			limit: row.creditLimitMinor === null ? null : amountText(row.creditLimitMinor, format),
			balance: amountText(row.balanceMinor, format),
			owes: row.balanceMinor > 0n,
			archived: row.archivedAt !== null
		}))
	};
};
