import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb, testDb } from '../db/test/db';
import { accounts } from '../db/schema/accounting';
import { registerRestaurant } from '../auth/register';
import { CHART, ACCOUNT_TYPES, ensureChart, accountIdByCode } from './chart';

afterAll(async () => {
	await closeTestDb();
});

async function register(name: string, email: string): Promise<string> {
	const result = await registerRestaurant(
		db,
		{
			restaurantName: name,
			timeZone: 'Africa/Mogadishu',
			ownerDisplayName: 'The Owner',
			email,
			password: 'a strong enough password'
		},
		{ mode: 'operator', ip: null, userAgent: 'cli:test' }
	);
	if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
	return result.restaurantId;
}

describe('the chart of accounts', () => {
	it('CHART has 23 rows, exact spec-23 codes and account types', () => {
		expect(CHART).toHaveLength(23);
		const codes = new Set(CHART.map((r) => r.code));
		expect(codes).toEqual(
			new Set([
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
			])
		);
		for (const row of CHART) {
			expect(ACCOUNT_TYPES).toContain(row.type);
		}
		// The en dash (U+2013) survived a copy from spec 23.
		expect(CHART[2].name).toBe('Payment Clearing – Card');
		expect(CHART[2].name.charCodeAt(17)).toBe(0x2013);
	});

	it('registering a restaurant seeds all 23 accounts once', async () => {
		const restaurantId = await register('Cafe One', 'chart-one@example.com');
		const rows = await testDb()
			.select()
			.from(accounts)
			.where(eq(accounts.restaurantId, restaurantId));
		expect(rows).toHaveLength(23);
		expect(
			rows
				.map((r) => ({ code: r.code, name: r.name, type: r.type }))
				.sort((a, b) => a.code.localeCompare(b.code))
		).toEqual([...CHART].sort((a, b) => a.code.localeCompare(b.code)));
	});

	it('two restaurants get 23 accounts each, per-restaurant', async () => {
		const rA = await register('Cafe Two', 'chart-two@example.com');
		const rB = await register('Cafe Three', 'chart-three@example.com');
		const rowsA = await testDb().select().from(accounts).where(eq(accounts.restaurantId, rA));
		const rowsB = await testDb().select().from(accounts).where(eq(accounts.restaurantId, rB));
		expect(rowsA).toHaveLength(23);
		expect(rowsB).toHaveLength(23);
	});

	it('ensureChart is idempotent and keeps the same ids', async () => {
		const restaurantId = await register('Cafe Idem', 'chart-idem@example.com');
		const first = await testDb()
			.select()
			.from(accounts)
			.where(eq(accounts.restaurantId, restaurantId));
		expect(first).toHaveLength(23);
		await db.transaction(async (tx) => ensureChart(tx, restaurantId));
		const second = await testDb()
			.select()
			.from(accounts)
			.where(eq(accounts.restaurantId, restaurantId));
		expect(second).toHaveLength(23);
		const byCode = (rows: typeof first) => Object.fromEntries(rows.map((r) => [r.code, r.id]));
		expect(byCode(second)).toEqual(byCode(first));
	});

	it('parity with the SQL backfill in migration 0012', () => {
		const migration = new URL('../db/migrations/0012_journal_guards.sql', import.meta.url);
		const sqlText = readFileSync(migration, 'utf8');
		const tuple = /\(\s*'(\d{4})'\s*,\s*'((?:[^']|'')+)'\s*,\s*'([a-z_]+)'\s*\)/g;
		const rows = [...sqlText.matchAll(tuple)].map(([, code, name, type]) => ({
			code,
			name: name.replaceAll("''", "'"),
			type
		}));
		expect(rows).toHaveLength(23);
		const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
		expect([...rows].sort(byCode)).toEqual(
			[...CHART].sort(byCode).map((r) => ({ code: r.code, name: r.name, type: r.type }))
		);
	});

	it('accountIdByCode returns a real id and throws on a missing code', async () => {
		const restaurantId = await register('Cafe Look', 'chart-look@example.com');
		const id = await accountIdByCode(testDb(), restaurantId, '1000');
		expect(id).toBeTruthy();
		await expect(accountIdByCode(testDb(), restaurantId, '9999')).rejects.toThrow(/9999/);
		await expect(
			accountIdByCode(testDb(), '00000000-0000-0000-0000-000000000000', '1000')
		).rejects.toThrow(/1000/);
	});
});
