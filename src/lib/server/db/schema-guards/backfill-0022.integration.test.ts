import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { closeTestDb } from '../test/db';

// Migration 0022 (tasks/customer-credit T-03), proved against the real database:
// its seed gives every EXISTING restaurant account 1100 Accounts Receivable and
// one DISABLED Customer credit method, invents nothing else and is idempotent;
// and it never touches a posted table (invariant 2).
//
// The seed is exercised by runBackfill, which runs the migration's OWN
// statements — the text between its two BACKFILL marker lines — never a copy
// (the backfill-0017 precedent). The triggers it creates are proved in
// constraints.integration.test.ts (T-04).
const pool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await pool.end();
	await closeTestDb();
});

const MIGRATION_URL = new URL('../migrations/0022_customer_credit_guards.sql', import.meta.url);
const BACKFILL_BEGIN = '-- BACKFILL BEGIN';
const BACKFILL_END = '-- BACKFILL END';

function migrationText(): string {
	return readFileSync(MIGRATION_URL, 'utf8');
}

function markerLine(lines: string[], marker: string): number {
	const found = lines.flatMap((line, index) => (line === marker ? [index] : []));
	if (found.length !== 1) {
		throw new Error(`0022 must hold the line "${marker}" exactly once; found ${found.length}`);
	}
	return found[0];
}

function backfillSection(text: string): string {
	const lines = text.split('\n');
	const begin = markerLine(lines, BACKFILL_BEGIN);
	const end = markerLine(lines, BACKFILL_END);
	if (end < begin) throw new Error('0022: the BACKFILL END line comes before BACKFILL BEGIN');
	return lines.slice(begin + 1, end).join('\n');
}

function onlyCommentsOrWhitespace(chunk: string): boolean {
	return chunk.split('\n').every((line) => /^\s*(--.*)?$/.test(line));
}

async function runBackfill(): Promise<void> {
	const statements = backfillSection(migrationText())
		.split('--> statement-breakpoint')
		.filter((chunk) => !onlyCommentsOrWhitespace(chunk));
	expect(statements).toHaveLength(2);
	for (const statement of statements) await pool.query(statement);
}

async function makeRestaurant(name: string): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		'insert into restaurants (name) values ($1) returning id',
		[name]
	);
	return rows[0].id;
}

async function addMethod(
	restaurantId: string,
	name: string,
	kind: 'cash' | 'card' | 'mobile',
	sortOrder: number
): Promise<void> {
	await pool.query(
		`insert into payment_methods (restaurant_id, name, kind, enabled, sort_order)
		 values ($1, $2, $3, true, $4)`,
		[restaurantId, name, kind, sortOrder]
	);
}

async function addAccount(restaurantId: string, code: string, name: string): Promise<void> {
	await pool.query(
		`insert into accounts (restaurant_id, code, name, type) values ($1, $2, $3, 'asset')`,
		[restaurantId, code, name]
	);
}

type MethodRow = { name: string; kind: string; enabled: boolean; sort_order: number };

async function methodsOf(restaurantId: string): Promise<MethodRow[]> {
	const { rows } = await pool.query<MethodRow>(
		`select name, kind, enabled, sort_order from payment_methods
		 where restaurant_id = $1 order by sort_order, name`,
		[restaurantId]
	);
	return rows;
}

async function accountCodes(restaurantId: string): Promise<string[]> {
	const { rows } = await pool.query<{ code: string }>(
		'select code from accounts where restaurant_id = $1 order by code',
		[restaurantId]
	);
	return rows.map((r) => r.code);
}

