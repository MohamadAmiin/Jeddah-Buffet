// THE payment transaction — spec 13's all-or-nothing run, in one caller's
// transaction (invariant 4). Called only by src/lib/server/orders/sync.ts
// (T-21). Order of steps is spec 13's:
//   1. Insert the order and its lines (device state before the payment).
//   2. Record the payment(s).
//   3. Finalize totals — nothing recomputed here (validateSale already
//      compared; the flag is on flag_reason).
//   4. Record the invoice number (spec 6 device namespace; a 23505 rolls
//      the whole transaction back and T-21 maps it to invoice_collision).
//   5. Deduct inventory (T-17 no-op today; the seam is in place).
//   6. Create the invoice: the row inserted in step 4 IS the invoice —
//      spec 13 and R8 list "Record Invoice Number" and "Create Invoice" as
//      two steps; this plan deliberately collapses them into ONE insert.
//   7. Post the journal entries (spec 24 rules): sale first, then COGS only
//      when cogsMinor > 0n.
//   8. Mark the order paid — the ONE status change in this function
//      (spec 13's "Mark Order PAID"; invariant 2 keeps every other row
//      immutable).
//   9. Audit: sale.recorded with clientOpId, plus sale.flagged (clientOpId
//      null) when softFlags is non-empty.
//
// Never catches, never opens a transaction of its own, never reads
// menu_items or restaurant_settings (spec 6: price at time of sale wins).

import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { ParsedSale, SoftFlag, SyncContext } from './validate';
import { toSaleLines } from './validate';
import { consumeForSale } from '../inventory/consume';
import { postEntry } from '../accounting/journal';
import { cogsLines, eventForMethod, saleLines } from '../accounting/posting-rules';
import { writeAudit } from '../audit';
import { invoices, orderLineModifiers, orderLines, orders, payments } from '../db/schema/orders';

