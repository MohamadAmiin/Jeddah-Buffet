import type { UserRole } from '../db/schema/users';

// The events this plan emits, as a DISCRIMINATED UNION with the exact shape of
// each one's `details`. Nothing else may be written.
//
// A typed union rather than Record<string, unknown> is the mechanism; "never put
// a password in details" as a comment is only a wish. Later plans EXTEND this
// union — they do not widen it to accept arbitrary objects.
export type AuditEvent =
	| {
			event: 'restaurant.registered';
			details: { restaurantName: string; timeZone: string; signupKey: string | null };
	  }
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
	| { event: 'pos.device.registered'; details: { deviceCode: string; label: string } }
	| { event: 'pos.device.revoked'; details: { deviceCode: string; label: string } }
	| { event: 'pos.pin.success'; details: { deviceCode: string; roleName: string } }
	| {
			event: 'pos.pin.failed';
			details: {
				deviceCode: string;
				reason: 'bad_pin' | 'rejected_locked';
				failedCount: number;
			};
	  }
	| {
			event: 'pos.pin.locked_out';
			details: { deviceCode: string; failedCount: number; lockedForMs: number };
	  }
	| { event: 'employee.created'; details: { roleName: string; displayName: string } }
	| { event: 'employee.pin_set'; details: { roleName: string } }
	| {
			event: 'employee.updated';
			details: { changes: Record<string, { old: unknown; new: unknown }> };
	  }
	| { event: 'employee.deactivated'; details: { roleName: string; displayName: string } }
	| { event: 'employee.reactivated'; details: { roleName: string; displayName: string } }
	| {
			event: 'employee.lockout_cleared';
			details: { displayName: string; failedCount: number; wasLocked: boolean };
	  }
	| { event: 'role.created'; details: { name: string; permissionKeys: string[] } }
	| { event: 'role.updated'; details: { changes: Record<string, { old: unknown; new: unknown }> } }
	| { event: 'role.archived'; details: { name: string } }
	| {
			event: 'menu.price_changed';
			details: {
				target: 'item' | 'modifier';
				targetId: string;
				name: string;
				oldPriceMinor: string;
				newPriceMinor: string;
			};
	  };

export type AuditEventName = AuditEvent['event'];

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
	'employee.updated',
	'employee.deactivated',
	'employee.reactivated',
	'employee.lockout_cleared',
	'role.created',
	'role.updated',
	'role.archived',
	'menu.price_changed'
] as const satisfies readonly AuditEventName[];

type AssertTrue<T extends true> = T;

export type _NoMissingAuditEventNames = AssertTrue<
	Exclude<AuditEventName, (typeof AUDIT_EVENT_NAMES)[number]> extends never ? true : false
>;
