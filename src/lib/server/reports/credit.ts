// THE CUSTOMER CREDIT REPORT (tasks/customer-credit T-14).
//
// Any cashier holding pos.payment may charge a bill to a registered customer
// with no owner PIN (the user's choice, 2026-11-12). A cashier who charges a
// bill the customer paid in cash to someone's account, and keeps the cash,
// leaves a drawer that balances — a credit sale never opens it. So this list —
// every credit charge and every customer payment, with a total per cashier — is
// the owner's control, beside the customer's own statement.
//
// Read-only, over STORED columns only (the reports/ rule): nothing here
// recomputes money, and a SQL sum() of an integer column is the only
// arithmetic. Grouped and filtered by BUSINESS DATE, never a timestamp cast
// (invariant 11): a charge by its shift's date, a payment by its shift's date,
// a reversal by its own reversal date. Spec 10, 26, 27.

import { sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import { minor, type Minor } from '../../money';

export type CreditChargeRow = {
	orderId: string;
	invoiceNumber: string;
	businessDate: string;
	paidAt: Date;
	customerId: string;
	customerName: string;
	cashier: string;
	tillCode: string;
	amountMinor: Minor;
};

export type CreditPaymentRow = {
	paymentId: string;
	/** `reversal` is the undoing of an earlier payment, on its own date. */
	kind: 'payment' | 'reversal';
	businessDate: string;
	at: Date;
	customerId: string;
	customerName: string;
	methodName: string;
	method: 'cash' | 'card' | 'mobile';
	cashier: string;
	/** A payment's amount; a reversal's amount (shown as a negative by the page). */
	amountMinor: Minor;
	reason: string | null;
};

export type CreditCashierRow = {
	userId: string | null;
	cashier: string;
	charges: number;
	chargedMinor: Minor;
	payments: number;
	receivedMinor: Minor;
};

export type CreditReport = {
	from: string;
	to: string;
	charges: CreditChargeRow[];
	payments: CreditPaymentRow[];
	byCashier: CreditCashierRow[];
	chargedMinor: Minor;
	/** Payments received minus reversals, in the range. */
	receivedNetMinor: Minor;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN = '(unknown)';

/** Every credit charge and customer payment between two business dates, inclusive. */
export async function creditReport(
	database: Executor,
	restaurantId: string,
	range: { from: string; to: string }
): Promise<CreditReport> {
	for (const date of [range.from, range.to]) {
		if (!DATE.test(date)) {
			throw new RangeError(`business dates must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
		}
	}

	const chargeRows = await database.execute<{
		order_id: string;
		invoice_number: string | null;
		business_date: string;
		paid_at: Date | string;
		customer_id: string;
		customer_name: string;
		user_id: string | null;
		cashier: string | null;
		till_code: string | null;
		amount: string;
	}>(sql`
		select o.id as order_id, i.invoice_number, s.business_date::text as business_date,
		       p.paid_at, p.customer_id, p.customer_name, o.employee_user_id as user_id,
		       u.display_name as cashier, d.device_code as till_code, p.amount_minor::text as amount
		from payments p
		join orders o on o.id = p.order_id and o.restaurant_id = p.restaurant_id
		join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = o.restaurant_id
		left join invoices i on i.order_id = o.id and i.restaurant_id = o.restaurant_id
		left join users u on u.id = o.employee_user_id and u.restaurant_id = o.restaurant_id
		left join pos_devices d on d.id = o.device_id
		where p.restaurant_id = ${restaurantId} and p.method = 'credit' and o.status = 'paid'
		  and s.business_date between ${range.from} and ${range.to}
		order by s.business_date, p.paid_at, o.id
	`);

	const paymentRows = await database.execute<{
		payment_id: string;
		kind: 'payment' | 'reversal';
		business_date: string;
		at: Date | string;
		customer_id: string;
		customer_name: string;
		method_name: string;
		method: 'cash' | 'card' | 'mobile';
		user_id: string | null;
		cashier: string | null;
		amount: string;
		reason: string | null;
	}>(sql`
		select * from (
			select cp.id as payment_id, 'payment' as kind, cp.business_date::text as business_date,
			       cp.received_at as at, cp.customer_id, c.name as customer_name,
			       cp.payment_method_name as method_name, cp.method,
			       cp.recorded_by_user_id as user_id, u.display_name as cashier,
			       cp.amount_minor::text as amount, null::text as reason, cp.created_at as recorded
			from customer_payments cp
			join customers c on c.id = cp.customer_id and c.restaurant_id = cp.restaurant_id
			left join users u on u.id = cp.recorded_by_user_id
			where cp.restaurant_id = ${restaurantId}
			  and cp.business_date between ${range.from} and ${range.to}
			union all
			select cp.id, 'reversal', cp.reversal_business_date::text, cp.reversed_at,
			       cp.customer_id, c.name, cp.payment_method_name, cp.method,
			       cp.reversed_by_user_id, u.display_name, cp.amount_minor::text,
			       cp.reversal_reason, cp.reversed_at
			from customer_payments cp
			join customers c on c.id = cp.customer_id and c.restaurant_id = cp.restaurant_id
			left join users u on u.id = cp.reversed_by_user_id
			where cp.restaurant_id = ${restaurantId}
			  and cp.reversal_business_date between ${range.from} and ${range.to}
		) rows
		order by business_date, at, recorded, payment_id
	`);

	// One row per cashier: what they charged to credit and what they received.
	// Two scalar-shaped halves joined by user — never charges joined to payments.
	const cashierRows = await database.execute<{
		user_id: string | null;
		cashier: string | null;
		charges: number;
		charged: string;
		payments: number;
		received: string;
	}>(sql`
		select t.user_id, u.display_name as cashier,
		       coalesce(sum(t.charges), 0)::int as charges,
		       coalesce(sum(t.charged), 0)::text as charged,
		       coalesce(sum(t.payments), 0)::int as payments,
		       coalesce(sum(t.received), 0)::text as received
		from (
			select o.employee_user_id as user_id, 1 as charges, p.amount_minor as charged,
			       0 as payments, 0::bigint as received
			from payments p
			join orders o on o.id = p.order_id and o.restaurant_id = p.restaurant_id
			join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = o.restaurant_id
			where p.restaurant_id = ${restaurantId} and p.method = 'credit' and o.status = 'paid'
			  and s.business_date between ${range.from} and ${range.to}
			union all
			select cp.recorded_by_user_id, 0, 0::bigint, 1, cp.amount_minor
			from customer_payments cp
			where cp.restaurant_id = ${restaurantId}
			  and cp.business_date between ${range.from} and ${range.to}
		) t
		left join users u on u.id = t.user_id
		group by t.user_id, u.display_name
		order by coalesce(sum(t.charged), 0) desc, coalesce(u.display_name, '') asc
	`);

	// Totals in SQL, like every other figure here.
	const totals = await database.execute<{ charged: string; received: string }>(sql`
		select
			coalesce((
				select sum(p.amount_minor)
				from payments p
				join orders o on o.id = p.order_id and o.restaurant_id = p.restaurant_id
				join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = o.restaurant_id
				where p.restaurant_id = ${restaurantId} and p.method = 'credit' and o.status = 'paid'
				  and s.business_date between ${range.from} and ${range.to}), 0)::text as charged,
			(coalesce((
				select sum(cp.amount_minor) from customer_payments cp
				where cp.restaurant_id = ${restaurantId}
				  and cp.business_date between ${range.from} and ${range.to}), 0)
			 - coalesce((
				select sum(cp.amount_minor) from customer_payments cp
				where cp.restaurant_id = ${restaurantId}
				  and cp.reversal_business_date between ${range.from} and ${range.to}), 0))::text
				as received
	`);

	return {
		from: range.from,
		to: range.to,
		charges: chargeRows.rows.map((r) => ({
			orderId: r.order_id,
			invoiceNumber: r.invoice_number ?? r.order_id,
			businessDate: r.business_date,
			paidAt: new Date(r.paid_at),
			customerId: r.customer_id,
			customerName: r.customer_name,
			cashier: r.cashier ?? UNKNOWN,
			tillCode: r.till_code ?? UNKNOWN,
			amountMinor: minor(BigInt(r.amount))
		})),
		payments: paymentRows.rows.map((r) => ({
			paymentId: r.payment_id,
			kind: r.kind,
			businessDate: r.business_date,
			at: new Date(r.at),
			customerId: r.customer_id,
			customerName: r.customer_name,
			methodName: r.method_name,
			method: r.method,
			cashier: r.cashier ?? UNKNOWN,
			amountMinor: minor(BigInt(r.amount)),
			reason: r.reason
		})),
		byCashier: cashierRows.rows.map((r) => ({
			userId: r.user_id,
			cashier: r.cashier ?? UNKNOWN,
			charges: r.charges,
			chargedMinor: minor(BigInt(r.charged)),
			payments: r.payments,
			receivedMinor: minor(BigInt(r.received))
		})),
		chargedMinor: minor(BigInt(totals.rows[0]?.charged ?? '0')),
		receivedNetMinor: minor(BigInt(totals.rows[0]?.received ?? '0'))
	};
}
