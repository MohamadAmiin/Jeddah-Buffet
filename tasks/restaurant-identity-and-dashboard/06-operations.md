# Phase 5 — Cross-layer tests, operations and documentation

The end-to-end journey, the two operator scripts that keep an owner from ever being locked out with
no recourse, and the documentation this plan owes.

**Depends on:** Phase 4 (T-19, T-22 and T-23 for the journey; T-13 and T-14 for the scripts).

Read `00-overview.md` first for the requirements, assumptions and the file-tag convention.

---

### T-24 — End-to-end auth journey

**Needs:** T-19, T-22, T-23
**Files:**
- `e2e/auth.spec.ts` — NEW
**Spec:** 29 (automated tests where mistakes cost money), 7 (the owner logs in with email and password
and enters the management dashboard), 9 (cookie sessions)
**Invariants:** 8 (server-side authorisation), 12 (cookie sessions, never `localStorage`)

**Do:**

1. Run against the **production build**, never the dev server. project-init T-09's
   `playwright.config.ts` already starts `pnpm build && pnpm preview`. That matters beyond
   convenience: SvelteKit's origin check is inert under `vite dev`, so a dev-server end-to-end test
   proves nothing about the CSRF behaviour invariant 12 depends on, and service workers — which the
   POS will need — do not exist there either.

2. The database must be in a known state for each run. Point the preview server at the test database
   and reset it with T-08's `resetDb()` before the spec, or give this spec its own database; do not
   run it against development data, because the first step of the journey only works when zero
   restaurants exist. State in the file which approach you chose and why.

3. Walk the whole journey in one spec, in order, because each step depends on the last:
   - visit `/register`, which is reachable because no restaurant exists;
   - submit the form with a valid setup token; land on `/dashboard`;
   - the page shows the restaurant name and the onboarding checklist, with the settings step done;
   - visit `/settings`, change the restaurant name, save, and see the new name in the header;
   - submit the logout form; land on `/login`;
   - visit `/dashboard`; be redirected to `/login` with a `next` parameter;
   - log in with the same credentials; land on `/dashboard`, not on the login page again;
   - visit `/register` again; receive a 404.

4. Assert one negative case in the browser, because it is the one thing only a real browser can
   confirm: after logging in, `localStorage` and `sessionStorage` contain no session value. Invariant
   12 forbids putting the token there, and a browser-level assertion is the only check that catches a
   future "convenience" addition.

5. Assert the session cookie's flags from the response: `HttpOnly` is set, `SameSite` is `Lax`, and
   `Path` is `/`. On `http://localhost` the `Secure` flag is deliberately absent — SvelteKit omits it
   only for that origin — so assert its presence conditionally rather than asserting it is always
   there, and leave a comment saying that production must be HTTPS.

6. Keep the spec free of database queries. It is a user-journey test; the row-level evidence belongs
   to the integration tests in Phases 1 to 3.

**Tests:** this file is the test. It is not a substitute for T-20's guard walk, which covers routes
this journey never visits.

**Done when:** `pnpm test:e2e` passes from a clean database, and passes again on a second run without
manual cleanup.

**Watch out:** the journey is order-dependent by nature, so write it as one test with sequential
steps rather than several tests that share state through the database. Independent tests that
secretly depend on execution order are the flakiest thing a suite can contain.

---

### T-25 — Operator scripts: reset the owner password, create a restaurant

**Needs:** T-13, T-14
**Files:**
- `scripts/reset-owner-password.ts` — NEW
- `scripts/create-restaurant.ts` — NEW
- `package.json` — EDIT (add two script entries beside the existing `db:*` ones)
**Spec:** 3 (sensitive actions are audit-logged), 29 (operations), 7 (the owner uses email and
password)
**Invariants:** 2 (never repair by hand-editing a record), 10 (credential changes are sensitive
actions and are audit-logged in the same transaction), 12 (passwords stored only as slow salted
hashes)

**Do:**

1. Understand what these prevent. There is exactly one owner account per restaurant, employees have no
   password, and this plan ships no self-service reset flow. So a forgotten password, or an attacker
   keeping the account locked, leaves the dashboard unreachable — and the only remedy anyone would
   reach for is `UPDATE users SET password_hash = '...'` typed by whoever holds the database URL. That
   is a credential change with no audit row, no session invalidation, and a hash string produced
   outside the application that may not parse. Both scripts exist so the sanctioned path is easier
   than the unsanctioned one.

2. `scripts/reset-owner-password.ts`:
   - connects using `DATABASE_URL` through the existing database client;
   - takes the owner's email as an argument and prompts for the new password without echoing it;
   - hashes through `src/lib/server/auth/password.ts`, so the parameters and PHC format match
     everything else;
   - in **one transaction**: writes the new hash, clears `failed_password_count` and
     `password_locked_until`, calls `invalidateAllForUser`, and writes a
     `user.password_reset_by_operator` audit row with `actorUserId: null`, `subjectUserId` set to the
     owner, and `details: { via: 'cli' }`;
   - prints what it did, and never prints the password or the hash.

