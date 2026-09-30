import {
	error,
	fail,
	redirect,
	type Actions,
	type RequestEvent,
	type ServerLoad
} from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import {
	addPurchaseUnit,
	archiveIngredient,
	archivePurchaseUnit,
	currentStock,
	getIngredient,
	movementLog,
	recordOpeningStock,
	todayInZone,
	updateIngredient,
	type InventoryWriteContext
} from '$lib/server/inventory';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { parsePriceInput } from '../../menu/helpers';
import {
	CURRENCY_MESSAGE,
	addUnitSchema,
	amountText,
	archiveUnitSchema,
	firstMessage,
	ingredientIdSchema,
	movementLabel,
	movementSourceText,
	openingStockSchema,
	parsePositiveQty,
	qtyText,
	signedQtyText,
	updateIngredientSchema
} from '../helpers';

// ONE INGREDIENT (spec 15: base unit and purchase units; spec 26: Stock
// Movement; CLAUDE.md "Inventory 1": opening stock). Every load and every action
// checks admin.inventory first (invariant 8): a form action is a separately
// reachable POST. The tenant comes from locals; the ingredient id from the route,
// and an id outside the restaurant is a 404 on the load and not_found in an
// action. Every action is one transaction around one module call, and the module
// writes the audit row (invariant 10). The log reads the ledger (invariant 6).
// Every amount leaves as the formatter's string, every quantity as formatQty's:
// the page computes nothing (invariant 1).

const NOT_FOUND_MESSAGE = 'That ingredient no longer exists. Reload the page.';
const NAME_TAKEN_MESSAGE = 'An ingredient with this name already exists.';
const BASE_UNIT_LOCKED_MESSAGE = 'The base unit cannot change once stock has moved.';
const OPENING_MOVED_MESSAGE =
	'Opening stock can only be recorded before any stock has moved for this ingredient.';

async function scope(
	locals: App.Locals
): Promise<{ restaurantId: string; format: MoneyFormat | null }> {
	const restaurantId = locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');
	let format: MoneyFormat | null = null;
	if (restaurant.currencyCode !== null) {
		try {
			format = moneyFormatFor(restaurant.currencyCode);
		} catch {
			// Guessing an exponent is exactly what the currency gate forbids.
			error(500, 'The stored currency cannot be formatted');
		}
	}
	return { restaurantId, format };
}

/** The route's ingredient id, or null when it cannot name one. */
function idOf(event: RequestEvent): string | null {
	const parsed = ingredientIdSchema.safeParse(event.params.id);
	return parsed.success ? parsed.data : null;
}

function writeContext(
	event: RequestEvent,
	restaurantId: string,
	actorUserId: string
): InventoryWriteContext {
	const { ip, userAgent } = requestContext(event);
	return { restaurantId, actorUserId, ip, userAgent };
}

function here(id: string): string {
	return `/inventory/${id}`;
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.inventory');
	const { restaurantId, format } = await scope(event.locals);
	const id = idOf(event);
	if (!id) error(404, 'Ingredient not found');
	const ingredient = await getIngredient(db, restaurantId, id);
	if (!ingredient) error(404, 'Ingredient not found');

	const [log, stock, today] = await Promise.all([
		movementLog(db, restaurantId, id, { limit: 200 }),
		currentStock(db, restaurantId),
		todayInZone(db, restaurantId)
	]);
	const row = stock.find((s) => s.id === id);
	const hasMovements = log.length > 0;
	const archived = ingredient.archivedAt !== null;

	// AN EXPLICIT LITERAL: strings and flags only, never a bigint.
	return {
		currency: format ? { code: format.code } : null,
		today,
		ingredient: {
			id: ingredient.id,
			name: ingredient.name,
			baseUnit: ingredient.baseUnit,
			archived
		},
		onHand: qtyText(ingredient.onHandQty, ingredient.baseUnit),
		negative: ingredient.onHandQty < 0n,
		value: amountText(ingredient.valueMinor, format),
		valueNegative: ingredient.valueMinor < 0n,
		average: row
			? { amount: amountText(row.perUnit.costMinor, format), unitName: row.perUnit.unitName }
			: null,
		units: ingredient.purchaseUnits.map((unit) => ({
			id: unit.id,
			name: unit.name,
			holds: qtyText(unit.baseQtyPerUnit, ingredient.baseUnit)
		})),
		hasMovements,
		openingAllowed: !hasMovements && !archived,
		movements: log.map((m, index) => {
			const label = movementLabel(m.movementType);
			return {
				id: `m-${index}`,
				businessDate: m.businessDate,
				glyph: label.glyph,
				type: label.words,
				qty: signedQtyText(m.qty, ingredient.baseUnit),
				qtyNegative: m.qty < 0n,
				cost: amountText(m.costMinor, format),
				costNegative: m.costMinor < 0n,
				sourceType: m.sourceType,
				sourceId: m.sourceId,
				source: movementSourceText(m.sourceType)
			};
		})
	};
};

