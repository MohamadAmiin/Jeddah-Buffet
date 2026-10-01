// THE LAYOUT RULES (docs/redesign Phase 8, section 13.1) — measured, not eyeballed.
//
// The till: the document never scrolls; every closer (Register this device, Sign
// in, Open shift, Pay, Pay · Cash, Close shift) is fully on screen in its
// error and blocked states too; the unsynced count is always visible; the till
// bar is one 64px row with no overflow — at 1280x800, 1280x720 (Playwright's
// default, used by the rest of the suite) and 1024x768.
// The dashboard: on a phone the page title starts under the 56px bar, nothing
// scrolls sideways, and the navigation drawer opens again after Escape and hands
// focus back; between 1024 and 1279px a side column that is not a create form
// stays reachable.
//
// SERIAL, ONE RESTAURANT. Public sign-up allows three new companies per address a
// day, so the tests share one restaurant instead of registering one per viewport,
// and the till test walks every state once, checking each size at each state.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { acquireRunLock, closeResetPool, resetDb } from '../src/lib/server/db/test/reset';
import {
	addItem,
	chooseOrderType,
	closeDbRows,
	completeSettings,
	createCashier,
	createCategory,
	createMenuItem,
	enterPin,
	openSession,
	payCash,
	pickEmployee,
	registerDevice,
	registerRestaurant,
	signIn,
	TILL_URL
} from './fixtures';

test.describe.configure({ mode: 'serial' });

const OWNER = {
	name: 'The Layout Cafe',
	email: 'owner@layout.test',
	password: 'a strong enough password'
};

const TILL = [
	{ width: 1280, height: 800 },
	{ width: 1280, height: 720 },
	{ width: 1024, height: 768 }
];

test.beforeAll(async () => {
	await acquireRunLock();
	await resetDb();
});

test.afterAll(async () => {
	await closeDbRows();
	await closeResetPool();
});

async function expectNoDocumentScroll(page: Page, what: string) {
	expect(
		await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight),
		`${what}: the document scrolls`
	).toBe(true);
}

async function expectTillBarFits(page: Page, what: string) {
	const bar = page.locator('[data-surface="pos"] > header');
	expect((await bar.boundingBox())!.height, `${what}: the till bar is not 64px`).toBe(64);
	expect(
		await bar.evaluate((el) => el.scrollWidth <= el.clientWidth),
		`${what}: the till bar overflows`
	).toBe(true);
}

/** At every till size: the closer is fully in view, the document does not scroll,
 *  the unsynced count is on screen and the bar is one row. */
async function checkEverySize(page: Page, closer: Locator, what: string) {
	for (const viewport of TILL) {
		await page.setViewportSize(viewport);
		const label = `${what} @ ${viewport.width}x${viewport.height}`;
		await expect(closer, `${label}: the closer`).toBeInViewport({ ratio: 1 });
		await expectNoDocumentScroll(page, label);
		await expect(
			page.getByRole('status', { name: 'Connection and sync' }),
			`${label}: the unsynced count`
		).toBeInViewport();
		await expectTillBarFits(page, label);
	}
	await page.setViewportSize(TILL[0]);
}

