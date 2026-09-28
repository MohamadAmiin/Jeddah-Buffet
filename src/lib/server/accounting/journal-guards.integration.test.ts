import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { accounts, journalEntries, journalEntryLines } from '../db/schema/accounting';

// A raw pool alongside testDb() so append-only rejections (raw UPDATE/DELETE)
// can be observed at their own layer without going through Drizzle's
// transaction machinery. testDb() covers the DEFERRED balance case: Drizzle
// issues `commit` inside its try, the trigger raises during that commit,
// PostgreSQL rolls the transaction back, Drizzle rethrows — so the promise
// rejects and the row counts afterwards are the proof nothing leaked.

const pool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await pool.end();
	await closeTestDb();
});

async function expectError(sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
	try {
		await pool.query(sql, params);
	} catch (error) {
		return error as pg.DatabaseError;
	}
	throw new Error(`Expected this statement to be rejected, but it succeeded:\n${sql}`);
}

/** Drizzle's transaction() wraps the underlying pg error with "Failed query:"
 * and stashes the real error on `.cause`. Walk the chain to find the pg
 * DatabaseError so tests can match on its actual message. */
function underlyingMessage(err: unknown): string {
	const seen = new Set<unknown>();
	let cur: unknown = err;
	const messages: string[] = [];
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		if (cur instanceof Error) messages.push(cur.message);
		cur = (cur as { cause?: unknown }).cause;
	}
	return messages.join(' | ');
}

async function expectDrizzleReject(fn: () => Promise<unknown>): Promise<pg.DatabaseError> {
	try {
		await fn();
	} catch (error) {
		return error as pg.DatabaseError;
	}
	throw new Error('Expected the transaction to reject, but it committed.');
}

async function makeRestaurant(name = 'Cafe One'): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		'insert into restaurants (name) values ($1) returning id',
		[name]
	);
	return rows[0].id;
}

async function makeOwner(restaurantId: string, email: string): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into users (restaurant_id, role, display_name, email, password_hash)
		 values ($1, 'owner', 'Owner', $2, 'not-a-real-hash') returning id`,
		[restaurantId, email]
	);
	return rows[0].id;
}

async function makeDevice(
	restaurantId: string,
	ownerId: string,
	code = 'POS1',
	tokenHash = 'a'.repeat(64)
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into pos_devices (restaurant_id, device_code, label, token_hash, registered_by_user_id)
		 values ($1, $2, 'Counter tablet', $3, $4) returning id`,
		[restaurantId, code, tokenHash, ownerId]
	);
	return rows[0].id;
}

async function makeSession(
	restaurantId: string,
	deviceId: string,
	userId: string
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into pos_sessions (
			restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
			opening_cash_minor, status
		) values ($1, $2, $3, now(), '2026-09-28', 50000, 'open') returning id`,
		[restaurantId, deviceId, userId]
	);
	return rows[0].id;
}

async function makeOrder(
	restaurantId: string,
	sessionId: string,
	deviceId: string,
	userId: string,
	status: 'open' | 'paid' = 'paid'
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into orders (
			restaurant_id, pos_session_id, device_id, employee_user_id, order_type, status,
			tax_mode, currency_code, menu_version, subtotal_minor, tax_minor, total_minor,
			opened_at, paid_at
		) values ($1, $2, $3, $4, 'takeaway', $5, 'exclusive', 'USD', 1, 1000, 100, 1100,
			now(), now()) returning id`,
		[restaurantId, sessionId, deviceId, userId, status]
	);
	return rows[0].id;
}

async function makePayment(restaurantId: string, orderId: string): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into payments (
			restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
		) values ($1, $2, 'cash', 1100, 2000, 900, now()) returning id`,
		[restaurantId, orderId]
	);
	return rows[0].id;
}

async function makeInvoice(
	restaurantId: string,
	orderId: string,
	deviceId: string
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into invoices (
			restaurant_id, order_id, device_id, invoice_seq, invoice_number, total_minor, issued_at
		) values ($1, $2, $3, 1, 'POS1-000001', 1100, now()) returning id`,
		[restaurantId, orderId, deviceId]
	);
	return rows[0].id;
}

async function accountId(restaurantId: string, code: string): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`select id from accounts where restaurant_id = $1 and code = $2`,
		[restaurantId, code]
	);
	if (rows.length === 0) throw new Error(`no account ${code} in restaurant ${restaurantId}`);
	return rows[0].id;
}

/** seedChart: run the migration's own INSERT INTO accounts chunk (idempotent
 * via ON CONFLICT), NOT a copy. Proves the migration's statement. */
