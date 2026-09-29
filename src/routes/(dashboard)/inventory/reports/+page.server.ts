import { error, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import {
	cogsByDate,
	consumptionByDate,
	negativeStock,
	reconciliation,
	todayInZone,
	wasteByDate
} from '$lib/server/inventory';
import { add } from '$lib/money';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import {
	amountText,
	isBusinessDate,
	qtyText,
	shiftBusinessDate,
	signedQtyText,
	wasteReasonText
} from '../helpers';

// THE INVENTORY REPORTS (spec 26: Consumption, Waste, Negative Stock Alerts,
// COGS). Plain indexed SQL in the module (spec 27); every figure is grouped by
// BUSINESS DATE (invariant 11). admin.inventory first (invariant 8). Every
// amount leaves as the formatter's string; the one sum here (sales COGS plus
// revaluations) goes through the money module's add (invariant 1).

const RANGE_MESSAGE = 'Dates must be YYYY-MM-DD, from on or before to.';
const DEFAULT_DAYS = 7;

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

	const rawFrom = event.url.searchParams.get('from');
	const rawTo = event.url.searchParams.get('to');
	for (const raw of [rawFrom, rawTo]) {
		if (raw !== null && !isBusinessDate(raw)) error(400, RANGE_MESSAGE);
	}
	// The default range is the seven business days ending today in the
	// restaurant's zone (computed in SQL, never from the server clock).
	const to = rawTo ?? (await todayInZone(db, restaurantId));
	const from = rawFrom ?? shiftBusinessDate(to, -(DEFAULT_DAYS - 1));
	// YYYY-MM-DD strings order the same way as the dates they name.
	if (from > to) error(400, RANGE_MESSAGE);

	const [used, waste, cogs, negative, rec] = await Promise.all([
		consumptionByDate(db, restaurantId, from, to),
		wasteByDate(db, restaurantId, from, to),
		cogsByDate(db, restaurantId, from, to),
		negativeStock(db, restaurantId),
		reconciliation(db, restaurantId)
	]);

	return {
		from,
		to,
		consumption: used.map((r) => ({
			id: `${r.businessDate}:${r.ingredientId}`,
			businessDate: r.businessDate,
			name: r.name,
			qty: qtyText(r.qty, r.baseUnit),
			cost: amountText(r.costMinor, format),
			costNegative: r.costMinor < 0n
		})),
		waste: waste.map((w) => ({
			id: w.wasteId,
			businessDate: w.businessDate,
			name: w.name,
			qty: qtyText(w.qty, w.baseUnit),
			reason: wasteReasonText(w.reason),
			note: w.note,
			cost: amountText(w.costMinor, format),
			costNegative: w.costMinor < 0n
		})),
		cogs: cogs.map((c) => {
			const total = add(c.cogsMinor, c.revaluationMinor);
			return {
				id: c.businessDate,
				businessDate: c.businessDate,
				sales: amountText(c.cogsMinor, format),
				salesNegative: c.cogsMinor < 0n,
				revaluation: amountText(c.revaluationMinor, format),
				revaluationNegative: c.revaluationMinor < 0n,
				total: amountText(total, format),
				totalNegative: total < 0n
			};
		}),
		negative: negative.map((n) => ({
			id: n.id,
			name: n.name,
			onHand: signedQtyText(n.onHandQty, n.baseUnit)
		})),
		reconciliation: {
			stockValue: amountText(rec.stockValueMinor, format),
			ledger1200: amountText(rec.ledger1200Minor, format),
			difference: amountText(rec.differenceMinor, format),
			differs: rec.differenceMinor !== 0n || rec.driftCount > 0,
			differenceNegative: rec.differenceMinor < 0n,
			driftCount: rec.driftCount
		}
	};
};
