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
	dbCredentials: { url: process.env.DATABASE_URL! },
	strict: true,
	verbose: true
});
