// drizzle-kit runs OUTSIDE Vite, so SvelteKit's $env modules are unavailable —
// hence dotenv here rather than src/lib/server/env.ts.
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	// Point at the dedicated schema FOLDER, never a glob over db/: a glob would
	// import client.ts and open a database connection just by running drizzle-kit.
	schema: './src/lib/server/db/schema',
	// CLAUDE.md requires migrations here, not drizzle's default ./drizzle.
	out: './src/lib/server/db/migrations',
	// MIGRATE_DATABASE_URL, not DATABASE_URL: migrations create and drop tables, so
	// they run as the OWNER role. DATABASE_URL is the runtime role, which owns
	// nothing and would fail with "permission denied for schema public".
	dbCredentials: { url: process.env.MIGRATE_DATABASE_URL! },
	strict: true,
	verbose: true
});
