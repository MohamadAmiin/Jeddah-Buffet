import { fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { loginWithPassword } from '$lib/server/auth/login';
import { SIGNUP_OPEN } from '$lib/server/env';
import { setSessionCookie } from '$lib/server/auth/session';
import { requestContext } from '$lib/server/audit';
import { MAX_PASSWORD_BYTES } from '$lib/server/auth/password';
import { safeNext, loginFailPayload } from './helpers';

// This route is PUBLIC by design and is listed in hooks.server.ts's
// PUBLIC_ROUTE_IDS. It needs no permission guard; the hook redirects a signed-in
// visitor to /dashboard before this load runs.
export const load: ServerLoad = async ({ locals }) => {
	if (locals.user) redirect(303, '/dashboard');
	// ONE bit, and nothing else: whether public sign-up is open (the SIGNUP switch),
	// which decides whether the page links to /register. It reveals nothing about
	// who has signed up — NO user list and NO restaurant name.
	return { signupOpen: SIGNUP_OPEN };
};

const loginSchema = z.object({
	email: z
		.string()
		.trim()
		.toLowerCase()
		.min(1, 'Enter your email')
		.max(320)
		.email('Enter a valid email'),
	password: z.string().min(1, 'Enter your password').max(MAX_PASSWORD_BYTES),
	next: z.string().optional()
});

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = loginSchema.safeParse({
			email: form.get('email'),
			password: form.get('password'),
			next: form.get('next') ?? undefined
		});

		if (!parsed.success) {
			// Echo back the EMAIL only — never the password.
			const email = typeof form.get('email') === 'string' ? String(form.get('email')) : '';
			return fail(400, loginFailPayload(email));
		}

		const { ip, userAgent } = requestContext(event);
		const result = await loginWithPassword(
			db,
			{ email: parsed.data.email, password: parsed.data.password },
			{ ip, userAgent }
		);

		if (!result.ok) {
			// ONE generic message for both 'invalid' and 'locked', so the response
			// cannot be used to discover which addresses are registered or which
			// accounts are currently locked. retryAfterMs is disclosed only when the
			// throttle refused, since that is about the caller's own behaviour.
			return fail(
				400,
				loginFailPayload(
					parsed.data.email,
					result.reason === 'throttled' ? { retryAfterMs: result.retryAfterMs } : {}
				)
			);
		}

		setSessionCookie(event.cookies, result.token, result.expiresAt);
		redirect(303, safeNext(parsed.data.next, event.url.origin));
	}
};
