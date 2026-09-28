import { desc, sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	bigint,
	integer,
	numeric,
	date,
	timestamp,
	index,
	unique,
	check,
	foreignKey
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { users } from './users';
import { journalEntries } from './accounting';
import { ingredients } from './inventory';

// PURCHASES (spec 19): a delivery of ingredients in purchase units, converted to
// base units, paid immediately (Dr 1200 / Cr 1000 Cash or 1010 Bank) or on credit
// (Dr 1200 / Cr 2000 Accounts Payable) and paid later by supplier payments
// (Dr 2000 / Cr 1000 | 1010).
//
// ACCOUNTS PAYABLE (2000) IS IN THE MVP, SUPPLIER MANAGEMENT IS NOT (spec 19,
// CLAUDE.md's "Do NOT build"): the supplier is a free-text name on the delivery,
// never a supplier record. "cash" means cash kept OUTSIDE the till (CLAUDE.md,
// "Inventory 3"); drawer cash is a POS pay-out, a later plan.
//
// Stock NEVER arrives through these tables: a delivery's goods reach the ledger
// only as stock_movements written by applyMovements (invariant 6).
//
// WRITTEN ONCE, NEVER EDITED (invariant 2). A header's journal_entry_id and its
// reversal_* columns are each written once after insert; nothing else on a header
// ever changes, and nothing may issue an UPDATE touching total_minor, paid_by,
// amount_minor, paid_from or business_date — that is enforced by code, because the
// once-written stamps rule out a trigger on the headers. purchase_lines are
// append-only in custom migration 0014 (T-08). A wrong delivery or payment is
// corrected by a reversal with a reason (CLAUDE.md, "Inventory 5"), never an edit.
//
// MONEY is bigint minor units (invariant 1); quantities numeric(12,3).

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const qtyColumn = (name: string) => numeric(name, { precision: 12, scale: 3 });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'restrict' });
const entryRef = (name: string) =>
	uuid(name).references(() => journalEntries.id, { onDelete: 'restrict' });

export const purchases = pgTable(
	'purchases',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		supplierName: text('supplier_name').notNull(),
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		paidBy: text('paid_by').notNull(),
		totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
		note: text('note'),
		recordedByUserId: userRef('recorded_by_user_id').notNull(),
		recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
		// Written once, after the entry is posted.
		journalEntryId: entryRef('journal_entry_id'),
		// The reversal stamp, written once (purchases_reversal_fields).
		reversedAt: timestamp('reversed_at', { withTimezone: true }),
		reversedByUserId: userRef('reversed_by_user_id'),
		reversalReason: text('reversal_reason'),
		reversalEntryId: entryRef('reversal_entry_id')
	},
	(t) => [
		check(
			'purchases_supplier_name_length',
			sql`char_length(btrim(${t.supplierName})) between 1 and 120`
		),
		check('purchases_paid_by_valid', sql`${t.paidBy} in ('cash', 'bank', 'credit')`),
		check('purchases_total_non_negative', sql`${t.totalMinor} >= 0`),
		check(
			'purchases_reversal_fields',
			sql`(${t.reversedAt} is null) = (${t.reversedByUserId} is null) and (${t.reversedAt} is null) = (${t.reversalReason} is null) and (${t.reversalReason} is null or char_length(btrim(${t.reversalReason})) between 3 and 200)`
		),
		// Target of purchase_lines_purchase_fk and supplier_payments_purchase_fk.
		unique('purchases_id_restaurant_unique').on(t.id, t.restaurantId),
		index('purchases_restaurant_business_date_idx').on(t.restaurantId, t.businessDate),
		index('purchases_restaurant_recorded_idx').on(t.restaurantId, desc(t.recordedAt))
	]
);

export const purchaseLines = pgTable(
	'purchase_lines',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		purchaseId: uuid('purchase_id').notNull(),
		lineNo: integer('line_no').notNull(),
		ingredientId: uuid('ingredient_id').notNull(),
		// Snapshots: a later rename or refactor of the unit cannot change this line.
		purchaseUnitName: text('purchase_unit_name').notNull(),
		unitQty: qtyColumn('unit_qty').notNull(),
		baseQtyPerUnit: qtyColumn('base_qty_per_unit').notNull(),
		baseQty: qtyColumn('base_qty').notNull(),
		lineCostMinor: bigint('line_cost_minor', { mode: 'bigint' }).notNull(),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.purchaseId],
			foreignColumns: [purchases.restaurantId, purchases.id],
			name: 'purchase_lines_purchase_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [t.restaurantId, t.ingredientId],
			foreignColumns: [ingredients.restaurantId, ingredients.id],
			name: 'purchase_lines_ingredient_fk'
		}).onDelete('restrict'),
		unique('purchase_lines_purchase_line_no_unique').on(t.purchaseId, t.lineNo),
		index('purchase_lines_ingredient_idx').on(t.ingredientId),
		check(
			'purchase_lines_amounts_valid',
			sql`${t.unitQty} > 0 and ${t.baseQtyPerUnit} > 0 and ${t.baseQty} > 0 and ${t.lineCostMinor} >= 0 and ${t.lineNo} >= 1`
		)
	]
);

export const supplierPayments = pgTable(
	'supplier_payments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		purchaseId: uuid('purchase_id').notNull(),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		paidFrom: text('paid_from').notNull(),
		businessDate: date('business_date', { mode: 'string' }).notNull(),
		recordedByUserId: userRef('recorded_by_user_id').notNull(),
		recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
		journalEntryId: entryRef('journal_entry_id'),
		reversedAt: timestamp('reversed_at', { withTimezone: true }),
		reversedByUserId: userRef('reversed_by_user_id'),
		reversalReason: text('reversal_reason'),
		reversalEntryId: entryRef('reversal_entry_id')
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.purchaseId],
			foreignColumns: [purchases.restaurantId, purchases.id],
			name: 'supplier_payments_purchase_fk'
		}).onDelete('restrict'),
		index('supplier_payments_purchase_idx').on(t.purchaseId),
		check('supplier_payments_amount_positive', sql`${t.amountMinor} > 0`),
		check('supplier_payments_paid_from_valid', sql`${t.paidFrom} in ('cash', 'bank')`),
		check(
			'supplier_payments_reversal_fields',
			sql`(${t.reversedAt} is null) = (${t.reversedByUserId} is null) and (${t.reversedAt} is null) = (${t.reversalReason} is null) and (${t.reversalReason} is null or char_length(btrim(${t.reversalReason})) between 3 and 200)`
		)
	]
);
