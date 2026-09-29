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
	PAID_FROM,
	getPurchase,
	listIngredients,
	paySupplier,
	paymentsFor,
	reversePurchase,
	reverseSupplierPayment,
	todayInZone,
	type InventoryWriteContext
} from '$lib/server/inventory';
import { formatQty } from '$lib/money/quantity';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { parsePriceInput } from '../../menu/helpers';
import {
	ALREADY_REVERSED_MESSAGE,
	CURRENCY_MESSAGE,
	DELIVERY_NOT_FOUND_MESSAGE,
	HAS_PAYMENTS_MESSAGE,
	PAID_BY_LABELS,
	PAID_FROM_LABELS,
	PAYMENT_NOT_FOUND_MESSAGE,
	REASON_MESSAGE,
	amountText,
	firstMessage,
	idSchema,
	paySchema,
	qtyText,
	reversePaymentSchema,
	reverseSchema
} from '../helpers';

// ONE DELIVERY (spec 19: the supplier is paid later; spec 22: corrections are
// reversing entries). The load and every action check admin.purchases first
// (invariant 8). The tenant comes from locals; a delivery of another
// restaurant answers 404 on the load and "no longer exists" in an action.
//
// NOTHING IS EDITED (invariant 2). A payment or the whole delivery is REVERSED
// with a reason: the module stamps the row once and writes new movements and a
// mirror entry dated today in the restaurant's zone (invariant 11). The
// original stays visible, marked ↩.

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

function context(event: RequestEvent, restaurantId: string, userId: string): InventoryWriteContext {
	const { ip, userAgent } = requestContext(event);
	return { restaurantId, actorUserId: userId, ip, userAgent };
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.purchases');
	const { restaurantId, format } = await scope(event.locals);
	const id = idSchema.safeParse(event.params.id);
	if (!id.success) error(404, 'Delivery not found');
	const purchase = await getPurchase(db, restaurantId, id.data);
	if (!purchase) error(404, 'Delivery not found');

	const [ingredients, today] = await Promise.all([
		listIngredients(db, restaurantId, { includeArchived: true }),
		todayInZone(db, restaurantId)
	]);
	const baseUnit = new Map(ingredients.map((i) => [i.id, i.baseUnit]));
	const openPayments = purchase.payments.some((p) => p.reversedAt === null);

	return {
		today,
		currency: format ? { code: format.code } : null,
		paidFromOptions: PAID_FROM.map((value) => ({ value, label: PAID_FROM_LABELS[value] })),
		purchase: {
			id: purchase.id,
			supplierName: purchase.supplierName,
			businessDate: purchase.businessDate,
			paidBy: PAID_BY_LABELS[purchase.paidBy],
			note: purchase.note,
			total: amountText(purchase.totalMinor, format),
			outstanding:
				purchase.paidBy === 'credit' && !purchase.reversed
					? amountText(purchase.outstandingMinor, format)
					: null,
			reversed: purchase.reversed,
			reversalReason: purchase.reversalReason,
			canPay: purchase.paidBy === 'credit' && !purchase.reversed && purchase.outstandingMinor > 0n,
			openPayments
		},
		lines: purchase.lines.map((line) => ({
			id: String(line.lineNo),
			lineNo: line.lineNo,
			ingredientName: line.ingredientName,
			unitName: line.purchaseUnitName,
			quantity: formatQty(line.unitQty),
			baseQuantity: qtyText(line.baseQty, baseUnit.get(line.ingredientId) ?? ''),
			total: amountText(line.lineCostMinor, format)
		})),
		payments: purchase.payments.map((payment) => ({
			id: payment.id,
			businessDate: payment.businessDate,
			amount: amountText(payment.amountMinor, format),
			paidFrom: PAID_FROM_LABELS[payment.paidFrom],
			reversed: payment.reversedAt !== null,
			reversalReason: payment.reversalReason
		}))
	};
};

