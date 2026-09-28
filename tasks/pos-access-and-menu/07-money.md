# Phase 6 — Money

The money foundation the menu half needs and nothing more: one isomorphic arithmetic module in
integer minor units, one rounding function, tax in both modes with the rate in integer basis points,
one display formatter, and the three nullable settings columns that tell the calculation which mode,
which rate and which currency to use. No prices, no order lines, no journal entries and no payment
transaction land here — this phase exists so the menu tables in Phase 7 have a `bigint` price they can
be multiplied and taxed by without a float ever touching the value.

**Depends on:** Phase 0 — specifically **T-01** (the money-module placement, and the correction to
`CLAUDE.md` invariant 1 that goes with it) and **T-03** (open decision 3 — tax mode and rounding — and
open decision 4 — currency and its minor-unit exponent). Independent of Phases 1–5: nothing here
touches `pos_devices`, PINs, the route guard or the POS shell, so this phase can be built in parallel
with them.

---

### T-33 — Create the isomorphic money core

**Needs:** T-01

**Files:**

- `src/lib/money/index.ts` — NEW (the directory **exists and contains only `README.md`**, created by
  T-01, whose `Done when:` requires `ls src/lib/money/` to print `README.md` and nothing else. Add
  `index.ts` beside it and do not touch the README. NOT `src/lib/server/money/`, which stays
  README-only and later takes DB-touching helpers alone)
- `src/lib/money/index.test.ts` — NEW (runs in the `unit` Vitest project, which includes
  `src/**/*.test.ts`)

**Spec:** 17 (money is integer minor units in `bigint`; one rounding rule implemented in one function
and used everywhere — POS, server and reports; a single currency), 29 (mandatory automated tests:
money arithmetic and rounding)

**Invariants:** 1 (money is integer minor units — `$8.50` is `850`; never a float, never `parseFloat`,
never `toFixed`, never a second rounding helper), 7 (ONE rounding rule in ONE function used by POS,
server and reports)

**Do:**

1. **Check T-01 has run before writing a line.** `CLAUDE.md` invariant 1 must already name
   `src/lib/money/` as the home of pure money arithmetic, and
   `src/lib/server/money/README.md` must no longer describe the placement as UNRESOLVED. If either
   still reads the old way, stop and report it: T-01 has not run, and this file would land in a repo
   whose rules still forbid it. **Do not edit `CLAUDE.md` or that README here** — T-01 owns both.

   **T-03 is a real prerequisite for step 6, even though `Needs:` above names only T-01** — that line
   is fixed by the task index in `tasks/pos-access-and-menu/00-overview.md`, and the index has not
   been corrected. Step 6 exports `ROUNDING_RULE`, which **is** spec 33 open decision 3's rounding
   answer, and 00-overview.md's Assumptions section says no task may encode one of these before T-03
   has obtained and recorded it. Steps 2–5, 7 and 8 encode no open decision and can be written while
   T-03 is still outstanding; step 6 cannot, and it says so again where it stands.
2. Create `src/lib/money/index.ts`. It is imported by **both** sides: `src/lib/server/**` and
   `src/routes/(pos)/**`. It therefore imports **nothing** — no `$lib/server/*` (`eslint.config.js`
   errors on that import from `src/routes/(pos)/**` and `src/lib/pos/**`), no `$app/*`, no npm
   package, no `node:*` builtin. Pure TypeScript and `bigint` only.
3. Export the branded minor-unit type and its only two conversions:
   ```ts
   declare const MINOR: unique symbol;
   export type Minor = bigint & { readonly [MINOR]: true };
   export function minor(value: bigint): Minor; // the ONLY constructor; throws TypeError unless typeof value === 'bigint'
   export function toBigInt(value: Minor): bigint; // for a drizzle bigint({ mode: 'bigint' }) write
   ```
   The brand is compile-time only and costs nothing at runtime. It exists so a plain `850` (a
   `number`) and a plain `850n` (a bare `bigint`) cannot be passed where a `Minor` is required, and so
   the **result** of any raw arithmetic is a plain `bigint` that cannot be assigned back to a `Minor`
   or handed to a function taking one — the value has to come back through `minor()`, and `add` and
   its siblings are where that happens.
   **Be exact about what the brand does not do.** `a + b` on two `Minor` values **type-checks** and
   yields `bigint`: a brand on a primitive blocks assignment, never arithmetic. So do not write a
   `@ts-expect-error` compile-guard over `a + b` expecting an error — there is none, and the unused
   `@ts-expect-error` then fails the build itself. A guard that does work is
   `// @ts-expect-error` over `const x: Minor = a + b;` and over `add(850n, 850n)`, because those are
   assignments. Banning raw `+` on money outright is a lint rule or a review note for a later task,
   not something this type achieves.
4. Export whole-unit arithmetic. Every one of these takes and returns `Minor`, never `number`:
   - `add(a: Minor, b: Minor): Minor`
   - `subtract(a: Minor, b: Minor): Minor`
   - `sum(values: readonly Minor[]): Minor` — **seed the fold with `0n`**, never `0`
   - `negate(a: Minor): Minor`
   - `multiplyByInteger(amount: Minor, count: bigint): Minor` — quantity × unit price. `count` is a
     `bigint` because `bigint * number` throws `TypeError` at runtime.
5. Export the exact-rational type the tax module needs, so full precision survives per line and is
   rounded once at the total (spec 17):
   ```ts
   export type Exact = { readonly numerator: bigint; readonly denominator: bigint };
   export function exact(numerator: bigint, denominator?: bigint): Exact; // denominator defaults to 1n
   export function addExact(a: Exact, b: Exact): Exact;
   export function sumExact(values: readonly Exact[]): Exact;
   export function exactEquals(a: Exact, b: Exact): boolean;
   ```
   `exact()` **must canonicalise**: reject `denominator === 0n` with a `RangeError`, move a negative
   sign onto the numerator so the denominator is always positive, and divide both by their greatest
   common divisor (a plain Euclidean `gcd` on `bigint`, defined locally in this file). Canonicalising
   is not tidiness: `a/b + c/d = (ad + cb)/(bd)`, so twenty un-reduced bill lines each carrying a
   denominator of `10000n` produce a denominator of `10000n ** 20n` — a number with eighty digits that
   grows with every line. Reduction also makes structural equality valid, which is what `exactEquals`
   and the tests rely on.
