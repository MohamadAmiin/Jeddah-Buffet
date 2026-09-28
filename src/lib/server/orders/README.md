# `orders/` — order/item lifecycle, split & merge bills, THE payment transaction

Order/item lifecycle, split & merge bills, THE payment transaction.

- Lifecycle `OPEN → BILLED → PAID`. Adding items to a BILLED order re-opens it.
  Re-opening a PAID order needs owner-PIN approval and writes NEW records — it
  never rewinds posted ones (invariant 2).
- Item status `NEW` (change or delete freely) → `SENT` (kitchen ticket printed;
  removal is a void, not a delete) → `VOIDED`.
- **The payment transaction is one all-or-nothing DB transaction and it runs AT
  PAYMENT**, in this order: record payment(s) → finalize totals → take the
  invoice number → deduct inventory (recipe × qty, incl. modifiers) → create
  invoice → post journal entries (sale **and** COGS) → mark order PAID.
  Splitting it across requests, or committing part of it alone, is a bug. An
  offline sale runs the SAME transaction server-side on sync (invariant 4,
  spec 13).
- Printing NEVER happens inside the transaction. Adding items and sending to
  the kitchen are ordinary saves.
- Every line stores the unit price AND tax rate used, so later menu or rate
  changes cannot alter past sales (invariant 7).

## Status

`pay.ts` holds THE payment transaction (`recordSale`), run inside the caller's transaction in spec 13's order: insert `orders` + `order_lines` + `order_line_modifiers` → insert `payments` → finalize totals (no recomputation; validateSale already compared) → insert `invoices` (records the device-namespace number; a 23505 rolls the whole tx back and T-21 maps it to `invoice_collision`) → `consumeForSale` (T-17 no-op today) → post the sale entry, and the COGS entry only when `cogsMinor > 0n` → mark the order `paid` (the ONE status change; invariant 2 keeps every other row immutable) → write `sale.recorded` (with `clientOpId`) and `sale.flagged` (with `clientOpId: null`) when soft flags carried through.

`sync.ts` (T-21) is its only caller and owns the `db.transaction` boundary. `validate.ts` (T-18) turns a queued `sale.complete` envelope into a `ParsedSale` and its soft flags.

Not built here: the server-side OPEN/BILLED lifecycle, split and merge bills, voids of SENT items, refunds, comps, re-opening a paid order, and printing.

This module calls `accounting/`, `inventory/`, `permissions/`, `audit/` and
`money/`. **None of them call back.**

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 13, 14. Invariants 1, 2, 4, 7, 9, 10.
