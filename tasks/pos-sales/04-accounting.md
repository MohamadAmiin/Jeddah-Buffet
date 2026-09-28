# Phase 2 (domain) — accounting (T-12, T-13, T-14)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 1; T-13 also on `03-money.md`.

**Depends on:** Phase 1 — T-04 (the `accounts`, `journal_entries`, `journal_entry_lines` tables),
T-08 (migration 0011, the reset list, the schema guards), T-09 (custom migration 0012 — this plan
calls it `0012_journal_guards.sql`; T-12 step 1 says what to do if T-09 named it differently: the
DEFERRABLE INITIALLY DEFERRED balance trigger, the append-only triggers and the chart backfill). T-13 additionally needs T-10 (`computeOrderTotals`).

This phase is the ledger's grammar, and it has three rules that every task below repeats in its
own words. First, a journal entry is never composed by hand: a business event (a cash sale, a card
sale, the cost of the food sold, a cash shortage at close) is looked up in a rule table that maps
it to a fixed set of debit and credit lines (spec 24), so nobody in this codebase — not a route,
not a report, not a repair script — ever types a debit. Second, the writer that turns those lines
into rows has exactly two responsibilities beyond inserting: it drops every line whose amount is
`0n` (a 0% tax rate or a free item must not produce a zero line the database rejects, and it must
not produce an empty entry either — when nothing remains it writes nothing and returns `null`), and
it takes the caller's transaction handle and never opens one of its own, because the payment
transaction owns that boundary (spec 13, invariant 4). Third, balance is guaranteed twice, in the
right order: the rule table produces lines that balance by construction, because T-10's totals
satisfy `subtotal − discount + tax = total` as an identity, and the database's deferred trigger
from T-09 checks Σdebit = Σcredit again at COMMIT. The trigger is the LAST line of defence, not the
first — it exists so that a bug anywhere above it cannot commit, not so that code above it can be
careless. Money is integer minor units in `bigint` throughout (`850` is $8.50); nothing here
rounds, parses a float or calls `toFixed`, and nothing here `UPDATE`s or `DELETE`s a journal row
(invariants 1, 2, 3).

### T-12 — The chart of accounts constant, `ensureChart`, the restaurant initializer entry, the parity test

**Needs:** T-09
**Files:**
- `src/lib/server/accounting/chart.ts` — NEW
- `src/lib/server/accounting/chart.integration.test.ts` — NEW
- `src/lib/server/restaurants/index.ts` — EDIT (three places: the import block at the top; the
  `restaurantInitializers` array, where `seedChartOfAccounts` is appended after PR #11's
  `initializeDefaultRoles` entry (itself after `insertSettingsRow`); and the comment blocks — the
  header comment beginning `// This module holds restaurant identity and settings`, the JSDoc
  above `restaurantInitializers` that begins "Ships with the settings row and default role rows",
  and the closing `// NOT HERE, IN ANY FORM` block at the end of the file)
