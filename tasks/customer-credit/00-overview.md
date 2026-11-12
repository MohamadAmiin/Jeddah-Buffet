# Customer credit — eat now, pay later

**Goal.** The owner registers customers (name, phone, optional credit limit) on the dashboard. A cashier charges a WHOLE bill to a registered customer on the till instead of taking cash, card or mobile. The customer pays back later, in part or in full, at the till during a shift, and gets a payment receipt. The books carry the debt in a new account, 1100 Accounts Receivable.

This is Accounts Receivable. Spec 31 lists it under "Later" and `CLAUDE.md` under "Do NOT build"; the user asked for it knowing that on 2026-11-12. It is a recorded departure from the spec — do not "correct" it away.

## Requirements (as agreed with the user, 2026-11-12)

1. A credit charge works OFFLINE for customers the till already has cached. New customers need a connection. Offline, the limit is checked against the last balance the till saw.
2. Any cashier holding `pos.payment` may charge, up to an OPTIONAL per-customer credit limit. No owner PIN.
3. Repayment happens AT THE TILL, in an open shift, online only. Cash goes into the drawer and into the shift's expected cash.
4. Only the owner registers, edits, archives and restores customers, on the dashboard.
5. New account `1100 Accounts Receivable` (asset), seeded for every restaurant.
6. No split bills: a bill is charged to credit in full. Partial repayments are allowed at any time.

## Scope

**IN** — customers (dashboard), the credit tender (till, offline-capable), customer payments (till, online), payment reversal (dashboard), account 1100 and two posting rules, reports, receipts.

**OUT** (each needs its own decision; no account is invented for any) — writing off a bad debt, correcting a cash payment after its shift closed, moving a charge to another customer, prepaid balances, due dates, interest, reminders, customer self-service, split tenders, owner-PIN approval of a charge.

## Approach

**Chosen: credit is a fourth payment KIND.** `payments.method` gains `'credit'`; a credit sale runs the SAME payment transaction as every sale (invariant 4) and debits 1100 instead of a tender account. Credit is switched on per restaurant through ONE built-in `payment_methods` row of kind `credit` (like the built-in Cash row), off until the owner enables it. A customer's balance is NEVER stored: it is computed from posted rows.

Rejected — *an unpaid order status*: orders would stay BILLED for weeks, no invoice number, no revenue, no stock deduction until the customer pays; it breaks "one transaction at payment" and leaves the sale out of its business date.
Rejected — *a stored balance column*: a second truth beside the ledger, written from two paths; the inventory caches already need a tripwire for that reason.

## Risks that survived the risk panel

The panel ran in REDUCED form: four of five lenses completed (accounting, data model, offline/sync, permissions); the ops lens and most adversarial refuters died on a network outage, so the findings below were adjudicated in conversation rather than independently refuted, and the ops review was done in conversation.

