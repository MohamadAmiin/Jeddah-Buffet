# Phase 4 — The till (offline)

**Depends on:** Phase 1 (T-01) and, per task, Phase 3. Read `00-overview.md` → "Wire", "Classes".

Rules for every task here: nothing under `src/lib/pos/` or `src/routes/(pos)/` imports `$lib/server/**`; the UI never does money arithmetic — amounts come from `src/lib/money` and render through its formatter; **`DB_VERSION` in `src/lib/pos/store.ts` stays 3** (a version bump cannot be rolled back; the production revert of 2026-11-08 is why); every pressable POS surface takes `border-control-line`; a disabled control says why in words; status is glyph plus word, never colour alone.

### T-15 — `tenderClass`, the credit option, the tripwire

**Needs:** T-01
**Files:**
- `src/lib/pos/tenders.ts` — EDIT; `src/lib/pos/tenders.test.ts` — EDIT
- `src/lib/pos/settings.ts` — EDIT (`readPaymentMethods` keeps kind `credit`); its test — EDIT
- `src/lib/pos/can-print.ts`, `src/lib/pos/printing.ts` (`saleStatusMark`, the drawer rule's comment) — EDIT; their tests — EDIT
**Invariants:** 5 (card and mobile still fail closed offline; cash and credit are facts)

**Do:**
1. `TenderKind = 'cash' | 'card' | 'mobile' | 'credit'`; icon `'account'` (add the glyph where tender icons are drawn).
2. Export `tenderClass(kind): 'fact' | 'request'` — cash and credit → `'fact'`; card and mobile → `'request'`; anything else → `'request'` (closed).
3. `tenderOptions`: after cash, card and mobile, append ONE credit option when the cached methods hold a row of kind `credit` (the server only sends it when enabled). `tenderReason('credit', online, ctx)`: never the offline reason; returns `'Needs permission to take payments'` without `pos.payment`, `'No customers on this till yet'` when the customers cache is empty.
4. `canPrint`: a `'fact'` tender prints at once; a `'request'` tender waits for the server (unchanged for card/mobile). `saleStatusMark`: a credit sale is never "Awaiting confirmation". The drawer rule stays `method === 'cash'` exactly — credit never pulses. `autoPrint` stays card/mobile only.
5. Source-text tripwire test: under `src/lib/pos` and `src/routes/(pos)`, every `=== 'cash'` / `!== 'cash'` comparison sits in an allow-list of files and reasons (drawer rule, cash keypad, change line); a new one fails the test. Class decisions must call `tenderClass`.

**Tests:** the above, plus: an unknown kind is still dropped; a second credit row is dropped; offline, card/mobile are disabled and credit is not.

**Done when:** `pnpm test:unit -- tenders settings can-print printing` passes.

---

### T-16 — The customers cache and the limit check

**Needs:** T-13, T-15
**Files:**
- `src/lib/pos/customers.ts` — NEW; `src/lib/pos/customers.test.ts` — NEW
- `src/lib/pos/store.ts` — EDIT only if a helper is needed; NO new object store, NO version change
**Invariants:** 5, 1

**Do:**
1. Cache = ONE key of the existing `settings` store, `customers`: `{ requestedAt, creditEnabled, customers: [...] }`. It is NOT in `KEPT_SETTING_KEYS`, so `bindDevice`/`forgetDevice` already clear it.
2. `refreshCustomers()`: only when online AND the signed-in employee holds `pos.payment`; `GET /api/pos/customers`, `credentials: 'same-origin'`; 403 → the existing revoked-device path (`forgetDevice`); any other failure keeps the old cache (the `refreshReceiptLogo` pattern in `settings.ts`). Record `requestedAt` = the time the request was SENT. Called at sign-in, after a flush that drained, and when the picker or `/pos/customers` opens.
3. `readCustomers()`, `searchCustomers(list, query)` (name or phone, case-insensitive, digits-only match for phones).
4. `localCharges(customerId)`: the sum (money module) of this till's completed credit sales to that customer that are (a) not yet synced, or (b) stored unrecorded, or (c) synced AFTER the cache's `requestedAt` — whatever `deviceId` they were queued under.
5. `creditCheck({ customer, billTotal, cache, localCharges })` → `{ ok: true, available } | { ok: false, reason: 'pay_only' | 'over_limit' | 'credit_off', words }`. `available = limit − cachedBalance − localCharges` (money module); no limit → always ok. Online, the pay screen awaits `refreshCustomers()` (bounded to 3 s) before the check.
6. Export `asOf(cache)` so every screen showing a cached balance prints "as of HH:MM".

**Tests:** limit 50, cached 0, one unsynced 30 → a second 30 is refused; the same after the 30 synced but before a newer refresh; allowed again once a refresh requested after the sync shows 30; an unrecorded charge always counts; pay-only customers are never chargeable; no fetch without `pos.payment`.

**Done when:** `pnpm test:unit -- pos/customers` passes.

---

### T-17 — A credit sale: cart, completeSale, receipt

**Needs:** T-15, T-16
**Files:**
- `src/lib/pos/orders.ts` — EDIT (`Cart`, `CompleteSaleArgs`, `validateBeforeTx`, `completeSale`); `orders.test.ts` — EDIT
- `src/lib/pos/receipt.ts` — EDIT (block 9, the payment); `receipt.test.ts` — EDIT
- `src/lib/pos/store.ts` — EDIT (`SaleSnapshot` type only, if the customer needs a typed home)
**Spec:** 6, 11
**Invariants:** 5 (the sale is complete on the device: invoice number from the device sequence, one queued op, same transaction as today)

**Do:**
1. `CompleteSaleArgs.payment` gains `method: 'credit'` and `customer: { id, name, phone } | null`. The customer is passed to `completeSale` by the pay screen — it is NOT stored on the cart, so a cashier who switches back to Cash cannot carry it along.
2. `validateBeforeTx`: `credit` requires a customer; any other method must have none.
3. The payload's payment carries `customerId` and `customerName` (cleaned with `cleanCustomerName`) ONLY for `credit`; `tenderedMinor`/`changeMinor` null. The sale snapshot stores the same, so the receipt prints from the snapshot alone.
4. Receipt, credit sale, block 9: `ON CREDIT - NOT PAID` (centred, in place of the tender line), `Charged to: <name>`, the phone, then two blank lines and `Signature: ____________`. These lines are NEVER hideable — add them to the never-hideable list in the header comment. Arabic names go through the existing paper path unchanged. No balance line (the balance is not in the snapshot).
5. Reprints carry COPY as today.

**Tests:** `completeSale` with credit enqueues one `sale.complete` whose payment has the customer and no cash fields, takes exactly one invoice number, and stores the snapshot; cash with a customer is refused before the transaction; the receipt shows the three lines with every show-switch off, at 32 and 48 columns; the receipt source tripwire still passes.

**Done when:** `pnpm test:unit -- orders receipt` passes.

---

### T-18 — The pay screen

**Needs:** T-17
**Files:**
- `src/routes/(pos)/pos/pay/+page.svelte` — EDIT (the tender radiogroup, the per-tender pane, `pay()`, the outcome branch)
- `src/lib/pos/components/` a `CustomerPicker.svelte` — NEW (or beside the page, following where `TaxExemptSheet` lives)
- `src/routes/(pos)/pos/sales/+page.svelte` — EDIT (`tenderOf` shows "Customer credit — <name>")
**Invariants:** 5

**Do:**
1. The credit radio appears from `tenderOptions`; its disabled reason comes from `tenderReason`.
2. Selected: a pane INSIDE the pay panel (not a modal): a search field, the matching customers each with balance, limit, available and "as of HH:MM"; pay-only customers are not listed. Picking one shows `creditCheck`'s result; a refusal is shown in words and blocks Pay (`payBlocked`: `'Choose a customer'`, or the refusal).
3. `pay()`: `outcome` and the immediate `printOriginals(orderId, { drawer: false })` come from `tenderClass(option.kind) === 'fact'`; cash keeps `drawer: true`. A credit sale shows PAID-style completion worded "Charged to <name>", never PENDING, no Cancel.
4. Changing the tender away from credit clears the chosen customer.

**Tests:** component/unit tests where the repo has them for this page; otherwise covered by T-24's e2e. `pnpm check` clean.

**Done when:** on `pnpm dev`, online and offline, a credit charge completes, prints once, the drawer stays shut, and the sale appears on `/pos/sales` with the customer.

---

### T-19 — The payment record, the queue, the drawer and the receipt

**Needs:** T-12, T-16
**Files:**
- `src/lib/pos/customer-payments.ts` — NEW; its test — NEW
- `src/lib/pos/queue.ts` — EDIT (the handling of a `customer.payment` entry's answers; `rewritePosSessionId`'s kinds); `queue.test.ts` — EDIT
- `src/lib/pos/printing.ts` — EDIT (a second, explicit drawer/print clause for payments); `src/lib/pos/receipt.ts` — EDIT (`renderPaymentReceipt`); tests — EDIT
**Spec:** 6, 11
**Invariants:** 5 (the device key makes a retry a no-op), 9/10 (no drawer pulse without a recorded reason)

**Do:**
1. `startCustomerPayment({ customer, amountMinor, tender, tenderedMinor, session, employee })`: in ONE IndexedDB transaction enqueue the `customer.payment` op and store the local record ON that queue entry: `{ paymentId, customerId, customerName, amountMinor, method, methodName, tappedAt, state: 'pending' | 'confirmed' | 'refused', balanceAfterMinor?, refusal?, printed?, drawerPulsed?, acknowledged? }`. Refuse to start when another payment for the same customer is `pending`, when offline, or when no shift is open.
2. Queue answers for this kind: 200 accepted/replayed → `confirmed` with `balanceAfterMinor`; 403 / 422 (except `database_error`) → `refused` with the reason, entry done, NO `sale.abandoned` (no invoice number was burned); network failure or `database_error` → stays `pending` and retries under the SAME `clientOpId`. There is no Cancel for a pending payment.
3. On `confirmed`, once per `paymentId`: print `renderPaymentReceipt` and — cash only, only within 30 s of `tappedAt` — pulse the drawer. Never at the tap, never on a refusal, never on a reprint. A confirmation later than 30 s prints and says "Open the drawer with the next cash sale" on screen.
4. `renderPaymentReceipt`: restaurant header as on a receipt, `PAYMENT RECEIVED`, date/time, customer name and phone, method, `Amount`, cash `Tendered`/`Change`, `Balance before` (= after + amount, money module), `Balance after`, cashier, till, COPY on reprints. Printable from the record alone.
5. Confirmed and acknowledged-refused records are pruned with the 30-day pass; pending ones never.
6. Add `'customer.payment'` to the kinds `rewritePosSessionId` rewrites.

**Tests — MANDATORY (offline sync):** a lost response leaves the record `pending` and a second `startCustomerPayment` for that customer is refused; the retry confirms once and prints once; a 422 marks it refused, prints nothing, pulses nothing; `database_error` keeps it pending; logout and shift close remain blocked while the queue is non-empty (existing rule — assert it covers this kind).

**Done when:** `pnpm test:unit -- customer-payments queue printing receipt` passes.

---

### T-20 — The `/pos/customers` screen

**Needs:** T-19
**Files:**
- `src/routes/(pos)/pos/customers/+page.svelte` — NEW
- the till's navigation (where `/pos/sales` is linked) — EDIT
- `src/service-worker.test.ts` / route-tree tests if they pin POS routes — EDIT
**Invariants:** 5, 8 (the screen is UX; the server's 403 is the control)

**Do:**
1. Shown only to an employee holding `pos.payment` (the `mayManageShift` pattern); others see a sentence, and no customer data is fetched.
2. The list: customers who owe first, then the rest; pay-only (archived) customers marked `◐ archived — payment only`; each with balance and "as of HH:MM"; search as on the pay screen. Reachable whether or not credit is enabled, whenever the cache holds anyone.
3. **Receive payment** for a customer who owes: amount (keypad, defaults to the full balance, never above it), tender from the cached cash/card/mobile methods. Disabled with the reason: offline (`◆ Needs a connection`), no open shift, a payment for this customer still pending.
4. A pending payment is permanent chrome on this screen and in the till bar's unsynced count: "Payment of X from <name> — waiting for the server". A refused one stays until the cashier presses **OK, I gave the money back** (sets `acknowledged`).
5. After confirmation: the new balance, and **Reprint** (needs `pos.print_receipt`).

**Done when:** `pnpm check && pnpm lint` clean; on `pnpm dev` a cash payment opens the drawer once, prints once, and the balance drops; with the network cut mid-request the screen shows the pending chrome and recovers without a duplicate.
