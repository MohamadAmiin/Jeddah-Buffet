# Phase 5 (UI) — the dashboard (T-35, T-36, T-37)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 1, Phase 2 and Phase 4
> (T-29's accepted-tender setting: the shared fixture enables card, and a card sale is refused
> outright until that setting exists).

Three rules govern this file and every task in it. First, the report is a READ of stored columns
and nothing else: `orders.subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`,
`payments.amount_minor` and the per-line snapshot are summed as the integers they are; nothing here
calls `computeOrderTotals`, `roundToMinor` or `taxOnAmount`, because a report that recomputes is a
second opinion about a sale the journal has already posted (invariant 7; spec 17's "one rounding
rule" is satisfied by never rounding at all here). Every figure is grouped by
`pos_sessions.business_date` — the date the cashier's shift belongs to — and NEVER by
`created_at::date` or any timestamp cast: a sale rung up at 01:30 belongs to the evening shift that
was still open (spec 10, 17; invariant 11). The queries are plain SQL over the indexes T-05–T-07
named, and stay that way until a report is measurably slow (spec 27: "well-indexed SQL queries on
PostgreSQL are enough"). Second, `/reports/flagged` is the owner's surface for spec 6's rule that
a synced sale which fails validation "is stored and flagged for owner review, never discarded":
every `pos_sync_ops` row that is not `accepted` is shown there with what the till recorded, and the
owner's only two moves are retry under the same op key and dismiss with a reason — neither edits a
posted record. Third, a dashboard page composes the primitives in `src/lib/components/ui/` —
`Card`, `PageHeader`, `Alert`, `Button`, `Field`, `StatusMark` — as `docs/design-system.md` §7b
lays down: Tailwind's default scale, `bg-raise` cards on the `bg-bg` ground, money in `font-mono
tabular-nums text-right` through the money module's formatter, a glyph beside every status colour,
at most one `role="alert"` region per page, and no money arithmetic in a `.svelte` file. By T-02's
convention, `src/lib/server/reports/` is called by `(dashboard)` routes only and calls no other
server module: it imports the Drizzle schema, the `Executor` type, and the isomorphic
`src/lib/money` and `src/lib/sync-ops` — nothing from `orders/`, `pos-sessions/` or
`accounting/`. Report scope is assumption 8 of `00-overview.md`: sales, sessions and flagged ops
only; journal and trial-balance views are a later plan.

### T-35 — The sales report query module

**Needs:** T-09 (the tables and the deferred balance trigger exist), T-11 (`changeDue`; implies
T-10's `computeOrderTotals`/`serializeTotals`), T-19 (`recordSale`; implies T-12's chart
initializer, T-14's journal writer and T-18's `validateSale`), T-20 (`openSession`/`closeSession`),
T-29 (the `acceptsCard` field on `SettingsChanges` — Phase 4, `07-sync-api.md`; without it sale B
below is refused as `tender_not_accepted` and `recordSaleAt` throws). The fixture in step 9 cannot
compile or run without every one of them, so T-35 must NOT start before T-29 has run — plain
task-ID order already satisfies this; a session that schedules by `Needs:` alone must honour it
too.
**Files:**
- `src/lib/server/reports/sales.ts` — NEW
- `src/lib/server/reports/sales.integration.test.ts` — NEW
- `src/lib/server/reports/README.md` — NEW
- `src/lib/server/db/test/sales.ts` — NEW (the sale-recording fixture the three test files of this
  phase share; see Do step 9)
**Spec:** 25 (Gross Sales − Discounts = Net Sales; the profit model the totals card follows), 26
("Sales by Product", "by Category", "by Payment Method", "by Order Type (dine-in / takeaway)", "by
Employee"; "Cashier Sessions", "Opening Cash", "Expected Cash", "Actual Cash", "Cash Difference"),
27 (plain indexed SQL for the MVP), 10 (a session belongs to one business date; a 01:30 sale
belongs to the previous business day), 17 ("Reports group sales by business date (the POS
session's date)"), 6 (a sale that fails validation is stored and flagged for owner review)
**Invariants:** 1 (money is integer minor units in `bigint`), 2 (posted records are permanent —
this module only reads), 7 (each line snapshots its own numbers; one rounding rule — the report
never rounds), 11 (business date, not calendar date)

**Do:**
1. Create the directory and its README. `src/lib/server/reports/README.md` states, in this order:
   the module holds read-only report queries over STORED columns; every function takes
   `restaurantId` explicitly and filters on it inside the query; figures are grouped by
   `pos_sessions.business_date`, never by a timestamp cast; nothing in the module imports
   `computeOrderTotals`, `roundToMinor`, `taxOnAmount` or `taxOnLine`, and nothing divides,
   multiplies by a fraction or rounds — a SQL `sum()` of integer columns is the only arithmetic;
   money columns are read as `bigint` (`mode: 'bigint'` on the schema, `BigInt(string)` on a
   `sum()` result) and never as `number`; the module is called by `(dashboard)` routes only and
   calls no other server module (T-02's convention (j)); it is never imported by client code or by
   `src/lib/pos/`. Close with `Spec 10, 17, 25, 26, 27. Invariants 1, 7, 11.`
2. In `sales.ts`, import `type { Executor } from '../auth/session'` (the `Db | DbTx` read type
   every reader in `src/lib/server` takes), `sql`, `and`, `eq`, `desc`, `asc` from `drizzle-orm`,
   the schema tables `orders`, `orderLines`, `orderLineModifiers`, `payments` (T-06's file),
   `posSessions` (T-05), `posSyncOps` (T-07), `posDevices`, `users`, `menuItems`, `menuCategories`,
   and `minor, type Minor` from `'../../money'`. Open each schema file before writing a query and
   use the column NAMES it declares; the names below are what the overview and T-05–T-07 specify
   (`orders`: `restaurant_id`, `pos_session_id`, `employee_user_id`, `order_type`, `status`,
   `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`, `tax_mode`, `paid_at`;
   `order_lines`: `order_id`, `menu_item_id`, `item_name`, `quantity`, `unit_price_minor`,
   `tax_rate_bp`, `discount_minor`, `status`; `order_line_modifiers`: `order_line_id`,
   `price_delta_minor`; `payments`: `order_id`, `method`, `amount_minor`; `pos_sessions`: `id`,
   `restaurant_id`, `device_id`, `business_date`, `opened_at`, `closed_at`, `status`,
   `opening_cash_minor`, `expected_cash_minor`, `counted_cash_minor`, `difference_minor`;
   `pos_sync_ops`: `restaurant_id`, `pos_session_id`, `status`, `resolved_at`). If a schema file
   spells one differently, the schema wins — change the query, not the schema.
3. Export the result type, with `bigint` money left as `Minor` (the page formats; this module
   never produces a string for money):
   ```ts
   export type SalesReport = {
   	businessDate: string; // 'YYYY-MM-DD'
   	totals: { grossSales: Minor; discounts: Minor; netSales: Minor; tax: Minor; takings: Minor;
   		orderCount: number };
   	byTender: { method: 'cash' | 'card' | 'mobile'; amount: Minor; count: number }[];
   	byOrderType: { orderType: 'dine_in' | 'takeaway'; amount: Minor; count: number }[];
   	byEmployee: { userId: string | null; displayName: string; amount: Minor; count: number }[];
   	byItem: { menuItemId: string; itemName: string; quantity: number; amount: Minor }[];
   	byCategory: { categoryId: string | null; name: string; quantity: number; amount: Minor }[];
   	sessions: { id: string; deviceCode: string; openedAt: Date; closedAt: Date | null;
   		openingCash: Minor; expectedCash: Minor | null; countedCash: Minor | null;
   		difference: Minor | null; status: 'open' | 'closed' }[];
   	flagged: { count: number; unrecordedCount: number };
   };
   ```
4. Export `defaultReportDate(database: Executor, restaurantId: string, now: Date):
   Promise<string>`. Two steps, both in SQL. (a) Select `business_date` from `pos_sessions` where
   `restaurant_id = $restaurantId` and `opened_at >= $now − interval '24 hours'` and
   `opened_at <= $now`, `order by opened_at desc limit 1`; if a row comes back, return its
   `business_date` (a `'YYYY-MM-DD'` string: the column is Drizzle `date(…, { mode: 'string' })`
   and the node-postgres driver hands `date` through unparsed). (b) Otherwise read the restaurant's
   `time_zone` from `restaurant_settings` and return one value computed in SQL from the `now`
   argument, not from `now()`: `select to_char(($now::timestamptz) at time zone $tz,
   'YYYY-MM-DD')` — `to_char` yields text, so no driver can turn it into a `Date`. `now` is a
   parameter so the tests can pin the clock; the route passes `new Date()`. The upper bound
   `opened_at <= $now` matters: a session opened at 01:30 must not decide the default at 00:40.
5. Export `salesReport(database: Executor, restaurantId: string, businessDate: string):
   Promise<SalesReport>`. First `if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new
   RangeError(...)` (the route validates first; this is the second layer). Then one query per
   section, each carrying the same three filters — `orders.restaurant_id = $rid`, `orders.status
   = 'paid'`, and a join `pos_sessions s on s.id = orders.pos_session_id and s.restaurant_id =
   $rid and s.business_date = $date` — written once as a shared `sql` fragment or subquery and
   reused, so no section can drift to `created_at::date`:
   - **totals**: `count(*)::int` as `orderCount`; `coalesce(sum(subtotal_minor), 0)::bigint`,
     `coalesce(sum(discount_minor), 0)::bigint`, `coalesce(sum(tax_minor), 0)::bigint`. Takings is
     a second query over `payments p join orders o on o.id = p.order_id` with the same three
     filters: `coalesce(sum(p.amount_minor), 0)::bigint`. `netSales = subtract(grossSales,
     discounts)` through `src/lib/money`. `sum()` of a `bigint` column is `numeric` in Postgres and
     pg returns it as a STRING; the `::bigint` cast keeps it integral and `minor(BigInt(value))`
     turns it into money. Never `Number()`, never `mode: 'number'`.
   - **byTender**: from `payments` with the same joins, `group by p.method`: `method`,
     `coalesce(sum(p.amount_minor), 0)::bigint`, `count(*)::int`. Return ALL THREE methods in the
     fixed order cash, card, mobile — a method with no payments gets `{ amount: 0n, count: 0 }` —
     so the page's table has a stable shape.
   - **byOrderType**: from `orders`, `group by order_type`: `sum(total_minor)::bigint`,
     `count(*)::int`; always both rows, `dine_in` then `takeaway`, zero-filled.
   - **byEmployee**: from `orders left join users u on u.id = orders.employee_user_id and
     u.restaurant_id = $rid`, `group by orders.employee_user_id, u.display_name`:
     `sum(total_minor)::bigint`, `count(*)::int`, ordered by amount desc then name. A null
     `display_name` (an employee the sale could not be matched to — the `employee_unknown` soft
     flag) is returned as `displayName: 'Unknown employee'` with `userId: null`; the raw id is
     never the label.
   - **byItem**: from `order_lines ol join orders o on o.id = ol.order_id` with the three filters
     on `o`, plus `ol.restaurant_id = $rid` and `ol.status <> 'voided'` (nothing writes `voided`
     in this plan; the filter is there so a later void plan cannot inflate the report), `left join
     (select order_line_id, sum(price_delta_minor) as delta from order_line_modifiers group by
     order_line_id) m on m.order_line_id = ol.id`. Per row, `group by ol.menu_item_id,
     ol.item_name`: `quantity = sum(ol.quantity)::int` and `amount = coalesce(sum(
     (ol.unit_price_minor + coalesce(m.delta, 0)) * ol.quantity - ol.discount_minor), 0)::bigint`
     — the stored unit price plus the stored modifier deltas, times the stored quantity, minus the
     stored line discount; an integer sum of stored columns and nothing else. Order by amount desc,
     then `item_name`. The label is `ol.item_name` as the line snapshotted it, never
     `menu_items.name`: a rename must not rewrite past sales.
   - **byCategory**: the same source and the same per-line expression, joined `menu_items mi on
     mi.id = ol.menu_item_id and mi.restaurant_id = $rid left join menu_categories c on c.id =
     mi.category_id`, `group by c.id, c.name`. Order by amount desc, then `c.name`, exactly as
     `byItem` (the test's deep-equal expects Food `2450n` before Drinks `600n`). A line stores no
     category, so the category is the item's CURRENT one (categories are archived, never deleted,
     so the join always resolves; a null still maps to `{ categoryId: null, name: 'Uncategorised' }`).
   - **sessions**: from `pos_sessions s join pos_devices d on d.id = s.device_id` where
     `s.restaurant_id = $rid and s.business_date = $date`, ordered by `opened_at asc`; map
     `opening_cash_minor` to `Minor` and the three close-time columns to `Minor | null` — an open
     session has `expectedCash`, `countedCash` and `difference` all `null` because close is what
     writes them (this module reads stored columns; it does not call T-20's `expectedCash`).
   - **flagged**: from `pos_sync_ops x join pos_sessions s on s.id = x.pos_session_id and
     s.restaurant_id = $rid` where `x.restaurant_id = $rid and s.business_date = $date and
     x.status <> 'accepted' and x.resolved_at is null`: `count(*)::int` and `count(*) filter
     (where x.status = 'unrecorded')::int`. `resolved_at` is the resolution stamp T-07's verbatim
     schema gives the row (beside `resolved_by_user_id` and `resolution`, CHECK `in ('retried',
     'dismissed')`) and T-21's `retryOp` AND `dismissOp` both write; the predicate is "not clean
     and not yet resolved by retry or dismiss" — the one T-07's partial index
     `pos_sync_ops_restaurant_unresolved_idx` is built for, so a retried-but-flagged op does NOT
     count. An `unrecorded` op whose `pos_session_id`
     matches no session (`unknown_session`) cannot be dated and appears only on `/reports/flagged`
     (T-37), never in a date's count; say so in a comment.
6. Every parameter is bound (`${restaurantId}` inside a `sql` template or the query builder's
   `eq`), never interpolated into the string. Every `bigint` column is read through the schema's
   `mode: 'bigint'` mapping; every aggregate is cast `::bigint` and converted with
   `minor(BigInt(row.value))`; every count is `::int` so pg returns a JavaScript number. Seed no
   reduce with `0`; the only additions are the two `subtract`/`sum` calls from `src/lib/money`.
7. Forbidden anywhere in `sales.ts`: `computeOrderTotals`, `roundToMinor`, `taxOnAmount`,
   `taxOnLine`, `Number(`, `parseFloat`, `toFixed`, `Math.`, a float literal, `/` on a money
   value, `::date` applied to `created_at`, `paid_at`, `opened_at` or any other timestamp, and
   `now()` (the clock is always the `now` argument) — not even inside a comment: the Done-when
   grep matches comments too, so write `the database clock` instead of the function name.
8. The indexes these queries rely on already exist by name from the schema tasks —
   `pos_sessions_restaurant_business_date_idx` on `(restaurant_id, business_date)`,
   `orders_restaurant_session_idx` on `(restaurant_id, pos_session_id)`, `payments_order_idx` on
   `(order_id)`, `order_lines_order_line_no_unique` (a UNIQUE constraint on `(order_id, line_no)`
   whose leading column is `order_id`, which serves the join — there is no plain `order_lines
   (order_id)` index and none is needed), `order_line_modifiers_line_idx` on `(order_line_id)`,
   `pos_sync_ops_session_idx` on `(pos_session_id)` and the PARTIAL
   `pos_sync_ops_restaurant_unresolved_idx` on `(restaurant_id, received_at) where status <>
   'accepted' and resolved_at is null` (there is no `pos_sync_ops (restaurant_id, status)` index);
   check `src/lib/server/db/schema/` for each by these names and, if one is missing, stop and
   report rather than adding a migration here (spec 27: index, do not summarise).
9. Write the shared fixture `src/lib/server/db/test/sales.ts` beside `seed.ts` (PR #11's
   precedent for a test-only seeding module). First `ls src/lib/server/db/test/`: if T-19 or T-21
   already left a helper there that records a sale through `validateSale` + `recordSale`, EXTEND
   that file with whatever is missing from the list below instead of creating a second one, and
   say which in the commit message. The fixture exports:
   - `seedSalesRestaurant(db, opts?: { taxMode?: TaxMode; taxRateBp?: number; timeZone?: string })`
     → `{ restaurantId, ownerId, staffId, deviceId, deviceCode, menuVersion, taxMode, taxRateBp,
     currencyCode: 'USD', items: { burger: string; tea: string; special: string },
     modifiers: { extraCheese: string } }`. The WHOLE seed runs inside ONE `db.transaction`
     (`updateSettings` takes a `DbTx`, not an `Executor`). Defaults: `taxMode: opts.taxMode ??
     'exclusive'`, `taxRateBp: opts.taxRateBp ?? 1000`, `timeZone: opts.timeZone ??
     'Africa/Mogadishu'` (UTC+3, no daylight saving — every date assertion in this file's three
     test files assumes it; a `'UTC'` default puts sale C on the 29th and fails them all). It
     inserts a `restaurants` row; runs `onRestaurantCreated(tx, id, { restaurantName, timeZone })`
     with that resolved `timeZone` (settings row, default roles, and T-12's chart of accounts — the
     journal writer refuses a restaurant with no chart); calls `updateSettings(tx, id, { taxMode,
     taxRateBp, currencyCode: 'USD', posIdleLockSeconds: 120, acceptsCard: true }, ctx)` where
     `ctx: UpdateSettingsContext = { actorUserId: null, ip: null, userAgent: null }` (the owner row
     does not exist yet at this point; a null actor is what the type allows) and `acceptsCard` is
     the accepted-tender field T-29 added so that CARD is enabled (confirm the name in
     `src/lib/server/restaurants/index.ts`); inserts the owner row (`role: 'owner'`, `email`,
     `passwordHash: 'not-a-real-hash'`); seeds
     `seedStaff(db, id, { displayName: 'Sam', roleName: 'Cashier' })` (the default Cashier role
     holds `pos.sell` and `pos.payment`); registers the device with `registerDevice(tx, {
     restaurantId, actorUserId: ownerId, label: 'Counter tablet' })` (code `POS1`); builds the menu
     through `createCategory` ('Food', 'Drinks'), `createItem` (Burger `800n` in Food, Tea `200n`
     in Drinks, Special `999n` in Food), `createModifierGroup` ('Extras'), `createModifier` ('Extra
     cheese', `+50n`) and `linkModifierGroup` (Extras → Burger); and finally reads
     `restaurant_settings.menu_version` (every menu write bumped it) so the envelopes below carry
     the CURRENT version and never trip `stale_menu_price`.
   - `syncContext(f, o: { clientOpId: string; occurredAt: Date; employeeId?: string })` →
     `SyncContext` with `restaurantId`, `cookieDeviceId = opDeviceId = f.deviceId`,
     `opDeviceCode = f.deviceCode`, `employeeId = o.employeeId ?? f.staffId`, `occurredAt`,
     `receivedAt = o.occurredAt` (equal on purpose: `clock_ahead` compares the two, and a test
     about dates must not depend on the wall clock), `ip: '203.0.113.5'`, `userAgent: 'vitest'`.
   - `openSessionAt(db, f, o: { posSessionId: string; openedAt: Date; openingCashMinor: bigint })`
     → runs `openSession(tx, syncContext(f, { clientOpId: randomUUID(), occurredAt: o.openedAt }),
     { posSessionId, openingCashMinor: minor(o.openingCashMinor) })` inside `db.transaction`,
     importing `minor` from `$lib/money` — T-20 declares this payload's money as `Minor`, and the
     wire string→`Minor` conversion belongs to T-21's `handleOp`, not to the fixture; T-20 stamps
     `opened_at` from the context's `occurredAt`, which is how the fixture dates a session.
   - `recordSaleAt(db, f, o: { posSessionId; occurredAt: Date; invoiceSeq: number; method:
     'cash'|'card'|'mobile'; orderType: 'dine_in'|'takeaway'; tableLabel: string | null;
     employeeId?: string; lines: { menuItemId; itemName; quantity: number; unitPriceMinor: bigint;
     taxRateBp: number; modifiers?: { modifierId; modifierName; priceDeltaMinor: bigint }[] }[] })`
     → builds the `SaleCompletePayload` of the overview: `orderId`, each `lineId` and `paymentId`
     from `crypto.randomUUID()`, `lineNo` 1..n, `discountMinor: '0'` on every line, `totals =
     serializeTotals(computeOrderTotals({ taxMode: f.taxMode, lines }, ROUNDING_RULE))` (T-10),
     ONE payment whose `amountMinor` is `totals.totalMinor`, with `tenderedMinor` = the next whole
     major unit at or above the total and `changeMinor = changeDue(tendered, total)` (T-11) for
     cash and both `null` otherwise, `invoiceNumber = formatInvoiceNumber(f.deviceCode,
     o.invoiceSeq)`, `openedAt` ten minutes before `occurredAt`, `taxMode`, `currencyCode` and
     `menuVersion` from the fixture; wraps it in an `OpEnvelope` (`kind: 'sale.complete'`,
     `clientOpId: randomUUID()`, `deviceId`, `employeeId`, `occurredAt` ISO, `seq: o.invoiceSeq`);
     then, in ONE `db.transaction`, calls `validateSale(tx, ctx, envelope)`, throws with the
     `hard` flag and `detail` if `ok` is false, and calls `recordSale(tx, ctx, result.sale,
     result.softFlags)`; returns `{ orderId, invoiceNumber, totals, softFlags }`. If `recordSale`
     turns out to expect the `pos_sync_ops` row `handleOp` inserts before it runs, wrap the two
     calls exactly the way `src/lib/server/orders/sync.ts` does — never change `recordSale`.
   - `closeSessionAt(db, f, o: { posSessionId; closedAt: Date; countedCashMinor: bigint })` →
     `closeSession(tx, ctx, { posSessionId, countedCashMinor: minor(o.countedCashMinor) })` in a
     transaction — again a `Minor`, as T-20 declares the payload; the string→`Minor` conversion is
     T-21's.
   In `recordSaleAt`'s envelope every `*Minor` field on the wire is a decimal STRING (`'850'`),
   because `validateSale` takes the `OpEnvelope` exactly as the till would send it; `bigint` never
   reaches `JSON.stringify`. The session helpers above call T-20 directly with `Minor` and never
   touch the wire.

**Tests:** (`sales.integration.test.ts`; the integration project truncates every table before
each test, so each case seeds its own fixture). The restaurant's zone is `Africa/Mogadishu` (UTC+3,
no daylight saving), tax exclusive at `1000` bp, so the seeded sales are:

| Sale | Session | Paid at (local / UTC) | Tender | Type | Lines | subtotal | tax | total |
|---|---|---|---|---|---|---|---|---|
| A | S1 | 28th 09:00 / 06:00Z | cash, tendered `1000n` | `dine_in`, table `T4` | 1 × Burger `800n` + Extra cheese `50n` | `850n` | `85n` | `935n` |
| B | S2 | 28th 20:00 / 17:00Z | card | `dine_in`, no table | 2 × Burger `800n` | `1600n` | `160n` | `1760n` |
| C | S2 | **29th 01:30 / 28th 22:30Z** | cash, tendered `700n` | `takeaway` | 3 × Tea `200n` | `600n` | `60n` | `660n` |
| D | S3 | 29th 09:30 / 06:30Z | cash, tendered `1000n` | `dine_in`, table `T1` | 1 × Burger `800n` | `800n` | `80n` | `880n` |

Sessions: S1 opened 28th 08:00 local (`2026-09-28T05:00:00Z`) with float `10000n`, closed 28th
14:00 local with a count of `10900n`; S2 opened 28th 18:00 local (`2026-09-28T15:00:00Z`), float
`10000n`, left open across midnight; S3 opened 29th 09:00 local (`2026-09-29T06:00:00Z`), float
`5000n`, left open. Sale C is spec 10's own example: rung up at 01:30 in a session that opened the
previous evening, so it belongs to the 28th.
- `salesReport(db, rid, '2026-09-28').totals` → `{ grossSales: 3050n, discounts: 0n, netSales:
  3050n, tax: 305n, takings: 3355n, orderCount: 3 }`, and the spec 25 identity asserted as its own
  case: `takings === netSales + tax` (`3355n === 3050n + 305n`).
- The 01:30 sale is on the 28th and not the 29th: the 28th's `byItem` contains `{ itemName: 'Tea',
  quantity: 3, amount: 600n }` and its `orderCount` is `3`; `salesReport(db, rid, '2026-09-29')` has
  NO `Tea` row, `orderCount: 1`, `totals.takings: 880n`.
- A card sale shows under card: the 28th's `byTender` deep-equals `[{ method: 'cash', amount:
  1595n, count: 2 }, { method: 'card', amount: 1760n, count: 1 }, { method: 'mobile', amount: 0n,
  count: 0 }]`, and `Σ byTender.amount === takings`.
- `byOrderType` on the 28th → `[{ orderType: 'dine_in', amount: 2695n, count: 2 }, { orderType:
  'takeaway', amount: 660n, count: 1 }]`; `byEmployee` → one row `{ displayName: 'Sam', amount:
  3355n, count: 3 }` with `userId` = the staff id.
- byItem quantities sum: the 28th's `byItem` deep-equals `[{ itemName: 'Burger', quantity: 3,
  amount: 2450n }, { itemName: 'Tea', quantity: 3, amount: 600n }]` (Burger = `850n` from A, with
  its modifier, plus `1600n` from B), `Σ quantity === 6` (the six line units sold), and — with no
  discounts, in exclusive mode — `Σ byItem.amount === totals.grossSales` (`3050n`). `byCategory`
  → `[{ name: 'Food', quantity: 3, amount: 2450n }, { name: 'Drinks', quantity: 3, amount: 600n }]`.
- Sessions on the 28th: two rows in opened order; S1 → `{ deviceCode: 'POS1', status: 'closed',
  openingCash: 10000n, expectedCash: 10935n, countedCash: 10900n, difference: -35n }` (expected =
  float + sale A's cash `935n`; sale C was after S1 closed and B was card); S2 → `{ status: 'open',
  expectedCash: null, countedCash: null, difference: null }`. `flagged` → `{ count: 0,
  unrecordedCount: 0 }`.
- `defaultReportDate` returns the 28th at 00:40 on the 29th: `defaultReportDate(db, rid, new
  Date('2026-09-28T21:40:00Z'))` → `'2026-09-28'` (S2 opened within 24 hours; S3 has not opened
  yet). Also: at `'2026-09-29T20:00:00Z'` (23:00 local on the 29th) → `'2026-09-29'` (S3); at
  `'2026-09-30T22:00:00Z'` (01:00 local on 1 October, nothing opened within 24 hours) →
  `'2026-10-01'` — the calendar date in the restaurant's zone, not UTC's 30th.
- A second restaurant seeded with `{ taxMode: 'inclusive', taxRateBp: 2000 }` and one cash sale
  of 1 × Special `999n` on a session of the 28th: its report → `{ grossSales: 832n, tax: 167n,
  takings: 999n }` (the blocker example from the overview: T-10 rounds the tie `166.5` half away
  from zero) and again `takings === netSales + tax`; its `byItem` → `[{ itemName: 'Special',
  quantity: 1, amount: 999n }]` (tax-inclusive, which the page labels). The FIRST restaurant's
  28th report is unchanged by it (`orderCount` still `3`) — tenant isolation in every query.
- An empty date: `salesReport(db, rid, '2026-01-01')` → every total `0n`, `orderCount: 0`,
  `byTender` three zero rows, `byOrderType` two zero rows, `byEmployee`, `byItem`, `byCategory`
  and `sessions` all `[]`, `flagged: { count: 0, unrecordedCount: 0 }`.
- `salesReport(db, rid, '28/09/2026')` rejects with `RangeError`.
- MANDATORY-adjacent (spec 29 — money arithmetic): no returned money field is a `number`:
  `typeof totals.takings === 'bigint'`, and `JSON.stringify(report)` THROWS (a `bigint` is not
  serialisable) — proof the module hands the page integers to format, not strings or floats.

**Done when:** `pnpm test:integration -- src/lib/server/reports/sales.integration.test.ts`
passes; `pnpm check` reports 0 errors; and these four greps hold, each run from the repo root:
`grep -n "computeOrderTotals\|roundToMinor\|taxOnAmount\|taxOnLine" src/lib/server/reports/sales.ts` prints nothing;
`grep -n "Number(\|parseFloat\|toFixed\|Math\.\|now()" src/lib/server/reports/sales.ts` prints nothing;
`grep -n "created_at::date\|paid_at::date\|opened_at::date" src/lib/server/reports/sales.ts` prints nothing;
`grep -c "business_date\|businessDate" src/lib/server/reports/sales.ts` prints at least `6` (one per
grouped section).

**Watch out:** `sum()` over a `bigint` column returns `numeric`, which pg hands over as a string
even after the `::bigint` cast — `BigInt(value)` it, and `coalesce(…, 0)` first, because `sum()` of
no rows is `NULL` and `BigInt(null)` throws. `count(*)` is `int8` and ALSO a string: cast `::int`.
`business_date` is a `'YYYY-MM-DD'` string end to end; a `Date` here is how a 01:30 sale lands on
the wrong day. Do not "help" the report by calling T-20's `expectedCash` for open sessions or by
recomputing a line's tax to show it "more accurately": the page labels the item column 'Net' or
'Incl. tax' by the restaurant's mode and footnotes that per-row rounding may differ from the total
by cents — that footnote is the design, not a bug to fix here. In the fixture, `receivedAt ===
occurredAt` is what keeps `clock_ahead` out of a test whose dates are fixed at 2026-09-28/29; if a
sale comes back `recorded_flagged` for another reason, print `softFlags` — the usual causes are a
`menuVersion` read before the last menu write (`stale_menu_price`) or card not enabled in the
settings (T-29).

### T-36 — `/reports` and the Reports rail item

**Needs:** T-35
**Files:**
- `src/routes/(dashboard)/reports/+page.server.ts` — NEW
- `src/routes/(dashboard)/reports/+page.svelte` — NEW
- `src/routes/(dashboard)/reports/reports.integration.test.ts` — NEW
- `src/lib/components/ui/Sidebar.svelte` — EDIT (the `NavItem` type's `href` union, and the
  `Reports` entry of the `nav-money` group inside `const groups`)
- `src/lib/components/ui/sidebar.test.ts` — EDIT (the case `'counts the rows that are not built
  yet'`, and a new case beside `'has a live Employees row'`)
- `src/routes/route-guards.integration.test.ts` — EDIT (append `'/(dashboard)/reports'` to the
  `DASHBOARD_ROUTE_IDS` array)
**Spec:** 26 (the sales and POS report lines this page renders), 25 (the order of the totals: Gross
Sales, Discounts, Net Sales), 10 (business date; Opening / Expected / Actual / Difference), 17
(reports group by business date), 8 ("the server returns 403 Forbidden"), 6 ("stored and flagged
for owner review")
**Invariants:** 8 (permissions enforced server-side on every route, reads included), 1 (money is
integer minor units — the page receives strings from the formatter), 7 (the UI never does money
arithmetic and never rounds), 11 (business date, not calendar date)

**Do:**
1. `+page.server.ts` — the load. First line of the body: `requirePermission(event,
   'admin.reports')` (the key exists in `src/lib/server/permissions/keys.ts` `ADMIN_KEYS`; the
   owner holds it, staff hold no dashboard key, an anonymous caller is redirected by the guard).
   Then `const restaurantId = event.locals.restaurantId; if (!restaurantId) error(500, 'No
   restaurant in scope')` — from locals, never from the URL. Read the restaurant with
   `getRestaurantWithSettings(db, restaurantId)` (404 if null): its `timeZone`, `taxMode` and
   `currencyCode` are needed below.
2. The date. `const raw = event.url.searchParams.get('date')`. When `raw === null`, `businessDate
   = await defaultReportDate(db, restaurantId, new Date())`. Otherwise validate with zod:
   `z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate)`, where `isCalendarDate` splits
   on `-`, builds `new Date(Date.UTC(y, m - 1, d))` and checks the three parts survive the round
   trip (so `2026-02-30` and `2026-13-01` fail); on failure `error(400, 'date must be a calendar
   date written YYYY-MM-DD')`. `Number()` on a date part is fine here — it is a date, not money.
   Compute `prevDate` and `nextDate` the same way (`Date.UTC(y, m - 1, d ± 1)` formatted back to
   `YYYY-MM-DD` with `toISOString().slice(0, 10)`); calendar arithmetic, not money.
3. `const report = await salesReport(db, restaurantId, businessDate)`. Formatting happens HERE,
   and only here. `const format = restaurant.currencyCode ? moneyFormatFor(restaurant.currencyCode)
   : null` (an unsupported stored code is a 500, as `/menu` treats it). Two helpers: `standalone =
   (v: Minor) => format ? formatMoney(v, format) : '—'` for a figure that stands alone (the totals
   card, the session cash figures — `formatMoney` appends the currency code after a no-break
   space), and `column = (v: Minor) => format ? formatAmount(v, format) : '—'` for a table column,
   with the code written once in the column header (`format.ts` documents that split; both are
   the money module's formatter and neither rounds). A negative figure comes back with a leading
   U+2212 minus from the formatter; the page must add `text-danger` to it, so the load returns each
   session's difference as `{ text: string; negative: boolean }` with `negative = v < 0n` (a
   comparison, not arithmetic) — `/menu`'s `modifier.negative` is the precedent.
4. Return AN EXPLICIT OBJECT LITERAL (never the report spread — a `bigint` in load data throws
   inside SvelteKit's serialiser, which is the safety net, not the design):
   ```ts
   return {
   	businessDate, prevDate, nextDate,
   	timeZone: restaurant.timeZone,
   	currency: format ? { code: format.code, exponent: format.exponent } : null,
   	itemAmountLabel: restaurant.taxMode === 'inclusive' ? 'Incl. tax'
   		: restaurant.taxMode === 'exclusive' ? 'Net' : 'Amount',
   	totals: { grossSales: standalone(…), discounts: standalone(…), netSales: standalone(…),
   		tax: standalone(…), takings: standalone(…), orderCount: report.totals.orderCount },
   	byTender: report.byTender.map((r) => ({ method: r.method, label: TENDER_LABELS[r.method],
   		count: r.count, amount: column(r.amount) })),           // 'Cash' | 'Card' | 'Mobile'
   	byOrderType: report.byOrderType.map((r) => ({ orderType: r.orderType,
   		label: r.orderType === 'dine_in' ? 'Dine-in' : 'Takeaway', count: r.count,
   		amount: column(r.amount) })),
   	byEmployee: […{ userId, displayName, count, amount: column(…) }],
   	byItem: […{ menuItemId, itemName, quantity, amount: column(…) }],
   	byCategory: […{ categoryId, name, quantity, amount: column(…) }],
   	sessions: report.sessions.map((s) => ({ id: s.id, deviceCode: s.deviceCode, status: s.status,
   		opened: when(s.openedAt), closed: s.closedAt ? when(s.closedAt) : null,
   		openingCash: standalone(s.openingCash),
   		expectedCash: s.expectedCash === null ? null : standalone(s.expectedCash),
   		countedCash: s.countedCash === null ? null : standalone(s.countedCash),
   		difference: s.difference === null ? null
   			: { text: standalone(s.difference), negative: s.difference < 0n } })),
   	flagged: report.flagged,
   	isEmpty: report.totals.orderCount === 0 && report.sessions.length === 0
   };
   ```
   `when(d: Date)` formats in the RESTAURANT'S zone with `new Intl.DateTimeFormat('en-GB', {
   timeZone: restaurant.timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute:
   '2-digit' })` — in the load, so server-rendered and hydrated text are identical (invariant 11:
   the clock that matters is the restaurant's).
5. `+page.svelte`. `let { data } = $props()`; imports `Alert, Button, Card, Field, PageHeader`
   from `$lib/components/ui`, `resolve` from `$app/paths`. `<svelte:head><title>Sales ·
   {data.businessDate} · matcami</title></svelte:head>`. Then `<PageHeader title={'Sales · ' +
   data.businessDate} description="Grouped by business date — the shift a sale was rung up in,
   so a 01:30 sale belongs to the evening before.">` with an `actions` snippet holding, in
   order: a ghost `Button` with `href={resolve('/reports') + '?date=' + data.prevDate}` labelled
   `Previous day`; a `<form method="GET" action={resolve('/reports')} class="flex items-end
   gap-2">` with `<Field id="date" name="date" type="date" label="Business date"
   value={data.businessDate} />` and a secondary `Button type="submit"` labelled `Show`; a ghost
   `Button` to `nextDate` labelled `Next day`. (If `pnpm lint`'s
   `svelte/no-navigation-without-resolve` rejects the concatenated hrefs, replace the two links
   with GET forms carrying a hidden `date` input — no other change.)
6. Below the header, one content column `class="flex max-w-6xl flex-col gap-8 px-4 pt-8 pb-16
   lg:px-7"` (the overview's column). At its top, AT MOST ONE `Alert`: `{#if data.currency ===
   null}` an info Alert "Set the currency in Settings before reading reports." `{:else if
   data.flagged.count > 0}` an info Alert whose children are `<span aria-hidden="true"
   class="text-st-offline font-mono">◆</span> {data.flagged.count} sales on this date await your
   review — <a href={resolve('/reports/flagged')} class="text-accent underline
   underline-offset-2">Review them</a>` (no sale can exist without a currency, so the two never
   coincide; e2e asserts a SINGLE `role="alert"`). When `data.isEmpty`, one `Card` with `<p
   class="text-body text-ink-2"><span aria-hidden="true" class="font-mono">○</span> No sales or
   sessions on this business date.</p>` and nothing else below it.
7. Otherwise one `Card` per section, each opening with `<h3 class="text-title">`, in this order.
   Every money cell is `class="text-right font-mono tabular-nums"`; every money column header is
   right-aligned too and carries the currency code, e.g. `Amount ({data.currency.code})`; header
   cells are `text-eyebrow text-ink-3 uppercase` (`text-ink-3` is legal because the table sits on
   the Card's `bg-raise`); tables are `<table class="w-full text-sm">` with `<thead>`/`<tbody>` and
   a `border-line` row divider.
   - **Totals**: a `<dl class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">` of six tiles in this
     order — Gross sales, Discounts, Net sales, Tax, Takings, Orders — each `<dt
     class="text-eyebrow text-ink-3 uppercase">` and `<dd class="text-section font-mono
     tabular-nums">`; Orders is `data.totals.orderCount`. Under the grid one line in
     `text-caption text-ink-2`: "Net sales = gross sales − discounts. Takings = net sales + tax:
     what customers paid."
   - **By tender**: Method | Payments | Amount — rows from `data.byTender` (all three always).
   - **By order type**: Type | Orders | Amount — 'Dine-in', 'Takeaway'.
   - **By employee**: Employee | Orders | Amount.
   - **By item**: Item | Qty | `{data.itemAmountLabel}` (`Net` in exclusive mode, `Incl. tax` in
     inclusive mode) — Qty in `font-mono tabular-nums text-right` — and after the table a
     `<p class="text-caption text-ink-2">` footnote: "Per-row rounding may differ from the total
     by cents."
   - **By category**: Category | Qty | the same label; the same footnote.
   - **Sessions**: NOT a nine-column table (nothing scrolls sideways at phone width, §7b). A
     `<ul class="divide-line-soft divide-y">` with one `<li class="py-4 first:pt-0 last:pb-0">` per
     session: a first row with the status mark and the device — `<span aria-hidden="true"
     class="font-mono {open ? 'text-ink-2' : 'text-ok'}">{open ? '○' : '●'}</span> <span
     class="font-mono">{deviceCode}</span> <span>{status === 'open' ? 'Open' : 'Closed'}</span>
     · opened {opened}{closed ? ' · closed ' + closed : ''}` — then a `<dl class="grid grid-cols-2
     gap-x-6 gap-y-1 sm:grid-cols-4">` with Opening / Expected / Counted / Difference, each `<dd>`
     money-styled, `—` for a null, and the difference `<dd>` gaining `text-danger` when
     `difference.negative` (the string already carries the `−`; colour never alone). `text-ok`
     and `text-danger` appear only on this Card's `bg-raise` — never on `bg-raise-2` or
     `bg-accent-soft`.
8. `Sidebar.svelte`: widen the `NavItem` `href` union to `'/dashboard' | '/settings' | '/device' |
   '/employees' | '/menu' | '/reports' | null`, and change the `nav-money` group's entry
   `{ label: 'Reports', href: null, icon: 'reports' }` to `{ label: 'Reports', href: '/reports',
   icon: 'reports' }`. Nothing else in the file moves; `/reports` does not begin with `pos`, so the
   service-worker-scope test stays green.
9. `sidebar.test.ts`: the case `'counts the rows that are not built yet'` expects `href: null` to
   occur `4` times — change it to `3` (Inventory, Purchases, Expenses remain), and add beside
   `'has a live Employees row'`: `it('has a live Reports row', () =>
   expect(source).toMatch(/label:\s*'Reports',\s*href:\s*'\/reports'/))`.
10. `route-guards.integration.test.ts`: append `'/(dashboard)/reports'` to `DASHBOARD_ROUTE_IDS`
    so the hook-level cases (anonymous → 303 to `/login`; staff → 403, not 404, not a redirect;
    owner → 200; staff POST → 403) run for the new route too. Nothing else in that file changes.

**Tests:** (`reports.integration.test.ts`; build the `RequestEvent` exactly as
`src/routes/(dashboard)/dashboard/dashboard.integration.test.ts` does — `locals: { user,
restaurantId, sessionToken: null, posDevice: null }`, `route: { id: '/(dashboard)/reports' }`,
`url: new URL('http://localhost/reports' + search)` — and seed with `seedSalesRestaurant`,
`openSessionAt`, `recordSaleAt` from `src/lib/server/db/test/sales.ts`)
- MANDATORY (spec 29 — permission check): a staff principal (`seedStaff` row, `Principal.role:
  'staff'`) calling `load` → the thrown value has `status: 403` and no `location`; an anonymous
  event (`locals.user: null`) → `status: 303` with `location` beginning `/login?next=`.
- The default date when no param: open one session with `openedAt: new Date(Date.now() -
  3_600_000)` (one hour ago) and call `load` with no `date` → `data.businessDate` equals that
  session's `business_date` read back from `pos_sessions` (T-20's derivation; the test never
  computes a date itself). With no session at all → `data.businessDate` matches
  `/^\d{4}-\d{2}-\d{2}$/` and equals `new Intl.DateTimeFormat('en-CA', { timeZone:
  'Africa/Mogadishu' }).format(new Date())` (the zone's calendar today).
- A bad date → 400: `?date=2026-13-45`, `?date=2026-02-30`, `?date=yesterday` and
  `?date=28/09/2026` each throw `status: 400`. `?date=2026-03-01` → `prevDate: '2026-02-28'`,
  `nextDate: '2026-03-02'`.
- Formatting is the load's: after one cash sale of 1 × Burger `800n` + Extra cheese `50n`
  (exclusive, `1000` bp) on a session of `?date=<its business_date>`, `data.totals.takings ===
  '9.35\u00a0USD'`, `data.totals.tax === '0.85\u00a0USD'` (the `\u00a0` is the formatter's
  NO-BREAK SPACE, U+00A0, written as a JavaScript escape in the test — a plain space fails `toBe`;
  equivalently build the expectation with `formatMoney(minor(935n), usd)`), `data.byItem[0]` deep-equals `{ menuItemId,
  itemName: 'Burger', quantity: 1, amount: '8.50' }`, `data.itemAmountLabel === 'Net'`,
  `data.byTender[0]` → `{ method: 'cash', label: 'Cash', count: 1, amount: '9.35' }`; on a
  restaurant seeded `{ taxMode: 'inclusive', taxRateBp: 2000 }` `data.itemAmountLabel === 'Incl.
  tax'`. A closed session with float `10000n` and a count of `10900n` after that sale → the session
  row's `difference` deep-equals `{ text: '\u22120.35\u00a0USD', negative: true }` (the leading
  minus is U+2212 and the code separator U+00A0, both from the formatter; write them as escapes).
  `JSON.stringify(data)` does NOT throw and contains no `bigint` (every amount left as
  a string) and none of `pinHash`, `passwordHash`, `token`.
- The empty date: `?date=2026-01-01` → `data.isEmpty === true`, `data.flagged` → `{ count: 0,
  unrecordedCount: 0 }`.

**Done when:** these pass, each run from the repo root:
`pnpm test:integration -- "src/routes/(dashboard)/reports/reports.integration.test.ts" src/routes/route-guards.integration.test.ts`;
`pnpm test:unit -- src/lib/components/ui/sidebar.test.ts src/routes/route-guards.test.ts` (the walk
finds `requirePermission(` in the new `+page.server.ts`); `pnpm check`; `pnpm lint`. And:
`grep -c "formatMoney\|formatAmount" "src/routes/(dashboard)/reports/+page.svelte"` prints `0`;
`grep -c "formatMoney\|formatAmount" "src/routes/(dashboard)/reports/+page.server.ts"` prints at least `2`;
`grep -n "\[#\|p-touch\|touch-" "src/routes/(dashboard)/reports/+page.svelte"` prints nothing;
and in a browser signed in as the owner the rail's `Reports` row is a link to `/reports` with no
`Soon` pill, `/reports` renders the seven cards, and `/reports?date=not-a-date` shows SvelteKit's
400 page.

**Watch out:** the LOAD formats; the `.svelte` file does no money work — not a `+`, not a
comparison against `0`, not a `toFixed`, not a sign check (the load's `negative` boolean is the
sign). `formatMoney` separates the amount from the currency code with U+00A0 (NO-BREAK SPACE,
`NO_BREAK_SPACE` in `src/lib/money/format.ts`; `format.test.ts` asserts it): never normalise it
to a space in the load, in a helper or in the test — write `\u00a0` in test literals or derive the
expectation from `formatMoney` itself. Keep every `href` through `resolve()` or lint fails. `text-ok` and `text-danger` are used
only inside a `Card` (`bg-raise`), never on `bg-raise-2` or `bg-accent-soft`; `text-ink-3` only
inside a Card too. Do not add a second `role="alert"` (e2e asserts a single one), do not put money
on the Overview page (T-37 adds a COUNT there, not an amount), and do not "fix" the per-row
footnote by rounding rows to make them add up — spec 17 rounds once on the invoice total and the
report reads that stored total.

### T-37 — `/reports/flagged` with retry and dismiss, and the dashboard alert

**Needs:** T-21 (`retryOp`, `dismissOp`, `handleOp` in `src/lib/server/orders/sync.ts`), T-36
**Files:**
- `src/lib/server/reports/flagged.ts` — NEW (the read side: the list and the count over
  `pos_sync_ops`, and the payload summariser)
- `src/lib/server/reports/README.md` — EXTEND (created by T-35; add one paragraph on `flagged.ts`
  after the paragraph on stored columns)
- `src/routes/(dashboard)/reports/flagged/+page.server.ts` — NEW
- `src/routes/(dashboard)/reports/flagged/+page.svelte` — NEW
- `src/routes/(dashboard)/reports/flagged/flagged.integration.test.ts` — NEW
- `src/lib/server/db/test/sales.ts` — EXTEND (created by T-35; export `saleEnvelope(f, o)`, the
  envelope builder `recordSaleAt` already uses, beside `recordSaleAt`. Do not rewrite the file)
- `src/routes/(dashboard)/dashboard/+page.server.ts` — EDIT (inside `load`, after `const activity
  = await recentActivity(db, restaurantId)`; and one key in the returned literal)
- `src/routes/(dashboard)/dashboard/+page.svelte` — EDIT (the import line from
  `$lib/components/ui`, and the top of the content `<div>` before the `At a glance` section)
- `src/routes/route-guards.integration.test.ts` — EDIT (append `'/(dashboard)/reports/flagged'`
  to `DASHBOARD_ROUTE_IDS`)
**Spec:** 6 ("If a synced sale fails validation, it is stored and flagged for owner review, never
discarded"; "Idempotency keys … the server ignores duplicates when a sync is retried"; gap-free
device invoice numbers), 8 (actions that require the owner; "403 Forbidden"), 7 (the owner as a
person: email + password on the dashboard), 3 (sensitive actions are audit-logged), 10 (business
date), 29 (permission checks)
**Invariants:** 5 (a completed offline cash sale is a recorded fact; a failed one is flagged, never
discarded; a retry is a no-op on what already exists), 8 (permissions enforced server-side on
every route and form action), 10 (audit rows in the same transaction — written by `retryOp` and
`dismissOp`, not by the route), 2 (posted records are permanent — no action edits an order,
invoice, payment, journal entry or line), 11 (business date)

**Do:**
1. `src/lib/server/reports/flagged.ts`. Imports as T-35's `sales.ts` (schema tables, `Executor`,
   `sql`, the money formatter, and `formatInvoiceNumber`, `type OpKind` from
   `'../../sync-ops'`) — still nothing from `orders/` or `pos-sessions/`. Export:
   ```ts
   export type FlaggedOp = {
   	id: string; kind: OpKind; status: 'recorded_flagged' | 'unrecorded';
   	flag: string | null; error: string | null; clientOpId: string; deviceCode: string;
   	invoiceNumber: string | null; employeeName: string | null; occurredAt: Date;
   	receivedAt: Date; businessDate: string | null; orderId: string | null;
   	payload: unknown; // the stored jsonb — the ROUTE summarises it and never returns it
   };
   export function listUnresolvedOps(database: Executor, restaurantId: string): Promise<FlaggedOp[]>;
   export function countUnresolvedOps(database: Executor, restaurantId: string): Promise<number>;
   export type OpSummary = { lines: string[]; total: string | null; tender: string | null };
   export function summarizeOp(kind: OpKind, payload: unknown, format: MoneyFormat | null): OpSummary;
   ```
   `listUnresolvedOps`: `from pos_sync_ops x join pos_devices d on d.id = x.device_id left join
   users u on u.id = x.employee_user_id and u.restaurant_id = $rid left join pos_sessions s on
   s.id = x.pos_session_id and s.restaurant_id = $rid` where `x.restaurant_id = $rid and x.status
   <> 'accepted' and x.resolved_at is null`, `order by x.received_at desc` (newest first) — the
   predicate T-07's partial index `pos_sync_ops_restaurant_unresolved_idx` is built for.
   `pos_sync_ops.id` is `bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity()` in T-07's
   verbatim schema, so Drizzle returns it as a JavaScript `bigint`: map `id: row.id.toString()`
   (a decimal string), because a `bigint` in load data makes SvelteKit's serialiser throw; T-21's
   `retryOp`/`dismissOp` take that decimal string as their `opId: string`.
   `invoiceNumber = x.invoice_seq === null ? null : formatInvoiceNumber(d.device_code,
   x.invoice_seq)` inside a try/catch that yields `null` for a seq the formatter refuses.
   `employeeName = u.display_name ?? null` — when the join finds nobody (the `employee_unknown`
   flag, or an id from another restaurant) the name is `null` and the raw id from the payload is
   NEVER surfaced as the actor. `businessDate = s.business_date ?? null` (an `unknown_session` op
   has no date). `countUnresolvedOps` is the same predicate with `count(*)::int`. Use the column
   names T-07's schema file declares (`invoice_seq`, `status`, `order_id`, `resolved_at`,
   `resolved_by_user_id`, `resolution`); `resolved_at` is the stamp BOTH `retryOp` and `dismissOp`
   write, so the predicate is "not accepted and not yet resolved by retry or dismiss".
