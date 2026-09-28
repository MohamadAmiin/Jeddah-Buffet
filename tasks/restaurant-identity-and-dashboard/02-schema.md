# Phase 1 — Schema and migrations

Five tables, one generated migration, one hand-written migration, and the test harness that lets the
rest of the plan be tested at all. These are the first business tables in matcami, so every idiom
chosen here is the idiom every later aggregate will be copied from. Get the column types right.

**Depends on:** Phase 0 (T-01 for the prerequisites, T-02 for the role split).

Read `00-overview.md` first for the requirements, assumptions and the file-tag convention.

**Rules that bind every task in this phase**, from CLAUDE.md and `src/lib/server/db/README.md`:

- Timestamps are `timestamptz`, stored UTC (invariant 11). In Drizzle that is
  `timestamp('col', { withTimezone: true })`. A bare `timestamp()` emits `timestamp without time
  zone`, and node-postgres then parses it in the server process's local zone, so every value silently
  shifts by the host offset. T-09 makes that impossible to get wrong again.
- No money column appears anywhere in this plan. When one arrives it is integer minor units in
  `bigint`, never a float and never a `numeric` money column (invariant 1).
- One schema file per aggregate, in `src/lib/server/db/schema/`. `drizzle.config.ts` points at that
  folder, so any `.ts` file placed there is picked up.
- Migrations are committed and are never hand-edited or deleted once they have run. Hand-written SQL
  is created **only** with `drizzle-kit generate --custom`, which registers the file in
  `migrations/meta/_journal.json`; a `.sql` file dropped into the folder by hand is silently never
  applied.

---

### T-04 — Schema: `restaurants`, `restaurant_settings`, `users`

