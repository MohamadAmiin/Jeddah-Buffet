# Phase 4 — waste, stock counts and the inventory reports (T-24 … T-26)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: Phase 3 (the ledger writer) and
> the deliveries and opening stock of 06-purchases-and-corrections.md.

Waste and count shortfalls leave stock at the weighted average (`Dr 5100 Waste & Inventory Adjustments /
Cr 1200 Inventory`); count surpluses come back at the average (`Dr 1200 / Cr 5100`). A count compares
the shelf with the ledger total at posting time, read under the same ordered row locks every other
writer takes, and it refuses to post while a till session is open or a sale operation is unresolved:
a sale that happened before the count but reaches the server after it would otherwise be deducted twice,
once by the count's correction and again by its own consumption (the risk panel's count finding;
assumption 4). A count may cover only some ingredients; the rest are untouched. The reports read stored
rows with plain indexed SQL (spec 27), filter `restaurant_id` in every query, group by `business_date`
and never by `created_at::date` (invariant 11), and never recompute a cost — the movement's
`cost_minor` and the posted journal lines are the numbers.

### T-24 — `recordWaste`

**Needs:** T-13, T-15, T-16
**Files:**
- `src/lib/server/inventory/waste.ts` — NEW
- `src/lib/server/inventory/waste.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16; re-export `recordWaste`)
**Spec:** 15 ("Waste | − | Void after preparation, or waste entry"), 24 ("Waste / void after preparation
| Waste & Inventory Adjustments | Inventory"), 3 (audit), 6 (negative stock allowed and flagged)
**Invariants:** 6 (stock leaves only as a movement through the one writer), 3 (the entry comes from the
rule table), 2 (the waste entry is append-only), 10, 11

**Do:**
1. `recordWaste(tx, ctx, { ingredientId, qty: Qty, reason: 'spoilage' | 'preparation_error' | 'breakage'
   | 'other', note?: string | null, businessDate })` → `{ ok: true; wasteId; costMinor }` or
   `{ ok: false; reason: 'not_found' | 'ingredient_archived' | 'note_required' | 'invalid_qty' }`.
2. `'invalid_qty'` unless `qty > 0n`; `'note_required'` when the reason is `'other'` and the trimmed note
   is not 3–200 characters; `'not_found'` for an ingredient outside the restaurant;
   `'ingredient_archived'` for an archived one.
3. `wasteId = crypto.randomUUID()`; `applyMovements(tx, { restaurantId, sourceType: 'waste_entry',
   sourceId: wasteId, businessDate, occurredAt: new Date(), recordedByUserId }, [{ kind: 'out', type:
   'waste', ingredientId, qty }])`.
4. `postEntry(event 'waste', sourceType 'waste_entry', sourceId wasteId, lines
   wasteLines(negate(costMinor)), memo \`Waste: ${reason}\`)` — `null` when the cost is 0 (an ingredient
   never bought, average 0).
5. Insert the `waste_entries` row LAST (append-only); audit `waste.recorded` with the quantity and cost as
   strings.
6. Waste that takes stock below zero is allowed; the reports flag it.

**Tests:** MANDATORY (spec 29 — posting rule per business event)
- Tomato in grams with stock `{10000.000 g, 3000, 300000}` (built by an opening-stock entry of 10 kg at
  `300n`/kg), waste `2000.000` g → movement cost `-600` (target `valueAt(8000000n, 300000n)` = 2400),
  entry `Dr 5100 600 / Cr 1200 600`, stock `8000.000` / `2400`.
- Waste on an ingredient with average 0 and no stock → movement qty `-1.000`, cost `0`, no entry.
- `'other'` without a note → `note_required`; archived ingredient → `ingredient_archived`; another
  restaurant's → `not_found`; nothing written in each case.

**Done when:** `pnpm test:integration src/lib/server/inventory/waste.integration.test.ts` passes.

### T-25 — Stock counts: `countBlockers` and `postCount`

**Needs:** T-20, T-23, T-24
**Files:**
- `src/lib/server/inventory/counts.ts` — NEW
- `src/lib/server/inventory/counts.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16)
**Spec:** 15 ("The owner counts stock periodically. The difference between the counted and system
quantity is posted as a count adjustment, to the Waste & Inventory Adjustments account"), 24 ("Stock
count shortfall | Waste & Inventory Adjustments | Inventory"; "Stock count surplus | Inventory | Waste &
Inventory Adjustments"), 6 and 10 (session close requires an empty sync queue)
**Invariants:** 6 (the correction is a movement; the system quantity is the ledger's), 3, 2 (count lines
are append-only), 5 (a synced sale is never double-deducted), 10, 11

**Do:**
1. `countBlockers(executor, restaurantId): Promise<{ openSessions: number; unresolvedSales: number }>`:
   `count(*)` of `pos_sessions` with `status = 'open'`, and of `pos_sync_ops` with `kind =
   'sale.complete'`, `status = 'unrecorded'` and `resolved_at is null` — both tables created by
   tasks/pos-sales (T-05, T-07 there); confirm the column names in the schema files.
2. `postCount(tx, ctx, { businessDate, note?: string | null, lines: { ingredientId; countedQty: Qty }[] })`
   → `{ ok: true; countId; shortfallMinor; surplusMinor }` or `{ ok: false; reason: 'blocked';
   openSessions; unresolvedSales }` or `{ ok: false; reason: 'no_lines' | 'too_many_lines' |
   'duplicate_ingredient' | 'invalid_qty' | 'no_inbound_history'; ingredientIds?: string[] }`.
3. Validate: 1–500 lines, distinct ingredients, every `countedQty >= 0n`.
4. Re-check `countBlockers` inside the transaction; any count above zero → `'blocked'` with both numbers
   (assumption 4).
5. `lockIngredients(tx, restaurantId, ids)`; per line, `system = locked.state.qty`,
   `difference = countedQty − system`.
6. Refuse `'no_inbound_history'` listing every ingredient whose difference is positive and whose
   `hasInboundHistory` is false — a surplus on stock that was never delivered or opened cannot be valued
   (assumption 1: enter opening stock or a delivery first).
7. `countId = crypto.randomUUID()`; insert `stock_counts` (`counted_at` now, the business date, the note,
   the recorder).
8. Build one request per line with a non-zero difference: `{ kind: 'out', type: 'count_adjustment', qty:
   −difference }` when negative, `{ kind: 'in', type: 'count_adjustment', qty: difference }` when
   positive; `applyMovements(tx, { …, sourceType: 'stock_count', sourceId: countId })`.
9. Insert every line (zero differences included) into `stock_count_lines` with `system_qty`,
   `counted_qty`, `difference_qty` (all `formatQty`) and `cost_minor` from the returned movement (`0` for
   a zero difference).
10. `shortfall = −Σ negative costs`, `surplus = Σ positive costs`; `postEntry(event
    'stock_count_shortfall', sourceType 'stock_count', lines countShortfallLines(shortfall))` and
    `postEntry(event 'stock_count_surplus', …, countSurplusLines(surplus))`, each `null` when zero.
11. Audit `stock.counted`.

**Tests:** MANDATORY (spec 29 — posting rule per business event)
- Tomato `{10000.000 g, 3000, 300000}` counted `9970.000` g → movement cost `-9` (target
  `valueAt(9970000n, 300000n)` = 2991), entry `Dr 5100 9 / Cr 1200 9`, line difference `-30.000`.
- A surplus from negative stock (T-10(g)): an ingredient with a delivery in its history at average
  `500000`, driven to `{-10000.000 g, -5000}` by sales, counted `5000.000` g → movement cost `+7500`,
  entry `Dr 1200 7500 / Cr 5100 7500`.
- One count with a shortfall on one ingredient and a surplus on another → two entries, one per event.
- A count equal to the system quantity → a line with difference `0.000`, no movement, no entry.
- `blocked` while a `pos_sessions` row is open (insert one through pos-sales' session module or directly
  with every NOT NULL column), and again while an `unrecorded`, unresolved `sale.complete` op exists;
  nothing written.
- A surplus on an ingredient with no delivery and no opening stock → `no_inbound_history` naming it.
- Duplicate ingredient lines → `duplicate_ingredient`.

**Done when:** `pnpm test:integration src/lib/server/inventory/counts.integration.test.ts` passes.

**Watch out:** the system quantity is the locked cache, which equals the ledger total (T-26's tripwire
checks it); never compute it from movements filtered by time — a late sale is excluded by the blockers,
not by a timestamp filter.

### T-26 — The inventory reports and the cache-vs-ledger tripwire

**Needs:** T-19, T-22, T-25
**Files:**
- `src/lib/server/inventory/reports.ts` — NEW
- `src/lib/server/inventory/reports.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16)
**Spec:** 26 (Inventory reports: Current Stock, Stock Movement, Purchases, Consumption, Waste, Stock
Count Differences, Negative Stock Alerts, COGS), 27 ("well-indexed SQL queries on PostgreSQL are enough"),
25 (gross profit), 17 (business date)
**Invariants:** 11 (group by business date, never `created_at::date`), 6 (the ledger is the truth; the
cache is compared against it, never trusted blindly), 1 (bigint totals)

