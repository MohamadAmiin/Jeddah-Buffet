import { expect, test } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import {
	addItem,
	chooseOrderType,
	closeDbRows,
	closeSession,
	completeSettings,
	createCashier,
	createCategory,
	createMenuItem,
	dbRows,
	enterPin,
	openSession,
	payCash,
	pickEmployee,
	registerDevice,
	registerRestaurant,
	signIn,
	storeRows
} from './fixtures';

// A FULL SHIFT, ONLINE AND OFFLINE, SYNCING EXACTLY ONCE (spec 6, 10, 13, 24, 26).
//
// One cashier opens a session, rings up a sale online and one offline, reloads
// while offline, reconnects, and the offline sale lands on the server once.
// MANDATORY (spec 29 — offline sync: retries never create duplicates): the same
// envelope re-POSTed, a reload-triggered flush and an online-event flush leave
// every posted table exactly as it was. Then two session closes (balanced and
// short) and the dashboard report over the same business date.
//
// Every database assertion follows a wait for `0 unsynced`; nothing waits on a
// timer. Money literals are strings because pg returns bigint and sum() that way.

const OWNER = {
	name: 'The Sale Cafe',
	email: 'owner@sale.test',
	password: 'a strong enough password'
};

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeDbRows();
	await closeResetPool();
});

type Count = { n: string };
const count = async (sql: string) => (await dbRows<Count>(sql))[0].n;

async function snapshot() {
	return {
		orders: await count('select count(*)::text as n from orders'),
		invoices: await count('select count(*)::text as n from invoices'),
		payments: await count('select count(*)::text as n from payments'),
		entries: await count('select count(*)::text as n from journal_entries'),
		lines: await count('select count(*)::text as n from journal_entry_lines'),
		saleOps: await count(
			"select count(*)::text as n from pos_sync_ops where kind = 'sale.complete'"
		),
		recorded: await count("select count(*)::text as n from audit_log where event = 'sale.recorded'")
	};
}

