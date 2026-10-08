import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CASH_TENDER_KEY, OFFLINE_REASON, tenderOptions, tenderReason } from './tenders';

// The pay screen's tender list and THE offline rule, by kind
// (tasks/settings-tax-payments-receipt T-22). Pure — no IndexedDB.

const SYNTHETIC_CASH = {
	key: 'cash',
	id: null,
	name: 'Cash',
	kind: 'cash',
	merchantNumber: null,
	icon: 'cash'
};

const CACHED = [
	{ id: 'c1', name: 'Cash', kind: 'cash', merchantNumber: null },
	{ id: 'm1', name: 'EVC Plus', kind: 'mobile', merchantNumber: '61 234 5678' },
	{ id: 'k1', name: 'Visa', kind: 'card', merchantNumber: null },
	{ id: 'm2', name: 'Zaad', kind: 'mobile', merchantNumber: '63 345 6789' }
];

describe('tenderOptions', () => {
	it('offers exactly the synthetic Cash when nothing is cached', () => {
		expect(tenderOptions([])).toEqual([SYNTHETIC_CASH]);
		expect(CASH_TENDER_KEY).toBe('cash');
	});

	it('offers the cached methods in their order, keyed by id, with their icons', () => {
		const options = tenderOptions(CACHED);
		expect(options.map((o) => o.key)).toEqual(['cash', 'm1', 'k1', 'm2']);
		expect(options.map((o) => o.id)).toEqual(['c1', 'm1', 'k1', 'm2']);
		expect(options.map((o) => o.icon)).toEqual(['cash', 'phone', 'card', 'phone']);
		expect(options.map((o) => o.kind)).toEqual(['cash', 'mobile', 'card', 'mobile']);
		expect(options.map((o) => o.name)).toEqual(['Cash', 'EVC Plus', 'Visa', 'Zaad']);
		expect(options[1].merchantNumber).toBe('61 234 5678');
		expect(options[2].merchantNumber).toBeNull();
	});

	it('puts a cash row listed after a mobile row first', () => {
		const options = tenderOptions([CACHED[1], CACHED[0]]);
		expect(options.map((o) => o.key)).toEqual(['cash', 'm1']);
		expect(options[0]).toEqual({ ...SYNTHETIC_CASH, id: 'c1' });
	});

	it('drops a second cash row, a kind it does not know and a repeated id', () => {
		const options = tenderOptions([
			...CACHED,
			{ id: 'c2', name: 'Till 2', kind: 'cash', merchantNumber: null },
			{ id: 'b1', name: 'Bank', kind: 'bank', merchantNumber: '1234' },
			{ id: 'm1', name: 'EVC Plus again', kind: 'mobile', merchantNumber: null },
			{ id: 'c1', name: 'Cash as a card', kind: 'card', merchantNumber: null },
			{ id: 'cash', name: 'Keyed like cash', kind: 'card', merchantNumber: null }
		]);
		expect(options.map((o) => o.key)).toEqual(['cash', 'm1', 'k1', 'm2']);
		expect(options.map((o) => o.name)).toEqual(['Cash', 'EVC Plus', 'Visa', 'Zaad']);
	});

	it('never gives a cash option a merchant number', () => {
		const options = tenderOptions([
			{ id: 'c1', name: 'Cash', kind: 'cash', merchantNumber: '61 000 0000' }
		]);
		expect(options).toEqual([{ ...SYNTHETIC_CASH, id: 'c1' }]);
	});
});

describe('tenderReason — invariant 5, fail closed', () => {
	it('disables card and mobile offline, with the reason in words', () => {
		expect(tenderReason('card', false)).toBe('◆ Cash only while offline');
		expect(tenderReason('mobile', false)).toBe('◆ Cash only while offline');
		expect(OFFLINE_REASON).toBe('◆ Cash only while offline');
	});

	it('never disables cash', () => {
		expect(tenderReason('cash', false)).toBeNull();
	});

	it('disables nothing online', () => {
		expect(tenderReason('cash', true)).toBeNull();
		expect(tenderReason('card', true)).toBeNull();
		expect(tenderReason('mobile', true)).toBeNull();
	});
});

describe('module boundary', () => {
	it('tenders.ts imports nothing', () => {
		const source = readFileSync('src/lib/pos/tenders.ts', 'utf8');
		expect(source).not.toMatch(/^\s*import\s/m);
		expect(source).not.toContain('require(');
	});
});