async function seedChart(restaurantId: string): Promise<void> {
	const migrationSql = readFileSync(
		new URL('../db/migrations/0012_journal_guards.sql', import.meta.url),
		'utf8'
	);
	const chunks = migrationSql.split('--> statement-breakpoint');
	const insertChunk = chunks.find((s) => /^\s*(?:--[^\n]*\n\s*)*INSERT INTO accounts\b/.test(s));
	if (!insertChunk) throw new Error('could not locate the INSERT INTO accounts chunk');
	// The migration's INSERT reads from restaurants r; scope to one restaurant here.
	const scoped = insertChunk.replace(
		'FROM restaurants r',
		`FROM (SELECT '${restaurantId}'::uuid AS id) r`
	);
	await pool.query(scoped);
}

type LineSpec = { code: string; debit?: bigint; credit?: bigint };

async function writeEntry(
	tx: Parameters<Parameters<ReturnType<typeof testDb>['transaction']>[0]>[0],
	restaurantId: string,
	lines: LineSpec[]
): Promise<string> {
	const [entry] = await tx
		.insert(journalEntries)
		.values({
			restaurantId,
			businessDate: '2026-09-28',
			event: 'cash_sale',
			sourceType: 'order',
			sourceId: randomUUID(),
			memo: 'test'
		})
		.returning({ id: journalEntries.id });
	let lineNo = 1;
	for (const l of lines) {
		const id = await accountIdInTx(tx, restaurantId, l.code);
		await tx.insert(journalEntryLines).values({
			restaurantId,
			entryId: entry.id,
			accountId: id,
			lineNo: lineNo++,
			debitMinor: l.debit ?? 0n,
			creditMinor: l.credit ?? 0n
		});
	}
	return entry.id;
}

async function accountIdInTx(
	tx: Parameters<Parameters<ReturnType<typeof testDb>['transaction']>[0]>[0],
	restaurantId: string,
	code: string
): Promise<string> {
	const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
	if (!row) throw new Error(`no account ${code}`);
	// Scope-check: the seedChart above is per-restaurant, so all accounts belong
	// to `restaurantId` in a well-formed test setup; nothing else to enforce.
	if (restaurantId === '') throw new Error('unreachable');
	return row.id;
}

describe('journal balance and append-only guards (T-09)', () => {
	let restaurantId: string;

	beforeEach(async () => {
		restaurantId = await makeRestaurant('journal-guards');
		await seedChart(restaurantId);
	});

	it('MANDATORY (spec 29 — journal entries always balance): rejects at COMMIT, entry never lands', async () => {
		const before = await pool.query<{ c: string }>(
			`select count(*)::text as c from journal_entries where restaurant_id = $1`,
			[restaurantId]
		);

		const err = await expectDrizzleReject(() =>
			testDb().transaction(async (tx) => {
				await writeEntry(tx, restaurantId, [{ code: '1000', debit: 1100n }]);
			})
		);
		expect(underlyingMessage(err)).toMatch(
			/journal entry [0-9a-f-]{36} is not balanced: debits 1100 credits 0, debit lines 1, credit lines 0/
		);

		const after = await pool.query<{ c: string }>(
			`select count(*)::text as c from journal_entries where restaurant_id = $1`,
			[restaurantId]
		);
		expect(after.rows[0].c).toBe(before.rows[0].c);
	});

	it('MANDATORY (spec 29 — the positive half): a balanced two-line entry commits', async () => {
		let entryId = '';
		await testDb().transaction(async (tx) => {
			entryId = await writeEntry(tx, restaurantId, [
				{ code: '1000', debit: 1100n },
				{ code: '4000', credit: 1100n }
			]);
		});
		expect(entryId).toBeTruthy();

		const [line1] = await testDb()
			.select({ debit: journalEntryLines.debitMinor })
			.from(journalEntryLines)
			.where(eq(journalEntryLines.entryId, entryId));
		expect(line1.debit).toBe(1100n);
	});

	it('MANDATORY: a four-line entry with a discount commits (spec 24 example)', async () => {
		let entryId = '';
		await testDb().transaction(async (tx) => {
			entryId = await writeEntry(tx, restaurantId, [
				{ code: '1000', debit: 990n },
				{ code: '4100', debit: 100n },
				{ code: '4000', credit: 1000n },
				{ code: '2100', credit: 90n }
			]);
		});
		expect(entryId).toBeTruthy();
	});

	it('MANDATORY: an entry with NO lines is rejected at COMMIT', async () => {
		const err = await expectDrizzleReject(() =>
			testDb().transaction(async (tx) => {
				await tx.insert(journalEntries).values({
					restaurantId,
					businessDate: '2026-09-28',
					event: 'cash_sale',
					sourceType: 'order',
					sourceId: randomUUID(),
					memo: 'no-lines-case'
				});
			})
		);
		expect(underlyingMessage(err)).toMatch(/journal entry [0-9a-f-]{36} has no lines/);
	});

	it('MANDATORY: two debit lines and no credit line is rejected at COMMIT', async () => {
		const err = await expectDrizzleReject(() =>
			testDb().transaction(async (tx) => {
				await writeEntry(tx, restaurantId, [
					{ code: '1000', debit: 500n },
					{ code: '1200', debit: 500n }
				]);
			})
		);
		expect(underlyingMessage(err)).toMatch(/debits 1000 credits 0, debit lines 2, credit lines 0/);
	});

	it('MANDATORY: mismatched totals are rejected at COMMIT', async () => {
		const err = await expectDrizzleReject(() =>
			testDb().transaction(async (tx) => {
				await writeEntry(tx, restaurantId, [
					{ code: '1000', debit: 1100n },
					{ code: '4000', credit: 1000n }
				]);
			})
		);
		expect(underlyingMessage(err)).toMatch(/debits 1100 credits 1000/);
	});
});