2. `summarizeOp` is PURE and defensive: the stored payload of an `unrecorded` op may be exactly
   the malformed object that earned `invalid_payload`. For `kind === 'sale.complete'`: if the
   value is an object with an array `lines`, each line with a string `itemName` and an integer
   `quantity`, push `` `${quantity} × ${itemName}` `` plus `` ` + ${modifierName}` `` per modifier
   with a string name; `total` = `formatMoney(minor(BigInt(totals.totalMinor)), format)` only when
   `totals.totalMinor` matches `/^-?\d+$/` and `format` is not null, else `null`; `tender` = the
   first payment's `method` capitalised plus its `amountMinor` — the payment amount, which equals
   `total`, NOT `tenderedMinor` — formatted the same way (`'Cash 9.35\u00a0USD'` for a `935`
   payment), else `null`. For `session.open` / `session.close`: one line `'Session open ·
   float …'` / `'Session close · counted …'` from `openingCashMinor` / `countedCashMinor` under
   the same digit check. For `sale.abandoned`: `` `Abandoned ${reason}` ``. For `pin.login`:
   `'PIN login'`. Anything that does not parse → `{ lines: ['Payload could not be read'], total:
   null, tender: null }`. It never throws, never returns the raw object, and never widens a
   string of digits to a `number`.
