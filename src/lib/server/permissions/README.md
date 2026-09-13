# `permissions/` — RBAC checks + owner-PIN approval gates

RBAC checks and owner-PIN approval gates.

- **Permissions are enforced SERVER-side on every POS API route, reads
  included.** Each route checks its own permission and returns `403`. Hiding a
  button is not security. A new `+server.ts` or form action with no permission
  check is unfinished (invariant 8).
- Permission keys come from spec 8. That list is introduced with "For example:",
  so it is extensible — but extending it is a plan's call, never coined mid-task.
- **Owner PIN approval is required** for: refund; void of an item already SENT
  to the kitchen; discount above the configured limit; comp/staff meal;
  re-opening a paid order; opening the cash drawer without a sale; cash pay-out
  above the limit; and voiding a whole order any of whose items were already
  SENT (invariant 9).
- Store action, acting employee, approver and reason code together in one audit
  record. Reason codes (spec 14) are mandatory on voids, refunds, discounts and
  comps; deleting a NEW (unsent) item needs none.

Called by `orders/` and by routes. Never calls `orders/` back.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 8, 9, 14. Invariants 8, 9.
