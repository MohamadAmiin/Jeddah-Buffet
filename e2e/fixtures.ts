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
		.getByLabel(employee.role === 'cashier' ? 'Cashier' : 'Waiter', { exact: true })
		.check();
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
