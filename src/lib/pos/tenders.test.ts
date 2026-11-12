import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CASH_TENDER_KEY,
	CREDIT_NEEDS_PERMISSION,
	CREDIT_NO_CUSTOMERS,
	OFFLINE_REASON,
	tenderClass,
	tenderOptions,
	tenderReason
} from './tenders';

// The pay screen's tender list and THE offline rule, by kind
// (tasks/settings-tax-payments-receipt T-22). Pure — no IndexedDB.

/** The pay screen's comparisons with the literal 'cash' (see the tripwire below). */
const PAY_PAGE_CASH_COMPARISONS = 7;

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

describe('the Customer credit tender (customer-credit T-15)', () => {
	const CREDIT = { id: 'x1', name: 'Customer credit', kind: 'credit', merchantNumber: null };

	it('is offered LAST, keyed by its id, when the cache holds the credit row', () => {
		const options = tenderOptions([CREDIT, ...CACHED]);
		expect(options.map((o) => o.kind)).toEqual(['cash', 'mobile', 'card', 'mobile', 'credit']);
		expect(options.at(-1)).toEqual({
			key: 'x1',
			id: 'x1',
			name: 'Customer credit',
			kind: 'credit',
			merchantNumber: null,
			icon: 'user-plus'
		});
	});

	it('is not offered when the cache has no credit row (the owner has it switched off)', () => {
		expect(tenderOptions(CACHED).some((o) => o.kind === 'credit')).toBe(false);
	});

	it('drops a second credit row, and never gives it a merchant number', () => {
		const options = tenderOptions([
			{ ...CREDIT, merchantNumber: '61 000 0000' },
			{ ...CREDIT, id: 'x2', name: 'Tabs' }
		]);
		expect(options.filter((o) => o.kind === 'credit')).toEqual([
			{
				key: 'x1',
				id: 'x1',
				name: 'Customer credit',
				kind: 'credit',
				merchantNumber: null,
				icon: 'user-plus'
			}
		]);
	});

	it('is NEVER disabled for being offline: a credit charge is a fact (invariant 5, amended)', () => {
		expect(tenderReason('credit', false)).toBeNull();
		expect(tenderReason('credit', true)).toBeNull();
	});

	it('says why it is dead: no permission, or no customer cached', () => {
		expect(tenderReason('credit', true, { mayTakePayment: false, customersCached: true })).toBe(
			CREDIT_NEEDS_PERMISSION
		);
		expect(tenderReason('credit', false, { mayTakePayment: true, customersCached: false })).toBe(
			CREDIT_NO_CUSTOMERS
		);
		// The credit context never changes the answer for another kind.
		expect(
			tenderReason('cash', false, { mayTakePayment: false, customersCached: false })
		).toBeNull();
		expect(tenderReason('card', false, { mayTakePayment: true, customersCached: true })).toBe(
			OFFLINE_REASON
		);
	});
});

describe('tenderClass — THE fact / request rule', () => {
	it('cash and credit are facts; card and mobile are requests', () => {
		expect(tenderClass('cash')).toBe('fact');
		expect(tenderClass('credit')).toBe('fact');
		expect(tenderClass('card')).toBe('request');
		expect(tenderClass('mobile')).toBe('request');
	});

	it('fails closed on anything it does not know', () => {
		for (const kind of ['cheque', '', 'CASH', null, undefined]) {
			expect(tenderClass(kind)).toBe('request');
		}
	});

	// THE TRIPWIRE. A sale's class — "is it already final?" — must come from
	// tenderClass. A comparison with the literal 'cash' is for what only cash does:
	// the drawer, the keypad, tendered and change. Each file below holds exactly
	// the comparisons listed; a new one anywhere under src/lib/pos or
	// src/routes/(pos) fails here, so it is looked at before it ships.
	it('every comparison with the literal cash is on the allow-list', () => {
		const ALLOWED: Record<string, number> = {
			// The cash row of the cached methods; cash is never disabled.
			'src/lib/pos/tenders.ts': 3,
			// THE TWO DRAWER CLAUSES: only a cash sale, and only a cash customer
			// payment, opens it.
			'src/lib/pos/printing.ts': 2,
			// The CASH / CHANGE lines of a receipt and of a payment receipt.
			'src/lib/pos/receipt.ts': 2,
			// Tendered and change ride on a cash customer payment only.
			'src/lib/pos/customer-payments.ts': 1,
			// Tendered and change exist for cash only.
			'src/lib/pos/orders.ts': 3,
			// The cash keypad, tendered, change, and the drawer on Pay.
			'src/routes/(pos)/pos/pay/+page.svelte': PAY_PAGE_CASH_COMPARISONS,
			// A cash customer payment is taken exactly: tendered = amount, change 0.
			'src/routes/(pos)/pos/customers/+page.svelte': 1
		};
		const found: Record<string, number> = {};
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(path);
				else if (/\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
					const hits = readFileSync(path, 'utf8').match(/[!=]==\s*'cash'/g);
					if (hits) found[path] = hits.length;
				}
			}
		};
		walk('src/lib/pos');
		walk('src/routes/(pos)');
		expect(found).toEqual(ALLOWED);
	});
});

describe('module boundary', () => {
	it('tenders.ts imports nothing', () => {
		const source = readFileSync('src/lib/pos/tenders.ts', 'utf8');
		expect(source).not.toMatch(/^\s*import\s/m);
		expect(source).not.toContain('require(');
	});
});
