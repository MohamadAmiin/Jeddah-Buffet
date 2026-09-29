import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import { startFakePrinter, type FakePrinter } from './fake-printer';
import {
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
	registerRestaurant
} from './fixtures';

// RECEIPTS, KITCHEN TICKETS AND THE DRAWER, END TO END — milestone 2 of
// tasks/menu-and-printing (spec 6, 11, 13, 29).
//
// The till in a real browser, the REAL print agent spawned as its own process,
// and two fake network printers that keep the bytes. One journey proves:
//   - invariant 5, fail closed: a card sale prints NOTHING until the server has
//     confirmed it, and its reprint buttons are disabled with the reason;
//   - invariant 4: the sale never waits for printing — it completes with the
//     internet down and with the agent stopped;
//   - invariant 9: the drawer opens for a cash original only — the pulse count
//     never moves on a reprint, a card sale or a catch-up;
//   - spec 11: a reprint is marked COPY, and nothing but printable ASCII and
//     the agent's own control bytes reaches the printer.
//
// An internet outage is simulated by aborting the app's /api/ requests, NOT by
// context.setOffline: Playwright's offline emulation cuts loopback too, and
// the agent is a loopback service.

const OWNER = {
	name: 'Maqaayadda Hodan',
	email: 'owner@printing.test',
	password: 'a strong enough password'
};
const OWNER_PIN = '1234';
const CASHIER = { displayName: 'Sam', pin: '5678' };
const TOKEN = 'c0ffee00'.repeat(8);
const PULSE = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

let receipt: FakePrinter;
let kitchen: FakePrinter;
let agent: ChildProcess | null = null;
let agentPort = 0;
let configPath = '';
let workDir = '';

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

/** Spawn the real agent and resolve once it says it is listening. */
function startAgent(): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			['print-agent/src/main.ts', 'run', '--config', configPath],
			{
				cwd: process.cwd(),
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		const timer = setTimeout(
			() => reject(new Error('the print agent never said listening')),
			20_000
		);
		let errors = '';
		child.stderr?.on('data', (chunk: Buffer) => (errors += chunk.toString()));
		child.stdout?.on('data', (chunk: Buffer) => {
			if (chunk.toString().includes('listening')) {
				clearTimeout(timer);
				resolve(child);
			}
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			if (code !== null && code !== 0)
				reject(new Error(`the print agent exited ${code}: ${errors}`));
		});
	});
}

function stopAgent(): Promise<void> {
	return new Promise((resolve) => {
		const child = agent;
		agent = null;
		if (!child || child.exitCode !== null) return resolve();
		child.once('exit', () => resolve());
		child.kill('SIGINT');
		setTimeout(() => child.kill('SIGKILL'), 3000).unref();
	});
}

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
	// Receipt 32 columns (58 mm), kitchen 48 (80 mm): the two widths in one run.
	receipt = await startFakePrinter();
	kitchen = await startFakePrinter();
	agentPort = await freePort();
	workDir = mkdtempSync(join(tmpdir(), 'matcami-printing-e2e-'));
	configPath = join(workDir, 'config.json');
	writeFileSync(
		configPath,
		JSON.stringify({
			// Playwright's baseURL: what the till's browser sends as Origin.
			origin: 'http://localhost:4173',
			token: TOKEN,
			port: agentPort,
			printers: {
				receipt: { host: '127.0.0.1', port: receipt.port, width: 32 },
				kitchen: { host: '127.0.0.1', port: kitchen.port, width: 48 }
			},
			dataDir: join(workDir, 'data')
		}),
		{ mode: 0o600 }
	);
	agent = await startAgent();
});

test.afterAll(async () => {
	await stopAgent();
	await receipt?.close();
	await kitchen?.close();
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	await closeDbRows();
	await closeResetPool();
});

const grid = (tillPage: Page) =>
	tillPage.getByRole('tabpanel').or(tillPage.getByRole('region', { name: 'Menu items' }));

