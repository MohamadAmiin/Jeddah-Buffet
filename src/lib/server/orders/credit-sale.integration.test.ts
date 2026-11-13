import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { closeTestDb, testDb } from '../db/test/db';
import {
	openSessionAt,
	pushOp,
	recordSaleAt,
	saleEnvelope,
	seedSalesRestaurant,
	type RecordSaleOptions,
	type SalesFixture
} from '../db/test/sales';
import { orders, payments, invoices } from '../db/schema/orders';
import { journalEntries } from '../db/schema/accounting';
import { posSyncOps } from '../db/schema/pos-sync';
import { auditLog } from '../db/schema/audit';
import { expectedCash } from '../pos-sessions';
import { setCreditEnabled } from '../restaurants';
import { minor } from '../../money';
import {
	archiveCustomer,
	balanceOf,
	createCustomer,
	receivableTripwire,
	statement,
	type CustomerWriteContext
} from '../customers';

// A CREDIT SALE through THE payment transaction (tasks/customer-credit T-10).
//
// MANDATORY (spec 29): the posting rule of a credit sale, in both tax modes;
// offline sync — a replayed credit sale records once, and a payload without the
// new keys still records; and invariant 5 as amended 2026-11-12 — a completed
// credit charge is recorded and FLAGGED, never rejected.

afterAll(async () => {
	await closeTestDb();
});

const AT = new Date('2026-09-28T09:00:00Z');

type World = { f: SalesFixture; session: string; ctx: CustomerWriteContext };

async function world(opts: Parameters<typeof seedSalesRestaurant>[1] = {}): Promise<World> {
	const f = await seedSalesRestaurant(db, opts);
	const session = randomUUID();
	await openSessionAt(db, f, { posSessionId: session, openedAt: AT, openingCashMinor: 5000n });
	const ctx = { restaurantId: f.restaurantId, actorUserId: f.ownerId, ip: null, userAgent: null };
	await db.transaction((tx) =>
		setCreditEnabled(tx, f.restaurantId, true, {
			actorUserId: f.ownerId,
			ip: null,
			userAgent: null
		})
	);
	return { f, session, ctx };
}

async function customer(
	w: World,
	o: { name?: string; phone?: string; limit?: bigint | null } = {}
): Promise<string> {
	const result = await db.transaction((tx) =>
		createCustomer(tx, w.ctx, {
			name: o.name ?? 'Ali Hassan',
			phone: o.phone ?? '615000001',
			creditLimitMinor: o.limit === undefined || o.limit === null ? null : minor(o.limit)
		})
	);
	if (!result.ok) throw new Error(result.reason);
	return result.customerId;
}

/** One burger: 800 + 10% = 880 exclusive; 800 inclusive. */
function burger(w: World, seq: number, o: Partial<RecordSaleOptions> = {}): RecordSaleOptions {
	return {
		posSessionId: w.session,
		occurredAt: new Date(AT.getTime() + seq * 60_000),
		invoiceSeq: seq,
		method: 'credit',
		orderType: 'dine_in',
		tableLabel: null,
		lines: [
			{
				menuItemId: w.f.items.burger,
				itemName: 'Burger',
				quantity: 1,
				unitPriceMinor: 800n,
				taxRateBp: w.f.taxRateBp
			}
		],
		...o
	};
}

/** Every journal line of one order's entries, as `event code Dr|Cr amount`. */
async function linesOfOrder(orderId: string): Promise<string[]> {
	const result = await testDb().execute<{ line: string }>(sql`
		select e.event || ' ' || a.code || ' ' ||
		       case when l.debit_minor > 0 then 'Dr ' || l.debit_minor else 'Cr ' || l.credit_minor end as line
		from journal_entries e
		join journal_entry_lines l on l.entry_id = e.id
		join accounts a on a.id = l.account_id
		where e.source_type = 'order' and e.source_id = ${orderId}
		order by e.event, l.line_no
	`);
	return result.rows.map((r) => r.line);
}

async function counts(restaurantId: string) {
	const one = async (
		table: typeof orders | typeof payments | typeof invoices | typeof journalEntries
	) =>
		(
			await testDb()
				.select({ c: sql<number>`count(*)::int` })
				.from(table)
				.where(eq(table.restaurantId, restaurantId))
		)[0].c;
	return {
		orders: await one(orders),
		payments: await one(payments),
		invoices: await one(invoices),
		entries: await one(journalEntries)
	};
}

