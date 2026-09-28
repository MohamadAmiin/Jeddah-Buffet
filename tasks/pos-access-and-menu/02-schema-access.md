# Phase 1 — Schema, access half

Everything the POS access half needs from the database, and nothing the money half needs: the
`pos_devices` table, the PIN columns on `users`, the `device_id` + `client_op_id` pair on `audit_log`
that a retried device operation deduplicates on, and one nullable idle-lock setting. The four schema
tasks write **schema files only**; a single generated migration lands at the end (T-09) and the
database-level assertions land after it (T-10). No price column, no tax column and no currency column
appears anywhere in this phase — those are open decisions 3 and 4 and belong to T-36 and T-37.

**Depends on:** Phase 0 (T-01 money-module placement, T-02 the `/pos` URL prefix and service-worker
policy, T-03 the four recorded decisions, T-04 the strengthened schema guard).

> **Read before running T-05.** T-05 to T-08 edit schema files and deliberately do **not** generate a
> migration. Between T-05 and T-09 the integration project (`pnpm test:integration`) and the e2e
> journey **will fail**, because the test database has no `pos_devices` table, no `pin_hash` column
> and no `pos_idle_lock_seconds` column yet — `resetDb()` itself raises `relation "pos_devices" does
> not exist` from T-05 onward, for the same reason. The **unit** project (`pnpm test:unit`) stays
> green throughout, and every task below demands that it does: T-04's guard cases hold `TABLES`, the
> discovery array and `IMPORTED_SCHEMA_FILES` to one another, so T-05 moves all three at once rather
> than leaving the unit suite red for four tasks. The integration failure is expected and is exactly
> what T-09 fixes. Do not "repair" it by running `pnpm db:generate` early: this phase ships **one**
> migration, and a migration that has run can never be hand-edited (invariant 2).

---

### T-05 — Create the `pos_devices` table

**Needs:** T-02 (the `/pos` URL prefix and the service-worker registration policy), T-04 (the schema
guard now requires `bigint` for money and notices a schema file nothing imports)
**Files:**

- `src/lib/server/db/schema/pos-devices.ts` — NEW
- `src/lib/server/db/schema-guards/schema.test.ts` — EDIT (four small edits, described in step 8: the
  import block at the top, the `IMPORTED_SCHEMA_FILES` constant T-04 put beside it, the `modules`
  object spread, and the sorted array inside `it('discovers the tables it is meant to guard')`.
  Change nothing in that file beyond those four)
- `src/lib/server/db/test/reset.ts` — EDIT (step 9: the exported `TABLES` const and the comment
  listing the tables just above it. Change nothing else in that file)

**Spec:** 7 (POS device registration — the owner logs in on the device with email + password, the
server issues a long-lived HttpOnly + Secure device cookie, "PIN login accepted only from registered
devices", and "the owner can revoke a device from the dashboard"), 6 (invoice numbers come from the
device's own prefix — `POS1-000001` — and "a second terminal later simply gets its own prefix
(`POS2-…`)"), 9 (the registered POS device is a cookie, HttpOnly + Secure + SameSite, never
`localStorage`), 33 (open decision 1 — one device now, a tablet becomes terminal 2 later)
**Invariants:** 12 (POS access = registered device + PIN; the device cookie is long-lived, HttpOnly +
Secure, and revocable from the dashboard), 11 (timestamps are `timestamptz`, stored UTC), 2 (posted
records are permanent — revocation is a stamp, never a `DELETE`), 5 (leave the seam: `device_id` on
POS-created rows so a second terminal is a data change, not a rewrite)

**Do:**

1. Create `src/lib/server/db/schema/pos-devices.ts` with these imports and nothing else:
   `import { sql } from 'drizzle-orm';`,
   `import { pgTable, uuid, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';`,
   `import { restaurants } from './restaurants';`, `import { users } from './users';`.
2. Export exactly one table, `posDevices`, with these columns — types verbatim:

   ```ts
   export const posDevices = pgTable(
   	'pos_devices',
   	{
   		id: uuid('id').primaryKey().defaultRandom(),
   		restaurantId: uuid('restaurant_id')
   			.notNull()
   			.references(() => restaurants.id, { onDelete: 'restrict' }),
   		// The invoice prefix. 'POS1' today; 'POS2' is a data change, not a rewrite.
   		deviceCode: text('device_code').notNull(),
   		// Human label shown in the dashboard device list, e.g. 'Counter tablet'.
   		label: text('label').notNull(),
   		// NOT the cookie value: the lowercase hex SHA-256 of the random device token,
   		// exactly as sessions.id is for the auth session. 64 characters.
   		tokenHash: text('token_hash').notNull(),
   		registeredByUserId: uuid('registered_by_user_id')
   			.notNull()
   			.references(() => users.id, { onDelete: 'restrict' }),
   		registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
   		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
   		revokedAt: timestamp('revoked_at', { withTimezone: true }),
   		revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
   			onDelete: 'restrict'
   		})
   	},
   	(table) => [
   		uniqueIndex('pos_devices_token_hash_unique').on(table.tokenHash),
   		uniqueIndex('pos_devices_restaurant_device_code_unique').on(table.restaurantId, table.deviceCode),
   		check('pos_devices_device_code_format', sql`${table.deviceCode} ~ '^[A-Z0-9]{1,8}$'`),
   		index('pos_devices_restaurant_id_idx').on(table.restaurantId)
   	]
   );
   ```

3. Write the `token_hash` comment in the file: the browser holds the random token in the device
   cookie; the database holds only its lowercase hex SHA-256, so a database leak yields hashes rather
   than usable devices. `src/lib/server/db/schema/sessions.ts` already does this for the auth session
   — copy the idiom, not a second one. T-13 owns the derivation and the cookie attributes.
