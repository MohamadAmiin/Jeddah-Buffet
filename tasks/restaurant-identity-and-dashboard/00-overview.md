# Restaurant identity, owner authentication and the dashboard shell

**Goal.** Give matcami its first business feature: a `restaurants` aggregate with settings, an owner
account created by a one-time-token-gated registration flow, email + password login/logout on secure
cookie sessions, a server-side authorisation guard, the audit-log writer every later plan calls, and
the owner's dashboard shell with an onboarding checklist and a settings page.

Every table created from this plan onward carries `restaurant_id NOT NULL`, and the runtime connects
to PostgreSQL as a **non-owner role**, so PostgreSQL row-level security can later be switched on with
one migration instead of a database re-bootstrap. That is the whole of "multi-tenant" in this plan:
the seams, not the SaaS.

This plan writes **no money code, no journal entry, no stock movement, no PIN, no POS device and no
offline path.** It creates the ground those stand on.

## Requirements (as agreed with the user, 2026-09-13)

The user asked, in their own words, to "make this project multi tenant", to "create the first
registration pages and the login", and "the main admin dashboard", and asked for the best technical
and business workflow. Four decisions were put to them at the planning gate and answered:

1. **Tenancy model — HYBRID: tenant-ready plus the database role split.** Every table carries
   `restaurant_id`; every server module takes `restaurantId` as an explicit parameter; the database
   bootstrap gains a non-owner runtime role now. No row-level security policies yet, no public
   signup, no email, no billing, no restaurant suspension.
2. **"Main admin dashboard" — the RESTAURANT OWNER's dashboard** that spec 7 describes. **No platform
   operator console.** Nothing in this plan builds a vendor-facing surface.
3. **First owner account — a ONE-TIME SETUP TOKEN.** `/register` answers only while zero restaurants
   exist **and** the submitted token matches `SETUP_TOKEN`. Additional restaurants are created by an
   operator script, never by a public URL.
4. **Go-ahead to write this plan** was given after the risk panel and approaches were presented.

## Scope

**IN** — the `matcami_app` runtime role and the split connection URLs · `restaurants`,
`restaurant_settings`, `users`, `sessions`, `audit_log` · the first generated migration plus one
custom migration for the audit append-only trigger · the integration-test database harness (migrate +
reset) · argon2id password hashing · cookie sessions with sliding expiry · login with lockout and
throttling · token-gated registration · the permission key map and route guards ·
`src/hooks.server.ts` · `/login`, `/logout`, `/register` · the `(dashboard)` shell, `/dashboard`
overview with onboarding checklist, `/settings` · operator scripts for password reset and creating an
additional restaurant · the end-to-end auth journey · `.env.example`, deploy notes and the CLAUDE.md
updates this plan earns.

**OUT** — everything on CLAUDE.md's "Do NOT build" list · row-level security policies and
`withTenant()` (the role split makes them a later migration; see Assumption 4) · public self-service
signup · email sending, email verification and self-service password reset · restaurant suspension
and any `status` column · billing · a platform-operator console · POS PIN login, `pin_hash`, device
registration and the device cookie · any money column, any account code, any posting rule, any stock
movement · the menu, employees, tables, purchases, expenses and reports pages (the checklist names
them; their plans do not exist) · IndexedDB, the service worker, the sync queue, the print agent ·
tax mode, tax rate, currency, approval limits and idle-lock timing as settings columns (open
decisions 3, 4 and 6 — see Assumption 6).

## Approach

**Chosen: tenant-ready schema and explicit module scoping, plus a database role split, with
registration gated by a one-time setup token.**

Concretely: `restaurant_id NOT NULL` on every tenant table with a unit test that enforces it on every
future table; every server module function takes `restaurantId` explicitly and filters by it; routes
call modules and are forbidden by lint from importing the database client; the runtime role is not
the table owner, so adding `ENABLE ROW LEVEL SECURITY` plus policies later needs no re-bootstrap and
no privilege re-grant.

