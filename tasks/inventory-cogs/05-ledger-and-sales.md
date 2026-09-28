# Phase 3 — the stock ledger and cost of goods sold (T-15 … T-19)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: Phase 1 (the tables and the
> append-only triggers) and Phase 2 (the costing rules, the posting rules).

One writer, `applyMovements` in `src/lib/server/inventory/movements.ts`, owns `stock_movements` and the
three cache columns on `ingredients` (`on_hand_qty`, `inventory_value_minor`, `avg_unit_cost_micro`).
Its first statement locks every affected ingredient row in ONE `select … where id = any($ids) order by
id for update`; it reads the caches only from that result and writes them under that lock, which is held
until COMMIT. That single ordered lock is what prevents the two findings the risk panel ranked highest
after the costing rules: a lost update (a delivery saved while the till syncs a sale, each overwriting
the other's absolute cache values) and a deadlock (one transaction locking in recipe order, another in
delivery-line order). Every other module calls it; nothing else inserts a movement or writes a cache
column. `consumeForSale` runs inside pos-sales' payment transaction (invariant 4) and must never throw
for a business reason — a dish with no recipe, an archived ingredient, stock below zero — because a
throw there rolls a completed cash sale back into an `unrecorded` sync op and blocks the session close.
It throws only for programming errors. Every write in this phase writes its audit row in the same
transaction (invariant 10).

### T-15 — Audit events for inventory, deliveries, payments, waste, counts and opening stock

**Needs:** T-02
**Files:**
- `src/lib/server/audit/events.ts` — EDIT (append members to the `AuditEvent` union after the last
  existing member, and the same names at the end of `AUDIT_EVENT_NAMES`; the compile-time completeness
  assertion `_NoMissingAuditEventNames` stays as it is)
- `src/lib/server/audit/audit.test.ts` — EDIT (add a case per new member)
- `src/routes/(dashboard)/dashboard/event-text.ts` — EDIT (one fixed sentence per new event name, in the
  map the file already exports)
- `src/routes/(dashboard)/dashboard/event-text.test.ts` — EDIT (if it enumerates names, add them; if it
  asserts every `AUDIT_EVENT_NAMES` entry has a sentence, it passes once the sentences exist)
**Spec:** 3 ("Sensitive actions are audit-logged: … price changes"; approvals), 22 (reversals are part
of the trail), 15 (waste and counts)
**Invariants:** 10 (every write carries its audit row in the same transaction), 12 (no secret ever enters
an audit row — `assertNoSecrets` rejects keys matching `/pass|pin|token|hash|secret|cookie|authorization/i`)

**Do:**
1. Add these members (amounts and quantities are decimal STRINGS — jsonb cannot hold a bigint; every
   key is chosen so `assertNoSecrets` passes — note that words like "shipping", "typing", "mapping" and
   "grouping" contain "pin" and must never be keys):
   - `ingredient.created` `{ ingredientId: string; name: string; baseUnit: string }`
   - `ingredient.updated` `{ ingredientId: string; changes: Record<string, { old: unknown; new: unknown }> }`
   - `ingredient.archived` `{ ingredientId: string; name: string }`
   - `purchase_unit.added` `{ ingredientId: string; unitName: string; baseQtyPerUnit: string }`
   - `purchase_unit.archived` `{ ingredientId: string; unitName: string }`
   - `recipe.changed` `{ ownerKind: 'item' | 'modifier'; ownerId: string; ownerName: string; before: {
     ingredientId: string; qty: string }[]; after: { ingredientId: string; qty: string }[] }`
   - `purchase.recorded` `{ purchaseId: string; supplierName: string; paidBy: 'cash' | 'bank' | 'credit';
     totalMinor: string; lineCount: number }`
   - `purchase.reversed` `{ purchaseId: string; totalMinor: string; reason: string; revaluationMinor: string }`
   - `supplier.paid` `{ paymentId: string; purchaseId: string; amountMinor: string; paidFrom: 'cash' | 'bank' }`
   - `supplier.payment_reversed` `{ paymentId: string; purchaseId: string; amountMinor: string; reason: string }`
   - `waste.recorded` `{ wasteId: string; ingredientId: string; qty: string; reason: string; costMinor: string }`
   - `stock.counted` `{ countId: string; lineCount: number; shortfallMinor: string; surplusMinor: string }`
   - `opening_stock.recorded` `{ entryId: string; ingredientId: string; qty: string; valueMinor: string }`
