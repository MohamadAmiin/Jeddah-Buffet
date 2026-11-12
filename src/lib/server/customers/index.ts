// CUSTOMERS (tasks/customer-credit T-08) — who may be charged, what they owe.
//
// The owner registers a customer (name, phone, optional credit limit); the till
// charges a whole bill to that customer (a `payments` row with method 'credit',
// written by THE payment transaction in orders/pay.ts) and later receives what
// they pay back (customer_payments, written by ./payments.ts).
//
// THE BALANCE IS NEVER STORED. It is ONE expression, customerBalanceSql below:
// the sum of the customer's credit payments minus the sum of their unreversed
// customer payments, as TWO SCALAR SUBQUERIES. Never rewrite it as two joins: a
// customer with three charges and two payments would then be counted six times.
// Everything that needs a balance — the till's list, the limit flag, the
// "cannot overpay" check, archive, the statement, the 1100 tripwire — reads it
// through this file.
//
// LOCK ORDER, everywhere: the shift row FOR SHARE (./payments.ts), then the
// customer row FOR UPDATE (lockCustomer), then the payment row. The customer
// lock is what serialises two writers racing for one balance.
//
// Module rule: calls accounting/ and audit/ only; called by orders/, by
// ./payments.ts and by routes. Every writer takes the caller's tx, is scoped by
// restaurant, audits in that tx (invariant 10) and answers a business refusal
// as { ok: false, reason }.
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { customers } from '../db/schema/customers';
import { writeAudit } from '../audit';
import { add, minor, subtract, type Minor } from '../../money';
import { cleanCustomerName, codePointLength } from '../../sync-ops';

/** Every customer write takes this (the InventoryWriteContext shape). */
export type CustomerWriteContext = {
	restaurantId: string;
	actorUserId: string;
	ip: string | null;
	userAgent: string | null;
};

export const CUSTOMER_PHONE_MIN = 3;
export const CUSTOMER_PHONE_MAX = 32;

export type CustomerRow = {
	id: string;
	name: string;
	phone: string;
	/** null = no limit. */
	creditLimitMinor: Minor | null;
	archivedAt: Date | null;
	createdAt: Date;
};

export type CustomerWithBalance = CustomerRow & { balanceMinor: Minor };

export type CustomerInput = {
	name: string;
	phone: string;
	creditLimitMinor: Minor | null;
};

type InputRefusal = { ok: false; reason: 'invalid_name' | 'invalid_phone' | 'invalid_limit' };

/**
 * THE balance of the customer row aliased `c`: charges minus unreversed
 * payments, each its own scalar subquery (bigint). Every query in this module
 * and in ./payments.ts uses this fragment; nothing retypes it.
 */
export const customerBalanceSql: SQL = sql`(
	coalesce((
		select sum(p.amount_minor) from payments p
		where p.restaurant_id = c.restaurant_id and p.customer_id = c.id), 0)
	- coalesce((
		select sum(cp.amount_minor) from customer_payments cp
		where cp.restaurant_id = c.restaurant_id and cp.customer_id = c.id
		  and cp.reversed_at is null), 0)
)`;

/** A phone as stored: control and format characters dropped, whitespace
 * collapsed, trimmed. Returns null outside 3–32 code points. */
export function cleanCustomerPhone(raw: string): string | null {
	if (typeof raw !== 'string') return null;
	const cleaned = raw
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const length = codePointLength(cleaned);
	if (length < CUSTOMER_PHONE_MIN || length > CUSTOMER_PHONE_MAX) return null;
	return cleaned;
}

function cleanInput(
	input: CustomerInput
): { ok: true; name: string; phone: string; creditLimitMinor: Minor | null } | InputRefusal {
	const name = typeof input.name === 'string' ? cleanCustomerName(input.name) : '';
	if (name === '') return { ok: false, reason: 'invalid_name' };
	const phone = cleanCustomerPhone(input.phone);
	if (phone === null) return { ok: false, reason: 'invalid_phone' };
	const limit = input.creditLimitMinor;
	if (limit !== null && (typeof limit !== 'bigint' || limit < 0n)) {
		return { ok: false, reason: 'invalid_limit' };
	}
	return { ok: true, name, phone, creditLimitMinor: limit };
}