describe('append-only triggers (T-09; invariant 2)', () => {
	let restaurantId: string;
	let ownerId: string;
	let deviceId: string;
	let sessionId: string;
	let orderId: string;
	let entryId: string;

	// The integration harness truncates every table before each test, so this
	// setup must run per test rather than once for the block.
	async function seedFixture() {
		restaurantId = await makeRestaurant('append-only');
		ownerId = await makeOwner(restaurantId, 'append-only@example.com');
		deviceId = await makeDevice(restaurantId, ownerId);
		sessionId = await makeSession(restaurantId, deviceId, ownerId);
		orderId = await makeOrder(restaurantId, sessionId, deviceId, ownerId);
		await makePayment(restaurantId, orderId);
		await makeInvoice(restaurantId, orderId, deviceId);

		await seedChart(restaurantId);

		await testDb().transaction(async (tx) => {
			entryId = await writeEntry(tx, restaurantId, [
				{ code: '1000', debit: 1100n },
				{ code: '4000', credit: 1100n }
			]);
		});
	}

	async function assertRejects(sql: string, params: unknown[], table: string, op: string) {
		const err = await expectError(sql, params);
		expect(err.code).toBe('P0001');
		expect(err.message).toContain(`${table} is append-only`);
		expect(err.message).toContain(op);
		expect(err.hint).toBe(
			'Correct a mistake with a reversing record, never by changing a posted one'
		);
	}

	it('UPDATE and DELETE are rejected on journal_entries, journal_entry_lines, invoices and payments', async () => {
		await seedFixture();
		await assertRejects(
			`update journal_entries set memo = 'tampered' where id = $1`,
			[entryId],
			'journal_entries',
			'UPDATE'
		);
		await assertRejects(
			`delete from journal_entries where id = $1`,
			[entryId],
			'journal_entries',
			'DELETE'
		);
		await assertRejects(
			`update journal_entry_lines set line_no = 99 where entry_id = $1`,
			[entryId],
			'journal_entry_lines',
			'UPDATE'
		);
		await assertRejects(
			`delete from journal_entry_lines where entry_id = $1`,
			[entryId],
			'journal_entry_lines',
			'DELETE'
		);
		await assertRejects(
			`update invoices set total_minor = 0 where order_id = $1`,
			[orderId],
			'invoices',
			'UPDATE'
		);
		await assertRejects(
			`delete from invoices where order_id = $1`,
			[orderId],
			'invoices',
			'DELETE'
		);
		await assertRejects(
			`update payments set amount_minor = 0 where order_id = $1`,
			[orderId],
			'payments',
			'UPDATE'
		);
		await assertRejects(
			`delete from payments where order_id = $1`,
			[orderId],
			'payments',
			'DELETE'
		);

		// Nothing leaked.
		const { rows: eCounts } = await pool.query<{ e: string; l: string; i: string; p: string }>(
			`select (select count(*)::text from journal_entries where id = $1) as e,
			        (select count(*)::text from journal_entry_lines where entry_id = $1) as l,
			        (select count(*)::text from invoices where order_id = $2) as i,
			        (select count(*)::text from payments where order_id = $2) as p`,
			[entryId, orderId]
		);
		expect(eCounts[0]).toEqual({ e: '1', l: '2', i: '1', p: '1' });
	});

	it('orders, pos_sessions and pos_sync_ops are NOT append-only — updates succeed', async () => {
		const rId = await makeRestaurant('append-only-updates');
		const oId = await makeOwner(rId, 'append-only-updates@example.com');
		const dId = await makeDevice(rId, oId);
		const sId = await makeSession(rId, dId, oId);
		const oOpenId = await makeOrder(rId, sId, dId, oId, 'open');

		const { rowCount: rcOrders } = await pool.query(
			`update orders set status = 'paid', updated_at = now() where id = $1`,
			[oOpenId]
		);
		expect(rcOrders).toBe(1);

		const { rowCount: rcSessions } = await pool.query(
			`update pos_sessions set status = 'closed', closed_at = now(),
			 closed_by_user_id = $2, closed_from_device_id = $3,
			 counted_cash_minor = 50000, expected_cash_minor = 50000, difference_minor = 0
			 where id = $1`,
			[sId, oId, dId]
		);
		expect(rcSessions).toBe(1);

		const { rows: opRows } = await pool.query<{ id: string }>(
			`insert into pos_sync_ops (restaurant_id, device_id, received_via_device_id, client_op_id,
			 kind, status, error, occurred_at, payload)
			 values ($1, $2, $2, gen_random_uuid(), 'sale.complete', 'unrecorded', 'database_error',
			 now(), '{}'::jsonb) returning id`,
			[rId, dId]
		);
		const { rowCount: rcSync } = await pool.query(
			`update pos_sync_ops set status = 'accepted', resolved_at = now(),
			 resolution = 'retried' where id = $1`,
			[opRows[0].id]
		);
		expect(rcSync).toBe(1);
	});
});

