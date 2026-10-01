// PAYMENT METHODS (spec 24, 26, 33 open decision 4; decided 2026-10-01,
// tasks/settings-tax-payments-receipt T-11): OWNER-NAMED methods — EVC Plus, Zaad,
// eDahab, a card terminal — beside ONE built-in Cash row.
//
// THE KIND IS FIXED. It picks the ledger account through the spec 24 posting rules
// (cash → Dr 1000, card → Dr 1020, mobile → Dr 1030; never the name) and the
// offline rule (only cash sells offline, invariant 5). No update path here takes a
// kind — updatePaymentMethod reads only name, merchantNumber and enabled — and
// migration 0017's trigger payment_methods_kind_immutable refuses one at the
// database.
//
// CASH IS THE BUILT-IN ROW ONLY. payment_methods_one_cash allows one per restaurant
// and payment_methods_cash_rules keeps it enabled, live and numberless; owners
// create 'card' or 'mobile' only, so no owner-named method can sell offline, open
// the drawer or post Dr 1000 Cash on Hand. Cash has nothing editable here.
//
// ARCHIVE, NEVER DELETE (invariants 2 and 5). There is no delete function here, and
// 0017's BEFORE DELETE trigger payment_methods_archive_only refuses one: payments
// reference a method by id, and a pending card or mobile sale must still resolve
// its method when it replays.
//
// NOTHING HERE BUMPS menu_version. Methods are not in the menu snapshot; they reach
// the till in the settings bundle of GET /api/pos/employees (T-20).
//
// Conventions of src/lib/server/permissions/roles.ts and
// src/lib/server/inventory/ingredients.ts: restaurantId explicit on every
// statement; writers take DbTx and never open a transaction (the savepoint in
// unlessTaken is the one exception); readers take Executor; an id is shape-checked
// before any SQL, so a malformed one never raises 22P02 into the caller's
// transaction; every change audits in the same transaction (invariant 10); a no-op
// writes nothing.
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
// TYPE-ONLY: index.ts re-exports this file, so a runtime import back would be a cycle.
import type { UpdateSettingsContext } from './index';
import type { PaymentMethod } from '../../sync-ops';
import { paymentMethods } from '../db/schema/payment-methods';
import { writeAudit } from '../audit';

export const PAYMENT_METHOD_NAME_MAX = 40;
export const MERCHANT_NUMBER_MAX = 40;

/** 'cash' | 'card' | 'mobile' — one list with the wire contract (PAYMENT_METHODS). */
export type PaymentMethodKind = PaymentMethod;

export type PaymentMethodRow = {
	id: string;
	name: string;
	kind: PaymentMethodKind;
	merchantNumber: string | null;
	enabled: boolean;
	sortOrder: number;
	archivedAt: Date | null;
};

/** Copied from src/lib/server/menu/images.ts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The control-character test updateSettings applies to receipt text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const NAME_CONSTRAINT = 'payment_methods_name_unique';

/**
 * True when `error` (or a cause in its chain) is a 23505 on `constraint`.
 * Copied privately from src/lib/server/inventory/ingredients.ts — restaurants/
 * may not import inventory/.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
	let cause: unknown = error;
	for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
		const c = cause as { code?: unknown; constraint?: unknown; cause?: unknown };
		if (c.code === '23505' && c.constraint === constraint) return true;
		cause = c.cause;
	}
	return false;
}

/**
 * Run `write` inside a SAVEPOINT (a nested drizzle transaction) and turn a
 * unique violation on `constraint` into `null`, leaving the caller's
 * transaction usable. Anything else rethrows. Copied privately from
 * src/lib/server/inventory/ingredients.ts.
 */
async function unlessTaken<T>(
	tx: DbTx,
	constraint: string,
	write: (sp: DbTx) => Promise<T>
): Promise<T | null> {
	try {
		return await tx.transaction(write);
	} catch (error) {
		if (isUniqueViolation(error, constraint)) return null;
		throw error;
	}
}

/**
 * The column is text; the CHECK payment_methods_kind_valid admits exactly
 * 'cash', 'card' and 'mobile' (PAYMENT_METHODS), which is what makes this cast
 * true.
 */
function asKind(kind: string): PaymentMethodKind {
	return kind as PaymentMethodKind;
}

