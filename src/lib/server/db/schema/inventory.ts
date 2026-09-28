import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	bigint,
	numeric,
	date,
	timestamp,
	index,
	uniqueIndex,
	unique,
	check,
	foreignKey
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { menuItems, modifiers } from './menu';
import { users } from './users';

// INVENTORY (spec 15, 16, 3): ingredients, the units they are bought in, and the
// recipes that say what each dish and each modifier uses.
//
// SPEC 15'S MODEL. An ingredient has ONE base unit (g, pcs, can) as free text;
// recipes are written in base units; purchases arrive in purchase units (kg, bag,
// case), each a row here with base_qty_per_unit, and are converted to base units
// before anything touches the ledger. A modifier changes the recipe as well as the
// price (Extra Cheese → +1 cheese), so a recipe line belongs to EITHER a menu item
// OR a modifier, never both.
//
// THE THREE CACHE COLUMNS — on_hand_qty, inventory_value_minor and
// avg_unit_cost_micro — are NEVER the truth (spec 3, invariant 6): stock on hand is
// the sum of stock_movements. They are written ONLY by applyMovements
// (src/lib/server/inventory/movements.ts, tasks/inventory-cogs T-16), under a row
// lock, inside the transaction that inserts the movement that changed them.
//
// avg_unit_cost_micro is MICRO minor units per base unit (minor × 1,000,000):
// spec 16's $5.50 per kg with a base unit of grams is 0.55 cents per gram, stored
// as 550000. A per-gram cost is a fraction of a cent and cannot be a _minor
// integer, which is why the schema guard lists it in MONEY_NAME_EXEMPT (CLAUDE.md,
// "Inventory 6"). The three value CHECKs on ingredients are the costing invariants
// of tasks/inventory-cogs/00-overview.md ("Shared contracts → Costing"): the
// average is never negative, zero stock holds zero value, positive stock never
// holds negative value. The zero defaults answer no open decision: a new
// ingredient has no stock.
//
// QUANTITIES are numeric(12,3) named *_qty (spec 17; the schema guard's one
// fixed-point type). pg returns them as strings, parsed ONCE by parseQty
// (src/lib/money/quantity.ts).
//
// RECIPE LINES ARE CONFIGURATION, not posted records (invariant 2 does not reach
// them): setRecipe replaces an owner's rows. The POS never sees them — the menu
// snapshot carries no recipe, and no cost column lives on menu_items (menu.ts).
//
// TENANT: composite (restaurant_id, id) foreign keys, each target a unique()
// CONSTRAINT inside its own CREATE TABLE, never a uniqueIndex() — menu.ts's header
// explains the 42830 ordering trap. modifiers has no composite unique, so
// recipe_lines.modifier_id is a single-column FK, as order_line_modifiers' is.

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const archivedAt = () => timestamp('archived_at', { withTimezone: true });
const qtyColumn = (name: string) => numeric(name, { precision: 12, scale: 3 });

export const ingredients = pgTable(
	'ingredients',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		name: text('name').notNull(),
		baseUnit: text('base_unit').notNull(),
		// CACHE — written only by applyMovements.
		onHandQty: qtyColumn('on_hand_qty').notNull().default('0'),
		// CACHE — written only by applyMovements. sql`0`, not 0n (pos-sales' idiom).
		inventoryValueMinor: bigint('inventory_value_minor', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		// CACHE — micro minor units per base unit; written only by applyMovements.
		avgUnitCostMicro: bigint('avg_unit_cost_micro', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		archivedAt: archivedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		// Target of every composite FK to an ingredient.
		unique('ingredients_id_restaurant_unique').on(t.id, t.restaurantId),
		uniqueIndex('ingredients_name_unique')
			.on(t.restaurantId, sql`lower(${t.name})`)
			.where(sql`${t.archivedAt} is null`),
		index('ingredients_restaurant_id_idx').on(t.restaurantId),
		check('ingredients_name_length', sql`char_length(btrim(${t.name})) between 1 and 80`),
		check('ingredients_base_unit_length', sql`char_length(btrim(${t.baseUnit})) between 1 and 16`),
		check('ingredients_avg_non_negative', sql`${t.avgUnitCostMicro} >= 0`),
		check(
			'ingredients_zero_qty_zero_value',
			sql`${t.onHandQty} <> 0 or ${t.inventoryValueMinor} = 0`
		),
		check(
			'ingredients_positive_qty_non_negative_value',
			sql`${t.onHandQty} <= 0 or ${t.inventoryValueMinor} >= 0`
		)
	]
);

export const ingredientPurchaseUnits = pgTable(
	'ingredient_purchase_units',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		ingredientId: uuid('ingredient_id').notNull(),
		name: text('name').notNull(),
		// How many base units one purchase unit holds: 1 kg of a gram ingredient is 1000.
		baseQtyPerUnit: qtyColumn('base_qty_per_unit').notNull(),
		archivedAt: archivedAt(),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.ingredientId],
			foreignColumns: [ingredients.restaurantId, ingredients.id],
			name: 'ingredient_purchase_units_ingredient_fk'
		}).onDelete('restrict'),
		unique('ingredient_purchase_units_id_restaurant_unique').on(t.id, t.restaurantId),
		uniqueIndex('ingredient_purchase_units_name_unique')
			.on(t.ingredientId, sql`lower(${t.name})`)
			.where(sql`${t.archivedAt} is null`),
		index('ingredient_purchase_units_ingredient_idx').on(t.ingredientId),
		check(
			'ingredient_purchase_units_name_length',
			sql`char_length(btrim(${t.name})) between 1 and 24`
		),
		check('ingredient_purchase_units_factor_positive', sql`${t.baseQtyPerUnit} > 0`)
	]
);

