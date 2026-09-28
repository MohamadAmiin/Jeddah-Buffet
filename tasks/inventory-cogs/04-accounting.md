# Phase 2 (domain) — accounting (T-13, T-14)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: Phase 1 (T-07 migrates the
> widened journal CHECKs).

Journal entries are generated from business events by the spec 24 rule table; nobody types a debit
(invariant 3). This phase extends the accounting module that tasks/pos-sales built — it does not create
a second one. It adds eight events and their pure rule functions, widens the source types an entry may
name, and adds `postReversal`, which is the only way a reversing entry is ever created (spec 22: "A
mistake is fixed with a reversing entry plus a correct new entry"). Every rule function is pure: it
returns `RuleLine[]` and touches no database; `postEntry` (pos-sales T-14) validates the lines, drops
zero-amount ones, resolves account codes and inserts, and the deferred trigger from migration 0012
rejects any unbalanced entry at COMMIT. pos-sales' own tests pin the six-event world; they are rewritten
here to enumerate from the constants, never deleted, and every case keeps asserting its original
behaviour.

### T-13 — Posting rules for the eight new events; rewrite the pinned pos-sales assertions

**Needs:** T-07
**Files:**
- `src/lib/server/accounting/posting-rules.ts` — EDIT (created by tasks/pos-sales T-13; extend the
  `POSTING_EVENTS` array after its sixth member; add the new functions after `overShortEvent`)
- `src/lib/server/accounting/journal.ts` — EDIT (created by tasks/pos-sales T-14; add
  `JOURNAL_SOURCE_TYPES` above `JournalEntryInput` and change its `sourceType` field's type)
- `src/lib/server/accounting/posting-rules.test.ts` — EDIT (created by tasks/pos-sales T-13; the pinned
  deep-equal of `POSTING_EVENTS` and of the emitted account-code set; add a new `describe` block)
- `src/lib/server/accounting/journal.integration.test.ts` — EDIT (created by tasks/pos-sales T-14; the
  property test that draws `POSTING_EVENTS[i % 6]`, and any assertion that exactly six distinct events
  were posted)
**Spec:** 24 (the rows "Purchase paid immediately | Inventory | Cash on Hand or Bank", "Purchase on credit
| Inventory | Accounts Payable", "Supplier paid | Accounts Payable | Cash on Hand or Bank", "Waste / void
after preparation | Waste & Inventory Adjustments | Inventory", "Stock count shortfall | Waste &
Inventory Adjustments | Inventory", "Stock count surplus | Inventory | Waste & Inventory Adjustments",
"Cost of food sold | COGS | Inventory"), 23 (the account codes, verbatim), 19 (purchases and Accounts
Payable), 22 (entries are generated, never typed)
**Invariants:** 3 (journal entries balance in the database and are generated from the rule table —
nobody types a debit), 1 (every amount is a `Minor` bigint)

**Do:**
1. Extend `POSTING_EVENTS`, keeping pos-sales' six first and in their order, then:
   `'purchase_paid', 'purchase_on_credit', 'supplier_paid', 'waste', 'stock_count_shortfall',
   'stock_count_surplus', 'inventory_revaluation', 'opening_stock'` — fourteen, spelled exactly as the
   CHECK T-06 wrote.
2. Add, each with a doc comment quoting its spec 24 row (or, for the last two, the overview assumption
   that defines it):
   - `purchaseEvent(paidBy: 'cash' | 'bank' | 'credit'): PostingEvent` → `'purchase_paid'` for cash and
     bank, `'purchase_on_credit'` for credit.
   - `purchaseLines(paidBy, total: Minor): RuleLine[]` → `[{ code: '1200', debit: total }, { code: '1000'
     | '1010' | '2000', credit: total }]` for cash (1000 Cash on Hand), bank (1010 Bank), credit (2000
     Accounts Payable).
   - `supplierPaymentLines(paidFrom: 'cash' | 'bank', amount: Minor)` → `[{ code: '2000', debit },
     { code: '1000' | '1010', credit }]`.
   - `wasteLines(cost: Minor)` → `[{ code: '5100', debit: cost }, { code: '1200', credit: cost }]`.
   - `countShortfallLines(amount: Minor)` → `Dr 5100 / Cr 1200`.
   - `countSurplusLines(amount: Minor)` → `Dr 1200 / Cr 5100`.
   - `revaluationLines(net: Minor)` (signed) → `net < 0n`: `[{ code: '5000', debit: -net }, { code: '1200',
     credit: -net }]`; `net > 0n`: `[{ code: '1200', debit: net }, { code: '5000', credit: net }]`;
     `net === 0n`: `[]`. (Assumption 2: 5000 Cost of Goods Sold.)
   - `openingStockLines(value: Minor)` → `[{ code: '1200', debit: value }, { code: '3000', credit: value }]`
     (3000 Owner's Capital; assumption 1 — a recorded amendment to spec 24, which has no row for stock the
     owner contributes).
   Every function except `revaluationLines` throws `TypeError` for a negative amount; none drops a zero
   line (that is `postEntry`'s job) and none reads the database.
3. In `journal.ts`, export `JOURNAL_SOURCE_TYPES = ['order', 'pos_session', 'purchase',
   'supplier_payment', 'waste_entry', 'stock_count', 'opening_stock'] as const` and set
   `JournalEntryInput.sourceType: (typeof JOURNAL_SOURCE_TYPES)[number]`. Nothing else in `postEntry`
   changes.
4. Rewrite the pinned pos-sales assertions T-01 recorded: the `POSTING_EVENTS` deep-equal becomes the
   fourteen; the emitted-code set assertion grows to include `1010`, `2000`, `3000` and `5100`; in
   `journal.integration.test.ts` replace `POSTING_EVENTS[i % 6]` with `POSTING_EVENTS[i %
   POSTING_EVENTS.length]` and a map from every event to a rule builder (the six existing builders
   unchanged, plus one per new event using the functions above with seeded amounts), and any
   "exactly six distinct events" assertion with `POSTING_EVENTS.length`.

**Tests:** MANDATORY (spec 29 — one posting-rule test per business event in the spec 24 table), in
`posting-rules.test.ts`:
- `purchaseLines('cash', 11000n)` deep-equals `[{ code: '1200', debit: 11000n }, { code: '1000', credit:
  11000n }]` and `purchaseEvent('cash')` is `'purchase_paid'`.
- `purchaseLines('bank', 11000n)` → credit line code `'1010'`; `purchaseEvent('bank')` → `'purchase_paid'`.
- `purchaseLines('credit', 11000n)` → credit line code `'2000'`; `purchaseEvent('credit')` →
  `'purchase_on_credit'`.
- `supplierPaymentLines('cash', 5000n)` → `[{ code: '2000', debit: 5000n }, { code: '1000', credit: 5000n }]`;
  `'bank'` → credit code `'1010'`.
- `wasteLines(82n)` → `[{ code: '5100', debit: 82n }, { code: '1200', credit: 82n }]`.
- `countShortfallLines(300n)` → `Dr 5100 300 / Cr 1200 300`; `countSurplusLines(300n)` → `Dr 1200 300 /
  Cr 5100 300`.
- `revaluationLines(-15000n)` → `[{ code: '5000', debit: 15000n }, { code: '1200', credit: 15000n }]`;
  `revaluationLines(3600n)` → `[{ code: '1200', debit: 3600n }, { code: '5000', credit: 3600n }]`;
  `revaluationLines(0n)` → `[]`.
- `openingStockLines(25000n)` → `[{ code: '1200', debit: 25000n }, { code: '3000', credit: 25000n }]`.
- Each non-signed function throws `TypeError` for `-1n`.
- Every code any rule emits exists in `CHART`; `linesBalance` is true for every rule over 1,000 seeded
  amounts (a seeded LCG, amounts `0n`–`10_000_000n`, signed for `revaluationLines`).
- `POSTING_EVENTS` deep-equals the fourteen literals; `JOURNAL_SOURCE_TYPES` deep-equals the seven.
- The rewritten pos-sales cases still assert what they asserted before (sale, COGS, over/short).

**Done when:** `pnpm test` passes (unit and integration), including every pos-sales test.

**Watch out:** `src/lib/server/accounting/index.ts` already `export *`s `posting-rules` and `journal`
(read it to confirm); do not edit it. Do not touch 4100 Sales Discounts or any sale rule. The codes are
spec 23's, verbatim; never invent one.

### T-14 — `postReversal` and the extended journal balance property test

**Needs:** T-13
**Files:**
- `src/lib/server/accounting/journal.ts` — EDIT (created by tasks/pos-sales T-14; add `postReversal`
  after `postEntry`, before `entryLines`)
- `src/lib/server/accounting/journal.integration.test.ts` — EDIT (created by tasks/pos-sales T-14; extend
  the property test T-13 rewrote, and add a `describe('postReversal')` block)
- `src/lib/server/accounting/README.md` — EDIT (created on main, extended by tasks/pos-sales; one line
  under the module's contents for `postReversal` and the one-reversal-per-entry index)
**Spec:** 22 ("Posted entries are never edited or deleted. A mistake is fixed with a reversing entry plus
a correct new entry"; "The database rejects any entry whose debits and credits don't match"), 3 (posted
records are permanent)
**Invariants:** 2 (posted records are permanent — the original is never updated), 3 (the mirror
balances because every line is swapped; the deferred trigger still checks it at COMMIT), 11 (the
reversal carries the business date it is given, never the original's)

**Do:**
1. Export `postReversal(tx: DbTx, input: { restaurantId: string; entryId: string; businessDate: string;
   memo: string }): Promise<{ entryId: string }>`:
   1. Throw `TypeError` unless `businessDate` matches `/^\d{4}-\d{2}-\d{2}$/` (the same check `postEntry`
      makes).
   2. Select the original header by `id = entryId AND restaurant_id = restaurantId`. None → throw
      `Error('journal entry not found')` (another restaurant's id lands here too).
   3. If its `reverses_entry_id` is not null → throw `Error('a reversal cannot be reversed')`.
   4. Read its lines with `entryLines(tx, entryId)` (it returns `{ lineNo, code, name, debit, credit }`).
   5. Insert the mirror header: the same `event`, `source_type` and `source_id`,
      `reverses_entry_id = entryId`, the given `memo` and `business_date`, `posted_at` now, the same
      `restaurant_id`.
   6. Insert one mirror line per original line, `line_no` preserved, `debit_minor` and `credit_minor`
      swapped, the account resolved by code within the restaurant (`accountIdByCode`, as `postEntry`
      does).
   7. Return `{ entryId: <the new id> }`.
2. It never catches, never opens its own transaction, and never updates or deletes the original or its
   lines (invariant 2; migration 0012's append-only triggers would reject it anyway).
3. README line: "`postReversal` is the only way a reversing entry is created; the partial unique index
   `journal_entries_reverses_entry_unique` allows one reversal per entry."

**Tests:** (integration, `journal.integration.test.ts`)
- MANDATORY (spec 29 — journal entries always balance, property test over generated events): the
  property test now posts entries for all fourteen events with seeded amounts, then calls
  `postReversal` on a random half of them, all inside one transaction per iteration; afterwards every
  entry's Σ debit equals Σ credit and every entry has at least one debit and one credit line.
- MANDATORY (spec 29 — the DB rejects an unbalanced entry): the existing pos-sales case stays and still
  passes (a single-line entry rejected at COMMIT).
- A `purchase_on_credit` entry of `11000n` (`Dr 1200 / Cr 2000`) reversed → the new entry's lines are
  `Dr 2000 11000 / Cr 1200 11000`, its event is `'purchase_on_credit'`, its `reverses_entry_id` is the
  original's id, its `business_date` is the one passed; re-selecting the original shows it unchanged.
- A second `postReversal` of the same entry rejects with SQLSTATE 23505 on
  `journal_entries_reverses_entry_unique`, and the row counts of both journal tables are unchanged.
- Reversing a reversal throws `'a reversal cannot be reversed'`.
- Another restaurant's entry id throws `'journal entry not found'` and writes nothing.
- A bad business date (`'2026-9-28'`) throws `TypeError` before any query.

**Done when:** `pnpm test:integration src/lib/server/accounting` passes.

**Watch out:** the unique index makes a double-submitted reversal safe even without a lock, but the
callers (T-21, T-22) still lock their business row first so the refusal is a clean `already_reversed`
answer rather than a 23505. `entryLines` does not filter by restaurant; step 2's scoped header read is
what makes the function tenant-safe.
