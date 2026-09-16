# `money/` — ONLY money helpers that touch the DB; the arithmetic is `src/lib/money/`

Money helpers that touch the database — reading a rate out of
`restaurant_settings`, mapping a `bigint` column. No money arithmetic lives
here.

## The placement is RESOLVED (2026-09-14)

The conflict this section used to record:

- CLAUDE.md invariant 1 said money arithmetic outside `src/lib/server/money`
  is a bug.
- Spec 17 requires "one rounding rule, implemented in one function and used
  everywhere (POS, server, reports)".
- SvelteKit build-blocks `$lib/server/**` from client code, and the offline POS
  must total a bill in the browser.

Those could not all hold. The spec outranks CLAUDE.md, so the pure arithmetic
lives in the **isomorphic** `src/lib/money/` — imported by `src/lib/server/**`,
by `src/lib/pos/**` and by `src/routes/(pos)/**` alike — and CLAUDE.md
invariant 1 was corrected to say so. `eslint.config.js` errors if that module
imports `$lib/server/**`.

What is left here: **only helpers that touch the database** — reading a rate
out of `restaurant_settings`, mapping a `bigint` column. A helper here reads or
maps a value and hands it to `src/lib/money/`; it never adds, multiplies,
allocates or rounds money itself. This directory is kept on purpose: deleting
it would read as "money moved out of the server", which is not what was
decided.

Copying a function into `src/lib/pos/` stays rejected. Spec 17 says one
function used everywhere, and two copies of a rounding rule is the bug that
requirement exists to prevent.

## Rules once this module holds code

- Integer minor units only. No float literal, no `parseFloat`, no `toFixed`,
  and no second rounding helper.
- ONE rounding rule in ONE function, used by POS, server and reports: full
  precision per line, round once on the invoice total (spec 17's default, still
  subject to open decision 3 — confirm with a local accountant).
- Discounts are applied before tax; tax mode (inclusive vs exclusive) is a
  restaurant setting read at calculation time, never hardcoded.
- Imports no sibling module.

Spec 17, 18. Invariants 1, 7.
