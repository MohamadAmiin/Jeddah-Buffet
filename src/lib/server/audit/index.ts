import type { RequestEvent } from '@sveltejs/kit';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { desc, eq } from 'drizzle-orm';
import { auditLog } from '../db/schema/audit';
import { users } from '../db/schema/users';
import type { AuditEvent } from './events';

export type { AuditEvent, AuditEventName } from './events';
import type { AuditEventName } from './events';

/** Who did it, who it was about, and where from. */
export type AuditEntry = AuditEvent & {
	/** Required and non-nullable. There is no tenant-less audit row. */
	restaurantId: string;
	/** Who DID it. Null for an unauthenticated or operator-script event. */
	actorUserId: string | null;
	/**
	 * Who it was ABOUT. A failed login is performed by nobody and is about the
	 * owner whose email was tried.
	 */
	subjectUserId: string | null;
	ip: string | null;
	userAgent: string | null;
	/**
	 * The registered till this row came from, or null for a dashboard event.
	 * T-19's idempotency lookup selects on (device_id, client_op_id), so a row
	 * written with a clientOpId and no deviceId can never be matched to its retry.
	 */
	deviceId?: string | null;
	/**
	 * The device-generated idempotency key for the operation that produced this
	 * row, or null when the server originated it. Backed by the partial
	 * UNIQUE (device_id, client_op_id) WHERE client_op_id IS NOT NULL.
	 */
	clientOpId?: string | null;
	/**
	 * Defaults to now. Exists so the offline plan can record a device-time event
	 * without altering a table whose rows cannot be updated.
	 */
	occurredAt?: Date;
};

const SECRET_KEY_PATTERN = /pass|pin|token|hash|secret|cookie|authorization/i;

/**
 * Walk `details` at every depth and throw if any KEY looks like a secret.
 *
 * The append-only trigger means a leaked secret in `details` can never be removed
 * without dropping the trigger, which would itself violate invariant 2 — so the
 * only workable defence is refusing to write it in the first place.
 *
 * Walks nested objects and arrays, not just top-level keys: the realistic leak is
 * not `{ password }`, it is somebody passing a whole parsed form body or a whole
 * database row through, where the dangerous key is one level down.
 */
export function assertNoSecrets(details: unknown, path = 'details'): void {
	if (details === null || typeof details !== 'object') return;

	if (Array.isArray(details)) {
		details.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`));
		return;
	}

	for (const [key, value] of Object.entries(details)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			// Names the KEY and its path, never the value.
			throw new Error(
				`Refusing to write an audit row: ${path}.${key} looks like a secret. ` +
					'audit_log is append-only, so a leaked credential could never be removed.'
			);
		}
		assertNoSecrets(value, `${path}.${key}`);
	}
}

/**
 * Write one audit row.
 *
 * Takes the transaction handle as its FIRST parameter and must not open its own:
 * invariant 10's house rule is that the audit row is written in the same
 * transaction as the action it records — either both commit or neither does.
 */
export async function writeAudit(tx: DbTx, entry: AuditEntry): Promise<void> {
	assertNoSecrets(entry.details);

	await tx.insert(auditLog).values({
		restaurantId: entry.restaurantId,
		actorUserId: entry.actorUserId,
		subjectUserId: entry.subjectUserId,
		event: entry.event,
		details: entry.details,
		ip: entry.ip,
		userAgent: entry.userAgent,
		deviceId: entry.deviceId ?? null,
		clientOpId: entry.clientOpId ?? null,
		occurredAt: entry.occurredAt ?? new Date()
	});
}

/**
 * Extract `ip` and `userAgent` from a SvelteKit request.
 *
 * BEHIND NGINX this returns the PROXY's address unless ADDRESS_HEADER and
 * XFF_DEPTH are configured for adapter-node — see T-26, which sets them. An audit
 * log that records 127.0.0.1 for every event cannot identify who attacked an
 * account, and it degrades silently, which is why it is written down here.
 */
export function requestContext(event: RequestEvent): {
	ip: string | null;
	userAgent: string | null;
} {
	let ip: string | null = null;
	try {
		ip = event.getClientAddress();
	} catch {
		// getClientAddress throws when the adapter cannot determine an address.
		ip = null;
	}
	return { ip, userAgent: event.request.headers.get('user-agent') };
}

// NOTHING here reads audit rows. This plan writes them and does not display
// them; an owner-facing audit view is a later plan, and it will need its own
// permission key.

/** One row of the activity feed, already narrowed to what a screen may show. */
export type ActivityEntry = {
	event: AuditEventName;
	/** The acting person's display name, or null for an unauthenticated event. */
	actor: string | null;
	occurredAt: Date;
};

/**
 * The most recent audit rows for ONE restaurant, newest first.
 *
 * Scoped to `restaurantId` in the query itself, never filtered in the caller:
 * there is no tenant-less audit row and there must be no tenant-less audit read.
 *
 * It returns `event`, the actor's display name and the timestamp — and nothing
 * else. `details` is deliberately NOT returned: it carries per-event payloads
 * (the email a login was attempted with, the old and new values of a settings
 * change) that a dashboard has no reason to broadcast, and the narrower the read,
 * the less there is to leak when a later event type is added to the union.
 *
 * Takes `Executor` (Db | DbTx), the type this codebase already uses for reads, so
 * it works on the plain handle and inside a transaction alike. Nothing here writes,
 * and invariant 2 keeps these rows append-only regardless.
 */
export async function recentActivity(
	database: Executor,
	restaurantId: string,
	limit = 8
): Promise<ActivityEntry[]> {
	const rows = await database
		.select({
			event: auditLog.event,
			actor: users.displayName,
			occurredAt: auditLog.occurredAt
		})
		.from(auditLog)
		.leftJoin(users, eq(auditLog.actorUserId, users.id))
		.where(eq(auditLog.restaurantId, restaurantId))
		.orderBy(desc(auditLog.occurredAt))
		.limit(limit);

	return rows.map((r) => ({
		event: r.event as AuditEventName,
		actor: r.actor,
		occurredAt: r.occurredAt
	}));
}
