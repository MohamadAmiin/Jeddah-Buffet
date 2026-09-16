import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import {
	menuCategories,
	menuItemModifierGroups,
	menuItems,
	modifierGroups,
	modifiers
} from '../db/schema/menu';
import { writeAudit } from '../audit';

// THE MENU MODULE (spec 3, 5, 15, 17).
//
// Conventions from src/lib/server/restaurants: every function takes restaurantId
// EXPLICITLY and scopes every statement by it — an id alone is a cross-tenant
// write; writers take DbTx and never open a transaction; readers take Executor.
//
// THE VERSION BUMP IS STRUCTURAL, NOT A CONVENTION. Every menu write runs inside
// withMenuVersionBump, the one private helper that increments
// restaurant_settings.menu_version, in SQL, in the caller's transaction. The raw
// inserts and updates live only inside callbacks passed to it, so there is no
// exported path that changes what a till would download without bumping the
// version it compares (spec 5). A NO-OP returns before the bump: saving an
// untouched form must not make every till in the building re-download the menu.
//
// A PRICE CHANGE IS AUDITED (spec 3 names price changes) as menu.price_changed,
// in the same transaction as the change (invariant 10). The amounts travel as
// decimal STRINGS of the integer minor value — jsonb cannot hold a bigint.
//
// NO MONEY ARITHMETIC HERE (invariants 1 and 7). Prices arrive as bigint minor
// units and are stored and returned as they are. This file imports nothing from
// src/lib/money: no rounding, no tax, no formatting.
//
// ARCHIVE, NEVER DELETE (invariant 2). The one DELETE in this file removes an item
// ↔ group LINK — a configuration row, not a posted record; an order line will
// snapshot the modifiers a guest actually chose.

export type MenuWriteContext = {
	actorUserId: string | null;
	ip: string | null;
	userAgent: string | null;
};

export type NotFound = { ok: false; reason: 'not_found' };
export type NotEmpty = { ok: false; reason: 'not_empty' };
export type InvalidSelectRange = { ok: false; reason: 'invalid_select_range' };
export type Created = { ok: true; id: string };
export type Changed = { ok: true; changed: boolean };

const NOT_FOUND: NotFound = { ok: false, reason: 'not_found' };
const UNCHANGED: Changed = { ok: true, changed: false };
const CHANGED: Changed = { ok: true, changed: true };

async function withMenuVersionBump<T>(
	tx: DbTx,
	restaurantId: string,
	write: (tx: DbTx) => Promise<T>
): Promise<T> {
	const result = await write(tx);
	// IN SQL, never read-modify-write in TypeScript: two concurrent writes must not
	// both read 7 and both write 8. updated_at is NOT touched — it means "the owner
	// changed a setting" and pairs with the settings.updated audit event.
	await tx
		.update(restaurantSettings)
		.set({ menuVersion: sql`${restaurantSettings.menuVersion} + 1` })
		.where(eq(restaurantSettings.restaurantId, restaurantId));
	return result;
}

function assertMinor(value: unknown, field: string): asserts value is bigint {
	if (typeof value !== 'bigint') {
		throw new TypeError(`${field} is a bigint of minor units (850n is $8.50), never a number`);
	}
}

// ── Row lookups: live rows only, scoped by restaurant; FOR UPDATE where the row
// is about to change, so two concurrent edits cannot both diff against it. ────

async function liveCategory(tx: DbTx, restaurantId: string, id: string, lock = false) {
	const query = tx
		.select()
		.from(menuCategories)
		.where(
			and(
				eq(menuCategories.restaurantId, restaurantId),
				eq(menuCategories.id, id),
				isNull(menuCategories.archivedAt)
			)
		);
	const [row] = lock ? await query.for('update') : await query;
	return row ?? null;
}

async function liveItem(tx: DbTx, restaurantId: string, id: string, lock = false) {
	const query = tx
		.select()
		.from(menuItems)
		.where(
			and(
				eq(menuItems.restaurantId, restaurantId),
				eq(menuItems.id, id),
				isNull(menuItems.archivedAt)
			)
		);
	const [row] = lock ? await query.for('update') : await query;
	return row ?? null;
}