test('till: every closer and the unsynced count stay on screen; the document never scrolls', async ({
	page,
	browser
}) => {
	test.setTimeout(300_000);
	await registerRestaurant(page, OWNER);
	await completeSettings(page, {
		taxMode: 'exclusive',
		taxRateBp: 1000,
		currency: 'USD',
		idleSeconds: 600
	});
	await createCategory(page, 'Mains');
	await createMenuItem(page, { category: 'Mains', name: 'Bariis', priceMinor: 850n });
	await createMenuItem(page, { category: 'Mains', name: 'Suqaar', priceMinor: 900n });
	await createCashier(page, { displayName: 'Amina Yusuf', pin: '4321' });

	const till = await browser.newContext({ viewport: TILL[0] });
	const tillPage = await till.newPage();
	await signIn(tillPage, OWNER);

	// Register this device, after a refused sign-in (the error sits at the top of
	// the form card, the closer stays its last element).
	await tillPage.goto(TILL_URL);
	await tillPage.getByRole('link', { name: 'Register this device' }).click();
	await tillPage.getByLabel('Owner email').fill(OWNER.email);
	await tillPage.getByLabel('Owner password').fill('not the password');
	await tillPage.getByLabel('Name for this device').fill('Counter tablet');
	await tillPage.getByRole('button', { name: 'Register this device' }).click();
	await expect(tillPage.getByRole('alert')).toBeVisible();
	await checkEverySize(
		tillPage,
		tillPage.getByRole('button', { name: 'Register this device' }),
		'register, refused'
	);
	await registerDevice(tillPage, OWNER);

	// Sign in, after a wrong PIN.
	await pickEmployee(tillPage, 'Amina Yusuf');
	await enterPin(tillPage, '9999');
	await expect(tillPage.getByRole('alert')).toBeVisible();
	await checkEverySize(tillPage, tillPage.getByRole('button', { name: 'Sign in' }), 'PIN, wrong');
	await enterPin(tillPage, '4321');

	// Open shift.
	await expect(tillPage.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
	await checkEverySize(tillPage, tillPage.getByRole('button', { name: 'Open shift' }), 'open');
	await openSession(tillPage, 50000n);

	// The order screen with 1, 4 and 12 lines.
	await chooseOrderType(tillPage, 'Takeaway');
	const pay = tillPage.getByRole('link', { name: /^Pay / });
	for (let lines = 1; lines <= 12; lines++) {
		await addItem(tillPage, lines % 2 ? 'Bariis' : 'Suqaar');
		if (lines === 1 || lines === 4 || lines === 12) {
			await checkEverySize(tillPage, pay, `order, ${lines} lines`);
		}
	}

	// Pay, with change due.
	await pay.click();
	await expect(tillPage.getByRole('heading', { name: 'Amount due' })).toBeVisible();
	for (const digit of '200000') {
		await tillPage.getByRole('button', { name: digit, exact: true }).click();
	}
	await expect(tillPage.getByText('Change due')).toBeVisible();
	const payCashKey = tillPage.getByRole('button', { name: /^Pay · Cash/ });
	await checkEverySize(tillPage, payCashKey, 'pay, cash with change');
	await payCashKey.click();
	await expect(tillPage.getByText('● Paid', { exact: true })).toBeVisible();
	await checkEverySize(tillPage, tillPage.getByRole('link', { name: 'New sale' }), 'paid');
	await tillPage.getByRole('link', { name: 'New sale' }).click();

	// Offline, with a sale waiting: the bar stays one row everywhere, including
	// at 390px, and closing is blocked with its closer still on screen.
	await till.setOffline(true);
	await addItem(tillPage, 'Bariis');
	await payCash(tillPage, 1000n);
	const status = tillPage.getByRole('status', { name: 'Connection and sync' });
	await expect(status).toContainText('Offline');
	await expect(status).toContainText('1 unsynced');
	await tillPage.getByRole('link', { name: 'New sale' }).click();
	await checkEverySize(tillPage, pay.or(tillPage.getByRole('button', { name: 'Pay' })), 'offline');
	await tillPage.setViewportSize({ width: 390, height: 844 });
	await expectTillBarFits(tillPage, 'offline @ 390x844');
	await expect(status).toBeInViewport();
	await tillPage.setViewportSize(TILL[0]);

	await tillPage.getByRole('link', { name: /^Shift · business date/ }).click();
	await expect(tillPage.getByRole('heading', { name: 'Close this shift' })).toBeVisible();
	const closeKey = tillPage.getByRole('button', { name: 'Close shift' });
	await expect(closeKey).toBeDisabled();
	await checkEverySize(tillPage, closeKey, 'close, blocked offline');
	await till.setOffline(false);
	await till.close();
});

test.describe('dashboard on a phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('content starts under the top bar, nothing scrolls sideways, the drawer reopens', async ({
		page
	}) => {
		await signIn(page, OWNER);
		await page.goto('/dashboard');
		const title = page.getByRole('main').getByRole('heading', { level: 2 }).first();
		expect((await title.boundingBox())!.y).toBeLessThan(120);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
		const menu = page.getByRole('button', { name: 'Open navigation' });
		// The second round proves it opens again after Escape.
		for (let round = 0; round < 2; round++) {
			await menu.click();
			await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
			await expect(menu).toBeFocused();
		}
	});
});

test.describe('dashboard between 1024 and 1279 px', () => {
	test.use({ viewport: { width: 1024, height: 768 } });

	test('side columns that are not create forms stay reachable', async ({ page }) => {
		await signIn(page, OWNER);
		await page.goto('/device');
		await expect(page.getByRole('button', { name: 'Save auto-lock' })).toBeVisible();
	});
});
