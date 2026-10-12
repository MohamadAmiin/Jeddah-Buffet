import { error, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { defaultReportDate, salesReportRange } from '$lib/server/reports/sales';
import {
	byBusinessDate,
	countOrders,
	orderRows,
	salesByTaxRate,
	sumDays
} from '$lib/server/reports/detail';
import { EXPORT_SECTIONS, type ExportSection } from '$lib/server/reports/export';
import type { Minor } from '$lib/money';
import { formatAmount, formatMoney, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { formatTaxRate } from '$lib/money/tax';
import type { OrderType } from '$lib/sync-ops';
import { isSingleDay, presetsFor, resolveRange, shiftDate } from './range';

// The LOAD formats; the page does no money work. Every amount leaves here as the
// money formatter's string, and a negative carries its sign as a boolean from a
// comparison, so the page never inspects a number (invariants 1, 7).
// tasks/sales-report-export T-10: every section covers a RANGE of business dates.

const TENDER_LABELS = { cash: 'Cash', card: 'Card', mobile: 'Mobile' } as const;
// The Type column of "By payment method": the kind of each named method.
const METHOD_KIND_LABELS = { cash: 'Cash', card: 'Card', mobile: 'Mobile money' } as const;
// A Record over the wire contract's type: a fourth order type with no label here
// fails to compile, instead of being mislabelled as the "other" one.
const ORDER_TYPE_LABELS: Record<OrderType, string> = {
	dine_in: 'Dine-in',
	takeaway: 'Takeaway',
	delivery: 'Delivery'
};
const BASIS_LABELS = { exclusive: 'Net', inclusive: 'Incl. tax' } as const;
const ROW_SUFFIX = { exclusive: ' (net)', inclusive: ' (incl. tax)' } as const;
const EXPORT_LABELS: Record<ExportSection, string> = {
	summary: 'Summary',
	days: 'By business date',
	'payment-methods': 'By payment method',
	employees: 'By employee',
	items: 'By item',
	categories: 'By category',
	'tax-rates': 'By tax rate',
	shifts: 'Shifts',
	orders: 'Orders',
	lines: 'Order lines'
};

/** The page lists the newest orders only; the Orders download has all of them.
 * Underscored: SvelteKit refuses any other non-standard export from +page.server.ts. */
export const _ORDERS_SHOWN = 200;

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.reports');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	const today = () => defaultReportDate(db, restaurantId, new Date());
	const range = await resolveRange(event.url.searchParams, today);
	const { from, to } = range;
	const singleDay = isSingleDay(range);

	const report = await salesReportRange(db, restaurantId, from, to);
	const days = await byBusinessDate(db, restaurantId, from, to);
	const profit = sumDays(days);
	const orders = await orderRows(db, restaurantId, from, to, {
		order: 'desc',
		limit: _ORDERS_SHOWN
	});
	const orderCount = await countOrders(db, restaurantId, from, to);
	const taxRates = await salesByTaxRate(db, restaurantId, from, to);
	const presets = presetsFor(await today());

	let format: MoneyFormat | null = null;
	if (restaurant.currencyCode !== null) {
		try {
			format = moneyFormatFor(restaurant.currencyCode);
		} catch {
			error(500, 'The stored currency cannot be formatted');
		}
	}
	const standalone = (v: Minor) => (format ? formatMoney(v, format) : '—');
	const column = (v: Minor) => (format ? formatAmount(v, format) : '—');
	const signed = (v: Minor, render: (v: Minor) => string) => ({
		text: render(v),
		negative: v < 0n
	});

	const clock = new Intl.DateTimeFormat('en-GB', {
		timeZone: restaurant.timeZone,
		day: '2-digit',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit'
	});
	const when = (d: Date) => clock.format(d);

	// The item and category amounts are labelled by the STORED mode of the range's
	// orders, never by today's setting. Two modes in one range: rows are split by
	// mode (T-03) and each says which it is.
	const mixed = report.taxModes.length > 1;
	// With no sale in the range nothing is mixed, so today's setting names it.
	const itemAmountLabel =
		report.taxModes.length === 1
			? BASIS_LABELS[report.taxModes[0]]
			: report.taxModes.length === 0 && restaurant.taxMode !== null
				? BASIS_LABELS[restaurant.taxMode]
				: 'Amount';
	const suffix = (mode: 'exclusive' | 'inclusive') => (mixed ? ROW_SUFFIX[mode] : '');

	const query = (r: { from: string; to: string }, extra = '') =>
		`from=${r.from}&to=${r.to}${extra}`;

	return {
		// The single-day view keeps every field it had: businessDate, prevDate, nextDate.
		businessDate: to,
		from,
		to,
		singleDay,
		title: singleDay ? `Sales · ${from}` : `Sales · ${from} to ${to}`,
		prevDate: shiftDate(from, -1),
		nextDate: shiftDate(from, 1),
		presets: [
			{ label: 'Today', query: query(presets.today), current: false },
			{ label: 'Last 7 days', query: query(presets.last7), current: false },
			{ label: 'This month', query: query(presets.month), current: false }
		].map((p) => ({ ...p, current: p.query === query(range) })),
		timeZone: restaurant.timeZone,
		currency: format ? { code: format.code, exponent: format.exponent } : null,
		itemAmountLabel,
		totals: {
			grossSales: standalone(report.totals.grossSales),
			discounts: standalone(report.totals.discounts),
			netSales: standalone(report.totals.netSales),
			tax: standalone(report.totals.tax),
			takings: standalone(report.totals.takings),
			orderCount: report.totals.orderCount
		},
		profit: {
			cogs: signed(profit.cogs, standalone),
			waste: signed(profit.waste, standalone),
			comps: signed(profit.comps, standalone),
			costOfSales: signed(profit.costOfSales, standalone),
			grossProfit: signed(profit.grossProfit, standalone)
		},
		openShifts: profit.openShifts,
		days: days.map((d) => ({
			id: d.businessDate,
			businessDate: d.businessDate,
			orderCount: d.orderCount,
			netSales: column(d.netSales),
			tax: column(d.tax),
			takings: column(d.takings),
			costOfSales: signed(d.costOfSales, column),
			grossProfit: signed(d.grossProfit, column)
		})),
		byTender: report.byTender.map((r) => ({
			method: r.method,
			label: TENDER_LABELS[r.method],
			count: r.count,
			amount: column(r.amount)
		})),
		// One row per method row; a payment with no method row (recorded before
		// named methods) is keyed by its kind. "(archived)" is words, not colour.
		byPaymentMethod: report.byPaymentMethod.map((r) => ({
			key: r.paymentMethodId ?? `unrecorded-${r.kind}`,
			label: r.archived ? `${r.name} (archived)` : r.name,
			kind: METHOD_KIND_LABELS[r.kind],
			count: r.count,
			amount: column(r.amount)
		})),
		byOrderType: report.byOrderType.map((r) => ({
			orderType: r.orderType,
			label: ORDER_TYPE_LABELS[r.orderType],
			count: r.count,
			amount: column(r.amount)
		})),
		byEmployee: report.byEmployee.map((r) => ({
			userId: r.userId,
			displayName: r.displayName,
			count: r.count,
			amount: column(r.amount)
		})),
		byItem: report.byItem.map((r) => ({
			menuItemId: r.menuItemId,
			key: `${r.menuItemId}:${r.itemName}:${r.taxMode}`,
			itemName: r.itemName + suffix(r.taxMode),
			quantity: r.quantity,
			amount: column(r.amount)
		})),
		byCategory: report.byCategory.map((r) => ({
			categoryId: r.categoryId,
			key: `${r.categoryId ?? 'none'}:${r.taxMode}`,
			name: r.name + suffix(r.taxMode),
			quantity: r.quantity,
			amount: column(r.amount)
		})),
		taxRates: taxRates.map((r) => ({
			key: `${r.taxMode}:${r.taxRateBp}:${r.taxRateName ?? ''}`,
			name: r.taxRateName ?? 'Rate not recorded',
			rate: formatTaxRate(r.taxRateBp),
			basis: BASIS_LABELS[r.taxMode],
			quantity: r.quantity,
			amount: column(r.amount)
		})),
		orders: orders.map((o) => ({
			id: o.orderId,
			invoiceNumber: o.invoiceNumber ?? '—',
			businessDate: o.businessDate,
			paidAt: o.paidAt.slice(11, 16),
			orderType: ORDER_TYPE_LABELS[o.orderType as OrderType] ?? o.orderType,
			tableLabel: o.tableLabel ?? '—',
			employeeName: o.employeeName ?? 'Unknown employee',
			payment: o.payments.map((p) => p.name ?? METHOD_KIND_LABELS[p.kind]).join(', ') || '—',
			total: column(o.total),
			flag: o.flagReason === null ? null : o.flagReason.replaceAll('_', ' ')
		})),
		orderCount,
		shownOrders: orders.length,
		exports: EXPORT_SECTIONS.map((section) => ({
			section,
			label: EXPORT_LABELS[section],
			query: query(range, `&section=${section}`)
		})),
		sessions: report.sessions.map((s) => ({
			id: s.id,
			businessDate: s.businessDate,
			deviceCode: s.deviceCode,
			status: s.status,
			opened: when(s.openedAt),
			closed: s.closedAt ? when(s.closedAt) : null,
			openingCash: standalone(s.openingCash),
			expectedCash: s.expectedCash === null ? null : standalone(s.expectedCash),
			countedCash: s.countedCash === null ? null : standalone(s.countedCash),
			difference:
				s.difference === null
					? null
					: { text: standalone(s.difference), negative: s.difference < 0n }
		})),
		flagged: report.flagged,
		isEmpty:
			report.totals.orderCount === 0 &&
			report.sessions.length === 0 &&
			days.every((d) => d.costOfSales === 0n)
	};
};