**Rejected — full multi-tenant SaaS now** (public signup, email verification, row-level security,
suspension). It contradicts spec 31, which lists "Multi-tenant SaaS" under Later, and CLAUDE.md's
do-not-build list, so it would require amending both. The risk panel returned one BLOCKER and five
MAJOR findings that apply only to it, including: `FORCE ROW LEVEL SECURITY` on tables owned by the
app role makes `pg_dump` fail, which breaks `pnpm db:migrate` because it chains the backup; policies
that are fail-closed on `users` make login and session validation return zero rows; and per-tenant
restore becomes impossible on a shared cluster, so restoring one restaurant rewinds another
restaurant's posted records, which invariant 2 forbids. Every one of those is solvable, and none of
them is solvable cheaply.

**Rejected — tenant-ready with no role split.** Marginally less work now. It leaves the runtime
connecting as the table owner, so the day row-level security is wanted, the bootstrap must be rewritten,
privileges re-granted, and every environment re-provisioned. The split costs one task today.

**Rejected — `REGISTRATION_MODE=open` as the way to add a second restaurant.** An environment flag
that re-opens an unauthenticated account-creating endpoint is one forgotten variable away from public
signup with none of the guards public signup would need. `scripts/create-restaurant.ts` (T-25) does
the same job with no public surface at all.

## Risks that survived adversarial verification

The five-lens panel produced **57 findings**. The refutation pass was **incomplete**: 31 of 63 agents
returned verdicts and 32 died on an API rate limit mid-run. Findings whose refuter died are marked
`[self-refuted]` below, meaning the planner applied the same refutation test in-conversation rather
than an independent agent. Treat those as slightly less challenged than the rest.

- **HIGH — first-run registration is first-come-first-served, and a hijacked first run cannot be
  undone.** `[self-refuted; two lenses agreed]` Deploy on a public hostname, and whoever finds
  `/register` before the owner does becomes the owner. Recovery would require disabling the audit
  trigger this plan installs and hand-deleting rows, which is the repair invariant 2 exists to
  forbid. **Mitigated by T-14 and T-19:** registration additionally requires `SETUP_TOKEN`, compared
  in constant time inside the same advisory-locked transaction.
- **HIGH — `/login` is an unauthenticated password-hashing sink and the per-account lockout is a
  denial-of-service lever.** `[self-refuted; two lenses agreed]` Each attempt costs ~43 ms and 19 MiB
  on Node's four-thread pool, including the deliberate dummy verify for unknown emails. Separately,
  five wrong passwords every five minutes keeps the only owner account locked out forever.
  **Mitigated by T-13:** a per-IP token bucket in front of the hash, the lock scoped so it cannot be
  renewed indefinitely by an attacker, and Nginx `limit_req` named in T-26's deploy notes as the
  primary throttle.
- **HIGH — no sanctioned owner password recovery.** `[self-refuted; two lenses agreed]` One owner
  account, no reset flow, so a forgotten password invites an unaudited `UPDATE users SET
  password_hash`. **Mitigated by T-25:** `scripts/reset-owner-password.ts` hashes through the same
  module, clears the lock, invalidates every session and writes the audit row.
- **HIGH — the session and layout payload can ship `password_hash` to the browser.**
  `[self-refuted]` "One query joining users" selects every column unless told otherwise, and
  SvelteKit serialises load data into the page and into `__data.json`. **Mitigated by T-12:** a
  `Principal` type is the only shape in `App.Locals`, selected by an explicit column list, with a
  test asserting no key matching `/hash|password|pin|locked|failed/` reaches the payload.
- **HIGH — the integration tests cannot run as designed.** `[self-refuted]` Nothing applies
  migrations to `matcami_test`, nothing resets rows between tests, and the concurrent-registration
  test needs two committed transactions, which a rollback-per-test wrapper forbids. **Mitigated by
  T-08**, which builds the harness before any test depends on it.
- **MED — `?next` on `/login` is an open redirect.** `[self-refuted]` Verified: SvelteKit's
  `redirect()` passes `location.toString()` through untouched, and `//evil.example` defeats a naive
  "starts with /" check. **Mitigated by T-18.**
