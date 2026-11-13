# Phase 1 — Contracts and schema

Read `00-overview.md` first: "Shared contracts" is the specification these tasks implement.

### T-01 — Wire contracts in `sync-ops`

**Needs:** -
**Files:**
- `src/lib/sync-ops/index.ts` — EDIT (the lists near the top; `SalePayment`; `SyncResult`; a new cleaner beside `cleanTaxOverrideReason`)
- the existing test file beside it (find it: `ls src/lib/sync-ops`) — EDIT
**Spec:** 6 (idempotent queued operations)
**Invariants:** 5 (every queued op carries a device key; a payload from an older till must still record)

**Do:**
1. Append `'credit'` to `PAYMENT_METHODS`. Add `CUSTOMER_PAYMENT_METHODS = ['cash','card','mobile'] as const`.
2. Append `'customer.payment'` to `OP_KINDS`; export `CustomerPaymentPayload` exactly as in the overview's "Wire".
3. Append `credit_limit_exceeded`, `customer_archived`, `credit_not_enabled` to `SOFT_FLAGS`.
4. `SalePayment`: add OPTIONAL `customerId?: string | null` and `customerName?: string | null`, with a doc comment in the style of `note` ("a till queued before customer credit omits the key").
5. `SyncResult`: add optional `balanceAfterMinor?: string`.
6. Export `CUSTOMER_NAME_MAX = 80` and `cleanCustomerName(raw: string): string` — trim, collapse runs of whitespace to one space, drop control characters, cut to 80 code points (reuse `codePointLength`'s approach). It never throws and may return `''`.
7. The module still imports nothing.

**Tests:** the lists are pinned verbatim; `cleanCustomerName` on a 120-character name returns 80 code points, on `'  Ali \n Hassan '` returns `'Ali Hassan'`, on an astral-plane name never splits a surrogate pair.

**Done when:** `pnpm test:unit` passes for `src/lib/sync-ops`. Other suites that pin these lists will now fail (`constraints.integration.test.ts`, `posting-rules.test.ts`'s `eventForMethod` loop, `tenders`, `settings`) — that is expected; each is fixed by the task that owns it. Do NOT weaken them here; note the failing files in the commit body.

**Watch out:** `eventForMethod` throws on `'credit'` until T-06, and `readPaymentMethods`/`tenderOptions` drop it until T-15. Do not touch them here.

---

### T-02 — Drizzle schema and generated migration 0021

**Needs:** T-01
**Files:**
- `src/lib/server/db/schema/customers.ts` — NEW (`customers`, `customer_payments`)
- `src/lib/server/db/schema/orders.ts` — EDIT (the `payments` table)
- `src/lib/server/db/schema/payment-methods.ts` — EDIT (kind CHECK, one-credit index, credit rules)
- `src/lib/server/db/schema/accounting.ts`, `src/lib/server/db/schema/pos-sync.ts` — EDIT (value-set CHECKs)
- the schema barrel/index if one exists, `src/lib/server/db/test/reset.ts`, `src/lib/server/db/schema-guards/schema.test.ts` — EDIT
- `src/lib/server/db/migrations/0021_*.sql` + `meta/` — NEW, by `pnpm db:generate`
**Spec:** 3, 17 (money columns)
**Invariants:** 1 (money is `bigint` minor units — `credit_limit_minor`, `amount_minor`, `balance_after_minor`; never `numeric`), 2 (posted rows are permanent), 11 (`timestamptz`; `business_date` is a `date` taken from the shift)

**Do:**
1. Create the two tables exactly as "Shared contracts → Tables" specifies, following the conventions of `src/lib/server/db/schema/purchases.ts` (`supplier_payments` is the twin of `customer_payments`: copy its reversal CHECK and add `reversal_business_date` to the all-or-none group). Composite foreign keys target `unique('<table>_id_restaurant_unique')` constraints, never a `uniqueIndex` (error 42830).
2. `payments`: the two columns, `payments_credit_customer`, the FK, the partial index; widen `payments_method_valid`.
3. `payment_methods`: widen `payment_methods_kind_valid`; add `payment_methods_one_credit` and `payment_methods_credit_rules`.
4. Widen `journal_entries_event_valid` (+`credit_sale`, `customer_payment_received`), `journal_entries_source_type_valid` (+`customer_payment`), `pos_sync_ops_kind_valid` (+`customer.payment`). If any CHECK or enum spells the soft-flag list, widen it too (grep the schema for `totals_mismatch`).
5. `pnpm db:generate`. Read the SQL: it must only CREATE the two tables, ADD the two columns, and DROP/ADD the named CHECKs. If drizzle-kit emits anything destructive, stop.
6. Add both tables to `TABLES` in `reset.ts` and to the pinned list and imports in `schema.test.ts`.
7. Before `pnpm db:migrate` on the dev database: it is shared across worktrees — compare the applied migration hashes with the files first; if another branch has applied a different 0021, stop and report.

**Tests:** `schema.test.ts` green (table list, `restaurant_id`, `_minor` naming, `timestamptz`).

**Done when:** `pnpm db:generate` reports no further changes; `pnpm test:unit -- schema.test` passes; the test database migrates.

**Watch out:** `payments` is append-only by trigger, but adding nullable columns is DDL and allowed; never backfill them (invariant 2). `customer_payments.method` uses its own three-value list — a customer cannot pay a debt with credit.

---

### T-03 — Custom migration 0022: triggers and seeds

**Needs:** T-02
**Files:**
- `src/lib/server/db/migrations/0022_customer_credit_guards.sql` + `meta/` — NEW, by `pnpm exec drizzle-kit generate --custom --name customer_credit_guards`
- `src/lib/server/db/schema-guards/backfill-0022.integration.test.ts` — NEW (model: `backfill-0017.integration.test.ts`)
**Invariants:** 2 (the migration posts nothing and rewrites no posted row), 3

**Do:**
1. Trigger on `customers`: BEFORE DELETE raises (reuse the archive-only function migration 0017 created for `payment_methods`/`tax_rates` if it is generic; read 0017 first).
2. Function + trigger `customer_payments_guard`: BEFORE DELETE raises; BEFORE UPDATE raises unless every column outside the reversal group is unchanged AND the old `reversed_at IS NULL` AND the new reversal group is fully set.
3. Seed, for every existing restaurant, `ON CONFLICT DO NOTHING`:
   - the account `1100`, `Accounts Receivable`, type `asset` (conflict target `(restaurant_id, code)`);
   - one `payment_methods` row: kind `credit`, `enabled = false`, no merchant number, `sort_order` after the last existing row, conflict target the `payment_methods_one_credit` partial index. Name `Customer credit`, or `Customer credit (account)` when a live method of that restaurant already has `lower(name) = 'customer credit'`.
4. Write at the top of the file what it does and that it must never be edited once run.

**Tests (backfill-0022):** a restaurant with the 23-account chart and only Cash gains exactly one account and one disabled credit row; a restaurant already owning a card method named "Customer credit" gets the fallback name; running the seed statements twice changes nothing; the journal, payments and orders row counts are unchanged.

**Done when:** `pnpm test:integration -- backfill-0022` passes and `pnpm db:generate` emits nothing new.

**Watch out:** a `--custom` migration's snapshot is a copy of the previous one — put NO schema change here that drizzle knows about, or the next `db:generate` re-emits it.

---

### T-04 — Constraint tests for the new guards

**Needs:** T-03
**Files:**
- `src/lib/server/db/schema-guards/constraints.integration.test.ts` — EDIT (the pinned lists near the existing `PAYMENT_METHODS`/`OP_KINDS`/events assertions; new describe blocks beside `payments_cash_fields` and `payments_payment_method_fk`)
**Invariants:** 2, 5

**Do / Tests** — each a database rejection or acceptance:
- The pinned lists equal the new `PAYMENT_METHODS`, `OP_KINDS`, posting events, source types; `payment_methods_kind_valid` equals `PAYMENT_METHODS`.
- `payments_credit_customer`: a credit payment without a customer is rejected; a cash payment with a customer is rejected; a credit payment with customer id and name inserts.
- `payments_payment_method_fk`: a credit payment pointing at the Cash row is rejected.
- `payment_methods`: a second credit row for one restaurant is rejected; a credit row with a merchant number or `archived_at` is rejected; its kind cannot change (existing trigger).
- `customers`: DELETE raises; two live customers with one phone are rejected; an archived one frees the phone.
- `customer_payments`: `amount_minor = 0` rejected; method `credit` rejected; cash without tendered/change rejected; DELETE raises; UPDATE of `amount_minor` raises; stamping the reversal group once succeeds, twice raises; a partial reversal group is rejected.

**Done when:** `pnpm test:integration -- constraints` passes.