test('a full shift: online sale, offline sale, one sync each, two closes, the report', async ({
	page,
	browser
}) => {
	test.setTimeout(300_000);

	// 1–5. The restaurant, its settings, a menu and a cashier.
	await registerRestaurant(page, OWNER);
	await completeSettings(page, {
		taxMode: 'exclusive',
		taxRateBp: 1000,
		currency: 'USD',
		idleSeconds: 120
	});
	await createCategory(page, 'Counter');
	await createMenuItem(page, { category: 'Counter', name: 'Burger', priceMinor: 800n });
	await createMenuItem(page, { category: 'Counter', name: 'Drink', priceMinor: 200n });
	await createCashier(page, { displayName: 'The Cashier', pin: '4321' });

	const till = await browser.newContext();
	const tillPage = await till.newPage();
	await signIn(tillPage, OWNER);
	await registerDevice(tillPage, OWNER);
	await tillPage.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	const status = tillPage.getByRole('status', { name: 'Connection and sync' });

	// 6. Sign in: no session yet, so the PIN lands on /pos/session.
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByTestId('till-employee')).toContainText('The Cashier · Cashier');
	await expect(tillPage.getByRole('banner')).toContainText('○ No session');
	await expect(tillPage.getByText(/Business date: \d{4}-\d{2}-\d{2}/)).toBeVisible();

	// 7. Open with a 500.00 float; the chip shows the SERVER's business date.
	await openSession(tillPage, 50000n);
	await expect(status).toContainText('0 unsynced');
	// The till bar's session key names the business date (docs/redesign Phase 1).
	const sessionKey = tillPage.getByRole('link', { name: /^Session · business date \d{4}-/ });
	await expect(sessionKey).toBeVisible();
	const businessDate = /business date (\d{4}-\d{2}-\d{2})/.exec(
		(await sessionKey.getAttribute('aria-label'))!
	)![1];
	const sessions = await dbRows<{
		status: string;
		opening_cash_minor: string;
		business_date: string;
	}>(
		'select status, opening_cash_minor::text, business_date::text as business_date from pos_sessions'
	);
	expect(sessions).toEqual([
		{ status: 'open', opening_cash_minor: '50000', business_date: businessDate }
	]);

	// 8. The first sale, online: Burger + Drink, takeaway, 20.00 tendered.
	await addItem(tillPage, 'Burger');
	await addItem(tillPage, 'Drink');
	const check = tillPage.getByRole('table');
	await expect(check).toContainText('@ 8.00 · tax 10.00%');
	await expect(check).toContainText('@ 2.00 · tax 10.00%');
	const totals = tillPage.locator('#check-h').locator('xpath=ancestor::section[1]');
	await expect(totals).toContainText(/Subtotal\s*10\.00/);
	await expect(totals).toContainText(/Tax\s*1\.00/);
	await expect(totals).toContainText(/Total\s*11\.00/);
	await chooseOrderType(tillPage, 'Takeaway');
	await payCash(tillPage, 2000n);
	await expect(tillPage.getByText('Invoice POS1-000001')).toBeVisible();
	await expect(tillPage.getByText(/\b9\.00/)).toBeVisible();
	await expect(status).toContainText('0 unsynced');
	await tillPage.getByRole('link', { name: 'New sale' }).click();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);
	await expect(totals).toContainText(/Total\s*0\.00/);

	// 9. The database after sale 1.
	const [order1] = await dbRows<Record<string, string | null>>(
		`select id, status, order_type, table_label, tax_mode, currency_code, subtotal_minor::text,
			discount_minor::text, tax_minor::text, total_minor::text from orders`
	);
	expect(order1).toMatchObject({
		status: 'paid',
		order_type: 'takeaway',
		table_label: null,
		tax_mode: 'exclusive',
		currency_code: 'USD',
		subtotal_minor: '1000',
		discount_minor: '0',
		tax_minor: '100',
		total_minor: '1100'
	});
	expect(
		await dbRows(
			`select quantity, unit_price_minor::text, tax_rate_bp, discount_minor::text
			 from order_lines order by line_no`
		)
	).toEqual([
		{ quantity: 1, unit_price_minor: '800', tax_rate_bp: 1000, discount_minor: '0' },
		{ quantity: 1, unit_price_minor: '200', tax_rate_bp: 1000, discount_minor: '0' }
	]);
	expect(
		await dbRows(
			'select method, amount_minor::text, tendered_minor::text, change_minor::text from payments'
		)
	).toEqual([
		{ method: 'cash', amount_minor: '1100', tendered_minor: '2000', change_minor: '900' }
	]);
	const [device] = await dbRows<{ id: string }>(
		"select id from pos_devices where device_code = 'POS1'"
	);
	expect(await dbRows('select invoice_number, device_id from invoices')).toEqual([
		{ invoice_number: 'POS1-000001', device_id: device.id }
	]);
	const [entry1] = await dbRows<{ id: string; event: string; business_date: string }>(
		'select id, event, business_date::text as business_date from journal_entries'
	);
	expect(entry1).toMatchObject({ event: 'cash_sale', business_date: businessDate });
	expect(
		await dbRows(
			`select a.code, l.debit_minor::text as debit, l.credit_minor::text as credit
			 from journal_entry_lines l join accounts a on a.id = l.account_id
			 where l.entry_id = $1 order by l.line_no`,
			[entry1.id]
		)
	).toEqual([
		{ code: '1000', debit: '1100', credit: '0' },
		{ code: '4000', debit: '0', credit: '1000' },
		{ code: '2100', debit: '0', credit: '100' }
	]);
	expect(
		await count(
			"select count(*)::text as n from journal_entries where event = 'cost_of_goods_sold'"
		)
	).toBe('0');
	const saleOps = await dbRows<{
		client_op_id: string;
		status: string;
		invoice_seq: number;
		order_id: string;
	}>(
		"select client_op_id, status, invoice_seq, order_id from pos_sync_ops where kind = 'sale.complete'"
	);
	expect(saleOps).toEqual([
		{
			client_op_id: saleOps[0].client_op_id,
			status: 'accepted',
			invoice_seq: 1,
			order_id: order1.id
		}
	]);
	expect(
		await count("select count(*)::text as n from pos_sync_ops where status <> 'accepted'")
	).toBe('0');
	expect(
		await dbRows("select device_id, client_op_id from audit_log where event = 'sale.recorded'")
	).toEqual([{ device_id: device.id, client_op_id: saleOps[0].client_op_id }]);

	// 10. Offline: the second sale is a recorded fact with the device's own number.
	await till.setOffline(true);
	await expect(status).toContainText('Offline');
	await addItem(tillPage, 'Burger');
	await addItem(tillPage, 'Drink');
	await chooseOrderType(tillPage, 'Dine in', { tableLabel: '4' });
	await payCash(tillPage, 1100n);
	await expect(tillPage.getByText('Invoice POS1-000002')).toBeVisible();
	await expect(tillPage.getByText(/\b0\.00 USD/).last()).toBeVisible();
	await expect(status).toContainText('1 unsynced');
	const queued = await storeRows<{
		clientOpId: string;
		kind: string;
		envelope: { payload: { invoiceNumber: string } };
	}>(tillPage, 'sync_queue');
	const op = queued.find(
		(q) => q.kind === 'sale.complete' && q.envelope.payload.invoiceNumber === 'POS1-000002'
	);
	expect(op).toBeDefined();
	const syncBodies: string[] = [];
	tillPage.on('request', (r) => {
		if (r.method() === 'POST' && r.url().endsWith('/api/pos/sync'))
			syncBodies.push(r.postData() ?? '');
	});
	await tillPage.getByRole('link', { name: 'New sale' }).click();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);

	// 11. Reload while offline: the shell comes from the worker, the cashier from the mirror.
	await tillPage.reload();
	await expect(tillPage.getByRole('heading', { name: 'Who is signing in?' })).toHaveCount(0);
	await expect(status).toContainText('Offline');
	await expect(status).toContainText('1 unsynced');
	await expect(tillPage.getByTestId('till-employee')).toContainText('The Cashier · Cashier');
	await expect(
		tillPage.getByRole('link', { name: `Session · business date ${businessDate} · Close session` })
	).toBeVisible();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);

	// 12. Reconnect: the online event flushes the queue.
	await till.setOffline(false);
	await expect(status).toContainText('0 unsynced');
	expect(
		await dbRows('select status, order_type, table_label from orders order by paid_at')
	).toEqual([
		{ status: 'paid', order_type: 'takeaway', table_label: null },
		{ status: 'paid', order_type: 'dine_in', table_label: '4' }
	]);
	expect(
		await dbRows('select invoice_number, device_id from invoices order by invoice_number')
	).toEqual([
		{ invoice_number: 'POS1-000001', device_id: device.id },
		{ invoice_number: 'POS1-000002', device_id: device.id }
	]);
	expect(
		await dbRows(
			`select e.id from journal_entries e join journal_entry_lines l on l.entry_id = e.id
			 group by e.id having sum(l.debit_minor) <> sum(l.credit_minor)`
		)
	).toEqual([]);
	expect(
		await dbRows(
			"select status, invoice_seq from pos_sync_ops where kind = 'sale.complete' order by invoice_seq"
		)
	).toEqual([
		{ status: 'accepted', invoice_seq: 1 },
		{ status: 'accepted', invoice_seq: 2 }
	]);
	const before = await snapshot();
	expect(before).toEqual({
		orders: '2',
		invoices: '2',
		payments: '2',
		entries: '2',
		lines: '6',
		saleOps: '2',
		recorded: '2'
	});

	// 13. MANDATORY (spec 29): three retries change nothing.
	const body =
		syncBodies.find((b) => b.includes('"POS1-000002"')) ??
		JSON.stringify(
			(queued.find((q) => q.clientOpId === op!.clientOpId) as unknown as { envelope: unknown })
				.envelope
		);
	const replay = await tillPage.evaluate(
		(b) =>
			fetch('/api/pos/sync', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: b
			}).then((r) => r.json()),
		body
	);
	expect(replay.status).toBe('replayed');
	expect(replay.clientOpId).toBe(op!.clientOpId);
	expect(await snapshot()).toEqual(before);

	await tillPage.reload();
	await expect(status).toContainText('0 unsynced');
	expect(await snapshot()).toEqual(before);

	await till.setOffline(true);
	await till.setOffline(false);
	await expect(status).toContainText('0 unsynced');
	expect(await snapshot()).toEqual(before);

	// 14. Close balanced: 500.00 + 11.00 + 11.00 = 522.00 expected, 522.00 counted.
	await closeSession(tillPage, 52200n);
	await expect(tillPage.getByText(/522\.00 USD/).first()).toBeVisible();
	await expect(tillPage.getByText('● Balanced')).toBeVisible();
	await expect(tillPage.getByText('Nothing was posted')).toBeVisible();
	await expect(status).toContainText('0 unsynced');
	expect(
		await dbRows(
			`select status, expected_cash_minor::text, counted_cash_minor::text, difference_minor::text
			 from pos_sessions`
		)
	).toEqual([
		{
			status: 'closed',
			expected_cash_minor: '52200',
			counted_cash_minor: '52200',
			difference_minor: '0'
		}
	]);
	expect(await count('select count(*)::text as n from journal_entries')).toBe('2');
	await tillPage.getByRole('button', { name: 'Done' }).click();
	await expect(tillPage).toHaveURL(/\/pos$/);
	await expect(tillPage.getByTestId('till-employee')).toContainText('Nobody signed in');

	// 15. A second session on the same till and date, closed 1.00 short.
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await openSession(tillPage, 52200n);
	await expect(status).toContainText('0 unsynced');
	await closeSession(tillPage, 52100n);
	await expect(tillPage.getByText(/−1\.00 USD/)).toBeVisible();
	await expect(tillPage.getByText(/✕ Short/)).toBeVisible();
	await expect(
		tillPage.getByText('The server posted the difference to 6800 Cash Over/Short')
	).toBeVisible();
	await expect(status).toContainText('0 unsynced');
	const closed = await dbRows<Record<string, string>>(
		`select status, opening_cash_minor::text, expected_cash_minor::text,
			counted_cash_minor::text, difference_minor::text
		 from pos_sessions order by opened_at`
	);
	expect(closed.map((s) => s.status)).toEqual(['closed', 'closed']);
	expect(closed[1]).toEqual({
		status: 'closed',
		opening_cash_minor: '52200',
		expected_cash_minor: '52200',
		counted_cash_minor: '52100',
		difference_minor: '-100'
	});
	expect(await count('select count(distinct business_date)::text as n from pos_sessions')).toBe(
		'1'
	);
	const [shortage] = await dbRows<{ id: string }>(
		"select id from journal_entries where event = 'cash_shortage_at_close'"
	);
	expect(await count('select count(*)::text as n from journal_entries')).toBe('3');
	expect(
		await dbRows(
			`select a.code, l.debit_minor::text as debit, l.credit_minor::text as credit
			 from journal_entry_lines l join accounts a on a.id = l.account_id
			 where l.entry_id = $1 order by l.line_no`,
			[shortage.id]
		)
	).toEqual([
		{ code: '6800', debit: '100', credit: '0' },
		{ code: '1000', debit: '0', credit: '100' }
	]);
	await tillPage.getByRole('button', { name: 'Done' }).click();

	// 16. The report, on the owner's dashboard.
	await page.goto('/dashboard');
	if (/\/login/.test(page.url())) await signIn(page, OWNER);
	await page.getByRole('link', { name: 'Reports', exact: true }).click();
	await expect(page).toHaveURL(/\/reports/);
	await expect(page.getByRole('heading', { name: `Sales · ${businessDate}` })).toBeVisible();
	await page.goto('/reports?date=' + businessDate);
	const tile = (label: string) =>
		page
			.locator('dt', { hasText: new RegExp(`^${label}$`) })
			.locator('xpath=following-sibling::dd[1]');
	await expect(tile('Gross sales')).toContainText('20.00');
	await expect(tile('Discounts')).toContainText('0.00');
	await expect(tile('Net sales')).toContainText('20.00');
	await expect(tile('Tax')).toContainText('2.00');
	await expect(tile('Takings')).toContainText('22.00');
	const row = (card: string, name: string) =>
		page
			.locator('section, div')
			.filter({ has: page.getByRole('heading', { name: card, exact: true }) })
			.last()
			.getByRole('row', { name: new RegExp(`^${name}\\b`) });
	await expect(row('By tender', 'Cash')).toContainText('22.00');
	await expect(row('By tender', 'Card')).toContainText('0.00');
	await expect(row('By tender', 'Mobile')).toContainText('0.00');
	await expect(row('By order type', 'Dine-in')).toContainText('11.00');
	await expect(row('By order type', 'Takeaway')).toContainText('11.00');
	await expect(row('By employee', 'The Cashier')).toContainText('22.00');
	await expect(row('By item', 'Burger')).toContainText(/2\s*16\.00/);
	await expect(row('By item', 'Drink')).toContainText(/2\s*4\.00/);
	await expect(row('By category', 'Counter')).toContainText(/4\s*20\.00/);
	const sessionsCard = page
		.locator('div')
		.filter({ has: page.getByRole('heading', { name: 'Sessions', exact: true }) })
		.last();
	const items = sessionsCard.getByRole('listitem');
	await expect(items).toHaveCount(2);
	await expect(items.nth(0)).toContainText('500.00');
	await expect(items.nth(0)).toContainText(/Difference\s*0\.00/);
	await expect(items.nth(1)).toContainText(/Counted\s*521\.00/);
	await expect(items.nth(1)).toContainText(/Difference\s*−1\.00/);
	await expect(page.getByRole('alert')).toHaveCount(0);

	await page.getByRole('link', { name: 'Overview', exact: true }).click();
	await expect(page.getByText(/sales await your review/)).toHaveCount(0);

	await till.close();
});
