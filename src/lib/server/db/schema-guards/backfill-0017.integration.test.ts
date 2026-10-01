import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { settingsComplete } from '../../restaurants';
import { testDb, closeTestDb } from '../test/db';

// Migration 0017 (tasks/settings-tax-payments-receipt T-07), proved against the
// real database: its backfill carries every restaurant's existing answers into
// the named-rate and payment-method tables and invents none, its triggers make
// the two catalogues archive-only and a payment method's kind permanent, and it
// never touches a posted table (invariant 2).
//
// The backfill is exercised by runBackfill, which runs the migration's OWN
// statements — the text between its two BACKFILL marker lines — never a copy
// (the seedChart precedent in accounting/journal-guards.integration.test.ts), so
// this file proves the statements that actually ran on every database.
//
// Connects with TEST_DATABASE_URL (the owner), like the rest of the integration
// project. The per-test truncate in integration-setup.ts gives each case a clean
// slate, so the backfill — which reads every restaurant — sees only the rows the
// case seeded.
const pool = new pg.Pool({
	connectionString: process.env.TEST_DATABASE_URL,
	options: '-c timezone=UTC'
});

afterAll(async () => {
	await pool.end();
	await closeTestDb();
});

const MIGRATION_URL = new URL('../migrations/0017_named_rates_and_methods.sql', import.meta.url);
const BACKFILL_BEGIN = '-- BACKFILL BEGIN';
const BACKFILL_END = '-- BACKFILL END';

function migrationText(): string {
	return readFileSync(MIGRATION_URL, 'utf8');
}

/** The index of the one line that is exactly `marker`; throws unless there is exactly one. */
function markerLine(lines: string[], marker: string): number {
	const found = lines.flatMap((line, index) => (line === marker ? [index] : []));
	if (found.length !== 1) {
		throw new Error(`0017 must hold the line "${marker}" exactly once; found ${found.length}`);
	}
	return found[0];
}

/** The text between the two BACKFILL marker lines, markers excluded. */
function backfillSection(text: string): string {
	const lines = text.split('\n');
	const begin = markerLine(lines, BACKFILL_BEGIN);
	const end = markerLine(lines, BACKFILL_END);
	if (end < begin) throw new Error('0017: the BACKFILL END line comes before BACKFILL BEGIN');
	return lines.slice(begin + 1, end).join('\n');
}

function onlyCommentsOrWhitespace(chunk: string): boolean {
	return chunk.split('\n').every((line) => /^\s*(--.*)?$/.test(line));
}

/** Run the migration's own backfill statements, in order, on one client, in one transaction. */
async function runBackfill(): Promise<void> {
	const statements = backfillSection(migrationText())
		.split('--> statement-breakpoint')
		.filter((chunk) => !onlyCommentsOrWhitespace(chunk));
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		try {
			for (const statement of statements) await client.query(statement);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		}
	} finally {
		client.release();
	}
}

/** Run SQL and return the PostgreSQL error, failing if it unexpectedly succeeded. */
async function expectError(sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
	try {
		await pool.query(sql, params);
	} catch (error) {
		return error as pg.DatabaseError;
	}
	throw new Error(`Expected this statement to be rejected, but it succeeded:\n${sql}`);
}

// ── Raw-SQL helpers, copied from constraints.integration.test.ts (another test
// file is not a module). ─────────────────────────────────────────────────────

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

type MakeSessionOverrides = {
	openingCashMinor?: number | bigint;
	status?: 'open' | 'closed';
	closedAt?: Date | null;
	closedByUserId?: string | null;
	closedFromDeviceId?: string | null;
	countedCashMinor?: number | bigint | null;
	expectedCashMinor?: number | bigint | null;
	differenceMinor?: number | bigint | null;
};

