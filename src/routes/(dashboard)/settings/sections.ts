import { resolve } from '$app/paths';

// THE SETTINGS SUB-NAVIGATION (tasks/settings-tax-payments-receipt, gate decision
// 8). The order is General, Tax, Payments, Receipt. General (T-27) and Tax (T-28)
// are listed here: SvelteKit's typed resolve() refuses a route that does not
// exist yet, so T-29 (Payments) and T-31 (Receipt) each append their link in the
// same commit that creates their page. It is a FUNCTION, not a constant, so that
// resolve() runs per render — as the inventory pages do.

/** The settings sub-navigation, in order. Every settings page renders it in PageHeader's `below`. */
export function settingsSections(): Array<{ label: string; href: string }> {
	return [
		{ label: 'General', href: resolve('/settings') },
		{ label: 'Tax', href: resolve('/settings/tax') }
	];
}

// The one link class, shared by every settings page. `data-current` lights the
// EXACT page only (see each page's `below` snippet): every /settings/<page> starts
// with /settings/, so the inventory nav's prefix rule would light General on all
// four pages.
export const SETTINGS_SECTION_LINK =
	'flex items-center border-b-2 border-transparent pb-3 text-sm font-medium text-ink-2 hover:text-ink data-current:border-accent data-current:text-ink';
