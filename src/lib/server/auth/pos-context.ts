import { error, type RequestEvent } from '@sveltejs/kit';
import { db } from '../db/client';
import type { Executor } from './session';
import { DEVICE_COOKIE, validateDeviceToken } from './pos-device';

// WHY THIS FILE EXISTS. src/hooks.server.ts gives a request a tenant only when its
// route id starts with /(dashboard), and slides the session cookie only there.
// Both the hook and src/app.d.ts carry the same warning: a POS or sync route "must
// resolve its tenant from the REGISTERED DEVICE row and its actor from the queued
// operation, never from whichever owner last logged in on that browser". This
// helper IS that resolution. It never falls back to the dashboard principal or the
// dashboard tenant, and it never reads the session cookie.
//
// It answers WHO THE DEVICE IS — not what the employee may do. Every /api/pos/*
// route still checks its own permission and returns 403 on its own: a device
// check is not an authorisation check, and the permission walk over the POS
// routes is what proves each of them makes one.
//
// 403 on every failure, never a 303. requireUser redirects an anonymous browser
// to /login because a person without an identity can go and get one; an
// unregistered device has no such page, and /api/pos/* is a JSON API where a
// redirect would be parsed as a successful response. Spec 8 names the status:
// "the server returns 403 Forbidden".
//
// THE CONTRACT — every /api/pos/* route calls this and nothing else:
//
//   import { requireDevice } from '$lib/server/auth/pos-context';
//   const device = await requireDevice(event); // { restaurantId, deviceId, deviceCode }
//
// It is ASYNC, unlike requireUser / requireOwner / requirePermission: a forgotten
// `await` yields a pending promise, which is truthy, and the route would proceed
// as if the device were valid.

/** The whole context: no `code`, no `label`. A route that wants the label reads the row. */
export type PosDeviceContext = { restaurantId: string; deviceId: string; deviceCode: string };

/**
 * Resolve the registered POS device behind this request, or throw 403 — for no
 * device cookie, a token that was never registered, and a REVOKED device alike.
 * On success the context is also left on the request as `locals.posDevice`.
 *
 * `database` defaults to the app's pool so route call sites stay one argument;
 * the integration test drives it against the test database.
 */
export async function requireDevice(
	event: RequestEvent,
	database: Executor = db
): Promise<PosDeviceContext> {
	const token = event.cookies.get(DEVICE_COOKIE);
	if (!token) error(403, 'Forbidden');

	const device = await validateDeviceToken(database, token);
	if (!device) error(403, 'Forbidden');

	const context: PosDeviceContext = {
		restaurantId: device.restaurantId,
		deviceId: device.deviceId,
		deviceCode: device.deviceCode
	};
	event.locals.posDevice = context;
	return context;
}