/** The trimmed name, or null when it is empty, too long or holds a control character. */
function cleanName(name: unknown): string | null {
	if (typeof name !== 'string') return null;
	const trimmed = name.trim();
	if (trimmed.length < 1 || trimmed.length > PAYMENT_METHOD_NAME_MAX) return null;
	if (CONTROL.test(trimmed)) return null;
	return trimmed;
}

/**
 * The trimmed merchant number ('' becomes null), or `false` when it is not a
 * string or null, is too long or holds a control character — it prints on every
 * receipt, and an ESC could start the drawer pulse.
 */
function cleanNumber(value: unknown): string | null | false {
	if (value === null) return null;
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (trimmed.length > MERCHANT_NUMBER_MAX || CONTROL.test(trimmed)) return false;
	return trimmed;
}

/** A programming error, not a refusal: the contract has no reason for it. */
function assertEnabled(enabled: unknown): asserts enabled is boolean {
	if (typeof enabled !== 'boolean') {
		throw new TypeError(`payment method "enabled" must be a boolean, got ${typeof enabled}`);
	}
}

/**
 * The restaurant's methods: Cash first, then by sort_order, then by name.
 * Live rows only unless `includeArchived` is true. DISABLED rows are returned —
 * filtering to the enabled ones is the settings bundle's job (T-20).
 */
export async function listPaymentMethods(
	database: Executor,
	restaurantId: string,
	opts?: { includeArchived?: boolean }
): Promise<PaymentMethodRow[]> {
	const rows = await database
		.select({
			id: paymentMethods.id,
			name: paymentMethods.name,
			kind: paymentMethods.kind,
			merchantNumber: paymentMethods.merchantNumber,
			enabled: paymentMethods.enabled,
			sortOrder: paymentMethods.sortOrder,
			archivedAt: paymentMethods.archivedAt
		})
		.from(paymentMethods)
		.where(
			opts?.includeArchived === true
				? eq(paymentMethods.restaurantId, restaurantId)
				: and(eq(paymentMethods.restaurantId, restaurantId), isNull(paymentMethods.archivedAt))
		)
		.orderBy(
			sql`${paymentMethods.kind} = 'cash' desc`,
			asc(paymentMethods.sortOrder),
			asc(paymentMethods.name)
		);
	return rows.map((row) => ({ ...row, kind: asKind(row.kind) }));
}

/**
 * Seed the built-in Cash row: idempotent, so a second call is a no-op. The
 * conflict target repeats payment_methods_one_cash's predicate exactly (the 0009
 * precedent), which is what lets Postgres use that partial index as the arbiter.
 * No audit row: it seeds configuration, as insertDefaultRoles does.
 */
export async function ensureCashMethod(tx: DbTx, restaurantId: string): Promise<void> {
	await tx
		.insert(paymentMethods)
		.values({
			restaurantId,
			name: 'Cash',
			kind: 'cash',
			enabled: true,
			sortOrder: 0,
			merchantNumber: null
		})
		.onConflictDoNothing({ target: paymentMethods.restaurantId, where: sql`kind = 'cash'` });
}

/**
 * Add an owner-named method of kind 'card' or 'mobile'. Never 'cash': the one
 * Cash row is built in. A name equal (in any case) to a live method's —
 * including 'Cash' — is a duplicate.
 */
export async function createPaymentMethod(
	tx: DbTx,
	restaurantId: string,
	input: { name: string; kind: 'card' | 'mobile'; merchantNumber: string | null; enabled: boolean },
	ctx: UpdateSettingsContext
): Promise<
	| { ok: true; id: string }
	| { ok: false; reason: 'invalid_name' | 'invalid_kind' | 'invalid_number' | 'duplicate_name' }
