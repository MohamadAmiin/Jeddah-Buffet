import { error, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { countDifferences, listCounts } from '$lib/server/inventory';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { amountText, signedQtyText } from '../../helpers';

// ONE POSTED COUNT (spec 26: Stock Count Differences). Read only: a posted count
// is permanent (invariant 2). admin.inventory first (invariant 8); a count of
// another restaurant, or an id that is not a count at all, answers 404.

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
	requirePermission(event, 'admin.inventory');
	const { restaurantId, format } = await scope(event.locals);
	const id = z.uuid().safeParse(event.params.id);
	if (!id.success) error(404, 'Count not found');

	// listCounts is restaurant-scoped: a foreign id is simply not in it.
	const count = (await listCounts(db, restaurantId)).find((c) => c.id === id.data);
	if (!count) error(404, 'Count not found');
	const lines = await countDifferences(db, restaurantId, count.id);

	return {
		count: {
			id: count.id,
			businessDate: count.businessDate,
			note: count.note,
			lineCount: count.lineCount,
			shortfall: amountText(count.shortfallMinor, format),
			surplus: amountText(count.surplusMinor, format)
		},
		lines: lines.map((l) => ({
			id: l.ingredientId,
			name: l.name,
			system: signedQtyText(l.systemQty, l.baseUnit),
			systemNegative: l.systemQty < 0n,
			counted: signedQtyText(l.countedQty, l.baseUnit),
			difference: signedQtyText(l.differenceQty, l.baseUnit),
			differenceNegative: l.differenceQty < 0n,
			value: amountText(l.costMinor, format),
			valueNegative: l.costMinor < 0n
		}))
	};
};
