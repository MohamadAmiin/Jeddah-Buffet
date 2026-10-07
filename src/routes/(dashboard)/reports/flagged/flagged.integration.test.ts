import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import {
	closeSessionAt,
	openSessionAt,
	pushOp,
	saleEnvelope,
	seedSalesRestaurant,
	type SalesFixture
} from '$lib/server/db/test/sales';
import { posSyncOps } from '$lib/server/db/schema/pos-sync';
import { auditLog } from '$lib/server/db/schema/audit';
import type { Principal } from '$lib/server/auth/session';
import { summarizeOp } from '$lib/server/reports/flagged';
import { minor } from '$lib/money';
import { formatMoney, moneyFormatFor } from '$lib/money/format';
import { actions, load } from './+page.server';
import { load as overviewLoad } from '../../dashboard/+page.server';

afterAll(async () => {
	await closeTestDb();
});

const usd = moneyFormatFor('USD');

type ListedOp = {
	id: string;
	status: string;
	flag: string | null;
	invoiceNumber: string | null;
	employeeName: string;
	businessDate: string | null;
	retryable: boolean;
	summary: { lines: string[]; total: string | null; tender: string | null };
};
type FlaggedData = { notice: string | null; ops: ListedOp[] };

function eventFor(
	f: SalesFixture,
	who: { userId: string; role: Principal['role'] },
	o: { routeId?: string; path?: string; form?: Record<string, string> } = {}
): RequestEvent {
	const user: Principal = {
		userId: who.userId,
		restaurantId: f.restaurantId,
		role: who.role,
		displayName: who.role === 'owner' ? 'Owner' : 'Staff',
		email: who.role === 'owner' ? 'owner@example.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
	const url = new URL('http://localhost' + (o.path ?? '/reports/flagged'));
	let request = new Request(url);
	if (o.form) {
		const body = new FormData();
		for (const [k, v] of Object.entries(o.form)) body.append(k, v);
		request = new Request(url, { method: 'POST', body });
	}
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: f.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request,
		route: { id: o.routeId ?? '/(dashboard)/reports/flagged' },
		url
	} as unknown as RequestEvent;
}

const owner = (f: SalesFixture) => ({ userId: f.ownerId, role: 'owner' as const });

async function listAsOwner(f: SalesFixture): Promise<FlaggedData> {
	return (await load(eventFor(f, owner(f)) as never)) as FlaggedData;
}

type Thrown = { status?: number; location?: string };
async function outcome(p: unknown): Promise<{ thrown?: Thrown; returned?: unknown }> {
	try {
		return { returned: await p };
	} catch (e) {
		return { thrown: e as Thrown };
	}
}

function retry(event: RequestEvent) {
	return actions.retry!(event as Parameters<NonNullable<typeof actions.retry>>[0]);
}
function dismiss(event: RequestEvent) {
	return actions.dismiss!(event as Parameters<NonNullable<typeof actions.dismiss>>[0]);
}

const oneMinuteAgo = () => new Date(Date.now() - 60_000);

function burgerLines(f: SalesFixture) {
	return [
		{
			menuItemId: f.items.burger,
			itemName: 'Burger',
			quantity: 1,
			unitPriceMinor: 800n,
			taxRateBp: f.taxRateBp,
			modifiers: [
				{ modifierId: f.modifiers.extraCheese, modifierName: 'Extra cheese', priceDeltaMinor: 50n }
			]
		}
	];
}

/** A cash sale naming a session that was never opened → unrecorded, unknown_session. */
async function unknownSessionOp(f: SalesFixture) {
	const posSessionId = randomUUID();
	const env = saleEnvelope(f, {
		posSessionId,
		occurredAt: oneMinuteAgo(),
		invoiceSeq: 1,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		lines: burgerLines(f)
	});
	const res = await pushOp(db, f, env);
	return { posSessionId, env, res };
}

