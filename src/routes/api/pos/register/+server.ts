import { json, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { posDevices } from '$lib/server/db/schema/pos-devices';
import { users } from '$lib/server/db/schema/users';
import { requestContext, writeAudit } from '$lib/server/audit';
import { loginWithPassword } from '$lib/server/auth/login';
import { MAX_PASSWORD_BYTES } from '$lib/server/auth/password';
import {
	DEVICE_COOKIE,
	registerDevice,
	setDeviceCookie,
	validateDeviceToken
} from '$lib/server/auth/pos-device';
import {
	SESSION_COOKIE,
	deleteSessionCookie,
	invalidateSession,
	sessionIdFromToken
} from '$lib/server/auth/session';

// POST /api/pos/register — spec 7: "Owner logs in on the POS device (email +
// password) -> 'Register this device as POS1' -> Server issues a long-lived
// device cookie (HttpOnly, Secure) -> PIN login accepted only from registered
// devices".
//
// The ONE /api route that is not device-guarded: it is public in PUBLIC_ROUTE_IDS
// and authenticates from its BODY, with the owner's email and password, through
// the existing loginWithPassword — which owns the per-IP throttle, the
// constant-time dummy verify, the five-attempt lockout and the login.* audit rows.
// There is no second password check anywhere.
//
// Email AND password, never email alone: an email address is public (printed on
// receipts), and a registered device is exactly what spec 6 ships cached employee
// PIN hashes to.

const registerSchema = z.object({
	email: z.string().trim().toLowerCase().min(1).max(320).email(),
	password: z.string().min(1).max(MAX_PASSWORD_BYTES),
	// A name the owner will recognise in the dashboard's device list.
	label: z.string().trim().min(1).max(60)
	// NO device-code field, and none may ever be added: the code is allocated by
	// registerDevice (the next unused POSn), because a client that could pick the
	// code could later pick the invoice-number prefix. A deviceCode in the body is
	// stripped by zod and ignored.
});

export const POST: RequestHandler = async (event) => {
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
	const parsed = registerSchema.safeParse(body);
	// Echo nothing back — never the password, never the email.
	if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 });
	const { email, password, label } = parsed.data;

	// A LIVE TILL IS NEVER REGISTERED OVER. If this browser already carries a device
	// cookie that resolves to a non-revoked device — of ANY restaurant — the request
	// is refused before a credential is checked. Registering would overwrite that
	// cookie and leave the other restaurant's row live but orphaned: its /device page
	// still showing a till it no longer has, its audit log silent, and its owner
	// answered 409 on re-registering. The one-device check below is scoped to the
	// CALLER's restaurant and cannot see this. The tablet's owner revokes it from
	// their dashboard first; a revoked cookie resolves to null and passes.
	// (Requested by the public-sign-up planning session: once anyone can create an
	// owner account, this is a cross-company device takeover.)
	const presented = event.cookies.get(DEVICE_COOKIE);
	if (presented && (await validateDeviceToken(db, presented))) {
		return json({ error: 'device_already_registered' }, { status: 409 });
	}

	const { ip, userAgent } = requestContext(event);

	// loginWithPassword COMMITS ON EVERY BRANCH, failure included — its own comment
	// explains why. So it is called first and never wrapped in the transaction
	// below: by the time its result is read, counters have moved on failure and a
	// dashboard session row exists on success (deleted again below).
	const result = await loginWithPassword(db, { email, password }, { ip, userAgent });
	if (!result.ok) {
		if (result.reason === 'throttled') {
			return json(
				{ error: 'too_many_attempts' },
				{
					status: 429,
					headers: { 'retry-after': String(Math.ceil((result.retryAfterMs ?? 0) / 1000)) }
				}
			);
		}
		// 'invalid' and 'locked' get ONE body and ONE status, so this endpoint cannot
		// be used to discover which addresses exist, which accounts are locked, or who
		// the owner is. 403, not 401: spec 8's status for "you may not do this".
		return json({ error: 'invalid_credentials' }, { status: 403 });
	}

	// A second layer. loginWithPassword refuses non-owners today; this exists so a
	// later relaxation of it cannot silently turn device registration into a
	// cashier capability. Spec 7 ties registration to the owner as a PERSON.
	const [actor] = await db
		.select({ role: users.role })
		.from(users)
		.where(eq(users.id, result.userId))
		.limit(1);
	if (!actor || actor.role !== 'owner') {
		await invalidateSession(db, sessionIdFromToken(result.token));
		deleteSessionCookie(event.cookies);
		return json({ error: 'invalid_credentials' }, { status: 403 });
	}

	// ONE transaction: refuse a second device, register, audit, and destroy the
	// owner's dashboard sessions on this browser — all or nothing, so a registered
	// device and the owner session that created it can never coexist.
	const outcome = await db.transaction(async (tx) => {
		// Spec 31's MVP is ONE registered POS device, and registerDevice delegates the
		// refusal to this route by name. FOR UPDATE locks any active row against a
		// concurrent revoke-and-register; when there is none, two racing registrations
		// both allocate the same code and the second dies on the full
		// (restaurant_id, device_code) unique index — the loud failure intended.
		const active = await tx
			.select({ id: posDevices.id })
			.from(posDevices)
			.where(and(eq(posDevices.restaurantId, result.restaurantId), isNull(posDevices.revokedAt)))
			.for('update');
		if (active.length > 0) {
			// Leave no orphan session behind; the existing device and any session
			// cookie already in this browser are left exactly as they were.
			await invalidateSession(tx, sessionIdFromToken(result.token));
			return { ok: false as const, reason: 'already_registered' as const };
		}

		// T-13's contract, matched rather than amended: actorUserId, label, and a
		// deviceCode that comes BACK, never goes in.
		const { deviceId, deviceCode, token, expiresAt } = await registerDevice(tx, {
			restaurantId: result.restaurantId,
			actorUserId: result.userId,
			label
		});

		// In THIS transaction (invariant 10). details is exactly T-14's shape. The row
		// carries deviceId — it is one of the first device-sourced rows — and no
		// clientOpId: the owner typed this at the counter; it is not a queued op.
		await writeAudit(tx, {
			restaurantId: result.restaurantId,
			actorUserId: result.userId,
			subjectUserId: null,
			event: 'pos.device.registered',
			details: { deviceCode, label },
			deviceId,
			ip,
			userAgent
		});

		// Destroy EXACTLY these two sessions — the one loginWithPassword just created
		// and the one already in this browser, if any — never invalidateAllForUser,
		// which would also sign the owner out of the laptop in the office.
		await invalidateSession(tx, sessionIdFromToken(result.token));
		const existing = event.cookies.get(SESSION_COOKIE);
		if (existing) await invalidateSession(tx, sessionIdFromToken(existing));

		return { ok: true as const, deviceId, deviceCode, token, expiresAt };
	});

	// Responses are built AFTER the transaction, from what it returned.
	if (!outcome.ok) {
		return json({ error: 'device_already_registered' }, { status: 409 });
	}

	// The token lives ONLY in the HttpOnly device cookie, exactly as a session token
	// does — never in the response body.
	setDeviceCookie(event.cookies, outcome.token, outcome.expiresAt);
	deleteSessionCookie(event.cookies);
	// deviceId — the pos_devices uuid — because a code like POS1 repeats in every
	// restaurant and so cannot identify this device to anything.
	return json(
		{ deviceId: outcome.deviceId, deviceCode: outcome.deviceCode, label },
		{ status: 201 }
	);
};
