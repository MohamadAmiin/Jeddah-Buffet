import { expect, test } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import {
	addItem,
	chooseOrderType,
	closeDbRows,
	completeSettings,
	createCashier,
	createCategory,
	createIngredient,
	createMenuItem,
	dbRows,
	enterPin,
	openSession,
	payCash,
	pickEmployee,
	recordDelivery,
	registerDevice,
	registerRestaurant,
	setRecipe
} from './fixtures';

// FROM A DELIVERY TO COST OF GOODS SOLD (tasks/inventory-cogs T-35; spec 13,
// 16, 26). Real stock arrives on the dashboard, a real till sells it, and the
// server deducts it inside the sale's own transaction (invariant 4), posts the
// COGS entry (invariant 3), keeps the caches equal to the ledger (invariant 6)
// and reports it under the session's business date (invariant 11).
//
// Numbers, by hand: 2 kg of meat for 11.00 is 0.55¢/g; 12 buns for 6.00 is 50¢
// each. Two burgers take 300 g (value 1100 → 935, cost 165) and 2 buns (600 →
// 500, cost 100): COGS 265. The burger now costs 82.5 + 50 = 132.5 → 1.33, and
// at 8.00 exclusive its margin is 6.67.
//
// Every server assertion follows a wait for `0 unsynced`; nothing waits on a
// timer.

const OWNER = {
	name: 'The Stock Cafe',
	email: 'owner@stock.test',
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

test('a delivery, a recipe, a till sale: stock, COGS, reports and margin agree', async ({
	page,
	browser
}) => {
	test.setTimeout(300_000);

	// 1. The restaurant, its settings, the Burger at 8.00 and a cashier.
	await registerRestaurant(page, OWNER);
	await completeSettings(page, {
		taxMode: 'exclusive',
		taxRateBp: 1000,
		currency: 'USD',
		idleSeconds: 120
	});
	await createCategory(page, 'Counter');
	await createMenuItem(page, { category: 'Counter', name: 'Burger', priceMinor: 800n });
	await createCashier(page, { displayName: 'The Cashier', pin: '4321' });

	// 2. Ingredients, the recipe and a bank delivery.
	await createIngredient(page, {
		name: 'Meat',
		baseUnit: 'g',
		unit: { name: 'kg', baseQtyPerUnit: '1000' }
	});
	await createIngredient(page, {
		name: 'Bun',
		baseUnit: 'pcs',
		unit: { name: 'bag', baseQtyPerUnit: '12' }
	});
	await setRecipe(page, {
		itemName: 'Burger',
		rows: [
			{ ingredientName: 'Meat', qty: '150' },
			{ ingredientName: 'Bun', qty: '1' }
		]
	});
	await recordDelivery(page, {
		supplier: 'Market',
		paidBy: 'Paid now — bank',
		lines: [
			{ ingredientName: 'Meat', unitName: 'kg', qty: '2', total: '11.00' },
			{ ingredientName: 'Bun', unitName: 'bag', qty: '1', total: '6.00' }
		]
	});

	// 3. The stock book after the delivery.
	const stockRow = (name: string) =>
		page.getByRole('table', { name: 'Ingredients' }).getByRole('row', { name: new RegExp(name) });
	await page.getByRole('link', { name: 'Inventory', exact: true }).click();
	await expect(stockRow('Meat')).toContainText('2000.000 g');
	await expect(stockRow('Bun')).toContainText('12.000 pcs');

	// 4. Two burgers on the till, paid in cash.
	const till = await browser.newContext();
	const tillPage = await till.newPage();
	// registerDevice checks the owner's password itself; a dashboard sign-in on
	// this tab first would spend a second attempt from the throttle every spec in
	// the run shares (10 per address per 10 minutes, process-local).
	await registerDevice(tillPage, OWNER);
	const status = tillPage.getByRole('status');
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await openSession(tillPage, 50000n);
	await expect(status).toContainText('0 unsynced');
	const businessDate = /business date (\d{4}-\d{2}-\d{2})/.exec(await status.innerText())![1];
	await addItem(tillPage, 'Burger');
	await addItem(tillPage, 'Burger');
	await chooseOrderType(tillPage, 'Takeaway');
	await payCash(tillPage, 2000n);
	await expect(status).toContainText('0 unsynced');

	// 5. The stock book after the sale. The owner's tab is still on /inventory
	// from step 3, and a link to the current URL does not re-run the load: reload.
	await page.reload();
	await expect(stockRow('Meat')).toContainText('1700.000 g');
	await expect(stockRow('Bun')).toContainText('10.000 pcs');

	// 6. The ledger and the books, straight from the database.
	const [order] = await dbRows<{ id: string }>('select id from orders');
	expect(
		await dbRows(
			`select i.name, m.qty::text as qty, m.cost_minor::text as cost,
			        m.business_date::text as business_date
			 from stock_movements m join ingredients i on i.id = m.ingredient_id
			 where m.movement_type = 'sale_consumption' and m.source_id = $1
			 order by i.name`,
			[order.id]
		)
	).toEqual([
		{ name: 'Bun', qty: '-2.000', cost: '-100', business_date: businessDate },
		{ name: 'Meat', qty: '-300.000', cost: '-165', business_date: businessDate }
	]);
	const cogs = await dbRows<{ id: string }>(
		"select id from journal_entries where event = 'cost_of_goods_sold' and source_id = $1",
		[order.id]
	);
	expect(cogs).toHaveLength(1);
	expect(
		await dbRows(
			`select a.code, l.debit_minor::text as debit, l.credit_minor::text as credit
			 from journal_entry_lines l join accounts a on a.id = l.account_id
			 where l.entry_id = $1 order by l.line_no`,
			[cogs[0].id]
		)
	).toEqual([
		{ code: '5000', debit: '265', credit: '0' },
		{ code: '1200', debit: '0', credit: '265' }
	]);
	expect(
		await dbRows(
			`select i.name, i.on_hand_qty::text as qty, i.inventory_value_minor::text as value
			 from ingredients i order by i.name`
		)
	).toEqual([
		{ name: 'Bun', qty: '10.000', value: '500' },
		{ name: 'Meat', qty: '1700.000', value: '935' }
	]);

	// 7. The reports, for the session's business date.
	await page.getByRole('link', { name: 'Inventory', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'Inventory sections' })
		.getByRole('link', { name: 'Reports', exact: true })
		.click();
	await expect(page).toHaveURL(/\/inventory\/reports/);
	await page.goto(`/inventory/reports?from=${businessDate}&to=${businessDate}`);
	const cogsCard = page
		.locator('section, div')
		.filter({ has: page.getByRole('heading', { name: /Cost of goods sold/ }) })
		.last();
	await expect(cogsCard).toContainText('2.65');

	// 8. The menu: the Burger's cost and margin at the averages now.
	await page.getByRole('link', { name: 'Menu', exact: true }).click();
	const burger = page
		.locator('li')
		.filter({ hasText: /^\s*Burger/ })
		.first();
	await expect(burger).toContainText(/Cost\s*1\.33/);
	await expect(burger).toContainText(/Margin\s*6\.67/);

	// 9. The stock book agrees with the books: no mismatch alert.
	await page.getByRole('link', { name: 'Inventory', exact: true }).click();
	await expect(page.getByText(/differs from the books/)).toHaveCount(0);
	await expect(page.getByText(/differs from the stock book/)).toHaveCount(0);

	await till.close();
});
