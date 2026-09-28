# Phase 2 (domain) — money (T-10, T-11)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 0.

Why this phase exists, and its rules. Exactly one place in the repository turns a fractional minor
unit into a whole one: `roundToMinor` in `src/lib/money/index.ts`, which takes a REQUIRED
`RoundingRule` and is called at every real site with the recorded constant `ROUNDING_RULE`
(`'half-up'`: a tie goes away from zero, so a reversing entry cancels exactly). Everything in this
phase is arithmetic on `bigint` minor units (`850n` is $8.50) inside the isomorphic module
`src/lib/money/`, which imports nothing outside itself, so the till (`src/lib/pos/`,
`src/routes/(pos)/`), the server (`src/lib/server/**`) and the dashboard report run the SAME code on
the SAME numbers. T-10 adds `computeOrderTotals`, the one function that turns an order's lines into
the five integers a sale is recorded and posted from, shaped so that the sale's journal entry
balances by construction. T-11 adds `changeDue` and `quickTenders`, so that no Svelte component ever
adds or subtracts two amounts itself. Nothing here touches the database, reads a setting or resolves
a `null` tax rate: the caller passes the resolved rate, the tax mode and the rounding rule, and this
phase computes. Phase 0 (`01-decisions.md`, T-01–T-03) comes first: T-10's `serializeTotals`
produces the wire shape that T-03's `SaleCompletePayload['totals']` declares; Phase 1 (schema) is
NOT a prerequisite, because no task here imports a table.

### T-10 — `computeOrderTotals`: ledger integers by construction, both tax modes, the tie cases, a property test

**Needs:** T-03 (`src/lib/sync-ops/index.ts` — the wire shape `SaleCompletePayload['totals']` that
`serializeTotals` must produce; the test pins the two together with a type-only import)
**Files:**
- `src/lib/money/order-totals.ts` — NEW
- `src/lib/money/order-totals.test.ts` — NEW

**Read, do not edit:** `src/lib/money/index.ts` MUST NOT be edited. `order-totals.ts` imports from
`'./index'` and `'./tax'` exactly as `tax.ts` does, and `index.ts` does NOT re-export the new
file, for the cycle reason `tax.ts`'s header comment states (the new file imports `index.ts`, and
a cycle in the module everything imports is not worth a shorter import path). `src/lib/money/
tax.ts` is likewise read, for `taxOnAmount` and `TaxMode`, and not edited. Check both files for
the symbols named below (`add`, `subtract`, `sum`, `multiplyByInteger`, `exact`, `addExact`,
`sumExact`, `roundToMinor`, `ROUNDING_RULE`, `Minor`, `Exact`, `RoundingRule`; `taxOnAmount`,
`TaxMode`); if one is missing, stop: the repo is not in the state this plan assumed.
**Spec:** 17 (money in integer minor units; discounts before tax; ONE rounding rule in one
function — full precision per line, rounded once on the invoice total; each line stores its own
rate), 18 (the worked sale: 800 + 200, tax 100, total 1100), 24 (the sale-with-discount example: Dr
Cash 990, Dr Sales Discounts 100, Cr Sales Revenue 1000, Cr Tax Payable 90 — 1090 = 1090), 6 (the
till totals the bill in the browser and the server records the same numbers), 29 (mandatory tests:
money arithmetic and rounding; tax calculation in both modes)
**Invariants:** 1 (money is integer minor units in `bigint`: no float, no `parseFloat`, no
`toFixed`, no arithmetic on money outside `src/lib/money`), 3 (journal entries balance in the
database — this function's output is what makes the sale entry balance), 7 (discount first, then
tax the discounted amount; each line snapshots its own price and rate; one rounding rule in one
function used by POS, server and reports)

**Do:**
1. Create `src/lib/money/order-totals.ts` with a header comment in the style of `tax.ts`:
   isomorphic; imported by the till, the server and the report; rounds ONLY through
   `roundToMinor`; never reads a setting; never resolves a `null` rate. Its ONLY imports are
   `import { add, addExact, exact, multiplyByInteger, roundToMinor, subtract, sum, sumExact,
   type Exact, type Minor, type RoundingRule } from './index';` and
   `import { taxOnAmount, type TaxMode } from './tax';`. No `$lib/...`, no `../sync-ops`, no
   `$lib/server/**` (ESLint errors on it in this directory), no `node:` builtin, no package.
   Callers outside the module import `'$lib/money/order-totals'`.
