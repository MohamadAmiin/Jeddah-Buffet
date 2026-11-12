# Phase 6 — End-to-end and documentation

**Depends on:** Phases 1–5.

### T-24 — End-to-end: charge, offline charge, repayment

**Needs:** T-18, T-20, T-21, T-22, T-23
**Files:**
- `e2e/pos-sale.spec.ts` — EDIT (a third serial test reusing the restaurant, cashier and tills of the first two)
- `e2e/fixtures.ts` — EDIT (helpers `addCustomer`, `enableCredit`, `chargeToCredit`, `receivePayment`)
**Spec:** 29

**Do:** NEVER sign up a new restaurant — the suite already fills the `/register` throttle (10 per 10 minutes). In the reused restaurant:
1. Owner: enable Customer credit; add a customer with a 50.00 limit.
2. Till (after a fresh sign-in so the tender is cached): charge a 30.00 bill → receipt job holds `ON CREDIT - NOT PAID` and no drawer pulse was sent; a second 30.00 bill is refused in words.
3. Go offline: charge 10.00 → completes; reconnect → the queue drains, exactly one order for it in the database.
4. Receive 20.00 cash → one `customer_payments` row, the drawer pulsed once, the payment receipt job shows balance 20.00.
5. Close the shift: expected cash includes the 20.00 and excludes the 40.00 of credit sales.
6. Dashboard: the statement reads 30.00, 10.00, −20.00, balance 20.00; `/reports` shows 40.00 sold on credit and 20.00 received; the journal's 1100 net is 20.00.

**Done when:** `pnpm test:e2e` passes in full (the whole suite, not only this spec).

---

### T-25 — `CLAUDE.md`, `scripts/deploy.sh`, READMEs

**Needs:** T-24
**Files:**
- `CLAUDE.md` — EDIT
- `scripts/deploy.sh` — EDIT (beside the existing "never roll back past 0019" note)
- `src/lib/pos/README.md`, `src/lib/server/permissions/README.md` if they list kinds/keys — EDIT

**Do:**
1. Invariant 5: add — "A completed offline CREDIT charge to a customer the till knows is the same kind of fact (decided 2026-11-12): recorded and flagged, never rejected; receiving a customer's payment needs a connection."
2. Mandatory-test lists: add the new test files under their areas.
3. Module map: `customers/` (index.ts, payments.ts), `reports/credit.ts`, `src/lib/pos/customers.ts`, `customer-payments.ts`, the routes `/customers`, `/reports/credit`, `/pos/customers`, `/api/pos/customers`; `accounting/chart.ts` now 24 codes; the dependency rule for `customers/`.
4. Glossary: Customer, Credit charge, Customer payment, Pay-only customer; Account codes — "spec 23's numbers plus 1100".
5. "Decisions already made": one entry "Customer credit — decided 2026-11-12 (`tasks/customer-credit`)" recording the six answers in the user's chosen options, the plan-approved defaults, the panel-adopted defaults marked "not individually confirmed", the accepted risks, the lock order, the report identities, the no-IndexedDB-bump rule, and the rollback rule. Amend decision (b) (tender set), Settings 2/3 (kinds and accounts), "Payment methods — decided 2026-10-01" (a second built-in row), and decision (c) (24 accounts).
6. Open decisions: row 3 gains "tax recognised at the credit sale; legal content of a credit invoice".
7. "Do NOT build": remove "Accounts Receivable"; add "customer credit beyond `tasks/customer-credit` (write-offs, due dates, interest, reminders, prepaid balances, split tenders)".
8. `scripts/deploy.sh`: "Never roll the code back past migration 0021 once a credit sale or a customer payment exists — the older code cannot post or read them. Roll forward."

**Done when:** `pnpm check && pnpm lint && pnpm test` green; `CLAUDE.md` reads consistently end to end (grep it for "23 accounts", "cash, card and mobile", "Accounts Receivable").
