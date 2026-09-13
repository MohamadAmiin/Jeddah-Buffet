import { redirect, type Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireUser } from '$lib/server/permissions';
import { invalidateSession, deleteSessionCookie } from '$lib/server/auth/session';
import { writeAudit, requestContext } from '$lib/server/audit';

// A FORM ACTION ONLY. There is deliberately no `load`, so a GET receives 405.
// A logout reachable by GET is triggerable by any image tag on any page.
//
// /logout is NOT in the hook's public allow-list, so an anonymous POST is
// redirected to /login before this action runs. That is correct — do not add a
// special case for it.
export const actions: Actions = {
	default: async (event) => {
		// Guarded in the ACTION, not only in a load: a form action is a separately
		// reachable POST endpoint (invariant 8).
		const user = requireUser(event);
		const { ip, userAgent } = requestContext(event);

		// The session row and its audit row go in ONE transaction (invariant 10).
		await db.transaction(async (tx) => {
			await invalidateSession(tx, user.sessionId);
			await writeAudit(tx, {
				restaurantId: user.restaurantId,
				actorUserId: user.userId,
				subjectUserId: user.userId,
				event: 'logout',
				details: {},
				ip,
				userAgent
			});
		});

		deleteSessionCookie(event.cookies);
		redirect(303, '/login');
	}
};
