# Phase 5 (UI) — the dashboard pages (T-27 … T-34)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: Phase 4 (every module the pages
> call) and T-18 for the menu column.

These are the owner's pages: online only (spec 6), mouse-driven, built from the dashboard primitives in
`src/lib/components/ui/` per `docs/design-system.md` §7b (PageHeader, Card, Table, Field, SelectField,
CheckField, Button, Alert, StatusMark). Every `load` and every form action calls `requirePermission(event,
'admin.inventory')` — or `'admin.purchases'` under `/purchases`, `'admin.menu'` on `/menu` — as its first
statement, and a staff principal gets 403 (invariant 8; spec 8: "hiding buttons in the frontend is not
considered security"). Each page's integration test drives the load and EVERY action as a staff principal
and expects 403 with no row written, copying the idiom of
`src/routes/(dashboard)/menu/menu-page.integration.test.ts` ("refuses a cashier with 403 on the load and
on every action": `seedStaff`, `principal(…)`, `statusOf`, `act`, `makeEvent`). The tenant is
`locals.restaurantId`, never a form field or query parameter; an id from another restaurant answers 404
on a load and `not_found` in an action. Every action runs one `db.transaction` around one module call;
the module writes the audit row. Loads format every bigint with the money formatter
(`formatAmount`/`formatMoney` from `$lib/money/format`) and every quantity with `formatQty`; the
`.svelte` files render strings and do no arithmetic. Money inputs are parsed with `parsePriceInput` from
`src/routes/(dashboard)/menu/helpers.ts` (import it; never copy it) behind the menu page's currency gate
(no currency set → money inputs disabled with the reason "Set the currency in Settings before entering
amounts."); quantity inputs are parsed with `parseQty`. zod schemas live in a `helpers.ts` beside each
page and bound every text field. Every form carries the in-flight guard of
`src/routes/(dashboard)/settings/+page.svelte` (a `submitting` flag, the button disabled and labelled
"Saving…") and every successful action ends in a 303 redirect. Colour never carries meaning alone:
below-zero stock shows `◆` and the words "below zero"; drift shows `✕` and "differs from the stock
book"; a reversed delivery shows `↩` and "reversed". An average cost is displayed only as the overview's
display rule says: `valueAt(qty(baseQtyPerUnit), avgMicro)` per purchase unit, or per one base unit.
No path added here begins with the characters `pos` (CLAUDE.md's service-worker rule).

### T-27 — `/inventory` and the Inventory and Purchases rail items

**Needs:** T-26
**Files:**
- `src/lib/components/ui/Sidebar.svelte` — EDIT (the `href` union in the `NavItem` type gains
  `'/inventory'` and `'/purchases'`; the rail rows labelled Inventory and Purchases get those hrefs in
  place of `null`)
- `src/lib/components/ui/sidebar.test.ts` — EDIT (if it pins the list of hrefs or the rows that are
  links, add the two)
- `src/routes/(dashboard)/inventory/+page.server.ts` — NEW
- `src/routes/(dashboard)/inventory/+page.svelte` — NEW
- `src/routes/(dashboard)/inventory/helpers.ts` — NEW
- `src/routes/(dashboard)/inventory/inventory-page.integration.test.ts` — NEW
**Spec:** 26 (Current Stock; Negative Stock Alerts), 8 (server enforcement), 15 (negative stock flagged)
**Invariants:** 8 (every load and action checks its key and answers 403), 6 (the tripwire compares the
cache with the ledger), 1 (the page does no arithmetic)

**Do:**
1. `load`: `requirePermission(event, 'admin.inventory')`; `currentStock` and `reconciliation` (T-26); map
   every amount to a formatted string and every quantity through `formatQty`.
2. Action `createIngredient` (fields `name` 1–80, `baseUnit` 1–16, both trimmed) → `createIngredient`
   (T-17) → 303 to `/inventory/<id>`; `name_taken` → `fail(400, { message: 'An ingredient with this
   name already exists.' })`.
3. Page: `PageHeader` "Inventory" with links to Recipes (`/inventory/recipes`), Deliveries
   (`/purchases`), Waste (`/inventory/waste`), Counts (`/inventory/counts`), Reports
   (`/inventory/reports`); when `differenceMinor ≠ 0n` or `driftCount > 0` an `Alert` "✕ The stock value
   differs from the books by <amount> (<n> ingredients differ from the stock book)." with no rebuild
   button (assumption 13); a `Table` of ingredients: name (link to `/inventory/<id>`), on hand with its
   unit, average per unit, value, and a status cell (`◆ below zero` / `✕ differs from the stock book` /
   empty); an "Add ingredient" `Card` with the form.
4. Sidebar: the two rows become links.

**Tests:** (integration)
- MANDATORY (spec 29 — permission checks, applied to every route in this repository): a staff principal
  gets 403 on the load and on `createIngredient`, and no ingredient row exists afterwards.
- As the owner, `createIngredient` writes the row and an `ingredient.created` audit row and redirects 303.
- With a cache corrupted in the test (owner connection `UPDATE`), the load's data carries the drift and
  the alert fields.
- `sidebar.test.ts` passes with the two new links.

**Done when:** the test passes and `pnpm check` and `pnpm lint` pass.

### T-28 — `/inventory/[id]`: units, opening stock, archive, the movement log

**Needs:** T-27
**Files:**
- `src/routes/(dashboard)/inventory/[id]/+page.server.ts` — NEW
- `src/routes/(dashboard)/inventory/[id]/+page.svelte` — NEW
- `src/routes/(dashboard)/inventory/[id]/ingredient-page.integration.test.ts` — NEW
**Spec:** 15 (base unit and purchase units), 26 (Stock Movement), 24 and assumption 1 (opening stock)
**Invariants:** 8, 6 (the log reads the ledger), 1, 10 (every action's module writes the audit row)

**Do:**
1. `load`: `requirePermission(event, 'admin.inventory')`; `getIngredient` (404 when it is not in the
   restaurant); its live purchase units; `movementLog(…, { limit: 200 })`; the average per unit;
   `openingAllowed` = no movement exists yet; `todayInZone` for the date defaults.
2. Actions, each `requirePermission` first:
   - `update` (name; base unit — the field is disabled with the reason "The base unit cannot change once
     stock has moved." when movements exist; the module refuses anyway) → `updateIngredient`.
   - `addUnit` (name 1–24, base quantity per unit via `parseQty`, > 0) → `addPurchaseUnit`.
   - `archiveUnit` (unit id) → `archivePurchaseUnit`.
   - `archive` → `archiveIngredient`; `in_recipe` → `fail(400, { message: 'Remove it from these recipes
     first: <owner names>.' })`.
   - `openingStock` (purchase unit, quantity via `parseQty`, cost per unit via `parsePriceInput`,
     business date `YYYY-MM-DD` defaulting to today in the restaurant's zone) → `recordOpeningStock`;
     the form explains "Stock already on the shelf. Recorded as money the owner put into the business."
     and is shown only while `openingAllowed`.
3. Movement log `Table`: business date, type in words with a glyph (delivery `+`, sale `−`, waste `✕`,
   count `≈`, opening `○`, revaluation `↕`, reversal `↩`), quantity with unit, cost (negatives with a
   leading `−` and `text-danger`), source (a link to `/purchases/<id>` for deliveries and their
   reversals; text otherwise).

**Tests:** (integration)
- MANDATORY (spec 29 — permission checks): 403 for staff on the load and on every action; nothing
  written.
- Another restaurant's ingredient id → 404 on the load.
- Each action's happy path (row and audit row) and each refusal's message.
- After a delivery, `openingAllowed` is false and the `openingStock` action answers the
  `has_movements` message.

**Done when:** the test passes.

### T-29 — `/inventory/recipes`: the recipe editor

**Needs:** T-27
**Files:**
- `src/routes/(dashboard)/inventory/recipes/+page.server.ts` — NEW
- `src/routes/(dashboard)/inventory/recipes/+page.svelte` — NEW
- `src/routes/(dashboard)/inventory/recipes/recipes-page.integration.test.ts` — NEW
**Spec:** 15 (recipes in base units; modifiers affect recipes), 16 (recipe cost at the current average)
**Invariants:** 8 (permissions are enforced server-side on every load and action), 10 (sensitive
actions are audit-logged — `setRecipe` writes `recipe.changed`), 1 (money is integer minor units; the
page does no arithmetic)

**Do:**
1. `load`: `requirePermission(event, 'admin.inventory')`; `listMenu` from `src/lib/server/menu` (read
   only — do not change it), `readRecipes`, live ingredients, `recipeCosts`; the selected owner from
   `?item=<id>` or `?modifier=<id>` (unknown or foreign id → no selection, never an error page).
2. Action `save`: owner kind and id, and up to 30 rows of ingredient id and quantity (`parseQty`; item
   rows must be positive, modifier rows may be negative) → `setRecipe` → 303 back to the same owner;
   each refusal maps to a message naming the row.
3. Page: a picker listing items by category and modifiers by group, each with its current recipe cost
   (formatted; "—" when it has no recipe); the editor for the selected owner as plain form rows with an
   "Add row" and a remove control per row (the rows are form fields, no client arithmetic); help text
   "Quantities are in each ingredient's base unit. Extras may be negative: 'No tomato' takes tomato
   away."

**Tests:** (integration)
- MANDATORY (spec 29 — permission checks): 403 for staff on the load and on `save`; no recipe row
  written.
- `save` replaces a recipe and writes `recipe.changed`; an invalid row (item quantity `-1`) answers the
  message and writes nothing.

**Done when:** the test passes.

### T-30 — `/purchases` and `/purchases/new`

**Needs:** T-27
**Files:**
- `src/routes/(dashboard)/purchases/+page.server.ts` — NEW
- `src/routes/(dashboard)/purchases/+page.svelte` — NEW
- `src/routes/(dashboard)/purchases/helpers.ts` — NEW
- `src/routes/(dashboard)/purchases/purchases-page.integration.test.ts` — NEW
- `src/routes/(dashboard)/purchases/new/+page.server.ts` — NEW
- `src/routes/(dashboard)/purchases/new/+page.svelte` — NEW
**Spec:** 19 (purchases in purchase units; paid now or on credit), 26 (Purchases), 6 (the dashboard is
online only)
**Invariants:** 8 (`admin.purchases` on every load and action), 10, 1

**Do:**
1. `/purchases` `load`: `requirePermission(event, 'admin.purchases')`; `listPurchases(…, { limit: 100 })`;
   a `Table`: supplier (link to `/purchases/<id>`), business date, paid by in words, total, outstanding
   (credit deliveries only), status (`↩ reversed` when reversed); a primary Button "Record a delivery"
   linking to `/purchases/new`.
2. `/purchases/new` `load`: `requirePermission(event, 'admin.purchases')`; live ingredients with their live
   purchase units; today in the restaurant's zone; the currency gate.
3. `/purchases/new` action `create`: supplier name (1–120), business date, paid by (a `SelectField`:
   "Paid now — bank", "Paid now — cash", "On credit"; helper text "Cash means cash kept outside the
   till. Paying from the till drawer is a pay-out, which is not part of this release." — assumption 3),
   note (≤ 200), and up to 30 line rows of ingredient, purchase unit (the unit list is filtered to the
   chosen ingredient on the server; a mismatch is refused by the module), quantity (`parseQty`) and line
   total (`parsePriceInput`) → `recordPurchase` → 303 to `/purchases/<id>`; `invalid_line` → the message
   "Line <n>: choose an ingredient and one of its units, a quantity above zero and a total." kept with the
   entered values.

**Tests:** (integration)
- MANDATORY (spec 29 — permission checks): 403 for staff on both loads and on `create`; no purchase row.
- `create` records a bank delivery with its movements and entry and redirects; an invalid line returns
  its message and writes nothing.

**Done when:** the test passes.

### T-31 — `/purchases/[id]`: pay, reverse a payment, reverse the delivery

**Needs:** T-30
**Files:**
- `src/routes/(dashboard)/purchases/[id]/+page.server.ts` — NEW
- `src/routes/(dashboard)/purchases/[id]/+page.svelte` — NEW
- `src/routes/(dashboard)/purchases/[id]/purchase-page.integration.test.ts` — NEW
**Spec:** 19 (supplier paid later), 22 (reversing entries), 24
**Invariants:** 8, 2 (corrections are reversals), 10, 11 (reversals dated today in the restaurant's zone)

**Do:**
1. `load`: `requirePermission(event, 'admin.purchases')`; `getPurchase` (404 when foreign) with lines,
   payments, outstanding and the reversal state.
2. Actions, each `requirePermission(event, 'admin.purchases')` first:
   - `pay` (amount via `parsePriceInput`, paid from "bank" or "cash", business date) → `paySupplier`;
     shown only for a credit delivery with an outstanding balance.
   - `reversePayment` (payment id, reason 3–200) → `reverseSupplierPayment`.
   - `reverse` (reason 3–200) → `reversePurchase`. Its form sits in its own `Card` with a `danger`
     Button; while a payment is open the Button is disabled with the reason "Reverse the payments on this
     delivery first."; the Card says the reversal is dated today and leaves the original visible.
   Each refusal maps to a message (`already_reversed` → "This was already reversed.").
3. Page: header facts (supplier, business date, paid by, total, outstanding, `↩ reversed` with the
   reason), the lines `Table` (ingredient, unit, quantity, base quantity, line total), the payments
   `Table` (date, amount, from, `↩ reversed`).

**Tests:** (integration)
- MANDATORY (spec 29 — permission checks): 403 for staff on the load and on every action; nothing
  written.
- `pay`, `reversePayment` and `reverse` happy paths; `reverse` with an open payment answers the
  `has_payments` message; a second `reverse` answers "This was already reversed."

**Done when:** the test passes.

### T-32 — `/inventory/waste`, `/inventory/counts` and `/inventory/counts/[id]`

**Needs:** T-27
**Files:**
- `src/routes/(dashboard)/inventory/waste/+page.server.ts` — NEW
- `src/routes/(dashboard)/inventory/waste/+page.svelte` — NEW
- `src/routes/(dashboard)/inventory/waste/waste-page.integration.test.ts` — NEW
- `src/routes/(dashboard)/inventory/counts/+page.server.ts` — NEW
- `src/routes/(dashboard)/inventory/counts/+page.svelte` — NEW
- `src/routes/(dashboard)/inventory/counts/counts-page.integration.test.ts` — NEW
- `src/routes/(dashboard)/inventory/counts/[id]/+page.server.ts` — NEW
- `src/routes/(dashboard)/inventory/counts/[id]/+page.svelte` — NEW
**Spec:** 15 (waste; stock counts), 26 (Waste; Stock Count Differences), 10 (session close; business date)
**Invariants:** 8 (permissions are enforced server-side on every load and action), 6 (inventory is a
ledger — waste and count corrections are movements through the one writer), 10 (sensitive actions are
audit-logged in the same transaction)

**Do:**
1. `/inventory/waste`: `load` (`admin.inventory`) returns live ingredients, today and the last 50 waste
   entries (`wasteByDate` over the last 30 business days); action `record` (ingredient, quantity via
   `parseQty`, reason as a `SelectField` with "Spoilage", "Preparation error", "Breakage", "Other", note —
   required for "Other", 3–200 — business date) → `recordWaste` → 303.
2. `/inventory/counts`: `load` (`admin.inventory`) returns `countBlockers`, live ingredients with their
   current on-hand quantity, `listCounts`, today. When either blocker is non-zero an `Alert` explains in
   words ("A shift is still open on the till. Close it before counting." / "<n> sales are waiting for
   your review on the Reports page.") and the form's submit Button is disabled with that reason; otherwise
   the form lists every live ingredient with its system quantity and an optional counted field (blank
   means not counted — partial counts are normal); action `post` → `postCount` with the non-blank rows →
   303 to `/inventory/counts/<id>`; `blocked` → the same words; `no_inbound_history` → "Enter opening
   stock or a delivery first for: <names>."
3. `/inventory/counts/[id]`: `load` (`admin.inventory`; 404 when foreign) → `countDifferences`: each
   line's system, counted, difference and value, and the count's shortfall and surplus totals.

**Tests:** (integration)
- MANDATORY (spec 29 — permission checks): 403 for staff on each of the three loads and on `record` and
  `post`; nothing written.
- Waste recorded with its movement and entry; "Other" without a note answers its message.
- `post` while a `pos_sessions` row is open answers the blocked message and writes nothing; after the
  session is closed, a count posts and its detail page shows the differences.

**Done when:** the tests pass.

### T-33 — `/inventory/reports`

**Needs:** T-27
**Files:**
- `src/routes/(dashboard)/inventory/reports/+page.server.ts` — NEW
- `src/routes/(dashboard)/inventory/reports/+page.svelte` — NEW
- `src/routes/(dashboard)/inventory/reports/reports-page.integration.test.ts` — NEW
**Spec:** 26 (Consumption, Waste, Negative Stock Alerts, COGS), 27 (plain indexed SQL), 17 (business date)
**Invariants:** 8, 11 (business dates, never calendar dates of `created_at`), 1

**Do:**
1. `load`: `requirePermission(event, 'admin.inventory')`; `from` and `to` from the query string,
   `YYYY-MM-DD` each, default the seven business days ending today in the restaurant's zone; a malformed
   date or `from > to` → `error(400, 'Dates must be YYYY-MM-DD, from on or before to.')`;
   `consumptionByDate`, `wasteByDate`, `cogsByDate`, `negativeStock`, `reconciliation`.
2. Page: a `PageHeader` with the range and a date form; Cards for "Ingredients used per business day",
   "Waste", "Cost of goods sold per business day" (sales and revaluations in separate columns and a
   total), "Stock below zero" (`◆` with the words), and the reconciliation line; money right-aligned in
   `font-mono tabular-nums`.

**Tests:** (integration)
- MANDATORY (spec 29 — permission checks): 403 for staff on the load.
- T-26's scripted day renders its numbers as formatted strings for the session's business date.
- `?from=2026-9-1` → 400.

**Done when:** the test passes.

### T-34 — Cost and margin on `/menu`

**Needs:** T-18
**Files:**
- `src/routes/(dashboard)/menu/+page.server.ts` — EDIT (in `load`, after the existing `listMenu` call and
  the currency gate: read `recipeCosts` and the restaurant's tax mode and rate, and add formatted
  `cost` and `margin` strings per item and `cost` per modifier to the returned data)
- `src/routes/(dashboard)/menu/+page.svelte` — EDIT (a read-only "Cost" and "Margin" column for items,
  a "Cost" cell for modifiers, and an "Edit recipe" link to `/inventory/recipes?item=<id>` or
  `?modifier=<id>`)
- `src/routes/(dashboard)/menu/menu-page.integration.test.ts` — EDIT (a new case for the cost and margin
  fields)
- `src/routes/api/menu/menu-api.integration.test.ts` — EDIT (a new case asserting the snapshot carries no
  cost)
**Spec:** 16 (recipe cost at the current average), 25 (gross profit), 17 (tax in both modes), 5 (the POS
snapshot — which must not change)
**Invariants:** 7 (one rounding each for cost and net price), 1 (the page does no arithmetic), 8 (the load
still checks `admin.menu` first)

**Do:**
1. In the load, for each item with a recipe: `dishMargin({ priceMinor, taxRateBp: item.taxRateBp ??
   restaurant.taxRateBp, taxMode: restaurant.taxMode, costExact }, ROUNDING_RULE)` from
   `src/lib/money/costing` (T-11) and format `costMinor` and `marginMinor`. When the restaurant's tax mode
   or rate is unset, show the cost and put "Set the tax mode in Settings" in the margin cell. An item
   without a recipe shows "—" and the "Edit recipe" link.
2. Do not touch `src/lib/server/menu/index.ts`: `listMenu` and `readMenuSnapshot` are unchanged; the POS
   snapshot never carries a cost (the risk panel's minor finding).

**Tests:** (integration)
- `menu-page.integration.test.ts`: an owner load for a Burger priced `800n`, restaurant exclusive at
  1000 bp in USD, with the T-11 recipe and averages → the item's `cost` is `'1.20'` and `margin` `'6.80'`
  in the page's money format (use the formatter's own output for the expected strings).
- `menu-api.integration.test.ts`: walk the whole `GET /api/menu` JSON body and assert no key named
  `cost`, `costMinor`, `margin` or `marginMinor` appears at any depth.
- The existing 403 case of the menu page still passes.

**Done when:** both test files pass and the menu page renders in `pnpm dev` without errors.