/** A cash sale rung up by a Waiter (no pos.payment) → recorded_flagged. */
async function waiterFlaggedOp(f: SalesFixture, posSessionId: string) {
	const robin = await seedStaff(db, f.restaurantId, { displayName: 'Robin', roleName: 'Waiter' });
	const env = saleEnvelope(f, {
		posSessionId,
		occurredAt: oneMinuteAgo(),
		invoiceSeq: 2,
		method: 'cash',
		orderType: 'takeaway',
		tableLabel: null,
		employeeId: robin.id,
		lines: burgerLines(f)
	});
	const res = await pushOp(db, f, env);
	return { robin, env, res };
}

async function counts() {
	const r = await db.execute<Record<string, number>>(sql`
		select
			(select count(*)::int from orders) as orders,
			(select count(*)::int from invoices) as invoices,
			(select count(*)::int from payments) as payments,
			(select count(*)::int from journal_entries) as entries,
			(select count(*)::int from journal_entry_lines) as lines
	`);
	return r.rows[0];
}

async function opRow(f: SalesFixture, clientOpId: string) {
	return db
		.select()
		.from(posSyncOps)
		.where(and(eq(posSyncOps.deviceId, f.deviceId), eq(posSyncOps.clientOpId, clientOpId)));
}

describe('the review list', () => {
	it('lists an unrecorded op with a summary and no raw payload', async () => {
		const f = await seedSalesRestaurant(db);
		const { res } = await unknownSessionOp(f);
		expect(res).toMatchObject({
			http: 200,
			body: { status: 'unrecorded', flag: 'unknown_session' }
		});

		const data = await listAsOwner(f);
		expect(data.ops).toHaveLength(1);
		expect(data.ops[0]).toMatchObject({
			status: 'unrecorded',
			flag: 'unknown_session',
			invoiceNumber: 'POS1-000001',
			employeeName: 'Sam',
			businessDate: null,
			retryable: true,
			summary: {
				lines: ['1 × Burger + Extra cheese'],
				total: formatMoney(minor(935n), usd),
				tender: 'Cash ' + formatMoney(minor(935n), usd)
			}
		});
		expect(data.ops[0].summary.total).toBe('9.35 USD');
		const json = JSON.stringify(data);
		expect(json).not.toContain('menuItemId');
		expect(json).not.toContain('lineId');
		expect(JSON.stringify(data.ops[0].summary)).not.toContain(f.staffId);
	});
});

describe('retry', () => {
	it('records a fixable op under the same key, and a second retry duplicates nothing', async () => {
		const f = await seedSalesRestaurant(db);
		const { posSessionId, env } = await unknownSessionOp(f);
		await openSessionAt(db, f, {
			posSessionId,
			openedAt: new Date(Date.now() - 120_000),
			openingCashMinor: 10000n
		});
		const [before] = await opRow(f, env.clientOpId);

		const first = await outcome(
			retry(eventFor(f, owner(f), { form: { opId: before.id.toString() } }))
		);
		expect(first.thrown).toMatchObject({
			status: 303,
			location: '/reports/flagged?notice=retried_accepted'
		});

		const rows = await opRow(f, env.clientOpId);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('accepted');
		expect(rows[0].orderId).not.toBeNull();
		expect(await counts()).toMatchObject({ orders: 1, invoices: 1, payments: 1, entries: 1 });
		const inv = await db.execute<{ invoice_number: string }>(
			sql`select invoice_number from invoices`
		);
		expect(inv.rows[0].invoice_number).toBe('POS1-000001');
		const sums = await db.execute<{ d: string; c: string }>(
			sql`select sum(debit_minor)::text as d, sum(credit_minor)::text as c from journal_entry_lines`
		);
		expect(sums.rows[0]).toEqual({ d: '935', c: '935' });
		const retried = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.event, 'sync.op_retried'), eq(auditLog.restaurantId, f.restaurantId)));
		expect(retried).toHaveLength(1);
		expect(retried[0].actorUserId).toBe(f.ownerId);
		expect((await listAsOwner(f)).ops).toHaveLength(0);

		// MANDATORY (spec 29 — offline sync: retries never create duplicates).
		const snapshot = await counts();
		await outcome(retry(eventFor(f, owner(f), { form: { opId: before.id.toString() } })));
		expect(await counts()).toEqual(snapshot);
		expect(await opRow(f, env.clientOpId)).toHaveLength(1);
	});
});

