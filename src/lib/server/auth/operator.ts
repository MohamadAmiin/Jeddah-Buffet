import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { users } from '../db/schema/users';
import { writeAudit } from '../audit';
import { hashPassword } from './password';
import { invalidateAllForUser } from './session';

/**
 * WHAT THESE PREVENT.
 *
 * There is exactly one owner account per restaurant, employees have no password,
 * and this plan ships no self-service reset. So a forgotten password — or an
 * attacker keeping the account locked — leaves the dashboard unreachable, and the
 * only remedy anyone would reach for is
 *
 *     UPDATE users SET password_hash = '...'
 *
 * typed by whoever holds the database URL. That is a credential change with no
 * audit row, no session invalidation, and a hash produced outside the application
 * that may not even parse. These functions exist so the sanctioned path is easier
 * than the unsanctioned one.
 */

export type OperatorResult =
	| { ok: true; userId: string; restaurantId: string; sessionsRemoved: number }
	| { ok: false; reason: 'not_found' };

/**
 * Reset an owner's password.
 *
 * In ONE transaction: write the new hash, clear the lockout counter and the lock,
 * invalidate every session for that user, and write a
 * user.password_reset_by_operator audit row with actorUserId null (an operator
 * script has no in-app actor) and subjectUserId set to the owner.
 *
 * Never prints or returns the password or the hash.
 */
export async function resetOwnerPassword(
	db: Db,
	email: string,
	newPassword: string
): Promise<OperatorResult> {
	const lowered = email.trim().toLowerCase();

	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				id: users.id,
				restaurantId: users.restaurantId,
				role: users.role
			})
			.from(users)
			.where(sql`lower(${users.email}) = ${lowered}`)
			.for('update')
			.limit(1);

		const user = rows[0];
		if (!user || user.role !== 'owner') {
			return { ok: false, reason: 'not_found' } as const;
		}

		// Hashed through the same module as everything else, so the parameters and
		// the PHC format match — a hash produced by hand outside the application may
		// not parse at all.
		const passwordHash = await hashPassword(newPassword);

		await tx
			.update(users)
			.set({
				passwordHash,
				failedPasswordCount: 0,
				passwordLockedUntil: null,
				updatedAt: new Date()
			})
			.where(eq(users.id, user.id));

		const removed = await tx.execute<{ n: number }>(
			sql`select count(*)::int as n from sessions where user_id = ${user.id}`
		);
		const sessionsRemoved = removed.rows[0].n;

		// Changing a password ends every session.
		await invalidateAllForUser(tx, user.id);

		await writeAudit(tx, {
			restaurantId: user.restaurantId,
			actorUserId: null,
			subjectUserId: user.id,
			event: 'user.password_reset_by_operator',
			details: { via: 'cli' },
			ip: null,
			userAgent: null
		});

		return {
			ok: true,
			userId: user.id,
			restaurantId: user.restaurantId,
			sessionsRemoved
		} as const;
	});
}

// NEITHER SCRIPT DELETES ANYTHING. Deactivating a user is is_active = false, which
// T-12's session validation already honours on the next request; removing a
// restaurant is not an operation this system supports, because audit rows
// reference it under ON DELETE RESTRICT and cannot themselves be removed.
