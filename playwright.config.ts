import { defineConfig } from '@playwright/test';

// Runs against the PRODUCTION BUILD, never `pnpm dev`. This matters beyond
// convenience: service workers and offline behaviour do not exist under the dev
// server, and SvelteKit's CSRF origin check is inert there too — so a dev-server
// e2e harness could never test the offline POS, which is the one thing in this
// product that most needs an end-to-end test.
export default defineConfig({
	testDir: 'e2e',
	webServer: {
		command: 'pnpm build && pnpm preview --port 4173',
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	use: { baseURL: 'http://localhost:4173' }
});
