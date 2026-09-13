import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import type { Executor } from './session';
import { restaurants } from '../db/schema/restaurants';
import { users } from '../db/schema/users';
import { writeAudit } from '../audit';
import { onRestaurantCreated, isValidTimeZone, canonicalTimeZone } from '../restaurants';
import { hashPassword } from './password';
import { createSession } from './session';
import { consume } from './throttle';

/**
 * A constant this module owns, so two simultaneous registrations serialise.
 *
 * pg_advisory_XACT_lock releases at the end of the transaction, which is what we
 * want. Do NOT use pg_advisory_lock: it is session-scoped and, on a pooled
 * connection, leaks a held lock onto whoever checks that connection out next —
 * the pool in use never resets session state between checkouts.
 */
const REGISTRATION_LOCK_KEY = 4_814_233_001;

/**
 * True only when ZERO restaurants exist.
 *
 * There is NO environment variable that re-opens this. Additional restaurants are
 * created by scripts/create-restaurant.ts (T-25), which calls registerRestaurant
 * below with no HTTP surface at all. A flag that re-exposes an unauthenticated
 * account-creating endpoint is one forgotten variable away from public signup
 * with none of public signup's guards.
 */
export async function isRegistrationOpen(tx: Executor): Promise<boolean> {
	const result = await tx.execute<{ n: number }>(sql`select count(*)::int as n from restaurants`);
	return result.rows[0].n === 0;
}

/** Constant-time compare that does not leak length through an early return. */
function tokensMatch(submitted: string, expected: string): boolean {
	const a = Buffer.from(submitted, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.byteLength !== b.byteLength) return false;
	return timingSafeEqual(a, b);
}

export type RegisterInput = {
	restaurantName: string;
	timeZone: string;
	ownerDisplayName: string;
	email: string;
	password: string;
	setupToken: string;
};

export type RegisterContext = {
	ip: string | null;
	userAgent: string | null;
	now?: Date;
	/**
	 * The expected token. Defaults to process.env.SETUP_TOKEN; the route passes the
	 * value env.ts validated. Injected so this module stays importable — and
	 * testable — without $env/dynamic/private.
	 */
	expectedSetupToken?: string | null;
	/**
	 * Operator scripts (T-25) set this to bypass the TOKEN gate only — never the
	 * advisory lock, never the uniqueness checks. The caller already holds the
	 * database credentials, so a token would prove nothing.
	 */
	bypassSetupToken?: boolean;
	/** Operator scripts also bypass the first-run gate to add a SECOND restaurant. */
	allowAdditionalRestaurant?: boolean;
};

export type RegisterResult =
	| { ok: true; token: string; expiresAt: Date; restaurantId: string; userId: string }
	| {
			ok: false;
			reason: 'closed' | 'bad_token' | 'email_taken' | 'invalid_time_zone' | 'throttled';
			retryAfterMs?: number;
	  };

export async function registerRestaurant(
	db: Db,
	input: RegisterInput,
	ctx: RegisterContext
): Promise<RegisterResult> {
	const now = ctx.now ?? new Date();
	const expected =
		ctx.expectedSetupToken !== undefined
			? ctx.expectedSetupToken
			: (process.env.SETUP_TOKEN ?? null);

	// Same throttle as login, keyed by IP.
	if (!ctx.bypassSetupToken) {
		const throttled = consume(`register:${ctx.ip ?? 'unknown'}`, now.getTime());
		if (!throttled.ok) {
			return { ok: false, reason: 'throttled', retryAfterMs: throttled.retryAfterMs };
		}
	}

	// Commit on every branch, exactly as T-13 does. Never signal a rejection by
	// throwing inside the callback.
	return db
		.transaction(async (tx: DbTx) => {
			// Serialise simultaneous submissions BEFORE looking at anything.
			await tx.execute(sql`select pg_advisory_xact_lock(${REGISTRATION_LOCK_KEY})`);

			// RE-CHECK INSIDE THE LOCK. Checking before it is a time-of-check-to-
			// time-of-use bug that lets two restaurants be created.
			if (!ctx.allowAdditionalRestaurant && !(await isRegistrationOpen(tx))) {
				return { ok: false, reason: 'closed' } as const;
			}

			if (!ctx.bypassSetupToken) {
				// If SETUP_TOKEN is unset, registration is NOT open regardless of the
				// restaurant count. A freshly deployed instance must not be claimable by
				// the first stranger who finds its hostname: a new host's TLS certificate
				// appears in Certificate Transparency logs within minutes of issuance, and
				// scanners follow.
				if (!expected || !tokensMatch(input.setupToken, expected)) {
					return { ok: false, reason: 'bad_token' } as const;
				}
			}

			if (!isValidTimeZone(input.timeZone)) {
				return { ok: false, reason: 'invalid_time_zone' } as const;
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

				const passwordHash = await hashPassword(input.password);
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
						timeZone: canonicalTimeZone(input.timeZone)
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
