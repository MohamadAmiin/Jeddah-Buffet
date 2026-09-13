import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Vitest runs a global setup ONCE per project run, before any test file.
//
// This closes a real gap: `pnpm db:migrate` migrates only the database named by
// MIGRATE_DATABASE_URL. Nothing had ever created a single table in matcami_test,
// so without this every integration test in this plan would fail with
// `relation "restaurants" does not exist`.
export default async function setup() {
	// The guard is REPEATED here rather than assumed from integration-setup.ts. A
	// global setup that silently targeted the development database would migrate —
	// and the per-test reset would truncate — real data. Repeating four lines is
	// cheaper than trusting that another file ran first.
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			'TEST_DATABASE_URL is not set. The integration global setup refuses to run rather ' +
				'than fall back to DATABASE_URL, which points at development data.'
		);
	}
	const dbName = new URL(url).pathname.replace(/^\//, '');
	if (!dbName.endsWith('_test')) {
		throw new Error(
			`Refusing to migrate "${dbName}": the database name must end in "_test". This setup ` +
				'applies migrations and its tests truncate tables.'
		);
	}

	const pool = new pg.Pool({ connectionString: url, options: '-c timezone=UTC' });
	try {
		// Drizzle's RUNTIME migrator, not `drizzle-kit push`. Two reasons:
		//   - drizzle-orm is a runtime dependency and drizzle-kit is a dev dependency,
		//     and the same choice is what makes the production migration path possible.
		//   - `push` diffs the schema files straight into the database and NEVER runs
		//     a custom migration, so the append-only trigger from 0004 would be absent
		//     while the schema looked correct — and T-09's rejection test would fail
		//     for a reason that has nothing to do with the trigger.
		await migrate(drizzle(pool), { migrationsFolder: 'src/lib/server/db/migrations' });
	} finally {
		await pool.end();
	}
}
