import { describe, it, expect } from 'vitest';
import {
	CASHIER_KEYS,
	WAITER_KEYS,
	ALL_KEYS,
	POS_KEYS,
	OWNER_KEYS,
	DEFAULT_ROLES,
	PERMISSION_LABELS,
	isPosPermissionKey
} from './keys';
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

describe('POS keys and default roles', () => {
	it('POS_KEYS has exactly ten entries and none starts with admin.', () => {
		expect(POS_KEYS).toHaveLength(10);
		expect(POS_KEYS.every((k) => k.startsWith('pos.'))).toBe(true);
		expect(POS_KEYS.some((k) => k.startsWith('admin.'))).toBe(false);
		expect([...POS_KEYS]).toEqual([...CASHIER_KEYS, ...WAITER_KEYS]);
	});

	it('DEFAULT_ROLES seeds Cashier and Waiter with their exact keys', () => {
		expect(DEFAULT_ROLES[0].name).toBe('Cashier');
		expect(DEFAULT_ROLES[0].permissionKeys).toEqual(CASHIER_KEYS);
		expect(DEFAULT_ROLES[1].name).toBe('Waiter');
		expect(DEFAULT_ROLES[1].permissionKeys).toEqual(WAITER_KEYS);
	});

	it('PERMISSION_LABELS has a non-empty label for every POS_KEYS entry', () => {
		for (const key of POS_KEYS) {
			expect(PERMISSION_LABELS[key], `missing label for ${key}`).toBeDefined();
			expect(PERMISSION_LABELS[key].trim().length).toBeGreaterThan(0);
		}
	});

	it('isPosPermissionKey accepts valid POS keys and rejects non-POS keys or non-strings', () => {
		expect(isPosPermissionKey('pos.sell')).toBe(true);
		expect(isPosPermissionKey('pos.transfer_table')).toBe(true);
		expect(isPosPermissionKey('admin.settings')).toBe(false);
		expect(isPosPermissionKey('pos.sel')).toBe(false);
		expect(isPosPermissionKey('')).toBe(false);
		expect(isPosPermissionKey(null)).toBe(false);
		expect(isPosPermissionKey(undefined)).toBe(false);
		expect(isPosPermissionKey(123)).toBe(false);
		expect(isPosPermissionKey({})).toBe(false);
	});
});

describe('owner grant and permissions', () => {
	it('the owner holds every key defined anywhere, including all ten POS keys', () => {
		for (const key of ALL_KEYS) {
			expect(hasPermission(principal('owner'), key), `owner is missing ${key}`).toBe(true);
		}
		expect(OWNER_KEYS.length).toBe(ALL_KEYS.length);
	});

	it('the owner grant is an array, not a wildcard', () => {
		expect(Array.isArray(OWNER_KEYS)).toBe(true);
		expect(OWNER_KEYS).toContain('pos.sell');
		expect(OWNER_KEYS).toContain('admin.settings');
	});

	it('a non-owner principal holds no key at all synchronously', () => {
		for (const role of ['staff'] as const) {
			for (const key of ALL_KEYS) {
				expect(hasPermission(principal(role), key), `${role} should hold no key`).toBe(false);
			}
		}
	});

	it('an anonymous caller holds nothing', () => {
		for (const key of ALL_KEYS) {
			expect(hasPermission(null, key)).toBe(false);
		}
	});
});
