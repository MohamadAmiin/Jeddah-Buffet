// checkEmployee — the single-shot permission check for device-sourced ops.
//
// Callers (tasks/pos-sales):
//   validateSale (T-18)   with ['pos.sell', 'pos.payment'] for sale.complete
//   handleOp     (T-21)   with ['pos.payment'] for session.open and session.close
//                         (assumption 6: reuse pos.payment; no new key coined)
//   pin.login and sale.abandoned are facts and never call this.
//
// A failure on a cash sale or a session open becomes a SOFT flag carried on
// the recorded row; on a card/mobile sale or a session close it becomes a
// 403. The consequence is the CALLER'S decision by tender, never this file's.
//
// Never throws for a failed check — every failure is a return value. This
// function runs inside the payment transaction; a thrown error would roll
// back the very sale it is checking.

import { and, eq } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import type { PermissionKey } from './keys';
import { permissionsForUser } from './roles';
import { users } from '../db/schema/users';

export type EmployeeCheckFailure =
	'employee_unknown' | 'employee_inactive' | 'employee_not_permitted';

export type EmployeeCheck = { ok: true } | { ok: false; reason: EmployeeCheckFailure };

export async function checkEmployee(
	database: Executor,
	restaurantId: string,
	userId: string,
	keys: readonly PermissionKey[]
): Promise<EmployeeCheck> {
	// Explicit column selection — never select() the whole row, which carries
	// password_hash and pin_hash.
	const rows = await database
		.select({ id: users.id, isActive: users.isActive })
		.from(users)
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.limit(1);
	if (rows.length === 0) return { ok: false, reason: 'employee_unknown' };
	if (rows[0].isActive === false) return { ok: false, reason: 'employee_inactive' };

	// permissionsForUser returns ALL_KEYS for role='owner' and the union of the
	// live role's keys for staff; an EMPTY set for an unknown or inactive user
	// (steps 2 and 3 already covered those, which is why they run first).
	const held = await permissionsForUser(database, restaurantId, userId);
	for (const key of keys) {
		if (!held.has(key)) return { ok: false, reason: 'employee_not_permitted' };
	}
	return { ok: true };
}
