import { expect, test } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import {
	addItem,
	chooseOrderType,
	closeDbRows,
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
	signIn
} from './fixtures';

// MENU WITH PHOTOS, OPTIONAL CATEGORIES AND THE DELIVERY ORDER TYPE — milestone 1
// of tasks/menu-and-printing (spec 4, 5, 6, 13, 26).
//
// The owner builds a menu with one categorised item and one photographed item
// with no category; the till shows both (the photo loaded), defaults to Dine in,
// sells the photographed item as a Delivery for cash, and the report lists the
// Delivery row. Then the owner marks an item sold out and archives the category,
// and the till's next menu sync shows a single grid with no tab bar and the
// sold-out key disabled. Finally the till goes offline and reloads: the shell
// comes from the service worker and the photo from the browser's HTTP cache
// (requirement R2 — best effort; the assertion stays even if it proves
// environment-dependent, and a flake is reported, never deleted).
//
// MANDATORY coverage (spec 29 — offline sync: retries never create duplicates):
// the Delivery sale syncs exactly once — `0 unsynced` and one orders row.

const OWNER = {
	name: 'The Delivery Cafe',
	email: 'owner@delivery.test',
	password: 'a strong enough password'
};

// A 1×1 PNG. The panel resizes it in the browser and uploads the result.
const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeDbRows();
	await closeResetPool();
});

test('menu photos, optional categories and a Delivery sale, online and offline', async ({
	page,
	browser
}) => {
	test.setTimeout(300_000);

	// 1. The restaurant and its settings.
	await registerRestaurant(page, OWNER);
	await completeSettings(page, {
		taxMode: 'exclusive',
		taxRateBp: 1000,
		currency: 'USD',
		idleSeconds: 120
	});

	// 2. A categorised Tea, and a Burger with no category and a photo.
	await createCategory(page, 'Drinks');
	await createMenuItem(page, { category: 'Drinks', name: 'Tea', priceMinor: 200n });
	await createMenuItem(page, {
		category: null,
		name: 'Burger',
		priceMinor: 800n,
		photo: { name: 'burger.png', mimeType: 'image/png', buffer: PNG_1X1 }
	});
	const burgerTile = page.getByRole('listitem').filter({ hasText: 'Burger' }).first();
	await expect(burgerTile).toContainText('No category');
	const tilePhoto = burgerTile.locator('img');
	await expect(tilePhoto).toBeVisible();
	await expect
		.poll(() => tilePhoto.evaluate((img) => (img as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	const photos = await dbRows<{ byte_size: number; content_type: string }>(
		'select byte_size, content_type from menu_images'
	);
	expect(photos).toHaveLength(1);
	expect(photos[0].byte_size).toBeLessThanOrEqual(409_600);
	expect(['image/webp', 'image/jpeg']).toContain(photos[0].content_type);

	// 3. A cashier, the registered till, a PIN, an open session.
	await createCashier(page, { displayName: 'The Cashier', pin: '4321' });
	const till = await browser.newContext();
	const tillPage = await till.newPage();
	await signIn(tillPage, OWNER);
	await registerDevice(tillPage, OWNER);
	await tillPage.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	const status = tillPage.getByRole('status');
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await expect(tillPage).toHaveURL(/\/pos\/session$/);
	await openSession(tillPage, 10000n);
	await expect(status).toContainText('0 unsynced');

	// 4. The order screen: Drinks and Other tabs, Burger under Other with its photo,
	//    Dine in pressed before anything is chosen.
	await expect(tillPage.getByRole('tab', { name: 'Drinks' })).toBeVisible();
	await expect(tillPage.getByRole('tab', { name: 'Other' })).toBeVisible();
	await expect(tillPage.getByRole('button', { name: 'Dine in', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await tillPage.getByRole('tab', { name: 'Other' }).click();
	const burgerKey = tillPage.getByRole('tabpanel').getByRole('button', { name: /Burger/ });
	await expect(burgerKey).toBeVisible();
	await expect
		.poll(() => burgerKey.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);

	// 5. Delivery, one Burger, cash 10.00 — a recorded fact, synced once.
	await chooseOrderType(tillPage, 'Delivery');
	await addItem(tillPage, 'Burger');
	await payCash(tillPage, 1000n);
	await expect(tillPage.getByText('● Paid')).toBeVisible();
	await expect(status).toContainText('0 unsynced');
	expect(await dbRows('select order_type, table_label, status from orders')).toEqual([
		{ order_type: 'delivery', table_label: null, status: 'paid' }
	]);

	// 6. The dashboard report lists the Delivery row: one sale, 8.80.
	await page.getByRole('link', { name: 'Reports', exact: true }).click();
	await expect(page).toHaveURL(/\/reports/);
	const byOrderType = page
		.getByRole('heading', { name: 'By order type' })
		.locator('xpath=following::table[1]');
	await expect(byOrderType).toContainText(/Delivery\s*1\s*8\.80/);

	// 7. Sold out and archived on the dashboard; the till re-syncs on employee select.
	await page.getByRole('link', { name: 'Menu', exact: true }).click();
	await page
		.getByRole('listitem')
		.filter({ hasText: 'Tea' })
		.first()
		.getByRole('button', { name: 'Mark sold out' })
		.click();
	await expect(page.getByRole('alert')).toContainText('Marked sold out.');
	await page.getByText('Archive Drinks…').click();
	await page.getByRole('button', { name: 'Archive category' }).click();
	await expect(page.getByRole('alert')).toContainText('1 item(s) moved to No category');

	await tillPage.getByRole('link', { name: 'New sale' }).click();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);
	// Employee select IS signing out, and it re-syncs the menu (spec 5).
	await tillPage.goto('/pos');
	await expect(tillPage.getByRole('heading', { name: 'Who is signing in?' })).toBeVisible();
	await pickEmployee(tillPage, 'The Cashier');
	await enterPin(tillPage, '4321');
	await expect(tillPage).toHaveURL(/\/pos\/order$/);
	await expect(tillPage.getByRole('tablist')).toHaveCount(0);
	const grid = tillPage.getByRole('region', { name: 'Menu items' });
	const teaKey = grid.getByRole('button', { name: /Tea/ });
	await expect(teaKey).toContainText('Unavailable');
	await expect(teaKey).toBeDisabled();
	await expect(grid.getByRole('button', { name: /Burger/ })).toBeEnabled();

	// 8. Offline reload: the shell from the service worker, the photo from the HTTP cache.
	await till.setOffline(true);
	await tillPage.reload();
	await expect(tillPage).toHaveURL(/\/pos\/order$/);
	await expect(status).toContainText('Offline');
	const offlineBurger = tillPage
		.getByRole('region', { name: 'Menu items' })
		.getByRole('button', { name: /Burger/ });
	await expect(offlineBurger).toBeVisible();
	await expect
		.poll(() =>
			offlineBurger.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)
		)
		.toBeGreaterThan(0);
	await till.setOffline(false);
	await till.close();
});