async function liveGroup(tx: DbTx, restaurantId: string, id: string, lock = false) {
	const query = tx
		.select()
		.from(modifierGroups)
		.where(
			and(
				eq(modifierGroups.restaurantId, restaurantId),
				eq(modifierGroups.id, id),
				isNull(modifierGroups.archivedAt)
			)
		);
	const [row] = lock ? await query.for('update') : await query;
	return row ?? null;
}

async function liveModifier(tx: DbTx, restaurantId: string, id: string) {
	const [row] = await tx
		.select()
		.from(modifiers)
		.where(
			and(
				eq(modifiers.restaurantId, restaurantId),
				eq(modifiers.id, id),
				isNull(modifiers.archivedAt)
			)
		)
		.for('update');
	return row ?? null;
}

// ── Categories ────────────────────────────────────────────────────────────────

export async function createCategory(
	tx: DbTx,
	restaurantId: string,
	input: { name: string; sortOrder?: number }
): Promise<Created> {
	return withMenuVersionBump(tx, restaurantId, async (write) => {
		const [row] = await write
			.insert(menuCategories)
			.values({ restaurantId, name: input.name, sortOrder: input.sortOrder ?? 0 })
			.returning({ id: menuCategories.id });
		return { ok: true as const, id: row.id };
	});
}

export async function updateCategory(
	tx: DbTx,
	restaurantId: string,
	categoryId: string,
	changes: { name?: string; sortOrder?: number }
): Promise<Changed | NotFound> {
	const current = await liveCategory(tx, restaurantId, categoryId, true);
	if (!current) return NOT_FOUND;

	const set: { name?: string; sortOrder?: number } = {};
	if (changes.name !== undefined && changes.name !== current.name) set.name = changes.name;
	if (changes.sortOrder !== undefined && changes.sortOrder !== current.sortOrder) {
		set.sortOrder = changes.sortOrder;
	}
	if (Object.keys(set).length === 0) return UNCHANGED;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		await write
			.update(menuCategories)
			.set({ ...set, updatedAt: new Date() })
			.where(and(eq(menuCategories.restaurantId, restaurantId), eq(menuCategories.id, categoryId)));
	});
	return CHANGED;
}

/**
 * Archive a category. Refused while it still holds a LIVE item: an item in an
 * archived category would vanish from the page and the till while still being
 * sellable data. Archive or move the items first.
 */
export async function archiveCategory(
	tx: DbTx,
	restaurantId: string,
	categoryId: string
): Promise<Changed | NotFound | NotEmpty> {
	const current = await liveCategory(tx, restaurantId, categoryId, true);
	if (!current) return NOT_FOUND;
	const [liveChild] = await tx
		.select({ id: menuItems.id })
		.from(menuItems)
		.where(
			and(
				eq(menuItems.restaurantId, restaurantId),
				eq(menuItems.categoryId, categoryId),
				isNull(menuItems.archivedAt)
			)
		)
		.limit(1);
	if (liveChild) return { ok: false, reason: 'not_empty' };

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		const now = new Date();
		await write
			.update(menuCategories)
			.set({ archivedAt: now, updatedAt: now })
			.where(and(eq(menuCategories.restaurantId, restaurantId), eq(menuCategories.id, categoryId)));
	});
	return CHANGED;
}

// ── Items ─────────────────────────────────────────────────────────────────────

export type ItemInput = {
	categoryId: string;
	name: string;
	priceMinor: bigint;
	/** Integer basis points (825 = 8.25%), or null — "inherit the restaurant rate". */
	taxRateBp?: number | null;
	isAvailable?: boolean;
	sortOrder?: number;
};

export async function createItem(
	tx: DbTx,
	restaurantId: string,
	input: ItemInput
): Promise<Created | NotFound> {
	assertMinor(input.priceMinor, 'priceMinor');
	if (!(await liveCategory(tx, restaurantId, input.categoryId))) return NOT_FOUND;

	return withMenuVersionBump(tx, restaurantId, async (write) => {
		const [row] = await write
			.insert(menuItems)
			.values({
				restaurantId,
				categoryId: input.categoryId,
				name: input.name,
				priceMinor: input.priceMinor,
				// Not given = inherit the restaurant's rate, which is what null means.
				taxRateBp: input.taxRateBp ?? null,
				isAvailable: input.isAvailable ?? true,
				sortOrder: input.sortOrder ?? 0
			})
			.returning({ id: menuItems.id });
		return { ok: true as const, id: row.id };
	});
}

