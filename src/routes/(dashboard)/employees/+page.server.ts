import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { createEmployee, listEmployees, setEmployeePin } from '$lib/server/auth/employees';

// THE EMPLOYEES PAGE — the cashier and the waiter, and every PIN, the owner's
// approval PIN included (spec 7, 8).
//
// A SECOND CASHIER OR WAITER IS ALLOWED, and no database constraint forbids it.
// Spec 31's "one owner, one cashier, one waiter" is an MVP SCOPE statement; whether
// a row may be refused is a question it does not answer. The default carried —
// recorded in CLAUDE.md's "Decisions already made" — is to allow it: this page has
// no deactivate and no delete, so refusing a second would make one mistyped name
// unrecoverable without a database edit. Never add a unique index on
// (restaurant_id, role); that would turn a scope statement into a migration.

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.employees');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const rows = await listEmployees(db, restaurantId);

	// AN EXPLICIT OBJECT LITERAL, never a spread user row: load data is serialised
	// into the page HTML and __data.json, and users holds the password and PIN hashes.
	return {
		employees: rows.map((r) => ({
			id: r.id,
			role: r.role,
			displayName: r.displayName,
			hasPin: r.hasPin,
			isActive: r.isActive
		}))
	};
};

// Server-side only: no schema is imported into a .svelte component.
const pin = z.string().regex(/^[0-9]{4,6}$/, 'The PIN must be 4 to 6 digits.');
const createSchema = z.object({
	role: z.enum(['cashier', 'waiter']),
	displayName: z.string().trim().min(1, 'Enter a name.').max(200),
	pin
});
const setPinSchema = z.object({ userId: z.uuid(), pin });

export const actions: Actions = {
	createEmployee: async (event) => {
		// Guarded AGAIN, in the action: a form action is a separately reachable POST
		// endpoint (invariant 8).
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();
		const parsed = createSchema.safeParse({
			role: form.get('role'),
			displayName: form.get('displayName'),
			pin: form.get('pin')
		});
		if (!parsed.success) {
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Check the form.' });
		}

		const { ip, userAgent } = requestContext(event);

		// The insert and its employee.created row commit together or not at all
		// (invariant 10). The PIN itself is never returned, logged or echoed.
		await db.transaction((tx) =>
			createEmployee(tx, restaurantId, parsed.data, { actorUserId: user.userId, ip, userAgent })
		);

		return { message: `${parsed.data.displayName} was added.` };
	},

	setPin: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();
		const parsed = setPinSchema.safeParse({ userId: form.get('userId'), pin: form.get('pin') });
		if (!parsed.success) {
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Check the form.' });
		}

		const { ip, userAgent } = requestContext(event);

		// restaurantId comes from locals and goes into the WHERE: a userId from the
		// form is not trusted on its own.
		const result = await db.transaction((tx) =>
			setEmployeePin(tx, restaurantId, parsed.data.userId, parsed.data.pin, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) return fail(400, { message: 'That employee was not found.' });
		return { message: 'PIN set.' };
	}
};
