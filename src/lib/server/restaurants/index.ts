import { eq } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import type { DbTx } from '../db/client';
import { restaurants } from '../db/schema/restaurants';
import { restaurantSettings } from '../db/schema/restaurant-settings';
import { writeAudit } from '../audit';
import { TAX_MODES, type TaxMode } from '../../money/tax';
import { SUPPORTED_CURRENCIES } from '../../money/format';
import { isValidTimeZone, canonicalTimeZone } from './time-zone';

export { isValidTimeZone, canonicalTimeZone, timeZoneSuggestions } from './time-zone';

// This module holds restaurant identity and settings and the onRestaurantCreated
// initializer list. It calls audit/ and NOTHING else — the two lists it reads from
// the isomorphic src/lib/money (TAX_MODES, SUPPORTED_CURRENCIES) call nothing —
// and is called by routes and by auth/register.ts. CLAUDE.md's "Where code lives"
// does not list it; T-26 adds it.
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
	/** Spec 33 open decision 3: null until the owner chooses, and never defaulted. */
	taxMode: TaxMode | null;
	/** ONE rate per restaurant, in integer basis points (825 = 8.25%), or null. */
	taxRateBp: number | null;
	/** An ISO 4217 code the money formatter supports, or null. */
	currencyCode: string | null;
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
			taxMode: restaurantSettings.taxMode,
			taxRateBp: restaurantSettings.taxRateBp,
			currencyCode: restaurantSettings.currencyCode,
			createdAt: restaurants.createdAt
		})
		.from(restaurants)
		.innerJoin(restaurantSettings, eq(restaurantSettings.restaurantId, restaurants.id))
		.where(eq(restaurants.id, restaurantId))
		.limit(1);

	const row = rows[0];
	if (!row) return null;
	// The column is text; the CHECK restaurant_settings_tax_mode_valid admits exactly
	// TAX_MODES or NULL, which is what makes this narrowing true.
	return { ...row, taxMode: row.taxMode as TaxMode | null };
}

export type SettingsChanges = {
	name?: string;
	timeZone?: string;
	posIdleLockSeconds?: number;
	// Typed loosely ON PURPOSE: each is validated inside updateSettings, whoever
	// the caller is.
	taxMode?: string;
	taxRateBp?: number;
	currencyCode?: string;
};

export type UpdateSettingsContext = {
	actorUserId: string | null;
	ip: string | null;
	userAgent: string | null;
};

export type UpdateSettingsResult =
	| { ok: true; changed: false }
	| { ok: true; changed: true; changes: Record<string, { old: unknown; new: unknown }> }
	| {
			ok: false;
			reason:
				| 'not_found'
				| 'invalid_time_zone'
				| 'invalid_idle_lock'
				| 'invalid_tax_mode'
				| 'invalid_tax_rate'
				| 'invalid_currency';
	  };

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

	// Tax mode, tax rate and currency (spec 33 open decisions 3 and 4, answered
	// 2026-09-15), each validated only when submitted, against the SAME lists the
	// money module computes and formats with — so the database can never hold a mode
	// taxOnLine refuses or a code formatMoney cannot render.
	if (changes.taxMode !== undefined) {
		if (!(TAX_MODES as readonly string[]).includes(changes.taxMode)) {
			return { ok: false, reason: 'invalid_tax_mode' };
		}
		if (changes.taxMode !== current.taxMode) {
			diff.taxMode = { old: current.taxMode, new: changes.taxMode };
		}
	}

	if (changes.taxRateBp !== undefined) {
		// Postgres would silently ROUND a decimal into the integer column; this guard
		// and the form's zod .int() are the real defences.
		const bp = changes.taxRateBp;
		if (!Number.isSafeInteger(bp) || bp < 0 || bp > 10_000) {
			return { ok: false, reason: 'invalid_tax_rate' };
		}
		if (bp !== current.taxRateBp) {
			diff.taxRateBp = { old: current.taxRateBp, new: bp };
		}
	}

	if (changes.currencyCode !== undefined) {
		if (!Object.hasOwn(SUPPORTED_CURRENCIES, changes.currencyCode)) {
			return { ok: false, reason: 'invalid_currency' };
		}
		if (changes.currencyCode !== current.currencyCode) {
			diff.currencyCode = { old: current.currencyCode, new: changes.currencyCode };
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
	if (
		diff.timeZone ||
		diff.posIdleLockSeconds ||
		diff.taxMode ||
		diff.taxRateBp ||
		diff.currencyCode
	) {
		await tx
			.update(restaurantSettings)
			.set({
				...(diff.timeZone ? { timeZone: canonical! } : {}),
				...(diff.posIdleLockSeconds ? { posIdleLockSeconds: changes.posIdleLockSeconds! } : {}),
				...(diff.taxMode ? { taxMode: changes.taxMode! } : {}),
				...(diff.taxRateBp ? { taxRateBp: changes.taxRateBp! } : {}),
				...(diff.currencyCode ? { currencyCode: changes.currencyCode! } : {}),
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
 * Required today: the time zone, the POS idle lock (T-08), and the tax mode, tax
 * rate and currency (T-36). Registration sets only the time zone, so a freshly
 * registered restaurant is INCOMPLETE until the owner chooses the other four — and
 * the POS launch is gated on this function: a till whose idle lock nobody chose has
 * no timeout to honour, and one whose tax mode nobody chose would total a bill by
 * a rule nobody picked.
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
	// AFTER the idle lock, in this order: tests deep-equal the array.
	if (current.taxMode === null) missing.push('tax mode');
	if (current.taxRateBp === null) missing.push('tax rate');
	if (current.currencyCode === null) missing.push('currency');

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