export async function recordSale(
	tx: DbTx,
	ctx: SyncContext,
	sale: ParsedSale,
	softFlags: SoftFlag[]
): Promise<{ orderId: string; invoiceNumber: string; entryIds: string[] }> {
	if (ctx.employeeUserId === null) {
		throw new Error(
			'recordSale requires ctx.employeeUserId; T-21 must reject an unknown employee before calling this'
		);
	}

	// Step 1 — the order row and its lines/modifiers.
	await tx.insert(orders).values({
		id: sale.orderId,
		restaurantId: ctx.restaurantId,
		posSessionId: sale.posSessionId,
		deviceId: ctx.opDeviceId,
		employeeUserId: ctx.employeeUserId,
		orderType: sale.orderType,
		tableLabel: sale.tableLabel,
		status: 'open',
		taxMode: sale.taxMode,
		currencyCode: sale.currencyCode,
		menuVersion: sale.menuVersion,
		subtotalMinor: sale.totals.subtotalMinor,
		discountMinor: sale.totals.discountMinor,
		taxMinor: sale.totals.taxMinor,
		totalMinor: sale.totals.totalMinor,
		flagReason: softFlags.length > 0 ? softFlags.join(',') : null,
		openedAt: sale.openedAt,
		paidAt: ctx.occurredAt
	});

	if (sale.lines.length > 0) {
		await tx.insert(orderLines).values(
			sale.lines.map((line) => ({
				id: line.lineId,
				restaurantId: ctx.restaurantId,
				orderId: sale.orderId,
				lineNo: line.lineNo,
				menuItemId: line.menuItemId,
				itemName: line.itemName,
				quantity: line.quantity,
				unitPriceMinor: line.unitPriceMinor,
				taxRateBp: line.taxRateBp,
				discountMinor: line.discountMinor,
				status: 'new' as const
			}))
		);
		const modifierRows = sale.lines.flatMap((line) =>
			line.modifiers.map((m) => ({
				restaurantId: ctx.restaurantId,
				orderLineId: line.lineId,
				modifierId: m.modifierId,
				modifierName: m.modifierName,
				priceDeltaMinor: m.priceDeltaMinor
			}))
		);
		if (modifierRows.length > 0) {
			await tx.insert(orderLineModifiers).values(modifierRows);
		}
	}

	// Step 2 — record the payment(s). In this plan the till writes one.
	await tx.insert(payments).values({
		id: sale.payment.paymentId,
		restaurantId: ctx.restaurantId,
		orderId: sale.orderId,
		method: sale.payment.method,
		amountMinor: sale.payment.amountMinor,
		tenderedMinor: sale.payment.tenderedMinor,
		changeMinor: sale.payment.changeMinor,
		paidAt: ctx.occurredAt
	});

	// Step 3 — finalize totals. The stored totals ARE the device's numbers
	// (spec 6, price at time of sale wins). validateSale already compared;
	// a totals mismatch is on flag_reason. Nothing is recomputed here.

	// Step 4 + 6 — record the invoice (the row IS the record of the number).
	// A 23505 on invoices_device_number_unique or invoices_device_seq_unique
	// is a genuine device-namespace collision; do NOT catch it — T-21 maps
	// it to HARD invoice_collision.
	await tx.insert(invoices).values({
		restaurantId: ctx.restaurantId,
		orderId: sale.orderId,
		deviceId: ctx.opDeviceId,
		invoiceSeq: sale.invoiceSeq,
		invoiceNumber: sale.invoiceNumber,
		totalMinor: sale.totals.totalMinor,
		issuedAt: ctx.occurredAt
	});

	// Step 5 — deduct inventory (T-17 no-op returns cogsMinor 0n).
	const { cogsMinor } = await consumeForSale(tx, {
		restaurantId: ctx.restaurantId,
		orderId: sale.orderId,
		lines: toSaleLines(sale.lines)
	});

	// Step 7 — journal entries (spec 24 rules).
	const entryIds: string[] = [];
	const event = eventForMethod(sale.payment.method);
	const saleEntry = await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: sale.businessDate,
		event,
		sourceType: 'order',
		sourceId: sale.orderId,
		memo: `Sale ${sale.invoiceNumber}`,
		lines: saleLines(event, {
			subtotal: sale.totals.subtotalMinor,
			discount: sale.totals.discountMinor,
			tax: sale.totals.taxMinor,
			total: sale.totals.totalMinor
		})
	});
	if (saleEntry) entryIds.push(saleEntry.entryId);

	if (cogsMinor > 0n) {
		const cogsEntry = await postEntry(tx, {
			restaurantId: ctx.restaurantId,
			businessDate: sale.businessDate,
			event: 'cost_of_goods_sold',
			sourceType: 'order',
			sourceId: sale.orderId,
			memo: `COGS ${sale.invoiceNumber}`,
			lines: cogsLines(cogsMinor)
		});
		if (cogsEntry) entryIds.push(cogsEntry.entryId);
	}

	// Step 8 — mark PAID; the ONLY status change in this function.
	await tx
		.update(orders)
		.set({ status: 'paid', updatedAt: new Date() })
		.where(and(eq(orders.id, sale.orderId), eq(orders.restaurantId, ctx.restaurantId)));

	// Step 9 — audit (in the same transaction; invariant 10). Only
	// sale.recorded carries clientOpId; the partial unique index
	// audit_log_device_client_op_unique allows one row per
	// (device_id, client_op_id).
	await writeAudit(tx, {
		event: 'sale.recorded',
		details: {
			deviceCode: ctx.opDeviceCode,
			invoiceNumber: sale.invoiceNumber,
			orderType: sale.orderType,
			method: sale.payment.method,
			totalMinor: sale.totals.totalMinor.toString()
		},
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.employeeUserId,
		subjectUserId: null,
		deviceId: ctx.opDeviceId,
		clientOpId: ctx.clientOpId,
		occurredAt: ctx.occurredAt,
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	if (softFlags.length > 0) {
		await writeAudit(tx, {
			event: 'sale.flagged',
			details: {
				deviceCode: ctx.opDeviceCode,
				invoiceNumber: sale.invoiceNumber,
				flags: softFlags
			},
			restaurantId: ctx.restaurantId,
			actorUserId: ctx.employeeUserId,
			subjectUserId: null,
			deviceId: ctx.opDeviceId,
			clientOpId: null,
			occurredAt: ctx.occurredAt,
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});
	}

	return { orderId: sale.orderId, invoiceNumber: sale.invoiceNumber, entryIds };
}
