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

Called by `orders/`. Never calls `orders/` back.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 15, 16, 19. Invariants 1, 2, 6.
