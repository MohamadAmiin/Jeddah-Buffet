import { error, fail, type Actions, type RequestEvent, type ServerLoad } from '@sveltejs/kit';
import { z } from 'zod';
import { requirePermission } from '$lib/server/permissions';
import { db } from '$lib/server/db/client';
import type { Principal } from '$lib/server/auth/session';
import {
	archivePaymentMethod,
	createPaymentMethod,
	listPaymentMethods,
	movePaymentMethod,
	updatePaymentMethod,
	type PaymentMethodRow
} from '$lib/server/restaurants';
import { requestContext } from '$lib/server/audit';

// THE PAYMENT METHODS PAGE (tasks/settings-tax-payments-receipt T-29, gate
// decision 8): the owner's NAMED card and mobile-money methods — EVC Plus, Zaad,
// a card terminal — each with a FIXED kind, a merchant number, an on/off switch
// and a place in the till's order, beside the one built-in Cash row.
//
// THE KIND IS FIXED, AND NEVER CASH. The kind — not the name — picks the ledger
// account through the spec 24 posting rules (every mobile method Dr 1030 Payment
// Clearing – Mobile Money, every card method Dr 1020 Payment Clearing – Card;
// nobody types a debit, and this page offers no account choice — invariant 3)
// and the offline rule (only the built-in Cash sells offline; card and mobile
// fail closed — invariant 5). So `create` offers card or mobile only, `update`
// never reads a kind (the module's changes type has none, and migration 0017's
// trigger refuses one at the database), and Cash has nothing editable here.
//
// ARCHIVE, NEVER DELETE (invariant 2): there is no delete action. An archived
// method leaves the till at its next sign-in, and past payments keep its name.
//
// Every load and every action checks admin.settings itself and takes
// restaurantId from locals, never from the form (invariant 8). Every write goes
// through the catalogue in restaurants/payment-methods.ts (T-11), which audits
// each change inside the action's ONE transaction (invariant 10). Methods are
// not in the menu snapshot: they reach the till in the settings bundle of
// GET /api/pos/employees (T-20).

type OwnerKind = 'card' | 'mobile';

/** The words for an owner method's kind. Cash has its own card and no label. */
function kindLabel(kind: OwnerKind): string {
	return kind === 'card' ? 'Card terminal' : 'Mobile money';
}

/** Narrows a catalogue row to the two kinds an owner may hold. */
function isOwnerMethod(row: PaymentMethodRow): row is PaymentMethodRow & { kind: OwnerKind } {
	return row.kind === 'card' || row.kind === 'mobile';
}

export const load: ServerLoad = async (event) => {
	requirePermission(event, 'admin.settings');

	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	// Cash first, then sort_order, then name; archived rows included (T-11).
	const rows = await listPaymentMethods(db, restaurantId, { includeArchived: true });
	const cash = rows.find((row) => row.kind === 'cash');
	const live = rows.filter((row) => row.archivedAt === null).filter(isOwnerMethod);
	// An archived row is never cash (payment_methods_cash_rules); the filter narrows the type.
	const archived = rows.filter((row) => row.archivedAt !== null).filter(isOwnerMethod);

	return {
		// Every restaurant has one (seedCashMethod; migration 0017). Null only for a
		// restaurant built by hand — the page still renders.
		cash: cash ? { id: cash.id, name: cash.name } : null,
		methods: live.map((row, index) => ({
			id: row.id,
			name: row.name,
			kind: row.kind,
			kindLabel: kindLabel(row.kind),
			merchantNumber: row.merchantNumber,
			enabled: row.enabled,
			// Position among the live owner methods: what Move up / Move down can do.
			first: index === 0,
			last: index === live.length - 1
		})),
		archived: archived.map((row) => ({
			id: row.id,
			name: row.name,
			kindLabel: kindLabel(row.kind)
		}))
	};
};

const KIND_MESSAGE = 'Choose Card terminal or Mobile money. Cash is built in.';
const NAME_MESSAGE = 'Enter a name of 1 to 40 characters with no control characters.';
const NUMBER_MESSAGE = 'The merchant number is up to 40 characters with no control characters.';
const NOT_FOUND_MESSAGE = 'That payment method no longer exists. Reload the page.';
const ARCHIVED_MESSAGE = 'That payment method is archived.';
const IS_CASH_MESSAGE = 'Cash is built in: it cannot be renamed, moved, switched off or archived.';
// The /settings page's fallback idiom: every action has a message for every
// reason its module can return, and an unlisted one still gets a sentence.
const METHOD_FALLBACK = 'That payment method could not be saved. Reload the page and try again.';

const MESSAGES: Record<string, string> = {
	invalid_kind: KIND_MESSAGE,
	invalid_name: NAME_MESSAGE,
	invalid_number: NUMBER_MESSAGE,
	duplicate_name: 'A payment method with that name already exists.',
	not_found: NOT_FOUND_MESSAGE,
	archived: ARCHIVED_MESSAGE,
	already_archived: ARCHIVED_MESSAGE,
	is_cash: IS_CASH_MESSAGE
};

