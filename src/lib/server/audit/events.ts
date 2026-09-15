import type { UserRole } from '../db/schema/users';

// The events this plan emits, as a DISCRIMINATED UNION with the exact shape of
// each one's `details`. Nothing else may be written.
//
// A typed union rather than Record<string, unknown> is the mechanism; "never put
// a password in details" as a comment is only a wish. Later plans EXTEND this
// union — they do not widen it to accept arbitrary objects.
export type AuditEvent =
	| { event: 'restaurant.registered'; details: { restaurantName: string; timeZone: string } }
	| { event: 'user.created'; details: { role: UserRole; displayName: string } }
	| { event: 'login.success'; details: { email: string } }
	| { event: 'login.failed'; details: { email: string; reason: 'bad_password' } }
	| { event: 'login.locked_out'; details: { email: string; failedCount: number } }
	| { event: 'login.rejected_locked'; details: { email: string } }
	| { event: 'logout'; details: Record<string, never> }
	| {
			event: 'settings.updated';
			details: { changes: Record<string, { old: unknown; new: unknown }> };
	  }
	| { event: 'user.password_reset_by_operator'; details: { via: 'cli' } }
	// ── POS access (tasks/pos-access-and-menu T-14) ─────────────────────────────
	// THESE SHAPES ARE THE CONTRACT; every consumer quotes them verbatim.
	//
	// Every key survives assertNoSecrets, which throws on any details key matching
	// /pass|pin|token|hash|secret|cookie|authorization/i — inside the action's own
	// transaction, so a bad key would roll back the very lockout it was recording.
	// Hence `failedCount` (never failedPinCount), `lockedForMs` (never minutes, and
	// matching the PIN verifier's PIN_LOCKOUT_MS), and `deviceCode` (never a token).
	//
	// pos.pin.failed's failedCount is the running count AFTER this attempt, and 0
	// when the attempt was refused because the employee was already locked (the
	// verifier zeroes the counter when it sets the lock). Its reason has exactly
	// two values: an unknown, foreign or inactive employee id writes NO audit row
	// at all — the row would be about nobody, and audit_log can never be pruned.
	//
	// The device-sourced rows (pos.pin.* and pos.device.registered) also fill
	// audit_log.device_id and client_op_id, through writeAudit's optional fields.
	// What does not exist yet is a queued-operation REPLAY: nothing in this plan
	// flushes a sync queue, because this till cannot sell.
	| { event: 'pos.device.registered'; details: { deviceCode: string; label: string } }
	| { event: 'pos.device.revoked'; details: { deviceCode: string; label: string } }
	| { event: 'pos.pin.success'; details: { deviceCode: string; role: UserRole } }
	| {
			event: 'pos.pin.failed';
			details: { deviceCode: string; reason: 'bad_pin' | 'rejected_locked'; failedCount: number };
	  }
	| {
			event: 'pos.pin.locked_out';
			details: { deviceCode: string; failedCount: number; lockedForMs: number };
	  }
	| { event: 'employee.created'; details: { role: UserRole; displayName: string } }
	| { event: 'employee.pin_set'; details: { role: UserRole } }
	| { event: 'employee.deactivated'; details: { role: UserRole; displayName: string } };

export type AuditEventName = AuditEvent['event'];

/**
 * Every event name at RUN time — a TypeScript union cannot be iterated. The
 * `satisfies` rejects a name that is not in the union; the assertion below
 * rejects a union member missing from this list. Existing nine first.
 */
export const AUDIT_EVENT_NAMES = [
	'restaurant.registered',
	'user.created',
	'login.success',
	'login.failed',
	'login.locked_out',
	'login.rejected_locked',
	'logout',
	'settings.updated',
	'user.password_reset_by_operator',
	'pos.device.registered',
	'pos.device.revoked',
	'pos.pin.success',
	'pos.pin.failed',
	'pos.pin.locked_out',
	'employee.created',
	'employee.pin_set',
	'employee.deactivated'
] as const satisfies readonly AuditEventName[];

type AssertTrue<T extends true> = T;

/**
 * Fails to COMPILE if a union member is missing from AUDIT_EVENT_NAMES: the
 * conditional resolves to `false`, which AssertTrue's constraint rejects.
 * Exported so the linter does not flag it as unused.
 */
export type _NoMissingAuditEventNames = AssertTrue<
	Exclude<AuditEventName, (typeof AUDIT_EVENT_NAMES)[number]> extends never ? true : false
>;
