# `audit/` — the audit log writer

The audit log writer.

- **Sensitive actions are audit-logged**: logins, failed PINs, voids, refunds,
  discounts, comps, approvals, cash-drawer opens, price changes.
- House rule: the audit row is written **in the same transaction as the action**
  it records. Offline logins are the one exception — recorded locally and synced
  later (invariant 10).
- Audit rows are append-only. They are never updated or deleted.
- Never log a PIN, a PIN hash, a session token or a password — not even a
  truncated one.

Called by `orders/`, `permissions/` and `auth/`. Never calls back into them.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 3, 6, 7. Invariant 10.
