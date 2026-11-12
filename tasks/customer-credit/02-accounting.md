# Phase 2 — Accounting

**Depends on:** Phase 1. Read `00-overview.md` → "Postings".

### T-05 — Account 1100 in the chart

**Needs:** T-03
**Files:**
- `src/lib/server/accounting/chart.ts` — EDIT (`CHART`, and the header comment)
- `src/lib/server/accounting/chart.integration.test.ts` and any other test asserting 23 accounts — EDIT (`grep -rn "23" src/lib/server/accounting src/lib/server/restaurants --include=*.test.ts`)
**Spec:** 23 ("We can expand this later")
**Invariants:** 3

**Do:**
1. Insert `{ code: '1100', name: 'Accounts Receivable', type: 'asset' }` between `1030` and `1200`.
2. Rewrite the header comment: spec 23's 23 codes verbatim PLUS `1100`, added by the user's decision of 2026-11-12 (`tasks/customer-credit`); any further code is still an open decision to surface.
3. `ensureChart` needs no change (idempotent insert of `CHART`).

**Tests:** chart length 24; `ensureChart` on a restaurant holding the old 23 adds exactly `1100` and is a no-op when run again; a newly registered restaurant has 24 accounts.

**Done when:** `pnpm test -- chart` passes.

---

### T-06 — Posting rules `credit_sale` and `customer_payment_received`

**Needs:** T-05
**Files:**
- `src/lib/server/accounting/posting-rules.ts` — EDIT
- `src/lib/server/accounting/journal.ts` — EDIT (`JOURNAL_SOURCE_TYPES` + `'customer_payment'`)
- `src/lib/server/accounting/posting-rules.test.ts` — EDIT
- `src/lib/server/accounting/journal.integration.test.ts` — EDIT (the property test over all events)
**Spec:** 22, 24 (rules as a table; this adds two rows the spec does not have — the recorded departure)
**Invariants:** 1 (every amount is a `Minor`; arithmetic only through `src/lib/money`), 3 (debits = credits)

**Do:**
1. `POSTING_EVENTS` += `'credit_sale'`, `'customer_payment_received'` (same spelling as T-02's CHECK). `SALE_EVENTS` += `'credit_sale'`. `CODE.ACCOUNTS_RECEIVABLE = '1100'`. `TENDER_ACCOUNT.credit_sale = '1100'`.
2. `eventForMethod('credit')` returns `'credit_sale'`. `saleLines` needs no other change: it then emits Dr 1100 `total`, Dr 4100 `discount` / Cr 4000 `subtotal`, Cr 2100 `tax`.
3. Export `customerPaymentLines(method: 'cash' | 'card' | 'mobile', amount: Minor): RuleLine[]` → `[{ code: 1000|1020|1030, debit: amount }, { code: '1100', credit: amount }]`; throws `RangeError` on a negative amount or any other method (`'credit'` included).

**Tests — MANDATORY (spec 29, one posting-rule test per event):**
- `credit_sale` with subtotal 3000, discount 0, tax 300, total 3300 → exactly `Dr 1100 3300 / Cr 4000 3000 / Cr 2100 300`; in inclusive mode with a tax-exempt bill, no 2100 line survives the writer.
- `customer_payment_received`: cash 2000 → `Dr 1000 2000 / Cr 1100 2000`; card → 1020; mobile → 1030; `'credit'` throws.
- The emitted-codes set gains `1100`; the pinned `POSTING_EVENTS` (16) and `JOURNAL_SOURCE_TYPES` lists updated; the 500-order balance loop runs over four sale events.
- MANDATORY (entries balance): the journal property test generates both new events and their reversals; every committed entry has debits = credits.

**Done when:** `pnpm test -- posting-rules journal` passes.

**Watch out:** the module-load check requires every `CODE` value to be in `CHART` — T-05 must be in.