export const actions: Actions = {
	pay: async (event) => {
		const user = requirePermission(event, 'admin.purchases');
		const { restaurantId, format } = await scope(event.locals);
		if (!format) return fail(400, { message: CURRENCY_MESSAGE });
		const id = idSchema.safeParse(event.params.id);
		if (!id.success) return fail(404, { message: DELIVERY_NOT_FOUND_MESSAGE });
		const form = await event.request.formData();
		const parsed = paySchema.safeParse({
			amount: form.get('amount') ?? '',
			paidFrom: form.get('paidFrom') ?? '',
			businessDate: form.get('businessDate') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		const amount = parsePriceInput(parsed.data.amount, format.exponent);
		if (!amount.ok) return fail(400, { message: amount.message });

		const result = await db.transaction((tx) =>
			paySupplier(tx, context(event, restaurantId, user.userId), {
				purchaseId: id.data,
				amountMinor: amount.minor,
				paidFrom: parsed.data.paidFrom,
				businessDate: parsed.data.businessDate
			})
		);
		if (!result.ok) {
			const messages = {
				not_found: DELIVERY_NOT_FOUND_MESSAGE,
				not_credit: 'This delivery was paid when it arrived; there is nothing to pay.',
				reversed: 'This delivery was reversed; there is nothing to pay.',
				exceeds_outstanding: 'That is more than is still owed on this delivery.',
				invalid_amount: 'Enter an amount above zero.'
			} as const;
			return fail(result.reason === 'not_found' ? 404 : 400, {
				message: messages[result.reason]
			});
		}
		redirect(303, `/purchases/${id.data}`);
	},

	reversePayment: async (event) => {
		const user = requirePermission(event, 'admin.purchases');
		const { restaurantId } = await scope(event.locals);
		const id = idSchema.safeParse(event.params.id);
		if (!id.success) return fail(404, { message: DELIVERY_NOT_FOUND_MESSAGE });
		const form = await event.request.formData();
		const parsed = reversePaymentSchema.safeParse({
			paymentId: form.get('paymentId') ?? '',
			reason: form.get('reason') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		// The payment must belong to THIS delivery, not merely to this restaurant.
		const payments = await paymentsFor(db, restaurantId, id.data);
		if (!payments.some((p) => p.id === parsed.data.paymentId)) {
			return fail(404, { message: PAYMENT_NOT_FOUND_MESSAGE });
		}

		const result = await db.transaction((tx) =>
			reverseSupplierPayment(tx, context(event, restaurantId, user.userId), {
				paymentId: parsed.data.paymentId,
				reason: parsed.data.reason
			})
		);
		if (!result.ok) {
			const messages = {
				not_found: PAYMENT_NOT_FOUND_MESSAGE,
				already_reversed: ALREADY_REVERSED_MESSAGE,
				invalid_reason: REASON_MESSAGE
			} as const;
			return fail(result.reason === 'not_found' ? 404 : 400, {
				message: messages[result.reason]
			});
		}
		redirect(303, `/purchases/${id.data}`);
	},

	reverse: async (event) => {
		const user = requirePermission(event, 'admin.purchases');
		const { restaurantId } = await scope(event.locals);
		const id = idSchema.safeParse(event.params.id);
		if (!id.success) return fail(404, { message: DELIVERY_NOT_FOUND_MESSAGE });
		const form = await event.request.formData();
		const parsed = reverseSchema.safeParse({ reason: form.get('reason') ?? '' });
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const result = await db.transaction((tx) =>
			reversePurchase(tx, context(event, restaurantId, user.userId), {
				purchaseId: id.data,
				reason: parsed.data.reason
			})
		);
		if (!result.ok) {
			const messages = {
				not_found: DELIVERY_NOT_FOUND_MESSAGE,
				already_reversed: ALREADY_REVERSED_MESSAGE,
				has_payments: HAS_PAYMENTS_MESSAGE,
				invalid_reason: REASON_MESSAGE
			} as const;
			return fail(result.reason === 'not_found' ? 404 : 400, {
				message: messages[result.reason]
			});
		}
		redirect(303, `/purchases/${id.data}`);
	}
};
