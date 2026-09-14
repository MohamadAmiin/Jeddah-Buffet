import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { SETUP_TOKEN } from '$lib/server/env';
import { isRegistrationOpen, registerRestaurant } from '$lib/server/auth/register';
import { setSessionCookie } from '$lib/server/auth/session';
import { requestContext } from '$lib/server/audit';
import { MAX_PASSWORD_BYTES } from '$lib/server/auth/password';
import { timeZoneSuggestions } from '$lib/server/restaurants';

// PUBLIC by design, listed in hooks.server.ts's PUBLIC_ROUTE_IDS. The hook sends a
// signed-in visitor to /dashboard before this load runs.
export const load: ServerLoad = async () => {
	if (!(await isRegistrationOpen(db))) {
		// 404, not a redirect and not a friendly "registration is closed" page: the
		// existence of a closed registration endpoint is not information an anonymous
		// visitor needs.
		error(404, 'Not found');
	}

	if (!SETUP_TOKEN) {
		// Open, but unusable. Name the variable so the operator can see what to do.
		error(
			503,
			'Registration is not configured: the SETUP_TOKEN environment variable is not set on the server.'
		);
	}

	return {
		// SUGGESTIONS for the picker only. The validator is isValidTimeZone, which
		// works by construction — this list omits UTC, Asia/Kolkata, Europe/Kyiv and
		// others that are perfectly valid.
		timeZones: timeZoneSuggestions()
	};
};

const registerSchema = z
	.object({
		restaurantName: z.string().trim().min(1, 'Enter the restaurant name').max(200),
		timeZone: z.string().trim().min(1, 'Choose a time zone').max(100),
		ownerDisplayName: z.string().trim().min(1, 'Enter your name').max(200),
		email: z
			.string()
			.trim()
			.toLowerCase()
			.min(1, 'Enter an email')
			.max(320)
			.email('Enter a valid email'),
		// Length is the useful constraint; character-class rules are not.
		password: z.string().min(8, 'Use at least 8 characters').max(MAX_PASSWORD_BYTES),
		passwordConfirm: z.string(),
		setupToken: z.string().min(1, 'Enter the setup token')
	})
	.refine((data) => data.password === data.passwordConfirm, {
		message: 'The two passwords do not match',
		path: ['passwordConfirm']
	});

const REASON_MESSAGE: Record<string, string> = {
	closed: 'Registration is closed: a restaurant already exists.',
	bad_token: 'That setup token is not correct.',
	email_taken: 'That email is already registered.',
	invalid_time_zone: 'That time zone is not recognised.',
	throttled: 'Too many attempts. Please wait and try again.'
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const raw = {
			restaurantName: form.get('restaurantName'),
			timeZone: form.get('timeZone'),
			ownerDisplayName: form.get('ownerDisplayName'),
			email: form.get('email'),
			password: form.get('password'),
			passwordConfirm: form.get('passwordConfirm'),
			setupToken: form.get('setupToken')
		};

		// Repopulate the form WITHOUT the password or the setup token.
		const echo = {
			restaurantName: typeof raw.restaurantName === 'string' ? raw.restaurantName : '',
			timeZone: typeof raw.timeZone === 'string' ? raw.timeZone : '',
			ownerDisplayName: typeof raw.ownerDisplayName === 'string' ? raw.ownerDisplayName : '',
			email: typeof raw.email === 'string' ? raw.email : ''
		};

		const parsed = registerSchema.safeParse(raw);
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			return fail(400, { ...echo, message: first?.message ?? 'Check the form and try again.' });
		}

		const { ip, userAgent } = requestContext(event);

		// registerRestaurant RE-CHECKS that registration is open inside its own
		// transaction, under an advisory lock. The load's check is a courtesy to the
		// user, not the gate — removing this duplication would reintroduce the race
		// two simultaneous submissions exploit.
		const result = await registerRestaurant(
			db,
			{
				restaurantName: parsed.data.restaurantName,
				timeZone: parsed.data.timeZone,
				ownerDisplayName: parsed.data.ownerDisplayName,
				email: parsed.data.email,
				password: parsed.data.password,
				setupToken: parsed.data.setupToken
			},
			{ ip, userAgent, expectedSetupToken: SETUP_TOKEN }
		);

		if (!result.ok) {
			return fail(400, {
				...echo,
				message: REASON_MESSAGE[result.reason] ?? 'Registration failed.'
			});
		}

		setSessionCookie(event.cookies, result.token, result.expiresAt);
		redirect(303, '/dashboard');
	}
};