describe('dismiss', () => {
	it('stamps the op, writes the audit row and touches nothing posted', async () => {
		const f = await seedSalesRestaurant(db);
		const sid = randomUUID();
		const { businessDate } = await openSessionAt(db, f, {
			posSessionId: sid,
			openedAt: new Date(Date.now() - 300_000),
			openingCashMinor: 0n
		});
		const { env, res } = await waiterFlaggedOp(f, sid);
		expect(res).toMatchObject({
			http: 200,
			body: { status: 'recorded_flagged', flag: 'employee_not_permitted' }
		});

		const listed = (await listAsOwner(f)).ops;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			status: 'recorded_flagged',
			employeeName: 'Robin',
			retryable: false,
			businessDate,
			invoiceNumber: 'POS1-000002'
		});

		const before = await counts();
		const [row] = await opRow(f, env.clientOpId);

		const tooShort = await outcome(
			dismiss(eventFor(f, owner(f), { form: { opId: row.id.toString(), reason: 'no' } }))
		);
		expect(tooShort.returned).toMatchObject({
			status: 400,
			data: { message: 'Give a reason of 3 to 200 characters.' }
		});
		expect((await opRow(f, env.clientOpId))[0].resolvedAt).toBeNull();

		const reason = "Robin rang it up on the cashier's behalf";
		const done = await outcome(
			dismiss(eventFor(f, owner(f), { form: { opId: row.id.toString(), reason } }))
		);
		expect(done.thrown).toMatchObject({
			status: 303,
			location: '/reports/flagged?notice=dismissed'
		});

		const [after] = await opRow(f, env.clientOpId);
		expect(after.resolvedAt).not.toBeNull();
		expect(after.resolvedByUserId).toBe(f.ownerId);
		expect(after.resolution).toBe('dismissed');
		expect(after.status).toBe('recorded_flagged');
		expect(after.orderId).toBe(row.orderId);

		const audit = await db
			.select()
			.from(auditLog)
			.where(
				and(eq(auditLog.event, 'sync.op_dismissed'), eq(auditLog.restaurantId, f.restaurantId))
			);
		expect(audit).toHaveLength(1);
		expect(audit[0].actorUserId).toBe(f.ownerId);
		expect((audit[0].details as { reason: string }).reason).toBe(reason);

		expect((await listAsOwner(f)).ops).toHaveLength(0);
		expect(await counts()).toEqual(before);
	});
});

describe('MANDATORY (spec 29) — permission check on /reports/flagged', () => {
	it('staff get 403 on the load and both actions, and nothing changes', async () => {
		const f = await seedSalesRestaurant(db);
		await unknownSessionOp(f);
		const [row] = await db
			.select()
			.from(posSyncOps)
			.where(eq(posSyncOps.restaurantId, f.restaurantId));
		const staff = { userId: f.staffId, role: 'staff' as const };

		const l = await outcome(load(eventFor(f, staff) as never));
		expect(l.thrown?.status).toBe(403);
		expect(l.thrown?.location).toBeUndefined();

		const r = await outcome(retry(eventFor(f, staff, { form: { opId: row.id.toString() } })));
		expect(r.thrown?.status).toBe(403);
		expect(r.thrown?.location).toBeUndefined();

		const d = await outcome(
			dismiss(eventFor(f, staff, { form: { opId: row.id.toString(), reason: 'not mine' } }))
		);
		expect(d.thrown?.status).toBe(403);
		expect(d.thrown?.location).toBeUndefined();

		expect((await listAsOwner(f)).ops).toHaveLength(1);
		const audits = await db
			.select()
			.from(auditLog)
			.where(sql`${auditLog.event} in ('sync.op_retried', 'sync.op_dismissed')`);
		expect(audits).toHaveLength(0);
	});

	it('a non-numeric opId fails 400 before any query', async () => {
		const f = await seedSalesRestaurant(db);
		const r = await outcome(retry(eventFor(f, owner(f), { form: { opId: 'not-a-uuid' } })));
		expect(r.returned).toMatchObject({ status: 400 });
		const d = await outcome(
			dismiss(eventFor(f, owner(f), { form: { opId: 'not-a-uuid', reason: 'a real reason' } }))
		);
		expect(d.returned).toMatchObject({ status: 400 });
	});
});

