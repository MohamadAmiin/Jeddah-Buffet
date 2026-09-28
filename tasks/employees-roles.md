# Employees and configurable roles

> One file by the user's request (2026-09-16): phases are headings below, research is a section
> below, and there is no `tasks/employees-roles/` directory and no zip.

**Goal.** Finish the dashboard's Employees area. Roles become owner-editable rows per restaurant
instead of a code map: a role holds a set of the ten spec 8 POS permission keys, every staff member
holds exactly one role, and the owner stays a fixed identity outside the tables. The Employees page
becomes a list, an edit page per person and a roles page; it gains edit, deactivate, reactivate and
clear-lockout; every dashboard PIN input accepts digits only. The till learns each employee's role
name and permission list through the bundle it already caches, so the sales plan can enforce staff
permissions on the server without a second data model.

## Requirements (as agreed with the user, 2026-09-16)

- **Scope override, confirmed.** Spec 31 lists "Advanced RBAC" and "Advanced employee management"
  under Later and CLAUDE.md's "Do NOT build" repeats them. The user chose owner-editable roles
  knowing both. T-01 records it under "Decisions already made", exactly as public sign-up was
  recorded, and "the spec outranks this file" does not apply to that entry.
- **Named roles per restaurant**, each with a set of permission keys; one role per staff member.
  Not per-employee checklists, not fixed roles with overrides.
- **A role may hold only the ten spec 8 POS keys.** The eight `admin.*` keys stay owner-only. A
  staff member still has no email and no password (the `users` CHECKs stay), so staff never open the
  dashboard.
