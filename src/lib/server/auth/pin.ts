import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { users, type UserRole } from '../db/schema/users';
import { writeAudit } from '../audit';
import { verifyPin } from '../../pin';

// SERVER-SIDE PIN VERIFICATION AND LOCKOUT (spec 7): PINs are 4–6 digits stored
// only as slow salted hashes, and after 5 wrong attempts the employee is locked
// out for 5 minutes and an audit event is logged.
//
// Modelled on loginWithPassword in ./login.ts, with two deliberate differences:
//   - NO THROTTLE. /login is a public email-and-password endpoint and needs a
//     per-IP bucket in front of its hashing. This call is reachable only from a
//     REGISTERED device — the PIN route proves the device cookie first — so spec
//     7's rule applies unmodified.
//   - IT OPENS NO TRANSACTION. It takes the caller's, exactly as writeAudit and
//     the device functions do: the counter update, the lock and the audit row
//     must commit together with whatever else the request does, and the PIN
//     route's idempotency lookup and its unique-violation retry path need the
//     whole attempt inside one transaction that route controls.
//
// It NEVER THROWS for a failed PIN. Drizzle's node-postgres session catches a
// thrown error, issues rollback and rethrows — which would roll back the very
// counter increment and audit row the failure exists to write, so the lockout
// would silently not exist while every unit test of verifyPin still passed. A
// wrong PIN, an unknown employee and a lockout are ordinary return values; only
// a genuine programming error throws.
//
// The PIN lockout pair (failed_pin_count, pin_locked_until) is SEPARATE from the
// password lockout pair, and this module never reads or writes the latter: five
// wrong PINs typed at the counter must not lock the owner out of the dashboard.

export const MAX_FAILED_PIN_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 5 * 60 * 1000;

/**
 * A real hashPin output over a random six-digit value nobody knows — printed
 * nowhere and kept nowhere — so an unknown employee id costs the same time as a
 * wrong PIN, exactly as login.ts does with DUMMY_PHC. A dummy cheaper than a
 * real verify would restore the timing difference it exists to remove. It is not
 * a usable credential.
 */
const DUMMY_PIN_PHC =
	'$pbkdf2-sha256$i=600000$uJn6vUy1SLryI0NRyuFEOw$c1V9x25AIdbkaSFMhDzIioGtDHqXRON9TrSui8+WWQY';

export type PinAttemptInput = { restaurantId: string; employeeId: string; pin: string };
export type PinAttemptContext = {
	deviceId: string;
	deviceCode: string;
	/** T-07's idempotency key, carried onto every audit row this call writes. */
	clientOpId: string | null;
	ip: string | null;
	userAgent: string | null;
	now?: Date;
};
export type PosEmployeeIdentity = { id: string; displayName: string; role: UserRole };
export type PinAttemptResult =
	| { ok: true; employee: PosEmployeeIdentity }
	| { ok: false; reason: 'invalid' }
	| { ok: false; reason: 'locked'; retryAfterMs: number };

/**
 * Verify an employee's PIN on a registered device, inside the CALLER's
 * transaction. This function writes every audit row for the attempt — the route
 * writes none — because only this function knows whether an attempt was the
 * fifth, and the route's idempotency lookup expects exactly one row per
 * client_op_id.
 */
