# Phase 0 — Prerequisites and the database role split

This plan is the first business feature, and it is cut from a repo whose toolchain plan is
unfinished. Phase 0 proves the ground is there, makes the runtime connect as a role that does not own
the tables, and answers the one toolchain decision this feature forces.

**Depends on:** nothing. Every later phase depends on this one.

Read `00-overview.md` first: it carries the requirements, the decisions taken at the gate, the
assumptions, and the file-tag convention (`NEW` / `EXTEND` / `EDIT`).

---

### T-01 — Verify the project-init prerequisites and stop if any are missing

**Needs:** -
**Files:** none created or edited. This task only reads and reports.
**Spec:** 29 (operations: database changes go through Drizzle migrations; a backup is always taken
before running them)
**Invariants:** none directly. This task exists so that no later task builds on a file that does not
exist.

**Do:**

1. Confirm the Node version. `node -v` must print `v24.21.0`. If it prints anything else, run
   `nvm use` (the repo pins `24.21.0` in `.nvmrc`) and check again. Do **not** proceed on another
   major version: `.npmrc` sets `engine-strict=true` and the hashing API this plan depends on does
   not exist before v24.7.0.

2. Check that every prerequisite file exists. Run exactly this and read the output:

   ```bash
   cd /home/mohamed-amiin/Desktop/matcami
   for f in .env .env.example drizzle.config.ts eslint.config.js vitest.config.ts \
            playwright.config.ts src/lib/server/env.ts src/lib/server/db/client.ts \
            scripts/db-backup.sh; do
     test -f "$f" && echo "OK   $f" || echo "MISSING  $f"
   done
   test -d src/lib/server/db/migrations && echo "OK   src/lib/server/db/migrations" \
     || echo "MISSING  src/lib/server/db/migrations"
   ```

3. **If anything prints `MISSING`, STOP and report it to the user.** Those files are the deliverables
   of `tasks/project-init.md` tasks T-06, T-07, T-08 and T-09, which were not done when this plan was
   written. Name which are missing and which project-init task owns each:

   - `.env`, `.env.example`, `src/lib/server/env.ts` → project-init **T-06**
   - `drizzle.config.ts`, `src/lib/server/db/client.ts`, `scripts/db-backup.sh`,
     `src/lib/server/db/migrations/` → project-init **T-07**
   - `eslint.config.js` → project-init **T-08**
   - `vitest.config.ts`, `playwright.config.ts` → project-init **T-09**

   Do not create them here. Do not work around them. This plan assumes they exist and edits several
   of them; guessing at their contents produces a migration that has already run against a schema
   nobody intended, which invariant 2 forbids you to hand-edit back.

4. Confirm that `src/lib/server/db/client.ts` exports a transaction-handle type. Run
   `grep -n 'export' src/lib/server/db/client.ts`. It must export `db`, and a type usable as a
   transaction handle (project-init T-07 names it `DbTx`). Every write function in this plan takes
   that handle as its first parameter, because invariant 4 requires one all-or-nothing transaction at
   payment and the habit is established here, long before payment exists. If the export is named
   something else, use the real name throughout this plan and say so in the commit.

5. Confirm the test harness runs at all: `pnpm test` must exit 0 with both the `unit` and
   `integration` projects reported. If the integration project fails because nothing has created the
   test schema, that is expected — **T-08 of this plan fixes it** — but the project must at least be
   configured and discovered. If `vitest` reports no `integration` project, project-init T-09 is
   incomplete; stop.

6. Confirm the working tree is clean and note the branch. This plan should be executed on a branch
   cut **after** project-init has merged. If `git log main..HEAD --oneline` shows the project-init
   commits still unmerged on a feature branch, tell the user: executing this plan on top of an
   unmerged `feat/project-init` means a later rebase, and project-init T-10 rewrites CLAUDE.md's
   commands section while this plan's T-26 edits other CLAUDE.md sections.

**Tests:** none. Step 2 and step 5 are the verification.

**Done when:** `node -v` prints `v24.21.0`, the loop in step 2 prints `OK` for every path,
`grep -n 'export' src/lib/server/db/client.ts` shows the database handle and the transaction-handle
type, and `pnpm test` exits 0 with both projects discovered.

**Watch out:** the temptation here is to create a small stub for whatever is missing and carry on.
Do not. A stub `drizzle.config.ts` pointing at the wrong `out` directory puts migrations in
`./drizzle` instead of `src/lib/server/db/migrations`, and CLAUDE.md requires them in the latter;
once a migration has run from the wrong place, the fix is another migration, never a move.

---

### T-02 — Add the non-owner runtime role and split the connection URLs

