import pg from 'pg';

// EVERY LATER PLAN THAT ADDS A TENANT TABLE MUST ADD IT HERE, or its rows leak
// between test files and tests start failing for reasons that have nothing to do
// with the code under test.
//
// Current tables, child-first for readability (the single statement below makes
// the order irrelevant):
//   audit_log, sessions, users, restaurant_settings, restaurants
const TABLES = ['audit_log', 'sessions', 'users', 'restaurant_settings', 'restaurants'] as const;

// Connect as the OWNER. TEST_DATABASE_URL points at `matcami` for exactly this
// reason (T-02 step 4): TRUNCATE requires a privilege the runtime role
// deliberately does not have.
let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
	if (!pool) {
		const url = process.env.TEST_DATABASE_URL;
		if (!url) throw new Error('TEST_DATABASE_URL is not set — refusing to reset any database.');
		const dbName = new URL(url).pathname.replace(/^\//, '');
		if (!dbName.endsWith('_test')) {
			throw new Error(`Refusing to truncate "${dbName}": the database name must end in "_test".`);
		}
		pool = new pg.Pool({ connectionString: url, options: '-c timezone=UTC' });
	}
	return pool;
}

/**
 * Truncate every table the schema defines, in ONE statement.
 *
 * One statement, not five: the foreign keys are RESTRICT, so truncating them
 * separately in the wrong order fails, and CASCADE in a single statement covers
 * the set. RESTART IDENTITY resets audit_log's identity sequence so ids are
 * predictable per test.
 *
 * TRUNCATE is used rather than DELETE deliberately — audit_log's append-only
 * trigger blocks DELETE, and TRUNCATE fires only statement-level triggers, so it
 * is the one way to clear that table at all.
 */
export async function resetDb(): Promise<void> {
	await getPool().query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** Close the pool. Called from the integration setup's afterAll. */
export async function closeResetPool(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = undefined;
	}
}