2. Export the two types with exactly these names and members:
   ```ts
   export type TotalsLine = {
   	unitPriceMinor: Minor; // the price STORED on the line, never re-read from the menu
   	quantity: bigint; // 3n, never 3
   	modifierDeltasMinor: Minor[]; // one entry per chosen modifier; −50n is legal
   	taxRateBp: number; // the RESOLVED rate: the item's own or the restaurant's; 825 = 8.25%
   	discountMinor: Minor; // a whole-line discount in minor units; 0n everywhere in this plan
   };
   export type OrderTotals = {
   	subtotal: Minor; // Cr 4000 Sales Revenue
   	discount: Minor; // Dr 4100 Sales Discounts
   	tax: Minor; // Cr 2100 Tax Payable
   	total: Minor; // Dr 1000 Cash on Hand / 1020 / 1030 — what the customer pays
   	net: Minor; // total − tax; equals subtotal when there is no discount
   	lines: { undiscountedNet: Exact; net: Exact; tax: Exact; gross: Exact }[];
   };
   ```
   Resolving `null` (`menu_items.tax_rate_bp` means "inherit the restaurant rate") is the
   caller's job — T-24 on the till, T-18 on the server. A `null` passed here reaches
   `taxOnAmount`'s guard and throws `TypeError`; do not catch it.
3. Export `computeOrderTotals(input: { taxMode: TaxMode; lines: TotalsLine[] }, rule:
   RoundingRule): OrderTotals`. `rule` is REQUIRED with no default — the `index.ts` idiom: a
   default parameter answers an open decision silently and hides every call site from grep. Every
   real caller passes `ROUNDING_RULE`. Per line, in this order, every value an `Exact` or a
   `Minor` and nothing rounded:
   1. `if (typeof line.quantity !== 'bigint') throw new TypeError('quantity is a bigint (3n),
      never a number')` — `bigint * number` throws a bare `TypeError` at runtime anyway; this one
      says why. Then `if (line.quantity < 1n) throw new RangeError(...)`: a zero or negative
      quantity is not a line.
   2. `if (line.discountMinor < 0n) throw new RangeError(...)`: a negative discount is a
      surcharge nobody approved.
   3. `unit = add(line.unitPriceMinor, sum(line.modifierDeltasMinor))` — `sum` seeds with `0n`,
      so an empty list adds nothing; a negative delta ("No cheese −50") is legal.
   4. `base = multiplyByInteger(unit, line.quantity)`.
   5. `amount = subtract(base, line.discountMinor)`; `if (amount < 0n) throw new
      RangeError('discount exceeds the line')` — refused, never clamped. Deltas that outweigh the
      price make `base` negative and fail this same check.
   6. `undiscountedNet = taxOnAmount(exact(base), line.taxRateBp, input.taxMode).net` — the net
      this line would have carried with no discount.
   7. `{ net, tax, gross } = taxOnAmount(exact(amount), line.taxRateBp, input.taxMode)` —
      discount FIRST, then tax the discounted amount (invariant 7). `tax.ts`'s header says the
      amount handed to it is already discounted; this step is the one place discounting happens.

   Push `{ undiscountedNet, net, tax, gross }` onto `lines`, in input order.
4. At order level, round each of the three ledger figures ONCE and derive the other two:
   ```ts
   const subtractExact = (a: Exact, b: Exact): Exact =>
   	addExact(a, exact(-b.numerator, b.denominator));
   const total = roundToMinor(sumExact(lines.map((l) => l.gross)), rule);
   const tax = roundToMinor(sumExact(lines.map((l) => l.tax)), rule);
   const discount = roundToMinor(
   	sumExact(lines.map((l) => subtractExact(l.undiscountedNet, l.net))),
   	rule
   );
   const net = subtract(total, tax); // DERIVED — never roundToMinor of the summed nets
   const subtotal = add(net, discount); // DERIVED
   return { subtotal, discount, tax, total, net, lines };
   ```
   `subtractExact` is module-private: not exported and NOT added to `index.ts`, which this plan
   never edits. Why derive: the sale posting rule (T-13) debits `total` and `discount` and credits
   `subtotal` and `tax`; with `net = total − tax` and `subtotal = net + discount`, the equation
   `total + discount = subtotal + tax` is an algebraic identity, so the entry balances in the
   database by construction (invariant 3) for every rate, both modes and either rule. This is
   assumption 7 of 00-overview.md: total, tax and discount are each rounded once, net and subtotal
   are derived; a clarification of the 2026-09-15 rounding decision, recorded by T-02. Rounding
   `net` on its own breaks it: 999 at 20% inclusive is exactly 832.5 net + 166.5 tax, and half-up
   on each gives 833 + 167 = 1000 ≠ 999 — the deferred balance trigger (T-09) would then reject
   every such sale at COMMIT. An empty `lines` array returns five `0n` and `lines: []`
   (`sumExact([])` is `exact(0n)`); refusing an empty order is the validator's job (T-18) and the
   till's (T-33).
