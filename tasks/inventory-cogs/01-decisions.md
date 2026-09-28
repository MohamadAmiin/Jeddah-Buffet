# Phase 0 — preconditions and decisions (T-01, T-02)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: nothing; every later phase
> depends on this one.

This plan executes on a tree that does not exist at the time it was written: `main` after
`tasks/pos-sales/` has merged. Everything this plan builds on — the chart of accounts, the posting-rule
table, the journal writer with its commit-time balance trigger, the orders and sessions tables, and the
`consumeForSale` seam inside the payment transaction — comes from that plan. So the first task proves
the tree is what this plan assumes, and stops if it is not. The second task writes the thirteen
defaults the user accepted into CLAUDE.md before any schema encodes them: CLAUDE.md's open-decisions
rule forbids baking an answer into a table or the chart of accounts silently, and a decision that lives
only in a plan file is invisible to the next session.

### T-01 — Verify pos-sales is merged and every inherited contract is as this plan expects

**Needs:** –
**Files:** none. This task runs commands and reports their output; it creates and edits nothing.
**Spec:** 29 ("database changes go through Drizzle migrations"; a backup before migrating), 13 (the
payment transaction whose "Deduct Inventory" step this plan fills), 24 (the posting-rule table this
plan extends)
**Invariants:** 2 (posted records are permanent — a migration that has run is never hand-edited or
renumbered), 3 (journal entries balance in the database — the trigger must already exist), 4 (one
all-or-nothing transaction at payment — the seam must sit inside it)

**Do:**
1. On `main`: `git log --oneline -1`. Confirm tasks/pos-sales has merged: `gh pr list --state merged
   --search pos-sales` or a merge commit of `feat/pos-sales` in `git log --oneline | head -20`. If it
   has not merged, STOP and ask the user. Never branch this plan from `feat/pos-sales` and never run it
   in the pos-sales worktree.
2. Migrations: `ls src/lib/server/db/migrations/*.sql` must list `0000` through `0012`, with exactly one
   `0011_*.sql` and the file `0012_journal_guards.sql`; `node -e "const j=require('./src/lib/server/db/migrations/meta/_journal.json');console.log(j.entries.length, j.entries.at(-1).tag)"`
   must print `13 0012_journal_guards`. Record the 0011 file's name (at plan time: `0011_jazzy_plazm.sql`).
3. Accounting contracts, each grep printing the expected line:
   - `grep -n "POSTING_EVENTS" -A8 src/lib/server/accounting/posting-rules.ts` shows exactly
     `cash_sale`, `card_sale`, `mobile_sale`, `cost_of_goods_sold`, `cash_shortage_at_close`,
     `cash_overage_at_close`.
   - `grep -n "sourceType" src/lib/server/accounting/journal.ts` shows `'order' | 'pos_session'`.
   - `grep -nE "^export (async )?function (postEntry|entryLines)" src/lib/server/accounting/journal.ts`
     prints both.
   - `grep -nE "^export (const CHART|async function (ensureChart|accountIdByCode))" src/lib/server/accounting/chart.ts`
     prints all three.
   - `grep -nE "journal_entries_event_valid|journal_entries_source_type_valid|reverses_entry_id" src/lib/server/db/schema/accounting.ts`
     prints all three.
   - `grep -n "posted_record_append_only" src/lib/server/db/migrations/0012_journal_guards.sql` prints the
     function and its four triggers.
4. The seam: `grep -n "consumeForSale\|cogsMinor" src/lib/server/inventory/consume.ts
   src/lib/server/orders/pay.ts`. Expected: `consume.ts` returns `{ movements: [], cogsMinor: minor(0n) }`;
   `pay.ts` calls `consumeForSale(tx, …)` after the invoice row is inserted and posts `cogsLines(`
   only inside `if (cogsMinor > 0n)`. Record both line numbers (at plan time in the pos-sales build:
   `pay.ts` lines 130 and 155).
5. The tables consumption and counts read: `grep -nE "paidAt|posSessionId" src/lib/server/db/schema/orders.ts`,
   `grep -nE "businessDate|status" src/lib/server/db/schema/pos-sessions.ts`, `grep -nE "kind|status|resolvedAt"
   src/lib/server/db/schema/pos-sync.ts` — each must print its columns.
6. The pos-sales tests that pin the six-event world (T-07, T-08 and T-13 of this plan rewrite them):
   `grep -n "i % 6\|'purchase'\|%_append_only" src/lib/server/accounting/*.test.ts
   src/lib/server/db/schema-guards/constraints.integration.test.ts`. Record every hit with its line.
7. `pnpm exec drizzle-kit check` is clean, and `pnpm test:integration` passes on the unmodified tree.
8. If any expectation in steps 2–5 differs, STOP and report exactly which contract differs and what the
   tree has instead. `00-overview.md` ("Workspace state" and "Shared contracts") must be corrected by
   the user or a planning session before T-03 runs.

**Tests:** none; this is a verification task.

**Done when:** every step printed its expected value, and the report names the 0011 file, the two
`pay.ts` line numbers and every pinned test line from step 6.

**Watch out:** this plan's two migrations must be GENERATED on this tree. Drizzle's migrator applies
entries by their journal `when` inside one transaction and silently skips any entry older than the
newest one already applied, so a migration generated elsewhere and merged later can be skipped forever
on a database migrated in the other order. Never hand-edit, renumber or re-date a migration that has run.

### T-02 — Record the thirteen inventory decisions in CLAUDE.md

**Needs:** T-01
**Files:**
- `CLAUDE.md` — EDIT (three places: append bullets at the end of "## Decisions already made (NOT open —
  do not re-litigate)"; in "## Open decisions — UNRESOLVED (spec 33)" amend row 7 "Inventory costing
  method → weighted average."; in "## Where code lives" extend the `inventory/` line of the tree)
