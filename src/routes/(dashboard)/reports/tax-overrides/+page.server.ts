import { error, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { defaultReportDate } from '$lib/server/reports/sales';
import { listTaxOverrides } from '$lib/server/reports/tax-overrides';
import type { Minor } from '$lib/money';
import { formatAmount, moneyFormatFor, type MoneyFormat } from '$lib/money/format';

// TAX-EXEMPT BILLS (tasks/bill-tax-override T-12): every bill a cashier made
// tax-exempt in a business-date range, with the reason they typed and the tax it
// removed, and a total per cashier. Any cashier may exempt a bill without the
// owner's PIN (the user's choice), so this page is the owner's control.
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

	const report = await listTaxOverrides(db, restaurantId, { from, to });

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
		byCashier: report.byCashier.map((row) => ({
			userId: row.userId,
			cashier: row.cashier,
			count: row.count,
			taxRemoved: column(row.taxRemovedMinor)
		})),
		rows: report.rows.map((row) => ({
			orderId: row.orderId,
			invoiceNumber: row.invoiceNumber,
			businessDate: row.businessDate,
			time: clock.format(row.paidAt),
			cashier: row.cashier,
			rateName: row.rateName,
			reason: row.reason,
			total: column(row.totalMinor),
			taxRemoved: column(row.taxRemovedMinor)
		}))
	};
};