export type ItemChanges = {
	name?: string;
	priceMinor?: bigint;
	/** null sets the item back to inheriting the restaurant's rate. */
	taxRateBp?: number | null;
	categoryId?: string;
	sortOrder?: number;
};

/**
 * Update an item's submitted fields. A price change writes ONE menu.price_changed
 * row in the same transaction; an unchanged form writes nothing and does not bump.
 */
export async function updateItem(
	tx: DbTx,
	restaurantId: string,
	itemId: string,
	changes: ItemChanges,
	ctx: MenuWriteContext
): Promise<Changed | NotFound> {
	const current = await liveItem(tx, restaurantId, itemId, true);
	if (!current) return NOT_FOUND;

	const set: Omit<ItemChanges, 'taxRateBp'> & { taxRateBp?: number | null } = {};
	if (changes.name !== undefined && changes.name !== current.name) set.name = changes.name;
	if (changes.priceMinor !== undefined) {
		assertMinor(changes.priceMinor, 'priceMinor');
		if (changes.priceMinor !== current.priceMinor) set.priceMinor = changes.priceMinor;
	}
	if (changes.taxRateBp !== undefined && changes.taxRateBp !== current.taxRateBp) {
		set.taxRateBp = changes.taxRateBp;
	}
	if (changes.sortOrder !== undefined && changes.sortOrder !== current.sortOrder) {
		set.sortOrder = changes.sortOrder;
	}
	if (changes.categoryId !== undefined && changes.categoryId !== current.categoryId) {
		if (!(await liveCategory(tx, restaurantId, changes.categoryId))) return NOT_FOUND;
		set.categoryId = changes.categoryId;
	}
	if (Object.keys(set).length === 0) return UNCHANGED;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		await write
			.update(menuItems)
			.set({ ...set, updatedAt: new Date() })
			.where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.id, itemId)));
		if (set.priceMinor !== undefined) {
			await writeAudit(write, {
				restaurantId,
				actorUserId: ctx.actorUserId,
				subjectUserId: null,
				event: 'menu.price_changed',
				details: {
					target: 'item',
					targetId: itemId,
					name: set.name ?? current.name,
					oldPriceMinor: current.priceMinor.toString(),
					newPriceMinor: set.priceMinor.toString()
				},
				ip: ctx.ip,
				userAgent: ctx.userAgent
			});
		}
	});
	return CHANGED;
}

/** Archive an item: the row stays, so a past order line still resolves (invariant 2). */
export async function archiveItem(
	tx: DbTx,
	restaurantId: string,
	itemId: string
): Promise<Changed | NotFound> {
	if (!(await liveItem(tx, restaurantId, itemId, true))) return NOT_FOUND;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		const now = new Date();
		await write
			.update(menuItems)
			.set({ archivedAt: now, updatedAt: now })
			.where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.id, itemId)));
	});
	return CHANGED;
}

/** Sold out, or back: the till greys a sold-out item out rather than forgetting it. */
export async function setItemAvailability(
	tx: DbTx,
	restaurantId: string,
	itemId: string,
	isAvailable: boolean
): Promise<Changed | NotFound> {
	const current = await liveItem(tx, restaurantId, itemId, true);
	if (!current) return NOT_FOUND;
	if (current.isAvailable === isAvailable) return UNCHANGED;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		await write
			.update(menuItems)
			.set({ isAvailable, updatedAt: new Date() })
			.where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.id, itemId)));
	});
	return CHANGED;
}

// ── Modifier groups ───────────────────────────────────────────────────────────

const validSelectRange = (minSelect: number, maxSelect: number) =>
	Number.isSafeInteger(minSelect) &&
	Number.isSafeInteger(maxSelect) &&
	minSelect >= 0 &&
	maxSelect >= minSelect;

