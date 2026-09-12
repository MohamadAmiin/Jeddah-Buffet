# `accounting/` — chart of accounts, posting rules, journal writer

Chart of accounts, posting rules (one per business event), journal writer.

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

Called by `orders/`. Never calls `orders/` back.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 22, 23, 24, 25. Invariants 2, 3, 4.
