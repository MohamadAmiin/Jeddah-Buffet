// dotenv so TEST_DATABASE_URL from .env reaches the webServer env below.
import 'dotenv/config';
import { defineConfig } from '@playwright/test';

// The preview server is pointed at the TEST database rather than development
// data, and e2e/auth.spec.ts resets it before the spec, so every run starts with
// zero companies and a fresh daily sign-up cap. Sign-up is public, so there is no
// token to submit; SIGNUP is pinned to `open` so a developer's own .env cannot
// close it under the journey.
//
// Consequence worth knowing: `pnpm test:e2e` and `pnpm test:integration` both use
// matcami_test, so do not run them concurrently.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

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
			SIGNUP: 'open',
			// `vite preview` is a PRODUCTION build, so env.ts applies its production
			// rules. http://localhost is the one origin where SvelteKit omits the
			// Secure flag, which is why the journey can hold a session at all — and a
			// loopback ORIGIN is also why a missing ADDRESS_HEADER is only a warning.
			ORIGIN: 'http://localhost:4173'
		}
	},
	use: { baseURL: 'http://localhost:4173' }
});
