import { json, type RequestHandler } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DbTx } from '$lib/server/db/client';
import { auditLog } from '$lib/server/db/schema/audit';
import { users, type UserRole } from '$lib/server/db/schema/users';
import { requestContext } from '$lib/server/audit';
import type { Executor } from '$lib/server/auth/session';
import { requireDevice, type PosDeviceContext } from '$lib/server/auth/pos-context';
import { verifyEmployeePin, type PinAttemptResult } from '$lib/server/auth/pin';

// POST /api/pos/pin — an employee signs in at the registered till (spec 7).
//
// The tenant comes from the DEVICE ROW (requireDevice) and from nowhere else: the
// dashboard tenant on the request is null outside /(dashboard) by design, and a
// restaurantId in the body would be a cross-tenant write.
//
// This route opens the ONE transaction and WRITES NO AUDIT ROW of its own. The
// PIN verifier writes every pos.pin.* row inside it, because only the verifier
// knows whether an attempt was the fifth; a second writer would mean two rows per
// attempt and would break the idempotency lookup below.

const pinSchema = z.object({
	employeeId: z.string().uuid(),
	// Spec 7: 4–6 DIGITS. The PIN never leaves this function: not logged, not
	// echoed, not put in any details, not returned.
	pin: z.string().regex(/^\d{4,6}$/),
	// The device's idempotency key for THIS attempt (invariant 5, spec 6). Optional
	// on the wire — an unkeyed caller simply gets no retry protection — and a UUID,
	// because a key the device can collide with is not a key.
	clientOpId: z.string().uuid().optional()
});

type Outcome =
	| { kind: 'success'; employeeId: string; displayName: string; role: UserRole }
	| { kind: 'invalid' }
	| { kind: 'locked'; retryAfterMs: number };

// THE IDEMPOTENCY KEY, and what makes a retry a no-op.
//
// The till retries a PIN post whose response was lost on a flaky counter
// connection; a second audit row for one typed PIN would be a lie in an
// append-only table. audit_log carries (device_id, client_op_id) with a partial
// UNIQUE for exactly this route, and the verifier stamps both on every row.
//
//   - Inside the transaction and BEFORE verifying, a present clientOpId is looked
//     up. On a hit the verifier is NOT called — no counter moves, no second row is
//     written — and the answer the lost response carried is rebuilt from the row:
//     pos.pin.success -> 200 (name and role re-read, scoped to the device's
//     restaurant); pos.pin.locked_out, and pos.pin.failed with reason
//     'rejected_locked' -> 423 with the remaining lock time recomputed;
//     pos.pin.failed with reason 'bad_pin' -> 401.
//   - With no clientOpId there is nothing to look up and nothing to deduplicate:
//     the attempt runs. That is honest; a silent global lock would make two
//     employees typing PINs at once look like a retry of each other.
//   - Two retries RACING both miss the lookup. The database is the backstop: the
//     loser's commit raises 23505 on audit_log_device_client_op_unique, its whole
//     transaction rolls back (counter increment included), and on that pair alone
//     the answer is rebuilt from the winner's row. Every other error rethrows.
async function replayFor(
	database: Executor,
	device: PosDeviceContext,
	clientOpId: string
): Promise<Outcome | null> {
	const [row] = await database
		.select({
			event: auditLog.event,
			subjectUserId: auditLog.subjectUserId,
			details: auditLog.details
		})
		.from(auditLog)
		.where(and(eq(auditLog.deviceId, device.deviceId), eq(auditLog.clientOpId, clientOpId)))
		.limit(1);
	if (!row) return null;

	if (!row.subjectUserId) return { kind: 'invalid' };
	const [employee] = await database
		.select({
			id: users.id,
			displayName: users.displayName,
			role: users.role,
			pinLockedUntil: users.pinLockedUntil
		})
		.from(users)
		.where(and(eq(users.id, row.subjectUserId), eq(users.restaurantId, device.restaurantId)))
		.limit(1);
	if (!employee) return { kind: 'invalid' };

	const reason = (row.details as { reason?: unknown }).reason;
	if (row.event === 'pos.pin.success') {
		return {
			kind: 'success',
			employeeId: employee.id,
			displayName: employee.displayName,
			role: employee.role
		};
	}
	if (
		row.event === 'pos.pin.locked_out' ||
		(row.event === 'pos.pin.failed' && reason === 'rejected_locked')
	) {
		const lockedUntil = employee.pinLockedUntil?.getTime() ?? 0;
		return { kind: 'locked', retryAfterMs: Math.max(0, lockedUntil - Date.now()) };
	}
	if (row.event === 'pos.pin.failed') return { kind: 'invalid' };

	// Only pos.pin.* rows carry a client op id in this plan; anything else under
	// this device's key is a programming error, not an answer to rebuild.
	throw new Error('An audit row that is not a PIN attempt carries this client op id');
}

