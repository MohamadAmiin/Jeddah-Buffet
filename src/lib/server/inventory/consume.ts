// consumeForSale — the inventory step of spec 13's payment transaction, as a
// DOCUMENTED NO-OP. It sits between "Record Invoice Number" and "Create
// Invoice" so that when the inventory plan adds recipes, EVERY sale posts
// Dr 5000 Cost of Goods Sold / Cr 1200 Inventory (invariant 6: inventory is
// a ledger; every sale posts COGS to it).
//
// THIS FUNCTION IS THE ONLY PLACE THE INVENTORY PLAN MUST CHANGE to make
// every sale post COGS. recordSale (T-19) already calls it in spec 13's slot
// and already posts cogsLines(cogsMinor) whenever cogsMinor > 0n.
//
// Until then: no stock movement is written, no COGS entry is posted, gross
// profit equals revenue in the books, and sales made before recipes exist
// will NEVER carry COGS — posted records are permanent (invariant 2), so a
// later plan MAY NOT back-fill movements onto them.
//
// It writes nothing, reads nothing, never throws, and takes the caller's tx
// rather than opening its own (invariant 4). It does NOT read menu_items:
// cost is the inventory ledger's weighted average, never a number on a menu
// row (invariant 6).

import type { DbTx } from '../db/client';
import { minor, type Minor } from '../../money';
import type { SaleLine } from '../../sync-ops';

export type ConsumeArgs = { restaurantId: string; orderId: string; lines: SaleLine[] };
export type ConsumeResult = { movements: never[]; cogsMinor: Minor };

export async function consumeForSale(tx: DbTx, args: ConsumeArgs): Promise<ConsumeResult> {
	void tx; // used the day recipes exist (invariant 4)
	void args; // recipe x quantity, incl. modifiers, the day recipes exist (spec 13, 15)
	return { movements: [], cogsMinor: minor(0n) };
}
