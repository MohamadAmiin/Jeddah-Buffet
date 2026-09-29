# `inventory/` — stock movements, recipes + unit conversion, costing

Stock movements, recipes + unit conversion, weighted-average costing.

- **Inventory is a ledger.** Stock on hand is the sum of stock movements
  (purchase, sale consumption, waste, comp, count adjustment). A cached
  quantity may exist for speed but is never the truth, and is never written
  without the movement that caused it (invariant 6).
- Sales are **never blocked** by stock levels. Negative stock is flagged, not
  prevented.
- Costing is weighted average, recalculated on EVERY purchase, with purchase
  units converted to base units first. Recipes use base units (g, pcs, can);
  purchases are entered in purchase units (kg, bag, case).
- Every sale posts Dr COGS / Cr Inventory via `accounting/`.
- Modifiers change the recipe as well as the price, so they change the
  deduction too.
- Posted stock movements are permanent (invariant 2).
- Quantities are `numeric(12,3)`; costs are integer minor units in `bigint`.

## Status

`consumeForSale` in `consume.ts` runs inside the payment transaction (`orders/pay.ts`) in spec 13's "Deduct Inventory" slot and first reads the order's `paid_at` and its POS session's business date, which every movement it writes carries. It aggregates the recipes of the sold items and chosen modifiers, with modifier deltas clamped at zero per line (`consumption.ts`). It writes one `sale_consumption` movement per ingredient through the one ledger writer, `applyMovements` in `movements.ts`, costed at the current weighted average, and returns the cost that `recordSale` posts as Dr 5000 / Cr 1200. A dish with no recipe consumes nothing and posts no COGS, and a sale recorded before its recipe existed never gains COGS later (invariant 2). It never throws for a business reason — an archived ingredient is consumed, stock may go negative, an ingredient with no average costs zero — so a completed cash sale is never rolled back by it (invariant 4).

## The rules

- **One writer.** `applyMovements` (`movements.ts`) is the only code that inserts into
  `stock_movements` or writes `on_hand_qty`, `inventory_value_minor` or `avg_unit_cost_micro`.
- **One lock order.** It takes every affected ingredient row in ONE
  `select … where id = any($ids) order by id for update`, reads the caches only from that result
  and holds the lock to COMMIT — no lost update between a syncing sale and a dashboard write, and
  no deadlock. Call it once per transaction: locking in two steps can deadlock. Supplier payments
  lock the delivery row before the payment row; a delivery reversal locks only the delivery.
- **Never throw for a business reason inside a sale.** `consume.ts` runs inside the payment
  transaction: no recipe, an archived ingredient, stock below zero and an ingredient with no
  average are all normal; only a missing order row (a programming error) throws.
- **Reversals, never edits.** A wrong delivery or supplier payment is reversed with a reason
  (3–200 characters), dated the day it is made in the restaurant's zone; a delivery's payments are
  reversed before the delivery; `journal_entries_reverses_entry_unique` allows one reversal per
  entry, and the once-written reversal stamp is claimed before anything else is written.
- **A count waits for the till.** No count posts while a POS session is open or a `sale.complete`
  op is unrecorded and unresolved; the system quantity is the locked cache.

## Files

- `movements.ts` — `applyMovements`, the ONE writer of `stock_movements` and the three cache
  columns, under one ordered `FOR UPDATE`; `lockIngredients`.
- `consumption.ts` — `aggregateConsumption`, pure recipe × quantity with clamped modifier deltas.
- `consume.ts` — `consumeForSale`, the payment transaction's inventory step.
- `ingredients.ts` — ingredients and purchase units (create, update, archive).
- `recipes.ts` — `setRecipe`, `recipeIndexFor`, `readRecipes`, `recipeCosts` (the menu page's
  cost; never in the POS snapshot).
- `purchases.ts` — `recordPurchase`, `reversePurchase`, `listPurchases`, `getPurchase`.
- `payments.ts` — `paySupplier`, `reverseSupplierPayment`, `outstandingMinor`.
- `opening.ts` — `recordOpeningStock` (Dr 1200 / Cr 3000).
- `waste.ts` — `recordWaste` (Dr 5100 / Cr 1200 at the average).
- `counts.ts` — `countBlockers`, `postCount`.
- `reports.ts` — current stock with the cache-vs-ledger tripwire, reconciliation with 1200, the
  movement log, consumption, waste and COGS by business date, counts.
- `business-date.ts` — `todayInZone`, in SQL.
- `*.integration.test.ts` — each against the real database; `consume.integration.test.ts`
  drives the real `recordSale` and `handleOp`.

Called by `orders/`. Never calls `orders/` back.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 15, 16, 19. Invariants 1, 2, 6.