3. `scripts/create-restaurant.ts`:
   - prompts for restaurant name, time zone, owner display name, email and password;
   - calls the **same** `registerRestaurant` function the web route calls, so the restaurant, its
     settings row, its owner and its audit rows are created by one code path with one set of rules;
   - bypasses only the setup-token gate, because the caller already holds the database credentials,
     and states that in its own help text;
   - is the **only** way to add a second restaurant. There is no environment variable that re-opens
     `/register`, deliberately: a flag that re-exposes an unauthenticated account-creating endpoint is
     one forgotten variable away from public signup with none of the guards public signup needs.

4. Neither script deletes anything. Deactivating a user is `is_active = false`, which T-12's session
   validation already honours on the next request; removing a restaurant is not an operation this
   system supports, because audit rows reference it under `ON DELETE RESTRICT` and cannot be removed.

5. Add to `package.json`:
   `"auth:reset-owner": "node --experimental-strip-types scripts/reset-owner-password.ts"` and
   `"restaurant:create": "node --experimental-strip-types scripts/create-restaurant.ts"`. Check how
   the repo's other scripts are invoked and match that style; if TypeScript execution needs a
   different runner here, use whatever `pnpm` scripts already prove works in this repo rather than
   introducing a new one.

6. Both scripts must refuse to run against a database whose name does not match the environment the
   operator thinks they are in. At minimum, print the host and database name and require a typed
   confirmation before writing.

**Tests:**
- integration: the reset script's core function writes the new hash, clears the lock, removes every
  session for that user, and writes exactly one audit row — all of which roll back together if the
  audit write fails;
- integration: `create-restaurant`'s core function creates a second restaurant while one already
  exists, and the two restaurants' owners cannot read each other's settings.

Extract the logic of each script into a function the test can call, leaving the file itself as
argument parsing and prompting. A script whose behaviour lives only in its top-level body is a script
that cannot be tested.

**Done when:** both scripts run end to end against the development database; the reset script leaves
exactly one audit row and zero sessions for that user; the create script produces a working second
restaurant whose owner can log in; and neither script prints a password or a hash.

**Watch out:** read the password from a prompt, never from a command-line argument. An argument lands
in the shell history and in the process list, where any other user on the machine can read it.

---

### T-26 — Environment, deploy notes and the CLAUDE.md updates

**Needs:** every task above
**Files:**
- `.env.example` — EDIT (created by project-init T-06; add the variables below)
- `src/lib/server/env.ts` — EDIT (created by project-init T-06; add the production assertions)
- `docs/deployment.md` — NEW
- `CLAUDE.md` — EDIT (three specific sections; see step 5)
- `README.md` — EDIT (created by project-init T-10 if it has run; add the first-run section)
**Spec:** 29 (operations: deployment is Docker and Nginx, HTTPS only; backups before migrations), 9
(SvelteKit's origin check stays enabled), 32 (deployment is Docker plus Nginx), 33 (open decision 2:
cloud hosting)
**Invariants:** 10 (the audit log must be able to identify who acted), 12 (cookies are Secure; the
origin check is never disabled)

**Do:**

1. Add to `.env.example`, each with a comment saying what breaks without it:

   ```
   # The public origin, e.g. https://pos.example.com. adapter-node needs it for
   # SvelteKit's CSRF origin check behind a proxy. NEVER disable the check instead.
   ORIGIN=

   # Behind Nginx, without these every audit row records 127.0.0.1 and the login
   # throttle treats all visitors as one client.
   ADDRESS_HEADER=x-forwarded-for
   XFF_DEPTH=1

   # One-time secret that opens /register while no restaurant exists. Unset it
   # after the owner has registered.
   SETUP_TOKEN=
   ```

   Do not put a working value in `ORIGIN` in the committed example. project-init T-06 set it to
   `http://localhost:3000`; change it to empty with the comment above, because an operator who copies
   the example unchanged to production gets `403 Cross-site POST form submissions are forbidden` on
   every login, and the tempting fix is the one invariant 12 forbids.

   Still do not add `TAX_MODE`, `TAX_RATE`, `CURRENCY` or any time-zone variable. Those are restaurant
   settings behind open decisions 3 and 4.

2. In `env.ts`, add assertions that run at startup:
   - in production, `ORIGIN` must be set, must be `https:`, and must not be `localhost` — throw a
     message naming the variable;
   - in production, warn loudly when `ADDRESS_HEADER` is unset, because the audit log's `ip` column
     and the throttle both silently degrade to the proxy's address;
   - keep T-10's assertion that `crypto.argon2` is a function;
   - keep T-14's boot warning about `SETUP_TOKEN` while registration is open.