4. Write the revocation comment: **revocation is the `revoked_at` / `revoked_by_user_id` stamp, never
   a `DELETE`.** `audit_log.device_id` (T-07) references this table with `ON DELETE RESTRICT`, so a
   device that has ever produced an audit row cannot be deleted at all — and must not be, or the
   trail of who was signed in on which till loses its subject. "Active" means `revoked_at is null`;
   every query that decides whether a device may show the PIN screen filters on that.
5. Write the `device_code` comment: it is the invoice prefix from spec 6 (`POS1-000001`). The CHECK
   allows 1–8 uppercase letters and digits, so the code is safe to print on a 32-character receipt
   line. T-13 assigns it; the value for the first device is the literal `POS1`, uppercase.
6. Do **not** add a constraint limiting a restaurant to one active device. Open decision 1 defaults
   to one device, and the whole point of `device_code` is that terminal 2 is a data change. Record
   that refusal in the file as a comment so nobody "tightens" it later.
7. Do **not** add `updated_at`. Nothing updates a device row except the two stamps above, each of
   which carries its own timestamp and actor.
8. Wire the schema guard in `src/lib/server/db/schema-guards/schema.test.ts`, **four** edits, and
   all four are load-bearing — T-04 strengthened this file so that a new schema file cannot land
   quietly, which means a new schema file now turns the unit suite red until every one is made:
   add `import * as posDevicesSchema from '../schema/pos-devices';` below the existing
   `import * as auditSchema from '../schema/audit';`; add `'pos-devices.ts'` to the
   `IMPORTED_SCHEMA_FILES` constant T-04 put beside those imports — its
   `it('imports every file in src/lib/server/db/schema')` case `readdirSync()`s the schema folder
   and fails until the new **file name** is listed there too, and it sorts both sides, so the
   position in the array does not matter; add `...posDevicesSchema` to the `modules` object; add
   `'pos_devices'` to the sorted array in `it('discovers the tables it is meant to
   guard')` so it reads `['audit_log', 'pos_devices', 'restaurant_settings', 'restaurants',
   'sessions', 'users']`. `pos_devices` carries `restaurant_id`, so it needs **no** entry in
   `TENANT_COLUMN_EXEMPT` — adding one there would be wrong.
9. Add `'pos_devices'` to the exported `TABLES` const in `src/lib/server/db/test/reset.ts` **in this
   same task**, and to the comment listing the tables above it, so both lists read the same six
   names: `['audit_log', 'sessions', 'pos_devices', 'users', 'restaurant_settings', 'restaurants']`.
   This is not T-10's job to do first: T-04's third case,
   `it('truncates every table it guards')`, asserts `[...TABLES].sort()` equals the discovered table
   names, so the discovery array in step 8 and this list must move **together** or `pnpm test:unit`
   goes red — and steps 8 and 9 are one edit split across two files, not two tasks. Adding it here
   is safe: `resetDb()` only runs its `TRUNCATE` in the integration project, which this phase's
   preamble already declares red until T-09 creates the table. T-10 re-confirms both lists rather
   than making either edit. `pos_devices` sits **after** `audit_log` (which references it) and
   **before** `users` and `restaurants` (which it references) — child-first, like the rest of the
   list, though the single `TRUNCATE` statement makes the order irrelevant.
10. Do **not** run `pnpm db:generate`. T-09 generates the one migration for this whole phase.

**Tests:**

- The existing unit schema guard is this task's test and must stay green: it asserts the table is
  discovered, that it carries `restaurant_id`, that `registered_at`, `last_seen_at` and `revoked_at`
  are `timestamptz` (invariant 11), and that no float or unconstrained `numeric` column exists.
  Run `pnpm test:unit`.
- T-04's two newer cases in that same file are what steps 8 and 9 keep green, and each names the
  edit it is missing: `it('imports every file in src/lib/server/db/schema')` fails until
  `'pos-devices.ts'` is in `IMPORTED_SCHEMA_FILES`, and `it('truncates every table it guards')`
  fails until `'pos_devices'` is in `TABLES` as well as in the discovery array. Neither needs a new
  test written here — they are the reason both lists move in this task.
- No integration test here: `pos_devices` does not exist in any database until T-09 runs the
  migration. The `UNIQUE` and `CHECK` assertions against the real database are T-10's.

**Done when:** `pnpm check`, `pnpm lint` and `pnpm test:unit` all pass, and `git status` shows **no**
new file under `src/lib/server/db/migrations/`.

**Watch out:** `pos_devices_restaurant_device_code_unique` is deliberately **not** partial on
`revoked_at is null`. Reusing `POS1` after revoking the first device would put two devices behind one
printed invoice prefix, and `POS1-000001` would then name two different sales — the database-level
`UNIQUE (device_id, invoice_number)` a later plan adds could not catch it, because the device ids
differ. So the code is burned: after revoking `POS1`, the next registration takes `POS2`. T-13 and
T-29 must allocate the next unused code rather than reuse one, and the CHECK plus this index are what
make that a loud failure rather than a silent duplicate.

---

### T-06 — Add the PIN columns to `users`

**Needs:** T-03 (the recorded PIN-hash decision), T-04 (the strengthened schema guard)
**Files:**

- `src/lib/server/db/schema/users.ts` — EDIT (replace the comment block headed
  `// THERE IS DELIBERATELY NO \`pin_hash\` COLUMN.` that sits immediately above
  `export const users = pgTable(`; add three columns inside the existing column object, directly
  after `passwordLockedUntil` and before `createdAt`. Change no existing column, index or CHECK)

