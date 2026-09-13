import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';

// This mirrors client.ts's pool options deliberately, against TEST_DATABASE_URL
// rather than importing the `db` singleton. Two reasons, both load bearing:
//   1. client.ts reads DATABASE_URL, which points at DEVELOPMENT data. R4 says
//      integration tests never touch it, and integration-setup.ts refuses any
//      database whose name does not end in _test.
//   2. client.ts imports $lib/server/env, a SvelteKit virtual module that does
//      not resolve under a plain Vitest node project.
// If client.ts's pool options ever change, change them here too — this test is
// what proves the configuration behaves, not that the file compiles.
const pool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await pool.end();
});

describe('database client configuration', () => {
	it('round-trips a query', async () => {
		const { rows } = await pool.query('select 1 as one');
		expect(rows[0].one).toBe(1);
	});

	it('speaks UTC on every connection (invariant 11)', async () => {
		// Timestamps are stored UTC in timestamptz; the restaurant's time zone is a
		// setting applied at the edges, never a property of the database session.
		// The `options: '-c timezone=UTC'` above is what makes this true.
		const { rows } = await pool.query("select current_setting('TimeZone') as tz");
		expect(rows[0].tz).toBe('UTC');
	});

	it('returns int8 as a string, never a float (invariant 1)', async () => {
		// 9007199254740993 is larger than Number.MAX_SAFE_INTEGER, so it cannot
		// survive a float round-trip. This assertion fails the day someone adds a
		// pg type parser and turns money into a JS number.
		const { rows } = await pool.query("select '9007199254740993'::int8 as big");
		expect(typeof rows[0].big).toBe('string');
		expect(rows[0].big).toBe('9007199254740993');
	});

	it('returns numeric as a string too (invariant 1)', async () => {
		// Ingredient quantities are numeric(12,3); the same no-type-parser rule
		// keeps them exact rather than binary floats.
		const { rows } = await pool.query("select '12.345'::numeric(12,3) as qty");
		expect(typeof rows[0].qty).toBe('string');
		expect(rows[0].qty).toBe('12.345');
	});
});
