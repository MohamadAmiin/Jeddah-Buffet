import type { AuditEventName } from '$lib/server/audit/events';

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
	'employee.updated': 'Employee changed',
	'employee.deactivated': 'Employee deactivated',
	'employee.reactivated': 'Employee reactivated',
	'employee.lockout_cleared': 'Employee PIN lockout cleared',
	'role.created': 'Role created',
	'role.updated': 'Role changed',
	'role.archived': 'Role archived',
	'menu.price_changed': 'Menu price changed'
};
