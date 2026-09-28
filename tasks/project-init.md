# Project initialization — toolchain, packages and a working database pipeline

**Goal.** Turn an empty matcami repo into a project that installs, runs, type-checks, lints, tests and
talks to PostgreSQL through Drizzle. Install and pin every tool and package the project needs. Write no
business logic, create no business tables, decide nothing the spec leaves open.

When this plan is done, every command in CLAUDE.md's "Commands & setup" block actually works, and that
block is rewritten to be factually true instead of a proposal.

## Requirements (as agreed with the user)

- **Scope is initialization only** — "installing the required tools and packages". Tooling, wiring, a
  verified database pipeline, a test harness, docs.
- **Node 24 LTS**, pinned. The machine currently runs v25.8.1, which Vitest 5 refuses outright
  (`engines.node: ^22.12.0 || ^24.0.0 || >=26.0.0`). The user installs Node 24 via nvm/fnm.
- **Tailwind CSS v4** for styling. The spec is silent on styling; this was surfaced as an open
  question and the user chose Tailwind. Recorded as a decision, not an assumption.
- **The already-running host PostgreSQL 16**, not Docker. The user chose this knowingly over the
  recommended Docker option, for speed of setup. See Assumptions for what it costs.
- **Single file plan**, at the user's request.
- **NOT in scope, by explicit instruction:** business tables, `lib/server/money` implementation, the
  spec 23 chart of accounts, authentication, a `docker-compose.yml`, CI, a service worker.

## Scope

**IN** — Node pin · PostgreSQL role + `matcami` and `matcami_test` databases · SvelteKit + Svelte 5 +
TypeScript + Vite with `adapter-node` · Tailwind v4 · every package pinned to an exact version ·
Drizzle ORM + drizzle-kit + a DB client + `db:*` scripts · a migration pipeline verified end to end,
including the hand-written-SQL path · ESLint + Prettier + svelte-check · the server/POS import boundary
rule · Vitest (unit + integration projects) · Playwright smoke test · the directory skeleton from
CLAUDE.md · README · CLAUDE.md truth-up.

**OUT** — everything on CLAUDE.md's "Do NOT build" list · any business table · any money arithmetic ·
any account code · any posting rule · authentication and PIN handling · the service worker and
IndexedDB · the print agent · `docker-compose.yml` · GitHub Actions · a validation library.

## Approach