> {
	// Every check runs before any SQL.
	const name = cleanName(input.name);
	if (name === null) return { ok: false, reason: 'invalid_name' };
	// Checked at RUNTIME: a route may pass a cast form value, and a cash-kind
	// method would sell offline and post Dr 1000.
	const kind: unknown = input.kind;
	if (kind !== 'card' && kind !== 'mobile') return { ok: false, reason: 'invalid_kind' };
	const merchantNumber = cleanNumber(input.merchantNumber);
	if (merchantNumber === false) return { ok: false, reason: 'invalid_number' };
	const enabled: unknown = input.enabled;
	assertEnabled(enabled);

	// The savepoint wraps the insert AND the audit row: a duplicate name rolls both
	// back and leaves `tx` usable.
	const id = await unlessTaken(tx, NAME_CONSTRAINT, async (sp) => {
		// After the LIVE non-cash methods; the first owner method is 1, Cash keeps 0.
		const [next] = await sp
			.select({ sortOrder: sql<number>`coalesce(max(${paymentMethods.sortOrder}), 0) + 1` })
			.from(paymentMethods)
			.where(
				and(
					eq(paymentMethods.restaurantId, restaurantId),
					ne(paymentMethods.kind, 'cash'),
					isNull(paymentMethods.archivedAt)
				)
			);
		const [row] = await sp
			.insert(paymentMethods)
			.values({
				restaurantId,
				name,
				kind,
				merchantNumber,
				enabled,
				sortOrder: Number(next?.sortOrder ?? 1)
			})
			.returning({ id: paymentMethods.id });
		await writeAudit(sp, {
			restaurantId,
			actorUserId: ctx.actorUserId,
			subjectUserId: null,
			event: 'payment_method.created',
			details: { name, kind, merchantNumber },
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});
		return row.id;
	});
	if (id === null) return { ok: false, reason: 'duplicate_name' };
	return { ok: true, id };
}

/**
 * Rename a LIVE owner method, change its merchant number, or switch it on or off.
 * The changes type has NO kind, and only those three keys are read — a forged
 * `kind` from a form is ignored. The same values are a no-op: no UPDATE, no audit.
 */
export async function updatePaymentMethod(
	tx: DbTx,
	restaurantId: string,
	methodId: string,
	changes: { name?: string; merchantNumber?: string | null; enabled?: boolean },
	ctx: UpdateSettingsContext
): Promise<
	| { ok: true; changed: boolean }
	| {
			ok: false;
			reason:
				'not_found' | 'archived' | 'is_cash' | 'invalid_name' | 'invalid_number' | 'duplicate_name';
	  }
> {
	if (!UUID.test(methodId)) return { ok: false, reason: 'not_found' };

	// Read ONLY these three keys; never spread `changes`.
	const nameIn = changes.name;
	const numberIn = changes.merchantNumber;
	const enabledIn = changes.enabled;

	let name: string | undefined;
	if (nameIn !== undefined) {
		const cleaned = cleanName(nameIn);
		if (cleaned === null) return { ok: false, reason: 'invalid_name' };
		name = cleaned;
	}
	let merchantNumber: string | null | undefined;
	if (numberIn !== undefined) {
		const cleaned = cleanNumber(numberIn);
		if (cleaned === false) return { ok: false, reason: 'invalid_number' };
		merchantNumber = cleaned;
	}
	if (enabledIn !== undefined) assertEnabled(enabledIn);

	const [current] = await tx
		.select({
			name: paymentMethods.name,
			kind: paymentMethods.kind,
			merchantNumber: paymentMethods.merchantNumber,
			enabled: paymentMethods.enabled,
			archivedAt: paymentMethods.archivedAt
		})
		.from(paymentMethods)
		.where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.restaurantId, restaurantId)))
		.for('update')
		.limit(1);
	if (!current) return { ok: false, reason: 'not_found' };
	// Cash has nothing editable: its name is built in and payment_methods_cash_rules
	// keeps it enabled and numberless.
	if (current.kind === 'cash') return { ok: false, reason: 'is_cash' };
	if (current.archivedAt !== null) return { ok: false, reason: 'archived' };

	const set: { name?: string; merchantNumber?: string | null; enabled?: boolean } = {};
	const diff: Record<string, { old: unknown; new: unknown }> = {};
	if (name !== undefined && name !== current.name) {
		set.name = name;
		diff.name = { old: current.name, new: name };
	}
	if (merchantNumber !== undefined && merchantNumber !== current.merchantNumber) {
		set.merchantNumber = merchantNumber;
		diff.merchantNumber = { old: current.merchantNumber, new: merchantNumber };
	}
	if (enabledIn !== undefined && enabledIn !== current.enabled) {
		set.enabled = enabledIn;
		diff.enabled = { old: current.enabled, new: enabledIn };
	}
	if (Object.keys(diff).length === 0) return { ok: true, changed: false };

	const written = await unlessTaken(tx, NAME_CONSTRAINT, async (sp) => {
		await sp
			.update(paymentMethods)
			.set({ ...set, updatedAt: new Date() })
			.where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.restaurantId, restaurantId)));
		await writeAudit(sp, {
			restaurantId,
			actorUserId: ctx.actorUserId,
			subjectUserId: null,
			event: 'payment_method.updated',
			details: { changes: diff },
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});
		return true;
	});
	if (written === null) return { ok: false, reason: 'duplicate_name' };
	return { ok: true, changed: true };
}