describe('the Overview count', () => {
	it('tracks unresolved ops through dismiss and retry', async () => {
		const f = await seedSalesRestaurant(db);
		const { posSessionId: missing, env: lostEnv } = await unknownSessionOp(f);
		const sid = randomUUID();
		await openSessionAt(db, f, {
			posSessionId: sid,
			openedAt: new Date(Date.now() - 300_000),
			openingCashMinor: 0n
		});
		const { env: robinEnv } = await waiterFlaggedOp(f, sid);

		const overview = async () =>
			(await overviewLoad(
				eventFor(f, owner(f), { routeId: '/(dashboard)/dashboard', path: '/dashboard' }) as never
			)) as { flaggedCount: number };

		const withBoth = await overview();
		expect(withBoth.flaggedCount).toBe(2);
		const json = JSON.stringify(withBoth);
		expect(json).not.toMatch(/ USD/);

		const [robinRow] = await opRow(f, robinEnv.clientOpId);
		await outcome(
			dismiss(
				eventFor(f, owner(f), { form: { opId: robinRow.id.toString(), reason: 'Known and fine' } })
			)
		);
		expect((await overview()).flaggedCount).toBe(1);

		// One device holds one open session: close the shift, then open the one the lost sale named.
		await closeSessionAt(db, f, {
			posSessionId: sid,
			closedAt: new Date(Date.now() - 200_000),
			countedCashMinor: 935n
		});
		await openSessionAt(db, f, {
			posSessionId: missing,
			openedAt: new Date(Date.now() - 120_000),
			openingCashMinor: 0n
		});
		const [lostRow] = await opRow(f, lostEnv.clientOpId);
		await outcome(retry(eventFor(f, owner(f), { form: { opId: lostRow.id.toString() } })));
		expect((await overview()).flaggedCount).toBe(0);
	});
});

describe('summarizeOp', () => {
	it('never throws and never widens', () => {
		expect(summarizeOp('sale.complete', { lines: 'nope' }, usd)).toEqual({
			lines: ['Payload could not be read'],
			total: null,
			tender: null
		});
		const payload = {
			lines: [{ itemName: 'Tea', quantity: 1, modifiers: [] }],
			totals: { totalMinor: '9.35' },
			payments: []
		};
		expect(summarizeOp('sale.complete', payload, usd).total).toBeNull();
		expect(
			summarizeOp('session.open', { posSessionId: 's', openingCashMinor: '10000' }, usd).lines
		).toEqual(['Shift open · float 100.00 USD']);
	});

	// settings-tax-payments-receipt T-17: the tender names the payment method. The
	// stored payload is untrusted — an unrecorded op may hold a name the validator
	// refused — so only a 1–40 character name with no control character is shown;
	// anything else reads as the capitalised kind, as before named methods.
	it('names the payment method in the tender, never a name the validator would refuse', () => {
		const payload = (name?: unknown) => ({
			lines: [{ itemName: 'Tea', quantity: 1, modifiers: [] }],
			totals: { totalMinor: '935' },
			payments: [
				{
					paymentId: 'payment-uuid',
					method: 'mobile',
					...(name === undefined ? {} : { paymentMethodName: name }),
					amountMinor: '935',
					tenderedMinor: null,
					changeMinor: null
				}
			]
		});
		const tender = (name?: unknown) => summarizeOp('sale.complete', payload(name), usd).tender;
		// '9.35 USD' — formatMoney joins the amount and the code with a no-break space.
		const amount = formatMoney(minor(935n), usd);
		expect(tender('EVC Plus')).toBe('EVC Plus ' + amount);
		expect(tender('x'.repeat(40))).toBe('x'.repeat(40) + ' ' + amount);
		// No name — a payload queued before named methods — and a null one.
		expect(tender()).toBe('Mobile ' + amount);
		expect(tender(null)).toBe('Mobile ' + amount);
		// Names the validator refuses: a control character, 41 characters.
		expect(tender('EVC\u001bPlus')).toBe('Mobile ' + amount);
		expect(tender('x'.repeat(41))).toBe('Mobile ' + amount);
	});
});
