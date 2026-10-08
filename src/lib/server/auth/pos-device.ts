import { randomBytes, createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import type { DbTx } from '../db/client';
import type { Executor } from './session';
import { posDevices } from '../db/schema/pos-devices';
import { users } from '../db/schema/users';

// POS DEVICE REGISTRATION AND REVOCATION (spec 7).
//
// The owner signs in ON each device once; the server issues a long-lived device
// cookie, and from then on PIN login is accepted only from a registered device.
// A restaurant may register AS MANY tills as it has counters (decision of
// 2026-10-08, departing from spec 31's one-device MVP): each gets its own code —
// POS1, POS2, … — and so its own gap-free invoice sequence and its own shift. The
// owner can revoke any of them from the dashboard. This module owns the device
// token, its hash, the device-code allocator and the cookie — and nothing else:
//
//   - It writes NO audit rows. Registration and revocation are composite
//     route-level actions, and the routes call writeAudit(tx, …) with the same tx
//     they hand in here, which is what keeps invariant 10's "same transaction as
//     the action" true.
//   - It opens NO transaction. Every writer takes the caller's DbTx, so a route can
//     register the device, destroy the owner's dashboard session on that browser
//     and write the audit row in one all-or-nothing commit.
//   - It never deletes a pos_devices row. Revocation is the revoked_at /
//     revoked_by_user_id stamp; audit_log.device_id references the row RESTRICT,
//     and an old row is the only record that a device once existed.
//
// node:crypto is correct HERE, under src/lib/server. The isomorphic PIN module in
// src/lib/pin must never import it.

export const DEVICE_COOKIE = 'matcami_pos_device';

// 400 days — the ceiling browsers now clamp cookie lifetimes to, and "long-lived"
// in spec 7's sense. A device row never expires on its own: the lifetime lives in
// the cookie.
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

// The printed invoice prefix (spec 6: POS1-000001). pos_devices' CHECK allows 1–8
// uppercase letters and digits, so 'POS' plus five digits is the ceiling.
const DEVICE_CODE_PATTERN = /^POS(\d+)$/;
const MAX_DEVICE_NUMBER = 99_999;

/**
 * 32 random bytes, base64url — the session.ts idiom exactly. This value goes in
 * the device cookie and is never stored.
 */
export function generateDeviceToken(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * The lowercase hex SHA-256 of the token — what pos_devices.token_hash holds. A
 * database leak then yields hashes, not usable devices.
 */
export function deviceTokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Register a POS device for a restaurant and return its raw token ONCE.
 *
 * The contract: `actorUserId` (the owner doing it), `label`, and a `deviceCode`
 * that is RETURNED, never passed in — a client that could pick the code could
 * pick the invoice-number prefix. `expiresAt` is now + the cookie lifetime, so the
 * caller can set the cookie and show the date without recomputing it.
 *
 * It does NOT refuse, revoke or supersede an existing active device — a second,
 * third or tenth till is an ordinary registration. The ONE refusal, a browser that
 * already carries a live device cookie, lives in the registration route, where a
 * person can be told why: registering over that cookie would leave the row it
 * named live but orphaned.
 */
export async function registerDevice(
	tx: DbTx,
	args: { restaurantId: string; actorUserId: string; label: string; now?: Date }
): Promise<{ deviceId: string; deviceCode: string; token: string; expiresAt: Date }> {
	const now = args.now ?? new Date();

	// Belt and braces beside the route's requireOwner: spec 7 ties registration to
	// the owner as a PERSON, so the database is asked, not the session.
	const [actor] = await tx
		.select({ role: users.role, restaurantId: users.restaurantId })
		.from(users)
		.where(eq(users.id, args.actorUserId))
		.limit(1);
	if (!actor || actor.role !== 'owner' || actor.restaurantId !== args.restaurantId) {
		throw new Error('registerDevice requires the owner of this restaurant');
	}

	// The next UNUSED code. Revoked rows are read too, deliberately: a code is
	// BURNED once used, because reusing POS1 would let POS1-000001 name two
	// different sales from two different devices. Filtering on revoked_at here
	// would hand POS1 straight back out, and the insert would then die on the full
	// (restaurant_id, device_code) unique index — never "fix" that by making the
	// index partial. A concurrent registration racing to the same number loses on
	// that index with 23505 and rolls the caller back: the loud failure intended.
	const codes = await tx
		.select({ deviceCode: posDevices.deviceCode })
		.from(posDevices)
		.where(eq(posDevices.restaurantId, args.restaurantId));
	let highest = 0;
	for (const { deviceCode } of codes) {
		const match = DEVICE_CODE_PATTERN.exec(deviceCode);
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	const next = highest + 1;
	if (next > MAX_DEVICE_NUMBER) {
		throw new Error('This restaurant has no device code left to allocate');
	}
	const deviceCode = `POS${next}`;

	const token = generateDeviceToken();
	const [row] = await tx
		.insert(posDevices)
		.values({
			restaurantId: args.restaurantId,
			deviceCode,
			label: args.label,
			tokenHash: deviceTokenHash(token),
			registeredByUserId: args.actorUserId,
			registeredAt: now
		})
		.returning({ id: posDevices.id });

	return {
		deviceId: row.id,
		deviceCode,
		token,
		expiresAt: new Date(now.getTime() + DEVICE_COOKIE_MAX_AGE_SECONDS * 1000)
	};
}

/**
 * Revoke a device: stamp revoked_at AND revoked_by_user_id together, in one
 * UPDATE … RETURNING scoped by id, restaurant and "not yet revoked", so the read
 * and the write cannot disagree and a null actor can never be written.
 *
 * Returns the stamped row's code and label (the route puts both in its audit
 * details without re-querying), or null when nothing was stamped — no such
 * device, another restaurant's device, or already revoked.
 */
export async function revokeDevice(
	tx: DbTx,
	args: { deviceId: string; restaurantId: string; actorUserId: string; now?: Date }
): Promise<{ deviceCode: string; label: string } | null> {
	const now = args.now ?? new Date();
	const rows = await tx
		.update(posDevices)
		.set({ revokedAt: now, revokedByUserId: args.actorUserId })
		.where(
			and(
				eq(posDevices.id, args.deviceId),
				eq(posDevices.restaurantId, args.restaurantId),
				isNull(posDevices.revokedAt)
			)
		)
		.returning({ deviceCode: posDevices.deviceCode, label: posDevices.label });
	return rows[0] ?? null;
}

/** What the dashboard may see of a device: no token, and no token hash. */
export type RegisteredDevice = {
	id: string;
	deviceCode: string; // 'POS1'
	label: string;
	registeredAt: Date;
	lastSeenAt: Date | null;
	revokedAt: Date | null;
};

/**
 * EVERY device the restaurant ever registered, live ones first and newest first
 * within each group, revoked rows included. An EXPLICIT column list that leaves
 * the token hash out, because the caller is a dashboard page and SvelteKit
 * serialises its load data into the HTML and __data.json. Revoked rows come back
 * with revokedAt set: the caller decides what that means — see hasLiveDevice —
 * and a revoked code is still the explanation of every invoice that carries it.
 */
export async function listDevices(
	database: Executor,
	restaurantId: string
): Promise<RegisteredDevice[]> {
	return database
		.select({
			id: posDevices.id,
			deviceCode: posDevices.deviceCode,
			label: posDevices.label,
			registeredAt: posDevices.registeredAt,
			lastSeenAt: posDevices.lastSeenAt,
			revokedAt: posDevices.revokedAt
		})
		.from(posDevices)
		.where(eq(posDevices.restaurantId, restaurantId))
		.orderBy(sql`${posDevices.revokedAt} is not null`, desc(posDevices.registeredAt));
}

/**
 * THE one definition of "this restaurant has a registered till": at least one
 * device that has not been revoked. /device and the /dashboard checklist both use
 * it, so the two screens cannot disagree. The newest row alone cannot answer this
 * any more — revoking the newest till while an older one is live must not report
 * the restaurant as unregistered.
 */
export function hasLiveDevice(devices: readonly Pick<RegisteredDevice, 'revokedAt'>[]): boolean {
	return devices.some((device) => device.revokedAt === null);
}

/**
 * Resolve a device cookie to its device, or null.
 *
 * A REVOKED device resolves to null — that single condition is what makes spec
 * 7's dashboard revocation enforceable rather than decorative. Nothing is written
 * on this path (no last_seen_at touch): it runs on every POS request, and a write
 * here is contention nobody asked for.
 */
export async function validateDeviceToken(
	database: Executor,
	token: string
): Promise<{ deviceId: string; restaurantId: string; deviceCode: string } | null> {
	const rows = await database
		.select({
			deviceId: posDevices.id,
			restaurantId: posDevices.restaurantId,
			deviceCode: posDevices.deviceCode
		})
		.from(posDevices)
		.where(and(eq(posDevices.tokenHash, deviceTokenHash(token)), isNull(posDevices.revokedAt)))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Set the device cookie. Only path, maxAge and (optionally) expires are passed:
 * httpOnly, sameSite and Secure are SvelteKit's defaults — httpOnly: true,
 * sameSite: 'lax', and Secure for every origin except http://localhost, which
 * browsers exempt by specification. Never weaken the Secure flag to make local
 * testing easier. The path is '/', not '/pos', because the endpoints that read
 * this cookie live at /api/pos/*, outside the /pos prefix.
 */
export function setDeviceCookie(cookies: Cookies, token: string, expiresAt?: Date): void {
	cookies.set(DEVICE_COOKIE, token, {
		path: '/',
		maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
		...(expiresAt ? { expires: expiresAt } : {})
	});
}

export function deleteDeviceCookie(cookies: Cookies): void {
	cookies.delete(DEVICE_COOKIE, { path: '/' });
}