export async function createModifierGroup(
	tx: DbTx,
	restaurantId: string,
	input: { name: string; minSelect?: number; maxSelect?: number }
): Promise<Created | InvalidSelectRange> {
	const minSelect = input.minSelect ?? 0;
	const maxSelect = input.maxSelect ?? 1;
	if (!validSelectRange(minSelect, maxSelect)) return { ok: false, reason: 'invalid_select_range' };

	return withMenuVersionBump(tx, restaurantId, async (write) => {
		const [row] = await write
			.insert(modifierGroups)
			.values({ restaurantId, name: input.name, minSelect, maxSelect })
			.returning({ id: modifierGroups.id });
		return { ok: true as const, id: row.id };
	});
}

export async function updateModifierGroup(
	tx: DbTx,
	restaurantId: string,
	groupId: string,
	changes: { name?: string; minSelect?: number; maxSelect?: number }
): Promise<Changed | NotFound | InvalidSelectRange> {
	const current = await liveGroup(tx, restaurantId, groupId, true);
	if (!current) return NOT_FOUND;

	const next = {
		name: changes.name ?? current.name,
		minSelect: changes.minSelect ?? current.minSelect,
		maxSelect: changes.maxSelect ?? current.maxSelect
	};
	if (!validSelectRange(next.minSelect, next.maxSelect)) {
		return { ok: false, reason: 'invalid_select_range' };
	}
	if (
		next.name === current.name &&
		next.minSelect === current.minSelect &&
		next.maxSelect === current.maxSelect
	) {
		return UNCHANGED;
	}

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		await write
			.update(modifierGroups)
			.set({ ...next, updatedAt: new Date() })
			.where(and(eq(modifierGroups.restaurantId, restaurantId), eq(modifierGroups.id, groupId)));
	});
	return CHANGED;
}

/**
 * Archive a group. Refused while it still holds a live modifier or is linked to
 * a live item: either would leave the till pointing at a group it cannot show.
 */
export async function archiveModifierGroup(
	tx: DbTx,
	restaurantId: string,
	groupId: string
): Promise<Changed | NotFound | NotEmpty> {
	if (!(await liveGroup(tx, restaurantId, groupId, true))) return NOT_FOUND;

	const [liveModifierRow] = await tx
		.select({ id: modifiers.id })
		.from(modifiers)
		.where(
			and(
				eq(modifiers.restaurantId, restaurantId),
				eq(modifiers.groupId, groupId),
				isNull(modifiers.archivedAt)
			)
		)
		.limit(1);
	const [liveLink] = await tx
		.select({ itemId: menuItemModifierGroups.menuItemId })
		.from(menuItemModifierGroups)
		.innerJoin(menuItems, eq(menuItems.id, menuItemModifierGroups.menuItemId))
		.where(
			and(
				eq(menuItemModifierGroups.restaurantId, restaurantId),
				eq(menuItemModifierGroups.modifierGroupId, groupId),
				isNull(menuItems.archivedAt)
			)
		)
		.limit(1);
	if (liveModifierRow || liveLink) return { ok: false, reason: 'not_empty' };

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		const now = new Date();
		await write
			.update(modifierGroups)
			.set({ archivedAt: now, updatedAt: now })
			.where(and(eq(modifierGroups.restaurantId, restaurantId), eq(modifierGroups.id, groupId)));
	});
	return CHANGED;
}

// ── Modifiers ─────────────────────────────────────────────────────────────────

export async function createModifier(
	tx: DbTx,
	restaurantId: string,
	input: { groupId: string; name: string; priceDeltaMinor: bigint }
): Promise<Created | NotFound> {
	assertMinor(input.priceDeltaMinor, 'priceDeltaMinor');
	if (!(await liveGroup(tx, restaurantId, input.groupId))) return NOT_FOUND;

	return withMenuVersionBump(tx, restaurantId, async (write) => {
		const [row] = await write
			.insert(modifiers)
			.values({
				restaurantId,
				groupId: input.groupId,
				name: input.name,
				priceDeltaMinor: input.priceDeltaMinor
			})
			.returning({ id: modifiers.id });
		return { ok: true as const, id: row.id };
	});
}

