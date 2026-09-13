// dotenv, for the same reason drizzle.config.ts needs it: Vitest runs outside
// SvelteKit, so $env is unavailable and .env is not otherwise loaded into
// process.env. Without this, integration-setup.ts sees TEST_DATABASE_URL as
// unset and the guard fires on every run for the wrong reason.
import 'dotenv/config';
import { defineConfig } from 'vitest/config';

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
					setupFiles: ['./src/lib/server/db/integration-setup.ts'],
					// Every file shares one matcami_test database; parallel files would
					// interfere with each other's rows.
					fileParallelism: false
				}
			}
		]
	}
});
