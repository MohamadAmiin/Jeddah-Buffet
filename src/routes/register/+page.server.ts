import { fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { SIGNUP_OPEN } from '$lib/server/env';
import { registerRestaurant } from '$lib/server/auth/register';
import { setSessionCookie } from '$lib/server/auth/session';
import { requestContext } from '$lib/server/audit';
import { MAX_PASSWORD_BYTES } from '$lib/server/auth/password';
import { timeZoneSuggestions } from '$lib/server/restaurants';

// PUBLIC SIGN-UP (decided 2026-09-15): anyone may create a company here, at any
// time — no setup token, no first-run gate. Listed in PUBLIC_ROUTE_IDS; the hook
// sends a signed-in visitor to /dashboard before this load runs.
//
// The limits live in registerRestaurant, not here: a per-address throttle and a
// cap of 3 new companies per address per 24 hours. This route only chooses
// 'public' mode, and must NEVER pass 'operator', which skips both.
//
// With SIGNUP=closed the page still answers and says so, rather than a 404 that
// leaves a visitor who followed a link wondering what broke.
export const load: ServerLoad = async () => ({
	signupOpen: SIGNUP_OPEN,
	// SUGGESTIONS for the picker only. The validator is isValidTimeZone, which works
	// by construction — this list omits UTC, Asia/Kolkata, Europe/Kyiv and others
	// that are perfectly valid.
	timeZones: SIGNUP_OPEN ? timeZoneSuggestions() : []
});

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
		passwordConfirm: z.string()
	})
	.refine((data) => data.password === data.passwordConfirm, {
		message: 'The two passwords do not match',
		path: ['passwordConfirm']
	});

const REASON_MESSAGE: Record<string, string> = {
	// Saying an email is taken is an ACCEPTED risk (2026-09-15): with public sign-up,
	// no email verification and one email per company, a sign-up form cannot hide it.
	email_taken: 'That email is already registered. Sign in instead, or use another email.',
	invalid_time_zone: 'That time zone is not recognised.',
	throttled: 'Too many attempts. Please wait and try again.',
	signup_limit:
		'Too many restaurants have been created from this network today. Please try again tomorrow.'
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
			passwordConfirm: form.get('passwordConfirm')
		};

		// Repopulate the form WITHOUT the password.
		const echo = {
			restaurantName: typeof raw.restaurantName === 'string' ? raw.restaurantName : '',
			timeZone: typeof raw.timeZone === 'string' ? raw.timeZone : '',
			ownerDisplayName: typeof raw.ownerDisplayName === 'string' ? raw.ownerDisplayName : '',
			email: typeof raw.email === 'string' ? raw.email : ''
		};

		// Checked HERE, not only in the load: a form action is a separately
		// reachable POST endpoint, and a closed switch must refuse a direct POST too.
		if (!SIGNUP_OPEN) {
			return fail(403, { ...echo, message: 'Sign-up is closed right now.' });
		}

		const parsed = registerSchema.safeParse(raw);
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			return fail(400, { ...echo, message: first?.message ?? 'Check the form and try again.' });
		}

		const { ip, userAgent } = requestContext(event);

		const result = await registerRestaurant(
			db,
			{
				restaurantName: parsed.data.restaurantName,
				timeZone: parsed.data.timeZone,
				ownerDisplayName: parsed.data.ownerDisplayName,
				email: parsed.data.email,
				password: parsed.data.password
			},
			{ mode: 'public', ip, userAgent }
		);

		if (!result.ok) {
			const limited = result.reason === 'throttled' || result.reason === 'signup_limit';
			return fail(limited ? 429 : 400, {
				...echo,
				message: REASON_MESSAGE[result.reason] ?? 'Sign-up failed.'
			});
		}

		setSessionCookie(event.cookies, result.token, result.expiresAt);
		redirect(303, '/dashboard');
	}
};