**Chosen: scaffold the framework core with `sv create --no-add-ons`, then hand-wire everything
matcami-specific.** The official scaffolder writes only the handful of canonical files that are fiddly
and that you want stock (`app.html`, `app.d.ts`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`,
`.npmrc`, `static/`). Every decision that matters to this project — exact versions, the migrations
folder, test isolation, boundary enforcement — is written explicitly by the tasks below.

Rejected — *`sv create` with all official add-ons* (`--add drizzle tailwindcss eslint prettier vitest
playwright`): the add-ons carry opinions that contradict CLAUDE.md. The Drizzle add-on picks its own
`out` folder (`./drizzle`, not `src/lib/server/db/migrations`), its own client shape and its own compose
file; the Vitest add-on writes a single-project config where two are needed. The override task is more
work than wiring it by hand, against output that could not be inspected at plan time.

Rejected — *hand-write every config, no scaffolder*: fully deterministic, but it buys determinism in
`svelte.config.js`, which is not where this project's risk lives, and it costs a long plan plus exact
`svelte-kit sync` ordering for a `tsconfig.json` that extends a generated file.

## Risks

A five-lens adversarial risk panel (accounting, data model, offline/sync, permissions, ops/migration)
produced **43 findings; 0 survived refutation.** That zero should be read as soft, not as a clean bill
of health: the refuters are instructed to kill speculation about unwritten code, and a scaffold is
almost entirely about setting up conditions for unwritten code, so the instrument was mis-tuned for
this task. No finding survived *as a risk*; several converted into hard requirements, which are written
into the tasks below rather than listed here as risks.

Notable refutations, so nobody re-opens them:

- *"The one rounding rule cannot live in `src/lib/server/money` — SvelteKit blocks it from the offline
  POS, forcing a second copy."* Refuted: SvelteKit's guard covers exactly `$lib/server/**`,
  `$env/*/private` and `*.server.ts`. One pure function in an isomorphic module (e.g. `src/lib/money/`)
  can be imported verbatim by the POS, the server and reports, satisfying spec 17 with zero
  duplication. This plan creates only an empty directory either way — see Assumptions, item 3.
- *"Money or ingredient quantities could arrive in JS as floats."* Refuted: `pg`/`pg-types` returns
  `int8` (oid 20) and `numeric` (oid 1700) as **strings** unless someone calls `setTypeParser`, and
  Drizzle's `numeric` defaults to string. The safe behaviour is the default. T-07 forbids type parsers
  anyway.
- *"Rollback-per-test isolation makes a COMMIT-time balance constraint untestable."* Refuted:
  `SET CONSTRAINTS ALL IMMEDIATE` forces a pending `DEFERRABLE INITIALLY DEFERRED` constraint trigger
  to raise inside a still-open transaction.
- *"No `db:backup` / not a git repo / versions unpinned / CLAUDE.md commands stay wrong."* Refuted as
  risks because they are simply features of this plan — T-07, T-03 and T-10 respectively. The repo is
  already a git repository with a remote (see Workspace state).
- *A dev-auth stub leaking owner access · `db:studio` editing posted records · `.env.example` leaking a
  live credential · no IndexedDB test environment · Playwright on `pnpm dev` · blocking `load` under
  `(pos)`*: all refuted as premature for a scaffold that writes no auth, has no posted records and
  builds no service worker. Three of them survive as task steps anyway (T-06, T-09).

## Requirements that came out of the panel

These are not risks; they are things the tasks must do, and each is cheap.

| # | Requirement | Where | Why |
|---|---|---|---|
| R1 | The `matcami` role **owns** both databases | T-02 | PostgreSQL 15+ revoked `CREATE` on schema `public` from `PUBLIC`, and drizzle-kit needs `CREATE` on the database for its own `drizzle` schema. Ownership settles both at once. |
| R2 | Hand-written SQL only ever via `drizzle-kit generate --custom` | T-07 | That command registers the file in `migrations/meta/_journal.json`. A `.sql` file dropped into the folder by hand is silently never applied — you would believe a constraint exists when it does not. |
| R3 | `drizzle.config.ts` `schema` points at a dedicated `schema/` folder, never a glob over `db/` | T-07 | A glob over `db/` imports `client.ts`, which opens a connection at import time. |
| R4 | The Vitest integration project **fails closed** on the database name | T-09 | It refuses to run unless the target database name ends in `_test`. The alternative is a test run truncating development data. |
| R5 | Never `csrf.checkOrigin: false`; document `ORIGIN` instead | T-04, T-10 | Invariant 12 requires the origin check stays on. `checkOrigin` is deprecated in favour of `trustedOrigins`, and CSRF checks are inert in dev — which is exactly how someone "fixes" a production 403 by disabling it. |
| R6 | Playwright runs against `build` + `preview`, never `pnpm dev` | T-09 | Service workers and offline behaviour do not exist under the dev server. Getting this wrong now makes offline permanently untestable later. |
| R7 | UTC everywhere — both databases and the DB client | T-02, T-07 | Invariant 11: timestamps are stored UTC in `timestamptz`. |
| R8 | Never delete a migration once it has run | T-07 | Drizzle records a hash in `meta/_journal.json` and never re-checks it; deleting a migration silently diverges this database from every freshly built one. |

## Assumptions (open decisions this plan rides on)

1. **Styling — ANSWERED by the user: Tailwind CSS v4.** The spec says nothing about styling. Recorded
   here because it was a decision, not a default.
2. **Database host — ANSWERED by the user: the host-installed PostgreSQL 16, not Docker.** What it
   costs, stated plainly: spec 29 and spec 32 target Docker + Nginx for deployment, so development no
   longer resembles the deployment target; the environment is not reproducible from the repo for CI or
   a second machine; project data lives in the developer's OS PostgreSQL. What it gains: the host
   `pg_dump` is 16.15 against a 16.15 server, so spec 29's "a backup is always taken before running
   database migrations" works with no version mismatch. **No task here creates a compose file.** If
   this is revisited, host port 5432 is occupied — a container must map another port.
3. **Where the money module lives — UNRESOLVED. This plan does not decide it.** CLAUDE.md invariant 1
   says money arithmetic outside `src/lib/server/money` is a bug. Spec 17 says "All money arithmetic
   goes through one shared module" and "One rounding rule, implemented in one function and used
   everywhere (POS, server, reports)". The offline POS must total a bill in the browser, and SvelteKit
   build-blocks `$lib/server/**` from client code, so those two cannot both hold as written.
   **T-05 creates `src/lib/server/money/` exactly as CLAUDE.md currently specifies** — the status quo,
   changing nothing and deciding nothing. The first money task MUST resolve the placement (likely an
   isomorphic `src/lib/money/` for the pure arithmetic, with CLAUDE.md invariant 1 corrected in the
   same commit) **before** it writes a single arithmetic function. Do not resolve it here.
4. **Validation library — UNRESOLVED.** Routes must validate input (CLAUDE.md). The spec names no
   library. `zod` 4.6.2 and `valibot` 1.5.0 are both current. **No validation library is installed by
   this plan.** The first task that writes a route with a request body chooses one and records it.
5. **Service worker path — UNRESOLVED, and not touched here.** SvelteKit builds
   `src/service-worker.ts` (`kit.files.serviceWorker`, default `"src/service-worker"`); CLAUDE.md's
   layout puts the service worker under `lib/pos/`. The offline task resolves it — either move the file
   or set `kit.files.serviceWorker`. No task here creates a service worker.
6. **CI — deferred.** A GitHub remote now exists, so GitHub Actions is possible, but the user did not
   ask for it and no task here creates a workflow.
7. **Seven spec 33 open decisions remain unresolved.** Nothing in this plan encodes an answer to any of
   them. In particular `.env.example` must NOT carry a tax mode, tax rate, currency or time zone — all
   of those are restaurant settings that belong in the database behind open decision 3 (T-06 enforces
   this).

## In play

Spec: 2 (stack: SvelteKit + TypeScript + Node.js), 3 (PostgreSQL as source of truth; Drizzle; the data
integrity rules), 4 (caching layers), 9 (HttpOnly + Secure cookies; SvelteKit's origin check stays on),
17 (money as integer minor units in `bigint`; `numeric(12,3)` quantities; UTC `timestamptz`),
29 (operations: backup before every migration; the six mandatory test areas), 30 (architecture),
32 (final technology decision), 33 (open decisions).

Invariants: 1 (money is integer minor units in `bigint`; arithmetic lives in one module),
3 (journal entries balance, enforced by a DB constraint checked at COMMIT — this plan must leave that
expressible), 11 (timestamps stored UTC in `timestamptz`), 12 (HttpOnly + Secure + SameSite cookies,
never `localStorage`, SvelteKit's origin/CSRF check stays ON).

Invariants 2 and 4–10 are not exercised by a scaffold that writes no business logic. No task may
foreclose them.

## Research

Every version below was read from the npm registry on **2026-09-12**. Pin them exactly; several
`latest` tags are wrong for this stack.

### Q: Which Node version can run this toolchain?

- **Source:** `npm view vitest engines` and `npm view @sveltejs/kit engines peerDependencies` —
  accessed 2026-09-12. `https://nodejs.org/dist/index.json` — accessed 2026-09-12.
- **Says:** `vitest@5.0.0` declares `engines.node: "^22.12.0 || ^24.0.0 || >=26.0.0"`.
  `vitest@4.1.11` declares `"^20.0.0 || ^22.0.0 || >=24.0.0"`. `@sveltejs/kit@2.70.3` declares
  `engines.node: ">=18.13"`. Node dist: **v24.21.0 is LTS "Krypton"** (2026-09-07); v25.9.0 is not LTS
  and superseded the installed v25.8.1 on 2026-03-31; v26.8.2 is Current, not LTS (2026-09-09).
- **Affects the plan:** T-01 pins Node 24.21.0. The installed v25.8.1 is excluded by Vitest 5 outright —
  `pnpm test` would refuse to run.

### Q: Which TypeScript version does this stack actually accept?

- **Source:** `npm view typescript dist-tags`, `npm view @sveltejs/kit peerDependencies`,
  `npm view svelte-check peerDependencies`, `npm view typescript-eslint peerDependencies` — all
  accessed 2026-09-12.
- **Says:** npm dist-tag `latest` for `typescript` is **7.0.2** (published 2026-07-08). But:
  `@sveltejs/kit@2.70.3` peers `typescript: "^5.3.3 || ^6.0.0"`; `svelte-check@4.7.6` peers
  `"^5.0.0 || ^6.0.0"`; `typescript-eslint@8.70.0` peers `">=4.8.4 <6.1.0"`. The stable 6.x line ends
  at **6.0.3** (published 2026-04-16). `svelte-check` has no 5.x release; `latest` is 4.7.6.
- **Affects the plan:** T-03 pins `typescript` to exactly **6.0.3** — the only version satisfying all
  three peer ranges. A plain `pnpm add -D typescript` installs 7.0.2 and breaks both `pnpm check` and
  `pnpm lint`.
- **GAP — not a spec conflict:** the spec names no TypeScript version, so nothing here contradicts it.

### Q: Which `@types/node` matches Node 24?

- **Source:** `npm view @types/node dist-tags versions` — accessed 2026-09-12.
- **Says:** dist-tag `latest` is **22.20.2**. The `ts6.0` tag points at **26.5.1**. The newest 24.x
  release is **24.13.4**.
- **Affects the plan:** T-03 pins `@types/node` to **24.13.4**, matching the Node 24 runtime. Both
  `pnpm add -D @types/node` (→ 22.20.2) and following the `ts6.0` tag (→ 26.5.1) give types for the
  wrong runtime.

### Q: Can `sv create` scaffold into a non-empty directory without prompting?

- **Source:** `https://svelte.dev/docs/cli/sv-create` — accessed 2026-09-12.
- **Says:** usage is `npx sv create [options] [path]`. Options include `--template <minimal|demo|library>`,
  `--types <ts|jsdoc>`, `--no-add-ons` ("Skip the interactive add-ons prompt"), `--no-install`, and
  `--no-dir-check` ("Bypass empty directory validation").
- **Affects the plan:** T-03 runs
  `npx sv create --template minimal --types ts --no-add-ons --no-install --no-dir-check .`.
  `--no-dir-check` is **required** — the directory already holds `CLAUDE.md`, `docs/`, `.claude/` and
  the spec PDF, and the scaffolder otherwise refuses.

### Q: How is a hand-written SQL migration created so Drizzle actually applies it?

- **Source:** `https://orm.drizzle.team/docs/drizzle-kit-generate` — accessed 2026-09-12.
- **Says:** `drizzle-kit generate --custom --name=seed-users` generates an empty migration file ready
  for hand-written SQL. The migrations folder tracks applied migrations via journal and snapshot files
  alongside each `migration.sql`.
- **Affects the plan:** T-07 proves this path works, because invariant 3's balance constraint is a
  `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, which drizzle-kit cannot generate from
  schema files. R2 forbids hand-creating a `.sql` file — only `generate --custom` registers it.

### Q: How are multiple test projects configured in Vitest 5?

- **Source:** `https://vitest.dev/guide/projects` — accessed 2026-09-12.
- **Says:** the key is `projects` inside `test` in `defineConfig`; no separate workspace file is needed.
  Verbatim: *"This feature is also known as a `workspace`. The `workspace` is deprecated since 3.2 and
  replaced with the `projects` configuration."*
- **Affects the plan:** T-09 writes `test.projects` in `vitest.config.ts`. A `vitest.workspace.ts` file
  is the wrong shape for this version.

### Q: What are SvelteKit's relevant config defaults?

- **Source:** `https://svelte.dev/docs/kit/configuration` — accessed 2026-09-12.
- **Says:** `kit.files.serviceWorker` defaults to `"src/service-worker"`; `files.lib` to `"src/lib"`;
  `files.routes` to `"src/routes"`; `files.hooks.server` to `"src/hooks.server"`. On CSRF:
  `csrf.checkOrigin` default is `true`, it is **deprecated** (use `trustedOrigins: ['*']` instead), it
  checks "the incoming origin header for POST, PUT, PATCH, or DELETE form submissions", and
  *"CSRF protections only function in production environments, not during local development."*
- **Affects the plan:** R5. T-10 documents `ORIGIN` and records that the origin check is never to be
  disabled (invariant 12). Assumption 5 records the service-worker path question for the offline task.

### Q: What PostgreSQL server is actually running, and what does the role need?

- **Source:** local `dpkg -l`, `/etc/postgresql/16/`, `ss -lntp`, `pg_isready` — all 2026-09-12.
- **Says:** PostgreSQL **16.15** installed via apt, listening on `127.0.0.1:5432` and the unix socket
  `/var/run/postgresql`. Client `psql`/`pg_dump` are also 16.15. OS user is `mohamed-amiin`; the
  default Ubuntu install uses peer auth for the `postgres` superuser and has no role for the OS user.
- **Affects the plan:** T-02 uses `sudo -u postgres psql` and makes the `matcami` role the **owner** of
  both databases (R1) — on PostgreSQL 15+ a non-owner cannot create objects in schema `public`.

## Workspace state at plan time (Phase 1 investigation, 2026-09-12)

The repo **is** a git repository, on branch `main`, remote `origin` =
`https://github.com/MohamadAmiin/Jeddah-Buffet.git`, upstream `origin/main`, in sync with the remote.
One commit exists: `149ce92 "initilaization"`. `gh` 2.62.0 is authenticated as `MohamadAmiin` with
`repo` and `workflow` scopes. Git identity is set. **No task needs to run `git init`.**

19 files are tracked: `CLAUDE.md`, `.gitignore`, `docs/spec.md`, the spec PDF, and the 15 files under
`.claude/skills/`. `.gitignore` already contains `tasks/` (line 2), plus `node_modules/`,
`.pnpm-store/`, `.svelte-kit/`, `build/`, `dist/`, `.vite/`, `.env`, `.env.*` with `!.env.example`,
`*.sql.gz`, `pgdata/`, `coverage/`, `test-results/`, `playwright-report/`, `blob-report/`,
`.playwright/`, `*.log`, `.DS_Store`, `.idea/`, `.vscode/*` with `!.vscode/extensions.json`.

**Everything else is absent**, verified by explicit `test -f` / `test -d`: no `package.json`,
`pnpm-lock.yaml`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `drizzle.config.ts`,
`docker-compose.yml`, `.env`, `.env.example`, `vitest.config.ts`, `playwright.config.ts`,
`eslint.config.js`, `.prettierrc`, `.npmrc`, `README.md`; no `src/`, `static/`, `e2e/`, `node_modules/`.

Installed: Node **v25.8.1** (to be replaced by 24 LTS in T-01), pnpm 10.33.0, npm 11.11.0, git 2.43.0,
Docker 29.8.0, docker compose v5.5.1, psql 16.15, `zip` 3.0, `sudo`. **`corepack` is NOT installed** —
do not rely on a `packageManager` field to auto-install pnpm on this machine.

This describes the repo **before T-01 runs**. Every path below tagged `NEW` is absent today. Files
created by earlier tasks in this plan are expected to exist when a later task runs — each task's
`Files:` tag says which case it is. **Stop and report a mismatch only** when a path tagged `NEW` in the
task you are about to run already exists, or a path tagged `EXTEND`/`EDIT` does not.

---

# Phase 0 — Preflight

Environment prerequisites the repo cannot create for itself. Both tasks need the user's machine and one
needs `sudo`, so neither can be fully automated — say so rather than faking success.

**Depends on:** nothing.

### T-01 — Install and pin Node 24 LTS

**Needs:** -
**Files:**
- `.nvmrc` — NEW
**Spec:** 2 (Node.js chosen as the runtime "because of its mature ecosystem and production
compatibility")
**Invariants:** none directly; this unblocks the test harness that every later invariant relies on.

**Do:**
1. Write `.nvmrc` containing exactly one line: `24.21.0`
2. Install and activate it. With fnm: `fnm install 24.21.0 && fnm use 24.21.0`. With nvm:
   `nvm install 24.21.0 && nvm use 24.21.0`. If neither tool is present, stop and tell the user which
   to install — do not proceed on Node 25.
3. Verify: `node -v` must print `v24.21.0` (or another `v24.x`). If it prints `v25.*`, the shell is
   still on the old version — stop and report it; do not continue.
4. Do **not** add a `packageManager` field expecting corepack to honour it: `corepack` is not installed
   on this machine. pnpm 10.33.0 is already available globally.
5. The `engines` field is set in T-03 when `package.json` exists.

**Tests:** none (environment task).

**Done when:** `node -v` prints `v24.21.0` and `cat .nvmrc` prints `24.21.0`.

**Watch out:** `vitest@5.0.0` declares `engines.node: "^22.12.0 || ^24.0.0 || >=26.0.0"`. Node 25 is
excluded by that range, so staying on v25.8.1 makes `pnpm test` fail at install or run time. This is
the whole reason the pin exists — do not "simplify" it away.

### T-02 — Create the PostgreSQL role and both databases

**Needs:** -
**Files:**
- `scripts/db-bootstrap.sh` — NEW
**Spec:** 3 (PostgreSQL is the primary source of truth), 17 (timestamps stored UTC in `timestamptz`),
29 (operations)
**Invariants:** 11 (business date, not calendar date — timestamps stored UTC; the restaurant's time
zone is a setting, so the *server* must not impose a local zone)

**Do:**
1. Create `scripts/db-bootstrap.sh`, executable, idempotent, safe to re-run. It must use
   `sudo -u postgres psql` because the default Ubuntu PostgreSQL 16 install uses peer auth for the
   `postgres` superuser and has no role for the OS user `mohamed-amiin`.
2. Create the login role only if absent — `CREATE ROLE` is not idempotent, so guard it:
   ```sql
   DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matcami') THEN
       CREATE ROLE matcami LOGIN PASSWORD 'CHANGE_ME';
     END IF;
   END $$;
   ```
   Take the password from the script's first argument or a `MATCAMI_DB_PASSWORD` environment variable.
   Never hardcode a real password in the script, and never commit one.
3. Create both databases, each **owned by `matcami`** (R1). `CREATE DATABASE` cannot run inside a
   transaction or a `DO` block, so guard it at the shell level, once per database:
   ```bash
   for dbname in matcami matcami_test; do
     exists=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$dbname'")
     [ "$exists" = "1" ] || sudo -u postgres createdb -O matcami "$dbname"
   done
   ```
   Ownership matters and is not cosmetic: PostgreSQL 15+ revoked `CREATE` on schema `public` from
   `PUBLIC`, so a non-owner role cannot create tables there, and drizzle-kit needs `CREATE` on the
   database to make its own `drizzle` schema for the migrations table. Ownership grants both.
4. Force UTC on both databases (R7):
   `sudo -u postgres psql -c "ALTER DATABASE matcami SET timezone TO 'UTC';"` and the same for
   `matcami_test`.
5. Print, at the end, the two connection URLs in the form
   `postgres://matcami:<password>@localhost:5432/matcami` so T-06 can paste them into `.env` — but
   print the password only if it was supplied on this run, never read one back out of the database.
6. `matcami_test` exists so the Vitest integration project can never touch development data (R4). Do
   not skip it.

**Tests:** none (environment task), but step 7's verification is mandatory.
7. Verify both, as the `matcami` role over TCP, not as `postgres`:
   ```bash
   psql "postgres://matcami:<password>@localhost:5432/matcami" \
     -c "select current_user, current_database(), current_setting('TimeZone');"
   ```
   Expect `matcami | matcami | UTC`. Repeat for `matcami_test`. Then confirm the role can actually
   create objects: `create table _perm_probe(x int); drop table _perm_probe;` must both succeed.

**Done when:** both URLs connect as `matcami`, both report `TimeZone = UTC`, and the create/drop probe
succeeds in both databases.

**Watch out:** if the TCP connection fails with a peer-authentication error, the connection is going
over the unix socket rather than `localhost` — keep `@localhost:5432` in the URL. If it fails with
`password authentication failed`, check `/etc/postgresql/16/main/pg_hba.conf` has a
`host all all 127.0.0.1/32 scram-sha-256` line. Do not edit `pg_hba.conf` without telling the user;
report it instead.

---

# Phase 1 — Application skeleton and packages

This is the "install the required tools and packages" core.

**Depends on:** Phase 0 (T-01 for the Node version).

### T-03 — Scaffold SvelteKit and pin every package to an exact version

**Needs:** T-01
**Files:**
- `package.json` — NEW (written by `sv create`, then rewritten by this task)
- `svelte.config.js` — NEW (written by `sv create`)
- `vite.config.ts` — NEW (written by `sv create`)
- `tsconfig.json` — NEW (written by `sv create`)
- `src/app.html` — NEW (written by `sv create`)
- `src/app.d.ts` — NEW (written by `sv create`)
- `.npmrc` — NEW (written by `sv create`)
- `.gitignore` — EDIT (already exists and is committed; see step 2 — `sv create` may overwrite it)
**Spec:** 2 (SvelteKit + TypeScript for UI and server; Node.js runtime), 32 (final technology decision)
**Invariants:** none directly.

**Do:**
1. From the repo root, scaffold the framework core only:
   ```bash
   npx sv create --template minimal --types ts --no-add-ons --no-install --no-dir-check .
   ```
   `--no-dir-check` is required: the directory already contains `CLAUDE.md`, `docs/`, `.claude/` and
   the spec PDF. `--no-add-ons` is deliberate — every add-on's opinions are replaced by later tasks.
2. **Immediately check `.gitignore`.** `sv create` writes its own and may have overwritten the
   committed one. Run `git diff .gitignore`. If it changed, restore the committed version with
   `git checkout -- .gitignore`, then merge in only genuinely new SvelteKit entries that are missing.
   Verify afterwards that `grep -nxF 'tasks/' .gitignore` prints **exactly one** line — losing that
   line would commit this plan directory.
3. Add `backups/` to `.gitignore` (T-07 writes database dumps there, and a dump of this database will
   eventually contain PIN hashes, session tokens and the audit log). Keep it to one new line; do not
   duplicate an existing entry.
4. Rewrite `package.json` so **every** dependency is an exact version with no `^` or `~`. A scaffold
   is the one place determinism is worth more than easy minor upgrades. Use exactly these:

   `dependencies`:
   ```
   drizzle-orm  0.45.2
   pg           8.23.0
   ```
   `devDependencies`:
   ```
   @playwright/test              1.63.0
   @sveltejs/adapter-node        5.5.7
   @sveltejs/kit                 2.70.3
   @sveltejs/vite-plugin-svelte  7.3.0
   @tailwindcss/vite             4.3.3
   @types/node                   24.13.4
   @types/pg                     8.23.1
   dotenv                        17.4.2
   drizzle-kit                   0.31.10
   eslint                        10.10.0
   eslint-config-prettier        10.1.8
   eslint-plugin-svelte          3.23.0
   prettier                      3.9.6
   prettier-plugin-svelte        4.1.1
   svelte                        5.57.0
   svelte-check                  4.7.6
   tailwindcss                   4.3.3
   typescript                    6.0.3
   typescript-eslint             8.70.0
   vite                          8.3.0
   vitest                        5.0.0
   ```
5. Three of those pins are counter-intuitive and must not be "updated" to `latest`:
   - `typescript` **6.0.3**, not 7.0.2. npm's `latest` is 7.0.2, but `@sveltejs/kit` peers
     `^5.3.3 || ^6.0.0`, `svelte-check` peers `^5.0.0 || ^6.0.0`, and `typescript-eslint` peers
     `>=4.8.4 <6.1.0`. 6.0.3 is the only version all three accept.
   - `@types/node` **24.13.4**, not 22.20.2 (`latest`) and not 26.5.1 (the `ts6.0` tag) — it must match
     the Node 24 runtime.
   - `vitest` **5.0.0** requires Node 22.12+/24/26+, which is why T-01 exists.
6. Add `"type": "module"`, `"private": true`, and:
   ```json
   "engines": { "node": ">=24.0.0 <25.0.0" }
   ```
7. Set the scripts. `db:migrate` chains the backup deliberately — spec 29 says "A backup is always
   taken before running database migrations", and a chained script is a mechanism where a comment is
   only a wish:
   ```json
   "scripts": {
     "dev": "vite dev",
     "build": "vite build",
     "preview": "vite preview",
     "prepare": "svelte-kit sync",
     "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
     "check:watch": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch",
     "lint": "prettier --check . && eslint .",
     "format": "prettier --write .",
     "test": "vitest run",
     "test:unit": "vitest run --project unit",
     "test:integration": "vitest run --project integration",
     "test:e2e": "playwright test",
     "db:generate": "drizzle-kit generate",
     "db:migrate": "pnpm db:backup && drizzle-kit migrate",
     "db:studio": "drizzle-kit studio",
     "db:backup": "bash scripts/db-backup.sh"
   }
   ```
8. Run `pnpm install`. Then `pnpm exec playwright install chromium` (the browser binary is a separate
   download from the npm package).
9. Confirm no peer-dependency warnings mention `typescript`. If any do, the TypeScript pin was lost —
   fix it before continuing; everything downstream depends on it.

**Tests:** none yet (T-09 builds the harness). Step 10 is the verification.
10. `pnpm install` completes with no unmet peer dependencies, and `pnpm exec tsc --version` prints
    `Version 6.0.3`.

**Done when:** `pnpm install` succeeds, `pnpm exec tsc --version` prints `Version 6.0.3`,
`node -v` prints `v24.21.0`, `grep -nxF 'tasks/' .gitignore` prints exactly one line, and
`git diff --stat` shows `.gitignore` either unchanged or changed only by the `backups/` addition.

**Watch out:** `sv create` overwriting `.gitignore` is the trap in this task — if `tasks/` is lost from
it, the next commit adds this entire plan directory to the repository. Check step 2 before anything
else. Also: `tsconfig.json` extends `./.svelte-kit/tsconfig.json`, which does not exist until
`svelte-kit sync` has run; the `prepare` script runs it on install, so if `pnpm check` complains about
a missing tsconfig, run `pnpm exec svelte-kit sync` and retry.

### T-04 — Switch to adapter-node and wire Tailwind CSS v4

**Needs:** T-03
**Files:**
- `svelte.config.js` — EXTEND (created by T-03; replace the adapter import and usage)
- `vite.config.ts` — EXTEND (created by T-03; add the Tailwind plugin beside `sveltekit()`)
- `src/app.css` — NEW
- `src/routes/+layout.svelte` — NEW
**Spec:** 2 (Node.js runtime), 9 (cookies and the origin check), 30 (architecture), 32 (deployment is
Docker + Nginx, so a Node server is the build target)
**Invariants:** 12 (sessions are HttpOnly + Secure + SameSite cookies; SvelteKit's origin/CSRF check
stays ON)

**Do:**
1. In `svelte.config.js`, replace `@sveltejs/adapter-auto` with `@sveltejs/adapter-node`:
   ```js
   import adapter from '@sveltejs/adapter-node';
   import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

   export default {
     preprocess: vitePreprocess(),
     kit: { adapter: adapter() }
   };
   ```
   `adapter-auto` guesses a deployment platform; spec 32 fixes the target as a Node server behind
   Nginx, so the adapter is not a guess.
2. Do **not** add a `csrf` option (R5). SvelteKit's origin check defaults to on, and invariant 12
   requires it stay on. If a production deployment later returns 403 on form posts, the fix is to set
   the `ORIGIN` environment variable for adapter-node — **never** to disable the check. Note in the
   file, as a comment, that `csrf.checkOrigin` is deprecated in favour of `trustedOrigins` and that
   CSRF protection is inert during local development, so "it works in dev" proves nothing.
3. In `vite.config.ts`, add the Tailwind v4 plugin **before** `sveltekit()`:
   ```ts
   import tailwindcss from '@tailwindcss/vite';
   import { sveltekit } from '@sveltejs/kit/vite';
   import { defineConfig } from 'vite';

   export default defineConfig({
     plugins: [tailwindcss(), sveltekit()]
   });
   ```
   Tailwind v4 needs no `tailwind.config.js` and no PostCSS config — do not create either.
4. Create `src/app.css`:
   ```css
   @import 'tailwindcss';

   @theme {
     /* POS buttons are pressed with a thumb, on a screen someone is standing at.
        A named token keeps that honest instead of scattering magic numbers. */
     --spacing-touch: 4rem;
   }
   ```
5. Create `src/routes/+layout.svelte` importing it, so the stylesheet is loaded once for every route:
   ```svelte
   <script lang="ts">
     import '../app.css';
     let { children } = $props();
   </script>

   {@render children()}
   ```
   Use Svelte 5 runes (`$props()`, `{@render children()}`) — this project is on Svelte 5.57.0, and the
   Svelte 4 `<slot />` form is legacy.

**Tests:** none (T-09 adds the smoke test that proves the page renders).

**Done when:** `pnpm dev` starts with no errors, `pnpm build` completes and produces a `build/`
directory containing `index.js` (adapter-node's server entry point), and a Tailwind utility class
applied in a component visibly takes effect in the browser.

**Watch out:** plugin order matters — `tailwindcss()` goes before `sveltekit()`. Do not create
`tailwind.config.js`: Tailwind v4 is configured in CSS via `@theme`, and a stray v3-style config file
is silently ignored, which is worse than an error because it looks like it should work.

### T-05 — Create the module skeleton and route groups

**Needs:** T-03
**Files:**
- `src/lib/server/{db,money,accounting,inventory,orders,auth,permissions,audit}/README.md` — NEW (one
  per directory, 8 files)
- `src/lib/pos/README.md` — NEW
- `src/lib/server/db/schema/.gitkeep` — NEW
- `src/routes/+page.svelte` — EXTEND (created by T-03; replace the placeholder content)
- `src/routes/(dashboard)/+layout.svelte` — NEW
- `src/routes/(pos)/+layout.svelte` — NEW
**Spec:** 30 (architecture), 31 (MVP scope), 32 (modular monolith)
**Invariants:** 1 (money arithmetic lives in one module — see the warning below)

**Do:**
1. Create the directory layout from CLAUDE.md's "Where code lives", giving each module directory a
   short `README.md` stating what belongs there and what must never import it. Git does not track empty
   directories, so a placeholder file per directory is required, not decorative. Use the CLAUDE.md
   one-liners:
   - `db/` — Drizzle schema (one file per aggregate), generated migrations, client. The **only** place
     tables are defined.
   - `money/` — integer cents, allocation, THE rounding rule, tax in both modes. Imported by
     everything; imports no sibling. **See the warning below before writing any code here.**
   - `accounting/` — chart of accounts, posting rules (one per business event), journal writer.
   - `inventory/` — stock movements, recipes + unit conversion, weighted-average costing.
   - `orders/` — order/item lifecycle, split & merge bills, THE payment transaction. Calls
     `accounting/`, `inventory/`, `permissions/`, `audit/`; none of them call back.
   - `auth/` — cookie sessions, PIN hash + lockout, POS device registration.
   - `permissions/` — RBAC checks + owner-PIN approval gates.
   - `audit/` — audit log writer.
   - `pos/` — IndexedDB, sync queue, service worker, device invoice sequence, print-agent client. Must
     work offline. Must never import `lib/server/**`.
2. Create `src/lib/server/db/schema/.gitkeep`. T-07 points drizzle-kit at this folder, and it must
   exist and be tracked even while empty (R3).
3. Create the two route groups with a minimal `+layout.svelte` each, and say in a comment what each
   group's constraint is: `(dashboard)` is owner/admin and online-only; `(pos)` must work offline and
   must never import from `$lib/server`.
4. Replace `src/routes/+page.svelte` with a plain landing page — a heading, one line of text, and links
   to `/` placeholders. It exists so `pnpm dev` serves something and T-09's smoke test has a target.
   Give it a stable `<h1>` such as `matcami` for the test to assert on.
5. Create **no** `+page.server.ts`, **no** `+layout.server.ts` and **no** `load` function anywhere
   under `(pos)`. A blocking server `load` in the POS shell is the seam that makes offline impossible
   later, and a scaffold is where that pattern gets copied from.
6. Write no business logic, no tables, no money arithmetic, no account codes. These are directories and
   README files.

**Tests:** none.

**Done when:** `git status --short` shows all the new files as untracked (so none landed inside an
ignored path), `pnpm dev` serves the landing page, and `pnpm build` succeeds.

**Watch out — do not resolve the money-module question here.** Create `src/lib/server/money/` exactly
as CLAUDE.md's layout specifies, and write nothing in it but the README. There is an unresolved
conflict: CLAUDE.md invariant 1 puts money arithmetic in `src/lib/server/money`, but spec 17 requires
"one rounding rule, implemented in one function and used everywhere (POS, server, reports)" and
SvelteKit build-blocks `$lib/server/**` from client code, so the offline POS cannot import it from
there. The spec outranks CLAUDE.md, so this will likely move to an isomorphic `src/lib/money/` — but
that is the first money task's decision to make and record, together with the CLAUDE.md correction.
Creating the directory CLAUDE.md already names decides nothing; moving it now would. Put a line in
`money/README.md` saying exactly this, so whoever opens it next is not surprised.

---

# Phase 2 — Database wiring

**Depends on:** Phase 0 (T-02 for the databases), Phase 1 (T-03 for the packages).

### T-06 — Environment files and env loading

**Needs:** T-02, T-03
**Files:**
- `.env.example` — NEW
- `.env` — NEW (never committed; `.gitignore` already ignores it)
- `src/lib/server/env.ts` — NEW
**Spec:** 17 (the restaurant's time zone is a *setting*; tax mode is a *setting*), 29 (operations),
33 (open decisions 3 and 4 are unresolved)
**Invariants:** 12 (secrets never reach the client)

**Do:**
1. Create `.env.example` with **placeholder** values only — it is committed, so it must never contain a
   working credential. Exactly these keys:
   ```
   # Development database. Create it with: bash scripts/db-bootstrap.sh <password>
   DATABASE_URL=postgres://matcami:CHANGE_ME@localhost:5432/matcami

   # Separate database used ONLY by the Vitest integration project.
   # The name MUST end in _test — the integration setup refuses to run otherwise.
   TEST_DATABASE_URL=postgres://matcami:CHANGE_ME@localhost:5432/matcami_test

   # adapter-node: the public origin in production. Required for SvelteKit's CSRF
   # origin check to pass behind Nginx. NEVER disable the origin check instead.
   ORIGIN=http://localhost:3000
   ```
2. **Do not add** `TAX_MODE`, `TAX_RATE`, `CURRENCY` or `TZ`/`RESTAURANT_TIMEZONE` to either env file.
   Spec 17 makes tax mode and the restaurant time zone *restaurant settings*, and open decisions 3 and
   4 (tax rules; payment methods and currencies) are unresolved. Putting them in `.env` would silently
   answer a spec 33 open decision and put a business setting outside the database where no audit trail
   reaches it. They belong in a settings table, in a later task, after the user decides.
3. Create the real `.env` by copying `.env.example` and filling in the actual password from T-02.
   Confirm it is ignored: `git check-ignore -v .env` must print a matching rule. Never print the
   contents of `.env` in output or a commit message.
4. Create `src/lib/server/env.ts` that reads and validates the environment once, and fails loudly at
   startup rather than producing `undefined` deep inside a query:
   ```ts
   import { env } from '$env/dynamic/private';

   function required(name: string): string {
     const value = env[name];
     if (!value) throw new Error(`Missing required environment variable: ${name}`);
     return value;
   }

   export const DATABASE_URL = required('DATABASE_URL');
   ```
   Use `$env/dynamic/private`, not `$env/static/private`: adapter-node reads the environment at
   runtime, so a static import would bake build-time values into the production bundle.
5. This file lives under `src/lib/server/` deliberately — SvelteKit build-blocks `$lib/server/**` from
   client code, which is the mechanism that stops a credential reaching the browser. Never move env
   reading to a shared or client-importable module.

**Tests:** none directly; T-09's integration setup exercises `TEST_DATABASE_URL`.

**Done when:** `git check-ignore -v .env` prints a matching rule, `.env.example` is tracked and contains
no real password, `grep -E 'TAX|CURRENCY|TIMEZONE' .env .env.example` finds nothing, and `pnpm dev`
starts without an env error.

**Watch out:** `.gitignore` already has `.env` and `.env.*` with a `!.env.example` negation — verify
that negation survived T-03 step 2, or `.env.example` will be silently untracked and the next developer
gets no template at all.

### T-07 — Drizzle config, the DB client, the backup script, and a verified migration pipeline

**Needs:** T-02, T-03, T-06
**Files:**
- `drizzle.config.ts` — NEW
- `src/lib/server/db/client.ts` — NEW
- `scripts/db-backup.sh` — NEW
- `src/lib/server/db/schema/_probe.ts` — NEW (created and deleted within this task)
- `src/lib/server/db/migrations/**` — NEW (generated; committed)
**Spec:** 3 (PostgreSQL as source of truth; Drizzle; "Journal entries must balance, and the database
itself enforces it (a constraint checked at commit), not only application code"), 17 (money as integer
minor units in `bigint`; quantities `numeric(12,3)`; UTC `timestamptz`), 29 ("A backup is always taken
before running database migrations"; "database changes go through Drizzle migrations")
**Invariants:** 1 (money is integer minor units in `bigint`; never a float or a `numeric` money
column), 3 (journal entries balance, enforced by a DB constraint checked at COMMIT — this task must
leave that *expressible*), 4 (one all-or-nothing transaction — the client must make a transaction
handle the natural thing to pass around), 11 (timestamps stored UTC in `timestamptz`)

**Do:**
1. Create `drizzle.config.ts`. Point `schema` at the dedicated **schema folder**, never at a glob over
   `db/` (R3) — a glob over `db/` would import `client.ts` and open a connection just by running
   drizzle-kit:
   ```ts
   import 'dotenv/config';
   import { defineConfig } from 'drizzle-kit';

   export default defineConfig({
     dialect: 'postgresql',
     schema: './src/lib/server/db/schema',
     out: './src/lib/server/db/migrations',
     dbCredentials: { url: process.env.DATABASE_URL! },
     strict: true,
     verbose: true
   });
   ```
   `out` is `src/lib/server/db/migrations` because CLAUDE.md requires it there — not drizzle's default
   `./drizzle`. `import 'dotenv/config'` is needed because drizzle-kit runs outside Vite, so SvelteKit's
   `$env` modules are unavailable.
2. Create `src/lib/server/db/client.ts`:
   ```ts
   import { drizzle } from 'drizzle-orm/node-postgres';
   import pg from 'pg';
   import { DATABASE_URL } from '../env';

   // Every connection speaks UTC. Invariant 11: timestamps are stored UTC in
   // timestamptz; the restaurant's time zone is a setting applied at the edges,
   // never a property of the database session.
   const pool = new pg.Pool({
     connectionString: DATABASE_URL,
     options: '-c timezone=UTC'
   });

   export const db = drizzle(pool);
   export type Db = typeof db;
   export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
   ```
3. **Configure no type parsers.** Do not call `pg.types.setTypeParser`, and never pass
   `mode: 'number'` to a `bigint` or `numeric` column. Left alone, `pg` returns `int8` and `numeric` as
   **strings**, which is exactly what invariant 1 requires — money as integer minor units and
   quantities as fixed-precision decimals, with no float anywhere near them. A type parser added "for
   convenience" later is how money silently becomes a JS float.
4. Export `DbTx` (step 2) and say in a comment why: invariant 4 requires one all-or-nothing transaction
   at payment, so every function that writes must accept a transaction handle rather than reach for the
   `db` singleton. Making the type available now is what makes that the easy path later.
5. Create `scripts/db-backup.sh`, executable:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   [ -f .env ] && set -a && . ./.env && set +a
   mkdir -p backups
   out="backups/matcami-$(date -u +%Y%m%d-%H%M%SZ).dump"
   pg_dump "$DATABASE_URL" --format=custom --file="$out"
   echo "Backup written: $out"
   ```
   `pnpm db:migrate` runs this first (T-03 step 7), which turns spec 29's rule into a mechanism. The
   host `pg_dump` is 16.15 against a 16.15 server, so there is no client/server version mismatch.
   `backups/` was added to `.gitignore` in T-03 step 3 — verify that, because a dump of this database
   will eventually contain PIN hashes, session tokens and the audit log, and must never be committed.
6. Now prove the pipeline, with a throwaway table. Create
   `src/lib/server/db/schema/_probe.ts`:
   ```ts
   import { pgTable, integer, timestamp } from 'drizzle-orm/pg-core';

   // Throwaway. Exists only to prove generate -> migrate works. Dropped in step 8.
   export const _probe = pgTable('_probe', {
     id: integer('id').primaryKey(),
     createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
   });
   ```
   Note `withTimezone: true` — that is `timestamptz`, per invariant 11. Establish it here, because this
   is the example every later table will be copied from.
7. Run `pnpm db:generate`, then `pnpm db:migrate`. Confirm a migration appeared under
   `src/lib/server/db/migrations/` with an entry in `migrations/meta/_journal.json`, and that the table
   now exists: `psql "$DATABASE_URL" -c '\d _probe'` shows `created_at` as
   `timestamp with time zone`.
8. Delete `src/lib/server/db/schema/_probe.ts`, then run `pnpm db:generate` and `pnpm db:migrate`
   again. The second migration drops the table. Confirm `\d _probe` now errors with
   `relation "_probe" does not exist`.
9. Prove the **hand-written SQL** path, which is what invariant 3 will need. Invariant 3 requires the
   database itself to reject an unbalanced journal entry *at COMMIT*, which in PostgreSQL means a
   `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`. drizzle-kit cannot generate that from
   schema files, so it must come from a custom migration. Run:
   ```bash
   pnpm exec drizzle-kit generate --custom --name=custom_sql_probe
   ```
   Put a harmless no-op in the generated file — `DO $$ BEGIN END $$;` and a comment explaining that
   this migration exists to prove the custom path is wired. Run `pnpm db:migrate` and confirm it is
   recorded in `meta/_journal.json`.
10. **Only ever create hand-written SQL with `generate --custom`** (R2). That command registers the file
    in `migrations/meta/_journal.json`; a `.sql` file dropped into the folder by hand is not registered
    and is silently never applied. That failure mode is specifically dangerous for invariant 3: you
    would believe the balance constraint exists while the database has no such trigger, and every test
    that checks "the DB rejects an unbalanced entry" would pass for the wrong reason.
11. Commit all three migrations and the whole `meta/` directory. **Never delete a migration once it has
    run** (R8, and CLAUDE.md: migrations are committed and never hand-edited once they have run).
    Drizzle stores a hash per migration and does not re-check it, so deleting one silently diverges
    this database from every freshly built one. The two probe migrations are honest history: a table
    was created and dropped.
12. Confirm `pnpm db:studio` starts and connects, then stop it. It is a row editor over the live
    database — note in the README (T-10) that it must never be used to edit a posted record
    (invariant 2: correct with a reversing record, never an `UPDATE`).

**Tests:** T-09 adds the integration project that connects to `matcami_test`. Steps 7–9's verifications
are mandatory and must actually be run, not assumed.

**Done when:** `pnpm db:generate` and `pnpm db:migrate` both succeed; a `pg_dump` file appears under
`backups/` on every `db:migrate`; `migrations/meta/_journal.json` lists three applied migrations;
`psql "$DATABASE_URL" -c '\d _probe'` errors with `does not exist`; and `git check-ignore -v backups`
prints a matching rule.

**Watch out:** `pnpm db:migrate` will fail if `.env` is missing or `DATABASE_URL` is unset, because the
backup script runs first — that is deliberate, not a bug. If `drizzle-kit generate` reports it found no
schema, check `drizzle.config.ts`'s `schema` path and that `src/lib/server/db/schema/` exists; an empty
schema folder is the normal state after step 8 and generating from it again would produce nothing.

---

# Phase 3 — Checks, tests and documentation

**Depends on:** Phase 1, Phase 2.

### T-08 — ESLint, Prettier, svelte-check, and the import boundary rule

**Needs:** T-03, T-05
**Files:**
- `eslint.config.js` — NEW
- `.prettierrc` — NEW
- `.prettierignore` — NEW
**Spec:** 30 (modular monolith), 32 (architecture)
**Invariants:** 1 (money arithmetic confined to one module), 12 (server-only code, including secrets,
never reaches the client)

**Do:**
1. Create `eslint.config.js` as a flat config (ESLint 10) combining `typescript-eslint`,
   `eslint-plugin-svelte` and `eslint-config-prettier` last, so formatting rules do not fight Prettier.
   Ignore `.svelte-kit/`, `build/`, `node_modules/`, `coverage/`, `backups/` and
   `src/lib/server/db/migrations/` — generated SQL and generated types are not hand-maintained code.
2. Add the boundary rule enforcing CLAUDE.md's house convention. SvelteKit already fails the build when
   *client* code imports `$lib/server/**`, but it does not police `lib/pos/`, which is ordinary
   TypeScript that may be imported from either side. Add an override for `src/lib/pos/**` and
   `src/routes/(pos)/**`:
   ```js
   {
     files: ['src/lib/pos/**/*.{ts,svelte}', 'src/routes/(pos)/**/*.{ts,svelte}'],
     rules: {
       'no-restricted-imports': ['error', {
         patterns: [{
           group: ['$lib/server/*', '$lib/server/**', '../server/*', '**/lib/server/**'],
           message:
             'lib/pos and the (pos) routes must work offline and must never import lib/server. ' +
             'SvelteKit build-blocks $lib/server from the browser, so this import cannot work ' +
             'offline. If you need shared logic (money arithmetic, for example), move the pure ' +
             'function into an isomorphic module both sides import — do NOT copy it. Spec 17 ' +
             'requires one rounding rule in one function used by POS, server and reports.'
         }]
       }]
     }
   }
   ```
   The message matters as much as the rule: it points at the real fix instead of inviting someone to
   copy the function.
3. Create `.prettierrc` with `prettier-plugin-svelte` registered, and `.prettierignore` covering the
   same generated paths as step 1 plus `pnpm-lock.yaml`.
4. Run `pnpm format`, then `pnpm lint` and `pnpm check`. Both must pass clean. Fix real problems; do
   not silence a rule to get green.
5. Verify the boundary rule actually fires — a lint rule nobody has seen fail is a rule that might not
   work. Temporarily add `import { db } from '$lib/server/db/client';` to a file under `src/lib/pos/`,
   run `pnpm lint`, confirm it errors with the custom message, then remove the import.

**Tests:** step 5 is the test, and it is not optional.

**Done when:** `pnpm check && pnpm lint` exits 0, and step 5's deliberate violation produces an ESLint
error naming the boundary.

**Watch out:** `eslint-config-prettier` must come **last** in the config array or it cannot turn off the
stylistic rules it exists to disable. `pnpm check` needs `.svelte-kit/tsconfig.json`, which the `check`
script generates via `svelte-kit sync` — if it complains about a missing tsconfig, that sync did not
run.

### T-09 — Vitest (unit + integration) and a Playwright smoke test

**Needs:** T-02, T-03, T-06, T-07
**Files:**
- `vitest.config.ts` — NEW
- `src/lib/server/db/integration-setup.ts` — NEW
- `src/lib/sanity.test.ts` — NEW
- `src/lib/server/db/client.integration.test.ts` — NEW
- `playwright.config.ts` — NEW
- `e2e/smoke.spec.ts` — NEW
**Spec:** 29 (the six mandatory test areas, verbatim: money arithmetic and rounding · tax calculation in
both modes · journal entries always balance · posting rules for every business event · offline sync
retries never duplicate · permission checks on every POS API)
**Invariants:** 3 (journal entries balance, enforced by the DB — the harness this task builds is the
only place that can ever be checked), 11 (UTC)

**Do:**
1. Create `vitest.config.ts` using `test.projects` — the `workspace` key and a separate
   `vitest.workspace.ts` are deprecated as of Vitest 3.2 and wrong for 5.0.0:
   ```ts
   import { defineConfig } from 'vitest/config';

   export default defineConfig({
     test: {
       projects: [
         {
           test: {
             name: 'unit',
             environment: 'node',
             include: ['src/**/*.test.ts'],
             exclude: ['src/**/*.integration.test.ts']
           }
         },
         {
           test: {
             name: 'integration',
             environment: 'node',
             include: ['src/**/*.integration.test.ts'],
             setupFiles: ['./src/lib/server/db/integration-setup.ts'],
             fileParallelism: false
           }
         }
       ]
     }
   });
   ```
   `fileParallelism: false` for the integration project because every file shares one `matcami_test`
   database; parallel files would interfere with each other's rows.
2. Create `src/lib/server/db/integration-setup.ts` and make it **fail closed** (R4). This is the guard
   that stops a test run destroying development data:
   ```ts
   const url = process.env.TEST_DATABASE_URL;

   if (!url) {
     throw new Error(
       'TEST_DATABASE_URL is not set. The integration project refuses to run rather than ' +
         'silently fall back to DATABASE_URL, because these tests truncate tables and ' +
         'DATABASE_URL points at development data. Set TEST_DATABASE_URL (see .env.example).'
     );
   }

   const dbName = new URL(url).pathname.replace(/^\//, '');
   if (!dbName.endsWith('_test')) {
     throw new Error(
       `Refusing to run integration tests against "${dbName}": the database name must end in ` +
         '"_test". Integration tests truncate tables, and this guard is what keeps them away ' +
         'from development and production data.'
     );
   }
   ```
   Never fall back to `DATABASE_URL`. A fallback is what turns "the test database was not configured"
   into "the test suite truncated the real one".
3. Create `src/lib/sanity.test.ts` — one trivial assertion, so the unit project is proven to run and
   report before anything depends on it.
4. Create `src/lib/server/db/client.integration.test.ts` asserting three things against the real
   database: a `select 1` round-trips; `current_setting('TimeZone')` is `UTC` (invariant 11, and the
   `options: '-c timezone=UTC'` in T-07 step 2 is what makes it so); and `select '9007199254740993'::int8`
   comes back as a **string**, not a `number` (invariant 1 — this is the assertion that will fail the
   day someone adds a `pg` type parser and turns money into a float, and `9007199254740993` is chosen
   because it is larger than `Number.MAX_SAFE_INTEGER` and so cannot survive a float round-trip).
5. Create `playwright.config.ts` running against the **production build**, never the dev server (R6):
   ```ts
   import { defineConfig } from '@playwright/test';

   export default defineConfig({
     testDir: 'e2e',
     webServer: {
       command: 'pnpm build && pnpm preview --port 4173',
       port: 4173,
       reuseExistingServer: !process.env.CI
     },
     use: { baseURL: 'http://localhost:4173' }
   });
   ```
   This matters beyond convenience: service workers and offline behaviour do not exist under `vite dev`,
   so an e2e harness pointed at the dev server could never test the offline POS — and that is the one
   thing in this product that most needs an end-to-end test.
6. Create `e2e/smoke.spec.ts`: load `/` and assert the `<h1>` from T-05 step 4 is visible.
7. Run `pnpm test` (both projects), then `pnpm test:e2e`. All must pass.
8. Record in the README (T-10) which of spec 29's six mandatory areas this harness now makes testable,
   and that **none of the six is implemented yet** — this task builds the harness, not the tests. The
   two that need a real PostgreSQL are "journal entries always balance" (the database must reject an
   unbalanced entry, which no mock can prove) and "permission checks on every POS API". Both belong to
   the integration project.

**Tests:** the files above are the tests. Mark none of them `MANDATORY (spec 29)` — the mandatory suites
arrive with the code they cover. This task's obligation is that the harness runs and that the
integration project cannot be pointed at a non-`_test` database.

**Done when:** `pnpm test` passes both projects; `pnpm test:e2e` passes; and pointing
`TEST_DATABASE_URL` at `.../matcami` (no `_test` suffix) makes `pnpm test:integration` **fail** with the
guard's message rather than running.

**Watch out:** verify the failure in the last clause by actually trying it — a fail-closed guard that
was never seen to fail is indistinguishable from one that does not work. Also, `pnpm test` on Node 25
fails at the engine check; if that happens, T-01 did not take effect in this shell.

### T-10 — Write the README and make CLAUDE.md's "Commands & setup" block true

**Needs:** T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-09
**Files:**
- `README.md` — NEW
- `CLAUDE.md` — EDIT (the "Commands & setup" section only)
**Spec:** 29 (operations: backups, migrations, the mandatory tests), 33 (open decisions)
**Invariants:** all twelve are referenced by CLAUDE.md; this task must not alter any of their wording
except as described in step 4.

**Do:**
1. Write `README.md` covering, in this order: prerequisites (Node 24.21.0 via `.nvmrc`, pnpm 10.33.0, a
   local PostgreSQL 16); first-time setup (`bash scripts/db-bootstrap.sh <password>`,
   `cp .env.example .env` and fill it in, `pnpm install`, `pnpm db:migrate`); the everyday commands;
   and where the documentation lives (`docs/spec.md` is authoritative, `CLAUDE.md` holds the
   invariants).
2. Include three warnings in the README, because each is a way to lose data or break an invariant
   quietly:
   - `pnpm db:studio` is a row editor over the live database. **Never** edit a posted record with it —
     a paid order, invoice, payment, stock movement or journal entry is corrected with a reversing
     record, never an `UPDATE` (invariant 2).
   - Hand-written SQL migrations are created **only** with `drizzle-kit generate --custom`. A `.sql`
     file added by hand is never registered in `meta/_journal.json` and is silently never applied.
   - Migrations are never deleted or edited once they have run. `pnpm db:migrate` takes a backup first,
     automatically — do not bypass it.
3. Note in the README which of spec 29's six mandatory test areas the harness supports and that none is
   implemented yet (T-09 step 8).
4. Rewrite CLAUDE.md's "Commands & setup" section so it states fact instead of a proposal. The current
   block opens with "ASSUMED toolchain — the repo is empty, nothing is installed. The commit that
   scaffolds tooling MUST make these real or rewrite this block; until then they are a proposal, not
   fact." That sentence must go, since this plan is that commit. Specifically:
   - Delete the `docker compose up -d db` line. There is no compose file; the database is the
     host-installed PostgreSQL 16. Replace it with `bash scripts/db-bootstrap.sh <password>` and a note
     that `DATABASE_URL` lives in `.env`, which is never committed.
   - Add the commands this plan created that the block does not list: `pnpm db:backup`,
     `pnpm test:unit`, `pnpm test:integration`, `pnpm format`.
   - Keep `pnpm db:migrate`'s "ALWAYS back up first" note, and state that the script now does it
     automatically.
   - Record the pinned versions that are counter-intuitive — Node 24.21.0, TypeScript 6.0.3,
     `@types/node` 24.13.4 — with one line on why, so nobody "updates" them to `latest` and breaks
     `pnpm check`.
5. Change **nothing else in CLAUDE.md**. Do not touch the twelve invariants, the module layout, the
   glossary, the open decisions table or the do-not-build list. In particular, do **not** amend
   invariant 1's money path — that belongs to the first money task, together with its decision (see
   Assumptions, item 3).
6. Verify every command in the rewritten block by running it. A block that documents a command nobody
   ran is the same defect this task exists to fix.
7. Commit. Suggested message:
   `chore: initialize project — SvelteKit, Drizzle, Tailwind, test harness, pinned toolchain`

**Tests:** step 6 — run every documented command.

**Done when:** every command in CLAUDE.md's "Commands & setup" block has been executed successfully in
this repo; the words "ASSUMED" and "proposal, not fact" no longer appear in that section; `docker
compose up -d db` no longer appears anywhere in CLAUDE.md; and `git diff CLAUDE.md` shows changes
confined to that one section.

**Watch out:** CLAUDE.md is the file every future session reads first. An inaccuracy left here
misleads every later task — which is precisely why the current block tells you to rewrite it. Resist
editing anything beyond the commands section; the invariants above it are not yours to adjust.

---

## Task index

| ID | Title | Phase | Needs |
|---|---|---|---|
| T-01 | Install and pin Node 24 LTS | 0 Preflight | - |
| T-02 | Create the PostgreSQL role and both databases | 0 Preflight | - |
| T-03 | Scaffold SvelteKit and pin every package exactly | 1 App skeleton | T-01 |
| T-04 | Switch to adapter-node and wire Tailwind CSS v4 | 1 App skeleton | T-03 |
| T-05 | Create the module skeleton and route groups | 1 App skeleton | T-03 |
| T-06 | Environment files and env loading | 2 Database | T-02, T-03 |
| T-07 | Drizzle config, DB client, backup, verified migration pipeline | 2 Database | T-02, T-03, T-06 |
| T-08 | ESLint, Prettier, svelte-check, import boundary rule | 3 Checks | T-03, T-05 |
| T-09 | Vitest (unit + integration) and Playwright smoke test | 3 Checks | T-02, T-03, T-06, T-07 |
| T-10 | README and CLAUDE.md "Commands & setup" truth-up | 3 Checks | all above |

**Suggested order:** T-01 → T-02 → T-03 → T-04 → T-05 → T-06 → T-07 → T-08 → T-09 → T-10.
T-04 and T-05 are independent of each other; T-08 can run any time after T-05.

## Definition of done for the whole plan

```bash
node -v                  # v24.21.0
pnpm install             # no unmet peers; tsc --version -> 6.0.3
pnpm dev                 # serves the landing page
pnpm build               # produces build/index.js (adapter-node)
pnpm check && pnpm lint  # exits 0
pnpm db:generate         # runs
pnpm db:migrate          # takes a backup first, then applies
pnpm db:studio           # connects
pnpm test                # unit + integration both pass
pnpm test:e2e            # smoke test passes
```

And: CLAUDE.md's "Commands & setup" block describes exactly the above, with no `docker compose` line
and no "ASSUMED" caveat.
