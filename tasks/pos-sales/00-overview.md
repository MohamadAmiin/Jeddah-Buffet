# POS sales: ordering, payment, sessions, the first ledger, and the daily sales report

> Plan written 2026-09-28 by the plan-feature skill. **Packaging:** one file per feature area (the
> user's request of 2026-09-28, reversing the earlier one-file rule): this overview plus
> `01`–`10`. No zip and no `RESEARCH.md` (no web research was needed: the spec and CLAUDE.md
> answered every question that arose). Every task ID is unique across the directory and every task
> is listed in the index at the bottom of this file. A session handed any one file must still read
> THIS file first.

**Goal.** Make the registered till sell. After an employee signs in with their PIN they get a split
screen: menu items on the left (category tabs, item keys, modifier picker), the guest check on the
right. They add items, pick what the customer is doing (sit now, waiting for a table, takeaway),
choose a tender and pay. Every sale is a recorded fact on the device first and syncs to the server,
online or not, through one idempotent operation that runs spec 13's all-or-nothing payment
transaction. Every money event posts a balanced journal entry generated from spec 24's table. A
cashier shift is a POS session that gives each sale its business date and reconciles the drawer at
close. The owner gets a dashboard report of a business date's sales, overall, by item, by category,
by tender, by order type and by employee, plus the day's sessions and any sale that needs review.

## Requirements (as agreed with the user, 2026-09-28)

The user's words: split screen, cart on the right, menu on the left, add items, choose sit / waiting
for a table / delivery, choose a payment method, pay, "every action should have a journal entry",
a comprehensive report of today's sales by item and overall, keep it simple. Two corrections were
argued once and accepted by the user's instruction to write the plan as presented:

- **"Every action has a journal entry" means every MONEY event posts** (sale, and cash over/short at
  session close in this plan; refunds, comps, pay-outs and purchases in theirs). Adding a line to a
  cart is not a business event and has nothing to debit (spec 22, 24). Sensitive actions are
  audit-logged instead (spec 3; invariant 10). Deleting a NEW cart line is neither posted nor audited
  (spec 14 "Delete item: none, none, no"; invariant 9).
- **"Delivery" is not built.** It is first on CLAUDE.md's "Do NOT build" list and under Later in
  spec 31. The till offers **Sit now**, **Waiting for a table** and **Takeaway**; the first two are
  `dine_in` with and without a table label, the third is `takeaway` (spec 13's two MVP order types;
  spec 26 reports "Sales by Order Type (dine-in / takeaway)"). Home delivery is a later plan; the
  order-type value set is a text CHECK, so adding a value then is one reversible constraint swap.

The requirements the plan proceeds under, R1–R14, are restated in full below the risk section as
**Assumptions**, because the user directed the plan be written with the presented defaults and did
not answer the thirteen questions individually. Each is recorded as a decision by T-02.

## Scope

**IN** — `pos_sessions`, `orders`, `order_lines`, `order_line_modifiers`, `payments`, `invoices`,
`pos_sync_ops`, `accounts`, `journal_entries`, `journal_entry_lines`; two migrations (generated DDL,
then a custom one for the deferred balance trigger, the append-only triggers and the chart
backfill); the per-restaurant chart of accounts seeded from spec 23 verbatim; posting rules for
`cash_sale`, `card_sale`, `mobile_sale` (each with the 4100 Sales Discounts line when a discount is
present), `cost_of_goods_sold`, `cash_shortage_at_close`, `cash_overage_at_close`; the journal
writer; `computeOrderTotals` in the isomorphic money module; THE payment transaction; a documented
no-op inventory step; the session module; the sync handler and `POST /api/pos/sync`; the till's
local order store, sync queue, per-device invoice sequence and the flush of the existing
`offline_logins` rows; the signed-in-employee state with an idle lock on every till screen; four
till screens (session, order, pay, plus the layout and PIN changes); accepted-tender settings; the
menu-version bump on tax-setting changes; `/reports`, `/reports/flagged` with owner retry/dismiss;
the mandatory spec 29 tests and two e2e journeys; CLAUDE.md and README updates.

**OUT** — printing of any kind (receipt, kitchen ticket, drawer kick; spec 11; its own plan, and it
never runs inside the payment transaction anyway); discounts, voids of SENT items, refunds, comps,
re-opening a paid order, pay-ins, pay-outs, drawer-open-without-sale, and therefore every owner-PIN
approval gate and every reason code (spec 8, 14; their own plan); send-to-kitchen and the SENT item
status (values exist in the CHECKs, nothing writes them); dining tables as records, transfer, merge,
split bills, split tenders in the UI (the `payments` table takes N rows per order from day one; the
till takes one tender per order); more than one open cart at a time; inventory tables, recipes,
purchases, weighted-average cost (the inventory plan; until it lands `consumeForSale` returns no
movements and zero cost and no COGS entry is written); home delivery; the trial balance and journal
views on the dashboard (a later reporting plan); everything else on CLAUDE.md's "Do NOT build" list.

## Approach

**Chosen: one queue and one transaction, offline-first, the whole slice in one plan (A).** Every
sale is completed on the device: the order, its invoice number from the per-device gap-free sequence
and the queue entry are written in ONE IndexedDB transaction. Online means only that the flush is
immediate. One endpoint, `POST /api/pos/sync`, takes one operation per request and runs the same
server transaction for every sale, keyed by `(device_id, client_op_id)` so a retry is a no-op. The
sessions, the chart, the journal, the review page and the report ship in the same plan because a
sale cannot be recorded correctly without a business date (invariant 11), a balanced ledger
(invariant 3) and a place for the owner to see a sale that failed validation (spec 6).

Rejected — *ledger first, till second (B)*: the same total in two PRs, the first of which a cashier
cannot use; the op payload and the flag semantics are exactly what the client design decides, so the
endpoint would have been reworked in plan two.

Rejected — *online-first thin slice (C)*: the till posts each cart change to the server and offline
comes later. It breaks invariant 5 and the `(pos)` group's own rule that the POS must work offline,
and it pushes invoice numbering onto the server against spec 6.

## Risks that survived adversarial verification

Five lenses (accounting, data model, offline/sync, permissions, ops/migration), 62 agents, 25
findings survived and 24 were refuted. Eight blockers merged into four because four lenses found
the same defect from different angles. Every survivor below names the task that owns its
prevention.

- **BLOCKER (invariant 5, spec 6, spec 10) — a flagged sale stored as an inert blob.** The first
  draft stored a sale that failed validation as payload only. A cashier deactivated while the till
  was offline would then sync an evening of real cash sales into that state, the queue would empty,
  and session close would book the cash as an overage to 6800 while revenue and tax never posted.
  **Prevention:** two flag classes (T-18, T-19, T-20, T-21, T-37). A SOFT failure (employee
  inactive or not permitted, a totals mismatch, a stale-menu price, a closed session) never rolls
  back: the sale is recorded in full from the device's numbers and the op row carries
  `status = 'recorded_flagged'` with a typed `order_id`. Only a HARD failure (tampering, an unknown
  session, a database error) lands as `status = 'unrecorded'` with the payload only, and session
  close is refused with 409 while any unrecorded op references the session. The dashboard lists
  flagged ops with two owner actions, retry under the same op key and dismiss with a reason.
- **BLOCKER (invariant 3, spec 17) — the inclusive-mode sale entry unbalanced by one cent.**
  Rounding net and tax separately at 20% inclusive on a 999 line gives 833 + 167 ≠ 999; the deferred
  trigger rejects at COMMIT and every such sale flags. **Prevention (T-10):** `computeOrderTotals`
  produces the ledger integers by construction: `total`, `tax` and `discount` are each rounded once
  with `roundToMinor(…, ROUNDING_RULE)`; `net = total − tax` and `subtotal = net + discount` are
  derived. A seeded property test over both modes and every rate 0..10000 asserts
  `net + tax = total` and `Dr = Cr`.
- **BLOCKER (invariants 8, 9; spec 8, 14) — the sync endpoint as a generic order ingest.** Whoever
  holds the tablet could post a sale with a discount, a negative quantity or a one-cent unit price
  and the ledger would take it with no approver and no reason. **Prevention (T-18):** the validator
  pins every money field to what this slice's screens can produce: line `discountMinor` is the
  literal `0`, `quantity ≥ 1`, prices `≥ 0`, modifiers must belong to the item, exactly one payment
  whose amount equals the total. A unit price that differs from the server menu at the SAME snapshot
  version is a hard failure (`price_tamper`); at a different version it is a soft flag
  (`stale_menu_price`), because spec 6 says price at time of sale wins. The 4100 rule stays
  implemented and tested (T-13) but is unreachable from the wire until the approvals plan.
- **BLOCKER (invariants 5, 12; spec 6) — ops stamped with a revoked device.** After the documented
  revoke-and-re-register reset, the new device's cookie carries sales stamped with the old device
  id; one reading strands them, the other records them under the wrong device or into another
  restaurant's tables after a tablet changes hands. **Prevention (T-21, T-25, T-27):** every queued
  op carries the `deviceId` it was recorded under. The server accepts an op only when that device row
  belongs to the cookie's restaurant, revoked or not, and records everything under the op's device
  (invoice namespace, audit `device_id`, session). An op whose device belongs to another restaurant
  answers 409 `foreign_device` with nothing stored, and the till parks it with permanent chrome.
  `session.close` from any live device of the restaurant may close an older device's open session.
- **MAJOR — the consequence of a failed employee check was keyed on connectivity.** A cash sale is
  completed on the device before the server sees it, online or not, so a 403 for an "online" cash
  sale strands a fact at the head of the queue. **Prevention (T-21, T-27):** key on TENDER.
  `sale.complete` with a cash payment and `session.open` are always recorded and flagged; only
  card/mobile sales and `session.close` may receive 403.
- **MAJOR — tax mode not snapshotted; the report recomputed.** A mode flip on `/settings` would
  rewrite past sales in the report and disagree with the journal. **Prevention (T-06, T-19, T-35):**
  `orders.tax_mode` NOT NULL and the device's rounded `subtotal_minor`, `discount_minor`,
  `tax_minor`, `total_minor` are stored; every line stores its RESOLVED `tax_rate_bp` NOT NULL; the
  journal posts from stored columns; the report sums stored columns; the server recomputation is
  only a check whose output is a flag.
- **MAJOR — zero-amount journal lines.** A 0% rate or a free item produces a zero line the line CHECK
  rejects, and every sale of that restaurant fails. **Prevention (T-09, T-14):** the journal writer
  drops zero lines and writes no entry when none remain; the deferred trigger requires Σdebit =
  Σcredit AND at least one debit and one credit line, fired on `journal_entries` too so an empty
  header cannot commit.
- **MAJOR — the invoice counter in a store the device wipes.** A revoke or device rebind clears the
  `settings` store; a naive server hint could rewind the sequence onto a number already queued.
  **Prevention (T-22, T-23, T-28):** the sequence gets its own object store keyed by device id,
  exempt from `forgetDevice` and `bindDevice` like `offline_logins`; the resume point is
  `max(local counter, highest queued number for that device, server hint)`; the hint is computed
  over `pos_sync_ops.invoice_seq` (all statuses) and `invoices`; `GET /api/pos/employees` returns
  `device.code`, which the till needs to build `POS1-000001`.
- **MAJOR — a tax setting change never bumps the menu version.** The till computes tax at a stale
  rate for weeks with no mismatch to catch it. **Prevention (T-29):** `updateSettings` bumps
  `restaurant_settings.menu_version` in the same transaction whenever `tax_mode`, `tax_rate_bp` or
  `currency_code` changes.
- **MAJOR — blocking the till on a pending card op.** The draft froze all sales while a card op with
  a lost response resolved. **Prevention (T-24, T-25, T-34):** never block; the op stays queued with
  its number and replays in order; cash stays live; a card/mobile op the server REJECTS (403, or
  the cashier cancels a pending one) becomes a `sale.abandoned` op that carries the burned invoice
  number so the server can explain the hole.
- **MAJOR — the signed-in employee mirror defeats the idle lock.** A reload would restore the
  employee from `sessionStorage` after the idle return. **Prevention (T-26, T-30):** the idle watch
  runs in the POS layout for every signed-in screen; the mirror carries `lastActiveAt` and refuses to
  restore past the idle limit or when the limit is unset; idle and sign-out clear it in the same tick
  they navigate.
- **MAJOR — migration numbering against PR #11.** Generating a sales migration on a tree without
  0008–0010 makes Drizzle skip the roles migrations forever on any database migrated under the other
  order. **Prevention (T-01):** stated precondition and verification before any schema task.
- **MAJOR — business date from an unvalidated device clock.** A reset tablet clock would date a
  whole session permanently to January. **Prevention (T-20, T-21, T-30, T-32):** the session-open
  screen shows the business date it is about to use; the server soft-flags any op whose
  `occurredAt` is more than 5 minutes AFTER `received_at` (`clock_ahead`); the till compares the
  `Date` header of each successful sync response with its clock and shows skew chrome above 5
  minutes.
- **MAJOR — missing mandatory tests.** The `offline_logins` flush needs its three assertions from
  the previous plan (one audit row per offline login after reconnect; a replayed key writes none; a
  record is sent only under the device it is stamped with), and the unbalanced-entry test must
  assert at COMMIT, not at INSERT. **Prevention:** T-09, T-25, T-39.
- **MINOR** — report figures defined in spec 25 terms with per-row rounding footnoted (T-35, T-36);
  text + CHECK instead of Postgres enums for every value set, the `TAX_MODES` idiom (T-04–T-07);
  `/reports` defaults to the last session's business date when it opened within 24 hours (T-36).

*Refuted, dropped* (one line each): discount apportionment untested (no nonzero discount is
writable; the spec 24 discount test is mandated anyway) · tender-keyed rules cannot express a split
tender (spec 24 keys by tender; a split is one entry with two debit lines later) · append-only should
cover payments and invoices (spec demands DB enforcement only for balance; the plan adds the triggers
anyway because they cost nothing, see T-09) · an append-only trigger on `orders` would break the
paid update (triggers land on journal tables, invoices and payments only) · composite FKs to `users`
would die with 42830 (those FKs are single-column) · migration numbering, generic version (precluded
by T-01) · store the integer sequence beside the text (done anyway: `invoice_seq`) · device time
column on sales (kept: `paid_at` is the device time; business date lives on the session) · a racing
retry produces a phantom duplicate (Postgres blocks the loser until the winner commits; the op key
catches it) · any 4xx blocks the queue head (the server flags everything it can key; only a device
403 stops the flush) · an unclosed session spans the next day (the spec's own model; the till shows
the business date) · local order retention (a 30-day prune, T-22) · no reviewer surface, permissions
version (covered by the merged blocker) · a waiter naming the cashier in an op (device-attested
identity is spec 6's design; residual accepted, R9) · the offline PIN flush invents a failed count
(new event names without one, T-15) · accepted tenders enforced only on the till (server check,
T-18) · cleared carts leave no trace (spec 14; the drawer is the control) · chart seeded twice across
a deploy window (no production database; parity test, T-12) · a tenders setting in
`settingsComplete` locks tills out (the plan does not gate on it) · revoke and re-register strands
the queue, ops version (covered by the merged blocker) · report indexes unnamed (T-05–T-07 name
them) · rollback unstated (house rule: restore the pre-migration dump) · IndexedDB version 3 upgrade
blocked (no real tills exist; `onblocked` tidied in T-22).

## Assumptions (the thirteen defaults, and the requirements R1–R14)

The user was shown these on 2026-09-28 with a default each and asked for the plan to be written
without changing them. **They are assumptions until the user confirms them; T-02 records each as a
decision with that provenance, and any task that depends on one says so.** A later "no" to any of
them is a re-plan of the tasks named.

| # | Question | Default the plan uses | Tasks that depend on it |
|---|---|---|---|
| 1 | "Delivery": home delivery, or takeaway? | Takeaway; home delivery is a later plan | T-06, T-33 |
| 2 | PR #11 (`feat/employee-roles`) merges before this plan executes? | Yes; this plan's migrations start at 0011 | T-01, T-16, T-28 |
| 3 | Tenders built: cash, card, mobile as recorded external-terminal tenders; a per-restaurant setting says which of card/mobile is enabled (spec 33 decision 4) | Yes; cash is always on | T-07, T-13, T-29, T-34 |
| 4 | Card and mobile while offline | Disabled offline, with the reason shown (CLAUDE.md invariant 5 wording); the alternative, "a standalone terminal authorizes on its own so the tender is a fact", was presented and NOT chosen | T-25, T-34 |
| 5 | Seed all 23 spec 23 accounts per restaurant, or only the accepted tenders' clearing accounts? | Seed all; the deviation from spec 23's "only the payment methods the restaurant accepts are created" is recorded | T-12 |
| 6 | Permission key for session open and close | Reuse `pos.payment`; no new key is coined | T-16, T-21 |
| 7 | Rounding clarification | `total`, `tax` and `discount` each rounded once; `net` and `subtotal` derived, so entries balance by construction. This is a clarification of the 2026-09-15 rounding decision, not a new rule | T-10 |
| 8 | Report scope | Sales, sessions and flagged ops only; journal and trial balance views are a later plan | T-35–T-37 |
| 9 | One active cart at a time | Yes; no hold/resume | T-24, T-33 |
| 10 | Return to employee-select after each payment (spec 7's optional lock) | No | T-34 |
| 11 | A kitchen closer on the order screen while printing is out of scope | No; the only closer is Pay | T-33 |
| 12 | Cart edits audited | No; deleting a NEW line needs no reason (spec 14, invariant 9) | T-24, T-33 |
| 13 | Prune synced sales from the device | Yes, after 30 days, in the flush | T-22, T-25 |

The requirements in full, as amended by the risk panel:

- **R1 Surfaces.** Ordering, tender and sessions live under `/pos/...` and MUST work offline for cash
  (invariant 5, spec 6). The report and the review page live on the dashboard, online only;
  `/reports` needs `admin.reports`, the review ACTIONS need the owner (`requireOwner`).
- **R2 Order type.** `orders.order_type` text CHECK in `('dine_in','takeaway')`; `table_label` text
  nullable (max 32 characters). Sit now = `dine_in` + optional label; Waiting for a table =
  `dine_in` + null; Takeaway = `takeaway`. No `dining_tables` table.
- **R3 Flow.** One active cart, built locally in IndexedDB. The server first sees an order when it
  is paid: ONE queued operation `sale.complete` carries the whole order. The transaction inserts the
  order with `status = 'open'` and marks it `'paid'` in the same transaction (spec 13's "Mark Order
  PAID" step); there is no server-side OPEN phase in this slice. `voided`, `refunded`, `billed` and
  the item statuses `sent`, `voided` exist in the CHECKs and nothing writes them.
- **R4 Tenders.** `payments.method` text CHECK in `('cash','card','mobile')`. Cash: `tendered_minor
  ≥ amount_minor`, `change_minor = tendered − amount`, computed by `src/lib/money/change.ts`, never
  in a component. Card and mobile are recorded external-terminal tenders with no provider
  integration; the till completes them ONLY after the server's 200; the keys are disabled offline
  and when the setting is off, each with its reason in words; a pending card/mobile op never blocks
  cash sales; a rejected or cancelled one becomes `sale.abandoned` carrying its invoice number.
- **R5 Money.** Every line snapshots `unit_price_minor`, the RESOLVED `tax_rate_bp` (the item's own
  or the restaurant's), `quantity`, and each chosen modifier's `price_delta_minor`; the order
  snapshots `tax_mode`, `currency_code`, `menu_version` and the device's rounded `subtotal_minor`,
  `discount_minor`, `tax_minor`, `total_minor`. Line `discount_minor` exists (bigint NOT NULL
  DEFAULT 0) and the validator pins it to 0 in this plan. Both tax modes through
  `src/lib/money/tax.ts`; totals through ONE isomorphic `computeOrderTotals`; the server recomputes
  from the op's own lines and mode only, never from live `menu_items` or `restaurant_settings`, and a
  mismatch is a soft flag. Reports never recompute.
- **R6 Sessions.** `pos_sessions` as in T-05; `business_date` is derived on the server IN SQL from
  `opened_at` in the restaurant's time zone; one open session per device; `session.open` is a queued
  op that works offline, and when the server already holds an open session for that device the open
  ATTACHES to it and answers its id; `session.close` requires a connection and an empty queue on the
  till (spec 6, 10) and is refused with 409 while any `unrecorded` op references the session;
  expected cash = opening float + Σ cash `payments.amount_minor` of the session's recorded orders
  (refunds, pay-ins and pay-outs are zero in this plan); `difference = counted − expected`; negative
  posts `Dr 6800 / Cr 1000`, positive posts `Dr 1000 / Cr 6800`, zero posts nothing.
- **R7 Ledger.** `accounts` per restaurant seeded with all 23 spec 23 codes verbatim by
  `ensureChart` (initializer for new restaurants, custom-migration backfill for existing ones);
  `journal_entries` + `journal_entry_lines` with a DEFERRABLE INITIALLY DEFERRED constraint trigger
  (Σdebit = Σcredit, ≥ 1 debit line, ≥ 1 credit line, checked at COMMIT) and append-only triggers;
  posting rules as a table keyed by business event; the journal writer drops zero lines; nobody
  types a debit. Audited events: `pos.session.opened`, `pos.session.closed`, `sale.recorded`,
  `sale.flagged`, `sale.abandoned`, `sync.op_unrecorded`, `sync.op_retried`, `sync.op_dismissed`,
  `pos.pin.offline_success`, `pos.pin.offline_failed`, each written in the same transaction as its
  action (invariant 10).
- **R8 The payment transaction** in `src/lib/server/orders/pay.ts`, called only by the sync handler,
  one DB transaction in spec 13's order: insert order (`open`) + lines + modifiers → record
  payment(s) → finalize totals (recompute, compare, soft-flag) → record the invoice number (validate
  format and device namespace) → deduct inventory (`consumeForSale`, no-op) → create the invoice row
  → post journal entries (sale; COGS only when cost > 0) → mark the order `paid` → write the audit
  row → mark the op row. Hard failures roll back and are stored `unrecorded` in their own small
  transaction; the till is told `unrecorded`, which clears the op from its queue because the fact is
  now stored server-side.
- **R9 Employee identity on requests.** No new cookie. The device cookie authenticates the device
  (`requireDevice`); each op carries `employeeId` and `deviceId`; the server checks the employee
  belongs to the op's device's restaurant, is active, and holds the keys: `pos.sell` + `pos.payment`
  for `sale.complete`, `pos.payment` for `session.open` and `session.close`, none for `pin.login`
  and `sale.abandoned` (facts). A failed check on a cash sale or a session open is a SOFT flag
  (`employee_not_permitted`, `employee_inactive`); on a card/mobile sale or a session close it is
  403. Accepted residual, recorded: whoever holds the registered device can craft a request naming
  another employee; the mitigations are the audit trail (device + employee on every row) and the
  fact that the till is a shared physical device.
- **R10 Idempotency and sequence.** `pos_sync_ops` with `UNIQUE (device_id, client_op_id)`; the
  handler looks the key up first and replays the stored result; a 23505 on that unique during the
  transaction means a racing retry won, so replay. The device sequence lives in its own IndexedDB
  store; the next number is taken in the SAME IndexedDB transaction that writes the completed sale
  and its queue entry.
- **R11 Queue semantics.** One queue store, FIFO by a device sequence, one op per request, retry with
  backoff and the same `clientOpId` on network errors; `unrecorded`, `recorded_flagged` and
  `accepted` all advance the queue; 409 `foreign_device` parks the op; a device 403 stops the flush,
  runs `forgetDevice` and shows permanent chrome; `countUnsynced` is ONE number over
  `offline_logins` + `sync_queue`. Logout and session close are blocked while the queue is non-empty
  and the control says why.
- **R12 Report.** `/reports?date=YYYY-MM-DD`, default = the business date of the restaurant's most
  recent session when it opened within the last 24 hours, else calendar today in the restaurant's
  time zone. Figures in spec 25 terms from STORED columns: Gross Sales = Σ `subtotal_minor`,
  Discounts = Σ `discount_minor`, Net Sales = Gross − Discounts, Tax = Σ `tax_minor`, Takings =
  Σ `payments.amount_minor` = Net Sales + Tax (asserted in a test); by tender, by order type, by
  employee, by item and by category (qty and amount, each row one Exact sum rounded once, with the
  footnote that per-row rounding may differ from the total by cents); the date's sessions with
  opening, expected, counted and difference; the date's flagged ops with a link to `/reports/flagged`.
  Plain indexed SQL on `pos_sessions.business_date` (spec 27), never `created_at::date`.
- **R13 Sequencing.** PR #11 first; T-01 verifies it.
- **R14 Tests** (spec 29, MANDATORY): `computeOrderTotals` in both modes with the tie cases and a
  property test; journal balance property test + the DB rejecting an unbalanced entry AT COMMIT and
  rejecting UPDATE/DELETE; one posting-rule test per event above; sync retry never duplicates (same
  `clientOpId` twice → one order, one invoice, one entry set); a permission row for every new
  `/api/pos` route; e2e: an offline cash sale syncs exactly once after reconnect, and the three
  offline-login flush assertions.

## In play

Spec: 3 (data integrity), 4 (IndexedDB contents), 5 (menu version), 6 (offline sales are facts,
idempotency keys, device invoice numbers, protecting unsynced data), 7 (PIN, idle), 8 (permission
keys, 403), 10 (sessions, business date, close rules), 13 (order types, statuses, the payment
transaction), 14 (delete item needs nothing), 17 (money, tax, rounding, business day), 18 (sale
example), 22 (double entry rules), 23 (chart, verbatim), 24 (posting rules), 25 (profit terms), 26
(reports), 27 (plain SQL), 29 (mandatory tests), 31 (scope), 33 (decisions 4 and 6).
Invariants: 1 (integer minor units in bigint), 2 (posted records permanent), 3 (entries balance in
the DB), 4 (one transaction at payment), 5 (offline cash sale is a fact; idempotency; device
sequence), 6 (inventory is a ledger; the step exists as a documented no-op), 7 (discount before tax;
each line snapshots its numbers; one rounding function), 8 (server-side permission on every route),
9 (nothing gated is built), 10 (audit in the same transaction), 11 (business date), 12 (device +
PIN; no secrets in localStorage).

## Workspace state at plan time (Phase 1, 2026-09-28, main at 1741344 plus PR #11 assumed merged)

`src/` exists and is partially built. The POS access layer, the menu, the money core and the audit
log exist (PR #10, merged 2026-09-15). `src/lib/server/orders/`, `accounting/` and `inventory/` hold
a README each and NO code. PR #11 (`feat/employee-roles`, open on 2026-09-28) adds `roles`,
`role_permissions`, `users.role_id`, rebuilds `user_role` to `('owner','staff')`, migrations
0008–0010, `permissionsForUser(database, restaurantId, userId): Promise<ReadonlySet<PermissionKey>>`
in `src/lib/server/permissions/roles.ts`, `POS_KEYS`/`PosPermissionKey` in `keys.ts`, and the cached
employee shape `{id, displayName, isOwner, roleName, permissions, isActive, pinPhc}`. **This plan is
written for the tree AFTER PR #11 merges**; T-01 verifies that before anything else runs.

Files this plan opens and EDITs (they existed at Phase 1, on main or on PR #11; every one is tagged
`EDIT` with a location hint in the task that touches it):

- `CLAUDE.md`
- `docs/design-system.md`
- `e2e/fixtures.ts`
- `e2e/pos-access.spec.ts`
- `e2e/pos-offline.spec.ts`
- `eslint.config.js`
- `src/lib/components/ui/Sidebar.svelte`
- `src/lib/components/ui/sidebar.test.ts`
- `src/lib/pos/README.md`
- `src/lib/pos/store.test.ts`
- `src/lib/pos/store.ts`
- `src/lib/server/accounting/README.md`
- `src/lib/server/audit/audit.test.ts`
- `src/lib/server/audit/events.ts`
- `src/lib/server/db/migrations/meta/_journal.json`
- `src/lib/server/db/schema-guards/constraints.integration.test.ts`
- `src/lib/server/db/schema-guards/schema.test.ts`
- `src/lib/server/db/schema/restaurant-settings.ts`
- `src/lib/server/db/test/reset.ts`
- `src/lib/server/inventory/README.md`
- `src/lib/server/orders/README.md`
- `src/lib/server/permissions/index.ts`
- `src/lib/server/restaurants/index.ts`
- `src/lib/server/restaurants/settings.integration.test.ts`
- `src/routes/(dashboard)/dashboard/+page.server.ts`
- `src/routes/(dashboard)/dashboard/+page.svelte`
- `src/routes/(dashboard)/dashboard/event-text.test.ts`
- `src/routes/(dashboard)/dashboard/event-text.ts`
- `src/routes/(dashboard)/settings/+page.server.ts`
- `src/routes/(dashboard)/settings/+page.svelte`
- `src/routes/(pos)/pos/+layout.svelte`
- `src/routes/(pos)/pos/+page.svelte`
- `src/routes/(pos)/pos/pin/+page.svelte`
- `src/routes/api/menu/version/version.integration.test.ts`
- `src/routes/api/pos/employees/+server.ts`
- `src/routes/api/pos/employees/employees.integration.test.ts`
- `src/routes/api/pos/permissions.integration.test.ts`
- `src/routes/route-guards.integration.test.ts`
- `src/routes/route-guards.test.ts`
- `vitest.config.ts`

Every other path in this plan is NEW to the task that first names it and EXTEND to every later task.
**Stop and report a mismatch only** when a path tagged `NEW` in the task you are about to run
already exists, or a path tagged `EXTEND`/`EDIT` does not: either means the repo is not in the state
this plan assumed.

## Shared contracts (every task uses these names; do not rename)

**Isomorphic op contract, `src/lib/sync-ops/index.ts` (T-03).** Imports nothing. Exports:

```ts
export const OP_KINDS = ['session.open', 'session.close', 'sale.complete', 'sale.abandoned', 'pin.login'] as const;
export type OpKind = (typeof OP_KINDS)[number];
export const ORDER_TYPES = ['dine_in', 'takeaway'] as const;
export const PAYMENT_METHODS = ['cash', 'card', 'mobile'] as const;
export const ORDER_STATUSES = ['open', 'billed', 'paid', 'voided', 'refunded'] as const;
export const LINE_STATUSES = ['new', 'sent', 'voided'] as const;
export const SESSION_STATUSES = ['open', 'closed'] as const;
export const OP_STATUSES = ['accepted', 'recorded_flagged', 'unrecorded'] as const;
export const SOFT_FLAGS = ['employee_not_permitted', 'employee_inactive', 'employee_unknown', 'totals_mismatch', 'stale_menu_price', 'session_closed', 'clock_ahead'] as const;
export const HARD_FLAGS = ['invalid_payload', 'price_tamper', 'unknown_session', 'unknown_item', 'unknown_modifier', 'invoice_collision', 'database_error'] as const;
export type OpEnvelope<K extends OpKind, P> = { kind: K; clientOpId: string; deviceId: string; employeeId: string; occurredAt: string; seq: number; payload: P };
// Every *Minor field on the wire is a DECIMAL STRING of the integer minor value ("850"), never a number (bigint does not survive JSON).
export type SaleCompletePayload = { orderId: string; posSessionId: string; orderType: 'dine_in'|'takeaway'; tableLabel: string|null; taxMode: 'exclusive'|'inclusive'; currencyCode: string; menuVersion: number; invoiceSeq: number; invoiceNumber: string; openedAt: string; lines: SaleLine[]; totals: { subtotalMinor: string; discountMinor: string; taxMinor: string; totalMinor: string }; payments: SalePayment[] };
export type SaleLine = { lineId: string; lineNo: number; menuItemId: string; itemName: string; quantity: number; unitPriceMinor: string; taxRateBp: number; discountMinor: string; modifiers: { modifierId: string; modifierName: string; priceDeltaMinor: string }[] };
export type SalePayment = { paymentId: string; method: 'cash'|'card'|'mobile'; amountMinor: string; tenderedMinor: string|null; changeMinor: string|null };
export type SessionOpenPayload = { posSessionId: string; openingCashMinor: string };
export type SessionClosePayload = { posSessionId: string; countedCashMinor: string };
export type SaleAbandonedPayload = { orderId: string; invoiceSeq: number; invoiceNumber: string; reason: 'rejected'|'cancelled' };
export type PinLoginPayload = { outcome: 'success'|'failed' };   // the employee is the envelope's employeeId
export type SyncResult = { clientOpId: string; status: 'accepted'|'recorded_flagged'|'unrecorded'|'replayed'; flag?: string; error?: string; posSessionId?: string; businessDate?: string; expectedCashMinor?: string; differenceMinor?: string };
export function formatInvoiceNumber(deviceCode: string, seq: number): string;   // 'POS1' + 6 → 'POS1-000006'; throws if seq < 1 or > 999999 or the code fails /^[A-Z0-9]{1,8}$/
export function parseInvoiceNumber(value: string): { deviceCode: string; seq: number } | null;
```

HTTP answers of `POST /api/pos/sync` (T-27), one op per request: `200` with a `SyncResult` for
`accepted`, `recorded_flagged`, `unrecorded` and `replayed`; `403 {error:'not_permitted'}` only for a
card/mobile `sale.complete` or a `session.close` whose employee fails the check; `409
{error:'foreign_device'}` when the op's `deviceId` is not a device of the cookie's restaurant; `409
{error:'session_has_unrecorded_ops', count}` for a close blocked by unrecorded ops; `400
{error:'invalid_request'}` only for an envelope the server cannot key (no `clientOpId` or `kind`);
`422 {error:'rejected', flag}` for a card/mobile `sale.complete` OR a `session.close` that fails a HARD
check (`unknown_session`, `invalid_payload`, `database_error`), nothing stored: neither has happened yet on
the till, which records a rejected card/mobile sale as `sale.abandoned` and keeps a refused close queued
until the owner resolves the cause on `/reports/flagged`; a cash sale or a `session.open` that fails a hard
check is NEVER 422, it is `200 unrecorded`; `415` for a non-JSON body; and `requireDevice`'s
plain `403` for no, unknown or revoked device. The tender decides the class, never connectivity.

Two convention amendments T-02 records in CLAUDE.md: `restaurants/` may import the `CHART` constant
and `ensureChart` from `accounting/chart.ts` for its initializer entry (it still calls no other
module), and `updateSettings` bumps `menu_version` with an inline SQL increment rather than by
calling `menu/` (which `restaurants/` may not import).

**Money, `src/lib/money/order-totals.ts` (T-10).** `computeOrderTotals(input: { taxMode: TaxMode;
lines: TotalsLine[] }, rule: RoundingRule): OrderTotals` where `TotalsLine = { unitPriceMinor: Minor;
quantity: bigint; modifierDeltasMinor: Minor[]; taxRateBp: number; discountMinor: Minor }` and
`OrderTotals = { subtotal: Minor; discount: Minor; tax: Minor; total: Minor; net: Minor; lines:
{ undiscountedNet: Exact; net: Exact; tax: Exact; gross: Exact }[] }`. Per line: `base =
(unitPrice + Σdeltas) × quantity`; `amount = base − discount` (throws if negative); `undiscountedNet =
taxOnAmount(exact(base), rate, mode).net`; `{net, tax, gross} = taxOnAmount(exact(amount), rate,
mode)`. Order: `total = roundToMinor(Σgross)`, `tax = roundToMinor(Σtax)`, `discount =
roundToMinor(Σ(undiscountedNet − net))`, `net = total − tax`, `subtotal = net + discount`. Identities
that always hold: `subtotal − discount + tax = total`; with no discounts `discount = 0n` exactly. Also exported:
`serializeTotals(t: OrderTotals): { subtotalMinor: string; discountMinor: string; taxMinor: string; totalMinor:
string }` (each bigint's decimal string, for the wire) and `totalsEqual(a: Pick<OrderTotals, 'subtotal' |
'discount' | 'tax' | 'total'>, b: same): boolean` (bigint equality of the four ledger integers; the server's
`totals_mismatch` check, T-18, and the till, T-24, call it by name).
`src/lib/money/change.ts` (T-11): `changeDue(tendered: Minor, total: Minor): Minor` (throws when
`tendered < total`) and `quickTenders(total: Minor, exponent: number): Minor[]` (exact amount, then
the next whole major unit above it, then the next round 5 and 10 of the major unit, deduplicated).

**Accounting, `src/lib/server/accounting/` (T-12–T-14).** `chart.ts`: `CHART` (23 rows `{code,
name, type}` verbatim from spec 23) and `ensureChart(tx: DbTx, restaurantId: string): Promise<void>`
(idempotent, `ON CONFLICT (restaurant_id, code) DO NOTHING`). `posting-rules.ts`: `POSTING_EVENTS =
['cash_sale','card_sale','mobile_sale','cost_of_goods_sold','cash_shortage_at_close',
'cash_overage_at_close'] as const`; `type RuleLine = { code: string; debit?: Minor; credit?: Minor }`;
`saleLines(event: 'cash_sale'|'card_sale'|'mobile_sale', t: { subtotal: Minor; discount: Minor; tax:
Minor; total: Minor }): RuleLine[]` = `Dr <1000|1020|1030> total`, `Dr 4100 discount`, `Cr 4000
subtotal`, `Cr 2100 tax`; `cogsLines(cost: Minor)` = `Dr 5000 / Cr 1200`; `overShortLines(difference:
Minor)` = negative → `Dr 6800 |d| / Cr 1000 |d|`, positive → `Dr 1000 d / Cr 6800 d`, zero → `[]`.
`journal.ts`: `postEntry(tx: DbTx, entry: { restaurantId: string; businessDate: string; event:
PostingEvent; sourceType: 'order'|'pos_session'; sourceId: string; memo: string; lines: RuleLine[] }):
Promise<{ entryId: string } | null>` — drops lines whose amount is `0n`, returns `null` and writes
nothing when none remain, resolves account ids by code within the restaurant, inserts the entry and
its lines with `line_no` 1..n, and never opens its own transaction.

**Orders, sessions, sync, `src/lib/server/` (T-16–T-21).** `permissions/employee.ts`:
`checkEmployee(database: Executor, restaurantId: string, userId: string, keys: PermissionKey[]):
Promise<{ ok: true } | { ok: false; reason: 'employee_unknown'|'employee_inactive'|
'employee_not_permitted' }>`. `inventory/consume.ts`: `consumeForSale(tx: DbTx, args: { restaurantId:
string; orderId: string; lines: SaleLine[] }): Promise<{ movements: never[]; cogsMinor: Minor }>`
returning `[]` and `0n`. `orders/validate.ts`: `validateSale(tx, ctx, envelope): Promise<{ ok: true;
sale: ParsedSale; softFlags: SoftFlag[] } | { ok: false; hard: HardFlag; detail: string }>`.
`orders/pay.ts`: `recordSale(tx: DbTx, ctx: SyncContext, sale: ParsedSale, softFlags: SoftFlag[]):
Promise<{ orderId: string; invoiceNumber: string; entryIds: string[] }>`. `pos-sessions/index.ts`:
`openSession(tx, ctx, payload)`, `closeSession(tx, ctx, payload)`, `expectedCash(tx, restaurantId,
posSessionId): Promise<Minor>`. `orders/sync.ts`: `handleOp(db: Db, device: PosDeviceContext, request:
{ ip; userAgent }, envelope: OpEnvelope): Promise<HandleResult>` where `HandleResult = { http: 200; body: SyncResult & { alreadyClosed?: true } } | { http: 400|403|409|422;
body: { error: string; flag?: string; count?: number } }`; `retryOp(db,
restaurantId, opId, actorUserId)`, `dismissOp(db, restaurantId, opId, actorUserId, reason)`.
`SyncContext = { restaurantId; cookieDeviceId; opDeviceId; opDeviceCode; employeeId; employeeUserId: string |
null (the users.id when a row with the envelope's employeeId exists in the restaurant, else null — T-18);
clientOpId;
occurredAt: Date; receivedAt: Date; ip; userAgent }`.

**Till, `src/lib/pos/` (T-22–T-26).** `store.ts` gains stores `orders` (keyPath `id`, index `status`),
`sync_queue` (keyPath `clientOpId`, index `seq`, index `deviceId`), `invoice_sequence` (keyPath
`deviceId`), `session` (keyPath `deviceId`), with `DB_VERSION = 3` and `case 2:` in `upgrade()`;
`orders`, `sync_queue`, `invoice_sequence`, `session` and `offline_logins` are NEVER cleared by
`bindDevice` or `forgetDevice`. `invoice-sequence.ts`: `takeNextInvoice(tx: IDBTransaction, deviceId,
deviceCode): Promise<{ seq; number }>` and `adoptServerHint(deviceId, lastInvoiceSeq)`. `orders.ts`:
`Cart`, `readCart`, `saveCart`, `completeSale(...)`, `abandonSale(...)`. `session.ts`:
`openLocalSession`, `closeLocalSession`, `readLocalSession` (the row only while its state is
'opening' | 'open' | 'closing', else null), `readSessionRow` (the row in any state), `adoptServerSession`. `queue.ts`: `enqueue(tx, entry)`,
`flush(fetchFn)`, `parkedCount()`, `onFlushResult`. `employee.svelte.ts`: `signedIn` state,
`signIn(employee)`, `signOut()`, `touch()`, `restoreFromMirror(idleSeconds)`.

## Execution notes

- Phases and files: **0 decisions** (`01`), **1 schema** (`02`), **2 domain** (`03` money, `04`
  accounting, `05` orders/sessions/sync), **3 offline** (`06`), **4 API** (`07`), **5 UI** (`08`
  till, `09` dashboard), **6 verification** (`10`). Unit and integration tests ship inside the task
  that writes the code; `10` holds only what spans layers.
- Execute in task-ID order unless a task's `Needs:` says otherwise. One commit per task, message
  `T-NN <type>(<scope>): <title>`.
- Every `+server.ts` and every form action checks its own permission and returns 403 (invariant 8);
  the walk in `src/routes/route-guards.test.ts` and the table in
  `src/routes/api/pos/permissions.integration.test.ts` must both pass with a row per new route.
- Nothing in this plan `UPDATE`s or `DELETE`s a paid order, invoice, payment, journal entry or line
  (invariant 2). The two updates that exist are the in-transaction `orders.status` `open → paid`
  (spec 13's own step) and `pos_sync_ops.status` on retry/dismiss, and `pos_sync_ops` is a sync log,
  not a posted record; T-07 says so in the schema comment.

## Task index (every task in this plan)

| ID | Title | File | Needs |
|---|---|---|---|
| T-01 | Verify the base tree holds PR #11's migrations and reset any database migrated out of order | 01-decisions.md | – |
| T-02 | Record the thirteen defaults and the sales-plan decisions in CLAUDE.md | 01-decisions.md | T-01 |
| T-03 | Create the isomorphic sync-op contract `src/lib/sync-ops/` | 01-decisions.md | T-02 |
| T-04 | Schema: `accounts`, `journal_entries`, `journal_entry_lines` | 02-schema.md | T-02 |
| T-05 | Schema: `pos_sessions` | 02-schema.md | T-02 |
| T-06 | Schema: `orders`, `order_lines`, `order_line_modifiers`, `payments`, `invoices` | 02-schema.md | T-05 |
| T-07 | Schema: `pos_sync_ops` and the accepted-tender settings columns | 02-schema.md | T-05, T-06 |
| T-08 | Generate migration 0011, register the new tables in the guards and the reset list, prove the constraints | 02-schema.md | T-03, T-04, T-05, T-06, T-07 |
| T-09 | Custom migration 0012: deferred balance trigger, append-only triggers, chart backfill; prove them at COMMIT | 02-schema.md | T-08 |
| T-10 | `computeOrderTotals`: ledger integers by construction, both tax modes, the tie cases, a property test | 03-money.md | T-03 |
| T-11 | `changeDue` and `quickTenders` in the money module | 03-money.md | T-10 |
| T-12 | The chart of accounts constant, `ensureChart`, the restaurant initializer entry, the parity test | 04-accounting.md | T-09 |
| T-13 | The posting-rule table with one test per business event | 04-accounting.md | T-10, T-12 |
| T-14 | The journal writer with the balance property test and the COMMIT-time rejection test | 04-accounting.md | T-13 |
| T-15 | Extend the audit event union with the sales, session, sync and offline-PIN events | 05-orders-sessions-sync.md | T-02 |
| T-16 | `checkEmployee`: an employee permission check for device-sourced operations | 05-orders-sessions-sync.md | T-01 |
| T-17 | `consumeForSale`: the inventory step as a documented no-op | 05-orders-sessions-sync.md | T-03 |
| T-18 | `validateSale`: the payload schema, hard failures, soft flags | 05-orders-sessions-sync.md | T-03, T-08, T-10, T-11, T-16 |
| T-19 | `recordSale`: THE payment transaction | 05-orders-sessions-sync.md | T-14, T-15, T-17, T-18 |
| T-20 | The session module: open (attach), close (expected cash, over/short), business date in SQL | 05-orders-sessions-sync.md | T-14, T-15 |
| T-21 | `handleOp`: dispatch, replay, device lineage, outcome mapping, unrecorded storage, retry and dismiss | 05-orders-sessions-sync.md | T-19, T-20 |
| T-22 | IndexedDB version 3: the four new stores, wipe exemptions, one unsynced count, pruning, `onblocked` | 06-offline-queue.md | T-03 |
| T-23 | The per-device invoice sequence store | 06-offline-queue.md | T-22 |
| T-24 | The local cart, `completeSale` in one IndexedDB transaction, `abandonSale`, the local session | 06-offline-queue.md | T-10, T-11, T-23 |
| T-25 | The flush: FIFO, backoff, outcome handling, parking, the offline-login flush, pruning | 06-offline-queue.md | T-24 |
| T-26 | The signed-in employee state with its mirror and idle rule | 06-offline-queue.md | T-22 |
| T-27 | `POST /api/pos/sync` with its permission rows | 07-sync-api.md | T-21 |
| T-28 | `GET /api/pos/employees`: device code, invoice hint, accepted tenders, open session, time zone | 07-sync-api.md | T-07, T-20, T-21 |
| T-29 | Accepted-tender settings and the menu-version bump on tax changes | 07-sync-api.md | T-07 |
| T-30 | The POS layout: employee state, idle watch, session chip, flush triggers, clock skew | 08-pos-screens.md | T-25, T-26, T-28 |
| T-31 | The PIN screen hands off to the session or order screen | 08-pos-screens.md | T-30 |
| T-32 | `/pos/session`: open with a float, close with a count | 08-pos-screens.md | T-30 |
| T-33 | `/pos/order`: the split screen | 08-pos-screens.md | T-30, T-32 |
| T-34 | `/pos/pay`: the tender step | 08-pos-screens.md | T-33 |
| T-35 | The sales report query module | 09-dashboard.md | T-09, T-11, T-19, T-20, T-29 |
| T-36 | `/reports` and the Reports rail item | 09-dashboard.md | T-35 |
| T-37 | `/reports/flagged` with retry and dismiss, and the dashboard alert | 09-dashboard.md | T-21, T-36 |
| T-38 | e2e: a full shift, online and offline, syncing exactly once | 10-verification.md | T-27, T-28, T-31, T-32, T-34, T-36 |
| T-39 | e2e: the three offline-login flush assertions | 10-verification.md | T-25, T-27, T-30, T-31 |
| T-40 | Docs: CLAUDE.md layout, module READMEs, the design-system note | 10-verification.md | T-27, T-28, T-29, T-34, T-37 |
| T-41 | Final verification: every check, every test, no schema drift, the quality checklist | 10-verification.md | T-38, T-39, T-40 |
