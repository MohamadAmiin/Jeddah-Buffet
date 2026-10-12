// THE DETAILED REPORT QUERIES (tasks/sales-report-export T-04, T-05, T-06).
//
// Read-only SQL over STORED columns, like sales.ts: every function takes
// restaurantId explicitly and filters on it in every joined table; sales are
// grouped by pos_sessions.business_date and cost by journal_entries.business_date,
// never by a timestamp cast (invariant 11). The only arithmetic is a SQL sum() or
// integer expression over stored integer columns, or add/subtract/sum from the
// money module — nothing here rounds, divides or recomputes a total, and nothing
// imports computeOrderTotals, taxBreakdown, roundToMinor or a tax helper
// (invariants 1 and 7). Money leaves SQL as text and becomes a Minor through
// BigInt, never through Number.
//
// Spec 23 (5000, 5100, 5200 verbatim), 25 (gross profit), 26, 27.

import { sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import { add, minor, subtract, sum, type Minor } from '../../money';

const big = (text: string | null): Minor => minor(BigInt(text ?? '0'));

// ── By business date and gross profit (T-04) ────────────────────────────────

export type DayRow = {
	businessDate: string;
	orderCount: number;
	grossSales: Minor;
	discounts: Minor;
	netSales: Minor;
	tax: Minor;
	takings: Minor;
	/** Σ (debit − credit) on 5000 Cost of Goods Sold, revaluations included. Signed. */
	cogs: Minor;
	/** Σ (debit − credit) on 5100 Waste & Inventory Adjustments. Signed. */
	waste: Minor;
	/** Σ (debit − credit) on 5200 Comps & Staff Meals. Signed. */
	comps: Minor;
	costOfSales: Minor;
	grossProfit: Minor;
	openShifts: number;
};

/**
 * One row per business date of [from, to], days with nothing included — the row
 * set comes from generate_series, so a day with waste or a count but no sale
 * still carries its cost and the rows always add up to the range (spec 25).
 * Sales, payments, cost and open shifts are separate grouped subqueries, so no
 * join can fan one out over another.
 */
export async function byBusinessDate(
	database: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<DayRow[]> {
	const result = await database.execute<{
		business_date: string;
		order_count: number;
		gross: string;
		discounts: string;
		tax: string;
		takings: string;
		cogs: string;
		waste: string;
		comps: string;
		open_shifts: number;
	}>(sql`
		with days as (
			select d::date as business_date
			from generate_series(${from}::timestamp, ${to}::timestamp, interval '1 day') d
		),
		sales as (
			select s.business_date,
				count(*)::int as order_count,
				sum(o.subtotal_minor) as gross,
				sum(o.discount_minor) as discounts,
				sum(o.tax_minor) as tax
			from orders o
			join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = ${restaurantId}
			where o.restaurant_id = ${restaurantId}
				and o.status = 'paid'
				and s.business_date between ${from} and ${to}
			group by s.business_date
		),
		takings as (
			select s.business_date, sum(p.amount_minor) as takings
			from payments p
			join orders o on o.id = p.order_id and o.restaurant_id = ${restaurantId}
			join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = ${restaurantId}
			where p.restaurant_id = ${restaurantId}
				and o.status = 'paid'
				and s.business_date between ${from} and ${to}
			group by s.business_date
		),
		costs as (
			select e.business_date,
				sum(l.debit_minor - l.credit_minor) filter (where a.code = '5000') as cogs,
				sum(l.debit_minor - l.credit_minor) filter (where a.code = '5100') as waste,
				sum(l.debit_minor - l.credit_minor) filter (where a.code = '5200') as comps
			from journal_entries e
			join journal_entry_lines l on l.entry_id = e.id and l.restaurant_id = e.restaurant_id
			join accounts a on a.id = l.account_id and a.restaurant_id = l.restaurant_id
			where e.restaurant_id = ${restaurantId}
				and a.code in ('5000', '5100', '5200')
				and e.business_date between ${from} and ${to}
			group by e.business_date
		),
		open_shifts as (
			select business_date, count(*)::int as open_shifts
			from pos_sessions
			where restaurant_id = ${restaurantId}
				and status = 'open'
				and business_date between ${from} and ${to}
			group by business_date
		)
		select to_char(days.business_date, 'YYYY-MM-DD') as business_date,
			coalesce(sales.order_count, 0) as order_count,
			coalesce(sales.gross, 0)::text as gross,
			coalesce(sales.discounts, 0)::text as discounts,
			coalesce(sales.tax, 0)::text as tax,
			coalesce(takings.takings, 0)::text as takings,
			coalesce(costs.cogs, 0)::text as cogs,
			coalesce(costs.waste, 0)::text as waste,
			coalesce(costs.comps, 0)::text as comps,
			coalesce(open_shifts.open_shifts, 0) as open_shifts
		from days
		left join sales on sales.business_date = days.business_date
		left join takings on takings.business_date = days.business_date
		left join costs on costs.business_date = days.business_date
		left join open_shifts on open_shifts.business_date = days.business_date
		order by days.business_date
	`);

	return result.rows.map((r) => {
		const grossSales = big(r.gross);
		const discounts = big(r.discounts);
		const netSales = subtract(grossSales, discounts);
		const cogs = big(r.cogs);
		const waste = big(r.waste);
		const comps = big(r.comps);
		const costOfSales = sum([cogs, waste, comps]);
		return {
			businessDate: r.business_date,
			orderCount: r.order_count,
			grossSales,
			discounts,
			netSales,
			tax: big(r.tax),
			takings: big(r.takings),
			cogs,
			waste,
			comps,
			costOfSales,
			grossProfit: subtract(netSales, costOfSales),
			openShifts: r.open_shifts
		};
	});
}

export type DayTotals = Omit<DayRow, 'businessDate'>;

/** THE range totals of the profit section: summed from the same rows the day
 * table shows, so the tiles and the rows reconcile by construction. */
export function sumDays(rows: readonly DayRow[]): DayTotals {
	const zero = minor(0n);
	const totals: DayTotals = {
		orderCount: 0,
		grossSales: zero,
		discounts: zero,
		netSales: zero,
		tax: zero,
		takings: zero,
		cogs: zero,
		waste: zero,
		comps: zero,
		costOfSales: zero,
		grossProfit: zero,
		openShifts: 0
	};
	for (const r of rows) {
		totals.orderCount += r.orderCount;
		totals.openShifts += r.openShifts;
		totals.grossSales = add(totals.grossSales, r.grossSales);
		totals.discounts = add(totals.discounts, r.discounts);
		totals.netSales = add(totals.netSales, r.netSales);
		totals.tax = add(totals.tax, r.tax);
		totals.takings = add(totals.takings, r.takings);
		totals.cogs = add(totals.cogs, r.cogs);
		totals.waste = add(totals.waste, r.waste);
		totals.comps = add(totals.comps, r.comps);
		totals.costOfSales = add(totals.costOfSales, r.costOfSales);
		totals.grossProfit = add(totals.grossProfit, r.grossProfit);
	}
	return totals;
}
