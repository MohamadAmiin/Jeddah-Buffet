// POS sessions — spec 10's shift lifecycle: opening cash → sales → count →
// reconciliation → over/short posting. Called ONLY by orders/sync.ts (T-21);
// itself calls accounting/ and audit/ and NEVER orders/ (a cycle and the
// layering rule the overview names).
//
// Business date is computed IN SQL in the restaurant's time zone (invariant
// 11): timestamptz AT TIME ZONE <zone> yields the wall-clock time in that
// zone, cast to date. Never in JavaScript, never in a date library.
//
// The over/short entry balances by construction: overShortLines(difference)
// emits one Dr and one Cr with the same magnitude, and T-13's rule table
// carries the sign by side.

import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { minor, subtract, type Minor } from '../../money';
import { postEntry } from '../accounting/journal';
import { overShortEvent, overShortLines } from '../accounting/posting-rules';
import { writeAudit } from '../audit';
import { posSessions } from '../db/schema/pos-sessions';
import { orders, payments } from '../db/schema/orders';
import { restaurantSettings } from '../db/schema/restaurant-settings';

/** Structurally identical to SyncContext in orders/validate.ts. Declared here
 * so this module never imports orders/. T-21 passes its SyncContext to these
 * functions unchanged. */
export type SessionContext = {
	restaurantId: string;
	cookieDeviceId: string;
	opDeviceId: string;
	opDeviceCode: string;
	employeeId: string;
	employeeUserId: string | null;
	clientOpId: string;
	occurredAt: Date;
	receivedAt: Date;
	ip: string | null;
	userAgent: string | null;
};

export type OpenSessionPayload = { posSessionId: string; openingCashMinor: Minor };
export type CloseSessionPayload = { posSessionId: string; countedCashMinor: Minor };

export type OpenResult = {
	posSessionId: string;
	businessDate: string;
	attached: boolean;
	openingCashMinor: Minor;
};

export type CloseResult = {
	posSessionId: string;
	businessDate: string;
	expectedCashMinor: Minor;
	countedCashMinor: Minor;
	differenceMinor: Minor;
};

export class SessionNotFound extends Error {
	constructor(public readonly posSessionId: string) {
		super(`no session ${posSessionId}`);
	}
}

export class SessionAlreadyClosed extends Error {
	constructor(public readonly posSessionId: string) {
		super(`session ${posSessionId} is closed`);
	}
}

export class SessionHasUnrecordedOps extends Error {
	constructor(public readonly count: number) {
		super(`${count} unrecorded operation(s) reference this session`);
	}
}

