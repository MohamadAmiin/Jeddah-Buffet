# Inventory and COGS: ingredients, recipes, deliveries, the stock ledger, costing, counts and waste

> Plan written 2026-09-28 by the plan-feature skill, approved in the user's words "ok , go and
> generate the task files". **Packaging:** a directory, one file per feature area (the user's
> standing preference since 2026-09-28): this overview plus `01`–`09`. No zip. No `RESEARCH.md` (no
> web research was needed). `Inventory-Business-Brief.pdf` beside it is the plain-English brief for
> the business team; it describes the same design and must stay consistent with it. Every task ID
> is unique across the directory and listed in the index at the bottom of this file. A session
> handed any one file must read THIS file first.

**Goal.** Give the owner the truth about stock and food cost. Ingredients have a base unit and the
units they are bought in; recipes say what each dish and each extra uses; deliveries bring stock in
at a known cost, paid now or on credit; every sale takes its ingredients out automatically inside
the sale's own transaction and posts its cost of goods sold; waste and stock counts correct the
difference; the owner can reverse a wrong delivery or payment; reports show stock, its value, what
was used, what was wasted, and what each dish costs and earns. The stock-movement ledger is the
single truth (invariant 6), costing is weighted average (spec 16, spec 33 decision 7), and every
cent that enters Inventory (1200) leaves it through a posted entry.

## Requirements (as agreed with the user, 2026-09-28)

The user asked for the inventory feature, "analyse this idea in detail then advice me to the best
way to implement it", was shown the design, the risk panel, three approaches and thirteen decisions
with defaults, asked for a business brief of the flow, and then said "ok , go and generate the task
files". The thirteen defaults are therefore the requirements this plan proceeds under; they are
listed under **Assumptions** and T-02 records each in CLAUDE.md.

- **Dashboard only, online only** (spec 6: "The management dashboard (menu edits, purchases,
  expenses, reports) requires a connection"). The till never sees recipes or costs, the menu
  snapshot is untouched, no `/api/pos` route changes.
- **Permission keys already exist** (ADMIN_KEYS on main, owner only): `admin.inventory` for
  ingredients, recipes, opening stock, waste, counts and the inventory reports; `admin.purchases`
  for deliveries, supplier payments and every reversal. No key is coined. Every load and every
  form action checks its key and returns 403 (invariant 8).
- **The design in `Inventory-Business-Brief.pdf`** is the business contract: stock book, average
  cost, sales never blocked, count after the shift, reversals with a reason, the thirteen defaults.

## Scope

**IN** — tables `ingredients`, `ingredient_purchase_units`, `recipe_lines`, `stock_movements`,
`opening_stock_entries`, `waste_entries`, `stock_counts`, `stock_count_lines`, `purchases`,
`purchase_lines`, `supplier_payments`; the widened `journal_entries` CHECKs and a one-reversal-per-entry
index on pos-sales' journal; two migrations (generated DDL, then a custom one for append-only
triggers); the isomorphic quantity and costing modules in `src/lib/money/`; eight new posting
events and `postReversal`; the ONE ledger writer with ordered row locks; `consumeForSale`'s real
body; ingredients, recipes, deliveries, supplier payments, reversals, opening stock, waste, counts;
the inventory reports and the cache-vs-ledger tripwire; the `/inventory` and `/purchases`
dashboard areas; the cost and margin column on `/menu`; audit events for every write; an e2e
journey; docs.

**OUT** — sub-recipes and batch prep; supplier records, statements and ageing (a delivery carries
a free-text supplier name; 2000 Accounts Payable IS used); more than one storage location; purchase
orders, receiving workflows, barcodes, expiry dates, reorder alerts; comps and void-after-cooking
waste (the approvals plan writes those movements through this plan's writer; the `comp` movement
type exists); paying a supplier from the till drawer (a POS pay-out, the pay-outs plan; nothing
here promises a link from a pay-out to a delivery); any POS or `/api` change; a button that
rebuilds the cached totals (assumption 13); everything else on CLAUDE.md's "Do NOT build" list.

## Approach

**Chosen: one plan, the whole ledger (A).** Schema, the quantity and costing modules, the single
ledger writer, consumption and COGS on sale, deliveries and payables, reversals, opening stock,
waste, counts, the pages and the reports. The costing rules below shape the movement table, the
writer and every page; designing them once and building the writer once is what makes the ledger
trustworthy. Phase order puts COGS on the books in phase 3.

Rejected — *two plans, ledger first then corrections (B)*: the same total across two PRs, and the
first slice cannot correct a mistyped delivery. It stays the fallback if two engineers are free.

Rejected — *quantities first, value later (C)*: invariant 6 wants every sale to post COGS; the
movement table's cost column would arrive by a second migration; a quantity-only ledger is the
current no-op plus alerts.

## Risks that survived adversarial verification