export const recipeLines = pgTable(
	'recipe_lines',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		// Exactly one owner (recipe_lines_one_owner).
		menuItemId: uuid('menu_item_id'),
		modifierId: uuid('modifier_id').references(() => modifiers.id, { onDelete: 'restrict' }),
		ingredientId: uuid('ingredient_id').notNull(),
		// Base units. An item's line is positive; a modifier's may be negative
		// ("No cheese" takes the item's cheese away) but never zero.
		qty: qtyColumn('qty').notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.menuItemId],
			foreignColumns: [menuItems.restaurantId, menuItems.id],
			name: 'recipe_lines_menu_item_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [t.restaurantId, t.ingredientId],
			foreignColumns: [ingredients.restaurantId, ingredients.id],
			name: 'recipe_lines_ingredient_fk'
		}).onDelete('restrict'),
		check('recipe_lines_one_owner', sql`(${t.menuItemId} is null) <> (${t.modifierId} is null)`),
		check(
			'recipe_lines_qty_sign',
			sql`(${t.menuItemId} is not null and ${t.qty} > 0) or (${t.modifierId} is not null and ${t.qty} <> 0)`
		),
		uniqueIndex('recipe_lines_item_ingredient_unique')
			.on(t.menuItemId, t.ingredientId)
			.where(sql`${t.menuItemId} is not null`),
		uniqueIndex('recipe_lines_modifier_ingredient_unique')
			.on(t.modifierId, t.ingredientId)
			.where(sql`${t.modifierId} is not null`),
		index('recipe_lines_ingredient_idx').on(t.ingredientId)
	]
);

// THE STOCK LEDGER (spec 3, 15; invariant 6). Stock on hand IS the sum of these
// rows; the ingredients caches are a copy. Every row is inserted by applyMovements
// (T-16) and none is ever updated or deleted: stock_movements, waste_entries,
// stock_count_lines and opening_stock_entries become append-only in custom
// migration 0014 (T-08). A mistake is corrected by a new, opposite movement.
//
// SIGN BY TYPE (stock_movements_sign_by_type): purchase and opening_stock bring
// goods in (qty > 0, cost >= 0); purchase_reversal, sale_consumption, waste and
// comp take them out (qty < 0, cost <= 0); count_adjustment goes either way but is
// never zero. A zero-quantity consumption is refused: callers skip it.
//
// A REVALUATION row carries qty = 0 and a non-zero cost: it moves VALUE, not goods
// — the gap between the old average and a late delivery's price on goods already
// sold (CLAUDE.md, "Inventory 2").
//
// source_id has NO foreign key: it points at a purchase, an order, a waste entry,
// a count or an opening-stock entry depending on source_type, so the pair is
// indexed instead.
//
// business_date is the business date of the event that caused the movement —
// the POS session's for a sale, the chosen day for a dashboard write — and is
// NEVER derived from created_at (invariant 11).
export const stockMovements = pgTable(
	'stock_movements',
	{
		id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
		restaurantId: tenant(),
		ingredientId: uuid('ingredient_id').notNull(),
		movementType: text('movement_type').notNull(),
		// Base units, signed by type.
		qty: qtyColumn('qty').notNull(),
		// The value that moved, signed like qty (a revaluation: either sign).
		costMinor: bigint('cost_minor', { mode: 'bigint' }).notNull(),
		sourceType: text('source_type').notNull(),
		sourceId: uuid('source_id').notNull(),
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
		// NULL for a sale synced from the till (the actor is the employee on the order).
		recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
			onDelete: 'restrict'
		}),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.ingredientId],
			foreignColumns: [ingredients.restaurantId, ingredients.id],
			name: 'stock_movements_ingredient_fk'
		}).onDelete('restrict'),
		// The literals are MOVEMENT_TYPES and MOVEMENT_SOURCES in
		// src/lib/server/inventory/movements.ts (T-16); the constraints test pins them.
		check(
			'stock_movements_type_valid',
			sql`${t.movementType} in ('purchase', 'purchase_reversal', 'opening_stock', 'sale_consumption', 'waste', 'count_adjustment', 'comp', 'revaluation')`
		),
		check(
			'stock_movements_source_valid',
			sql`${t.sourceType} in ('purchase', 'order', 'waste_entry', 'stock_count', 'opening_stock')`
		),
		check(
			'stock_movements_sign_by_type',
			sql`(${t.movementType} in ('purchase', 'opening_stock') and ${t.qty} > 0 and ${t.costMinor} >= 0) or (${t.movementType} in ('purchase_reversal', 'sale_consumption', 'waste', 'comp') and ${t.qty} < 0 and ${t.costMinor} <= 0) or (${t.movementType} = 'count_adjustment' and ${t.qty} <> 0) or (${t.movementType} = 'revaluation' and ${t.qty} = 0 and ${t.costMinor} <> 0)`
		),
		index('stock_movements_ingredient_time_idx').on(t.restaurantId, t.ingredientId, t.occurredAt),
		index('stock_movements_restaurant_business_date_idx').on(t.restaurantId, t.businessDate),
		index('stock_movements_source_idx').on(t.sourceType, t.sourceId)
	]
);