**Spec:** 33 (decision 7, weighted average), 24 (the posting table; opening stock has no row), 16
(weighted average updated on every purchase), 15 (units, recipes, counts, negative stock), 19
(purchases, Accounts Payable), 22 (reversing entries)
**Invariants:** 6 (inventory is a ledger — the one-writer rule is recorded here), 2 (posted records are
permanent — corrections are reversals), 1 (money is integer minor units; the micro-cost column is the
recorded exception to the `_minor` naming rule)

**Do:**
1. Append one bullet per assumption in the overview's Assumptions table, in table order. Each bullet
   starts with a bold one-line name, is dated 2026-09-28, and carries this provenance sentence
   verbatim: "Presented with a default on 2026-09-28; the user approved the plan with the defaults
   ("ok , go and generate the task files"); a reversal re-plans the tasks named in
   tasks/inventory-cogs/00-overview.md." The substance, one bullet each:
   1. **Opening stock.** An opening-stock entry per ingredient (quantity in a purchase unit and a cost
      per unit) posts `Dr 1200 Inventory / Cr 3000 Owner's Capital` under the event `opening_stock`,
      and is allowed only while the ingredient has no stock movement at all. This is a recorded
      amendment to spec 24, which has no row for stock the owner contributes; spec 24 itself is not
      edited.
   2. **Revaluation.** When a delivery lands in zero or negative stock, or a reversal leaves stock in a
      state the average cannot describe, the difference is a `revaluation` stock movement and an
      `inventory_revaluation` entry against 5000 Cost of Goods Sold (the alternative, 5100, was
      presented and not chosen).
   3. **Cash deliveries.** A delivery "paid by cash" on the dashboard means cash kept outside the till;
      it never enters a POS session's expected cash. Paying from the till drawer is a POS pay-out,
      which a later plan builds.
   4. **When a count may post.** Only when no `pos_sessions` row of the restaurant has `status = 'open'`
      and no `pos_sync_ops` row with `kind = 'sale.complete'` has `status = 'unrecorded'` and
      `resolved_at` null; the page says why it is waiting.
   5. **Reversals.** Delivery reversal and supplier-payment reversal exist, need `admin.purchases`
      (owner only) and a reason of 3–200 characters; a delivery with an unreversed payment cannot be
      reversed until the payment is.
   6. **Average-cost precision.** `ingredients.avg_unit_cost_micro` is a bigint of micro minor units
      per base unit (minor × 1,000,000); $5.50 per kg with a base unit of grams is `550000`. It is the
      first entry in the schema guard's `MONEY_NAME_EXEMPT`, because a per-gram cost is a fraction of a
      cent and cannot be a `_minor` integer.
   7. **Units.** One base unit per ingredient as free text (1–16 characters); purchase units per
      ingredient with a `base_qty_per_unit`; no global units table.
   8. **Recipes.** Edited on `/inventory/recipes`; `/menu` shows each item's cost and margin
      read-only.
   9. **A reversal's business date.** The day the reversal is made, in the restaurant's time zone,
      never the original's date; last month's reports stay as they were.
   10. **Archiving an ingredient.** Refused while any recipe line of a non-archived menu item or
       modifier references it.
   11. **Modifier deltas.** Per order line and per ingredient, the item's quantity plus the chosen
       modifiers' deltas is clamped at zero before it is multiplied by the line quantity.
   12. **Offline sales.** Costed when they reach the server, at the average current then; the
       movement's `occurred_at` is the order's `paid_at` and its business date is the POS session's.
   13. **No cache rebuild.** There is no action that rebuilds the cached ingredient totals from the
       ledger; `/inventory` shows a tripwire when they differ, and a fix is decided then.
2. Append two more bullets:
   - **The costing rules conserve value.** Cite "Shared contracts → Costing" in
     tasks/inventory-cogs/00-overview.md: an at-average movement is costed as the change in stock value
     (`valueAt(qty', avg)`, which is zero exactly when the quantity is zero), the average is recomputed
     only from a positive quantity and a positive value, and three CHECKs on `ingredients` enforce the
     results (`avg_unit_cost_micro >= 0`; quantity zero ⇒ value zero; quantity positive ⇒ value not
     negative).
   - **One ledger writer.** `applyMovements` in `src/lib/server/inventory/movements.ts` is the only code
     that inserts into `stock_movements` or writes `ingredients.on_hand_qty`,
     `inventory_value_minor` or `avg_unit_cost_micro`; it locks every affected ingredient row in ONE
     `select … order by id for update` before reading them, which is what prevents lost updates and
     deadlocks between a syncing sale and a dashboard write.
3. Open-decisions row 7: change it to "7. Inventory costing method → weighted average — implemented by
   tasks/inventory-cogs (2026-09-28), representation and rules recorded under Decisions already made."
   Keep the row: CLAUDE.md deletes a row only when the decision is fully answered, and the table's
   other rows are untouched.
4. "Where code lives": extend the `inventory/` line to read, in substance: "stock movements (the ONE
   writer, movements.ts), recipes + unit conversion, weighted-average costing, deliveries and supplier
   payments, waste, counts, reports".

**Tests:** `pnpm lint` passes (prettier checks Markdown formatting of CLAUDE.md).

**Done when:** `grep -c 'inventory-cogs' CLAUDE.md` prints 16 or more, `grep -n 'movements.ts'
CLAUDE.md` prints at least two lines, and `pnpm lint` passes.

**Watch out:** append only. Never reword, reorder or delete an existing decision, and never edit
`docs/spec.md` — "the spec outranks this file", so an amendment is recorded here as a decision, not
written into the spec. Keep the invariants section untouched: invariant 6 already says what this plan
implements.
