import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import {
	archiveCustomer,
	getCustomer,
	restoreCustomer,
	statement,
	updateCustomer
} from '$lib/server/customers';
import { paymentsOf, reverseCustomerPayment } from '$lib/server/customers/payments';
import { formatAmount } from '$lib/money/format';
import {
	NOT_FOUND_MESSAGE,
	PAYMENT_NOT_FOUND_MESSAGE,
	amountText,
	customerSchema,
	firstMessage,
	idSchema,
	readLimit,
	refusalMessage,
	reversePaymentSchema
} from '../helpers';
import { context, scope } from '../scope.server';

// ONE CUSTOMER (tasks/customer-credit T-21): the details, the limit, archive and
// restore, the statement, and reversing a payment. The load and EVERY action
// check admin.customers first (invariant 8). The tenant comes from the session;
// another restaurant's customer answers 404 on the load and "no longer exists"
// in an action.
//
// NOTHING IS EDITED (invariant 2). A charge is a posted sale; a payment is a
// posted record. A wrong payment is REVERSED with a reason — the row stays,
// marked ↩, and the reversal is its own line of the statement. Nothing here
// creates a charge or receives a payment: both happen only on the till.

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.customers');
	const { restaurantId, format } = await scope(event.locals);
	const id = idSchema.safeParse(event.params.id);
	if (!id.success) error(404, 'Customer not found');

	const customer = await getCustomer(db, restaurantId, id.data);
	if (!customer) error(404, 'Customer not found');
	const rows = await statement(db, restaurantId, id.data);
	const payments = await paymentsOf(db, restaurantId, id.data);
	const byId = new Map(payments.map((p) => [p.id, p]));

	return {
		currency: format ? { code: format.code } : null,
		customer: {
			id: customer.id,
			name: customer.name,
			phone: customer.phone,
			// The limit as the owner would type it back: no separators, the currency's decimals.
			limitInput:
				customer.creditLimitMinor === null || !format
					? ''
					: formatAmount(customer.creditLimitMinor, format).replaceAll(',', ''),
			limit:
				customer.creditLimitMinor === null ? null : amountText(customer.creditLimitMinor, format),
			balance: amountText(customer.balanceMinor, format),
			owes: customer.balanceMinor !== 0n,
			archived: customer.archivedAt !== null
		},
		statement: rows.map((row, index) => {
			const payment = row.paymentId ? byId.get(row.paymentId) : undefined;
			return {
				id: `${index}`,
				kind: row.kind,
				businessDate: row.businessDate,
				what:
					row.kind === 'charge'
						? `Invoice ${row.reference}`
						: row.kind === 'payment'
							? `Payment — ${row.methodName ?? ''}`
							: `Reversal — ${row.reason ?? ''}`,
				cashier: row.cashierName ?? '—',
				till: row.tillCode ?? '—',
				amount: amountText(row.amountMinor, format),
				balance: amountText(row.balanceMinor, format),
				reversed: row.reversed,
				// An unreversed payment can be reversed: card and mobile at any time, cash
				// only while its shift is still open (the drawer has not been counted).
				paymentId: row.kind === 'payment' && !row.reversed ? row.paymentId : null,
				reversible:
					row.kind === 'payment' && !row.reversed && payment !== undefined
						? payment.method !== 'cash' || payment.shiftOpen
						: false
			};
		})
	};
};

export const actions: Actions = {
	update: async (event) => {
		const user = requirePermission(event, 'admin.customers');
		const { restaurantId, format } = await scope(event.locals);
		const id = idSchema.safeParse(event.params.id);
		if (!id.success) return fail(404, { message: NOT_FOUND_MESSAGE });
		const form = await event.request.formData();
		const parsed = customerSchema.safeParse({
			name: String(form.get('name') ?? ''),
			phone: String(form.get('phone') ?? ''),
			creditLimit: String(form.get('creditLimit') ?? '')
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		const limit = readLimit(parsed.data.creditLimit, format?.exponent ?? null);
		if (!limit.ok) return fail(400, { message: limit.message });

		const result = await db.transaction((tx) =>
			updateCustomer(tx, context(event, restaurantId, user.userId), id.data, {
				name: parsed.data.name,
				phone: parsed.data.phone,
				creditLimitMinor: limit.limit
			})
		);
		if (!result.ok) {
			return fail(result.reason === 'not_found' ? 404 : 400, {
				message: refusalMessage(result.reason)
			});
		}
		redirect(303, `/customers/${id.data}`);
	},

	archive: async (event) => {
		const user = requirePermission(event, 'admin.customers');
		const { restaurantId } = await scope(event.locals);
		const id = idSchema.safeParse(event.params.id);
		if (!id.success) return fail(404, { message: NOT_FOUND_MESSAGE });
		const result = await db.transaction((tx) =>
			archiveCustomer(tx, context(event, restaurantId, user.userId), id.data)
		);
		if (!result.ok) {
			return fail(result.reason === 'not_found' ? 404 : 400, {
				message: refusalMessage(result.reason)
			});
		}
		redirect(303, `/customers/${id.data}`);
	},

	restore: async (event) => {
		const user = requirePermission(event, 'admin.customers');
		const { restaurantId } = await scope(event.locals);
		const id = idSchema.safeParse(event.params.id);
		if (!id.success) return fail(404, { message: NOT_FOUND_MESSAGE });
		const result = await db.transaction((tx) =>
			restoreCustomer(tx, context(event, restaurantId, user.userId), id.data)
		);
		if (!result.ok) {
			return fail(result.reason === 'not_found' ? 404 : 400, {
				message:
					result.reason === 'phone_taken'
						? 'Another customer now has that phone number. Change one of them before restoring.'
						: refusalMessage(result.reason)
			});
		}
		redirect(303, `/customers/${id.data}`);
	},

	reversePayment: async (event) => {
		const user = requirePermission(event, 'admin.customers');
		const { restaurantId } = await scope(event.locals);
		const id = idSchema.safeParse(event.params.id);
		if (!id.success) return fail(404, { message: NOT_FOUND_MESSAGE });
		const form = await event.request.formData();
		const parsed = reversePaymentSchema.safeParse({
			paymentId: form.get('paymentId') ?? '',
			reason: form.get('reason') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });
		// The payment must belong to THIS customer, not merely to this restaurant.
		const payments = await paymentsOf(db, restaurantId, id.data);
		if (!payments.some((p) => p.id === parsed.data.paymentId)) {
			return fail(404, { message: PAYMENT_NOT_FOUND_MESSAGE });
		}

		const result = await db.transaction((tx) =>
			reverseCustomerPayment(tx, context(event, restaurantId, user.userId), {
				paymentId: parsed.data.paymentId,
				reason: parsed.data.reason
			})
		);
		if (!result.ok) {
			return fail(result.reason === 'not_found' ? 404 : 400, {
				message:
					result.reason === 'not_found' ? PAYMENT_NOT_FOUND_MESSAGE : refusalMessage(result.reason)
			});
		}
		redirect(303, `/customers/${id.data}`);
	}
};
