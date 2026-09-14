import { expect, test } from '@playwright/test';

// Proves the production build boots AND that the bare host sends a visitor
// somewhere useful.
//
// This used to assert a heading on a placeholder landing page. That page is gone:
// `/` is now a signpost, not a screen. The assertion is stronger for it — a page
// that rendered proved the build served HTML, whereas a redirect proves the build
// served HTML *and* that the session-aware routing decision ran.
test('the bare host sends a signed-out visitor to the login page', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

// The redirect is a 303 and is NOT cached: a 301 would be remembered by the browser
// and would outlive any later decision to give `/` a real page.
test('the redirect is a 303, not a permanent one', async ({ request }) => {
	const response = await request.get('/', { maxRedirects: 0 });
	expect(response.status()).toBe(303);
	expect(response.headers()['location']).toMatch(/\/login$/);
});