2. Add their thirteen names to `AUDIT_EVENT_NAMES` in the same order.
3. `event-text.ts`: a plain sentence per name, e.g. `'purchase.recorded': 'Recorded a delivery'`,
   `'purchase.reversed': 'Reversed a delivery'`, `'stock.counted': 'Posted a stock count'` — the
   dashboard feed never renders `details`.

**Tests:**
- `audit.test.ts`: for each new member, a sample details object passes `assertNoSecrets` and type-checks
  as that member.
- The existing test that walks `AUDIT_EVENT_NAMES` keeps passing (every name has a sentence).

**Done when:** `pnpm check` and `pnpm test:unit src/lib/server/audit src/routes/(dashboard)/dashboard`
pass.

**Watch out:** do not change any existing member (PR #11 and pos-sales already shaped several);
extend only.

### T-16 — `applyMovements`: the one ledger writer with ordered row locks; concurrency tests

**Needs:** T-08, T-10
**Files:**
- `src/lib/server/inventory/movements.ts` — NEW
- `src/lib/server/inventory/business-date.ts` — NEW
- `src/lib/server/inventory/movements.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — NEW (re-exports this task's names; later tasks add theirs)
**Spec:** 3 ("Inventory is a ledger. Stock on hand is the sum of stock movements. A cached quantity may
exist for speed, but the movements are the truth"), 15 (movement types), 16 (weighted average), 17
(business date in the restaurant's zone)
**Invariants:** 6 (the cache is written only with the movement that caused it, only here), 1 (bigint and
`Qty` only), 11 (every movement carries the business date its caller passes), 2 (movements are inserted,
never updated)

**Do:**
1. Export `MOVEMENT_TYPES`, `MOVEMENT_SOURCES`, `MovementRequest`, `MovementContext`, `LockedIngredient`,
   `StockMovementRow`, `lockIngredients` and `applyMovements` exactly as the overview's "Shared contracts →
   The ledger writer". `MOVEMENT_TYPES` and `MOVEMENT_SOURCES` must equal the literal lists T-07's
   constraint test spells; import this module's constants into that test in place of the spelled lists.
2. `lockIngredients(tx, restaurantId, ids)`: deduplicate and sort the ids ascending; run ONE drizzle
   select of `id, name, on_hand_qty, inventory_value_minor, avg_unit_cost_micro, archived_at` plus
   `has_inbound_history` (an `exists (select 1 from stock_movements where ingredient_id = ingredients.id
   and movement_type in ('purchase', 'opening_stock'))`) where `restaurant_id = $1 and id = any($2)`,
   ordered by id, with `.for('update')`; parse `on_hand_qty` with `parseQty` and brand the value with
   `minor()`; throw `Error('ingredient not found: <id>')` if any requested id is missing (a programming
   error or tampering — no business path sends an unknown id). Return a `Map` keyed by id.
3. `applyMovements(tx, ctx, requests)`:
   1. Validate BEFORE any SQL: every `qty > 0n`, every `costMinor` / `originalCostMinor >= 0n`, the
      business date matches `/^\d{4}-\d{2}-\d{2}$/`; otherwise throw `TypeError`. An empty request list
      returns `{ movements: [], costMinor: 0n, revaluationMinor: 0n }` without locking.
   2. `lockIngredients` for the distinct ingredient ids.
   3. Walk the requests in the order given, holding a working `StockState` per ingredient: `inbound` →
      `applyInbound(state, qty, costMinor, ROUNDING_RULE)`; `out` → `applyAtAverage(state, qty, 'out', …)`;
      `in` → `applyAtAverage(state, qty, 'in', …)`; `reversal` → `applyReversal(state, qty,
      originalCostMinor, …)`. For each result build a movement row: `qty` is `+q` for inbound and in,
      `−q` for out and reversal, written with `formatQty`; `cost_minor` is the result's `costMinor`;
      then, when `revaluationMinor !== 0n`, a second row of type `'revaluation'` with `qty '0.000'` and
      `cost_minor = revaluationMinor`. Every row carries `ctx`'s restaurant, source, business date,
      occurred-at and recorded-by.
   4. Insert all rows in one statement, returning them.
   5. UPDATE each touched ingredient ONCE with its final `on_hand_qty` (`formatQty`),
      `inventory_value_minor`, `avg_unit_cost_micro` and `updated_at = now()`, `where id = … and
      restaurant_id = …`.
   6. Return `{ movements, costMinor: Σ non-revaluation costs, revaluationMinor: Σ revaluation costs }`.
   It never opens a transaction, never writes a journal entry (callers post), never catches.
4. `business-date.ts`: `todayInZone(executor, restaurantId): Promise<string>` runs
   `select to_char(now() at time zone s.time_zone, 'YYYY-MM-DD') from restaurant_settings s where
   s.restaurant_id = $1` — computed in SQL, never with JavaScript dates (invariant 11).
5. Header comment of movements.ts: the one-writer rule, the ordered-lock rule and why (lost update,
   deadlock), and the costing rules' names.

**Tests:** (integration, `movements.integration.test.ts`)
- The spec 16 numbers of T-10(a) through the database: an ingredient in grams, an inbound of `10000000n`
  at `5000n`, another at `6000n`, an out of `150000n` → three movement rows with costs `5000`, `6000`,
  `-82`; the cache reads `19850.000` g, `10918`, `550000`.
- The negative-stock case of T-10(d): an out, then an inbound → a `purchase` row of cost `25000` AND a
  `revaluation` row of qty `0.000` and cost `-15000`; returned `revaluationMinor` is `-15000n`.
- After 200 seeded random requests across three ingredients: for each ingredient, the cache's
  `on_hand_qty` equals Σ `qty` and `inventory_value_minor` equals Σ `cost_minor` over its movements.
- CONCURRENCY (two pool connections): transaction A (the sale shape: `out` requests for `[bun, meat]`)
  locks, then awaits a 300 ms timer before inserting; transaction B (a delivery: `inbound` requests for
  `[meat, bun]` — the reverse order) starts 50 ms after A. Both commit; neither raises 40P01; the final
  caches equal Σ movements; the average equals `unitCostMicro(Σ cost, Σ qty)` for each ingredient whose
  Σ qty is positive.
- An id belonging to another restaurant → throws and writes no row (select counts before and after).
- A request with `qty: 0n` → `TypeError` before any SQL (assert with a spy or by showing no lock was
  taken: the other connection can update the row immediately).
- `todayInZone` for a restaurant in `'Asia/Tokyo'` returns the date in Tokyo (compare with
  `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' })` in the test).

**Done when:** `pnpm test:integration src/lib/server/inventory/movements.integration.test.ts` passes.

**Watch out:** never lock one ingredient at a time, never read a cache column outside this lock, and never
write a cache column anywhere else — T-37 greps for it. A request list may name the same ingredient
twice (two delivery lines); apply them in order against the working state and update the row once.

### T-17 — Ingredients and purchase units: create, update, archive

**Needs:** T-15, T-16
**Files:**
- `src/lib/server/inventory/ingredients.ts` — NEW
- `src/lib/server/inventory/ingredients.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16; re-export this task's names)
**Spec:** 15 (ingredients, base units, purchase units with conversions), 3 (audit), 26 (current stock)
**Invariants:** 10 (audit in the same transaction), 6 (an ingredient is archived, never deleted — its
movements reference it), 1 (quantities as `Qty`)

**Do:**
1. `type InventoryWriteContext = { restaurantId: string; actorUserId: string; ip: string | null;
   userAgent: string | null }` (exported; every write in this plan takes it).
2. `createIngredient(tx, ctx, { name, baseUnit })` → `{ ok: true; id }` or `{ ok: false; reason:
   'name_taken' }` (map 23505 on `ingredients_name_unique`); trims both strings; audit
   `ingredient.created`.
3. `updateIngredient(tx, ctx, id, { name?, baseUnit? })` → `{ ok: true; changed: boolean }` or
   `'not_found' | 'name_taken' | 'has_movements'`: a base-unit change is refused with `'has_movements'`
   once any stock movement exists for the ingredient (every stored quantity would change meaning);
   audit `ingredient.updated` with old and new values of what changed.
4. `archiveIngredient(tx, ctx, id)` → `{ ok: true }` or `{ ok: false; reason: 'not_found' }` or
   `{ ok: false; reason: 'in_recipe'; owners: string[] }` — refused while any `recipe_lines` row
   references the ingredient whose menu item or modifier has `archived_at is null` (assumption 10);
   stock may be non-zero when archiving (the reports keep showing archived ingredients with stock);
   audit `ingredient.archived`.
5. `addPurchaseUnit(tx, ctx, ingredientId, { name, baseQtyPerUnit: Qty })` (factor `> 0n`) →
   `{ ok: true; id }` or `'not_found' | 'name_taken' | 'ingredient_archived'`; audit `purchase_unit.added`.
   `archivePurchaseUnit(tx, ctx, unitId)`; audit `purchase_unit.archived`.
6. `listIngredients(db, restaurantId, { includeArchived })` and `getIngredient(db, restaurantId, id)`
   return the row with `onHandQty: Qty` (parsed), `valueMinor: Minor`, `avgMicro: bigint`, and the live
   purchase units. Every query filters `restaurant_id`.
7. None of these functions writes a cache column (they are read-only for the caches).

**Tests:** (integration)
- Create → the row exists with zero caches and an `ingredient.created` audit row in the same restaurant.
- `'Meat'` then `'meat'` → `name_taken`; archive the first, then `'meat'` succeeds.
- Update the name → one audit row with `{ name: { old, new } }`; change the base unit before any movement
  → allowed; after one movement (insert via `applyMovements`) → `has_movements`.
- Archive while a live menu item's recipe uses it → `in_recipe` with that item's name; archive the menu
  item (through `archiveItem` in `src/lib/server/menu`) → archiving the ingredient now succeeds.
- Add a purchase unit `kg` with `1000000n` (1000.000); a second live `KG` → `name_taken`.
- Every function called with another restaurant's id → `not_found`, nothing written, no audit row.

**Done when:** `pnpm test:integration src/lib/server/inventory/ingredients.integration.test.ts` passes.

### T-18 — Recipes: `setRecipe`, `recipeIndexFor` and the `recipeCosts` reader

**Needs:** T-11, T-17
**Files:**
- `src/lib/server/inventory/recipes.ts` — NEW
- `src/lib/server/inventory/recipes.integration.test.ts` — NEW
- `src/lib/server/inventory/index.ts` — EXTEND (created by T-16)
**Spec:** 15 (recipes in base units; modifiers affect recipes), 16 ("Recipe costs … use the current
average cost"), 5 (the POS snapshot — which recipes must NOT enter)
**Invariants:** 10 (audit), 6 (costs come from the ledger's cached averages, never typed), 7 (one rounding
per owner), 1

**Do:**
1. `setRecipe(tx, ctx, { owner: { kind: 'item' | 'modifier'; id }, lines: { ingredientId; qty: Qty }[] })`
   → `{ ok: true }` or `{ ok: false; reason }` with reasons `'not_found'` (owner not in the restaurant),
   `'owner_archived'`, `'ingredient_not_found'`, `'ingredient_archived'`, `'duplicate_ingredient'`,
   `'invalid_qty'` (item lines must be `> 0n`, modifier lines `!== 0n`), `'too_many_lines'` (more than 30).
   In one transaction: read the owner's current rows (for the audit `before`), delete them, insert the
   new rows (`qty` via `formatQty`), audit `recipe.changed` with `before`, `after` and the owner's name.
   An empty `lines` clears the recipe. Recipes are configuration: replacing them is not an edit of a
   posted record, and no `menu_version` bump happens (the POS never sees recipes).
2. `recipeIndexFor(executor, restaurantId, itemIds, modifierIds): Promise<RecipeIndex>` (T-12's type):
   two queries (`where menu_item_id = any(...)` and `where modifier_id = any(...)`), both filtered by
   restaurant, quantities parsed with `parseQty`.
3. `readRecipes(db, restaurantId)` → every recipe line with its owner kind and id, ingredient name and
   base unit, for the editor (T-29).
4. `recipeCosts(db, restaurantId): Promise<Map<string, { costExact: Exact; costMinor: Minor }>>` keyed by
   item id and modifier id: join recipe lines to the ingredients' cached `avg_unit_cost_micro`, compute
   `recipeCostExact` per owner (T-11) and round once with `roundToMinor`. Modifier costs may be negative
   ("No tomato" saves the tomato).
5. Do NOT touch `src/lib/server/menu/index.ts`: `listMenu` and `readMenuSnapshot` stay exactly as they
   are; cost is read by this separate reader and merged by the `/menu` page load (T-34).

**Tests:** (integration)
- Set a burger recipe (bun 1.000, meat 150.000, cheese 1.000) → three rows and one audit row with an
  empty `before`; replace it with two lines → `before` has three, `after` two; clear it → zero rows.
- Each refusal reason, and that a refusal writes nothing.
- A modifier recipe with `tomato -30.000` is accepted; an item line with `-1.000` → `invalid_qty`.
- `recipeIndexFor` returns the shape T-12 expects for one item and one modifier.
- `recipeCosts` with the burger and cached averages meat `550000`, bun `25000000`, cheese `12000000` →
  `costMinor 120n` (119.5 rounded once).

**Done when:** `pnpm test:integration src/lib/server/inventory/recipes.integration.test.ts` passes.

### T-19 — `consumeForSale`: recipe × quantity through the ledger writer; COGS on every sale

**Needs:** T-12, T-18
**Files:**
- `src/lib/server/inventory/consume.ts` — EDIT (created by tasks/pos-sales T-17; replace the body of
  `consumeForSale`, keep the exported names `ConsumeArgs`, `ConsumeResult` and `consumeForSale`, widen
  `ConsumeResult.movements` from `never[]` to `StockMovementRow[]`, and rewrite the header comment to
  describe what now happens)
- `src/lib/server/inventory/consume.test.ts` — EDIT (created by tasks/pos-sales T-17; its unit
  assertions that the function returns an empty result no longer hold — delete the file's cases and the
  file itself, because the behaviour now needs a database and lives in the integration test below)
- `src/lib/server/inventory/consume.integration.test.ts` — NEW
- `src/lib/server/inventory/README.md` — EDIT (created on main, given a `## Status` section by
  tasks/pos-sales T-17; replace that section with the real behaviour)
