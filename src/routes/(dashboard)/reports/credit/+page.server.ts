import { error, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { defaultReportDate } from '$lib/server/reports/sales';
import { creditReport } from '$lib/server/reports/credit';
import type { Minor } from '$lib/money';
import { formatAmount, moneyFormatFor, type MoneyFormat } from '$lib/money/format';

// CUSTOMER CREDIT (tasks/customer-credit T-23): every bill charged to a
// customer's credit and every payment a customer made, in a business-date
// range, with a total per cashier. Any cashier holding pos.payment may charge a
// bill to a customer without the owner's PIN (the user's choice, 2026-11-12),
// and a credit sale never opens the drawer — so this page is the owner's
// control, beside each customer's own statement.
//
// admin.reports, checked here (invariant 8); restaurantId from the session. The
// LOAD formats every amount with the money module; the page does no money work.

function isCalendarDate(value: string): boolean {
	const [y, m, d] = value.split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine(isCalendarDate);

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.reports');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	const parse = (name: 'from' | 'to'): string | null => {
		const raw = event.url.searchParams.get(name);
		if (raw === null || raw === '') return null;
		const parsed = dateSchema.safeParse(raw);
		if (!parsed.success) error(400, `${name} must be a calendar date written YYYY-MM-DD`);
		return parsed.data;
	};
	const fromParam = parse('from');
	const toParam = parse('to');
	const fallback = fromParam ?? toParam ?? (await defaultReportDate(db, restaurantId, new Date()));
	let from = fromParam ?? fallback;
	let to = toParam ?? fallback;
	// YYYY-MM-DD strings order as dates do; a reversed range is read the right way round.
	if (from > to) [from, to] = [to, from];

	const report = await creditReport(db, restaurantId, { from, to });

	let format: MoneyFormat | null = null;
	if (restaurant.currencyCode !== null) {
		try {
			format = moneyFormatFor(restaurant.currencyCode);
		} catch {
			error(500, 'The stored currency cannot be formatted');
		}
	}
	const column = (v: Minor) => (format ? formatAmount(v, format) : '—');
	const clock = new Intl.DateTimeFormat('en-GB', {
		timeZone: restaurant.timeZone,
		hour: '2-digit',
		minute: '2-digit'
	});

	return {
		from,
		to,
		currency: format ? { code: format.code } : null,
		charged: column(report.chargedMinor),
		receivedNet: column(report.receivedNetMinor),
		byCashier: report.byCashier.map((row) => ({
			key: row.userId ?? 'unknown',
			cashier: row.cashier,
			charges: row.charges,
			charged: column(row.chargedMinor),
			payments: row.payments,
			received: column(row.receivedMinor)
		})),
		charges: report.charges.map((row) => ({
			orderId: row.orderId,
			invoiceNumber: row.invoiceNumber,
			businessDate: row.businessDate,
			time: clock.format(row.paidAt),
			customerId: row.customerId,
			customerName: row.customerName,
			cashier: row.cashier,
			till: row.tillCode,
			amount: column(row.amountMinor)
		})),
		payments: report.payments.map((row, index) => ({
			key: `${row.paymentId}-${row.kind}-${index}`,
			kind: row.kind,
			businessDate: row.businessDate,
			time: clock.format(row.at),
			customerId: row.customerId,
			customerName: row.customerName,
			method: row.methodName,
			cashier: row.cashier,
			amount: column(row.amountMinor),
			reason: row.reason
		}))
	};
};
