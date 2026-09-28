# Phase 1 — schema and migrations (T-03 … T-08)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: Phase 0 (T-01, T-02).

Every table in this phase follows the house schema idiom that `src/lib/server/db/schema/menu.ts` and
`roles.ts` on main and pos-sales' `accounting.ts` already use. Every value set is a `text` column with a
NAMED CHECK, never a Postgres enum (the repo already paid for one enum rebuild, migration 0010). Every
table carries `restaurant_id uuid NOT NULL → restaurants.id ON DELETE RESTRICT`. Money is
`bigint(…, { mode: 'bigint' })` named `*_minor`. Ingredient quantities are
`numeric('…', { precision: 12, scale: 3 })` named `*_qty` — the schema guard's one permitted fixed-point
type — and pg returns them as strings, which the code parses once with `parseQty` (T-09). Timestamps are
`timestamp(…, { withTimezone: true })`. Inside every aggregate, and from every table to `ingredients`,
references are COMPOSITE `(restaurant_id, id)` foreign keys, and each composite target is a `unique()`
CONSTRAINT declared inside its own CREATE TABLE — never a `uniqueIndex()`, because drizzle-kit emits
every CREATE INDEX after all foreign keys and the FK would fail with 42830 (menu.ts's header explains
it). `modifiers` has no composite unique on main, so `recipe_lines.modifier_id` is a single-column FK,
exactly as pos-sales' `order_line_modifiers.modifier_id`. References to `users` and `journal_entries`
are single-column. Schema files cannot import `$lib` (drizzle-kit loads them outside Vite), so CHECK
literals are spelled out here and pinned to their TypeScript constants in
`constraints.integration.test.ts`. Every foreign-key and query column gets a named index. All foreign
keys are `onDelete('restrict')`.

### T-03 — Schema: `ingredients`, `ingredient_purchase_units`, `recipe_lines`

