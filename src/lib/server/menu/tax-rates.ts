// NAMED TAX RATES (spec 17; decided 2026-10-01, tasks/settings-tax-payments-receipt
// T-10): "VAT 5%", "Exempt 0%", "Alcohol duty 15%" — one rate per order line,
// never stacked.
//
// ARCHIVE, NEVER DELETE (invariants 2 and 5). There is no delete function here, and
// migration 0017's BEFORE DELETE trigger tax_rates_archive_only refuses one: a rate
// id a till cached last week must still resolve when its offline sale syncs.
//
// EVERY WRITE BUMPS THE MENU VERSION, inside withMenuVersionBump (version.ts), in the
// caller's transaction (spec 5; risk 4). A rate reaches the till inside the
// versioned snapshot; without the bump the till keeps charging the old rate and
// every later sale arrives at the SAME version with a different rate — a HARD
// price_tamper instead of a soft stale_menu_price. A no-op returns BEFORE the bump
// and writes no audit row. Every change audits in the same transaction
// (invariant 10).
//
// THE DEFAULT is restaurant_settings.default_tax_rate_id, written only by
// updateSettings (T-13), never here. Nothing here makes a rate the default — not
// even a restaurant's first one: no rate is ever seeded or assumed (risk 5).
//
// NO MONEY HERE. This file imports nothing from src/lib/money: a rate arrives as
// integer basis points (825 = 8.25%), never a fraction (invariant 1), and turning
// the owner's typed percent into basis points is the route's job
// (parsePercentToBp, T-28).
//
// Conventions of src/lib/server/permissions/roles.ts and
// src/lib/server/inventory/ingredients.ts: restaurantId explicit on every
// statement; writers take DbTx and never open a transaction (the savepoint in
// unlessTaken is the one exception); readers take Executor; an id is shape-checked
// before any SQL, so a malformed one never raises 22P02 into the caller's
// transaction.
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
// TYPE-ONLY: index.ts re-exports this file, so a runtime import back would be a cycle.
import type { MenuWriteContext } from './index';
import { withMenuVersionBump } from './version';
import { taxRates } from '../db/schema/tax-rates';
import { menuItems } from '../db/schema/menu';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { writeAudit } from '../audit';

export const TAX_RATE_NAME_MAX = 40;

export type TaxRateRow = {
	id: string;
	name: string;
	rateBp: number;
	sortOrder: number;
	archivedAt: Date | null;
	isDefault: boolean;
	liveItemCount: number;
};

/** Copied from src/lib/server/menu/images.ts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The control-character test updateSettings applies to receipt text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const NAME_CONSTRAINT = 'tax_rates_name_unique';

/**
 * True when `error` (or a cause in its chain) is a 23505 on `constraint`.
 * Copied privately from src/lib/server/inventory/ingredients.ts — menu/ may not
 * import inventory/.
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

/** The trimmed name, or null when it is empty, too long or holds a control character. */
function cleanName(name: unknown): string | null {
	if (typeof name !== 'string') return null;
	const trimmed = name.trim();
	if (trimmed.length < 1 || trimmed.length > TAX_RATE_NAME_MAX) return null;
	if (CONTROL.test(trimmed)) return null;
	return trimmed;
}

/** Integer basis points from 0 (a legitimate "Exempt 0%") to 10,000 (100%). */
function validRate(rateBp: unknown): rateBp is number {
	return (
		typeof rateBp === 'number' && Number.isSafeInteger(rateBp) && rateBp >= 0 && rateBp <= 10_000
	);
}

/**
 * Every rate of the restaurant: live rows first, ordered by sort_order then name,
 * then archived rows in the same order. `isDefault` compares the row with
 * restaurant_settings.default_tax_rate_id. `liveItemCount` counts the LIVE items
 * that point at the rate explicitly (menu_items.tax_rate_id = the rate); an item
 * that INHERITS the default (tax_rate_id NULL) is not counted.
 */
