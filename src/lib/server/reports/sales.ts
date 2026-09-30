// T-35: THE SALES REPORT QUERY MODULE.
//
// Read-only queries over STORED columns. Every function takes restaurantId
// explicitly and filters on it inside the query; figures are grouped by
// pos_sessions.business_date, never by a timestamp cast. Nothing here imports
// the money module's totals, rounding or tax functions, and nothing
// divides, multiplies by a fraction or rounds — a SQL sum() of integer columns
// is the only arithmetic. Money columns are read as bigint (mode: 'bigint' on
// the schema, BigInt(string) on a sum() result) and never as number.
//
// Spec 10, 17, 25, 26, 27. Invariants 1, 7, 11.

import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { orders, orderLines, orderLineModifiers, payments } from '../db/schema/orders';
import { posSessions } from '../db/schema/pos-sessions';
import { posSyncOps } from '../db/schema/pos-sync';
import { posDevices } from '../db/schema/pos-devices';
import { users } from '../db/schema/users';
import { menuItems, menuCategories } from '../db/schema/menu';
import { minor, subtract, type Minor } from '../../money';
import { ORDER_TYPES, type OrderType } from '../../sync-ops';

export type SalesReport = {
	businessDate: string;
	totals: {
		grossSales: Minor;
		discounts: Minor;
		netSales: Minor;
		tax: Minor;
		takings: Minor;
		orderCount: number;
	};
	byTender: { method: 'cash' | 'card' | 'mobile'; amount: Minor; count: number }[];
	byOrderType: { orderType: OrderType; amount: Minor; count: number }[];
	byEmployee: { userId: string | null; displayName: string; amount: Minor; count: number }[];
	byItem: { menuItemId: string; itemName: string; quantity: number; amount: Minor }[];
	byCategory: { categoryId: string | null; name: string; quantity: number; amount: Minor }[];
	sessions: {
		id: string;
		deviceCode: string;
		openedAt: Date;
		closedAt: Date | null;
		openingCash: Minor;
		expectedCash: Minor | null;
		countedCash: Minor | null;
		difference: Minor | null;
		status: 'open' | 'closed';
	}[];
	flagged: { count: number; unrecordedCount: number };
};

export async function defaultReportDate(
	database: Executor,
	restaurantId: string,
	now: Date
): Promise<string> {
	const recent = await database.execute<{ business_date: string }>(sql`
		select ${posSessions.businessDate} as business_date
		from ${posSessions}
		where ${posSessions.restaurantId} = ${restaurantId}
			and ${posSessions.openedAt} >= (${now.toISOString()}::timestamptz - interval '24 hours')
			and ${posSessions.openedAt} <= ${now.toISOString()}::timestamptz
		order by ${posSessions.openedAt} desc
		limit 1
	`);
	if (recent.rows.length > 0) return recent.rows[0].business_date;

	const fallback = await database.execute<{ business_date: string }>(sql`
		select to_char((${now.toISOString()}::timestamptz) at time zone ${restaurantSettings.timeZone},
			'YYYY-MM-DD') as business_date
		from ${restaurantSettings}
		where ${restaurantSettings.restaurantId} = ${restaurantId}
	`);
	if (fallback.rows.length === 0) {
		throw new Error(`no restaurant_settings row for ${restaurantId}`);
	}
	return fallback.rows[0].business_date;
}

