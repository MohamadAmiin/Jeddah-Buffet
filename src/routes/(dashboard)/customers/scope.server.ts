import { error, type RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import type { CustomerWriteContext } from '$lib/server/customers';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';

// Shared by the three Customers routes. NOT a guard: every load and every action
// calls requirePermission(event, 'admin.customers') itself, first (invariant 8).

/** The tenant from the session — never from a form or the URL — and its currency. */
export async function scope(
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

export function context(
	event: RequestEvent,
	restaurantId: string,
	actorUserId: string
): CustomerWriteContext {
	return { restaurantId, actorUserId, ...requestContext(event) };
}
