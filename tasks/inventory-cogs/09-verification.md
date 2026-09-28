# Phase 6 — e2e, documentation and the final gate (T-35 … T-37)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: every earlier phase.

Unit and integration tests shipped with the tasks that wrote the code; this phase holds only what spans
layers. One Playwright journey follows real stock from a delivery through a real till sale into the cost
of goods sold on the books and the menu's margin, using the pos-sales fixtures for everything on the
till side. The documentation task leaves CLAUDE.md and the module READMEs describing what now exists, so
the next plan (approvals, which will write `comp` and void-waste movements through this plan's writer)
starts from the truth. The final task runs every check and the greps that prove the two structural
rules of this plan: only `applyMovements` writes the ledger and the ingredient caches, and nothing
updates or deletes a posted record.

### T-35 — e2e: from delivery to cost of goods sold

**Needs:** T-28, T-29, T-30, T-33, T-34
**Files:**
- `e2e/inventory.spec.ts` — NEW
- `e2e/fixtures.ts` — EDIT (created on main, extended by tasks/pos-sales T-38; add three helpers beside
  the pos-sales ones: `createIngredient(page, { name, baseUnit, unit: { name, baseQtyPerUnit } })`,
  `setRecipe(page, { itemName, rows: { ingredientName, qty }[] })`, `recordDelivery(page, { supplier,
  paidBy, lines: { ingredientName, unitName, qty, total }[] })`)
**Spec:** 13 (inventory is deducted inside the payment transaction), 16 (COGS on every sale), 26
(inventory reports), 29 (automated tests where mistakes cost money)
**Invariants:** 4 (the deduction happens in the sale's transaction on the server), 6 (the ledger and the
caches agree), 3 (the COGS entry balances), 11 (reports by the session's business date)

**Do:**
1. One serial test, reusing the pos-sales fixtures for: registering a restaurant, completing settings
   (tax exclusive, 1000 bp, USD, an idle lock), creating the menu item "Burger" at 8.00, a cashier with a
   PIN, registering the device, opening a session and paying cash (`completeSettings`, `createMenuItem`,
   `openSession`, `addItem`, `payCash` — read `e2e/fixtures.ts` after pos-sales merges for their exact
   signatures).
2. As the owner: create "Meat" (base unit `g`, unit `kg` = 1000) and "Bun" (base unit `pcs`, unit `bag`
   = 12); set the Burger recipe to Meat 150 and Bun 1; record a bank delivery of 2 kg of meat for 11.00
   and 1 bag of buns for 6.00.
3. `/inventory` shows Meat `2,000.000` g (or the exact string `formatQty` produces, `2000.000`) and Bun
   `12.000` pcs.
4. On the till, sell two burgers for cash; wait for the status bar to say "0 unsynced".
5. `/inventory` shows Meat `1700.000` g and Bun `10.000` pcs.
6. Query the test database (the pattern `e2e/pos-offline.spec.ts` uses): exactly two `sale_consumption`
   movements whose `source_id` is the order's id — meat cost `-165` (value 1100 → `valueAt(1,700.000 g,
   550000)` = 935) and bun cost `-100` (value 600 → `valueAt(10.000, 50000000)` = 500) — and one
   `cost_of_goods_sold` journal entry of `265` for that order.
7. `/inventory/reports` for the session's business date shows cost of goods sold 2.65.
8. `/menu` shows the Burger's cost 1.33 (82.5 + 50 = 132.5, rounded once) and margin 6.67 (8.00 − 1.33).
9. `/inventory`'s reconciliation shows no difference (the drift alert is absent).

**Tests:** this task IS the test.

**Done when:** `pnpm build && pnpm test:e2e e2e/inventory.spec.ts` passes.

**Watch out:** the e2e runs against the production build, serially, and shares `matcami_test` with the
integration project under the advisory lock; wait for "0 unsynced" before asserting anything on the
server; never assert on timing.

### T-36 — Docs: CLAUDE.md layout and glossary, module READMEs

**Needs:** T-34
**Files:**
- `CLAUDE.md` — EDIT ("## Where code lives": the `inventory/` and `money/` lines; "## Domain glossary":
  new and refined entries; "## Tests that are mandatory, not optional (spec 29)": cite the files)
- `src/lib/server/inventory/README.md` — EDIT (created on main; a `## Files` section and the rules)
- `src/lib/server/accounting/README.md` — EDIT (created on main; the eight events and `postReversal`,
  if T-14 did not already add them — check and add only what is missing)
**Spec:** 15, 16, 19, 22, 24 (what the docs describe)
**Invariants:** 6 (the one-writer rule is written where the next reader will look), 2 (reversals only)

**Do:**
1. "Where code lives": `inventory/` lists `movements.ts` (the ONLY writer of `stock_movements` and the
   ingredient caches, ordered row locks), `consumption.ts`, `consume.ts` (inside the payment
   transaction; never throws for business reasons), `ingredients.ts`, `recipes.ts`, `purchases.ts`,
   `payments.ts`, `opening.ts`, `waste.ts`, `counts.ts`, `reports.ts`, `business-date.ts`. The `money/`
   line names `quantity.ts` (quantities as bigint thousandths) and `costing.ts` (the value-conserving
   rules, recipe cost, margin).
2. Glossary: add "Stock movement" (one line of the ledger; permanent; stock on hand is their sum),
   "Revaluation" (a zero-quantity movement that moves value when a delivery lands in zero or negative
   stock or a reversal leaves stock the average cannot describe; posts to 5000), "Opening stock" (stock
   on the shelf at go-live, `Dr 1200 / Cr 3000`), "Delivery (purchase)" (spec 19's purchase; paid now or
   on credit); refine "Base unit vs purchase unit" with `base_qty_per_unit`.
3. Mandatory tests list: cite `src/lib/money/quantity.test.ts`, `src/lib/money/costing.test.ts` (money,
   rounding, tax in both modes for the margin), `src/lib/server/accounting/posting-rules.test.ts` and
   `journal.integration.test.ts` (one test per new event; balance property with reversals),
   `src/lib/server/inventory/consume.integration.test.ts` (retries never duplicate consumption).
4. Inventory README: a `## Files` section with one line per file; the one-writer rule; the lock order;
   the never-throw rule of `consume.ts`; the reversal rules (payment before delivery; one reversal per
   entry; dated today).

**Tests:** `pnpm lint` (prettier checks Markdown).

**Done when:** `pnpm lint` passes, and every path named in CLAUDE.md's "Where code lives" for `inventory/`
and `money/` exists (`ls` each).

**Watch out:** append and refine; never reword a recorded decision (T-02 recorded them).

### T-37 — Final verification: every check, every test, no schema drift, the quality checklist

**Needs:** T-35, T-36
**Files:** none. This task runs commands and reports their output.
**Spec:** 29 (the mandatory test areas; migrations with a backup), 3 (permanent records), 22
**Invariants:** 1, 2, 3, 6, 7, 8 (the whole set this plan touches)

**Do:**
1. `nvm use && pnpm install --frozen-lockfile`.
2. `pnpm check`, `pnpm lint`, `pnpm test` (unit and integration), `pnpm build`, then `pnpm test:e2e` (the
   e2e AFTER `test:integration`, the order that leaves rows behind).
3. `pnpm exec drizzle-kit check` is clean, and `pnpm db:generate` creates NO new migration file (if it
   does, the schema and migrations 0013/0014 disagree — stop and report).
4. Greps that must print nothing outside test files:
   - `grep -rnE 'parseFloat|toFixed\(|Math\.(round|floor|ceil)|Number\(' src/lib/money
     src/lib/server/inventory src/lib/server/accounting --include='*.ts' | grep -v '\.test\.ts'`
     (`Number.isSafeInteger` in `consumption.ts` is the one permitted `Number.` use — review any hit by
     hand and report it).
   - Every insert into `stock_movements` is in `inventory/movements.ts`:
     `grep -rn 'insert(stockMovements)' src --include='*.ts' | grep -v 'inventory/movements.ts' | grep -v test`.
   - Every write of the three cache columns is in `inventory/movements.ts`:
     `grep -rnE 'onHandQty|inventoryValueMinor|avgUnitCostMicro' src/lib/server --include='*.ts' | grep -E
     'set\(|\.update' | grep -v 'inventory/movements.ts' | grep -v test`.
   - No update or delete of a posted record: `grep -rnE '\.(update|delete)\((stockMovements|purchaseLines|stockCountLines|wasteEntries|openingStockEntries|journalEntries|journalEntryLines)\)'
     src --include='*.ts' | grep -v test`.
5. Walk the task-format quality bar and report each item: a fresh session could run T-19 alone from the
   overview and its text; every money task names bigint minor units and every quantity task names `Qty`
   thousandths; every accounting task names its `Dr`/`Cr` codes; every new load and form action checks
   `admin.inventory`, `admin.purchases` or `admin.menu` and has a 403 test; each spec 29 area this plan
   touches has a MANDATORY test (money and rounding: T-09, T-10, T-11; tax in both modes: T-11; journal
   balance: T-14; one posting-rule test per event: T-13, T-20, T-21, T-23, T-24, T-25; retries never
   duplicate: T-19; permission tests: T-27–T-34); no invented path; no UPDATE or DELETE of a posted
   record; every assumption recorded by T-02.
6. Report every command's output, and list anything that failed with its fix or the reason it could not
   be fixed.

**Tests:** this task runs every test.

**Done when:** every command passes, every grep prints nothing (or only reviewed, justified hits), and the
checklist has no open item.