export async function verifyEmployeePin(
	tx: DbTx,
	input: PinAttemptInput,
	ctx: PinAttemptContext
): Promise<PinAttemptResult> {
	const now = ctx.now ?? new Date();

	// FOR UPDATE so two concurrent attempts cannot both read a count of 4 and both
	// write 5. Columns named explicitly — never the whole users row, for the reason
	// the Principal comment in ./session.ts gives.
	const rows = await tx
		.select({
			id: users.id,
			restaurantId: users.restaurantId,
			role: users.role,
			displayName: users.displayName,
			isActive: users.isActive,
			pinHash: users.pinHash,
			failedPinCount: users.failedPinCount,
			pinLockedUntil: users.pinLockedUntil
		})
		.from(users)
		.where(and(eq(users.id, input.employeeId), eq(users.restaurantId, input.restaurantId)))
		.for('update')
		.limit(1);
	const user = rows[0];

	// No such employee, another restaurant's, deactivated, or no PIN set: spend the
	// same time, write NO audit row, and answer byte for byte like a wrong PIN, so
	// an employee id cannot be probed by timing or by response. No row on purpose:
	// it would be about nobody, and audit_log can never be pruned. A retry carrying
	// the same clientOpId finds no row to replay and simply runs again — still a
	// no-op, because no counter moved and no row exists either time.
	if (!user || !user.isActive || user.pinHash === null) {
		await verifyPin(input.pin, DUMMY_PIN_PHC);
		return { ok: false, reason: 'invalid' };
	}

	// Every row below carries the device, the op id, the request context and the
	// attempt's own time, and is written with THIS transaction handle.
	const common = {
		restaurantId: user.restaurantId,
		subjectUserId: user.id,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		deviceId: ctx.deviceId,
		clientOpId: ctx.clientOpId,
		occurredAt: now
	};

	if (user.pinLockedUntil && user.pinLockedUntil.getTime() > now.getTime()) {
		// Already locked: the hash is not even checked. failedCount is 0 because
		// setting the lock zeroed the stored counter — it is the stored count, not a
		// running tally of refusals. Performed by nobody.
		await writeAudit(tx, {
			...common,
			actorUserId: null,
			event: 'pos.pin.failed',
			details: { deviceCode: ctx.deviceCode, reason: 'rejected_locked', failedCount: 0 }
		});
		return {
			ok: false,
			reason: 'locked',
			retryAfterMs: user.pinLockedUntil.getTime() - now.getTime()
		};
	}

	const correct = await verifyPin(input.pin, user.pinHash);

	if (!correct) {
		const failedCount = user.failedPinCount + 1;
		if (failedCount >= MAX_FAILED_PIN_ATTEMPTS) {
			// RESET the counter when setting the lock. A counter that kept climbing
			// would make `=== 5` never fire again after one warm-up cycle, and `>= 5`
			// would re-lock on every later miss — stricter than spec 7, punishing an
			// employee who mistypes once. Five fresh misses are the price of each lock.
			await tx
				.update(users)
				.set({
					failedPinCount: 0,
					pinLockedUntil: new Date(now.getTime() + PIN_LOCKOUT_MS),
					updatedAt: now
				})
				.where(eq(users.id, user.id));
			await writeAudit(tx, {
				...common,
				actorUserId: null,
				event: 'pos.pin.locked_out',
				details: { deviceCode: ctx.deviceCode, failedCount, lockedForMs: PIN_LOCKOUT_MS }
			});
			// The attempt that SETS the lock already answers "locked", for the full
			// lockout: the till shows its countdown at once, and a retry of this very
			// attempt — replayed from its pos.pin.locked_out row as 423 — answers the
			// same thing the original did.
			return { ok: false, reason: 'locked', retryAfterMs: PIN_LOCKOUT_MS };
		} else {
			await tx
				.update(users)
				.set({ failedPinCount: failedCount, updatedAt: now })
				.where(eq(users.id, user.id));
			await writeAudit(tx, {
				...common,
				actorUserId: null,
				event: 'pos.pin.failed',
				details: { deviceCode: ctx.deviceCode, reason: 'bad_pin', failedCount }
			});
		}
		return { ok: false, reason: 'invalid' };
	}

	await tx
		.update(users)
		.set({ failedPinCount: 0, pinLockedUntil: null, updatedAt: now })
		.where(eq(users.id, user.id));
	await writeAudit(tx, {
		...common,
		actorUserId: user.id,
		event: 'pos.pin.success',
		details: { deviceCode: ctx.deviceCode, role: user.role }
	});
	return { ok: true, employee: { id: user.id, displayName: user.displayName, role: user.role } };
}
