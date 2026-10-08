import { eq, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { restaurantSettings } from '../db/schema/restaurant-settings';

// THE MENU VERSION BUMP (spec 5; tasks/settings-tax-payments-receipt T-10).
//
// This is the ONE place src/lib/server/menu/ increments
// restaurant_settings.menu_version — the integer the till compares before it
// downloads the full snapshot. Every menu write (index.ts) and every tax-rate
// write (tax-rates.ts) runs inside it, in the caller's transaction.
//
// It is exported ONLY so the sibling tax-rates.ts can use it, and it is NOT
// re-exported from index.ts: nothing outside src/lib/server/menu/ imports it.
// restaurants/ never calls it — updateSettings bumps menu_version with its own
// inline SQL increment (CLAUDE.md decision (k)), because restaurants/ may not
// import menu/.

export async function withMenuVersionBump<T>(
	tx: DbTx,
	restaurantId: string,
	write: (tx: DbTx) => Promise<T>
): Promise<T> {
	const result = await write(tx);
	// IN SQL, never read-modify-write in TypeScript: two concurrent writes must not
	// both read 7 and both write 8. updated_at is NOT touched — it means "the owner
	// changed a setting" and pairs with the settings.updated audit event.
	await tx
		.update(restaurantSettings)
		.set({ menuVersion: sql`${restaurantSettings.menuVersion} + 1` })
		.where(eq(restaurantSettings.restaurantId, restaurantId));
	return result;
}
