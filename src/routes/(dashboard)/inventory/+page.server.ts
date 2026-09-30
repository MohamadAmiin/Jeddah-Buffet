import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { createIngredient, currentStock, reconciliation } from '$lib/server/inventory';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { amountText, createIngredientSchema, firstMessage, qtyText } from './helpers';

// THE INVENTORY PAGE (spec 26: Current Stock, Negative Stock Alerts). Every load
// and every action checks admin.inventory first (invariant 8): a form action is
// a separately reachable POST. The tenant comes from locals, never from the form
// or the query string. Every amount leaves as the formatter's string and every
// quantity as formatQty's; the page computes nothing.
//
// THE TRIPWIRE (invariant 6; CLAUDE.md "Inventory 13"): when the stock value
// differs from account 1200, or an ingredient's cache differs from its
// movements, the page says so. It offers no rebuild button.

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
	const [stock, rec] = await Promise.all([
		currentStock(db, restaurantId),
		reconciliation(db, restaurantId)
	]);
	const differs = rec.differenceMinor !== 0n || rec.driftCount > 0;
	return {
		ingredients: stock.map((row) => ({
			id: row.id,
			name: row.name,
			archived: row.archived,
			onHand: qtyText(row.onHandQty, row.baseUnit),
			perUnit: amountText(row.perUnit.costMinor, format),
			perUnitName: row.perUnit.unitName,
			value: amountText(row.valueMinor, format),
			valueNegative: row.valueMinor < 0n,
			negative: row.negative,
			drift: row.drift
		})),
		mismatch: differs
			? {
					difference: amountText(rec.differenceMinor, format),
					driftCount: rec.driftCount
				}
			: null
	};
};

export const actions: Actions = {
	createIngredient: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const form = await event.request.formData();
		const parsed = createIngredientSchema.safeParse({
			name: form.get('name') ?? '',
			baseUnit: form.get('baseUnit') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const { ip, userAgent } = requestContext(event);
		const result = await db.transaction((tx) =>
			createIngredient(
				tx,
				{ restaurantId, actorUserId: user.userId, ip, userAgent },
				{ name: parsed.data.name, baseUnit: parsed.data.baseUnit }
			)
		);
		if (!result.ok) return fail(400, { message: 'An ingredient with this name already exists.' });
		redirect(303, `/inventory/${result.id}`);
	}
};