**Spec:** 7 (PIN rules — "PINs are 4–6 digits, stored only as slow salted hashes (e.g. Argon2 or
bcrypt)", "After 5 wrong attempts, the employee is locked out for 5 minutes and an audit event is
logged", and "The owner also has a POS PIN, used to approve sensitive actions (section 8)"),
6 ("Switching employees offline uses PIN hashes cached on the registered device (slow, salted hashes,
refreshed on each sync)" — so the algorithm must be verifiable **in the browser**)
**Invariants:** 12 (PINs are 4–6 digits, stored ONLY as slow salted hashes, never reversible, never
logged; 5 wrong attempts lock the employee out for 5 minutes and write an audit event), 9 (owner PIN
approval for refunds, voids of SENT items, over-limit discounts, comps and re-opens — the owner PIN
this invariant depends on is the column added here), 11 (timestamps are `timestamptz`)

**Do:**

1. Open `src/lib/server/db/schema/users.ts` and read the comment above the table. It says the column
   was omitted because "Spec 6 requires employee PINs to be verified OFFLINE IN THE BROWSER from
   hashes cached on the registered device. The POS plan must therefore choose an algorithm available
   in WebCrypto or WASM, which may not be the server-side argon2id parameters T-10 uses for
   passwords." **That choice has now been made by T-03.** Replace the whole block with a comment
   recording it. If T-03's record differs from the default below, the record wins and the comment
   states what T-03 actually decided.
   **Beware the task-ID collision inside that quote: its `T-10` is an ID from the EARLIER
   `restaurant-identity-and-dashboard` plan, not this plan's T-10** ("Wire the new tables into the
   schema guard and the test reset list", which hashes nothing). The argon2id parameters the comment
   means are in `src/lib/server/auth/password.ts` — `ARGON2_MEMORY` / `ARGON2_PASSES` /
   `ARGON2_PARALLELISM`, OWASP's `m=19456,t=2,p=1`. Do not go looking for them in this plan's T-10.
2. The default T-03 carries: **PBKDF2-HMAC-SHA256 at 600,000 iterations** through
   `crypto.subtle.deriveBits`, implemented once in an isomorphic `src/lib/pin/` module (T-11) used by
   both the server and the offline till. WebCrypto has **no** Argon2, and
   `src/lib/server/auth/password.ts` uses `node:crypto`'s built-in argon2id, which has no browser
   build — so the PIN hash cannot reuse the password hash. Spec 7's "e.g. Argon2 or bcrypt" names
   examples, not a closed list, and PBKDF2 at the OWASP work factor is a slow salted hash.
3. Say in the comment that the value is a **PHC-style string carrying its own parameters** —
   `$pbkdf2-sha256$i=600000$<salt>$<tag>` — exactly as `password.ts` stores
   `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`, so the iteration count can be raised later without
   invalidating stored hashes. That is why the column is `text` and not `bytea`.
4. Add the three columns, types verbatim:

   ```ts
   pinHash: text('pin_hash'),
   failedPinCount: integer('failed_pin_count').notNull().default(0),
   pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
   ```

   All three imports (`text`, `integer`, `timestamp`) are already in the file's import list.
5. Say in the comment why this is a **separate pair** from `failed_password_count` /
   `password_locked_until`: five wrong PINs typed at the counter must not lock the owner out of the
   dashboard, and a password lockout must not stop the cashier taking money. The two surfaces lock
   independently; T-12 owns the PIN pair and must never touch the password pair.
6. Say explicitly that **the owner MAY have a `pin_hash`**, because spec 7 gives the owner a POS PIN
   used to approve sensitive actions. `pin_hash` is therefore orthogonal to the existing
   `users_non_owner_has_no_credentials` CHECK
   (`role = 'owner' or (email is null and password_hash is null)`), which is about email and password
   only.
7. Add **no** new CHECK constraint. In particular do not write "a cashier must have a pin_hash": an
   employee is created before their PIN is set, and a CHECK that contradicts
   `users_non_owner_has_no_credentials` or forbids a half-configured employee can only be undone by a
   second migration. All three columns are nullable or defaulted so the migration applies to the
   existing owner row without touching it.
8. Do **not** run `pnpm db:generate`. T-09 generates the one migration for this phase.

**Tests:**

- The existing unit schema guard is this task's test: `pin_locked_until` is picked up automatically
  by `it('every timestamp column is timestamptz (invariant 11)')`, and a bare
  `timestamp('pin_locked_until')` fails it. Run `pnpm test:unit`.
- No integration test here — the columns do not exist in `matcami_test` until T-09 runs the
  migration. T-10 adds the database-level cases (a cashier may carry a `pin_hash` with no email and
  no password; the owner may carry a `password_hash` **and** a `pin_hash`).

**Done when:** `pnpm check`, `pnpm lint` and `pnpm test:unit` pass; `git diff` on `users.ts` shows
exactly three added columns and one replaced comment, with no change to `users_email_lower_unique`,
`users_one_owner_per_restaurant`, `users_owner_has_credentials`,
`users_non_owner_has_no_credentials` or `users_restaurant_id_idx`.

**Watch out:** the PIN and its hash must never reach the audit log.
`assertNoSecrets()` in `src/lib/server/audit/index.ts` walks `details` at every depth and **throws**
on any key matching `/pass|pin|token|hash|secret|cookie|authorization/i` — so an audit `details` key
named `pin`, `pinHash` or `tokenHash` is a runtime error, by design (invariant 12: never reversible,
never logged). If T-03 answered the `RESEARCH.md` gap by requiring **6 digits** rather than spec 7's
4–6, that is a validation bound in T-11/T-12, not a column change: nothing here encodes PIN length.

