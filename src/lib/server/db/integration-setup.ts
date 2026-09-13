import { beforeEach, afterAll } from 'vitest';
import { resetDb, closeResetPool } from './test/reset';

// FAIL CLOSED. This is the guard that stops a test run destroying development
// data. Integration tests truncate tables; DATABASE_URL points at data somebody
// cares about. There is deliberately NO fallback to DATABASE_URL — a fallback is
// what turns "the test database was not configured" into "the test suite
// truncated the real one".
const url = process.env.TEST_DATABASE_URL;

if (!url) {
	throw new Error(
		'TEST_DATABASE_URL is not set. The integration project refuses to run rather than ' +
			'silently fall back to DATABASE_URL, because these tests truncate tables and ' +
			'DATABASE_URL points at development data. Set TEST_DATABASE_URL (see .env.example).'
	);
}

const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
	throw new Error(
		`Refusing to run integration tests against "${dbName}": the database name must end in ` +
			'"_test". Integration tests truncate tables, and this guard is what keeps them away ' +
			'from development and production data.'
	);
}

// Reset between tests HERE rather than per-test, so a new test file cannot forget
// it. Deliberately NOT a transaction-rollback wrapper: two tests in this plan need
// genuinely committed, concurrent transactions — T-14's "two concurrent
// registrations, exactly one succeeds" and T-13's lockout, which must observe a
// counter that survived a rejected login. A rollback wrapper makes both untestable.
beforeEach(async () => {
	await resetDb();
});

afterAll(async () => {
	await closeResetPool();
});
