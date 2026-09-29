// SHARED HELPERS for the three POS specs — pos-access, pos-service-worker and
// pos-offline. Plain exported async functions, NOT a Playwright fixture file:
// Playwright's default testMatch is **/*.@(spec|test).?(c|m)[jt]s?(x), so a file
// named fixtures.ts is never collected as a test.
//
// EVERY DASHBOARD PAGE IS REACHED BY CLICKING ITS RAIL LINK, never by typing its
// URL: the URLs belong to T-29 and T-31, the rail labels are fixed by T-30, and the
// click is itself the assertion that the rail is wired. Rail links are matched with
// `exact: true` because the onboarding checklist carries links whose names contain
// the same words ("Open the POS page", "Add employees", "Open menu").
import { expect, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * The till's landing screen (T-25). `/pos`, with NO trailing slash: it is the
 * literal the service worker is scoped to and the manifest's start_url, and scope
 * matching is a plain string prefix — `/pos/` would not match `/pos` itself. Never
 * write `/pos/`.
 */
export const TILL_URL = '/pos';

export type Owner = { name: string; email: string; password: string };

/**
 * Sign a company up at /register — public since main's PR #9, with no setup
 * token — and leave its owner signed in on /dashboard.
 */
export async function registerRestaurant(
	page: Page,
	owner: Owner,
	options: { timeZone?: string } = {}
): Promise<void> {
	await page.goto('/register');
	await page.getByLabel('Restaurant name').fill(owner.name);
	await page.getByLabel('Time zone').fill(options.timeZone ?? 'Africa/Mogadishu');
	await page.getByLabel('Your name').fill('The Owner');
	await page.getByLabel('Email').fill(owner.email);
	await page.getByLabel('Password', { exact: true }).fill(owner.password);
	await page.getByLabel('Confirm password').fill(owner.password);
	await page.getByRole('button', { name: 'Create restaurant' }).click();
	await expect(page).toHaveURL(/\/dashboard$/);
}

export async function signIn(page: Page, owner: Pick<Owner, 'email' | 'password'>): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Email').fill(owner.email);
	await page.getByLabel('Password', { exact: true }).fill(owner.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard$/);
}

/** Add a cashier or a waiter with a PIN, from the Employees page reached by its rail link. */
export async function createEmployee(
	page: Page,
	employee: { displayName: string; role: 'cashier' | 'waiter'; pin: string }
): Promise<void> {
	await page.getByRole('link', { name: 'Employees', exact: true }).click();
	await expect(page).toHaveURL(/\/employees$/);
	await page.getByLabel('Name', { exact: true }).fill(employee.displayName);
	await page
		.getByLabel('Role', { exact: true })
		.selectOption({ label: employee.role === 'cashier' ? 'Cashier' : 'Waiter' });
	// `exact`: every staff row also carries a "New PIN" field.
	await page.getByLabel('PIN', { exact: true }).fill(employee.pin);
	await page.getByRole('button', { name: 'Create employee' }).click();
	await expect(page.getByRole('alert')).toContainText(`${employee.displayName} was added.`);
}

export function createCashier(page: Page, cashier: { displayName: string; pin: string }) {
	return createEmployee(page, { ...cashier, role: 'cashier' });
}

/**
 * Register the till from the till itself (spec 7): the landing screen says the
 * device is not registered, the owner signs in there once, and the till lands on
 * employee-select.
 */
export async function registerDevice(
	tillPage: Page,
	owner: Pick<Owner, 'email' | 'password'>,
	label = 'Counter tablet'
): Promise<void> {
	await tillPage.goto(TILL_URL);
	await tillPage.getByRole('link', { name: 'Register this device' }).click();
	await expect(
		tillPage.getByRole('heading', { name: 'Register this device as the till' })
	).toBeVisible();
	await tillPage.getByLabel('Owner email').fill(owner.email);
	await tillPage.getByLabel('Owner password').fill(owner.password);
	await tillPage.getByLabel('Name for this device').fill(label);
	await tillPage.getByRole('button', { name: 'Register this device' }).click();
	await expect(tillPage.getByRole('heading', { name: 'Who is signing in?' })).toBeVisible();
}

/**
 * Type a PIN on the till's keypad and submit it. A PIN is 4–6 DIGITS and stays a
 * string: leading zeros are legal, and nothing here may pass it through a number.
 */
export async function enterPin(tillPage: Page, pin: string): Promise<void> {
	for (const digit of pin) {
		await tillPage.getByRole('button', { name: digit, exact: true }).click();
	}
	await tillPage.getByRole('button', { name: 'Sign in' }).click();
}

/** Pick an employee on the till's employee-select screen. */
export async function pickEmployee(tillPage: Page, displayName: string): Promise<void> {
	await tillPage.getByRole('button', { name: new RegExp(displayName) }).click();
	await expect(tillPage.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
}

/** Every row of one store in the till's IndexedDB, read inside the page. */
export function storeRows<T>(tillPage: Page, store: string): Promise<T[]> {
	return tillPage.evaluate(
		(name) =>
			new Promise<T[]>((resolve, reject) => {
				const open = indexedDB.open('matcami-pos');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const request = db.transaction(name).objectStore(name).getAll();
					request.onsuccess = () => {
						db.close();
						resolve(request.result as T[]);
					};
					request.onerror = () => reject(request.error);
				};
			}),
		store
	);
}

