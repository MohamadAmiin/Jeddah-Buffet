import type { UserRole } from '../db/schema/users';

// ───────────────────────── SPEC 8, VERBATIM ─────────────────────────
// Copied from docs/spec.md section 8. Do not reword, reorder or "tidy" these —
// keys.test.ts asserts them against the spec text, so a drift is a test failure
// rather than a discovery.

/** Spec 8 § Cashier */
export const CASHIER_KEYS = [
	'pos.sell',
	'pos.payment',
	'pos.print_receipt',
	'pos.void_unsent_item',
	'pos.cash_payout'
] as const;

/** Spec 8 § Waiter */
export const WAITER_KEYS = [
	'pos.create_order',
	'pos.view_menu',
	'pos.modify_order',
	'pos.send_to_kitchen',
	'pos.transfer_table'
] as const;

// ────────────────── PLAN-LEVEL EXTENSION, NOT SPEC TEXT ──────────────────
// Spec 8 introduces its list with "For example:" and names NO dashboard keys.
// These are proposed by tasks/restaurant-identity-and-dashboard (T-15) and
// granted to the owner only. src/lib/server/permissions/README.md records that
// extending the list "is a plan's call, never coined mid-task" — so if you need a
// key that is neither here nor in your task's Do: steps, stop and ask.
//
// Only admin.settings is used by this plan. The rest exist so T-21's navigation
// can render an entry per key, and so each later plan finds its key already named
// rather than coining one mid-task.
export const ADMIN_KEYS = [
	'admin.settings',
	'admin.menu',
	'admin.inventory',
	'admin.purchases',
	'admin.expenses',
	'admin.reports',
	'admin.employees',
	'admin.devices'
] as const;

export type PermissionKey =
	(typeof CASHIER_KEYS)[number] | (typeof WAITER_KEYS)[number] | (typeof ADMIN_KEYS)[number];

/**
 * The owner gets EVERY key, ENUMERATED — never a wildcard.
 *
 * Enumerating means adding a key is a deliberate decision about who receives it,
 * rather than something the owner silently inherits. The POS keys are included on
 * purpose: spec 7 gives the owner a POS PIN used to approve sensitive actions, so
 * an owner who could not hold pos.sell would be unable to act at the till the day
 * the POS exists.
 */
export const ROLE_KEYS: Record<UserRole, readonly PermissionKey[]> = {
	owner: [...CASHIER_KEYS, ...WAITER_KEYS, ...ADMIN_KEYS],
	cashier: [...CASHIER_KEYS],
	waiter: [...WAITER_KEYS]
};

/**
 * NO DATABASE TABLES FOR ROLES AND PERMISSIONS. Spec 3 lists "Roles, Permissions"
 * among the things PostgreSQL will contain, and this code map plus the users.role
 * column satisfies that. Editable RBAC tables are the "advanced RBAC" CLAUDE.md's
 * do-not-build list excludes: they would need their own management screens, their
 * own audit events and their own migration story before a single permission could
 * be checked.
 */
export const ALL_KEYS: readonly PermissionKey[] = [...CASHIER_KEYS, ...WAITER_KEYS, ...ADMIN_KEYS];