- `src/lib/server/accounting/README.md` — EDIT (replace the first paragraph under the title, the
  one-line placeholder "Chart of accounts, posting rules (one per business event), journal
  writer.", with what now lives in the module; leave the bullet list below it untouched)
**Spec:** 23 (the chart of accounts, verbatim: 23 accounts from 1000 Cash on Hand to 6900 Other
Expenses; its sentence "Only the payment methods the restaurant accepts are created" is
deliberately NOT followed — see Watch out), 22 (posted entries are never edited or deleted), 24
(the conceptual tables `accounts`, `journal_entries`, `journal_entry_lines`)
**Invariants:** 2 (posted records are permanent — the seed is `ON CONFLICT DO NOTHING`, never an
update), 3 (journal entries balance in the database — the trigger's lines reference these rows)

**Do:**
1. Before writing anything, confirm the ground T-09 left: run
   `ls src/lib/server/db/migrations/0012_*.sql`; it must print exactly ONE file — this plan calls it
   `0012_journal_guards.sql`; if T-09 named it differently, use that path in the parity test below
   and say only "migration 0012" in the step 6 code comment and the step 7 README text. Then
   `grep -l journal_entry_lines src/lib/server/db/schema/*.ts` must print exactly one file (T-04's;
   this plan calls it `src/lib/server/db/schema/accounting.ts` — if T-04 named it differently,
   import from the file grep found and change nothing else). If either `ls` prints nothing or more
   than one file, or the grep prints anything but one file, stop and report: the repo is not in the
   state this plan assumed. Open that schema file and note the exported table object `accounts`
   and its columns `id` (uuid), `restaurantId`, `code` (text), `name` (text), `type` (text, with
   T-04's CHECK on the six type literals), plus the composite UNIQUE on `(restaurant_id, code)`.
2. Create `src/lib/server/accounting/chart.ts`. Relative imports only (`../db/schema/accounting`,
   `drizzle-orm`, `import type { DbTx } from '../db/client'`,
   `import type { Executor } from '../auth/session'`); the module touches no other server module,
   which is what keeps the convention amendment in step 6 narrow and cycle-free. Use the
   declaration form `import type { X } from …` for `DbTx` and `Executor` — never the inline
   `import { type X } from …` — because `.svelte-kit/tsconfig.json` sets
   `verbatimModuleSyntax: true`, under which the inline form retains a side-effect load of
   `../db/client` (→ `../env` → `$env/dynamic/private`), and `db/client` cannot load under the unit
   project, which has no `$lib`/`$env` alias; T-13's unit test imports this file. Open the file with
   a comment: "Spec 23 verbatim. Never add, rename or renumber an account here — a code the spec
   does not define is an open decision to surface, not a gap to fill (CLAUDE.md, Domain glossary)."
3. Export the account types and the chart:
   ```ts
   export const ACCOUNT_TYPES = [
   	'asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense'
   ] as const;
   export type AccountType = (typeof ACCOUNT_TYPES)[number];
   export type ChartRow = {
   	readonly code: string; readonly name: string; readonly type: AccountType
   };
   export const CHART: readonly ChartRow[] = Object.freeze([
   	/* the 23 rows below, in this order */
   ]);
   ```
   These six literals are the ones T-04's `accounts.type` CHECK admits. If T-04's CHECK spells them
   differently, the migration has already run and cannot be edited (invariant 2 applies to
   migrations too): use T-04's spellings here, never the other way round. The 23 rows, codes and
   names exactly as spec 23 prints them, in spec order, `code` as a TEXT string (`'1000'`, never the
   number `1000`). Spec 23's parentheticals — "(reduces revenue)" on 4100 and 4200, "(electricity,
   water, internet)" on 6200 — are annotations, NOT part of the name. The dash in 1020 and 1030 is
   an EN DASH (U+2013, `–`), copied from the spec, not a hyphen:

   | code | name | type |
   |---|---|---|
   | `1000` | `Cash on Hand` | `asset` |
   | `1010` | `Bank` | `asset` |
   | `1020` | `Payment Clearing – Card` | `asset` |
   | `1030` | `Payment Clearing – Mobile Money` | `asset` |
   | `1200` | `Inventory` | `asset` |
   | `2000` | `Accounts Payable` | `liability` |
   | `2100` | `Tax Payable` | `liability` |
   | `3000` | `Owner's Capital` | `equity` |
   | `3100` | `Owner's Drawings` | `equity` |
   | `3900` | `Retained Earnings` | `equity` |
   | `4000` | `Sales Revenue` | `revenue` |
   | `4100` | `Sales Discounts` | `revenue` |
   | `4200` | `Sales Refunds` | `revenue` |
   | `5000` | `Cost of Goods Sold` | `cost_of_sales` |
   | `5100` | `Waste & Inventory Adjustments` | `cost_of_sales` |
   | `5200` | `Comps & Staff Meals` | `cost_of_sales` |
   | `6000` | `Rent Expense` | `expense` |
   | `6100` | `Salary Expense` | `expense` |
   | `6200` | `Utilities Expense` | `expense` |
   | `6300` | `Maintenance Expense` | `expense` |
   | `6400` | `Payment Processing Fees` | `expense` |
   | `6800` | `Cash Over/Short` | `expense` |
   | `6900` | `Other Expenses` | `expense` |

   4100 and 4200 are contra-revenue accounts: their type is `revenue` and their normal balance is a
   DEBIT. Nothing in this task encodes normal balances — T-13's rules carry the side.
4. Export `ensureChart(tx: DbTx, restaurantId: string): Promise<void>`: ONE insert statement of all
   23 rows — `tx.insert(accounts).values(CHART.map((row) => ({ restaurantId, code: row.code,
   name: row.name, type: row.type })))` — chained with
   `.onConflictDoNothing({ target: [accounts.restaurantId, accounts.code] })`. Omit `id`: T-04 gave
   it `.defaultRandom()`; if the schema file shows no default, generate `randomUUID()` from
   `node:crypto` per row. Insert only those four columns; if `pnpm check` then reports another
   required column, T-04 added a NOT NULL column this plan did not list — stop and report rather
   than guess a value. Idempotent by construction: a second call inserts nothing and never UPDATEs
   an existing row (a renamed account would be a decision, not a re-seed).
5. Export `accountIdByCode(tx: Executor, restaurantId: string, code: string): Promise<string>`: one
   `select({ id: accounts.id })` filtered by `and(eq(accounts.restaurantId, restaurantId),
   eq(accounts.code, code))`, `.limit(1)`. When no row comes back throw
   `new Error(\`account ${code} is not in the chart of restaurant ${restaurantId}; run ensureChart\`)`.
   It takes `Executor` (a read works with `Db` or `DbTx`), scopes by restaurant explicitly — there
   is no ambient tenant in this codebase — and is the ONLY way T-14's writer turns a code into an
   `account_id`.
6. Edit `src/lib/server/restaurants/index.ts`: add `import { ensureChart } from '../accounting/chart';`
   beside the existing `import { writeAudit } from '../audit';`, then append a THIRD entry to
   `restaurantInitializers`, AFTER `initializeDefaultRoles` (PR #11's second entry) (order matters:
   the array is run in order and the settings row is what every other initializer may assume
   exists):
   ```ts
   // The chart of accounts, spec 23 verbatim, seeded for EVERY new restaurant.
   // CLAUDE.md's house convention says restaurants/ calls only audit/; T-02 of
   // tasks/pos-sales recorded the amendment (CLAUDE.md, "Decisions already made",
   // 2026-09-28) that it may import CHART and ensureChart from accounting/chart.ts
   // for exactly this entry — it still calls no other module.
   async function seedChartOfAccounts(tx, restaurantId) {
   	await ensureChart(tx, restaurantId);
   }
   ```
   Then bring the three comments into line with the code: the header comment's sentence that
   begins "It calls audit/" becomes "It calls audit/ and, for the chart seed only, accounting/chart
   (amendment recorded by T-02 on 2026-09-28) — and reads constants from permissions/keys.ts"; the
   JSDoc above `restaurantInitializers` (which begins "Ships with the settings row and default role
   rows" after PR #11) becomes "Ships with the settings row, the default role rows and the chart of
   accounts", keeping its explanation of why the list exists; the closing `// NOT HERE, IN ANY
   FORM` block gains one sentence: "The chart of accounts HAS landed
   here (T-12 of tasks/pos-sales, by decision of 2026-09-28): seeded through the initializer list
   for new restaurants and backfilled by migration 0012 for existing ones." Do not touch any other
   function in the file.
7. Edit `src/lib/server/accounting/README.md`: replace the placeholder first paragraph with:
   "`chart.ts` — `CHART`, spec 23's 23 accounts verbatim as `{ code, name, type }` with `code` a
   text string; `ensureChart(tx, restaurantId)`, the idempotent per-restaurant seed
   (`ON CONFLICT (restaurant_id, code) DO NOTHING`) that the restaurant initializer list runs for
   every new restaurant and migration 0012 backfilled for existing ones;
   `accountIdByCode(tx, restaurantId, code)`, the only code-to-id lookup, which throws when the code
   is absent. `posting-rules.ts` (T-13) and `journal.ts` (T-14) follow in the same plan." Leave the
   bullets below it as they are, with ONE exception: the line below the bullets that reads
   "Called by `orders/`. Never calls `orders/` back." is made inaccurate by step 6 (`restaurants/`
   now calls `accounting/chart`), so replace it with "Called by `orders/` and, for the chart seed
   only, by `restaurants/` (amendment recorded by T-02 of tasks/pos-sales, 2026-09-28). Never calls
   either back." Nothing else in the README changes in this task.
8. Run `pnpm check && pnpm lint` and then the whole suite: the settings tests' `makeRestaurant`
   helper and every registration test go through `onRestaurantCreated`, so each now also seeds 23
   `accounts` rows; T-08 put `accounts` in the reset list, so those rows are truncated between
   tests. If an existing test creates a restaurant THROUGH `onRestaurantCreated` or
   `registerRestaurant` and asserts that `accounts` is empty afterwards, that assertion described
   the pre-T-12 world and its expected value becomes 23 — change nothing else in it. A test that
   inserts a bare `restaurants` row and asserts 0 accounts is still right and stays as it is.

**Tests:** (`src/lib/server/accounting/chart.integration.test.ts`, the integration project; no spec 29
area of its own — the mandatory ledger tests are T-13's and T-14's, and they rest on this seed)
- Registering a restaurant through `registerRestaurant(db, { restaurantName: 'Cafe One', timeZone:
  'Africa/Mogadishu', ownerDisplayName: 'The Owner', email: 'owner@cafe.com', password: 'a strong
  enough password' }, { mode: 'operator', ip: null, userAgent: 'cli:test' })` → `select().from(
  accounts).where(eq(accounts.restaurantId, restaurantId))` has length `23`, and the rows mapped to
  `{ code, name, type }` and sorted by code deep-equal `[...CHART]`.
- Two registrations (distinct emails) → 46 rows in `accounts`, 23 per restaurant: the chart is per
  restaurant, not global.
- `await db.transaction((tx) => ensureChart(tx, restaurantId))` run twice on a registered restaurant
  → still exactly `23` rows, and the 23 `id` values before and after are identical (nothing was
  replaced).
- Parity with the SQL backfill, so the migration and the TypeScript seed can never drift:
  ```ts
  // The path is the ONE file `ls src/lib/server/db/migrations/0012_*.sql` printed in step 1;
  // this plan calls it 0012_journal_guards.sql — use T-09's actual name if it differs.
  const migration = new URL('../db/migrations/0012_journal_guards.sql', import.meta.url);
  const sqlText = readFileSync(migration, 'utf8');
  const tuple = /\(\s*'(\d{4})'\s*,\s*'((?:[^']|'')+)'\s*,\s*'([a-z_]+)'\s*\)/g;
  const rows = [...sqlText.matchAll(tuple)].map(([, code, name, type]) => ({
  	code,
  	name: name.replaceAll("''", "'"),
  	type
  }));
  expect(rows).toHaveLength(23);
  const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
  expect([...rows].sort(byCode)).toEqual([...CHART].sort(byCode));
  ```
  The comparison is order-INDEPENDENT on purpose: T-09 may have grouped its VALUES tuples by type
  or in any other row order, and every row being right is what parity means — CHART's spec order is
  pinned separately by the table in step 3, and the 23-member set test below pins the codes. The
  `''` un-escaping is load-bearing: SQL writes `Owner's Capital` as `'Owner''s Capital'`. If T-09
  spelled its VALUES tuples in another COLUMN order, adapt the REGEX to T-09's spelling — never
  `CHART`, and never the migration (it has run).
- `new Set(CHART.map((r) => r.code))` equals the exact set `{1000, 1010, 1020, 1030, 1200, 2000,
  2100, 3000, 3100, 3900, 4000, 4100, 4200, 5000, 5100, 5200, 6000, 6100, 6200, 6300, 6400, 6800,
  6900}` as strings, 23 members, no duplicates (`CHART.length === 23`).
- Every `CHART[i].type` is a member of `ACCOUNT_TYPES`; `CHART[2].name` is
  `'Payment Clearing – Card'` with `name.charCodeAt(17) === 0x2013` (the en dash survived).
- `accountIdByCode(db, restaurantId, '1000')` returns the `id` of that restaurant's 1000 row;
  `accountIdByCode(db, restaurantId, '9999')` rejects with a message containing `9999`;
  `accountIdByCode(db, '00000000-0000-0000-0000-000000000000', '1000')` rejects — a code that exists
  only in another restaurant is absent here.

**Done when:** `pnpm test:integration src/lib/server/accounting/chart.integration.test.ts` passes,
`pnpm check && pnpm lint` are clean, and `pnpm test` stays green — the registration and settings
tests now run with 23 account rows per restaurant, cleared between tests by T-08's reset list.

**Watch out:** CLAUDE.md's house convention says `restaurants/` calls only `audit/`; T-02 recorded
the amendment that it may import `accounting/chart` for this one entry — cite it in the code
comment (step 6) so the next reader does not "fix" the import away, and do not let `chart.ts` import
`restaurants/` back (a cycle) or any module beyond the schema. Never invent an account code: a
posting that needs a code not in this table is an open decision to surface (CLAUDE.md, "Open
decisions"), not a row to add. Assumption 5 of the overview: ALL 23 accounts are seeded, including
both clearing accounts, even though spec 23 says only the accepted payment methods' accounts are
created — T-02 records the deviation; do not "correct" the seed to the enabled tenders. The
parity test reads the migration file from disk: it runs from the integration project, whose cwd is
the repo root, and the `new URL(…, import.meta.url)` form keeps it independent of cwd anyway. If
the file still says "Ships with exactly one entry" the tree is pre-PR #11: stop, T-01 was not
satisfied.

### T-13 — The posting-rule table with one test per business event

**Needs:** T-10, T-12
**Files:**
- `src/lib/server/accounting/posting-rules.ts` — NEW
- `src/lib/server/accounting/posting-rules.test.ts` — NEW
**Spec:** 24 (the posting-rule table: rows "Cash sale", "Card / mobile sale", "Cost of food sold",
"Sale with discount", "Cash shortage at session close", "Cash overage at session close"; the worked
"sale with a discount" example), 22 (the $11 cash-sale example: Dr Cash 11.00 / Cr Sales Revenue
10.00 / Cr Tax Payable 1.00; entries must always balance), 10 (a −$10 difference at close is a
shortage posted to Cash Over/Short), 23 (the codes), 29 ("Posting rules for every business event"
is a mandatory automated test)
**Invariants:** 1 (money is integer minor units in bigint — every amount here is a `Minor`, never
a number), 3 (journal entries balance — the lines balance by construction), 7 (discount before tax;
one rounding rule — these functions receive rounded totals from `computeOrderTotals` and never
round, add tax or apply a discount themselves)

**Do:**
1. Create `src/lib/server/accounting/posting-rules.ts`. Imports, all relative:
   `import { minor, negate, sum, add, type Minor } from '../../money';` (every arithmetic step on a
   `Minor` in this file goes through those functions — invariant 1: NEVER money arithmetic outside
   `src/lib/money`; no raw `+`/`-` on a `Minor` anywhere here), `import type { SalePayment } from
   '../../sync-ops';` (T-03's isomorphic contract; the method union is taken from the wire type so
   it cannot drift), `import { CHART } from './chart';`. NOTHING from `../db/**`: the module is pure
   and never touches the database; it computes lines, and T-14 writes them. Open with a comment:
   "Spec 24's posting-rule table as code. Every business event maps to a FIXED set of debit and
   credit lines; nobody types a debit. These functions emit zero-amount lines as they are — the
   journal writer drops them — and never round: they receive integers already rounded once by
   computeOrderTotals."
2. Export the event list, spelled IDENTICALLY to T-04's CHECK on `journal_entries.event` and to
   T-08's constraint test (T-14's integration test proves the parity by inserting each one):
   ```ts
   export const POSTING_EVENTS = [
   	'cash_sale',
   	'card_sale',
   	'mobile_sale',
   	'cost_of_goods_sold',
   	'cash_shortage_at_close',
   	'cash_overage_at_close'
   ] as const;
   export type PostingEvent = (typeof POSTING_EVENTS)[number];
   export const SALE_EVENTS = ['cash_sale', 'card_sale', 'mobile_sale'] as const;
   export type SaleEvent = (typeof SALE_EVENTS)[number];
   /** Exactly ONE of debit / credit is present; the amount is a Minor and may be 0n. */
   export type RuleLine = { code: string; debit?: Minor; credit?: Minor };
   export type SaleTotals = { subtotal: Minor; discount: Minor; tax: Minor; total: Minor };
   ```
   `SaleTotals` is structurally a subset of T-10's `OrderTotals`, so a caller passes the result of
   `computeOrderTotals(...)` straight in.
3. Name the codes once, as constants, and guard them at module load: `const CODE = { CASH_ON_HAND:
   '1000', CLEARING_CARD: '1020', CLEARING_MOBILE: '1030', INVENTORY: '1200', TAX_PAYABLE: '2100',
   SALES_REVENUE: '4000', SALES_DISCOUNTS: '4100', COGS: '5000', CASH_OVER_SHORT: '6800' } as const;`
   followed by a loop that throws `new Error(\`posting rule names account ${code}, which is not in
   CHART\`)` for any value not found in `CHART` — a typo then fails at import time, in every test
   run, rather than at the first sale. `const TENDER_ACCOUNT: Record<SaleEvent, string> = {
   cash_sale: CODE.CASH_ON_HAND, card_sale: CODE.CLEARING_CARD, mobile_sale: CODE.CLEARING_MOBILE }`
   — three tender events and accounts (1000, 1020, 1030) because assumption 3 of 00-overview.md
   fixes the tender set as cash, card and mobile.
4. Export `saleLines(event: SaleEvent, t: SaleTotals): RuleLine[]` — spec 24's "Cash sale", "Card /
   mobile sale" and "Sale with discount" rows in ONE function, because a sale with a zero discount
   IS a plain sale. Throw a `RangeError` if `event` is not in `SALE_EVENTS` or if any of the four
   totals is negative (a negative sale is a refund, spec 24's "Cash refund" row, which this plan
   does not build). Return exactly these four lines, in this order:
   - `Dr <TENDER_ACCOUNT[event]> t.total` — `1000 Cash on Hand` for `cash_sale`, `1020 Payment
     Clearing – Card` for `card_sale`, `1030 Payment Clearing – Mobile Money` for `mobile_sale`;
   - `Dr 4100 Sales Discounts t.discount` — 4100 is contra-revenue and is DEBITED; it is `0n` for
     every sale this plan's screens can produce and the writer drops it then;
   - `Cr 4000 Sales Revenue t.subtotal`;
   - `Cr 2100 Tax Payable t.tax`.
   They balance because `subtotal − discount + tax = total` holds for every `computeOrderTotals`
   result (T-10): Σdebit = total + discount = subtotal + tax = Σcredit.
5. Export `cogsLines(cost: Minor): RuleLine[]` — spec 24's "Cost of food sold": throw a
   `RangeError` when `cost < 0n`; return `[{ code: '5000', debit: cost }, { code: '1200', credit:
   cost }]`, i.e. `Dr 5000 Cost of Goods Sold / Cr 1200 Inventory`. A `0n` cost yields two zero
   lines the writer drops; T-19 only calls this when the cost is positive anyway.
6. Export `overShortLines(difference: Minor): RuleLine[]`, where `difference = counted − expected`
   as R6 defines it (spec 10: counted $1,840 against expected $1,850 is a difference of −$10):
   - `difference < 0n` → spec 24's "Cash shortage at session close": `[{ code: '6800', debit:
     negate(difference) }, { code: '1000', credit: negate(difference) }]`, i.e. `Dr 6800 Cash
     Over/Short |d| / Cr 1000 Cash on Hand |d|` — `negate` from the money module, never a unary
     `-` on the value (invariant 1);
   - `difference > 0n` → "Cash overage at session close": `[{ code: '1000', debit: difference },
     { code: '6800', credit: difference }]`, i.e. `Dr 1000 Cash on Hand d / Cr 6800 Cash Over/Short d`;
   - `difference === 0n` → `[]` (a drawer that balances posts nothing).
   The amounts are always positive; the SIGN is carried by which side 6800 sits on.
7. Export `eventForMethod(method: SalePayment['method']): SaleEvent` — `cash → 'cash_sale'`,
   `card → 'card_sale'`, `mobile → 'mobile_sale'`; throw a `RangeError` for anything else (wire data
   is validated by T-18 before it reaches here, but the rule table must not silently post an
   unknown tender to cash). Also export `overShortEvent(difference: Minor): PostingEvent | null` —
   `'cash_shortage_at_close'` when negative, `'cash_overage_at_close'` when positive, `null` when
   zero — so T-20 names the entry's event with the same function that chooses its lines.
8. Export `linesBalance(lines: readonly RuleLine[]): boolean` — exactly
   `sum(lines.map((l) => l.debit ?? minor(0n))) === sum(lines.map((l) => l.credit ?? minor(0n)))`,
   a missing side counting as `minor(0n)`. No raw `+`/`-` on a `Minor` here — use `sum`/`add`/
   `negate` from the money module (invariant 1); `sum` is the module's own reduction and is the only
   place the total is formed. It is a check for tests and for T-14's callers, not a repair.
9. The functions do NOT drop zero lines (the writer does), do NOT round, and never touch the
   database. Run `pnpm check && pnpm lint`.

**Tests:** (`src/lib/server/accounting/posting-rules.test.ts`, the unit project — every case below is
MANDATORY (spec 29 — posting rules for every business event) unless marked otherwise. Amounts are
integer minor units; `minor(1100n)` builds one. Imports, all relative — the unit project has no
`$lib` alias, and `src/lib/money/index.ts` does NOT re-export order-totals (T-10), so it is
imported by file:
```ts
import { computeOrderTotals } from '../../money/order-totals';
import { minor, sum, add, ROUNDING_RULE } from '../../money';
import { PAYMENT_METHODS } from '../../sync-ops';
import { CHART } from './chart';
import { POSTING_EVENTS, SALE_EVENTS, saleLines, cogsLines, overShortLines, overShortEvent, eventForMethod, linesBalance } from './posting-rules';
```)
- Spec 22's cash sale, subtotal 1000, discount 0, tax 100, total 1100:
  `saleLines('cash_sale', …)` deep-equals `[{ code: '1000', debit: 1100n }, { code: '4100', debit:
  0n }, { code: '4000', credit: 1000n }, { code: '2100', credit: 100n }]` — in that order.
- The same totals with `'card_sale'` → first line `{ code: '1020', debit: 1100n }`; with
  `'mobile_sale'` → `{ code: '1030', debit: 1100n }`; the other three lines identical to the cash
  case.
- Spec 24's discount example — burger 1000, 10% discount, 10% tax exclusive — as literal totals
  `{ subtotal: 1000n, discount: 100n, tax: 90n, total: 990n }`: `saleLines('cash_sale', …)` →
  `Dr 1000 990n, Dr 4100 100n, Cr 4000 1000n, Cr 2100 90n`, Σdebit = Σcredit = `1090n`, and
  `linesBalance(...)` is `true`. Then the SAME totals derived, not typed: `computeOrderTotals({
  taxMode: 'exclusive', lines: [{ unitPriceMinor: minor(1000n), quantity: 1n, modifierDeltasMinor:
  [], taxRateBp: 1000, discountMinor: minor(100n) }] }, ROUNDING_RULE)` yields `subtotal 1000n,
  discount 100n, tax 90n, total 990n` and produces the identical four lines.
- COGS: `cogsLines(minor(300n))` → `[{ code: '5000', debit: 300n }, { code: '1200', credit: 300n }]`
  (spec 22's $3.00 food cost).
- Shortage: `overShortLines(minor(-1000n))` → `[{ code: '6800', debit: 1000n }, { code: '1000',
  credit: 1000n }]` (spec 10's −$10 in cents); `overShortEvent(minor(-1000n))` is
  `'cash_shortage_at_close'`.
- Overage: `overShortLines(minor(1000n))` → `[{ code: '1000', debit: 1000n }, { code: '6800',
  credit: 1000n }]`; `overShortEvent(minor(1000n))` is `'cash_overage_at_close'`.
- Zero: `overShortLines(minor(0n))` → `[]`; `overShortEvent(minor(0n))` is `null`.
- `eventForMethod` maps `'cash' → 'cash_sale'`, `'card' → 'card_sale'`, `'mobile' → 'mobile_sale'`;
  for every member of T-03's `PAYMENT_METHODS` the result is a member of `SALE_EVENTS`;
  `eventForMethod('cheque' as never)` throws a `RangeError`.
- MANDATORY (spec 29 — journal entries always balance, at the rule level): a seeded property over
  500 random orders — copy the eight-line linear-congruential `generator(seed)` and `between()`
  helpers from `src/lib/money/tax.test.ts` (no property-testing library is installed; a seed makes
  a failure reproduce). Per order: 1–6 lines, `unitPriceMinor` 0–100000, `quantity` 1n–9n, 0–3
  modifier deltas 0–2000 each, `taxRateBp` 0–10000 as a `Number`, `discountMinor` 0 up to the line's
  base `(unitPrice + Σdeltas) × quantity` so `computeOrderTotals` never throws; `taxMode` alternates
  `'exclusive'` / `'inclusive'`. For each order and for EACH of the three sale events assert
  `linesBalance(saleLines(event, totals)) === true`, every amount `>= 0n`, and, with
  `const debits = sum(lines.map((l) => l.debit ?? minor(0n)))`, that
  `debits === add(totals.total, totals.discount)` — both sides built with the money module's
  `sum`/`add`, never with a raw `+` (invariant 1 applies to test code too). 500 orders × 3 events =
  1500 balanced line sets.
- Every code the rules emit exists in `CHART`: collect the codes from one `saleLines` call per sale
  event, one `cogsLines` call, and `overShortLines` for −1n and 1n; assert each is found in
  `CHART.map((r) => r.code)`, and that the set is exactly `{'1000','1020','1030','4100','4000',
  '2100','5000','1200','6800'}`.
- Not mandatory: `saleLines` with a negative `total` throws a `RangeError`; `cogsLines(minor(-1n))`
  throws; every line returned by every function has exactly one of `debit` / `credit` defined.
- Not mandatory: `POSTING_EVENTS` deep-equals `['cash_sale', 'card_sale', 'mobile_sale',
  'cost_of_goods_sold', 'cash_shortage_at_close', 'cash_overage_at_close']` — the spelling T-04's
  CHECK and T-08's test use, pinned so a rename here cannot pass unit tests while every insert
  fails.

**Done when:** `pnpm test:unit src/lib/server/accounting/posting-rules.test.ts` passes with every
case above present, and `pnpm check && pnpm lint` are clean.

**Watch out:** 4100 Sales Discounts is contra-revenue and is DEBITED, never credited — spec 24's
example puts it on the debit side beside Cash. The discount line will be `0n` for every sale this
plan can produce (T-18 pins line discounts to 0) and the writer drops it — the rule still emits it,
so the approvals plan that introduces real discounts changes NOTHING in this file. The unit
project has no `$lib` alias: use relative imports, and note `chart.ts` is safe to import from a
unit test ONLY because T-12 wrote its `DbTx` and `Executor` imports in the declaration form
`import type { X } from …` — `verbatimModuleSyntax: true` in `.svelte-kit/tsconfig.json` means the
inline form `import { type X } from '../db/client'` would retain the module load of `db/client`
(→ `../env` → `$env/dynamic/private`), which the unit project cannot resolve, and this test would
then fail at import for a reason unrelated to posting rules. If it does, fix the import FORM in
`chart.ts`, nothing else. Its remaining imports are pure drizzle table objects — no connection
opens. `bigint` and `number` never mix: `quantity` is `1n`, the rate is a `number`, and there is
no raw `+`/`-` on a `Minor` here — use `sum`/`add`/`negate` from the money module.

### T-14 — The journal writer with the balance property test and the COMMIT-time rejection test

**Needs:** T-13
**Files:**
- `src/lib/server/accounting/journal.ts` — NEW
- `src/lib/server/accounting/journal.integration.test.ts` — NEW
- `src/lib/server/accounting/index.ts` — NEW (re-exports `chart`, `posting-rules`, `journal`)
**Spec:** 22 (entries are generated automatically, the database rejects an entry whose debits and
credits do not match, posted entries are never edited or deleted), 24 (`journal_entries` +
`journal_entry_lines`, one entry per business event), 13 (journal entries are created INSIDE the
payment transaction — so the writer takes the caller's handle), 10 and 17 (every entry carries the
POS session's business date, never the calendar date), 29 ("Journal entries always balance" is a
mandatory automated test)
**Invariants:** 1 (money is integer minor units in bigint), 2 (posted records are permanent — the
writer has no update and no delete path), 3 (journal entries balance in the database, checked at
COMMIT by T-09's deferred trigger), 4 (one all-or-nothing transaction at payment — the writer never
opens its own), 11 (business date, not calendar date)

**Do:**
1. Confirm the ground: `ls src/lib/server/accounting/` must show `chart.ts` (T-12) and
   `posting-rules.ts` (T-13), and the schema file from T-12 step 1 must export `journalEntries` and
   `journalEntryLines`. Open it and note the columns the writer sets. `journal_entries`: `id` (uuid,
   default random), `restaurant_id` (uuid), `event` (text, CHECK in the six `POSTING_EVENTS`
   spellings), `source_type` (text, CHECK in `('order','pos_session')`), `source_id` (uuid, no
   foreign key — it is polymorphic over `source_type`; if T-04 did give it one, the tests below must
   insert the referenced row first), `memo` (text), `business_date` (`date`, Drizzle mode
   `'string'` — it reads and writes `'YYYY-MM-DD'`), `posted_at` (timestamptz). `journal_entry_lines`:
   `id`, `restaurant_id`, `entry_id` (uuid → `journal_entries.id`), `line_no` (integer), `account_id`
   (uuid → `accounts.id`), `debit_minor` and `credit_minor` (`bigint`, Drizzle `mode: 'bigint'`, with
   T-04's CHECK that both are `>= 0` and exactly one is `> 0`). If a money column is `mode:
   'number'`, stop and report — invariant 1 forbids it and T-04 must fix it before this task runs.
2. Create `src/lib/server/accounting/journal.ts`. Relative imports: `asc, eq` from `drizzle-orm`,
   `type DbTx` from `../db/client`, `type Executor` from `../auth/session`, the three tables from
   the schema file, `accountIdByCode` from `./chart`, `type PostingEvent` and `type RuleLine` from
   `./posting-rules`, `minor, type Minor` from `../../money`. Export the input type exactly as the
   overview's shared contract states it:
   ```ts
   export type JournalEntryInput = {
   	restaurantId: string;
   	/** The POS session's business date as 'YYYY-MM-DD' — never derived from a timestamp here. */
   	businessDate: string;
   	event: PostingEvent;
   	sourceType: 'order' | 'pos_session';
   	sourceId: string;
   	memo: string;
   	lines: RuleLine[];
   };
   ```
3. Export `postEntry(tx: DbTx, entry: JournalEntryInput): Promise<{ entryId: string } | null>`, in
   this order, with no step reordered:
   1. Throw a `TypeError` unless `entry.businessDate` matches `/^\d{4}-\d{2}-\d{2}$/` — a `Date`
      passed here would be serialised in the server's zone and could land a sale on the wrong
      business date (invariant 11).
   2. Shape-check EVERY line as given, before any dropping: exactly one of `debit` / `credit` is
      defined (`!== undefined`); the defined amount is a `bigint` and is `>= 0n`. Otherwise throw an
      `Error` naming the line's index and code (`line 2 (4000) must carry exactly one of debit or
      credit`). A line with both sides — even when one is `0n` — is a programming error, not a zero
      line.
   3. Drop every line whose defined amount is `0n`. A 0% tax rate, a free item or a `0n` discount
      produces such a line, and T-04's line CHECK rejects it; dropping it is the writer's job so
      that no rule has to special-case zero.
   4. If no line remains, return `null` WITHOUT running any SQL — no header row, because T-09's
      trigger also fires on `journal_entries` and an empty header could never commit, and because a
      free order legitimately has nothing to post.
   5. Resolve every distinct code to an `account_id` with `accountIdByCode(tx, entry.restaurantId,
      code)` into a `Map<string, string>`, BEFORE the first insert. An unknown code therefore throws
      with nothing written and the transaction still usable.
   6. Insert one `journal_entries` row: `restaurantId`, `event`, `sourceType`, `sourceId`, `memo`,
      `businessDate` (the string as given), `postedAt: new Date()`; take the id with
      `.returning({ id: journalEntries.id })`.
   7. Insert the remaining lines in ONE statement, in the order they arrived after the drop, with
      `lineNo` 1..n, `restaurantId: entry.restaurantId`, `entryId`, `accountId` from the map,
      `debitMinor: line.debit ?? 0n`, `creditMinor: line.credit ?? 0n`.
   8. Return `{ entryId }`.
   The writer does NOT assert Σdebit = Σcredit in TypeScript. Balance is the rule table's property
   by construction (T-13) and the database's guarantee at COMMIT (T-09, invariant 3: "enforced by a
   DB constraint checked at COMMIT, not only in TypeScript"); a pre-check here would mean no test
   that goes through the writer ever reaches the trigger, and the rejection test below depends on
   reaching it. It never catches an error (a failure must roll the caller's whole transaction
   back, invariant 4), never opens a transaction, never calls `db` directly, and has no `update`
   and no `delete` (invariant 2 — a wrong entry is corrected by a reversing entry posted through
   this same function, never by touching the rows).
4. Export `entryLines(tx: Executor, entryId: string): Promise<{ lineNo: number; code: string; name:
   string; debit: Minor; credit: Minor }[]>` — a `select` from `journalEntryLines` inner-joined to
   `accounts` on `account_id`, `where(eq(journalEntryLines.entryId, entryId))`,
   `orderBy(asc(journalEntryLines.lineNo))`, mapping `debit_minor` / `credit_minor` through
   `minor(...)`. For tests and for later reports; it reads and never writes.
5. Create `src/lib/server/accounting/index.ts` with exactly three lines: `export * from './chart';`,
   `export * from './posting-rules';`, `export * from './journal';`. There are no name collisions
   among the three; if `pnpm check` reports one, rename the new symbol in `journal.ts`, never one the
   overview's contract names.
6. Run `pnpm check && pnpm lint`.

**Tests:** (`src/lib/server/accounting/journal.integration.test.ts`, the integration project. Imports,
all relative — `computeOrderTotals` is NOT reachable from `'../../money'` because T-10 keeps it out
of `index.ts`; `readFileSync` is not needed in this file:
```ts
import { randomUUID } from 'node:crypto';
import { computeOrderTotals } from '../../money/order-totals';
import { minor, ROUNDING_RULE } from '../../money';
import { POSTING_EVENTS, saleLines, cogsLines, overShortLines, overShortEvent } from './posting-rules';
import { postEntry, entryLines } from './journal';
import { onRestaurantCreated } from '../restaurants';
import { restaurants } from '../db/schema/restaurants';
import { testDb } from '../db/test/db';
```
Fixture `makeRestaurant()`: insert a `restaurants` row, then `db.transaction((tx) =>
onRestaurantCreated(tx, id, { restaurantName, timeZone: 'Africa/Mogadishu' }))` — exactly as
`src/lib/server/restaurants/settings.integration.test.ts` does — which seeds the chart through T-12.
`sourceId` values are `randomUUID()` from `node:crypto`. Use the seeded `generator(seed)` and
`between()` from `src/lib/money/tax.test.ts`.)
- MANDATORY (spec 29 — journal entries always balance; a property test over generated events):
  generate 300 events, `i` from 0 to 299, kind `POSTING_EVENTS[i % 6]` so every one of the six
  events occurs 50 times. A sale event gets random totals from `computeOrderTotals` (the T-13
  generator: 1–6 lines, random prices, quantities, modifier deltas, rate 0–10000, a random discount
  up to the line base, mode alternating exclusive / inclusive) and `saleLines(event, totals)`;
  `cost_of_goods_sold` gets `cogsLines(minor(cost))` with `cost` 0–100000 (so some are `0n`);
  the `cash_shortage_at_close` slot draws `d` from −100000 to −1 and the `cash_overage_at_close`
  slot draws `d` from 1 to 100000, each getting `overShortLines(minor(d))`; name the entry's event
  with `overShortEvent(minor(d))` and assert it equals the slot's own event (it always does, since
  the sign is fixed per slot, and it is never `null`). Post ALL of them through `postEntry` inside
  ONE `db.transaction`, `businessDate: '2026-09-27'`, collecting the results — the only `null`
  results are the zero-cost COGS entries, which the "rows equal non-null results" assertion below
  accounts for. The transaction must COMMIT (the deferred trigger checks every entry at that moment).
  Then, from the database with plain SQL: `select entry_id, sum(debit_minor)::text as dr,
  sum(credit_minor)::text as cr, count(*) filter (where debit_minor > 0)::int as debits, count(*)
  filter (where credit_minor > 0)::int as credits from journal_entry_lines group by entry_id` —
  assert for every row `dr === cr`, `debits >= 1`, `credits >= 1`; assert the number of
  `journal_entries` rows equals the number of non-null results; assert every line has exactly one
  positive side (`select count(*) from journal_entry_lines where (debit_minor > 0) = (credit_minor
  > 0)` is `0`).
- MANDATORY (spec 29 — the database rejects an unbalanced entry, at COMMIT): bypass the rules and
  call `postEntry(tx, { …, event: 'cash_sale', sourceType: 'order', lines: [{ code: '1000', debit:
  minor(500n) }] })` inside `db.transaction`. The writer accepts it (one line, one side, non-zero,
  known code) and inserts a header and one line; the transaction then rejects at COMMIT:
  `await expect(db.transaction(...)).rejects.toThrow(<the text T-09's balance trigger raises —
  run `ls src/lib/server/db/migrations/0012_*.sql`, which must print exactly ONE file (this plan
  calls it `0012_journal_guards.sql`; if T-09 named it differently, open that one), find the RAISE
  EXCEPTION in the balance-check function and assert on a stable prefix of that message>)`. Afterwards
  `journal_entries` and `journal_entry_lines` both have `0` rows.
- Each of the six `POSTING_EVENTS` spellings commits: for every event post a balanced entry built
  by its own rule — `saleLines(event, { subtotal: minor(100n), discount: minor(0n), tax:
  minor(0n), total: minor(100n) })` for the three sale events, `cogsLines(minor(100n))` for
  `cost_of_goods_sold`, `overShortLines(minor(-100n))` for `cash_shortage_at_close`,
  `overShortLines(minor(100n))` for `cash_overage_at_close` — → six `journal_entries` rows, and
  `select distinct event` returns exactly the six literals. This is the parity check between
  `POSTING_EVENTS` and T-04's CHECK.
- A sale with tax 0 posts exactly two lines: `saleLines('cash_sale', { subtotal: minor(1000n),
  discount: minor(0n), tax: minor(0n), total: minor(1000n) })` through `postEntry` → `entryLines`
  returns `[{ lineNo: 1, code: '1000', name: 'Cash on Hand', debit: 1000n, credit: 0n }, { lineNo:
  2, code: '4000', name: 'Sales Revenue', debit: 0n, credit: 1000n }]` — no zero `4100` line, no
  zero `2100` line, and `line_no` is contiguous from 1.
- A free order (totals all `0n`) → `postEntry` returns `null`, and `journal_entries` has `0` rows.
- Unknown code throws before any insert: inside one `db.transaction`, `await
  expect(postEntry(tx, { …, lines: [{ code: '9999', debit: minor(100n) }, { code: '4000', credit:
  minor(100n) }] })).rejects.toThrow(/9999/)`, then — still inside the same callback, on `tx` —
  `select count(*)::int from journal_entries` is `0` (a header inserted before the lookup would
  make it `1`; a failed SQL statement would have aborted the transaction and made this query throw
  instead), then `throw` to roll back.
- `business_date` lands as given: post with `businessDate: '2026-09-27'` → `select business_date
  from journal_entries` returns the string `'2026-09-27'` exactly (the column is `date`, Drizzle
  mode `'string'`; a `Date` object coming back means T-04 chose the wrong mode — stop and report).
  `posted_at` is within 60 seconds of `Date.now()`.
- Shape errors write nothing: a line with both `debit` and `credit` defined, a line with neither,
  and a line with `debit: minor(-1n)` each make `postEntry` reject with an `Error` (assert the
  message names the line index and code), and `journal_entries` stays at `0` rows.
- `businessDate: '2026/09/27'` and `businessDate: new Date().toISOString()` each reject with a
  `TypeError` before any SQL runs.
- Posts in the caller's transaction, never its own: inside `db.transaction`, `postEntry` a balanced
  entry, assert on `tx` that `journal_entries` has `1` row, then `throw new Error('boom')`; the
  transaction promise rejects with `boom` and afterwards both journal tables have `0` rows (the
  pattern of `src/lib/server/audit/audit.integration.test.ts`, "leaves NO row behind when the
  surrounding transaction rolls back").
- `entryLines` on an unknown entry id returns `[]`; on a four-line sale entry it returns the lines
  ordered by `line_no` with `debit` and `credit` as `bigint` values (`typeof x.debit === 'bigint'`).

**Done when:** `pnpm test:integration src/lib/server/accounting/journal.integration.test.ts` passes
with every case above present, `pnpm test:unit src/lib/server/accounting/posting-rules.test.ts`
still passes, and `pnpm check && pnpm lint` are clean.

**Watch out:** The balance trigger is DEFERRABLE INITIALLY DEFERRED, so an unbalanced entry is NOT
refused by the `insert` — every statement succeeds — and the rejection surfaces from
`db.transaction(...)`'s promise when Drizzle issues COMMIT. A test that wraps `postEntry` in
`try/catch` inside the callback catches nothing; assert on the transaction promise, and count rows
only after it has settled. The message to match is T-09's, read from the migration file, not a
guess. `bigint({ mode: 'bigint' })` columns return `bigint`: compare with `1000n`, seed every
reduce with `0n`, and never `Number()` an amount. `business_date` is a `'YYYY-MM-DD'` string end to
end; a `Date` here is how a 01:30 sale lands on the wrong day. Do not add a Σdebit = Σcredit check
inside `postEntry` "for safety": the property test and the trigger are the two guarantees, in that
order, and a TypeScript pre-check would silently retire the trigger from every test path. Nothing
in this task updates or deletes a journal row; there is no function for it, and a later "fix" is a
reversing entry through `postEntry`.