**Spec:** 13 ("Deduct Inventory — recipes × quantity, incl. modifiers" inside the payment transaction; an
offline sale runs the same transaction on sync), 16 ("COGS is posted to the ledger on every sale"), 15
("Sales are never blocked by stock levels"), 6 (offline sales are facts), 24 (Cost of food sold: Dr COGS
/ Cr Inventory)
**Invariants:** 4 (one all-or-nothing transaction at payment — this runs inside it and never throws for
a business reason), 6 (inventory is a ledger; sales never blocked; negative stock allowed), 5 (a synced
cash sale is a fact; a retry is a no-op), 11 (the movement's business date is the POS session's), 2

**Do:**
1. Keep the signature `consumeForSale(tx: DbTx, args: ConsumeArgs): Promise<ConsumeResult>` with
   `ConsumeArgs = { restaurantId; orderId; lines: SaleLine[] }`. The caller, `recordSale` in
   `src/lib/server/orders/pay.ts` (tasks/pos-sales T-19), inserts the order row before calling and posts
   `cogsLines(cogsMinor)` only when `cogsMinor > 0n`; do not change `pay.ts`.
2. In the caller's transaction:
   1. `select s.business_date, o.paid_at from orders o join pos_sessions s on s.id = o.pos_session_id
      and s.restaurant_id = o.restaurant_id where o.id = $orderId and o.restaurant_id = $restaurantId`.
      No row → throw `Error('consumeForSale: order not found')` (a programming error: pos-sales inserts
      the order first).
   2. `recipeIndexFor(tx, restaurantId, distinct menuItemIds of the lines, distinct modifierIds)`.
   3. `aggregateConsumption(lines, index)`.
   4. Empty map → return `{ movements: [], cogsMinor: minor(0n) }`. A dish with no recipe consumes
      nothing and posts no COGS; a sale recorded before its recipe existed never gains COGS later,
      because posted records are permanent (invariant 2).
   5. `applyMovements(tx, { restaurantId, sourceType: 'order', sourceId: orderId, businessDate,
      occurredAt: paid_at, recordedByUserId: null }, [one { kind: 'out', type: 'sale_consumption',
      ingredientId, qty } per map entry])`.
   6. Return `{ movements, cogsMinor: negate(costMinor) }` — never negative, because an `'out'` costing
      never has a positive cost.
