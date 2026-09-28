import { describe, expect, it } from 'vitest';
import type { DbTx } from '../db/client';
import type { SaleLine } from '../../sync-ops';
import { consumeForSale } from './consume';

describe('consumeForSale (documented no-op)', () => {
	it('returns empty movements and 0n cogs for a two-line sale', async () => {
		const lines: SaleLine[] = [
			{
				lineId: 'line-1',
				lineNo: 1,
				menuItemId: 'menu-1',
				itemName: 'Tea',
				quantity: 1,
				unitPriceMinor: '850',
				taxRateBp: 825,
				discountMinor: '0',
				modifiers: []
			},
			{
				lineId: 'line-2',
				lineNo: 2,
				menuItemId: 'menu-2',
				itemName: 'Coffee',
				quantity: 2,
				unitPriceMinor: '900',
				taxRateBp: 825,
				discountMinor: '0',
				modifiers: [{ modifierId: 'mod-1', modifierName: 'Extra shot', priceDeltaMinor: '50' }]
			}
		];
		const tx = {} as DbTx;
		const result = await consumeForSale(tx, {
			restaurantId: 'r-1',
			orderId: 'o-1',
			lines
		});
		expect(result.movements).toEqual([]);
		expect(result.movements).toHaveLength(0);
		expect(result.cogsMinor).toBe(0n);
		expect(typeof result.cogsMinor).toBe('bigint');
	});

	it('accepts an empty lines array', async () => {
		const result = await consumeForSale({} as DbTx, {
			restaurantId: 'r-1',
			orderId: 'o-1',
			lines: []
		});
		expect(result).toEqual({ movements: [], cogsMinor: 0n });
	});
});
