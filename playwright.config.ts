// dotenv so TEST_DATABASE_URL from .env reaches the webServer env below.
import 'dotenv/config';
import { defineConfig } from '@playwright/test';

// The journey's first step only works when ZERO restaurants exist, so the preview
// server is pointed at the TEST database rather than development data, and
// e2e/auth.spec.ts resets it before the spec. SETUP_TOKEN is fixed here so the
// registration step has a value to submit.
//
// Consequence worth knowing: `pnpm test:e2e` and `pnpm test:integration` both use
// matcami_test, so do not run them concurrently.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const E2E_SETUP_TOKEN = 'e2e-setup-token';

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
		// Never reuse a server that might be pointed at development data.
		reuseExistingServer: false,
		env: {
			DATABASE_URL: TEST_DATABASE_URL,
			MIGRATE_DATABASE_URL: process.env.MIGRATE_DATABASE_URL ?? '',
			TEST_DATABASE_URL,
			SETUP_TOKEN: E2E_SETUP_TOKEN
		}
	},
	use: { baseURL: 'http://localhost:4173' }
});