3. `+page.server.ts` — the load: `requirePermission(event, 'admin.reports')`; `restaurantId` from
   locals (500 if absent); `getRestaurantWithSettings` for `timeZone` and `currencyCode` (`format`
   as in T-36); `const ops = await listUnresolvedOps(db, restaurantId)`; and `notice` parsed from
   `event.url.searchParams.get('notice')` with `z.enum(['retried_accepted', 'retried_flagged',
   'retried_unrecorded', 'dismissed']).optional()` — an unknown value is IGNORED, never echoed back
   into the page (`safeParse`, and `undefined` on failure). Return an explicit literal:
   ```ts
   return {
   	timeZone: restaurant.timeZone,
   	notice: NOTICE_TEXT[notice] ?? null,   // a sentence, never the raw query value
   	ops: ops.map((op) => ({
   		id: op.id, kind: op.kind, status: op.status, flag: op.flag, error: op.error,
   		clientOpId: op.clientOpId, deviceCode: op.deviceCode, invoiceNumber: op.invoiceNumber,
   		employeeName: op.employeeName ?? 'Unknown employee',
   		occurred: when(op.occurredAt), businessDate: op.businessDate,
   		retryable: op.status === 'unrecorded',
   		summary: summarizeOp(op.kind, op.payload, format)     // never op.payload itself
   	}))
   };
   ```
   `NOTICE_TEXT`: `retried_accepted` → `'● Recorded. The sale now appears in the report for its
   business date.'`; `retried_flagged` → `'▲ Recorded, with a flag: it appears in the report for
   its business date and the retry is in the audit log.'`; `retried_unrecorded` → `'◆ Still not
   recorded. The row shows the new reason.'`; `dismissed` → `'Dismissed. The reason is in the
   audit log.'`. A retried op is RESOLVED whatever its outcome: T-21 step 3 stamps `resolved_at`,
   `resolved_by_user_id` and `resolution = 'retried'` before the dispatch decides `accepted` or
   `recorded_flagged`, so a retry that lands flagged leaves this list at once (the `resolved_at is
   null` predicate drops it) — the notice must not promise it "stays listed".
