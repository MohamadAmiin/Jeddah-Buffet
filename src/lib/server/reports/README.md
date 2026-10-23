# src/lib/server/reports/ — the read side of sales reporting

This module holds read-only report queries over STORED columns. Every function
takes `restaurantId` explicitly and filters on it inside the query; figures are
grouped by `pos_sessions.business_date`, never by a timestamp cast. Nothing in
the module imports `computeOrderTotals`, `roundToMinor`, `taxOnAmount` or
`taxOnLine`, and nothing divides, multiplies by a fraction or rounds — a SQL
`sum()` of integer columns is the only arithmetic. Money columns are read as
`bigint` (`mode: 'bigint'` on the schema, `BigInt(string)` on a `sum()`
result) and never as `number`. The module is called by `(dashboard)` routes
only and calls no other server module (T-02's convention (j)); it is never
imported by client code or by `src/lib/pos/`.

`flagged.ts` lists and counts `pos_sync_ops` rows that are not `accepted` and
not yet resolved (`resolved_at is null`: neither retried nor dismissed), joins
the employee name and the session's business date, and summarises a stored
payload for display; it never returns the raw payload to a page and never
retries or dismisses anything — those are `orders/sync.ts`'s `retryOp` and
`dismissOp`, called by the route.

`tax-overrides.ts` (tasks/bill-tax-override) lists every paid tax-exempt bill
in a business-date range — invoice, cashier, the rate and reason the till
stored, the total and `tax_removed_minor` — and a count and `sum()` of the tax
removed per cashier: the owner's control on an exemption any cashier may apply
without a PIN. `sales.ts`'s by-item and by-category amounts read
`order_lines.charged_minor` when it is set (a line of an inclusive-mode exempt
bill, whose share of the total the payment transaction stored) instead of unit
price × quantity, so those sections still add up to the takings.

Spec 10, 17, 25, 26, 27. Invariants 1, 7, 11.
