import { expect, test, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTaxRate } from '../src/lib/money/tax';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import { startFakePrinter, type FakePrinter } from './fake-printer';
import {
	addItem,
	addPaymentMethod,
	addTaxRate,
	chooseOrderType,
	closeDbRows,
	completeSettings,
	createCashier,
	createMenuItem,
	dbRows,
	enterPin,
	openSession,
	payCash,
	pickEmployee,
	registerDevice,
	registerRestaurant,
	setItemTaxRate,
	storeRows
} from './fixtures';
import {
	agentPairingLink,
	freePort,
	startAgent,
	stopAgent,
	writeAgentConfig
} from './print-agent-harness';

// CONFIGURE, SELL, PRINT — END TO END (tasks/settings-tax-payments-receipt
// T-35; spec 6, 11, 13, 17, 24, 26, 29).
//
// The owner configures on the dashboard everything the till needs — a NAMED
// default rate and a 0% one, two named mobile-money methods with merchant
// numbers, the receipt's lines, switches, heading and logo — and the till sells
// with the REAL print agent spawned as its own process and two fake network
// printers that keep the bytes. One journey proves:
//   - invariant 7: every order line stores its own rate's name and number, and
//     the receipt prints the per-rate breakdown, which adds up to the stored tax
//     (0.80 + 0.00) — MANDATORY (spec 29), in EXCLUSIVE mode only; both tax modes
//     are held by src/lib/money/order-totals.test.ts and src/lib/pos/receipt.test.ts;
//   - invariant 3 (spec 24 "Card / mobile sale"): a named MOBILE method posts
//     Dr 1030 Payment Clearing – Mobile Money for the sale's total, chosen by its
//     KIND, never its name — MANDATORY (spec 29, a posting rule per business event);
//   - invariant 5: the mobile sale prints NOTHING until the server confirms it;
//     offline, every card and mobile key is disabled with the reason in words,
//     and cash still sells, prints and syncs exactly once;
//   - invariant 4: printing is never inside the payment transaction — each sale
//     completes whatever the printer does;
//   - invariant 1 and spec 11: every amount on paper is the sale's stored minor
//     units through the formatter, and nothing but printable ASCII and the
//     agent's own command bytes reaches a printer. The logo reaches the RECEIPT
//     printer only as the agent's own GS v 0 band, never the kitchen printer, and
//     a receipt carries it only after the owner confirmed its test print (the
//     logo confirmation gate, T-24);
//   - spec 26: Sales by payment method names each method.
//
// An internet outage is simulated by aborting the app's /api/ requests, NOT by
// context.setOffline: Playwright's offline emulation cuts loopback too, and the
// agent is a loopback service. The pay screen learns it is offline from
// window's `offline` event — it reads navigator.onLine once, when it mounts — so
// the event is dispatched only after the screen has mounted.

const OWNER = {
	name: 'Maqaayadda Xamar',
	email: 'owner@settings-receipt.test',
	password: 'a strong enough password'
};
const OWNER_PIN = '1234';
const CASHIER = { displayName: 'Sam', pin: '5678' };
const TOKEN = 'decaf000'.repeat(8);
// GS v 0 with m = 0, then xL xH = 48 bytes a row and yL yH = 32 rows: the
// 64 × 32 logo is not scaled (logoTargetSize never upscales, and 64 is a
// multiple of 8), its rows are padded to the 32-column printer's full 384 dots,
// and 32 rows fit in one band.
const RASTER = Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 0x20, 0x00]);
const PULSE = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

let receipt: FakePrinter;
let kitchen: FakePrinter;
let agent: ChildProcess | null = null;
let agentPort = 0;
let configPath = '';
let workDir = '';

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
	// Receipt 32 columns (58 mm), kitchen 48 (80 mm).
	receipt = await startFakePrinter();
	kitchen = await startFakePrinter();
	agentPort = await freePort();
	workDir = mkdtempSync(join(tmpdir(), 'matcami-settings-receipt-e2e-'));
	configPath = writeAgentConfig(workDir, {
		agentPort,
		receiptPort: receipt.port,
		kitchenPort: kitchen.port,
		token: TOKEN
	});
	agent = await startAgent(configPath);
});

