# `money/` — integer cents, allocation, THE rounding rule, tax in both modes

Integer cents, allocation, THE rounding rule, tax in both modes. Imported by
everything; imports no sibling.

## Read this before writing any code here — the placement is UNRESOLVED

This directory exists because CLAUDE.md's layout names it. Creating it decides
nothing. Moving it would, so it was not moved.

The conflict, stated plainly:

- CLAUDE.md invariant 1 says money arithmetic outside `src/lib/server/money`
  is a bug.
- Spec 17 requires "one rounding rule, implemented in one function and used
  everywhere (POS, server, reports)".
- SvelteKit build-blocks `$lib/server/**` from client code, and the offline POS
  must total a bill in the browser.

Those cannot all hold as written. The spec outranks CLAUDE.md, so the pure
arithmetic will most likely move to an isomorphic `src/lib/money/` — but that
is the **first money task's** decision to make and record, together with the
correction to CLAUDE.md invariant 1, in the same commit, and **before** it
writes a single arithmetic function.

Do not resolve it by copying a function into `src/lib/pos/`. Spec 17 says one
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
