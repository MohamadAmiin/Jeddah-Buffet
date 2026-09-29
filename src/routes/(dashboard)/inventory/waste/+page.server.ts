import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { listIngredients, recordWaste, todayInZone, wasteByDate } from '$lib/server/inventory';
import { parseQty, type Qty } from '$lib/money/quantity';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import {
	amountText,
	firstMessage,
	qtyText,
	shiftBusinessDate,
	wasteReasonText,
	wasteSchema
} from '../helpers';

// THE WASTE PAGE (spec 15, 26: Waste). Goods thrown away leave stock at the
// average through the module's one ledger writer and post Dr 5100 / Cr 1200
// (invariant 6). Every load and every action checks admin.inventory first
// (invariant 8); the tenant comes from locals. The page renders strings only.

const RECENT_DAYS = 30;
const RECENT_LIMIT = 50;

const REFUSALS = {
	not_found: 'That ingredient no longer exists. Reload the page.',
	ingredient_archived: 'That ingredient is archived. Choose another one.',
	note_required: 'Say what happened in a note of 3 to 200 characters when the reason is Other.',
	invalid_qty: 'Enter a quantity above zero, with at most three decimals.'
} as const;

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
	const today = await todayInZone(db, restaurantId);
	const [live, waste] = await Promise.all([
		listIngredients(db, restaurantId, { includeArchived: false }),
		wasteByDate(db, restaurantId, shiftBusinessDate(today, -(RECENT_DAYS - 1)), today)
	]);
	return {
		today,
		ingredients: live.map((i) => ({ id: i.id, name: i.name, baseUnit: i.baseUnit })),
		// wasteByDate is oldest first; the page lists the newest first.
		entries: waste
			.slice(-RECENT_LIMIT)
			.reverse()
			.map((w) => ({
				id: w.wasteId,
				businessDate: w.businessDate,
				name: w.name,
				qty: qtyText(w.qty, w.baseUnit),
				reason: wasteReasonText(w.reason),
				note: w.note,
				cost: amountText(w.costMinor, format)
			}))
	};
};

export const actions: Actions = {
	record: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const form = await event.request.formData();
		const parsed = wasteSchema.safeParse({
			ingredientId: form.get('ingredientId') ?? '',
			qty: form.get('qty') ?? '',
			reason: form.get('reason') ?? '',
			note: form.get('note') ?? '',
			businessDate: form.get('businessDate') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		let wasted: Qty;
		try {
			wasted = parseQty(parsed.data.qty);
		} catch {
			return fail(400, { message: REFUSALS.invalid_qty });
		}

		const { ip, userAgent } = requestContext(event);
		const result = await db.transaction((tx) =>
			recordWaste(
				tx,
				{ restaurantId, actorUserId: user.userId, ip, userAgent },
				{
					ingredientId: parsed.data.ingredientId,
					qty: wasted,
					reason: parsed.data.reason,
					note: parsed.data.note || null,
					businessDate: parsed.data.businessDate
				}
			)
		);
		if (!result.ok) return fail(400, { message: REFUSALS[result.reason] });
		redirect(303, '/inventory/waste');
	}
};