function toOutcome(result: PinAttemptResult): Outcome {
	if (result.ok) {
		return {
			kind: 'success',
			employeeId: result.employee.id,
			displayName: result.employee.displayName,
			role: result.employee.role
		};
	}
	return result.reason === 'locked'
		? { kind: 'locked', retryAfterMs: result.retryAfterMs }
		: { kind: 'invalid' };
}

/** The loser of a race on the same key: 23505 on the idempotency index, and nothing else. */
function isDuplicateOpKey(thrown: unknown): boolean {
	// Drizzle wraps the driver's error; walk the cause chain to the pg error.
	let current: unknown = thrown;
	for (let depth = 0; depth < 5 && current; depth++) {
		const e = current as { code?: string; constraint?: string; cause?: unknown };
		if (e.code === '23505' && e.constraint === 'audit_log_device_client_op_unique') return true;
		current = e.cause;
	}
	return false;
}

/**
 * The only three shapes either path can produce. 401 for a wrong PIN AND for an
 * unknown or foreign employee id, byte for byte, so this device cannot be used to
 * enumerate employees. 423 Locked, not 403, so a lockout can never satisfy the
 * permission walk's "no device -> 403" assertion by accident.
 */
function respond(outcome: Outcome): Response {
	switch (outcome.kind) {
		case 'success':
			return json(
				{ employeeId: outcome.employeeId, displayName: outcome.displayName, role: outcome.role },
				{ status: 200 }
			);
		case 'locked':
			return json({ error: 'locked_out', retryAfterMs: outcome.retryAfterMs }, { status: 423 });
		case 'invalid':
			return json({ error: 'invalid_pin' }, { status: 401 });
	}
}

export const POST: RequestHandler = async (event) => {
	// FIRST, before anything else runs: 403 for a missing, unknown or revoked device.
	const device = await requireDevice(event);

	const contentType = event.request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('application/json')) {
		return json({ error: 'unsupported_media_type' }, { status: 415 });
	}
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'invalid_request' }, { status: 400 });
	}
	const parsed = pinSchema.safeParse(body);
	if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 });
	const { employeeId, pin, clientOpId } = parsed.data;

	const { ip, userAgent } = requestContext(event);

	const attempt = async (tx: DbTx): Promise<Outcome> => {
		if (clientOpId) {
			const replay = await replayFor(tx, device, clientOpId);
			if (replay) return replay;
		}
		const result = await verifyEmployeePin(
			tx,
			{ restaurantId: device.restaurantId, employeeId, pin },
			{
				deviceId: device.deviceId,
				deviceCode: device.deviceCode,
				clientOpId: clientOpId ?? null,
				ip,
				userAgent
			}
		);
		return toOutcome(result);
	};

	let outcome: Outcome;
	try {
		outcome = await db.transaction(attempt);
	} catch (thrown) {
		if (!clientOpId || !isDuplicateOpKey(thrown)) throw thrown;
		// A racing retry committed first: answer from the row it wrote.
		const replay = await replayFor(db, device, clientOpId);
		if (!replay) throw thrown;
		outcome = replay;
	}

	// Built AFTER the transaction, from what it returned, so a rolled-back attempt
	// can never have had a success response sent for it.
	return respond(outcome);
};

// NO DASHBOARD SESSION IS CREATED HERE AND NO SESSION COOKIE IS SET. The till's
// employee identity is not a dashboard login, and this plan's till cannot sell,
// so no employee token is issued either. The later plan that lets the till act on
// the server must decide how the employee identity travels with a request; it is
// not decided here, and must not be filled by habit with a session cookie.