// Stock already on the shelf at go-live (CLAUDE.md, "Inventory 1"): one entry per
// ingredient, only while it has no movement at all; posts Dr 1200 / Cr 3000.
// Append-only (T-08). The purchase-unit name and factor are snapshots.
export const openingStockEntries = pgTable(
	'opening_stock_entries',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		ingredientId: uuid('ingredient_id').notNull(),
		purchaseUnitName: text('purchase_unit_name').notNull(),
		unitQty: qtyColumn('unit_qty').notNull(),
		baseQtyPerUnit: qtyColumn('base_qty_per_unit').notNull(),
		baseQty: qtyColumn('base_qty').notNull(),
		unitCostMinor: bigint('unit_cost_minor', { mode: 'bigint' }).notNull(),
		valueMinor: bigint('value_minor', { mode: 'bigint' }).notNull(),
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		recordedByUserId: uuid('recorded_by_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.ingredientId],
			foreignColumns: [ingredients.restaurantId, ingredients.id],
			name: 'opening_stock_entries_ingredient_fk'
		}).onDelete('restrict'),
		uniqueIndex('opening_stock_entries_ingredient_unique').on(t.ingredientId),
		check(
			'opening_stock_entries_amounts_valid',
			sql`${t.unitQty} > 0 and ${t.baseQtyPerUnit} > 0 and ${t.baseQty} > 0 and ${t.unitCostMinor} >= 0 and ${t.valueMinor} >= 0`
		)
	]
);

// Waste (spec 15, 24): goods thrown away, costed at the average and posted
// Dr 5100 / Cr 1200. Append-only (T-08).
export const wasteEntries = pgTable(
	'waste_entries',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		ingredientId: uuid('ingredient_id').notNull(),
		qty: qtyColumn('qty').notNull(),
		reason: text('reason').notNull(),
		note: text('note'),
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		recordedByUserId: uuid('recorded_by_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.ingredientId],
			foreignColumns: [ingredients.restaurantId, ingredients.id],
			name: 'waste_entries_ingredient_fk'
		}).onDelete('restrict'),
		index('waste_entries_restaurant_business_date_idx').on(t.restaurantId, t.businessDate),
		check('waste_entries_qty_positive', sql`${t.qty} > 0`),
		check(
			'waste_entries_reason_valid',
			sql`${t.reason} in ('spoilage', 'preparation_error', 'breakage', 'other')`
		),
		check(
			'waste_entries_note_for_other',
			sql`${t.reason} <> 'other' or (${t.note} is not null and char_length(btrim(${t.note})) between 3 and 200)`
		)
	]
);

// A stock count (spec 15): the header. Its lines carry the system quantity read
// from the ledger under the ingredient locks at posting time.
export const stockCounts = pgTable(
	'stock_counts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		countedAt: timestamp('counted_at', { withTimezone: true }).notNull(),
		note: text('note'),
		recordedByUserId: uuid('recorded_by_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		createdAt: createdAt()
	},
	(t) => [
		// Target of stock_count_lines_count_fk.
		unique('stock_counts_id_restaurant_unique').on(t.id, t.restaurantId),
		index('stock_counts_restaurant_business_date_idx').on(t.restaurantId, t.businessDate)
	]
);

// One line per counted ingredient. Append-only (T-08).
export const stockCountLines = pgTable(
	'stock_count_lines',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		countId: uuid('count_id').notNull(),
		ingredientId: uuid('ingredient_id').notNull(),
		systemQty: qtyColumn('system_qty').notNull(),
		countedQty: qtyColumn('counted_qty').notNull(),
		differenceQty: qtyColumn('difference_qty').notNull(),
		// Signed: the value of the adjustment, negative for a shortfall.
		costMinor: bigint('cost_minor', { mode: 'bigint' }).notNull(),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.countId],
			foreignColumns: [stockCounts.restaurantId, stockCounts.id],
			name: 'stock_count_lines_count_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [t.restaurantId, t.ingredientId],
			foreignColumns: [ingredients.restaurantId, ingredients.id],
			name: 'stock_count_lines_ingredient_fk'
		}).onDelete('restrict'),
		uniqueIndex('stock_count_lines_count_ingredient_unique').on(t.countId, t.ingredientId),
		check('stock_count_lines_counted_non_negative', sql`${t.countedQty} >= 0`),
		check(
			'stock_count_lines_difference',
			sql`${t.differenceQty} = ${t.countedQty} - ${t.systemQty}`
		)
	]
);