Five lenses (accounting, data model, offline/sync, permissions, ops/migration), 45 agents, 15
findings survived and 21 were refuted. The survivors merge into three design rules and five items.
Every item names the task that owns its prevention.

- **BLOCKER (invariant 6, spec 16) — the costing arithmetic strands value in 1200.** "One rounding
  per movement" plus "reset the average on a purchase into negative stock" leaks cents: a bag of
  sugar drained two grams at a time posts zero cost on every sale and leaves the whole bag's value
  in Inventory at zero stock; goods sold before their invoice is entered never reach 5000; a
  reversal after consumption can store a negative average that silently stops COGS. **Prevention
  (T-10, T-16, T-20, T-22):** the value-conserving rules in "Shared contracts → Costing": an
  at-average movement is costed as the change in stock value (value after = `valueAt(qty', avg)`,
  zero exactly when qty' is zero), so the last gram carries the last cent; the average is
  recomputed only from a positive quantity and a non-negative value; a delivery into zero or
  negative stock re-values the stock at its own unit cost and posts the difference as a
  `revaluation` movement and an `inventory_revaluation` entry to 5000 (assumption 2); database
  CHECKs on `ingredients`: `avg_unit_cost_micro >= 0`, `on_hand_qty <> 0 or inventory_value_minor
  = 0`, `on_hand_qty <= 0 or inventory_value_minor >= 0`. A seeded property test drives random
  sequences through the rules and asserts the invariants after every step.
- **BLOCKER (invariant 6) — lost updates and deadlocks on the ingredient caches.** A delivery
  saved while the till syncs a sale reads the same ingredient row; the second writer overwrites the
  first and every later sale is mis-costed; locking rows in recipe order in one transaction and in
  line order in another deadlocks, and a deadlocked cash sale lands `unrecorded` in pos-sales.
  **Prevention (T-16):** ONE ledger writer, `applyMovements`, whose first statement locks every
  affected ingredient row in one `SELECT … ORDER BY id FOR UPDATE`; caches are read only from that
  result and written under that lock, held to COMMIT; every path (consumption, delivery, reversal,
  opening stock, waste, count) goes through it. A two-connection integration test races a sale and
  a delivery with reversed ingredient order and asserts no 40P01 and caches equal Σ movements. The
  reports carry a per-ingredient tripwire (T-26).
- **MAJOR — double submit reverses twice or over-pays.** **Prevention (T-06, T-14, T-21, T-22):** a
  partial unique index `journal_entries_reverses_entry_unique` on `reverses_entry_id WHERE
  reverses_entry_id IS NOT NULL`; the delivery row is locked `FOR UPDATE` before the reversed-at
  check or the outstanding balance is computed; the reversal mark is a conditional `UPDATE … WHERE
  reversed_at IS NULL` that must affect exactly one row before any movement is written.
- **MAJOR — a paid delivery could never be corrected.** **Prevention (T-21, T-22):** supplier
  payment reversal with a reason; a delivery reversal is refused until every payment on it is
  reversed, and says so.
- **MAJOR — opening stock had no valued entry.** **Prevention (T-23, T-25):** an opening-stock entry
  per ingredient (assumption 1) posting `Dr 1200 / Cr 3000 Owner's Capital`; a count refuses a
  surplus on an ingredient that has never had a delivery or opening stock, and says why.
- **MAJOR — a count double-deducts a sale that synced after it.** **Prevention (T-25):** system
  quantity is the ledger total at posting time under the locks, and a count refuses to post while
  any `pos_sessions` row of the restaurant is `open` or any `sale.complete` op is `unrecorded` and
  unresolved (assumption 4), with the reason on the page.
- **MAJOR — pos-sales tests pin the six-event world.** **Prevention (T-13, T-08):** the accounting
  task rewrites those assertions to enumerate from the constants; `journal-guards.integration.test.ts`
  is on the EDIT list; the new triggers reuse migration 0012's `posted_record_append_only()` so
  their names end in `_append_only` and their message matches.
- **MINOR — recipe cost must never touch the POS snapshot.** **Prevention (T-18, T-34):** a separate
  reader `recipeCosts` called from `/menu`'s load; `listMenu` and `readMenuSnapshot` are untouched;
  a test asserts `/api/menu`'s body has no `cost` or `margin` key.

*Refuted, dropped* (one line each): cash deliveries double-count against the drawer (cash outside
the till is spec-normal; drawer cash is a pay-out; helper text says so, T-30) · business date
undefined for payments and reversals (assumption 9 and the form fields settle it) · recipe line
uniqueness and sign checks (house idiom; adopted in T-03) · archiving an ingredient with live
recipes (house pattern refuses; adopted in T-17) · missing sign and source CHECKs on movements
(adopted in T-04) · forms without an idempotency key (the settings page's in-flight guard is the
idiom; adopted in every form) · widening the CHECKs breaks pos-sales tests (kept as the item above)
· append-only should cover lines and payments (the spec demands DB enforcement only for balance;
added where cheap, T-08) · zero-quantity movements rejected by a CHECK (consumption skips zero
rows, T-19) · retry test not extended to movements (the op key stops a replay before the seam; a
test is added anyway, T-19) · "future sales only" wording (spec 13 and 16 cost at recording time;
wording fixed) · single-column ingredient FKs leak across tenants (new tables carry composite
targets and every read is restaurant-scoped) · recipe cost flowing into the snapshot (the MINOR
item) · audit rows outside the transaction (`writeAudit(tx, …)` takes the handle) · reversal
without a PIN (spec 8's PIN list is closed) · unbounded supplier name (zod `.max(120)`) · migration
numbers assumed (T-01 discovers them) · zero-cost movements rejecting cash sales (no such
constraint; consumption never throws for business reasons) · unnamed report indexes (named in
T-03–T-05) · business date defaulting from the server clock (derived in the restaurant's zone).

## Assumptions (the thirteen defaults)

Presented on 2026-09-28 with a default each; the user approved the plan with them. T-02 records
each in CLAUDE.md. A later "no" to any of them re-plans the tasks named.

| # | Decision | Default the plan uses | Tasks |
|---|---|---|---|
| 1 | Stock on the shelf at go-live | An opening-stock entry per ingredient (quantity in a purchase unit and a cost per unit), posting `Dr 1200 Inventory / Cr 3000 Owner's Capital` under the new event `opening_stock`; allowed only while the ingredient has no movement at all | T-04, T-13, T-23, T-28 |
| 2 | Where a late delivery's revaluation goes | 5000 Cost of Goods Sold, event `inventory_revaluation` (the alternative was 5100) | T-10, T-13, T-20, T-22 |
| 3 | Cash deliveries on the dashboard | Allowed; means cash held outside the till; drawer cash is a POS pay-out (later plan) | T-20, T-30 |
| 4 | When a count may be posted | Only when no `pos_sessions` row of the restaurant is `open` and no `sale.complete` op is `unrecorded` with `resolved_at` null | T-25, T-32 |
| 5 | Reversals | Delivery reversal and supplier-payment reversal, `admin.purchases` (owner only), reason 3–200 characters | T-21, T-22, T-31 |
| 6 | Average-cost precision | `ingredients.avg_unit_cost_micro` bigint = minor units × 1,000,000 per base unit, with a `MONEY_NAME_EXEMPT` entry | T-03, T-07, T-10 |
| 7 | Units | One base unit per ingredient as free text (1–16 characters); purchase units per ingredient with a `base_qty_per_unit`; no units table | T-03, T-17 |
| 8 | Where recipes are edited | `/inventory/recipes`; `/menu` shows cost and margin read-only | T-29, T-34 |
| 9 | A reversal's business date | The day it is made, in the restaurant's time zone | T-21, T-22 |
| 10 | Archiving an ingredient | Refused while any recipe line of a non-archived item or modifier references it | T-17 |
| 11 | Modifier deltas | Per order line and per ingredient, item quantity + modifier deltas is clamped at zero before multiplying by the line quantity | T-12, T-19 |
| 12 | Sales made offline | Costed when they reach the server, at the average then; `occurred_at` is the order's `paid_at`, business date the session's | T-19 |
| 13 | A button to rebuild cached totals | Not built; the tripwire on `/inventory` shows any difference | T-26, T-27 |

## In play

Spec: 3 (integrity rules), 6 (dashboard online-only; offline sales are facts), 13 (Deduct
Inventory inside the payment transaction), 15 (recipes, units, movements, counts, negative stock),
16 (weighted average; COGS on every sale), 17 (money and quantities; business date), 19
(purchases, Accounts Payable), 22 (reversing entries), 23 (chart), 24 (posting rules), 25 (gross
profit), 26 (inventory reports), 27 (plain indexed SQL), 29 (mandatory tests), 31 (scope), 33
(decision 7).
Invariants: 1 (money is bigint minor units; quantities numeric(12,3); no float), 2 (movements,
lines, entries permanent; corrections are reversals), 3 (every new event balances; the DB trigger
from pos-sales checks at COMMIT), 4 (consumption runs inside the sale's transaction and never
throws for business reasons), 6 (the ledger is the truth; caches written only with their
movement; sales never blocked; negative stock flagged), 7 (one rounding function), 8 (every load
and action checks its key), 10 (audit in the same transaction), 11 (business date on every
movement and entry).

## Workspace state at plan time (2026-09-28)

Main is at `1b9bc13` (PR #11 merged). **`tasks/pos-sales/` is being built in the worktree
`/home/mohamed-amiin/Desktop/matcami-pos-sales` on branch `feat/pos-sales`; at plan time its T-01
through T-15 are committed** (schema, migrations 0011 `0011_jazzy_plazm.sql` and 0012
`0012_journal_guards.sql`, sync-ops, money totals, the accounting module, audit events). **This
plan executes on the tree AFTER pos-sales merges to main.** T-01 verifies that and stops otherwise.
Every path pos-sales creates is tagged `EDIT` here with "(created by tasks/pos-sales T-NN)", exactly
as pos-sales treated PR #11's files.

Facts read from the pos-sales worktree that this plan relies on (T-01 re-verifies each on main):
`src/lib/server/accounting/posting-rules.ts` exports `POSTING_EVENTS` (six literals), `SALE_EVENTS`,
`RuleLine = { code: string; debit?: Minor; credit?: Minor }`, `saleLines`, `cogsLines`,
`overShortLines`, `eventForMethod`, `overShortEvent`, `linesBalance`; `journal.ts` exports
`JournalEntryInput` whose `sourceType` is typed `'order' | 'pos_session'` (this plan widens it),
`postEntry`, `entryLines`; `chart.ts` exports `ACCOUNT_TYPES`, `CHART`, `ensureChart`,
`accountIdByCode`; `schema/accounting.ts` declares `journal_entries_event_valid` and
`journal_entries_source_type_valid` CHECKs and `reverses_entry_id` (a nullable self-FK nothing
writes yet); migration 0012 defines `posted_record_append_only()` and four `*_append_only`
triggers; `journal-guards.integration.test.ts` counts `%_append_only` triggers;
`journal.integration.test.ts` draws `POSTING_EVENTS[i % 6]`; `constraints.integration.test.ts`
uses `'purchase'` as a rejected `source_type`. Not yet built at plan time, taken from the approved
pos-sales plan: `src/lib/server/inventory/consume.ts` (T-17: the no-op `consumeForSale(tx,
{ restaurantId, orderId, lines })` returning `{ movements: never[]; cogsMinor: Minor }`),
`src/lib/server/orders/pay.ts` (T-19: calls it after the order, lines, payments and invoice rows are
inserted and before the sale entry; posts `cogsLines(cogsMinor)` only when `cogsMinor > 0n`),
`src/lib/server/orders/sync.ts` (T-21: `handleOp`, replay by op key), `pos_sessions.business_date`
(T-05), `orders.paid_at` (T-06), `src/lib/server/reports/sales.ts` (T-35) and the `/reports` page
(T-36), `e2e/fixtures.ts` helpers (T-38).

Files this plan opens and EDITs (they exist on main, or will after pos-sales merges; each is tagged
`EDIT` with a location hint in its task):

- `CLAUDE.md`
- `e2e/fixtures.ts`
- `src/lib/components/ui/Sidebar.svelte`
- `src/lib/components/ui/sidebar.test.ts`
- `src/lib/server/accounting/README.md`
- `src/lib/server/accounting/index.ts`
- `src/lib/server/accounting/journal-guards.integration.test.ts`
- `src/lib/server/accounting/journal.integration.test.ts`
- `src/lib/server/accounting/journal.ts`
- `src/lib/server/accounting/posting-rules.test.ts`
- `src/lib/server/accounting/posting-rules.ts`
- `src/lib/server/audit/events.ts`
- `src/lib/server/audit/audit.test.ts`
- `src/lib/server/db/schema/accounting.ts`
- `src/lib/server/db/schema-guards/constraints.integration.test.ts`
- `src/lib/server/db/schema-guards/schema.test.ts`
- `src/lib/server/db/test/reset.ts`
- `src/lib/server/db/migrations/meta/_journal.json`
- `src/lib/server/inventory/README.md`
- `src/lib/server/inventory/consume.ts`
- `src/lib/server/inventory/consume.test.ts`
- `src/routes/(dashboard)/dashboard/event-text.ts`
- `src/routes/(dashboard)/dashboard/event-text.test.ts`
- `src/routes/(dashboard)/menu/+page.server.ts`
- `src/routes/(dashboard)/menu/+page.svelte`
- `src/routes/(dashboard)/menu/menu-page.integration.test.ts`
- `src/routes/api/menu/menu-api.integration.test.ts`

Every other path in this plan is NEW to the task that first names it and EXTEND to every later
task. **Stop and report a mismatch only** when a path tagged `NEW` in the task you are about to run
already exists, or a path tagged `EXTEND`/`EDIT` does not.

## Shared contracts (every task uses these names; do not rename)

### Quantities — `src/lib/money/quantity.ts` (T-09)

Quantities are ingredient amounts in the ingredient's base unit, stored as `numeric(12,3)` and
named `*_qty` (the schema guard's one fixed-point type). In TypeScript a quantity is a bigint of
**thousandths**: `1500n` is 1.500. pg returns numeric as a string; it is parsed ONCE by `parseQty`.
The file imports only `./index`.

```ts
declare const QTY: unique symbol;
export type Qty = bigint & { readonly [QTY]: true };     // thousandths of a base unit
export const QTY_SCALE = 1000n;
export const QTY_MAX = 999_999_999_999n;                  // numeric(12,3) bound, in thousandths
export function qty(value: bigint): Qty;                  // the ONLY constructor; throws outside ±QTY_MAX
export function parseQty(text: string): Qty;              // '2', '2.5', '-30.000', '0.030' → throws on >3 decimals, exponent, spaces inside, empty
export function formatQty(q: Qty): string;                // always 3 decimals: 2500n → '2.500', -30n → '-0.030'; used for DB writes and display
export function addQty(a: Qty, b: Qty): Qty;
export function subQty(a: Qty, b: Qty): Qty;
export function negQty(a: Qty): Qty;
export function sumQty(values: readonly Qty[]): Qty;      // seeded with 0n
export function mulQty(a: Qty, b: Qty, rule: RoundingRule): Qty;  // a × b / 1000, rounded once by roundToMinor
export function qtyExact(q: Qty): Exact;                  // exact(q, 1000n)
```

`roundToMinor` is THE rounding function (invariant 7); a quantity result is unwrapped from its
`Minor` brand with `toBigInt` and re-branded with `qty()`. A second rounding helper is a bug.

### Costing — `src/lib/money/costing.ts` (T-10, T-11)

Imports only `./index`, `./quantity` and `./tax`. Money is `Minor`; the average is a bigint of
**micro minor units per base unit** (`avgMicro`): $5.50 per kg with a base unit of grams is 0.55
cents per gram = `550_000n`. `MICRO = 1_000_000n`.

```ts
export type StockState = { qty: Qty; value: Minor; avgMicro: bigint };
export type Applied = { state: StockState; costMinor: Minor; revaluationMinor: Minor };
export function valueAt(q: Qty, avgMicro: bigint, rule: RoundingRule): Minor;
export function unitCostMicro(value: Minor, q: Qty, rule: RoundingRule): bigint;
export function applyInbound(s: StockState, inQty: Qty, costMinor: Minor, rule: RoundingRule): Applied;
export function applyAtAverage(s: StockState, moveQty: Qty, direction: 'out' | 'in', rule: RoundingRule): Applied;
export function applyReversal(s: StockState, outQty: Qty, originalCostMinor: Minor, rule: RoundingRule): Applied;
export function extendCost(unitQty: Qty, unitCostMinor: Minor, rule: RoundingRule): Minor;
export function recipeCostExact(lines: readonly { qty: Qty; avgMicro: bigint }[]): Exact;
export function dishMargin(args: { priceMinor: Minor; taxRateBp: number; taxMode: TaxMode; costExact: Exact }, rule: RoundingRule): { costMinor: Minor; netPriceMinor: Minor; marginMinor: Minor };
```

The rules, verbatim (the BLOCKER's prevention):

- `valueAt(q, avg) = q === 0n ? 0n : roundToMinor(exact(q × avg, 1000n × MICRO))`.
- `unitCostMicro(value, q) = toBigInt(roundToMinor(exact(value × 1000n × MICRO, q)))`, only for `q > 0n`.
- **applyInbound** (delivery line, opening stock; `inQty > 0n`, `cost >= 0n`): `costMinor = cost`.
  If `s.qty > 0n`: `qty' = qty + in`, `value' = value + cost`, `avg' = unitCostMicro(value', qty')`,
  `revaluation = 0`. If `s.qty <= 0n` (zero or negative stock): `avg' = toBigInt(roundToMinor(
  exact(cost × 1000n × MICRO, in)))`, `qty' = qty + in`, `value' = qty' === 0n ? 0n :
  roundToMinor(exact(qty' × cost, in))` (the delivery's own unit cost, full precision),
  `revaluation = value' − (value + cost)`.
- **applyAtAverage 'out'** (sale consumption, waste, count shortfall, comp; `moveQty > 0n`):
  `qty' = qty − move`, `target = valueAt(qty', avg)`, `costMinor = min(0n, target − value)`,
  `value' = value + costMinor`, `avg' = avg`, `revaluation = 0`.
- **applyAtAverage 'in'** (count surplus; `moveQty > 0n`): `qty' = qty + move`, `target =
  valueAt(qty', avg)`, `costMinor = max(0n, target − value)`, `value' = value + costMinor`,
  `avg' = avg`, `revaluation = 0`.
- **applyReversal** (delivery reversal at the ORIGINAL line cost; `outQty > 0n`, `cost >= 0n`):
  `costMinor = −cost`, `qty' = qty − out`, `raw = value − cost`. If `qty' > 0n` and `raw > 0n`:
  `avg' = unitCostMicro(raw, qty')`, `value' = raw`, `revaluation = 0`. Otherwise: `avg' = avg`,
  `value' = valueAt(qty', avg)`, `revaluation = value' − raw`.
- After every rule: `avgMicro >= 0n`; `qty === 0n ⇒ value === 0n`; `qty > 0n ⇒ value >= 0n`;
  `value' − value === costMinor + revaluationMinor`. The same three are CHECKs on `ingredients`.
- `extendCost(unitQty, unitCost) = roundToMinor(exact(unitQty × unitCost, 1000n))`.
- `recipeCostExact` sums `exact(q × avg, 1000n × MICRO)` over the lines with no rounding.
  `dishMargin` rounds the cost ONCE (`costMinor = roundToMinor(costExact)`), rounds the net price
  ONCE (`netPriceMinor = roundToMinor(taxOnLine(price, rate, mode).net)` — exclusive: the price;
  inclusive: price × 10000 / (10000 + rate)), and computes `marginMinor = netPriceMinor −
  costMinor` as a subtraction, so the three figures the menu page shows always add up.
- Display of an average: the pages show the average cost per purchase unit as
  `valueAt(qty(baseQtyPerUnit), avgMicro)` (e.g. per kg), or per one base unit when the ingredient
  has no purchase unit — no other conversion exists.

### The ledger writer — `src/lib/server/inventory/movements.ts` (T-16)

```ts
export const MOVEMENT_TYPES = ['purchase','purchase_reversal','opening_stock','sale_consumption','waste','count_adjustment','comp','revaluation'] as const;
export const MOVEMENT_SOURCES = ['purchase','order','waste_entry','stock_count','opening_stock'] as const;
export type MovementRequest =
  | { kind: 'inbound'; type: 'purchase' | 'opening_stock'; ingredientId: string; qty: Qty; costMinor: Minor }
  | { kind: 'out'; type: 'sale_consumption' | 'waste' | 'count_adjustment' | 'comp'; ingredientId: string; qty: Qty }
  | { kind: 'in'; type: 'count_adjustment'; ingredientId: string; qty: Qty }
  | { kind: 'reversal'; type: 'purchase_reversal'; ingredientId: string; qty: Qty; originalCostMinor: Minor };
export type MovementContext = { restaurantId: string; sourceType: (typeof MOVEMENT_SOURCES)[number]; sourceId: string; businessDate: string; occurredAt: Date; recordedByUserId: string | null };
export type LockedIngredient = { id: string; name: string; state: StockState; archivedAt: Date | null; hasInboundHistory: boolean };
export async function lockIngredients(tx: DbTx, restaurantId: string, ids: readonly string[]): Promise<Map<string, LockedIngredient>>;
export async function applyMovements(tx: DbTx, ctx: MovementContext, requests: readonly MovementRequest[]): Promise<{ movements: StockMovementRow[]; costMinor: Minor; revaluationMinor: Minor }>;
```

`lockIngredients` runs ONE statement: `select … from ingredients where restaurant_id = $1 and id =
any($2) order by id for update`, throws if any id is missing (a programming error or tampering,
never a business state). `applyMovements` locks the distinct ids first, applies the requests in
the order given against the locked states with the costing rules and `ROUNDING_RULE`, inserts one
`stock_movements` row per request (skipping none: callers never send a zero quantity) plus one
`revaluation` row (qty `0.000`) per request whose `revaluationMinor ≠ 0n`, writes each ingredient's
`on_hand_qty`, `inventory_value_minor`, `avg_unit_cost_micro` ONCE at the end, and returns the rows
and the two sums. **It is the only code that inserts into `stock_movements` or updates the three
cache columns.** It never opens a transaction and never writes a journal entry (callers post).

### Posting — `src/lib/server/accounting/posting-rules.ts` and `journal.ts` (T-13, T-14)

`POSTING_EVENTS` gains, in this order after pos-sales' six: `'purchase_paid', 'purchase_on_credit',
'supplier_paid', 'waste', 'stock_count_shortfall', 'stock_count_surplus', 'inventory_revaluation',
'opening_stock'` (fourteen). New `JOURNAL_SOURCE_TYPES = ['order', 'pos_session', 'purchase',
'supplier_payment', 'waste_entry', 'stock_count', 'opening_stock'] as const`; `JournalEntryInput.
sourceType` becomes `(typeof JOURNAL_SOURCE_TYPES)[number]`. New pure rule functions (spec 24
verbatim; nobody types a debit):

| Function | Lines | Event |
|---|---|---|
| `purchaseLines(paidBy: 'cash'\|'bank'\|'credit', total)` | Dr 1200 Inventory total / Cr 1000 Cash on Hand \| 1010 Bank \| 2000 Accounts Payable total | `purchaseEvent(paidBy)`: `purchase_paid` for cash and bank, `purchase_on_credit` for credit |
| `supplierPaymentLines(paidFrom: 'cash'\|'bank', amount)` | Dr 2000 / Cr 1000 \| 1010 | `supplier_paid` |
| `wasteLines(cost)` | Dr 5100 Waste & Inventory Adjustments / Cr 1200 | `waste` |
| `countShortfallLines(amount)` | Dr 5100 / Cr 1200 | `stock_count_shortfall` |
| `countSurplusLines(amount)` | Dr 1200 / Cr 5100 | `stock_count_surplus` |
| `revaluationLines(net)` (signed) | net < 0: Dr 5000 \|net\| / Cr 1200; net > 0: Dr 1200 / Cr 5000; 0: `[]` | `inventory_revaluation` |
| `openingStockLines(value)` | Dr 1200 / Cr 3000 Owner's Capital | `opening_stock` |

Every amount argument is a non-negative `Minor` except `revaluationLines`. `postReversal(tx,
{ restaurantId, entryId, businessDate, memo }): Promise<{ entryId: string }>` in `journal.ts`
reads the original entry and its lines scoped to the restaurant, refuses an entry that is itself a
reversal, and inserts a mirror (debit ↔ credit) with the same `event`, `source_type` and
`source_id`, `reverses_entry_id = entryId`; the partial unique index makes a second reversal fail
with 23505 on `journal_entries_reverses_entry_unique`. It is the ONLY way a reversal is created.

### Inventory module — `src/lib/server/inventory/` (T-12, T-16 – T-26)

Every function takes the caller's `tx` (or `Executor` for reads) and an explicit `restaurantId`;
write functions return discriminated results `{ ok: true, … } | { ok: false, reason }` for business
refusals and throw only for programming errors; each writes its audit row in the same transaction.

- `consumption.ts` (T-12): `aggregateConsumption(lines: SaleLine[], recipes: RecipeIndex): Map<string, Qty>` — pure.
- `ingredients.ts` (T-17): `createIngredient`, `updateIngredient`, `archiveIngredient`, `addPurchaseUnit`, `archivePurchaseUnit`, `listIngredients`, `getIngredient`.
- `recipes.ts` (T-18): `setRecipe(tx, ctx, { owner: { kind: 'item' | 'modifier'; id }, lines })`, `readRecipes`, `recipeIndexFor(tx, restaurantId, itemIds, modifierIds)`, `recipeCosts(db, restaurantId)`.
- `consume.ts` (T-19): `consumeForSale(tx, { restaurantId, orderId, lines }): Promise<{ movements: StockMovementRow[]; cogsMinor: Minor }>` — same signature pos-sales T-17 created.
- `purchases.ts` (T-20, T-22): `recordPurchase`, `reversePurchase`, `listPurchases`, `getPurchase`.
- `payments.ts` (T-21): `paySupplier`, `reverseSupplierPayment`, `outstandingMinor`.
- `opening.ts` (T-23): `recordOpeningStock`.
- `waste.ts` (T-24): `recordWaste`.
- `counts.ts` (T-25): `countBlockers`, `postCount`.
- `reports.ts` (T-26): `currentStock`, `movementLog`, `consumptionByDate`, `wasteByDate`, `countDifferences`, `negativeStock`, `cogsByDate`, `reconciliation`.
- `business-date.ts` (T-16): `todayInZone(executor, restaurantId): Promise<string>` — `to_char(now() at time zone restaurant_settings.time_zone, 'YYYY-MM-DD')` in SQL, never JavaScript.

### Pages (T-27 – T-34)

`/inventory`, `/inventory/[id]`, `/inventory/recipes`, `/inventory/waste`, `/inventory/counts`,
`/inventory/counts/[id]`, `/inventory/reports` (all `admin.inventory`); `/purchases`,
`/purchases/new`, `/purchases/[id]` (all `admin.purchases`); the `/menu` cost column
(`admin.menu`, as today). Each load formats every bigint with the money formatter or `formatQty`;
the `.svelte` files do no arithmetic. Each form carries the settings page's in-flight guard
(`submitting` flag, disabled button labelled "Saving…"), and each action ends in a 303 redirect
(POST-redirect-GET) on success. The sidebar's `NavItem` href union gains `'/inventory'` and
`'/purchases'`; neither path begins with the characters `pos` (CLAUDE.md's service-worker rule).

## Execution notes

- Phases and files: **0 decisions** (`01`), **1 schema** (`02`), **2 domain core** (`03` quantity and
  costing, `04` accounting), **3 ledger and sales** (`05`), **4 deliveries, corrections, counts,
  waste and reports** (`06`, `07`), **5 dashboard** (`08`), **6 verification** (`09`). Unit and
  integration tests ship inside the task that writes the code; `09` holds only what spans layers.
- Execute in task-ID order unless `Needs:` says otherwise. One commit per task, message
  `T-NN <type>(<scope>): <title>`.
- Nothing in this plan `UPDATE`s or `DELETE`s a stock movement, a purchase line, a count line, a
  waste entry, an opening-stock entry, a journal entry or a journal line (invariant 2). The updates
  that exist: the three cache columns on `ingredients` (only inside `applyMovements`), the
  `reversed_*` and `journal_entry_id` columns on `purchases` and `supplier_payments` (written once),
  and configuration rows (`ingredients` name/unit/archive, purchase units, recipe lines).
- Recipe lines are configuration, not posted records: `setRecipe` replaces an owner's rows (delete
  and insert in one transaction), exactly as `unlinkModifierGroup` deletes a link on main.

## Task index (every task in this plan)

| ID | Title | File | Needs |
|---|---|---|---|
| T-01 | Verify pos-sales is merged and every inherited contract is as this plan expects | 01-decisions.md | – |
| T-02 | Record the thirteen inventory decisions in CLAUDE.md | 01-decisions.md | T-01 |
| T-03 | Schema: `ingredients`, `ingredient_purchase_units`, `recipe_lines` | 02-schema.md | T-02 |
| T-04 | Schema: `stock_movements`, `opening_stock_entries`, `waste_entries`, `stock_counts`, `stock_count_lines` | 02-schema.md | T-03 |
| T-05 | Schema: `purchases`, `purchase_lines`, `supplier_payments` | 02-schema.md | T-03 |
| T-06 | Widen the journal CHECKs and add the one-reversal-per-entry index | 02-schema.md | T-02 |
| T-07 | Generate migration 0013; the schema guards, the exemption, the reset list and the constraint tests | 02-schema.md | T-03, T-04, T-05, T-06 |
| T-08 | Custom migration 0014: append-only triggers on the inventory records; prove them | 02-schema.md | T-07 |
| T-09 | `src/lib/money/quantity.ts`: quantities as bigint thousandths | 03-costing.md | T-02 |
| T-10 | `src/lib/money/costing.ts`: the value-conserving movement rules and their property test | 03-costing.md | T-09 |
| T-11 | Recipe cost, dish margin and extended cost | 03-costing.md | T-10 |
| T-12 | `aggregateConsumption`: recipes × sale lines with modifier deltas clamped at zero | 03-costing.md | T-09 |
| T-13 | Posting rules for the eight new events; rewrite the pinned pos-sales assertions | 04-accounting.md | T-07 |
| T-14 | `postReversal` and the extended journal balance property test | 04-accounting.md | T-13 |
| T-15 | Audit events for inventory, deliveries, payments, waste, counts and opening stock | 05-ledger-and-sales.md | T-02 |
| T-16 | `applyMovements`: the one ledger writer with ordered row locks; concurrency tests | 05-ledger-and-sales.md | T-08, T-10 |
| T-17 | Ingredients and purchase units: create, update, archive | 05-ledger-and-sales.md | T-15, T-16 |
| T-18 | Recipes: `setRecipe`, `recipeIndexFor` and the `recipeCosts` reader | 05-ledger-and-sales.md | T-11, T-17 |
| T-19 | `consumeForSale`: recipe × quantity through the ledger writer; COGS on every sale | 05-ledger-and-sales.md | T-12, T-18 |
| T-20 | `recordPurchase`: delivery lines, unit conversion, movements, revaluation, entries | 06-purchases-and-corrections.md | T-13, T-17 |
| T-21 | Supplier payments: `paySupplier` and `reverseSupplierPayment` | 06-purchases-and-corrections.md | T-20 |
| T-22 | `reversePurchase`: mirror movements and entries at the original cost | 06-purchases-and-corrections.md | T-14, T-21 |
| T-23 | `recordOpeningStock` | 06-purchases-and-corrections.md | T-13, T-17 |
| T-24 | `recordWaste` | 07-counts-waste-reports.md | T-13, T-15, T-16 |
| T-25 | Stock counts: `countBlockers` and `postCount` | 07-counts-waste-reports.md | T-20, T-23, T-24 |
| T-26 | The inventory reports and the cache-vs-ledger tripwire | 07-counts-waste-reports.md | T-19, T-22, T-25 |
| T-27 | `/inventory` and the Inventory and Purchases rail items | 08-dashboard.md | T-26 |
| T-28 | `/inventory/[id]`: units, opening stock, archive, the movement log | 08-dashboard.md | T-27 |
| T-29 | `/inventory/recipes`: the recipe editor | 08-dashboard.md | T-27 |
| T-30 | `/purchases` and `/purchases/new` | 08-dashboard.md | T-27 |
| T-31 | `/purchases/[id]`: pay, reverse a payment, reverse the delivery | 08-dashboard.md | T-30 |
| T-32 | `/inventory/waste`, `/inventory/counts` and `/inventory/counts/[id]` | 08-dashboard.md | T-27 |
| T-33 | `/inventory/reports` | 08-dashboard.md | T-27 |
| T-34 | Cost and margin on `/menu` | 08-dashboard.md | T-18 |
| T-35 | e2e: from delivery to cost of goods sold | 09-verification.md | T-28, T-29, T-30, T-33, T-34 |
| T-36 | Docs: CLAUDE.md layout and glossary, module READMEs | 09-verification.md | T-34 |
| T-37 | Final verification: every check, every test, no schema drift, the quality checklist | 09-verification.md | T-35, T-36 |
