# `accounting/` — chart of accounts, posting rules, journal writer

`chart.ts` — `CHART`, spec 23's 23 accounts verbatim as `{ code, name, type }` with `code` a text string; `ensureChart(tx, restaurantId)`, the idempotent per-restaurant seed (`ON CONFLICT (restaurant_id, code) DO NOTHING`) that the restaurant initializer list runs for every new restaurant and migration 0012 backfilled for existing ones; `accountIdByCode(tx, restaurantId, code)`, the only code-to-id lookup, which throws when the code is absent. `posting-rules.ts` (T-13) and `journal.ts` (T-14) follow in the same plan.

- Entries are **generated from business events** by the spec 24 posting-rule
  table. Nobody types a debit.
- Account codes come from spec 23 verbatim (1000 Cash on Hand … 6900 Other
  Expenses). Never invent one — propose it instead.
- Debits = credits, enforced by a database constraint checked at COMMIT, not
  only in TypeScript (invariant 3, spec 3).
- Posted journal entries and lines are permanent. A mistake is corrected with a
  reversing entry plus a new correct one — never an `UPDATE` or `DELETE`, not in
  app code, not in a repair script, not in a migration (invariant 2).
- Every write takes a transaction handle. The payment transaction is
  all-or-nothing and it owns the boundary (invariant 4).

Called by `orders/` and, for the chart seed only, by `restaurants/` (amendment recorded by T-02 of tasks/pos-sales, 2026-09-28). Never calls either back.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 22, 23, 24, 25. Invariants 2, 3, 4.
