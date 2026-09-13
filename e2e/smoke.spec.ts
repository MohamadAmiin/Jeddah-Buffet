import { expect, test } from '@playwright/test';

// Proves the production build boots and serves a page. The <h1> comes from
// T-05's landing page and is deliberately stable — do not change its text
// without changing this assertion.
test('the landing page renders', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'matcami' })).toBeVisible();
});
