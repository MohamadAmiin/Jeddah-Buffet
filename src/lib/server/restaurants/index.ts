import { eq } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import type { DbTx } from '../db/client';
import { restaurants } from '../db/schema/restaurants';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { writeAudit } from '../audit';
import { isValidTimeZone, canonicalTimeZone } from './time-zone';

export { isValidTimeZone, canonicalTimeZone, timeZoneSuggestions } from './time-zone';

// This module holds restaurant identity and settings and the onRestaurantCreated
// initializer list. It calls audit/ and NOTHING else, and is called by routes and
// by auth/register.ts. CLAUDE.md's "Where code lives" does not list it; T-26 adds
// it.
//
// CONVENTION, applied throughout src/lib/server: functions that WRITE take DbTx,
// so a plain `db` handle cannot be passed where a transaction is required;
// functions that only READ take Executor (Db | DbTx) and work with either.

export type RestaurantWithSettings = {
	id: string;
	name: string;
	timeZone: string;
	/**
	 * Seconds of inactivity before the POS returns to employee-select, or null
	 * while the owner has not chosen. There is no default anywhere — not in the
	 * column and not in code — so null is a real state every reader must handle.
	 */
	posIdleLockSeconds: number | null;
	createdAt: Date;
};

/**
 * Read one restaurant and its settings.
 *
 * Takes restaurantId EXPLICITLY and filters by it. There is no ambient tenant in
 * this codebase, which is what makes the schema's restaurant_id columns load
 * bearing rather than decorative.
 */
export async function getRestaurantWithSettings(
	tx: Executor,
	restaurantId: string
): Promise<RestaurantWithSettings | null> {
	const rows = await tx
		.select({
			id: restaurants.id,
			name: restaurants.name,
			timeZone: restaurantSettings.timeZone,
			posIdleLockSeconds: restaurantSettings.posIdleLockSeconds,
			createdAt: restaurants.createdAt
		})
		.from(restaurants)
		.innerJoin(restaurantSettings, eq(restaurantSettings.restaurantId, restaurants.id))
		.where(eq(restaurants.id, restaurantId))
		.limit(1);

	return rows[0] ?? null;
}

export type SettingsChanges = {
	name?: string;
	timeZone?: string;
	posIdleLockSeconds?: number;
};

export type UpdateSettingsContext = {
	actorUserId: string | null;
	ip: string | null;
	userAgent: string | null;
};

export type UpdateSettingsResult =
	| { ok: true; changed: false }
	| { ok: true; changed: true; changes: Record<string, { old: unknown; new: unknown }> }
	| { ok: false; reason: 'not_found' | 'invalid_time_zone' | 'invalid_idle_lock' };

// The POS idle lock's SANITY BOUND — not a default (CLAUDE.md, "Decisions already
// made", 2026-09-15). Under 30 seconds the till locks while the cashier is
// counting change; over 30 minutes it is not a lock.
const POS_IDLE_LOCK_MIN_SECONDS = 30;
const POS_IDLE_LOCK_MAX_SECONDS = 1800;

/**
 * Update restaurant settings, writing the change and its audit row in the SAME
 * transaction (invariant 10).
 *
 * Recording old AND new values is what makes the audit row useful: the time zone
 * decides which business day a POS session belongs to, and the name will be
 * printed on receipts. A row that says only "settings were updated" cannot answer,
 * months later, what changed and when.
 *
 * This is the ONE writer of every settings column, the POS idle lock included:
 * a direct tx.update(restaurantSettings) elsewhere changes a setting with no
 * audit row.
 */