/** True when `error` (or a cause in its chain) is a 23505 on `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth++) {
		const c = current as { code?: string; constraint?: string; cause?: unknown };
		if (c.code === '23505' && c.constraint === constraint) return true;
		current = c.cause;
	}
	return false;
}

const PHONE_UNIQUE = 'customers_phone_unique';

function toRow(row: {
	id: string;
	name: string;
	phone: string;
	creditLimitMinor: bigint | null;
	archivedAt: Date | null;
	createdAt: Date;
}): CustomerRow {
	return {
		id: row.id,
		name: row.name,
		phone: row.phone,
		creditLimitMinor: row.creditLimitMinor === null ? null : minor(row.creditLimitMinor),
		archivedAt: row.archivedAt,
		createdAt: row.createdAt
	};
}

const ROW_COLUMNS = {
	id: customers.id,
	name: customers.name,
	phone: customers.phone,
	creditLimitMinor: customers.creditLimitMinor,
	archivedAt: customers.archivedAt,
	createdAt: customers.createdAt
};

/**
 * THE customer lock: `select … for update` on the one row, scoped by
 * restaurant. Null when the id is not a customer of this restaurant. Take it
 * BEFORE reading a balance you are about to act on, and after the shift lock.
 */
export async function lockCustomer(
	tx: DbTx,
	restaurantId: string,
	customerId: string
): Promise<CustomerRow | null> {
	const [row] = await tx
		.select(ROW_COLUMNS)
		.from(customers)
		.where(and(eq(customers.id, customerId), eq(customers.restaurantId, restaurantId)))
		.for('update');
	return row ? toRow(row) : null;
}

/** What one customer owes now. 0 for an unknown id. */
export async function balanceOf(
	executor: Executor,
	restaurantId: string,
	customerId: string
): Promise<Minor> {
	const result = await executor.execute<{ balance: string }>(sql`
		select ${customerBalanceSql}::text as balance
		from customers c
		where c.id = ${customerId} and c.restaurant_id = ${restaurantId}
	`);
	const row = result.rows[0];
	return minor(row ? BigInt(row.balance) : 0n);
}

type ListedRow = {
	id: string;
	name: string;
	phone: string;
	credit_limit_minor: string | null;
	archived_at: Date | string | null;
	created_at: Date | string;
	balance: string;
};

function toListed(row: ListedRow): CustomerWithBalance {
	return {
		id: row.id,
		name: row.name,
		phone: row.phone,
		creditLimitMinor:
			row.credit_limit_minor === null ? null : minor(BigInt(row.credit_limit_minor)),
		archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
		createdAt: new Date(row.created_at),
		balanceMinor: minor(BigInt(row.balance))
	};
}

/**
 * The restaurant's customers with what each owes, by name.
 * `live` (default): unarchived only. `all`: archived too. `collectable`: the
 * till's list — every live customer plus each archived one who still owes.
 */
export async function listCustomers(
	executor: Executor,
	restaurantId: string,
	options: { include?: 'live' | 'all' | 'collectable' } = {}
): Promise<CustomerWithBalance[]> {
	const include = options.include ?? 'live';
	const filter =
		include === 'all'
			? sql`true`
			: include === 'collectable'
				? sql`(c.archived_at is null or ${customerBalanceSql} <> 0)`
				: sql`c.archived_at is null`;
	const result = await executor.execute<ListedRow>(sql`
		select c.id, c.name, c.phone, c.credit_limit_minor::text as credit_limit_minor,
		       c.archived_at, c.created_at, ${customerBalanceSql}::text as balance
		from customers c
		where c.restaurant_id = ${restaurantId} and ${filter}
		order by lower(c.name), c.id
	`);
	return result.rows.map(toListed);
}

/** One customer with their balance, archived or not; null when unknown. */
export async function getCustomer(
	executor: Executor,
	restaurantId: string,
	customerId: string
): Promise<CustomerWithBalance | null> {
	const result = await executor.execute<ListedRow>(sql`
		select c.id, c.name, c.phone, c.credit_limit_minor::text as credit_limit_minor,
		       c.archived_at, c.created_at, ${customerBalanceSql}::text as balance
		from customers c
		where c.restaurant_id = ${restaurantId} and c.id = ${customerId}
	`);
	const row = result.rows[0];
	return row ? toListed(row) : null;
}

