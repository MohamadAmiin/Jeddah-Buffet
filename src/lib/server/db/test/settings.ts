// Test-only settings fixtures; T-15 adds `seedPaymentMethod` beside this.
//
// tasks/settings-tax-payments-receipt T-13: the restaurant's tax rate is a NAMED
// tax_rates row and the default is a pointer at one (restaurant_settings.
// default_tax_rate_id). A fixture that used to pass `updateSettings({ taxRateBp })`
// seeds a named rate here instead, through the real writers — createTaxRate and
// updateSettings — so every fixture rate is versioned and audited exactly as an
// owner's would be. Nothing here writes a table directly.

import type { DbTx } from '../client';
import { createTaxRate } from '../../menu';
import { updateSettings, type UpdateSettingsContext } from '../../restaurants';

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