**Needs:** T-01
**Files:**
- `scripts/db-bootstrap.sh` — EDIT (created by project-init T-02; it currently creates the role
  `matcami` and both databases. Add a second role after the existing role block, before the database
  loop's grants, and extend the closing report)
- `.env.example` — EDIT (created by project-init T-06; add `MIGRATE_DATABASE_URL` and
  `TEST_DATABASE_URL` alongside the existing `DATABASE_URL`, and change what `DATABASE_URL` points at)
- `.env` — EDIT (the developer's real file, never committed; same three variables)
- `drizzle.config.ts` — EDIT (created by project-init T-07; change `dbCredentials.url` to read
  `MIGRATE_DATABASE_URL`)
- `scripts/db-backup.sh` — EDIT (created by project-init T-07; change the `pg_dump` argument to
  `MIGRATE_DATABASE_URL`)
- `src/lib/server/env.ts` — EDIT (created by project-init T-06; add the new required variables to the
  validation)
**Spec:** 3 (PostgreSQL is the primary source of truth), 29 (a backup is always taken before running
database migrations; database changes go through Drizzle migrations), 1 (the architecture should be
structured so that we can later add multi-tenant support)
**Invariants:** 12 (secrets never reach the client; server-only modules read the environment)

**Do:**

1. Understand why this task exists before changing anything. `scripts/db-bootstrap.sh` today creates
   **one** role, `matcami`, and makes it the **owner** of both databases. A table owner is not subject
   to that table's row-level security policies unless the table is additionally marked
   `FORCE ROW LEVEL SECURITY`, and forcing it makes `pg_dump` run by that same owner fail outright,
   which breaks `pnpm db:migrate` because that script chains `pnpm db:backup` first. Splitting the
   roles now means row-level security can be switched on later by one migration, with no bootstrap
   rewrite and no privilege re-grant. This task does **not** create any policy.

2. In `scripts/db-bootstrap.sh`, add a second login role named `matcami_app`, guarded exactly the way
   the existing role is guarded (`CREATE ROLE` is not idempotent). Take its password from a second
   positional argument or the environment variable `MATCAMI_APP_DB_PASSWORD`. Follow the existing
   file's pattern: pass the password to `psql` as a `-v` variable and use `:'pw'` so psql quotes it,
   never string-paste it into SQL. Do **not** give it `SUPERUSER`, `CREATEDB`, `CREATEROLE` or
   `BYPASSRLS`. Do **not** make it an owner of anything.

3. Inside the existing per-database loop, after the timezone statement, grant the runtime role what it
   needs and nothing more. Run these as the `postgres` superuser against each database in turn:

   ```sql
   GRANT CONNECT ON DATABASE "<dbname>" TO matcami_app;
   GRANT USAGE ON SCHEMA public TO matcami_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO matcami_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO matcami_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE matcami IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO matcami_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE matcami IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO matcami_app;
   ```

   The two `ALTER DEFAULT PRIVILEGES` statements are the point of the whole task: they must say
   `FOR ROLE matcami`, because `matcami` is the role that will create every future table through
   migrations, and default privileges attach to the creating role. Without them, every table a later
   plan adds is invisible to the runtime until someone remembers a manual `GRANT`.

   The sequence grant is not optional: `audit_log.id` is `GENERATED ALWAYS AS IDENTITY`, which is
   backed by a sequence, and an insert fails without `USAGE` on it.

   Note what is deliberately **absent** from the grant list: `TRUNCATE`. PostgreSQL requires the
   `TRUNCATE` privilege for that statement and only the owner has it by default, so the runtime role
   cannot truncate `audit_log` even though the append-only trigger T-07 installs covers only `UPDATE`
   and `DELETE`. That is the intended division of labour; do not add `TRUNCATE` to the grant.

4. Extend the script's closing report so it prints all three connection URLs in the shape the env
   files need, with the same "only print a password supplied on this run" rule the existing script
   already follows:

   ```
   DATABASE_URL=postgres://matcami_app:<app-password>@localhost:5432/matcami
   MIGRATE_DATABASE_URL=postgres://matcami:<owner-password>@localhost:5432/matcami
   TEST_DATABASE_URL=postgres://matcami:<owner-password>@localhost:5432/matcami_test
   ```

   `TEST_DATABASE_URL` points at the **owner** role deliberately: the integration harness (T-08)
   creates and truncates tables, which the runtime role must not be able to do.

5. Re-run the bootstrap. It is idempotent, so this is safe:
   `bash scripts/db-bootstrap.sh <owner-password> <app-password>` (or via the two environment
   variables). Confirm it reports the existing role and databases as already present and the new role
   as created.

6. Update `.env.example` and `.env`. `DATABASE_URL` now points at `matcami_app`; add
   `MIGRATE_DATABASE_URL` and confirm `TEST_DATABASE_URL` points at `matcami`. Keep the placeholder
   discipline the existing file uses: `.env.example` is committed and must never contain a working
   credential. Do **not** add `TAX_MODE`, `TAX_RATE`, `CURRENCY` or any time-zone variable; those are
   restaurant settings behind open decisions 3 and 4, and project-init T-06 forbids them here.

7. Update `src/lib/server/env.ts` so `MIGRATE_DATABASE_URL` is validated alongside `DATABASE_URL`,
   failing loudly at startup rather than producing `undefined` inside a query. Keep using
   `$env/dynamic/private`, not `$env/static/private`, for the reason project-init T-06 records:
   adapter-node reads the environment at runtime.

8. Point `drizzle.config.ts` at `MIGRATE_DATABASE_URL` and `scripts/db-backup.sh` at the same
   variable. Both run as the owner from now on. Leave `drizzle.config.ts`'s `schema` and `out` paths
   exactly as project-init T-07 set them.

9. Prove the split works. As the app role, creating a table must **fail**; as the owner it must
   succeed:

   ```bash
   psql "$DATABASE_URL" -c "select current_user" ;              # matcami_app
   psql "$DATABASE_URL" -c "create table _t(x int)" ;           # must ERROR: permission denied
   psql "$MIGRATE_DATABASE_URL" -c "create table _t(x int); drop table _t;"   # must succeed
   ```

**Tests:** none in Vitest — this is environment work. Step 9's two probes are the verification and
they are mandatory.

**Done when:** `bash scripts/db-bootstrap.sh` is idempotent on a second run; `psql "$DATABASE_URL" -c
"select current_user"` prints `matcami_app`; `create table` fails as the app role and succeeds as the
owner; `pnpm db:migrate` still runs (it will apply nothing yet) and still writes a dump into
`backups/`; and `grep -E 'TAX|CURRENCY|TIMEZONE' .env .env.example` finds nothing.

**Watch out:** `ALTER DEFAULT PRIVILEGES` without `FOR ROLE matcami` attaches to whoever runs the
statement, which in this script is `postgres`. Migrations are run by `matcami`, so the privileges
would never apply and every future table would be unreadable by the runtime, with a `permission
denied for table` error appearing only after that table's first query in production. Read the two
statements back with `psql "$MIGRATE_DATABASE_URL" -c '\ddp'` and confirm the grantor column says
`matcami`.

---

### T-03 — Install and pin zod, and record the validation-library decision

**Needs:** T-01
**Files:**
- `package.json` — EDIT (add one entry to `dependencies`, keeping the existing exact-version, no-caret
  convention that project-init T-03 established)
**Spec:** 8 (the server enforces authorisation and returns 403; routes validate what they are given),
29 (automated tests where mistakes cost money)
**Invariants:** 8 (routes validate input, check permissions, call a module, return)

**Do:**

1. `tasks/project-init.md` assumption 4 left the validation library to "the first task that writes a
   route with a request body". This plan's `/login`, `/register` and `/settings` form actions are
   those routes, so the decision lands here. **The decision is `zod`.** The alternative weighed was
   `valibot`; `zod` was chosen for ecosystem breadth, and nothing here needs valibot's smaller bundle,
   because in this plan validation runs only on the server.

2. Add `zod` to `dependencies` — not `devDependencies`, because server code imports it at runtime.
   Pin it exactly, with no `^` and no `~`, exactly as every other entry in this `package.json` is
   pinned. At the time this plan was written the current release was **4.6.4**; check the registry
   (`npm view zod version`) and pin whatever 4.x is current, recording the number you chose in the
   commit message.

3. Run `pnpm install`. Confirm no peer-dependency warning mentions `typescript`: this repo pins
   TypeScript at 6.0.3 deliberately, and a warning there means the pin was disturbed.

4. Write no schemas in this task. The schemas live beside the routes that use them (T-18, T-19, T-23).
   This task exists so that the decision is a separate, reviewable commit rather than a line smuggled
   into a route.

5. Validation is **server-side only** in this plan. Do not import `zod` into a `.svelte` component and
   do not add client-side validation that could disagree with the server's. The form pages
   progressively enhance, and the server is the only authority on whether a submission is valid.

**Tests:** none. Step 3 is the verification.

**Done when:** `pnpm install` succeeds with no unmet peers, `zod` appears in `dependencies` with an
exact version and no range prefix, `pnpm exec tsc --version` still prints `Version 6.0.3`, and
`pnpm check && pnpm lint` exits 0.

**Watch out:** do not let the package manager resolve `zod` to a range. A caret here would let a
minor release change validation behaviour between a developer's machine and production, and this
repo's whole dependency convention exists to prevent that.
