import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { listMenu } from '$lib/server/menu';
import {
	listIngredients,
	readRecipes,
	recipeCosts,
	setRecipe,
	type SetRecipeRefusal
} from '$lib/server/inventory';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { formatQty } from '$lib/money/quantity';
import { amountText, firstMessage, parseRecipeRows, recipeOwnerSchema } from '../helpers';

// THE RECIPE EDITOR (spec 15: recipes in base units, modifiers change the
// recipe; spec 16: recipe cost at the current average). Every load and every
// action checks admin.inventory first (invariant 8). The tenant comes from
// locals; the selected owner comes from ?item= or ?modifier=, and an id that is
// not one of this restaurant's live items or modifiers simply selects nothing.
//
// Recipes are configuration: setRecipe replaces an owner's rows and writes
// recipe.changed (invariant 10). Quantities are parsed once with parseQty and
// leave as formatQty's text; costs leave as the formatter's string. The page
// computes nothing (invariant 1).

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
	const [menu, recipes, costs, ingredientRows] = await Promise.all([
		listMenu(db, restaurantId),
		readRecipes(db, restaurantId),
		recipeCosts(db, restaurantId),
		listIngredients(db, restaurantId, { includeArchived: true })
	]);

	const costOf = (id: string) => {
		const cost = costs.get(id);
		return {
			cost: cost ? amountText(cost.costMinor, format) : null,
			costNegative: cost ? cost.costMinor < 0n : false
		};
	};
	const hasRecipe = (id: string) => costs.has(id);

	const itemRow = (item: (typeof menu.items)[number]) => ({
		id: item.id,
		name: item.name,
		hasRecipe: hasRecipe(item.id),
		...costOf(item.id)
	});
	const categoryIds = new Set(menu.categories.map((category) => category.id));
	const categories = menu.categories.map((category) => ({
		id: category.id,
		name: category.name,
		items: menu.items.filter((item) => item.categoryId === category.id).map(itemRow)
	}));
	const loose = menu.items.filter((item) => !categoryIds.has(item.categoryId));
	if (loose.length > 0) {
		categories.push({ id: 'other', name: 'Other', items: loose.map(itemRow) });
	}
	const groups = menu.modifierGroups.map((group) => ({
		id: group.id,
		name: group.name,
		modifiers: menu.modifiers
			.filter((modifier) => modifier.groupId === group.id)
			.map((modifier) => ({
				id: modifier.id,
				name: modifier.name,
				hasRecipe: hasRecipe(modifier.id),
				...costOf(modifier.id)
			}))
	}));

	// The selection: a live item or modifier of THIS restaurant, or nothing.
	const itemId = event.url.searchParams.get('item');
	const modifierId = event.url.searchParams.get('modifier');
	const item = itemId ? menu.items.find((row) => row.id === itemId) : undefined;
	const modifier =
		!item && modifierId ? menu.modifiers.find((row) => row.id === modifierId) : undefined;
	const owner = item
		? {
				kind: 'item' as const,
				id: item.id,
				name: item.name,
				context: menu.categories.find((c) => c.id === item.categoryId)?.name ?? null
			}
		: modifier
			? {
					kind: 'modifier' as const,
					id: modifier.id,
					name: modifier.name,
					context: menu.modifierGroups.find((g) => g.id === modifier.groupId)?.name ?? null
				}
			: null;

	const archived = new Set(
		ingredientRows.filter((row) => row.archivedAt !== null).map((r) => r.id)
	);
	const selected = owner
		? {
				...owner,
				hasRecipe: hasRecipe(owner.id),
				...costOf(owner.id),
				rows: recipes
					.filter((line) => line.ownerKind === owner.kind && line.ownerId === owner.id)
					.map((line) => ({
						ingredientId: line.ingredientId,
						ingredientName: line.ingredientName,
						baseUnit: line.baseUnit,
						qty: formatQty(line.qty),
						archived: archived.has(line.ingredientId)
					}))
			}
		: null;

	return {
		categories,
		groups,
		// Live ingredients are the choices; an archived one appears only while the
		// selected recipe still names it, so the row can be seen and removed.
		ingredients: ingredientRows
			.filter(
				(row) =>
					row.archivedAt === null ||
					(selected?.rows.some((line) => line.ingredientId === row.id) ?? false)
			)
			.map((row) => ({
				id: row.id,
				name: row.name,
				baseUnit: row.baseUnit,
				archived: row.archivedAt !== null
			})),
		selected
	};
};

const REFUSALS: Record<SetRecipeRefusal, { status: number; message: string }> = {
	not_found: { status: 404, message: 'That menu item or modifier no longer exists.' },
	owner_archived: {
		status: 400,
		message: 'That menu item or modifier is archived; its recipe cannot change.'
	},
	ingredient_not_found: { status: 400, message: 'An ingredient on this recipe no longer exists.' },
	ingredient_archived: {
		status: 400,
		message: 'An ingredient on this recipe is archived. Remove its row.'
	},
	duplicate_ingredient: { status: 400, message: 'Each ingredient belongs on one row only.' },
	invalid_qty: { status: 400, message: 'Check the quantities.' },
	too_many_lines: { status: 400, message: 'A recipe has at most 30 ingredients.' }
};

export const actions: Actions = {
	save: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const form = await event.request.formData();

		const owner = recipeOwnerSchema.safeParse({
			kind: form.get('kind') ?? '',
			ownerId: form.get('ownerId') ?? ''
		});
		if (!owner.success) return fail(400, { message: firstMessage(owner.error) });
		const { kind, ownerId } = owner.data;

		const text = (name: string) =>
			form.getAll(name).map((value) => (typeof value === 'string' ? value : ''));
		const rows = parseRecipeRows(kind, text('ingredientId'), text('qty'));
		if (!rows.ok) return fail(400, { message: rows.message });

		const { ip, userAgent } = requestContext(event);
		const result = await db.transaction((tx) =>
			setRecipe(
				tx,
				{ restaurantId, actorUserId: user.userId, ip, userAgent },
				{
					owner: { kind, id: ownerId },
					lines: rows.lines.map((line) => ({ ingredientId: line.ingredientId, qty: line.qty }))
				}
			)
		);
		if (!result.ok) {
			const refusal = REFUSALS[result.reason];
			// Name the row when the refusal is about one ingredient.
			if (result.reason === 'ingredient_not_found' || result.reason === 'ingredient_archived') {
				const known = await listIngredients(db, restaurantId, { includeArchived: true });
				const byId = new Map(known.map((row) => [row.id, row]));
				const bad = rows.lines.find((line) => {
					const found = byId.get(line.ingredientId);
					return result.reason === 'ingredient_not_found' ? !found : found?.archivedAt != null;
				});
				if (bad) {
					const message =
						result.reason === 'ingredient_not_found'
							? `Row ${bad.row}: that ingredient no longer exists.`
							: `Row ${bad.row}: ${byId.get(bad.ingredientId)!.name} is archived. Remove its row.`;
					return fail(refusal.status, { message });
				}
			}
			return fail(refusal.status, { message: refusal.message });
		}
		redirect(303, `/inventory/recipes?${kind}=${ownerId}`);
	}
};
