// Test-only settings fixtures: named tax rates (T-13) and payment methods (T-15).
//
// tasks/settings-tax-payments-receipt T-13: the restaurant's tax rate is a NAMED
// tax_rates row and the default is a pointer at one (restaurant_settings.
// default_tax_rate_id). A fixture that used to pass `updateSettings({ taxRateBp })`
// seeds a named rate here instead, through the real writers — createTaxRate and
// updateSettings — so every fixture rate is versioned and audited exactly as an
// owner's would be. Nothing here writes a table directly.
//
// T-15: a card or mobile tender is a named payment_methods row now, not the
// retired accepts_card / accepts_mobile switches. seedPaymentMethod goes through
// the real writer, createPaymentMethod; cashMethodId and defaultTaxRateOf only
// READ, so a test can name the built-in Cash row and the default rate.

import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../client';
import type { Executor } from '../../auth/session';
import { paymentMethods } from '../schema/payment-methods';
import { restaurantSettings } from '../schema/restaurant-settings';
import { taxRates } from '../schema/tax-rates';
import { createTaxRate } from '../../menu';
import { createPaymentMethod, updateSettings, type UpdateSettingsContext } from '../../restaurants';

/**
 * Create a named tax rate (`name` defaults to 'Tax', so receipts read "Tax 10.00%"
 * as before) and, when `makeDefault` is true, make it the restaurant's default.
 * `makeDefault` defaults to false: a rate is not a default until someone says so
 * (risk 5). Throws `seedTaxRate: <reason>` on any refusal; returns the rate id.
 */
export async function seedTaxRate(
	tx: DbTx,
	restaurantId: string,
	input: { name?: string; rateBp: number; makeDefault?: boolean },
	ctx: UpdateSettingsContext
): Promise<string> {
	const created = await createTaxRate(
		tx,
		restaurantId,
		{ name: input.name ?? 'Tax', rateBp: input.rateBp },
		ctx
	);
	if (!created.ok) throw new Error(`seedTaxRate: ${created.reason}`);

	if (input.makeDefault === true) {
		const result = await updateSettings(tx, restaurantId, { defaultTaxRateId: created.id }, ctx);
		if (!result.ok) throw new Error(`seedTaxRate: ${result.reason}`);
	}
	return created.id;
}

/**
 * Create an owner-named card or mobile method through createPaymentMethod, so it
 * is validated, ordered and audited exactly as an owner's would be.
 * `merchantNumber` defaults to null and `enabled` to true. Throws
 * `seedPaymentMethod failed: <reason>` on a refusal; returns the method id.
 */
export async function seedPaymentMethod(
	tx: DbTx,
	restaurantId: string,
	input: {
		name: string;
		kind: 'card' | 'mobile';
		merchantNumber?: string | null;
		enabled?: boolean;
	},
	ctx: UpdateSettingsContext = { actorUserId: null, ip: null, userAgent: null }
): Promise<string> {
	const created = await createPaymentMethod(
		tx,
		restaurantId,
		{
			name: input.name,
			kind: input.kind,
			merchantNumber: input.merchantNumber ?? null,
			enabled: input.enabled ?? true
		},
		ctx
	);
	if (!created.ok) throw new Error(`seedPaymentMethod failed: ${created.reason}`);
	return created.id;
}

/**
 * The id of the restaurant's built-in Cash row (seeded by seedCashMethod, or by
 * migration 0017 for older restaurants). Throws when there is none.
 */
export async function cashMethodId(database: Executor, restaurantId: string): Promise<string> {
	const [row] = await database
		.select({ id: paymentMethods.id })
		.from(paymentMethods)
		.where(and(eq(paymentMethods.restaurantId, restaurantId), eq(paymentMethods.kind, 'cash')))
		.limit(1);
	if (!row) throw new Error(`cashMethodId: restaurant ${restaurantId} has no Cash row`);
	return row.id;
}

/**
 * The restaurant's default tax rate — restaurant_settings.default_tax_rate_id
 * joined to tax_rates on id AND restaurant — or null while the owner has chosen
 * none.
 */
export async function defaultTaxRateOf(
	database: Executor,
	restaurantId: string
): Promise<{ id: string; name: string; rateBp: number } | null> {
	const [row] = await database
		.select({ id: taxRates.id, name: taxRates.name, rateBp: taxRates.rateBp })
		.from(restaurantSettings)
		.innerJoin(
			taxRates,
			and(
				eq(taxRates.id, restaurantSettings.defaultTaxRateId),
				eq(taxRates.restaurantId, restaurantSettings.restaurantId)
			)
		)
		.where(eq(restaurantSettings.restaurantId, restaurantId))
		.limit(1);
	return row ?? null;
}
