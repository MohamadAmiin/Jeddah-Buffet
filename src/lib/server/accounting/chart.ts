// Spec 23 verbatim. Never add, rename or renumber an account here — a code the
// spec does not define is an open decision to surface, not a gap to fill
// (CLAUDE.md, Domain glossary).
//
// Every restaurant gets all 23 accounts (Assumption 5 of tasks/pos-sales,
// recorded in CLAUDE.md by T-02 on 2026-09-28), deviating from spec 23's
// "Only the payment methods the restaurant accepts are created" — turning a
// tender on later must not need a migration or a seed step.

import { and, eq } from 'drizzle-orm';
import { accounts } from '../db/schema/accounting';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';

/** The six literals T-04's accounts.type CHECK admits. */
export const ACCOUNT_TYPES = [
	'asset',
	'liability',
	'equity',
	'revenue',
	'cost_of_sales',
	'expense'
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type ChartRow = {
	readonly code: string;
	readonly name: string;
	readonly type: AccountType;
};

/** Spec 23, in spec order. The dash in 1020 and 1030 is an EN DASH (U+2013). */
export const CHART: readonly ChartRow[] = Object.freeze([
	{ code: '1000', name: 'Cash on Hand', type: 'asset' },
	{ code: '1010', name: 'Bank', type: 'asset' },
	{ code: '1020', name: 'Payment Clearing – Card', type: 'asset' },
	{ code: '1030', name: 'Payment Clearing – Mobile Money', type: 'asset' },
	{ code: '1200', name: 'Inventory', type: 'asset' },
	{ code: '2000', name: 'Accounts Payable', type: 'liability' },
	{ code: '2100', name: 'Tax Payable', type: 'liability' },
	{ code: '3000', name: "Owner's Capital", type: 'equity' },
	{ code: '3100', name: "Owner's Drawings", type: 'equity' },
	{ code: '3900', name: 'Retained Earnings', type: 'equity' },
	{ code: '4000', name: 'Sales Revenue', type: 'revenue' },
	{ code: '4100', name: 'Sales Discounts', type: 'revenue' },
	{ code: '4200', name: 'Sales Refunds', type: 'revenue' },
	{ code: '5000', name: 'Cost of Goods Sold', type: 'cost_of_sales' },
	{ code: '5100', name: 'Waste & Inventory Adjustments', type: 'cost_of_sales' },
	{ code: '5200', name: 'Comps & Staff Meals', type: 'cost_of_sales' },
	{ code: '6000', name: 'Rent Expense', type: 'expense' },
	{ code: '6100', name: 'Salary Expense', type: 'expense' },
	{ code: '6200', name: 'Utilities Expense', type: 'expense' },
	{ code: '6300', name: 'Maintenance Expense', type: 'expense' },
	{ code: '6400', name: 'Payment Processing Fees', type: 'expense' },
	{ code: '6800', name: 'Cash Over/Short', type: 'expense' },
	{ code: '6900', name: 'Other Expenses', type: 'expense' }
]);

/** Idempotently seed spec 23's 23 accounts for a restaurant. Called by the
 * restaurantInitializers list for new restaurants; migration 0012 (T-09)
 * backfilled the same rows for restaurants that existed before this ran. */
export async function ensureChart(tx: DbTx, restaurantId: string): Promise<void> {
	await tx
		.insert(accounts)
		.values(
			CHART.map((row) => ({
				restaurantId,
				code: row.code,
				name: row.name,
				type: row.type
			}))
		)
		.onConflictDoNothing({ target: [accounts.restaurantId, accounts.code] });
}

/** The one code-to-id lookup. Throws when the code is absent so a rule cannot
 * silently post to a missing account. */
export async function accountIdByCode(
	tx: Executor,
	restaurantId: string,
	code: string
): Promise<string> {
	const rows = await tx
		.select({ id: accounts.id })
		.from(accounts)
		.where(and(eq(accounts.restaurantId, restaurantId), eq(accounts.code, code)))
		.limit(1);
	if (rows.length === 0) {
		throw new Error(
			`account ${code} is not in the chart of restaurant ${restaurantId}; run ensureChart`
		);
	}
	return rows[0].id;
}