**Do:**
1. `currentStock(db, restaurantId)` → per ingredient that is live, or archived with a non-zero quantity or
   value: `{ id, name, baseUnit, onHandQty, avgMicro, valueMinor, negative: onHandQty < 0n, ledgerQty,
   ledgerValueMinor, drift: boolean, perUnit: { unitName; costMinor } | null }` — `ledgerQty` and
   `ledgerValueMinor` from ONE grouped query `sum(qty), sum(cost_minor) … group by ingredient_id`;
   `drift` when either differs from the cache; `perUnit` is the average per the first live purchase unit
   (`valueAt(qty(baseQtyPerUnit), avgMicro)`, the overview's display rule) or per one base unit when the
   ingredient has none.
2. `movementLog(db, restaurantId, ingredientId, { limit = 200 })` → newest first: `movementType`, `qty`,
   `costMinor`, `sourceType`, `sourceId`, `businessDate`, `occurredAt`.
3. `consumptionByDate(db, restaurantId, from, to)` → per `business_date` and ingredient: `Σ −qty` and
   `Σ −cost_minor` of `sale_consumption` movements.
4. `wasteByDate(db, restaurantId, from, to)` → per business date: each waste entry with its reason and
   the cost of its movement.
5. `countDifferences(db, restaurantId, countId)` → the count's lines with system, counted, difference and
   cost; `listCounts(db, restaurantId)` → counts newest first with their shortfall and surplus totals.
6. `negativeStock(db, restaurantId)` → ingredients with `on_hand_qty < 0`.
7. `cogsByDate(db, restaurantId, from, to)` → per `journal_entries.business_date`: Σ (debit − credit) on
   account 5000 for entries with event `cost_of_goods_sold`, and separately for `inventory_revaluation`.
8. `reconciliation(db, restaurantId)` → `{ stockValueMinor: Σ inventory_value_minor, ledger1200Minor: Σ
   debit − Σ credit on account 1200, differenceMinor, driftCount }`.
9. Every query names `restaurant_id` in its WHERE; dates are `'YYYY-MM-DD'` strings validated by the
   caller; bigint sums are read as bigint (cast `::bigint` in SQL where drizzle would return a string).

**Tests:** (integration)
- A scripted day on one restaurant: opening stock (meat 20 kg at `100n`/kg), a bank delivery (5 kg for
  `5000n`), three burger sales through the REAL `recordSale`, a waste entry, a count, and the reversal of
  the delivery. Then:
  - `reconciliation` → `differenceMinor 0n`, `driftCount 0`.
  - `currentStock` → each ingredient's cache equals its ledger totals; `perUnit` for meat per kg equals
    `valueAt(qty(1000000n), avgMicro)`.
  - `consumptionByDate` for the session's business date equals −Σ of the sales' movements.
  - `cogsByDate` equals the sum of the three `cost_of_goods_sold` entries, with the reversal's
    revaluation in the separate column.
  - `wasteByDate` and `countDifferences` return the entered rows.
- A deliberately corrupted cache (an `UPDATE ingredients SET on_hand_qty = on_hand_qty + 1` in the test on
  the owner connection) → that ingredient's `drift` is true and `driftCount` is 1.
- A sale made at 01:30 local time in a session opened the evening before appears under the previous
  business date (the session's), not the calendar date.

**Done when:** `pnpm test:integration src/lib/server/inventory/reports.integration.test.ts` passes.

**Watch out:** reports never call the costing rules to recompute a value; they read `cost_minor` and the
journal lines. No summary table, no materialized view (CLAUDE.md "Do NOT build").
