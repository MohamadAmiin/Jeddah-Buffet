import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { listRoles } from '$lib/server/permissions/roles';
import { createEmployee, listEmployees } from '$lib/server/auth/employees';
import { getRestaurantWithSettings } from '$lib/server/restaurants';

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.employees');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const [rows, roleRows, settings] = await Promise.all([
		listEmployees(db, restaurantId),
		listRoles(db, restaurantId),
		getRestaurantWithSettings(db, restaurantId)
	]);

	if (!settings) error(500, 'Restaurant settings not found');

	return {
		employees: rows.map((r) => ({
			id: r.id,
			kind: r.kind,
			displayName: r.displayName,
			roleName: r.roleName,
			roleArchived: r.roleArchived,
			hasPin: r.hasPin,
			isActive: r.isActive,
			lockedUntil: r.lockedUntil,
			failedPinCount: r.failedPinCount
		})),
		roles: roleRows.map((r) => ({
			id: r.id,
			name: r.name
		})),
		timeZone: settings.timeZone
	};
};

const pin = z.string().regex(/^[0-9]{4,6}$/, 'The PIN must be 4 to 6 digits.');

const createSchema = z.object({
	displayName: z.string().trim().min(1, 'Enter a name.').max(200),
	roleId: z.uuid(),
	pin
});

export const actions: Actions = {
	createEmployee: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();

		const parsed = createSchema.safeParse({
			roleId: form.get('roleId'),
			displayName: form.get('displayName'),
			pin: form.get('pin')
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the form.'
			});
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			createEmployee(tx, restaurantId, parsed.data, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			if (result.reason === 'role_not_live') {
				return fail(400, { message: 'Choose a role.' });
			}

			return fail(400, { message: 'That employee could not be created.' });
		}

		return { message: `${parsed.data.displayName} was added.` };
	}
};