// A READ-ONLY query against the TEST database, mirroring getPool() in
// src/lib/server/db/test/reset.ts — including the guard, because a query helper
// that could reach development data is exactly the bug that guard prevents.
let pool: pg.Pool | undefined;

function testPool(): pg.Pool {
	if (!pool) {
		const url = process.env.TEST_DATABASE_URL;
		if (!url) throw new Error('TEST_DATABASE_URL is not set — refusing to query any database.');
		const dbName = new URL(url).pathname.replace(/^\//, '');
		if (!dbName.endsWith('_test')) {
			throw new Error(`Refusing to query "${dbName}": the database name must end in "_test".`);
		}
		pool = new pg.Pool({ connectionString: url, options: '-c timezone=UTC' });
	}
	return pool;
}

export async function dbRows<T>(text: string, params: unknown[] = []): Promise<T[]> {
	return (await testPool().query(text, params)).rows as T[];
}

export async function closeDbRows(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = undefined;
	}
}

/** Tax, currency and the idle lock: /settings, then /device, each by its rail link. */
export async function completeSettings(
	page: Page,
	s: {
		taxMode: 'exclusive' | 'inclusive';
		taxRateBp: number;
		currency: string;
		idleSeconds: number;
	}
): Promise<void> {
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await page.getByLabel('Tax mode').fill(s.taxMode);
	await page.getByLabel('Tax rate (basis points)').fill(String(s.taxRateBp));
	await page.getByLabel('Currency code').fill(s.currency);
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('alert')).toContainText('Settings saved.');

	await page.getByRole('link', { name: 'POS', exact: true }).click();
	await expect(page).toHaveURL(/\/device$/);
	await page.getByLabel('Auto-lock after (seconds)').fill(String(s.idleSeconds));
	await page.getByRole('button', { name: 'Save auto-lock' }).click();
	await expect(page.getByRole('alert')).toContainText('Auto-lock saved.');
}

export async function createCategory(page: Page, name: string): Promise<void> {
	await page.getByRole('link', { name: 'Menu', exact: true }).click();
	await expect(page).toHaveURL(/\/menu$/);
	await page.getByLabel('Category name').fill(name);
	await page.getByRole('button', { name: 'Add category' }).click();
	await expect(page.getByRole('alert')).toContainText(`${name} added.`);
}

/** The Price field takes MAJOR units as text, built from the digits — never by division. */
export async function createMenuItem(
	page: Page,
	item: { category: string; name: string; priceMinor: bigint }
): Promise<void> {
	await page.getByRole('link', { name: 'Menu', exact: true }).click();
	await expect(page).toHaveURL(/\/menu$/);
	await page.getByLabel('Category', { exact: true }).selectOption({ label: item.category });
	await page.getByLabel('Item name').fill(item.name);
	const d = String(item.priceMinor).padStart(3, '0');
	await page.getByLabel('Price', { exact: true }).fill(d.slice(0, -2) + '.' + d.slice(-2));
	await page.getByRole('button', { name: 'Add item' }).click();
	await expect(page.getByRole('alert')).toContainText(`${item.name} added.`);
}

/** The till's keypads take MINOR units as digits: 50000n is five presses and reads 500.00. */
async function typeMinor(tillPage: Page, amount: bigint): Promise<void> {
	for (const digit of String(amount)) {
		await tillPage.getByRole('button', { name: digit, exact: true }).click();
	}
}

export async function openSession(tillPage: Page, openingCashMinor: bigint): Promise<void> {
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByRole('heading', { name: 'Open a session' })).toBeVisible();
	await typeMinor(tillPage, openingCashMinor);
	await tillPage.getByRole('button', { name: 'Open session' }).click();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);
}

export async function addItem(tillPage: Page, name: string): Promise<void> {
	await tillPage
		.getByRole('tabpanel')
		.getByRole('button', { name: new RegExp(name) })
		.click();
	await expect(tillPage.getByRole('table')).toContainText(name);
}

export async function chooseOrderType(
	tillPage: Page,
	type: 'Sit now' | 'Waiting for a table' | 'Takeaway',
	options: { tableLabel?: string } = {}
): Promise<void> {
	await tillPage.getByRole('button', { name: type, exact: true }).click();
	if (options.tableLabel !== undefined) {
		await tillPage.getByLabel('Table', { exact: true }).fill(options.tableLabel);
		await tillPage.keyboard.press('Tab');
	}
	const expected =
		type === 'Sit now' && options.tableLabel ? `Sit now · Table ${options.tableLabel}` : type;
	await expect(tillPage.getByRole('heading', { level: 2 })).toHaveText(expected);
}

