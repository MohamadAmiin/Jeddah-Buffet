import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatTaxRate as moneyFormatTaxRate } from '../money/tax';
import type { LocalMenu } from './store';
import {
	formatTaxRate,
	itemsByCategory,
	lineTaxRateText,
	modifierGroupsFor,
	resolveTaxRate
} from './menu-view';

type Item = LocalMenu['items'][number];

function item(over: Partial<Item> & Pick<Item, 'id' | 'categoryId'>): Item {
	return {
		name: over.id,
		priceMinor: 100n,
		taxRateBp: null,
		taxRate: null,
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
		format: 2,
		restaurantId: 'r',
		currency: 'USD',
		currencyExponent: 2,
		taxMode: 'exclusive',
		taxRateBp: 825,
		defaultTaxRate: null,
		categories: [],
		items: [],
		modifierGroups: [],
		...over
	};
}

// tasks/settings-tax-payments-receipt T-18: the named rate first, then the legacy
// numbers a format-1 copy carries.
describe('resolveTaxRate', () => {
	const TAX = { id: 'r0', name: 'Tax', rateBp: 825 };

	it("the item's named rate wins", () => {
		const reduced = { id: 'r5', name: 'Reduced', rateBp: 500 };
		const resolved = resolveTaxRate(
			{ name: 'Tea', taxRate: reduced, taxRateBp: 999 },
			{ defaultTaxRate: TAX, taxRateBp: 825 }
		);
		expect(resolved).toEqual({ id: 'r5', name: 'Reduced', rateBp: 500 });
		// Copied into a new object: a cart line never shares the cached row.
		expect(resolved).not.toBe(reduced);
	});

	it("a format-1 item's own number comes next", () => {
		expect(
			resolveTaxRate(
				{ name: 'Tea', taxRate: null, taxRateBp: 500 },
				{ defaultTaxRate: TAX, taxRateBp: 825 }
			)
		).toEqual({ id: null, name: null, rateBp: 500 });
	});

	it("then the menu's default rate", () => {
		const resolved = resolveTaxRate(
			{ name: 'Tea', taxRate: null, taxRateBp: null },
			{ defaultTaxRate: TAX, taxRateBp: 825 }
		);
		expect(resolved).toEqual({ id: 'r0', name: 'Tax', rateBp: 825 });
		expect(resolved).not.toBe(TAX);
	});

	it("then the menu's legacy number", () => {
		expect(
			resolveTaxRate(
				{ name: 'Tea', taxRate: null, taxRateBp: null },
				{ defaultTaxRate: null, taxRateBp: 825 }
			)
		).toEqual({ id: null, name: null, rateBp: 825 });
	});

	it('0 is a rate at every step', () => {
		const exempt = { id: 'r-ex', name: 'Exempt', rateBp: 0 };
		expect(
			resolveTaxRate(
				{ name: 'Tea', taxRate: exempt, taxRateBp: 825 },
				{ defaultTaxRate: TAX, taxRateBp: 825 }
			)
		).toEqual({ id: 'r-ex', name: 'Exempt', rateBp: 0 });
		expect(
			resolveTaxRate(
				{ name: 'Tea', taxRate: null, taxRateBp: 0 },
				{ defaultTaxRate: TAX, taxRateBp: 825 }
			)
		).toEqual({ id: null, name: null, rateBp: 0 });
		expect(
			resolveTaxRate(
				{ name: 'Tea', taxRate: null, taxRateBp: null },
				{ defaultTaxRate: exempt, taxRateBp: 825 }
			)
		).toEqual({ id: 'r-ex', name: 'Exempt', rateBp: 0 });
		expect(
			resolveTaxRate(
				{ name: 'Tea', taxRate: null, taxRateBp: null },
				{ defaultTaxRate: null, taxRateBp: 0 }
			)
		).toEqual({ id: null, name: null, rateBp: 0 });
	});

	it('throws naming the item when nothing is set', () => {
		expect(() =>
			resolveTaxRate(
				{ name: 'Tea', taxRate: null, taxRateBp: null },
				{ defaultTaxRate: null, taxRateBp: null }
			)
		).toThrow(/tax rate.*Tea|Tea.*tax rate/);
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

	// menu-and-printing T-16: a category is optional on the dashboard now.
	it('puts an item with no category under Other', () => {
		const m = menu({
			categories: [{ id: 'c1', name: 'One', sortOrder: 0 }],
			items: [item({ id: 'water', categoryId: null }), item({ id: 'tea', categoryId: 'c1' })]
		});
		const tabs = itemsByCategory(m);
		expect(tabs.map((t) => t.id)).toEqual(['c1', 'other']);
		expect(tabs[0].items.map((i) => i.id)).toEqual(['tea']);
		expect(tabs[1].items.map((i) => i.id)).toEqual(['water']);
	});

	it('returns exactly one tab when no category exists', () => {
		const m = menu({
			categories: [],
			items: [
				item({ id: 'a', categoryId: null, sortOrder: 1 }),
				item({ id: 'b', categoryId: null })
			]
		});
		const tabs = itemsByCategory(m);
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toMatchObject({ id: 'other', name: 'Other' });
		expect(tabs[0].items.map((i) => i.id)).toEqual(['b', 'a']);
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

	it("is the money module's function, re-exported — not a copy", () => {
		expect(formatTaxRate).toBe(moneyFormatTaxRate);
	});
});

// settings-tax-payments-receipt T-19: the check line's tax text — the stored
// number first (e2e/pos-sale.spec.ts asserts `@ 8.00 · tax 10.00%`), then the
// rate's name when the line has one.
describe('lineTaxRateText', () => {
	it('prints the stored number, then the name when the line has one', () => {
		expect(lineTaxRateText({ taxRateBp: 1000, taxRateName: null })).toBe('10.00%');
		expect(lineTaxRateText({ taxRateBp: 1000, taxRateName: 'VAT' })).toBe('10.00% (VAT)');
	});

	it('a line saved by the previous build, with no name key, prints the number alone', () => {
		expect(lineTaxRateText({ taxRateBp: 1000 })).toBe('10.00%');
	});
});

describe('MANDATORY (spec 29) — the till screens hold no number conversion of money', () => {
	const FILES = [
		'src/routes/(pos)/pos/session/+page.svelte',
		'src/routes/(pos)/pos/order/+page.svelte',
		'src/routes/(pos)/pos/pay/+page.svelte',
		'src/routes/(pos)/pos/sales/+page.svelte',
		'src/routes/(pos)/pos/printer/+page.svelte',
		'src/lib/pos/menu-view.ts',
		// The till's shared components print money too (docs/redesign Phase 0), so
		// every file under src/lib/components/pos/ is scanned — a new one is covered
		// without being listed.
		...readdirSync('src/lib/components/pos', { recursive: true, encoding: 'utf8' })
			.filter((f) => f.endsWith('.svelte') || f.endsWith('.ts'))
			.map((f) => `src/lib/components/pos/${f.replaceAll('\\', '/')}`)
	];
	const FORBIDDEN = [
		'parseFloat',
		'.toFixed(',
		'Number(',
		'roundToMinor(',
		'taxOnAmount(',
		'taxOnLine(',
		// T-19: only orders.ts computes the per-rate breakdown; a screen prints it.
		'taxBreakdown('
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
