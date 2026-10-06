import { resolve } from '$app/paths';

// THE SETTINGS SUB-NAVIGATION (tasks/settings-tax-payments-receipt, gate decision
// 8). The order is General, Tax, Payments, Receipt — General (T-27), Tax (T-28),
// Payments (T-29) and Receipt (T-31), each appended in the commit that created
// its page, because SvelteKit's typed resolve() refuses a route that does not
// exist yet. It is a FUNCTION, not a constant, so that resolve() runs per render
// — as the inventory pages do.

/** The settings sub-navigation, in order. Every settings page renders it in PageHeader's `below`. */
export function settingsSections(): Array<{ label: string; href: string }> {
	return [
		{ label: 'General', href: resolve('/settings') },
		{ label: 'Tax', href: resolve('/settings/tax') },
		{ label: 'Payments', href: resolve('/settings/payments') },
		{ label: 'Receipt', href: resolve('/settings/receipt') }
	];
}

// The one link class, shared by every settings page. `data-current` lights the
// EXACT page only (see each page's `below` snippet): every /settings/<page> starts
// with /settings/, so the inventory nav's prefix rule would light General on all
// four pages.
export const SETTINGS_SECTION_LINK =
	'flex items-center border-b-2 border-transparent pb-3 text-sm font-medium text-ink-2 hover:text-ink data-current:border-accent data-current:text-ink';
