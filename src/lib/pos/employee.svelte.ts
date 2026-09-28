// The signed-in employee state. UI convenience only — the server re-checks
// the employee on every op (T-16, T-21); nothing here may be the reason a
// request is trusted (invariant 8). No $effect, no $derived (this module runs
// outside any component and under the server compilation in tests where
// neither exists).
//
// The mirror lives in sessionStorage (per tab; dies with it), never
// localStorage (invariant 12). It holds no PIN, no hash, no cookie.

import type { CachedEmployee } from './store';

/** The PR #11 cached shape MINUS pinPhc and isActive. The hash is NEVER copied here. */
export type SignedInEmployee = {
	id: string;
	displayName: string;
	isOwner: boolean;
	roleName: string;
	permissions: string[];
};

/** The one reactive value. A $state box because a reassigned $state variable
 * cannot be exported from a module; screens read `signedIn.current`. */
export const signedIn = $state<{ current: SignedInEmployee | null }>({ current: null });

const MIRROR_KEY = 'matcami_pos_employee';
const TOUCH_THROTTLE_MS = 5_000;
let lastActiveAt = 0;
let lastMirrorWriteAt = 0;

export function fromCachedEmployee(cached: CachedEmployee): SignedInEmployee {
	return {
		id: cached.id,
		displayName: cached.displayName,
		isOwner: cached.isOwner,
		roleName: cached.roleName,
		permissions: [...cached.permissions]
	};
}

function readMirror(): unknown | null {
	try {
		if (typeof sessionStorage === 'undefined') return null;
		const raw = sessionStorage.getItem(MIRROR_KEY);
		if (raw === null) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function writeMirror(value: object): void {
	try {
		if (typeof sessionStorage === 'undefined') return;
		sessionStorage.setItem(MIRROR_KEY, JSON.stringify(value));
	} catch {
		/* private window / blocked storage */
	}
}

function clearMirror(): void {
	try {
		if (typeof sessionStorage === 'undefined') return;
		sessionStorage.removeItem(MIRROR_KEY);
	} catch {
		/* ignore */
	}
}

export function signIn(employee: SignedInEmployee, now = Date.now()): void {
	signedIn.current = {
		id: employee.id,
		displayName: employee.displayName,
		isOwner: employee.isOwner,
		roleName: employee.roleName,
		permissions: [...employee.permissions]
	};
	lastActiveAt = now;
	lastMirrorWriteAt = now;
	writeMirror({ ...employee, lastActiveAt: now });
}

export function touch(now = Date.now()): void {
	if (signedIn.current === null) return;
	lastActiveAt = now;
	if (now - lastMirrorWriteAt >= TOUCH_THROTTLE_MS) {
		writeMirror({ ...(signedIn.current as SignedInEmployee), lastActiveAt: now });
		lastMirrorWriteAt = now;
	}
}

export function signOut(): void {
	signedIn.current = null;
	lastActiveAt = 0;
	lastMirrorWriteAt = 0;
	clearMirror();
}

function isValidMirror(value: unknown): value is SignedInEmployee & { lastActiveAt: number } {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== 'string' || typeof v.displayName !== 'string') return false;
	if (typeof v.roleName !== 'string' || typeof v.isOwner !== 'boolean') return false;
	if (!Array.isArray(v.permissions)) return false;
	if (!(v.permissions as unknown[]).every((p) => typeof p === 'string')) return false;
	if (typeof v.lastActiveAt !== 'number' || !Number.isFinite(v.lastActiveAt)) return false;
	return true;
}

export function restoreFromMirror(
	idleSeconds: number | null,
	now = Date.now()
): SignedInEmployee | null {
	if (idleSeconds === null) {
		signedIn.current = null;
		lastActiveAt = 0;
		lastMirrorWriteAt = 0;
		clearMirror();
		return null;
	}
	const raw = readMirror();
	if (raw === null || !isValidMirror(raw)) {
		signedIn.current = null;
		lastActiveAt = 0;
		lastMirrorWriteAt = 0;
		clearMirror();
		return null;
	}
	if (now - raw.lastActiveAt > idleSeconds * 1_000) {
		signedIn.current = null;
		lastActiveAt = 0;
		lastMirrorWriteAt = 0;
		clearMirror();
		return null;
	}
	const employee: SignedInEmployee = {
		id: raw.id,
		displayName: raw.displayName,
		isOwner: raw.isOwner,
		roleName: raw.roleName,
		permissions: [...(raw.permissions as string[])]
	};
	signedIn.current = employee;
	lastActiveAt = now;
	lastMirrorWriteAt = now;
	writeMirror({ ...employee, lastActiveAt: now });
	return employee;
}

export function hasPermission(key: string): boolean {
	return signedIn.current?.permissions.includes(key) ?? false;
}

export function lastActiveAtForTest(): number {
	return lastActiveAt;
}
