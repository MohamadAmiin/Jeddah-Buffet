# `db/` — Drizzle schema, migrations, client

Drizzle schema (one file per aggregate), generated migrations, client. The
**only** place tables are defined.

- Schema files live in `schema/`, one per aggregate. `drizzle.config.ts` points
  at that folder, never at a glob over this directory — a glob would import
  `client.ts` and open a database connection just by running drizzle-kit.
- Migrations live in `migrations/`, are committed, and are NEVER hand-edited or
  deleted once they have run. Add a new migration instead.
- Hand-written SQL only ever via `drizzle-kit generate --custom`, which
  registers the file in `migrations/meta/_journal.json`. A `.sql` file dropped
  into the folder by hand is not registered and is silently never applied.

What the schema owes the rest of the project:

- Money is integer minor units in `bigint`. Never a float, never a `numeric`
  money column (invariant 1, spec 17).
- Ingredient and stock-movement quantities are `numeric(12,3)`. An order-line
  item count is an ordinary `integer` (invariant 1).
- Timestamps are `timestamptz`, stored UTC. The restaurant's time zone is a
  setting applied at the edges (invariant 11, spec 17).
- Journal entries balance, enforced by the database at COMMIT — a
  `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`. drizzle-kit
  cannot generate that from schema files, so it comes from a custom migration
  (invariant 3, spec 3).
- `UNIQUE (device_id, invoice_number)` wherever invoice numbers land; keep
  `device_id` on POS-created rows so a second terminal is a data change, not a
  rewrite (invariant 5).

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 3, 17. CLAUDE.md "Where code lives".