test.afterAll(async () => {
	await stopAgent(agent);
	agent = null;
	await receipt?.close();
	await kitchen?.close();
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	await closeDbRows();
	await closeResetPool();
});

/** How many times `needle` occurs in `tape` (non-overlapping). */
function occurrences(tape: Buffer, needle: Buffer): number {
	let n = 0;
	for (let at = tape.indexOf(needle); at !== -1; at = tape.indexOf(needle, at + needle.length)) {
		n += 1;
	}
	return n;
}

async function signInOnTill(tillPage: Page, name: string, pin: string): Promise<void> {
	await tillPage.goto('/pos');
	await pickEmployee(tillPage, name);
	await enterPin(tillPage, pin);
	await expect(tillPage).toHaveURL(/\/pos\/(session|order)$/);
}

async function newSale(tillPage: Page): Promise<void> {
	await tillPage.getByRole('link', { name: 'POS', exact: true }).click();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);
}

/** Open the pay screen and wait until it has mounted and read the bill. */
async function openPay(tillPage: Page): Promise<void> {
	await tillPage.getByRole('link', { name: /^Pay\b/ }).click();
	await expect(tillPage).toHaveURL(/\/pos\/pay$/);
	await expect(tillPage.getByRole('heading', { name: 'Amount due' })).toBeVisible();
}

type PaymentRow = {
	invoice_number: string;
	method: string;
	payment_method_name: string | null;
	amount: string;
};
const PAYMENTS_SQL = `select i.invoice_number, p.method, p.payment_method_name, p.amount_minor::text as amount
	from payments p join invoices i on i.order_id = p.order_id order by i.invoice_number`;