/** A change to price_delta_minor writes ONE menu.price_changed row, target 'modifier'. */
export async function updateModifier(
	tx: DbTx,
	restaurantId: string,
	modifierId: string,
	changes: { name?: string; priceDeltaMinor?: bigint },
	ctx: MenuWriteContext
): Promise<Changed | NotFound> {
	const current = await liveModifier(tx, restaurantId, modifierId);
	if (!current) return NOT_FOUND;

	const set: { name?: string; priceDeltaMinor?: bigint } = {};
	if (changes.name !== undefined && changes.name !== current.name) set.name = changes.name;
	if (changes.priceDeltaMinor !== undefined) {
		assertMinor(changes.priceDeltaMinor, 'priceDeltaMinor');
		if (changes.priceDeltaMinor !== current.priceDeltaMinor) {
			set.priceDeltaMinor = changes.priceDeltaMinor;
		}
	}
	if (Object.keys(set).length === 0) return UNCHANGED;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		await write
			.update(modifiers)
			.set({ ...set, updatedAt: new Date() })
			.where(and(eq(modifiers.restaurantId, restaurantId), eq(modifiers.id, modifierId)));
		if (set.priceDeltaMinor !== undefined) {
			await writeAudit(write, {
				restaurantId,
				actorUserId: ctx.actorUserId,
				subjectUserId: null,
				event: 'menu.price_changed',
				details: {
					// The discriminator is what says, forever, which entity targetId names.
					target: 'modifier',
					targetId: modifierId,
					name: set.name ?? current.name,
					oldPriceMinor: current.priceDeltaMinor.toString(),
					newPriceMinor: set.priceDeltaMinor.toString()
				},
				ip: ctx.ip,
				userAgent: ctx.userAgent
			});
		}
	});
	return CHANGED;
}

export async function archiveModifier(
	tx: DbTx,
	restaurantId: string,
	modifierId: string
): Promise<Changed | NotFound> {
	if (!(await liveModifier(tx, restaurantId, modifierId))) return NOT_FOUND;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		const now = new Date();
		await write
			.update(modifiers)
			.set({ archivedAt: now, updatedAt: now })
			.where(and(eq(modifiers.restaurantId, restaurantId), eq(modifiers.id, modifierId)));
	});
	return CHANGED;
}

// ── Item ↔ group links ────────────────────────────────────────────────────────

function linkWhere(restaurantId: string, itemId: string, groupId: string) {
	return and(
		eq(menuItemModifierGroups.restaurantId, restaurantId),
		eq(menuItemModifierGroups.menuItemId, itemId),
		eq(menuItemModifierGroups.modifierGroupId, groupId)
	);
}

export async function linkModifierGroup(
	tx: DbTx,
	restaurantId: string,
	itemId: string,
	groupId: string,
	sortOrder = 0
): Promise<Changed | NotFound> {
	if (!(await liveItem(tx, restaurantId, itemId))) return NOT_FOUND;
	if (!(await liveGroup(tx, restaurantId, groupId))) return NOT_FOUND;
	const [existing] = await tx
		.select({ itemId: menuItemModifierGroups.menuItemId })
		.from(menuItemModifierGroups)
		.where(linkWhere(restaurantId, itemId, groupId));
	if (existing) return UNCHANGED;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		await write
			.insert(menuItemModifierGroups)
			.values({ restaurantId, menuItemId: itemId, modifierGroupId: groupId, sortOrder });
	});
	return CHANGED;
}

/** Unlink a group from an item — the one DELETE in this module, of a configuration link. */
export async function unlinkModifierGroup(
	tx: DbTx,
	restaurantId: string,
	itemId: string,
	groupId: string
): Promise<Changed> {
	const [existing] = await tx
		.select({ itemId: menuItemModifierGroups.menuItemId })
		.from(menuItemModifierGroups)
		.where(linkWhere(restaurantId, itemId, groupId));
	if (!existing) return UNCHANGED;

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		await write.delete(menuItemModifierGroups).where(linkWhere(restaurantId, itemId, groupId));
	});
	return CHANGED;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The integer the POS compares (spec 5). An integer, so a plain number. */
export async function getMenuVersion(database: Executor, restaurantId: string): Promise<number> {
	const [row] = await database
		.select({ menuVersion: restaurantSettings.menuVersion })
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId))
		.limit(1);
	if (!row) throw new Error(`No settings row for restaurant ${restaurantId}`);
	return row.menuVersion;
}

/**
 * Does the restaurant have at least one LIVE menu item? `limit 1`, not a count:
 * the question is "is there one", and the answer must not slow down as the menu
 * grows. An ARCHIVED item does not count — a restaurant that archived everything
 * it sells has not finished setting up its menu.
 */