export async function updateSettings(
	tx: DbTx,
	restaurantId: string,
	changes: SettingsChanges,
	ctx: UpdateSettingsContext
): Promise<UpdateSettingsResult> {
	// Read the CURRENT row first, inside the same transaction.
	const current = await getRestaurantWithSettings(tx, restaurantId);
	if (!current) return { ok: false, reason: 'not_found' };

	const diff: Record<string, { old: unknown; new: unknown }> = {};

	if (changes.name !== undefined && changes.name !== current.name) {
		diff.name = { old: current.name, new: changes.name };
	}

	let canonical: string | undefined;
	if (changes.timeZone !== undefined) {
		// Validate ONLY a field the form actually submitted. Re-validating a stored
		// value while the owner is merely renaming the restaurant could reject a
		// setting that has worked for months, if a Node or ICU update changed which
		// spelling is canonical.
		if (!isValidTimeZone(changes.timeZone)) {
			return { ok: false, reason: 'invalid_time_zone' };
		}
		canonical = canonicalTimeZone(changes.timeZone);
		if (canonical !== current.timeZone) {
			diff.timeZone = { old: current.timeZone, new: canonical };
		}
	}

	if (changes.posIdleLockSeconds !== undefined) {
		const seconds = changes.posIdleLockSeconds;
		if (
			!Number.isInteger(seconds) ||
			seconds < POS_IDLE_LOCK_MIN_SECONDS ||
			seconds > POS_IDLE_LOCK_MAX_SECONDS
		) {
			return { ok: false, reason: 'invalid_idle_lock' };
		}
		if (seconds !== current.posIdleLockSeconds) {
			diff.posIdleLockSeconds = { old: current.posIdleLockSeconds, new: seconds };
		}
	}

	// A no-op submission must not produce a meaningless audit row.
	if (Object.keys(diff).length === 0) return { ok: true, changed: false };

	const now = new Date();
	if (diff.name) {
		await tx
			.update(restaurants)
			.set({ name: changes.name!, updatedAt: now })
			.where(eq(restaurants.id, restaurantId));
	}
	// ONE update of the settings row, and both halves of it are load-bearing.
	// Widening the condition without making the payload conditional would blank the
	// stored time zone on an idle-lock-only save (canonical is undefined then), and
	// the time zone decides which business date every sale belongs to (invariant
	// 11). Adding the column to the payload without widening the condition would
	// write the audit row and nothing else — and the owner could then never satisfy
	// settingsComplete().
	if (diff.timeZone || diff.posIdleLockSeconds) {
		await tx
			.update(restaurantSettings)
			.set({
				...(diff.timeZone ? { timeZone: canonical! } : {}),
				...(diff.posIdleLockSeconds ? { posIdleLockSeconds: changes.posIdleLockSeconds! } : {}),
				updatedAt: now
			})
			.where(eq(restaurantSettings.restaurantId, restaurantId));
	}

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		event: 'settings.updated',
		details: { changes: diff },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});

	return { ok: true, changed: true, changes: diff };
}

/**
 * Is this restaurant configured enough to operate?
 *
 * Required today: the time zone, and the POS idle lock (T-08). Registration sets
 * the time zone and leaves the idle lock null, so a freshly registered restaurant
 * is INCOMPLETE until the owner chooses an idle lock — and POS device registration
 * is gated on this function, because a till whose idle lock nobody chose would
 * have no timeout to honour on the screen that protects the drawer.
 *
 * EVERY LATER PLAN THAT ADDS A REQUIRED SETTING MUST ADD IT TO THIS FUNCTION'S
 * LIST. T-22's onboarding checklist reads it, and POS session opening will too.
 * Money-relevant settings (tax mode, tax rate, currency — spec 33 open decisions
 * 3 and 4) must land NULLABLE and be reported here as missing, never supplied by
 * a column DEFAULT that silently answers the open decision for a restaurant whose
 * owner never visited the settings page.
 */
export async function settingsComplete(
	tx: Executor,
	restaurantId: string
): Promise<{ complete: boolean; missing: string[] }> {
	const current = await getRestaurantWithSettings(tx, restaurantId);
	if (!current) return { complete: false, missing: ['settings row'] };

	const missing: string[] = [];
	if (!current.timeZone || current.timeZone.trim() === '') missing.push('time zone');
	if (current.posIdleLockSeconds === null) missing.push('POS idle lock');

	return { complete: missing.length === 0, missing };
}

export type RestaurantInitializerInput = {
	restaurantName: string;
	timeZone: string;
};

/**
 * Ordered initializers run INSIDE the registration transaction.
 *
 * Ships with exactly one entry: the settings row. The list exists so a later plan
 * — the accounting plan needing a per-restaurant chart of accounts, for instance —
 * adds an idempotent entry HERE, rather than writing a migration that cross-joins
 * every existing restaurant and then silently does nothing for the next one
 * created.
 */
export const restaurantInitializers: Array<
	(tx: DbTx, restaurantId: string, input: RestaurantInitializerInput) => Promise<void>
> = [
	async function insertSettingsRow(tx, restaurantId, input) {
		await tx.insert(restaurantSettings).values({
			restaurantId,
			timeZone: canonicalTimeZone(input.timeZone)
		});
	}
];

export async function onRestaurantCreated(
	tx: DbTx,
	restaurantId: string,
	input: RestaurantInitializerInput
): Promise<void> {
	for (const initializer of restaurantInitializers) {
		await initializer(tx, restaurantId, input);
	}
}

// NOT HERE, IN ANY FORM, NOT EVEN COMMENTED OUT: tax mode, tax rate and currency
// (they arrive with their own task, nullable, and are reported missing above) and
// approval limits (spec 33 open decision 6). The POS idle lock HAS landed (T-08):
// nullable, no column default, and no fallback number anywhere in code.