---

### T-07 — Add `device_id` and `client_op_id` to `audit_log` with a partial UNIQUE

**Needs:** T-05 (`pos_devices` exists as a schema file to reference)
**Files:**

- `src/lib/server/db/schema/audit.ts` — EDIT (rewrite the `device_id, client_op_id` paragraph inside
  the `NOT ADDED HERE, and expected rather than forgotten:` comment block, keeping the
  `approver_user_id, reason_code` paragraph untouched; add two columns after `userAgent` and before
  `occurredAt`; add one index entry beside `audit_log_restaurant_created_idx`)

**Spec:** 6 (idempotency keys — "Every operation carries a unique ID generated on the device, so the
server ignores duplicates when a sync is retried", and "Offline logins are recorded locally and
synced to the audit log"), 3 (sensitive actions are audit-logged: logins, failed PINs, voids,
refunds, approvals), 7 (PIN login is accepted only from a registered device, so the device belongs in
the trail)
**Invariants:** 5 (every queued operation carries a device-generated idempotency key; **a retry MUST
be a no-op**), 2 (posted records are permanent — migration `0004_audit_log_append_only.sql` blocks
`UPDATE` and `DELETE` on this table), 10 (sensitive actions are audit-logged, in the same transaction
as the action), 11 (timestamps are `timestamptz`)

**Do:**

1. Read the comment already in `src/lib/server/db/schema/audit.ts`. It requires this task by name:
   *"device_id, client_op_id — the offline sync plan must add both, plus a partial UNIQUE (device_id,
   client_op_id), BEFORE the first device-sourced audit row is written, or a retried sync writes a
   duplicate that the append-only trigger then makes permanent. The trigger T-07 installs blocks
   UPDATE and DELETE, not ALTER TABLE, so the columns can still be added — but only before the bad
   rows exist."* **Beware the task-ID collision inside that quote: its `T-07` is an ID from the
   EARLIER `restaurant-identity-and-dashboard` plan, not this task.** That trigger is already
   installed, by the committed migration `0004_audit_log_append_only.sql`; **this task installs no
   trigger and writes no SQL at all** — it edits a schema file, and T-09 generates the one migration
   for the phase. What the quote still tells you is the part that matters: the trigger blocks
   `UPDATE` and `DELETE` but not `ALTER TABLE`, so these two columns can still be added — but only
   while no duplicate rows exist yet.
   **This plan writes the first device-sourced rows** (T-19's PIN logins and T-18's device
   registration), so the columns land now. Replace that paragraph with one saying they have landed
   and why.
2. Extend the imports: `import { desc, sql } from 'drizzle-orm';`, add `uniqueIndex` to the
   `drizzle-orm/pg-core` import list, and add `import { posDevices } from './pos-devices';`.
3. Add the two columns, types verbatim:

   ```ts
   // Which registered till produced this row. Null for every dashboard event.
   deviceId: uuid('device_id').references(() => posDevices.id, { onDelete: 'restrict' }),
   // The device-generated idempotency key for the operation that produced this row.
   // Null for anything the server originated.
   clientOpId: text('client_op_id'),
   ```

4. Add the partial unique index to the array returned by the table's second argument, beside
   `audit_log_restaurant_created_idx`:

   ```ts
   uniqueIndex('audit_log_device_client_op_unique')
   	.on(table.deviceId, table.clientOpId)
   	.where(sql`${table.clientOpId} is not null`),
   ```

5. Write the failure this prevents into the comment, concretely: the till flushes a queued offline
   PIN-login event, the server commits it, and the response is lost on the way back. The till retries
   — that is what a sync queue does. With no key to deduplicate on, the second insert succeeds and
   the audit log now says the cashier signed in twice at the same instant. `0004`'s trigger blocks
   `UPDATE` and `DELETE`, so **that duplicate is permanent**: it cannot be merged, edited or removed,
   and every later "who was on the till" answer is wrong for that shift.
6. Both columns are nullable with **no** `DEFAULT`: every audit row written so far came from the
   dashboard and has no device. The FK is `restrict` like every other foreign key in the schema
   except `sessions.user_id` — a device that has produced an audit row can never be deleted, which is
   precisely why T-05 revokes with a stamp.
7. This task changes the schema only. The writer `writeAudit()` in `src/lib/server/audit/index.ts`
   gains its `deviceId` / `clientOpId` fields in T-14, together with the POS event variants — do not
   edit `audit/index.ts` or `audit/events.ts` here.
8. Do **not** run `pnpm db:generate`. T-09 generates the one migration for this phase.

**Tests:**

- The unit schema guard covers the new columns (tenant column present, no float, timestamps
  unchanged). Run `pnpm test:unit`.
- No integration test here — the columns do not exist in `matcami_test` until T-09. T-10 proves the
  partial UNIQUE actually rejects a duplicate at the database, and that ordinary device-less rows are
  unaffected.

**Done when:** `pnpm check`, `pnpm lint` and `pnpm test:unit` pass; `git diff` on `audit.ts` shows two
added columns, one added index and one rewritten comment paragraph, with
`audit_log_restaurant_created_idx`, `occurredAt` and `createdAt` unchanged.

**Watch out:** PostgreSQL's default `NULLS DISTINCT` means two rows with the same `device_id` and
`client_op_id = NULL` never collide — which is what makes this index safe to add to a table full of
dashboard rows. Do **not** "improve" it with `NULLS NOT DISTINCT`: that would make the second
device-less audit row of any kind fail. The `where client_op_id is not null` predicate is what keeps
the index small; a row with a `client_op_id` but no `device_id` is likewise never deduplicated, and
that is correct, because a client op id is unique **per device**, not globally.