**Needs:** T-01
**Files:**
- `src/lib/server/db/schema/restaurants.ts` — NEW
- `src/lib/server/db/schema/restaurant-settings.ts` — NEW
- `src/lib/server/db/schema/users.ts` — NEW
**Spec:** 3 (PostgreSQL holds Users, Roles, Permissions), 7 (the owner uses email and password; the
cashier and waiter use PINs on the POS), 17 (timestamps stored UTC in `timestamptz`; the restaurant's
time zone is a setting), 31 (one restaurant, one cashier, one waiter, one owner)
**Invariants:** 11 (timestamps stored UTC in `timestamptz`; the restaurant's time zone is a setting),
12 (PINs and passwords stored only as slow salted hashes, never reversible, never logged)

**Do:**

1. Create `restaurants.ts` exporting `restaurants`, table name `restaurants`:
   - `id` — `uuid('id').primaryKey().defaultRandom()`
   - `name` — `text('name').notNull()`
   - `createdAt` — `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`
   - `updatedAt` — `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()`

   Do **not** add a `status` column. Restaurant suspension belongs to a SaaS variant the user did not
   choose, and an inert enum nobody sets is worse than no column.

2. Create `restaurant-settings.ts` exporting `restaurantSettings`, table name `restaurant_settings`:
   - `restaurantId` — `uuid('restaurant_id').primaryKey().references(() => restaurants.id, {
     onDelete: 'restrict' })`
   - `timeZone` — `text('time_zone').notNull()`
   - `updatedAt` — `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()`

   One settings row per restaurant, so the foreign key **is** the primary key. `onDelete: 'restrict'`
   throughout this plan: a restaurant with any history must not be deletable, because audit rows
   reference it and those are append-only.

   Add a file comment stating what must **not** be added here and why: tax mode, tax rate, currency,
   approval limits and idle-lock seconds are open decisions 3, 4 and 6, and CLAUDE.md forbids baking
   an answer into the schema. When they arrive they land **nullable**, with POS session-open gated on
   completeness, never with a column `DEFAULT` that silently answers the open decision for every
   restaurant already registered.

3. Create `users.ts`. First the role enum:
   `export const userRole = pgEnum('user_role', ['owner', 'cashier', 'waiter'])` — spec 31's three
   roles, no Manager (open decision 5 defaults to owner PIN only, and CLAUDE.md excludes the Manager
   role).

   Then `users`, table name `users`:
   - `id` — `uuid('id').primaryKey().defaultRandom()`
   - `restaurantId` — `uuid('restaurant_id').notNull().references(() => restaurants.id, { onDelete:
     'restrict' })`
   - `role` — `userRole('role').notNull()`
   - `displayName` — `text('display_name').notNull()`
   - `email` — `text('email')` (nullable)
   - `passwordHash` — `text('password_hash')` (nullable)
   - `isActive` — `boolean('is_active').notNull().default(true)`
   - `failedPasswordCount` — `integer('failed_password_count').notNull().default(0)`
   - `passwordLockedUntil` — `timestamp('password_locked_until', { withTimezone: true })` (nullable)
   - `createdAt`, `updatedAt` — `timestamptz`, not null, default now

4. There is deliberately **no `pin_hash` column**. Spec 6 requires employee PINs to be verified
   offline in the browser from hashes cached on the registered device, so the POS plan must choose an
   algorithm available in WebCrypto or WASM, which may not be the argon2id parameters T-10 uses for
   passwords. A column with no writer, no reader and no decided format would hard-code the wrong
   assumption into the first migration. Adding a nullable column later is metadata-only. Put that
   reasoning in a comment in the file so the next person does not "fix" the omission.

   For the same reason the counters are named `failed_password_count` and `password_locked_until`
   rather than generic names: the PIN plan adds its own pair, and the two surfaces lock
   independently. Five wrong PINs typed by a waiter at the counter must not lock the owner out of the
   dashboard.

5. Add these table constraints and indexes in the table's extra-config callback:

   - `uniqueIndex('users_email_lower_unique').on(sql\`lower(${table.email})\`).where(sql\`${table.email}
     is not null\`)` — email is a **global** login identity, unique across all restaurants, matched
     case-insensitively.
   - `uniqueIndex('users_one_owner_per_restaurant').on(table.restaurantId).where(sql\`${table.role} =
     'owner'\`)` — exactly one owner per restaurant (spec 31).
   - `check('users_owner_has_credentials', sql\`${table.role} <> 'owner' or (${table.email} is not
     null and ${table.passwordHash} is not null)\`)` — an owner must be able to log in.
   - `check('users_non_owner_has_no_credentials', sql\`${table.role} = 'owner' or (${table.email} is
     null and ${table.passwordHash} is null)\`)` — and nobody else may. Spec 7 gives email and
     password to the Owner/Admin and PINs to the cashier and waiter. Without this second constraint a
     later Employees plan can quietly give a cashier a password, and any route guarded only by
     "is there a session" would then accept them.
   - `index('users_restaurant_id_idx').on(table.restaurantId)`

6. Export a TypeScript type for the role union derived from the enum, so later code never compares
   against a bare string literal that a typo can break.

**Tests:** the constraint behaviour is tested in T-09 against the real database, because a CHECK
constraint that exists only in a schema file proves nothing. Do not write a unit test that re-asserts
the Drizzle object shape.

**Done when:** `pnpm check` passes with the three files in place, and every timestamp column in all
three files is written with `{ withTimezone: true }`. No migration is generated yet; that is T-06.

**Watch out:** `defaultRandom()` gives the database a `gen_random_uuid()` default, which is right, but
T-14 will still generate the restaurant's id in application code before inserting. That is deliberate:
it keeps a single transaction able to insert the restaurant and then rows that reference it under a
future row-level-security `WITH CHECK` policy, which cannot see an id the database has not returned
yet. Leave the default in place; it costs nothing and covers inserts from scripts.

---

### T-05 — Schema: `sessions` and `audit_log`

**Needs:** T-04
**Files:**
- `src/lib/server/db/schema/sessions.ts` — NEW
- `src/lib/server/db/schema/audit.ts` — NEW
**Spec:** 3 ("Sensitive actions are audit-logged: logins, failed PINs, voids, refunds, discounts,
comps, approvals, cash drawer opens and price changes"; posted records are permanent), 6 (offline
logins are recorded locally and synced to the audit log — a seam this table must leave open), 8 (the
action, the employee, the approver and the reason are stored together in the audit log), 9 (secure
cookie sessions)
**Invariants:** 10 (sensitive actions are audit-logged, in the same transaction as the action), 11
(timestamps stored UTC in `timestamptz`), 12 (sessions are cookies, never `localStorage`)

**Do:**

1. Create `sessions.ts` exporting `sessions`, table name `sessions`:
   - `id` — `text('id').primaryKey()`. This is **not** the cookie value. It is the lowercase hex
     SHA-256 of the random token that is in the cookie, so a database leak does not hand an attacker
     a usable session. T-12 owns that derivation; the schema just needs a 64-character text primary
     key.
   - `userId` — `uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' })`.
     Cascade is correct **here and only here**: a session is not a business record, and deleting a
     user should not leave a live session behind. Every other foreign key in this plan is `restrict`.
   - `expiresAt` — `timestamp('expires_at', { withTimezone: true }).notNull()`
   - `createdAt` — `timestamptz`, not null, default now
   - `lastSeenAt` — `timestamptz`, not null, default now
   - `index('sessions_user_id_idx').on(table.userId)` and
     `index('sessions_expires_at_idx').on(table.expiresAt)`

   `sessions` deliberately has **no `restaurant_id`**. A session belongs to a user, the user belongs
   to a restaurant, and duplicating the tenant here would create two places that can disagree. T-09's
   schema guard lists `sessions` as an explicit exemption, with this sentence as the reason.

2. Create `audit.ts` exporting `auditLog`, table name `audit_log`:
   - `id` — `bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey()`
   - `restaurantId` — `uuid('restaurant_id').notNull().references(() => restaurants.id, { onDelete:
     'restrict' })`
   - `actorUserId` — `uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' })`,
     nullable: an unauthenticated or operator-script event has no actor.
   - `subjectUserId` — `uuid('subject_user_id').references(() => users.id, { onDelete: 'restrict' })`,
     nullable: **who the event was about**. A failed login is performed by nobody and is *about* the
     owner whose email was tried. Without this column the only id available is the victim's, and it
     lands in `actor_user_id`, so a later "actions by employee" report blames the attacked owner for
     the attack.
   - `event` — `text('event').notNull()`
   - `details` — `jsonb('details').notNull().default({})`
   - `ip` — `text('ip')`, nullable
   - `userAgent` — `text('user_agent')`, nullable
   - `occurredAt` — `timestamp('occurred_at', { withTimezone: true }).notNull()` — **when the thing
     happened**, which is not always when the row was written. Spec 6 requires offline logins to be
     recorded on the device and synced later; without this column such a row is stamped with the sync
     time and the real time is lost. Nothing in this plan writes a value other than "now", and that
     is fine: the column exists so the offline plan does not have to alter a table whose rows cannot
     be updated.
   - `createdAt` — `timestamptz`, not null, default now — when the row was written.
   - `index('audit_log_restaurant_created_idx').on(table.restaurantId, desc(table.createdAt))`

3. Create that index now, while the table is empty. `audit_log` is the fastest-growing table in the
   system from day one, and every owner-facing view of it filters by restaurant and orders by time
   descending. Adding the index later on a live table needs `CREATE INDEX CONCURRENTLY`, which cannot
   run inside a transaction block, and Drizzle's migrator wraps each migration run in one — so it
   becomes an out-of-band manual step in a maintenance window. Today it is one line.

4. Do **not** add `approver_user_id` or `reason_code` columns. Spec 8 requires the action, employee,
   approver and reason stored together, but approvals are the POS approvals plan's work and nothing
   in this plan can produce one. Adding nullable columns later is a trivial migration. Record that in
   a file comment so the approvals plan knows they are expected, not forgotten.

5. Do **not** add `device_id` or a client-side operation id either. The offline sync plan must add
   both, plus a partial `UNIQUE (device_id, client_op_id)`, **before** the first device-sourced audit
   row is written, or a retried sync writes a duplicate the append-only trigger then makes permanent.
   Put exactly that sentence in a file comment: the trigger T-07 installs blocks `UPDATE` and
   `DELETE`, not `ALTER TABLE`, so the columns can still be added — but only before the bad rows
   exist.

**Tests:** covered by T-09 against the real database.

**Done when:** `pnpm check` passes, both files use `{ withTimezone: true }` on every timestamp, and
the `audit_log` composite index is declared.

**Watch out:** `bigint('id', { mode: 'bigint' })` returns JavaScript `bigint` values, not `number`.
That is the correct choice for this project — invariant 1's habit of never letting a large integer
become a float starts here — but it means test assertions compare against `1n`, not `1`. Do not
"simplify" it to `mode: 'number'`.

---

### T-06 — Generate and apply the first business migration

**Needs:** T-02, T-04, T-05
**Files:**
- `src/lib/server/db/migrations/**` — NEW (generated; committed in full, including `meta/`)
**Spec:** 3 (database changes are the source of truth), 29 ("A backup is always taken before running
database migrations"; "database changes go through Drizzle migrations")
**Invariants:** 11 (timestamps stored UTC in `timestamptz`)

**Do:**

1. Run `pnpm db:generate`. Drizzle reads `src/lib/server/db/schema/` and writes one SQL file plus
   snapshot and journal entries under `src/lib/server/db/migrations/`.

2. **Read the generated SQL before applying it.** This is the first business migration in the project
   and it is the template every later one is compared against. Check, line by line:
   - every timestamp column says `timestamp with time zone`, not `timestamp`;
   - `users` has both check constraints, both partial unique indexes and the lower-case email index;
   - every foreign key says `ON DELETE RESTRICT` except `sessions.user_id`, which says
     `ON DELETE CASCADE`;
   - `audit_log.id` is `bigint generated always as identity`;
   - the composite index on `audit_log (restaurant_id, created_at desc)` is present;
   - there is no money column, no `numeric` column, and no `status` column anywhere.

   If any of those is wrong, fix the **schema file** and regenerate. Do not hand-edit generated SQL.

3. Apply it with `pnpm db:migrate`. That script chains `pnpm db:backup` first, which is spec 29's
   rule turned into a mechanism — let it run; do not call `drizzle-kit migrate` directly to skip it.
   After T-02 both the backup and the migration run as the owner role via `MIGRATE_DATABASE_URL`.

4. Verify against the live database, as the owner:

   ```bash
   psql "$MIGRATE_DATABASE_URL" -c '\d users'
   psql "$MIGRATE_DATABASE_URL" -c '\d audit_log'
   psql "$MIGRATE_DATABASE_URL" -c "select conname, pg_get_constraintdef(oid) from pg_constraint
                                    where conrelid='users'::regclass"
   ```

   `created_at` and every other timestamp must report `timestamp with time zone`. Both `users` check
   constraints must appear by name.

5. Verify the runtime role can actually use the new tables, which is what T-02's default privileges
   were for:

   ```bash
   psql "$DATABASE_URL" -c "select count(*) from users"        # must succeed, returns 0
   psql "$DATABASE_URL" -c "create table _t(x int)"            # must still fail
   ```

   If the first command fails with `permission denied for table users`, T-02's
   `ALTER DEFAULT PRIVILEGES` did not say `FOR ROLE matcami`. Fix the bootstrap, re-run it, and grant
   the existing tables explicitly; do not work around it by connecting as the owner.

6. Commit the entire `migrations/` directory including `meta/_journal.json` and the snapshot files.
   Never delete or edit a migration once it has run: Drizzle records a hash per migration and does not
   re-check it, so removing one silently diverges this database from every freshly built one.

**Tests:** none directly. T-09 turns the checks in steps 4 and 5 into automated ones.

**Done when:** `pnpm db:migrate` succeeds; a dump file appears under `backups/`; `\d users` shows both
check constraints and `timestamp with time zone`; `select count(*) from users` succeeds as
`matcami_app` and `create table` still fails as `matcami_app`; and the whole `migrations/` directory
is committed.

**Watch out:** if `drizzle-kit generate` reports that it found no schema, check that
`drizzle.config.ts`'s `schema` points at `./src/lib/server/db/schema` and that the files T-04 and
T-05 created are there. An empty or mis-pointed schema path generates an empty migration, which
applies cleanly and creates nothing — and the failure surfaces much later, as a missing table.

---

### T-07 — Custom migration: make `audit_log` append-only in the database

**Needs:** T-06
**Files:**
- `src/lib/server/db/migrations/**` — EXTEND (created by T-06; add ONE new custom migration. Do not
  touch the file T-06 generated)
**Spec:** 3 ("Posted records are permanent... never updated or deleted"; "Sensitive actions are
audit-logged"), 29 (database changes go through Drizzle migrations)
**Invariants:** 2 (posted records are permanent, corrected with a reversing record, never an `UPDATE`
or `DELETE` — not in app code, not in a repair script, not in a migration), 10 (sensitive actions are
audit-logged)

**Do:**

1. Generate the file the only way that registers it:

   ```bash
   pnpm exec drizzle-kit generate --custom --name=audit_log_append_only
   ```

   This is not a style preference. `drizzle-kit generate --custom` writes the file **and** records it
   in `migrations/meta/_journal.json`. A `.sql` file created by hand in that folder is never
   registered and is silently never applied — and the failure mode here is the worst kind: you would
   believe the audit log is tamper-proof while the database has no such trigger, and any test that
   checks "the database rejects an update" would fail for the right reason only by accident.

2. Write into the generated file a trigger function and a trigger:

   ```sql
   CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION 'audit_log is append-only: % on row is not permitted', TG_OP
       USING HINT = 'Correct a mistake with a new audit row, never by changing an existing one.';
   END;
   $$ LANGUAGE plpgsql;

   CREATE TRIGGER audit_log_no_update_or_delete
     BEFORE UPDATE OR DELETE ON audit_log
     FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
   ```

3. The trigger covers `UPDATE` and `DELETE` and deliberately **not** `TRUNCATE`. Write that decision
   into the migration as a SQL comment, with both halves of the reasoning:
   - `TRUNCATE` fires only statement-level triggers, so a row-level trigger would not catch it
     anyway; and
   - the integration harness (T-08) resets the test database by truncating, and a `BEFORE TRUNCATE`
     trigger would make every test run after the first one fail.
   - Production is protected by privilege instead: `TRUNCATE` requires the `TRUNCATE` privilege,
     which only the owner holds, and T-02 deliberately did not grant it to `matcami_app`. The
     application therefore cannot truncate the audit log even though the trigger does not mention it.

4. Apply with `pnpm db:migrate` and verify by trying both forbidden operations as the owner — the
   role with the most privilege, so that a pass here means a pass for everyone:

   ```bash
   psql "$MIGRATE_DATABASE_URL" -c "insert into audit_log
     (restaurant_id, event, details, occurred_at)
     select id, 'test.probe', '{}'::jsonb, now() from restaurants limit 1"
   psql "$MIGRATE_DATABASE_URL" -c "update audit_log set event='changed' where event='test.probe'"
   psql "$MIGRATE_DATABASE_URL" -c "delete from audit_log where event='test.probe'"
   ```

   The insert succeeds only if a restaurant exists; if none does yet, insert one in a transaction you
   roll back, or defer this check to T-09 where the harness provides fixtures. The `update` and the
   `delete` must both raise `audit_log is append-only`.

5. Commit both migration files and the updated `meta/_journal.json` together.

**Tests:** T-09 asserts both rejections in the integration project. That test is not optional.

**Done when:** `meta/_journal.json` lists two applied migrations; `UPDATE` and `DELETE` on
`audit_log` both raise an exception naming append-only; and `TRUNCATE audit_log` still succeeds as
the owner but fails as `matcami_app` with `permission denied`.

**Watch out:** the probe row in step 4 cannot be cleaned up — that is the point of the feature, and it
is why the probe belongs in the test database or inside a rolled-back transaction, not in
development data you care about.

---

### T-08 — Integration-test database harness: migrate and reset

**Needs:** T-06, T-07
**Files:**
- `src/lib/server/db/test/global-setup.ts` — NEW
- `src/lib/server/db/test/reset.ts` — NEW
- `vitest.config.ts` — EDIT (created by project-init T-09; add `globalSetup` to the `integration`
  project only, leaving the `unit` project untouched)
**Spec:** 29 (the six mandatory test areas; "Journal entries always balance" and "Permission checks on
every POS API" both require a real PostgreSQL, so this harness is what makes them possible later)
**Invariants:** 10 (the audit row is written in the same transaction as the action — only a real
database can prove that), 11 (UTC)

**Do:**

1. Understand the gap this closes. `pnpm db:migrate` migrates the database named by
   `MIGRATE_DATABASE_URL` only. project-init T-09's `integration-setup.ts` validates that
   `TEST_DATABASE_URL` ends in `_test` and refuses to run otherwise, but nothing has ever created a
   single table in `matcami_test`. Without this task, every integration test in this plan fails with
   `relation "restaurants" does not exist`.

2. Write `global-setup.ts`. Vitest runs a global setup **once per project run**, before any test file.
   It must:
   - read `TEST_DATABASE_URL`, and throw if it is unset or does not end in `_test` — repeat the
     guard rather than assume the setup file ran, because a global setup that silently targeted the
     development database would truncate real data;
   - open a `pg.Pool` against it;
   - apply migrations with Drizzle's **runtime** migrator, `migrate` from
     `drizzle-orm/node-postgres/migrator`, pointing `migrationsFolder` at
     `src/lib/server/db/migrations`. Use this rather than shelling out to `drizzle-kit`, because
     `drizzle-orm` is a runtime dependency and `drizzle-kit` is a dev dependency; the same choice
     makes the production migration path in T-26 possible.
   - close the pool.

   Do **not** use `drizzle-kit push` as a shortcut. `push` diffs the schema files straight into the
   database and never runs the custom migration, so the append-only trigger would be absent and
   T-09's rejection test would fail while the schema looked correct.

3. Write `reset.ts` exporting `resetDb()`. It truncates every table the schema defines, in one
   statement, with `RESTART IDENTITY CASCADE`:

   ```sql
   TRUNCATE audit_log, sessions, users, restaurant_settings, restaurants RESTART IDENTITY CASCADE;
   ```

   One statement, not five: the foreign keys are `RESTRICT`, so truncating them separately in the
   wrong order fails, and `CASCADE` in a single statement covers the set. Connect as the owner —
   `TEST_DATABASE_URL` points at `matcami` for exactly this reason (T-02 step 4).

   Add a comment listing the tables and stating that **every later plan that adds a tenant table must
   add it here**, or its rows leak between test files.

4. Wire `resetDb()` into the integration project. Prefer a `beforeEach` in a shared setup file over
   per-test calls, so a new test file cannot forget it. Keep project-init T-09's
   `fileParallelism: false` for the integration project: every file shares one database and parallel
   files would truncate each other's fixtures mid-test.

5. Do **not** implement per-test isolation by wrapping each test in a transaction that is rolled
   back. Two tests in this plan need genuinely committed, concurrent transactions: T-14's
   "two concurrent registrations, exactly one succeeds" and T-13's lockout test, which must observe a
   counter that survived a rejected login. A rollback wrapper makes both untestable.

6. Verify the harness the only way that means anything — by pointing it at the wrong database and
   confirming it refuses:

   ```bash
   TEST_DATABASE_URL="$MIGRATE_DATABASE_URL" pnpm test:integration    # must FAIL with the guard
   ```

**Tests:** this task builds the harness; T-09 is its first consumer. Write no assertions here beyond
the guard check in step 6.

**Done when:** `pnpm test:integration` sets up a fully migrated `matcami_test` including the
append-only trigger; running it twice in a row passes both times (proving the reset works); and
pointing `TEST_DATABASE_URL` at a database whose name does not end in `_test` fails with the guard's
message instead of running.

**Watch out:** a fail-closed guard that has never been seen to fail is indistinguishable from one
that does not work. Step 6 is not optional.

---

### T-09 — Schema guard tests every future aggregate inherits

**Needs:** T-08
**Files:**
- `src/lib/server/db/schema/schema.test.ts` — NEW
- `src/lib/server/db/schema/constraints.integration.test.ts` — NEW
**Spec:** 3 (money as integers; posted records permanent; journal entries must balance — the habits
this test protects), 17 (money in `bigint` minor units; quantities `numeric(12,3)`; timestamps UTC in
`timestamptz`), 29 (automated tests where mistakes cost money)
**Invariants:** 1 (money is integer minor units in `bigint`, never a float and never a `numeric` money
column), 2 (posted records are permanent), 11 (timestamps stored UTC in `timestamptz`)

**Do:**

1. Write `schema.test.ts` as a **unit** test that reflects over the Drizzle schema. Import every table
   from `src/lib/server/db/schema/`, and for each one use `getTableColumns()` to assert:

   - **Every tenant table has a `restaurant_id` column.** Exempt exactly three, each with the reason
     written in the test as a comment: `restaurants` (it *is* the tenant), `restaurant_settings` (its
     primary key is the restaurant id, under a different column name only if you renamed it — check
     the real name), and `sessions` (a session belongs to a user who belongs to a restaurant;
     duplicating the tenant here would create two places that can disagree). Write the exemption list
     as a named constant with a comment saying that **adding to this list is a plan's decision, never
     a convenience**.

   - **Every timestamp column is `timestamptz`.** Iterate the columns, and for any whose Drizzle
     column type is a PostgreSQL timestamp, assert its `withTimezone` property is `true`. This is the
     single most valuable line in the file: a bare `timestamp()` is the tutorial idiom, it emits
     `timestamp without time zone`, and node-postgres then parses the value in the Node process's
     local zone — so on a server running at UTC+3 every expiry and lock time silently reads three
     hours early, and once the POS session table copies the idiom, business-date grouping is off by
     the host offset with nothing failing loudly.

   - **No floating-point or unconstrained decimal column exists.** Assert no column is `real`,
     `double precision` or `numeric` without an explicit precision and scale. Money is integer minor
     units in `bigint` (invariant 1) and ingredient quantities are `numeric(12,3)`; anything else is
     a bug. This plan creates no such column, so the test passes trivially today and earns its keep
     the first time a later plan adds a price.

2. Write `constraints.integration.test.ts` as an **integration** test against the real database,
   because a constraint that exists only in a schema file proves nothing. Use the T-08 harness, and
   assert with real inserts:

   - Two users with emails `Owner@Cafe.com` and `owner@cafe.com` cannot both exist — the second
     insert violates the lower-case unique index.
   - Two users with `role = 'owner'` in the same restaurant cannot both exist.
   - A user with `role = 'owner'` and a null `email` or null `password_hash` is rejected by
     `users_owner_has_credentials`.
   - A user with `role = 'cashier'` and a non-null `email` or `password_hash` is rejected by
     `users_non_owner_has_no_credentials`.
   - Deleting a restaurant that has any user, settings row or audit row is rejected by the
     `RESTRICT` foreign keys.
   - Deleting a user cascades away that user's sessions and leaves their audit rows alone — the audit
     row's `actor_user_id` is `RESTRICT`, so the delete is in fact refused while audit rows reference
     them. Assert the refusal: an employee who has done anything cannot be deleted, only deactivated.
   - **MANDATORY:** `UPDATE audit_log SET event = ...` raises, and `DELETE FROM audit_log` raises.
     Both must be exercised; the trigger covers both operations and a test of only one would pass
     with a half-written trigger.

3. Every assertion must check the **error**, not merely that something threw. Assert on the
   constraint name or the message text, so a test cannot pass because an unrelated failure happened
   first.

**Tests:** the files above are the tests. Mark the two `audit_log` rejection cases and the
timestamp-column assertion as the ones that must never be deleted; they are what make invariants 2
and 11 real rather than aspirational.

**Done when:** `pnpm test` passes both projects; deliberately changing one schema column to a bare
`timestamp()` makes `schema.test.ts` fail; deliberately removing the `restaurant_id` column from a
table makes it fail; and both `audit_log` mutation attempts raise in the integration test.

**Watch out:** write the `restaurant_id` assertion so it discovers tables automatically from the
schema module's exports rather than from a hand-maintained list. A hand-maintained list is a list
someone forgets to update, which is exactly the failure the test exists to prevent.
