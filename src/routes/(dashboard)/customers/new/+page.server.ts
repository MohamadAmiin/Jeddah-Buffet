import { fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { createCustomer } from '$lib/server/customers';
import { customerSchema, firstMessage, readLimit, refusalMessage } from '../helpers';
import { context, scope } from '../scope.server';

// ADD A CUSTOMER (tasks/customer-credit T-21). Owner only: the load and the
// action each check admin.customers first (invariant 8); the tenant comes from
// the session, never from the form. The credit limit is typed as an amount and
// read without a float (invariant 1); empty means no limit.

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.customers');
	const { format } = await scope(event.locals);
	return { currency: format ? { code: format.code } : null };
};

export const actions: Actions = {
	create: async (event) => {
		const user = requirePermission(event, 'admin.customers');
		const { restaurantId, format } = await scope(event.locals);
		const form = await event.request.formData();
		const values = {
			name: String(form.get('name') ?? ''),
			phone: String(form.get('phone') ?? ''),
			creditLimit: String(form.get('creditLimit') ?? '')
		};
		const parsed = customerSchema.safeParse(values);
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error), values });
		const limit = readLimit(parsed.data.creditLimit, format?.exponent ?? null);
		if (!limit.ok) return fail(400, { message: limit.message, values });

		const result = await db.transaction((tx) =>
			createCustomer(tx, context(event, restaurantId, user.userId), {
				name: parsed.data.name,
				phone: parsed.data.phone,
				creditLimitMinor: limit.limit
			})
		);
		if (!result.ok) return fail(400, { message: refusalMessage(result.reason), values });
		redirect(303, `/customers/${result.customerId}`);
	}
};
