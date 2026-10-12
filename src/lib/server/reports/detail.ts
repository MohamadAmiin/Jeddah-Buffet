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

// ── Orders and order lines (T-05) ───────────────────────────────────────────

export type PaymentKind = 'cash' | 'card' | 'mobile';

export type OrderRow = {
	orderId: string;
	businessDate: string;
	deviceCode: string;
	invoiceNumber: string | null;
	invoiceSeq: number | null;
	/** Local time in the restaurant's zone, 'YYYY-MM-DD HH:MM:SS' — the device's clock. */
	paidAt: string;
	/** Local time in the restaurant's zone — when the server stored the sale. */
	receivedAt: string;
	orderType: string;
	tableLabel: string | null;
	employeeName: string | null;
	taxMode: 'exclusive' | 'inclusive';
	lineCount: number;
	subtotal: Minor;
	discount: Minor;
	tax: Minor;
	total: Minor;
	/** In the order they were taken; the method name is the one AT THE TIME OF SALE. */
	payments: { kind: PaymentKind; name: string | null; amount: Minor }[];
	flagReason: string | null;
	note: string | null;
};

const LOCAL = (column: string) =>
	sql.raw(`to_char(${column} at time zone rs.time_zone, 'YYYY-MM-DD HH24:MI:SS')`);

/** The paid orders of the range, ordered by the device's gap-free sequence. */
export async function orderRows(
	database: Executor,
	restaurantId: string,
	from: string,
	to: string,
	opts: { order: 'asc' | 'desc'; limit?: number }
): Promise<OrderRow[]> {
	const dir = sql.raw(opts.order === 'desc' ? 'desc' : 'asc');
	const limit =
		opts.limit === undefined ? sql`` : sql`limit ${Math.max(0, Math.trunc(opts.limit))}`;
	const result = await database.execute<{
		order_id: string;
		business_date: string;
		device_code: string;
		invoice_number: string | null;
		invoice_seq: number | null;
		paid_at: string;
		received_at: string;
		order_type: string;
		table_label: string | null;
		employee_name: string | null;
		tax_mode: string;
		line_count: number;
		subtotal: string;
		discount: string;
		tax: string;
		total: string;
		payments: { kind: string; name: string | null; amount: string }[];
		flag_reason: string | null;
		note: string | null;
	}>(sql`
		select o.id as order_id,
			to_char(s.business_date, 'YYYY-MM-DD') as business_date,
			d.device_code,
			i.invoice_number,
			i.invoice_seq,
			${LOCAL('o.paid_at')} as paid_at,
			${LOCAL('o.received_at')} as received_at,
			o.order_type,
			o.table_label,
			u.display_name as employee_name,
			o.tax_mode,
			lc.line_count,
			o.subtotal_minor::text as subtotal,
			o.discount_minor::text as discount,
			o.tax_minor::text as tax,
			o.total_minor::text as total,
			coalesce(pay.payments, '[]'::json) as payments,
			o.flag_reason,
			o.note
		from orders o
		join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = ${restaurantId}
		join pos_devices d on d.id = o.device_id and d.restaurant_id = ${restaurantId}
		join restaurant_settings rs on rs.restaurant_id = ${restaurantId}
		left join invoices i on i.order_id = o.id and i.restaurant_id = ${restaurantId}
		left join users u on u.id = o.employee_user_id and u.restaurant_id = ${restaurantId}
		left join lateral (
			select count(*)::int as line_count
			from order_lines ol
			where ol.order_id = o.id and ol.restaurant_id = ${restaurantId} and ol.status <> 'voided'
		) lc on true
		left join lateral (
			select json_agg(
				json_build_object('kind', p.method, 'name', p.payment_method_name,
					'amount', p.amount_minor::text)
				order by p.paid_at, p.id) as payments
			from payments p
			where p.order_id = o.id and p.restaurant_id = ${restaurantId}
		) pay on true
		where o.restaurant_id = ${restaurantId}
			and o.status = 'paid'
			and s.business_date between ${from} and ${to}
		order by s.business_date ${dir}, d.device_code ${dir}, i.invoice_seq ${dir} nulls last, o.id
		${limit}
	`);
	return result.rows.map((r) => ({
		orderId: r.order_id,
		businessDate: r.business_date,
		deviceCode: r.device_code,
		invoiceNumber: r.invoice_number,
		invoiceSeq: r.invoice_seq,
		paidAt: r.paid_at,
		receivedAt: r.received_at,
		orderType: r.order_type,
		tableLabel: r.table_label,
		employeeName: r.employee_name,
		// orders_tax_mode_valid admits exactly these two literals.
		taxMode: r.tax_mode as OrderRow['taxMode'],
		lineCount: r.line_count,
		subtotal: big(r.subtotal),
		discount: big(r.discount),
		tax: big(r.tax),
		total: big(r.total),
		// payments_method_valid admits exactly the three kinds.
		payments: r.payments.map((p) => ({
			kind: p.kind as PaymentKind,
			name: p.name,
			amount: big(p.amount)
		})),
		flagReason: r.flag_reason,
		note: r.note
	}));
}