3. Write `docs/deployment.md` covering, in this order:

   - **HTTPS only, everywhere, including a LAN trial.** SvelteKit marks the session cookie `Secure`
     for every origin except `http://localhost`, and browsers discard a `Secure` cookie delivered over
     plain HTTP from any other host. On `http://192.168.1.10:3000` the result is an endless login
     loop: the login succeeds, the cookie is dropped, the guard sees no session, back to `/login`,
     with nothing logged anywhere. Test locally on `localhost` or through a port-forward; never add an
     HTTP exception to the cookie.
   - **Nginx configuration**: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` so
     `XFF_DEPTH=1` is correct, plus `limit_req_zone` and `limit_conn` on `/login` and `/register`.
     Note that the application's in-memory throttle from T-13 is a backstop: it is process-local, it
     resets on restart, and the edge is where real rate limiting belongs.
   - **First run**: set `SETUP_TOKEN`, deploy, register the owner immediately, then unset the token
     and restart. Say plainly why the window matters: a new host's TLS certificate appears in
     Certificate Transparency logs within minutes, scanners follow, and until the owner registers the
     endpoint that creates the owner account is reachable.
   - **Migrations in production**: `drizzle-kit` is a dev dependency, so an image built with
     `pnpm install --prod` cannot run `pnpm db:migrate`. Take the pre-migration `pg_dump` on the
     database host as the owner role, into storage that is not the container's filesystem, and apply
     migrations with a small runner using `drizzle-orm/node-postgres/migrator` — the same runtime
     migrator T-08 uses for the test database. `backups/` inside a container is ephemeral and is not
     a backup.
   - **The two database roles**: `matcami` owns the tables and is used for migrations, `pg_dump` and
     `db:studio`; `matcami_app` is the runtime role and owns nothing. Record that this split is what
     makes row-level security a later migration rather than a re-bootstrap, and that nobody should
     "simplify" the deployment by pointing the application at the owner role.
   - **`db:studio` is a row editor over the live database.** Never edit a posted record with it. When
     that matters — paid orders, invoices, payments, stock movements, journal entries — the correction
     is a reversing record, never an `UPDATE` (invariant 2). Audit rows cannot be edited at all; the
     database refuses.

4. In `README.md`, add a short first-run section: run the bootstrap with both passwords, fill `.env`
   with all four connection and origin variables, set `SETUP_TOKEN`, run `pnpm db:migrate`, start the
   app, visit `/register`. Point at `docs/deployment.md` for production. If project-init T-10 has not
   run and `README.md` is still the scaffolder's default, write this section anyway and say in the
   commit that T-10 will rewrite the rest.

5. Edit **exactly three things** in `CLAUDE.md`, and nothing else. Do not touch the twelve invariants,
   the glossary, the do-not-build list or the open-decisions table:

   - **"Where code lives"**: add `restaurants/` to the `lib/server/` list with a one-line description
     ("restaurant record, settings, and the onRestaurantCreated initializer list"), and add the three
     new top-level routes — `login/`, `register/`, `logout/` — to the `routes/` block, noting they sit
     outside the route groups because they must be reachable without a session.
   - **The house convention paragraph**: record that `restaurants/` is called by `orders/`-style
     modules and by routes, and calls only `audit/`.
   - **A new short subsection recording the decisions this plan made**, placed near the open-decisions
     section but clearly separate from it, listing: validation library is `zod`; the dashboard
     permission keys `admin.*` are a plan-level extension, not spec 8 text; password login lockout is
     a house rule adapted from spec 7's PIN rule and is paired with a per-IP throttle;
     registration is first-run plus `SETUP_TOKEN`, with additional restaurants created by
     `pnpm restaurant:create`; the database has two roles and why.

   Do **not** amend the do-not-build list. The hybrid this plan builds does not contradict it: spec 1
   requires the architecture be structured so multi-tenant support can be added later, which is what
   `restaurant_id` on every table and the role split provide. Nothing here builds multiple tenants,
   multiple branches, multiple terminals or a SaaS signup.

   Do **not** delete or rewrite the open-decisions rows for tax rules, payment methods or approval
   limits. This plan deliberately left all three unanswered, and the settings table has no column for
   any of them.

6. Verify every command you documented by running it.

**Tests:** step 6 is the verification. Add one unit test for the `env.ts` production assertions: with
`NODE_ENV=production` and `ORIGIN` unset, the module throws and the message names `ORIGIN`.

**Done when:** `.env.example` contains the four new variables with their comments and no working
credential; `env.ts` refuses to start in production without a valid `ORIGIN`; `docs/deployment.md`
exists and covers all six topics; `git diff CLAUDE.md` shows changes confined to the three sections in
step 5; and every documented command has been run successfully in this repo.

**Watch out:** CLAUDE.md is the first file every future session reads, so an inaccuracy left here
misleads every later task. Resist improving anything beyond the three sections — in particular, do
not amend invariant 1's money-module path, which `tasks/project-init.md` assumption 3 reserves for the
first money task, and which this plan has no standing to decide.
