# Phase 2 (domain) — quantities, costing and consumption (T-09 … T-12)

> Part of tasks/inventory-cogs/ — read 00-overview.md first. Depends on: Phase 0 (T-02).

Money arithmetic lives in the isomorphic `src/lib/money/` (invariants 1 and 7), and quantity arithmetic
lives beside it because every quantity ends up multiplied into money. A quantity is a bigint of
**thousandths** of a base unit (`Qty`), parsed once from pg's numeric string. `roundToMinor` in
`src/lib/money/index.ts` is THE rounding function for money, for micro-costs and for quantities alike;
there is no second rounding helper anywhere, and a result that is not money is unwrapped from its
`Minor` brand with `toBigInt` and re-branded. The costing rules are the design's answer to the risk
panel's first BLOCKER — cents stranded in Inventory, and a negative average that silently stops COGS —
and they are specified verbatim in the overview's "Shared contracts → Costing". Implement them exactly;
do not "simplify" a rule back to value ÷ quantity. Nothing in these files may contain `Number(`,
`parseFloat`, `toFixed`, `Math.` or a float literal, and each test file reads its source to prove it.
The files in `src/lib/money/` import only siblings (`./index`, `./tax`, `./quantity`) and nothing else,
because the POS and the server import the same module.

Every expected number below was worked by hand with bigint arithmetic and half-up-away-from-zero
rounding; a test that disagrees with one of them means the code is wrong, not the number.

### T-09 — `src/lib/money/quantity.ts`: quantities as bigint thousandths