5. Export `serializeTotals(t: OrderTotals): { subtotalMinor: string; discountMinor: string;
   taxMinor: string; totalMinor: string }` — `.toString()` of each of the four `bigint`s (`850n`
   → `'850'`). This is the exact `totals` shape of `SaleCompletePayload` in
   `src/lib/sync-ops/index.ts` (T-03): a `bigint` throws inside `JSON.stringify` and is never
   widened to a `number`, so the conversion happens here and nowhere else. `net` is not on the
   wire; the server derives it the same way.
6. Export `totalsEqual(a, b): boolean` where both parameters are typed
   `Pick<OrderTotals, 'subtotal' | 'discount' | 'tax' | 'total'>` — true when the four fields are
   each `===` (a `bigint` compares by value). `net` is implied by `total − tax`; `lines` is never
   compared. The `Pick` is deliberate: the server's `totals_mismatch` check (T-18, validateSale step 9) compares its
   recomputed `OrderTotals` with `{ subtotal: minor(BigInt(s)), … }` built from the device's four
   wire strings.
7. Forbidden anywhere in the file: `Number(`, `parseFloat`, `toFixed`, `Math.`, a float literal,
   `/` or `%` on a money value, and any rounding other than the three `roundToMinor` calls in step
   4. Keep the spelling `roundToMinor(` out of the comments so the Done-when grep counts calls.
   Run `pnpm format` before `pnpm lint`.

**Tests:** `src/lib/money/order-totals.test.ts`, importing from `'./index'`, `'./tax'` and
`'./order-totals'` (relative: the unit project in `vitest.config.ts` has no `$lib` alias). Reuse
the seeded LCG idiom of `tax.test.ts` (`generator(seed)`, `between(next, lo, hi)`, the Numerical
Recipes constants, no property-testing library) and write a
`line(unit, rateBp, { quantity, deltas, discount })` builder so each case reads as numbers. Every
case below is MANDATORY (spec 29 — money arithmetic and rounding; tax calculation in both modes)
unless marked otherwise; `R` stands for `ROUNDING_RULE`.
- spec 18, exclusive: lines 800 and 200 at 1000 bp → `subtotal 1000n, discount 0n, tax 100n,
  total 1100n, net 1000n`; `lines[0]` equals `{ undiscountedNet: exact(800n), net: exact(800n),
  tax: exact(80n), gross: exact(880n) }`.
- spec 17, inclusive: 1100 at 1000 bp → `net 1000n, tax 100n, total 1100n, subtotal 1000n,
  discount 0n` — both modes leave the customer paying 1100 and the revenue at 1000.
- The tie, inclusive: 999 at 2000 bp → `total 999n, tax 167n, net 832n, subtotal 832n, discount
  0n`; assert `subtotal − discount + tax === total`; assert `lines[0].net` equals
  `exact(1665n, 2n)` (832.5) and that `roundToMinor(lines[0].net, R)` is `833n` while `net` is
  `832n` — 833 + 167 = 1000 ≠ 999 is why `net` is derived and never rounded.
- The tie, inclusive: 1414 at 1200 bp → `lines[0].tax` equals `exact(303n, 2n)` (151.5);
  `tax === roundToMinor(exact(303n, 2n), R)`, which is `152n` under the recorded `'half-up'` (and
  `152n` under `'half-even'` too, 152 being the even neighbour); `total 1414n`;
  `net === 1414n − tax` (`1262n`); `subtotal 1262n`; the identity holds. Compare against
  `roundToMinor`'s own answer as well as the literal, so a later rule change cannot make the test
  lie about which rule produced the number.