describe('MANDATORY (spec 29) — the posting rule of a credit sale', () => {
	it('exclusive 10%: Dr 1100 880 / Cr 4000 800 / Cr 2100 80; the payment names the customer; the drawer is untouched', async () => {
		const w = await world();
		const id = await customer(w);

		const sale = await recordSaleAt(
			db,
			w.f,
			burger(w, 1, { customer: { id, name: 'Ali Hassan' } })
		);

		expect(sale.softFlags).toEqual([]);
		expect(await linesOfOrder(sale.orderId)).toEqual([
			'credit_sale 1100 Dr 880',
			'credit_sale 4000 Cr 800',
			'credit_sale 2100 Cr 80'
		]);
		const [payment] = await testDb()
			.select()
			.from(payments)
			.where(eq(payments.orderId, sale.orderId));
		expect(payment).toMatchObject({
			method: 'credit',
			paymentMethodName: 'Customer credit',
			amountMinor: 880n,
			tenderedMinor: null,
			changeMinor: null,
			customerId: id,
			customerName: 'Ali Hassan'
		});
		const [order] = await testDb().select().from(orders).where(eq(orders.id, sale.orderId));
		expect(order.status).toBe('paid');
		// Expected cash is the float alone: no money changed hands.
		expect(await db.transaction((tx) => expectedCash(tx, w.f.restaurantId, w.session))).toBe(5000n);
		expect(await balanceOf(db, w.f.restaurantId, id)).toBe(880n);
	});

	it('inclusive 10%: Dr 1100 800 / Cr 4000 727 / Cr 2100 73', async () => {
		const w = await world({ taxMode: 'inclusive' });
		const id = await customer(w);
		const sale = await recordSaleAt(db, w.f, burger(w, 1, { customer: { id } }));
		expect(await linesOfOrder(sale.orderId)).toEqual([
			'credit_sale 1100 Dr 800',
			'credit_sale 4000 Cr 727',
			'credit_sale 2100 Cr 73'
		]);
	});

	it('writes sale.recorded (owning the op key) and sale.credit_charged naming the customer', async () => {
		const w = await world();
		const id = await customer(w);
		const sale = await recordSaleAt(
			db,
			w.f,
			burger(w, 1, { customer: { id, name: 'Ali Hassan' } })
		);

		const rows = await testDb()
			.select()
			.from(auditLog)
			.where(
				and(eq(auditLog.restaurantId, w.f.restaurantId), eq(auditLog.event, 'sale.credit_charged'))
			);
		expect(rows).toHaveLength(1);
		expect(rows[0].clientOpId).toBeNull();
		expect(rows[0].actorUserId).toBe(w.f.staffId);
		expect(rows[0].details).toEqual({
			deviceCode: w.f.deviceCode,
			invoiceNumber: sale.invoiceNumber,
			customerId: id,
			customerName: 'Ali Hassan',
			totalMinor: '880'
		});
	});

	it('two charges: the balance, the statement and the 1100 tripwire agree', async () => {
		const w = await world();
		const id = await customer(w);
		await recordSaleAt(db, w.f, burger(w, 1, { customer: { id } }));
		await recordSaleAt(db, w.f, burger(w, 2, { customer: { id } }));
		// A cash sale between them moves nothing on the customer.
		await recordSaleAt(db, w.f, burger(w, 3, { method: 'cash' }));

		expect(await balanceOf(db, w.f.restaurantId, id)).toBe(1760n);
		const rows = await statement(db, w.f.restaurantId, id);
		expect(rows.map((r) => [r.kind, r.reference, r.amountMinor, r.balanceMinor])).toEqual([
			['charge', `${w.f.deviceCode}-000001`, 880n, 880n],
			['charge', `${w.f.deviceCode}-000002`, 880n, 1760n]
		]);
		expect(rows[0].tillCode).toBe(w.f.deviceCode);
		expect(rows[0].businessDate).toBe('2026-09-28');
		expect(await receivableTripwire(db, w.f.restaurantId)).toEqual({
			sumOfBalances: 1760n,
			ledger1100: 1760n,
			matches: true
		});
	});
});