test('configure, sell, print: a named rate, a named method, payment numbers, the breakdown and offline cash', async ({
	page,
	browser
}) => {
	test.setTimeout(600_000);

	// 1. THE OWNER CONFIGURES EVERYTHING. The default rate `Tax` 10% and the
	//    exclusive mode (completeSettings), a 0% rate for Water, two named
	//    mobile-money methods with their merchant numbers.
	await registerRestaurant(page, OWNER);
	await completeSettings(page, {
		taxMode: 'exclusive',
		taxRateBp: 1000,
		currency: 'USD',
		idleSeconds: 300
	});
	await addTaxRate(page, { name: 'Exempt', percent: '0', makeDefault: false });
	await createMenuItem(page, { category: null, name: 'Burger', priceMinor: 800n });
	await createMenuItem(page, { category: null, name: 'Water', priceMinor: 100n });
	// The option's label is the rate's name and the money module's formatted rate.
	await setItemTaxRate(page, 'Water', `Exempt ${formatTaxRate(0)}`);
	await addPaymentMethod(page, { name: 'EVC Plus', kind: 'mobile', merchantNumber: '61 234 5678' });
	await addPaymentMethod(page, { name: 'Zaad', kind: 'mobile', merchantNumber: '63 345 6789' });

	// The receipt: a header line, a footer line, the business date OFF, and the
	// heading over the payment numbers.
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'Settings', exact: true })
		.click();
	await expect(page).toHaveURL(/\/settings$/);
	await page
		.getByRole('navigation', { name: 'Settings sections' })
		.getByRole('link', { name: 'Receipt', exact: true })
		.click();
	await expect(page).toHaveURL(/\/settings\/receipt$/);
	await page.getByLabel('Header line 1').fill('Open daily 7-23');
	await page.getByLabel('Footer line 1').fill('Mahadsanid!');
	await page.getByLabel('Print the business date').uncheck();
	await page.getByLabel('Payment numbers heading').fill('PAY BY MOBILE MONEY');
	await page.getByRole('button', { name: 'Save receipt' }).click();
	await expect(page.getByRole('alert')).toContainText('Receipt saved.');

	// The logo: a 64 × 32 PNG drawn in the page — white, with a black bar — given
	// to the picker, which converts it in the browser to 1-bit rows.
	const dataUrl = await page.evaluate(() => {
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 32;
		const g = c.getContext('2d')!;
		g.fillStyle = '#fff';
		g.fillRect(0, 0, 64, 32);
		g.fillStyle = '#000';
		g.fillRect(8, 8, 48, 16);
		return c.toDataURL('image/png');
	});
	const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
	await page
		.getByLabel('Logo image')
		.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer });
	await expect(page.getByText('● Ready to save: 64 × 32 dots.')).toBeVisible();
	await page.getByRole('button', { name: 'Save logo' }).click();
	await expect(page.getByRole('alert')).toContainText('Logo saved.');

	// The live preview, drawn by the till's own formatter.
	await expect(page.getByText('Open daily 7-23')).toBeVisible();
	await expect(page.getByRole('img', { name: 'The logo' })).toBeVisible();
	expect(await dbRows('select width_dots, height_dots, byte_size from receipt_logos')).toEqual([
		{ width_dots: 64, height_dots: 32, byte_size: 256 }
	]);

	// 2. THE TILL. The owner's own PIN, a cashier, and the registered device.
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'Employees', exact: true })
		.click();
	await page.getByRole('link', { name: /The Owner/ }).click();
	await expect(page).toHaveURL(/\/employees\/[0-9a-f-]+$/);
	await page.getByLabel('New PIN').fill(OWNER_PIN);
	await page.getByRole('button', { name: 'Set PIN' }).click();
	await expect(page.getByRole('alert')).toContainText('PIN set');
	await createCashier(page, CASHIER);

	const till = await browser.newContext();
	const tillPage = await till.newPage();
	await registerDevice(tillPage, OWNER);

	// The pairing link, opened with nobody signed in: the owner signs in and the
	// till pairs itself.
	await tillPage.goto(agentPairingLink(configPath));
	await expect(tillPage).toHaveURL(/\/pos$/);
	await expect(tillPage.getByTestId('pairing-waiting')).toBeVisible();
	await pickEmployee(tillPage, 'The Owner');
	await enterPin(tillPage, OWNER_PIN);
	await expect(tillPage).toHaveURL(/\/pos\/printer$/);
	await expect(tillPage.getByTestId('paired-agent')).toContainText(`http://127.0.0.1:${agentPort}`);
	const chip = tillPage.getByTestId('printer-chip');
	const results = tillPage.getByTestId('test-results');

	// The logo's bytes are cached on the till (IndexedDB), so printing never
	// touches the network.
	await expect
		.poll(
			async () =>
				(await storeRows<{ key: string }>(tillPage, 'settings')).some(
					(r) => r.key === 'receiptLogo'
				),
			{ timeout: 15_000 }
		)
		.toBe(true);

	// THE LOGO CONFIRMATION GATE: until the owner has watched a test page print the
	// logo, the chip says so and receipts carry none.
	await expect(chip).toContainText('Test-print the logo before receipts use it', {
		timeout: 35_000
	});
	await tillPage.getByTestId('test-print').click();
	await expect(results).toContainText('● Test page sent to the receipt printer', {
		timeout: 15_000
	});
	await expect(results).toContainText(
		'● The logo was sent — it should print at the top of the receipt test page.'
	);
	await receipt.waitFor('TEST PRINT');
	await kitchen.waitFor('TEST PRINT');
	expect(receipt.count('TEST PRINT')).toBe(1);
	expect(receipt.count(RASTER)).toBe(1);
	// The kitchen printer's test page never carries the logo.
	expect(kitchen.count(RASTER)).toBe(0);
	await tillPage.getByRole('button', { name: 'The logo printed correctly' }).click();
	await expect(results).toContainText('● Receipts will print the logo');
	await expect(chip).toContainText('Printer ready');

	// 3. SALE 1, CASH: Burger at the default 10%, Water at Exempt 0%.
	await signInOnTill(tillPage, CASHIER.displayName, CASHIER.pin);
	await openSession(tillPage, 5000n);
	await chooseOrderType(tillPage, 'Takeaway');
	await addItem(tillPage, 'Burger');
	await addItem(tillPage, 'Water');
	const before1 = receipt.bytes().length;
	await payCash(tillPage, 1000n);
	await receipt.waitFor('Mahadsanid!', { from: before1 });
	await receipt.waitFor(PULSE, { from: before1 });
	const tape1 = receipt.bytes().subarray(before1);
	// The agent writes ALIGN, BOLD and SIZE before every line's text, so the byte
	// after each LF is ESC, never the line's first letter: a line is matched by
	// its END (the amount, then LF), never anchored with ^.
	const text1 = tape1.toString('latin1');
	expect(occurrences(tape1, RASTER), 'sale 1: the confirmed logo, once').toBe(1);
	for (const expected of [
		'Open daily 7-23',
		'9.80',
		'CASH',
		'CHANGE',
		'0.20',
		'PAY BY MOBILE MONEY',
		'EVC Plus',
		'61 234 5678',
		'Zaad',
		'63 345 6789',
		'Mahadsanid!'
	]) {
		expect(text1.includes(expected), `sale 1 receipt: ${expected}`).toBe(true);
	}
	// MANDATORY (spec 29): the per-rate breakdown on paper sums to the stored tax,
	// 0.80 + 0.00 (exclusive mode).
	expect(text1).toMatch(/Tax 10\.00% +0\.80\n/);
	expect(text1).toMatch(/Exempt 0\.00% +0\.00\n/);
	// The business date is switched off; no UTF-8 minus (E2 88 92) and no NBSP
	// (C2 A0) reached the printer.
	expect(text1.includes('Business date')).toBe(false);
	expect(tape1.includes(0xe2)).toBe(false);
	expect(tape1.includes(0xc2)).toBe(false);
	expect(receipt.count(PULSE)).toBe(1);
	// Synced before the next sale cuts the sync route.
	await expect(tillPage.getByText('0 unsynced')).toBeVisible();

	// 4. SALE 2, EVC PLUS — FAIL CLOSED: nothing prints until the server confirms it.
	await tillPage.route('**/api/pos/sync', (route) => route.abort());
	await newSale(tillPage);
	await addItem(tillPage, 'Burger');
	await openPay(tillPage);
	await tillPage
		.getByRole('radiogroup', { name: 'Tender' })
		.getByRole('radio', { name: /^EVC Plus/ })
		.click();
	// The selected method's merchant number, on the pay screen (Settings 6).
	await expect(tillPage.getByTestId('merchant-number')).toBeVisible();
	await expect(tillPage.getByTestId('merchant-number')).toHaveText('61 234 5678');
	const before2 = receipt.bytes().length;
	const kitchenBefore2 = kitchen.bytes().length;
	await tillPage.getByRole('button', { name: /^Pay · EVC Plus/ }).click();
	await expect(tillPage.getByText('◐ Waiting for the server to confirm…')).toBeVisible();
	await tillPage.waitForTimeout(3000);
	expect(receipt.bytes().length).toBe(before2);
	expect(kitchen.bytes().length).toBe(kitchenBefore2);

	await tillPage.unroute('**/api/pos/sync');
	await tillPage.evaluate(() => window.dispatchEvent(new Event('online')));
	await receipt.waitFor('POS1-000002', { from: before2, timeoutMs: 20_000 });
	await receipt.waitFor('EVC PLUS', { from: before2 });
	await receipt.waitFor('8.80', { from: before2 });
	await receipt.waitFor('Mahadsanid!', { from: before2 });
	const tape2 = receipt.bytes().subarray(before2);
	expect(tape2.includes(Buffer.from('CHANGE', 'latin1'))).toBe(false);
	// A mobile sale never opens the drawer.
	expect(receipt.count(PULSE)).toBe(1);
	await expect(tillPage.getByText('0 unsynced')).toBeVisible();

	expect(await dbRows<PaymentRow>(PAYMENTS_SQL)).toEqual([
		{ invoice_number: 'POS1-000001', method: 'cash', payment_method_name: 'Cash', amount: '980' },
		{
			invoice_number: 'POS1-000002',
			method: 'mobile',
			payment_method_name: 'EVC Plus',
			amount: '880'
		}
	]);
	// MANDATORY (spec 29 — posting rule per business event): the named mobile
	// method posts Dr 1030 Payment Clearing – Mobile Money for the sale's total.
	expect(
		await dbRows<{ code: string; debit: string }>(
			`select a.code, l.debit_minor::text as debit from journal_entry_lines l
				join journal_entries e on e.id = l.entry_id
				join accounts a on a.id = l.account_id
				where e.event = 'mobile_sale' and l.debit_minor > 0`
		)
	).toEqual([{ code: '1030', debit: '880' }]);
	// Invariant 7: each line stores the rate it was taxed at, by name and number.
	expect(
		await dbRows<{
			invoice_number: string;
			item_name: string;
			tax_rate_bp: number;
			tax_rate_name: string | null;
		}>(
			`select i.invoice_number, l.item_name, l.tax_rate_bp, l.tax_rate_name from order_lines l
				join invoices i on i.order_id = l.order_id order by i.invoice_number, l.line_no`
		)
	).toEqual([
		{ invoice_number: 'POS1-000001', item_name: 'Burger', tax_rate_bp: 1000, tax_rate_name: 'Tax' },
		{ invoice_number: 'POS1-000001', item_name: 'Water', tax_rate_bp: 0, tax_rate_name: 'Exempt' },
		{ invoice_number: 'POS1-000002', item_name: 'Burger', tax_rate_bp: 1000, tax_rate_name: 'Tax' }
	]);

	// 5. SALE 3, OFFLINE CASH: the internet goes down; the agent is local.
	await tillPage.route('**/api/**', (route) => route.abort());
	await newSale(tillPage);
	await addItem(tillPage, 'Water');
	await openPay(tillPage);
	await tillPage.evaluate(() => window.dispatchEvent(new Event('offline')));
	const tenders = tillPage.getByRole('radiogroup', { name: 'Tender' });
	await expect(tenders.getByRole('radio', { name: /^EVC Plus/ })).toBeDisabled();
	await expect(tenders.getByRole('radio', { name: /^Zaad/ })).toBeDisabled();
	// The reason, in words, on each disabled key.
	await expect(tenders.getByText('◆ Cash only while offline')).toHaveCount(2);
	await expect(tenders.getByText('◆ Cash only while offline').first()).toBeVisible();
	const cash = tenders.getByRole('radio', { name: 'Cash', exact: true });
	await expect(cash).toBeEnabled();
	// Cash with nothing keyed pays the exact amount.
	await cash.click();
	await expect(tillPage.getByTestId('exact-hint')).toBeVisible();
	const before3 = receipt.bytes().length;
	await tillPage.getByRole('button', { name: /^Pay · Cash/ }).click();
	await expect(tillPage.getByText('● Paid', { exact: true })).toBeVisible();
	await receipt.waitFor('POS1-000003', { from: before3 });
	await receipt.waitFor('Exempt 0.00%', { from: before3 });
	await receipt.waitFor(RASTER, { from: before3 });
	await receipt.waitFor(PULSE, { from: before3 });
	expect(receipt.count(PULSE)).toBe(2);
	await expect(tillPage.getByText('1 unsynced')).toBeVisible();

	await tillPage.unroute('**/api/**');
	await tillPage.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(tillPage.getByText('0 unsynced')).toBeVisible({ timeout: 20_000 });
	const payments = await dbRows<PaymentRow>(PAYMENTS_SQL);
	expect(payments).toHaveLength(3);
	expect(payments[2]).toEqual({
		invoice_number: 'POS1-000003',
		method: 'cash',
		payment_method_name: 'Cash',
		amount: '100'
	});

	// 6. SALES BY PAYMENT METHOD, on the owner's dashboard (spec 26).
	const [session] = await dbRows<{ d: string }>(
		'select business_date::text as d from pos_sessions'
	);
	await page
		.getByRole('navigation', { name: 'Dashboard sections' })
		.getByRole('link', { name: 'Reports', exact: true })
		.click();
	await expect(page).toHaveURL(/\/reports/);
	await page.goto('/reports?date=' + session!.d);
	const row = (card: string, name: string) =>
		page
			.locator('section, div')
			.filter({ has: page.getByRole('heading', { name: card, exact: true }) })
			.last()
			.getByRole('row', { name: new RegExp(`^${name}\\b`) });
	await expect(row('By payment method', 'Cash')).toContainText('10.80');
	await expect(row('By payment method', 'EVC Plus')).toContainText('8.80');

	await till.close();
});
