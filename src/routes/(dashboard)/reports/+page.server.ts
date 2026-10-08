import { error, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { defaultReportDate, salesReport } from '$lib/server/reports/sales';
import type { Minor } from '$lib/money';
import { formatAmount, formatMoney, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import type { OrderType } from '$lib/sync-ops';

// The LOAD formats; the page does no money work. Every amount leaves here as the
// money formatter's string, and a negative difference carries its sign as a
// boolean from a comparison, so the page never inspects a number (invariants 1, 7).

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

function isCalendarDate(value: string): boolean {
	const [y, m, d] = value.split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine(isCalendarDate);

function shiftDate(value: string, days: number): string {
	const [y, m, d] = value.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.reports');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	const raw = event.url.searchParams.get('date');
	let businessDate: string;
	if (raw === null) {
		businessDate = await defaultReportDate(db, restaurantId, new Date());
	} else {
		const parsed = dateSchema.safeParse(raw);
		if (!parsed.success) error(400, 'date must be a calendar date written YYYY-MM-DD');
		businessDate = parsed.data;
	}

	const report = await salesReport(db, restaurantId, businessDate);

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

	const clock = new Intl.DateTimeFormat('en-GB', {
		timeZone: restaurant.timeZone,
		day: '2-digit',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit'
	});
	const when = (d: Date) => clock.format(d);

	return {
		businessDate,
		prevDate: shiftDate(businessDate, -1),
		nextDate: shiftDate(businessDate, 1),
		timeZone: restaurant.timeZone,
		currency: format ? { code: format.code, exponent: format.exponent } : null,
		itemAmountLabel:
			restaurant.taxMode === 'inclusive'
				? 'Incl. tax'
				: restaurant.taxMode === 'exclusive'
					? 'Net'
					: 'Amount',
		totals: {
			grossSales: standalone(report.totals.grossSales),
			discounts: standalone(report.totals.discounts),
			netSales: standalone(report.totals.netSales),
			tax: standalone(report.totals.tax),
			takings: standalone(report.totals.takings),
			orderCount: report.totals.orderCount
		},
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
			itemName: r.itemName,
			quantity: r.quantity,
			amount: column(r.amount)
		})),
		byCategory: report.byCategory.map((r) => ({
			categoryId: r.categoryId,
			name: r.name,
			quantity: r.quantity,
			amount: column(r.amount)
		})),
		sessions: report.sessions.map((s) => ({
			id: s.id,
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
		isEmpty: report.totals.orderCount === 0 && report.sessions.length === 0
	};
};