export async function salesReport(
	database: Executor,
	restaurantId: string,
	businessDate: string
): Promise<SalesReport> {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
		throw new RangeError(`businessDate must be YYYY-MM-DD, got ${JSON.stringify(businessDate)}`);
	}

	// Written once here, reused by every section — no query can drift to a
	// timestamp cast.
	const salesFilter = and(
		eq(orders.restaurantId, restaurantId),
		eq(orders.status, 'paid'),
		eq(posSessions.businessDate, businessDate),
		eq(posSessions.restaurantId, restaurantId)
	);

	// TOTALS.
	const totalsRows = await database
		.select({
			orderCount: sql<number>`count(*)::int`,
			gross: sql<string>`coalesce(sum(${orders.subtotalMinor}), 0)::bigint`,
			discounts: sql<string>`coalesce(sum(${orders.discountMinor}), 0)::bigint`,
			tax: sql<string>`coalesce(sum(${orders.taxMinor}), 0)::bigint`
		})
		.from(orders)
		.innerJoin(posSessions, eq(posSessions.id, orders.posSessionId))
		.where(salesFilter);
	const totalsRow = totalsRows[0];
	const grossSales = minor(BigInt(totalsRow?.gross ?? '0'));
	const discounts = minor(BigInt(totalsRow?.discounts ?? '0'));
	const tax = minor(BigInt(totalsRow?.tax ?? '0'));
	const netSales = subtract(grossSales, discounts);
	const orderCount = totalsRow?.orderCount ?? 0;

	const takingsRows = await database
		.select({
			amount: sql<string>`coalesce(sum(${payments.amountMinor}), 0)::bigint`
		})
		.from(payments)
		.innerJoin(orders, eq(orders.id, payments.orderId))
		.innerJoin(posSessions, eq(posSessions.id, orders.posSessionId))
		.where(salesFilter);
	const takings = minor(BigInt(takingsRows[0]?.amount ?? '0'));

	// BY TENDER. All three methods always, zero-filled.
	const tenderRows = await database
		.select({
			method: payments.method,
			amount: sql<string>`coalesce(sum(${payments.amountMinor}), 0)::bigint`,
			count: sql<number>`count(*)::int`
		})
		.from(payments)
		.innerJoin(orders, eq(orders.id, payments.orderId))
		.innerJoin(posSessions, eq(posSessions.id, orders.posSessionId))
		.where(salesFilter)
		.groupBy(payments.method);
	const tenderMap = new Map(tenderRows.map((r) => [r.method, r]));
	const byTender: SalesReport['byTender'] = (['cash', 'card', 'mobile'] as const).map((m) => {
		const hit = tenderMap.get(m);
		return {
			method: m,
			amount: hit ? minor(BigInt(hit.amount)) : minor(0n),
			count: hit ? hit.count : 0
		};
	});

	// BY ORDER TYPE.
	const orderTypeRows = await database
		.select({
			orderType: orders.orderType,
			amount: sql<string>`coalesce(sum(${orders.totalMinor}), 0)::bigint`,
			count: sql<number>`count(*)::int`
		})
		.from(orders)
		.innerJoin(posSessions, eq(posSessions.id, orders.posSessionId))
		.where(salesFilter)
		.groupBy(orders.orderType);
	const orderTypeMap = new Map(orderTypeRows.map((r) => [r.orderType, r]));
	// Every type in the wire contract's order, zero rows included — the literal
	// list this used to hold silently dropped a type the CHECK accepted (spec 26).
	const byOrderType: SalesReport['byOrderType'] = ORDER_TYPES.map((t) => {
		const hit = orderTypeMap.get(t);
		return {
			orderType: t,
			amount: hit ? minor(BigInt(hit.amount)) : minor(0n),
			count: hit ? hit.count : 0
		};
	});

	// BY EMPLOYEE.
	const employeeRows = await database
		.select({
			userId: orders.employeeUserId,
			displayName: users.displayName,
			amount: sql<string>`coalesce(sum(${orders.totalMinor}), 0)::bigint`,
			count: sql<number>`count(*)::int`
		})
		.from(orders)
		.innerJoin(posSessions, eq(posSessions.id, orders.posSessionId))
		.leftJoin(users, and(eq(users.id, orders.employeeUserId), eq(users.restaurantId, restaurantId)))
		.where(salesFilter)
		.groupBy(orders.employeeUserId, users.displayName)
		.orderBy(
			sql`coalesce(sum(${orders.totalMinor}), 0) desc`,
			sql`coalesce(${users.displayName}, '') asc`
		);
	const byEmployee: SalesReport['byEmployee'] = employeeRows.map((r) => ({
		userId: r.displayName === null ? null : r.userId,
		displayName: r.displayName ?? 'Unknown employee',
		amount: minor(BigInt(r.amount)),
		count: r.count
	}));

	// BY ITEM. The stored unit price plus stored modifier deltas, times stored
	// quantity, minus stored line discount — an integer sum of stored columns.
	// The `unrecorded` op that references a session with no row cannot be dated
	// and appears only on /reports/flagged (T-37), never in a date's count.
	const itemRows = await database.execute<{
		menu_item_id: string;
		item_name: string;
		quantity: number;
		amount: string;
	}>(sql`
		with modifier_sums as (
			select ${orderLineModifiers.orderLineId} as order_line_id,
				sum(${orderLineModifiers.priceDeltaMinor}) as delta
			from ${orderLineModifiers}
			group by ${orderLineModifiers.orderLineId}
		)
		select
			${orderLines.menuItemId} as menu_item_id,
			${orderLines.itemName} as item_name,
			sum(${orderLines.quantity})::int as quantity,
			coalesce(sum(
				(${orderLines.unitPriceMinor} + coalesce(m.delta, 0)) * ${orderLines.quantity}
					- ${orderLines.discountMinor}
			), 0)::bigint as amount
		from ${orderLines}
		inner join ${orders} on ${orders.id} = ${orderLines.orderId}
		inner join ${posSessions} on ${posSessions.id} = ${orders.posSessionId}
		left join modifier_sums m on m.order_line_id = ${orderLines.id}
		where ${orders.restaurantId} = ${restaurantId}
			and ${orders.status} = 'paid'
			and ${posSessions.restaurantId} = ${restaurantId}
			and ${posSessions.businessDate} = ${businessDate}
			and ${orderLines.restaurantId} = ${restaurantId}
			and ${orderLines.status} <> 'voided'
		group by ${orderLines.menuItemId}, ${orderLines.itemName}
		order by amount desc, ${orderLines.itemName} asc
	`);
	const byItem: SalesReport['byItem'] = itemRows.rows.map((r) => ({
		menuItemId: r.menu_item_id,
		itemName: r.item_name,
		quantity: r.quantity,
		amount: minor(BigInt(r.amount))
	}));

	// BY CATEGORY. Same per-line expression, joined through the item's CURRENT
	// category (categories are archived, never deleted, so the join resolves;
	// a null still maps to Uncategorised).
	const categoryRows = await database.execute<{
		category_id: string | null;
		name: string | null;
		quantity: number;
		amount: string;
	}>(sql`
		with modifier_sums as (
			select ${orderLineModifiers.orderLineId} as order_line_id,
				sum(${orderLineModifiers.priceDeltaMinor}) as delta
			from ${orderLineModifiers}
			group by ${orderLineModifiers.orderLineId}
		)
		select
			c.id as category_id,
			c.name as name,
			sum(${orderLines.quantity})::int as quantity,
			coalesce(sum(
				(${orderLines.unitPriceMinor} + coalesce(m.delta, 0)) * ${orderLines.quantity}
					- ${orderLines.discountMinor}
			), 0)::bigint as amount
		from ${orderLines}
		inner join ${orders} on ${orders.id} = ${orderLines.orderId}
		inner join ${posSessions} on ${posSessions.id} = ${orders.posSessionId}
		inner join ${menuItems} mi on mi.id = ${orderLines.menuItemId}
			and mi.restaurant_id = ${restaurantId}
		left join ${menuCategories} c on c.id = mi.category_id
		left join modifier_sums m on m.order_line_id = ${orderLines.id}
		where ${orders.restaurantId} = ${restaurantId}
			and ${orders.status} = 'paid'
			and ${posSessions.restaurantId} = ${restaurantId}
			and ${posSessions.businessDate} = ${businessDate}
			and ${orderLines.restaurantId} = ${restaurantId}
			and ${orderLines.status} <> 'voided'
		group by c.id, c.name
		order by amount desc, coalesce(c.name, '') asc
	`);
	const byCategory: SalesReport['byCategory'] = categoryRows.rows.map((r) => ({
		categoryId: r.category_id,
		name: r.name ?? 'Uncategorised',
		quantity: r.quantity,
		amount: minor(BigInt(r.amount))
	}));

	// SESSIONS.
	const sessionRows = await database
		.select({
			id: posSessions.id,
			deviceCode: posDevices.deviceCode,
			openedAt: posSessions.openedAt,
			closedAt: posSessions.closedAt,
			openingCash: posSessions.openingCashMinor,
			expectedCash: posSessions.expectedCashMinor,
			countedCash: posSessions.countedCashMinor,
			difference: posSessions.differenceMinor,
			status: posSessions.status
		})
		.from(posSessions)
		.innerJoin(posDevices, eq(posDevices.id, posSessions.deviceId))
		.where(
			and(eq(posSessions.restaurantId, restaurantId), eq(posSessions.businessDate, businessDate))
		)
		.orderBy(sql`${posSessions.openedAt} asc`);
	const sessions: SalesReport['sessions'] = sessionRows.map((s) => ({
		id: s.id,
		deviceCode: s.deviceCode,
		openedAt: s.openedAt,
		closedAt: s.closedAt,
		openingCash: minor(BigInt(s.openingCash)),
		expectedCash: s.expectedCash === null ? null : minor(BigInt(s.expectedCash)),
		countedCash: s.countedCash === null ? null : minor(BigInt(s.countedCash)),
		difference: s.difference === null ? null : minor(BigInt(s.difference)),
		status: s.status === 'closed' ? 'closed' : 'open'
	}));

	// FLAGGED for THIS date. An op whose session id does not resolve to a
	// row (unknown_session) has no business date and belongs to
	// /reports/flagged (T-37), never here.
	const flaggedRows = await database.execute<{ count: number; unrecorded: number }>(sql`
		select
			count(*)::int as count,
			count(*) filter (where ${posSyncOps.status} = 'unrecorded')::int as unrecorded
		from ${posSyncOps}
		inner join ${posSessions} on ${posSessions.id} = ${posSyncOps.posSessionId}
			and ${posSessions.restaurantId} = ${restaurantId}
		where ${posSyncOps.restaurantId} = ${restaurantId}
			and ${posSessions.businessDate} = ${businessDate}
			and ${posSyncOps.status} <> 'accepted'
			and ${posSyncOps.resolvedAt} is null
	`);
	const flaggedRow = flaggedRows.rows[0];
	const flagged = {
		count: flaggedRow?.count ?? 0,
		unrecordedCount: flaggedRow?.unrecorded ?? 0
	};

	return {
		businessDate,
		totals: { grossSales, discounts, netSales, tax, takings, orderCount },
		byTender,
		byOrderType,
		byEmployee,
		byItem,
		byCategory,
		sessions,
		flagged
	};
}