---

### T-08 — Add the nullable idle-lock setting to `restaurant_settings`

**Needs:** T-03 (open decision 6 — lock timing — obtained and recorded)
**Files:**

- `src/lib/server/db/schema/restaurant-settings.ts` — EDIT (the
  `WHAT MUST NOT BE ADDED HERE, AND WHY` comment block, and the column object)
- `src/lib/server/restaurants/index.ts` — EDIT (the `RestaurantWithSettings` type, the `select` inside
  `getRestaurantWithSettings`, `SettingsChanges`, `UpdateSettingsResult`, the body of
  `updateSettings`, `settingsComplete`, and the closing comment on the last two lines)
- `src/lib/server/restaurants/settings.integration.test.ts` — EDIT (the `describe('settingsComplete')`
  block near the end)
- `e2e/auth.spec.ts` — EDIT (step 3's checklist assertion,
  `await expect(page.getByText('not started', { exact: true })).toHaveCount(5);` and the three comment
  lines above it)

**Spec:** 7 ("The POS returns to the employee selection screen after a set idle time (default 2
minutes, configurable)"), 33 (open decision 6 — approval limits and lock timing; recommended default
"auto-lock after 2 minutes idle"), 10 (POS sessions — a cashier shift is what the lock protects)
**Invariants:** 12 (the POS returns to employee-select after idle, default 2 minutes, **configurable**
— so it is a setting, never a constant in the POS code), 10 (a settings change writes its audit row
in the **same transaction** as the change)

**Do:**

1. Read the comment at the top of `src/lib/server/db/schema/restaurant-settings.ts` before touching
   it. It says tax mode, tax rate, currency, approval limits and idle-lock seconds must not be added
   "with a sensible default", and that when they arrive "they land NULLABLE, with POS session-open
   gated on `settingsComplete()`, never with a column DEFAULT — a DEFAULT silently answers the open
   decision for every restaurant already registered". Follow it exactly.
2. Add `integer` to the `drizzle-orm/pg-core` import and add one column to the table:
   `posIdleLockSeconds: integer('pos_idle_lock_seconds')`. No `.notNull()`, no `.default()`.
   Rewrite the comment so it records that idle-lock seconds has landed **nullable** per T-03's
   record, and that tax mode, tax rate, currency and approval limits are still forbidden here — tax
   mode and currency arrive in T-36, after open decisions 3 and 4 are answered.
3. In `src/lib/server/restaurants/index.ts`, add `posIdleLockSeconds: number | null` to the
   `RestaurantWithSettings` type and `posIdleLockSeconds: restaurantSettings.posIdleLockSeconds` to
   the `select({...})` inside `getRestaurantWithSettings`. T-26's PIN screen reads the value through
   this function; nothing in the POS may hardcode 120.
4. Extend `settingsComplete()`: after the time-zone check, `if (current.posIdleLockSeconds === null)
   missing.push('POS idle lock');`. Update the function's doc comment — it already says "EVERY LATER
   PLAN THAT ADDS A REQUIRED SETTING MUST ADD IT TO THIS FUNCTION'S LIST". **T-29 gates POS device
   registration on `settingsComplete()`**: a till whose idle lock nobody chose must not be registered,
   because the screen that protects the drawer would have no timeout to honour.
5. Give the setting its one audited writer, in `updateSettings()`, so nothing else ever writes the
   column directly:
   - `SettingsChanges` gains `posIdleLockSeconds?: number`.
   - `UpdateSettingsResult`'s failure reason union gains `'invalid_idle_lock'`.
   - Validate before diffing: reject anything that is not an integer between **30 and 1800 seconds
     inclusive** with `{ ok: false, reason: 'invalid_idle_lock' }`. Under 30 seconds the till locks
     while the cashier is counting change; over 30 minutes it is not a lock. This is a **sanity
     bound, not a default** — if T-03 recorded a different bound, use T-03's and say so in the commit
     message.
   - When it differs from the stored value, add `posIdleLockSeconds: { old, new }` to `diff`.
   - Then widen the guard around the write. **There is no unconditional
     `tx.update(restaurantSettings)` call in this file** — the only one sits inside a time-zone
     guard, at `src/lib/server/restaurants/index.ts` lines 119–124:

     ```ts
     if (diff.timeZone) {
     	await tx
     		.update(restaurantSettings)
     		.set({ timeZone: canonical!, updatedAt: now })
     		.where(eq(restaurantSettings.restaurantId, restaurantId));
     }
     ```

     Change the condition to `if (diff.timeZone || diff.posIdleLockSeconds)` **and** make the `.set()`
     payload conditional in the same edit:

     ```ts
     if (diff.timeZone || diff.posIdleLockSeconds) {
     	await tx
     		.update(restaurantSettings)
     		.set({
     			...(diff.timeZone ? { timeZone: canonical! } : {}),
     			...(diff.posIdleLockSeconds
     				? { posIdleLockSeconds: changes.posIdleLockSeconds! }
     				: {}),
     			updatedAt: now
     		})
     		.where(eq(restaurantSettings.restaurantId, restaurantId));
     }
     ```

     Both halves of that edit are load-bearing, and skipping either is silent:
     - Adding `posIdleLockSeconds` to the `.set()` **without** widening the condition means an
       idle-lock-only call — `updateSettings(tx, id, { posIdleLockSeconds: 120 }, ctx)`, which is
       exactly what T-29's POS page sends — returns `{ ok: true, changed: true }` and writes the
       `settings.updated` audit row while writing **nothing to the database**. Step 4 makes
       `settingsComplete()` depend on this column and T-29 gates POS device registration on
       `settingsComplete()`, so the owner could never register a till. The Tests bullet below
       (`settingsComplete` → `{ complete: true, missing: [] }` after the update) is what fails, and
       it fails pointing at the wrong function.
     - Widening the condition **without** making the payload conditional is the mirror failure: on a
       call that changes only the idle lock, `canonical` is `undefined`, so
       `.set({ timeZone: canonical! })` blanks the stored time zone — and the time zone decides which
       business date every sale belongs to (invariant 11).
   - Let the existing `writeAudit(tx, { event: 'settings.updated', details: { changes: diff } })`
     carry the diff — same transaction, one audit row (invariant 10). Do not add a new audit event
     name.
