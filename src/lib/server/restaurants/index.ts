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
};

export type UpdateSettingsContext = {
	actorUserId: string | null;
	ip: string | null;
	userAgent: string | null;
};

export type UpdateSettingsResult =
	| { ok: true; changed: false }
	| { ok: true; changed: true; changes: Record<string, { old: unknown; new: unknown }> }
	| { ok: false; reason: 'not_found' | 'invalid_time_zone' };

/**
 * Update restaurant settings, writing the change and its audit row in the SAME
 * transaction (invariant 10).
 *
 * Recording old AND new values is what makes the audit row useful: the time zone
 * decides which business day a POS session belongs to, and the name will be
 * printed on receipts. A row that says only "settings were updated" cannot answer,
 * months later, what changed and when.
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

	// A no-op submission must not produce a meaningless audit row.
	if (Object.keys(diff).length === 0) return { ok: true, changed: false };

	const now = new Date();
	if (diff.name) {
		await tx
			.update(restaurants)
			.set({ name: changes.name!, updatedAt: now })
			.where(eq(restaurants.id, restaurantId));
	}
	if (diff.timeZone) {
		await tx
			.update(restaurantSettings)
			.set({ timeZone: canonical!, updatedAt: now })
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
 * Today the only required field is the time zone, so this is effectively always
 * true after registration — AND THAT IS THE POINT.
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

// NOT HERE, IN ANY FORM, NOT EVEN COMMENTED OUT: tax mode, tax rate, currency,
// approval limits, idle-lock timing. Spec 33 open decisions 3, 4 and 6.
