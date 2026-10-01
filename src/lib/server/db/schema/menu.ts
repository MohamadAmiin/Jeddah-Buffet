import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	integer,
	bigint,
	boolean,
	timestamp,
	index,
	uniqueIndex,
	unique,
	check,
	foreignKey,
	primaryKey,
	customType
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { taxRates } from './tax-rates';

// THE MENU (spec 3, 5, 15, 17): categories, items, modifier groups, the item ↔
// group links, and modifiers. The POS downloads all of it as one snapshot,
// governed by restaurant_settings.menu_version (spec 5) — every write here bumps
// it, in the menu module, in the same transaction.
//
// MONEY IS BIGINT MINOR UNITS, mode 'bigint' (invariant 1): price_minor and
// price_delta_minor are 850 for $8.50. client.ts installs no type parsers, so pg
// hands int8 back as a string and mode 'bigint' turns it into a JavaScript bigint;
// mode 'number' would hand money to the one type invariant 1 forbids. A negative
// price_delta_minor is legitimate ("No cheese −$0.50"); a negative price is not.
//
// TAX: an item's rate is menu_items.tax_rate_id, a NAMED rate in tax_rates
// (tasks/settings-tax-payments-receipt). It is NULLABLE, and NULL means "the
// restaurant default" (restaurant_settings.default_tax_rate_id). The composite
// (restaurant_id, tax_rate_id) FK keeps a non-NULL id inside the same
// restaurant; PostgreSQL's default MATCH SIMPLE skips the check when the id is
// NULL.
// menu_items.tax_rate_bp — the old per-item override in integer basis points,
// NULL = inherit — is being REPLACED: the menu module still writes it until T-13
// switches items to tax_rate_id, migration 0017 copies its values into named
// rates, and T-33 drops it in migration 0018. No new code may read tax_rate_bp.
//
// ARCHIVE, NEVER DELETE (invariant 2). archived_at exists so that the sales
// plan's order lines, which reference menu_items.id and modifiers.id, never
// force an alteration of a populated table: a read excludes archived rows, and
// nothing issues a DELETE against categories, items, groups or modifiers. The
// plain DELETEs are two: unlinking a group from an item, and dropping a REPLACED
// (or removed) menu_images row — both configuration, not posted records; an
// order line snapshots the modifiers a guest actually chose (invariant 7) and
// never references a photo.
//
// CATEGORIES ARE OPTIONAL (tasks/menu-and-printing, 2026-09-29):
// menu_items.category_id is NULLABLE and NULL means "No category" — the till
// shows such items under its synthetic "Other" tab. The composite FK still
// applies whenever the column is set (PostgreSQL's default MATCH SIMPLE skips
// the check when any referencing column is NULL), so a non-NULL category must
// still belong to the same restaurant. Archiving a category MOVES its live items
// to NULL in the menu module, in one transaction and one version bump.
//
// PHOTOS live in menu_images as bytea — in PostgreSQL rather than on disk or in
// object storage, so the spec 29 pg_dump backups cover them and no new service
// or credential exists. byte_size is capped at 409,600 so one multipart upload
// stays under adapter-node's default 512K body limit (src/lib/menu-images.ts
// owns that number). A photo row is NEVER edited: a new photo is a new row and
// a new id, which is what lets the routes serve it as immutable. It is read
// ONLY through a restaurant-scoped lookup (readImage in
// src/lib/server/menu/images.ts) and referenced by menu_items.image_id through
// the composite FK below.
//
// NO RECIPE COLUMN, deliberately. Spec 15's recipes link items to ingredients in
// numeric(12,3) base units and belong to the inventory plan, which has no tables
// yet; a nullable column pointing at nothing is a guess a migration makes
// permanent. The seam left is the stable uuid of an item or a modifier. Cost
// never lands here either: it is the inventory ledger's weighted average
// (invariant 6), never a number typed on a menu item.
//
// TENANT: every table carries restaurant_id, and a child references its parent
// through a COMPOSITE (restaurant_id, id) foreign key, so the database refuses an
// item in another restaurant's category — a single-column FK would accept it.
// PostgreSQL needs a unique index on exactly that pair in every TARGET table, or
// it refuses the FK at migrate time; menu_categories, modifier_groups,
// menu_items and menu_images are the four targets, and each carries one — declared as a UNIQUE
// CONSTRAINT (unique()), not a uniqueIndex(). The difference is statement ORDER:
// drizzle-kit writes a constraint inside CREATE TABLE but every CREATE INDEX after
// all the foreign keys, so a unique INDEX would not exist yet when the composite FK
// is added, and the migration dies with 42830 ("there is no unique constraint
// matching given keys"). A unique constraint IS a unique index underneath.

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const menuCategories = pgTable(
	'menu_categories',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		name: text('name').notNull(),
		sortOrder: integer('sort_order').notNull().default(0),
		archivedAt: archivedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(table) => [
		index('menu_categories_restaurant_id_idx').on(table.restaurantId),
		// Two LIVE categories called "Drinks" and "drinks" are a data-entry accident;
		// an archived one frees its name. users_email_lower_unique is the idiom.
		uniqueIndex('menu_categories_name_unique')
			.on(table.restaurantId, sql`lower(${table.name})`)
			.where(sql`${table.archivedAt} is null`),
		unique('menu_categories_id_restaurant_unique').on(table.id, table.restaurantId)
	]
);

// bytea has no builder in drizzle-orm 0.45 (pg-core/columns holds none), so the
// column is a customType: the pg driver hands bytea back as a Buffer and takes
// one on the way in; the module boundary is a plain Uint8Array.
const byteaColumn = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType: () => 'bytea',
	toDriver: (value) => Buffer.from(value),
	fromDriver: (value) => new Uint8Array(value)
});