export async function createCustomer(
	tx: DbTx,
	ctx: CustomerWriteContext,
	input: CustomerInput
): Promise<{ ok: true; customerId: string } | InputRefusal | { ok: false; reason: 'phone_taken' }> {
	const cleaned = cleanInput(input);
	if (!cleaned.ok) return cleaned;
	try {
		// A savepoint: a duplicate phone rolls back the insert AND its audit row and
		// leaves the caller's transaction usable.
		const customerId = await tx.transaction(async (sp) => {
			const [row] = await sp
				.insert(customers)
				.values({
					restaurantId: ctx.restaurantId,
					name: cleaned.name,
					phone: cleaned.phone,
					creditLimitMinor: cleaned.creditLimitMinor
				})
				.returning({ id: customers.id });
			await writeAudit(sp, {
				restaurantId: ctx.restaurantId,
				actorUserId: ctx.actorUserId,
				subjectUserId: null,
				ip: ctx.ip,
				userAgent: ctx.userAgent,
				event: 'customer.created',
				details: {
					customerId: row.id,
					name: cleaned.name,
					phone: cleaned.phone,
					creditLimitMinor:
						cleaned.creditLimitMinor === null ? null : cleaned.creditLimitMinor.toString()
				}
			});
			return row.id;
		});
		return { ok: true, customerId };
	} catch (error) {
		if (isUniqueViolation(error, PHONE_UNIQUE)) return { ok: false, reason: 'phone_taken' };
		throw error;
	}
}

export async function updateCustomer(
	tx: DbTx,
	ctx: CustomerWriteContext,
	customerId: string,
	input: CustomerInput
): Promise<
	{ ok: true; changed: boolean } | InputRefusal | { ok: false; reason: 'not_found' | 'phone_taken' }
> {
	const cleaned = cleanInput(input);
	if (!cleaned.ok) return cleaned;
	const current = await lockCustomer(tx, ctx.restaurantId, customerId);
	if (!current) return { ok: false, reason: 'not_found' };

	const changes: Record<string, { old: unknown; new: unknown }> = {};
	if (current.name !== cleaned.name) changes.name = { old: current.name, new: cleaned.name };
	if (current.phone !== cleaned.phone) changes.phone = { old: current.phone, new: cleaned.phone };
	if (current.creditLimitMinor !== cleaned.creditLimitMinor) {
		changes.creditLimitMinor = {
			old: current.creditLimitMinor === null ? null : current.creditLimitMinor.toString(),
			new: cleaned.creditLimitMinor === null ? null : cleaned.creditLimitMinor.toString()
		};
	}
	if (Object.keys(changes).length === 0) return { ok: true, changed: false };

	try {
		await tx.transaction(async (sp) => {
			await sp
				.update(customers)
				.set({
					name: cleaned.name,
					phone: cleaned.phone,
					creditLimitMinor: cleaned.creditLimitMinor,
					updatedAt: new Date()
				})
				.where(and(eq(customers.id, customerId), eq(customers.restaurantId, ctx.restaurantId)));
			await writeAudit(sp, {
				restaurantId: ctx.restaurantId,
				actorUserId: ctx.actorUserId,
				subjectUserId: null,
				ip: ctx.ip,
				userAgent: ctx.userAgent,
				event: 'customer.updated',
				details: { customerId, changes }
			});
		});
	} catch (error) {
		if (isUniqueViolation(error, PHONE_UNIQUE)) return { ok: false, reason: 'phone_taken' };
		throw error;
	}
	return { ok: true, changed: true };
}

/** Unresolved unrecorded credit sales naming this customer: a charge the owner
 * has not yet retried or dismissed on /reports/flagged. */
async function unrecordedChargeCount(
	executor: Executor,
	restaurantId: string,
	customerId: string
): Promise<number> {
	const result = await executor.execute<{ c: number }>(sql`
		select count(*)::int as c
		from pos_sync_ops o
		where o.restaurant_id = ${restaurantId}
		  and o.kind = 'sale.complete'
		  and o.status = 'unrecorded'
		  and o.resolved_at is null
		  and o.payload -> 'payments' -> 0 ->> 'method' = 'credit'
		  and o.payload -> 'payments' -> 0 ->> 'customerId' = ${customerId}
	`);
	return result.rows[0]?.c ?? 0;
}