export async function hasMenuItems(database: Executor, restaurantId: string): Promise<boolean> {
	const rows = await database
		.select({ id: menuItems.id })
		.from(menuItems)
		.where(and(eq(menuItems.restaurantId, restaurantId), isNull(menuItems.archivedAt)))
		.limit(1);
	return rows.length > 0;
}

/**
 * The live menu for the dashboard page: archived rows never appear, and a link
 * appears only between a live item and a live group. Prices stay bigint.
 */
export async function listMenu(database: Executor, restaurantId: string) {
	const categories = await database
		.select({
			id: menuCategories.id,
			name: menuCategories.name,
			sortOrder: menuCategories.sortOrder
		})
		.from(menuCategories)
		.where(and(eq(menuCategories.restaurantId, restaurantId), isNull(menuCategories.archivedAt)))
		.orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name));

	const items = await database
		.select({
			id: menuItems.id,
			categoryId: menuItems.categoryId,
			name: menuItems.name,
			priceMinor: menuItems.priceMinor,
			taxRateBp: menuItems.taxRateBp,
			isAvailable: menuItems.isAvailable,
			sortOrder: menuItems.sortOrder
		})
		.from(menuItems)
		.where(and(eq(menuItems.restaurantId, restaurantId), isNull(menuItems.archivedAt)))
		.orderBy(asc(menuItems.sortOrder), asc(menuItems.name));

	const groups = await database
		.select({
			id: modifierGroups.id,
			name: modifierGroups.name,
			minSelect: modifierGroups.minSelect,
			maxSelect: modifierGroups.maxSelect
		})
		.from(modifierGroups)
		.where(and(eq(modifierGroups.restaurantId, restaurantId), isNull(modifierGroups.archivedAt)))
		.orderBy(asc(modifierGroups.name));

	const modifierRows = await database
		.select({
			id: modifiers.id,
			groupId: modifiers.groupId,
			name: modifiers.name,
			priceDeltaMinor: modifiers.priceDeltaMinor
		})
		.from(modifiers)
		.where(and(eq(modifiers.restaurantId, restaurantId), isNull(modifiers.archivedAt)))
		.orderBy(asc(modifiers.name));

	const links = await database
		.select({
			menuItemId: menuItemModifierGroups.menuItemId,
			modifierGroupId: menuItemModifierGroups.modifierGroupId,
			sortOrder: menuItemModifierGroups.sortOrder
		})
		.from(menuItemModifierGroups)
		.innerJoin(menuItems, eq(menuItems.id, menuItemModifierGroups.menuItemId))
		.innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.modifierGroupId))
		.where(
			and(
				eq(menuItemModifierGroups.restaurantId, restaurantId),
				isNull(menuItems.archivedAt),
				isNull(modifierGroups.archivedAt)
			)
		)
		.orderBy(asc(menuItemModifierGroups.sortOrder));

	return { categories, items, modifierGroups: groups, modifiers: modifierRows, links };
}

/**
 * The till's FULL snapshot (spec 5 — no change-only sync). The CALLER runs this in
 * ONE repeatable-read, read-only transaction, so the version and every row come
 * from a single database snapshot: under read committed a price edit landing
 * between two of these queries would ship new rows stamped with the old version,
 * and the device would believe it was current while holding a menu that is not.
 *
 * Live rows only; an unavailable item IS included, because the till greys a
 * sold-out item out rather than forgetting it exists. The currency code, the tax
 * mode and the restaurant's tax rate come back AS STORED — null while unchosen —
 * and the currency is not looked up here: this module imports nothing from
 * src/lib/money. Prices stay bigint; the route decides how they cross JSON.
 */
export async function readMenuSnapshot(database: Executor, restaurantId: string) {
	const [settings] = await database
		.select({
			version: restaurantSettings.menuVersion,
			currencyCode: restaurantSettings.currencyCode,
			taxMode: restaurantSettings.taxMode,
			taxRateBp: restaurantSettings.taxRateBp
		})
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId))
		.limit(1);
	if (!settings) throw new Error(`No settings row for restaurant ${restaurantId}`);
	return { ...settings, ...(await listMenu(database, restaurantId)) };
}