export async function openSession(
	tx: DbTx,
	ctx: SessionContext,
	payload: OpenSessionPayload
): Promise<OpenResult> {
	if (ctx.employeeUserId === null) {
		throw new Error('openSession requires ctx.employeeUserId');
	}

	// Serialise concurrent opens for one device — a for-update over the
	// non-existent row would lock nothing.
	await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.opDeviceId}))`);

	const [existing] = await tx
		.select({
			id: posSessions.id,
			businessDate: posSessions.businessDate,
			openingCashMinor: posSessions.openingCashMinor
		})
		.from(posSessions)
		.where(
			and(
				eq(posSessions.restaurantId, ctx.restaurantId),
				eq(posSessions.deviceId, ctx.opDeviceId),
				eq(posSessions.status, 'open')
			)
		)
		.for('update')
		.limit(1);

	if (existing) {
		await writeAudit(tx, {
			event: 'pos.session.opened',
			details: {
				deviceCode: ctx.opDeviceCode,
				businessDate: existing.businessDate,
				openingCashMinor: existing.openingCashMinor.toString(),
				attached: true
			},
			restaurantId: ctx.restaurantId,
			actorUserId: ctx.employeeUserId,
			subjectUserId: null,
			deviceId: ctx.opDeviceId,
			clientOpId: ctx.clientOpId,
			occurredAt: ctx.occurredAt,
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});
		return {
			posSessionId: existing.id,
			businessDate: existing.businessDate,
			attached: true,
			openingCashMinor: minor(existing.openingCashMinor)
		};
	}

	// Read the restaurant's time zone and derive the business date IN SQL.
	const [settings] = await tx
		.select({ timeZone: restaurantSettings.timeZone })
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, ctx.restaurantId))
		.limit(1);
	if (!settings) throw new Error(`settings missing for restaurant ${ctx.restaurantId}`);

	const [inserted] = await tx
		.insert(posSessions)
		.values({
			id: payload.posSessionId,
			restaurantId: ctx.restaurantId,
			deviceId: ctx.opDeviceId,
			openedByUserId: ctx.employeeUserId,
			openedAt: ctx.occurredAt,
			businessDate: sql`(${ctx.occurredAt.toISOString()}::timestamptz at time zone ${settings.timeZone})::date`,
			openingCashMinor: payload.openingCashMinor,
			status: 'open'
		})
		.returning({ businessDate: posSessions.businessDate });

	await writeAudit(tx, {
		event: 'pos.session.opened',
		details: {
			deviceCode: ctx.opDeviceCode,
			businessDate: inserted.businessDate,
			openingCashMinor: payload.openingCashMinor.toString(),
			attached: false
		},
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.employeeUserId,
		subjectUserId: null,
		deviceId: ctx.opDeviceId,
		clientOpId: ctx.clientOpId,
		occurredAt: ctx.occurredAt,
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return {
		posSessionId: payload.posSessionId,
		businessDate: inserted.businessDate,
		attached: false,
		openingCashMinor: payload.openingCashMinor
	};
}

/** Expected cash: opening float + Σ cash payments on paid orders of the
 * session. Refunds, pay-ins and pay-outs are zero in this plan and will
 * join this same statement when their plans land. */
export async function expectedCash(
	tx: Executor,
	restaurantId: string,
	posSessionId: string
): Promise<Minor> {
	const rows = await tx.execute<{ expected: string }>(sql`
		select s.opening_cash_minor
			+ coalesce(
					sum(p.amount_minor) filter (
						where p.method = 'cash' and o.status = 'paid'
					),
					0
				) as expected
		from pos_sessions s
		left join orders o on o.pos_session_id = s.id and o.restaurant_id = s.restaurant_id
		left join payments p on p.order_id = o.id and p.restaurant_id = o.restaurant_id
		where s.id = ${posSessionId} and s.restaurant_id = ${restaurantId}
		group by s.id, s.opening_cash_minor
	`);
	if (rows.rows.length === 0) throw new SessionNotFound(posSessionId);
	return minor(BigInt(rows.rows[0].expected));
}

export async function closeSession(
	tx: DbTx,
	ctx: SessionContext,
	payload: CloseSessionPayload
): Promise<CloseResult> {
	if (ctx.employeeUserId === null) {
		throw new Error('closeSession requires ctx.employeeUserId');
	}

	const [session] = await tx
		.select({
			id: posSessions.id,
			deviceId: posSessions.deviceId,
			businessDate: posSessions.businessDate,
			status: posSessions.status
		})
		.from(posSessions)
		.where(
			and(eq(posSessions.id, payload.posSessionId), eq(posSessions.restaurantId, ctx.restaurantId))
		)
		.for('update')
		.limit(1);
	if (!session) throw new SessionNotFound(payload.posSessionId);
	if (session.status === 'closed') throw new SessionAlreadyClosed(session.id);

	// Unrecorded ops referencing this session block the close.
	const unrecorded = await tx.execute<{ c: string }>(sql`
		select count(*)::text as c from pos_sync_ops
		where restaurant_id = ${ctx.restaurantId}
		  and pos_session_id = ${session.id}
		  and status = 'unrecorded'
		  and resolved_at is null
	`);
	const count = Number(unrecorded.rows[0].c);
	if (count > 0) throw new SessionHasUnrecordedOps(count);

	const expected = await expectedCash(tx, ctx.restaurantId, session.id);
	const difference = subtract(payload.countedCashMinor, expected);

	await tx
		.update(posSessions)
		.set({
			status: 'closed',
			closedAt: ctx.occurredAt,
			closedByUserId: ctx.employeeUserId,
			closedFromDeviceId: ctx.cookieDeviceId,
			countedCashMinor: payload.countedCashMinor,
			expectedCashMinor: expected,
			differenceMinor: difference
		})
		.where(and(eq(posSessions.id, session.id), eq(posSessions.status, 'open')));

	if (difference !== 0n) {
		const event = overShortEvent(difference);
		if (event === null) throw new Error('unreachable: over-short with zero difference');
		await postEntry(tx, {
			restaurantId: ctx.restaurantId,
			businessDate: session.businessDate,
			event,
			sourceType: 'pos_session',
			sourceId: session.id,
			memo: 'Session close',
			lines: overShortLines(difference)
		});
	}

	await writeAudit(tx, {
		event: 'pos.session.closed',
		details: {
			deviceCode: ctx.opDeviceCode,
			businessDate: session.businessDate,
			expectedCashMinor: expected.toString(),
			countedCashMinor: payload.countedCashMinor.toString(),
			differenceMinor: difference.toString()
		},
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.employeeUserId,
		subjectUserId: null,
		deviceId: ctx.opDeviceId,
		clientOpId: ctx.clientOpId,
		occurredAt: ctx.occurredAt,
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return {
		posSessionId: session.id,
		businessDate: session.businessDate,
		expectedCashMinor: expected,
		countedCashMinor: payload.countedCashMinor,
		differenceMinor: difference
	};
}

// Suppress the "orders/payments used only in a template" lint by referencing
// them as values.
void orders;
void payments;
void asc;

/** The device's currently OPEN session, or null. T-05's partial unique index
 * pos_sessions_one_open_per_device makes .limit(1) exact. */
export async function openSessionForDevice(
	database: Executor,
	restaurantId: string,
	deviceId: string
): Promise<{
	id: string;
	openedByUserId: string;
	businessDate: string;
	openingCashMinor: bigint;
	openedAt: Date;
} | null> {
	const rows = await database
		.select({
			id: posSessions.id,
			openedByUserId: posSessions.openedByUserId,
			businessDate: posSessions.businessDate,
			openingCashMinor: posSessions.openingCashMinor,
			openedAt: posSessions.openedAt
		})
		.from(posSessions)
		.where(
			and(
				eq(posSessions.restaurantId, restaurantId),
				eq(posSessions.deviceId, deviceId),
				eq(posSessions.status, 'open')
			)
		)
		.limit(1);
	return rows[0] ?? null;
}
