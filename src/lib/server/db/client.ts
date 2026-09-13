import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { DATABASE_URL } from '../env';

// Every connection speaks UTC. Invariant 11: timestamps are stored UTC in
// timestamptz; the restaurant's time zone is a setting applied at the edges,
// never a property of the database session.
const pool = new pg.Pool({
	connectionString: DATABASE_URL,
	options: '-c timezone=UTC'
});

// NO TYPE PARSERS, deliberately. Do not call pg.types.setTypeParser, and never
// pass mode: 'number' to a bigint or numeric column. Left alone, pg returns
// int8 and numeric as STRINGS — exactly what invariant 1 requires: money as
// integer minor units and quantities as fixed-precision decimals, with no float
// anywhere near them. A type parser added "for convenience" later is how money
// silently becomes a JS float.
export const db = drizzle(pool);
export type Db = typeof db;

// Invariant 4 requires ONE all-or-nothing transaction at payment, so every
// function that writes takes a transaction handle rather than reaching for the
// db singleton. Exporting the type now is what makes that the easy path later.
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
