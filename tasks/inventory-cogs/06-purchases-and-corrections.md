# Phase 4 — deliveries, supplier payments, reversals and opening stock (T-20 … T-23)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: Phase 3 (the ledger writer,
> ingredients and purchase units) and Phase 2 (the posting rules and `postReversal`).

Deliveries are spec 19's purchases: entered in purchase units, converted to base units, costed into the
weighted average, and posted `Dr 1200 Inventory / Cr 1000 Cash on Hand | 1010 Bank | 2000 Accounts
Payable`. Stock enters only through `applyMovements`; the journal only through the rule functions and
`postEntry`/`postReversal`. Corrections are reversals, never edits (invariant 2, spec 22): the delivery
row is locked `FOR UPDATE` before its state is checked, the reversal stamp is a conditional `UPDATE …
WHERE reversed_at IS NULL` that must affect exactly one row before anything else is written, and the
database's `journal_entries_reverses_entry_unique` index allows one reversal per entry. A delivery on
credit cannot be reversed while an unreversed payment references it; the owner reverses the payment
first. Every function takes the caller's transaction, is scoped by `restaurant_id`, writes its audit row
in that transaction (invariant 10), and returns `{ ok: true, … } | { ok: false, reason }` for business
refusals; it throws only for programming errors.

### T-20 — `recordPurchase`: delivery lines, unit conversion, movements, revaluation, entries

