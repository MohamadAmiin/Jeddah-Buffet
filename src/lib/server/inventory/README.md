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

## Files

- `movements.ts` — `applyMovements`, the ONE writer of `stock_movements` and the three cache
  columns, under one ordered `FOR UPDATE`; `lockIngredients`.
- `consumption.ts` — `aggregateConsumption`, pure recipe × quantity with clamped modifier deltas.
- `consume.ts` — `consumeForSale`, the payment transaction's inventory step.
- `ingredients.ts` — ingredients and purchase units; `recipes.ts` — recipes, `recipeIndexFor`,
  `recipeCosts`; `business-date.ts` — `todayInZone`.
- `*.integration.test.ts` — each against the real database; `consume.integration.test.ts`
  drives the real `recordSale` and `handleOp`.

Called by `orders/`. Never calls `orders/` back.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 15, 16, 19. Invariants 1, 2, 6.
