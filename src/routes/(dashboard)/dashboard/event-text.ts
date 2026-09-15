import type { AuditEventName } from '$lib/server/audit/events';

// One sentence per audit event, for the overview's recent-activity list.
//
// Typed as a TOTAL Record over the event union, so a future event nobody gives a
// sentence to is a compile error rather than a dotted name on the owner's screen.
// It lives in its own file, not inside +page.svelte, so event-text.test.ts can
// hold it to AUDIT_EVENT_NAMES — a stale entry for a removed event fails there.
export const EVENT_TEXT: Record<AuditEventName, string> = {
	'restaurant.registered': 'Restaurant registered',
	'user.created': 'Account created',
	'login.success': 'Signed in',
	'login.failed': 'Failed sign-in attempt',
	'login.locked_out': 'Account locked after repeated failures',
	'login.rejected_locked': 'Sign-in refused while locked',
	logout: 'Signed out',
	'settings.updated': 'Settings changed',
	'user.password_reset_by_operator': 'Password reset from the command line',
	'pos.device.registered': 'POS device registered',
	'pos.device.revoked': 'POS device revoked',
	'pos.pin.success': 'Signed in at the POS',
	'pos.pin.failed': 'Failed POS sign-in attempt',
	'pos.pin.locked_out': 'Employee locked out at the POS after repeated failures',
	'employee.created': 'Employee added',
	'employee.pin_set': 'Employee PIN set',
	'employee.deactivated': 'Employee deactivated'
};