/** The sentence for a module refusal. */
function messageFor(refusal: { reason: string }): string {
	return MESSAGES[refusal.reason] ?? METHOD_FALLBACK;
}

/** The message for a form that failed zod, by the field that failed. */
function fieldMessage(issue: { path: PropertyKey[] } | undefined): string {
	if (issue?.path.includes('methodId')) return NOT_FOUND_MESSAGE;
	if (issue?.path.includes('kind')) return KIND_MESSAGE;
	if (issue?.path.includes('merchantNumber')) return NUMBER_MESSAGE;
	if (issue?.path.includes('direction')) return METHOD_FALLBACK;
	return NAME_MESSAGE;
}

/** The restaurant in scope and the audit context — never read from the form. */
function scopeOf(event: RequestEvent, user: Principal) {
	// restaurantId comes from locals, NEVER from the form body — that is the
	// cross-tenant write the "never touches another restaurant" test exists to catch.
	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');
	const { ip, userAgent } = requestContext(event);
	return { restaurantId, ctx: { actorUserId: user.userId, ip, userAgent } };
}

// The name's bounds and the number's shape are checked by the module (which
// trims both, and turns an empty number into null): zod only insists that each
// arrived as a string — and that the kind is card or mobile. Never cash: the one
// Cash row is built in, and a cash-kind method would sell offline and post
// Dr 1000 (risk 1).
const createSchema = z.object({
	name: z.string().trim(),
	kind: z.enum(['card', 'mobile'], { error: KIND_MESSAGE }),
	merchantNumber: z.string()
});
// NO kind here: the kind is permanent, and the action never reads one.
const updateSchema = z.object({
	methodId: z.uuid(),
	name: z.string().trim(),
	merchantNumber: z.string()
});
const moveSchema = z.object({ methodId: z.uuid(), direction: z.enum(['up', 'down']) });
const methodIdSchema = z.object({ methodId: z.uuid() });

// Named actions only: a page with named actions may not also have `default`
// (SvelteKit throws at the first POST).
export const actions: Actions = {
	create: async (event) => {
		// Guarded AGAIN, in the action itself: a form action is a separately
		// reachable POST endpoint (invariant 8).
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = createSchema.safeParse({
			name: form.get('name'),
			kind: form.get('kind'),
			merchantNumber: form.get('merchantNumber')
		});
		if (!parsed.success) return fail(400, { message: fieldMessage(parsed.error.issues[0]) });

		const { name, kind, merchantNumber } = parsed.data;
		// Checkbox semantics: an unticked box posts nothing, and absent means false.
		const enabled = form.get('enabled') === 'yes';

		const result = await db.transaction((tx) =>
			createPaymentMethod(tx, restaurantId, { name, kind, merchantNumber, enabled }, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: `${name} added.` };
	},

	update: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = updateSchema.safeParse({
			methodId: form.get('methodId'),
			name: form.get('name'),
			merchantNumber: form.get('merchantNumber')
		});
		if (!parsed.success) return fail(400, { message: fieldMessage(parsed.error.issues[0]) });

		const { methodId, name, merchantNumber } = parsed.data;
		const enabled = form.get('enabled') === 'yes';

		// Exactly these three keys — a posted `kind` is never read, so a forged one
		// changes nothing (and the database would refuse it anyway).
		const result = await db.transaction((tx) =>
			updatePaymentMethod(tx, restaurantId, methodId, { name, merchantNumber, enabled }, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: result.changed ? `${name} saved.` : 'No changes to save.' };
	},

	move: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = moveSchema.safeParse({
			methodId: form.get('methodId'),
			direction: form.get('direction')
		});
		if (!parsed.success) return fail(400, { message: fieldMessage(parsed.error.issues[0]) });

		const result = await db.transaction((tx) =>
			movePaymentMethod(tx, restaurantId, parsed.data.methodId, parsed.data.direction, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: result.changed ? 'Order saved.' : 'Already at that end of the list.' };
	},

	archive: async (event) => {
		const user = requirePermission(event, 'admin.settings');
		const { restaurantId, ctx } = scopeOf(event, user);

		const form = await event.request.formData();
		const parsed = methodIdSchema.safeParse({ methodId: form.get('methodId') });
		if (!parsed.success) return fail(400, { message: NOT_FOUND_MESSAGE });

		// The hidden name is for the MESSAGE only; the write is keyed on the id.
		const posted = form.get('name');
		const name = typeof posted === 'string' && posted.trim() !== '' ? posted.trim() : 'Method';

		const result = await db.transaction((tx) =>
			archivePaymentMethod(tx, restaurantId, parsed.data.methodId, ctx)
		);
		if (!result.ok) return fail(400, { message: messageFor(result) });

		return { message: `${name} archived.` };
	}
};
