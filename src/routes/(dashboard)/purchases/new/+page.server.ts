import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { PAID_BY, listIngredients, recordPurchase, todayInZone } from '$lib/server/inventory';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import {
	CURRENCY_MESSAGE,
	INITIAL_FORM_LINES,
	MAX_FORM_LINES,
	PAID_BY_HINT,
	PAID_BY_LABELS,
	createPurchaseSchema,
	firstMessage,
	lineMessage,
	readLines,
	unitOptionValue,
	type LineValues
} from '../helpers';

// RECORD A DELIVERY (spec 19: purchases in purchase units, paid now or on
// credit). The load and the action check admin.purchases first (invariant 8).
// The tenant comes from locals, never from the form. The business date is the
// owner's choice, defaulting to today in the restaurant's zone (invariant 11).
//
// THE PAGE IS GATED ON THE CURRENCY, exactly as /menu is: without a currency
// there is no exponent to read a typed total with, so the total inputs are
// disabled with the reason and the action refuses with the same sentence.
//
// A line picks ONE "Ingredient — unit" option whose value carries both ids, so
// no client script is needed to filter units by ingredient; recordPurchase
// refuses a unit that is not the ingredient's, archived, or foreign anyway.

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

type Values = {
	supplierName: string;
	businessDate: string;
	paidBy: string;
	note: string;
	lines: LineValues[];
};

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.purchases');
	const { restaurantId, format } = await scope(event.locals);
	const [ingredients, today] = await Promise.all([
		listIngredients(db, restaurantId, { includeArchived: false }),
		todayInZone(db, restaurantId)
	]);
	return {
		today,
		currency: format ? { code: format.code } : null,
		maxLines: MAX_FORM_LINES,
		initialRows: INITIAL_FORM_LINES,
		paidByOptions: PAID_BY.map((value) => ({ value, label: PAID_BY_LABELS[value] })),
		paidByHint: PAID_BY_HINT,
		unitOptions: ingredients.flatMap((ingredient) =>
			ingredient.purchaseUnits.map((unit) => ({
				value: unitOptionValue(ingredient.id, unit.id),
				label: `${ingredient.name} — ${unit.name}`
			}))
		),
		// Named so the page can say why they are missing from the list.
		withoutUnits: ingredients
			.filter((ingredient) => ingredient.purchaseUnits.length === 0)
			.map((ingredient) => ingredient.name)
	};
};

export const actions: Actions = {
	create: async (event) => {
		const user = requirePermission(event, 'admin.purchases');
		const { restaurantId, format } = await scope(event.locals);
		const form = await event.request.formData();
		const text = (name: string) => {
			const value = form.get(name);
			return typeof value === 'string' ? value : '';
		};
		const values: Values = {
			supplierName: text('supplierName'),
			businessDate: text('businessDate'),
			paidBy: text('paidBy'),
			note: text('note'),
			lines: []
		};
		if (!format) return fail(400, { message: CURRENCY_MESSAGE, values });

		const lines = readLines(form, format.exponent);
		values.lines = lines.values;
		const parsed = createPurchaseSchema.safeParse(values);
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error), values });
		if (!lines.ok) return fail(400, { message: lines.message, values });

		const { ip, userAgent } = requestContext(event);
		const result = await db.transaction((tx) =>
			recordPurchase(
				tx,
				{ restaurantId, actorUserId: user.userId, ip, userAgent },
				{
					supplierName: parsed.data.supplierName,
					businessDate: parsed.data.businessDate,
					paidBy: parsed.data.paidBy,
					note: parsed.data.note === '' ? null : parsed.data.note,
					lines: lines.lines.map((line) => ({
						ingredientId: line.ingredientId,
						purchaseUnitId: line.purchaseUnitId,
						unitQty: line.unitQty,
						lineCostMinor: line.lineCostMinor
					}))
				}
			)
		);
		if (!result.ok) {
			if (result.reason === 'invalid_line') {
				// The module counts the lines it was given; the owner sees form rows.
				const row = lines.lines[result.lineNo - 1]?.row ?? result.lineNo;
				return fail(400, { message: lineMessage(row), values });
			}
			if (result.reason === 'no_lines') {
				return fail(400, { message: 'Add at least one line.', values });
			}
			return fail(400, { message: `A delivery has at most ${MAX_FORM_LINES} lines.`, values });
		}
		redirect(303, `/purchases/${result.purchaseId}`);
	}
};
