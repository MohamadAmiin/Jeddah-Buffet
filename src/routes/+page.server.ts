import { redirect, type ServerLoad } from '@sveltejs/kit';

// `/` IS NOT A PAGE. It is a signpost.
//
// It used to render a placeholder landing page — a heading, a line of prose and two
// links — that existed only so `pnpm dev` served something and the smoke test had a
// stable <h1>. The product has screens now, and a visitor typing the bare host
// should land where they can actually do something.
//
// Signed in  -> /dashboard
// Signed out -> /login
//
// The route itself stays. Deleting +page.svelte without leaving something here
// would make `/` match nothing, and hooks.server.ts returns early on a null
// route.id for SvelteKit to 404 — so the bare host would 404 rather than redirect,
// which is worse than the placeholder it replaced.
//
// 303, matching the hook's own redirects: this is "look over there", not "this
// moved permanently", and a 301 would be cached by the browser and outlive any
// later decision to give `/` a real page.
export const load: ServerLoad = (event) => {
	redirect(303, event.locals.user ? '/dashboard' : '/login');
};
