import { error, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { listPurchases } from '$lib/server/inventory';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { PAID_BY_LABELS, amountText } from './helpers';

// THE DELIVERIES LIST (spec 19, 26: Purchases). The load checks admin.purchases
// first (invariant 8). The tenant comes from locals, never from the query
// string. Every amount leaves as the formatter's string; the page computes
// nothing. A reversed delivery stays in the list, marked ↩ (invariant 2).

async function scope(
	locals: App.Locals
): Promise<{ restaurantId: string; format: MoneyFormat | null }> {
	const restaurantId = locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');
	return {
		restaurantId,
		format: restaurant.currencyCode === null ? null : moneyFormatFor(restaurant.currencyCode)
	};
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.purchases');
	const { restaurantId, format } = await scope(event.locals);
	const rows = await listPurchases(db, restaurantId, { limit: 100 });
	return {
		purchases: rows.map((row) => ({
			id: row.id,
			supplierName: row.supplierName,
			businessDate: row.businessDate,
			paidBy: PAID_BY_LABELS[row.paidBy],
			total: amountText(row.totalMinor, format),
			// Only a live credit delivery can owe anything.
			outstanding:
				row.paidBy === 'credit' && !row.reversed ? amountText(row.outstandingMinor, format) : null,
			status: row.reversed ? 'reversed' : row.outstandingMinor > 0n ? 'owed' : 'settled'
		}))
	};
};