6. Export **THE** rounding function — the only place in the entire repo where a fractional minor unit
   becomes a whole one:
   ```ts
   export type RoundingRule = 'half-up' | 'half-even';
   export function roundToMinor(value: Exact, rule: RoundingRule): Minor;
   ```
   `rule` is a **required parameter with no default value**. A default parameter is exactly how spec
   33's open decision 3 becomes a silently answered decision, and it would hide the call sites from
   `grep` on the day the accountant answers. Implement with `bigint` only: truncate toward zero, take
   the remainder, compare `2n * abs(remainder)` with the denominator; on a tie, `'half-up'` goes
   **away from zero** (so `−0.5` → `−1`, and a reversing entry cancels the entry it reverses exactly)
   and `'half-even'` goes to the even neighbour.
   Also export the one named constant every call site passes:
   ```ts
   export const ROUNDING_RULE: RoundingRule = 'half-up';
   ```
   **Stop and ask if T-03 has not recorded an answer to open decision 3's rounding question.** Look
   in two places: `CLAUDE.md`'s "Decisions already made (NOT open — do not re-litigate)" section, and
   the **Open decision 3 (tax rules)** bullet under "## Assumptions" in
   `tasks/pos-access-and-menu/00-overview.md`, which still reads `— UNANSWERED.` until T-03 rewrites
   it. If neither carries a rounding answer, **do not write this constant and do not carry spec 17's
   default on your own judgement** — a value committed here is the one every call site will pass
   forever, and changing it later changes every total the books have already recorded. Steps 2–5, 7
   and 8 can still be written and committed; this export waits for T-03.
   When T-03 **has** recorded an answer, this constant is that answer and its comment cites T-03. When
   what T-03 recorded is that the user explicitly said to proceed with spec 17's carried default, the
   value is `'half-up'` — chosen over `'half-even'` because a cash till and a hand-written receipt
   round a half away from zero, a customer checking the total on a calculator reproduces that, and
   half-even's compensating argument applies to large portfolios of independent roundings rather than
   to the single per-invoice rounding spec 17 prescribes. Either way the comment says it is open
   decision 3's answer, that changing it is a decision and not a refactor, and the commit message
   records which of the two cases applied and quotes T-03's record.
7. Export the allocator split bills will need:
   ```ts
   export function allocate(total: Minor, parts: number): Minor[];
   ```
   Largest-remainder: `base = total / BigInt(parts)` (bigint division truncates toward zero),
   `remainder = total - base * BigInt(parts)`, then hand one minor unit — carrying the **sign of the
   remainder** — to each of the first `abs(remainder)` parts. `100n` across 3 gives
   `[34n, 33n, 33n]`; `−100n` across 3 gives `[−34n, −33n, −33n]`. Throw a `RangeError` unless
   `Number.isInteger(parts) && parts >= 1`. **Do not add a weighted variant** — allocating by seat or
   by line weight belongs to the split-bill task that actually needs it.
8. Write `src/lib/money/index.test.ts`. **No property-testing library may be added** — this project's
   runtime dependencies are exactly `drizzle-orm`, `pg` and `zod`, and adding `fast-check` is a
   decision nobody has made. Write the property tests as a deterministic loop over a small seeded
   linear-congruential generator defined at the top of the test file, so a failure reproduces exactly.

**Tests:**

- MANDATORY (spec 29 — money arithmetic and rounding): `allocate(minor(100n), 3)` returns
  `[34n, 33n, 33n]` and `sum(...)` of the result is `100n`.
- MANDATORY (spec 29): `allocate(minor(-100n), 3)` returns `[-34n, -33n, -33n]` and sums back to
  `-100n` — negative totals behave symmetrically, because a refund is the reverse of the sale.
- MANDATORY (spec 29 — rounding): explicit tie cases pin both rules —
  `roundToMinor(exact(5n, 2n), 'half-up') === 3n` (2.5 → 3) and `roundToMinor(exact(5n, 2n),
  'half-even') === 2n`; `roundToMinor(exact(7n, 2n), 'half-even') === 4n` (3.5 → 4);
  `roundToMinor(exact(-5n, 2n), 'half-up') === -3n` (ties away from zero).
- MANDATORY (spec 29): non-tie rounding is unaffected by the rule —
  `roundToMinor(exact(1992375n, 10000n), rule) === 199n` for both rules (199.2375).
- MANDATORY (spec 29 — property): for 500 generated `(total, parts)` pairs with
  `total ∈ [−10_000_000n, 10_000_000n]` and `parts ∈ [1, 20]`, `sum(allocate(total, parts))` equals
  `total` exactly and the result has exactly `parts` entries — allocation never loses or invents a
  minor unit.
- `exact(2000n, 10000n)` canonicalises to `{ numerator: 1n, denominator: 5n }`; `exact(1n, -2n)`
  canonicalises to `{ numerator: -1n, denominator: 2n }`; `exact(1n, 0n)` throws.
- `addExact(exact(1n, 3n), exact(1n, 6n))` equals `exact(1n, 2n)` — the denominator stays small
  because `exact()` reduces.
- `sum([])` is `0n`; `multiplyByInteger(minor(850n), 3n)` is `2550n`.
- `allocate(minor(100n), 0)` and `allocate(minor(100n), 1.5)` both throw.

**Done when:** `pnpm exec vitest run --project unit src/lib/money/index.test.ts` passes,
`pnpm check && pnpm lint` are clean, and
`grep -nE 'parseFloat|toFixed|Math\.|Number\(' src/lib/money/index.ts` **prints nothing** — no
`parseFloat`, no `toFixed`, no `Math.` anything and no `Number(...)` call. Step 7's
`Number.isInteger` does not match that pattern and must not be removed to satisfy it: the pattern
requires the `(` immediately after `Number`.
Float **literals** are checked by eye rather than by grep, because no pattern separates a decimal in
code from a decimal in a comment: `grep -nE '[0-9]\.[0-9]' src/lib/money/index.ts` is **expected to
print hits**, and this task mandates two of them — step 6's comment explaining that `−0.5` rounds to
`−1`, and invariant 1's standard phrasing that `$8.50` is `850`. Read every hit; each one must be
inside a comment or a string. A decimal in executable code is a float literal and a bug, and
`pnpm check` plus T-01's eslint boundary are what stop it in the general case.

