import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	integer,
	bigint,
	timestamp,
	index,
	unique,
	check,
	foreignKey
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';
import { posDevices } from './pos-devices';
import { users } from './users';
import { posSessions } from './pos-sessions';
import { menuItems, modifiers } from './menu';

// SPEC 13: order and item statuses.
//   orders.status  ∈ ('open','billed','paid','voided','refunded')
//   order_lines.status ∈ ('new','sent','voided')
// In THIS plan only 'open' and 'paid' are ever written to an order and only
// 'new' to a line — 'billed', 'voided', 'refunded', 'sent' exist in the CHECKs
// so the kitchen and approvals plans need no migration.
//
// order_type is ('dine_in', 'takeaway', 'delivery') — delivery is a tag paid
// at the till (tasks/menu-and-printing T-04); the literal list MUST equal
// ORDER_TYPES in src/lib/sync-ops, which constraints.integration.test.ts
// asserts.
//
// INVARIANT 7 — every line snapshots unit_price_minor and its RESOLVED
// tax_rate_bp (the item's own rate or the restaurant's, resolved on the
// device, NOT NULL — never "inherit"); the order snapshots tax_mode,
// currency_code, menu_version and the device's rounded subtotal_minor,
// discount_minor, tax_minor, total_minor. A later menu, rate or mode change
// therefore cannot alter a past sale, and the report never recomputes.
//
// INVARIANT 5 — invoice numbers are the DEVICE's gap-free sequence
// (POS1-000001), unique per (device_id, invoice_number) AND per
// (device_id, invoice_seq). The server never renumbers, there is no global
// sequence and no max(number)+1.
//
// INVARIANT 2 — invoices and payments get append-only triggers in migration
// 0012 (T-09). orders.status is updated EXACTLY ONCE (open → paid) inside the
// payment transaction — spec 13's own "Mark Order PAID" step — and nothing
// else updates a paid order; a mistake is a REVERSING record.
//
// The server first sees an order when it is paid (the sale.complete op
// carries the whole order), so paid_at is NOT NULL: the row is inserted with
// status = 'open' and the device's paid_at, then marked 'paid' in the same
// transaction.
//
// The arithmetic in orders_totals_identity and payments_cash_fields is a
// database GUARD that verifies an identity; the numbers are computed by
// computeOrderTotals (T-10) and changeDue (T-11) in src/lib/money/, never in
// SQL, a route or a component.
//
// discount_minor exists on orders and order_lines (bigint NOT NULL DEFAULT 0)
// and the validator (T-18) pins it to 0 until the approvals plan. payments
// takes N rows per order from day one (spec 13: split payments), while the
// till writes exactly one.

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const orders = pgTable(
	'orders',
	{
		id: uuid('id').primaryKey().defaultRandom(), // device-generated in practice
		restaurantId: tenant(),
		posSessionId: uuid('pos_session_id').notNull(),
		deviceId: uuid('device_id')
			.notNull()
			.references(() => posDevices.id, { onDelete: 'restrict' }),
		employeeUserId: uuid('employee_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		orderType: text('order_type').notNull(),
		tableLabel: text('table_label'),
		status: text('status').notNull(),
		taxMode: text('tax_mode').notNull(),
		currencyCode: text('currency_code').notNull(),
		menuVersion: integer('menu_version').notNull(),
		subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull(),
		discountMinor: bigint('discount_minor', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
		totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
		// The soft flag a recorded sale carries (T-19), e.g. 'totals_mismatch'. Null = clean.
		flagReason: text('flag_reason'),
		openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
		paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		// Target of order_lines_order_fk, payments_order_fk, invoices_order_fk.
		unique('orders_id_restaurant_unique').on(t.id, t.restaurantId),
		foreignKey({
			columns: [t.restaurantId, t.posSessionId],
			foreignColumns: [posSessions.restaurantId, posSessions.id],
			name: 'orders_session_fk'
		}).onDelete('restrict'),
		index('orders_restaurant_session_idx').on(t.restaurantId, t.posSessionId),
		index('orders_session_idx').on(t.posSessionId),
		index('orders_employee_idx').on(t.employeeUserId),
		check('orders_order_type_valid', sql`${t.orderType} in ('dine_in', 'takeaway', 'delivery')`),
		check(
			'orders_table_label_length',
			sql`${t.tableLabel} is null or char_length(${t.tableLabel}) between 1 and 32`
		),
		check(
			'orders_status_valid',
			sql`${t.status} in ('open', 'billed', 'paid', 'voided', 'refunded')`
		),
		check('orders_tax_mode_valid', sql`${t.taxMode} in ('exclusive', 'inclusive')`),
		check('orders_currency_code_format', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
		check(
			'orders_amounts_non_negative',
			sql`${t.subtotalMinor} >= 0 and ${t.discountMinor} >= 0 and ${t.taxMinor} >= 0 and ${t.totalMinor} >= 0`
		),
		check(
			'orders_totals_identity',
			sql`${t.subtotalMinor} - ${t.discountMinor} + ${t.taxMinor} = ${t.totalMinor}`
		)
	]
);

export const orderLines = pgTable(
	'order_lines',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		orderId: uuid('order_id').notNull(),
		lineNo: integer('line_no').notNull(),
		menuItemId: uuid('menu_item_id').notNull(),
		// Snapshot of the name at time of sale; the menu may rename the item later.
		itemName: text('item_name').notNull(),
		// An item COUNT: an ordinary integer, not numeric(12,3) (that is ingredient qty).
		quantity: integer('quantity').notNull(),
		unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
		// RESOLVED on the device: the item's own rate or the restaurant's. Never null.
		taxRateBp: integer('tax_rate_bp').notNull(),
		discountMinor: bigint('discount_minor', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		status: text('status').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		// Target of order_line_modifiers_line_fk.
		unique('order_lines_id_restaurant_unique').on(t.id, t.restaurantId),
		unique('order_lines_order_line_no_unique').on(t.orderId, t.lineNo),
		foreignKey({
			columns: [t.restaurantId, t.orderId],
			foreignColumns: [orders.restaurantId, orders.id],
			name: 'order_lines_order_fk'
		}).onDelete('restrict'),
		// menu_items_id_restaurant_unique already exists (migration 0007).
		foreignKey({
			columns: [t.restaurantId, t.menuItemId],
			foreignColumns: [menuItems.restaurantId, menuItems.id],
			name: 'order_lines_menu_item_fk'
		}).onDelete('restrict'),
		index('order_lines_menu_item_idx').on(t.menuItemId),
		check('order_lines_quantity_positive', sql`${t.quantity} >= 1`),
		check('order_lines_unit_price_minor_non_negative', sql`${t.unitPriceMinor} >= 0`),
		check('order_lines_tax_rate_bp_range', sql`${t.taxRateBp} >= 0 and ${t.taxRateBp} <= 10000`),
		check('order_lines_discount_minor_non_negative', sql`${t.discountMinor} >= 0`),
		check('order_lines_status_valid', sql`${t.status} in ('new', 'sent', 'voided')`)
	]
);

export const orderLineModifiers = pgTable(
	'order_line_modifiers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		orderLineId: uuid('order_line_id').notNull(),
		// SINGLE-column FK: modifiers has no (restaurant_id, id) unique, and adding one
		// to an existing table in this migration would be ordered after this FK (42830).
		modifierId: uuid('modifier_id')
			.notNull()
			.references(() => modifiers.id, { onDelete: 'restrict' }),
		modifierName: text('modifier_name').notNull(),
		// May be negative ("No cheese −$0.50"); no CHECK, like modifiers.price_delta_minor.
		priceDeltaMinor: bigint('price_delta_minor', { mode: 'bigint' }).notNull(),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.orderLineId],
			foreignColumns: [orderLines.restaurantId, orderLines.id],
			name: 'order_line_modifiers_line_fk'
		}).onDelete('restrict'),
		index('order_line_modifiers_line_idx').on(t.orderLineId)
	]
);

