import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import {
	archiveCategory,
	archiveItem,
	createCategory,
	createItem,
	createModifier,
	createModifierGroup,
	linkModifierGroup,
	listMenu,
	listTaxRates,
	removeItemImage,
	setItemAvailability,
	setItemImage,
	unlinkModifierGroup,
	updateCategory,
	updateItem
} from '$lib/server/menu';
import { sniffImageType } from '$lib/server/menu/images';
import { IMAGE_MAX_BYTES, dashboardImageUrl } from '$lib/menu-images';
import { ROUNDING_RULE, minor, toBigInt } from '$lib/money';
import { dishMargin } from '$lib/money/costing';
import { recipeCosts } from '$lib/server/inventory';
import { formatAmount, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import {
	archiveCategorySchema,
	archiveItemSchema,
	availabilitySchema,
	createCategorySchema,
	createItemSchema,
	createModifierGroupSchema,
	createModifierSchema,
	firstMessage,
	formatTaxRate,
	itemIdSchema,
	linkSchema,
	parsePriceInput,
	renameCategorySchema,
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
	return {
		restaurantId,
		format,
		taxMode: restaurant.taxMode,
		// T-13: the named default rate's id, or null while the owner has not chosen.
		defaultTaxRateId: restaurant.defaultTaxRateId
	};
}

const TAX_RATE_GONE_MESSAGE = 'That tax rate is no longer available.';

/** A duplicate live category name reaches us as the partial unique index's 23505. */
function isUniqueViolation(thrown: unknown): boolean {
	const code = (value: unknown) => (value as { code?: string } | null)?.code;
	return code(thrown) === '23505' || code((thrown as { cause?: unknown })?.cause) === '23505';
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.menu');
	const { restaurantId, format, taxMode, defaultTaxRateId } = await menuScope(event.locals);
	const menu = await listMenu(db, restaurantId);
	const amount = (value: bigint) => (format ? formatAmount(minor(value), format) : null);

	// T-13: each item's RESOLVED named rate — its own, else the restaurant default,
	// else none — by id over every rate, archived ones included (an item may still
	// point at one). The same rule as readMenuSnapshot; no number is assumed.
	const rates = await listTaxRates(db, restaurantId);
	const byId = new Map(rates.map((rate) => [rate.id, rate]));
	const rateOf = (item: { taxRateId: string | null }) => {
		const id = item.taxRateId ?? defaultTaxRateId;
		return id === null ? null : (byId.get(id) ?? null);
	};

	// COST AND MARGIN (tasks/inventory-cogs T-34), read-only: the recipe's cost at
	// the ledger's current averages, from a SEPARATE reader — listMenu and the POS
	// snapshot never carry a cost. The cost and the net price are each rounded
	// once by dishMargin, and the margin is their difference (invariant 7). With no
	// tax mode or rate set the margin cannot be known, and the page says why.
	const costs = await recipeCosts(db, restaurantId);
	const costOf = (id: string) => {
		const cost = costs.get(id);
		return cost ? { text: amount(cost.costMinor), negative: cost.costMinor < 0n } : null;
	};
	const marginOf = (item: { id: string; priceMinor: bigint; taxRateId: string | null }) => {
		const cost = costs.get(item.id);
		const rate = rateOf(item)?.rateBp ?? null;
		if (!cost) return null;
		if (taxMode === null || rate === null) return { text: null, negative: false, unset: true };
		const m = dishMargin(
			{ priceMinor: minor(item.priceMinor), taxRateBp: rate, taxMode, costExact: cost.costExact },
			ROUNDING_RULE
		);
		return { text: amount(m.marginMinor), negative: m.marginMinor < 0n, unset: false };
	};

	// AN EXPLICIT LITERAL: every amount is the formatter's string, every rate a label,
	// every photo a URL (the bytes are served by /menu/images/[id]).
	return {
		currency: format ? { code: format.code, exponent: format.exponent } : null,
		categories: menu.categories.map((category) => ({
			id: category.id,
			name: category.name,
			itemCount: menu.items.filter((item) => item.categoryId === category.id).length
		})),
		uncategorisedCount: menu.items.filter((item) => item.categoryId === null).length,
		items: menu.items.map((item) => {
			const rate = rateOf(item);
			return {
				id: item.id,
				categoryId: item.categoryId,
				name: item.name,
				price: amount(item.priceMinor),
				// 'Tax 10%', or 'restaurant rate' while nothing resolves.
				taxRate: rate ? `${rate.name} ${formatTaxRate(rate.rateBp)}` : formatTaxRate(null),
				taxRateId: item.taxRateId,
				isAvailable: item.isAvailable,
				imageUrl: item.imageId ? dashboardImageUrl(item.imageId) : null,
				cost: costOf(item.id),
				margin: marginOf(item),
				groupIds: menu.links
					.filter((link) => link.menuItemId === item.id)
					.map((link) => link.modifierGroupId)
			};
		}),
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
					negative: modifier.priceDeltaMinor < 0n,
					cost: costOf(modifier.id)
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

		// T-13: no rate is passed, so a new item takes the restaurant's default rate.
		// The named-rate choice arrives with T-32.
		const result = await db.transaction((tx) =>
			createItem(tx, restaurantId, {
				// null = no category (the till's "Other" tab).
				categoryId: parsed.data.categoryId,
				name: parsed.data.name,
				priceMinor: toBigInt(price.minor)
			})
		);
		if (!result.ok) {
			return fail(400, {
				message:
					result.reason === 'invalid_tax_rate'
						? TAX_RATE_GONE_MESSAGE
						: 'That category no longer exists.'
			});
		}
		// The id lets the panel upload the photo in its own request, after the item exists.
		return { message: `${parsed.data.name} added.`, itemId: result.id };
	},

	updateItem: async (event) => {
		const user = requirePermission(event, 'admin.menu');
		const { restaurantId, format } = await menuScope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });

		const form = await event.request.formData();
		const parsed = updateItemSchema.safeParse({
			itemId: form.get('itemId') ?? '',
			name: form.get('name') ?? '',
			price: form.get('price') ?? '',
			categoryId: form.get('categoryId') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		// A blank price keeps the current one.
		let priceMinor: bigint | undefined;
		if (parsed.data.price.trim() !== '') {
			const price = parsePriceInput(parsed.data.price, format.exponent);
			if (!price.ok) return fail(400, { message: price.message });
			priceMinor = toBigInt(price.minor);
		}

		const { ip, userAgent } = requestContext(event);
		// The price change and its menu.price_changed audit row commit together.
		const result = await db.transaction((tx) =>
			updateItem(
				tx,
				restaurantId,
				parsed.data.itemId,
				// categoryId null moves the item to "No category". No rate is passed
				// (T-13), so an edited item keeps its rate; T-32 adds the choice.
				{
					name: parsed.data.name,
					priceMinor,
					categoryId: parsed.data.categoryId
				},
				{ actorUserId: user.userId, ip, userAgent }
			)
		);
		if (!result.ok) {
			return fail(400, {
				message:
					result.reason === 'invalid_tax_rate'
						? TAX_RATE_GONE_MESSAGE
						: 'That item no longer exists.'
			});
		}
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
	},

	// ── menu-and-printing T-11: the five actions the module had and the page lacked.
	// None involves a price, so none is gated on the currency; each still checks
	// admin.menu itself (invariant 8) and scopes by the session's restaurant.

	renameCategory: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId } = await menuScope(event.locals);

		const form = await event.request.formData();
		const parsed = renameCategorySchema.safeParse({
			categoryId: form.get('categoryId') ?? '',
			name: form.get('name') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		try {
			const result = await db.transaction((tx) =>
				updateCategory(tx, restaurantId, parsed.data.categoryId, { name: parsed.data.name })
			);
			if (!result.ok) return fail(400, { message: 'That category no longer exists.' });
			return { message: result.changed ? 'Renamed.' : 'No change to save.' };
		} catch (thrown) {
			if (isUniqueViolation(thrown)) {
				return fail(400, { message: 'A category with that name already exists.' });
			}
			throw thrown;
		}
	},

	archiveCategory: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId } = await menuScope(event.locals);

		const form = await event.request.formData();
		const parsed = archiveCategorySchema.safeParse({ categoryId: form.get('categoryId') ?? '' });
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		// ARCHIVE, never delete; its live items move to "No category" in the same
		// transaction and version bump (CLAUDE.md, the gate defaults of 2026-09-29).
		const result = await db.transaction((tx) =>
			archiveCategory(tx, restaurantId, parsed.data.categoryId)
		);
		if (!result.ok) return fail(400, { message: 'That category no longer exists.' });
		return { message: `Archived. ${result.movedItems} item(s) moved to No category.` };
	},

	setAvailability: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId } = await menuScope(event.locals);

		const form = await event.request.formData();
		const parsed = availabilitySchema.safeParse({
			itemId: form.get('itemId') ?? '',
			available: form.get('available') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const available = parsed.data.available === 'yes';
		const result = await db.transaction((tx) =>
			setItemAvailability(tx, restaurantId, parsed.data.itemId, available)
		);
		if (!result.ok) return fail(400, { message: 'That item no longer exists.' });
		if (!result.changed) return { message: 'No change to save.' };
		return { message: available ? 'Marked available.' : 'Marked sold out.' };
	},

	// multipart: the panel sends the photo in its OWN request, after the item is
	// saved, so a refused photo never loses the typed name and price. The browser
	// resized it (src/lib/image-resize.ts); this action trusts nothing about that.
	setImage: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId } = await menuScope(event.locals);

		const form = await event.request.formData();
		const parsed = itemIdSchema.safeParse({ itemId: form.get('itemId') ?? '' });
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		const file = form.get('image');
		// File.size is a byte count, not money: compared directly.
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose a photo.' });
		}
		if (file.size > IMAGE_MAX_BYTES) {
			return fail(400, {
				message: 'The photo is still larger than 400 KB after resizing. Try another photo.'
			});
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		// The type is what the bytes SAY, never what the browser declared.
		const contentType = sniffImageType(bytes);
		if (contentType === null) return fail(400, { message: 'Use a JPEG, PNG or WebP photo.' });

		const result = await db.transaction((tx) =>
			setItemImage(tx, restaurantId, parsed.data.itemId, { bytes, contentType })
		);
		if (!result.ok) return fail(400, { message: 'That item no longer exists.' });
		return { message: 'Photo saved.', imageId: result.imageId };
	},

	removeImage: async (event) => {
		requirePermission(event, 'admin.menu');
		const { restaurantId } = await menuScope(event.locals);

		const form = await event.request.formData();
		const parsed = itemIdSchema.safeParse({ itemId: form.get('itemId') ?? '' });
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const result = await db.transaction((tx) =>
			removeItemImage(tx, restaurantId, parsed.data.itemId)
		);
		if (!result.ok) return fail(400, { message: 'That item no longer exists.' });
		return { message: result.changed ? 'Photo removed.' : 'There was no photo.' };
	}
};
