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
	| { event: 'user.password_reset_by_operator'; details: { via: 'cli' } };

export type AuditEventName = AuditEvent['event'];