export const payments = pgTable(
	'payments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		orderId: uuid('order_id').notNull(),
		method: text('method').notNull(),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		// Cash only: what the customer handed over and what went back. Null for card/mobile.
		tenderedMinor: bigint('tendered_minor', { mode: 'bigint' }),
		changeMinor: bigint('change_minor', { mode: 'bigint' }),
		paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.orderId],
			foreignColumns: [orders.restaurantId, orders.id],
			name: 'payments_order_fk'
		}).onDelete('restrict'),
		index('payments_order_idx').on(t.orderId),
		check('payments_method_valid', sql`${t.method} in ('cash', 'card', 'mobile')`),
		check('payments_amount_minor_non_negative', sql`${t.amountMinor} >= 0`),
		check(
			'payments_cash_fields',
			sql`(${t.method} = 'cash' and ${t.tenderedMinor} is not null and ${t.changeMinor} is not null and ${t.tenderedMinor} >= ${t.amountMinor} and ${t.changeMinor} = ${t.tenderedMinor} - ${t.amountMinor}) or (${t.method} <> 'cash' and ${t.tenderedMinor} is null and ${t.changeMinor} is null)`
		)
	]
);

export const invoices = pgTable(
	'invoices',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		restaurantId: tenant(),
		orderId: uuid('order_id').notNull(),
		// The device whose sequence issued the number — the NAMESPACE of invoice_number.
		deviceId: uuid('device_id')
			.notNull()
			.references(() => posDevices.id, { onDelete: 'restrict' }),
		invoiceSeq: integer('invoice_seq').notNull(),
		invoiceNumber: text('invoice_number').notNull(), // 'POS1-000001'
		totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
		issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
		createdAt: createdAt()
	},
	(t) => [
		foreignKey({
			columns: [t.restaurantId, t.orderId],
			foreignColumns: [orders.restaurantId, orders.id],
			name: 'invoices_order_fk'
		}).onDelete('restrict'),
		unique('invoices_order_unique').on(t.orderId),
		// Spec 6: "the server enforces uniqueness on (device, number)". Never global.
		unique('invoices_device_number_unique').on(t.deviceId, t.invoiceNumber),
		unique('invoices_device_seq_unique').on(t.deviceId, t.invoiceSeq),
		check('invoices_seq_range', sql`${t.invoiceSeq} between 1 and 999999`),
		check('invoices_number_format', sql`${t.invoiceNumber} ~ '^[A-Z0-9]{1,8}-[0-9]{6}$'`)
	]
);