/**
 * Move a LIVE owner method one place up or down among the live owner methods,
 * then renumber them 1..n (which also removes ties). At an edge nothing is
 * written. Cash is not in the list: it is always first.
 */
export async function movePaymentMethod(
	tx: DbTx,
	restaurantId: string,
	methodId: string,
	direction: 'up' | 'down',
	ctx: UpdateSettingsContext
): Promise<
	{ ok: true; changed: boolean } | { ok: false; reason: 'not_found' | 'archived' | 'is_cash' }
> {
	if (!UUID.test(methodId)) return { ok: false, reason: 'not_found' };

	// Every live owner method in ONE `select … order by id for update` — the
	// deadlock-free multi-row lock of applyMovements (inventory/movements.ts): two
	// concurrent moves take the same rows in the same order.
	const locked = await tx
		.select({
			id: paymentMethods.id,
			name: paymentMethods.name,
			sortOrder: paymentMethods.sortOrder
		})
		.from(paymentMethods)
		.where(
			and(
				eq(paymentMethods.restaurantId, restaurantId),
				ne(paymentMethods.kind, 'cash'),
				isNull(paymentMethods.archivedAt)
			)
		)
		.orderBy(asc(paymentMethods.id))
		.for('update');

	if (!locked.some((row) => row.id === methodId)) {
		const [other] = await tx
			.select({ kind: paymentMethods.kind, archivedAt: paymentMethods.archivedAt })
			.from(paymentMethods)
			.where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.restaurantId, restaurantId)))
			.limit(1);
		if (!other) return { ok: false, reason: 'not_found' };
		if (other.kind === 'cash') return { ok: false, reason: 'is_cash' };
		return { ok: false, reason: 'archived' };
	}

	// The order listPaymentMethods shows: sort_order, then name.
	const list = [...locked].sort(
		(a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
	);
	const from = list.findIndex((row) => row.id === methodId);
	const to = direction === 'up' ? from - 1 : from + 1;
	if (to < 0 || to >= list.length) return { ok: true, changed: false };
	const moved = list[from];
	[list[from], list[to]] = [list[to], list[from]];

	const now = new Date();
	for (const [index, row] of list.entries()) {
		const sortOrder = index + 1;
		if (row.sortOrder === sortOrder) continue;
		await tx
			.update(paymentMethods)
			.set({ sortOrder, updatedAt: now })
			.where(and(eq(paymentMethods.id, row.id), eq(paymentMethods.restaurantId, restaurantId)));
	}

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		event: 'payment_method.updated',
		details: { changes: { sortOrder: { old: moved.sortOrder, new: to + 1 } } },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
	return { ok: true, changed: true };
}

/**
 * Archive an owner method: it leaves the till's list at the next sign-in, and
 * `enabled` is left as it was. Cash cannot be archived.
 */
export async function archivePaymentMethod(
	tx: DbTx,
	restaurantId: string,
	methodId: string,
	ctx: UpdateSettingsContext
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'already_archived' | 'is_cash' }> {
	if (!UUID.test(methodId)) return { ok: false, reason: 'not_found' };

	const [method] = await tx
		.select({
			name: paymentMethods.name,
			kind: paymentMethods.kind,
			archivedAt: paymentMethods.archivedAt
		})
		.from(paymentMethods)
		.where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.restaurantId, restaurantId)))
		.for('update')
		.limit(1);
	if (!method) return { ok: false, reason: 'not_found' };
	if (method.kind === 'cash') return { ok: false, reason: 'is_cash' };
	if (method.archivedAt !== null) return { ok: false, reason: 'already_archived' };

	const now = new Date();
	await tx
		.update(paymentMethods)
		.set({ archivedAt: now, updatedAt: now })
		.where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.restaurantId, restaurantId)));
	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		event: 'payment_method.archived',
		// Not cash (refused above), so the kind is card or mobile.
		details: { name: method.name, kind: asKind(method.kind) as 'card' | 'mobile' },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
	return { ok: true };
}
