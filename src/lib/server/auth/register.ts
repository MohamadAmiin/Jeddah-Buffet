import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { writeAudit } from '../audit';
import { onRestaurantCreated, isValidTimeZone, canonicalTimeZone } from '../restaurants';
import { hashPassword } from './password';
import { createSession } from './session';
import { consume } from './throttle';
import { signupAddressKey } from './signup-key';

// PUBLIC SIGN-UP (decided 2026-09-15). Anyone may create a company — a restaurant
// plus its owner — at /register, at any time. There is no setup token and no
// first-run gate: this deliberately reverses the earlier "first run plus
// SETUP_TOKEN" rule, and CLAUDE.md records the decision.
//
// Two callers, two modes. The mode is REQUIRED, so nobody gets one by default:
//   'public'   — the /register form action. Always throttled per address, always
//                subject to the daily cap.
//   'operator' — scripts/create-restaurant.ts, run by someone who already holds the
//                database credentials. No throttle, no cap.
// These used to be two booleans, and the one named for the token (bypassSetupToken)
// silently switched the throttle off too: a public route that reused the CLI's
// flags would have shipped with no rate limit at all. One explicit mode is what
// stops that happening again.

/** New companies one address may create in any rolling 24 hours, in public mode. */
export const SIGNUP_DAILY_CAP = 3;
const SIGNUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * First half of the per-address advisory lock. The two-key (int, int) form lives
 * in a different key space from the one-key bigint form, so it cannot collide
 * with any other advisory lock in the system.
 */
const SIGNUP_LOCK_NAMESPACE = 48_142_330;

export type RegisterMode = 'public' | 'operator';

export type RegisterInput = {
	restaurantName: string;
	timeZone: string;
	ownerDisplayName: string;
	email: string;
	password: string;
};

export type RegisterContext = {
	mode: RegisterMode;
	ip: string | null;
	userAgent: string | null;
	now?: Date;
};

export type RegisterResult =
	| { ok: true; token: string; expiresAt: Date; restaurantId: string; userId: string }
	| {
			ok: false;
			reason: 'email_taken' | 'invalid_time_zone' | 'throttled' | 'signup_limit';
			retryAfterMs?: number;
	  };

export async function registerRestaurant(
	db: Db,
	input: RegisterInput,
	ctx: RegisterContext
): Promise<RegisterResult> {
	const now = ctx.now ?? new Date();
	const signupKey = ctx.mode === 'public' ? signupAddressKey(ctx.ip) : null;

	// The throttle runs BEFORE any hashing — that is the whole point of it.
	if (signupKey !== null) {
		const throttled = consume(`register:${signupKey}`, now.getTime());
		if (!throttled.ok) {
			return { ok: false, reason: 'throttled', retryAfterMs: throttled.retryAfterMs };
		}
	}

	if (!isValidTimeZone(input.timeZone)) {
		return { ok: false, reason: 'invalid_time_zone' };
	}

	// HASH BEFORE THE TRANSACTION OPENS. argon2id costs ~19 MiB and tens of
	// milliseconds. Inside the transaction it would hold one of the pool's ten
	// connections — and, in public mode, the address lock — for that long, and a
	// burst of sign-ups would make every company's login, dashboard and till queue
	// for a connection. An attempt that later fails on a taken email wastes one
	// hash and nothing else.
	const passwordHash = await hashPassword(input.password);

	// Commit on every branch. Never signal a rejection by throwing inside the
	// callback — except EmailTakenError, which must roll the inserts back.
	return db
		.transaction(async (tx: DbTx) => {
			if (signupKey !== null) {
				// Serialise sign-ups from ONE address, so two simultaneous submissions
				// cannot both read "2 so far" and both commit. Different addresses never
				// wait on each other. pg_advisory_XACT_lock releases at commit or rollback;
				// the session-scoped form would leak onto a pooled connection.
				await tx.execute(
					sql`select pg_advisory_xact_lock(${SIGNUP_LOCK_NAMESPACE}::int, hashtext(${signupKey}::text))`
				);

				// Counted from the audit log, which is append-only and survives restarts —
				// an in-memory counter would hand every address a fresh allowance on each
				// deploy. The partial index that keeps this cheap as audit_log grows lands
				// in its own migration AFTER feat/pos-access-and-menu merges: Drizzle skips
				// any migration older than the newest one already applied.
				const since = new Date(now.getTime() - SIGNUP_WINDOW_MS);
				const counted = await tx.execute<{ n: number }>(sql`
					select count(*)::int as n
					from audit_log
					where event = 'restaurant.registered'
					  and details ->> 'signupKey' = ${signupKey}
					  and occurred_at > ${since}
				`);
				if (counted.rows[0].n >= SIGNUP_DAILY_CAP) {
					return { ok: false, reason: 'signup_limit' } as const;
				}
			}

			// Generate the id in APPLICATION CODE rather than letting the database
			// default supply it: the rows that follow reference it, and a future
			// row-level-security WITH CHECK policy cannot be satisfied by an id the
			// database has not returned yet.
			const restaurantId = randomUUID();
			const email = input.email.trim().toLowerCase();

			try {
				await tx.insert(restaurants).values({
					id: restaurantId,
					name: input.restaurantName,
					createdAt: now,
					updatedAt: now
				});

				await onRestaurantCreated(tx, restaurantId, {
					restaurantName: input.restaurantName,
					timeZone: input.timeZone
				});

				const [owner] = await tx
					.insert(users)
					.values({
						restaurantId,
						role: 'owner',
						displayName: input.ownerDisplayName,
						email,
						passwordHash,
						createdAt: now,
						updatedAt: now
					})
					.returning({ id: users.id });

				await writeAudit(tx, {
					restaurantId,
					actorUserId: owner.id,
					subjectUserId: null,
					event: 'restaurant.registered',
					details: {
						restaurantName: input.restaurantName,
						timeZone: canonicalTimeZone(input.timeZone),
						signupKey
					},
					ip: ctx.ip,
					userAgent: ctx.userAgent,
					occurredAt: now
				});

				await writeAudit(tx, {
					restaurantId,
					actorUserId: owner.id,
					subjectUserId: owner.id,
					event: 'user.created',
					details: { role: 'owner', displayName: input.ownerDisplayName },
					ip: ctx.ip,
					userAgent: ctx.userAgent,
					occurredAt: now
				});

				const { token, expiresAt } = await createSession(tx, owner.id, now);

				return { ok: true, token, expiresAt, restaurantId, userId: owner.id } as const;
			} catch (error) {
				// The lower(email) unique index is what decides a duplicate — never a
				// pre-check with a select, which races. Catch THAT constraint by name and
				// let anything else propagate.
				const constraint = (error as { cause?: { constraint?: string }; constraint?: string })
					?.cause?.constraint;
				if (constraint === 'users_email_lower_unique') {
					// Re-thrown so the transaction rolls back the restaurant and settings
					// rows too; the caller sees a clean email_taken.
					throw new EmailTakenError();
				}
				throw error;
			}
		})
		.catch((error: unknown) => {
			if (error instanceof EmailTakenError) {
				return { ok: false, reason: 'email_taken' } as const;
			}
			throw error;
		});
}

/** Internal marker so a duplicate email rolls the whole registration back cleanly. */
class EmailTakenError extends Error {
	constructor() {
		super('email taken');
		this.name = 'EmailTakenError';
	}
}