/** Burger has the optional Extras group, so its card opens the options panel first. */
async function addBurger(tillPage: Page, options: { noCheese?: boolean } = {}): Promise<void> {
	await grid(tillPage)
		.getByRole('button', { name: /Burger/ })
		.click();
	const panel = tillPage.getByRole('region', { name: 'Burger options' });
	await expect(panel).toBeVisible();
	if (options.noCheese) await panel.getByRole('button', { name: /No cheese/ }).click();
	await panel.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(tillPage.getByRole('table')).toContainText('Burger');
}

async function signInOnTill(tillPage: Page, name: string, pin: string): Promise<void> {
	await tillPage.goto('/pos');
	await pickEmployee(tillPage, name);
	await enterPin(tillPage, pin);
	await expect(tillPage).toHaveURL(/\/pos\/(session|order)$/);
}

async function openSales(tillPage: Page): Promise<void> {
	await tillPage.getByRole('link', { name: 'Sales', exact: true }).click();
	await expect(tillPage).toHaveURL(/\/pos\/sales$/);
	await expect(tillPage.getByRole('heading', { name: 'Sales on this till' })).toBeVisible();
	await expect(tillPage.getByTestId('sale-row').first()).toBeVisible();
}

async function newSale(tillPage: Page): Promise<void> {
	await tillPage.getByRole('link', { name: 'POS', exact: true }).click();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);
}

