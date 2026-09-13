// dotenv, for the same reason drizzle.config.ts needs it: Vitest runs outside
// SvelteKit, so $env is unavailable and .env is not otherwise loaded into
// process.env. Without this, integration-setup.ts sees TEST_DATABASE_URL as
// unset and the guard fires on every run for the wrong reason.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The integration project imports REAL route modules and the real hook, so it
// needs the two aliases SvelteKit would otherwise provide. Without them a route's
// `import { db } from '$lib/server/db/client'` cannot resolve, and T-20's
// behavioural guard test could only assert against a re-implementation of the
// thing it is meant to be testing.
const alias = {
	$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
	'$env/dynamic/private': fileURLToPath(
		new URL('./src/lib/server/db/test/env-stub.ts', import.meta.url)
	)
};

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.integration.test.ts']
				}
			},
			{
				test: {
					name: 'integration',
					environment: 'node',
					include: ['src/**/*.integration.test.ts'],
					// Runs ONCE before any test file: applies migrations to matcami_test.
					// Without it every integration test fails with
					// `relation "restaurants" does not exist`.
					globalSetup: ['./src/lib/server/db/test/global-setup.ts'],
					setupFiles: ['./src/lib/server/db/integration-setup.ts'],
					alias,
					// Every file shares one matcami_test database; parallel files would
					// interfere with each other's rows.
					fileParallelism: false
				}
			}
		]
	}
});
