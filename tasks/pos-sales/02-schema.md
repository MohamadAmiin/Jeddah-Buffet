# Phase 1 — schema and migrations (T-04 … T-09)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 0.

This phase adds ten tables and two migrations, and every one of them obeys the same rules. Every
value set (an order type, a status, a tender, an op kind, an account type, a posting event) is a
`text` column with a NAMED `CHECK (… in (…))`, never a Postgres enum: adding a value later is one
reversible constraint swap (`DROP CONSTRAINT`, `ADD CONSTRAINT`), whereas the repo already paid once
for an enum rebuild — migration `0010_user_role_owner_staff.sql` had to drop three dependent
constraints, retype a column, drop and recreate the type, put everything back, and be reordered by
hand before its first run. Every table carries `restaurant_id uuid NOT NULL` referencing
`restaurants` (the schema guard in `schema-guards/schema.test.ts` fails otherwise). Every money
column is named `<thing>_minor` and typed `bigint('…', { mode: 'bigint' })` — integer minor units,
`850` is $8.50, never a float, never `numeric` (invariant 1); the guard keys on the name, so a money
column with any other suffix or type fails it. Every timestamp is
`timestamp('…', { withTimezone: true })` (`timestamptz`, UTC; invariant 11). Every foreign key
is `ON DELETE RESTRICT`. INSIDE an aggregate a child references its parent through a COMPOSITE
`(restaurant_id, id)` foreign key, so the database itself refuses a row that points into another
restaurant: `orders → order_lines → order_line_modifiers`, `orders → payments`, `orders → invoices`,
`journal_entries → journal_entry_lines`, `journal_entry_lines → accounts`, `orders → pos_sessions`,
and `order_lines → menu_items` (whose target unique `menu_items_id_restaurant_unique` already
exists). FKs to `users`, `pos_devices` and `modifiers` are SINGLE-column: `modifiers` has no
composite unique, and adding one to an existing table in the same migration runs into drizzle-kit's
statement order — it emits every `CREATE INDEX` after every `ADD CONSTRAINT … FOREIGN KEY`, so the
FK would be added before its target exists and the migration would die with SQLSTATE 42830. For the
same reason every composite-FK TARGET is a UNIQUE CONSTRAINT declared with `unique()`, which
drizzle-kit writes inside `CREATE TABLE`, and never a `uniqueIndex()`, which it writes last;
`src/lib/server/db/schema/menu.ts` explains this in its header comment. Schema files cannot import
`$lib` (drizzle-kit loads them outside Vite), so each CHECK spells its literals, and T-08's
`constraints.integration.test.ts` pins every list to the isomorphic constants in
`src/lib/sync-ops/index.ts` (T-03) and `src/lib/money/tax.ts`, exactly the way
`restaurant_settings_tax_mode_valid` is already pinned to `TAX_MODES`.

**Idioms every task in this phase uses** (copy them; do not invent variants):

```ts
// Column helpers, declared at the top of each new schema file (menu.ts is the precedent).
const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
```

- A money column that defaults to zero is written `.default(sql\`0\`)`, NEVER `.default(0n)`:
  drizzle-kit serialises the snapshot with `JSON.stringify`, which throws `TypeError: Do not know
  how to serialize a BigInt` on a bigint literal and aborts `pnpm db:generate`. The SQL form renders
  `DEFAULT 0 NOT NULL`, which is what the migration needs. (Verified against drizzle-kit 0.31.10.)
- An identity primary key is `bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey()`
  (the `audit_log` idiom). Its values come back as JavaScript `bigint`, so tests compare with `1n`.
- A business-date column is `date('business_date', { mode: 'string' }).notNull()`: Drizzle hands
  it back as `'YYYY-MM-DD'`. Raw `pg` (the pool the constraints test uses) hands a `date` back as a
  JavaScript `Date`, so raw assertions select `business_date::text`.
- A self-referencing FK needs the explicit return type:
  `uuid('reverses_entry_id').references((): AnyPgColumn => journalEntries.id, { onDelete: 'restrict' })`.
- A partial index is `uniqueIndex('…').on(t.col).where(sql\`${t.status} = 'open'\`)`; the same
  `.where()` works on `index()`.
- Nothing here writes a trigger or a function: drizzle-kit cannot express them, so they arrive in
  T-09's custom migration. Nothing here uses `pgEnum`.
- Between T-04 and T-08 the unit test `imports every file in src/lib/server/db/schema` in
  `schema.test.ts` FAILS by design (a new schema file exists that the guard does not import yet).
  T-08 registers the four files and makes it green. Do not "fix" it early by editing the guard.

### T-04 — Schema: `accounts`, `journal_entries`, `journal_entry_lines`