4. The two actions, `retry` and `dismiss`. Each begins `const user = requireOwner(event)` — the
   OWNER AS A PERSON, not a capability (spec 7 gives the owner alone email + password; spec 8 ties
   money-shaped decisions to the owner's approval; `requireOwner` throws `error(403, 'Forbidden')`
   for any other principal and redirects an anonymous one) — then `restaurantId` from locals (500
   if absent), then `await event.request.formData()` and zod: `retry` parses `{ opId:
   z.string().regex(/^\d{1,18}$/) }`; `dismiss` parses `{ opId: z.string().regex(/^\d{1,18}$/),
   reason: z.string().trim().min(3).max(200) }` — `pos_sync_ops.id` is a bigint identity (T-07),
   so the id on the wire is the decimal string step 1 produced, never a uuid. A parse failure →
   `fail(400, { message: 'Give a reason of 3 to 200 characters.' })` for the reason, `fail(400, {
   message: 'That sale was not found.' })` otherwise. The route writes NO audit row and opens NO
   transaction of its own. Both calls pass the dashboard request as their LAST argument, exactly
   as the settings action does: `const request = { ip: event.getClientAddress(), userAgent:
   event.request.headers.get('user-agent') }`.
   - `retryOp(db, restaurantId, opId, user.userId, request)` re-runs the stored envelope under the
     SAME `(device_id, client_op_id)` key through the same transaction `handleOp` uses and writes
     `sync.op_retried`. Its return (T-21 step 4) is `{ ok: true; status: 'accepted' |
     'recorded_flagged' } | { ok: false; reason: 'not_found' | 'still_unrecorded'; flag?; detail? }`.
     Map it: `ok: true, status: 'accepted'` → `redirect(303, '/reports/flagged?notice=retried_accepted')`;
     `ok: true, status: 'recorded_flagged'` → `…?notice=retried_flagged`; `ok: false, reason:
     'still_unrecorded'` → `…?notice=retried_unrecorded` (a REDIRECT, not a `fail` — the row was
     updated with the new reason); `ok: false, reason: 'not_found'` → `fail(400, { message: 'That
     sale was not found.' })`.
   - `dismissOp(db, restaurantId, opId, user.userId, reason, request)` resolves a
     `recorded_flagged` OR `unrecorded` row (T-21 step 5, amended by this plan so that its `update`
     matches `status in ('recorded_flagged', 'unrecorded') and resolved_at is null`): it stamps
     `resolved_at = now()`, `resolved_by_user_id = actorUserId`, `resolution = 'dismissed'` and
     writes `sync.op_dismissed` in the same transaction; it never changes `status`, `order_id` or
     any posted row. The reason is stored ONLY in the `sync.op_dismissed` audit row's
     `details.reason` — there is no reason column on `pos_sync_ops`. Its return is `{ ok: true } |
     { ok: false; reason: 'not_found' | 'invalid_reason' }`: `ok: true` → `redirect(303,
     '/reports/flagged?notice=dismissed')`; `not_found` → `fail(400, { message: 'That sale was
     not found.' })`; `invalid_reason` → `fail(400, { message: 'Give a reason of 3 to 200
     characters.' })`.
   Every success is a `redirect(303, …)` — POST-redirect-GET, so a browser refresh cannot run a
   retry twice and the notice survives the redirect in the query string.