describe('chart backfill (T-09)', () => {
	it('seedChart is idempotent and covers all 23 spec 23 codes', async () => {
		const r1 = await makeRestaurant('chart-1');
		await seedChart(r1);
		await seedChart(r1);
		const { rows: after } = await pool.query<{ c: string }>(
			`select count(*)::text as c from accounts where restaurant_id = $1`,
			[r1]
		);
		expect(after[0].c).toBe('23');

		const { rows: codes } = await pool.query<{ code: string }>(
			`select code from accounts where restaurant_id = $1 order by code`,
			[r1]
		);
		expect(codes.map((c) => c.code)).toEqual([
			'1000',
			'1010',
			'1020',
			'1030',
			'1200',
			'2000',
			'2100',
			'3000',
			'3100',
			'3900',
			'4000',
			'4100',
			'4200',
			'5000',
			'5100',
			'5200',
			'6000',
			'6100',
			'6200',
			'6300',
			'6400',
			'6800',
			'6900'
		]);

		const { rows: named } = await pool.query<{ code: string; name: string; type: string }>(
			`select code, name, type from accounts where restaurant_id = $1 and code in
			 ('1020', '1030', '3000', '5000', '6800') order by code`,
			[r1]
		);
		const byCode = Object.fromEntries(named.map((r) => [r.code, r]));
		expect(byCode['1020'].name).toBe('Payment Clearing – Card');
		expect(byCode['1030'].name).toBe('Payment Clearing – Mobile Money');
		expect(byCode['3000'].name).toBe("Owner's Capital");
		expect(byCode['5000'].type).toBe('cost_of_sales');
		expect(byCode['6800'].type).toBe('expense');

		// A second restaurant seeded independently gets its own 23.
		const r2 = await makeRestaurant('chart-2');
		await seedChart(r2);
		const { rows: countTwo } = await pool.query<{ c: string }>(
			`select count(*)::text as c from accounts where restaurant_id = $1`,
			[r2]
		);
		expect(countTwo[0].c).toBe('23');
		expect(await accountId(r2, '1000')).toBeTruthy();
	});

	it('the triggers are deferrable and initially deferred; the four append-only triggers exist', async () => {
		const { rows: deferred } = await pool.query<{
			tgname: string;
			tgdeferrable: boolean;
			tginitdeferred: boolean;
		}>(
			`select tgname, tgdeferrable, tginitdeferred from pg_trigger
			 where tgname in ('journal_entry_lines_balanced', 'journal_entries_have_lines')`
		);
		expect(deferred).toHaveLength(2);
		for (const row of deferred) {
			expect(row.tgdeferrable).toBe(true);
			expect(row.tginitdeferred).toBe(true);
		}

		const { rows: appendOnly } = await pool.query<{ c: string }>(
			`select count(*)::text as c from pg_trigger where tgname like '%_append_only'`
		);
		expect(appendOnly[0].c).toBe('4');
	});
});
