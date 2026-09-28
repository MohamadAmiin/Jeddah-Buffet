import { error, fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { archiveRole, createRole, listRoles, updateRole } from '$lib/server/permissions/roles';
import { PERMISSION_LABELS, POS_KEYS } from '$lib/server/permissions/keys';

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.employees');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) {
		error(500, 'No restaurant in scope');
	}

	const roles = await listRoles(db, restaurantId, { includeArchived: true });

	return {
		roles: roles.map((role) => ({
			id: role.id,
			name: role.name,
			permissionKeys: role.permissionKeys,
			archivedAt: role.archivedAt,
			activeStaffCount: role.activeStaffCount,
			staffCount: role.staffCount
		})),
		keys: POS_KEYS.map((key) => ({
			key,
			label: PERMISSION_LABELS[key]
		}))
	};
};

const roleName = z.string().trim().min(1).max(60);
const permissionKeys = z.array(z.enum(POS_KEYS)).min(1);

const createSchema = z.object({
	name: roleName,
	permissionKeys
});

const updateSchema = z.object({
	roleId: z.uuid(),
	name: roleName,
	permissionKeys
});

const archiveSchema = z.object({
	roleId: z.uuid()
});

function permissionKeyValues(form: FormData): string[] {
	return form
		.getAll('permissionKeys')
		.filter((value): value is string => typeof value === 'string');
}

export const actions: Actions = {
	create: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) {
			return fail(500, { message: 'No restaurant in scope' });
		}

		const form = await event.request.formData();

		const parsed = createSchema.safeParse({
			name: form.get('name'),
			permissionKeys: permissionKeyValues(form)
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.path.includes('permissionKeys')
					? 'Pick at least one permission.'
					: 'Enter a name of up to 60 characters.'
			});
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			createRole(tx, restaurantId, parsed.data, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			const messages: Record<typeof result.reason, string> = {
				duplicate_name: 'A role with that name already exists.',
				reserved_name: 'Owner is reserved for the owner.',
				invalid_keys: 'Pick at least one permission.',
				invalid_name: 'Enter a name of up to 60 characters.'
			};

			return fail(400, { message: messages[result.reason] });
		}

		return { message: 'Role created.' };
	},

	update: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) {
			return fail(500, { message: 'No restaurant in scope' });
		}

		const form = await event.request.formData();

		const parsed = updateSchema.safeParse({
			roleId: form.get('roleId'),
			name: form.get('name'),
			permissionKeys: permissionKeyValues(form)
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.path.includes('permissionKeys')
					? 'Pick at least one permission.'
					: 'Enter a name of up to 60 characters.'
			});
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			updateRole(
				tx,
				restaurantId,
				parsed.data.roleId,
				{
					name: parsed.data.name,
					permissionKeys: parsed.data.permissionKeys
				},
				{
					actorUserId: user.userId,
					ip,
					userAgent
				}
			)
		);

		if (!result.ok) {
			const messages: Record<typeof result.reason, string> = {
				not_found: 'That role was not found.',
				archived: 'That role is archived.',
				invalid_name: 'Enter a name of up to 60 characters.',
				reserved_name: 'Owner is reserved for the owner.',
				duplicate_name: 'A role with that name already exists.',
				invalid_keys: 'Pick at least one permission.'
			};

			return fail(400, { message: messages[result.reason] });
		}

		return {
			message: result.changed ? 'Role saved.' : 'Nothing to save.'
		};
	},

	archive: async (event) => {
		const user = requirePermission(event, 'admin.employees');

		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) {
			return fail(500, { message: 'No restaurant in scope' });
		}

		const form = await event.request.formData();

		const parsed = archiveSchema.safeParse({
			roleId: form.get('roleId')
		});

		if (!parsed.success) {
			return fail(400, { message: 'That role was not found.' });
		}

		const { ip, userAgent } = requestContext(event);

		const result = await db.transaction((tx) =>
			archiveRole(tx, restaurantId, parsed.data.roleId, {
				actorUserId: user.userId,
				ip,
				userAgent
			})
		);

		if (!result.ok) {
			if (result.reason === 'in_use') {
				return fail(400, {
					message: `${result.activeStaffCount} active staff hold this role. Move them to another role first.`
				});
			}

			if (result.reason === 'already_archived') {
				return fail(400, { message: 'That role is archived.' });
			}

			return fail(400, { message: 'That role was not found.' });
		}

		return { message: 'Role archived.' };
	}
};
