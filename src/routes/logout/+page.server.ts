import { error, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requireUser } from '$lib/server/permissions';
import { invalidateSession, deleteSessionCookie } from '$lib/server/auth/session';
import { writeAudit, requestContext } from '$lib/server/audit';

// A FORM ACTION ONLY. A logout reachable by GET is triggerable by any image tag
// on any page, so a GET must not log anyone out.
//
// The 405 is EXPLICIT, and that is not belt-and-braces. "No load export, so
// SvelteKit answers 405" is FALSE for a GET: respond.js has
// `page_methods = new Set(['GET','HEAD','POST'])`, so a GET is routed to
// render_page, and because this route has no +page.svelte the renderer throws
// `Missing +page.svelte component for route /logout` — a 500, with an unhandled
// error in the server log. MEASURED against the production build: a signed-in
// GET /logout returned 500 before this load existed.
//
// /logout is NOT in the hook's public allow-list, so an anonymous GET or POST is
// redirected to /login before any of this runs. That is correct — do not add a
// special case for it.
export const load: ServerLoad = () => {
	error(405, 'Sign out with the button — GET is not allowed here.');
};
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
