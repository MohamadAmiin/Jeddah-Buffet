# `pos-sessions/` — POS shift open/close and business date in SQL

- **A POS session is a cashier shift**: opening cash → sales → count →
  reconciliation. Distinct from the auth session (spec 10).
- `business_date` is THE business date of every sale in the session
  (invariant 11). It is derived IN SQL by `openSession` from the device's
  `occurredAt` in the restaurant's time zone: `(occurredAt::timestamptz at
time zone <tz>)::date`. Never in JavaScript, never by a date library —
  01:30 belongs to the previous evening.
- Spec 10's expected cash: `opening_cash_minor + Σ payments.amount_minor`
  of paid orders in the session, filtered by `method = 'cash'`. Card and
  mobile takings are in clearing accounts (1020, 1030), not the drawer.
- Close reconciliation posts the difference to `6800 Cash Over/Short`
  through T-13's `overShortLines`: shortage = `Dr 6800 / Cr 1000`, overage
  = `Dr 1000 / Cr 6800`, zero posts nothing.
- Close is refused with `SessionHasUnrecordedOps(count)` while any
  `pos_sync_ops` row that names this session still has
  `status = 'unrecorded'` and `resolved_at is null`. A cash sale the
  server could not record is cash in the drawer with no revenue posted;
  closing over it would book that cash to 6800 as an overage. The owner
  retries or dismisses the op on `/reports/flagged` first (spec 6).
- The close writes its columns ONCE on a row locked `for update` and
  still `open`; nothing here edits a closed session (invariant 2).

Called by `orders/sync.ts` only (T-21). Calls `accounting/` and `audit/`
only. Never calls `orders/`.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 10, 17, 24. Invariants 1, 2, 3, 4, 10, 11.