**Needs:** T-13, T-17
**Files:**
- `src/lib/server/inventory/purchases.ts` — NEW
- `src/lib/server/inventory/purchases.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16; re-export this task's names)
**Spec:** 19 (purchase units converted to base units; each purchase updates the weighted average; paid
immediately → Cash; on credit → Accounts Payable), 16 (the weighted-average example), 24 ("Purchase paid
immediately | Inventory | Cash on Hand or Bank"; "Purchase on credit | Inventory | Accounts Payable")
**Invariants:** 6 (stock enters only as movements; the average is recalculated on every purchase), 3
(entries from the rule table, balanced in the DB), 1 (bigint minor units; quantities as `Qty`), 10
(audit in the same transaction), 11 (the owner's business date on every movement and entry)

**Do:**
1. `recordPurchase(tx, ctx: InventoryWriteContext, input: { supplierName: string; businessDate: string;
   paidBy: 'cash' | 'bank' | 'credit'; note?: string | null; lines: { ingredientId: string;
   purchaseUnitId: string; unitQty: Qty; lineCostMinor: Minor }[] })` → `{ ok: true; purchaseId: string;
   revaluationMinor: Minor }` or `{ ok: false; reason: 'no_lines' | 'too_many_lines' | 'invalid_line';
   lineNo?: number }`.
2. Refuse `'no_lines'` for zero lines and `'too_many_lines'` for more than 50. For every line: the
   purchase unit must exist in the restaurant, be live (`archived_at is null`) and belong to the line's
   ingredient, and the ingredient must be live; otherwise `'invalid_line'` with the 1-based `lineNo`.
   `unitQty > 0n` and `lineCostMinor >= 0n` or `'invalid_line'`.
3. For each line compute `baseQty = mulQty(unitQty, baseQtyPerUnit, ROUNDING_RULE)`; if it rounds to
   `0n` → `'invalid_line'`.
4. `purchaseId = crypto.randomUUID()`; `total = sum(lineCosts)` (the money module's `sum`, seeded at 0n).
5. Insert the header (`supplier_name` trimmed, `business_date`, `paid_by`, `total_minor`, `note`,
   `recorded_by_user_id`, `journal_entry_id` null), then the lines with `line_no` 1…n and the snapshots
   (`purchase_unit_name`, `base_qty_per_unit`), all quantities written with `formatQty`.
6. `applyMovements(tx, { restaurantId, sourceType: 'purchase', sourceId: purchaseId, businessDate,
   occurredAt: new Date(), recordedByUserId: ctx.actorUserId }, lines.map(l => ({ kind: 'inbound', type:
   'purchase', ingredientId, qty: baseQty, costMinor: lineCostMinor })))` — two lines of the same
   ingredient are two requests, applied in line order.
7. `postEntry(tx, { restaurantId, businessDate, event: purchaseEvent(paidBy), sourceType: 'purchase',
   sourceId: purchaseId, memo: \`Delivery from ${supplierName}\`, lines: purchaseLines(paidBy, total) })`
   — it returns `null` for a zero total and writes nothing; that is correct (a free delivery moves stock
   but no money).
8. If `revaluationMinor !== 0n`: `postEntry(…, event: 'inventory_revaluation', memo: \`Revaluation on
   delivery from ${supplierName}\`, lines: revaluationLines(revaluationMinor))` (assumption 2: to 5000).
9. `UPDATE purchases SET journal_entry_id = <entry id> WHERE id = … AND restaurant_id = … AND
   journal_entry_id IS NULL` (once; skip when no entry was posted).
10. Audit `purchase.recorded` with `purchaseId`, the trimmed supplier name, `paidBy`, `totalMinor` as a
    string and `lineCount`.
11. Also export `listPurchases(db, restaurantId, { limit })` (newest `recorded_at` first; supplier,
    business date, paid by, total, reversed flag, outstanding from T-21's `outstandingMinor` — add it
    when T-21 lands, returning `0n` for non-credit until then) and `getPurchase(db, restaurantId, id)`
    (header, lines, and — from T-21 on — payments).

**Tests:** MANDATORY (spec 29 — one posting-rule test per business event, through the real path; money
arithmetic)
- Spec 16 as two deliveries of meat (base unit g, purchase unit `kg` with `base_qty_per_unit` 1000.000):
  10.000 kg at `5000n`, then 10.000 kg at `6000n`, both paid by bank → the cache reads `20000.000` g,
  value `11000`, average `550000`; two entries `Dr 1200 5000 / Cr 1010 5000` and `Dr 1200 6000 / Cr 1010
  6000`, event `purchase_paid`.
- The same first delivery on credit → `Dr 1200 5000 / Cr 2000 5000`, event `purchase_on_credit`; paid by
  cash → `Cr 1000`.
- Negative stock (T-10(d)): 30,000.000 g consumed at average 0 through `applyMovements` (an `out`), then
  a delivery of 50.000 kg for `25000n` → movements `purchase +50000.000 / 25000` and `revaluation 0.000 /
  -15000`; entries `Dr 1200 25000 / Cr 1010 25000` and `inventory_revaluation Dr 5000 15000 / Cr 1200
  15000`; result `revaluationMinor -15000n`.
- A two-line delivery naming one ingredient twice → two `purchase` movements, one entry for the total.
- A zero-cost delivery → stock moves, no journal entry, `journal_entry_id` stays null.
- After every case above: 1200's balance (Σ debit − Σ credit on account 1200 for the restaurant) equals
  Σ `inventory_value_minor` of its ingredients.
- A purchase unit of another restaurant, an archived unit, a unit of a different ingredient → each
  `invalid_line` with its `lineNo`, and no row in any table.

**Done when:** `pnpm test:integration src/lib/server/inventory/purchases.integration.test.ts` passes.

**Watch out:** the business date is the owner's choice (the form defaults it to `todayInZone`); never
derive it from `recorded_at`. Never recompute the average here — `applyMovements` does it.

### T-21 — Supplier payments: `paySupplier` and `reverseSupplierPayment`

**Needs:** T-20
**Files:**
- `src/lib/server/inventory/payments.ts` — NEW
- `src/lib/server/inventory/payments.integration.test.ts` — NEW
- `src/lib/server/inventory/purchases.ts` — EXTEND (created by T-20; `listPurchases` and `getPurchase`
  now include `outstandingMinor` and the payments)
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16)
**Spec:** 19 ("When the supplier is paid later: Accounts Payable −, Cash (or Bank) −"), 24 ("Supplier paid
| Accounts Payable | Cash on Hand or Bank"), 22 (reversing entries)
**Invariants:** 2 (a payment is never edited; a mistake is a reversal), 3, 1, 10, 11 (a reversal is
dated the day it is made)

**Do:**
1. `outstandingMinor(executor, restaurantId, purchaseId): Promise<Minor>` = for a purchase with
   `paid_by = 'credit'` and `reversed_at is null`: `total_minor − Σ amount_minor` of its payments with
   `reversed_at is null`; `0n` for any other purchase. One query.
2. `paySupplier(tx, ctx, { purchaseId, amountMinor, paidFrom: 'cash' | 'bank', businessDate })` →
   `{ ok: true; paymentId }` or `'not_found' | 'not_credit' | 'reversed' | 'exceeds_outstanding' |
   'invalid_amount'`:
   1. FIRST `select … from purchases where id = $1 and restaurant_id = $2 for update` — the lock that
      serialises two concurrent payments (and a payment racing a reversal).
   2. Refuse `'not_credit'` unless `paid_by = 'credit'`; `'reversed'` if `reversed_at` is set;
      `'invalid_amount'` unless `amountMinor > 0n`; `'exceeds_outstanding'` if the amount is larger than
      `outstandingMinor` computed under the lock.
   3. `paymentId = crypto.randomUUID()`; insert the payment; `postEntry(event 'supplier_paid',
      sourceType 'supplier_payment', sourceId paymentId, lines supplierPaymentLines(paidFrom, amount),
      memo 'Supplier payment')`; set `journal_entry_id` once (`… where journal_entry_id is null`); audit
      `supplier.paid`.
3. `reverseSupplierPayment(tx, ctx, { paymentId, reason })` → `{ ok: true }` or `'not_found' |
   'already_reversed' | 'invalid_reason'`:
   1. Reason trimmed, 3–200 characters, else `'invalid_reason'`.
   2. Read the payment's `purchase_id` (scoped), lock the purchase row `FOR UPDATE`, then the payment row
      `FOR UPDATE`.
   3. `update supplier_payments set reversed_at = now(), reversed_by_user_id = $actor, reversal_reason =
      $reason where id = $id and restaurant_id = $r and reversed_at is null` — it must affect exactly one
      row, else `'already_reversed'`.
   4. `postReversal(tx, { restaurantId, entryId: journal_entry_id, businessDate: await todayInZone(tx,
      restaurantId), memo: \`Reversal: ${reason}\` })` (assumption 9: the reversal is dated today, in the
      restaurant's zone); store `reversal_entry_id` (`… where reversal_entry_id is null`); audit
      `supplier.payment_reversed`.

**Tests:** MANDATORY (spec 29 — posting rule per business event)
- A credit delivery of `11000n`; `paySupplier` `5000n` from bank → `Dr 2000 5000 / Cr 1010 5000`, event
  `supplier_paid`; `outstandingMinor` → `6000n`.
- Paying `7000n` next → `exceeds_outstanding`, nothing written.
- Two concurrent `paySupplier` of `6000n` each, on separate pool connections → exactly one `ok`, the
  other `exceeds_outstanding`; 2000's balance never goes below zero.
- `reverseSupplierPayment` of the 5000 payment → a mirror entry `Dr 1010 5000 / Cr 2000 5000` with
  `reverses_entry_id` set and today's business date in the restaurant's zone; `outstandingMinor` back to
  `11000n`; one `supplier.payment_reversed` audit row.
- Reversing it again → `already_reversed`, no new entry.
- Paying a delivery paid by cash → `not_credit`; paying a reversed delivery → `reversed`.
- Another restaurant's ids → `not_found`, nothing written.

**Done when:** `pnpm test:integration src/lib/server/inventory/payments.integration.test.ts` passes.

**Watch out:** always lock the purchase row before the payment row, in both functions, so the two can
never deadlock with each other or with `reversePurchase` (which locks only the purchase row).

### T-22 — `reversePurchase`: mirror movements and entries at the original cost

**Needs:** T-14, T-21
**Files:**
- `src/lib/server/inventory/purchases.ts` — EXTEND (created by T-20; add `reversePurchase`)
- `src/lib/server/inventory/purchases.integration.test.ts` — EXTEND (created by T-20; add a
  `describe('reversePurchase')` block)
**Spec:** 22 ("Posted entries are never edited or deleted. A mistake is fixed with a reversing entry plus
a correct new entry"), 3 (posted records are permanent), 16 (the average), 24
**Invariants:** 2 (nothing is edited: mirror movements and a mirror entry are new rows), 6 (the stock
reversal goes through the one writer), 3, 11 (dated today in the restaurant's zone), 10

**Do:**
1. `reversePurchase(tx, ctx, { purchaseId, reason })` → `{ ok: true; revaluationMinor: Minor }` or
   `'not_found' | 'already_reversed' | 'has_payments' | 'invalid_reason'`.
2. Reason trimmed, 3–200 characters, else `'invalid_reason'`.
3. `select … from purchases where id and restaurant_id for update`; none → `'not_found'`;
   `reversed_at` set → `'already_reversed'`.
4. Any payment of this purchase with `reversed_at is null` → `'has_payments'` (the page tells the owner to
   reverse the payments first).
5. `update purchases set reversed_at = now(), reversed_by_user_id, reversal_reason where id and
   restaurant_id and reversed_at is null` — exactly one row, else `'already_reversed'`.
6. `applyMovements(tx, { …, sourceType: 'purchase', sourceId: purchaseId, businessDate: await
   todayInZone(tx, restaurantId), occurredAt: new Date() }, one { kind: 'reversal', type:
   'purchase_reversal', ingredientId, qty: parseQty(line.base_qty), originalCostMinor: line.line_cost_minor }
   per line, in line order)` — the ORIGINAL line cost, never the current average.
7. When `journal_entry_id` is not null: `postReversal(tx, { restaurantId, entryId: journal_entry_id,
   businessDate: today, memo: \`Reversal: ${reason}\` })`; store `reversal_entry_id` once.
8. When `revaluationMinor !== 0n`: `postEntry(event 'inventory_revaluation', sourceType 'purchase',
   sourceId purchaseId, lines revaluationLines(revaluationMinor), businessDate today, memo 'Revaluation
   after delivery reversal')` — a new entry, not a reversal.
9. The delivery's own earlier revaluation entry, if any, is NOT reversed: the new revaluation re-balances
   stock value against 1200 from the state the ledger is in now. Say so in a comment.
10. Audit `purchase.reversed` with `totalMinor`, `reason` and `revaluationMinor` as strings.

**Tests:** MANDATORY (spec 29 — journal entries balance; posting rule per event through the real path)
- Reverse an unconsumed bank delivery of 10.000 kg meat for `6000n` into otherwise-empty stock → one
  `purchase_reversal` movement `-10000.000 / -6000`, stock `0.000` / value `0`, no revaluation, a mirror
  entry `Dr 1010 6000 / Cr 1200 6000` with `reverses_entry_id` set.
- Reverse after consumption (T-10(e)): stock `{20000.000 g, 2000, 100000}` built by an opening-stock or
  delivery, a delivery of 5.000 kg for `5000n` (average `280000`), 15,000.000 g consumed through
  `applyMovements` (`out`) → reversing the 5000 delivery gives a `purchase_reversal` movement cost `-5000`,
  a `revaluation` movement `+3600`, the average stays `280000`, value `1400`; entries: the mirror of the
  delivery and `inventory_revaluation Dr 1200 3600 / Cr 5000 3600`.
- A credit delivery with an open payment → `has_payments`, nothing written; after
  `reverseSupplierPayment` → the delivery reversal succeeds.
- Two concurrent reversals on separate connections → one `ok`, the other `already_reversed`; exactly one
  mirror entry and one set of `purchase_reversal` movements.
- After every case: Σ `inventory_value_minor` equals 1200's balance, and 2000's balance equals Σ
  `outstandingMinor` over the restaurant's credit deliveries.

**Done when:** `pnpm test:integration src/lib/server/inventory/purchases.integration.test.ts` passes.

**Watch out:** step 5 must run before step 6: the stamp claims the reversal, so a racing second call
fails at step 3 or 5 and never writes a movement.

### T-23 — `recordOpeningStock`

**Needs:** T-13, T-17
**Files:**
- `src/lib/server/inventory/opening.ts` — NEW
- `src/lib/server/inventory/opening.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16)
**Spec:** 24 ("Owner invests money | Cash on Hand or Bank | Owner's Capital" — the nearest row; spec 24
has none for stock the owner contributes, so assumption 1 records the amendment), 15 (stock on hand from
movements), 16 (the first cost sets the average)
**Invariants:** 6 (opening stock enters as a movement through the one writer), 2 (the entry is
append-only), 3, 1, 10

**Do:**
1. `recordOpeningStock(tx, ctx, { ingredientId, purchaseUnitId, unitQty: Qty, unitCostMinor: Minor,
   businessDate })` → `{ ok: true; entryId }` or `'not_found' | 'invalid_unit' | 'has_movements' |
   'already_recorded' | 'invalid_amount'`.
2. `lockIngredients(tx, restaurantId, [ingredientId])` first (throws for an unknown id — catch nothing;
   check existence with a scoped select before locking and answer `'not_found'`).
3. `'has_movements'` when any stock movement exists for the ingredient (opening stock is only for an
   ingredient with no history — assumption 1); `'already_recorded'` when an opening-stock entry exists.
4. The purchase unit must be live and belong to the ingredient, else `'invalid_unit'`; `unitQty > 0n`
   and `unitCostMinor >= 0n`, else `'invalid_amount'`.
5. `baseQty = mulQty(unitQty, baseQtyPerUnit, ROUNDING_RULE)`; `value = extendCost(unitQty,
   unitCostMinor, ROUNDING_RULE)`; `entryId = crypto.randomUUID()`.
6. `applyMovements(tx, { restaurantId, sourceType: 'opening_stock', sourceId: entryId, businessDate,
   occurredAt: new Date(), recordedByUserId }, [{ kind: 'inbound', type: 'opening_stock', ingredientId,
   qty: baseQty, costMinor: value }])`.
7. `postEntry(event 'opening_stock', sourceType 'opening_stock', sourceId entryId, lines
   openingStockLines(value), memo 'Opening stock')` — `null` when the value is 0.
8. Insert the `opening_stock_entries` row LAST (it is append-only), with every snapshot; audit
   `opening_stock.recorded`.

**Tests:** MANDATORY (spec 29 — posting rule per business event)
- 50.000 kg of meat at `500n` per kg (unit `kg` = 1000.000 g) → base `50000.000` g, value `25000`,
  average `500000`; entry `Dr 1200 25000 / Cr 3000 25000`, event `opening_stock`.
- A second opening-stock entry for the same ingredient → `has_movements` (the first one's movement
  exists and is checked first); assert exactly that reason.
- Opening stock after a delivery → `has_movements`.
- A unit cost of `0n` → a movement, no journal entry.
- A unit of another ingredient → `invalid_unit`; another restaurant's ingredient → `not_found`; nothing
  written in either case.

**Done when:** `pnpm test:integration src/lib/server/inventory/opening.integration.test.ts` passes.

**Watch out:** this is not a purchase — it credits 3000 Owner's Capital, never 1000, 1010 or 2000.