5. `+page.svelte`. `<svelte:head><title>Sales awaiting review · matcami</title></svelte:head>`;
   `<PageHeader title="Sales awaiting review" description="A synced sale that fails validation is
   stored and flagged for your review, never discarded. Retry runs it again under the same
   operation key; dismiss records your reason.">`. The content column as in T-36. `{#if
   data.notice}` ONE info `Alert` with `{data.notice}` — the page's only `role="alert"`. When
   `data.ops.length === 0`: a `Card` with `<span aria-hidden="true" class="text-ok
   font-mono">●</span> Nothing awaits review.` Otherwise a `Card` holding a `<ul
   class="divide-line-soft divide-y">`, one `<li class="flex flex-col gap-3 py-4 first:pt-0
   last:pb-0">` per op:
   - the mark, glyph AND word: `unrecorded` → `<span aria-hidden="true" class="text-st-offline
     font-mono">◆</span> Not recorded`; `recorded_flagged` → `<span aria-hidden="true"
     class="text-st-billed font-mono">▲</span> Recorded, flagged` (an op that becomes `accepted`
     leaves the list; the `●` appears in the notice sentence instead);
   - a `<dl class="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4 text-sm">` of When (`occurred`),
     Business date (`businessDate ?? '—'`), Kind, Invoice (`<span class="font-mono">`, or `—`),
     Employee, Flag (`flag ?? '—'` in `font-mono`), and, when `error` is set, a full-width `<dd
     class="text-danger">` with the error text (Svelte escapes it; never `{@html}`);
   - the summary: `summary.lines` as a `<ul>`, then `Total {summary.total}` and `Tender
     {summary.tender}` when present, money in `font-mono tabular-nums`;
   - the actions, side by side: `{#if op.retryable}<form method="POST" action="?/retry"
     use:enhance><input type="hidden" name="opId" value={op.id} /><Button type="submit"
     variant="secondary">Retry</Button></form>{/if}` and `<form method="POST" action="?/dismiss"
     use:enhance class="flex items-end gap-2"><input type="hidden" name="opId" value={op.id} />
     <Field id={'reason-' + op.id} name="reason" label="Reason" required minlength={3} />
     <Button type="submit" variant="danger">Dismiss</Button></form>` (the `danger` variant is for
     a destructive action — this is the dashboard's first). `import { enhance } from
     '$app/forms'`; a `fail(400)` renders `form?.message` under the row's forms in `text-danger`
     — NOT in a second `Alert`.
   After the list, one `<p class="text-caption text-ink-2">`: "Dismissing a sale that was not
   recorded leaves an explained hole in the till's invoice sequence: its number stays on the
   customer's receipt, nothing on the server will ever carry it, and the reason you give is the
   explanation."
6. The Overview. In `dashboard/+page.server.ts`, add `import { countUnresolvedOps } from
   '$lib/server/reports/flagged';`, then after `const activity = await recentActivity(db,
   restaurantId);` add `const flaggedCount = await countUnresolvedOps(db, restaurantId);` (no
   second guard — one route, one permission, and the owner holds `admin.reports` too), and add
   `flaggedCount` to the returned literal. In `dashboard/+page.svelte`, extend the import to
   `import { Alert, Card, PageHeader, StatusMark } from '$lib/components/ui';` and insert, as the
   FIRST child of `<div class="flex max-w-6xl flex-col gap-10 …">`, before the `At a glance`
   section: `{#if data.flaggedCount > 0}<Alert tone="info"><span aria-hidden="true"
   class="text-st-offline font-mono">◆</span> {data.flaggedCount} sales await your review — <a
   href={resolve('/reports/flagged')} class="text-accent underline underline-offset-2">Review
   them</a></Alert>{/if}`. The page has no other alert, so the single-alert rule holds; the count
   is a number, not money, so the page's "no money figures" note stays true.
7. `route-guards.integration.test.ts`: append `'/(dashboard)/reports/flagged'` to
   `DASHBOARD_ROUTE_IDS`.
8. `README.md` (T-35's): add the paragraph — `flagged.ts` lists and counts `pos_sync_ops` rows
   that are not `accepted` and not yet resolved (`resolved_at is null`: neither retried nor
   dismissed), joins the employee name and the session's business
   date, and summarises a stored payload for display; it never returns the raw payload to a page
   and never retries or dismisses anything — those are `orders/sync.ts`'s `retryOp` and
   `dismissOp`, called by the route.

**Tests:** (`flagged.integration.test.ts`; events as in T-36 with `route: { id:
'/(dashboard)/reports/flagged' }`, a `POST` `Request` with a `FormData` body for the actions as
`src/routes/(dashboard)/device/revoke.integration.test.ts` builds one; seed with
`seedSalesRestaurant` and drive ops through `handleOp(db, { restaurantId, deviceId, deviceCode },
{ ip: '203.0.113.5', userAgent: 'vitest' }, envelope)` from `src/lib/server/orders/sync.ts` with
`occurredAt` one minute in the past, so the wall-clock `receivedAt` never raises `clock_ahead`;
the `sale.complete` envelope is the one `recordSaleAt` builds — factor its builder out of the
fixture as `saleEnvelope(f, o)` if it is not already exported)
- The load lists an unrecorded op with its summary: a `sale.complete` envelope naming a
  `posSessionId` that was never opened → `handleOp` answers `{ http: 200, body: { status:
  'unrecorded', flag: 'unknown_session' } }`; then the owner's `load` → `data.ops` has length `1`
  and `data.ops[0]` matches `{ status: 'unrecorded', flag: 'unknown_session', invoiceNumber:
  'POS1-000001', employeeName: 'Sam', businessDate: null, retryable: true, summary: { lines: ['1 ×
  Burger + Extra cheese'], total: '9.35\u00a0USD', tender: 'Cash 9.35\u00a0USD' } }` (the
  envelope carries `invoiceSeq: 1`; `tender` shows the payment's `amountMinor` `935`, not the
  `tenderedMinor` `1000`; `\u00a0` is the formatter's U+00A0 — or build both strings with
  `formatMoney(minor(935n), usd)`);
  `JSON.stringify(data)` contains neither `menuItemId` nor `lineId` (raw payload keys) nor the
  staff user's id inside `summary`.
- Retry on a fixable op: open the missing session with `openSessionAt(db, f, { posSessionId,
  openedAt: two minutes ago, openingCashMinor: 10000n })`, then call `actions.retry` as the owner
  with `{ opId }` → it THROWS a redirect with `status: 303` and `location:
  '/reports/flagged?notice=retried_accepted'`; afterwards the `pos_sync_ops` row for that
  `(device_id, client_op_id)` is still ONE row, now `status: 'accepted'` with `order_id` set;
  `orders` holds exactly `1` row, `invoices` exactly `1` with `invoice_number: 'POS1-000001'`,
  `payments` exactly `1`, `journal_entries` exactly `1` (`cash_sale`; no COGS while cost is `0n`)
  whose lines sum `debit === credit === 935n`; the `audit_log` holds one `sync.op_retried` row with
  `actor_user_id` = the owner; and the owner's `load` now lists `0` ops. MANDATORY (spec 29 —
  offline sync: retries never create duplicates): call `actions.retry` again with the same `opId`
  → whether it answers `fail(400)` or a redirect, every count above is UNCHANGED (still `1` order,
  `1` invoice, `1` payment, `1` entry).
- Dismiss writes the audit row and resolves a `recorded_flagged` op (its own case, seeding its own
  fixture — the integration project truncates every table before each case, so the retry case's
  `POS1-000001` does not exist here): seed a second staff `seedStaff(db, rid, { displayName:
  'Robin', roleName: 'Waiter' })` (no `pos.payment`), open a session, and record a cash sale
  through `handleOp` with `employeeId` = Robin's id, that open session and an envelope built with
  `invoiceSeq: 2` → `{ status: 'recorded_flagged', flag: 'employee_not_permitted' }`; the load
  lists it with `status: 'recorded_flagged'`, `employeeName: 'Robin'`, `retryable: false`,
  `businessDate` = the session's date, `invoiceNumber: 'POS1-000002'` (from `invoiceSeq: 2`);
  count rows in `orders`, `invoices`, `payments`, `journal_entries`, `journal_entry_lines`;
  `actions.dismiss` as the owner with `{ opId, reason: 'Robin rang it up on the cashier\'s behalf'
  }` → redirect `303` to `'/reports/flagged?notice=dismissed'`; the op row's `resolved_at` is set,
  `resolved_by_user_id` is the owner, `resolution = 'dismissed'`, and its `status` is STILL
  `'recorded_flagged'` with `order_id` unchanged; one `audit_log` row `sync.op_dismissed` with the
  reason in `details.reason` and `actor_user_id` = the owner; the load lists `0` ops; and every
  row count taken before is IDENTICAL after (invariant 2 — nothing posted was touched). A reason
  of `'no'` (2 characters) → `fail(400)` with `message: 'Give a reason of 3 to 200 characters.'`
  and no stamp (`resolved_at` still null).
- MANDATORY (spec 29 — permission check): both actions reject a staff principal with `status:
  403` and no `location`, and change nothing (the op still listed, no audit row); the load rejects
  a staff principal with `403` too; a non-numeric `opId` of `'not-a-uuid'` → `fail(400)` (the
  `/^\d{1,18}$/` check, before any query).
- The dashboard count matches: in one case seed BOTH ops above (the unknown-session cash op with
  `invoiceSeq: 1` and Robin's flagged op with `invoiceSeq: 2`); with both unresolved, the
  Overview's `load` (`import { load as overviewLoad } from '../../dashboard/+page.server';` —
  two levels up from `reports/flagged/`) returns `flaggedCount: 2`; after the dismiss, `1`; after
  opening the missing session and the retry, `0`. `JSON.stringify` of that data contains no
  `bigint` and no money string.
- `summarizeOp('sale.complete', { lines: 'nope' }, format)` → `{ lines: ['Payload could not be
  read'], total: null, tender: null }`; `summarizeOp('sale.complete', payloadWith({ totalMinor:
  '9.35' }), format)` → `total: null` (not digits, not widened); `summarizeOp('session.open', {
  posSessionId: 's', openingCashMinor: '10000' }, format)` → `lines: ['Session open · float
  100.00\u00a0USD']` (U+00A0 before the code, as everywhere the formatter writes it).

**Done when:** these pass, each run from the repo root:
`pnpm test:integration -- "src/routes/(dashboard)/reports/flagged/flagged.integration.test.ts" "src/routes/(dashboard)/dashboard/dashboard.integration.test.ts" src/routes/route-guards.integration.test.ts`;
`pnpm test:unit -- src/routes/route-guards.test.ts` — the static walk sees `requirePermission(` in
the new `+page.server.ts` and `requireOwner(` INSIDE its `export const actions` block (the walk
checks the actions body separately); `pnpm check`; `pnpm lint`. And:
`grep -n "payload" "src/routes/(dashboard)/reports/flagged/+page.svelte"` prints nothing;
`grep -n "update(\|delete(" "src/routes/(dashboard)/reports/flagged/+page.server.ts" src/lib/server/reports/flagged.ts` prints nothing;
and in a browser the Overview shows `◆ 1 sales await your review` linking to `/reports/flagged`
while one op is unresolved, and shows no alert once it is dismissed.

**Watch out:** never expose the payload's employee id as the actor when the employee is unknown —
the name comes from the `users` join or is `'Unknown employee'`, and the raw id lives only in the
op row. `formatMoney` separates the amount from the currency code with U+00A0 (NO-BREAK SPACE);
never replace it with a space — not in `summarizeOp`, not in the load, not in a test helper —
write `\u00a0` in test literals or derive the expectation from `formatMoney`. No action ever
edits an order, invoice, payment or journal row: `retryOp` writes NEW rows under the old key,
`dismissOp` stamps `resolved_at` / `resolved_by_user_id` / `resolution` on the `pos_sync_ops`
row only (a sync log, not a posted record — the overview's execution note says so), and the tests
count every posted table before and after to prove it. The audit rows are `retryOp`'s and `dismissOp`'s; a second one from the
route would double-log the same act. `requireOwner`, not `requirePermission('admin.reports')`, on
the two actions — the load is a read any `admin.reports` holder may do, the actions are decisions
spec 8 reserves for the owner. Keep the notice a query-string CODE mapped to a sentence in the
load; echoing free text from the URL into a `role="alert"` region is how a link becomes a message
the owner did not write. Do not build a "retry all" or a bulk dismiss: each op is one decision
with one reason.
