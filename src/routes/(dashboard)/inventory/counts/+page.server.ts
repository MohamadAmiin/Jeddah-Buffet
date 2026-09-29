import { error, fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { requestContext } from '$lib/server/audit';
import { getRestaurantWithSettings } from '$lib/server/restaurants';
import {
	countBlockers,
	listCounts,
	listIngredients,
	postCount,
	todayInZone,
	MAX_COUNT_LINES,
	type CountBlockers
} from '$lib/server/inventory';
import { parseQty, type Qty } from '$lib/money/quantity';
import { moneyFormatFor, type MoneyFormat } from '$lib/money/format';
import { amountText, countSchema, firstMessage, signedQtyText } from '../helpers';

// THE STOCK COUNTS PAGE (spec 15, 26: Stock Count Differences). The owner types
// what is on the shelf; the module posts the difference from the ledger's own
// system quantity as a count adjustment (invariant 6). A count waits while a
// shift is open on the till or a sale awaits review (CLAUDE.md "Inventory 4"):
// the page says why, and the module re-checks inside the transaction. Every
// load and every action checks admin.inventory first (invariant 8).

const OPEN_SESSION_MESSAGE = 'A shift is still open on the till. Close it before counting.';

function unresolvedMessage(n: number): string {
	return n === 1
		? '1 sale is waiting for your review on the Reports page.'
		: `${n} sales are waiting for your review on the Reports page.`;
}

/** The blockers in words, or [] when a count may post. */
function blockerMessages(b: CountBlockers): string[] {
	const messages: string[] = [];
	if (b.openSessions > 0) messages.push(OPEN_SESSION_MESSAGE);
	if (b.unresolvedSales > 0) messages.push(unresolvedMessage(b.unresolvedSales));
	return messages;
}

const REFUSALS = {
	no_lines: 'Enter a counted quantity for at least one ingredient.',
	too_many_lines: `A count covers at most ${MAX_COUNT_LINES} ingredients.`,
	duplicate_ingredient: 'An ingredient appears twice. Reload the page and count again.',
	invalid_qty: 'Counted quantities are zero or more, with at most three decimals.'
} as const;

async function scope(
	locals: App.Locals
): Promise<{ restaurantId: string; format: MoneyFormat | null }> {
	const restaurantId = locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const restaurant = await getRestaurantWithSettings(db, restaurantId);
	if (!restaurant) error(404, 'Restaurant not found');
	return {
		restaurantId,
		format: restaurant.currencyCode === null ? null : moneyFormatFor(restaurant.currencyCode)
	};
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.inventory');
	const { restaurantId, format } = await scope(event.locals);
	const [blockers, live, counts, today] = await Promise.all([
		countBlockers(db, restaurantId),
		listIngredients(db, restaurantId, { includeArchived: false }),
		listCounts(db, restaurantId),
		todayInZone(db, restaurantId)
	]);
	return {
		today,
		blockers: blockerMessages(blockers),
		ingredients: live.map((i) => ({
			id: i.id,
			name: i.name,
			baseUnit: i.baseUnit,
			system: signedQtyText(i.onHandQty, i.baseUnit),
			negative: i.onHandQty < 0n
		})),
		counts: counts.map((c) => ({
			id: c.id,
			businessDate: c.businessDate,
			note: c.note,
			lineCount: c.lineCount,
			shortfall: amountText(c.shortfallMinor, format),
			surplus: amountText(c.surplusMinor, format)
		}))
	};
};

export const actions: Actions = {
	post: async (event) => {
		const user = requirePermission(event, 'admin.inventory');
		const { restaurantId } = await scope(event.locals);
		const form = await event.request.formData();
		const parsed = countSchema.safeParse({
			note: form.get('note') ?? '',
			businessDate: form.get('businessDate') ?? ''
		});
		if (!parsed.success) return fail(400, { message: firstMessage(parsed.error) });

		const ids = form.getAll('ingredientId').map(String);
		const counted = form.getAll('countedQty').map(String);
		if (ids.length !== counted.length) {
			return fail(400, { message: 'The count form is incomplete. Reload the page.' });
		}
		if (ids.length > MAX_COUNT_LINES) return fail(400, { message: REFUSALS.too_many_lines });

		// Only the restaurant's live ingredients may be counted: an id the form
		// did not offer is an answer, never a query against another tenant.
		const live = await listIngredients(db, restaurantId, { includeArchived: false });
		const names = new Map(live.map((i) => [i.id, i.name]));

		const lines: { ingredientId: string; countedQty: Qty }[] = [];
		for (let i = 0; i < ids.length; i += 1) {
			const text = counted[i].trim();
			if (text === '') continue; // blank = not counted; partial counts are normal
			const name = names.get(ids[i]);
			if (name === undefined) {
				return fail(400, {
					message: 'An ingredient on this form no longer exists. Reload the page.'
				});
			}
			let value: Qty;
			try {
				value = parseQty(text);
			} catch {
				return fail(400, {
					message: `${name}: enter zero or more, with at most three decimals.`
				});
			}
			if (value < 0n) {
				return fail(400, { message: `${name}: enter zero or more, with at most three decimals.` });
			}
			lines.push({ ingredientId: ids[i], countedQty: value });
		}

		const { ip, userAgent } = requestContext(event);
		const result = await db.transaction((tx) =>
			postCount(
				tx,
				{ restaurantId, actorUserId: user.userId, ip, userAgent },
				{ businessDate: parsed.data.businessDate, note: parsed.data.note || null, lines }
			)
		);
		if (!result.ok) {
			if (result.reason === 'blocked') {
				return fail(409, { message: blockerMessages(result).join(' ') });
			}
			if (result.reason === 'no_inbound_history') {
				const list = result.ingredientIds.map((id) => names.get(id) ?? id).join(', ');
				return fail(400, { message: `Enter opening stock or a delivery first for: ${list}.` });
			}
			return fail(400, { message: REFUSALS[result.reason] });
		}
		redirect(303, `/inventory/counts/${result.countId}`);
	}
};