**Needs:** T-02
**Files:**
- `src/lib/server/db/schema/accounting.ts` — NEW
**Spec:** 22 (double entry; "Posted entries are never edited or deleted"; "The database rejects any
entry whose debits and credits don't match"), 23 (the chart: four-digit codes in six groups), 24
(the three tables `accounts`, `journal_entries`, `journal_entry_lines`; entries generated from
business events), 3 ("Journal entries must balance, and the database itself enforces it (a
constraint checked at commit)"), 17 (integer minor units in `bigint`; `timestamptz`; business date)
**Invariants:** 1 (money is integer minor units in bigint), 2 (posted records are permanent),
3 (journal entries balance in the database), 11 (business date, not calendar date)

**Do:**
1. Run `ls src/lib/server/db/schema/accounting.ts`; it must NOT exist (if it does, stop: the repo is
   not in the state this plan assumed). Create it with exactly these imports and nothing else — no
   `$lib/…`, no relative import of `src/lib/sync-ops` or `src/lib/server/accounting`:
   ```ts
   import { sql } from 'drizzle-orm';
   import {
   	pgTable, uuid, text, bigint, integer, date, timestamp, index, unique, check, foreignKey,
   	type AnyPgColumn
   } from 'drizzle-orm/pg-core';
   import { restaurants } from './restaurants';
   ```
   Declare the `tenant()` and `createdAt()` helpers from the phase idioms.
2. Write the header comment (a `//` block above the first table) stating, in these words or close
   to them:
   - these are spec 22/24's three shapes — a per-restaurant chart of `accounts`, `journal_entries`
     generated from business events by the spec 24 posting-rule table (nobody types a debit), and
     `journal_entry_lines` with exactly one side each;
   - invariant 3 (debits = credits, at least one debit line and one credit line, checked at
     COMMIT) is NOT enforced in this file: drizzle-kit cannot express a `CREATE CONSTRAINT TRIGGER
     … DEFERRABLE INITIALLY DEFERRED`, so it arrives in custom migration 0012 (T-09); the CHECKs
     below only guarantee each line is well-formed;
   - invariant 2 (posted records are permanent) is enforced by the append-only triggers of the
     same migration; nothing in application code, a repair script or a migration may `UPDATE` or
     `DELETE` a row of `journal_entries` or `journal_entry_lines` — a mistake is corrected with a
     reversing entry plus a new correct one;
   - money is `bigint` mode `'bigint'` minor units (invariant 1): `debit_minor = 1100` is $11.00;
     `client.ts` installs no type parsers, so pg hands int8 back as a string and mode `'bigint'`
     makes it a JavaScript `bigint`;
   - `reverses_entry_id` is a SEAM: nothing in this plan writes it; the refund/void plan will
     point a reversing entry at the entry it cancels;
   - every value set is `text` + a named CHECK, never an enum (the reason is this phase's rule:
     migration 0010 was the enum rebuild the repo will not repeat).
3. Add `accounts`, verbatim:
   ```ts
   export const accounts = pgTable(
   	'accounts',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: tenant(),
   		// Spec 23's four-digit code, e.g. '1000'. Text, so '1000' never becomes 1000.
   		code: text('code').notNull(),
   		name: text('name').notNull(),
   		type: text('type').notNull(),
   		createdAt: createdAt()
   	},
   	(t) => [
   		// Target of ON CONFLICT (restaurant_id, code) DO NOTHING in ensureChart (T-12)
   		// and the 0012 backfill (T-09).
   		unique('accounts_restaurant_code_unique').on(t.restaurantId, t.code),
   		// Target of journal_entry_lines_account_fk — a UNIQUE CONSTRAINT, not an index.
   		unique('accounts_id_restaurant_unique').on(t.id, t.restaurantId),
   		index('accounts_restaurant_id_idx').on(t.restaurantId),
   		check('accounts_code_format', sql`${t.code} ~ '^[0-9]{4}$'`),
   		check(
   			'accounts_type_valid',
   			sql`${t.type} in ('asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense')`
   		)
   	]
   );
   ```
4. Add `journalEntries`, verbatim:
   ```ts
   export const journalEntries = pgTable(
   	'journal_entries',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: tenant(),
   		// The POS session's business date (invariant 11), passed in by the writer —
   		// never created_at::date.
   		businessDate: date('business_date', { mode: 'string' }).notNull(),
   		// The spec 24 business event that generated the entry. The literals are
   		// POSTING_EVENTS in src/lib/server/accounting/posting-rules.ts (T-13); the
   		// constraints test pins the two lists together.
   		event: text('event').notNull(),
   		sourceType: text('source_type').notNull(),
   		// The order or POS session the entry came from. No FK: the source lives in a
   		// different aggregate and an entry must outlive any later change to it.
   		sourceId: uuid('source_id').notNull(),
   		memo: text('memo').notNull(),
   		// SEAM — nothing in this plan writes it.
   		reversesEntryId: uuid('reverses_entry_id').references((): AnyPgColumn => journalEntries.id, {
   			onDelete: 'restrict'
   		}),
   		postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
   		createdAt: createdAt()
   	},
   	(t) => [
   		// Target of journal_entry_lines_entry_fk.
   		unique('journal_entries_id_restaurant_unique').on(t.id, t.restaurantId),
   		index('journal_entries_restaurant_business_date_idx').on(t.restaurantId, t.businessDate),
   		index('journal_entries_source_idx').on(t.sourceType, t.sourceId),
   		check(
   			'journal_entries_event_valid',
   			sql`${t.event} in ('cash_sale', 'card_sale', 'mobile_sale', 'cost_of_goods_sold', 'cash_shortage_at_close', 'cash_overage_at_close')`
   		),
   		check('journal_entries_source_type_valid', sql`${t.sourceType} in ('order', 'pos_session')`)
   	]
   );
   ```
5. Add `journalEntryLines`, verbatim:
   ```ts
   export const journalEntryLines = pgTable(
   	'journal_entry_lines',
   	{
   		id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
   		restaurantId: tenant(),
   		entryId: uuid('entry_id').notNull(),
   		accountId: uuid('account_id').notNull(),
   		lineNo: integer('line_no').notNull(),
   		// Exactly one of the two is positive (journal_entry_lines_one_side). Minor
   		// units in bigint (invariant 1). sql`0`, not 0n — see the phase idioms.
   		debitMinor: bigint('debit_minor', { mode: 'bigint' }).notNull().default(sql`0`),
   		creditMinor: bigint('credit_minor', { mode: 'bigint' }).notNull().default(sql`0`),
   		createdAt: createdAt()
   	},
   	(t) => [
   		foreignKey({
   			columns: [t.restaurantId, t.entryId],
   			foreignColumns: [journalEntries.restaurantId, journalEntries.id],
   			name: 'journal_entry_lines_entry_fk'
   		}).onDelete('restrict'),
   		foreignKey({
   			columns: [t.restaurantId, t.accountId],
   			foreignColumns: [accounts.restaurantId, accounts.id],
   			name: 'journal_entry_lines_account_fk'
   		}).onDelete('restrict'),
   		unique('journal_entry_lines_entry_line_no_unique').on(t.entryId, t.lineNo),
   		index('journal_entry_lines_account_idx').on(t.accountId),
   		index('journal_entry_lines_entry_idx').on(t.entryId),
   		check('journal_entry_lines_non_negative', sql`${t.debitMinor} >= 0 and ${t.creditMinor} >= 0`),
   		check('journal_entry_lines_one_side', sql`(${t.debitMinor} = 0) <> (${t.creditMinor} = 0)`)
   	]
   );
   ```
6. Run `pnpm format` (Prettier owns the layout; tabs), then `pnpm check` and `pnpm lint`.

**Tests:** none in this task beyond `pnpm check`. The guards (`schema.test.ts`: tenant column,
`timestamptz`, `_minor` = `bigint`) and the constraints (`constraints.integration.test.ts`) are
proven in T-08; the balance trigger and the append-only triggers in T-09. `pnpm test:unit` FAILS on
`imports every file in src/lib/server/db/schema` from this task until T-08 — expected.

**Done when:** `pnpm check` exits 0 with the file imported nowhere yet;
`grep -cE 'pgEnum|\$lib|sync-ops' src/lib/server/db/schema/accounting.ts` prints `0`;
`grep -n "schema: './src/lib/server/db/schema'" drizzle.config.ts` prints one line (drizzle-kit
reads the whole folder, so T-08's `pnpm db:generate` will emit these three tables).

**Watch out:** Do not add triggers, functions or `SET CONSTRAINTS` anywhere in a schema file —
drizzle-kit cannot express them and the balance rule lands in T-09. Do not import `$lib`. Do not
"simplify" `mode: 'bigint'` to `mode: 'number'` — that is money in a float. The two composite-FK
targets (`accounts_id_restaurant_unique`, `journal_entries_id_restaurant_unique`) MUST be
`unique()`, not `uniqueIndex()`, or the generated migration dies with 42830. `.default(sql\`0\`)`,
never `.default(0n)`. The column order inside `unique('accounts_id_restaurant_unique').on(t.id,
t.restaurantId)` versus the FK's `[t.restaurantId, t.accountId]` is fine: PostgreSQL matches the
column SET, and `menu.ts` uses the same pairing.

### T-05 — Schema: `pos_sessions`

**Needs:** T-02
**Files:**
- `src/lib/server/db/schema/pos-sessions.ts` — NEW
**Spec:** 10 (a shift: opening cash → sales → count → reconciliation; expected cash versus counted
cash; "The system records the shortage and posts it to the Cash Over/Short account"; "Every POS
session belongs to one business date"; "Session close requires a connection and an empty sync
queue"), 6 ("Local sync queue" and "Idempotency keys" — spec 6 speaks of offline cash SALES as
facts; the rule that a session opened offline is a queued fact is this plan's R6, not spec text),
17 (business day; `timestamptz`), 24 (the two over/short posting rules the close fields feed)
**Invariants:** 1 (money is integer minor units in bigint), 2 (posted records are permanent — a
session is NOT one of them, but its close fields are written once), 5 (offline facts; device
namespace), 11 (business date, not calendar date)

**Do:**
1. Run `ls src/lib/server/db/schema/pos-sessions.ts`; it must NOT exist. Create it importing `sql`
   from `drizzle-orm`; `pgTable, uuid, text, bigint, date, timestamp, index, uniqueIndex, unique,
   check` from `drizzle-orm/pg-core`; `restaurants` from `./restaurants`; `posDevices` from
   `./pos-devices`; `users` from `./users`. Declare `tenant()` and `createdAt()`.
2. Header comment, stating:
   - spec 10: a POS session is a cashier shift, distinct from the auth session; it holds the
     opening float, and at close the counted cash, the expected cash (opening float + Σ cash
     payments of the session's recorded orders; refunds, pay-ins and pay-outs are zero in this
     plan) and `difference = counted − expected`, which T-20 posts as `Dr 6800 Cash Over/Short /
     Cr 1000 Cash on Hand` when negative and `Dr 1000 / Cr 6800` when positive (nothing when zero);
   - invariant 11: `business_date` is THE business date of every sale in the session; it is
     derived IN SQL by T-20 from `opened_at` in the restaurant's time zone
     (`(opened_at at time zone <tz>)::date`), never computed in JavaScript, and reports group by
     it, never by `created_at::date`;
   - `id` is generated by the DEVICE (the `session.open` op carries it); `defaultRandom()` exists
     only so a direct test insert works;
   - `opened_at` is the device's `occurredAt`; `received_at` is when the server stored the row;
   - `closed_from_device_id` exists for DEVICE LINEAGE: after a revoke-and-re-register, the
     successor device (the cookie's live device) may close a session that an older, now revoked
     device opened; `device_id` stays the opener;
   - the close fields (`closed_at`, `closed_by_user_id`, `closed_from_device_id`,
     `counted_cash_minor`, `expected_cash_minor`, `difference_minor`, `status`) are written ONCE,
     by `closeSession` (T-20), in the same transaction as the over/short entry, and
     `pos_sessions_closed_fields` requires ALL of them together when `status = 'closed'` —
     `closed_from_device_id` included, because `closeSession` always sets it
     (`closedFromDeviceId: ctx.cookieDeviceId`) and a closed session with no device lineage is a
     row the database must refuse; a session is not one of invariant 2's posted records, but
     nothing else may update it, and no code path reopens a closed session.
3. Add the table, verbatim:
   ```ts
   export const posSessions = pgTable(
   	'pos_sessions',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: tenant(),
   		deviceId: uuid('device_id')
   			.notNull()
   			.references(() => posDevices.id, { onDelete: 'restrict' }),
   		openedByUserId: uuid('opened_by_user_id')
   			.notNull()
   			.references(() => users.id, { onDelete: 'restrict' }),
   		openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
   		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
   		businessDate: date('business_date', { mode: 'string' }).notNull(),
   		openingCashMinor: bigint('opening_cash_minor', { mode: 'bigint' }).notNull(),
   		status: text('status').notNull(),
   		closedAt: timestamp('closed_at', { withTimezone: true }),
   		closedByUserId: uuid('closed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
   		closedFromDeviceId: uuid('closed_from_device_id').references(() => posDevices.id, {
   			onDelete: 'restrict'
   		}),
   		countedCashMinor: bigint('counted_cash_minor', { mode: 'bigint' }),
   		expectedCashMinor: bigint('expected_cash_minor', { mode: 'bigint' }),
   		differenceMinor: bigint('difference_minor', { mode: 'bigint' }),
   		createdAt: createdAt()
   	},
   	(t) => [
   		// Target of orders_session_fk — a UNIQUE CONSTRAINT, not an index.
   		unique('pos_sessions_id_restaurant_unique').on(t.id, t.restaurantId),
   		// One open session per device (spec 10). Partial, so closed sessions pile up freely.
   		uniqueIndex('pos_sessions_one_open_per_device')
   			.on(t.deviceId)
   			.where(sql`${t.status} = 'open'`),
   		index('pos_sessions_restaurant_business_date_idx').on(t.restaurantId, t.businessDate),
   		index('pos_sessions_device_status_idx').on(t.deviceId, t.status),
   		check('pos_sessions_opening_cash_non_negative', sql`${t.openingCashMinor} >= 0`),
   		check('pos_sessions_status_valid', sql`${t.status} in ('open', 'closed')`),
   		check(
   			'pos_sessions_closed_fields',
   			sql`((${t.status} = 'closed') = (${t.closedAt} is not null)) and (${t.status} = 'open' or (${t.countedCashMinor} is not null and ${t.expectedCashMinor} is not null and ${t.differenceMinor} is not null and ${t.closedByUserId} is not null and ${t.closedFromDeviceId} is not null))`
   		)
   	]
   );
   ```
4. `pnpm format`, `pnpm check`, `pnpm lint`.

**Tests:** none in this task beyond `pnpm check` (T-08 proves `pos_sessions_one_open_per_device`,
`pos_sessions_status_valid`, `pos_sessions_closed_fields` and the `bigint` round trip against the
real database).

**Done when:** `pnpm check` exits 0; `grep -c "date('business_date', { mode: 'string' })"
src/lib/server/db/schema/pos-sessions.ts` prints `1`; `grep -cE 'pgEnum|\$lib'` on the file
prints `0`.

**Watch out:** `difference_minor` may be NEGATIVE (a shortage) — no non-negative CHECK on it, nor on
`counted_cash_minor`/`expected_cash_minor` beyond the closed-fields rule. Never compute
`difference` in a component or a route: `closeSession` (T-20) computes it, through the money module.
The one open session per device is a `uniqueIndex` (partial), which is correct here because no
foreign key targets it; the composite-FK target `pos_sessions_id_restaurant_unique` is the
`unique()` constraint. Raw-`pg` reads of `business_date` come back as a `Date`; select
`business_date::text` in assertions.

### T-06 — Schema: `orders`, `order_lines`, `order_line_modifiers`, `payments`, `invoices`

**Needs:** T-05
**Files:**
- `src/lib/server/db/schema/orders.ts` — NEW
**Spec:** 13 (order types dine-in / takeaway; statuses OPEN, BILLED, PAID, VOIDED, REFUNDED; item
statuses NEW, SENT, VOIDED; the payment transaction "Record Payment(s) → Finalize Totals → Record
Invoice Number → Deduct Inventory → Create Invoice → Create Journal Entries → Mark Order PAID"), 6
("Each order line stores the price and tax rate used"; invoice numbers `POS1-000001` from the
device's own sequence, "the server enforces uniqueness on (device, number)"), 17 ("Each order line
stores the tax rate used"; money in `bigint`), 14 (deleting a NEW item needs no reason — the item
status values), 33 (decision 4: tenders `cash`, `card`, `mobile`)
**Invariants:** 1 (money is integer minor units in bigint), 2 (posted records are permanent),
4 (one all-or-nothing transaction at payment), 5 (an offline cash sale is a fact; device invoice
namespace; the server never renumbers), 7 (discount before tax; each line snapshots its own price
and rate; one rounding rule)

**Do:**
1. Run `ls src/lib/server/db/schema/orders.ts`; it must NOT exist. Create it importing `sql` from
   `drizzle-orm`; `pgTable, uuid, text, integer, bigint, timestamp, index, unique, check,
   foreignKey` from `drizzle-orm/pg-core`; `restaurants` from `./restaurants`; `posDevices` from
   `./pos-devices`; `users` from `./users`; `posSessions` from `./pos-sessions` (T-05); `menuItems,
   modifiers` from `./menu`. Declare `tenant()`, `createdAt()`, `updatedAt()`. The import graph is
   acyclic: `menu.ts`, `pos-devices.ts`, `pos-sessions.ts` and `users.ts` import nothing from this
   file.
2. Header comment, stating:
   - spec 13's statuses: `orders.status` allows `open`, `billed`, `paid`, `voided`, `refunded` and
     `order_lines.status` allows `new`, `sent`, `voided`; in THIS plan only `open` and `paid` are
     ever written to an order and only `new` to a line — `billed`, `voided`, `refunded`, `sent`
     exist in the CHECKs so the kitchen and approvals plans add no migration;
   - `order_type` is `('dine_in', 'takeaway')` only: assumption 1 of `00-overview.md` (takeaway,
     not home delivery; a later plan may add a value with one constraint swap);
   - invariant 7: every line snapshots `unit_price_minor` and its RESOLVED `tax_rate_bp` (the
     item's own rate or the restaurant's, resolved on the device, NOT NULL — never "inherit"), and
     the order snapshots `tax_mode`, `currency_code`, `menu_version` and the device's rounded
     `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`, so a later menu, rate or mode
     change cannot alter a past sale and the report never recomputes;
   - invariant 5: invoice numbers are the DEVICE's gap-free sequence, `POS1-000001`, unique per
     `(device_id, invoice_number)` and per `(device_id, invoice_seq)`; the server never renumbers,
     there is no global sequence and no `max(number)+1`;
   - invariant 2: `invoices` and `payments` get append-only triggers in migration 0012 (T-09);
     `orders.status` is updated EXACTLY ONCE, `open → paid`, inside the payment transaction — spec
     13's own "Mark Order PAID" step — and nothing else updates a paid order; a mistake is a
     reversing record;
   - the server first sees an order when it is paid (the `sale.complete` op carries the whole
     order), so `paid_at` is NOT NULL: the row is inserted with `status = 'open'` and the device's
     `paid_at`, then marked `paid` in the same transaction;
   - the arithmetic in `orders_totals_identity` and `payments_cash_fields` is a database GUARD
     that verifies an identity; the numbers are computed by `computeOrderTotals` and `changeDue`
     in `src/lib/money/` (T-10, T-11), never in SQL, a route or a component;
   - `discount_minor` exists on both `orders` and `order_lines` (bigint NOT NULL DEFAULT 0) and the
     validator (T-18) pins it to 0 until the approvals plan;
   - `payments` takes N rows per order from day one (spec 13 "may be split"); the till writes one.
3. Add `orders`, verbatim:
   ```ts
   export const orders = pgTable(
   	'orders',
   	{
   		id: uuid('id').primaryKey().defaultRandom(), // device-generated in practice
   		restaurantId: tenant(),
   		posSessionId: uuid('pos_session_id').notNull(),
   		deviceId: uuid('device_id')
   			.notNull()
   			.references(() => posDevices.id, { onDelete: 'restrict' }),
   		employeeUserId: uuid('employee_user_id')
   			.notNull()
   			.references(() => users.id, { onDelete: 'restrict' }),
   		orderType: text('order_type').notNull(),
   		tableLabel: text('table_label'),
   		status: text('status').notNull(),
   		taxMode: text('tax_mode').notNull(),
   		currencyCode: text('currency_code').notNull(),
   		menuVersion: integer('menu_version').notNull(),
   		subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull(),
   		discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull().default(sql`0`),
   		taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
   		totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
   		// The soft flag a recorded sale carries (T-19), e.g. 'totals_mismatch'. Null = clean.
   		flagReason: text('flag_reason'),
   		openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
   		paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
   		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
   		createdAt: createdAt(),
   		updatedAt: updatedAt()
   	},
   	(t) => [
   		// Target of order_lines_order_fk, payments_order_fk, invoices_order_fk.
   		unique('orders_id_restaurant_unique').on(t.id, t.restaurantId),
   		foreignKey({
   			columns: [t.restaurantId, t.posSessionId],
   			foreignColumns: [posSessions.restaurantId, posSessions.id],
   			name: 'orders_session_fk'
   		}).onDelete('restrict'),
   		index('orders_restaurant_session_idx').on(t.restaurantId, t.posSessionId),
   		index('orders_session_idx').on(t.posSessionId),
   		index('orders_employee_idx').on(t.employeeUserId),
   		check('orders_order_type_valid', sql`${t.orderType} in ('dine_in', 'takeaway')`),
   		check(
   			'orders_table_label_length',
   			sql`${t.tableLabel} is null or char_length(${t.tableLabel}) between 1 and 32`
   		),
   		check(
   			'orders_status_valid',
   			sql`${t.status} in ('open', 'billed', 'paid', 'voided', 'refunded')`
   		),
   		check('orders_tax_mode_valid', sql`${t.taxMode} in ('exclusive', 'inclusive')`),
   		check('orders_currency_code_format', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
   		check(
   			'orders_amounts_non_negative',
   			sql`${t.subtotalMinor} >= 0 and ${t.discountMinor} >= 0 and ${t.taxMinor} >= 0 and ${t.totalMinor} >= 0`
   		),
   		check(
   			'orders_totals_identity',
   			sql`${t.subtotalMinor} - ${t.discountMinor} + ${t.taxMinor} = ${t.totalMinor}`
   		)
   	]
   );
   ```
4. Add `orderLines`, verbatim:
   ```ts
   export const orderLines = pgTable(
   	'order_lines',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: tenant(),
   		orderId: uuid('order_id').notNull(),
   		lineNo: integer('line_no').notNull(),
   		menuItemId: uuid('menu_item_id').notNull(),
   		// Snapshot of the name at time of sale; the menu may rename the item later.
   		itemName: text('item_name').notNull(),
   		// An item COUNT: an ordinary integer, not numeric(12,3) (that is ingredient qty).
   		quantity: integer('quantity').notNull(),
   		unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
   		// RESOLVED on the device: the item's own rate or the restaurant's. Never null.
   		taxRateBp: integer('tax_rate_bp').notNull(),
   		discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull().default(sql`0`),
   		status: text('status').notNull(),
   		createdAt: createdAt()
   	},
   	(t) => [
   		// Target of order_line_modifiers_line_fk.
   		unique('order_lines_id_restaurant_unique').on(t.id, t.restaurantId),
   		unique('order_lines_order_line_no_unique').on(t.orderId, t.lineNo),
   		foreignKey({
   			columns: [t.restaurantId, t.orderId],
   			foreignColumns: [orders.restaurantId, orders.id],
   			name: 'order_lines_order_fk'
   		}).onDelete('restrict'),
   		// menu_items_id_restaurant_unique already exists (migration 0007).
   		foreignKey({
   			columns: [t.restaurantId, t.menuItemId],
   			foreignColumns: [menuItems.restaurantId, menuItems.id],
   			name: 'order_lines_menu_item_fk'
   		}).onDelete('restrict'),
   		index('order_lines_menu_item_idx').on(t.menuItemId),
   		check('order_lines_quantity_positive', sql`${t.quantity} >= 1`),
   		check('order_lines_unit_price_minor_non_negative', sql`${t.unitPriceMinor} >= 0`),
   		check('order_lines_tax_rate_bp_range', sql`${t.taxRateBp} >= 0 and ${t.taxRateBp} <= 10000`),
   		check('order_lines_discount_minor_non_negative', sql`${t.discountMinor} >= 0`),
   		check('order_lines_status_valid', sql`${t.status} in ('new', 'sent', 'voided')`)
   	]
   );
   ```
5. Add `orderLineModifiers`, verbatim:
   ```ts
   export const orderLineModifiers = pgTable(
   	'order_line_modifiers',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: tenant(),
   		orderLineId: uuid('order_line_id').notNull(),
   		// SINGLE-column FK: modifiers has no (restaurant_id, id) unique, and adding one
   		// to an existing table in this migration would be ordered after this FK (42830).
   		modifierId: uuid('modifier_id')
   			.notNull()
   			.references(() => modifiers.id, { onDelete: 'restrict' }),
   		modifierName: text('modifier_name').notNull(),
   		// May be negative ("No cheese −$0.50"); no CHECK, like modifiers.price_delta_minor.
   		priceDeltaMinor: bigint('price_delta_minor', { mode: 'bigint' }).notNull(),
   		createdAt: createdAt()
   	},
   	(t) => [
   		foreignKey({
   			columns: [t.restaurantId, t.orderLineId],
   			foreignColumns: [orderLines.restaurantId, orderLines.id],
   			name: 'order_line_modifiers_line_fk'
   		}).onDelete('restrict'),
   		index('order_line_modifiers_line_idx').on(t.orderLineId)
   	]
   );
   ```
6. Add `payments`, verbatim:
   ```ts
   export const payments = pgTable(
   	'payments',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: tenant(),
   		orderId: uuid('order_id').notNull(),
   		method: text('method').notNull(),
   		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
   		// Cash only: what the customer handed over and what went back. Null for card/mobile.
   		tenderedMinor: bigint('tendered_minor', { mode: 'bigint' }),
   		changeMinor: bigint('change_minor', { mode: 'bigint' }),
   		paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
   		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
   		createdAt: createdAt()
   	},
   	(t) => [
   		foreignKey({
   			columns: [t.restaurantId, t.orderId],
   			foreignColumns: [orders.restaurantId, orders.id],
   			name: 'payments_order_fk'
   		}).onDelete('restrict'),
   		index('payments_order_idx').on(t.orderId),
   		check('payments_method_valid', sql`${t.method} in ('cash', 'card', 'mobile')`),
   		check('payments_amount_minor_non_negative', sql`${t.amountMinor} >= 0`),
   		check(
   			'payments_cash_fields',
   			sql`(${t.method} = 'cash' and ${t.tenderedMinor} is not null and ${t.changeMinor} is not null and ${t.tenderedMinor} >= ${t.amountMinor} and ${t.changeMinor} = ${t.tenderedMinor} - ${t.amountMinor}) or (${t.method} <> 'cash' and ${t.tenderedMinor} is null and ${t.changeMinor} is null)`
   		)
   	]
   );
   ```
7. Add `invoices`, verbatim:
   ```ts
   export const invoices = pgTable(
   	'invoices',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: tenant(),
   		orderId: uuid('order_id').notNull(),
   		// The device whose sequence issued the number — the NAMESPACE of invoice_number.
   		deviceId: uuid('device_id')
   			.notNull()
   			.references(() => posDevices.id, { onDelete: 'restrict' }),
   		invoiceSeq: integer('invoice_seq').notNull(),
   		invoiceNumber: text('invoice_number').notNull(), // 'POS1-000001'
   		totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
   		issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
   		createdAt: createdAt()
   	},
   	(t) => [
   		foreignKey({
   			columns: [t.restaurantId, t.orderId],
   			foreignColumns: [orders.restaurantId, orders.id],
   			name: 'invoices_order_fk'
   		}).onDelete('restrict'),
   		unique('invoices_order_unique').on(t.orderId),
   		// Spec 6: "the server enforces uniqueness on (device, number)". Never global.
   		unique('invoices_device_number_unique').on(t.deviceId, t.invoiceNumber),
   		unique('invoices_device_seq_unique').on(t.deviceId, t.invoiceSeq),
   		check('invoices_seq_range', sql`${t.invoiceSeq} between 1 and 999999`),
   		check('invoices_number_format', sql`${t.invoiceNumber} ~ '^[A-Z0-9]{1,8}-[0-9]{6}$'`)
   	]
   );
   ```
8. `pnpm format`, `pnpm check`, `pnpm lint`.

**Tests:** none in this task beyond `pnpm check` (T-08 proves the CHECKs, the uniques, the composite
FKs' tenant isolation and the `bigint` round trip; T-09 proves `invoices` and `payments` are
append-only).

**Done when:** `pnpm check` exits 0; `grep -cE 'pgEnum|\$lib' src/lib/server/db/schema/orders.ts`
prints `0`; `grep -c "unique('" src/lib/server/db/schema/orders.ts` prints `6` (the six unique
constraints above) and `grep -c "uniqueIndex" src/lib/server/db/schema/orders.ts` prints `0`.

**Watch out:** Composite-FK targets need UNIQUE CONSTRAINTS created inside the same `CREATE TABLE`:
`orders_id_restaurant_unique`, `order_lines_id_restaurant_unique` and T-05's
`pos_sessions_id_restaurant_unique` are `unique()`, and `menu_items` already has one; `modifiers`
does not, hence the single-column `modifier_id` FK — do NOT add a composite unique to `modifiers`
in this plan. `.default(sql\`0\`)`, never `0n`. There is no `dining_tables` table and no FK from
`table_label`: it is a free-text label of at most 32 characters (R2). No non-negative CHECK on
`price_delta_minor`. `invoice_number`'s regex is the same as `formatInvoiceNumber` (T-03) produces:
`'^[A-Z0-9]{1,8}-[0-9]{6}$'`, matching `pos_devices_device_code_format` (`^[A-Z0-9]{1,8}$`) plus a
six-digit, zero-padded sequence.

### T-07 — Schema: `pos_sync_ops` and the accepted-tender settings columns

**Needs:** T-05, T-06
**Files:**
- `src/lib/server/db/schema/pos-sync.ts` — NEW
- `src/lib/server/db/schema/restaurant-settings.ts` — EDIT (two places: add `boolean` to the
  `drizzle-orm/pg-core` import on line 2; add two columns immediately after
  `currencyCode: text('currency_code'),` and before `menuVersion`, with the comment below)
**Spec:** 6 ("Every operation carries a unique ID generated on the device, so the server ignores
duplicates when a sync is retried"; "If a synced sale fails validation, it is stored and flagged for
owner review, never discarded"; offline logins "recorded locally and synced to the audit log"), 33
(decision 4: which payment methods launch — the part ASSUMED on 2026-09-28 as tasks/pos-sales
Assumption 3, recorded by T-02 pending the user's confirmation: cash always, card and mobile
switched on per restaurant), 7 (PINs "stored only as slow salted hashes"), 3 (audit-logged actions)
**Invariants:** 5 (idempotency keys; a retry is a no-op; a flagged fact is never discarded), 10
(sensitive actions audit-logged in the same transaction — the `pin.login` op feeds it), 12 (PINs
stored only as hashes, never logged — the op payload carries an OUTCOME, never a PIN)

**Do:**
1. Run `ls src/lib/server/db/schema/pos-sync.ts`; it must NOT exist. Create it importing `sql`
   from `drizzle-orm`; `pgTable, uuid, text, integer, bigint, jsonb, timestamp, index,
   uniqueIndex, check` from `drizzle-orm/pg-core`; `restaurants`, `posDevices`, `users` from their
   sibling files. Declare `tenant()`, `createdAt()`, `updatedAt()`.
2. Header comment, stating:
   - this is a SYNC LOG, not one of invariant 2's posted records: `status`, `flag`, `error`,
     `resolved_at`, `resolved_by_user_id` and `resolution` are UPDATED by the owner's retry and
     dismiss actions (`retryOp`, `dismissOp` in T-21) and by nothing else; the append-only
     triggers of migration 0012 deliberately do NOT cover this table;
   - `payload` is kept for ever, so a sale that failed validation is never lost (spec 6: "stored
     and flagged for owner review, never discarded"); a retry replays it under the SAME
     `client_op_id`;
   - the `payload` NEVER contains a PIN: the `pin.login` op carries only `{ outcome: 'success' |
     'failed' }` and the envelope's `employeeId`; a PIN reaching this column would be a PIN in the
     database in clear (invariant 12);
   - `(device_id, client_op_id)` is THE idempotency key (invariant 5, spec 6): the handler looks
     it up first and replays the stored result, and the unique index catches a racing retry
     (23505 → replay);
   - `client_op_id` is typed `uuid` (the till and the existing PIN page generate keys with
     `crypto.randomUUID()`), while the wire's `OpEnvelope.clientOpId` is a `string`. Therefore
     T-21 (`handleOp`) and T-27 (`POST /api/pos/sync`) MUST validate `clientOpId` AND `deviceId`
     as UUIDs (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) BEFORE
     touching `pos_sync_ops`, and answer `400 {error:'invalid_request'}` otherwise — an envelope
     the server cannot key, the same class as a missing `clientOpId` or `kind`. Without that
     check a crafted non-UUID key fails the op-row insert itself with SQLSTATE 22P02, so the op
     could not be stored even as `unrecorded`;
   - `device_id` is the device the op was STAMPED with, which may be revoked — after a
     revoke-and-re-register the successor's cookie flushes ops stamped with the old device, and
     the server records them under that device (its invoice namespace); `received_via_device_id`
     is the cookie's device;
   - `pos_session_id`, `order_id`, `invoice_seq` and `invoice_number` are extracted from the
     payload AT RECEIPT so the review page (T-37), the session-close guard (T-20 detects an
     `unrecorded` op that references the session and returns a typed refusal; T-21/T-27 answer
     `409 {error:'session_has_unrecorded_ops', count}`) and the invoice hint (T-28:
     `max(invoice_seq)` over
     all statuses) need no jsonb queries; they have NO foreign keys because an `unrecorded` op
     names an order or session that was never written;
   - status values: `accepted` (recorded clean), `recorded_flagged` (recorded in full with a
     soft flag in `flag`), `unrecorded` (a hard failure; payload only; `error` says why).
3. Add the table, verbatim:
   ```ts
   export const posSyncOps = pgTable(
   	'pos_sync_ops',
   	{
   		id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
   		restaurantId: tenant(),
   		deviceId: uuid('device_id')
   			.notNull()
   			.references(() => posDevices.id, { onDelete: 'restrict' }),
   		receivedViaDeviceId: uuid('received_via_device_id')
   			.notNull()
   			.references(() => posDevices.id, { onDelete: 'restrict' }),
   		clientOpId: uuid('client_op_id').notNull(),
   		kind: text('kind').notNull(),
   		employeeUserId: uuid('employee_user_id').references(() => users.id, { onDelete: 'restrict' }),
   		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
   		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
   		status: text('status').notNull(),
   		flag: text('flag'),
   		error: text('error'),
   		payload: jsonb('payload').notNull(),
   		posSessionId: uuid('pos_session_id'),
   		orderId: uuid('order_id'),
   		invoiceSeq: integer('invoice_seq'),
   		invoiceNumber: text('invoice_number'),
   		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
   		resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
   			onDelete: 'restrict'
   		}),
   		resolution: text('resolution'),
   		createdAt: createdAt(),
   		updatedAt: updatedAt()
   	},
   	(t) => [
   		// THE idempotency key. Not partial: client_op_id is NOT NULL here, unlike audit_log's.
   		uniqueIndex('pos_sync_ops_device_client_op_unique').on(t.deviceId, t.clientOpId),
   		// The review page's list: everything not clean and not yet resolved, newest last.
   		index('pos_sync_ops_restaurant_unresolved_idx')
   			.on(t.restaurantId, t.receivedAt)
   			.where(sql`${t.status} <> 'accepted' and ${t.resolvedAt} is null`),
   		index('pos_sync_ops_session_idx').on(t.posSessionId),
   		index('pos_sync_ops_device_invoice_seq_idx').on(t.deviceId, t.invoiceSeq),
   		check(
   			'pos_sync_ops_kind_valid',
   			sql`${t.kind} in ('session.open', 'session.close', 'sale.complete', 'sale.abandoned', 'pin.login')`
   		),
   		check(
   			'pos_sync_ops_status_valid',
   			sql`${t.status} in ('accepted', 'recorded_flagged', 'unrecorded')`
   		),
   		check(
   			'pos_sync_ops_resolution_valid',
   			sql`${t.resolution} is null or ${t.resolution} in ('retried', 'dismissed')`
   		)
   	]
   );
   ```
4. Open `src/lib/server/db/schema/restaurant-settings.ts`. On line 2 change the import to
   `import { pgTable, uuid, text, integer, boolean, timestamp, check } from 'drizzle-orm/pg-core';`.
   Then, directly after the line `currencyCode: text('currency_code'),` (inside the column object,
   before `menuVersion`), insert:
   ```ts
   		// Spec 33 open decision 4 (payment methods at launch), the part ASSUMED on
   		// 2026-09-28 (tasks/pos-sales Assumption 3, recorded in CLAUDE.md by T-02 pending
   		// the user's confirmation): cash is always
   		// accepted; card and mobile are recorded external-terminal tenders the owner
   		// switches on here. NULLABLE with NO column DEFAULT, exactly like tax_mode above:
   		// null means the owner has not chosen, and the till treats it as OFF and shows
   		// the reason on the disabled key. Written only by updateSettings (T-29).
   		acceptsCard: boolean('accepts_card'),
   		acceptsMobile: boolean('accepts_mobile'),
   ```
   Do NOT add a CHECK, a DEFAULT or a NOT NULL. Do NOT touch `settingsComplete()` in
   `src/lib/server/restaurants/index.ts` — the plan does not gate session-open on tenders (a
   restaurant with only cash is complete).
5. `pnpm format`, `pnpm check`, `pnpm lint`.

**Tests:** none beyond `pnpm check` (T-08 proves `pos_sync_ops_device_client_op_unique`,
the three CHECKs and that the two settings columns accept `null`, `true` and `false`).

**Done when:** `pnpm check` exits 0; `grep -c "accepts_card\|accepts_mobile"
src/lib/server/db/schema/restaurant-settings.ts` prints `2`; `grep -n "default" src/lib/server/db/
schema/restaurant-settings.ts` shows no line for either new column; `grep -cE 'pgEnum|\$lib'
src/lib/server/db/schema/pos-sync.ts` prints `0`.

**Watch out:** No column DEFAULT on `accepts_card`/`accepts_mobile` — CLAUDE.md forbids a default
that answers an open decision, and a migration that has run cannot be hand-edited back. No code
fallback either (`?? false` is a default wearing a disguise): T-28 returns the nullable value and
the till renders "not enabled by the owner" for `null`. The `pos_sync_ops.payload` column is
`jsonb NOT NULL` with no default — an op with no payload is a bug, not an empty object. The
`pin.login` op carries only an outcome; if any later task tries to put a PIN, a hash or a cookie
value into `payload`, stop. `client_op_id` is `uuid` here (the envelope's `clientOpId` is a UUID
string); `audit_log.client_op_id` is `text` and stays so. Because the column is `uuid`, T-21/T-27
MUST reject a `clientOpId` or `deviceId` that is not a UUID with `400 {error:'invalid_request'}`
BEFORE any insert — otherwise the insert dies with 22P02 and the op cannot even be stored as
`unrecorded`.

### T-08 — Generate migration 0011, register the new tables in the guards and the reset list, prove the constraints

**Needs:** T-03, T-04, T-05, T-06, T-07
**Files:**
- `src/lib/server/db/migrations/0011_<generated-name>.sql` — NEW (generated by `pnpm db:generate`;
  the adjective-noun name is drizzle-kit's; never renamed, never hand-edited once it has run)
- `src/lib/server/db/migrations/meta/0011_snapshot.json` — NEW (generated)
- `src/lib/server/db/migrations/meta/_journal.json` — EDIT (by drizzle-kit only: it appends the
  `idx: 11` entry; never by hand)
- `src/lib/server/db/schema-guards/schema.test.ts` — EDIT (three places: the `import * as …`
  block and the `modules` spread at the top; `IMPORTED_SCHEMA_FILES`; the expected array inside
  `it('discovers the tables it is meant to guard')`)
- `src/lib/server/db/test/reset.ts` — EDIT (the `TABLES` array and the comment above it)
- `src/lib/server/db/schema-guards/constraints.integration.test.ts` — EDIT (append the describe
  blocks below after the last existing block, `describe('roles constraints', …)`; if that block is
  absent the tree is pre-PR #11 — stop, T-01 was not satisfied)
**Spec:** 3 (data integrity rules; drizzle migrations), 29 (a backup before every migration; the
mandatory test areas), 6 (the idempotency key and the device invoice namespace, enforced in the
database), 17 (money in `bigint`; both tax modes)
**Invariants:** 1 (money is integer minor units in bigint), 3 (journal lines are well-formed —
the balance itself is T-09), 5 (retries are no-ops; `UNIQUE (device_id, invoice_number)`), 7 (each
line snapshots its rate), 11 (business date column)

**Do:**
1. Preconditions: `ls src/lib/server/db/migrations/0010_user_role_owner_staff.sql` exists (PR #11
   merged; T-01), `ls src/lib/server/db/migrations/0011_*.sql` prints nothing, `ls
   src/lib/sync-ops/index.ts` exists (T-03 — this task's tests import its constants). If any of
   these is wrong, stop.
2. Run `nvm use && pnpm db:generate`. It writes `0011_<name>.sql` and `meta/0011_snapshot.json`
   and appends to `meta/_journal.json`. It must not prompt (all ten tables and both columns are
   new); if it asks about a rename, answer that everything is new and re-check the schema files.
3. Open the generated SQL and confirm, before it runs anywhere:
   - ten `CREATE TABLE` statements (`accounts`, `invoices`, `journal_entries`,
     `journal_entry_lines`, `order_line_modifiers`, `order_lines`, `orders`, `payments`,
     `pos_sessions`, `pos_sync_ops`), each carrying its `CONSTRAINT … CHECK (…)` and
     `CONSTRAINT … UNIQUE(…)` lines INSIDE the statement;
   - `ALTER TABLE "restaurant_settings" ADD COLUMN "accepts_card" boolean;` and the same for
     `"accepts_mobile"`, with no `DEFAULT` and no `NOT NULL`;
   - every `ADD CONSTRAINT … FOREIGN KEY` comes AFTER the last `CREATE TABLE`, and every
     composite FK's target (`accounts_id_restaurant_unique`, `journal_entries_id_restaurant_unique`,
     `pos_sessions_id_restaurant_unique`, `orders_id_restaurant_unique`,
     `order_lines_id_restaurant_unique`, plus the pre-existing `menu_items_id_restaurant_unique`)
     is a `CONSTRAINT … UNIQUE` inside its `CREATE TABLE`, i.e. it precedes the FK;
   - the only `CREATE UNIQUE INDEX` lines are `pos_sessions_one_open_per_device` (with `WHERE
     "pos_sessions"."status" = 'open'`) and `pos_sync_ops_device_client_op_unique`;
   - `"debit_minor" bigint DEFAULT 0 NOT NULL`, `"credit_minor" bigint DEFAULT 0 NOT NULL`, and
     `"discount_minor" bigint DEFAULT 0 NOT NULL` on `orders` and `order_lines`;
   - `"business_date" date NOT NULL` on `pos_sessions` and `journal_entries`; every other time
     column is `timestamp with time zone`.
   If anything is out of order, the fix is a SCHEMA change plus a regenerated file (delete the
   just-generated `0011_*.sql`, `meta/0011_snapshot.json` and the journal entry, then generate
   again) — never an edit to the SQL, and never after the file has run.
4. Run `pnpm db:migrate` against the development database. It runs `pnpm db:backup` first (a
   `pg_dump` into `backups/`; spec 29 — if `pg_dump` is missing, install it, never bypass the
   backup) and then applies 0011. Afterwards `psql "$MIGRATE_DATABASE_URL" -c '\d pos_sync_ops'`
   shows the table.
5. `schema.test.ts`: add, in the import block, `import * as accountingSchema from
   '../schema/accounting';`, `import * as posSessionsSchema from '../schema/pos-sessions';`,
   `import * as ordersSchema from '../schema/orders';`, `import * as posSyncSchema from
   '../schema/pos-sync';` and spread all four into `modules`. Add `'accounting.ts'`,
   `'orders.ts'`, `'pos-sessions.ts'`, `'pos-sync.ts'` to `IMPORTED_SCHEMA_FILES` (keep it
   alphabetical: accounting, audit, menu, orders, pos-devices, pos-sessions, pos-sync,
   restaurant-settings, restaurants, roles, sessions, users). Replace the expected array in
   `it('discovers the tables it is meant to guard')` with the 23 names in JavaScript `.sort()`
   order (`_` sorts before letters):
   `accounts, audit_log, invoices, journal_entries, journal_entry_lines, menu_categories,
   menu_item_modifier_groups, menu_items, modifier_groups, modifiers, order_line_modifiers,
   order_lines, orders, payments, pos_devices, pos_sessions, pos_sync_ops, restaurant_settings,
   restaurants, role_permissions, roles, sessions, users`.
   Add NOTHING to `TENANT_COLUMN_EXEMPT` or `MONEY_NAME_EXEMPT`: every new table has
   `restaurant_id`, every money column ends in `_minor` and is `bigint`, `tax_rate_bp` is
   `integer`, `quantity` is `integer`. If a guard fails, fix the schema, never the guard.
6. `reset.ts`: insert into `TABLES`, between `'sessions'` and `'pos_devices'`, in this order:
   `'journal_entry_lines'`, `'journal_entries'`, `'accounts'`, `'pos_sync_ops'`, `'invoices'`,
   `'payments'`, `'order_line_modifiers'`, `'order_lines'`, `'orders'`, `'pos_sessions'`. Update
   the "Current tables, child-first" comment to list all 23, and add one sentence: T-09's
   append-only triggers on `journal_entries`, `journal_entry_lines`, `invoices` and `payments`
   block UPDATE and DELETE but not TRUNCATE, so this single `TRUNCATE … RESTART IDENTITY CASCADE`
   remains the one way to clear them, and `RESTART IDENTITY` also resets the identity sequences
   of `journal_entry_lines` and `pos_sync_ops`.
7. `constraints.integration.test.ts`: add file-scope helpers beside `makeDevice`, each a raw
   `pool.query` returning the new row's `id`:
   - `makeSession(restaurantId, deviceId, userId, overrides?)` →
     `insert into pos_sessions (restaurant_id, device_id, opened_by_user_id, opened_at,
     business_date, opening_cash_minor, status, closed_at, closed_by_user_id,
     closed_from_device_id, counted_cash_minor, expected_cash_minor, difference_minor) values
     ($1, $2, $3, now(), '2026-09-28', $4, $5, $6, $7, $8, $9, $10, $11) returning id`, where
     `overrides` is `{ openingCashMinor?, status?, closedAt?, closedByUserId?,
     closedFromDeviceId?, countedCashMinor?, expectedCashMinor?, differenceMinor? }` defaulting to
     `50000`, `'open'` and `null` for the six close columns. A closed row passes all six:
     `{ status: 'closed', closedAt: new Date(), closedByUserId: userId, closedFromDeviceId:
     deviceId, countedCashMinor: 50000, expectedCashMinor: 50000, differenceMinor: 0 }`;
   - `makeOrder(restaurantId, sessionId, deviceId, userId, overrides?)` → `insert into orders
     (restaurant_id, pos_session_id, device_id, employee_user_id, order_type, table_label, status,
     tax_mode, currency_code, menu_version, subtotal_minor, discount_minor, tax_minor, total_minor,
     opened_at, paid_at) values ($1, $2, $3, $4, 'takeaway', null, 'paid', 'exclusive', 'USD', 1,
     1000, 0, 100, 1100, now(), now()) returning id`, with `overrides` for the type, label,
     status, mode and the four amounts;
   - `makeMenuItem(restaurantId, name = 'Drinks')` → a category (`insert into menu_categories
     (restaurant_id, name) values ($1, $2)`; the parameter exists because
     `menu_categories_name_unique` is `(restaurant_id, lower(name)) where archived_at is null`, so a
     second call for one restaurant inside one test MUST pass a different name or it fails with
     23505) then an item (`insert into menu_items (restaurant_id,
     category_id, name, price_minor) values ($1, $2, 'Tea', 850) returning id`) — the existing
     `makeCategory`/`makeItem` are scoped inside the menu describe and are not reachable;
   - `makeLine(restaurantId, orderId, menuItemId, overrides?)` → `insert into order_lines
     (restaurant_id, order_id, line_no, menu_item_id, item_name, quantity, unit_price_minor,
     tax_rate_bp, discount_minor, status) values ($1, $2, 1, $3, 'Tea', 1, 850, 825, 0, 'new')
     returning id`, with `overrides` for `line_no`, `quantity`, `unit_price_minor`, `tax_rate_bp`
     and `status`;
   - `makeModifier(restaurantId)` → a group (`insert into modifier_groups (restaurant_id, name)
     values ($1, 'Milk') returning id`) then `insert into modifiers (restaurant_id, group_id, name,
     price_delta_minor) values ($1, $2, 'Oat milk', 50) returning id`;
   - `makePayment(restaurantId, orderId, method = 'cash', amount = 1100, tendered = 2000,
     change = 900)` → `insert into payments (restaurant_id, order_id, method, amount_minor,
     tendered_minor, change_minor, paid_at) values ($1, $2, $3, $4, $5, $6, now()) returning id`
     (pass `null` for `tendered` and `change` on card and mobile);
   - `makeInvoice(restaurantId, orderId, deviceId, seq = 1, number = 'POS1-000001')` → `insert
     into invoices (restaurant_id, order_id, device_id, invoice_seq, invoice_number, total_minor,
     issued_at) values ($1, $2, $3, $4, $5, 1100, now()) returning id`;
   - `makeAccount(restaurantId, code = '1000', name = 'Cash on Hand', type = 'asset')`;
   - `makeEntry(client: pg.PoolClient, restaurantId)` → `client.query(…)`, NOT `pool.query`:
     `insert into journal_entries (restaurant_id, business_date, event, source_type, source_id,
     memo) values ($1, '2026-09-28', 'cash_sale', 'order', gen_random_uuid(), 'test') returning
     id` on the `withRollback` client — the only helper in this list that takes a client, for the
     rule stated next;
   - `withRollback(fn: (client: pg.PoolClient) => Promise<void>)` → `pool.connect()`, `begin`,
     `await fn(client)`, then `rollback` in a `finally` and `client.release()`. THE RULE: EVERY
     insert into `journal_entries` in this file — the fixture entries of REJECTION cases included,
     so every `makeEntry` call and every `journal_entry_lines` case, because a line needs an entry
     for `journal_entry_lines_entry_fk` — runs inside `withRollback` on its `client`, never
     autocommitted through `pool.query`. After T-09 lands, an autocommitted entry with no lines,
     or a lone line, is rejected at its OWN COMMIT by the deferred triggers
     (`journal_entries_have_lines`, `journal_entry_lines_balanced`), so an autocommitted fixture
     entry would throw before the case under test even ran; inside `withRollback` the ROLLBACK
     never fires them, and in a rejection case the ONLY statement that fails is the offending
     `journal_entry_lines` INSERT itself (a CHECK or FK violation fails at INSERT, before any
     COMMIT). Rejection cases on every OTHER table (a CHECK violation fails at INSERT) may stay
     autocommitted.
   Then the describe blocks and cases listed under **Tests**.
8. Run `pnpm test` (unit and integration — the integration global setup migrates `matcami_test`
   to 0011 by itself), `pnpm exec drizzle-kit check`, `pnpm db:generate` a second time (expect
   `No schema changes, nothing to migrate`), `pnpm check`, `pnpm lint`.

**Tests:** (the schema guards are the repo's own test gate; the cases marked MANDATORY are the
database half of a spec 29 area)
- `schema.test.ts` (unit): every existing `it` in `schema.test.ts` (eight after PR #11: discovers,
  imports every file, truncates, tenant, timestamptz, money bigint, fixture shapes, menu money)
  passes over 23 tables; in particular `every
  money column is bigint minor units` reports no offender, `every timestamp column is timestamptz`
  none, `every tenant table has a restaurant_id column` none, `truncates every table it guards`
  passes with the 23-entry `TABLES`.
- `describe('value sets are pinned to the isomorphic constants (T-08)')` — import
  `ORDER_TYPES, PAYMENT_METHODS, ORDER_STATUSES, LINE_STATUSES, SESSION_STATUSES, OP_STATUSES,
  OP_KINDS` from `$lib/sync-ops` and `TAX_MODES` from `$lib/money/tax`; declare locally `const
  POSTING_EVENTS = ['cash_sale', 'card_sale', 'mobile_sale', 'cost_of_goods_sold',
  'cash_shortage_at_close', 'cash_overage_at_close'] as const;` with the comment that T-13 exports
  this exact literal from `src/lib/server/accounting/posting-rules.ts` and swaps this local for an
  import. For each list: `expect(<LIST>).toEqual([...])` with the overview's literal values; one
  insert per value succeeds (`rowCount === 1`); one insert with a value outside the list is
  rejected with `error.code === '23514'` and the named constraint:
  - `ORDER_TYPES` on `orders.order_type`; `'delivery'` → `orders_order_type_valid`.
  - `ORDER_STATUSES` on `orders.status`; `'cancelled'` → `orders_status_valid`.
  - `TAX_MODES` on `orders.tax_mode`; `'included'` → `orders_tax_mode_valid`.
  - `LINE_STATUSES` on `order_lines.status` (line inserted with `menu_item_id` from
    `makeMenuItem`, `quantity 1`, `unit_price_minor 850`, `tax_rate_bp 825`); `'deleted'` →
    `order_lines_status_valid`.
  - `PAYMENT_METHODS` on `payments.method` (`cash` with `tendered 2000`/`change 900` for amount
    `1100`; `card` and `mobile` with both null); `'voucher'` → `payments_method_valid`.
  - `SESSION_STATUSES` on `pos_sessions.status` (`'closed'` through `makeSession` with the full
    closed `overrides`: `closedAt`, `closedByUserId`, `closedFromDeviceId = the same device`,
    `counted 50000`, `expected 50000`, `difference 0`); `'suspended'` →
    `pos_sessions_status_valid`.
  - `OP_KINDS` on `pos_sync_ops.kind` and `OP_STATUSES` on `pos_sync_ops.status` (the row for
    every case is `insert into pos_sync_ops (restaurant_id, device_id, received_via_device_id,
    client_op_id, kind, status, occurred_at, payload) values ($1, $2, $2, gen_random_uuid(),
    'pin.login', 'accepted', now(), '{"outcome":"success"}'::jsonb)` — `received_via_device_id`
    is the same device — varying ONLY the column under test: `kind` for the `OP_KINDS` cases,
    `status` for the `OP_STATUSES` cases, plus `resolution` for its cases); `'sale.void'`
    → `pos_sync_ops_kind_valid`; `'rejected'` → `pos_sync_ops_status_valid`; resolution `'ignored'`
    → `pos_sync_ops_resolution_valid`, while `'retried'`, `'dismissed'` and `null` are accepted.
  - `POSTING_EVENTS` on `journal_entries.event` inside `withRollback`; `'refund'` →
    `journal_entries_event_valid`; `source_type 'purchase'` → `journal_entries_source_type_valid`.
  - `accounts.type`: the six literals accepted; `'contra'` → `accounts_type_valid`.
- `describe('pos_sessions constraints (T-08)')`:
  - a second `open` session for one device → `23505`, `pos_sessions_one_open_per_device`; after
    `update pos_sessions set status = 'closed', closed_at = now(), closed_by_user_id = $2,
    closed_from_device_id = $3, counted_cash_minor = 50000, expected_cash_minor = 50000,
    difference_minor = 0 where id = $1`, a new `open` session on the same device succeeds (the
    index is partial); a second device may hold its own open session concurrently.
  - `status = 'closed'` with `closed_at` null → `23514`, `pos_sessions_closed_fields`;
    `status = 'closed'` with `closed_at` set but `difference_minor` null → the same constraint;
    `status = 'closed'` with every other close field set but `closed_from_device_id` null → the
    same constraint (a closed session always records the device that closed it);
    `status = 'open'` with `closed_at` set → the same constraint.
  - `opening_cash_minor = -1` (`makeSession` with `{ openingCashMinor: -1 }`) →
    `pos_sessions_opening_cash_non_negative`.
  - `select business_date::text` returns `'2026-09-28'`, and through Drizzle
    (`testDb().select({ d: posSessions.businessDate })`) returns the string `'2026-09-28'`.
- `describe('orders, payments and invoices constraints (T-08)')`:
  - totals identity: `subtotal 1000, discount 0, tax 100, total 1000` → `23514`,
    `orders_totals_identity`; `subtotal 1000, discount 100, tax 90, total 990` is accepted.
  - `table_label` of 33 characters (`'x'.repeat(33)`) → `orders_table_label_length`; `''` → the
    same; `'Table 12'` and `null` accepted.
  - `currency_code 'usd'` → `orders_currency_code_format`.
  - `subtotal -1` → `orders_amounts_non_negative`.
  - an order whose `pos_session_id` belongs to ANOTHER restaurant → `23503`,
    `orders_session_fk` (tenant isolation — the reason the FK is composite).
  - cash payment `amount 1100, tendered 2000, change 800` → `23514`, `payments_cash_fields`;
    `tendered 1000` (< amount) → the same; `card` with `tendered 1100` → the same; `cash` with
    `tendered null` → the same; `amount -1` → `payments_amount_minor_non_negative`.
  - MANDATORY (spec 29 — offline sync: retries never create duplicates; the invoice half): two
    invoices with one `(device_id, invoice_number)` (`'POS1-000001'` on two different orders) →
    `23505`, `invoices_device_number_unique`; the same number on a SECOND device (`POS2`) is
    accepted (the namespace is per device, invariant 5); two invoices for one order →
    `invoices_order_unique`; one device with `invoice_seq 1` twice under different numbers →
    `invoices_device_seq_unique`; `invoice_seq 0` → `invoices_seq_range`; `invoice_seq 1000000` →
    the same; number `'POS1-1'` → `invoices_number_format`; `'pos1-000001'` → the same.
  - an order line with `tax_rate_bp 10001` → `order_lines_tax_rate_bp_range`; `-1` → the same;
    `quantity 0` → `order_lines_quantity_positive`; `unit_price_minor -1` →
    `order_lines_unit_price_minor_non_negative`; the same `(order_id, line_no)` twice →
    `order_lines_order_line_no_unique`; a line whose `menu_item_id` belongs to another restaurant
    → `23503`, `order_lines_menu_item_fk`.
  - a modifier row whose `order_line_id` belongs to another restaurant's line → `23503`,
    `order_line_modifiers_line_fk`; `price_delta_minor -50` is accepted.
  - MANDATORY (spec 29 — money arithmetic and rounding; the schema half): through Drizzle,
    `select({ total: orders.totalMinor })` returns `1100n` (a `bigint`, never `1100`), and
    `payments.changeMinor` returns `900n`.
- `describe('pos_sync_ops constraints (T-08)')`:
  - MANDATORY (spec 29 — offline sync: retries never create duplicates; the op-log half): two ops
    with one `(device_id, client_op_id)` → `23505`, `pos_sync_ops_device_client_op_unique`, and
    `select count(*)` is `1` afterwards; the same `client_op_id` on a second device is accepted.
  - `payload` null → `23502` (not-null violation).
  - a `device_id` of a REVOKED device (`update pos_devices set revoked_at = now(),
    revoked_by_user_id = $2 where id = $1` first) is accepted — a revoked device's queued facts
    are still recorded under it.
  - `restaurant_settings`: first `insert into restaurant_settings (restaurant_id, time_zone)
    values ($1, 'UTC')` (the existing `makeSettings` is scoped inside `describe('restaurant_settings
    constraints')` and is NOT reachable from this block, which is appended after `roles
    constraints`); then `select accepts_card, accepts_mobile` on that fresh row returns
    `null, null` (no default); then `update … set accepts_card = true, accepts_mobile = false
    where restaurant_id = $1` and afterwards both to `null` succeed (`rowCount 1` each).
- `describe('accounting constraints (T-08)')` (MANDATORY (spec 29 — journal entries always
  balance; the well-formed-line half; the balance itself is T-09)). EVERY case in this block that
  touches `journal_entries` or `journal_entry_lines` — the rejection cases included — runs inside
  `withRollback`, with its entry from `makeEntry(client, r)` and every insert through `client`,
  because a line needs an entry for `journal_entry_lines_entry_fk` and an autocommitted entry
  would be rejected at its own COMMIT by T-09's `journal_entries_have_lines`; in each rejection
  case the only statement that fails is the offending `journal_entry_lines` INSERT:
  - `accounts` (autocommitted is fine — no trigger touches it): an account with code `'100'` →
    `23514`, `accounts_code_format`; `'10000'` → the same; `'1A00'` → the same; the same
    `(restaurant_id, code)` twice → `23505`, `accounts_restaurant_code_unique`; the same code in
    two restaurants accepted.
  - inside `withRollback`: a line with `debit_minor 5, credit_minor 5` → `23514`,
    `journal_entry_lines_one_side`.
  - inside `withRollback`: a line with `debit_minor 0, credit_minor 0` →
    `journal_entry_lines_one_side`.
  - inside `withRollback`: a line with `debit_minor -1, credit_minor 0` →
    `journal_entry_lines_non_negative` (only that constraint fails for this input, so the name is
    deterministic).
  - inside `withRollback`: a line whose `account_id` belongs to another restaurant's account →
    `23503`, `journal_entry_lines_account_fk`; a line whose `entry_id` belongs to another
    restaurant's entry → `journal_entry_lines_entry_fk`; the same `(entry_id, line_no)` twice →
    `journal_entry_lines_entry_line_no_unique`; a balanced pair (`Dr 1000` `1100` / `Cr 4000`
    `1100`) inserts with `rowCount 1` each, and `select debit_minor` through the Drizzle client
    bound to the same connection (or a raw `select debit_minor::text` on `client`, compared to
    `'1100'`) returns `1100n` (or its text).

**Done when:** `pnpm db:generate` run a second time prints `No schema changes, nothing to migrate`
and `ls src/lib/server/db/migrations/*.sql | wc -l` prints `12`; `pnpm test` passes, including
every new describe block; `pnpm exec drizzle-kit check` reports no error; `pnpm check && pnpm lint`
pass; `git status` shows the three migration artefacts and the three edited test/reset files,
nothing else (the four schema files were committed by T-04 … T-07).

**Watch out:** If the generated SQL orders an `ADD CONSTRAINT … FOREIGN KEY` after an index it
needs, or a composite FK's target is missing, the fix is a schema change (make the target a
`unique()` constraint) and a REGENERATED file BEFORE the migration first runs — never an edit
after. Never rename the generated file: `_journal.json` carries its tag. The `.default(0n)` crash
(`Do not know how to serialize a BigInt`) means a schema file used a bigint literal — change it to
`sql\`0\``. Do not write ANY `journal_entries` or `journal_entry_lines` insert outside
`withRollback` — the fixture entry of a rejection case included: it passes today and fails at its
own COMMIT after T-09. Do not add an `UPDATE` or `DELETE`
against `invoices` or `payments` in these tests: T-09 forbids them and its own test proves it.
The `_journal.json` `when` timestamps are drizzle-kit's; commit them as generated.

### T-09 — Custom migration 0012: deferred balance trigger, append-only triggers, chart backfill; prove them at COMMIT

**Needs:** T-08
**Files:**
- `src/lib/server/db/migrations/0012_journal_guards.sql` — NEW (created EMPTY by `pnpm exec
  drizzle-kit generate --custom --name=journal_guards`, then filled by hand BEFORE it first runs;
  never edited after)
- `src/lib/server/db/migrations/meta/0012_snapshot.json` — NEW (generated: a copy of 0011's
  snapshot, because a custom migration changes no Drizzle-known schema)
- `src/lib/server/db/migrations/meta/_journal.json` — EDIT (by drizzle-kit only: the `idx: 12`
  entry with tag `0012_journal_guards`)
- `src/lib/server/accounting/journal-guards.integration.test.ts` — NEW
**Spec:** 22 ("The database rejects any entry whose debits and credits don't match"; "Posted entries
are never edited or deleted"), 3 ("Journal entries must balance, and the database itself enforces
it (a constraint checked at commit), not only application code"; "Posted records are permanent"),
23 (the chart, verbatim — 23 accounts), 24 (`accounts` per restaurant), 29 (mandatory: "Journal
entries always balance"; a backup before every migration)
**Invariants:** 3 (journal entries balance in the database, checked at COMMIT), 2 (posted records
are permanent — `journal_entries`, `journal_entry_lines`, `invoices`, `payments`), 1 (money is
integer minor units in bigint), 10 (nothing here is audited; the backfill is a migration, not an
action)

**Do:**
1. Preconditions: T-08's migration has run on the development database and `pnpm test` is green;
   `ls src/lib/server/db/migrations/0012_*` prints nothing.
2. Run `pnpm exec drizzle-kit generate --custom --name=journal_guards`. This is the ONLY way a
   hand-written SQL file is registered in `meta/_journal.json`; a `.sql` file dropped into the
   folder by hand is silently never applied. Migration `0004_audit_log_append_only.sql` is the
   precedent and its header explains why. Confirm `0012_journal_guards.sql` (empty),
   `meta/0012_snapshot.json` and the new journal entry exist.
3. Write the SQL, in this order, with `--> statement-breakpoint` between statements (drizzle's
   migrator splits on that marker and runs the whole file in ONE transaction):
   ```sql
   -- Invariant 3 IN THE DATABASE: a journal entry balances (Σdebit = Σcredit, at least one
   -- debit line and at least one credit line), checked AT COMMIT by a CONSTRAINT TRIGGER that
   -- is DEFERRABLE INITIALLY DEFERRED — spec 3: "a constraint checked at commit, not only
   -- application code". Deferred, because the writer inserts the entry and then its lines
   -- one by one; an immediate trigger would reject the first line of every entry.
   --
   -- Invariant 2 IN THE DATABASE: journal_entries, journal_entry_lines, invoices and payments
   -- are append-only. NOT orders (status is updated once, open → paid, inside the payment
   -- transaction — spec 13's own step), NOT pos_sessions (closed once by closeSession), NOT
   -- pos_sync_ops (a sync log the owner's retry/dismiss updates).
   --
   -- Created with `drizzle-kit generate --custom`, the only form that registers the file in
   -- migrations/meta/_journal.json — a .sql file dropped into this folder by hand is silently
   -- never applied, and here that failure is the dangerous kind: you would believe the ledger
   -- rejects an unbalanced entry while the database has no such trigger.

   CREATE OR REPLACE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
   DECLARE
     the_entry_id uuid := coalesce(NEW.entry_id, OLD.entry_id);
     debits bigint;
     credits bigint;
     debit_lines bigint;
     credit_lines bigint;
   BEGIN
     SELECT coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0),
            count(*) FILTER (WHERE debit_minor > 0), count(*) FILTER (WHERE credit_minor > 0)
       INTO debits, credits, debit_lines, credit_lines
       FROM journal_entry_lines
      WHERE entry_id = the_entry_id;
     IF debits <> credits OR debit_lines = 0 OR credit_lines = 0 THEN
       RAISE EXCEPTION 'journal entry % is not balanced: debits % credits %, debit lines %, credit lines %',
         the_entry_id, debits, credits, debit_lines, credit_lines;
     END IF;
     RETURN NULL;
   END;
   $$ LANGUAGE plpgsql;
   --> statement-breakpoint
   CREATE CONSTRAINT TRIGGER journal_entry_lines_balanced
     AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();
   --> statement-breakpoint
   -- An entry header with no lines would pass the line trigger (it never fires), so the header
   -- table gets its own deferred check: an entry must have at least one line by COMMIT.
   CREATE OR REPLACE FUNCTION journal_entry_has_lines() RETURNS trigger AS $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM journal_entry_lines WHERE entry_id = NEW.id) THEN
       RAISE EXCEPTION 'journal entry % has no lines', NEW.id;
     END IF;
     RETURN NULL;
   END;
   $$ LANGUAGE plpgsql;
   --> statement-breakpoint
   CREATE CONSTRAINT TRIGGER journal_entries_have_lines
     AFTER INSERT ON journal_entries
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION journal_entry_has_lines();
   --> statement-breakpoint
   CREATE OR REPLACE FUNCTION posted_record_append_only() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
       USING HINT = 'Correct a mistake with a reversing record, never by changing a posted one';
   END;
   $$ LANGUAGE plpgsql;
   --> statement-breakpoint
   CREATE TRIGGER journal_entries_append_only
     BEFORE UPDATE OR DELETE ON journal_entries
     FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
   --> statement-breakpoint
   CREATE TRIGGER journal_entry_lines_append_only
     BEFORE UPDATE OR DELETE ON journal_entry_lines
     FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
   --> statement-breakpoint
   CREATE TRIGGER invoices_append_only
     BEFORE UPDATE OR DELETE ON invoices
     FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
   --> statement-breakpoint
   CREATE TRIGGER payments_append_only
     BEFORE UPDATE OR DELETE ON payments
     FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
   --> statement-breakpoint
   -- The spec 23 chart, verbatim, for every restaurant that exists BEFORE ensureChart (T-12)
   -- becomes a restaurant initializer. Idempotent: ON CONFLICT on accounts_restaurant_code_unique.
   -- The en dash in the two clearing names is the spec's own character. All 23 accounts are
   -- seeded (Assumption 5), deviating from spec 23's "only the payment methods the restaurant
   -- accepts are created" — recorded in CLAUDE.md by T-02.
   INSERT INTO accounts (restaurant_id, code, name, type)
   SELECT r.id, c.code, c.name, c.type
   FROM restaurants r
   CROSS JOIN (VALUES
     ('1000', 'Cash on Hand', 'asset'),
     ('1010', 'Bank', 'asset'),
     ('1020', 'Payment Clearing – Card', 'asset'),
     ('1030', 'Payment Clearing – Mobile Money', 'asset'),
     ('1200', 'Inventory', 'asset'),
     ('2000', 'Accounts Payable', 'liability'),
     ('2100', 'Tax Payable', 'liability'),
     ('3000', 'Owner''s Capital', 'equity'),
     ('3100', 'Owner''s Drawings', 'equity'),
     ('3900', 'Retained Earnings', 'equity'),
     ('4000', 'Sales Revenue', 'revenue'),
     ('4100', 'Sales Discounts', 'revenue'),
     ('4200', 'Sales Refunds', 'revenue'),
     ('5000', 'Cost of Goods Sold', 'cost_of_sales'),
     ('5100', 'Waste & Inventory Adjustments', 'cost_of_sales'),
     ('5200', 'Comps & Staff Meals', 'cost_of_sales'),
     ('6000', 'Rent Expense', 'expense'),
     ('6100', 'Salary Expense', 'expense'),
     ('6200', 'Utilities Expense', 'expense'),
     ('6300', 'Maintenance Expense', 'expense'),
     ('6400', 'Payment Processing Fees', 'expense'),
     ('6800', 'Cash Over/Short', 'expense'),
     ('6900', 'Other Expenses', 'expense')
   ) AS c(code, name, type)
   ON CONFLICT (restaurant_id, code) DO NOTHING;

   -- The append-only triggers cover UPDATE and DELETE and deliberately NOT TRUNCATE. Three
   -- reasons, all of which have to hold together (0004_audit_log_append_only.sql is the
   -- precedent):
   --   1. TRUNCATE fires only STATEMENT-level triggers, so a row-level trigger would not catch
   --      it anyway.
   --   2. The integration harness resets the test database by truncating (test/reset.ts), and
   --      a BEFORE TRUNCATE trigger would make every test run after the first fail.
   --   3. Production is protected by PRIVILEGE instead: TRUNCATE requires the TRUNCATE
   --      privilege, which only the owner role holds; the runtime role matcami_app owns
   --      nothing and was never granted it, so the application cannot truncate a posted table.
   ```
   Keep the file's encoding UTF-8 so the en dash (U+2013) survives; `git diff` must show `–`, not
   `?`.
4. Write `src/lib/server/accounting/journal-guards.integration.test.ts`. It uses a raw `pg.Pool`
   on `process.env.TEST_DATABASE_URL` with `options: '-c timezone=UTC'` (the constraints test's
   idiom) plus `testDb()`/`closeTestDb()` from `../db/test/db` for the Drizzle transaction cases,
   and imports `accounts, journalEntries, journalEntryLines` from `../db/schema/accounting` and
   `randomUUID` from `node:crypto`. Helpers (raw SQL, each returning the new `id`):
   `makeRestaurant`, `makeOwner` and `makeDevice` copied VERBATIM from
   `src/lib/server/db/schema-guards/constraints.integration.test.ts` (file scope, above the first
   `describe`) — copy, do not retype: they already supply the NOT NULL columns a retyped version
   would omit (`users.display_name`, `pos_devices.label`, the 64-character `token_hash`,
   `registered_by_user_id`) and, after PR #11, satisfy `users_owner_has_no_role_staff_has_one`
   (an owner's `role_id` is null); then `makeSession` (the closed `overrides` shape), `makeOrder`,
   `makePayment` (`cash`, `amount 1100`, `tendered 2000`, `change 900`), `makeInvoice`
   (`invoice_seq 1`, `'POS1-000001'`, `total 1100`) — the same insert statements T-08 step 7
   spelled out for those four — and:
   - `seedChart(restaurantId)`: read `../db/migrations/0012_journal_guards.sql` with
     `readFileSync(new URL(…, import.meta.url), 'utf8')`, split on `--> statement-breakpoint`,
     and take the chunk that CONTAINS `INSERT INTO accounts` once leading comment lines are
     skipped: `chunks.find((s) => /^\s*(?:--[^\n]*\n\s*)*INSERT INTO accounts\b/.test(s))`.
     NOT "the chunk whose trimmed text starts with it": the chunk after the last breakpoint opens
     with the five `-- The spec 23 chart …` comment lines, and `trim()` strips whitespace, not
     comments, so a `startsWith` finds nothing. Throw a clear error if the find returns
     `undefined`, then execute that whole chunk as one `pool.query` (its trailing `--` comment
     block is harmless to PostgreSQL). This proves the MIGRATION's statement, not a copy.
   - `accountId(restaurantId, code)`: `select id from accounts where restaurant_id = $1 and code
     = $2`.
   - `writeEntry(tx, restaurantId, lines: { code: string; debit?: bigint; credit?: bigint }[])`
     (a TEST helper — not T-14's `postEntry`, which does not exist yet): inserts a
     `journal_entries` row through Drizzle (`businessDate: '2026-09-28'`, `event: 'cash_sale'`,
     `sourceType: 'order'`, `sourceId: randomUUID()`, `memo: 'test'`) and one
     `journal_entry_lines` row per element with `lineNo` 1..n, `debitMinor`/`creditMinor` as
     given (`0n` for the missing side). It takes the transaction handle and never opens its own.
   The assertions are under **Tests**. A rejected `db.transaction(…)` is the DRIZZLE promise
   rejecting: Drizzle issues `commit` inside its `try`, the deferred trigger raises during that
   `commit`, PostgreSQL has already rolled the transaction back, Drizzle issues `rollback`
   (harmless) and rethrows — so `await expect(testDb().transaction(…)).rejects.toThrow(/…/)` is
   the right shape, and the row counts afterwards are the proof nothing leaked.
5. Run `pnpm test:integration src/lib/server/accounting/journal-guards.integration.test.ts` (the
   global setup applies 0012 to `matcami_test`), then `pnpm test` in full (T-08's constraints
   tests must still pass — EVERY `journal_entries` insert there, rejection fixtures included, is
   inside `withRollback`, so the deferred triggers never fire and they do), then `pnpm db:migrate` on the development database (backup first), `pnpm exec drizzle-kit
   check`, `pnpm db:generate` (expect nothing), `pnpm check`, `pnpm lint`.

**Tests:** (integration; the file above)
- MANDATORY (spec 29 — journal entries always balance: the DB rejects an unbalanced entry AT
  COMMIT): inside `testDb().transaction`, insert an entry and ONE debit line (`Dr 1000` `1100n`);
  inside the same callback, `tx.select` the line count for the entry and expect `1` (the INSERT
  itself passed — the check is deferred); then assert the transaction promise REJECTS with a
  message matching `/journal entry [0-9a-f-]{36} is not balanced: debits 1100 credits 0, debit
  lines 1, credit lines 0/`, and afterwards `select count(*)` from `journal_entries` and from
  `journal_entry_lines` are both `0`.
- MANDATORY (spec 29 — the positive half): a balanced two-line entry (`Dr 1000` `1100n`, `Cr 4000`
  `1100n`) commits; afterwards `journal_entries` has `1` row and `journal_entry_lines` has `2`,
  and `select({ d: journalEntryLines.debitMinor })` for line 1 returns `1100n`.
- MANDATORY: a four-line entry that balances with a discount (`Dr 1000` `990n`, `Dr 4100` `100n`,
  `Cr 4000` `1000n`, `Cr 2100` `90n`; 1090 = 1090) commits — the spec 24 discount example.
- MANDATORY: an entry with NO lines → the transaction rejects with `/journal entry .* has no
  lines/`; `journal_entries` count `0` afterwards.
- MANDATORY: two debit lines and no credit line (`Dr 1000` `500n`, `Dr 1200` `500n`) → rejects with
  `/debits 1000 credits 0, debit lines 2, credit lines 0/` (no credit side, even though the two
  debits agree); counts `0`.
- MANDATORY: `Dr 1000` `1100n` and `Cr 4000` `1000n` → rejects with `/debits 1100 credits 1000/`.
- Append-only (invariant 2), after committing the balanced entry and seeding
  restaurant → owner → device → session → order → payment → invoice with the helpers, each of
  these raw statements is rejected with `error.code === 'P0001'`, `error.message` containing the
  table name followed by ` is append-only`, `error.message` containing the operation, and
  `error.hint === 'Correct a mistake with a reversing record, never by changing a posted one'`:
  - `update journal_entries set memo = 'tampered'` → `journal_entries is append-only: UPDATE`
  - `delete from journal_entries` → `journal_entries is append-only: DELETE`
  - `update journal_entry_lines set line_no = 99` → `journal_entry_lines is append-only: UPDATE`
  - `delete from journal_entry_lines` → `journal_entry_lines is append-only: DELETE`
  - `update invoices set total_minor = 0` → `invoices is append-only: UPDATE`
  - `delete from invoices` → `invoices is append-only: DELETE`
  - `update payments set amount_minor = 0` → `payments is append-only: UPDATE`
  - `delete from payments` → `payments is append-only: DELETE`
  and afterwards every one of the four tables still holds its rows (`journal_entries 1`,
  `journal_entry_lines 2`, `invoices 1`, `payments 1`). INSERT still works — the fixture is the
  proof.
- Not append-only, by design: `update orders set status = 'paid', updated_at = now() where id =
  $1` on an order inserted with `status 'open'` succeeds (`rowCount 1`); `update pos_sessions …
  set status = 'closed' …` (all close fields supplied) succeeds; after inserting an `unrecorded`
  op (the T-08 column list, `status 'unrecorded'`, `error 'database_error'`), `update pos_sync_ops
  set status = 'accepted', resolved_at = now(), resolution = 'retried' where id = $1` succeeds.
- The chart backfill: `seedChart(r)` twice → `select count(*) from accounts where restaurant_id =
  $1` is `23` after the first run and `23` after the second; `select code from accounts where
  restaurant_id = $1 order by code` equals the 23 codes `1000, 1010, 1020, 1030, 1200, 2000, 2100,
  3000, 3100, 3900, 4000, 4100, 4200, 5000, 5100, 5200, 6000, 6100, 6200, 6300, 6400, 6800, 6900`;
  the names for `1020` and `1030` are `'Payment Clearing – Card'` and `'Payment Clearing – Mobile
  Money'` (U+2013); `3000` is `"Owner's Capital"`; the `type` of `5000` is `'cost_of_sales'` and
  of `6800` is `'expense'`; with two restaurants seeded, each has `23`.
- The triggers are deferrable and deferred: `select tgname, tgdeferrable, tginitdeferred from
  pg_trigger where tgname in ('journal_entry_lines_balanced', 'journal_entries_have_lines')` returns
  two rows with `true, true`; `select count(*) from pg_trigger where tgname like '%_append_only'`
  returns `4`.

**Done when:** `pnpm db:migrate` applies 0012 to the development database (the backup prints
first) and `psql "$MIGRATE_DATABASE_URL" -tAc "select count(*) from pg_trigger where tgname in
('journal_entry_lines_balanced','journal_entries_have_lines','journal_entries_append_only',
'journal_entry_lines_append_only','invoices_append_only','payments_append_only')"` prints `6`;
`pnpm test:integration src/lib/server/accounting/journal-guards.integration.test.ts` passes;
`pnpm test` passes in full; `pnpm exec drizzle-kit check` reports no error and `pnpm db:generate`
prints `No schema changes, nothing to migrate`; `pnpm check && pnpm lint` pass.

**Watch out:** DEFERRED means EVERY INSERT PASSES — the rejection happens at COMMIT. A test that
asserts on the insert instead of the commit fails, and the tempting "fix" is to make the trigger
immediate, which would then reject the writer's first line of every entry; the fix is to assert on
the transaction promise, as above. Never put `SET CONSTRAINTS ALL IMMEDIATE` in the journal writer
(T-14) for the same reason. The append-only trigger is BEFORE, so it fires before the deferred one
ever sees an UPDATE or DELETE. The file is frozen the moment it has RUN anywhere: the first `pnpm
test` applies it to `matcami_test`, and `pnpm db:migrate` to the development database. Iterate
against the TEST database only; if the SQL must change before it has reached the development
database, fix the file and reset `matcami_test` so the migrator replays from 0000 — as the owner:
`psql "$TEST_DATABASE_URL" -c 'drop schema public cascade; drop schema if exists drizzle cascade;
create schema public;'` (Drizzle records applied migrations in schema `drizzle`, so dropping
`public` alone would leave it believing 0012 ran). Never do that to the development or a production
database; there the house rule is to restore the pre-migration dump from `backups/`. Once 0012 has
run on the development database a mistake is a NEW migration 0013, never an edit. Do not put the
triggers or the backfill into a schema file or a generated migration: drizzle-kit would either
refuse them or re-emit a drift on the next `db:generate`. `RAISE EXCEPTION` without an `ERRCODE`
is SQLSTATE `P0001`; do not change the message texts — T-14's and T-19's error mapping and these
tests match on them.
