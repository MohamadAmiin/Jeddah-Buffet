#!/usr/bin/env node
//
// Reset an owner's password.
//
//   pnpm auth:reset-owner <email>
//
// The password is read from a PROMPT, never from an argument: an argument lands
// in the shell history and in the process list, where any other user on the
// machine can read it.
//
// This is the SANCTIONED path. The unsanctioned one — `UPDATE users SET
// password_hash = '...'` typed by whoever holds the database URL — leaves no
// audit row, no session invalidation, and a hash produced outside the application
// that may not even parse.
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { resetOwnerPassword } from '../src/lib/server/auth/operator';
import { makePrompter } from './prompt';

// A pool built here rather than importing src/lib/server/db/client.ts: that module
// reads $env/dynamic/private, a SvelteKit virtual module that does not resolve
// under plain node.
function connect() {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error('DATABASE_URL is not set. Fill in .env (see .env.example).');
		process.exit(1);
	}
	return { pool: new pg.Pool({ connectionString: url, options: '-c timezone=UTC' }), url };
}

async function main() {
	const email = process.argv[2];
	if (!email) {
		console.error('Usage: pnpm auth:reset-owner <email>');
		process.exit(1);
	}

	const { pool, url } = connect();
	const parsed = new URL(url);

	// Refuse to run against a database the operator did not mean.
	console.log(`Host:     ${parsed.hostname}:${parsed.port || '5432'}`);
	console.log(`Database: ${parsed.pathname.replace(/^\//, '')}`);
	console.log(`Owner:    ${email}`);

	const prompt = makePrompter();
	try {
		const confirm = await prompt.ask('Type the database name to continue: ');
		if (confirm.trim() !== parsed.pathname.replace(/^\//, '')) {
			console.error('Did not match. Nothing was changed.');
			process.exit(1);
		}

		const password = await prompt.askSecret('New password: ');
		const again = await prompt.askSecret('Repeat it: ');
		if (password !== again) {
			console.error('The two passwords do not match. Nothing was changed.');
			process.exit(1);
		}
		if (password.length < 8) {
			console.error('Use at least 8 characters. Nothing was changed.');
			process.exit(1);
		}

		const result = await resetOwnerPassword(drizzle(pool), email, password);
		if (!result.ok) {
			console.error(`No owner found with that email. Nothing was changed.`);
			process.exit(1);
		}

		// Never print the password or the hash.
		console.log('\nPassword reset.');
		console.log(`  user:              ${result.userId}`);
		console.log(`  restaurant:        ${result.restaurantId}`);
		console.log(`  sessions ended:    ${result.sessionsRemoved}`);
		console.log('  lockout cleared:   yes');
		console.log('  audit row written: user.password_reset_by_operator');
	} finally {
		prompt.close();
		await pool.end();
	}
}

await main();