describe('MANDATORY (spec 29) — offline sync: a credit sale records once', () => {
	it('the same op twice: accepted then replayed; one order, payment, invoice and entry set; charged once', async () => {
		const w = await world();
		const id = await customer(w);
		const envelope = saleEnvelope(w.f, burger(w, 1, { customer: { id } }));

		const first = await pushOp(db, w.f, envelope);
		const second = await pushOp(db, w.f, envelope);

		expect(first).toMatchObject({ http: 200, body: { status: 'accepted' } });
		expect(second).toMatchObject({ http: 200, body: { status: 'replayed' } });
		// One sale entry and no COGS entry (the burger has no recipe).
		expect(await counts(w.f.restaurantId)).toEqual({
			orders: 1,
			payments: 1,
			invoices: 1,
			entries: 1
		});
		expect(await balanceOf(db, w.f.restaurantId, id)).toBe(880n);
	});

	it('a payload WITHOUT the new keys still records exactly as before', async () => {
		const w = await world();
		const envelope = saleEnvelope(w.f, burger(w, 1, { method: 'cash', omitIds: true }));
		const payment = (envelope.payload as { payments: Record<string, unknown>[] }).payments[0];
		expect(payment).not.toHaveProperty('customerId');
		expect(payment).not.toHaveProperty('customerName');

		expect(await pushOp(db, w.f, envelope)).toMatchObject({
			http: 200,
			body: { status: 'accepted' }
		});
		const [row] = await testDb().select().from(payments);
		expect(row).toMatchObject({ method: 'cash', customerId: null, customerName: null });
	});
});

describe('MANDATORY (invariant 5, amended 2026-11-12) — a credit charge is recorded and flagged, never rejected', () => {
	it('over the limit: recorded_flagged credit_limit_exceeded, HTTP 200, posted in full', async () => {
		const w = await world();
		const id = await customer(w, { limit: 1000n });
		await recordSaleAt(db, w.f, burger(w, 1, { customer: { id } })); // 880 of 1000

		const r = await pushOp(db, w.f, saleEnvelope(w.f, burger(w, 2, { customer: { id } })));

		expect(r).toMatchObject({
			http: 200,
			body: { status: 'recorded_flagged', flag: 'credit_limit_exceeded' }
		});
		expect(await balanceOf(db, w.f.restaurantId, id)).toBe(1760n);
	});

	it('exactly at the limit is not flagged', async () => {
		const w = await world();
		const id = await customer(w, { limit: 880n });
		const r = await pushOp(db, w.f, saleEnvelope(w.f, burger(w, 1, { customer: { id } })));
		expect(r).toMatchObject({ http: 200, body: { status: 'accepted' } });
	});

	it('an archived customer: recorded_flagged customer_archived', async () => {
		const w = await world();
		const id = await customer(w);
		expect(await db.transaction((tx) => archiveCustomer(tx, w.ctx, id))).toEqual({ ok: true });

		const r = await pushOp(db, w.f, saleEnvelope(w.f, burger(w, 1, { customer: { id } })));

		expect(r).toMatchObject({
			http: 200,
			body: { status: 'recorded_flagged', flag: 'customer_archived' }
		});
		expect(await balanceOf(db, w.f.restaurantId, id)).toBe(880n);
	});

	it('credit switched off by the owner: recorded_flagged credit_not_enabled', async () => {
		const w = await world();
		const id = await customer(w);
		await db.transaction((tx) =>
			setCreditEnabled(tx, w.f.restaurantId, false, {
				actorUserId: w.f.ownerId,
				ip: null,
				userAgent: null
			})
		);

		const r = await pushOp(db, w.f, saleEnvelope(w.f, burger(w, 1, { customer: { id } })));

		expect(r).toMatchObject({
			http: 200,
			body: { status: 'recorded_flagged', flag: 'credit_not_enabled' }
		});
	});

	it('an unknown customer: stored unrecorded with its payload, HTTP 200, nothing posted — never discarded', async () => {
		const w = await world();
		const other = await world();
		const foreign = await customer(other);

		for (const [seq, id] of [
			[1, randomUUID()],
			[2, foreign], // another restaurant's customer
			[3, 'not-a-uuid']
		] as const) {
			const r = await pushOp(db, w.f, saleEnvelope(w.f, burger(w, seq, { customer: { id } })));
			expect(r).toMatchObject({
				http: 200,
				body: { status: 'unrecorded', flag: 'invalid_payload' }
			});
		}
		// No customer at all on a credit payment.
		const none = await pushOp(db, w.f, saleEnvelope(w.f, burger(w, 4)));
		expect(none).toMatchObject({ http: 200, body: { status: 'unrecorded' } });

		expect(await counts(w.f.restaurantId)).toEqual({
			orders: 0,
			payments: 0,
			invoices: 0,
			entries: 0
		});
		const ops = await testDb()
			.select({ status: posSyncOps.status, payload: posSyncOps.payload })
			.from(posSyncOps)
			.where(
				and(eq(posSyncOps.restaurantId, w.f.restaurantId), eq(posSyncOps.kind, 'sale.complete'))
			);
		expect(ops).toHaveLength(4);
		for (const op of ops) {
			expect(op.status).toBe('unrecorded');
			// The whole envelope is kept, for the owner's retry.
			expect((op.payload as { payload: { payments: unknown[] } }).payload.payments).toHaveLength(1);
		}
		expect(await balanceOf(db, other.f.restaurantId, foreign)).toBe(0n);
	});

	it('an unrecorded credit sale blocks archiving its customer', async () => {
		const w = await world();
		const id = await customer(w);
		// Unrecorded for another reason: an unknown session.
		const r = await pushOp(
			db,
			w.f,
			saleEnvelope(w.f, burger(w, 1, { customer: { id }, posSessionId: randomUUID() }))
		);
		expect(r).toMatchObject({ http: 200, body: { status: 'unrecorded' } });

		expect(await db.transaction((tx) => archiveCustomer(tx, w.ctx, id))).toEqual({
			ok: false,
			reason: 'has_unrecorded_charge'
		});
	});

	it('a customer who owes cannot be archived', async () => {
		const w = await world();
		const id = await customer(w);
		await recordSaleAt(db, w.f, burger(w, 1, { customer: { id } }));
		expect(await db.transaction((tx) => archiveCustomer(tx, w.ctx, id))).toEqual({
			ok: false,
			reason: 'has_balance'
		});
	});
});