- **MED — behind Nginx every audit row records `127.0.0.1`, and an unset `ORIGIN` makes every form
  POST return 403.** `[self-refuted; two lenses agreed]` Verified in adapter-node's handler:
  `ADDRESS_HEADER` defaults to empty, so `getClientAddress()` returns the proxy socket. The tempting
  fix for the 403 is disabling the origin check, which invariant 12 forbids. **Mitigated by T-17 and
  T-26.**
- **MED — the route guard is allow-by-default.** `[self-refuted]` Guarding only route ids under
  `/(dashboard)` leaves every future top-level route public unless it remembers its own check.
  **Mitigated by T-17 and T-20:** an explicit public allow-list, deny by default, and a test that
  walks `src/routes` and fails on any server file that is neither allow-listed nor guarded.
- **MED — `audit_log` has no subject column**, so a failed login records the attacked owner as the
  actor. `[self-refuted]` **Mitigated by T-05.**
- **MED — `details jsonb` is free-form and the append-only trigger makes any leaked secret
  permanent.** *Refuted by the panel* as a spec citation (nothing in spec 3 or invariant 10 governs
  the contents of `details`), but kept as a requirement because the cost is one guard function:
  **T-11** takes typed per-event details and throws on any key matching
  `/pass|pin|token|hash|secret|cookie/i`.
- **LOW — `engines` admits Node 24.0 to 24.6, which have no `crypto.argon2`.** `[self-refuted]`
  Verified: the API landed in v24.7.0. `pnpm install` and every non-hashing test pass there, and the
  first registration throws. **Mitigated by T-10.**
- **LOW — `Intl.supportedValuesOf('timeZone')` rejects valid IANA names.** `[self-refuted, and
  confirmed by running it on the pinned Node 24.21.0]` `UTC`, `Etc/UTC`, `Asia/Kolkata`,
  `Europe/Kyiv` and `America/Argentina/Buenos_Aires` are all absent from that list, while
  `Intl.DateTimeFormat` accepts every one of them. Firefox reports `Asia/Kolkata` and `Europe/Kyiv`
  from `resolvedOptions()`. **Mitigated by T-16**, which validates by construction instead.
- **LOW — plain HTTP on a LAN address produces a silent endless login loop.** `[self-refuted]`
  Verified: SvelteKit sets `secure` on cookies for every host except `http://localhost`, and browsers
  discard a `Secure` cookie from a plain-HTTP non-localhost origin. **Mitigated by T-26's deploy
  notes.**
- **LOW — nothing forbids a non-owner row holding email and password**, and login does not check the
  role, so a later Employees plan could create a cashier who can log in. `[self-refuted]`
  **Mitigated by T-04's second CHECK constraint and T-13.**
- **LOW — `fail()` payloads can echo the submitted password into page data.** `[self-refuted]`
  **Mitigated by T-18 and T-19.**

**Considered and rejected — one line each, so nobody re-opens them:**

- *Time-zone edits silently reinterpret the business dates of posted records* — refuted: spec 10 puts
  the business date on the POS session, so later plans stamp `business_date` once at creation and
  group by the stored column. The cheap half survives as a requirement: T-16 audits settings changes
  with old and new values.
- *A later migration will default `tax_mode` and `currency` silently* — refuted: invariant 7 forbids
  hardcoding tax mode, not defaulting a settings column, and those columns are not in this plan. The
  cheap half survives: T-22's checklist calls `settingsComplete()`, which later plans extend.
- *The chart of accounts cannot be seeded per restaurant* — refuted: this plan creates no `accounts`
  table and the accounting plan owns that decision. The cheap half survives: T-14 ships an ordered
  `onRestaurantCreated(tx, restaurantId)` initializer list for it to hook into.
- *Public registration makes currency and tax regime per-tenant* — refuted: no public registration,
  and no currency or tax column in this plan.
- *Row-level security blinds the journal balance trigger* — refuted: no journal tables, no policies,
  no `FORCE` in this plan.
- *Suspending a restaurant strands completed offline sales* — refuted: no `status` column.
- *POS rows would inherit the tenant from the dashboard cookie* — refuted: no sync route and no POS
  code here. The cheap half survives: T-17 sets `locals.restaurantId` for dashboard routes only, so a
  future POS route that forgets its own resolution fails loudly instead of silently inheriting.