// A menu item's photo. No updated_at and no archived_at: a row is never edited
// or archived — a replaced photo's row is deleted by the menu module once no
// item references it (menu configuration, never referenced by an order line).
export const menuImages = pgTable(
	'menu_images',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		contentType: text('content_type').notNull(),
		byteSize: integer('byte_size').notNull(),
		bytes: byteaColumn('bytes').notNull(),
		createdAt: createdAt()
	},
	(table) => [
		index('menu_images_restaurant_id_idx').on(table.restaurantId),
		// Target of menu_items_image_fk.
		unique('menu_images_id_restaurant_unique').on(table.id, table.restaurantId),
		check(
			'menu_images_content_type_valid',
			sql`${table.contentType} in ('image/jpeg', 'image/png', 'image/webp')`
		),
		check('menu_images_byte_size_range', sql`${table.byteSize} between 1 and 409600`),
		check('menu_images_byte_size_matches', sql`octet_length(${table.bytes}) = ${table.byteSize}`)
	]
);

export const menuItems = pgTable(
	'menu_items',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		// NULL = "No category" (the till's "Other" tab).
		categoryId: uuid('category_id'),
		name: text('name').notNull(),
		priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
		// NULL = inherit the restaurant's rate.
		taxRateBp: integer('tax_rate_bp'),
		// NULL = the restaurant default (restaurant_settings.default_tax_rate_id).
		taxRateId: uuid('tax_rate_id'),
		isAvailable: boolean('is_available').notNull().default(true),
		sortOrder: integer('sort_order').notNull().default(0),
		// NULL = no photo. A photo row is never edited; a new photo is a new id.
		imageId: uuid('image_id'),
		archivedAt: archivedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(table) => [
		index('menu_items_restaurant_category_idx').on(table.restaurantId, table.categoryId),
		// A target of menu_item_modifier_groups' composite FK.
		unique('menu_items_id_restaurant_unique').on(table.id, table.restaurantId),
		foreignKey({
			columns: [table.restaurantId, table.categoryId],
			foreignColumns: [menuCategories.restaurantId, menuCategories.id],
			name: 'menu_items_category_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [table.restaurantId, table.imageId],
			foreignColumns: [menuImages.restaurantId, menuImages.id],
			name: 'menu_items_image_fk'
		}).onDelete('restrict'),
		index('menu_items_image_idx').on(table.imageId),
		foreignKey({
			columns: [table.restaurantId, table.taxRateId],
			foreignColumns: [taxRates.restaurantId, taxRates.id],
			name: 'menu_items_tax_rate_fk'
		}).onDelete('restrict'),
		index('menu_items_tax_rate_idx').on(table.taxRateId),
		// A menu price is never negative; a discount is its own concept with its own
		// approval rule (spec 14).
		check('menu_items_price_minor_non_negative', sql`${table.priceMinor} >= 0`),
		check(
			'menu_items_tax_rate_bp_range',
			sql`${table.taxRateBp} is null or (${table.taxRateBp} >= 0 and ${table.taxRateBp} <= 10000)`
		)
	]
);

export const modifierGroups = pgTable(
	'modifier_groups',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		name: text('name').notNull(),
		minSelect: integer('min_select').notNull().default(0),
		maxSelect: integer('max_select').notNull().default(1),
		archivedAt: archivedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(table) => [
		index('modifier_groups_restaurant_id_idx').on(table.restaurantId),
		unique('modifier_groups_id_restaurant_unique').on(table.id, table.restaurantId),
		check(
			'modifier_groups_select_range',
			sql`${table.minSelect} >= 0 and ${table.maxSelect} >= ${table.minSelect}`
		)
	]
);

// The item ↔ group join. NO surrogate id and NO archived_at: the composite
// primary key IS the composite unique the table needs, nothing references this
// row, and unlinking is a plain DELETE — a configuration link, not a posted record.
export const menuItemModifierGroups = pgTable(
	'menu_item_modifier_groups',
	{
		restaurantId: tenant(),
		menuItemId: uuid('menu_item_id').notNull(),
		modifierGroupId: uuid('modifier_group_id').notNull(),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: createdAt()
	},
	(table) => [
		primaryKey({
			name: 'menu_item_modifier_groups_pk',
			columns: [table.menuItemId, table.modifierGroupId]
		}),
		foreignKey({
			columns: [table.restaurantId, table.menuItemId],
			foreignColumns: [menuItems.restaurantId, menuItems.id],
			name: 'menu_item_modifier_groups_item_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [table.restaurantId, table.modifierGroupId],
			foreignColumns: [modifierGroups.restaurantId, modifierGroups.id],
			name: 'menu_item_modifier_groups_group_fk'
		}).onDelete('restrict'),
		index('menu_item_modifier_groups_group_idx').on(table.modifierGroupId)
	]
);

export const modifiers = pgTable(
	'modifiers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		groupId: uuid('group_id').notNull(),
		name: text('name').notNull(),
		// May be negative: "No cheese −$0.50" is a legitimate delta. No CHECK here.
		priceDeltaMinor: bigint('price_delta_minor', { mode: 'bigint' }).notNull(),
		archivedAt: archivedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(table) => [
		index('modifiers_restaurant_group_idx').on(table.restaurantId, table.groupId),
		foreignKey({
			columns: [table.restaurantId, table.groupId],
			foreignColumns: [modifierGroups.restaurantId, modifierGroups.id],
			name: 'modifiers_group_fk'
		}).onDelete('restrict')
	]
);
