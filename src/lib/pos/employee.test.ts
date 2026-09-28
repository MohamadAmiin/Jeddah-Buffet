import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	fromCachedEmployee,
	hasPermission,
	lastActiveAtForTest,
	restoreFromMirror,
	signIn,
	signOut,
	signedIn,
	touch,
	type SignedInEmployee
} from './employee.svelte';

const T0 = Date.parse('2026-09-28T10:00:00Z');
const MIRROR_KEY = 'matcami_pos_employee';

function fakeStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
		removeItem: (k: string) => {
			map.delete(k);
		},
		clear: () => map.clear()
	};
}

const employee: SignedInEmployee = {
	id: 'e-1',
	displayName: 'Amina',
	isOwner: false,
	roleName: 'Cashier',
	permissions: ['pos.sell', 'pos.payment']
};

beforeEach(() => {
	vi.stubGlobal('sessionStorage', fakeStorage());
	signOut();
});

describe('signIn + restoreFromMirror', () => {
	it('restores within the idle limit and rewrites lastActiveAt', () => {
		signIn(employee, T0);
		// Simulate a reload — the state box is a $state proxy; assign null via `as`
		// so tsc doesn't narrow the box to never for the rest of the test.
		(signedIn as { current: SignedInEmployee | null }).current = null;
		const restored = restoreFromMirror(120, T0 + 119_000);
		expect(restored).not.toBeNull();
		expect(restored?.id).toBe('e-1');
		expect(signedIn.current).not.toBeNull();
		const mirror = JSON.parse(sessionStorage.getItem(MIRROR_KEY) as string) as {
			lastActiveAt: number;
		};
		expect(mirror.lastActiveAt).toBe(T0 + 119_000);
	});

	it('past the limit returns null and clears the mirror', () => {
		signIn(employee, T0);
		expect(restoreFromMirror(120, T0 + 120_001)).toBeNull();
		expect(signedIn.current).toBeNull();
		expect(sessionStorage.getItem(MIRROR_KEY)).toBeNull();
	});

	it('exactly at the limit still restores (> is the rule)', () => {
		signIn(employee, T0);
		expect(restoreFromMirror(120, T0 + 120_000)).not.toBeNull();
	});

	it('idleSeconds null never restores', () => {
		signIn(employee, T0);
		expect(restoreFromMirror(null, T0 + 1)).toBeNull();
		expect(sessionStorage.getItem(MIRROR_KEY)).toBeNull();
	});

	it('a malformed mirror returns null and clears it', () => {
		sessionStorage.setItem(MIRROR_KEY, '{not json');
		expect(restoreFromMirror(120, T0)).toBeNull();
		expect(sessionStorage.getItem(MIRROR_KEY)).toBeNull();

		sessionStorage.setItem(MIRROR_KEY, JSON.stringify({ id: 'e-1' }));
		expect(restoreFromMirror(120, T0)).toBeNull();

		sessionStorage.setItem(
			MIRROR_KEY,
			JSON.stringify({ ...employee, permissions: ['pos.sell', 7], lastActiveAt: T0 })
		);
		expect(restoreFromMirror(120, T0)).toBeNull();
	});
});

describe('touch, signOut, hasPermission', () => {
	it('touch throttles at 5s and updates lastActiveAt in memory', () => {
		signIn(employee, T0);
		touch(T0 + 1_000);
		expect(lastActiveAtForTest()).toBe(T0 + 1_000);
		let mirror = JSON.parse(sessionStorage.getItem(MIRROR_KEY) as string) as {
			lastActiveAt: number;
		};
		expect(mirror.lastActiveAt).toBe(T0);
		touch(T0 + 5_000);
		mirror = JSON.parse(sessionStorage.getItem(MIRROR_KEY) as string) as {
			lastActiveAt: number;
		};
		expect(mirror.lastActiveAt).toBe(T0 + 5_000);
	});

	it('signOut clears state and mirror; touch after does nothing', () => {
		signIn(employee, T0);
		signOut();
		expect(signedIn.current).toBeNull();
		expect(sessionStorage.getItem(MIRROR_KEY)).toBeNull();
		touch(T0 + 1_000);
		expect(sessionStorage.getItem(MIRROR_KEY)).toBeNull();
	});

	it('hasPermission reads the list; owner with no perms returns false', () => {
		expect(hasPermission('pos.sell')).toBe(false);
		signIn(employee, T0);
		expect(hasPermission('pos.sell')).toBe(true);
		expect(hasPermission('pos.void')).toBe(false);
		signOut();
		signIn(
			{ id: 'o-1', displayName: 'Owner', isOwner: true, roleName: 'Owner', permissions: [] },
			T0
		);
		expect(hasPermission('pos.sell')).toBe(false);
	});
});

describe('fromCachedEmployee', () => {
	it('picks the five fields and never copies pinPhc', () => {
		const cached = {
			id: 'e-1',
			displayName: 'Amina',
			isOwner: false,
			roleName: 'Cashier',
			permissions: ['pos.sell'],
			isActive: true,
			pinPhc: '$pbkdf2-sha256$i=600000$X$Y'
		};
		const result = fromCachedEmployee(cached);
		expect(Object.keys(result).sort()).toEqual([
			'displayName',
			'id',
			'isOwner',
			'permissions',
			'roleName'
		]);
		expect(JSON.stringify(result)).not.toContain('pbkdf2');
	});
});

describe('storage that throws', () => {
	it('signIn, touch, signOut and restoreFromMirror survive a throwing storage', () => {
		const throwing = {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('SecurityError');
			},
			removeItem: () => {
				throw new Error('SecurityError');
			},
			clear: () => {}
		};
		vi.stubGlobal('sessionStorage', throwing);
		expect(() => signIn(employee, T0)).not.toThrow();
		expect(() => touch(T0 + 10_000)).not.toThrow();
		expect(() => signOut()).not.toThrow();
		expect(restoreFromMirror(120, T0)).toBeNull();
	});
});
