# Phase 3 — Server modules and API

**Depends on:** Phases 1–2. Read `00-overview.md` → "Shared contracts" (balance, locks, wire, classes, reports).

Module rule for the new `src/lib/server/customers/`: it calls `accounting/` and `audit/` only; it is called by `orders/`, `reports/`-free routes and `/api`. Every function takes the caller's `tx`, is scoped by `restaurantId`, audits in that transaction (invariant 10), and answers business refusals as `{ ok: false, reason }` — the house style of `src/lib/server/inventory/payments.ts`.

### T-07 — `admin.customers` key and audit events

**Needs:** -
**Files:**
- `src/lib/server/permissions/keys.ts` — EDIT (`ADMIN_KEYS`, labels if admin keys have any) and `keys.test.ts` — EDIT
- `src/lib/server/audit/events.ts` — EDIT (the typed union and `AUDIT_EVENT_NAMES`)
**Spec:** 8
**Invariants:** 8, 10

**Do:**
1. Append `'admin.customers'` to `ADMIN_KEYS` (owner only through `OWNER_KEYS`; a role can still hold only `POS_KEYS`). Note in the comment: added by the user's decision of 2026-11-12.
2. Audit events, each with a typed details shape: `customer.created`, `customer.updated`, `customer.archived`, `customer.restored`, `customer.payment_received` (customerId, amountMinor, method, paymentMethodId, posSessionId, balanceAfterMinor), `customer.payment_reversed` (paymentId, reason, reversalBusinessDate), `sale.credit_charged` (customerId, customerName, invoiceNumber, totalMinor), `payment_method.credit_enabled` / `credit_disabled` (or reuse the existing payment-method update event if its details can carry it — read the file first).

**Tests:** the key tests still prove the ten spec 8 POS keys verbatim and that no role may hold an `admin.*` key; the compile-time assert in `events.ts` passes.

**Done when:** `pnpm check` and `pnpm test:unit -- keys` pass.

---

### T-08 — `customers/index.ts`: customers, balance, statement

**Needs:** T-02, T-07
**Files:**
- `src/lib/server/customers/index.ts` — NEW
- `src/lib/server/customers/customers.integration.test.ts` — NEW
**Invariants:** 1, 2, 10

