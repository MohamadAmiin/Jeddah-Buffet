import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),

	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},

	kit: {
		// adapter-node, not adapter-auto: adapter-auto guesses a deployment
		// platform, and spec 32 fixes the target as a Node server behind Nginx,
		// so the adapter is not a guess.
		adapter: adapter(),

		// NO automatic service-worker registration. The default (`register: true`)
		// injects `navigator.serviceWorker.register('/service-worker.js')` into EVERY
		// server-rendered page with no `scope`, so the scope is the script's own
		// directory: `/`. A worker at scope `/` controls /dashboard as well as the
		// till, so authenticated dashboard HTML and __data.json responses land in
		// Cache Storage — which /logout does not clear, because deleting a session
		// cookie does not delete a cache. The POS worker is therefore registered BY
		// HAND, from the POS layout only, with `{ scope: '/pos' }` — NO trailing
		// slash. Scope matching is a plain STRING prefix on the URL, not a path-segment
		// match: '/pos' covers the till's own landing screen at /pos, while '/pos/'
		// would leave that screen uncontrolled and unable to load offline. The same
		// string-prefix rule is why no route outside the (pos) group may have a path
		// beginning with the characters `pos`. The whole policy is in CLAUDE.md,
		// "Decisions already made". `register: false` turns off registration only:
		// SvelteKit still bundles src/service-worker.ts and serves /service-worker.js.
		serviceWorker: { register: false }

		// No `csrf` option is set here, deliberately. SvelteKit's origin check
		// defaults to on and invariant 12 requires it STAY on. If a production
		// deployment returns 403 on form posts, the fix is to set the ORIGIN
		// environment variable for adapter-node — NEVER to disable the check.
		// Two things make that mistake easy: `csrf.checkOrigin` is deprecated in
		// favour of `trustedOrigins`, and CSRF protection is inert during local
		// development — so "it works in dev" proves nothing about production.
	}
};
