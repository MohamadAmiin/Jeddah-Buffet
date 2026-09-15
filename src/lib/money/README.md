# `money/` — ISOMORPHIC: integer minor units, allocation, THE rounding rule, tax in both modes

The one home of money arithmetic. The server (`src/lib/server/**`), the offline
POS (`src/lib/pos/**`, `src/routes/(pos)/**`) and reports all import this same
module — spec 17 requires one rounding rule in one function used by all three,
and spec 6 has the POS total a bill in the browser.

## What lives here, and what does not

**Here:** pure money arithmetic — integer minor units, allocation, THE rounding
rule, and tax in both modes (inclusive and exclusive).

**Not here:** anything that touches the database. Reading a rate out of
`restaurant_settings` or mapping a `bigint` column belongs in
`src/lib/server/money/`, which may import this module; this module never
imports that one.

## It imports nothing

This module is **isomorphic**, so it imports nothing at all:

- no sibling module;
- nothing from `$lib/server/**` — SvelteKit build-blocks it from the browser,
  and `eslint.config.js` errors on it here;
- no Node builtin (`node:crypto`, `node:fs` …). A `node:` import here breaks the
  browser build and takes the offline POS with it.

## Rules

- Money is integer minor units, stored in `bigint` columns: `$8.50` is `850`. A
  float literal, `parseFloat`, `toFixed` or a second rounding helper anywhere in
  here is a bug (invariant 1).
- A tax **rate** is an integer in **basis points** — `825` is 8.25% — never a
  float like `0.0825`. In JavaScript `640 * 0.0825` is `52.800000000000004`,
  not `52.8`, and spec 17 carries full precision per line before rounding once
  at the total, so that error accumulates into the figure a tax filing
  reconciles against.
- ONE rounding rule lives in ONE function, used by POS, server and reports:
  full precision per line, round once on the invoice total. That is spec 17's
  default and is still subject to open decision 3 — T-03 of the
  `pos-access-and-menu` plan obtains the answer, and nothing here may encode one
  before it does.
- Discounts are applied before tax; tax mode (inclusive vs exclusive) is a
  restaurant setting read at calculation time, never hardcoded.

Spec 17, 18. Invariants 1, 7.