describe('0022 seed: account 1100 and the disabled Customer credit method (customer-credit T-03)', () => {
	it('an existing restaurant gains exactly one account and one disabled credit method', async () => {
		const id = await makeRestaurant('Cafe One');
		await addAccount(id, '1000', 'Cash on Hand');
		await addAccount(id, '1200', 'Inventory');
		await addMethod(id, 'Cash', 'cash', 0);
		await addMethod(id, 'EVC Plus', 'mobile', 1);

		await runBackfill();

		expect(await accountCodes(id)).toEqual(['1000', '1100', '1200']);
		const { rows } = await pool.query<{ name: string; type: string }>(
			`select name, type from accounts where restaurant_id = $1 and code = '1100'`,
			[id]
		);
		expect(rows).toEqual([{ name: 'Accounts Receivable', type: 'asset' }]);
		expect(await methodsOf(id)).toEqual([
			{ name: 'Cash', kind: 'cash', enabled: true, sort_order: 0 },
			{ name: 'EVC Plus', kind: 'mobile', enabled: true, sort_order: 1 },
			{ name: 'Customer credit', kind: 'credit', enabled: false, sort_order: 2 }
		]);
	});

	it('a restaurant already using the name "Customer credit" gets the fallback name, and its method is untouched', async () => {
		const id = await makeRestaurant('Cafe Tabs');
		await addMethod(id, 'Cash', 'cash', 0);
		await addMethod(id, 'customer CREDIT', 'mobile', 1);

		await runBackfill();

		expect(await methodsOf(id)).toEqual([
			{ name: 'Cash', kind: 'cash', enabled: true, sort_order: 0 },
			{ name: 'customer CREDIT', kind: 'mobile', enabled: true, sort_order: 1 },
			{ name: 'Customer credit (account)', kind: 'credit', enabled: false, sort_order: 2 }
		]);
	});

	it('every restaurant is seeded, each on its own', async () => {
		const a = await makeRestaurant('A');
		const b = await makeRestaurant('B');
		await addMethod(a, 'Cash', 'cash', 0);

		await runBackfill();

		expect((await methodsOf(a)).filter((m) => m.kind === 'credit')).toHaveLength(1);
		// B had no method at all: the credit row is still seeded, disabled.
		expect(await methodsOf(b)).toEqual([
			{ name: 'Customer credit', kind: 'credit', enabled: false, sort_order: 1 }
		]);
		expect(await accountCodes(b)).toEqual(['1100']);
	});

	it('is idempotent: a second run changes nothing', async () => {
		const id = await makeRestaurant('Cafe One');
		await addMethod(id, 'Cash', 'cash', 0);
		await runBackfill();
		const before = { methods: await methodsOf(id), accounts: await accountCodes(id) };

		await runBackfill();

		expect({ methods: await methodsOf(id), accounts: await accountCodes(id) }).toEqual(before);
	});

	it('an owner who already switched credit on keeps it on', async () => {
		const id = await makeRestaurant('Cafe One');
		await runBackfill();
		await pool.query(
			`update payment_methods set enabled = true where restaurant_id = $1 and kind = 'credit'`,
			[id]
		);

		await runBackfill();

		expect((await methodsOf(id)).filter((m) => m.kind === 'credit')).toEqual([
			{ name: 'Customer credit', kind: 'credit', enabled: true, sort_order: 1 }
		]);
	});
});

describe('0022 never touches a posted table (customer-credit T-03)', () => {
	it('MANDATORY (invariant 2): the seed names no sale or journal-entry table and holds no destructive statement', () => {
		const seed = backfillSection(migrationText());
		for (const table of [
			'orders',
			'order_lines',
			'payments"',
			'invoices',
			'journal_entries',
			'journal_entry_lines',
			'stock_movements',
			'customer_payments'
		]) {
			expect(seed).not.toContain(table);
		}
		const whole = migrationText()
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('--'))
			.join('\n');
		expect(whole).not.toMatch(/\b(ALTER TABLE|DROP|DELETE FROM|TRUNCATE|DISABLE TRIGGER)\b/i);
		expect(whole).not.toMatch(/\bUPDATE\s+"/i);
	});

	it('holds each BACKFILL marker line exactly once, with no trigger or function between them', () => {
		const seed = backfillSection(migrationText());
		expect(seed).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)/i);
	});

	it('the two triggers exist under the planned names', async () => {
		const { rows } = await pool.query<{ tgname: string }>(
			`select tgname from pg_trigger
			 where tgname in ('customers_archive_only', 'customer_payments_guard') and not tgisinternal
			 order by tgname`
		);
		expect(rows.map((r) => r.tgname)).toEqual([
			'customer_payments_guard',
			'customers_archive_only'
		]);
	});
});
