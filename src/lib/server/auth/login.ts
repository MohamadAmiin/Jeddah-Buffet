import { sql, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { users } from '../db/schema/users';
import { writeAudit } from '../audit';
import { verifyPassword, needsRehash, hashPassword } from './password';
import { createSession } from './session';
import { consume } from './throttle';

// SPEC 7 defines "after 5 wrong attempts, locked out for 5 minutes" for PINs
// entered on a REGISTERED POS DEVICE. Applying it to a public email-and-password
// endpoint is this plan's HOUSE RULE (00-overview assumption 3), and the naive
// form is a weapon: anyone who knows the owner's email can send five wrong
// passwords every five minutes and keep the only owner account locked out
// forever. Two changes make it safe, and both are required — the per-IP throttle
// in front, and a lock an attacker cannot renew indefinitely (see step 5).
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 5 * 60 * 1000;

/**
 * A real PHC string with the SAME parameters as a live hash, so an unknown email
 * costs the same time as a wrong password. A dummy that is cheaper than a real
 * verify restores the timing difference it exists to remove.
 *
 * It is the hash of a random string nobody knows; it is not a usable credential.
 */
const DUMMY_PHC =
	'$argon2id$v=19$m=19456,t=2,p=1$EktaimJf4olJxEDQTptLgQ$DxmERz8ffb5S7nxCFAYUH1qs9ULV6Wpl1vaYJeFB/hI';

export type LoginInput = { email: string; password: string };

export type LoginContext = {
	ip: string | null;
	userAgent: string | null;
	now?: Date;
};

export type LoginResult =
	| { ok: true; token: string; expiresAt: Date; restaurantId: string; userId: string }
	| { ok: false; reason: 'invalid' | 'locked' | 'throttled'; retryAfterMs?: number };

/**
 * Authenticate an owner by email and password.
 *
 * THE TRANSACTION COMMITS ON EVERY BRANCH, INCLUDING FAILURE. Never signal a
 * failed login by throwing inside the callback: Drizzle's node-postgres session
 * catches any thrown error, issues `rollback` and rethrows — so a thrown "invalid
 * password" would roll back the very rows the failure was supposed to write.
 * failed_password_count would stay at zero forever, no login.failed audit row
 * would ever exist, and the five-attempt lockout would silently not exist, while
 * every unit test of verifyPassword still passed. The callback returns a result
 * object; the route turns it into an HTTP response AFTER the commit.
 */
export async function loginWithPassword(
	db: Db,
	input: LoginInput,
	ctx: LoginContext
): Promise<LoginResult> {
	const now = ctx.now ?? new Date();
	const email = input.email.trim().toLowerCase();

	// The throttle runs BEFORE any hashing — that is the whole point of it.
	const throttleKey = `login:${ctx.ip ?? 'unknown'}`;
	const throttled = consume(throttleKey, now.getTime());
	if (!throttled.ok) {
		return { ok: false, reason: 'throttled', retryAfterMs: throttled.retryAfterMs };
	}

	return db.transaction(async (tx) => {
		// FOR UPDATE so two concurrent attempts cannot both read a count of 4 and
		// both write 5.
		const rows = await tx
			.select({
				id: users.id,
				restaurantId: users.restaurantId,
				role: users.role,
				email: users.email,
				passwordHash: users.passwordHash,
				isActive: users.isActive,
				failedPasswordCount: users.failedPasswordCount,
				passwordLockedUntil: users.passwordLockedUntil
			})
			.from(users)
			.where(sql`lower(${users.email}) = ${email}`)
			.for('update')
			.limit(1);

		const user = rows[0];

		// Unknown email, non-owner, or deactivated: spend the same time, write NO
		// audit row, and say nothing specific.
		//
		// No audit row on purpose: a tenant-less audit row has no restaurant to
		// belong to and would be visible to nobody. Unknown-email attempts are the
		// throttle's business and the server log's, not the audit log's.
		if (!user || user.role !== 'owner' || !user.isActive || !user.passwordHash) {
			await verifyPassword(DUMMY_PHC, input.password);
			return { ok: false, reason: 'invalid' } as const;
		}

		if (user.passwordLockedUntil && user.passwordLockedUntil.getTime() > now.getTime()) {
			await writeAudit(tx, {
				restaurantId: user.restaurantId,
				actorUserId: null, // performed by nobody
				subjectUserId: user.id, // about the owner whose account was targeted
				event: 'login.rejected_locked',
				details: { email },
				ip: ctx.ip,
				userAgent: ctx.userAgent,
				occurredAt: now
			});
			return { ok: false, reason: 'locked' } as const;
		}

		const correct = await verifyPassword(user.passwordHash, input.password);

		if (!correct) {
			const failedCount = user.failedPasswordCount + 1;

			if (failedCount >= MAX_FAILED_ATTEMPTS) {
				// RESET the counter when setting the lock. This is not a detail: if the
				// counter kept climbing, a condition written as `=== 5` would never fire
				// again and the account could be guessed at full speed forever after one
				// warm-up cycle; written as `>= 5` it would re-lock on every subsequent
				// miss, which is stricter than spec 7 and locks an owner who mistypes
				// once. Resetting makes five fresh misses the price of each new lock.
				await tx
					.update(users)
					.set({
						failedPasswordCount: 0,
						passwordLockedUntil: new Date(now.getTime() + LOCKOUT_MS),
						updatedAt: now
					})
					.where(eq(users.id, user.id));

				await writeAudit(tx, {
					restaurantId: user.restaurantId,
					actorUserId: null,
					subjectUserId: user.id,
					event: 'login.locked_out',
					details: { email, failedCount },
					ip: ctx.ip,
					userAgent: ctx.userAgent,
					occurredAt: now
				});
			} else {
				await tx
					.update(users)
					.set({ failedPasswordCount: failedCount, updatedAt: now })
					.where(eq(users.id, user.id));

				await writeAudit(tx, {
					restaurantId: user.restaurantId,
					actorUserId: null,
					subjectUserId: user.id,
					event: 'login.failed',
					details: { email, reason: 'bad_password' },
					ip: ctx.ip,
					userAgent: ctx.userAgent,
					occurredAt: now
				});
			}

			return { ok: false, reason: 'invalid' } as const;
		}

		// Success: clear the counter and the lock, re-hash if the cost factor has
		// been raised since, then create the session.
		const update: {
			failedPasswordCount: number;
			passwordLockedUntil: null;
			updatedAt: Date;
			passwordHash?: string;
		} = { failedPasswordCount: 0, passwordLockedUntil: null, updatedAt: now };

		if (needsRehash(user.passwordHash)) {
			update.passwordHash = await hashPassword(input.password);
		}

		await tx.update(users).set(update).where(eq(users.id, user.id));

		const { token, expiresAt } = await createSession(tx, user.id, now);

		await writeAudit(tx, {
			restaurantId: user.restaurantId,
			actorUserId: user.id, // on success, the actor IS the user
			subjectUserId: user.id,
			event: 'login.success',
			details: { email },
			ip: ctx.ip,
			userAgent: ctx.userAgent,
			occurredAt: now
		});

		return {
			ok: true,
			token,
			expiresAt,
			restaurantId: user.restaurantId,
			userId: user.id
		} as const;
	});
}
