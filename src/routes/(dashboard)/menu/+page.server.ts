import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import {
	archiveItem,
	createCategory,
	createItem,
	createModifier,
	createModifierGroup,
	linkModifierGroup,
	listMenu,
	unlinkModifierGroup,
	updateItem
} from '$lib/server/menu';
import { minor, toBigInt } from '$lib/money';
import { formatAmount, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import {
	archiveItemSchema,
	createCategorySchema,
	createItemSchema,
	createModifierGroupSchema,
	createModifierSchema,
	firstMessage,
	formatTaxRate,
	linkSchema,
	parseOptionalRate,
	parsePriceInput,
	updateItemSchema
} from './helpers';

// THE DASHBOARD MENU PAGE (spec 15, 17). Every load and every action checks
// admin.menu itself (invariant 8): a form action is a separately reachable POST.
// The tenant comes from locals, never from the form body or the query string.
//
// THE PAGE IS GATED ON THE CURRENCY. restaurant_settings holds a currency CODE and
// no exponent; the exponent comes from SUPPORTED_CURRENCIES through
// moneyFormatFor. While no currency is set there is no exponent, so there is no
// way to know whether 8.50 means 850 or 85 — every price input is disabled with
// the reason, and every action refuses with the same sentence, rather than
// picking an exponent nobody chose.
//
// A typed price is converted ONCE, here, by parsePriceInput (helpers.ts), and
// written with toBigInt. Every amount leaves this file as the money formatter's
// string: no bigint reaches the page, and the page does no arithmetic.

const CURRENCY_MESSAGE = 'Set the currency in Settings before adding prices.';

/** The tenant, and the currency's format — or null while no currency is set. */
async function menuScope(locals: App.Locals) {
	const restaurantId = locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');
	let format: MoneyFormat | null = null;
	if (restaurant.currencyCode !== null) {
		try {
			format = moneyFormatFor(restaurant.currencyCode);
		} catch {
			// The settings form stores only codes the formatter supports, so this is a
			// bad row — and guessing an exponent is exactly what the gate forbids.
			error(500, 'The stored currency cannot be formatted');
		}
	}
	return { restaurantId, format };
}

/** A duplicate live category name reaches us as the partial unique index's 23505. */
function isUniqueViolation(thrown: unknown): boolean {
	const code = (value: unknown) => (value as { code?: string } | null)?.code;
	return code(thrown) === '23505' || code((thrown as { cause?: unknown })?.cause) === '23505';
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.menu');
	const { restaurantId, format } = await menuScope(event.locals);
	const menu = await listMenu(db, restaurantId);
	const amount = (value: bigint) => (format ? formatAmount(minor(value), format) : null);

	// AN EXPLICIT LITERAL: every amount is the formatter's string, every rate a label.
	return {
		currency: format ? { code: format.code, exponent: format.exponent } : null,
		categories: menu.categories.map((category) => ({ id: category.id, name: category.name })),
		items: menu.items.map((item) => ({
			id: item.id,
			categoryId: item.categoryId,
			name: item.name,
			price: amount(item.priceMinor),
			taxRate: formatTaxRate(item.taxRateBp),
			taxRateBp: item.taxRateBp,
			isAvailable: item.isAvailable,
			groupIds: menu.links
				.filter((link) => link.menuItemId === item.id)
				.map((link) => link.modifierGroupId)
		})),
		groups: menu.modifierGroups.map((group) => ({
			id: group.id,
			name: group.name,
			minSelect: group.minSelect,
			maxSelect: group.maxSelect,
			modifiers: menu.modifiers
				.filter((modifier) => modifier.groupId === group.id)
				.map((modifier) => ({
					id: modifier.id,
					name: modifier.name,
					delta: amount(modifier.priceDeltaMinor),
					negative: modifier.priceDeltaMinor < 0n
				}))
		}))
	};
};

export const actions: Actions = {
	createCategory: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = createCategorySchema.safeParse({ name: form.get('name') ?? '' });
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		try {
			await db.transaction((tx) => createCategory(tx, restaurantId, { name: parsed.data.name }));
		} catch (thrown) {
			if (isUniqueViolation(thrown)) {
				return fail(400, { message: 'A category with that name already exists.' });
			}
			throw thrown;
		}
		return { message: `${parsed.data.name} added.` };
	},

	createItem: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = createItemSchema.safeParse({
			categoryId: form.get('categoryId') ?? '',
			name: form.get('name') ?? '',
			price: form.get('price') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		const price = parsePriceInput(parsed.data.price, format.exponent);
		if (!price.ok) return fail(400, { message: price.message });
		const rate = parseOptionalRate(form.get('taxRateBp'));
		if (!rate.ok) return fail(400, { message: rate.message });

		const result = await db.transaction((tx) =>
			createItem(tx, restaurantId, {
				categoryId: parsed.data.categoryId,
				name: parsed.data.name,
				priceMinor: toBigInt(price.minor),
				taxRateBp: rate.value
			})
		);
		if (!result.ok) return fail(400, { message: 'That category no longer exists.' });
		return { message: `${parsed.data.name} added.` };
	},

	updateItem: async (event) => {
		const user = requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = updateItemSchema.safeParse({
			itemId: form.get('itemId') ?? '',
			name: form.get('name') ?? '',
			price: form.get('price') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		// A blank price keeps the current one.
		let priceMinor: bigint | undefined;
		if (parsed.data.price.trim() !== '') {
			const price = parsePriceInput(parsed.data.price, format.exponent);
			if (!price.ok) return fail(400, { message: price.message });
			priceMinor = toBigInt(price.minor);
		}
		const rate = parseOptionalRate(form.get('taxRateBp'));
		if (!rate.ok) return fail(400, { message: rate.message });

		const { ip, userAgent } = requestContext(event);
		// The price change and its menu.price_changed audit row commit together.
		const result = await db.transaction((tx) =>
			updateItem(
				tx,
				restaurantId,
				parsed.data.itemId,
				{ name: parsed.data.name, priceMinor, taxRateBp: rate.value },
				{ actorUserId: user.userId, ip, userAgent }
			)
		);
		if (!result.ok) return fail(400, { message: 'That item no longer exists.' });
		return { message: result.changed ? `${parsed.data.name} saved.` : 'No change to save.' };
	},

	archiveItem: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = archiveItemSchema.safeParse({ itemId: form.get('itemId') ?? '' });
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		// ARCHIVE, never delete: the row stays, so past receipts and reports resolve.
		const result = await db.transaction((tx) => archiveItem(tx, restaurantId, parsed.data.itemId));
		if (!result.ok) return fail(400, { message: 'That item no longer exists.' });
		return { message: 'Archived. It stays on past receipts and reports.' };
	},

	createModifierGroup: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = createModifierGroupSchema.safeParse({
			name: form.get('name') ?? '',
			minSelect: form.get('minSelect') ?? '0',
			maxSelect: form.get('maxSelect') ?? '1'
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const result = await db.transaction((tx) => createModifierGroup(tx, restaurantId, parsed.data));
		if (!result.ok) {
			return fail(400, { message: 'The most a guest may pick cannot be fewer than the least.' });
		}
		return { message: `${parsed.data.name} added.` };
	},

	createModifier: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = createModifierSchema.safeParse({
			groupId: form.get('groupId') ?? '',
			name: form.get('name') ?? '',
			priceDelta: form.get('priceDelta') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		// A delta may be negative: "No cheese" takes money off.
		const delta = parsePriceInput(parsed.data.priceDelta, format.exponent, { signed: true });
		if (!delta.ok) return fail(400, { message: delta.message });

		const result = await db.transaction((tx) =>
			createModifier(tx, restaurantId, {
				groupId: parsed.data.groupId,
				name: parsed.data.name,
				priceDeltaMinor: toBigInt(delta.minor)
			})
		);
		if (!result.ok) return fail(400, { message: 'That modifier group no longer exists.' });
		return { message: `${parsed.data.name} added.` };
	},

	linkGroup: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = linkSchema.safeParse({
			itemId: form.get('itemId') ?? '',
			groupId: form.get('groupId') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const result = await db.transaction((tx) =>
			linkModifierGroup(tx, restaurantId, parsed.data.itemId, parsed.data.groupId)
		);
		if (!result.ok) return fail(400, { message: 'That item or group no longer exists.' });
		return { message: result.changed ? 'Modifier group attached.' : 'Already attached.' };
	},

	unlinkGroup: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = linkSchema.safeParse({
			itemId: form.get('itemId') ?? '',
			groupId: form.get('groupId') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const result = await db.transaction((tx) =>
			unlinkModifierGroup(tx, restaurantId, parsed.data.itemId, parsed.data.groupId)
		);
		return { message: result.changed ? 'Modifier group detached.' : 'It was not attached.' };
	}
};
