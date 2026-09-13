import { describe, it, expect } from 'vitest';
import { CASHIER_KEYS, WAITER_KEYS, ADMIN_KEYS, ALL_KEYS, ROLE_KEYS } from './keys';
import { hasPermission } from './index';
import type { Principal } from '../auth/session';

function principal(role: Principal['role']): Principal {
	return {
		userId: 'u',
		restaurantId: 'r',
		role,
		displayName: 'Someone',
		email: null,
		sessionId: 's',
		expiresAt: new Date(Date.now() + 1000)
	};
}

describe('spec 8 key lists, copied verbatim', () => {
	// Written as literals transcribed from docs/spec.md section 8, so drift is a
	// test failure rather than a discovery.
	it('the cashier list equals spec 8 exactly', () => {
		expect([...CASHIER_KEYS]).toEqual([
			'pos.sell',
			'pos.payment',
			'pos.print_receipt',
			'pos.void_unsent_item',
			'pos.cash_payout'
		]);
	});

	it('the waiter list equals spec 8 exactly', () => {
		expect([...WAITER_KEYS]).toEqual([
			'pos.create_order',
			'pos.view_menu',
			'pos.modify_order',
			'pos.send_to_kitchen',
			'pos.transfer_table'
		]);
	});

	it('spec 8 defines exactly ten POS keys', () => {
		expect(CASHIER_KEYS.length + WAITER_KEYS.length).toBe(10);
	});
});

describe('role grants', () => {
	it('the owner holds every key defined anywhere, including all ten POS keys', () => {
		for (const key of ALL_KEYS) {
			expect(hasPermission(principal('owner'), key), `owner is missing ${key}`).toBe(true);
		}
		expect(ROLE_KEYS.owner.length).toBe(ALL_KEYS.length);
	});

	it('the owner grant is enumerated, not a wildcard', () => {
		// A wildcard would make adding a key an accident rather than a decision.
		expect(Array.isArray(ROLE_KEYS.owner)).toBe(true);
		expect(ROLE_KEYS.owner).toContain('pos.sell');
		expect(ROLE_KEYS.owner).toContain('admin.settings');
	});

	it('a waiter does not hold pos.payment', () => {
		expect(hasPermission(principal('waiter'), 'pos.payment')).toBe(false);
	});

	it('a cashier does not hold pos.transfer_table', () => {
		expect(hasPermission(principal('cashier'), 'pos.transfer_table')).toBe(false);
	});

	it('no role other than owner holds any admin.* key', () => {
		for (const key of ADMIN_KEYS) {
			expect(hasPermission(principal('cashier'), key), `cashier holds ${key}`).toBe(false);
			expect(hasPermission(principal('waiter'), key), `waiter holds ${key}`).toBe(false);
			expect(hasPermission(principal('owner'), key)).toBe(true);
		}
	});

	it('an anonymous caller holds nothing', () => {
		for (const key of ALL_KEYS) {
			expect(hasPermission(null, key)).toBe(false);
		}
	});

	it('every key belongs to at least one role', () => {
		const granted = new Set(Object.values(ROLE_KEYS).flat());
		for (const key of ALL_KEYS) {
			expect(granted.has(key), `${key} is granted to nobody`).toBe(true);
		}
	});
});