**Needs:** T-02
**Files:**
- `src/lib/server/db/schema/inventory.ts` — NEW
**Spec:** 15 (ingredients, base units, purchase units and conversions, recipes, modifiers affect
recipes), 16 (weighted average per ingredient), 3 ("a cached quantity may exist for speed, but the
movements are the truth"), 17 (quantities use fixed-precision decimals, e.g. numeric(12,3))
**Invariants:** 6 (inventory is a ledger — the three cache columns are written ONLY by `applyMovements`
with the movement that changed them), 1 (money is integer minor units in bigint; quantities are
numeric(12,3), the one exception), 2 (recipe lines are configuration, not posted records)

**Do:**
1. Create the file with the house helper pattern (define local `tenant()`, `createdAt()`,
   `updatedAt()`, `archivedAt()` helpers as menu.ts does; do not import menu.ts's private ones) and a
   `qtyColumn(name)` helper returning `numeric(name, { precision: 12, scale: 3 })`.
2. `ingredients`:
   - `id uuid PK defaultRandom()`, `restaurant_id` (tenant), `name text NOT NULL`,
     `base_unit text NOT NULL`, `on_hand_qty numeric(12,3) NOT NULL DEFAULT '0'`,
     `inventory_value_minor bigint NOT NULL DEFAULT 0`, `avg_unit_cost_micro bigint NOT NULL DEFAULT 0`,
     `archived_at timestamptz NULL`, `created_at`, `updated_at`.
   - `unique('ingredients_id_restaurant_unique').on(id, restaurantId)` — the composite FK target.
   - `uniqueIndex('ingredients_name_unique').on(restaurantId, sql\`lower(${name})\`).where(sql\`${archivedAt} is null\`)`.
   - `index('ingredients_restaurant_id_idx').on(restaurantId)`.
   - CHECK `ingredients_name_length`: `char_length(btrim(name)) between 1 and 80`.
   - CHECK `ingredients_base_unit_length`: `char_length(btrim(base_unit)) between 1 and 16`.
   - CHECK `ingredients_avg_non_negative`: `avg_unit_cost_micro >= 0`.
   - CHECK `ingredients_zero_qty_zero_value`: `on_hand_qty <> 0 or inventory_value_minor = 0`.
   - CHECK `ingredients_positive_qty_non_negative_value`: `on_hand_qty <= 0 or inventory_value_minor >= 0`.
3. `ingredient_purchase_units`:
   - `id uuid PK`, `restaurant_id`, `ingredient_id uuid NOT NULL`, `name text NOT NULL`,
     `base_qty_per_unit numeric(12,3) NOT NULL`, `archived_at`, `created_at`.
   - composite FK `ingredient_purchase_units_ingredient_fk` `(restaurant_id, ingredient_id)` →
     `ingredients (restaurant_id, id)`.
   - `unique('ingredient_purchase_units_id_restaurant_unique').on(id, restaurantId)`.
   - `uniqueIndex('ingredient_purchase_units_name_unique').on(ingredientId, sql\`lower(${name})\`).where(archived_at is null)`.
   - `index('ingredient_purchase_units_ingredient_idx').on(ingredientId)`.
   - CHECK `ingredient_purchase_units_name_length`: `char_length(btrim(name)) between 1 and 24`.
   - CHECK `ingredient_purchase_units_factor_positive`: `base_qty_per_unit > 0`.
4. `recipe_lines`:
   - `id uuid PK`, `restaurant_id`, `menu_item_id uuid NULL`, `modifier_id uuid NULL`,
     `ingredient_id uuid NOT NULL`, `qty numeric(12,3) NOT NULL`, `created_at`, `updated_at`.
   - composite FK `recipe_lines_menu_item_fk` `(restaurant_id, menu_item_id)` →
     `menu_items (restaurant_id, id)` (its target constraint `menu_items_id_restaurant_unique` exists on
     main; open menu.ts to confirm the name before writing).
   - single-column FK `modifier_id` → `modifiers.id` (restrict).
   - composite FK `recipe_lines_ingredient_fk` `(restaurant_id, ingredient_id)` → `ingredients`.
   - CHECK `recipe_lines_one_owner`: `(menu_item_id is null) <> (modifier_id is null)`.
   - CHECK `recipe_lines_qty_sign`: `(menu_item_id is not null and qty > 0) or (modifier_id is not null
     and qty <> 0)`.
   - `uniqueIndex('recipe_lines_item_ingredient_unique').on(menuItemId, ingredientId).where(menu_item_id is not null)`.
   - `uniqueIndex('recipe_lines_modifier_ingredient_unique').on(modifierId, ingredientId).where(modifier_id is not null)`.
   - `index('recipe_lines_ingredient_idx').on(ingredientId)`.
5. The file's header comment says, in substance: spec 15's model (base unit, purchase units, recipes in
   base units, modifiers change the recipe); the three cache columns are written ONLY by
   `applyMovements` (T-16) under a row lock, inside the transaction that inserts the movement that
   changed them, and are never the truth (invariant 6); `avg_unit_cost_micro` is micro minor units per
   base unit — spec 16's $5.50 per kg with a base unit of grams is 0.55 cents per gram, stored as
   `550000`; the three value CHECKs are the costing invariants of the overview; the zero defaults answer
   no open decision (a new ingredient has no stock); recipe lines are configuration (they are replaced,
   not reversed) and the POS never sees them (the menu snapshot carries no recipe).

**Tests:** none in this task beyond `pnpm check`; the constraints are proven in T-07.

**Done when:** `pnpm check` passes with the new file present.

**Watch out:** do not add a recipe or cost column to `menu_items` — menu.ts's header forbids it: cost
is the ledger's weighted average, never a number typed on a menu row. Do not declare the composite FK
target with `uniqueIndex`.

### T-04 — Schema: `stock_movements`, `opening_stock_entries`, `waste_entries`, `stock_counts`, `stock_count_lines`

**Needs:** T-03
**Files:**
- `src/lib/server/db/schema/inventory.ts` — EXTEND (created by T-03; add the five tables after
  `recipe_lines`. Do not rewrite the file)
**Spec:** 15 (movement types and directions; stock counts; negative stock flagged), 3 ("Stock on hand is
the sum of stock movements"; permanent records), 24 (waste and count rows), 17 (business day and time)
**Invariants:** 6 (inventory is a ledger), 2 (movements, waste entries, count lines and opening-stock
entries are permanent — append-only by T-08), 11 (every movement carries a business date), 1 (costs
bigint minor units; quantities numeric(12,3))

**Do:**
1. `stock_movements`:
   - `id bigint(mode 'bigint') generatedAlwaysAsIdentity PK`, `restaurant_id`, `ingredient_id uuid NOT NULL`,
     `movement_type text NOT NULL`, `qty numeric(12,3) NOT NULL`, `cost_minor bigint NOT NULL`,
     `source_type text NOT NULL`, `source_id uuid NOT NULL`, `business_date date NOT NULL` (mode
     'string'), `occurred_at timestamptz NOT NULL`, `recorded_by_user_id uuid NULL → users.id`,
     `created_at`.
   - composite FK `stock_movements_ingredient_fk` → `ingredients`.
   - CHECK `stock_movements_type_valid`: `movement_type in ('purchase', 'purchase_reversal',
     'opening_stock', 'sale_consumption', 'waste', 'count_adjustment', 'comp', 'revaluation')`.
   - CHECK `stock_movements_source_valid`: `source_type in ('purchase', 'order', 'waste_entry',
     'stock_count', 'opening_stock')`.
   - CHECK `stock_movements_sign_by_type`: `(movement_type in ('purchase', 'opening_stock') and qty > 0
     and cost_minor >= 0) or (movement_type in ('purchase_reversal', 'sale_consumption', 'waste',
     'comp') and qty < 0 and cost_minor <= 0) or (movement_type = 'count_adjustment' and qty <> 0) or
     (movement_type = 'revaluation' and qty = 0 and cost_minor <> 0)`.
   - `index('stock_movements_ingredient_time_idx').on(restaurantId, ingredientId, occurredAt)`,
     `index('stock_movements_restaurant_business_date_idx').on(restaurantId, businessDate)`,
     `index('stock_movements_source_idx').on(sourceType, sourceId)`.
   - No FK on `source_id`: it points at a purchase, an order, a waste entry, a count or an opening-stock
     entry depending on `source_type`; the pair is indexed instead.
2. `opening_stock_entries`:
   - `id uuid PK` (generated in code, no default needed but `defaultRandom()` is harmless),
     `restaurant_id`, `ingredient_id uuid NOT NULL`, `purchase_unit_name text NOT NULL`,
     `unit_qty numeric(12,3) NOT NULL`, `base_qty_per_unit numeric(12,3) NOT NULL`,
     `base_qty numeric(12,3) NOT NULL`, `unit_cost_minor bigint NOT NULL`, `value_minor bigint NOT NULL`,
     `business_date date NOT NULL`, `recorded_by_user_id uuid NOT NULL → users.id`, `created_at`.
   - composite FK → `ingredients`; `uniqueIndex('opening_stock_entries_ingredient_unique').on(ingredientId)`.
   - CHECKs: `unit_qty > 0`, `base_qty_per_unit > 0`, `base_qty > 0`, `unit_cost_minor >= 0`,
     `value_minor >= 0` (one named CHECK `opening_stock_entries_amounts_valid` holding all five).
3. `waste_entries`:
   - `id uuid PK`, `restaurant_id`, `ingredient_id uuid NOT NULL`, `qty numeric(12,3) NOT NULL`,
     `reason text NOT NULL`, `note text NULL`, `business_date date NOT NULL`,
     `recorded_by_user_id uuid NOT NULL → users.id`, `created_at`.
   - composite FK → `ingredients`; `index('waste_entries_restaurant_business_date_idx').on(restaurantId, businessDate)`.
   - CHECK `waste_entries_qty_positive`: `qty > 0`.
   - CHECK `waste_entries_reason_valid`: `reason in ('spoilage', 'preparation_error', 'breakage', 'other')`.
   - CHECK `waste_entries_note_for_other`: `reason <> 'other' or (note is not null and
     char_length(btrim(note)) between 3 and 200)`.
4. `stock_counts`:
   - `id uuid PK`, `restaurant_id`, `business_date date NOT NULL`, `counted_at timestamptz NOT NULL`,
     `note text NULL`, `recorded_by_user_id uuid NOT NULL → users.id`, `created_at`.
   - `unique('stock_counts_id_restaurant_unique').on(id, restaurantId)`;
     `index('stock_counts_restaurant_business_date_idx').on(restaurantId, businessDate)`.
5. `stock_count_lines`:
   - `id uuid PK`, `restaurant_id`, `count_id uuid NOT NULL`, `ingredient_id uuid NOT NULL`,
     `system_qty numeric(12,3) NOT NULL`, `counted_qty numeric(12,3) NOT NULL`,
     `difference_qty numeric(12,3) NOT NULL`, `cost_minor bigint NOT NULL` (signed: the value of the
     adjustment; negative for a shortfall), `created_at`.
   - composite FKs `stock_count_lines_count_fk` → `stock_counts` and `stock_count_lines_ingredient_fk` →
     `ingredients`; `uniqueIndex('stock_count_lines_count_ingredient_unique').on(countId, ingredientId)`.
   - CHECK `stock_count_lines_counted_non_negative`: `counted_qty >= 0`.
   - CHECK `stock_count_lines_difference`: `difference_qty = counted_qty - system_qty`.
6. Comments: the ledger is the truth (spec 3, invariant 6); `stock_movements`, `waste_entries`,
   `stock_count_lines` and `opening_stock_entries` become append-only in T-08; the sign rules by type;
   why a `revaluation` row carries `qty = 0` (it moves value, not goods: the gap between the old average
   and a late delivery's price on goods already sold); why `source_id` has no FK; `business_date` is
   never derived from `created_at` (invariant 11).

**Tests:** none beyond `pnpm check`; T-07 proves every CHECK.

**Done when:** `pnpm check` passes.

**Watch out:** `stock_movements.id` is a bigint identity (like `audit_log.id`), so ids compare as
`1n`, not `1`, in tests. A `sale_consumption` row with `qty = 0` is rejected by the sign CHECK: the
consumption code must skip zero totals (T-12, T-19), never write them.

### T-05 — Schema: `purchases`, `purchase_lines`, `supplier_payments`

**Needs:** T-03
**Files:**
- `src/lib/server/db/schema/purchases.ts` — NEW
**Spec:** 19 (purchases in purchase units converted to base units; paid immediately → Cash or Bank; on
credit → Accounts Payable; supplier paid later; "The Accounts Payable account is part of the MVP. Full
supplier management … stays in Later"), 22 (a mistake is fixed with a reversing entry), 24 (purchase
and supplier-payment rows)
**Invariants:** 1 (amounts bigint minor units), 2 (lines are permanent; headers carry once-written ids
and a reversal stamp, never an edit of the amounts), 6 (a delivery's stock arrives only through
movements, never through these tables)

**Do:**
1. `purchases`:
   - `id uuid PK` (generated in code), `restaurant_id`, `supplier_name text NOT NULL`,
     `business_date date NOT NULL`, `paid_by text NOT NULL`, `total_minor bigint NOT NULL`,
     `note text NULL`, `recorded_by_user_id uuid NOT NULL → users.id`,
     `recorded_at timestamptz NOT NULL defaultNow()`, `journal_entry_id uuid NULL → journal_entries.id`,
     `reversed_at timestamptz NULL`, `reversed_by_user_id uuid NULL → users.id`,
     `reversal_reason text NULL`, `reversal_entry_id uuid NULL → journal_entries.id`.
   - CHECK `purchases_supplier_name_length`: `char_length(btrim(supplier_name)) between 1 and 120`.
   - CHECK `purchases_paid_by_valid`: `paid_by in ('cash', 'bank', 'credit')`.
   - CHECK `purchases_total_non_negative`: `total_minor >= 0`.
   - CHECK `purchases_reversal_fields`: `(reversed_at is null) = (reversed_by_user_id is null) and
     (reversed_at is null) = (reversal_reason is null) and (reversal_reason is null or
     char_length(btrim(reversal_reason)) between 3 and 200)`.
   - `unique('purchases_id_restaurant_unique').on(id, restaurantId)`;
     `index('purchases_restaurant_business_date_idx').on(restaurantId, businessDate)`;
     `index('purchases_restaurant_recorded_idx').on(restaurantId, desc(recordedAt))`.
   - Import `journalEntries` from `./accounting` (created by tasks/pos-sales T-04) for the two
     single-column FKs.
2. `purchase_lines`:
   - `id uuid PK`, `restaurant_id`, `purchase_id uuid NOT NULL`, `line_no integer NOT NULL`,
     `ingredient_id uuid NOT NULL`, `purchase_unit_name text NOT NULL` (snapshot),
     `unit_qty numeric(12,3) NOT NULL`, `base_qty_per_unit numeric(12,3) NOT NULL` (snapshot),
     `base_qty numeric(12,3) NOT NULL`, `line_cost_minor bigint NOT NULL`, `created_at`.
   - composite FKs `purchase_lines_purchase_fk` → `purchases` and `purchase_lines_ingredient_fk` →
     `ingredients` (import from `./inventory`).
   - `unique('purchase_lines_purchase_line_no_unique').on(purchaseId, lineNo)`;
     `index('purchase_lines_ingredient_idx').on(ingredientId)`.
   - one CHECK `purchase_lines_amounts_valid`: `unit_qty > 0 and base_qty_per_unit > 0 and base_qty > 0
     and line_cost_minor >= 0 and line_no >= 1`.
3. `supplier_payments`:
   - `id uuid PK` (generated in code), `restaurant_id`, `purchase_id uuid NOT NULL`,
     `amount_minor bigint NOT NULL`, `paid_from text NOT NULL`, `business_date date NOT NULL`,
     `recorded_by_user_id uuid NOT NULL → users.id`, `recorded_at timestamptz NOT NULL defaultNow()`,
     `journal_entry_id uuid NULL → journal_entries.id`, `reversed_at`, `reversed_by_user_id`,
     `reversal_reason`, `reversal_entry_id` (as on purchases).
   - composite FK `supplier_payments_purchase_fk` → `purchases`;
     `index('supplier_payments_purchase_idx').on(purchaseId)`.
   - CHECK `supplier_payments_amount_positive`: `amount_minor > 0`.
   - CHECK `supplier_payments_paid_from_valid`: `paid_from in ('cash', 'bank')`.
   - CHECK `supplier_payments_reversal_fields`: the same shape as `purchases_reversal_fields`.
4. Header comment: spec 19; Accounts Payable (2000) is in the MVP, supplier management is not, so the
   supplier is a free-text name (assumption 7's sibling decision, recorded in the overview's scope);
   "cash" means cash kept outside the till (assumption 3); the header's `journal_entry_id`,
   `reversal_*` columns are written once each and nothing else on the header ever changes; lines are
   append-only (T-08).

**Tests:** none beyond `pnpm check`; T-07 proves the constraints.

**Done when:** `pnpm check` passes.

**Watch out:** `purchases` itself is NOT append-only (its journal id and reversal stamp are written
after insert), so its amounts are protected by code, not a trigger: nothing may ever issue an UPDATE
that touches `total_minor`, `paid_by` or `business_date`.

### T-06 — Widen the journal CHECKs and add the one-reversal-per-entry index

**Needs:** T-02
**Files:**
- `src/lib/server/db/schema/accounting.ts` — EDIT (created by tasks/pos-sales T-04; in the
  `journalEntries` table's extra-config array, the two `check(...)` calls named
  `journal_entries_event_valid` and `journal_entries_source_type_valid`, and the index list beside them)
**Spec:** 22 ("A mistake is fixed with a reversing entry plus a correct new entry"), 24 (the new rows:
purchase paid, purchase on credit, supplier paid, waste, stock count shortfall and surplus)
**Invariants:** 3 (journal entries balance in the database — unaffected, the balance trigger stays), 2
(posted entries are never edited; a reversal is a new entry, and one per original)

**Do:**
1. Replace the event list of `journal_entries_event_valid` with the fourteen `POSTING_EVENTS` in the
   overview's order: `'cash_sale', 'card_sale', 'mobile_sale', 'cost_of_goods_sold',
   'cash_shortage_at_close', 'cash_overage_at_close', 'purchase_paid', 'purchase_on_credit',
   'supplier_paid', 'waste', 'stock_count_shortfall', 'stock_count_surplus', 'inventory_revaluation',
   'opening_stock'`.
2. Replace the list of `journal_entries_source_type_valid` with `'order', 'pos_session', 'purchase',
   'supplier_payment', 'waste_entry', 'stock_count', 'opening_stock'`.
3. Add `uniqueIndex('journal_entries_reverses_entry_unique').on(t.reversesEntryId).where(sql\`${t.reversesEntryId} is not null\`)`.
4. Update the comment on `reverses_entry_id`: it is written by `postReversal` (T-14), and the partial
   unique index allows exactly one reversal per entry, so a double-submitted reversal fails with 23505.

**Tests:** none beyond `pnpm check`; T-07 proves the widened CHECKs and the index.

**Done when:** `pnpm check` passes.

**Watch out:** drizzle-kit emits `DROP CONSTRAINT` + `ADD CONSTRAINT` for a changed CHECK; the ADD
validates every existing row, and every pos-sales row keeps a value that is still in the list. Keep the
literal spelling identical to T-13's `POSTING_EVENTS` and `JOURNAL_SOURCE_TYPES`: T-07 pins them together.

### T-07 — Generate migration 0013; the schema guards, the exemption, the reset list and the constraint tests

**Needs:** T-03, T-04, T-05, T-06
**Files:**
- `src/lib/server/db/migrations/0013_<generated>.sql` and `meta/0013_snapshot.json` — NEW (generated by
  drizzle-kit; never edited after it runs)
- `src/lib/server/db/migrations/meta/_journal.json` — EDIT (by drizzle-kit only, never by hand)
- `src/lib/server/db/schema-guards/schema.test.ts` — EDIT (the `modules` spread: add the inventory and
  purchases schema modules; `IMPORTED_SCHEMA_FILES`: add `'inventory.ts'` and `'purchases.ts'` in
  alphabetical order; `MONEY_NAME_EXEMPT`: add the first entry)
- `src/lib/server/db/test/reset.ts` — EDIT (the `TABLES` array and its comment list)
- `src/lib/server/db/schema-guards/constraints.integration.test.ts` — EDIT (created on main, extended by
  tasks/pos-sales T-08; add describe blocks; rewrite the two pinned pos-sales assertions)
**Spec:** 29 (schema changes through Drizzle migrations; a backup before migrating), 3 (integrity rules),
17 (money integers; quantities numeric(12,3))
**Invariants:** 1 (money bigint `_minor`; the one recorded exemption), 2 (a migration that has run is
never hand-edited), 6 (the value CHECKs), 3 (the journal CHECKs still admit every balanced entry)

**Do:**
1. `pnpm db:generate`. Open the new SQL file and confirm: eleven `CREATE TABLE` statements with their
   CHECK and UNIQUE constraints inline; every composite target constraint declared inside its own CREATE
   TABLE before any FK that uses it; `DROP CONSTRAINT` + `ADD CONSTRAINT` for the two journal CHECKs;
   `CREATE UNIQUE INDEX "journal_entries_reverses_entry_unique" … WHERE "reverses_entry_id" IS NOT NULL`.
   Record the generated number and name; if main moved and the number is not 0013, use what drizzle-kit
   wrote and note it — never renumber.
2. `pnpm db:migrate` on the dev database (the backup runs first automatically).
3. `schema.test.ts`: import `* as inventorySchema from '../schema/inventory'` and
   `* as purchasesSchema from '../schema/purchases'` into `modules`; add the two file names to
   `IMPORTED_SCHEMA_FILES`; add to `MONEY_NAME_EXEMPT`:
   `'ingredients.avg_unit_cost_micro': 'weighted-average unit cost in MICRO minor units per base unit (minor × 1,000,000): a per-gram cost is a fraction of a cent, so it cannot be a _minor integer; a plan decision (tasks/inventory-cogs assumption 6), never a convenience'`.
   Run the guard; every other new column must pass the existing rules unchanged (fix the schema, never
   the guard).
4. `reset.ts`: add, child-first, `'stock_count_lines', 'stock_counts', 'waste_entries',
   'opening_stock_entries', 'stock_movements', 'supplier_payments', 'purchase_lines', 'purchases',
   'recipe_lines', 'ingredient_purchase_units', 'ingredients'`, placed before the journal tables and
   before `menu_items`, `modifiers` and `users`; update the comment list above `TABLES`.
5. `constraints.integration.test.ts`: first rewrite the pinned pos-sales assertions T-01 recorded — the
   example `source_type` that must be rejected becomes `'expense'` (`'purchase'` is now valid), and the
   deep-equal of the event list becomes the fourteen events of T-06. Then add a
   `describe('inventory constraints (inventory-cogs T-07)')` block, each case asserting the SQLSTATE and
   the constraint name, following the file's existing helpers:
   - `avg_unit_cost_micro = -1` → 23514 `ingredients_avg_non_negative`;
   - `on_hand_qty = '0.000'` with `inventory_value_minor = 5` → 23514 `ingredients_zero_qty_zero_value`;
   - `on_hand_qty = '1.000'` with `inventory_value_minor = -1` → 23514
     `ingredients_positive_qty_non_negative_value`;
   - two live ingredients `'Meat'` and `'meat'` → 23505 `ingredients_name_unique`; archiving the first
     frees the name;
   - a recipe line with both owners, and one with neither → 23514 `recipe_lines_one_owner`;
   - an item recipe line with `qty = '-1.000'` → 23514 `recipe_lines_qty_sign`; a modifier line with
     `qty = '-30.000'` is accepted;
   - a `sale_consumption` movement with `qty = '1.000'` → 23514 `stock_movements_sign_by_type`; a
     `revaluation` with `qty = '1.000'` → the same; a `revaluation` with `qty = '0.000'` and
     `cost_minor = 5` is accepted;
   - a waste entry with reason `'other'` and no note → 23514 `waste_entries_note_for_other`;
   - a count line whose difference is not counted − system → 23514 `stock_count_lines_difference`;
   - a second opening-stock entry for one ingredient → 23505 `opening_stock_entries_ingredient_unique`;
   - a purchase with `reversed_at` set and no reason → 23514 `purchases_reversal_fields`;
   - two journal entries whose `reverses_entry_id` is the same entry → 23505
     `journal_entries_reverses_entry_unique` (insert inside a transaction that also inserts balanced
     lines, so the deferred balance trigger passes and the unique index is what fails);
   - event `'purchase_paid'` with `source_type 'purchase'` is accepted; `source_type 'expense'` is
     rejected with `journal_entries_source_type_valid`.
   Pin each CHECK list to its constant: spell `MOVEMENT_TYPES` and `MOVEMENT_SOURCES` in the test now
   (T-16 exports identical arrays and imports this assertion's intent into its own test).

**Tests:** the schema guards (`schema.test.ts`) and the new describe block; `pnpm test` runs both.

**Done when:** a second `pnpm db:generate` creates no file; `pnpm test` passes (unit and integration);
`pnpm exec drizzle-kit check` is clean.

**Watch out:** if the generated SQL orders an `ADD CONSTRAINT` after a foreign key that needs it, fix the
schema file (declare the target with `unique()` inside the table) and regenerate BEFORE the migration
first runs. After it has run, the only fix is a new migration.

### T-08 — Custom migration 0014: append-only triggers on the inventory records; prove them

**Needs:** T-07
**Files:**
- `src/lib/server/db/migrations/0014_inventory_append_only.sql` and its meta entry — NEW, created by
  `pnpm exec drizzle-kit generate --custom --name=inventory_append_only`
- `src/lib/server/accounting/journal-guards.integration.test.ts` — EDIT (created by tasks/pos-sales T-09;
  the assertion that counts triggers `like '%_append_only'`, line recorded by T-01)
- `src/lib/server/inventory/inventory-guards.integration.test.ts` — NEW
**Spec:** 3 ("Posted records are permanent. Paid orders, invoices, payments, stock movements and journal
entries are never updated or deleted"), 22
**Invariants:** 2 (posted records are permanent — enforced in the database for the inventory records), 6
(stock movements are the truth, so they must not change)

**Do:**
1. Generate the custom file. CLAUDE.md says `generate --custom` is for data; a trigger is the one other
   thing drizzle-kit cannot express, and migrations 0004 and 0012 are the precedents — say exactly that
   in the file's header comment.
2. SQL, one statement per `--> statement-breakpoint`, reusing migration 0012's
   `posted_record_append_only()` (do NOT create a second function):
   ```sql
   CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
     FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
   ```
   and the same for `purchase_lines`, `stock_count_lines`, `waste_entries` and
   `opening_stock_entries`, each named `<table>_append_only`.
3. Header comment: why these five and not `purchases`, `supplier_payments` or `stock_counts` (their
   journal ids and reversal stamps are written once after insert) or `ingredients` (it carries the
   caches `applyMovements` updates); why TRUNCATE is not covered (the test reset truncates, and
   production relies on the runtime role lacking the TRUNCATE privilege), in the same words as 0004 and
   0012.
4. `pnpm db:migrate`.
5. `journal-guards.integration.test.ts`: replace the count of `%_append_only` triggers with an exact set
   assertion of the nine names — pos-sales' `journal_entries_append_only`,
   `journal_entry_lines_append_only`, `invoices_append_only`, `payments_append_only`, plus the five above.

**Tests:** `inventory-guards.integration.test.ts` (integration): for each of the five tables, insert a
valid row (build the parents it needs: restaurant, user, ingredient, purchase, count), then assert that
`UPDATE` and `DELETE` each reject with the message raised by `posted_record_append_only()` (open 0012 for
its exact text and assert on a stable prefix naming the table), and that the row is unchanged afterwards.

**Done when:** `pnpm db:migrate` applies 0014, and both test files pass.

**Watch out:** never name a trigger with a different suffix to dodge the pinned count; the exact-set
assertion is the fix. The integration harness resets with TRUNCATE, which these row-level triggers do
not block — that is intended.