test('receipts, kitchen tickets and the drawer: cash prints, a reprint is COPY, card waits for the server', async ({
	page,
	browser
}) => {
	test.setTimeout(600_000);

	// 1. The restaurant, its settings, the receipt header and the card terminal.
	await registerRestaurant(page, OWNER);
	await completeSettings(page, {
		taxMode: 'exclusive',
		taxRateBp: 1000,
		currency: 'USD',
		idleSeconds: 300
	});
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await page.getByLabel('Address').fill('Makka Al-Mukarama Rd, Km4');
	await page.getByLabel('Phone').fill('61 555 0142');
	await page.getByLabel('Footer line').fill('Mahadsanid! Thank you!');
	await page.getByLabel('Card terminal').selectOption('yes');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('alert')).toContainText('Settings saved.');

	// 2. Burger 8.00 with no category, and the Extras group with No cheese at -0.50.
	await createMenuItem(page, { category: null, name: 'Burger', priceMinor: 800n });
	await page.getByLabel('Group name').fill('Extras');
	await page.getByRole('button', { name: 'Add group' }).click();
	await expect(page.getByRole('alert')).toContainText('Extras added.');
	await page.getByLabel('Group', { exact: true }).selectOption({ label: 'Extras' });
	await page.getByLabel('Modifier name').fill('No cheese');
	await page.getByLabel('Price change').fill('-0.50');
	await page.getByRole('button', { name: 'Add modifier' }).click();
	await expect(page.getByRole('alert')).toContainText('No cheese added.');
	const burgerTile = page.getByRole('listitem').filter({ hasText: 'Burger' }).first();
	await burgerTile.getByRole('button', { name: 'Edit' }).click();
	await page.getByLabel('Modifier group').selectOption({ label: 'Extras' });
	await page.getByRole('button', { name: 'Attach' }).click();
	await expect(burgerTile).toContainText('Modifiers: Extras');

	// 3. The owner's own PIN, a cashier, and the till.
	await page.getByRole('link', { name: 'Employees', exact: true }).click();
	await page.getByRole('link', { name: /The Owner/ }).click();
	await expect(page).toHaveURL(/\/employees\/[0-9a-f-]+$/);
	await page.getByLabel('New PIN').fill(OWNER_PIN);
	await page.getByRole('button', { name: 'Set PIN' }).click();
	await expect(page.getByRole('alert')).toContainText('PIN set');
	await createCashier(page, CASHIER);

	const till = await browser.newContext();
	const tillPage = await till.newPage();
	await registerDevice(tillPage, OWNER);

	// 4. The owner pairs the till; both printers print the test page.
	await signInOnTill(tillPage, 'The Owner', OWNER_PIN);
	const chip = tillPage.getByTestId('printer-chip');
	await expect(chip).toContainText('Printer not set up');
	await tillPage.locator('summary').filter({ hasText: 'The Owner' }).click();
	await tillPage.getByRole('link', { name: 'Printer' }).click();
	await expect(tillPage).toHaveURL(/\/pos\/printer$/);
	await tillPage.getByLabel('Agent address').fill(`http://127.0.0.1:${agentPort}`);
	await tillPage.getByLabel('Pairing token').fill(TOKEN);
	await tillPage.getByRole('button', { name: 'Save and test print' }).click();
	const results = tillPage.getByTestId('test-results');
	await expect(results).toContainText('● Test page sent to the receipt printer', {
		timeout: 15_000
	});
	await expect(results).toContainText('● Test page sent to the kitchen printer');
	await receipt.waitFor('TEST PRINT');
	await kitchen.waitFor('TEST PRINT');
	expect(receipt.count('RECEIPT PRINTER')).toBe(1);
	expect(kitchen.count('KITCHEN PRINTER')).toBe(1);
	// The ruler is exactly the printer's width: 32 on the receipt, 48 on the kitchen.
	expect(receipt.count('12345678901234567890123456789012\n')).toBe(1);
	expect(kitchen.count('123456789012345678901234567890123456789012345678\n')).toBe(1);
	await expect(chip).toContainText('Printer ready');
	expect(receipt.count(PULSE)).toBe(0);

	// 5. The cashier sells a Delivery: Burger without cheese, a kitchen note, cash 10.00.
	await signInOnTill(tillPage, CASHIER.displayName, CASHIER.pin);
	await openSession(tillPage, 5000n);
	await chooseOrderType(tillPage, 'Delivery');
	await addBurger(tillPage, { noCheese: true });
	await tillPage.getByLabel('Note for the kitchen').fill('no onions');
	await tillPage.keyboard.press('Tab');
	await expect(tillPage.getByRole('region', { name: 'Current Order' })).toContainText('no onions');
	const receiptBefore = receipt.bytes().length;
	const kitchenBefore = kitchen.bytes().length;
	await payCash(tillPage, 1000n);
	await expect(tillPage.getByTestId('print-line')).toContainText('● Receipt sent to the printer', {
		timeout: 15_000
	});

	// 6. What reached the printers.
	await receipt.waitFor('Mahadsanid!', { from: receiptBefore });
	await receipt.waitFor(PULSE, { from: receiptBefore });
	await kitchen.waitFor('END OF TICKET', { from: kitchenBefore });
	const tape = receipt.bytes().subarray(receiptBefore);
	for (const expected of [
		'Maqaayadda Hodan',
		'Makka Al-Mukarama Rd, Km4',
		'Tel 61 555 0142',
		'POS1-000001',
		'Delivery',
		'Burger',
		'No cheese',
		'-0.50',
		'8.25',
		'CASH',
		'CHANGE',
		'1.75',
		'Mahadsanid! Thank you!'
	]) {
		expect(tape.includes(Buffer.from(expected, 'latin1')), `receipt: ${expected}`).toBe(true);
	}
	// No UTF-8 minus (E2 88 92) and no NBSP (C2 A0) reached the printer.
	expect(tape.includes(0xe2)).toBe(false);
	expect(tape.includes(0xc2)).toBe(false);
	const ticket = kitchen.bytes().subarray(kitchenBefore);
	for (const expected of ['ORDER 1', 'DELIVERY', 'BURGER', '+ NO CHEESE', 'NO ONIONS', 'BY SAM']) {
		expect(ticket.includes(Buffer.from(expected, 'latin1')), `kitchen: ${expected}`).toBe(true);
	}
	// A kitchen ticket carries no prices.
	expect(ticket.includes(Buffer.from('.50', 'latin1'))).toBe(false);
	expect(ticket.includes(Buffer.from('8.25', 'latin1'))).toBe(false);
	expect(receipt.count(PULSE)).toBe(1);
	expect(kitchen.count(PULSE)).toBe(0);

	// The sale synced exactly once (spec 29).
	await expect(tillPage.getByText('0 unsynced')).toBeVisible();
	expect(
		await dbRows<{ order_type: string; note: string | null; total_minor: string }>(
			'select order_type, note, total_minor::text as total_minor from orders'
		)
	).toEqual([{ order_type: 'delivery', note: 'no onions', total_minor: '825' }]);

	// 7. A reprint is marked COPY and never opens the drawer.
	await openSales(tillPage);
	const firstSale = tillPage.getByTestId('sale-row').filter({ hasText: 'POS1-000001' });
	await expect(firstSale).toContainText('● Paid');
	await expect(firstSale).toContainText('8.25');
	await expect(firstSale).toContainText('Delivery');
	const beforeCopy = receipt.bytes().length;
	expect(receipt.count('COPY')).toBe(0);
	await firstSale.getByRole('button', { name: 'Reprint receipt' }).click();
	await expect(firstSale).toContainText('● COPY of the receipt sent to the printer');
	await receipt.waitFor('COPY', { from: beforeCopy });
	await receipt.waitFor('POS1-000001', { from: beforeCopy });
	await receipt.waitFor('Reprint by', { from: beforeCopy });
	const kitchenBeforeCopy = kitchen.bytes().length;
	await firstSale.getByRole('button', { name: 'Reprint kitchen ticket' }).click();
	await expect(firstSale).toContainText('● COPY of the kitchen ticket sent to the printer');
	await kitchen.waitFor('*** COPY ***', { from: kitchenBeforeCopy });
	expect(receipt.count(PULSE)).toBe(1);
	// A reprint records nothing: still one order, one invoice.
	expect(await dbRows('select id from orders')).toHaveLength(1);
	expect(await dbRows('select id from invoices')).toHaveLength(1);

	// 8. CARD, FAIL CLOSED: nothing prints until the server confirms the sale.
	await tillPage.route('**/api/pos/sync', (route) => route.abort());
	await newSale(tillPage);
	await addBurger(tillPage);
	await tillPage.getByRole('button', { name: /^Pay\b/ }).click();
	await expect(tillPage).toHaveURL(/\/pos\/pay$/);
	await tillPage
		.getByRole('group', { name: 'Tender' })
		.getByRole('button', { name: /^Card/ })
		.click();
	const receiptBeforeCard = receipt.bytes().length;
	const kitchenBeforeCard = kitchen.bytes().length;
	await tillPage.getByRole('button', { name: /^Pay · Card/ }).click();
	await expect(tillPage.getByText('◐ Waiting for the server to confirm…')).toBeVisible();
	await expect(
		tillPage.getByText('◐ The receipt prints once the payment is confirmed')
	).toBeVisible();
	await tillPage.waitForTimeout(5000);
	expect(receipt.bytes().length).toBe(receiptBeforeCard);
	expect(kitchen.bytes().length).toBe(kitchenBeforeCard);

	await openSales(tillPage);
	const cardSale = tillPage.getByTestId('sale-row').filter({ hasText: 'POS1-000002' });
	await expect(cardSale).toContainText('◐ Awaiting confirmation — no receipt yet');
	await expect(cardSale.getByRole('button', { name: 'Reprint receipt' })).toBeDisabled();
	await expect(cardSale.getByRole('button', { name: 'Reprint kitchen ticket' })).toBeDisabled();
	await expect(cardSale).toContainText("Awaiting the server's confirmation");
	expect(receipt.bytes().length).toBe(receiptBeforeCard);

	await tillPage.unroute('**/api/pos/sync');
	await tillPage.evaluate(() => window.dispatchEvent(new Event('online')));
	await receipt.waitFor('POS1-000002', { from: receiptBeforeCard, timeoutMs: 20_000 });
	await receipt.waitFor('CARD', { from: receiptBeforeCard });
	await kitchen.waitFor('ORDER 2', { from: kitchenBeforeCard });
	await expect(cardSale).toContainText('● Paid');
	await expect(cardSale.getByRole('button', { name: 'Reprint receipt' })).toBeEnabled();
	const cardTape = receipt.bytes().subarray(receiptBeforeCard);
	expect(cardTape.includes(Buffer.from('COPY', 'latin1'))).toBe(false);
	expect(cardTape.includes(Buffer.from('CHANGE', 'latin1'))).toBe(false);
	// A card sale never opens the drawer.
	expect(receipt.count(PULSE)).toBe(1);
	await expect(tillPage.getByText('0 unsynced')).toBeVisible();

	// 9. THE INTERNET GOES DOWN — the agent is local, so a cash sale still prints.
	await tillPage.route('**/api/**', (route) => route.abort());
	await newSale(tillPage);
	await addBurger(tillPage);
	const receiptBeforeOutage = receipt.bytes().length;
	await payCash(tillPage, 1000n);
	await expect(tillPage.getByTestId('print-line')).toContainText('● Receipt sent to the printer', {
		timeout: 15_000
	});
	await receipt.waitFor('POS1-000003', { from: receiptBeforeOutage });
	await receipt.waitFor(PULSE, { from: receiptBeforeOutage });
	expect(receipt.count(PULSE)).toBe(2);
	await expect(tillPage.getByText('1 unsynced')).toBeVisible();
	await tillPage.unroute('**/api/**');
	await tillPage.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(tillPage.getByText('0 unsynced')).toBeVisible({ timeout: 20_000 });

	// 10. THE AGENT STOPS — the sale still completes; the receipt is reprinted later.
	await stopAgent();
	await expect(chip).toContainText('◆', { timeout: 35_000 });
	await expect(chip).toContainText('Printer unreachable');
	await newSale(tillPage);
	await addBurger(tillPage);
	const receiptBeforeDown = receipt.bytes().length;
	await payCash(tillPage, 1000n);
	await expect(tillPage.getByTestId('print-line')).toContainText(
		'◆ Not printed — reprint it from Sales',
		{ timeout: 15_000 }
	);
	expect(receipt.bytes().length).toBe(receiptBeforeDown);
	await expect(tillPage.getByText('0 unsynced')).toBeVisible({ timeout: 20_000 });

	agent = await startAgent();
	await openSales(tillPage);
	await expect(chip).toContainText('Printer ready', { timeout: 35_000 });
	const lateSale = tillPage.getByTestId('sale-row').filter({ hasText: 'POS1-000004' });
	await expect(lateSale).toContainText('● Paid');
	await lateSale.getByRole('button', { name: 'Reprint receipt' }).click();
	await expect(lateSale).toContainText('● COPY of the receipt sent to the printer');
	await receipt.waitFor('POS1-000004', { from: receiptBeforeDown });
	await receipt.waitFor('COPY', { from: receiptBeforeDown });
	// The drawer did not open late: two cash originals printed with the agent up, two pulses.
	await tillPage.waitForTimeout(1500);
	expect(receipt.count(PULSE)).toBe(2);
	expect(kitchen.count(PULSE)).toBe(0);

	// Four sales on the server, each exactly once; the reprints added nothing.
	expect(
		await dbRows<{ n: string }>('select count(*)::text as n from orders where status = $1', [
			'paid'
		])
	).toEqual([{ n: '4' }]);
	expect(await dbRows<{ n: string }>('select count(*)::text as n from invoices')).toEqual([
		{ n: '4' }
	]);

	await till.close();
});