/** How many paid orders the range holds — the page shows a capped list. */
export async function countOrders(
	database: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<number> {
	const result = await database.execute<{ n: number }>(sql`
		select count(*)::int as n
		from orders o
		join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = ${restaurantId}
		where o.restaurant_id = ${restaurantId}
			and o.status = 'paid'
			and s.business_date between ${from} and ${to}
	`);
	return result.rows[0]?.n ?? 0;
}

export type LineRow = {
	businessDate: string;
	deviceCode: string;
	invoiceNumber: string | null;
	paidAt: string;
	orderType: string;
	taxMode: 'exclusive' | 'inclusive';
	lineNo: number;
	itemName: string;
	quantity: number;
	unitPrice: Minor;
	/** Ordered by name, then id — the table has no ordering column of its own. */
	modifiers: { name: string; delta: Minor }[];
	modifierTotal: Minor;
	taxRateName: string | null;
	taxRateBp: number;
	discount: Minor;
	/** (unit price + Σ modifier deltas) × quantity − line discount: STORED integers.
	 * Net in exclusive mode, tax-inclusive in inclusive mode. Never a per-line tax. */
	lineAmount: Minor;
};

/** Every line of the range's paid orders, in invoice then line order. */
export async function lineRows(
	database: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<LineRow[]> {
	const result = await database.execute<{
		business_date: string;
		device_code: string;
		invoice_number: string | null;
		paid_at: string;
		order_type: string;
		tax_mode: string;
		line_no: number;
		item_name: string;
		quantity: number;
		unit_price: string;
		modifiers: { name: string; delta: string }[];
		modifier_total: string;
		tax_rate_name: string | null;
		tax_rate_bp: number;
		discount: string;
		line_amount: string;
	}>(sql`
		select to_char(s.business_date, 'YYYY-MM-DD') as business_date,
			d.device_code,
			i.invoice_number,
			${LOCAL('o.paid_at')} as paid_at,
			o.order_type,
			o.tax_mode,
			ol.line_no,
			ol.item_name,
			ol.quantity,
			ol.unit_price_minor::text as unit_price,
			coalesce(m.mods, '[]'::json) as modifiers,
			coalesce(m.delta, 0)::text as modifier_total,
			ol.tax_rate_name,
			ol.tax_rate_bp,
			ol.discount_minor::text as discount,
			((ol.unit_price_minor + coalesce(m.delta, 0)) * ol.quantity - ol.discount_minor)::text
				as line_amount
		from order_lines ol
		join orders o on o.id = ol.order_id and o.restaurant_id = ${restaurantId}
		join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = ${restaurantId}
		join pos_devices d on d.id = o.device_id and d.restaurant_id = ${restaurantId}
		join restaurant_settings rs on rs.restaurant_id = ${restaurantId}
		left join invoices i on i.order_id = o.id and i.restaurant_id = ${restaurantId}
		left join lateral (
			select json_agg(
					json_build_object('name', olm.modifier_name, 'delta', olm.price_delta_minor::text)
					order by olm.modifier_name, olm.id) as mods,
				sum(olm.price_delta_minor) as delta
			from order_line_modifiers olm
			where olm.order_line_id = ol.id and olm.restaurant_id = ${restaurantId}
		) m on true
		where ol.restaurant_id = ${restaurantId}
			and ol.status <> 'voided'
			and o.status = 'paid'
			and s.business_date between ${from} and ${to}
		order by s.business_date, d.device_code, i.invoice_seq nulls last, o.id, ol.line_no
	`);
	return result.rows.map((r) => ({
		businessDate: r.business_date,
		deviceCode: r.device_code,
		invoiceNumber: r.invoice_number,
		paidAt: r.paid_at,
		orderType: r.order_type,
		taxMode: r.tax_mode as LineRow['taxMode'],
		lineNo: r.line_no,
		itemName: r.item_name,
		quantity: r.quantity,
		unitPrice: big(r.unit_price),
		modifiers: r.modifiers.map((mod) => ({ name: mod.name, delta: big(mod.delta) })),
		modifierTotal: big(r.modifier_total),
		taxRateName: r.tax_rate_name,
		taxRateBp: r.tax_rate_bp,
		discount: big(r.discount),
		lineAmount: big(r.line_amount)
	}));
}

/** How many lines lineRows would return — the export's row cap checks it first. */
export async function countLines(
	database: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<number> {
	const result = await database.execute<{ n: number }>(sql`
		select count(*)::int as n
		from order_lines ol
		join orders o on o.id = ol.order_id and o.restaurant_id = ${restaurantId}
		join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = ${restaurantId}
		where ol.restaurant_id = ${restaurantId}
			and ol.status <> 'voided'
			and o.status = 'paid'
			and s.business_date between ${from} and ${to}
	`);
	return result.rows[0]?.n ?? 0;
}

// ── By tax rate (T-06) ──────────────────────────────────────────────────────

export type TaxRateRow = {
	taxMode: 'exclusive' | 'inclusive';
	/** The rate's name AT THE TIME OF SALE; null on lines recorded before named rates. */
	taxRateName: string | null;
	taxRateBp: number;
	lineCount: number;
	quantity: number;
	/** Σ line amount — the TAXABLE amount, net in exclusive mode, tax-inclusive in
	 * inclusive mode. No per-rate TAX: it is not stored on a sale, and computing it
	 * here would recompute money (gate decision 2). */
	amount: Minor;
};

/** Sales per (stored tax mode, rate name, rate number) over the range. */
export async function salesByTaxRate(
	database: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<TaxRateRow[]> {
	const result = await database.execute<{
		tax_mode: string;
		tax_rate_name: string | null;
		tax_rate_bp: number;
		line_count: number;
		quantity: number;
		amount: string;
	}>(sql`
		select o.tax_mode,
			ol.tax_rate_name,
			ol.tax_rate_bp,
			count(*)::int as line_count,
			sum(ol.quantity)::int as quantity,
			coalesce(sum((ol.unit_price_minor + coalesce(m.delta, 0)) * ol.quantity
				- ol.discount_minor), 0)::text as amount
		from order_lines ol
		join orders o on o.id = ol.order_id and o.restaurant_id = ${restaurantId}
		join pos_sessions s on s.id = o.pos_session_id and s.restaurant_id = ${restaurantId}
		left join lateral (
			select sum(olm.price_delta_minor) as delta
			from order_line_modifiers olm
			where olm.order_line_id = ol.id and olm.restaurant_id = ${restaurantId}
		) m on true
		where ol.restaurant_id = ${restaurantId}
			and ol.status <> 'voided'
			and o.status = 'paid'
			and s.business_date between ${from} and ${to}
		group by o.tax_mode, ol.tax_rate_name, ol.tax_rate_bp
		order by ol.tax_rate_bp desc, ol.tax_rate_name nulls last, o.tax_mode
	`);
	return result.rows.map((r) => ({
		taxMode: r.tax_mode as TaxRateRow['taxMode'],
		taxRateName: r.tax_rate_name,
		taxRateBp: r.tax_rate_bp,
		lineCount: r.line_count,
		quantity: r.quantity,
		amount: big(r.amount)
	}));
}