**Needs:** T-02
**Files:**
- `src/lib/money/quantity.ts` — NEW
- `src/lib/money/quantity.test.ts` — NEW
**Spec:** 17 ("Ingredient quantities use fixed-precision decimals (e.g. numeric(12,3))"; "All money
arithmetic goes through one shared module"), 15 (base units and purchase-unit conversions)
**Invariants:** 1 (no float anywhere near money; quantities are the numeric(12,3) exception, carried
here as exact integers), 7 (one rounding function, `roundToMinor`)

**Do:**
1. Implement the overview's "Shared contracts → Quantities" exactly: `Qty` (a branded bigint),
   `QTY_SCALE = 1000n`, `QTY_MAX = 999_999_999_999n`, `qty()`, `parseQty`, `formatQty`, `addQty`,
   `subQty`, `negQty`, `sumQty`, `mulQty`, `qtyExact`. The file imports only `./index`
   (`roundToMinor`, `toBigInt`, `exact`, `type Exact`, `type RoundingRule`).
2. `qty(value: bigint)` is the ONLY constructor: it throws `TypeError` for a non-bigint and
   `RangeError` outside `-QTY_MAX … QTY_MAX` (the numeric(12,3) bound).
3. `parseQty(text)` trims surrounding whitespace, then accepts `^-?\d+(\.\d{1,3})?$` only; anything
   else (a comma, an exponent, four decimals, a space inside, an empty string, a lone `-`) throws a
   `TypeError` whose message states the accepted shape ("a quantity is digits with at most three
   decimals, e.g. 2.5 or 0.030"). Build the bigint from the digit strings (whole × 1000 + the fraction
   padded to three digits), never through a number.
4. `formatQty(q)` always prints three decimals, a leading `-` for negatives and `0` before the point:
   `2500n` → `'2.500'`, `-30n` → `'-0.030'`, `0n` → `'0.000'`. It is used for database writes and for
   display.
5. `mulQty(a, b, rule)` = `qty(toBigInt(roundToMinor(exact(a * b, 1000n), rule)))` — one rounding.
6. Header comment: why thousandths (numeric(12,3) holds exactly three decimals), why pg's string is
   parsed once here and nowhere else, why the money rounding function is reused (invariant 7 forbids a
   second one).

**Tests:** MANDATORY (spec 29 — money arithmetic and rounding: quantities feed every cost)
- `parseQty('2')` → `2000n`; `'2.5'` → `2500n`; `'0.030'` → `30n`; `'-30.000'` → `-30000n`;
  `'  7.25  '` → `7250n`.
- `parseQty` throws for `'1,5'`, `'1e3'`, `'1.2345'`, `''`, `' '`, `'-'`, `'1 000'`.
- `formatQty(2500n)` → `'2.500'`; `formatQty(-30n)` → `'-0.030'`; `formatQty(0n)` → `'0.000'`.
- Round trip `parseQty(formatQty(q)) === q` for 1,000 seeded values across ±QTY_MAX (use a small
  deterministic LCG in the test file).
- `mulQty(2500n, 1000000n, ROUNDING_RULE)` → `2500000n` (2.5 × 1000.000).
- `mulQty(333n, 333n, ROUNDING_RULE)` → `111n` (0.110889 rounds half-up to 0.111).
- `qty(QTY_MAX + 1n)` and `qty(-QTY_MAX - 1n)` throw `RangeError`.
- Source tripwire: read `src/lib/money/quantity.ts` with `readFileSync` and assert it contains none of
  `Number(`, `parseFloat`, `toFixed`, `Math.`, and no float literal (`/\b\d+\.\d+\b/` outside comments —
  strip `//` and `/* */` comments before matching).

**Done when:** `pnpm test:unit src/lib/money/quantity.test.ts` passes and `pnpm check` passes.

**Watch out:** `BigInt('2.5')` throws; split on the point and build the value from the two digit
strings. `roundToMinor` requires the rule argument — pass `ROUNDING_RULE` at call sites, never a literal.

### T-10 — `src/lib/money/costing.ts`: the value-conserving movement rules and their property test

**Needs:** T-09
**Files:**
- `src/lib/money/costing.ts` — NEW
- `src/lib/money/costing.test.ts` — NEW
**Spec:** 16 (weighted average: 10 kg at $5.00 + 10 kg at $6.00 → $5.50/kg; "Recipe costs, and therefore
the COGS of each sale, use the current average cost"), 15 (negative stock is allowed and flagged), 22
(reversing entries), 33 (decision 7: weighted average)
**Invariants:** 6 (inventory is a ledger — the value moved by a movement is exactly the change in stock
value, so the ledger and 1200 can never drift), 1 (bigint only), 7 (`roundToMinor` is the only rounding)

**Do:**
1. Export `MICRO = 1_000_000n`, `type StockState = { qty: Qty; value: Minor; avgMicro: bigint }`,
   `type Applied = { state: StockState; costMinor: Minor; revaluationMinor: Minor }`.
2. `valueAt(q, avgMicro, rule)`: `0n` when `q === 0n`, else `roundToMinor(exact(q * avgMicro, 1000n *
   MICRO), rule)`. Doc comment: the value of a quantity at an average, the one place a stock value is
   rounded.
3. `unitCostMicro(value, q, rule)`: throws `RangeError` unless `q > 0n`; returns
   `toBigInt(roundToMinor(exact(value * 1000n * MICRO, q), rule))`.
4. `applyInbound(s, inQty, costMinor, rule)` — deliveries and opening stock. Throws `TypeError` unless
   `inQty > 0n` and `costMinor >= 0n`. `costMinor` of the result is the input cost.
   - When `s.qty > 0n`: `qty' = s.qty + in`, `value' = s.value + cost`,
     `avg' = unitCostMicro(value', qty')`, `revaluation = 0n`.
   - When `s.qty <= 0n` (zero or negative stock): `avg' = toBigInt(roundToMinor(exact(cost * 1000n *
     MICRO, in), rule))` (the delivery's own unit cost), `qty' = s.qty + in`,
     `value' = qty' === 0n ? 0n : roundToMinor(exact(qty' * cost, in), rule)` (full precision, one
     rounding), `revaluation = value' − (s.value + cost)`.
   Doc comment: why a delivery into negative stock does not average (a negative weight has no meaning;
   the goods already sold are re-valued at this delivery's price and the gap posts to 5000 — assumption 2).
5. `applyAtAverage(s, moveQty, direction, rule)` — throws `TypeError` unless `moveQty > 0n`.
   - `'out'` (sale consumption, waste, count shortfall, comp): `qty' = s.qty − move`,
     `target = valueAt(qty', s.avgMicro)`, `costMinor = min(0n, target − s.value)`,
     `value' = s.value + costMinor`, `avg' = s.avgMicro`, `revaluation = 0n`.
   - `'in'` (count surplus): `qty' = s.qty + move`, `target = valueAt(qty', s.avgMicro)`,
     `costMinor = max(0n, target − s.value)`, `value' = s.value + costMinor`, `avg' = s.avgMicro`,
     `revaluation = 0n`.
   Doc comment: the cost is the CHANGE in stock value, so when the quantity reaches zero the value
   reaches zero with it — the last gram carries the last cent (the panel's stranded-value BLOCKER).
6. `applyReversal(s, outQty, originalCostMinor, rule)` — delivery reversal at the ORIGINAL line cost.
   Throws `TypeError` unless `outQty > 0n` and `originalCostMinor >= 0n`. `costMinor = −cost`,
   `qty' = s.qty − out`, `raw = s.value − cost`.
   - When `qty' > 0n` and `raw > 0n`: `avg' = unitCostMicro(raw, qty')`, `value' = raw`,
     `revaluation = 0n`.
   - Otherwise: `avg' = s.avgMicro`, `value' = valueAt(qty', s.avgMicro)`, `revaluation = value' − raw`.
   Doc comment: why the average is never recomputed from a non-positive quantity or value (the panel's
   negative-average finding: a negative average would give every later sale a positive cost and
   `pay.ts` would skip its COGS entry).
7. Every function returns a fresh `StockState` and never mutates its input. `min` and `max` are local
   bigint helpers, not `Math`.

**Tests:** MANDATORY (spec 29 — money arithmetic and rounding). Quantities are thousandths (10,000.000 g
is `10000000n`); values are cents; averages are micro-cents per base unit.
- (a) Spec 16 in grams: from `{ qty: 10000000n, value: 5000n, avgMicro: 500000n }`,
  `applyInbound(…, 10000000n, 6000n)` → `{ qty: 20000000n, value: 11000n, avgMicro: 550000n }`,
  revaluation `0n`. Then `applyAtAverage(…, 150000n, 'out')` → `valueAt(19850000n, 550000n)` is 10,917.5,
  rounded to `10918n`; so `costMinor === -82n`, value `10918n`, avg unchanged `550000n`.
- (b) Three buns bought for 100: from `{0n, 0n, 0n}`, `applyInbound(…, 3000n, 100n)` → avg `33333333n`,
  value `100n`, revaluation `0n`; three `'out'` movements of `1000n` → costs `-33n`, `-34n`, `-33n`, final
  value `0n` at quantity `0n`.
- (c) Sugar, 5,000 g for 200: from `{0n,0n,0n}` inbound `5000000n` at `200n` → avg `40000n`; 2,500 `'out'`
  movements of `2000n` (2 g) → every cost `<= 0n`, the final state `{0n, 0n, 40000n}`, Σ costs `-200n`.
- (d) Negative stock: from `{0n,0n,0n}`, `'out'` `30000000n` → cost `0n`, state `{-30000000n, 0n, 0n}`;
  then `applyInbound(…, 50000000n, 25000n)` → avg `500000n`, qty `20000000n`, value `10000n`, revaluation
  `-15000n` (10,000 − (0 + 25,000)).
- (e) Reversal after consumption: from `{20000000n, 2000n, 100000n}`, inbound `5000000n` at `5000n` →
  `{25000000n, 7000n, 280000n}`; `'out'` `15000000n` → value `2800n`, cost `-4200n`; then
  `applyReversal(…, 5000000n, 5000n)` → raw is `-2200n`, so avg stays `280000n`, value `1400n`,
  revaluation `3600n`, costMinor `-5000n`, qty `5000000n`.
- (f) Reversal into otherwise-empty stock: from `{0n,0n,0n}` inbound `10000000n` at `6000n` (avg
  `600000n`, value `6000n`), then `applyReversal(…, 10000000n, 6000n)` → `{0n, 0n, 600000n}`, revaluation
  `0n`, no throw.
- (g) Count surplus from negative stock: from `{-10000000n, -5000n, 500000n}`, `applyAtAverage(…,
  15000000n, 'in')` → target `2500n`, costMinor `7500n`, state `{5000000n, 2500n, 500000n}`.
- Guards: `applyInbound` with `0n` quantity, `applyAtAverage` with `-1n`, `applyReversal` with a negative
  cost each throw `TypeError`; `unitCostMicro(100n, 0n)` throws `RangeError`.
- Property test (seeded LCG in the file, 5,000 sequences of 1–40 steps, each step one of inbound, out,
  in or reversal, quantities `1n`–`50000000n`, costs `0n`–`100000n`, starting from `{0n,0n,0n}`), asserting
  after EVERY step: `avgMicro >= 0n`; `qty === 0n` ⇒ `value === 0n`; `qty > 0n` ⇒ `value >= 0n`;
  `value' − value === costMinor + revaluationMinor`; an `'out'` step never has `costMinor > 0n`; an `'in'`
  step never has `costMinor < 0n`; every field is a `bigint`.
- Source tripwire as in T-09.

**Done when:** `pnpm test:unit src/lib/money/costing.test.ts` passes and `pnpm check` passes.

**Watch out:** never recompute the average from a non-positive quantity or a non-positive value. Never
round twice inside one rule: `valueAt` and `unitCostMicro` each round once, and the rules call each at
most once per result field.

### T-11 — Recipe cost, dish margin and extended cost

**Needs:** T-10
**Files:**
- `src/lib/money/costing.ts` — EXTEND (created by T-10; add `extendCost`, `recipeCostExact` and
  `dishMargin` after the movement rules. Do not rewrite the file)
- `src/lib/money/costing.test.ts` — EXTEND (created by T-10; add a new `describe` block)
**Spec:** 16 (recipe cost at the current average; the burger example), 17 (tax in both modes; round
once), 25 (gross profit = net sales − COGS)
**Invariants:** 7 (one rounding function; the cost and the net price are each rounded once), 1 (bigint
only)

**Do:**
1. `extendCost(unitQty: Qty, unitCostMinor: Minor, rule): Minor` =
   `roundToMinor(exact(unitQty * unitCostMinor, 1000n), rule)` — a quantity of purchase units times a
   cost per purchase unit (opening stock, T-23). Throws `TypeError` for a negative input.
2. `recipeCostExact(lines: readonly { qty: Qty; avgMicro: bigint }[]): Exact` = the exact sum of
   `exact(qty * avgMicro, 1000n * MICRO)` over the lines, using `sumExact`; no rounding.
3. `dishMargin({ priceMinor, taxRateBp, taxMode, costExact }, rule)` returns
   `{ costMinor, netPriceMinor, marginMinor }` where `costMinor = roundToMinor(costExact, rule)`,
   `netPriceMinor = roundToMinor(taxOnLine(priceMinor, taxRateBp, taxMode).net, rule)` and
   `marginMinor = netPriceMinor − costMinor` (a subtraction, so the three figures the menu page shows
   always add up). It imports `taxOnLine` and `type TaxMode` from `./tax`. An unset tax mode throws, as
   `taxOnLine` already does; callers without a mode show the cost only.

**Tests:** MANDATORY (spec 29 — tax calculated in both modes, for the margin; money arithmetic and
rounding)
- `extendCost(2500n, 550n, ROUNDING_RULE)` → `1375n` (2.5 kg at $5.50/kg).
- `extendCost(333n, 100n, ROUNDING_RULE)` → `33n` (33.3 rounds down).
- The burger: `recipeCostExact([{ qty: 150000n, avgMicro: 550000n }, { qty: 1000n, avgMicro: 25000000n },
  { qty: 1000n, avgMicro: 12000000n }])` equals the exact 119.5 (82.5 + 25 + 12; assert with
  `exactEquals(…, exact(239n, 2n))`).
- `dishMargin({ priceMinor: 800n, taxRateBp: 1000, taxMode: 'exclusive', costExact: <the burger> })` →
  `{ costMinor: 120n, netPriceMinor: 800n, marginMinor: 680n }`.
- The same with `priceMinor: 880n`, `taxMode: 'inclusive'` → net `800n` (880 × 10000 / 11000), cost
  `120n`, margin `680n`.
- `priceMinor: 999n`, `taxRateBp: 2000`, `taxMode: 'inclusive'` → net 832.5 rounds to `833n`, margin
  `713n`.
- The average display rule of the overview: `valueAt(qty(1000000n), 550000n)` (one kilogram of an
  ingredient whose base unit is grams) → `550n`, i.e. $5.50 per kg.

**Done when:** `pnpm test:unit src/lib/money/costing.test.ts` passes.

**Watch out:** the margin is never rounded on its own — it is the difference of two rounded figures.
`taxOnLine` expects the rate as a JavaScript integer number of basis points (its existing contract);
that number is a rate, not money.

### T-12 — `aggregateConsumption`: recipes × sale lines with modifier deltas clamped at zero

**Needs:** T-09
**Files:**
- `src/lib/server/inventory/consumption.ts` — NEW
- `src/lib/server/inventory/consumption.test.ts` — NEW (unit project; no database)
**Spec:** 15 (recipes × quantity; "Burger + Extra Cheese → Cheese +1"; "Burger – No Tomato → Tomato
−30g"), 13 ("Deduct Inventory — recipes × quantity, incl. modifiers")
**Invariants:** 6 (sales are never blocked; a modifier can never create stock), 4 (this pure function is
called inside the payment transaction by T-19 and must not throw for business reasons)

**Do:**
1. Export `type RecipeIndex = { items: Map<string, Map<string, Qty>>; modifiers: Map<string, Map<string,
   Qty>> }` — owner id → ingredient id → quantity in base units (modifier quantities may be negative).
2. Export `aggregateConsumption(lines: readonly SaleLine[], recipes: RecipeIndex): Map<string, Qty>`.
   `SaleLine` comes from `src/lib/sync-ops` (created by tasks/pos-sales T-03); import it as a type.
3. For each sale line: collect the ingredient ids that appear in the item's recipe or in any chosen
   modifier's recipe; for each, `base = (item qty or 0n) + Σ (each chosen modifier's delta or 0n)`;
   clamp `base` at `0n` (assumption 11); multiply by the line's `quantity` (a JavaScript integer —
   convert with `BigInt(line.quantity)` after checking `Number.isSafeInteger`) into a `Qty` via `qty()`;
   add into the running total with `addQty`.
4. After all lines, delete every ingredient whose total is `0n` and return the map. An item with no
   recipe contributes nothing; an unknown modifier id contributes nothing.
5. Pure: no database, no I/O; imports only the `Qty` helpers from `src/lib/money/quantity` and the
   `SaleLine` type.

**Tests:** (unit)
- Burger recipe `{ bun: 1000n, meat: 150000n, tomato: 30000n }`, one line of quantity 2 → `bun 2000n`,
  `meat 300000n`, `tomato 60000n`.
- The same line with the "No tomato" modifier (`tomato: -30000n`) → no `tomato` key.
- "No tomato" on an item whose recipe has no tomato → no `tomato` key (clamped at zero, never negative).
- "Extra cheese" (`cheese: 1000n`) on an item with `cheese: 1000n` → `cheese 2000n` per unit.
- An item with no recipe → an empty map.
- Two lines of the same item → the totals add.
- A line quantity that is not a safe integer → throws `TypeError` (a programming error; pos-sales'
  validator already guarantees integers ≥ 1).

**Done when:** `pnpm test:unit src/lib/server/inventory/consumption.test.ts` passes.

**Watch out:** clamp per line and per ingredient BEFORE multiplying by the quantity, never on the
aggregated total — "no tomato" on one burger must not cancel the tomato of another line.