export async function listTaxRates(
	database: Executor,
	restaurantId: string
): Promise<TaxRateRow[]> {
	const [settings] = await database
		.select({ defaultTaxRateId: restaurantSettings.defaultTaxRateId })
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId))
		.limit(1);
	const defaultTaxRateId = settings?.defaultTaxRateId ?? null;

	const rows = await database
		.select({
			id: taxRates.id,
			name: taxRates.name,
			rateBp: taxRates.rateBp,
			sortOrder: taxRates.sortOrder,
			archivedAt: taxRates.archivedAt
		})
		.from(taxRates)
		.where(eq(taxRates.restaurantId, restaurantId))
		.orderBy(sql`${taxRates.archivedAt} is not null`, asc(taxRates.sortOrder), asc(taxRates.name));

	const counts = await database
		.select({
			taxRateId: menuItems.taxRateId,
			liveItemCount: sql<number>`count(*)::int`
		})
		.from(menuItems)
		.where(
			and(
				eq(menuItems.restaurantId, restaurantId),
				isNotNull(menuItems.taxRateId),
				isNull(menuItems.archivedAt)
			)
		)
		.groupBy(menuItems.taxRateId);
	const countByRate = new Map<string, number>();
	for (const row of counts) {
		if (row.taxRateId !== null) countByRate.set(row.taxRateId, Number(row.liveItemCount));
	}

	return rows.map((row) => ({
		...row,
		isDefault: row.id === defaultTaxRateId,
		liveItemCount: countByRate.get(row.id) ?? 0
	}));
}

/**
 * Add a named rate. It is NOT made the default, even when it is the restaurant's
 * first: the owner picks the default on /settings/tax (risk 5).
 */
export async function createTaxRate(
	tx: DbTx,
	restaurantId: string,
	input: { name: string; rateBp: number },
	ctx: MenuWriteContext
): Promise<
	| { ok: true; id: string }
	| { ok: false; reason: 'invalid_name' | 'invalid_rate' | 'duplicate_name' }
> {
	// Both checks run before any SQL; a refusal returns before the bump is entered.
	const name = cleanName(input.name);
	if (name === null) return { ok: false, reason: 'invalid_name' };
	const rateBp = input.rateBp;
	if (!validRate(rateBp)) return { ok: false, reason: 'invalid_rate' };

	// The savepoint wraps the WHOLE bump: a duplicate name rolls back the insert, the
	// version increment and the audit row together, and leaves `tx` usable.
	const id = await unlessTaken(tx, NAME_CONSTRAINT, (sp) =>
		withMenuVersionBump(sp, restaurantId, async (write) => {
			const [next] = await write
				.select({
					sortOrder: sql<number>`coalesce(max(${taxRates.sortOrder}), -1) + 1`
				})
				.from(taxRates)
				.where(and(eq(taxRates.restaurantId, restaurantId), isNull(taxRates.archivedAt)));
			const [row] = await write
				.insert(taxRates)
				.values({ restaurantId, name, rateBp, sortOrder: Number(next?.sortOrder ?? 0) })
				.returning({ id: taxRates.id });
			await writeAudit(write, {
				restaurantId,
				actorUserId: ctx.actorUserId,
				subjectUserId: null,
				event: 'tax_rate.created',
				details: { name, rateBp },
				ip: ctx.ip,
				userAgent: ctx.userAgent
			});
			return row.id;
		})
	);
	if (id === null) return { ok: false, reason: 'duplicate_name' };
	return { ok: true, id };
}

/**
 * Rename and/or re-rate a LIVE rate. The same name and rate is a no-op: no bump,
 * no audit row.
 */
export async function updateTaxRate(
	tx: DbTx,
	restaurantId: string,
	taxRateId: string,
	changes: { name?: string; rateBp?: number },
	ctx: MenuWriteContext
): Promise<
	| { ok: true; changed: boolean }
	| {
			ok: false;
			reason: 'not_found' | 'archived' | 'invalid_name' | 'invalid_rate' | 'duplicate_name';
	  }
> {
	if (!UUID.test(taxRateId)) return { ok: false, reason: 'not_found' };

	let name: string | undefined;
	if (changes.name !== undefined) {
		const cleaned = cleanName(changes.name);
		if (cleaned === null) return { ok: false, reason: 'invalid_name' };
		name = cleaned;
	}
	const rateBp = changes.rateBp;
	if (rateBp !== undefined && !validRate(rateBp)) return { ok: false, reason: 'invalid_rate' };

	const [current] = await tx
		.select({
			name: taxRates.name,
			rateBp: taxRates.rateBp,
			archivedAt: taxRates.archivedAt
		})
		.from(taxRates)
		.where(and(eq(taxRates.id, taxRateId), eq(taxRates.restaurantId, restaurantId)))
		.for('update')
		.limit(1);
	if (!current) return { ok: false, reason: 'not_found' };
	if (current.archivedAt !== null) return { ok: false, reason: 'archived' };

	const set: { name?: string; rateBp?: number } = {};
	const diff: Record<string, { old: unknown; new: unknown }> = {};
	if (name !== undefined && name !== current.name) {
		set.name = name;
		diff.name = { old: current.name, new: name };
	}
	if (rateBp !== undefined && rateBp !== current.rateBp) {
		set.rateBp = rateBp;
		diff.rateBp = { old: current.rateBp, new: rateBp };
	}
	if (Object.keys(set).length === 0) return { ok: true, changed: false };

	// A new rate applies only to sales rung up after the till downloads the bumped
	// snapshot; every past order line keeps the tax_rate_bp it stored (spec 17,
	// invariant 7). Changing the rate of the DEFAULT, or of a rate items use, is
	// allowed — that is what the bump is for.
	const written = await unlessTaken(tx, NAME_CONSTRAINT, (sp) =>
		withMenuVersionBump(sp, restaurantId, async (write) => {
			await write
				.update(taxRates)
				.set({ ...set, updatedAt: new Date() })
				.where(and(eq(taxRates.id, taxRateId), eq(taxRates.restaurantId, restaurantId)));
			await writeAudit(write, {
				restaurantId,
				actorUserId: ctx.actorUserId,
				subjectUserId: null,
				event: 'tax_rate.updated',
				details: { changes: diff },
				ip: ctx.ip,
				userAgent: ctx.userAgent
			});
			return true;
		})
	);
	if (written === null) return { ok: false, reason: 'duplicate_name' };
	return { ok: true, changed: true };
}

