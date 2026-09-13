import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

// A Drizzle handle on the TEST database, for integration tests.
//
// The `db` singleton in ../client.ts cannot be used here for two reasons, both
// load bearing:
//   1. it reads DATABASE_URL, which is the RUNTIME role against DEVELOPMENT
//      data — R4 forbids integration tests from touching either;
//   2. it imports ../env, which imports $env/dynamic/private, a SvelteKit
//      virtual module that does not resolve in a plain-node Vitest project.
//
// The pool options mirror client.ts deliberately (UTC session, no type parsers).
// If client.ts's options change, change them here too.
let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
	if (!pool) {
		const url = process.env.TEST_DATABASE_URL;
		if (!url) throw new Error('TEST_DATABASE_URL is not set.');
		const dbName = new URL(url).pathname.replace(/^\//, '');
		if (!dbName.endsWith('_test')) {
			throw new Error(`Refusing to connect to "${dbName}": the name must end in "_test".`);
		}
		pool = new pg.Pool({ connectionString: url, options: '-c timezone=UTC' });
	}
	return pool;
}

export function testDb() {
	return drizzle(getPool());
}

export async function closeTestDb(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = undefined;
	}
}