async function makeSession(
	restaurantId: string,
	deviceId: string,
	userId: string,
	overrides: MakeSessionOverrides = {}
): Promise<string> {
	const openingCashMinor = overrides.openingCashMinor ?? 50000;
	const status = overrides.status ?? 'open';
	const closedAt = overrides.closedAt ?? null;
	const closedByUserId = overrides.closedByUserId ?? null;
	const closedFromDeviceId = overrides.closedFromDeviceId ?? null;
	const countedCashMinor = overrides.countedCashMinor ?? null;
	const expectedCashMinor = overrides.expectedCashMinor ?? null;
	const differenceMinor = overrides.differenceMinor ?? null;

	const { rows } = await pool.query<{ id: string }>(
		`insert into pos_sessions (
			restaurant_id, device_id, opened_by_user_id, opened_at, business_date,
			opening_cash_minor, status, closed_at, closed_by_user_id, closed_from_device_id,
			counted_cash_minor, expected_cash_minor, difference_minor
		) values ($1, $2, $3, now(), '2026-09-28', $4, $5, $6, $7, $8, $9, $10, $11)
		returning id`,
		[
			restaurantId,
			deviceId,
			userId,
			openingCashMinor,
			status,
			closedAt,
			closedByUserId,
			closedFromDeviceId,
			countedCashMinor,
			expectedCashMinor,
			differenceMinor
		]
	);
	return rows[0].id;
}

type MakeOrderOverrides = {
	orderType?: 'dine_in' | 'takeaway';
	tableLabel?: string | null;
	status?: 'open' | 'billed' | 'paid' | 'voided' | 'refunded';
	taxMode?: 'exclusive' | 'inclusive';
	currencyCode?: string;
	subtotalMinor?: number | bigint;
	discountMinor?: number | bigint;
	taxMinor?: number | bigint;
	totalMinor?: number | bigint;
};

async function makeOrder(
	restaurantId: string,
	sessionId: string,
	deviceId: string,
	userId: string,
	overrides: MakeOrderOverrides = {}
): Promise<string> {
	const orderType = overrides.orderType ?? 'takeaway';
	const tableLabel = overrides.tableLabel ?? null;
	const status = overrides.status ?? 'paid';
	const taxMode = overrides.taxMode ?? 'exclusive';
	const currencyCode = overrides.currencyCode ?? 'USD';
	const subtotal = overrides.subtotalMinor ?? 1000;
	const discount = overrides.discountMinor ?? 0;
	const tax = overrides.taxMinor ?? 100;
	const total = overrides.totalMinor ?? 1100;

	const { rows } = await pool.query<{ id: string }>(
		`insert into orders (
			restaurant_id, pos_session_id, device_id, employee_user_id, order_type, table_label,
			status, tax_mode, currency_code, menu_version, subtotal_minor, discount_minor,
			tax_minor, total_minor, opened_at, paid_at
		) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13, now(), now())
		returning id`,
		[
			restaurantId,
			sessionId,
			deviceId,
			userId,
			orderType,
			tableLabel,
			status,
			taxMode,
			currencyCode,
			subtotal,
			discount,
			tax,
			total
		]
	);
	return rows[0].id;
}

async function makeLine(
	restaurantId: string,
	orderId: string,
	menuItemId: string,
	overrides: {
		lineNo?: number;
		quantity?: number;
		unitPriceMinor?: number | bigint;
		taxRateBp?: number;
		status?: 'new' | 'sent' | 'voided';
		discountMinor?: number | bigint;
	} = {}
): Promise<string> {
	const lineNo = overrides.lineNo ?? 1;
	const quantity = overrides.quantity ?? 1;
	const unitPriceMinor = overrides.unitPriceMinor ?? 850;
	const taxRateBp = overrides.taxRateBp ?? 825;
	const status = overrides.status ?? 'new';
	const discountMinor = overrides.discountMinor ?? 0;

	const { rows } = await pool.query<{ id: string }>(
		`insert into order_lines (
			restaurant_id, order_id, line_no, menu_item_id, item_name, quantity,
			unit_price_minor, tax_rate_bp, discount_minor, status
		) values ($1, $2, $3, $4, 'Tea', $5, $6, $7, $8, $9)
		returning id`,
		[
			restaurantId,
			orderId,
			lineNo,
			menuItemId,
			quantity,
			unitPriceMinor,
			taxRateBp,
			discountMinor,
			status
		]
	);
	return rows[0].id;
}