**Watch out:** `bigint` literals need the `n` suffix and `bigint + number` throws `TypeError` at
runtime, not compile time, so a `0` seed in a fold is a crash in production and not a red squiggle.
`JSON.stringify` **throws** on a `bigint`, so any amount crossing an API boundary or entering an audit
`details` object is converted with `.toString()` at that boundary — never by widening the value to a
`number`. Drizzle's `bigint({ mode: 'bigint' })` returns a `bigint`, which is why this module speaks
`bigint` and not `string`. Nothing in this file may reach for `Math.round` — it takes a `number`, and
there is no `number` here to give it.

---

### T-34 — Add tax in both modes, with the rate in integer basis points

**Needs:** T-33, T-03

**Files:**

- `src/lib/money/tax.ts` — NEW (the directory and its core were created by T-33; add this file
  **beside** `index.ts` and import from it. Do **not** rewrite `index.ts`, and do **not** add a
  re-export of `tax.ts` to it — `tax.ts` imports `index.ts`, so a re-export makes the two files import
  each other, and a cycle in the one module everything else imports is not worth a shorter import
  path. Callers write `import { taxOnLine } from '$lib/money/tax'`)
- `src/lib/money/tax.test.ts` — NEW

**Spec:** 17 (tax mode is a restaurant setting; the inclusive/exclusive table; one rounding rule, full
precision per line, round once on the invoice total; discounts applied before tax), 18 (the worked
sale: subtotal $10, tax $1, total $11 — tax is not revenue), 29 (mandatory automated tests: tax
calculation in **both** tax modes)

**Invariants:** 1 (money is integer minor units; no float anywhere near it), 7 (discount first, then
tax the discounted amount; tax mode is a setting read at calculation time, never hardcoded; ONE
rounding rule in ONE function)

**Do:**

1. Create `src/lib/money/tax.ts`, importing `Minor`, `Exact`, `exact` and `addExact` from `./index`.
   It computes and **never rounds** — `roundToMinor` from T-33 is the only rounding function in the
   repo, and it is called once, by the caller, on the invoice total.
2. Export the mode, as a tuple and a union so one list feeds both TypeScript and the zod schema T-36
   writes:
   ```ts
   export const TAX_MODES = ['exclusive', 'inclusive'] as const;
   export type TaxMode = (typeof TAX_MODES)[number];
   ```
   These two literals are also the two values T-36's database CHECK constraint on
   `restaurant_settings.tax_mode` allows. Keep them spelled identically.
3. **The rate is integer basis points. `825` means 8.25%.** Type it `rateBp: number` — the column T-36
   adds is `integer`, and `pg` returns an `integer` column as a JavaScript number — then guard it on
   entry:
   ```ts
   if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > 10_000) {
     throw new TypeError('tax rate is integer basis points (825 = 8.25%), never a fraction');
   }
   ```
   and convert once with `BigInt(rateBp)`. A signature of `rateBp: number` meaning `0.0825` would put
   floating point on line one of the module whose entire purpose is to keep it out:
   `2415 * 0.0825 === 199.23749999999998`, and because spec 17 carries full precision per line and
   rounds once at the total, that error accumulates across every line before any rounding happens and
   lands on the figure a tax filing is reconciled against.
4. Export the calculation over exact rationals, so a discounted line amount (which is already an
   `Exact`) can be taxed without a rounding step in the middle:
   ```ts
   export type LineTax = { net: Exact; tax: Exact; gross: Exact };
   export function taxOnAmount(amount: Exact, rateBp: number, mode: TaxMode): LineTax;
   ```
   Both formulae explicitly, by integer multiply-then-divide, carrying the remainder in the
   denominator rather than rounding per line:
   - **exclusive** — the amount is the net and the tax is added on top:
     `net = amount`, `tax = amount × bp / 10000`, `gross = net + tax`.
   - **inclusive** — the amount already contains the tax:
     `tax = amount × bp / (10000 + bp)`, `net = amount × 10000 / (10000 + bp)`, `gross = amount`.

   With `amount = { numerator: a, denominator: d }` the exclusive tax is
   `exact(a * BigInt(rateBp), d * 10_000n)` and the inclusive tax is
   `exact(a * BigInt(rateBp), d * BigInt(10_000 + rateBp))`. `exact()` reduces, so the denominators
   stay small.
5. Export the thin whole-amount wrapper the order lines will call:
   ```ts
   export function taxOnLine(amount: Minor, rateBp: number, mode: TaxMode): LineTax;
   ```
   It is `taxOnAmount(exact(amount), rateBp, mode)` and nothing else.
6. `mode` is a **required parameter with no default value**, and `tax.ts` contains no literal
   `'exclusive'` or `'inclusive'` outside `TAX_MODES`. It is read at calculation time from
   `restaurant_settings.tax_mode` (the column T-36 adds) on the server, and on the POS from the cached
   menu snapshot. A default in the signature silently answers spec 33's open decision 3 for every
   restaurant whose owner never chose.
7. State in the file header that **the amount handed to this module is already discounted** —
   discount first, then tax the discounted amount (invariant 7). `tax.ts` never applies a discount and
   never reads a discount; doing so here would put two places in the repo that decide the order of
   operations.
8. Write `src/lib/money/tax.test.ts`. As in T-33, no property-testing library: a seeded
   linear-congruential generator defined in the test file drives the generated cases.

**Tests:**