export async function payCash(tillPage: Page, tenderedMinor: bigint): Promise<void> {
	await tillPage.getByRole('button', { name: /^Pay\b/ }).click();
	await expect(tillPage).toHaveURL(/\/pos\/pay$/);
	await expect(tillPage.getByRole('heading', { name: 'Amount due' })).toBeVisible();
	await tillPage
		.getByRole('group', { name: 'Tender' })
		.getByRole('button', { name: 'Cash', exact: true })
		.click();
	await typeMinor(tillPage, tenderedMinor);
	await expect(tillPage.getByText('Change due')).toBeVisible();
	await tillPage.getByRole('button', { name: /^Pay · Cash/ }).click();
	await expect(tillPage.getByText('● Paid')).toBeVisible();
}

export async function closeSession(tillPage: Page, countedCashMinor: bigint): Promise<void> {
	await tillPage.getByRole('link', { name: /Session · business date/ }).click();
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await expect(tillPage.getByRole('heading', { name: 'Close this session' })).toBeVisible();
	await expect(tillPage.getByText('◆ Offline — closing needs a connection')).toHaveCount(0);
	await expect(tillPage.getByText(/operations still syncing/)).toHaveCount(0);
	await expect(tillPage.getByText(/from a previous registration/)).toHaveCount(0);
	await typeMinor(tillPage, countedCashMinor);
	await tillPage.getByRole('button', { name: 'Close session' }).click();
	await expect(tillPage.getByText('Expected', { exact: true })).toBeVisible();
}

// ── tasks/inventory-cogs T-35: the owner's inventory pages ──────────────────
// Reached by the rail's Inventory and Purchases links and the pages' own links,
// never by typing a URL.

/** Add an ingredient on /inventory, then one purchase unit on its own page. */
export async function createIngredient(
	page: Page,
	i: { name: string; baseUnit: string; unit: { name: string; baseQtyPerUnit: string } }
): Promise<void> {
	await page.getByRole('link', { name: 'Inventory', exact: true }).click();
	await expect(page).toHaveURL(/\/inventory$/);
	await page.getByLabel('Name', { exact: true }).fill(i.name);
	await page.getByLabel('Base unit', { exact: true }).fill(i.baseUnit);
	await page.getByRole('button', { name: 'Add ingredient' }).click();
	await expect(page).toHaveURL(/\/inventory\/[0-9a-f-]{36}$/);
	await page.getByLabel('Unit name').fill(i.unit.name);
	await page.getByLabel(`${i.baseUnit} per unit`).fill(i.unit.baseQtyPerUnit);
	await page.getByRole('button', { name: 'Add unit' }).click();
	await expect(page.getByRole('table', { name: 'Purchase units' })).toContainText(i.unit.name);
}

/** Set a menu item's recipe on /inventory/recipes; quantities are in base units. */
export async function setRecipe(
	page: Page,
	r: { itemName: string; rows: { ingredientName: string; qty: string }[] }
): Promise<void> {
	await page.getByRole('link', { name: 'Inventory', exact: true }).click();
	await page.getByRole('link', { name: 'Recipes', exact: true }).click();
	await expect(page).toHaveURL(/\/inventory\/recipes/);
	await page.getByRole('link', { name: r.itemName, exact: true }).click();
	await expect(page).toHaveURL(/\/inventory\/recipes\?item=/);
	for (const [index, row] of r.rows.entries()) {
		const select = page.getByLabel(`Ingredient, row ${index + 1}`);
		if ((await select.count()) === 0) {
			await page.getByRole('button', { name: 'Add row' }).click();
		}
		const option = select.locator('option', { hasText: `${row.ingredientName} (` });
		await select.selectOption({ value: (await option.getAttribute('value'))! });
		await page.getByLabel(`Quantity, row ${index + 1}`).fill(row.qty);
	}
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/inventory\/recipes\?item=/);
	await expect(page.getByRole('alert')).toHaveCount(0);
}

/** Record a delivery on /purchases/new; totals are major units as text ("11.00"). */
export async function recordDelivery(
	page: Page,
	d: {
		supplier: string;
		paidBy: 'Paid now — bank' | 'Paid now — cash' | 'On credit';
		lines: { ingredientName: string; unitName: string; qty: string; total: string }[];
	}
): Promise<void> {
	await page.getByRole('link', { name: 'Purchases', exact: true }).click();
	await expect(page).toHaveURL(/\/purchases$/);
	await page.getByRole('link', { name: 'Record a delivery' }).click();
	await expect(page).toHaveURL(/\/purchases\/new$/);
	await page.getByLabel('Supplier', { exact: true }).fill(d.supplier);
	await page.getByLabel('Paid by', { exact: true }).selectOption({ label: d.paidBy });
	for (const [index, line] of d.lines.entries()) {
		const n = index + 1;
		await page
			.getByLabel(`Line ${n}: ingredient and unit`)
			.selectOption({ label: `${line.ingredientName} — ${line.unitName}` });
		await page.getByLabel(`Line ${n}: quantity`).fill(line.qty);
		await page.getByLabel(`Line ${n}: line total`).fill(line.total);
	}
	await page.getByRole('button', { name: 'Record delivery' }).click();
	await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/);
}
