import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requireOwner, requirePermission } from '$lib/server/permissions';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import { listUnresolvedOps, summarizeOp } from '$lib/server/reports/flagged';
import { dismissOp, retryOp } from '$lib/server/orders/sync';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';

// The notice is a CODE in the query string mapped to a sentence here. Free
// text from the URL is never echoed into the page's alert region.
const NOTICE_TEXT = {
	retried_accepted: '● Recorded. The sale now appears in the report for its business date.',
	retried_flagged:
		'▲ Recorded, with a flag: it appears in the report for its business date and the retry is in the audit log.',
	retried_unrecorded: '◆ Still not recorded. The row shows the new reason.',
	dismissed: 'Dismissed. The reason is in the audit log.'
} as const;

const noticeSchema = z.enum([
	'retried_accepted',
	'retried_flagged',
	'retried_unrecorded',
	'dismissed'
]);
const opIdSchema = z.string().regex(/^\d{1,18}$/);
const reasonSchema = z.string().trim().min(3).max(200);

const NOT_FOUND = 'That sale was not found.';
const BAD_REASON = 'Give a reason of 3 to 200 characters.';

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.reports');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');

	let format: MoneyFormat | null = null;
	if (restaurant.currencyCode !== null) {
		try {
			format = moneyFormatFor(restaurant.currencyCode);
		} catch {
			error(500, 'The stored currency cannot be formatted');
		}
	}

	const clock = new Intl.DateTimeFormat('en-GB', {
		timeZone: restaurant.timeZone,
		day: '2-digit',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit'
	});

	const ops = await listUnresolvedOps(db, restaurantId);
	const notice = noticeSchema.safeParse(event.url.searchParams.get('notice') ?? undefined);

	return {
		timeZone: restaurant.timeZone,
		notice: notice.success ? NOTICE_TEXT[notice.data] : null,
		ops: ops.map((op) => ({
			id: op.id,
			kind: op.kind,
			status: op.status,
			flag: op.flag,
			error: op.error,
			clientOpId: op.clientOpId,
			deviceCode: op.deviceCode,
			invoiceNumber: op.invoiceNumber,
			employeeName: op.employeeName ?? 'Unknown employee',
			occurred: clock.format(op.occurredAt),
			businessDate: op.businessDate,
			retryable: op.status === 'unrecorded',
			summary: summarizeOp(op.kind, op.payload, format)
		}))
	};
};

export const actions: Actions = {
	retry: async (event) => {
		const user = requireOwner(event);
		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();
		const opId = opIdSchema.safeParse(form.get('opId'));
		if (!opId.success) return fail(400, { message: NOT_FOUND, opId: null });

		const request = {
			ip: event.getClientAddress(),
			userAgent: event.request.headers.get('user-agent')
		};
		const result = await retryOp(db, restaurantId, opId.data, user.userId, request);
		if (result.ok) {
			redirect(
				303,
				result.status === 'accepted'
					? '/reports/flagged?notice=retried_accepted'
					: '/reports/flagged?notice=retried_flagged'
			);
		}
		if (result.reason === 'still_unrecorded') {
			redirect(303, '/reports/flagged?notice=retried_unrecorded');
		}
		return fail(400, { message: NOT_FOUND, opId: opId.data });
	},

	dismiss: async (event) => {
		const user = requireOwner(event);
		const restaurantId = event.locals.restaurantId;
		if (!restaurantId) error(500, 'No restaurant in scope');

		const form = await event.request.formData();
		const opId = opIdSchema.safeParse(form.get('opId'));
		if (!opId.success) return fail(400, { message: NOT_FOUND, opId: null });
		const reason = reasonSchema.safeParse(form.get('reason'));
		if (!reason.success) return fail(400, { message: BAD_REASON, opId: opId.data });

		const request = {
			ip: event.getClientAddress(),
			userAgent: event.request.headers.get('user-agent')
		};
		const result = await dismissOp(db, restaurantId, opId.data, user.userId, reason.data, request);
		if (result.ok) redirect(303, '/reports/flagged?notice=dismissed');
		return fail(400, {
			message: result.reason === 'invalid_reason' ? BAD_REASON : NOT_FOUND,
			opId: opId.data
		});
	}
};
