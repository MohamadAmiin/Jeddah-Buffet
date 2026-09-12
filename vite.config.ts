import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// tailwindcss() goes BEFORE sveltekit() — the order matters.
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-node, not adapter-auto: adapter-auto guesses a deployment
			// platform, and spec 32 fixes the target as a Node server behind Nginx,
			// so the adapter is not a guess.
			//
			// No `csrf` option is set here, deliberately. SvelteKit's origin check
			// defaults to on and invariant 12 requires it STAY on. If a production
			// deployment returns 403 on form posts, the fix is to set the ORIGIN
			// environment variable for adapter-node — NEVER to disable the check.
			// Two things make that mistake easy: `csrf.checkOrigin` is deprecated in
			// favour of `trustedOrigins`, and CSRF protection is inert during local
			// development — so "it works in dev" proves nothing about production.
			adapter: adapter()
		})
	]
});
