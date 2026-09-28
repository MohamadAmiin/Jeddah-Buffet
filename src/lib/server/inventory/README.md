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

No inventory tables exist yet. `consumeForSale` in `consume.ts` is the seam the payment transaction (`orders/pay.ts`, T-19) calls in spec 13's "Deduct Inventory" slot; today it takes the caller's `tx` and returns `{ movements: [], cogsMinor: 0n }`. The inventory plan will replace its body with recipe × quantity deductions (modifiers included) costed at the weighted average and return the movements and their total cost. Until then no stock movement is written and no COGS entry is posted, so gross profit equals revenue in the books, and sales recorded before recipes exist will never carry COGS (invariant 2 — posted records are permanent, so no back-fill).

Called by `orders/`. Never calls `orders/` back.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 15, 16, 19. Invariants 1, 2, 6.