- **BLOCKER — a reversal or a payment racing the shift close.** Checking "the shift is open" with a plain read lets a cash reversal commit into a shift that just closed: 1000 credited twice, a false shortage in 6800, nothing editable. → Every customer-payment writer takes `select … from pos_sessions … for share` FIRST and decides under it. Lock order everywhere: shift (FOR SHARE) → customer (FOR UPDATE) → payment row. FOR SHARE, never FOR UPDATE, on the shift. Two-connection test. (T-11)
- **BLOCKER — a customer payment with no device-side state.** A lost response looks like a failure; the cashier taps again and the books hold two payments for one. → A local payment record written with the queue entry; while unanswered it is permanent chrome with no Cancel and no second Receive for that customer; the receipt and the drawer wait for the server's answer; the server stores `balance_after_minor` so a replay answers the same. (T-12, T-19)
- **MAJOR — sums over two child tables written as joins multiply.** Expected cash and the balance must each be scalar subqueries, never one more join; tests seed at least two rows on each side. (T-08, T-11)
- **MAJOR — the customer lock taken after the checks it protects.** The customer lookup in the sale path IS the lock (`for update`) and runs before the archived / limit checks. (T-10)
- **MAJOR — a balance nobody can collect.** An archived customer can come to owe (a stale till, a later reversal). → The till list includes archived customers who still owe, pay-only; payments are accepted for them; the owner gets Restore; receiving payments never depends on the credit switch. (T-08, T-13, T-20, T-21)
- **MAJOR — report identities.** Removing credit from takings breaks five pinned identities. → New identities, each pinned (Shared contracts → Reports). (T-14)
- **MAJOR — a reversal with no business date.** → `reversal_business_date`: the shift's date for cash, today for card/mobile; a reversal is its own negative row on its own date. (T-02, T-11, T-14)
- **MAJOR — IndexedDB version 4 cannot be rolled back** (PR #34 was reverted in production on 2026-11-08). → NO version bump: the customer list is one key of the existing `settings` store; the payment record rides on its queue entry. (T-16, T-19)
- **MAJOR — the till's limit check forgets its own synced charge until the next balance refresh.** → Count a local charge until a refresh REQUESTED after its sync has landed. (T-16)
- **MAJOR — class decisions scattered as `=== 'cash'`.** → ONE function `tenderClass` (cash and credit are facts; card and mobile are requests) and a source-text tripwire. (T-15)
- **MAJOR — customer fields on a non-credit sale, or a long name, making a completed sale unrecordable.** → The server reads the customer fields only when the method is `credit`, cleans and cuts the name, never refuses for it. (T-01, T-10)
- **MAJOR — no trace of who charged whom.** → Audit row `sale.credit_charged`, a per-cashier credit report, invoice and cashier on every statement row. (T-10, T-14, T-23)
- **MAJOR — the drawer opening for a payment the server refuses.** → Pulse and print only on the accepted answer. (T-19)
- **MAJOR — switching credit off stops nothing server-side.** → SOFT flag `credit_not_enabled`; the switch travels with the customers refresh. (T-10, T-13)
- **MAJOR — every till holds every customer's phone and debt.** → Fetched and shown only while the signed-in employee holds `pos.payment`; residual accepted (below). (T-13, T-16)
- **MAJOR — new posted table without database guards.** → Triggers in the custom migration; `customer_payments` is inserted WITH its journal entry id so only the reversal stamp is ever updated. (T-03)
- **MINOR** — indexes for the balance read (T-02); the seed colliding with an owner method already named "Customer credit" (T-03); enabling credit must be self-healing (ensure 1100 and the row) (T-09).
- *Ops, reviewed in conversation*: the deploy migrates first and then restarts, so an old till shell meets the new server: it drops the unknown `credit` kind from its cached methods (fail-safe) and never sends the new op. Once ONE credit sale exists the code cannot be rolled back (old `eventForMethod` throws) — roll forward only, written into `scripts/deploy.sh` (T-25). The CHECK swaps rescan small tables under a brief lock; deploy outside service hours.
- *Refuted, dropped*: "customer names survive a revoked till in orders/sync_queue" (those stores must survive by invariant 5 and already hold cashier names); "the signed slip identifies the customer only by a cached name" (the invoice number resolves to the stored `customer_id`).

## Assumptions (decisions this plan rides on)

Answered by the user: the six requirements above, and — approved with the plan on 2026-11-12 — the `admin.customers` key, the built-in credit method row, the invariant 5 amendment, tax owed at the sale, no overpayment, owner reversal (cash only while its shift is open).

Adopted from the risk panel as defaults, NOT individually confirmed — confirm at the first opportunity; a reversal re-plans the tasks named:
- **Restore** an archived customer (owner, dashboard) exists. (T-08, T-21)
- **A cash reversal is dated its shift's business date; a card/mobile reversal the day it is made.** Refines "Inventory 9". (T-11)
- **The `customer.payment_received` audit row (tender cash), written in the payment's transaction, is the evidence for that drawer pulse** — the reading "Printing — decided 2026-09-29" uses for a cash sale. (T-19)
- **Accepted risks**: a cashier can charge a bill the customer paid in cash to someone's account and keep the cash (controls: the limit, `sale.credit_charged`, the per-cashier report, the statement the customer disputes); whoever holds a registered till can name another employee (decision (g)); customer names, phones and balances sit in the till's browser storage.
- **Open decision 3 (accountant)**: tax is recognised when the credit sale is made, and whether a credit invoice needs extra legal lines.

## In play

Spec: 3, 6 (offline), 8 (permissions), 10 (shifts), 11 (printing), 13 (payment transaction), 17 (money), 22–24 (ledger), 26–27 (reports), 29 (mandatory tests), 31 (the departure).
Invariants: 1 (money is integer minor units, arithmetic only in `src/lib/money`), 2 (posted records are permanent — corrections are reversals), 3 (entries balance at COMMIT), 4 (ONE payment transaction), 5 (offline facts, idempotency keys, device invoice numbers — AMENDED here), 8 (server-side permission on every route), 10 (audit in the same transaction), 11 (business date of the shift).

## Workspace state at plan time (2026-11-12)

Worktree `/home/mohamed-amiin/Desktop/matcami-customer-credit`, branch `feat/customer-credit`, equal to `main` at `ef587f1`. Established repo: migrations `0000`–`0020_category_photos`; every module in `CLAUDE.md`'s map exists. NOTHING of this feature exists: no `customers` table, no `src/lib/server/customers/`, no `/customers` or `/pos/customers` route, no `/api/pos/customers`. Tags: `NEW` = this task creates it; `EXTEND` = an earlier task here created it; `EDIT` = it exists today. Stop and report if a `NEW` path exists or an `EDIT` path does not.

Read a file before editing it: line numbers below are from 2026-11-12 and drift.

---

## Shared contracts

### Postings (nobody types a debit — `src/lib/server/accounting/posting-rules.ts`)

| Event | Lines |
|---|---|
| `credit_sale` | Dr 1100 Accounts Receivable `total` · Dr 4100 Sales Discounts `discount` / Cr 4000 Sales Revenue `subtotal` · Cr 2100 Tax Payable `tax` |
| `cost_of_goods_sold` | unchanged: Dr 5000 / Cr 1200, posted with every sale |
| `customer_payment_received` | Dr 1000 Cash on Hand (cash) or 1020 (card) or 1030 (mobile) / Cr 1100 Accounts Receivable |
| reversal | `postReversal` — the mirror entry, never an edit |

Journal source types gain `customer_payment`.

### Tables

`customers` — `id uuid pk`, `restaurant_id`, `name text` (1–80 after trim), `phone text` (3–32 after trim), `credit_limit_minor bigint NULL` (NULL = no limit; CHECK `>= 0`), `archived_at timestamptz NULL`, `created_at`, `updated_at`. `unique customers_id_restaurant_unique (restaurant_id, id)`. Partial unique index `customers_phone_unique (restaurant_id, phone) WHERE archived_at IS NULL`. Never deleted (trigger).

`customer_payments` — `id uuid pk` (device-generated `paymentId`), `restaurant_id`, `customer_id`, `amount_minor bigint` (`> 0`), `method text` CHECK `in ('cash','card','mobile')` (its OWN pinned list, not `PAYMENT_METHODS`), `payment_method_id uuid NOT NULL`, `payment_method_name text NOT NULL` (1–40), `tendered_minor`, `change_minor` (the `payments_cash_fields` rule), `balance_after_minor bigint NOT NULL` (`>= 0`), `pos_session_id`, `device_id`, `recorded_by_user_id`, `business_date date` (the shift's), `received_at timestamptz` (device time), `created_at`, `journal_entry_id uuid NOT NULL`, and the reversal group, all NULL or all set: `reversed_at`, `reversed_by_user_id`, `reversal_reason` (3–200 after btrim), `reversal_entry_id`, `reversal_business_date`. Composite FKs: `(restaurant_id, customer_id) → customers`, `(restaurant_id, payment_method_id, method) → payment_methods(restaurant_id, id, kind)`, session, device, user, journal entries. Indexes `(restaurant_id, customer_id)`, `(pos_session_id)`, `(restaurant_id, business_date)`. Trigger: no DELETE; UPDATE only of the reversal group, from NULL, once.

`payments` gains `customer_id uuid NULL`, `customer_name text NULL` (1–80); CHECK `payments_credit_customer`: `(method = 'credit') = (customer_id IS NOT NULL) AND (customer_id IS NULL) = (customer_name IS NULL)`; FK `(restaurant_id, customer_id) → customers`; partial index `payments_customer_idx (restaurant_id, customer_id) WHERE customer_id IS NOT NULL`. `payments_method_valid` gains `'credit'`. A credit payment has `tendered_minor`/`change_minor` NULL (the existing non-cash branch) and `payment_method_id` = the restaurant's credit row.

`payment_methods`: `payment_methods_kind_valid` gains `'credit'`; partial unique `payment_methods_one_credit (restaurant_id) WHERE kind = 'credit'`; CHECK `payment_methods_credit_rules`: `kind <> 'credit' OR (archived_at IS NULL AND merchant_number IS NULL)`. The credit row is seeded `enabled = false`, name `Customer credit`.

### The balance — ONE query, in `src/lib/server/customers/index.ts`

`balance = (select coalesce(sum(p.amount_minor),0) from payments p where p.restaurant_id = c.restaurant_id and p.customer_id = c.id) − (select coalesce(sum(cp.amount_minor),0) from customer_payments cp where cp.restaurant_id = c.restaurant_id and cp.customer_id = c.id and cp.reversed_at is null)` — two scalar subqueries, never two joins. Subtraction in SQL on bigint is allowed here as in the existing report queries; any arithmetic in TypeScript goes through `src/lib/money`. Used by the till list, the limit flag, the overpay check, archive, the statement and the 1100 tripwire.

### Locks

Order, everywhere: **shift row `FOR SHARE` → customer row `FOR UPDATE` → payment row `FOR UPDATE`.** The sale path locks the customer and then inserts the order (a key-share lock on the shift, which never waits on FOR SHARE). `closeSession` holds the shift `FOR UPDATE` and locks nothing else.

### Wire (`src/lib/sync-ops/index.ts`)

- `PAYMENT_METHODS = ['cash','card','mobile','credit']`; `CUSTOMER_PAYMENT_METHODS = ['cash','card','mobile']`.
- `SalePayment` gains OPTIONAL `customerId?: string | null`, `customerName?: string | null` — sent only when `method === 'credit'`; the server ignores them otherwise.
- `OP_KINDS` gains `'customer.payment'`; payload `CustomerPaymentPayload = { paymentId, customerId, posSessionId, method, paymentMethodId, paymentMethodName, amountMinor, tenderedMinor, changeMinor, receivedAt }` (money as decimal strings).
- `SOFT_FLAGS` gain `credit_limit_exceeded`, `customer_archived`, `credit_not_enabled`. No new HARD flag: an unknown customer is `invalid_payload` with detail `unknown_customer`.
- `SyncResult` gains optional `balanceAfterMinor?: string`.
- `cleanCustomerName(raw): string` — trim, collapse whitespace, drop control characters, cut to 80 code points; shared by till and server; never throws.

### Classes

`sale.complete` with `credit` is a FACT (HTTP 200 always; recorded, recorded-flagged or stored unrecorded — never rejected). `customer.payment` is a REQUEST: 403 `not_permitted` without `pos.payment`; 422 `{error:'rejected', flag:'invalid_payload', detail}` with detail `exceeds_balance`, `unknown_customer`, `unknown_session`, `session_closed`, `invalid_amount`, `tender_not_accepted`; a `database_error` is retried by the till under the same key, never dropped.

### Reports — identities, each pinned by a test

- `takings = cash + card + mobile` sale payments (money received for the day's sales).
- `soldOnCredit` = credit sale payments. `netSales + tax = takings + soldOnCredit`.
- `sum(byTender) = sum(byPaymentMethod) = takings + soldOnCredit`, credit as its own row labelled "Sold on credit (not received)".
- By order type = by employee = by item = `netSales + tax`.
- `customerPaymentsReceived` (per method) = payments by `business_date` (reversed or not) − reversals by `reversal_business_date`. Never part of takings.
- Expected cash of a shift = opening + (scalar: cash sale payments of its paid orders) + (scalar: its cash `customer_payments` with `reversed_at IS NULL`).

### Permissions

`admin.customers` (new, owner only): every `/customers` load and action. `admin.reports`: `/reports/credit`. `admin.settings`: the credit switch. `pos.payment`: charging to credit (with `pos.sell`, as every sale) and `customer.payment`. `GET /api/pos/customers`: `requireDevice`; the till calls it only while the signed-in employee holds `pos.payment`.

---

## Task index

| ID | Title | File | Needs |
|---|---|---|---|
| T-01 | Wire contracts in `sync-ops` | 01-schema.md | - |
| T-02 | Drizzle schema and generated migration 0021 | 01-schema.md | T-01 |
| T-03 | Custom migration 0022: triggers and seeds | 01-schema.md | T-02 |
| T-04 | Constraint tests for the new guards | 01-schema.md | T-03 |
| T-05 | Account 1100 in the chart | 02-accounting.md | T-03 |
| T-06 | Posting rules `credit_sale`, `customer_payment_received` | 02-accounting.md | T-05 |
| T-07 | `admin.customers` key and audit events | 03-server.md | - |
| T-08 | `customers/index.ts`: customers, balance, statement | 03-server.md | T-02, T-07 |
| T-09 | The built-in credit method: seed, ensure, enable | 03-server.md | T-05 |
| T-10 | A credit sale through THE payment transaction | 03-server.md | T-06, T-08, T-09 |
| T-11 | `customers/payments.ts`: receive, reverse, expected cash | 03-server.md | T-06, T-08 |
| T-12 | The `customer.payment` sync op | 03-server.md | T-11 |
| T-13 | `GET /api/pos/customers` | 03-server.md | T-08, T-09 |
| T-14 | Report queries: identities and the credit report | 03-server.md | T-10, T-11 |
| T-15 | Till: `tenderClass`, the credit option, the tripwire | 04-till.md | T-01 |
| T-16 | Till: the customers cache and the limit check | 04-till.md | T-13, T-15 |
| T-17 | Till: a credit sale — cart, completeSale, printing, receipt | 04-till.md | T-15, T-16 |
| T-18 | Till: the pay screen | 04-till.md | T-17 |
| T-19 | Till: the payment record, queue, drawer and receipt | 04-till.md | T-12, T-16 |
| T-20 | Till: the `/pos/customers` screen | 04-till.md | T-19 |
| T-21 | Dashboard: `/customers`, `/customers/new`, `/customers/[id]` | 05-dashboard.md | T-08, T-11 |
| T-22 | Dashboard: the Customer credit switch | 05-dashboard.md | T-09 |
| T-23 | Dashboard: report rows and `/reports/credit` | 05-dashboard.md | T-14 |
| T-24 | End-to-end: charge, offline charge, repayment | 06-docs-e2e.md | T-18, T-20, T-21, T-22, T-23 |
| T-25 | `CLAUDE.md`, `scripts/deploy.sh`, READMEs | 06-docs-e2e.md | T-24 |

Every task ends with `pnpm check && pnpm lint` clean and its own tests green, in one commit.