6. Fix the existing expectation in `src/lib/server/restaurants/settings.integration.test.ts`: the
   case `it('is complete straight after registration')` asserts
   `{ complete: true, missing: [] }` and is now wrong — a freshly registered restaurant has a null
   idle lock. It becomes `{ complete: false, missing: ['POS idle lock'] }`, and its name changes to
   say so.
7. Fix `e2e/auth.spec.ts`. The dashboard checklist's first step is
   `done: data.settings.complete`, so the "Restaurant settings" step now renders `not started` with
   the detail line `Still needed: POS idle lock.` — the count in
   `getByText('not started', { exact: true })` goes from **5 to 6**. Update the assertion and the
   comment above it (which currently reads "The settings step is done; the other five are not
   started"). Leave the `exact: true` alone: each step renders the phrase twice, once visibly and
   once screen-reader-only, so a loose match counts double.
8. Do **not** add tax mode, tax rate, currency or approval limits. Do **not** give the column a
   `DEFAULT`, and do **not** write a `?? 120` fallback anywhere in the code — a fallback is a column
   default wearing a disguise, and it answers open decision 6 for an owner who never chose.

**Tests:** (all in `src/lib/server/restaurants/settings.integration.test.ts`)

- `settingsComplete` straight after registration → `{ complete: false, missing: ['POS idle lock'] }`
  (the rewritten existing case).
- `updateSettings(tx, id, { posIdleLockSeconds: 120 }, ctx)` → `{ ok: true, changed: true }`, then
  `settingsComplete` → `{ complete: true, missing: [] }`, and **exactly one** `audit_log` row whose
  `details.changes` is `{ posIdleLockSeconds: { old: null, new: 120 } }`.
- `posIdleLockSeconds: 29` and `posIdleLockSeconds: 1801` → `{ ok: false, reason: 'invalid_idle_lock' }`
  and **zero** audit rows written.
- Re-submitting the same value → `{ ok: true, changed: false }` and no audit row, matching the
  existing no-op behaviour for `name` and `timeZone`.

**Done when:** `pnpm check`, `pnpm lint` and `pnpm test:unit` pass. The integration and e2e suites
stay **red until T-09 has run the migration** — `pos_idle_lock_seconds` does not exist in
`matcami_test` yet, so `getRestaurantWithSettings` cannot select it. Re-run `pnpm test` and
`pnpm test:e2e` at the end of T-09 and both must be green then.

**Watch out:** nothing in the access half writes this value until T-29's dashboard POS page. T-29 must
render an "auto-lock after" field and call `updateSettings()` — never
`tx.update(restaurantSettings)` directly, which would change a setting with no audit row and break
invariant 10 — or the owner can never satisfy `settingsComplete()` and can never register the till.
The settings form action at `src/routes/(dashboard)/settings/+page.server.ts` needs no change here:
its failure branch is a ternary on `result.reason === 'invalid_time_zone'` with a generic fallback
message, so the new reason compiles and degrades to "Those settings could not be saved."

---

### T-09 — Generate and run the access migration

**Needs:** T-05 (`pos_devices`), T-06 (PIN columns), T-07 (`audit_log` device columns), T-08
(`pos_idle_lock_seconds`)
**Files:**

- `src/lib/server/db/migrations/0005_<drizzle-generated-name>.sql` — NEW (generated by drizzle-kit,
  never hand-written)
- `src/lib/server/db/migrations/meta/0005_snapshot.json` — NEW (generated)
- `src/lib/server/db/migrations/meta/_journal.json` — EDIT (generated: one new entry, `idx: 5`)

**Spec:** 29 (Operations — "A backup is always taken before running database migrations"; deployment
database changes go through Drizzle migrations), 3 (PostgreSQL is the primary source of truth,
Drizzle is the ORM)
**Invariants:** 2 (posted records are permanent; a migration that has run is never hand-edited — a
correction is a NEW migration), 11 (every timestamp column is `timestamptz`)

**Do:**

1. `nvm use` first — `engines` refuses anything but Node 24.21.0. Then `pnpm db:generate`, which runs
   `drizzle-kit generate` against `./src/lib/server/db/schema` and writes into
   `./src/lib/server/db/migrations` (see `drizzle.config.ts`). It produces one `0005_*.sql`, one
   `meta/0005_snapshot.json`, and one new entry in `meta/_journal.json`.
2. **Read the generated SQL before running anything.** Check it against this list:
   - `CREATE TABLE "pos_devices"` with `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
     `device_code text NOT NULL`, `label text NOT NULL`, `token_hash text NOT NULL`,
     `registered_by_user_id uuid NOT NULL`, and `registered_at`, `last_seen_at`, `revoked_at` all
     spelled **`timestamp with time zone`** — a bare `timestamp` anywhere is a bug, stop and fix the
     schema file.
   - Three foreign keys on `pos_devices` — to `restaurants` and twice to `users` — every one
     `ON DELETE RESTRICT`, and a `CHECK` named `pos_devices_device_code_format`.
   - `CREATE UNIQUE INDEX "pos_devices_token_hash_unique"` and
     `CREATE UNIQUE INDEX "pos_devices_restaurant_device_code_unique"` on
     `("restaurant_id","device_code")` with **no** `WHERE` clause, plus
     `CREATE INDEX "pos_devices_restaurant_id_idx"`.
   - `ALTER TABLE "users" ADD COLUMN "pin_hash" text;`,
     `ADD COLUMN "failed_pin_count" integer DEFAULT 0 NOT NULL;`,
     `ADD COLUMN "pin_locked_until" timestamp with time zone;` — and **no** change to any existing
     `users` column, index or CHECK.
   - `ALTER TABLE "audit_log" ADD COLUMN "device_id" uuid;` and `ADD COLUMN "client_op_id" text;`,
     its FK to `pos_devices` `ON DELETE RESTRICT`, and
     `CREATE UNIQUE INDEX "audit_log_device_client_op_unique" ON "audit_log" ("device_id","client_op_id") WHERE "audit_log"."client_op_id" is not null;`
     — **the `WHERE` clause must be present**; without it the index is not the partial one T-07
     specified.
   - `ALTER TABLE "restaurant_settings" ADD COLUMN "pos_idle_lock_seconds" integer;` — with **no**
     `DEFAULT` and no `NOT NULL`. A `DEFAULT` here answers open decision 6 for every restaurant
     already registered; if drizzle emitted one, the schema file has a `.default()` on it — remove it
     and regenerate.
   - Nothing else: no `DROP`, no `ALTER COLUMN`, no touching of
     `CREATE TRIGGER audit_log_no_update_or_delete` from `0004_audit_log_append_only.sql`.
3. If anything on that list is wrong, fix the **schema file** and regenerate. A generated migration
   that has **not yet run** may be deleted: remove the `0005_*.sql`, remove `meta/0005_snapshot.json`,
   remove its entry from `meta/_journal.json`, then run `pnpm db:generate` again. Once step 4 has run
   it, that option is gone — a correction is then a new `0006` migration (invariant 2).
4. Run `pnpm db:migrate`. It runs `pnpm db:backup` **first, automatically** (spec 29), which
   `pg_dump`s into `backups/`, then `drizzle-kit migrate` applies `0005` to `MIGRATE_DATABASE_URL` —
   the owner role `matcami`, not the runtime role. Confirm a new dump appeared in `backups/`.
5. Verify against the real database, not the migration text:
   `psql "$MIGRATE_DATABASE_URL" -c '\d pos_devices' -c '\d audit_log' -c '\d restaurant_settings' -c '\d users'`
   (source `.env` into the shell first, e.g. `set -a; . ./.env; set +a`). Confirm
   `audit_log_device_client_op_unique` is listed with its `WHERE (client_op_id IS NOT NULL)`
   predicate, and that `pos_idle_lock_seconds` shows **no** default.
6. `matcami_test` needs no separate command: the Vitest integration project's
   `src/lib/server/db/test/global-setup.ts` runs Drizzle's runtime migrator over
   `src/lib/server/db/migrations` once per run. Run `pnpm test` — the integration failures T-06 and
   T-08 deliberately left behind must now be gone.
7. Commit the generated `.sql`, the snapshot and `_journal.json` together. A `.sql` file that is not
   registered in `_journal.json` is silently never applied.

**Tests:** this task adds none of its own. It is the task that makes the integration project pass
again: `pnpm test` (unit + integration) and `pnpm test:e2e` are its evidence.

**Done when:** `pnpm db:migrate` exits 0, `backups/` holds a dump dated today,
`src/lib/server/db/migrations/meta/_journal.json` has exactly **six** entries with the last tagged
`0005_*`, the four `psql \d` outputs show the columns and indexes listed in step 2, and
`pnpm check && pnpm lint && pnpm test && pnpm test:e2e` all pass.

**Watch out:** do not run `pnpm test:e2e` and `pnpm test:integration` at the same time — both use
`matcami_test` and both truncate it (`playwright.config.ts` says so, and `reset.ts` takes a run lock
for exactly this reason). And never hand-edit `0005` after it has run, not even to fix a comment: the
next environment would apply different SQL from the one this machine ran, and `_journal.json` would
not notice.

---

### T-10 — Wire the new tables into the schema guard and the test reset list

**Needs:** T-09 (the migration has run, so the tables and columns exist in `matcami_test`)
**Files:**

- `src/lib/server/db/test/reset.ts` — VERIFY (confirm the `TABLES` const and the comment above it
  carry `pos_devices`, which T-05 step 9 added; add it if it is missing)
- `src/lib/server/db/schema-guards/schema.test.ts` — VERIFY (confirm the import, the
  `IMPORTED_SCHEMA_FILES` entry, the `modules` spread and the discovery entry T-05 step 8 added; add
  whatever is missing)
- `src/lib/server/db/schema-guards/constraints.integration.test.ts` — EDIT (add two cases to the
  existing `describe('users constraints')` block, and one new `describe` block at the end of the file,
  beside `describe('audit_log is append-only (invariant 2)')`)

**Spec:** 29 (automated tests — "Offline sync: retries never create duplicates"), 6 (idempotency keys
so the server ignores duplicates when a sync is retried), 3 (the database itself enforces the
integrity rules, not only application code)
**Invariants:** 5 (a retried queued operation MUST be a no-op), 2 (`audit_log` is append-only, so a
duplicate can never be removed), 12 (PIN hashes live only in `pin_hash`)

**Do:**

1. In `src/lib/server/db/test/reset.ts`, **confirm T-05 step 9 already changed** the `TABLES` const
   to `['audit_log', 'sessions', 'pos_devices', 'users', 'restaurant_settings', 'restaurants']` and
   updated the comment above it to list the same six; add `pos_devices` to both if it is missing.
   T-05 makes this edit rather than T-10 because T-04's `it('truncates every table it guards')`
   asserts `TABLES` equals the tables the guard discovers, so the two lists cannot be five tasks
   apart without the unit suite going red. The file's own note says the list is
   "child-first for readability (the single statement below makes the order irrelevant)" — that is
   accurate and is why this is a readability choice, not a correctness one: `resetDb()` issues **one**
   `TRUNCATE a, b, c RESTART IDENTITY CASCADE`, which truncates every named table in a single
   atomic statement, so the order inside the list changes nothing. `pos_devices` sits **after**
   `audit_log` because `audit_log.device_id` references it, and **before** `users` and `restaurants`
   because it references those — child-first, like the rest of the list. Missing this line is how
   device rows leak between test files.
2. In `src/lib/server/db/schema-guards/schema.test.ts`, confirm T-05 made all four of its edits:
   `import * as posDevicesSchema from '../schema/pos-devices';`, `'pos-devices.ts'` in the
   `IMPORTED_SCHEMA_FILES` constant (the file **name**, which is what
   `it('imports every file in src/lib/server/db/schema')` reads the directory for — distinct from
   the table name below), the `...posDevicesSchema` spread in `modules`, and `'pos_devices'` in the
   sorted array inside `it('discovers the tables it is meant to guard')`. Add whatever is missing.
   Add **no** entry to `TENANT_COLUMN_EXEMPT`: `pos_devices` carries `restaurant_id`, so it must be
   guarded, not exempted.
3. In `constraints.integration.test.ts`, add a helper beside the existing `makeRestaurant` /
   `makeOwner`:

   ```ts
   async function makeDevice(
   	restaurantId: string,
   	ownerId: string,
   	code = 'POS1',
   	tokenHash = 'a'.repeat(64)
   ): Promise<string> {
   	const { rows } = await pool.query<{ id: string }>(
   		`insert into pos_devices (restaurant_id, device_code, label, token_hash, registered_by_user_id)
   		 values ($1, $2, 'Counter tablet', $3, $4) returning id`,
   		[restaurantId, code, tokenHash, ownerId]
   	);
   	return rows[0].id;
   }
   ```

4. Add the two `users` cases T-06 could not write: a cashier inserted with a `pin_hash` and no email
   and no password is **accepted** (`rowCount` 1) — `users_non_owner_has_no_credentials` is about
   email and password only; and an owner inserted with `password_hash` **and** `pin_hash` is
   **accepted**, because spec 7 gives the owner a POS PIN for approvals.
5. Add the new `describe('pos_devices and the device idempotency key')` block with the cases listed
   under **Tests** below, using the existing `expectError()` helper, which returns the
   `pg.DatabaseError` and fails the test if the statement unexpectedly succeeded. Assert on
   `error.constraint` (and `error.code === '23505'` for unique violations) rather than on the message
   text, exactly as the surrounding cases do.

**Tests:**

- MANDATORY (spec 29 — offline sync: retries never create duplicates). Two `audit_log` rows with the
  same `device_id` and the same `client_op_id` → the second is rejected with
  `error.code === '23505'` and `error.constraint === 'audit_log_device_client_op_unique'`. This is
  the database half of the rule; the queue that relies on it arrives with a later plan.
- MANDATORY (spec 29 — same rule, the other direction). Two `audit_log` rows with the same
  `device_id` and `client_op_id = null` are **both accepted** (`select count(*)` returns 2) —
  PostgreSQL's default `NULLS DISTINCT` plus the `where client_op_id is not null` predicate is what
  lets ordinary dashboard rows keep being written. A third row with the **same** `client_op_id` but a
  **different** `device_id` is also accepted: the key is unique per device, not globally.
- `pos_devices` rejects a second row with the same `token_hash` →
  `pos_devices_token_hash_unique`.
- `pos_devices` rejects a second `POS1` in the same restaurant **even after the first is revoked**
  (`update pos_devices set revoked_at = now()`, then insert `POS1` again) →
  `pos_devices_restaurant_device_code_unique`. This pins T-05's deliberate decision that an invoice
  prefix is burned once used.
- `pos_devices` rejects `device_code = 'pos 1'` → `pos_devices_device_code_format`.
- Deleting a `pos_devices` row that has an `audit_log` row is refused with `error.code === '23503'`
  and `error.constraint === 'audit_log_device_id_pos_devices_id_fk'`, and the audit row survives
  (`select count(*)` still 1) — revocation is a stamp, never a delete.

**Done when:** `pnpm test:integration` passes with the new cases included,
`pnpm test:unit` passes, `grep -n "pos_devices" src/lib/server/db/test/reset.ts` prints the `TABLES`
line, and `grep -n "pos.devices" src/lib/server/db/schema-guards/schema.test.ts` prints all four of
the import, the `IMPORTED_SCHEMA_FILES` entry, the `modules` spread and the discovery-list entry.

**Watch out:** `audit_log.id` is `bigint` with `mode: 'bigint'`, so any assertion on an id from a
Drizzle read compares against `1n`, not `1` — the raw `pg` queries used in this file return it as a
string instead, which is why the existing cases count with `count(*)::int`. Keep that idiom. And
`resetDb()` relies on `TRUNCATE` firing only statement-level triggers, which is the one way to clear
the append-only `audit_log` at all — do not swap it for `DELETE` while adding `pos_devices` to the
list.