/**
 * Archive: the customer leaves the till's list and can no longer be charged.
 * Refused while they owe anything (or are owed), and while an unrecorded credit
 * sale names them — either would leave a balance nobody is looking at.
 */
export async function archiveCustomer(
	tx: DbTx,
	ctx: CustomerWriteContext,
	customerId: string
): Promise<
	| { ok: true }
	| {
			ok: false;
			reason: 'not_found' | 'already_archived' | 'has_balance' | 'has_unrecorded_charge';
	  }
> {
	const current = await lockCustomer(tx, ctx.restaurantId, customerId);
	if (!current) return { ok: false, reason: 'not_found' };
	if (current.archivedAt !== null) return { ok: false, reason: 'already_archived' };
	// Under the customer lock: a racing charge or payment has committed or waits.
	const balance = await balanceOf(tx, ctx.restaurantId, customerId);
	if (balance !== 0n) return { ok: false, reason: 'has_balance' };
	if ((await unrecordedChargeCount(tx, ctx.restaurantId, customerId)) > 0) {
		return { ok: false, reason: 'has_unrecorded_charge' };
	}
	await tx
		.update(customers)
		.set({ archivedAt: new Date(), updatedAt: new Date() })
		.where(and(eq(customers.id, customerId), eq(customers.restaurantId, ctx.restaurantId)));
	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'customer.archived',
		details: { customerId, name: current.name }
	});
	return { ok: true };
}

/** Restore an archived customer. Refused while a LIVE customer holds the phone. */
export async function restoreCustomer(
	tx: DbTx,
	ctx: CustomerWriteContext,
	customerId: string
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_archived' | 'phone_taken' }> {
	const current = await lockCustomer(tx, ctx.restaurantId, customerId);
	if (!current) return { ok: false, reason: 'not_found' };
	if (current.archivedAt === null) return { ok: false, reason: 'not_archived' };
	try {
		await tx.transaction(async (sp) => {
			await sp
				.update(customers)
				.set({ archivedAt: null, updatedAt: new Date() })
				.where(and(eq(customers.id, customerId), eq(customers.restaurantId, ctx.restaurantId)));
			await writeAudit(sp, {
				restaurantId: ctx.restaurantId,
				actorUserId: ctx.actorUserId,
				subjectUserId: null,
				ip: ctx.ip,
				userAgent: ctx.userAgent,
				event: 'customer.restored',
				details: { customerId, name: current.name }
			});
		});
	} catch (error) {
		if (isUniqueViolation(error, PHONE_UNIQUE)) return { ok: false, reason: 'phone_taken' };
		throw error;
	}
	return { ok: true };
}

export type StatementRow = {
	kind: 'charge' | 'payment' | 'reversal';
	/** The business date the row belongs to (invariant 11). */
	businessDate: string;
	at: Date;
	/** A charge: its invoice number. A payment or reversal: the payment id. */
	reference: string;
	/** The customer payment this row is, or reverses; null on a charge. */
	paymentId: string | null;
	/** A payment's method name; null otherwise. */
	methodName: string | null;
	/** A payment's method kind; null otherwise. */
	method: 'cash' | 'card' | 'mobile' | null;
	/** A reversal's reason; null otherwise. */
	reason: string | null;
	cashierName: string | null;
	tillCode: string | null;
	/** Signed: a charge and a reversal raise the balance (+), a payment lowers it (−). */
	amountMinor: Minor;
	/** The balance after this row. */
	balanceMinor: Minor;
	/** A payment only: it has been reversed (its reversal is its own row). */
	reversed: boolean;
};

/**
 * Everything that moved one customer's balance, oldest first, with a running
 * balance whose last value equals balanceOf. A reversed payment stays on its
 * own date and its reversal is a separate row on the reversal's date — last
 * month's statement never changes.
 */