/**
 * Archive a rate (the archiveRole order: lock FIRST, then read). Refused for the
 * restaurant's default and for a rate a LIVE item points at; archived items never
 * block it — the validator still resolves an archived rate by id for them
 * (spec 6).
 */
export async function archiveTaxRate(
	tx: DbTx,
	restaurantId: string,
	taxRateId: string,
	ctx: MenuWriteContext
): Promise<
	| { ok: true }
	| { ok: false; reason: 'not_found' | 'already_archived' | 'is_default' }
	| { ok: false; reason: 'in_use'; liveItemCount: number }
> {
	if (!UUID.test(taxRateId)) return { ok: false, reason: 'not_found' };

	// FOR UPDATE before the default and the item count are read: assertLiveTaxRate
	// (FOR SHARE) in updateSettings and the item writers then waits for this
	// transaction, so no default or item can be pointed at a rate being archived
	// (risk 8).
	const [rate] = await tx
		.select({
			name: taxRates.name,
			rateBp: taxRates.rateBp,
			archivedAt: taxRates.archivedAt
		})
		.from(taxRates)
		.where(and(eq(taxRates.id, taxRateId), eq(taxRates.restaurantId, restaurantId)))
		.for('update')
		.limit(1);
	if (!rate) return { ok: false, reason: 'not_found' };
	if (rate.archivedAt !== null) return { ok: false, reason: 'already_archived' };

	const [settings] = await tx
		.select({ defaultTaxRateId: restaurantSettings.defaultTaxRateId })
		.from(restaurantSettings)
		.where(eq(restaurantSettings.restaurantId, restaurantId))
		.limit(1);
	if (settings?.defaultTaxRateId === taxRateId) return { ok: false, reason: 'is_default' };

	const [countRow] = await tx
		.select({ liveItemCount: sql<number>`count(*)::int` })
		.from(menuItems)
		.where(
			and(
				eq(menuItems.restaurantId, restaurantId),
				eq(menuItems.taxRateId, taxRateId),
				isNull(menuItems.archivedAt)
			)
		);
	const liveItemCount = Number(countRow?.liveItemCount ?? 0);
	if (liveItemCount > 0) return { ok: false, reason: 'in_use', liveItemCount };

	await withMenuVersionBump(tx, restaurantId, async (write) => {
		const now = new Date();
		await write
			.update(taxRates)
			.set({ archivedAt: now, updatedAt: now })
			.where(and(eq(taxRates.id, taxRateId), eq(taxRates.restaurantId, restaurantId)));
		await writeAudit(write, {
			restaurantId,
			actorUserId: ctx.actorUserId,
			subjectUserId: null,
			event: 'tax_rate.archived',
			details: { name: rate.name, rateBp: rate.rateBp },
			ip: ctx.ip,
			userAgent: ctx.userAgent
		});
	});
	return { ok: true };
}

/**
 * The rate row, locked FOR SHARE for the rest of the transaction, or null when
 * missing, foreign or archived. A malformed id is null with no query.
 */
export async function assertLiveTaxRate(
	tx: DbTx,
	restaurantId: string,
	taxRateId: string
): Promise<{ id: string; name: string; rateBp: number } | null> {
	if (!UUID.test(taxRateId)) return null;
	const [rate] = await tx
		.select({ id: taxRates.id, name: taxRates.name, rateBp: taxRates.rateBp })
		.from(taxRates)
		.where(
			and(
				eq(taxRates.id, taxRateId),
				eq(taxRates.restaurantId, restaurantId),
				isNull(taxRates.archivedAt)
			)
		)
		.for('share')
		.limit(1);
	return rate ?? null;
}