- *The owner's dashboard session becomes an immortal principal on the POS tablet* — refuted: no POS
  surface exists yet. T-12 nonetheless slides the cookie only on dashboard requests and records that
  the device plan must invalidate it when it issues a device cookie.
- *Throwing inside the login transaction rolls back the lockout counter and the audit row* — refuted
  as a risk because the plan chooses the shape; kept as a hard requirement in T-13: the transaction
  callback returns a result object and commits on every branch.
- *`pin_hash` invites the server-only password module to become the PIN hasher* — refuted because the
  column is dropped. T-04 omits it, and the counters are named `failed_password_count` and
  `password_locked_until` so the PIN plan adds its own pair.
- *`crypto.argon2` is experimental* — refuted on evidence: Node's changelog shows "doc,crypto: mark
  argon2 and encap/decap as stable" landed in **24.19.0** (2026-08-03), before the pinned 24.21.0,
  and the v24.21.0 documentation source carries no stability marker on those sections. The
  `@types/node` JSDoc still says `@experimental`; that is a stale annotation, not the runtime
  contract. The cheap half survives: T-10 pins a fixed PHC test vector so any future backend swap
  must prove interoperability.
- *A `numeric` or float money column could slip in* — refuted: this plan creates no money column at
  all. T-09's schema guard nonetheless fails any future `numeric` column that is not `numeric(12,3)`.
- *Lockout never resets, so guessing becomes unlimited after one cycle* — refuted on the citation,
  kept as a requirement: T-13 resets the counter when it sets the lock, and tests the sixth attempt
  after expiry.
- *Missing index on `audit_log(restaurant_id, created_at)`* — refuted as a spec-27 risk, kept because
  it is free while the table is empty: T-05 creates it.
- *`audit_log.restaurant_id` should be nullable to hold unknown-email failures* — refuted, and the
  plan does the opposite: the column stays `NOT NULL`, and unknown-email attempts are throttled and
  server-logged, never audit rows.

## Assumptions (open decisions this plan rides on)

1. **Tenancy, dashboard meaning and registration policy — ANSWERED by the user at the gate on
   2026-09-13.** See Requirements 1 to 3. This plan does **not** amend spec 31 or CLAUDE.md's
   do-not-build list, because the hybrid does not contradict them: spec 1 requires the architecture be
   "structured so that we can later add ... Multi-tenant support", which is exactly what it builds.
2. **Validation library — DECIDED HERE: `zod`, pinned exactly.** `tasks/project-init.md` assumption 4
   left this to "the first task that writes a route with a request body", which is T-18. Recorded in
   CLAUDE.md by T-26. The alternative considered was `valibot`; `zod` was chosen for its larger
   ecosystem and because nothing in this plan needs valibot's bundle-size advantage on the server.
3. **Password lockout is a HOUSE RULE, not a spec rule.** Spec 7 defines "after 5 wrong attempts,
   locked out for 5 minutes" for **PINs on a registered device**. Applying it to a public
   email-and-password endpoint is this plan's proposal, and the panel showed the naive version is a
   denial-of-service lever. T-13 implements it with a per-IP throttle in front and a lock that an
   attacker cannot renew indefinitely. If the user disagrees, T-13 is the only task to change.
4. **Row-level security is NOT implemented here, and that is deliberate.** T-02 makes it cheap later:
   the runtime role does not own the tables, so `ENABLE ROW LEVEL SECURITY` plus `CREATE POLICY`
   applies to it automatically with no `FORCE` and no bootstrap change. Whoever implements it must
   first decide which tables are **resolvers** — `users` looked up by email, `sessions` looked up by
   token hash, and the future `pos_devices` looked up by cookie hash are all read *before* a tenant is
   known and cannot be policy-filtered by tenant. That decision is not made here.
5. **Dashboard permission keys are NOT spec-derived.** Spec 8 lists POS keys "For example" and names
   none for the dashboard. T-15 proposes `admin.settings`, `admin.menu`, `admin.inventory`,
   `admin.purchases`, `admin.expenses`, `admin.reports`, `admin.employees`, `admin.devices`, granted
   to the owner only, and flags them in code as a plan-level extension. Spec 8's POS keys are
   reproduced verbatim and tested against the spec text.