3. Archived ingredients are consumed like any other; stock may go below zero; a sale synced offline is
   costed at the average current now (assumption 12). Never catch, never post a journal entry, never
   throw for a business reason.
4. README `## Status`: the real behaviour in five sentences (the read of the session's business date,
   the aggregation, the one writer, the no-recipe case, the never-throw rule).

**Tests:** (integration, `consume.integration.test.ts`; seed with pos-sales' helpers in
`src/lib/server/db/test/seed.ts` where they exist and build a `SaleCompletePayload` inline otherwise;
drive the REAL `recordSale` inside `db.transaction`, and `handleOp` from `src/lib/server/orders/sync.ts`
for the retry case)
- A cash sale of two burgers (recipe bun 1.000 pcs, meat 150.000 g; stock bought through
  `applyMovements` inbound: meat `2000000n` for `1100n`, bun `12000n` for `600n`) → two
  `sale_consumption` movements with `business_date` equal to the session's and `occurred_at` equal to
  `orders.paid_at`: meat qty `-300.000` cost `-165` (value 1100 → `valueAt(1700000n, 550000n)` = 935),
  bun qty `-2.000` cost `-100` (value 600 → `valueAt(10000n, 50000000n)` = 500); the caches read meat
  `1700.000` / `935`, bun `10.000` / `500`; and one `cost_of_goods_sold` entry `Dr 5000 265 / Cr 1200 265`.
- A dish with no recipe → no movement, no `cost_of_goods_sold` entry, the sale accepted.
- A sale into never-bought stock (average 0) → movement qty `-300.000`, cost `0`, stock `-300.000`, the
  sale accepted, no COGS entry.
- MANDATORY (spec 29 — offline sync: retries never create duplicates): the same `sale.complete`
  envelope sent twice through `handleOp` → one order, one set of `sale_consumption` movements, one
  `cost_of_goods_sold` entry; the second answer is `replayed`.
- An archived ingredient in the recipe is still consumed.
- A "No tomato" modifier on the line → no tomato movement.
- `pos-sales`' own suites (`pnpm test`) stay green.

**Done when:** `pnpm test:integration src/lib/server/inventory/consume.integration.test.ts` and `pnpm
test` pass.

**Watch out:** pos-sales T-38's e2e asserts the `cost_of_goods_sold` total is `0` for a journey with no
recipe; with no recipe rows that stays true. Do not move the call in `pay.ts` or read `menu_items`
prices here — cost comes only from the ledger.
