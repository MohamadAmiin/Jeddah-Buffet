import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LocalMenu } from './store';
import { formatTaxRate, itemsByCategory, modifierGroupsFor, resolveTaxRate } from './menu-view';

type Item = LocalMenu['items'][number];

function item(over: Partial<Item> & Pick<Item, 'id' | 'categoryId'>): Item {
	return {
		name: over.id,
		priceMinor: 100n,
		taxRateBp: null,
		isAvailable: true,
		sortOrder: 0,
		modifierGroupIds: [],
		imageId: null,
		...over
	};
}

function menu(over: Partial<LocalMenu>): LocalMenu {
	return {
		version: 1,
		restaurantId: 'r',
		currency: 'USD',
		currencyExponent: 2,
		taxMode: 'exclusive',
		taxRateBp: 825,
		categories: [],
		items: [],
		modifierGroups: [],
		...over
	};
}

describe('resolveTaxRate', () => {
	it('prefers the item, treats 0 as a rate, and throws when neither is set', () => {
		expect(resolveTaxRate({ name: 'Tea', taxRateBp: 500 }, { taxRateBp: 825 })).toBe(500);
		expect(resolveTaxRate({ name: 'Tea', taxRateBp: null }, { taxRateBp: 825 })).toBe(825);
		expect(resolveTaxRate({ name: 'Tea', taxRateBp: 0 }, { taxRateBp: 825 })).toBe(0);
		expect(() => resolveTaxRate({ name: 'Tea', taxRateBp: null }, { taxRateBp: null })).toThrow(
			/tax rate.*Tea|Tea.*tax rate/
		);
	});
});

describe('itemsByCategory', () => {
	it('orders tabs and items by sortOrder and keeps an empty category', () => {
		const m = menu({
			categories: [
				{ id: 'c2', name: 'Two', sortOrder: 1 },
				{ id: 'c1', name: 'One', sortOrder: 0 }
			],
			items: [
				item({ id: 'late', categoryId: 'c1', sortOrder: 2 }),
				item({ id: 'early', categoryId: 'c1', sortOrder: 0 })
			]
		});
		const tabs = itemsByCategory(m);
		expect(tabs.map((t) => t.id)).toEqual(['c1', 'c2']);
		expect(tabs[0].items.map((i) => i.id)).toEqual(['early', 'late']);
		expect(tabs[1].items).toEqual([]);
		expect(tabs.find((t) => t.id === 'other')).toBeUndefined();
	});

	it('puts an orphaned item under a final Other tab', () => {
		const m = menu({
			categories: [{ id: 'c1', name: 'One', sortOrder: 0 }],
			items: [item({ id: 'lost', categoryId: 'ghost' })]
		});
		const tabs = itemsByCategory(m);
		expect(tabs.at(-1)).toMatchObject({ id: 'other', name: 'Other' });
		expect(tabs.at(-1)?.items.map((i) => i.id)).toEqual(['lost']);
	});
});

describe('modifierGroupsFor', () => {
	it('follows the item order and names a dangling id', () => {
		const g = (id: string) => ({ id, name: id, minSelect: 0, maxSelect: 1, modifiers: [] });
		const m = menu({ modifierGroups: [g('g1'), g('g2')] });
		const it2 = item({ id: 'x', categoryId: 'c', modifierGroupIds: ['g2', 'g1'] });
		expect(modifierGroupsFor(it2, m).map((x) => x.id)).toEqual(['g2', 'g1']);
		const bad = item({ id: 'y', categoryId: 'c', modifierGroupIds: ['g9'] });
		expect(() => modifierGroupsFor(bad, m)).toThrow(/g9/);
	});
});

describe('formatTaxRate', () => {
	it('renders basis points as a two-decimal percentage', () => {
		expect(formatTaxRate(825)).toBe('8.25%');
		expect(formatTaxRate(0)).toBe('0.00%');
		expect(formatTaxRate(10000)).toBe('100.00%');
		expect(formatTaxRate(5)).toBe('0.05%');
		expect(formatTaxRate(1050)).toBe('10.50%');
		expect(() => formatTaxRate(8.25)).toThrow();
		expect(() => formatTaxRate(-1)).toThrow();
	});
});

describe('MANDATORY (spec 29) — the till screens hold no number conversion of money', () => {
	const FILES = [
		'src/routes/(pos)/pos/session/+page.svelte',
		'src/routes/(pos)/pos/order/+page.svelte',
		'src/routes/(pos)/pos/pay/+page.svelte',
		'src/lib/pos/menu-view.ts'
	];
	const FORBIDDEN = [
		'parseFloat',
		'.toFixed(',
		'Number(',
		'roundToMinor(',
		'taxOnAmount(',
		'taxOnLine('
	];

	for (const file of FILES) {
		it(`${file} contains none of the forbidden calls`, () => {
			const source = readFileSync(file, 'utf8');
			for (const needle of FORBIDDEN) expect(source, needle).not.toContain(needle);
		});
	}

	it('positive control: the money module itself rounds', () => {
		expect(readFileSync('src/lib/money/index.ts', 'utf8')).toContain('roundToMinor(');
	});
});
