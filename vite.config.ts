import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The Svelte/SvelteKit configuration lives in svelte.config.js, not here.
// Both svelte-check and the Svelte VS Code extension read that file; the
// extension's bundled svelte-language-server cannot read a config passed
// inline to sveltekit(), and reports a false error on every .svelte file.
export default defineConfig({
	// tailwindcss() goes BEFORE sveltekit() — the order matters.
	plugins: [tailwindcss(), sveltekit()]
});
