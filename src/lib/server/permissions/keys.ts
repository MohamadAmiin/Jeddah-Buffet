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

export const POS_KEYS = [...CASHIER_KEYS, ...WAITER_KEYS] as const;
export type PosPermissionKey = (typeof POS_KEYS)[number];

/** The owner's grant, ENUMERATED (never a wildcard): every key, POS and admin. */
export const OWNER_KEYS: readonly PermissionKey[] = [
	...CASHIER_KEYS,
	...WAITER_KEYS,
	...ADMIN_KEYS
];

export function isPosPermissionKey(value: unknown): value is PosPermissionKey {
	return typeof value === 'string' && (POS_KEYS as readonly string[]).includes(value);
}

/** Seeded for every restaurant; editable afterwards. Names are reserved nowhere except 'owner'. */
export const DEFAULT_ROLES = [
	{ name: 'Cashier', permissionKeys: CASHIER_KEYS },
	{ name: 'Waiter', permissionKeys: WAITER_KEYS }
] as const;

export const RESERVED_ROLE_NAMES: readonly string[] = ['owner']; // compared lower-cased, trimmed

export const ROLE_NAME_MAX = 60;

/** Human labels for the roles page; the KEY is the contract, the label is copy. */
export const PERMISSION_LABELS: Record<PosPermissionKey, string> = {
	'pos.sell': 'Sell: ring up items',
	'pos.payment': 'Take payment',
	'pos.print_receipt': 'Print receipts',
	'pos.void_unsent_item': 'Remove items not yet sent to the kitchen',
	'pos.cash_payout': 'Cash pay-out, up to the limit',
	'pos.create_order': 'Create orders',
	'pos.view_menu': 'View the menu',
	'pos.modify_order': 'Modify orders',
	'pos.send_to_kitchen': 'Send orders to the kitchen',
	'pos.transfer_table': 'Transfer tables'
};

/**
 * Roles are owner-editable rows, per restaurant (CLAUDE.md "Decisions already made",
 * 2026-09-16). Staff permissions are stored in role_permissions and resolved from
 * the database in T-06. The owner's grant is OWNER_KEYS above, in code.
 */
export const ALL_KEYS: readonly PermissionKey[] = [...CASHIER_KEYS, ...WAITER_KEYS, ...ADMIN_KEYS];
