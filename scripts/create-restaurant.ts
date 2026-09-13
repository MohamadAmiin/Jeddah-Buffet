#!/usr/bin/env node
//
// Create an ADDITIONAL restaurant and its owner.
//
//   pnpm restaurant:create
//
// This is the ONLY way to add a second restaurant. There is deliberately no
// environment variable that re-opens /register: a flag that re-exposes an
// unauthenticated account-creating endpoint is one forgotten variable away from
// public signup with none of the guards public signup would need.
//
// It calls the SAME registerRestaurant the web route calls, so the restaurant,
// its settings row, its owner and its audit rows are created by one code path
// with one set of rules. It bypasses only the SETUP-TOKEN gate and the first-run
// gate — never the advisory lock, never the uniqueness checks — because the
// caller already holds the database credentials and a token would prove nothing.
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { registerRestaurant } from '../src/lib/server/auth/register';
import { makePrompter } from './prompt';

function connect() {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error('DATABASE_URL is not set. Fill in .env (see .env.example).');
		process.exit(1);
	}
	return { pool: new pg.Pool({ connectionString: url, options: '-c timezone=UTC' }), url };
}

async function main() {
	const { pool, url } = connect();
	const parsed = new URL(url);
	const dbName = parsed.pathname.replace(/^\//, '');

	console.log(`Host:     ${parsed.hostname}:${parsed.port || '5432'}`);
	console.log(`Database: ${dbName}`);

	const prompt = makePrompter();
	try {
		const confirm = await prompt.ask('Type the database name to continue: ');
		if (confirm.trim() !== dbName) {
			console.error('Did not match. Nothing was created.');
			process.exit(1);
		}

		const restaurantName = (await prompt.ask('Restaurant name: ')).trim();
		const timeZone = (await prompt.ask('Time zone (e.g. Africa/Mogadishu): ')).trim();
		const ownerDisplayName = (await prompt.ask('Owner name: ')).trim();
		const email = (await prompt.ask('Owner email: ')).trim();
		const password = await prompt.askSecret('Owner password: ');
		const again = await prompt.askSecret('Repeat it: ');

		if (password !== again) {
			console.error('The two passwords do not match. Nothing was created.');
			process.exit(1);
		}
		if (password.length < 8) {
			console.error('Use at least 8 characters. Nothing was created.');
			process.exit(1);
		}

		const result = await registerRestaurant(
			drizzle(pool),
			{
				restaurantName,
				timeZone,
				ownerDisplayName,
				email,
				password,
				setupToken: ''
			},
			{
				ip: null,
				userAgent: 'cli:create-restaurant',
				bypassSetupToken: true,
				allowAdditionalRestaurant: true
			}
		);

		if (!result.ok) {
			console.error(`Could not create the restaurant: ${result.reason}. Nothing was created.`);
			process.exit(1);
		}

		// Never print the password or the session token.
		console.log('\nRestaurant created.');
		console.log(`  restaurant: ${result.restaurantId}`);
		console.log(`  owner:      ${result.userId}`);
		console.log(`  audit rows: restaurant.registered, user.created`);
		console.log('\nThe owner can now sign in at /login with that email and password.');
	} finally {
		prompt.close();
		await pool.end();
	}
}

await main();