describe('customer fields the server did not expect', () => {
	it('a CASH sale carrying a customer records as a plain cash sale; no customer is stored or charged', async () => {
		const w = await world();
		const id = await customer(w);

		const r = await pushOp(
			db,
			w.f,
			saleEnvelope(w.f, burger(w, 1, { method: 'cash', customer: { id, name: 'Ali Hassan' } }))
		);

		expect(r).toMatchObject({ http: 200, body: { status: 'accepted' } });
		const [row] = await testDb().select().from(payments);
		expect(row).toMatchObject({ method: 'cash', customerId: null, customerName: null });
		expect(await balanceOf(db, w.f.restaurantId, id)).toBe(0n);
	});

	it('a cash sale carrying a malformed customer id still records', async () => {
		const w = await world();
		const r = await pushOp(
			db,
			w.f,
			saleEnvelope(w.f, burger(w, 1, { method: 'cash', customer: { id: 'x'.repeat(500) } }))
		);
		expect(r).toMatchObject({ http: 200, body: { status: 'accepted' } });
	});

	it('a 120-character customer name is cut to 80 and recorded, never refused; no name falls back to the row', async () => {
		const w = await world();
		const id = await customer(w, { name: 'Ali Hassan' });

		const long = await pushOp(
			db,
			w.f,
			saleEnvelope(w.f, burger(w, 1, { customer: { id, name: 'x'.repeat(120) } }))
		);
		const blank = await pushOp(
			db,
			w.f,
			saleEnvelope(w.f, burger(w, 2, { customer: { id, name: ' \n ' } }))
		);

		expect(long).toMatchObject({ http: 200, body: { status: 'accepted' } });
		expect(blank).toMatchObject({ http: 200, body: { status: 'accepted' } });
		const rows = await testDb()
			.select({ name: payments.customerName })
			.from(payments)
			.orderBy(payments.paidAt);
		expect(rows.map((r) => r.name)).toEqual(['x'.repeat(80), 'Ali Hassan']);
	});
});

describe('the customer lock', () => {
	it('two concurrent charges that cross the limit together: both recorded, exactly one flagged', async () => {
		const w = await world();
		const id = await customer(w, { limit: 1000n });

		const results = await Promise.all([
			pushOp(db, w.f, saleEnvelope(w.f, burger(w, 1, { customer: { id } }))),
			pushOp(db, w.f, saleEnvelope(w.f, burger(w, 2, { customer: { id } })))
		]);

		const statuses = results.map((r) => (r.body as { status: string }).status).sort();
		expect(statuses).toEqual(['accepted', 'recorded_flagged']);
		const flagged = results.find(
			(r) => (r.body as { status: string }).status === 'recorded_flagged'
		);
		expect((flagged?.body as { flag?: string }).flag).toBe('credit_limit_exceeded');
		expect(await balanceOf(db, w.f.restaurantId, id)).toBe(1760n);
	});
});