- Rounded ONCE on the sum, not per line: three lines of 333 at 825 bp exclusive → each
  `lines[i].tax` equals `exact(10989n, 400n)` (27.4725); `tax 82n` (82.4175); assert
  `3n * roundToMinor(lines[0].tax, R) === 81n` — the per-line defect; `total 1081n` (1081.4175),
  `net 999n`, `subtotal 999n`.
- Modifiers and quantity: unit 1000, deltas `[−50n]`, quantity `3n`, 1000 bp exclusive →
  `subtotal 2850n, tax 285n, total 3135n, discount 0n`. Unit 850, deltas `[50n]` (Extra Cheese),
  quantity `2n`, 825 bp exclusive → `subtotal 1800n, tax 149n` (148.5, a tie in exclusive mode),
  `total 1949n` (1948.5), `net 1800n`.
- spec 24's discount: 1000 at 1000 bp exclusive with `discountMinor 100n` → `subtotal 1000n,
  discount 100n, tax 90n, total 990n, net 900n`; `total + discount === subtotal + tax` (`1090n`,
  spec 24's "$10.90 = $10.90"); `serializeTotals` returns
  `{ subtotalMinor: '1000', discountMinor: '100', taxMinor: '90', totalMinor: '990' }`.
- Inclusive discount: 1100 at 1000 bp inclusive with `discountMinor 110n` → `subtotal 1000n,
  discount 100n` (the net part of the 110 gross discount; its 10 of tax is simply never
  collected), `tax 90n, total 990n, net 900n`; `total + discount === subtotal + tax`.
- A free item alone: unit 0 at 1000 bp → all five `0n`, every member of `lines[0]` `exact(0n)`,
  `discount === 0n` exactly.
- Rate 0 in both modes: 1000 at 0 bp → `tax 0n, total 1000n, net 1000n, subtotal 1000n`.
- Refusals (not spec 29 areas, still required): `quantity: 2 as never` → `TypeError`;
  `quantity: 0n` → `RangeError`; `discountMinor 101n` on a 100 line → `RangeError`;
  `discountMinor −1n` → `RangeError`; deltas `[−200n]` on a 100 unit → `RangeError`;
  `taxRateBp: null as never` → `TypeError`; `taxMode: null as never` → `TypeError`; `rule`
  `undefined as never` → `TypeError` (`roundToMinor`'s guard); an empty `lines` array → five
  `0n` and `lines: []`.
- MANDATORY property test, seed `20260928n`, 2000 cases: per case draw the mode from the HIGH
  bits (`(next() >> 16n) % 2n` — the generator's low bit alternates, as `index.test.ts` notes) and
  1–6 lines; per line a rate 0..10000, 0–3 deltas each in −500..500, a unit price 0..99999
  replaced by `−Σdeltas` when `unit + Σdeltas < 0n` (so no generated line is negative), a
  quantity `1n..9n`; one coin per case from the high bits: heads → every line's `discountMinor` is
  `0n`, tails → each line's discount is drawn 0..base. Under `R` assert, for every case: (i)
  `subtotal − discount + tax === total`; (ii) `net + tax === total`; (iii) `discount === 0n` if
  and only if every line discount is `0n`; (iv) `total + discount === subtotal + tax` — the sale
  entry's Dr = Cr (T-13); (v) every per-line `Exact` has `denominator <= 20000n` (reduced
  fractions over 10000 or 10000 + bp). Compute the same case under `'half-even'` and assert (i),
  (ii) and (iv) again — they hold by construction under any rule. Coverage: both modes drawn, and
  each coin outcome at least 500 times.
- Source tripwire: `readFileSync(new URL('./order-totals.ts', import.meta.url), 'utf8')` (the
  idiom of `src/routes/(dashboard)/menu/helpers.test.ts`), with comments stripped the way
  `stripComments` in `src/lib/components/components.test.ts` does; assert the code contains none
  of `Number(`, `parseFloat`, `toFixed`, `Math.`, that `/\d\.\d/` does not match (no float
  literal), and that every `from '…'` specifier is `'./index'` or `'./tax'`.
- Wire shape: `import type { SaleCompletePayload } from '../sync-ops/index'` in the TEST only
  (type-only, erased at runtime; never in `order-totals.ts`), then
  `const wire: SaleCompletePayload['totals'] = serializeTotals(totals)` — a compile-time pin to
  T-03; `totalsEqual` is `true` for two computations of the same input and `false` when any one of
  the four fields differs by `1n`.

**Done when:** `pnpm test:unit src/lib/money` passes with the two new files listed in its output;
`pnpm check` reports 0 errors; `pnpm lint` passes; `git status --short src/lib/money` shows
exactly `?? src/lib/money/order-totals.ts` and `?? src/lib/money/order-totals.test.ts` and NO
modified file (`index.ts`, `tax.ts`, `format.ts` untouched);
`grep -o "roundToMinor(" src/lib/money/order-totals.ts | wc -l` prints `3`.

**Watch out:** Never round per line and never call `Math.round`: the three `roundToMinor` calls in
step 4 are the only rounding, and `net` / `subtotal` are subtractions and additions of
already-rounded integers. `exact()` reduces every fraction, so each PER-LINE denominator stays
≤ 20000; the three order-level sums carry the LCM of the line denominators (inclusive lines at 825
bp and 1000 bp give lcm(10825, 11000) = 4,763,000), which `bigint` handles — assert (v) per line
only, and do not "optimise" the reduction away. Seed every reduction with `0n`: `bigint +
number` throws at runtime, not at compile time. Claim (iii)'s reverse direction (some line discount
above `0n` ⇒ `discount > 0n`) relies on `'half-up'`: a 1-minor-unit discount at 10000 bp inclusive
has a net part of exactly 0.5, which `'half-even'` rounds to 0 — so assert (iii) under `R` only.
This plan's validator (T-18) pins every wire `discountMinor` to `"0"`, but the discount paths are
built and tested now because the 4100 posting rule (T-13, spec 24) needs them and the approvals
plan opens them. Do not import `../sync-ops` from `order-totals.ts` — the money module imports
nothing outside itself; a type-only import in the test is fine.

### T-11 — `changeDue` and `quickTenders` in the money module

**Needs:** T-10 (`computeOrderTotals` produces the `total` these helpers take; the same module
conventions and test idioms)
**Files:**
- `src/lib/money/change.ts` — NEW
- `src/lib/money/change.test.ts` — NEW
**Spec:** 13 (Record Payment(s) — the amount recorded is the order total; tendered and change are
numbers the till computes for the drawer, not spec text), 6 (an offline cash sale is a completed
fact, so the change is computed on the device
from the device's total), 17 (all money arithmetic in one shared module; integer minor units), 29
(mandatory tests: money arithmetic)
**Invariants:** 1 (money is integer minor units in `bigint`; no float; no arithmetic on money
outside `src/lib/money` — which is why a component may not subtract a tender from a total itself),
7 (one rounding rule in one function — this file never rounds)

**Do:**
1. Create `src/lib/money/change.ts` importing ONLY
   `import { minor, subtract, type Minor } from './index';`. Header comment: isomorphic; called by
   the till's pay screen (T-34) to show the change and the quick-tender keys, by `completeSale`
   (T-24) to fill `SalePayment.changeMinor` for a cash payment, and by the server's validator
   (T-18) to check that a cash payment's `changeMinor` equals `tenderedMinor − amountMinor`; no
   Svelte component ever does this subtraction itself. The file rounds nothing and reads no
   setting.
2. Export `changeDue(tendered: Minor, total: Minor): Minor`: `if (tendered < total) throw new
   RangeError('tendered is less than the amount due')`; return `subtract(tendered, total)`.
   `changeDue(total, total)` is `0n`. No allocation, no rounding: both inputs are whole minor
   units already — the total came from `computeOrderTotals`, the tender from the keypad or a
   quick-tender key.
3. Export `quickTenders(total: Minor, exponent: number): Minor[]`, the amounts the pay screen
   offers as one-tap cash keys. Guard `exponent` with the same test `formatAmount` in
   `src/lib/money/format.ts` uses (`!Number.isSafeInteger(exponent) || exponent < 0` →
   `RangeError`); `total < 0n` → `RangeError` (refunds are a later plan; throw rather than guess).
   If `total === 0n` return `[minor(0n)]`. Otherwise `major = 10n ** BigInt(exponent)` (one major
   unit: `100n` for USD, exponent 2) and `nextAbove(step: bigint) = minor((total / step + 1n) *
   step)` — bigint division truncates toward zero, so the `+ 1n` makes the result STRICTLY above
   `total` (2000 → 2100, not 2000). Candidates in this order: the exact `total`;
   `nextAbove(major)`; `nextAbove(5n * major)`; `nextAbove(10n * major)`. De-duplicate preserving
   order (`[...new Set(candidates)]`; a `Set` compares `bigint` by value) and return: ascending by
   construction, 1 to 4 entries, entry 0 always the exact total.
4. The exponent is `moneyFormatFor(currencyCode).exponent` from `src/lib/money/format.ts` at the
   CALL SITE — the till holds the code in its cached menu snapshot's `currency` and the order
   snapshots `currency_code`. `change.ts` does not import `./format` and never assumes 2.
5. Not in this file: the keypad, whether card and mobile are enabled, any check on where a tender
   came from. Forbidden: `Number(`, `parseFloat`, `toFixed`, `Math.`, float literals. Keep the
   spelling `from '` out of comments (write "in `src/lib/money/format.ts`", not "from
   `src/lib/money/format.ts`") so the Done-when grep counts only the import. Run `pnpm format`
   before `pnpm lint`.

**Tests:** `src/lib/money/change.test.ts`, MANDATORY (spec 29 — money arithmetic) throughout:
- `changeDue(minor(2000n), minor(1237n))` → `763n`; `changeDue(minor(1237n), minor(1237n))` →
  `0n`; `changeDue(minor(1000n), minor(1237n))` → throws `RangeError`;
  `changeDue(minor(3000n), minor(2750n))` → `250n` (the pay-screen case T-34 cites).
- `quickTenders(minor(1237n), 2)` → `[1237n, 1300n, 1500n, 2000n]`.
- `quickTenders(minor(2750n), 2)` → `[2750n, 2800n, 3000n]` — the 5-unit step
  `(5n + 1n) × 500n` and the 10-unit step `(2n + 1n) × 1000n` coincide at 3000 and de-duplicate;
  4000 is never offered (the pay-screen case T-34 cites).
- `quickTenders(minor(2000n), 2)` → `[2000n, 2100n, 2500n, 3000n]` (a round total still gets
  strictly-above keys).
- `quickTenders(minor(0n), 2)` → `[0n]`.
- `quickTenders(minor(1237n), 0)` → `[1237n, 1238n, 1240n]` — exponent 0, a zero-decimal
  currency: the 5-unit and 10-unit steps coincide at 1240 and de-duplicate.
- `quickTenders(minor(1700n), 2)` → `[1700n, 1800n, 2000n]` (de-duplication at exponent 2);
  `quickTenders(minor(99n), 2)` → `[99n, 100n, 500n, 1000n]`.
- `quickTenders(minor(-1n), 2)`, `quickTenders(minor(100n), 1.5)` and
  `quickTenders(minor(100n), -1)` → throw `RangeError`.
- Property, seed `20260928n`, 500 cases, `total` in 1..10_000_000 and `exponent` in 0..3: the
  result is strictly ascending with no duplicate, has 1–4 entries, `result[0] === total`, every
  later entry is `> total`, and for every entry `t`: `changeDue(t, total) >= 0n` and
  `t − changeDue(t, total) === total`.
- Source tripwire as in T-10, for `change.ts`: none of `Number(`, `parseFloat`, `toFixed`,
  `Math.`, no float literal, and the only import specifier is `'./index'`.

**Done when:** `pnpm test:unit src/lib/money/change.test.ts` passes; `pnpm check` reports 0
errors; `pnpm lint` passes; `grep -n "from '" src/lib/money/change.ts` prints exactly one line and
it ends in `'./index';`; `git status --short src/lib/money` shows only the two new `change*` files
as untracked and nothing modified.

**Watch out:** The exponent comes from `moneyFormatFor(code).exponent` at the call site; this file
imports only `'./index'`. `10n ** exponent` with a `number` throws — convert with
`BigInt(exponent)` after the integer guard. `total / step` truncates, and the `+ 1n` is the whole
meaning of "strictly above": without it `quickTenders(minor(2000n), 2)` would offer 2000 twice. A
negative total never reaches this file in this plan; throwing is correct, silently taking the
absolute value is not.