- MANDATORY (spec 29 — tax in BOTH modes): spec 17's table, exclusive at 10% — `taxOnLine(minor(1000n),
  1000, 'exclusive')` gives `net` `exact(1000n)`, `tax` `exact(100n)`, `gross` `exact(1100n)`.
- MANDATORY (spec 29 — tax in BOTH modes): spec 17's table, inclusive at 10% —
  `taxOnLine(minor(1100n), 1000, 'inclusive')` gives `net` `exact(1000n)`, `tax` `exact(100n)`,
  `gross` `exact(1100n)`. Both modes leave the customer paying `1100n` and revenue at `1000n`.
- MANDATORY (spec 29): spec 18's sale — burger `800n` + drink `200n` at `1000` bp exclusive sums
  (`sumExact`) to a tax of `exact(100n)` and a total of `exact(1100n)`, rounding once with
  `roundToMinor(total, ROUNDING_RULE)` to `1100n`.
- MANDATORY (spec 29 — the rounding rule actually matters): three lines of `333n`, `333n` and `334n`
  at `825` bp exclusive. Rounding **per line** gives `27n + 27n + 28n = 82n`; carrying full precision
  and rounding **once on the total** gives `roundToMinor(exact(825000n, 10000n), 'half-up') === 83n`.
  Assert `83n` and name spec 17 in the test title — this case is the reason the module returns
  `Exact` rather than `Minor`. (It also separates the rules: `'half-even'` on the same total gives
  `82n`.)
- MANDATORY (spec 29): a fractional exclusive line — `taxOnLine(minor(2415n), 825, 'exclusive').tax`
  equals `exact(1992375n, 10000n)` exactly (199.2375), with no rounding applied, and no intermediate
  value in the module is a `number`.
- MANDATORY (spec 29 — property, inverse): for 500 generated `(amount, rateBp)` pairs with
  `amount ∈ [0n, 10_000_000n]` and `rateBp ∈ [0, 10_000]`, `taxOnAmount(taxOnLine(amount, rateBp,
  'inclusive').net, rateBp, 'exclusive').gross` equals `exact(amount)` — splitting a gross into net and
  tax and adding the tax back to the net returns the same gross, in exact rationals, with no rounding
  anywhere.
- MANDATORY (spec 29 — property, internal consistency): for the same generated pairs and both modes,
  `addExact(net, tax)` equals `gross`; in `'inclusive'` mode `gross` equals `exact(amount)`, in
  `'exclusive'` mode `net` equals `exact(amount)`.
- `taxOnLine(minor(1000n), 0, 'exclusive')` gives a tax of `exact(0n)` and a gross equal to the net —
  a zero rate is legal, not an error.
- `taxOnLine(minor(1000n), 8.25, 'exclusive')` throws `TypeError`, and so does a rate of `-1` and a
  rate of `10_001`.

**Done when:** `pnpm exec vitest run --project unit src/lib/money/tax.test.ts` passes,
`pnpm check && pnpm lint` are clean, and
`grep -nE 'parseFloat|toFixed|Math\.|0\.[0-9]' src/lib/money/tax.ts` prints nothing — the only
non-`bigint` number in the file is `rateBp` and its guard bounds.

**Watch out:** `BigInt(8.25)` throws `RangeError`, not `TypeError`, and a caller reading a rate out of
a JSON body gets a `number` — hence the explicit `Number.isSafeInteger` guard before the conversion,
so the error message names basis points instead of surfacing a raw `RangeError`. Do not "simplify"
`LineTax` down to a `Minor` by rounding inside this module: a per-line round is the exact defect the
third mandatory test above exists to catch, and it changes the tax a filing reconciles against.

---

### T-35 — Add the money formatter

**Needs:** T-33, T-03

**Files:**

- `src/lib/money/format.ts` — NEW (the directory and its core were created by T-33; add this file
  beside `index.ts` and `tax.ts`. Import only the `Minor` type from `./index`; add no re-export to
  `index.ts`, for the cycle reason in T-34)
- `src/lib/money/format.test.ts` — NEW

**Spec:** 17 (money is integer minor units; a single currency in the MVP — which currency and which
minor-unit exponent is spec 33 open decision 4), 29 (mandatory automated tests: money arithmetic)

**Invariants:** 1 (money is integer minor units; no float, no `parseFloat`, no `toFixed`), 7 (the UI
never does money arithmetic and never rounds — the formatter renders the value it is handed)

**Do:**

1. Create `src/lib/money/format.ts`. It is isomorphic like the rest of the directory: no
   `$lib/server/*`, no `$app/*`, no npm package. It **does not round and does not do arithmetic** —
   it renders the exact `Minor` value it is given (invariants 1 and 7). A value that needs rounding
   was already rounded once, by `roundToMinor`, before it got here.
2. Export the shape and the currency table, filled in from **T-03's recorded answer to open decision
   4**:
   ```ts
   export type MoneyFormat = { code: string; exponent: number };
   export const SUPPORTED_CURRENCIES: Record<string, MoneyFormat> = {
     /* exactly the code(s) T-03 recorded, e.g. SOS: { code: 'SOS', exponent: 2 } */
   };
   export function moneyFormatFor(code: string): MoneyFormat; // throws RangeError on an unknown code
   ```
   One currency in the MVP (spec 17), so this table has one entry. It exists rather than a bare
   constant so T-36's settings form can validate the owner's currency code against
   `Object.keys(SUPPORTED_CURRENCIES)` and cannot store a code this formatter is unable to render. If
   T-03 recorded no currency, **stop and ask** — do not invent one and do not fall back to `USD`.
3. Export the two formatters:
   ```ts
   export function formatAmount(amount: Minor, format: MoneyFormat): string; // "1,234.56", "−8.50"
   export function formatMoney(amount: Minor, format: MoneyFormat): string;  // "1,234.56 SOS"
   ```
   `format` is a **required parameter with no default** — a default would answer open decision 4
   silently. `formatMoney` appends a NO-BREAK SPACE (U+00A0) and the ISO code, so the code cannot wrap
   onto its own line; the code goes **after** the number so a column of amounts stays aligned on its
   digits and no per-currency symbol table is needed. Use `formatAmount` inside a column of money and
   `formatMoney` where a single amount stands alone.
4. Format by integer string surgery on the `bigint`, never by converting to a `number`: take the sign,
   take the absolute value, split on `10n ** BigInt(exponent)` into major and minor parts, left-pad the
   minor part to `exponent` digits, and group the major part in threes from the right. **No
   `Number()`, no `toFixed`, no `toLocaleString`, and no `Intl.NumberFormat` on the value** — every one
   of those routes an exact `bigint` through a float.
5. Separators: `.` for the decimal point and `,` for thousands, written as two named constants at the
   top of the file. Spec 17 and spec 33 say nothing about numeral formatting, so this is a presentation
   choice made by this task: it is the convention the rest of this repo's English-language UI already
   reads in, and it is one line to change because it is a constant rather than a literal buried in the
   loop. **Record the choice in the commit message.** If T-03's record names separators, use those
   instead.
6. `exponent === 0` renders no decimal point and no fractional digits at all — `formatAmount(minor(5n),
   { code: 'XYZ', exponent: 0 })` is `"5"`, not `"5."`.
7. The formatter owns the **sign**; the call site owns the **colour**. A negative renders with a
   leading U+2212 MINUS SIGN (`'−'`), not a U+002D hyphen, and never in accounting parentheses. The
   `--danger` colour on a negative is applied by the component rendering it (`text-danger`), because
   this module returns a string and must never return markup or a class name.
8. State the one screen rule in the file header so every UI task follows the same one: **money renders
   in `--font-mono` with `tabular-nums`, right-aligned** — in Tailwind, `font-mono tabular-nums
   text-right`. No Svelte component is added by this task; T-39's menu screen applies those utilities
   to the string this function returns.

**Tests:** **none of these carries the `MANDATORY (spec 29)` marker, and that is deliberate.** Spec
29's six areas are money arithmetic and rounding; tax in both modes; journal entries balance; one
posting rule per spec 24 event; offline retries never duplicating; and a permission check per POS API
route. Rendering a `bigint` as a string is none of them — this module does no arithmetic and no
rounding at all (step 1) — and marking it MANDATORY would dilute a marker the rest of this plan uses
to mean something specific. These tests are still **required**: they ship in the same commit as the
code, and `Done when:` does not pass without them.

- With `{ code: 'SOS', exponent: 2 }` (substitute T-03's recorded currency),
  `formatAmount(minor(0n), fmt) === '0.00'`,
  `formatAmount(minor(5n), fmt) === '0.05'` (below one major unit),
  `formatAmount(minor(850n), fmt) === '8.50'`,
  `formatAmount(minor(123456789n), fmt) === '1,234,567.89'` (a large, grouped value).
- `formatAmount(minor(-850n), fmt) === '−8.50'` — assert the escape, not a pasted glyph, so a hyphen
  sneaking in fails the test; and `formatAmount(minor(-5n), fmt) === '−0.05'`.
- `formatMoney(minor(850n), fmt) === '8.50 SOS'`.
- Round-trip property: for 500 generated amounts in `[−100_000_000n, 100_000_000n]`, stripping the
  group separator, replacing `'−'` with `'-'` and
  removing the decimal point from `formatAmount(...)` re-parses with `BigInt()` to **exactly** the
  input — the formatter never returns a value that reads back as a different number of minor units.
  The parser is local to the test file and is not exported: nothing in the application parses a
  formatted amount, because form input arrives as digits and is validated server-side.
- `formatAmount(minor(5n), { code: 'XYZ', exponent: 0 }) === '5'` and
  `formatAmount(minor(-5n), { code: 'XYZ', exponent: 0 }) === '−5'`.
- `moneyFormatFor('ZZZ')` throws `RangeError`; `moneyFormatFor` on the recorded code returns its entry.

**Done when:** `pnpm exec vitest run --project unit src/lib/money/format.test.ts` passes,
`pnpm check && pnpm lint` are clean, and
`grep -nE 'Number\(|toFixed|toLocaleString|Intl\.' src/lib/money/format.ts` prints nothing.

**Watch out:** `String(-850n)` is `'-850'` with a U+002D hyphen — take the sign from
`amount < 0n` and build the string from the absolute value, or the hyphen survives into the output and
the U+2212 assertion fails in a way that looks like a font problem. `(-850n) % 100n` is `-50n` in
JavaScript, so compute the fractional part from the absolute value or a negative amount renders with a
stray sign inside its decimals. Padding uses `padStart` on the string form of the fractional `bigint`,
never arithmetic.

---

### T-36 — Add the tax-mode and currency settings columns and surface them in settings

**Needs:** T-03, T-34, T-35

**This task is two independently verifiable halves, and they are committed separately. The seam is
the migration.** **Part A** is the three columns, their CHECK constraints, the generated migration
and the constraint integration test. **Part B** is the `restaurants` domain validation, the settings
route, the two Svelte pages and the e2e journey. Run Part A's `Done when:` and commit it before
starting Part B. The split is not tidiness: a migration that has run **cannot be hand-edited back**
(invariant 2), so if this work is abandoned it must be abandoned at the seam. Part A alone leaves
three nullable columns that nothing yet writes — complete and harmless on its own terms. A Part A
stopped halfway is neither. The task index in `tasks/pos-access-and-menu/00-overview.md` fixes this
as **one** ID, so these are two commits under T-36 and not two task IDs: write `T-36 (part A)` and
`T-36 (part B)` in the commit subjects.

**Files:**

**Part A — schema, constraints, migration:**

- `src/lib/server/db/schema/restaurant-settings.ts` — EDIT (read the "WHAT MUST NOT BE ADDED HERE, AND
  WHY" comment first, then add the three columns beside `timeZone` and the constraints in the table's
  second argument, which the file does not have yet)
- `src/lib/server/db/migrations/00NN_<drizzle-generated-name>.sql` — NEW (produced by
  `pnpm db:generate`; never hand-named, and never a `.sql` file dropped into the folder by hand — an
  unregistered file is silently never applied)
- `src/lib/server/db/schema-guards/constraints.integration.test.ts` — EDIT (add a
  `describe('restaurant_settings constraints')` block beside the existing `users constraints` block)
- `src/lib/server/db/schema-guards/schema.test.ts` — EDIT, **only if step 2's check actually fails.**
  This is where T-04 wrote the money-column predicate, its naming-convention comment block and the
  empty `MONEY_NAME_EXEMPT` list. T-04's own fixture cases assert that `integer('tax_rate_bp')` and
  `text('tax_mode')` are **not** flagged, so the expected outcome is that this file needs no edit at
  all; step 2 says what to do if the guard disagrees. T-04 is a genuine prerequisite of that step even
  though `Needs:` above does not name it — that line is fixed by the task index, which has not been
  corrected.

**Part B — domain, route, UI, e2e:**

- `src/lib/server/restaurants/index.ts` — EDIT (`RestaurantWithSettings` and the select inside
  `getRestaurantWithSettings`; `SettingsChanges`, `UpdateSettingsResult` and the diff block inside
  `updateSettings`; the `missing` list inside `settingsComplete`)
- `src/routes/(dashboard)/settings/+page.server.ts` — EDIT (`settingsSchema`, the `load` return, the
  `safeParse` input in the default action, and the `result.reason` mapping)
- `src/routes/(dashboard)/settings/+page.svelte` — EDIT (three controls in the form, replacing the
  `NO fields for tax mode…` comment block)
- `src/routes/(dashboard)/dashboard/+page.svelte` — EDIT (the `Restaurant settings` step's `detail`
  string for the complete case, currently `'Name and time zone are set.'`)
- `src/lib/server/restaurants/settings.integration.test.ts` — EDIT (the `settingsComplete` describe
  block, whose `is complete straight after registration` case — **already rewritten once by T-08** —
  changes again; and a new `updateSettings` case)
- `src/routes/(dashboard)/device/device.integration.test.ts` — EDIT (**this is the second
  file that deep-equals `settingsComplete()`, and it is easy to miss.** T-29's two `setIdleLock`
  cases assert the list on both sides of a save, against the two-entry reality of Phase 5; step 6
  makes the list four long, so both assertions move. **Update them, never shorten them** — the test
  bullet below gives the two exact arrays.)
- `e2e/auth.spec.ts` — EDIT (**step 6's settings form only.** Step 3's `not started` count does
  **not** change in this task; the test bullet below says why, and says not to "fix" it.)

**Spec:** 17 (tax mode is a restaurant setting read at calculation time; one currency in the MVP), 29
(mandatory automated tests: tax calculation in both tax modes), 33 (open decision 3 — tax rules; open
decision 4 — payment methods and currencies)

**Invariants:** 1 (money is integer minor units; a tax **rate** is integer basis points, never a
float), 7 (tax mode is a setting, never hardcoded), 8 (permissions enforced server-side on every route
and every form action, reads included, returning `403`), 10 (the audit row is written in the same
transaction as the action), 11 (timestamps are `timestamptz`)

**Do — Part A (schema, constraints, migration):**

1. **Confirm T-03 recorded open decisions 3 and 4 before touching the schema.** Look in `CLAUDE.md`'s
   "Decisions already made (NOT open — do not re-litigate)" section and in the **Open decision 3 (tax
   rules)** and **Open decision 4 (currency)** bullets under "## Assumptions" in
   `tasks/pos-access-and-menu/00-overview.md`, which read `— UNANSWERED.` until T-03 rewrites them.
   The header comment in `src/lib/server/db/schema/restaurant-settings.ts` forbids adding tax mode,
   tax rate or currency "with a sensible default", and a migration that has run cannot be hand-edited
   back (invariant 2). If T-03's record is missing, stop and ask.
2. Add three columns to `restaurantSettings`, **all nullable, none with a column `DEFAULT`** — a
   `DEFAULT` answers the open decision for every restaurant already registered, and the owner who never
   visits this page would open their first POS session with a tax mode nobody chose:
   ```ts
   taxMode: text('tax_mode'),
   taxRateBp: integer('tax_rate_bp'),
   currencyCode: text('currency_code'),
   ```
   `tax_rate_bp` is `integer` and **not** `bigint`: it is a rate in basis points (`825` = 8.25%), not
   an amount of money, and money columns are the ones carrying minor units (the `_minor` suffix). Do
   not rename it to `_minor` and do not widen it to `bigint` to satisfy T-04's guard.
   **Then check the guard rather than assuming either way:** run `pnpm test:unit` and read the result
   of T-04's `numericColumnOffenders` assertion in
   `src/lib/server/db/schema-guards/schema.test.ts`. The expected outcome is **green with no edit**,
   because T-04's `_bp` rule requires exactly `integer` for a name ending `_bp`, its money-name rule
   exempts names ending `_bp`, and its own fixtures assert `integer('tax_rate_bp')` and
   `text('tax_mode')` are not flagged (`currency_code` matches none of its name patterns). If the
   guard **does** flag one of these three columns, the fix is in that test file and nowhere else:
   tighten the money-name predicate to the `_minor` suffix, keep `MONEY_NAME_EXEMPT` empty, and say
   in the commit message that T-04's predicate was narrowed and why. Never add a column to
   `MONEY_NAME_EXEMPT` to get past it, and never change the column's type to please a test.
   Import `integer` and `check` from `drizzle-orm/pg-core` and `sql` from `drizzle-orm`.
3. Add the table's second argument with three CHECK constraints, each written so a NULL passes (the
   columns are legitimately unset until the owner chooses):
   ```ts
   (table) => [
     check('restaurant_settings_tax_mode_valid',
       sql`${table.taxMode} is null or ${table.taxMode} in ('exclusive', 'inclusive')`),
     check('restaurant_settings_tax_rate_bp_range',
       sql`${table.taxRateBp} is null or (${table.taxRateBp} >= 0 and ${table.taxRateBp} <= 10000)`),
     check('restaurant_settings_currency_code_format',
       sql`${table.currencyCode} is null or ${table.currencyCode} ~ '^[A-Z]{3}$'`)
   ]
   ```
   The two tax-mode literals are the two entries of `TAX_MODES` in `src/lib/money/tax.ts`; keep the
   spellings identical. Do **not** import `$lib/money/tax` into this schema file — `drizzle-kit`
   loads the files in `src/lib/server/db/schema` directly, outside Vite, and cannot resolve the `$lib`
   alias, so the import would break `pnpm db:generate`.
4. `pnpm db:generate`, then **read the generated SQL**. It must contain three
   `ALTER TABLE "restaurant_settings" ADD COLUMN` statements and three
   `ALTER TABLE "restaurant_settings" ADD CONSTRAINT … CHECK …` statements. If drizzle-kit emitted the
   columns but not the checks, add them with `pnpm exec drizzle-kit generate --custom --name=…` as a
   second, hand-written migration — the only supported route, because it registers the file in
   `migrations/meta/_journal.json`. Then `pnpm db:migrate` (it runs `db:backup` first, automatically).
   Never hand-edit a migration that has already run.

**Tests — Part A:**

- `constraints.integration.test.ts`: `update restaurant_settings set tax_mode = 'included'` is rejected
  with `error.constraint === 'restaurant_settings_tax_mode_valid'`; `tax_rate_bp = -1` and
  `tax_rate_bp = 10001` are rejected with `restaurant_settings_tax_rate_bp_range`;
  `currency_code = 'sos'` is rejected with `restaurant_settings_currency_code_format`; and setting all
  three to `NULL` succeeds.
- In the same new `describe('restaurant_settings constraints')` block, because this is the file where
  those two literals are asserted against the real database: `TAX_MODES` imported from
  `$lib/money/tax` deep-equals `['exclusive', 'inclusive']`, pinning it against the two literals
  written into the CHECK constraint, which no type system connects.

**Done when — Part A:** `pnpm db:migrate` applies cleanly,
`pnpm exec vitest run --project integration src/lib/server/db/schema-guards/constraints.integration.test.ts`
passes, `pnpm test:unit` passes (T-04's schema guard included, unedited),
`pnpm check && pnpm lint` are clean, `pnpm test:e2e` still passes **unchanged** — Part A adds columns
nothing reads yet, so no assertion anywhere should move — and
`psql "$MIGRATE_DATABASE_URL" -c "\d restaurant_settings"` shows `tax_mode`, `tax_rate_bp` and
`currency_code` all nullable with **no** default and the three named CHECK constraints listed.
**Commit here before starting Part B.**

**Do — Part B (domain, route, UI, e2e):**

5. In `src/lib/server/restaurants/index.ts`: add `taxMode: TaxMode | null`, `taxRateBp: number | null`
   and `currencyCode: string | null` to `RestaurantWithSettings` and to the `select` in
   `getRestaurantWithSettings`. Extend `SettingsChanges` with the same three optional fields, and
   inside `updateSettings` validate **only fields the form actually submitted** (the existing
   time-zone comment explains why) — `taxMode` must be in `TAX_MODES` from `$lib/money/tax`,
   `taxRateBp` must satisfy `Number.isSafeInteger` and `0 <= bp <= 10000`, `currencyCode` must be a key
   of `SUPPORTED_CURRENCIES` from `$lib/money/format`. Add `'invalid_tax_mode' | 'invalid_tax_rate' |
   'invalid_currency'` to the `UpdateSettingsResult` failure reasons. Changed values go into the same
   `diff` object, so the existing `writeAudit(tx, { event: 'settings.updated', details: { changes:
   diff } })` call carries the old and new values **in the same transaction as the write** (invariant
   10) with no change to `src/lib/server/audit/events.ts`, whose details type is already
   `{ changes: Record<string, { old: unknown; new: unknown }> }`. T-08 widened the `if (diff.timeZone
   || diff.posIdleLockSeconds)` condition and the `.set({...})` spread around it; widen both again
   for the three new fields rather than adding a second update statement.
6. Extend `settingsComplete` to push `'tax mode'`, `'tax rate'` and `'currency'` onto `missing` when
   the respective column is `null`. This is the documented extension point and the reason it exists.
   **Push them after T-08's `'POS idle lock'` check, not before it, and do not touch that check.**
   The function's order of pushes is the order of the array the tests deep-equal, so straight after
   registration `missing` reads `['POS idle lock', 'tax mode', 'tax rate', 'currency']` — time zone is
   set at registration, the other four are not. A freshly registered restaurant was already
   legitimately **incomplete** after T-08; this task makes it incomplete for three more reasons, which
   is what gates the first POS session on a tax mode somebody actually chose.
7. `src/routes/(dashboard)/settings/+page.server.ts`: keep `requirePermission(event, 'admin.settings')`
   on **both** the `load` and the default action — a form action is a separately reachable POST
   endpoint and returns `403` on its own (invariant 8). Return the three current values from `load`.
   Extend `settingsSchema` with three **optional** fields —
   `taxMode: z.enum(TAX_MODES).optional()`, `taxRateBp: z.coerce.number().int().min(0).max(10000).optional()`,
   `currencyCode: z.string().trim().toUpperCase().refine((c) => c in SUPPORTED_CURRENCIES).optional()`
   — and map a blank submitted string to `undefined` **before** parsing, so a blank field means "not
   submitted, leave it alone" rather than "clear it". Map each new failure reason to its own message
   ("Choose a tax mode of exclusive or inclusive.", "The tax rate is whole basis points — 825 means
   8.25%.", "That currency code is not one this system can format."). Never read `restaurantId` from
   the form body.
8. `src/routes/(dashboard)/settings/+page.svelte`: replace the `NO fields for tax mode…` comment with
   three `Field` controls, **not** marked `required` (the columns are nullable and the owner may save a
   rename without answering) — `Tax mode` with `list="tax-modes"` and a `<datalist>` of `exclusive` and
   `inclusive`, mirroring the existing time-zone control exactly, because `Field` renders an `<input>`
   and has no select support and adding one is a separate decision; `Tax rate (basis points)` with a
   hint reading `825 means 8.25%. Whole basis points only.`; and `Currency code` with a hint naming the
   supported code. Keep exactly one `role="alert"` on the page. Add **no** idle-lock control here — see
   Watch out. In `src/routes/(dashboard)/dashboard/+page.svelte`, change the completed-step detail from
   `'Name and time zone are set.'` to `'Name, time zone, tax and currency are set.'`.

**Tests — Part B:**

- MANDATORY (spec 29 — tax in BOTH modes), integration in `settings.integration.test.ts`: a restaurant
  saved with `taxMode: 'exclusive', taxRateBp: 825` and a second saved with `taxMode: 'inclusive',
  taxRateBp: 825`, both read back through `getRestaurantWithSettings`, feed `taxOnLine(minor(1000n),
  row.taxRateBp!, row.taxMode!)` and produce the two different, asserted `LineTax` results — the mode
  genuinely travels from the database into the calculation, and nothing in the path defaults it.
- `settings.integration.test.ts`: `settingsComplete` straight after registration now returns
  `{ complete: false, missing: ['POS idle lock', 'tax mode', 'tax rate', 'currency'] }` — **update the
  existing `is complete straight after registration` case, do not delete it.** T-08 already rewrote
  that case once, from `{ complete: true, missing: [] }` to
  `{ complete: false, missing: ['POS idle lock'] }`; this task **appends** to that list. Step 6's
  pushes therefore go after T-08's idle-lock check, so the array order matches this deep-equal.
  **Do not delete T-08's idle-lock check to make the assertion shorter** — that silently reopens open
  decision 6, which T-03 answered.
- `settings.integration.test.ts`, the clearing case: a single `updateSettings` call setting
  `taxMode`, `taxRateBp`, `currencyCode` **and** `posIdleLockSeconds: 120` (T-08's field) is followed
  by `settingsComplete` → `{ complete: true, missing: [] }`. All four are required: setting only the
  three new columns leaves `{ complete: false, missing: ['POS idle lock'] }`, so an assertion of
  `complete: true` that omits the idle lock is a test that cannot pass.
- `device.integration.test.ts`: T-29's `setIdleLock` cases deep-equal `settingsComplete()` on
  both sides of a save, and both arrays grow here. After a successful save of
  `posIdleLockSeconds: 120` the result becomes
  `{ complete: false, missing: ['tax mode', 'tax rate', 'currency'] }` — the idle lock has left the
  list and the three new settings have not been chosen on that page; after a rejected `29` or `1801`
  it becomes `{ complete: false, missing: ['POS idle lock', 'tax mode', 'tax rate', 'currency'] }`.
  **Update both deep-equals rather than deleting either case, and do not drop the idle-lock entry to
  make the second one shorter** — the same rule as the bullet above. T-29's
  `{ complete: true, missing: [] }` after a successful save is the assertion this task invalidates:
  three columns that page does not write are now required too, so leaving it as it stands leaves a
  test this task has made unpassable, and `Done when — Part B`'s `pnpm test:integration` is where it
  surfaces.
- `settings.integration.test.ts`: `updateSettings` with `taxMode: 'exclusive'` writes exactly one
  `audit_log` row whose `details.changes.taxMode` is `{ old: null, new: 'exclusive' }`; with
  `taxRateBp: 8.25` it returns `{ ok: false, reason: 'invalid_tax_rate' }` and writes **nothing** —
  neither the column nor an audit row.
- `e2e/auth.spec.ts`: **step 3's `not started` count does not change in this task. Leave that
  assertion exactly as you find it.** T-08 already moved it — from `5` to `6` — for precisely the
  reason that would otherwise be given here: the settings step stopped being done at registration the
  moment the idle lock joined `settingsComplete`'s list. This task makes that step *more* incomplete,
  not newly incomplete, so the number of steps rendering `not started` is unchanged. Read the number
  before and after and confirm it is the same; if it moved, something other than this task moved it.
  What **does** change is **step 6**: after filling `Restaurant name`, also fill `Tax mode`,
  `Tax rate (basis points)` and `Currency code`, save, and assert `Settings saved.` as the existing
  step already does. Then return to `/dashboard` and assert the settings step's detail line now reads
  `Still needed: POS idle lock.` — the three new entries have gone from it and the idle lock has not.
  **Do not assert that the settings step flips to done, and do not assert the count drops.**
  `e2e/auth.spec.ts` never visits `/device`, which is where the idle lock is saved (see Watch
  out), so at the end of this journey it is still unset: the step legitimately stays `not started`
  and the count legitimately stays where T-08 left it.

**Done when — Part B:** `pnpm test:integration` and `pnpm test:unit` pass, `pnpm test:e2e` passes,
`pnpm check && pnpm lint` are clean, and a manual save on `/settings` with a tax mode, a rate and a
currency writes exactly one `audit_log` row carrying all three in `details.changes`.

**Watch out:** open decision 3 also covers **whether a tax rate is per-item or per-restaurant**. This
task puts one rate on the restaurant. If T-03 recorded a per-item answer, `tax_rate_bp` here is the
default a menu item inherits when it carries no rate of its own and T-37 adds the per-item override —
if T-03 recorded per-item **only**, stop and ask before writing this column rather than encoding a
shape nobody chose. PostgreSQL silently **rounds** a decimal into an `integer` column, so
`insert … tax_rate_bp = 8.25` stores `8` without complaint: the zod `.int()` on the form and the
`Number.isSafeInteger` guard in `updateSettings` are the real defences, not the column type.

**The idle lock is written by T-29's `setIdleLock` action on `/device`, not by the `/settings`
form this task edits — do not add a fourth control here.** T-08 added the column and taught
`updateSettings` to validate it; T-29 renders the `Auto-lock after (seconds)` field beside the device
it protects and posts it through `updateSettings()`. Adding a fourth control to this form would put
two tasks' worth of change behind one review and give the owner two screens that set the same
setting. The form this task edits gains tax mode, tax rate and currency, and nothing else.
`e2e/auth.spec.ts` never visits `/device`, so at the end of that journey the idle lock is still
unset: after Part B the checklist's settings step there is still `not started` with
`Still needed: POS idle lock.`, which is exactly why the e2e bullet above forbids asserting
otherwise.

Every column here stays nullable; `restaurant_settings` has no `NOT NULL` money or tax column in this
plan. Adding required settings flips `settingsComplete` to `false` for every existing restaurant,
which is intended — and the checklist detail line moves with it, which is why every
`settingsComplete` assertion above is a deep-equal on an ordered array rather than a `toContain`.