6. **Tax mode, tax rate, currency, approval limits and idle-lock timing are NOT columns in this
   plan.** Open decisions 3, 4 and 6 are unresolved and CLAUDE.md forbids baking an answer into the
   schema. `restaurant_settings` is created with `time_zone` only, so later plans add their columns
   with their decisions. Those columns must land **nullable**, with POS session-open gated on
   `settingsComplete()`, never with a column `DEFAULT` that silently answers an open decision.
7. **Money module placement remains UNRESOLVED.** `tasks/project-init.md` assumption 3 records the
   conflict between invariant 1 and spec 17. This plan writes no money code and does not resolve it.
8. **PIN hashing is NOT decided here.** `users.pin_hash` is deliberately omitted. Spec 6 requires
   PINs to be verified offline in the browser, so the POS plan must pick an algorithm available in
   WebCrypto or WASM, which may not be argon2id at these parameters. A nullable `ADD COLUMN` later is
   metadata-only.
9. **A new server module directory is introduced:** `src/lib/server/restaurants/`. CLAUDE.md's "Where
   code lives" does not list it. T-26 adds it. It holds restaurant settings and the
   `onRestaurantCreated` initializer list, and it calls `audit/` and nothing else.
10. **Open decision 2 (hosting) is assumed to be the spec's default: cloud, Docker plus Nginx.** It
    drives the proxy-header, `ORIGIN` and HTTPS requirements in T-17 and T-26. Nothing in the schema
    depends on it.

## In play