async function makePayment(
	restaurantId: string,
	orderId: string,
	method: 'cash' | 'card' | 'mobile' = 'cash',
	amount: number | bigint = 1100,
	tendered: number | bigint | null = 2000,
	change: number | bigint | null = 900
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into payments (
			restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor, paid_at
		) values ($1, $2, $3, $4, $5, $6, now()) returning id`,
		[restaurantId, orderId, method, amount, tendered, change]
	);
	return rows[0].id;
}

async function makeInvoice(
	restaurantId: string,
	orderId: string,
	deviceId: string,
	seq = 1,
	number = 'POS1-000001'
): Promise<string> {
	const { rows } = await pool.query<{ id: string }>(
		`insert into invoices (
			restaurant_id, order_id, device_id, invoice_seq, invoice_number, total_minor, issued_at
		) values ($1, $2, $3, $4, $5, 1100, now()) returning id`,
		[restaurantId, orderId, deviceId, seq, number]
	);
	return rows[0].id;
}

describe('0017 backfill carries every existing answer and invents none (settings-tax-payments-receipt T-07)', () => {
	// T-33 converts this describe in the same commit as migration 0018: it seeds and
	// reads tax_rate_bp, accepts_card, accepts_mobile and receipt_footer, which 0018
	// drops, so T-33 re-adds those columns inside one rolled-back transaction on a
	// single client and runs runBackfill on that client. The trigger and static
	// describes stay unchanged.

	type LegacySettings = {
		taxMode: 'exclusive' | 'inclusive' | null;
		taxRateBp: number | null;
		currencyCode: string | null;
		acceptsCard: boolean | null;
		acceptsMobile: boolean | null;
		receiptFooter: string | null;
	};

	/** A settings row shaped like one written before this plan: only the legacy columns. */
	async function makeLegacySettings(restaurantId: string, legacy: LegacySettings): Promise<void> {
		await pool.query(
			`insert into restaurant_settings (
				restaurant_id, time_zone, tax_mode, tax_rate_bp, currency_code,
				accepts_card, accepts_mobile, receipt_footer
			) values ($1, 'UTC', $2, $3, $4, $5, $6, $7)`,
			[
				restaurantId,
				legacy.taxMode,
				legacy.taxRateBp,
				legacy.currencyCode,
				legacy.acceptsCard,
				legacy.acceptsMobile,
				legacy.receiptFooter
			]
		);
	}

	/** A menu item shaped like one written before this plan: a raw rate, no rate id. */
	async function makeLegacyItem(
		restaurantId: string,
		name: string,
		taxRateBp: number | null,
		{ archived = false }: { archived?: boolean } = {}
	): Promise<string> {
		const { rows } = await pool.query<{ id: string }>(
			`insert into menu_items (restaurant_id, category_id, name, price_minor, tax_rate_bp, archived_at)
			 values ($1, null, $2, 500, $3, $4) returning id`,
			[restaurantId, name, taxRateBp, archived ? new Date() : null]
		);
		return rows[0].id;
	}

	type Legacy = {
		a: string;
		b: string;
		c: string;
		items: {
			burger: string;
			tea: string;
			juice: string;
			oldJuice: string;
			water: string;
			soda: string;
		};
		teaLine: string;
		payment: string;
	};

	/** Restaurants A, B and C as they stood before this plan, with one paid sale in A. */
	async function seedLegacy(): Promise<Legacy> {
		const a = await makeRestaurant('Legacy A');
		await makeLegacySettings(a, {
			taxMode: 'exclusive',
			taxRateBp: 825,
			currencyCode: 'USD',
			acceptsCard: true,
			acceptsMobile: false,
			receiptFooter: 'Thanks for visiting'
		});
		const burger = await makeLegacyItem(a, 'Burger', null);
		const tea = await makeLegacyItem(a, 'Tea', 825);
		const juice = await makeLegacyItem(a, 'Juice', 500);
		const oldJuice = await makeLegacyItem(a, 'Old juice', 500, { archived: true });
		const water = await makeLegacyItem(a, 'Water', 0);

		const owner = await makeOwner(a, 'owner-a@example.com');
		const device = await makeDevice(a, owner);
		const session = await makeSession(a, device, owner);
		const order = await makeOrder(a, session, device, owner);
		const teaLine = await makeLine(a, order, tea, { taxRateBp: 825 });
		const payment = await makePayment(a, order, 'cash', 1100, 2000, 900);
		await makeInvoice(a, order, device, 1, 'POS1-000001');

		const b = await makeRestaurant('Legacy B');
		await makeLegacySettings(b, {
			taxMode: null,
			taxRateBp: null,
			currencyCode: null,
			acceptsCard: null,
			acceptsMobile: null,
			receiptFooter: null
		});

		const c = await makeRestaurant('Legacy C');
		await makeLegacySettings(c, {
			taxMode: null,
			taxRateBp: null,
			currencyCode: null,
			acceptsCard: false,
			acceptsMobile: true,
			receiptFooter: null
		});
		const soda = await makeLegacyItem(c, 'Soda', 700);

		return {
			a,
			b,
			c,
			items: { burger, tea, juice, oldJuice, water, soda },
			teaLine,
			payment
		};
	}

	const POSTED_TABLES = ['orders', 'order_lines', 'payments', 'invoices'] as const;

	/** Every posted row of the restaurant, as PostgreSQL's own text form of the whole row. */
	async function postedRows(restaurantId: string): Promise<Record<string, string[]>> {
		const snapshot: Record<string, string[]> = {};
		for (const table of POSTED_TABLES) {
			const { rows } = await pool.query<{ row: string }>(
				`select t::text as row from ${table} t where t.restaurant_id = $1 order by t.id`,
				[restaurantId]
			);
			snapshot[table] = rows.map((r) => r.row);
		}
		return snapshot;
	}

	async function versionAndStamp(
		restaurantId: string
	): Promise<{ menu_version: number; updated_at: string }> {
		const { rows } = await pool.query<{ menu_version: number; updated_at: string }>(
			`select menu_version, updated_at::text as updated_at
			 from restaurant_settings where restaurant_id = $1`,
			[restaurantId]
		);
		return rows[0];
	}

	async function legacyColumns(restaurantId: string): Promise<Record<string, unknown>> {
		const { rows } = await pool.query(
			`select tax_mode, tax_rate_bp, currency_code, accepts_card, accepts_mobile, receipt_footer
			 from restaurant_settings where restaurant_id = $1`,
			[restaurantId]
		);
		return rows[0];
	}

	async function ratesOf(
		restaurantId: string
	): Promise<
		{ id: string; name: string; rate_bp: number; sort_order: number; archived_at: Date | null }[]
	> {
		const { rows } = await pool.query(
			`select id, name, rate_bp, sort_order, archived_at
			 from tax_rates where restaurant_id = $1 order by sort_order, name`,
			[restaurantId]
		);
		return rows;
	}

	async function defaultRateOf(restaurantId: string): Promise<string | null> {
		const { rows } = await pool.query<{ default_tax_rate_id: string | null }>(
			'select default_tax_rate_id from restaurant_settings where restaurant_id = $1',
			[restaurantId]
		);
		return rows[0].default_tax_rate_id;
	}

	async function itemRateId(itemId: string): Promise<string | null> {
		const { rows } = await pool.query<{ tax_rate_id: string | null }>(
			'select tax_rate_id from menu_items where id = $1',
			[itemId]
		);
		return rows[0].tax_rate_id;
	}

	/** Every row the backfill writes, whole, for the idempotence comparison. */
	async function catalogueRows(): Promise<Record<string, string[]>> {
		const queries = {
			tax_rates: 'select t::text as row from tax_rates t order by t.restaurant_id, t.id',
			payment_methods:
				'select t::text as row from payment_methods t order by t.restaurant_id, t.id',
			receipt_lines:
				'select t::text as row from receipt_lines t order by t.restaurant_id, t.section, t.position',
			menu_items: 'select t::text as row from menu_items t order by t.restaurant_id, t.id'
		};
		const snapshot: Record<string, string[]> = {};
		for (const [table, sql] of Object.entries(queries)) {
			const { rows } = await pool.query<{ row: string }>(sql);
			snapshot[table] = rows.map((r) => r.row);
		}
		return snapshot;
	}

	it('A: "Tax" becomes the default rate, and each distinct item rate becomes its own named rate', async () => {
		const legacy = await seedLegacy();
		await runBackfill();

		const rates = await ratesOf(legacy.a);
		expect(rates.map(({ name, rate_bp, sort_order }) => ({ name, rate_bp, sort_order }))).toEqual([
			{ name: 'Tax', rate_bp: 825, sort_order: 0 },
			{ name: 'Tax 0.00%', rate_bp: 0, sort_order: 1 },
			{ name: 'Tax 5.00%', rate_bp: 500, sort_order: 2 }
		]);
		expect(rates.every((rate) => rate.archived_at === null)).toBe(true);
		expect(await defaultRateOf(legacy.a)).toBe(rates[0].id);
	});

	it('A: items point at their rate by id; an item with no rate keeps NULL; tax_rate_bp is unchanged', async () => {
		const legacy = await seedLegacy();
		const itemsBefore = await pool.query(
			`select id, tax_rate_bp, updated_at::text as updated_at
			 from menu_items order by id`
		);
		await runBackfill();

		const byName = Object.fromEntries(
			(await ratesOf(legacy.a)).map((rate) => [rate.name, rate.id])
		);
		expect(await itemRateId(legacy.items.burger)).toBeNull();
		expect(await itemRateId(legacy.items.tea)).toBe(byName['Tax']);
		expect(await itemRateId(legacy.items.juice)).toBe(byName['Tax 5.00%']);
		expect(await itemRateId(legacy.items.oldJuice)).toBe(byName['Tax 5.00%']);
		expect(await itemRateId(legacy.items.water)).toBe(byName['Tax 0.00%']);

		const itemsAfter = await pool.query(
			`select id, tax_rate_bp, updated_at::text as updated_at
			 from menu_items order by id`
		);
		expect(itemsAfter.rows).toEqual(itemsBefore.rows);
	});

	it("MANDATORY (Risk 5 — no rate invented): a restaurant with no rate gets no rate and no default, and settingsComplete still reports 'tax rate'", async () => {
		const legacy = await seedLegacy();
		await runBackfill();

		expect(await ratesOf(legacy.b)).toEqual([]);
		expect(await defaultRateOf(legacy.b)).toBeNull();
		expect((await settingsComplete(testDb(), legacy.b)).missing).toContain('tax rate');
		expect((await settingsComplete(testDb(), legacy.a)).missing).not.toContain('tax rate');
	});

	it('C: an item rate with no restaurant rate becomes its own rate, and there is still no default', async () => {
		const legacy = await seedLegacy();
		await runBackfill();

		const rates = await ratesOf(legacy.c);
		expect(rates.map(({ name, rate_bp, sort_order }) => ({ name, rate_bp, sort_order }))).toEqual([
			{ name: 'Tax 7.00%', rate_bp: 700, sort_order: 1 }
		]);
		expect(await defaultRateOf(legacy.c)).toBeNull();
		expect(await itemRateId(legacy.items.soda)).toBe(rates[0].id);
	});

	it('payment methods: Cash for every restaurant; accepts_card / accepts_mobile = true becomes one enabled method of that kind', async () => {
		const legacy = await seedLegacy();
		await runBackfill();

		const methodsOf = async (restaurantId: string) =>
			(
				await pool.query(
					`select name, kind, enabled, merchant_number
					 from payment_methods where restaurant_id = $1 order by sort_order`,
					[restaurantId]
				)
			).rows;
		expect(await methodsOf(legacy.a)).toEqual([
			{ name: 'Cash', kind: 'cash', enabled: true, merchant_number: null },
			{ name: 'Card', kind: 'card', enabled: true, merchant_number: null }
		]);
		expect(await methodsOf(legacy.b)).toEqual([
			{ name: 'Cash', kind: 'cash', enabled: true, merchant_number: null }
		]);
		expect(await methodsOf(legacy.c)).toEqual([
			{ name: 'Cash', kind: 'cash', enabled: true, merchant_number: null },
			{ name: 'Mobile money', kind: 'mobile', enabled: true, merchant_number: null }
		]);
	});

	it('receipt lines: the footer becomes footer line 1; the nine receipt switches stay on', async () => {
		const legacy = await seedLegacy();
		await runBackfill();

		const linesOf = async (restaurantId: string) =>
			(
				await pool.query(
					`select section, position, body
					 from receipt_lines where restaurant_id = $1 order by section, position`,
					[restaurantId]
				)
			).rows;
		expect(await linesOf(legacy.a)).toEqual([
			{ section: 'footer', position: 1, body: 'Thanks for visiting' }
		]);
		expect(await linesOf(legacy.b)).toEqual([]);
		expect(await linesOf(legacy.c)).toEqual([]);

		const { rows } = await pool.query(
			`select receipt_show_cashier, receipt_show_table, receipt_show_business_date,
			        receipt_show_order_type, receipt_show_unit_price, receipt_show_currency_line,
			        receipt_show_device_line, receipt_show_payment_numbers, receipt_tax_breakdown
			 from restaurant_settings where restaurant_id = $1`,
			[legacy.a]
		);
		expect(Object.values(rows[0])).toHaveLength(9);
		expect(Object.values(rows[0]).every((value) => value === true)).toBe(true);
	});

	it('menu_version goes up by exactly 1; updated_at and the legacy settings columns are unchanged', async () => {
		const legacy = await seedLegacy();
		const restaurants = [legacy.a, legacy.b, legacy.c];
		const stampsBefore = await Promise.all(restaurants.map(versionAndStamp));
		const legacyBefore = await Promise.all(restaurants.map(legacyColumns));
		await runBackfill();

		const stampsAfter = await Promise.all(restaurants.map(versionAndStamp));
		stampsAfter.forEach((after, i) => {
			expect(after.menu_version).toBe(stampsBefore[i].menu_version + 1);
			expect(after.updated_at).toBe(stampsBefore[i].updated_at);
		});
		expect(await Promise.all(restaurants.map(legacyColumns))).toEqual(legacyBefore);
	});

	it('MANDATORY (invariant 2 — posted records are permanent; Risk 3): the paid sale is byte-for-byte unchanged', async () => {
		const legacy = await seedLegacy();
		const before = await postedRows(legacy.a);
		// Not vacuous: the sale really is there — one order, one line, one payment, one invoice.
		for (const table of POSTED_TABLES) expect(before[table]).toHaveLength(1);
		await runBackfill();

		expect(await postedRows(legacy.a)).toEqual(before);
		const line = await pool.query(
			'select tax_rate_id, tax_rate_name from order_lines where id = $1',
			[legacy.teaLine]
		);
		expect(line.rows[0]).toEqual({ tax_rate_id: null, tax_rate_name: null });
		const payment = await pool.query(
			'select payment_method_id, payment_method_name from payments where id = $1',
			[legacy.payment]
		);
		expect(payment.rows[0]).toEqual({ payment_method_id: null, payment_method_name: null });
	});

	it('is idempotent: a second run changes nothing but menu_version', async () => {
		const legacy = await seedLegacy();
		const restaurants = [legacy.a, legacy.b, legacy.c];
		const start = await Promise.all(restaurants.map(versionAndStamp));
		await runBackfill();
		const once = await catalogueRows();
		await runBackfill();

		expect(await catalogueRows()).toEqual(once);
		const twice = await Promise.all(restaurants.map(versionAndStamp));
		twice.forEach((after, i) => expect(after.menu_version).toBe(start[i].menu_version + 2));
	});
});

describe('0017 triggers: archive-only catalogues and a fixed payment kind (settings-tax-payments-receipt T-07)', () => {
	async function makeRate(restaurantId: string, name: string): Promise<string> {
		const { rows } = await pool.query<{ id: string }>(
			'insert into tax_rates (restaurant_id, name, rate_bp) values ($1, $2, 500) returning id',
			[restaurantId, name]
		);
		return rows[0].id;
	}

	async function makeMethod(restaurantId: string, name: string, kind: string): Promise<string> {
		const { rows } = await pool.query<{ id: string }>(
			`insert into payment_methods (restaurant_id, name, kind, enabled)
			 values ($1, $2, $3, true) returning id`,
			[restaurantId, name, kind]
		);
		return rows[0].id;
	}

	it('DELETE on tax_rates is refused, referenced or not', async () => {
		const r = await makeRestaurant('Archive-only rates');
		const unreferenced = await makeRate(r, 'Exempt');
		const referenced = await makeRate(r, 'VAT');
		await pool.query(
			`insert into menu_items (restaurant_id, name, price_minor, tax_rate_id)
			 values ($1, 'Tea', 850, $2)`,
			[r, referenced]
		);

		for (const id of [unreferenced, referenced]) {
			const error = await expectError('delete from tax_rates where id = $1', [id]);
			expect(error.code).toBe('P0001');
			expect(error.message).toMatch(/tax_rates rows are archived, never deleted/);
		}
		const { rows } = await pool.query<{ count: number }>(
			'select count(*)::int as count from tax_rates where restaurant_id = $1',
			[r]
		);
		expect(rows[0].count).toBe(2);
	});

	it('DELETE on payment_methods is refused, the Cash row included', async () => {
		const r = await makeRestaurant('Archive-only methods');
		const card = await makeMethod(r, 'Card terminal', 'card');
		const cash = await makeMethod(r, 'Cash', 'cash');

		for (const id of [card, cash]) {
			const error = await expectError('delete from payment_methods where id = $1', [id]);
			expect(error.code).toBe('P0001');
			expect(error.message).toMatch(/payment_methods rows are archived, never deleted/);
		}
		const { rows } = await pool.query<{ count: number }>(
			'select count(*)::int as count from payment_methods where restaurant_id = $1',
			[r]
		);
		expect(rows[0].count).toBe(2);
	});

	it('the kind is fixed; every other column is not', async () => {
		const r = await makeRestaurant('Fixed kind');
		const card = await makeMethod(r, 'Card terminal', 'card');

		const error = await expectError(`update payment_methods set kind = 'mobile' where id = $1`, [
			card
		]);
		expect(error.code).toBe('P0001');
		expect(error.message).toMatch(/payment_methods\.kind is fixed/);

		for (const assignment of [
			'kind = kind',
			`name = 'Visa terminal'`,
			`merchant_number = '123'`,
			'enabled = false',
			'sort_order = 5',
			'archived_at = now()'
		]) {
			const result = await pool.query(`update payment_methods set ${assignment} where id = $1`, [
				card
			]);
			expect(result.rowCount).toBe(1);
		}
		const { rows } = await pool.query<{ kind: string }>(
			'select kind from payment_methods where id = $1',
			[card]
		);
		expect(rows[0].kind).toBe('card');
	});

	it('archiving a tax rate stays an UPDATE', async () => {
		const r = await makeRestaurant('Archive a rate');
		const rate = await makeRate(r, 'VAT');
		const result = await pool.query('update tax_rates set archived_at = now() where id = $1', [
			rate
		]);
		expect(result.rowCount).toBe(1);
	});

	it('the three triggers exist under the planned names', async () => {
		const { rows } = await pool.query<{ tgname: string }>(
			'select tgname from pg_trigger where not tgisinternal and tgname = any($1) order by tgname',
			[['tax_rates_archive_only', 'payment_methods_archive_only', 'payment_methods_kind_immutable']]
		);
		expect(rows.map((row) => row.tgname)).toEqual([
			'payment_methods_archive_only',
			'payment_methods_kind_immutable',
			'tax_rates_archive_only'
		]);
	});
});

describe('0017 never touches a posted table (settings-tax-payments-receipt T-07)', () => {
	/** The migration with every `--` comment removed (the breakpoint lines included). */
	function withoutComments(text: string): string {
		return text
			.split('\n')
			.map((line) => line.replace(/--.*$/, ''))
			.join('\n');
	}

	it('names no sale table, and holds no ALTER TABLE, DROP, DELETE FROM, TRUNCATE or DISABLE TRIGGER', () => {
		const sql = withoutComments(migrationText());
		// Not vacuous: the stripped text still holds the statements.
		expect(sql).toMatch(/CREATE TRIGGER tax_rates_archive_only/);
		expect(sql).toMatch(/INSERT INTO "payment_methods"/);
		// `\bpayments\b` cannot match payment_methods: it needs an s right before the
		// word boundary. DELETE\s+FROM, not a bare DELETE: the triggers' own
		// "BEFORE DELETE ON" must not trip it.
		expect(sql).not.toMatch(/\b(orders|order_lines|payments|invoices)\b/i);
		expect(sql).not.toMatch(/\b(ALTER\s+TABLE|DROP|DELETE\s+FROM|TRUNCATE|DISABLE\s+TRIGGER)\b/i);
	});

	it('holds each BACKFILL marker line exactly once, with no trigger or function between them', () => {
		const text = migrationText();
		const lines = text.split('\n');
		expect(lines.filter((line) => line === BACKFILL_BEGIN)).toHaveLength(1);
		expect(lines.filter((line) => line === BACKFILL_END)).toHaveLength(1);

		const section = backfillSection(text);
		expect(section).not.toMatch(/CREATE\s+TRIGGER/i);
		expect(section).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
	});
});
