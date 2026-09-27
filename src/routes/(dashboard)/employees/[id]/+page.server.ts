import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { listRoles } from '$lib/server/permissions/roles';
import {
	clearPinLockout,
	deactivateEmployee,
	getEmployee,
	reactivateEmployee,
	setEmployeePin,
	updateEmployee
} from '$lib/server/auth/employees';
import { getRestaurantWithSettings } from '$lib/server/restaurants';

const idSchema = z.uuid();

const updateSchema = z.object({
	displayName: z.string().trim().min(1, 'Enter a name.').max(200),
	roleId: z.uuid()
});

const pinSchema = z.object({
	pin: z.string().regex(/^[0-9]{4,6}$/, 'The PIN must be 4 to 6 digits.')
});

const reactivateSchema = z.object({
	roleId: z.uuid().optional()
});

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.employees');

	const parsedId = idSchema.safeParse(event.params.id);
	if (!parsedId.success) {
		error(404, 'Employee not found');
	}

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const employee = await getEmployee(db, restaurantId, parsedId.data);

	if (!employee) {
		error(404, 'Employee not found');
	}

	const [roleRows, settings] = await Promise.all([
		listRoles(db, restaurantId),
		getRestaurantWithSettings(db, restaurantId)
	]);

	if (!settings) error(500, 'Restaurant settings not found');

	const roleOptions = roleRows.map((role) => ({
		value: role.id,
		label: role.name,
		disabled: false
	}));

	if (employee.roleId && employee.roleName && employee.roleArchived) {
		roleOptions.push({
			value: employee.roleId,
			label: `${employee.roleName} (archived)`,
			disabled: true
		});
	}

	return {
		employee: {
			id: employee.id,
			kind: employee.kind,
			displayName: employee.displayName,
			roleId: employee.roleId,
			roleName: employee.roleName,
			roleArchived: employee.roleArchived,
			hasPin: employee.hasPin,
			isActive: employee.isActive,
			lockedUntil: employee.lockedUntil,
			failedPinCount: employee.failedPinCount
		},
		roles: roleOptions,
		timeZone: settings.timeZone
	};
};

export const actions: Actions = {
	update: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const parsedId = idSchema.safeParse(event.params.id);
		if (!parsedId.success) {
			return fail(400, { message: 'That employee was not found.' });
		}

		const form = await event.request.formData();

		const parsed = updateSchema.safeParse({
			displayName: form.get('displayName'),
			roleId: form.get('roleId')
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the form.'
			});
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			updateEmployee(tx, restaurantId, parsedId.data, parsed.data, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			if (result.reason === 'owner') {
				return fail(400, { message: 'The owner is not edited here.' });
			}

			if (result.reason === 'role_not_live') {
				return fail(400, { message: 'Choose a live role: that one is archived.' });
			}

			return fail(400, { message: 'That employee was not found.' });
		}

		return {
			message: result.changed ? 'Saved.' : 'Nothing to save.'
		};
	},

	setPin: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const parsedId = idSchema.safeParse(event.params.id);
		if (!parsedId.success) {
			return fail(400, { message: 'That employee was not found.' });
		}

		const form = await event.request.formData();
		const parsed = pinSchema.safeParse({
			pin: form.get('pin')
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the form.'
			});
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			setEmployeePin(tx, restaurantId, parsedId.data, parsed.data.pin, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			return fail(400, { message: 'That employee was not found.' });
		}

		return { message: 'PIN set.' };
	},

	clearLockout: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const parsedId = idSchema.safeParse(event.params.id);
		if (!parsedId.success) {
			return fail(400, { message: 'That employee was not found.' });
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			clearPinLockout(tx, restaurantId, parsedId.data, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			if (result.reason === 'nothing_to_clear') {
				return fail(400, { message: 'There is no lockout to clear.' });
			}

			return fail(400, { message: 'That employee was not found.' });
		}

		return { message: 'Lockout cleared.' };
	},

	deactivate: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const parsedId = idSchema.safeParse(event.params.id);
		if (!parsedId.success) {
			return fail(400, { message: 'That employee was not found.' });
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			deactivateEmployee(tx, restaurantId, parsedId.data, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			if (result.reason === 'owner') {
				return fail(400, { message: 'The owner is not edited here.' });
			}

			return fail(400, { message: 'That employee was not found.' });
		}

		return {
			message: `${result.displayName} was deactivated. The till drops them the next time it loads the staff list.`
		};
	},

	reactivate: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const parsedId = idSchema.safeParse(event.params.id);
		if (!parsedId.success) {
			return fail(400, { message: 'That employee was not found.' });
		}

		const employee = await getEmployee(db, restaurantId, parsedId.data);
		if (!employee) {
			return fail(400, { message: 'That employee was not found.' });
		}

		const form = await event.request.formData();
		const parsed = reactivateSchema.safeParse({
			roleId: form.get('roleId') || undefined
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the form.'
			});
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			reactivateEmployee(tx, restaurantId, parsedId.data, parsed.data, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			if (result.reason === 'owner') {
				return fail(400, { message: 'The owner is not edited here.' });
			}

			if (result.reason === 'role_not_live') {
				return fail(400, {
					message: `Choose a role first: ${employee.roleName} is archived.`
				});
			}

			if (result.reason === 'not_found') {
				return fail(400, { message: 'That employee was not found.' });
			}
		}

		return { message: `${employee.displayName} was reactivated.` };
	}
};
