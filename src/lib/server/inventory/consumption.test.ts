import { describe, expect, it } from 'vitest';
import type { SaleLine, SaleLineModifier } from '../../sync-ops';
import { qty, type Qty } from '../../money/quantity';
import { aggregateConsumption, type RecipeIndex } from './consumption';

// Spec 15's examples in grams (thousandths): a burger is 1 bun, 150 g meat and
// 30 g tomato; "No tomato" is −30 g; "Extra cheese" is +1 slice.

function recipe(entries: Record<string, bigint>): Map<string, Qty> {
	return new Map(Object.entries(entries).map(([id, q]) => [id, qty(q)]));
}

const recipes: RecipeIndex = {
	items: new Map([
		['burger', recipe({ bun: 1000n, meat: 150000n, tomato: 30000n })],
		['cheeseburger', recipe({ bun: 1000n, meat: 150000n, cheese: 1000n })]
	]),
	modifiers: new Map([
		['no-tomato', recipe({ tomato: -30000n })],
		['extra-cheese', recipe({ cheese: 1000n })]
	])
};

function mod(modifierId: string): SaleLineModifier {
	return { modifierId, modifierName: modifierId, priceDeltaMinor: '0' };
}

function line(
	menuItemId: string,
	quantity: number,
	modifiers: string[] = [],
	lineNo = 1
): SaleLine {
	return {
		lineId: `line-${lineNo}`,
		lineNo,
		menuItemId,
		itemName: menuItemId,
		quantity,
		unitPriceMinor: '800',
		taxRateBp: 1000,
		discountMinor: '0',
		modifiers: modifiers.map(mod)
	};
}

function asObject(map: Map<string, Qty>): Record<string, bigint> {
	return Object.fromEntries(map);
}

describe('aggregateConsumption', () => {
	it('multiplies the item recipe by the line quantity', () => {
		expect(asObject(aggregateConsumption([line('burger', 2)], recipes))).toEqual({
			bun: 2000n,
			meat: 300000n,
			tomato: 60000n
		});
	});

	it('"No tomato" removes the tomato entirely', () => {
		const used = aggregateConsumption([line('burger', 2, ['no-tomato'])], recipes);
		expect(used.has('tomato')).toBe(false);
		expect(asObject(used)).toEqual({ bun: 2000n, meat: 300000n });
	});

	it('"No tomato" on an item without tomato is clamped at zero, never negative', () => {
		const used = aggregateConsumption([line('cheeseburger', 1, ['no-tomato'])], recipes);
		expect(used.has('tomato')).toBe(false);
		expect(asObject(used)).toEqual({ bun: 1000n, meat: 150000n, cheese: 1000n });
	});

	it('"Extra cheese" adds to the recipe per unit', () => {
		const used = aggregateConsumption([line('cheeseburger', 3, ['extra-cheese'])], recipes);
		expect(used.get('cheese')).toBe(6000n);
	});

	it('an item with no recipe contributes nothing', () => {
		expect(aggregateConsumption([line('tea', 4)], recipes).size).toBe(0);
	});

	it('an unknown modifier contributes nothing', () => {
		const used = aggregateConsumption([line('burger', 1, ['mystery'])], recipes);
		expect(asObject(used)).toEqual({ bun: 1000n, meat: 150000n, tomato: 30000n });
	});

	it('two lines of the same item add', () => {
		const used = aggregateConsumption(
			[line('burger', 1, [], 1), line('burger', 2, [], 2)],
			recipes
		);
		expect(asObject(used)).toEqual({ bun: 3000n, meat: 450000n, tomato: 90000n });
	});

	it('"No tomato" on one line never cancels the tomato of another line', () => {
		const used = aggregateConsumption(
			[line('burger', 1, ['no-tomato'], 1), line('burger', 1, [], 2)],
			recipes
		);
		expect(used.get('tomato')).toBe(30000n);
	});

	it('a line quantity that is not a safe integer is a programming error', () => {
		expect(() => aggregateConsumption([line('burger', 1.5)], recipes)).toThrow(TypeError);
		expect(() => aggregateConsumption([line('burger', 2 ** 53)], recipes)).toThrow(TypeError);
	});
});