**Spec:** 1 (one restaurant now, structured for multi-tenant later), 3 (PostgreSQL holds Users,
Roles, Permissions, Audit Logs; posted records permanent; sensitive actions audit-logged), 4 (the POS
will cache restaurant settings and the employee list — a seam this plan's table shapes must leave
open), 7 (owner uses email and password to enter the management dashboard; PIN rules belong to the
POS), 8 (User → Role → Permissions; the server returns 403; hiding buttons is not security), 9
(HttpOnly + Secure + SameSite cookie sessions, no `localStorage`, SvelteKit's origin check stays on),
10 (business date belongs to the POS session — a seam, nothing here stamps one), 17 (timestamps
stored UTC in `timestamptz`; the restaurant's time zone is a setting), 26 (the report list the
dashboard navigation anticipates), 29 (operations, backups before migrations, the six mandatory test
areas), 31 (MVP includes email/password for management; Multi-tenant SaaS is Later), 32 (management
login is email and password; authentication is secure HttpOnly cookies), 33 (open decisions).

**Spec 29's six mandatory test areas:** this feature lands in exactly one of them — *"Permission
checks on every POS API"* — carried by **T-20**, which walks `src/routes` statically and then asserts
403 and redirect behaviour against a real database. The other five (money arithmetic and rounding,
tax in both modes, journal entries always balance, one posting rule per business event, offline sync
retries never duplicate) are untouched here because this plan writes no money, no journal, no stock
and no offline code. T-08 builds the integration harness they will all need.

**Invariants:** 8 (permissions enforced server-side on every route, reads included, returning 403),
10 (logins, failed logins, lockouts, logout and settings changes are audit-logged, in the same
transaction as the action), 11 (timestamps stored UTC in `timestamptz`; the restaurant's time zone is
a setting), 12 (PIN and password hashing is slow and salted and never reversible or logged; sessions
are HttpOnly + Secure + SameSite cookies, never `localStorage`; SvelteKit's origin check stays on).
Invariant 2 applies in spirit: audit rows are append-only, enforced by a database trigger.

**Not engaged, and no task may foreclose them:** 1 (money as integer minor units), 3 (journal entries
balance in the database), 4 (the one payment transaction), 5 (offline sales are recorded facts), 6
(inventory is a ledger), 7 (discounts before tax; line snapshots), 9 (owner-PIN approvals).

## Workspace state at plan time (Phase 1 investigation, 2026-09-13)

Branch `feat/project-init` at `b45b5ed`, clean. `main` holds only the initial commit `149ce92`.
Remote `origin` is `github.com/MohamadAmiin/Jeddah-Buffet`.

**Present and committed:** `package.json` (scripts and 23 exactly-pinned dependencies; no validation
library, no hashing package), `svelte.config.js` (adapter-node; a comment records that the CSRF origin
check is never to be disabled), `vite.config.ts`, `tsconfig.json`, `.nvmrc` (`24.21.0`), `.npmrc`
(`engine-strict=true`), `.gitignore` (line 2 is `tasks/`), `scripts/db-bootstrap.sh` (creates role
`matcami` as **owner** of `matcami` and `matcami_test`, both set to UTC), `src/app.css`,
`src/app.d.ts` (an empty commented `App.Locals` stub), `src/app.html`, `src/lib/styles/tokens.css`,
`src/routes/+layout.svelte`, `src/routes/+page.svelte` (landing page, two placeholder links to `/`),
`src/routes/(dashboard)/+layout.svelte` and `src/routes/(pos)/+layout.svelte` (both comment-only),
and a `README.md` in each of `src/lib/server/{db,auth,permissions,audit,money,accounting,inventory,
orders}` and `src/lib/pos`.

**Absent at plan time — verified by explicit `test -f` / `test -d` / `find`:** no `.env`, no
`.env.example`, no `src/lib/server/env.ts`, no `drizzle.config.ts`, no `src/lib/server/db/client.ts`,
no `src/lib/server/db/migrations/`, no `eslint.config.js`, no `vitest.config.ts`, no
`playwright.config.ts`, no `e2e/`, no `src/hooks.server.ts`, no test file anywhere, no
`docker-compose.yml`. `src/lib/server/db/schema/` contains only `.gitkeep`. **No schema exists**, so
every table in this plan is a create.

**Those absences are project-init's work, not this plan's.** `tasks/project-init.md` defines T-01 to
T-10; T-01 to T-05 are committed, and **T-06 (env files and `env.ts`), T-07 (`drizzle.config.ts`, the
DB client exporting `db`/`Db`/`DbTx`, `scripts/db-backup.sh`, the migration pipeline including the
`generate --custom` path), T-08 (`eslint.config.js`), T-09 (Vitest unit and integration projects,
`playwright.config.ts`) are NOT DONE.** T-01 of this plan is the gate that verifies them.

**File tags used below.** `NEW` = absent at Phase 1 and created by this task. `EXTEND` = created by an
earlier task **in this plan**, which is named; never rewrite such a file wholesale. `EDIT` = the file
exists when the task runs, with a location hint; for files created by **project-init** rather than by
Phase 1, the tag reads `EDIT (created by project-init T-NN; verified present by T-01)`. **Stop and
report a mismatch** when a path tagged `NEW` already exists, or a path tagged `EXTEND`/`EDIT` does
not.

**Runtime facts, measured on this machine on 2026-09-13:** `nvm use 24.21.0` gives Node v24.21.0 with
OpenSSL 3.5.8. `require('node:crypto').argon2` and `argon2Sync` are functions; argon2id at
`memory: 19456`, `passes: 2`, `parallelism: 1`, `tagLength: 32` completed in ~43 ms with no warning
printed. `Intl.supportedValuesOf('timeZone')` returns 418 entries and does **not** contain `UTC`,
`Etc/UTC`, `Asia/Kolkata`, `Europe/Kyiv` or `America/Argentina/Buenos_Aires`.

## Task index

Every task, in dependency order. `Needs` are task IDs, never prose.

| ID | Title | Phase file | Needs |
|---|---|---|---|
| T-01 | Verify the project-init prerequisites and stop if any are missing | `01-prerequisites.md` | - |
| T-02 | Add the non-owner runtime role and split the connection URLs | `01-prerequisites.md` | T-01 |
| T-03 | Install and pin zod, and record the validation-library decision | `01-prerequisites.md` | T-01 |
| T-04 | Schema: `restaurants`, `restaurant_settings`, `users` | `02-schema.md` | T-01 |
| T-05 | Schema: `sessions` and `audit_log` | `02-schema.md` | T-04 |
| T-06 | Generate and apply the first business migration | `02-schema.md` | T-02, T-04, T-05 |
| T-07 | Custom migration: make `audit_log` append-only in the database | `02-schema.md` | T-06 |
| T-08 | Integration-test database harness: migrate and reset | `02-schema.md` | T-06, T-07 |
| T-09 | Schema guard tests every future aggregate inherits | `02-schema.md` | T-08 |
| T-10 | `auth/password.ts` — argon2id in PHC format | `03-domain.md` | T-01 |
| T-11 | `audit/` — the typed, secret-refusing audit writer | `03-domain.md` | T-05, T-08 |
| T-12 | `auth/session.ts` — cookie sessions and the `Principal` projection | `03-domain.md` | T-05, T-08 |
| T-13 | `auth/login.ts` — lockout, throttle and the commit-on-every-branch rule | `03-domain.md` | T-10, T-11, T-12 |
| T-14 | `auth/register.ts` — token-gated first-run registration | `03-domain.md` | T-10, T-11, T-12, T-16 |
| T-15 | `permissions/` — the key map and the guards | `03-domain.md` | T-12 |
| T-16 | `restaurants/` — settings, time-zone validation, `settingsComplete` | `03-domain.md` | T-04, T-11 |
| T-17 | `src/hooks.server.ts` — deny-by-default guard and `App.Locals` | `04-http.md` | T-12, T-15 |
| T-18 | `/login` and `/logout` routes | `04-http.md` | T-03, T-13, T-17 |
| T-19 | `/register` route | `04-http.md` | T-03, T-14, T-17 |
| T-20 | The route-guard test that walks `src/routes` | `04-http.md` | T-17, T-18, T-19 |
| T-21 | The `(dashboard)` shell layout | `05-dashboard.md` | T-17 |
| T-22 | `/dashboard` overview and the onboarding checklist | `05-dashboard.md` | T-16, T-21 |
| T-23 | `/settings` page | `05-dashboard.md` | T-16, T-21 |
| T-24 | End-to-end auth journey | `06-operations.md` | T-19, T-22, T-23 |
| T-25 | Operator scripts: reset the owner password, create a restaurant | `06-operations.md` | T-13, T-14 |
| T-26 | Environment, deploy notes and the CLAUDE.md updates | `06-operations.md` | all above |

**Phases and their order**

| # | Phase | File | Depends on |
|---|---|---|---|
| 0 | Prerequisites and the role split | `01-prerequisites.md` | nothing |
| 1 | Schema and migrations | `02-schema.md` | Phase 0 |
| 2 | Domain modules | `03-domain.md` | Phase 1 |
| 3 | HTTP surface: hook, routes, guards | `04-http.md` | Phase 2 |
| 4 | Dashboard UI | `05-dashboard.md` | Phase 3 |
| 5 | Cross-layer tests, operations, documentation | `06-operations.md` | Phase 4 |

T-03 and T-10 are independent of the schema and may run any time after T-01. T-16 is listed in Phase 2
but needs only T-04 and T-11, so it can run early; T-14 needs it.

## Definition of done for the whole plan

```bash
pnpm check && pnpm lint          # exits 0
pnpm test                        # unit + integration projects both pass
pnpm test:e2e                    # the auth journey passes
psql "$MIGRATE_DATABASE_URL" -c "update audit_log set event='x' where id=1"   # ERROR: append-only
psql "$DATABASE_URL" -c "\dn"    # connects as matcami_app, which owns nothing
```

And, checked by hand once:

- Visiting `/register` with no `SETUP_TOKEN` set returns a 503 that names the variable.
- Visiting `/register` with the token creates the restaurant, the settings row, the owner and two
  audit rows in one transaction, and lands on `/dashboard`.
- Visiting `/register` a second time returns 404.
- `/dashboard` while logged out redirects to `/login`; the redirect target is never an external URL.
- Every `(dashboard)` page and form action returns 403 for a session whose role is not `owner`.
- `GET /logout` is rejected; the logout form works and the cookie is gone afterwards.
- `pnpm db:migrate` takes a backup first and applies both migrations.
