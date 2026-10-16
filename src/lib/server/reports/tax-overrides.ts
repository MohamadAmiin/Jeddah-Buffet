// THE TAX-EXEMPT BILLS REPORT (tasks/bill-tax-override T-09).
//
// Any cashier may make a bill tax-exempt with a reason and no owner PIN (the
// user's choice, 2026-10-15). A cashier who exempts a cash bill and keeps the tax
// the customer paid leaves a drawer that balances, so this list — every exempt
// bill, with its reason and the tax it removed, and a total per cashier — is the
// owner's control.
//
// Read-only, over STORED columns only (the reports/ rule): the override columns
// and tax_removed_minor were written by the payment transaction from the till's
// numbers, so nothing here recomputes money. A SQL sum() of an integer column is
// the only arithmetic. Grouped and filtered by the POS session's business date,
// never a timestamp cast (invariant 11). Spec 10, 26, 27.

import { and, asc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import { invoices, orders } from '../db/schema/orders';
import { posSessions } from '../db/schema/pos-sessions';
import { users } from '../db/schema/users';
import { minor, type Minor } from '../../money';

export type TaxOverrideRow = {
	orderId: string;
	invoiceNumber: string;
	businessDate: string;
	paidAt: Date;
	cashier: string;
	rateName: string;
	reason: string;
	totalMinor: Minor;
	taxRemovedMinor: Minor;
};

export type TaxOverrideCashier = {
	userId: string;
	cashier: string;
	count: number;
	taxRemovedMinor: Minor;
};

export type TaxOverrideReport = {
	from: string;
	to: string;
	rows: TaxOverrideRow[];
	byCashier: TaxOverrideCashier[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every exempt bill of the restaurant between two business dates, inclusive. */
export async function listTaxOverrides(
	database: Executor,
	restaurantId: string,
	range: { from: string; to: string }
): Promise<TaxOverrideReport> {
	for (const date of [range.from, range.to]) {
		if (!DATE.test(date)) {
			throw new RangeError(`business dates must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
		}
	}
	const filter = and(
		eq(orders.restaurantId, restaurantId),
		eq(orders.status, 'paid'),
		isNotNull(orders.taxOverrideRateId),
		eq(posSessions.restaurantId, restaurantId),
		gte(posSessions.businessDate, range.from),
		lte(posSessions.businessDate, range.to)
	);

	const rows = await database
		.select({
			orderId: orders.id,
			invoiceNumber: invoices.invoiceNumber,
			businessDate: posSessions.businessDate,
			paidAt: orders.paidAt,
			cashier: users.displayName,
			rateName: orders.taxOverrideRateName,
			reason: orders.taxOverrideReason,
			totalMinor: orders.totalMinor,
			taxRemovedMinor: orders.taxRemovedMinor
		})
		.from(orders)
		.innerJoin(posSessions, eq(posSessions.id, orders.posSessionId))
		.innerJoin(
			invoices,
			and(eq(invoices.orderId, orders.id), eq(invoices.restaurantId, restaurantId))
		)
		.innerJoin(users, eq(users.id, orders.employeeUserId))
		.where(filter)
		.orderBy(asc(posSessions.businessDate), asc(orders.paidAt), asc(invoices.invoiceNumber));

	const cashierRows = await database
		.select({
			userId: orders.employeeUserId,
			cashier: users.displayName,
			count: sql<number>`count(*)::int`,
			taxRemoved: sql<string>`coalesce(sum(${orders.taxRemovedMinor}), 0)::bigint`
		})
		.from(orders)
		.innerJoin(posSessions, eq(posSessions.id, orders.posSessionId))
		.innerJoin(users, eq(users.id, orders.employeeUserId))
		.where(filter)
		.groupBy(orders.employeeUserId, users.displayName)
		.orderBy(sql`coalesce(sum(${orders.taxRemovedMinor}), 0) desc`, asc(users.displayName));

	return {
		from: range.from,
		to: range.to,
		// The five override columns are all-or-none (orders_tax_override_all_or_none),
		// so a row selected on tax_override_rate_id has every one of them.
		rows: rows.map((row) => ({
			orderId: row.orderId,
			invoiceNumber: row.invoiceNumber,
			businessDate: row.businessDate,
			paidAt: row.paidAt,
			cashier: row.cashier,
			rateName: row.rateName as string,
			reason: row.reason as string,
			totalMinor: minor(row.totalMinor),
			taxRemovedMinor: minor(row.taxRemovedMinor as bigint)
		})),
		byCashier: cashierRows.map((row) => ({
			userId: row.userId,
			cashier: row.cashier,
			count: row.count,
			taxRemovedMinor: minor(BigInt(row.taxRemoved))
		}))
	};
}