export const actions: Actions = {
	update: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const id = idOf(event);
		if (!id) return fail(400, { message: NOT_FOUND_MESSAGE });

		const form = await event.request.formData();
		const baseUnit = form.get('baseUnit');
		const parsed = updateIngredientSchema.safeParse({
			name: form.get('name') ?? '',
			baseUnit: baseUnit === null ? undefined : baseUnit
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const ctx = writeContext(event, restaurantId, user.userId);
		const result = await db.transaction((tx) =>
			updateIngredient(tx, ctx, id, { name: parsed.data.name, baseUnit: parsed.data.baseUnit })
		);
		if (!result.ok) {
			const messages = {
				not_found: NOT_FOUND_MESSAGE,
				name_taken: NAME_TAKEN_MESSAGE,
				has_movements: BASE_UNIT_LOCKED_MESSAGE
			};
			return fail(400, { message: messages[result.reason] });
		}
		redirect(303, here(id));
	},

	addUnit: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const id = idOf(event);
		if (!id) return fail(400, { message: NOT_FOUND_MESSAGE });

		const form = await event.request.formData();
		const parsed = addUnitSchema.safeParse({
			name: form.get('name') ?? '',
			baseQtyPerUnit: form.get('baseQtyPerUnit') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		const factor = parsePositiveQty(parsed.data.baseQtyPerUnit);
		if (!factor.ok) return fail(400, { message: factor.message });

		const ctx = writeContext(event, restaurantId, user.userId);
		const result = await db.transaction((tx) =>
			addPurchaseUnit(tx, ctx, id, { name: parsed.data.name, baseQtyPerUnit: factor.qty })
		);
		if (!result.ok) {
			const messages = {
				not_found: NOT_FOUND_MESSAGE,
				name_taken: 'This ingredient already has a unit with this name.',
				ingredient_archived: 'This ingredient is archived: it takes no new units.'
			};
			return fail(400, { message: messages[result.reason] });
		}
		redirect(303, here(id));
	},

	archiveUnit: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const id = idOf(event);
		if (!id) return fail(400, { message: NOT_FOUND_MESSAGE });

		const form = await event.request.formData();
		const parsed = archiveUnitSchema.safeParse({ unitId: form.get('unitId') ?? '' });
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const ctx = writeContext(event, restaurantId, user.userId);
		const result = await db.transaction(async (tx) => {
			// The unit must be one of THIS ingredient's live units, not merely the
			// restaurant's: the page archives what it shows.
			const ingredient = await getIngredient(tx, restaurantId, id);
			if (!ingredient?.purchaseUnits.some((u) => u.id === parsed.data.unitId)) {
				return { ok: false as const, reason: 'not_found' as const };
			}
			return archivePurchaseUnit(tx, ctx, parsed.data.unitId);
		});
		if (!result.ok) return fail(400, { message: 'That unit no longer exists. Reload the page.' });
		redirect(303, here(id));
	},

	archive: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const id = idOf(event);
		if (!id) return fail(400, { message: NOT_FOUND_MESSAGE });

		const ctx = writeContext(event, restaurantId, user.userId);
		const result = await db.transaction((tx) => archiveIngredient(tx, ctx, id));
		if (!result.ok) {
			if (result.reason === 'in_recipe') {
				return fail(400, {
					message: `Remove it from these recipes first: ${result.owners.join(', ')}.`
				});
			}
			return fail(400, { message: NOT_FOUND_MESSAGE });
		}
		redirect(303, '/inventory');
	},

	openingStock: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId, format } = await scope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });
		const id = idOf(event);
		if (!id) return fail(400, { message: NOT_FOUND_MESSAGE });

		const form = await event.request.formData();
		const parsed = openingStockSchema.safeParse({
			purchaseUnitId: form.get('purchaseUnitId') ?? '',
			qty: form.get('qty') ?? '',
			cost: form.get('cost') ?? '',
			businessDate: form.get('businessDate') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		const unitQty = parsePositiveQty(parsed.data.qty);
		if (!unitQty.ok) return fail(400, { message: unitQty.message });
		const cost = parsePriceInput(parsed.data.cost, format.exponent);
		if (!cost.ok) return fail(400, { message: cost.message });

		const ctx = writeContext(event, restaurantId, user.userId);
		const result = await db.transaction((tx) =>
			recordOpeningStock(tx, ctx, {
				ingredientId: id,
				purchaseUnitId: parsed.data.purchaseUnitId,
				unitQty: unitQty.qty,
				unitCostMinor: cost.minor,
				businessDate: parsed.data.businessDate
			})
		);
		if (!result.ok) {
			const messages = {
				not_found: NOT_FOUND_MESSAGE,
				invalid_unit: "Choose one of this ingredient's purchase units.",
				has_movements: OPENING_MOVED_MESSAGE,
				already_recorded: 'Opening stock has already been recorded for this ingredient.',
				invalid_amount: 'Enter a quantity above zero and a cost of zero or more.'
			};
			return fail(400, { message: messages[result.reason] });
		}
		redirect(303, here(id));
	}
};