**Do:**
1. `createCustomer(tx, ctx, { name, phone, creditLimitMinor })`, `updateCustomer(tx, ctx, id, {...})`: name cleaned with `cleanCustomerName` and 1–80; phone trimmed, 3–32; limit `bigint | null`, `>= 0n`. A phone already held by a LIVE customer → `{ ok:false, reason:'phone_taken' }` (catch 23505 on `customers_phone_unique` too). `ctx` is `InventoryWriteContext`'s shape (`restaurantId, actorUserId, ip, userAgent`).
2. `lockCustomer(tx, restaurantId, id)` — `select … for update`; returns the row or null. Exported: T-10 and T-11 use it.
3. `balanceOf(executor, restaurantId, customerId): Promise<Minor>` and `listCustomers(executor, restaurantId, { includeArchived })` returning each row with `balanceMinor` — the ONE balance expression from the overview (two scalar subqueries). Export the SQL fragment so no other file retypes it.
4. `archiveCustomer`: lock, then refuse `has_balance` when the balance is not zero and `has_unrecorded_charge` when an unresolved `pos_sync_ops` row (`kind = 'sale.complete'`, `status = 'unrecorded'`, `resolved_at IS NULL`) names the customer in its payload's `payments[0].customerId`. `restoreCustomer`: lock, refuse `phone_taken` when a live customer holds the phone.
5. `statement(executor, restaurantId, customerId)`: charges (from `payments` joined to `orders`/`invoices`: business date of the order's shift, invoice number, cashier name, till code, amount) and payments (business date, method name, cashier, amount, and — as its own negative row on `reversal_business_date` — each reversal with its reason), ordered by time, plus the closing balance. The running balance is computed with the money module's `add`/`subtract`.
6. `receivableTripwire(executor, restaurantId)`: `{ sumOfBalances, ledger1100 }` — the net of account 1100's journal lines; the page shows a warning when they differ (the `/inventory` cache-vs-ledger tripwire is the precedent in `src/lib/server/inventory/reports.ts`).

**Tests:** CRUD and its audit rows; phone uniqueness among live only; a customer with TWO charges and TWO payments (one reversed) has the exact balance (catches join multiplication); archive refused with a balance, allowed at zero; restore; a customer of another restaurant is invisible to every function; tripwire equal after a mix of charges, payments and a reversal.

**Done when:** `pnpm test:integration -- customers.integration` passes.

**Watch out:** seed charges in tests through `recordSale` once T-10 exists; until then insert fixture rows directly and revisit in T-10.

---

### T-09 — The built-in credit method: seed, ensure, enable

**Needs:** T-05
**Files:**
- `src/lib/server/restaurants/payment-methods.ts` — EDIT (beside `seedCashMethod`)
- `src/lib/server/restaurants/` initializer list (where `seedCashMethod` is registered) — EDIT
- the module's integration test — EDIT
**Invariants:** 3 (credit must never be on without account 1100)

**Do:**
1. `ensureCreditMethod(tx, restaurantId)`: idempotent insert of the credit row (`enabled: false`, the name rule of T-03). Register it as an initializer for new restaurants.
2. `setCreditEnabled(tx, ctx, enabled)`: in ONE transaction run `ensureChart`, `ensureCreditMethod`, then set `enabled`; audit. This is the only writer of that row: the generic update/archive/create paths must refuse kind `credit` (an owner can never create, rename, archive or give a merchant number to it) — add the refusals and their tests.
3. The list reader used by `/settings/payments` returns the credit row separately (`creditMethod: { id, name, enabled }`), so the methods table does not show it as an editable method.
4. `GET /api/pos/employees`' settings bundle needs no change: it already sends enabled, unarchived rows as `{ id, name, kind, merchantNumber }`.

**Tests:** a new restaurant has one disabled credit row; enabling on a restaurant with a 23-account chart and NO credit row creates both and enables; creating a second credit row through the writer is refused; payment-method changes still never bump `menu_version`.

**Done when:** the module's integration tests pass.

---

### T-10 — A credit sale through THE payment transaction

**Needs:** T-06, T-08, T-09
**Files:**
- `src/lib/server/orders/validate.ts` — EDIT (`paymentSchema`; step 7, payment-method resolution; a new customer step; `ParsedSale`)
- `src/lib/server/orders/pay.ts` — EDIT (`recordSale`: the payment insert and the audit block)
- `src/lib/server/orders/sync.ts` — EDIT (`peekMethod`)
- `src/lib/server/orders/validate.integration.test.ts`, `pay.integration.test.ts`, `sync.integration.test.ts` — EDIT
**Spec:** 6, 13
**Invariants:** 4 (ONE transaction, same order of steps; nothing new commits alone), 5 (AMENDED: a completed offline credit charge to a known customer is a recorded fact — recorded and flagged, never rejected; a retry is a no-op), 10

**Do:**
1. `paymentSchema`: method from the widened `PAYMENT_METHODS`; `credit` carries no tendered/change (the non-cash branch); `customerId` optional uuid, `customerName` optional string with NO length refusal.
2. Customer fields are read ONLY when `method === 'credit'`; otherwise dropped silently (a cash sale carrying a stray `customerId` records as a plain cash sale).
3. Method resolution for `credit`: the restaurant's credit row, by id or (no id) the single row — with NO enabled filter, like cash. Row missing → HARD `invalid_payload` / `credit_method_missing`. Row disabled → SOFT `credit_not_enabled`.
4. Customer step, credit only: `customerId` missing, or not a customer of this restaurant → HARD `invalid_payload` / `unknown_customer` (stored unrecorded for the owner; never discarded). Otherwise `lockCustomer` (the lookup IS the lock; `validateSale` still writes nothing), then: archived → SOFT `customer_archived`; limit set and `balanceOf + total > limit` (money module) → SOFT `credit_limit_exceeded`. Stored name = `cleanCustomerName(payload name)` or, when empty, `customers.name`.
5. `recordSale`: write `customerId`/`customerName` on the payments row. `eventForMethod` → `credit_sale` posts Dr 1100. Everything else — invoice, `consumeForSale`, COGS, order → paid — unchanged.
6. Audit: after `sale.recorded`, write `sale.credit_charged` with `clientOpId: null` (the `sale.tax_override` pattern — `sale.recorded` owns the op's audit row).
7. `peekMethod` returns `'credit'`; `isRequestClass` stays true only for card/mobile, so a credit sale is fact-class: HTTP 200 always.

**Tests — MANDATORY (spec 29):**
- Posting: a credit sale posts `Dr 1100 / Cr 4000 / Cr 2100` plus `Dr 5000 / Cr 1200`, in both tax modes; the payments row carries the customer; the shift's expected cash is unchanged.
- Offline sync: the same op sent twice records once (one order, one payment, one entry, balance charged once); a payload WITHOUT the new keys still records exactly as before.
- Flags: over the limit → recorded with `credit_limit_exceeded`; archived → `customer_archived`; credit disabled → `credit_not_enabled`; unknown customer → `unrecorded`, payload kept, shift close then answers 409; a cash sale carrying `customerId` → accepted as cash, no customer stored; a 120-character customer name → recorded with 80.
- Concurrency (two connections): two credit sales that together cross the limit — the second to commit carries the flag.
- An employee without `pos.payment` on a credit sale → 200 `recorded_flagged` (`employee_not_permitted`), as for cash.

**Done when:** `pnpm test:integration -- orders` passes and T-08's fixtures now go through `recordSale`.

**Watch out:** do not add a second transaction or a post-commit step. Do not move the customer lock after the order insert.

---

### T-11 — `customers/payments.ts`: receive, reverse, expected cash

**Needs:** T-06, T-08
**Files:**
- `src/lib/server/customers/payments.ts` — NEW
- `src/lib/server/pos-sessions/index.ts` — EDIT (`expectedCash`)
- `src/lib/server/customers/payments.integration.test.ts` — NEW; `src/lib/server/pos-sessions/sessions.integration.test.ts` — EDIT
**Spec:** 10 (shift reconciliation), 24
**Invariants:** 2 (a wrong payment is REVERSED, never edited), 3, 10, 11

**Do:**
1. `receiveCustomerPayment(tx, ctx, input)` with `input = { paymentId, customerId, posSessionId, deviceId, employeeId, method, paymentMethodId, paymentMethodName, amountMinor, tenderedMinor, changeMinor, receivedAt }`. In this order:
   a. `select … from pos_sessions where id and restaurant_id … for share`; missing → `unknown_session`; `status <> 'open'` → `session_closed`. Take `business_date` from it.
   b. `lockCustomer`; missing → `unknown_customer`. An ARCHIVED customer is accepted.
   c. Resolve the payment method: a live, enabled row of this restaurant whose kind equals `method` and is cash, card or mobile (cash: the Cash row) → else `tender_not_accepted`. The credit switch is irrelevant here.
   d. `amount > 0n` else `invalid_amount`; `amount <= balanceOf` else `exceeds_balance`; cash: `changeDue` consistency as in `validate.ts`.
   e. `balanceAfter = subtract(balance, amount)`. `postEntry({ event:'customer_payment_received', sourceType:'customer_payment', sourceId: paymentId, businessDate, memo:'Customer payment', lines: customerPaymentLines(method, amount) })`, THEN insert the `customer_payments` row with its `journal_entry_id` and `balance_after_minor` (no later UPDATE). Audit `customer.payment_received`.
   f. Return `{ ok:true, balanceAfterMinor }`.
2. `reverseCustomerPayment(tx, ctx, { paymentId, reason })`: reason trimmed 3–200 else `invalid_reason`. Read the payment (not found → `not_found`). If its method is cash: lock its shift `for share` and require `status = 'open'` else `shift_closed`; `reversalBusinessDate` = the shift's business date. Card/mobile: `reversalBusinessDate = todayInZone`. Then `lockCustomer`, then claim with a conditional UPDATE of the whole reversal group `WHERE reversed_at IS NULL` (0 rows → `already_reversed`) — post `postReversal({ entryId, businessDate: reversalBusinessDate, memo: 'Reversal: <reason>' })` first so `reversal_entry_id` goes in with the same UPDATE. Audit `customer.payment_reversed`.
3. `expectedCash`: rewrite as `opening_cash_minor + (scalar subquery: cash sale payments of the shift's paid orders) + (scalar subquery: customer_payments where pos_session_id = s.id and method = 'cash' and reversed_at is null)`. No third join.
4. `paymentsOf(executor, restaurantId, customerId)` reader for the dashboard.

**Tests — MANDATORY:**
- Posting per kind (cash 1000, card 1020, mobile 1030, each against 1100); the reversal mirrors it and is dated per the rule (a cash reversal after midnight in a shift opened the day before carries the SHIFT's date).
- `exceeds_balance`, `invalid_amount`, `session_closed`, `unknown_customer`, another restaurant's customer → refused, nothing written.
- Expected cash: a shift with 2 cash sales, 1 card sale, 1 credit sale, 2 cash customer payments, 1 card customer payment and 1 reversed cash payment closes with the exact figure; over/short posts only the true difference.
- Two connections: a cash reversal racing `closeSession` either commits before the close reads expected cash (and is excluded) or is refused `shift_closed` — never both committed inconsistently. Same for a receive racing a close.
- A reversed payment restores the balance; reversing twice → `already_reversed`.

**Done when:** `pnpm test:integration -- payments.integration sessions` passes.

**Watch out:** FOR SHARE on the shift, never FOR UPDATE (a concurrent sale's order insert would deadlock against it). Lock order: shift → customer → payment.

---

### T-12 — The `customer.payment` sync op

**Needs:** T-11
**Files:**
- `src/lib/server/orders/sync.ts` — EDIT (`isRequestClass`, the pre-transaction permission gate, a `customer.payment` case in `handleOp`, `replayLookup`, `retryOp`'s refusal list)
- `src/lib/server/orders/validate.ts` or a small `customer-payment-payload.ts` beside it — NEW zod schema for `CustomerPaymentPayload`
- `src/lib/server/orders/sync.integration.test.ts`, `src/routes/api/pos/permissions.integration.test.ts` — EDIT
**Spec:** 6, 8
**Invariants:** 5 (idempotency key `(device_id, client_op_id)`; a retry is a no-op), 8 (403 server-side)

**Do:**
1. `customer.payment` is request-class. Gate: `checkEmployee(..., ['pos.payment'])` failing → 403 `not_permitted`, nothing stored.
2. Case: parse the payload (bad → 422 `invalid_payload`); call `receiveCustomerPayment` with the op's `deviceId`/`employeeId`; `{ok:false, reason}` → 422 `{ error:'rejected', flag:'invalid_payload', detail: reason }` and the transaction rolls back (no op row, as for a rejected card sale); ok → status `accepted` with `balanceAfterMinor`.
3. Replay: a retry of an accepted op answers with the SAME `balanceAfterMinor`, read back from `customer_payments` by `paymentId`.
4. Device lineage and `foreign_device` behave as for every op (decision (h)).

**Tests — MANDATORY:** the same op twice → one payment, one entry, same answer both times (balance included); without `pos.payment` → 403 and no rows; amount above the balance → 422 `exceeds_balance`; closed shift → 422; a waiter-only employee → 403; the permissions test file gains the op.

**Done when:** `pnpm test:integration -- sync permissions` passes.

---

### T-13 — `GET /api/pos/customers`

**Needs:** T-08, T-09
**Files:**
- `src/routes/api/pos/customers/+server.ts` — NEW (template: `src/routes/api/pos/receipt-logo/+server.ts`)
- `src/routes/api/pos/customers/customers.integration.test.ts` — NEW
- `src/routes/route-guards.test.ts` (the pinned `/api` list), `src/routes/api/pos/permissions.integration.test.ts` (`DEVICE_GUARDED`) — EDIT
**Invariants:** 8 (reads are guarded too)

**Do:**
1. `requireDevice(event)` first; tenant = `device.restaurantId`; no parameters.
2. Body, `cache-control: no-store`: `{ creditEnabled: boolean, customers: [{ id, name, phone, creditLimitMinor: string | null, balanceMinor: string, payOnly: boolean }] }` — live customers (`payOnly: false`) plus archived customers whose balance is not zero (`payOnly: true`). Exactly these fields.

**Tests — MANDATORY:** no cookie → 403; revoked device → 403; another restaurant's customers never appear; the response keys are exactly the six; an archived customer with a balance appears pay-only, one at zero does not.

**Done when:** `pnpm test -- customers.integration route-guards permissions` passes.

---

### T-14 — Report queries: identities and the credit report

**Needs:** T-10, T-11
**Files:**
- `src/lib/server/reports/sales.ts` — EDIT (`SalesReport` type, takings, `byTender`, `byPaymentMethod`)
- `src/lib/server/reports/credit.ts` — NEW (`creditReport(executor, restaurantId, businessDate)`)
- `src/lib/server/reports/sales.integration.test.ts` — EDIT; `credit.integration.test.ts` — NEW
**Spec:** 26, 27 (plain indexed SQL over stored columns)
**Invariants:** 11 (group by the shift's business date), 1 (reports never recompute money)

**Do:** implement "Shared contracts → Reports" exactly.
1. `takings` excludes credit; add `soldOnCredit` and `customerPaymentsReceived: [{ kind, paymentMethodId, name, count, amount }]` (payments on the date minus reversals dated the date).
2. `byTender` and `byPaymentMethod` carry a `credit` row.
3. `creditReport`: the date's credit charges (invoice, customer, cashier, till, amount) with a total per cashier, and the date's customer payments and reversals (customer, method, cashier, amount) with a total per cashier.
4. `/reports`' "empty day" logic must treat a day with only customer payments as not empty.

**Tests:** on a day with cash 11.00, card 22.00, credit 33.00 (exclusive 10%): takings 33.00, soldOnCredit 33.00, netSales + tax 66.00, sum(byTender) 66.00, by order type 66.00; a 20.00 customer payment appears only in `customerPaymentsReceived`; a reversal dated another day shows there as a negative; every existing pinned identity is updated to the new statement, none deleted.

**Done when:** `pnpm test:integration -- reports` passes.