export async function statement(
	executor: Executor,
	restaurantId: string,
	customerId: string
): Promise<StatementRow[]> {
	const result = await executor.execute<{
		kind: 'charge' | 'payment' | 'reversal';
		business_date: string;
		at: Date | string;
		reference: string;
		payment_id: string | null;
		method_name: string | null;
		method: 'cash' | 'card' | 'mobile' | null;
		reason: string | null;
		cashier_name: string | null;
		till_code: string | null;
		amount: string;
		reversed: boolean;
	}>(sql`
		select * from (
			select 'charge' as kind, s.business_date::text as business_date, p.paid_at as at,
			       coalesce(i.invoice_number, p.order_id::text) as reference,
			       null::uuid as payment_id, null::text as method_name, null::text as method,
			       null::text as reason, u.display_name as cashier_name, d.device_code as till_code,
			       p.amount_minor::text as amount, false as reversed, 0 as tie
			from payments p
			join orders o on o.id = p.order_id and o.restaurant_id = p.restaurant_id
			join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = o.restaurant_id
			left join invoices i on i.order_id = o.id and i.restaurant_id = o.restaurant_id
			left join users u on u.id = o.employee_user_id
			left join pos_devices d on d.id = o.device_id
			where p.restaurant_id = ${restaurantId} and p.customer_id = ${customerId}
			union all
			select 'payment', cp.business_date::text, cp.received_at, cp.id::text, cp.id,
			       cp.payment_method_name, cp.method, null, u.display_name, d.device_code,
			       cp.amount_minor::text, cp.reversed_at is not null, 1
			from customer_payments cp
			left join users u on u.id = cp.recorded_by_user_id
			left join pos_devices d on d.id = cp.device_id
			where cp.restaurant_id = ${restaurantId} and cp.customer_id = ${customerId}
			union all
			select 'reversal', cp.reversal_business_date::text, cp.reversed_at, cp.id::text, cp.id,
			       cp.payment_method_name, cp.method, cp.reversal_reason, u.display_name, null,
			       cp.amount_minor::text, false, 2
			from customer_payments cp
			left join users u on u.id = cp.reversed_by_user_id
			where cp.restaurant_id = ${restaurantId} and cp.customer_id = ${customerId}
			  and cp.reversed_at is not null
		) rows
		order by at, tie, reference
	`);

	let balance = minor(0n);
	return result.rows.map((row) => {
		const amount = minor(BigInt(row.amount));
		// The money module does the arithmetic (invariant 1).
		balance = row.kind === 'payment' ? subtract(balance, amount) : add(balance, amount);
		return {
			kind: row.kind,
			businessDate: row.business_date,
			at: new Date(row.at),
			reference: row.reference,
			paymentId: row.payment_id,
			methodName: row.kind === 'charge' ? null : row.method_name,
			method: row.kind === 'charge' ? null : row.method,
			reason: row.reason,
			cashierName: row.cashier_name,
			tillCode: row.till_code,
			amountMinor: row.kind === 'payment' ? subtract(minor(0n), amount) : amount,
			balanceMinor: balance,
			reversed: row.reversed
		};
	});
}

/**
 * The tripwire (the /inventory cache-vs-ledger precedent): the sum of every
 * customer's balance beside the net of account 1100 Accounts Receivable in the
 * journal. They are equal by construction — every charge and every payment
 * posts to 1100 in the transaction that records it — so a difference means a
 * row reached one side without the other. Reported, never repaired here.
 */
export async function receivableTripwire(
	executor: Executor,
	restaurantId: string
): Promise<{ sumOfBalances: Minor; ledger1100: Minor; matches: boolean }> {
	const result = await executor.execute<{ balances: string; ledger: string }>(sql`
		select
			coalesce((
				select sum(${customerBalanceSql}) from customers c
				where c.restaurant_id = ${restaurantId}), 0)::text as balances,
			coalesce((
				select sum(l.debit_minor) - sum(l.credit_minor)
				from journal_entry_lines l
				join accounts a on a.id = l.account_id and a.restaurant_id = l.restaurant_id
				where l.restaurant_id = ${restaurantId} and a.code = '1100'), 0)::text as ledger
	`);
	const row = result.rows[0];
	const sumOfBalances = minor(BigInt(row?.balances ?? '0'));
	const ledger1100 = minor(BigInt(row?.ledger ?? '0'));
	return { sumOfBalances, ledger1100, matches: sumOfBalances === ledger1100 };
}
