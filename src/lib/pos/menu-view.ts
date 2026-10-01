// Pure helpers over the cached menu snapshot for the order screen. No DOM, no
// IndexedDB, no fetch, and no money arithmetic: the key grid is GENERATED from
// the snapshot (spec 5), so a hand-placed key cannot become a second source of
// truth.

import type { LocalMenu } from './store';

export type MenuItem = LocalMenu['items'][number];
export type MenuGroup = LocalMenu['modifierGroups'][number];
export type CategoryTab = { id: string; name: string; items: MenuItem[] };

const bySortOrder = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder;

/** Categories in sortOrder, each with its items in sortOrder; an empty category
 *  is KEPT; items with NO category (categoryId null) or whose categoryId matches
 *  no live category go under a final synthetic tab { id: 'other', name: 'Other' },
 *  present only when needed. */
export function itemsByCategory(menu: LocalMenu): CategoryTab[] {
	const known = new Set(menu.categories.map((c) => c.id));
	const tabs: CategoryTab[] = [...menu.categories].sort(bySortOrder).map((c) => ({
		id: c.id,
		name: c.name,
		items: menu.items.filter((i) => i.categoryId === c.id).sort(bySortOrder)
	}));
	const orphans = menu.items
		.filter((i) => i.categoryId === null || !known.has(i.categoryId))
		.sort(bySortOrder);
	if (orphans.length > 0) tabs.push({ id: 'other', name: 'Other', items: orphans });
	return tabs;
}

/** The rate a line snapshots: the item's own when it is a number (0 is a rate,
 *  not "unset"), else the snapshot's; throws naming the item when both are null. */
export function resolveTaxRate(
	item: Pick<MenuItem, 'name' | 'taxRateBp'>,
	snapshot: Pick<LocalMenu, 'taxRateBp'>
): number {
	if (typeof item.taxRateBp === 'number') return item.taxRateBp;
	if (typeof snapshot.taxRateBp === 'number') return snapshot.taxRateBp;
	throw new TypeError(`No tax rate for "${item.name}" and none set for the restaurant`);
}

/** The item's modifier groups in the order of item.modifierGroupIds. */
export function modifierGroupsFor(item: MenuItem, menu: LocalMenu): MenuGroup[] {
	return item.modifierGroupIds.map((groupId) => {
		const group = menu.modifierGroups.find((g) => g.id === groupId);
		if (!group) {
			throw new RangeError(
				`Item ${item.id} names modifier group ${groupId}, which is not in the menu`
			);
		}
		return group;
	});
}

// formatTaxRate lives in src/lib/money/tax.ts (settings-tax-payments-receipt T-08);
// re-exported so the till's existing imports keep working. Not a copy.
export { formatTaxRate } from '../money/tax';