- **Seeded and editable.** Every restaurant gets a `Cashier` role (spec 8's five cashier keys) and a
  `Waiter` role (spec 8's five waiter keys): from the restaurant initializer for new restaurants,
  from migration 0009 for restaurants that already exist. Existing cashier and waiter rows are
  pointed at them. Both roles can be renamed, re-keyed and archived afterwards.
- **The owner is not a role.** `users.role = 'owner'`, `role_id` NULL, every key enumerated in code,
  never renamed, deactivated or given a role on these pages, and still the only approver (spec 33
  open decision 5 is unchanged).
- **Employee actions:** edit name and role; deactivate and reactivate; set or replace PIN (exists);
  clear a PIN lockout early; roles: create, rename, set keys, archive, with archive refused while an
  active staff member holds the role. **No delete**: `audit_log` references `users` and the user rows
  of anyone who ever signed in can never go.
- **Onboarding step** "Employees and PINs" is done when at least one ACTIVE staff member has a PIN.
- **UI:** `/employees` (list + add), `/employees/[id]` (edit), `/employees/roles` (manage). New
  primitives: CheckField, SelectField, PinField, Table.
- **PIN inputs on the dashboard:** digits only, 4 to 6, masked, with a show/hide toggle. The server
  rule (`/^[0-9]{4,6}$/`, `src/lib/pin` `isValidPin`) is unchanged; digits-only is UX, not security.
- **Enum strategy A:** `users.role` is REBUILT as `owner | staff` (recommended, accepted).
- **No database CHECK enumerating permission keys:** the ten keys live once in
  `src/lib/server/permissions/keys.ts`, tested against spec 8, validated by zod on every write. A
  prefix CHECK (`permission_key LIKE 'pos.%'`) is allowed because it duplicates no list.
- **One-time migration exception, accepted:** the generated enum-rebuild migration is reordered by
  hand BEFORE its first run, and the reason is written in the file and in the db README.
- **Live DB:** dev and test only; no production database exists (checked read-only 2026-09-16).

## Scope

**IN** — `roles` + `role_permissions` tables, `users.role_id`, the `user_role` enum rebuild, three
migrations, seeded roles (initializer + backfill), `permissions/roles.ts` with the resolver
`permissionsForUser`, the employees write model, the POS bundle shape (`isOwner`, `roleName`,
`permissions`), the POS PIN response, the till's cached-employee shape and both POS screens' labels,
four dashboard primitives, three dashboard pages, the onboarding step, audit events, docs, tests.

**OUT** — staff dashboard logins; `admin.*` keys on roles; a Manager role or remote approvals;
per-employee permission overrides; deleting employees or roles; a permissions table in the database;
any change to owner-PIN approvals; server-side enforcement of staff keys on POS operations (the till
still cannot sell; the sales plan calls `permissionsForUser` when it adds employee identity to
requests); a sync flush for `offline_logins`; scheduling, payroll, time clocks.

## Approach

**Chosen: rebuild the identity column and ship whole (A).** `users.role` becomes `owner | staff`;
`roles`, `role_permissions` and `users.role_id` arrive together; three migration files land in the
order generated DDL (0008), custom seed + backfill (0009), generated enum rebuild + CHECK (0010,
hand-ordered before its first run); then the resolver, the bundle, the primitives and the pages, in
one PR with the schema first. No production database exists, so the rebuild is cheapest today.

Rejected — *additive enum, dormant values (B)*: `ADD VALUE 'staff'` never referenced by a migration,
`cashier`/`waiter` kept in the schema array as dormant, TypeScript narrowed with `.$type`. Avoids
hand-ordered SQL but leaves the database type, the schema array and the TypeScript type disagreeing
forever, and the first person who "tidies" the enum array makes drizzle-kit emit the rebuild that
fails on the three dependent constraints (risk 1), in a plan that does not know why.

Rejected — *two shippable slices (C)*: lifecycle + UI + PinField first over the code map, roles
tables second. Builds the employees screens twice and touches the e2e journey twice for the same end
state.

## Risks that survived adversarial verification

Five lenses, 29 findings, 23 refuted, 0 blockers. The six survivors merge into three.

- **HIGH — migration mechanics break every fresh database.** Drizzle's runtime migrator runs EVERY
  pending migration in ONE transaction (`node_modules/drizzle-orm/pg-core/dialect.js`, `migrate()`),
  and that migrator builds the test database (`src/lib/server/db/test/global-setup.ts`) and
  production (`docs/deployment.md` §4). PostgreSQL 16 forbids USING an enum value added by
  `ALTER TYPE ... ADD VALUE` in the transaction that added it (error 55P04), even on zero rows, so
  "add `staff`, then rewrite rows" cannot work. And drizzle-kit 0.31.10's own enum rebuild starts
  with `ALTER TABLE users ALTER COLUMN role SET DATA TYPE text`, which fails with 42883 because
  `users_owner_has_credentials`, `users_non_owner_has_no_credentials` and
  `users_one_owner_per_restaurant` are stored with `'owner'::user_role` casts (verified in a
  rolled-back transaction on `matcami_test`). Prevention: T-05 rebuilds the type in a GENERATED
  migration whose SQL is reordered by hand before its first run: drop the three dependents, retype
  to text, rewrite `cashier`/`waiter` to `staff`, drop and create the type, retype back, recreate the
  three dependents by their exact names, then add the new CHECK. Never `--custom` for this: a custom
  file's snapshot is a copy of the previous one, so the drift would be re-emitted by the sales
  plan's first `pnpm db:generate`.
- **HIGH — the new `users` CHECK must land after the backfill.** drizzle-kit emits
  `ADD CONSTRAINT ... CHECK` right after `ADD COLUMN`, and `ADD CONSTRAINT` validates existing rows.
  After any `pnpm test:e2e` run `matcami_test` holds staff rows with `role_id` NULL, and the next
  `pnpm test:integration` migrates that database BEFORE truncating it, so every integration test
  would fail on 23514 before a single test ran. Prevention: three files in order (T-02 DDL without the
  CHECK, T-03 seed + backfill, T-05 rebuild + CHECK last), and T-18 verifies in the order
  `pnpm test:e2e` THEN `pnpm test:integration`, the sequence that leaves rows behind.
- **MED — an active employee on an archived role.** Deactivate Bob (Waiter), archive Waiter (allowed:
  no active holder), reactivate Bob: active, on an archived role, whose keys the resolver and the
  bundle still grant. A stale edit form and a two-tab race under READ COMMITTED reach the same
  state, and no CHECK can span two tables. Prevention: create, change-role and reactivate lock the
  target role `FOR SHARE` inside the transaction and refuse when it is archived (T-06 `assertLiveRole`,
  used by T-08 and T-09); reactivation of an employee whose role is archived demands a live role in
  the same form; `archiveRole` locks the role `FOR UPDATE` FIRST and only then counts active holders
  (T-06). Integration tests cover the deterministic path and the concurrent pair.

*Refuted, dropped* (one line each): a staff role named "Owner" spoofs the approver (no authorisation
path reads the name; the server keeps `role = 'owner'`; the bundle gains an explicit `isOwner`
anyway) · audit rows carrying a role string become meaningless (attribution is the user id FK;
`role.*` events keep history) · `failedCount` is 0 on a lockout-cleared row (documented stored-count
convention) · the dependent drops are unnecessary (proved the opposite, folded into risk 1) · a
format CHECK on keys (cannot catch a typo; the prefix CHECK is kept only to forbid `admin.*`) · a
restaurant-led index on `roles` (a five-row table; added as a nicety) · old-shape cached rows on the
till (the old worker serves the old build; T-11's reader is tolerant) · the bundle loses its owner
marker (`isOwner` added) · sync-time permission reads reject offline sales (spec 6: stored and
flagged, never rejected; the sales plan's design) · deactivation reaches the till on its next fetch
(spec 6's pull model, decided in the POS plan) · clear-lockout leaves the till's countdown running
(pre-existing through set-PIN; cosmetic) · the owner row reachable through a crafted form (refused in
the write model's WHERE, T-08/T-09) · two answers to "may X do Y" (no staff session can exist) · the
resolver must fail closed (it does: inactive, foreign and unknown users get an empty set) · tenant
WHERE and the 403 table (house idiom; the hook's `/(dashboard)` prefix covers the new routes) · audit
keys tripping the secret scan (rule stated in every event task) · PinField echoing the PIN (house
idiom: `fail()` never carries a secret) · CHECK-before-backfill as a major (no production; folded into
risk 2) · no written rollback (restore the pre-migration dump, spec 29) · sign-up during the deploy
window misses seeded roles (maintenance-window model; the owner can create roles) · the unbuilt
audit-log cap index colliding in the journal (no such branch; a collision fails loudly) · mandatory
tests going red (expected rewiring, scheduled per task) · docs the plan owes (T-01).

## Assumptions and recorded defaults

- Spec 33 open decision 5 (who approves) is untouched: owner PIN only. No task adds an approver
  capability to a role.
- The role name `Owner` (any case) is reserved (CHECK `roles_name_not_owner`), so the till's role label
  can never read "Owner" for a staff member.
- Role management lives in `src/lib/server/permissions/roles.ts` and calls `audit/` only.
  `restaurants/` reads the `DEFAULT_ROLES` constant from `permissions/keys.ts` (constants, no DB).
- The bundle and the PIN response carry `isOwner`, `roleName` and `permissions` (the owner's
  `permissions` in the bundle are the ten POS keys; `permissionsForUser(owner)` on the server is
  `ALL_KEYS`).
- `/employees/roles` is reached from a header action on `/employees`; the rail is unchanged.
- Deactivated staff stay listed, dimmed, after the active ones; the owner's row is listed first.
- Audit `details` never carry a key matching `/pass|pin|token|hash|secret|cookie|authorization/i`
  (`assertNoSecrets` throws and rolls the action back). The new events use `roleName`,
  `permissionKeys`, `failedCount`, `wasLocked`, `changes`, `displayName`, `name`.
- **Execution note.** Unit and integration suites must be green at the end of every task. The
  Playwright journey is expected RED from T-05 (the enum flip changes what the till renders) until
  T-14 and T-11 have landed; T-18 makes it green and is the gate for the PR. `pnpm check` and
  `pnpm lint` must pass at every task.

## In play

Spec: 3 (users, roles, permissions tables; audit rule), 7 (PIN rules, owner's POS PIN), 8 (the key
lists, User → Role → Permissions, 403), 9 (sessions), 29 (mandatory tests, backup before migrate),
31 (the Later list this plan departs from), 33 (decision 5 kept).
Invariants: 2 (users and roles are NOT posted records, so UPDATE is allowed; `audit_log` is
append-only and untouched), 5 (cached bundle and `offline_logins` are unsynced facts), 8 (every
load and action guarded, 403), 9 (approvals owner-only), 10 (audit row in the same transaction),
11 (timestamptz), 12 (PIN rules).

## Research

### Q: Can a migration add an enum value and use it in the same run?

- **Source:** https://www.postgresql.org/docs/16/sql-altertype.html — accessed 2026-09-16.
- **Says:** "If `ALTER TYPE ... ADD VALUE` (the form that adds a new value to an enum type) is
  executed inside a transaction block, the new value cannot be used until after the transaction has
  been committed." The page documents `ADD VALUE` and `RENAME VALUE` only; there is no `DROP VALUE`.
- **Affects the plan:** no migration may `ADD VALUE`. T-05 recreates the type (`CREATE TYPE` values
  are usable at once) after retyping the column to text and rewriting rows.

### Q: Does Drizzle run pending migrations in one transaction?

- **Source:** `node_modules/drizzle-orm/pg-core/dialect.js` lines 44–72, drizzle-orm 0.45.2 — read
  2026-09-16. `drizzle-kit migrate` (0.31.10) delegates to the same migrator;
  `src/lib/server/db/test/global-setup.ts` calls it directly.
- **Says:** `await session.transaction(async (tx) => { for await (const migration of migrations)
  { ... tx.execute(stmt) ... } })` — every pending file, one transaction.
- **Affects the plan:** risks 1 and 2 above; the three files of T-02/T-03/T-05 must be correct as
  ONE unit on a fresh database and as a unit on a database at 0007 with staff rows.

### Q: What does `drizzle-kit generate --custom` record?

- **Source:** `node_modules/drizzle-kit/bin.cjs` around line 32169 (`config.custom` branch writes
  `cur: custom` with `sqlStatements: []`), and this repo's `migrations/meta/0004_snapshot.json`
  equals `0003_snapshot.json` apart from ids and format — read 2026-09-16.
- **Says:** a custom migration's snapshot is the PREVIOUS snapshot under a new id; it does not
  serialise the schema files.
- **Affects the plan:** `--custom` is used for DATA only (T-03). Every schema change goes through a
  plain `pnpm db:generate` so the snapshot chain stays truthful; T-05 edits the generated SQL before
  it runs and proves the chain with `pnpm db:generate` (no diff) and `pnpm exec drizzle-kit check`.

### Q: Does drizzle-kit's enum rebuild work on `users`?

- **Source:** the risk panel's refuter ran the statement in a rolled-back transaction on
  `matcami_test` (PostgreSQL 16.15) on 2026-09-16; `pg_get_constraintdef` shows the three `users`
  objects with `'owner'::user_role` casts.
- **Says:** `ALTER TABLE users ALTER COLUMN role SET DATA TYPE text` fails with 42883 `operator does
  not exist: text = user_role` while the constraints and the partial index exist.
- **Affects the plan:** T-05 drops the three by name first and recreates them by name last.

No `CONFLICT WITH SPEC` and no `GAP`: spec 8 is silent on editable roles and the user decided.

## Workspace state at plan time (Phase 1, 2026-09-16; live DB checked read-only)

Branch `main` at `1741344` (PR #10 merged). Established repo: SvelteKit 2 + Svelte 5 runes, Drizzle
0.45.2, drizzle-kit 0.31.10, zod 4.6.4, Vitest 5 (unit + integration projects), Playwright, Node
24.21.0. Eight committed migrations `0000`–`0007`, all applied to the dev database; `drizzle-kit
check` clean. Dev data: 1 restaurant, 1 owner, 0 staff, 1 device, 15 audit rows. Every path below
tagged `EDIT` was opened during planning; every `NEW` path was absent. Files created by earlier tasks
in this plan are `EXTEND` and name the task. **Stop and report a mismatch only** when a `NEW` path
already exists or an `EXTEND`/`EDIT` path does not.

EXISTS (modify):
- `src/lib/server/db/schema/users.ts` — `pgEnum user_role ['owner','cashier','waiter']`; two CHECKs
  and the partial unique index reference `'owner'`; PIN columns `pin_hash`, `failed_pin_count`,
  `pin_locked_until`; no `role_id`.
- `src/lib/server/db/schema-guards/schema.test.ts` (discovery list, `IMPORTED_SCHEMA_FILES`),
  `src/lib/server/db/schema-guards/constraints.integration.test.ts` (users CHECKs by name),
  `src/lib/server/db/test/reset.ts` (`TABLES`), `src/lib/server/db/README.md`.
- `src/lib/server/permissions/keys.ts` (`CASHIER_KEYS`, `WAITER_KEYS`, `ADMIN_KEYS`, `ROLE_KEYS`,
  `ALL_KEYS`), `index.ts` (`hasPermission` sync over `ROLE_KEYS`; `requireUser`, `requireOwner`,
  `requirePermission`), `keys.test.ts`, `guards.test.ts`, `README.md`.
- `src/lib/server/auth/employees.ts` (`EmployeeRow`, `employeeSetupStatus`, `listEmployees`,
  `createEmployee({ role: 'cashier'|'waiter', displayName, pin })`, `setEmployeePin`),
  `employee-directory.ts` (`PosEmployee` five keys incl. `pinPhc`; `listPosEmployees`), `pin.ts`
  (`verifyEmployeePin`, `PosEmployeeIdentity { id, displayName, role }`, writes `pos.pin.*`),
  `session.ts` (`Principal.role: UserRole`, `Executor`), plus their integration tests.
- `src/lib/server/audit/events.ts` (typed union + `AUDIT_EVENT_NAMES`; `employee.deactivated` exists
  with no writer), `src/routes/(dashboard)/dashboard/event-text.ts` (total `Record` over the union).
- `src/lib/server/restaurants/index.ts` (`restaurantInitializers`, one entry).
- `src/routes/api/pos/employees/+server.ts`, `src/routes/api/pos/pin/+server.ts` and tests
  (`employees.integration.test.ts` asserts exactly five keys per entry).
- `src/lib/pos/store.ts` (`CachedEmployee` five keys; `cacheEmployees` clear-and-replace;
  `DB_VERSION 2`), `store.test.ts`; `src/routes/(pos)/pos/+page.svelte` (`ROLE_LABEL` map),
  `src/routes/(pos)/pos/pin/+page.svelte` ("Signed in as {displayName} ({role})").
- `src/routes/(dashboard)/employees/+page.server.ts` and `+page.svelte` (list + Set-PIN form per row
  + add form with hand-built radios), `src/lib/server/auth/employees.integration.test.ts`.
- `src/routes/(dashboard)/dashboard/+page.server.ts` (`employeesReady`), `+page.svelte` (step copy),
  `dashboard.integration.test.ts`.
- `src/lib/components/ui/` — `Alert`, `Button`, `Card`, `Field` (renders an `<input>` only),
  `PageHeader`, `StatusMark` (`'done' | 'not-started'`), `Sidebar`, `ThemeToggle`, `AuthSplit`,
  `index.ts`; `src/lib/components/components.test.ts` (discovers files; forbids `$lib/server`).
- `src/routes/route-guards.integration.test.ts` (explicit dashboard route-id array), `e2e/fixtures.ts`
  (`createEmployee` clicks the `Cashier`/`Waiter` radios), `e2e/pos-access.spec.ts`,
  `e2e/pos-offline.spec.ts` (asserts the cached row shape), `docs/design-system.md` §7b, `CLAUDE.md`.

CREATE:
- `src/lib/server/db/schema/roles.ts`; migrations `0008_*`, `0009_*`, `0010_*` + meta.
- `src/lib/server/db/test/seed.ts` (test helpers `seedRole`, `seedStaff`).
- `src/lib/server/permissions/roles.ts` + `roles.integration.test.ts`.
- `src/lib/components/ui/CheckField.svelte`, `SelectField.svelte`, `Table.svelte`, `PinField.svelte`,
  `primitives.test.ts`.
- `src/routes/(dashboard)/employees/[id]/+page.server.ts`, `+page.svelte`, `employee.integration.test.ts`.
- `src/routes/(dashboard)/employees/roles/+page.server.ts`, `+page.svelte`, `roles-page.integration.test.ts`.

## Task index

| ID | Title | Phase | Needs |
|---|---|---|---|
| T-01 | Record the decision in CLAUDE.md and the module READMEs | 0 | - |
| T-02 | Add `roles`, `role_permissions` and `users.role_id`; generate 0008 | 1 | T-01 |
| T-03 | Seed the two default roles and backfill existing staff; custom 0009 | 1 | T-02 |
| T-04 | Rework the permission key module: owner in code, POS keys, defaults, labels | 1 | T-01 |
| T-05 | Rebuild `user_role` as `owner \| staff`, add the users CHECK; hand-ordered 0010; test seed helper and fixture sweep | 1 | T-02, T-03, T-04 |
| T-06 | Build `permissions/roles.ts`: list, create, update, archive, `assertLiveRole`, `permissionsForUser` | 2 | T-05 |
| T-07 | Seed default roles for new restaurants from the initializer | 2 | T-06 |
| T-08 | Rework the employees read and write model: list, get, create, update, setup status | 2 | T-06 |
| T-09 | Add deactivate, reactivate and clear-lockout with their audit events | 2 | T-08 |
| T-10 | Ship `isOwner`, `roleName`, `permissions` in the POS bundle and the PIN response | 2 | T-06 |
| T-11 | Cache the new bundle shape on the till and show role names | 3 | T-10 |
| T-12 | Add CheckField, SelectField, Table; extend StatusMark; document them | 4 | T-01 |
| T-13 | Add PinField: digits only, 4–6, masked, show/hide | 4 | T-12 |
| T-14 | Rebuild `/employees`: table, add form with a role select, header action | 5 | T-08, T-12, T-13 |
| T-15 | Build `/employees/[id]`: details, PIN, lockout, status | 5 | T-09, T-12, T-13 |
| T-16 | Build `/employees/roles`: create, edit keys, rename, archive | 5 | T-06, T-12 |
| T-17 | Redefine the onboarding step | 5 | T-08 |
| T-18 | Verify: e2e journeys, the migration sequence, every command green | 6 | T-11, T-14, T-15, T-16, T-17 |

---

## Phase 0 — Decisions and docs

The scope departure and the migration exception are written down BEFORE any code, so a later session
bound by CLAUDE.md cannot "correct" the roles tables back into a code map.

### T-01 — Record the decision in CLAUDE.md and the module READMEs

**Needs:** -
**Files:**
- `CLAUDE.md` — EDIT (four places: "Decisions already made", "Do NOT build", "Where code lives" tree
  and the migrations sentence under it, invariant 12)
- `src/lib/server/db/README.md` — EDIT (after the "Migrations live in `migrations/`" bullet)
- `src/lib/server/permissions/README.md` — EDIT (a new bullet after the "Permission keys come from
  spec 8" bullet)
**Spec:** 8 (User → Role → Permissions; the lists are "For example"), 31 (Advanced RBAC and Advanced
employee management are listed under Later), 33 (decision 5 stays owner PIN only)
**Invariants:** 8 (permissions enforced server-side), 9 (owner PIN approval), 12 (PIN rules)

**Do:**
1. In `CLAUDE.md` under "Decisions already made", append this bullet verbatim:
   > - **Roles are owner-editable rows, per restaurant — decided 2026-09-16, a deliberate departure
   > from spec 31.** Spec 31 lists "Advanced RBAC" and "Advanced employee management" under Later and
   > this file's "Do NOT build" list repeated them; the user chose editable roles knowing both, so
   > "the spec outranks this file" does NOT apply to this point — do not "correct" roles back into a
   > code map. The shape: `roles` and `role_permissions` (`src/lib/server/db/schema/roles.ts`),
   > `users.role_id`, and `users.role` narrowed to `owner | staff`. A role may hold ONLY the ten spec
   > 8 POS keys (`POS_KEYS`); the eight `admin.*` keys stay owner-only, and a staff member still has
   > no email and no password (the users CHECKs are unchanged), so staff never open the dashboard.
   > The OWNER is not a role: `users.role = 'owner'`, `role_id NULL`, every key enumerated in code as
   > `OWNER_KEYS`, never renamed, deactivated or given a role on the Employees pages, and still the
   > only approver (spec 33 decision 5 unchanged). Every restaurant gets two EDITABLE seeded roles,
   > `Cashier` and `Waiter`, from the spec 8 lists (`insertDefaultRoles` for new restaurants,
   > migration 0009 for existing ones). The name `Owner` is reserved. Roles are archived, never
   > deleted, and an ACTIVE employee never holds an archived role: `assertLiveRole` (FOR SHARE) in
   > create, change-role and reactivate, and `archiveRole` locking the role FOR UPDATE before it
   > counts holders. Nothing else from the Later list came with it: no staff dashboard logins, no
   > per-employee overrides, no Manager role, no remote approvals. The user's words: "i choose the
   > recommended Option" (2026-09-17), after choosing named roles, POS keys only, seeded defaults and
   > a fixed owner one by one.
2. In "Do NOT build", replace the fragment `Manager role and remote approvals, advanced RBAC, advanced
   employee management` with: `Manager role and remote approvals · RBAC beyond owner-editable roles
   over the ten spec 8 POS keys (no staff dashboard logins, no per-employee overrides, no permission
   hierarchy) · employee management beyond the Employees pages (no scheduling, payroll or time
   clocks)`.
3. In "Where code lives": change the `permissions/` line to `permissions/  RBAC checks + owner-PIN
   approval gates; roles.ts holds the owner-editable roles and the permissionsForUser resolver (calls
   audit/ only)`; change the `components/ui/` line to list `Button, Field, CheckField, SelectField,
   PinField, Table, Card, PageHeader, Alert, StatusMark, ThemeToggle`; in the house-convention
   paragraph change `restaurants/ ... calls only audit/` to `calls only audit/ and reads constants
   from permissions/keys.ts`. After the sentence ending `are NEVER hand-edited once they have run —
   add a new one instead.` append: `A GENERATED migration may be reordered by hand BEFORE its first
   run, only when drizzle-kit cannot express the change and only with the reason written at the top
   of the file; the one precedent is 0010's enum rebuild, which must drop and recreate the three
   users constraints drizzle-kit does not know depend on the type. generate --custom is for DATA
   (seeds, backfills): its snapshot is a copy of the previous one, so a schema change written that way
   leaves a drift the next db:generate re-emits.`
4. In invariant 12, after the clause `never reversible, never logged;` insert ` dashboard PIN
   inputs accept digits only through PinField, which is UX — the server's 4–6 ASCII-digit rule is
   the control;` so the sentence keeps reading through to the lockout rule.
5. In `src/lib/server/db/README.md`, add the same "may be reordered by hand BEFORE its first run"
   sentence as a bullet, naming 0010.
6. In `src/lib/server/permissions/README.md`, add: `- Roles are owner-editable rows (roles,
   role_permissions) over the ten spec 8 POS keys; the owner's grant is OWNER_KEYS in code and
   admin.* never enters a role. See CLAUDE.md "Decisions already made", 2026-09-16.`

**Tests:** none (documentation). `pnpm lint` still passes (prettier checks Markdown).

**Done when:** `grep -c 'owner-editable rows' CLAUDE.md` prints `1`, `grep -c '0010' CLAUDE.md
src/lib/server/db/README.md` prints `1` for each file, and `pnpm lint` passes.

**Watch out:** do not delete any row of "Open decisions — UNRESOLVED": decision 5 stays there,
unchanged.

---

## Phase 1 — Schema and migrations

**Depends on:** Phase 0. Three migration files, in this order, so that every fresh database and
every database at 0007 with staff rows migrates in the migrator's single transaction: 0008 generated
DDL without the users CHECK, 0009 custom seed + backfill, 0010 generated enum rebuild + CHECK,
hand-ordered before its first run. T-04 is a code-only task placed here because T-05 removes the
`cashier`/`waiter` entries `ROLE_KEYS` is typed over; doing the key module first keeps every commit
compiling.

### T-02 — Add `roles`, `role_permissions` and `users.role_id`; generate 0008

**Needs:** T-01
**Files:**
- `src/lib/server/db/schema/roles.ts` — NEW
- `src/lib/server/db/schema/users.ts` — EDIT (add `roleId` and its FK + index inside the `users`
  table; the enum and the CHECKs are NOT touched in this task)
- `src/lib/server/db/schema-guards/schema.test.ts` — EDIT (import `../schema/roles`, spread it into
  `modules`, add `'roles.ts'` to `IMPORTED_SCHEMA_FILES`, add `'role_permissions'` and `'roles'` to
  the discovery expectation)
- `src/lib/server/db/test/reset.ts` — EDIT (`TABLES`: add `'role_permissions'` and `'roles'`; users
  before roles in the comment order)
- `src/lib/server/db/migrations/0008_roles_and_role_id.sql` + `meta/0008_snapshot.json` +
  `meta/_journal.json` — NEW, generated
**Spec:** 3 ("Users, Roles, Permissions" among the tables), 8
**Invariants:** 2 (roles are configuration, not posted records; archive never delete), 11 (every
timestamp is timestamptz)

**Do:**
1. Create `roles.ts` with two tables, using the tenant idiom of `menu.ts` (child references parent
   through a COMPOSITE `(restaurant_id, id)` FK; the target's pair is a `unique()` CONSTRAINT, not a
   `uniqueIndex()`, because drizzle-kit writes `CREATE INDEX` after every FK):
   ```ts
   export const roles = pgTable('roles', {
     id: uuid('id').primaryKey().defaultRandom(),
     restaurantId: uuid('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'restrict' }),
     name: text('name').notNull(),
     archivedAt: timestamp('archived_at', { withTimezone: true }),
     createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
     updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
   }, (t) => [
     index('roles_restaurant_id_idx').on(t.restaurantId),
     uniqueIndex('roles_name_unique').on(t.restaurantId, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`),
     unique('roles_id_restaurant_unique').on(t.id, t.restaurantId),
     check('roles_name_length', sql`length(btrim(${t.name})) between 1 and 60`),
     check('roles_name_not_owner', sql`lower(btrim(${t.name})) <> 'owner'`)
   ]);
   export const rolePermissions = pgTable('role_permissions', {
     restaurantId: uuid('restaurant_id').notNull().references(() => restaurants.id, { onDelete: 'restrict' }),
     roleId: uuid('role_id').notNull(),
     permissionKey: text('permission_key').notNull(),
     createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
   }, (t) => [
     primaryKey({ name: 'role_permissions_pk', columns: [t.roleId, t.permissionKey] }),
     foreignKey({ columns: [t.restaurantId, t.roleId], foreignColumns: [roles.restaurantId, roles.id], name: 'role_permissions_role_fk' }).onDelete('restrict'),
     index('role_permissions_restaurant_idx').on(t.restaurantId),
     // Forbids admin.* structurally; enumerates nothing, so a new POS key needs no migration.
     check('role_permissions_key_pos_only', sql`${t.permissionKey} like 'pos.%'`)
   ]);
   ```
   Head the file with a comment: roles are archived, never deleted; the reserved name; the ten keys
   live in `permissions/keys.ts`; why the prefix CHECK is not an enumeration.
2. In `users.ts` add `roleId: uuid('role_id')` (nullable, no default) after `role`, and in the table
   extras add `index('users_role_id_idx').on(table.roleId)` and
   `foreignKey({ columns: [table.restaurantId, table.roleId], foreignColumns: [roles.restaurantId, roles.id], name: 'users_role_fk' }).onDelete('restrict')`.
   Import `roles` from `./roles` (no cycle: `roles.ts` imports `restaurants.ts` only). Do NOT add
   the owner/staff CHECK here (T-05) and do NOT touch the enum (T-05).
3. Update the three guard files as listed under Files.
4. Run `pnpm db:generate --name roles_and_role_id`. Open the SQL: it must contain `CREATE TABLE
   "roles"`, `CREATE TABLE "role_permissions"`, `ALTER TABLE "users" ADD COLUMN "role_id" uuid`,
   the three FKs, the four indexes and the three CHECKs, and NOTHING about `user_role`. Run
   `pnpm db:migrate` (it backs up first) against the dev database.

**Tests:**
- `pnpm test:unit -- schema-guards` passes: discovery lists 13 tables, `roles.ts` is imported, every
  timestamp is timestamptz, both new tables carry `restaurant_id`.
- `src/lib/server/db/schema-guards/constraints.integration.test.ts` gains a `describe('roles
  constraints')`: a role named `Owner` (any case) is rejected (`roles_name_not_owner`); a blank name
  is rejected; two LIVE roles `Cashier` and `cashier` in one restaurant are rejected and the name is
  free once the first is archived (`archived_at` set); a `role_permissions` row with
  `admin.settings` is rejected by `role_permissions_key_pos_only`; a role in restaurant A cannot be
  referenced by a user in restaurant B (`users_role_fk`, 23503); a role a user holds cannot be
  deleted (23503).

**Done when:** `pnpm db:generate` prints that there is nothing to generate, `pnpm exec drizzle-kit
check` is clean, `pnpm check && pnpm lint && pnpm test` pass, and `\d users` on the dev database shows
`role_id uuid` with `users_role_fk`.

**Watch out:** `ON CONFLICT` in T-03 targets the partial index expression `(restaurant_id,
lower(name)) WHERE archived_at IS NULL` — keep the index exactly as written. `unique()` for the
`(id, restaurant_id)` pair, never `uniqueIndex()`: 42830 at migrate time otherwise.

### T-03 — Seed the two default roles and backfill existing staff; custom 0009

**Needs:** T-02
**Files:**
- `src/lib/server/db/migrations/0009_seed_default_roles.sql` + `meta/0009_snapshot.json` +
  `meta/_journal.json` — NEW, via `pnpm db:generate --custom --name seed_default_roles`, then the SQL
  body written by hand (that is what `--custom` is for)
**Spec:** 8 (the Cashier and Waiter key lists, verbatim), 31 (one cashier, one waiter is the MVP
scope the seeds mirror)
**Invariants:** 2 (users rows are not posted records: the UPDATE is allowed; `audit_log` is never
touched by a migration)

**Do:**
1. Run the generate command above; it writes an empty `0009_seed_default_roles.sql` and a snapshot
   equal to 0008's. Paste this body (keep the `--> statement-breakpoint` lines; drizzle splits on
   them):
   ```sql
   -- Seed the two spec 8 roles for every restaurant that exists BEFORE editable roles, and point
   -- its legacy cashier/waiter users at them. New restaurants get the same rows from
   -- restaurantInitializers (insertDefaultRoles). Idempotent: re-running changes nothing.
   INSERT INTO "roles" ("restaurant_id", "name")
   SELECT r."id", v."name"
   FROM "restaurants" r CROSS JOIN (VALUES ('Cashier'), ('Waiter')) AS v("name")
   ON CONFLICT ("restaurant_id", lower("name")) WHERE "archived_at" IS NULL DO NOTHING;
   --> statement-breakpoint
   INSERT INTO "role_permissions" ("restaurant_id", "role_id", "permission_key")
   SELECT ro."restaurant_id", ro."id", k."key"
   FROM "roles" ro
   JOIN (VALUES
     ('cashier', 'pos.sell'), ('cashier', 'pos.payment'), ('cashier', 'pos.print_receipt'),
     ('cashier', 'pos.void_unsent_item'), ('cashier', 'pos.cash_payout'),
     ('waiter', 'pos.create_order'), ('waiter', 'pos.view_menu'), ('waiter', 'pos.modify_order'),
     ('waiter', 'pos.send_to_kitchen'), ('waiter', 'pos.transfer_table')
   ) AS k("role_name", "key") ON lower(ro."name") = k."role_name"
   WHERE ro."archived_at" IS NULL
   ON CONFLICT ("role_id", "permission_key") DO NOTHING;
   --> statement-breakpoint
   UPDATE "users" u
   SET "role_id" = ro."id", "updated_at" = now()
   FROM "roles" ro
   WHERE u."role_id" IS NULL
     AND u."role"::text IN ('cashier', 'waiter')
     AND ro."restaurant_id" = u."restaurant_id"
     AND ro."archived_at" IS NULL
     AND lower(ro."name") = u."role"::text;
   ```
2. Run `pnpm db:migrate`. On the dev database expect 2 roles and 10 `role_permissions` rows for the
   one restaurant and no users change (it has no staff).

**Tests:**
- Integration (`constraints.integration.test.ts`, same describe as T-02): insert a restaurant, a
  legacy-shaped user is impossible to create after T-05, so the backfill is exercised by SQL in the
  test: insert restaurant + two roles through the migration's first two statements copied verbatim
  into the test, run them twice, assert 2 roles and 10 permission rows both times (idempotent).
- Manual, recorded in the commit message: `psql "$MIGRATE_DATABASE_URL" -Atc "select name, (select
  count(*) from role_permissions p where p.role_id = r.id) from roles r order by 1"` prints
  `Cashier|5` and `Waiter|5`.

**Done when:** the migration applies on the dev database and on a fresh `matcami_test` (run
`pnpm test:integration`, whose global setup migrates it), `pnpm exec drizzle-kit check` is clean.

**Watch out:** the eleven key strings must match spec 8 and `keys.ts` character for character; a
typo here is a permanent seeded row. `ON CONFLICT (restaurant_id, name)` errors: the conflict
target must name the partial index expression exactly as written above.

### T-04 — Rework the permission key module: owner in code, POS keys, defaults, labels

**Needs:** T-01
**Files:**
- `src/lib/server/permissions/keys.ts` — EDIT (replace `ROLE_KEYS` and its comment block; add
  exports)
- `src/lib/server/permissions/index.ts` — EDIT (`hasPermission`, the re-export line)
- `src/lib/server/permissions/keys.test.ts` — EDIT (rewrite the `role grants` describe)
- `src/lib/server/permissions/guards.test.ts` — EDIT (the `lets a cashier through on a key they DO
  hold` case)
**Spec:** 8 (the ten POS keys verbatim; the owner approves; 403)
**Invariants:** 8 (server-side checks), 9 (owner-only approval)

**Do:**
1. In `keys.ts` keep `CASHIER_KEYS`, `WAITER_KEYS`, `ADMIN_KEYS`, `PermissionKey`, `ALL_KEYS`
   unchanged. Delete `ROLE_KEYS` and the "NO DATABASE TABLES FOR ROLES AND PERMISSIONS" comment
   (replace it with a comment pointing at CLAUDE.md's 2026-09-16 decision). Add:
   ```ts
   export const POS_KEYS = [...CASHIER_KEYS, ...WAITER_KEYS] as const;
   export type PosPermissionKey = (typeof POS_KEYS)[number];
   /** The owner's grant, ENUMERATED (never a wildcard): every key, POS and admin. */
   export const OWNER_KEYS: readonly PermissionKey[] = [...CASHIER_KEYS, ...WAITER_KEYS, ...ADMIN_KEYS];
   export function isPosPermissionKey(value: unknown): value is PosPermissionKey;
   /** Seeded for every restaurant; editable afterwards. Names are reserved nowhere except 'owner'. */
   export const DEFAULT_ROLES = [
     { name: 'Cashier', permissionKeys: CASHIER_KEYS },
     { name: 'Waiter', permissionKeys: WAITER_KEYS }
   ] as const;
   export const RESERVED_ROLE_NAMES: readonly string[] = ['owner']; // compared lower-cased, trimmed
   export const ROLE_NAME_MAX = 60;
   /** Human labels for the roles page; the KEY is the contract, the label is copy. */
   export const PERMISSION_LABELS: Record<PosPermissionKey, string> = {
     'pos.sell': 'Sell: ring up items',
     'pos.payment': 'Take payment',
     'pos.print_receipt': 'Print receipts',
     'pos.void_unsent_item': 'Remove items not yet sent to the kitchen',
     'pos.cash_payout': 'Cash pay-out, up to the limit',
     'pos.create_order': 'Create orders',
     'pos.view_menu': 'View the menu',
     'pos.modify_order': 'Modify orders',
     'pos.send_to_kitchen': 'Send orders to the kitchen',
     'pos.transfer_table': 'Transfer tables'
   };
   ```
2. In `index.ts`: `hasPermission(principal, key)` returns `principal?.role === 'owner' &&
   OWNER_KEYS.includes(key)`. A non-owner principal holds NOTHING synchronously, by design: staff
   permissions are read from the database by `permissionsForUser` (T-06), and no staff dashboard
   session can exist (`users_non_owner_has_no_credentials`, `login.ts`). Update the re-export line
   to export `POS_KEYS`, `OWNER_KEYS`, `DEFAULT_ROLES`, `PERMISSION_LABELS`, `RESERVED_ROLE_NAMES`,
   `ROLE_NAME_MAX`, `isPosPermissionKey` and the `PosPermissionKey` type; stop exporting `ROLE_KEYS`.
3. `grep -rn ROLE_KEYS src` must return only test files you are editing in this task.

**Tests:**
- `keys.test.ts`: the two spec 8 lists unchanged (keep those cases verbatim); `POS_KEYS` has exactly
  ten entries and none starts with `admin.`; `DEFAULT_ROLES[0]` is `Cashier` with exactly
  `CASHIER_KEYS`, `DEFAULT_ROLES[1]` is `Waiter` with exactly `WAITER_KEYS`; the owner holds every
  key in `ALL_KEYS` and `OWNER_KEYS.length === ALL_KEYS.length`; `OWNER_KEYS` is an array, not a
  wildcard; a non-owner principal holds no key at all; anonymous holds nothing;
  `PERMISSION_LABELS` has a non-empty label for every `POS_KEYS` entry; `isPosPermissionKey` rejects
  `'admin.settings'`, `'pos.sel'` and a non-string.
- `guards.test.ts`: replace the "cashier through on a key they DO hold" case with "a non-owner
  principal gets 403 on every key, even a POS key"; keep the owner cases.

**Done when:** `pnpm check && pnpm lint && pnpm test:unit` pass and `grep -rn ROLE_KEYS src` prints
nothing.

**Watch out:** the ten POS keys stay copied VERBATIM from spec 8; do not reorder them, keys.test.ts
asserts the literal order.

### T-05 — Rebuild `user_role` as `owner | staff`, add the users CHECK; hand-ordered 0010; test seed helper and fixture sweep

**Needs:** T-02, T-03, T-04
**Files:**
- `src/lib/server/db/schema/users.ts` — EDIT (the `pgEnum` values; a new `check()`; the header
  comment)
- `src/lib/server/db/migrations/0010_user_role_owner_staff.sql` + `meta/0010_snapshot.json` +
  `meta/_journal.json` — NEW, generated, then the SQL body REPLACED before its first run
- `src/lib/server/db/test/seed.ts` — NEW (`seedRole`, `seedStaff`)
- `src/lib/server/db/schema-guards/constraints.integration.test.ts` — EDIT (`users constraints`)
- every test file that inserts `role: 'cashier'` or `role: 'waiter'` — EDIT (the compiler lists
  them; at plan time 19 files, listed under "Workspace state")
- `src/lib/server/auth/employees.ts` — EDIT (minimal bridge only, see step 6; T-08 rewrites it)
- `src/lib/server/auth/employee-directory.ts`, `pin.ts`, `src/routes/api/pos/pin/+server.ts`,
  `src/routes/(pos)/pos/+page.svelte`, `src/routes/(pos)/pos/pin/+page.svelte`,
  `src/routes/(dashboard)/employees/+page.svelte` — EDIT (type-level only: wherever the literal
  union `'owner' | 'cashier' | 'waiter'` or a `ROLE_LABEL` map is spelled out, make it compile with
  `'owner' | 'staff'`; T-10, T-11 and T-14 do the real work)
**Spec:** 7 (PIN rules unchanged), 8, 31
**Invariants:** 2 (users is not a posted record: the rewrite is allowed; audit_log untouched),
11 (timestamptz), 12 (the owner's CHECKs are recreated exactly)

**Do:**
1. In `users.ts`: `export const userRole = pgEnum('user_role', ['owner', 'staff']);` and add to the
   table extras `check('users_owner_has_no_role_staff_has_one', sql\`(${table.role} = 'owner') =
   (${table.roleId} is null)\`)`. Rewrite the header comment: `staff` is every non-owner; the person's
   job title is `roles.name` through `role_id`; the old `cashier`/`waiter` values were rewritten to
   `staff` by 0010. Leave the two credential CHECKs and the partial unique index EXACTLY as they are.
2. Run `pnpm db:generate --name user_role_owner_staff`. If drizzle-kit asks whether `staff` renames
   `cashier` or `waiter`, answer that it is a NEW value. Read the generated SQL once: it will start
   with `ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text` and end with the new CHECK.
3. REPLACE the whole SQL body with the sequence below, headed by a comment that says: drizzle-kit
   cannot express this change because three `users` objects depend on the type; this file was
   reordered by hand BEFORE its first run, which CLAUDE.md permits; never edit it again.
   ```sql
   ALTER TABLE "users" DROP CONSTRAINT "users_owner_has_credentials";
   --> statement-breakpoint
   ALTER TABLE "users" DROP CONSTRAINT "users_non_owner_has_no_credentials";
   --> statement-breakpoint
   DROP INDEX "users_one_owner_per_restaurant";
   --> statement-breakpoint
   ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;
   --> statement-breakpoint
   UPDATE "users" SET "role" = 'staff', "updated_at" = now() WHERE "role" IN ('cashier', 'waiter');
   --> statement-breakpoint
   DROP TYPE "public"."user_role";
   --> statement-breakpoint
   CREATE TYPE "public"."user_role" AS ENUM('owner', 'staff');
   --> statement-breakpoint
   ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING "role"::"public"."user_role";
   --> statement-breakpoint
   ALTER TABLE "users" ADD CONSTRAINT "users_owner_has_credentials" CHECK ("users"."role" <> 'owner' or ("users"."email" is not null and "users"."password_hash" is not null));
   --> statement-breakpoint
   ALTER TABLE "users" ADD CONSTRAINT "users_non_owner_has_no_credentials" CHECK ("users"."role" = 'owner' or ("users"."email" is null and "users"."password_hash" is null));
   --> statement-breakpoint
   CREATE UNIQUE INDEX "users_one_owner_per_restaurant" ON "users" USING btree ("restaurant_id") WHERE "users"."role" = 'owner';
   --> statement-breakpoint
   ALTER TABLE "users" ADD CONSTRAINT "users_owner_has_no_role_staff_has_one" CHECK (("users"."role" = 'owner') = ("users"."role_id" is null));
   ```
   The three recreated objects keep their names and their exact 0003 definitions:
   `constraints.integration.test.ts` asserts each by name.
4. Run `pnpm db:migrate` on the dev database, then `pnpm db:generate` again: it must report nothing
   to generate. `pnpm exec drizzle-kit check` must be clean.
5. Create `src/lib/server/db/test/seed.ts`:
   `seedRole(db, restaurantId, { name, permissionKeys }) → { id }` (inserts `roles` +
   `role_permissions`), and `seedStaff(db, restaurantId, { displayName, roleId?, roleName?,
   permissionKeys?, pinHash?, isActive? }) → { id, roleId }` which reuses a live role of that name in
   that restaurant or seeds `Cashier` with `CASHIER_KEYS` when nothing is given, then inserts the
   user with `role: 'staff'`, `email: null`, `passwordHash: null`. Keep it dumb: no audit rows.
6. The sweep. Run `pnpm check`; every error is a `role: 'cashier'`/`'waiter'` insert or a literal
   union. Replace inserts with `seedStaff`, unions with `'owner' | 'staff'`, and `ROLE_LABEL` maps
   with `{ owner: 'Owner', staff: 'Staff' }` (T-11 and T-14 replace those labels with the real role
   name). In `employees.ts`: `employeeSetupStatus` filters `eq(users.role, 'staff')`;
   `createEmployee` keeps its `{ role: 'cashier' | 'waiter' }` input for now and resolves it to the
   restaurant's LIVE role named `Cashier` or `Waiter` (T-03 seeded them), inserting
   `role: 'staff', roleId` — return `{ ok: false, reason: 'no_such_role' }` when it is missing.
   `listEmployees` and `listPosEmployees` return `role: 'staff'` for staff; the label is cosmetic
   until T-10/T-11/T-14.
7. `constraints.integration.test.ts` `users constraints`: rename the cashier/waiter cases to staff
   (create the role with `seedRole`), keep the assertions and the constraint NAMES, and add: a staff
   user with `role_id NULL` is rejected by `users_owner_has_no_role_staff_has_one`; an owner with a
   `role_id` is rejected by the same CHECK; inserting `role: 'cashier'` is rejected by the database
   (22P02, the value no longer exists).

**Tests:**
- Every unit and integration suite green (`pnpm test`), including the renamed constraint cases and
  the three new ones.
- Migration on a database WITH staff rows: on a scratch database (never dev): apply 0000–0009 only
  (checkout the previous commit's migrations folder, or `psql` the files in order), insert a
  restaurant, an owner and a `role: 'cashier'` user with `role_id NULL`, then apply 0009 and 0010:
  the cashier row ends with `role = 'staff'` and `role_id` = that restaurant's `Cashier` role; the
  CHECK holds. Record the commands in the commit message.

**Done when:** `pnpm db:generate` reports nothing to generate, `pnpm exec drizzle-kit check` is
clean, `pnpm check && pnpm lint && pnpm test` pass, `grep -rn "'cashier'\|'waiter'" src --include=*.ts
--include=*.svelte` matches only `DEFAULT_ROLES`/labels/e2e text and the 0009 SQL, and
`\dT+ user_role` on the dev database lists `owner, staff`.

**Watch out:** the e2e journey goes red at this task and stays red until T-11 and T-14; that is
expected and written in the plan header. Never run 0010 in two halves and never `ADD VALUE`:
PostgreSQL refuses to use a value added in the same transaction, and the migrator runs everything in
one. If `DROP TYPE` reports another dependent, stop and list it in the commit rather than adding
`CASCADE`.

---

## Phase 2 — Domain

**Depends on:** Phase 1. Business rules live in `src/lib/server/**`; routes validate, guard, call,
return. Every writer takes `DbTx` and writes its audit row with the same handle (invariant 10).

### T-06 — Build `permissions/roles.ts`: list, create, update, archive, `assertLiveRole`, `permissionsForUser`

**Needs:** T-05
**Files:**
- `src/lib/server/permissions/roles.ts` — NEW
- `src/lib/server/permissions/index.ts` — EDIT (re-export the new module's functions and types)
- `src/lib/server/audit/events.ts` — EDIT (three `role.*` members + `AUDIT_EVENT_NAMES`)
- `src/routes/(dashboard)/dashboard/event-text.ts` — EDIT (three sentences)
- `src/lib/server/permissions/roles.integration.test.ts` — NEW
**Spec:** 8 (User → Role → Permissions; the ten keys), 3 (sensitive actions audit-logged)
**Invariants:** 8 (the resolver is the server's only answer for staff), 9 (no role grants approval),
10 (audit row in the same transaction), 2 (roles are archived, never deleted)

**Do:**
1. Types and signatures, all tenant-scoped by an explicit `restaurantId` in every WHERE:
   ```ts
   export type RoleRow = { id: string; name: string; permissionKeys: PosPermissionKey[]; archivedAt: Date | null; activeStaffCount: number; staffCount: number };
   export type RoleInput = { name: string; permissionKeys: PosPermissionKey[] };
   export type RoleWriteContext = { actorUserId: string; ip: string | null; userAgent: string | null };
   export async function listRoles(database: Executor, restaurantId: string, opts?: { includeArchived?: boolean }): Promise<RoleRow[]>; // live first by name, archived last
   export async function getRole(database: Executor, restaurantId: string, roleId: string): Promise<RoleRow | null>;
   export async function createRole(tx: DbTx, restaurantId: string, input: RoleInput, ctx: RoleWriteContext): Promise<{ ok: true; id: string } | { ok: false; reason: 'invalid_name' | 'reserved_name' | 'duplicate_name' | 'invalid_keys' }>;
   export async function updateRole(tx: DbTx, restaurantId: string, roleId: string, changes: Partial<RoleInput>, ctx: RoleWriteContext): Promise<{ ok: true; changed: boolean } | { ok: false; reason: 'not_found' | 'archived' | 'invalid_name' | 'reserved_name' | 'duplicate_name' | 'invalid_keys' }>;
   export async function archiveRole(tx: DbTx, restaurantId: string, roleId: string, ctx: RoleWriteContext): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'already_archived' } | { ok: false; reason: 'in_use'; activeStaffCount: number }>;
   /** The role row, locked FOR SHARE for the rest of the transaction, or null when missing, foreign or archived. */
   export async function assertLiveRole(tx: DbTx, restaurantId: string, roleId: string): Promise<{ id: string; name: string } | null>;
   export async function permissionsForUser(database: Executor, restaurantId: string, userId: string): Promise<ReadonlySet<PermissionKey>>;
   ```
2. Validation, in code, before any SQL: `name` trimmed, 1–`ROLE_NAME_MAX` characters else
   `invalid_name`; lower-cased name in `RESERVED_ROLE_NAMES` → `reserved_name`; every key passes
   `isPosPermissionKey`, duplicates removed, at least one key else `invalid_keys`. The database's
   `role_permissions_key_pos_only` and `roles_name_not_owner` CHECKs are backstops, not the rule.
3. `createRole`: insert `roles`, insert one `role_permissions` row per key, write
   `role.created { name, permissionKeys }`. A 23505 on `roles_name_unique` (walk the cause chain
   as `api/pos/pin/+server.ts` does) → `{ ok: false, reason: 'duplicate_name' }`; anything else
   rethrows.
4. `updateRole`: `SELECT ... FOR UPDATE` the role by id AND restaurant; missing → `not_found`;
   `archived_at` set → `archived`. Diff name and keys against the row; no change → `{ ok: true,
   changed: false }` with NO audit row. Keys change = delete every `role_permissions` row of the role
   and insert the new set (configuration rows, not posted records). Write
   `role.updated { changes: { name?: { old, new }, permissionKeys?: { old, new } } }`.
5. `archiveRole`: lock the role `FOR UPDATE` FIRST, then `count(*)` of `users` with that `role_id`
   and `is_active = true`; `> 0` → `{ ok: false, reason: 'in_use', activeStaffCount }`; else set
   `archived_at = now()`, `updated_at`, write `role.archived { name }`. Locking before counting is
   what serialises against T-08's create and T-09's reactivate.
6. `assertLiveRole`: `select id, name from roles where id = $1 and restaurant_id = $2 and
   archived_at is null for share` (`.for('share')`); return the row or null. Under READ COMMITTED a
   waiter re-evaluates the WHERE on the row version that committed, so an archive that wins the lock
   makes this return null afterwards.
7. `permissionsForUser`: read `users` (`role`, `is_active`, `role_id`) by id AND restaurant; missing,
   foreign or inactive → empty set; `role = 'owner'` → `new Set(ALL_KEYS)`; staff → the keys of its
   `role_id`, filtered through `isPosPermissionKey`. Never throws for a bad id.
8. Audit events (`events.ts`): `role.created { name: string; permissionKeys: string[] }`,
   `role.updated { changes: Record<string, { old: unknown; new: unknown }> }`,
   `role.archived { name: string }`; add the three names to `AUDIT_EVENT_NAMES` and three sentences
   to `EVENT_TEXT` (`Role created`, `Role changed`, `Role archived`). No key here matches the secret
   pattern (`permissionKeys` does not contain `pin`).

**Tests** (`roles.integration.test.ts`, integration project):
- create → list returns the role with its keys sorted as given; `getRole` from another restaurant is
  null.
- `cashier` vs `Cashier` in one restaurant → `duplicate_name`; after archiving the first, the name is
  free.
- `Owner`, ` owner `, `OWNER` → `reserved_name`; 61 characters → `invalid_name`; `admin.settings` or
  `pos.sel` → `invalid_keys`; an empty key list → `invalid_keys`.
- update keys writes ONE `role.updated` row whose `changes.permissionKeys.old/new` are the exact
  lists; an identical update writes no row; a forced throw after the update leaves neither the
  change nor the row (transaction).
- archive with one ACTIVE holder → `in_use` with `activeStaffCount: 1`; with one INACTIVE holder →
  ok; archived twice → `already_archived`.
- `assertLiveRole` → null for archived, foreign and unknown ids; the row for a live one.
- `permissionsForUser`: owner → every `ALL_KEYS` entry; staff on `Cashier` → exactly the five;
  inactive staff → empty; unknown id → empty; the same user id under another restaurant id → empty.
- Concurrency, two transactions on `testDb()`: (a) A calls `archiveRole` and pauses on a deferred
  promise after the lock; B calls `assertLiveRole` on the same role, which blocks; A commits; B
  resolves to null. (b) B calls `assertLiveRole` and pauses holding FOR SHARE; A calls `archiveRole`,
  which blocks; B inserts a staff user with that role (`seedStaff`) and commits; A resolves to
  `in_use`.

**Done when:** `pnpm test:integration -- roles` passes, `pnpm check && pnpm lint` pass, and
`grep -n "role\." src/routes/(dashboard)/dashboard/event-text.ts` shows the three sentences.

**Watch out:** `permissions/roles.ts` imports `../db/schema/*`, `../audit` and the `Executor`/`DbTx`
types; it must not import `../auth/employees.ts` (that file imports this one). Do not write a
`role.updated` row for a no-op.

### T-07 — Seed default roles for new restaurants from the initializer

**Needs:** T-06
**Files:**
- `src/lib/server/restaurants/index.ts` — EDIT (a second entry in `restaurantInitializers`, after
  `insertSettingsRow`; the trailing "NOT HERE" comment gains a line saying roles ARE here)
- `src/lib/server/auth/register.integration.test.ts` — EDIT (one new case)
**Spec:** 8 (the two lists), 31
**Invariants:** 10 (the registration transaction is the one that writes them)

**Do:**
1. Add `async function insertDefaultRoles(tx, restaurantId)` that inserts, for each entry of
   `DEFAULT_ROLES` (imported from `../permissions/keys`, constants only), one `roles` row and its
   `role_permissions` rows with `onConflictDoNothing()` on both inserts, so a re-run is a no-op.
   Push it onto `restaurantInitializers` after `insertSettingsRow`. No audit row: registration
   already writes `restaurant.registered`; seeded configuration is part of that event.
2. `scripts/create-restaurant.ts` goes through `registerRestaurant`, so the operator path is covered
   without a change.

**Tests:**
- `register.integration.test.ts`: after `registerRestaurant(..., 'public')`, `listRoles` for the new
  restaurant returns exactly `Cashier` with `CASHIER_KEYS` and `Waiter` with `WAITER_KEYS`, and a
  second restaurant registered afterwards has its OWN two rows (four in total, two per tenant).

**Done when:** that case passes and the e2e fixture's later `createEmployee` (T-14) can pick
`Cashier` on a freshly registered restaurant.

**Watch out:** `restaurants/` imports `permissions/keys.ts` (constants) and the schema tables only —
never `permissions/roles.ts`, which imports `audit/`; the layering note in T-01 records this.

### T-08 — Rework the employees read and write model: list, get, create, update, setup status

**Needs:** T-06
**Files:**
- `src/lib/server/auth/employees.ts` — EDIT (rewrite `EmployeeRow`, `listEmployees`,
  `createEmployee`, `employeeSetupStatus`; add `getEmployee`, `updateEmployee`; keep
  `setEmployeePin` with a details change)
- `src/lib/server/audit/events.ts` — EDIT (`employee.created`, `employee.pin_set` shapes;
  `employee.updated` added)
- `src/routes/(dashboard)/dashboard/event-text.ts` — EDIT (`Employee changed`)
- `src/routes/(dashboard)/dashboard/+page.server.ts` — EDIT (`employeesReady: staff.staffWithPin`)
- `src/routes/(dashboard)/employees/+page.server.ts` and `+page.svelte` — EDIT (bridge only: the
  load also returns `roles: [{ id, name }]` from `listRoles`, the radios render one per live role
  with `value={role.id}` and the role's name as the label, the action reads `roleId`; T-14 replaces
  the radios)
- `src/lib/server/auth/employees.integration.test.ts`,
  `src/routes/(dashboard)/dashboard/dashboard.integration.test.ts` — EDIT
**Spec:** 7 (the owner's POS PIN is set here too), 8
**Invariants:** 2 (users rows may be updated; nothing posted is touched), 8 (every action guarded),
10 (audit in the same transaction)

**Do:**
1. ```ts
   export type EmployeeRow = { id: string; kind: 'owner' | 'staff'; displayName: string; roleId: string | null; roleName: string | null; roleArchived: boolean; hasPin: boolean; isActive: boolean; lockedUntil: Date | null; failedPinCount: number };
   export async function listEmployees(database: Executor, restaurantId: string): Promise<EmployeeRow[]>; // owner first, then active staff by name, then inactive by name
   export async function getEmployee(database: Executor, restaurantId: string, userId: string): Promise<EmployeeRow | null>;
   export async function createEmployee(tx: DbTx, restaurantId: string, input: { roleId: string; displayName: string; pin: string }, ctx: AuditContext): Promise<{ ok: true; id: string } | { ok: false; reason: 'role_not_live' }>;
   export async function updateEmployee(tx: DbTx, restaurantId: string, userId: string, changes: { displayName: string; roleId: string }, ctx: AuditContext): Promise<{ ok: true; changed: boolean } | { ok: false; reason: 'not_found' | 'owner' | 'role_not_live' }>;
   export async function employeeSetupStatus(database: Executor, restaurantId: string): Promise<{ staffWithPin: boolean }>;
   ```
   `listEmployees`/`getEmployee` left-join `roles`; `hasPin` stays computed in SQL (`pin_hash is
   not null`), the hash never enters memory; `lockedUntil` = `pin_locked_until` when it is in the
   future, else null; `kind` = `role`; owner rows carry `roleName: 'Owner'` (a label, and the name is
   reserved for roles so it cannot collide).
2. `createEmployee`: `assertLiveRole(tx, restaurantId, roleId)` → null → `role_not_live`; insert
   `role: 'staff'`, `roleId`, `email: null`, `passwordHash: null`, `pinHash: await hashPin(pin)`;
   write `employee.created { roleName, displayName }`.
3. `updateEmployee`: `SELECT ... FOR UPDATE` the user by id AND restaurant; missing → `not_found`;
   `role = 'owner'` → `owner` (the owner is never renamed here, whatever a form posts); when
   `roleId` differs from the current one, `assertLiveRole` → null → `role_not_live`. Diff
   `displayName` (trimmed) and the role; no change → `{ ok: true, changed: false }`, no audit row.
   Otherwise update and write `employee.updated { changes: { displayName?: { old, new }, role?:
   { old: <old role name>, new: <new role name> } } }`.
4. `employeeSetupStatus`: `exists(users where restaurant_id = $1 and role = 'staff' and is_active
   and pin_hash is not null)`; the dashboard reads `employeesReady: staff.staffWithPin`.
5. `setEmployeePin`: unchanged behaviour; details become `{ roleName }` (`'Owner'` for the owner).
6. `events.ts`: `employee.created { roleName: string; displayName: string }`,
   `employee.pin_set { roleName: string }`, new `employee.updated { changes: Record<string, { old:
   unknown; new: unknown }> }`; names list; `EVENT_TEXT['employee.updated'] = 'Employee changed'`.
7. The list page bridge (see Files): keep the alert text `${displayName} was added.` and the button
   `Create employee`, so `e2e/fixtures.ts` keeps working until T-14.

**Tests** (`employees.integration.test.ts`):
- `listEmployees` orders owner, active staff, inactive staff; carries `roleName` from the role and
  `roleArchived: true` once the role is archived; never a hash (assert no key matching `/hash|phc/i`).
- `createEmployee` with an archived role → `role_not_live`, no row, no audit; with a live one →
  `role: 'staff'`, `role_id` set, exactly one `employee.created` row in the same transaction.
- `updateEmployee`: renames and re-roles with ONE `employee.updated` row carrying old/new; a no-op
  writes no row; the owner's id → `owner` and nothing changes; another restaurant's id →
  `not_found`; an archived target role → `role_not_live`.
- `employeeSetupStatus`: false with no staff, false with a staff member and no PIN, false when the
  only PIN-holder is inactive, true otherwise; the owner's PIN never counts.
- `dashboard.integration.test.ts`: `employeesReady` follows `staffWithPin`.

**Done when:** `pnpm check && pnpm lint && pnpm test` pass and the list page still creates an
employee from a role radio (manual: `pnpm dev`, `/employees`).

**Watch out:** `listEmployees` selects explicit columns, never the whole users row (password and PIN
hashes). `employees.ts` imports `../permissions/roles` (for `assertLiveRole` and `listRoles`);
`roles.ts` must not import back.

### T-09 — Add deactivate, reactivate and clear-lockout with their audit events

**Needs:** T-08
**Files:**
- `src/lib/server/auth/employees.ts` — EDIT (three functions beside `updateEmployee`)
- `src/lib/server/audit/events.ts` — EDIT (`employee.deactivated` shape; `employee.reactivated`,
  `employee.lockout_cleared` added)
- `src/routes/(dashboard)/dashboard/event-text.ts` — EDIT (two sentences)
- `src/lib/server/auth/employees.integration.test.ts` — EDIT
**Spec:** 7 ("After 5 wrong attempts, the employee is locked out for 5 minutes"; the owner has a
POS PIN), 3 (audit)
**Invariants:** 10 (same transaction; no details key may match the secret pattern), 12 (PIN lockout
rules; clearing early is an owner action on the dashboard, never callable from the till)

**Do:**
1. ```ts
   export async function deactivateEmployee(tx: DbTx, restaurantId: string, userId: string, ctx: AuditContext): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'owner' | 'already_inactive' }>;
   export async function reactivateEmployee(tx: DbTx, restaurantId: string, userId: string, input: { roleId?: string }, ctx: AuditContext): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'owner' | 'already_active' | 'role_not_live' }>;
   export async function clearPinLockout(tx: DbTx, restaurantId: string, userId: string, ctx: AuditContext): Promise<{ ok: true; wasLocked: boolean } | { ok: false; reason: 'not_found' | 'nothing_to_clear' }>;
   ```
2. `deactivateEmployee`: `FOR UPDATE`; owner → `owner`; `is_active = false`, `updated_at`; write
   `employee.deactivated { roleName, displayName }`. The till drops the person on its next
   directory fetch (spec 6's pull model; nothing pushes).
3. `reactivateEmployee`: `FOR UPDATE`; owner → `owner`; target role = `input.roleId ?? current
   role_id`; `assertLiveRole` → null → `role_not_live` (this is the guard against an active employee
   on an archived role); set `is_active = true` and, when the role changed, `role_id`; write
   `employee.reactivated { roleName, displayName }` and, only when the role changed, one
   `employee.updated` row.
4. `clearPinLockout`: `FOR UPDATE`; allowed for the OWNER too (it is their approval PIN); if
   `failed_pin_count = 0` and `pin_locked_until` is null or past → `nothing_to_clear`; else set both
   to `0`/`null` and write `employee.lockout_cleared { displayName, failedCount, wasLocked }` where
   `failedCount` is the stored count before clearing (0 when a lock was set, by the verifier's
   convention) and `wasLocked` is whether `pin_locked_until` was in the future.
5. `events.ts`: `employee.deactivated { roleName: string; displayName: string }` (the unused
   `role: UserRole` shape is replaced), `employee.reactivated` same shape,
   `employee.lockout_cleared { displayName: string; failedCount: number; wasLocked: boolean }`;
   names list; `EVENT_TEXT`: `Employee reactivated`, `Employee PIN lockout cleared`.

**Tests:**
- deactivate → `is_active false`, one row, `listPosEmployees` no longer returns the person; twice →
  `already_inactive`; the owner → `owner`.
- The archived-role path: staff on `Waiter`, deactivate, `archiveRole(Waiter)` succeeds,
  `reactivateEmployee` with no `roleId` → `role_not_live`; with `roleId` of `Cashier` → ok, one
  `employee.reactivated` and one `employee.updated` row; the person is active on `Cashier`.
- `clearPinLockout`: after five wrong `verifyEmployeePin` attempts (lock set) → `{ ok: true,
  wasLocked: true }`, the next correct PIN succeeds; with nothing to clear → `nothing_to_clear`; the
  audit row's details keys are exactly `displayName`, `failedCount`, `wasLocked` (a key containing
  `pin` would throw inside `writeAudit` and roll the clear back).

**Done when:** `pnpm test:integration -- employees` passes and `pnpm check && pnpm lint` pass.

**Watch out:** never name a details key with `pin` in it (`pinLockedUntil`, `lockedPin`): the audit
writer refuses it and the action rolls back at runtime, not at compile time.

### T-10 — Ship `isOwner`, `roleName`, `permissions` in the POS bundle and the PIN response

**Needs:** T-06
**Files:**
- `src/lib/server/auth/employee-directory.ts` — EDIT (`PosEmployee`, `listPosEmployees`; add
  `posIdentity`)
- `src/lib/server/auth/pin.ts` — EDIT (`PosEmployeeIdentity`; the success branch reads the role
  name; `pos.pin.success` details)
- `src/routes/api/pos/pin/+server.ts` — EDIT (`Outcome`, `replayFor`, `respond`)
- `src/routes/api/pos/employees/+server.ts` — EDIT (comment only: "seven keys per entry")
- `src/lib/server/audit/events.ts` — EDIT (`pos.pin.success` details)
- `src/lib/server/auth/employee-directory.integration.test.ts`, `pin.integration.test.ts`,
  `src/routes/api/pos/employees/employees.integration.test.ts`,
  `src/routes/api/pos/pin/pin.integration.test.ts` — EDIT
**Spec:** 6 (the bundle cached on the registered device; PIN hashes travel, deliberately), 7, 8
**Invariants:** 5 (the bundle is the till's offline truth; the PIN route's idempotent replay stays
byte-for-byte), 8 (`requireDevice` first, unchanged), 12

**Do:**
1. `PosEmployee = { id: string; displayName: string; isOwner: boolean; roleName: string;
   permissions: PermissionKey[]; isActive: boolean; pinPhc: string | null }` — SEVEN keys, the
   field `pinPhc` keeps its tripwire name. `listPosEmployees`: active users left-joined to `roles`,
   then ONE query over `role_permissions` for the restaurant grouped by `role_id`; owner rows get
   `isOwner: true`, `roleName: 'Owner'`, `permissions: [...POS_KEYS]` (the till only ever asks about
   POS keys; the server's `permissionsForUser(owner)` is `ALL_KEYS`); staff get their role's keys
   sorted in `POS_KEYS` order. Order: owner first, then `roleName`, then `displayName`.
2. Add `posIdentity(database: Executor, restaurantId: string, userId: string): Promise<{ id;
   displayName; isOwner; roleName } | null>` for the PIN route's replay and the verifier.
3. `pin.ts`: `PosEmployeeIdentity = { id; displayName; isOwner: boolean; roleName: string }`; after
   a correct PIN, read the role name inside the transaction (a second select, or `posIdentity(tx,
   ...)`); `pos.pin.success` details become `{ deviceCode, roleName }`.
4. `api/pos/pin/+server.ts`: success body `{ employeeId, displayName, isOwner, roleName }`;
   `replayFor` rebuilds it with `posIdentity`; 401/423 bodies unchanged; the idempotency lookup
   unchanged.
5. `events.ts`: `pos.pin.success { deviceCode: string; roleName: string }`.

**Tests:**
- MANDATORY (spec 29 — permission checks on every POS API): `src/routes/api/pos/permissions.integration.test.ts`
  keeps passing unchanged: no new route, both routes still answer 403 first without a device.
- `employees.integration.test.ts` (API): every entry serialises EXACTLY the seven keys above and
  the top level exactly `device`, `employees`, `settings`; the owner entry is first with
  `isOwner: true` and the ten POS keys; a `Cashier` carries the five cashier keys; a staff member
  whose role gained a key sees it on the next GET; a deactivated employee is absent.
- `pin.integration.test.ts`: the 200 body carries `isOwner` and `roleName`; the replay of a lost
  response carries the same; `pos.pin.success` details are `{ deviceCode, roleName }`.

**Done when:** `pnpm test:integration -- pos` passes and `pnpm check && pnpm lint` pass.

**Watch out:** the bundle is returned AS-IS from the read model (not widened, not narrowed) and
still `cache-control: no-store`. Never put `permissions` or `roleName` into an audit `details`
under a key containing `pin`.

---

## Phase 3 — Offline

**Depends on:** Phase 2 (T-10). `lib/pos` imports nothing from `lib/server`; the till caches what
the bundle sends and must keep working on rows cached by the previous build.

### T-11 — Cache the new bundle shape on the till and show role names

**Needs:** T-10
**Files:**
- `src/lib/pos/store.ts` — EDIT (`CachedEmployee`, `cacheEmployees`, `readCachedEmployees`)
- `src/lib/pos/store.test.ts` — EDIT
- `src/routes/(pos)/pos/+page.svelte` — EDIT (`DirectoryEntry`, `Choice`, the tile's second line)
- `src/routes/(pos)/pos/pin/+page.svelte` — EDIT (`signedIn`, the offline branch, the heading)
- `e2e/pos-offline.spec.ts` — EDIT (the cached-row shape assertions)
**Spec:** 4 (IndexedDB holds the employee list), 6 (offline employee switching from cached hashes)
**Invariants:** 5 (`offline_logins` untouched; a retry stays a no-op), 12

**Do:**
1. `CachedEmployee = { id; displayName; isOwner: boolean; roleName: string; permissions: string[];
   isActive; pinPhc: string | null }`. `cacheEmployees` stores exactly those seven keys
   (clear-and-replace, unchanged). No `DB_VERSION` bump: the object store is the same, only the row
   shape grew.
2. `readCachedEmployees` NORMALISES rows written by the previous build, which carry `role` and lack
   the three new keys: `isOwner ??= role === 'owner'`, `roleName ??= { owner: 'Owner', cashier:
   'Cashier', waiter: 'Waiter' }[role] ?? 'Staff'`, `permissions ??= []`. The next successful
   directory fetch replaces them. `verifyCachedPin` is unchanged.
3. Employee select: the tile's second line shows `roleName` (no `ROLE_LABEL` map); the "no PIN set
   yet" wording stays. PIN screen: `signedIn = { displayName, roleName }` from the 200 body online
   and from the cached row offline; the heading stays `Signed in as {displayName} ({roleName})`, so
   `e2e` `/Signed in as The Cashier/` still matches.
4. `permissions` is cached and NOT used for anything yet: the till cannot sell. Leave a comment:
   the sales plan reads it to enable controls offline, and the server re-checks on sync.

**Tests:**
- `store.test.ts`: caches seven keys and no eighth; an old-shape row put directly into the store
  reads back normalised; `bindDevice` to another device still clears the rows; `verifyCachedPin`
  unchanged.
- MANDATORY (spec 29 — offline retries never duplicate): the existing `recordOfflineLogin` retry
  case stays green untouched.
- `e2e/pos-offline.spec.ts`: `storeRows(tillPage, 'employees')` expectations list the seven keys
  and the role names `Cashier`/`Waiter`.

**Done when:** `pnpm test:unit -- store` passes, `pnpm check && pnpm lint` pass, and the pos-offline
spec is green once T-14 has landed (T-18 runs it).

**Watch out:** the normalisation must never THROW on a malformed row: a till that cannot read its
cache signs nobody in offline, which is worse than a blank label.

---

## Phase 4 — UI primitives

**Depends on:** Phase 0. Screens compose primitives (`docs/design-system.md` §7b); a screen that
retypes class strings is the defect the primitives exist to stop. Every primitive takes props and
imports nothing from `$lib/server` (`src/lib/components/components.test.ts` discovers new files
automatically).

### T-12 — Add CheckField, SelectField, Table; extend StatusMark; document them

**Needs:** T-01
**Files:**
- `src/lib/components/ui/CheckField.svelte` — NEW
- `src/lib/components/ui/SelectField.svelte` — NEW
- `src/lib/components/ui/Table.svelte` — NEW
- `src/lib/components/ui/StatusMark.svelte` — EDIT (a third status; the header comment)
- `src/lib/components/ui/index.ts` — EDIT (three exports)
- `src/lib/components/ui/primitives.test.ts` — NEW (source-level assertions, the `sidebar.test.ts`
  idiom)
- `docs/design-system.md` — EDIT (§7b: a "Primitives" list, the table rule, the StatusMark
  vocabulary)
**Spec:** 8 (the roles page needs a checkbox per key)
**Invariants:** none directly; the design rules in CLAUDE.md "Design & UI" (tokens only, colour
never alone, control borders `border-control-line`, WCAG AA)

**Do:**
1. `CheckField`: props `{ id, name, value, label, checked = false, hint = '', disabled = false,
   disabledReason = '' }`. Markup: one wrapper `div.flex.flex-col.gap-1`, a `<label for={id}>` whose
   text is EXACTLY `label` wrapping `<input type="checkbox" {id} {name} {value} {checked}
   {disabled} class="accent-accent">` then the text, then the hint (`text-ink-3 text-xs`; legal
   because it sits inside a `bg-raise` card) and the disabled reason as a sibling `<span>` linked
   by `aria-describedby`, the Button idiom.
2. `SelectField`: props `{ id, name, label, value = '', required = false, hint = '', error = '',
   placeholder = '', options: { value: string; label: string; disabled?: boolean }[] , disabled =
   false, disabledReason = '' }`. Label above, `<select>` with the SAME control class Field uses
   (`border-control-line bg-bg text-ink rounded-control border px-3 py-2`), a first disabled
   placeholder option when `placeholder` is set and `value` is empty, hint, error (no `role=alert`,
   as Field). The label text is the accessible name: no suffix, no asterisk.
3. `Table`: `<script lang="ts" generics="Row extends { id: string }">`, props `{ caption: string;
   columns: { key: string; label: string; numeric?: boolean }[]; rows: Row[]; cell: Snippet<[Row,
   string]>; empty?: string }`. Markup: `<table class="w-full">`, `<caption class="sr-only">`,
   `<thead class="hidden md:table-header-group">` with `text-ink-2 text-xs` headers, one `<tr
   class="border-line block border-t py-3 md:table-row md:py-0">` per row, each `<td class="flex
   items-baseline justify-between gap-3 md:table-cell md:py-3 md:pr-4">` rendering `<span
   class="text-ink-3 text-xs md:hidden">{column.label}</span>` then `{@render cell(row,
   column.key)}`; numeric columns add `font-mono tabular-nums md:text-end`. Below `md` a row stacks
   into label/value pairs, so NOTHING scrolls horizontally at any width. With zero rows render one
   line: `○ {empty}` in `text-ink-2`.
4. `StatusMark`: add `blocked: { glyph: '✕', tone: 'text-danger' }` and extend the prop type to
   `'done' | 'not-started' | 'blocked'`. Rewrite the header: the dashboard vocabulary is now `●`
   done/active, `○` not started/inactive, `✕` blocked (locked, archived); spec 13's item and order
   statuses still arrive with the orders plan.
5. `docs/design-system.md` §7b: add a **Primitives** paragraph listing the eleven components and
   one line each; a **Tables** rule (stack below `md`, never scroll; money and counts in `font-mono`
   right-aligned); update the "Empty and not-started states" line to the three-glyph vocabulary.

**Tests** (`primitives.test.ts`, unit):
- `CheckField.svelte` contains `type="checkbox"` inside a `<label` element; `SelectField.svelte`
  contains `<select` and `border-control-line`; `Table.svelte` contains `sr-only` on the caption
  and `md:hidden` on the per-cell label; `StatusMark.svelte` contains the three glyphs; none of the
  three new files contains an arbitrary value (`/\[#|\[\d+px\]/`), `p-touch` or `--c-screen`.
- `pnpm test:unit -- components` (the boundary test) passes untouched.

**Done when:** `pnpm check && pnpm lint && pnpm test:unit` pass and `pnpm build` succeeds.

**Watch out:** one `role="alert"` per page is the journey's strict-mode rule: no primitive here
renders one. Do not add a token; the three files use existing utilities only.

### T-13 — Add PinField: digits only, 4–6, masked, show/hide

**Needs:** T-12
**Files:**
- `src/lib/components/ui/PinField.svelte` — NEW
- `src/lib/components/ui/index.ts` — EDIT (export)
- `src/lib/components/ui/primitives.test.ts` — EXTEND (created by T-12; a PinField block)
- `docs/design-system.md` — EDIT (§7b: a "PIN fields" paragraph)
**Spec:** 7 (PINs are 4–6 digits)
**Invariants:** 12 (PIN never logged, never in a URL; digits-only is UX, the server rule is the
control)

**Do:**
1. Props `{ id, name, label, hint = '4 to 6 digits.', error = '', required = false }`. State
   `value = $state('')`, `revealed = $state(false)`. Import `PIN_MIN_DIGITS`, `PIN_MAX_DIGITS` from
   `$lib/pin` (isomorphic; allowed in a component).
2. Markup, Field's anatomy: `<label for={id}>` with EXACTLY `label`; a row with the input and a
   toggle; hint; error. The input: `type={revealed ? 'text' : 'password'}`, `inputmode="numeric"`,
   `pattern="[0-9]*"`, `maxlength={PIN_MAX_DIGITS}`, `minlength={PIN_MIN_DIGITS}`,
   `autocomplete="off"`, `{required}`, the Field control class, `oninput` handler:
   `const digits = target.value.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS); target.value = digits;
   value = digits;` — this covers typing AND paste, since paste fires `input`. The toggle is the
   `Button` primitive, `variant="ghost"`, `type="button"`, `aria-pressed={revealed}`, text
   `Show PIN` / `Hide PIN`.
3. The component never logs, never reads the URL, never stores the value anywhere but the input.
4. §7b: "PIN fields: `PinField` only — digits, 4 to 6, masked with a show/hide toggle; the server
   rejects anything else and that rejection is the control."

**Tests:**
- `primitives.test.ts`: `PinField.svelte` contains `inputmode="numeric"`, `pattern="[0-9]*"`,
  `maxlength`, `replace(/\D/g, '')`, `aria-pressed`, and does not contain `console.`,
  `localStorage` or `sessionStorage`.
- Behaviour is asserted end to end in T-18 (typing `12ab34` leaves `1234`).

**Done when:** `pnpm check && pnpm lint && pnpm test:unit` pass.

**Watch out:** the label text stays exactly the caller's `label`: `e2e/fixtures.ts` locates the
input with `getByLabel('PIN', { exact: true })`, and a toggle whose accessible name is `Show PIN`
does not collide with it.

---

## Phase 5 — Dashboard pages

**Depends on:** Phases 2 and 4. Every load and every form action begins with
`requirePermission(event, 'admin.employees')` and answers 403 to anyone else (invariant 8); the
tenant is `event.locals.restaurantId` in every WHERE and no id from a form or a URL is trusted
alone; every action runs in ONE `db.transaction` that also writes the audit row (invariant 10); a
load returns explicit object literals, never a spread row (hashes never reach the browser).

### T-14 — Rebuild `/employees`: table, add form with a role select, header action

**Needs:** T-08, T-12, T-13
**Files:**
- `src/routes/(dashboard)/employees/+page.server.ts` — EDIT (load; the `createEmployee` action;
  DELETE the `setPin` action, it moves to T-15)
- `src/routes/(dashboard)/employees/+page.svelte` — EDIT (rewrite the markup)
- `src/lib/server/auth/employees.integration.test.ts` — EDIT (the page's load/action cases)
- `e2e/fixtures.ts` — EDIT (`createEmployee`: the role select)
**Spec:** 7, 8
**Invariants:** 8, 10, 11 (lockout times shown in the restaurant's time zone)

**Do:**
1. Load: `listEmployees`, `listRoles` (live only), `getRestaurantWithSettings` for `timeZone`.
   Return `{ employees: rows.map(r => ({ id, kind, displayName, roleName, roleArchived, hasPin,
   isActive, lockedUntil, failedPinCount })), roles: [{ id, name }], timeZone }`.
2. Action `createEmployee`: zod `{ displayName: trim 1–200, roleId: z.uuid(), pin:
   /^[0-9]{4,6}$/ }`; `role_not_live` → `fail(400, { message: 'Choose a role.' })`; success message
   stays `${displayName} was added.` (e2e asserts it).
3. Markup: `PageHeader` eyebrow `Setup`, title `Employees`, description "The people who sign in at
   the till, what each may do there, and the PIN each one types. The owner's PIN also approves
   refunds, voids and the other sensitive actions.", and an `actions` snippet with `<Button
   href={resolve('/employees/roles')} variant="secondary">Manage roles</Button>`. ONE `Alert`. A
   `Card class="max-w-page"` titled `Staff` with a `Table` (caption `Staff`): columns Name, Role,
   PIN, Status. Name cell: a link to `resolve('/employees/[id]', { id })` with the display name;
   Role cell: `roleName`, plus `StatusMark status="blocked" label="archived"` when `roleArchived`;
   PIN cell: `StatusMark done "PIN set"` or `not-started "No PIN yet"`; Status cell: `done
   "Active"`, `not-started "Inactive"`, and when `lockedUntil` is set `blocked "Locked until HH:MM"`
   formatted with `Intl.DateTimeFormat` in `data.timeZone` (the device page's `when()` idiom).
   Inactive rows take `text-ink-3` (legal: the card is `bg-raise`). Empty state text: "No staff yet.
   Add the first person below."
4. `Card class="max-w-form"` `Add an employee`: `Field` Name, `SelectField` Role (options from
   `data.roles`, placeholder `Choose a role`, hint "What a role may do at the till is set under
   Manage roles."), `PinField` PIN, `Button variant="primary"` `Create employee`. When
   `data.roles` is empty, the select is disabled with reason "Create a role first" and the hint
   links to Manage roles. Delete every per-row Set-PIN form and the radio fieldset.
5. `e2e/fixtures.ts` `createEmployee`: replace the radio click with
   `page.getByLabel('Role', { exact: true }).selectOption({ label: employee.role === 'cashier' ?
   'Cashier' : 'Waiter' })`; keep every other locator.

**Tests:**
- Integration: the load's returned keys are exactly those listed (no `pinHash`, no `pinPhc`, no
  `email`); a cashier session gets 403 on the load and the action (`route-guards.integration.test.ts`
  already lists this route); creating with an archived role → 400 `Choose a role.`; creating with a
  live role → 200 and the alert text.
- The journey's `createEmployee` fixture works against the new form (proved in T-18).

**Done when:** `pnpm check && pnpm lint && pnpm test` pass; `pnpm dev` shows the table, the header
action and the add form; nothing scrolls horizontally at 360px width.

**Watch out:** exactly one `role="alert"` on the page. No money on this screen. The owner's row
links to the edit page like any other; the edit page decides what the owner may change.

### T-15 — Build `/employees/[id]`: details, PIN, lockout, status

**Needs:** T-09, T-12, T-13
**Files:**
- `src/routes/(dashboard)/employees/[id]/+page.server.ts` — NEW
- `src/routes/(dashboard)/employees/[id]/+page.svelte` — NEW
- `src/routes/(dashboard)/employees/[id]/employee.integration.test.ts` — NEW
- `src/routes/route-guards.integration.test.ts` — EDIT (add `'/(dashboard)/employees/[id]'` to the
  dashboard route-id array)
**Spec:** 7 (set the owner's approval PIN; the lockout rule), 8
**Invariants:** 8, 10, 11, 12

**Do:**
1. Load: `requirePermission`; `z.uuid()` on `event.params.id` else 404; `getEmployee` → null →
   `error(404, 'Employee not found')` (a foreign restaurant's id is a 404, not a hint); `listRoles`
   live; when the employee's role is archived, append `{ value: roleId, label: `${roleName}
   (archived)`, disabled: true }` to the options; `timeZone`. Return explicit literals.
2. Actions, each guarded again and each in one `db.transaction`:
   - `update` `{ displayName, roleId }` → `updateEmployee`; `owner` → `fail(400, 'The owner is not
     edited here.')`; `role_not_live` → `fail(400, 'Choose a live role: that one is archived.')`;
     `not_found` → `fail(400, 'That employee was not found.')`; ok → `Saved.` or `Nothing to save.`
   - `setPin` `{ pin }` → `setEmployeePin`; `PIN set.`
   - `clearLockout` → `clearPinLockout`; `Lockout cleared.` / `nothing_to_clear` → `fail(400, 'There
     is no lockout to clear.')`
   - `deactivate` → `deactivateEmployee`; `${name} was deactivated. The till drops them the next
     time it loads the staff list.`
   - `reactivate` `{ roleId? }` → `reactivateEmployee`; `role_not_live` → `fail(400, 'Choose a
     role first: ${roleName} is archived.')`; `${name} was reactivated.`
3. Markup: `PageHeader` eyebrow `Employees`, title = display name, description = `roleName` (the
   owner: `Owner · holds every permission`), actions snippet: `Button variant="ghost"
   href={resolve('/employees')}` `All employees`. ONE `Alert`. Cards, `max-w-form`:
   - `Details` (staff only): `Field` Name, `SelectField` Role, `Button variant="primary"` `Save`
     (the page's one primary). For the owner this card is a paragraph: "The owner's name is
     changed on Settings."
   - `PIN`: `StatusMark` PIN set / No PIN yet; `PinField` label `New PIN`; `Button secondary` `Set
     PIN`; then the lockout line: locked → `StatusMark blocked "Locked until HH:MM after 5 wrong
     attempts"` and a form with `Button secondary` `Clear lockout`; not locked but
     `failedPinCount > 0` → "N wrong attempts so far" and the same button; else "No lockout."
   - `Status` (staff only): active → `StatusMark done "Active"`, `Button variant="danger"`
     `Deactivate`, a caption "They disappear from the till the next time it loads the staff list;
     nothing they did is deleted."; inactive → `StatusMark not-started "Inactive"`, and when the
     role is archived a `SelectField` of live roles with hint "`${roleName}` is archived; choose a
     role to reactivate.", then `Button secondary` `Reactivate`.
4. Add the route id to the 403 array.

**Tests** (`employee.integration.test.ts`):
- MANDATORY-style guard: a cashier session on the load and on each of the five actions → 403 (the
  route-guards array drives the load; drive the actions here).
- Load: a foreign restaurant's employee id → 404; the owner's load carries `kind: 'owner'`.
- Each action's happy path, the owner refusals (`update`, `deactivate`, `reactivate` → 400 with the
  message; `setPin` and `clearLockout` succeed for the owner), and reactivate on an archived role
  → 400 then ok with a live `roleId`.
- The load never carries a key matching `/hash|phc|email|password/i`.

**Done when:** `pnpm check && pnpm lint && pnpm test` pass and, in `pnpm dev`, the owner can set
their approval PIN from their own row, rename a staff member, move them to another role, lock and
clear a PIN, deactivate and reactivate.

**Watch out:** `event.params.id` is validated as a uuid BEFORE any query, and the tenant is always
in the WHERE; a 404 for a foreign id, never a 403 (403 is for a caller who lacks the permission).

### T-16 — Build `/employees/roles`: create, edit keys, rename, archive

**Needs:** T-06, T-12
**Files:**
- `src/routes/(dashboard)/employees/roles/+page.server.ts` — NEW
- `src/routes/(dashboard)/employees/roles/+page.svelte` — NEW
- `src/routes/(dashboard)/employees/roles/roles-page.integration.test.ts` — NEW
- `src/routes/route-guards.integration.test.ts` — EDIT (add `'/(dashboard)/employees/roles'`)
**Spec:** 8 (the ten keys; "hiding buttons in the frontend is not considered security")
**Invariants:** 8, 9 (no key here grants approval; the approval list is owner PIN only), 10

**Do:**
1. Load: `requirePermission`; `listRoles(db, restaurantId, { includeArchived: true })`; return
   `{ roles: [{ id, name, permissionKeys, archivedAt, activeStaffCount, staffCount }], keys:
   POS_KEYS.map(key => ({ key, label: PERMISSION_LABELS[key] })) }`.
2. Actions: `create` `{ name, permissionKeys }` (`form.getAll('permissionKeys')`, zod
   `z.array(z.enum(POS_KEYS)).min(1)`) → `createRole`; `update` `{ roleId, name, permissionKeys }`
   → `updateRole`; `archive` `{ roleId }` → `archiveRole`. Messages: `duplicate_name` → 'A role with
   that name already exists.'; `reserved_name` → 'Owner is reserved for the owner.';
   `invalid_keys` → 'Pick at least one permission.'; `invalid_name` → 'Enter a name of up to 60
   characters.'; `archived` → 'That role is archived.'; `in_use` → '`${n}` active staff hold this
   role. Move them to another role first.'; success: 'Role created.', 'Role saved.' / 'Nothing to
   save.', 'Role archived.'.
3. Markup: `PageHeader` eyebrow `Employees`, title `Roles`, description "What each role may do at
   the till. A change reaches the till the next time it loads the staff list.", actions: ghost
   `All employees`. ONE `Alert`. One `Card class="max-w-form"` per LIVE role: a form `?/update`
   with hidden `roleId`, `Field` Name, a `<fieldset>` with `<legend>` `Permissions at the till`
   and one `CheckField` per `data.keys` (name `permissionKeys`, value = key, checked when the role
   holds it), a line "`${staffCount}` staff, `${activeStaffCount}` active", `Button secondary`
   `Save role`; and a second form `?/archive` with `Button variant="danger"` `Archive`, disabled
   with reason "In use by `${activeStaffCount}` active staff" when that count is above zero. After
   the live roles, a `Card` `Archived roles` listing each with `StatusMark blocked` and its name (no
   form), or "None." Last, a `Card` `New role` with the same fields and `Button variant="primary"`
   `Create role` (the one primary on the page).
4. Add the route id to the 403 array.

**Tests** (`roles-page.integration.test.ts`):
- A cashier session → 403 on the load and the three actions.
- `create` with `admin.settings` in `permissionKeys` → 400 before any row is written (zod), and
  the database CHECK would refuse it anyway (assert both: the action's status, then a direct insert
  → 23514).
- `create` `Owner` → 400 reserved; duplicate → 400; happy path → the role and its keys exist and the
  alert text.
- `update` changes keys and writes one `role.updated`; `archive` with an active holder → 400 with
  the count; after deactivating the holder → ok, and the name is free for a new role.

**Done when:** `pnpm check && pnpm lint && pnpm test` pass and, in `pnpm dev`, a new role `Runner`
with `pos.create_order` and `pos.send_to_kitchen` appears in the add-employee select on `/employees`.

**Watch out:** the ten checkboxes are ALL the keys a role can hold; never render an `admin.*` key
here, and never coin a key: a needed key that is not in spec 8 is a stop-and-ask.

### T-17 — Redefine the onboarding step

**Needs:** T-08
**Files:**
- `src/routes/(dashboard)/dashboard/+page.svelte` — EDIT (the `Employees and PINs` step's `detail`)
- `e2e/pos-access.spec.ts` — EDIT (the checklist expectation near the "Employees needs a cashier AND
  a waiter" comment)
**Spec:** 7
**Invariants:** none

**Do:**
1. `detail: 'Add at least one staff member with a PIN for the POS.'`; label and cta unchanged
   (`e2e/auth.spec.ts` counts six `not started` marks and clicks `Add employees`).
2. In `pos-access.spec.ts`, the step turns `done` after ONE cashier with a PIN is created; update
   the comment and the assertion accordingly.

**Tests:** `dashboard.integration.test.ts` (T-08) covers the boolean; the journey covers the copy.

**Done when:** `pnpm check && pnpm lint && pnpm test` pass; the e2e run in T-18 passes this step.

---

## Phase 6 — Verification

**Depends on:** every phase. The journey went red at T-05 by design; this phase makes it green and
proves the migration sequence in both directions.

### T-18 — Verify: e2e journeys, the migration sequence, every command green

**Needs:** T-11, T-14, T-15, T-16, T-17
**Files:**
- `e2e/auth.spec.ts` — EDIT (one PinField assertion on `/employees`: fill `12ab34`, expect the
  input value `1234`; click `Show PIN`, expect `type="text"`; click `Hide PIN`, expect
  `type="password"`; then clear and continue the journey)
- `e2e/pos-access.spec.ts`, `e2e/pos-offline.spec.ts`, `e2e/fixtures.ts` — EDIT only where a run
  still fails after T-11, T-14 and T-17 (the role names and the seven cached keys)
**Spec:** 29 (the six mandatory areas; a backup before every migration)
**Invariants:** 5, 8, 10, 12

**Do:**
1. `pnpm check && pnpm lint && pnpm test && pnpm build`.
2. `pnpm test:e2e` (against the production build). Then, WITHOUT truncating, `pnpm test:integration`
   again: this is the order that migrates a database still holding e2e staff rows, the exact
   sequence risk 2 in the header describes. Both green.
3. Fresh-database proof, on `matcami_test` ONLY (the name must end in `_test`; the integration
   setup refuses anything else): `psql "$TEST_DATABASE_URL" -c 'drop schema public cascade; create
   schema public; drop schema if exists drizzle cascade;'`, then `pnpm test:integration` — the
   global setup applies 0000–0010 in one transaction on an empty database.
4. `pnpm db:generate` prints that there is nothing to generate; `pnpm exec drizzle-kit check` is
   clean; `git status` shows no stray migration or snapshot file.
5. Dev database: `pnpm db:migrate` already ran in T-02/T-03/T-05; confirm with
   `psql "$MIGRATE_DATABASE_URL" -Atc "select enumlabel from pg_enum e join pg_type t on t.oid =
   e.enumtypid where t.typname = 'user_role' order by enumsortorder"` → `owner`, `staff`, and the
   roles count query from T-03.
6. Manual pass in `pnpm dev`: register a restaurant, open `/employees` (two seeded roles in the
   select), create `Runner` on `/employees/roles`, add a staff member on it, open the till, sign in,
   see `Signed in as ... (Runner)`; archive `Runner` → refused while they are active; deactivate
   them, archive `Runner`, reactivate → refused until a live role is chosen.
7. Re-read every file this plan touched for a leftover `cashier`/`waiter` literal outside
   `DEFAULT_ROLES`, `PERMISSION_LABELS`, the store's old-row normalisation map (T-11), the
   0009/0010 SQL, `seedStaff`'s default role name and e2e display names; remove any.

**Tests:** the whole suite is the test. The six spec 29 areas this plan touches: permission checks
on every POS API (unchanged and green), offline retries never duplicate (unchanged and green).

**Done when:** every command in steps 1–4 is green in one run on one machine, step 5 prints the
expected values, and the PR description lists the commands with their output summaries.

**Watch out:** never point step 3 at `DATABASE_URL` or `MIGRATE_DATABASE_URL`; the schema drop is
for the test database alone.
