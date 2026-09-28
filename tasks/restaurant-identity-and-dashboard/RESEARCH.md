# Research — restaurant identity, owner authentication and the dashboard shell

Findings are evidence, not decisions. A source never silently overrides `docs/spec.md`. Every entry
carries its source and the date it was accessed. Where a source and the spec disagree, the entry says
so under `CONFLICT WITH SPEC`; where the spec is simply silent, it says `GAP`.

Several entries were produced by running code on this machine rather than by reading a document.
Those are marked **measured** and give the command, because a claim about a runtime is worth more when
it was observed than when it was read.

---

## Q: Is Node's built-in `crypto.argon2` stable on the version this repo pins, and what is its exact API?

- **Source:** `https://raw.githubusercontent.com/nodejs/node/v24.21.0/doc/api/crypto.md` and
  `https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V24.md` — both accessed
  2026-09-13. Plus **measured** on this machine, 2026-09-13, under `nvm use 24.21.0`.
- **Says:** `crypto.argon2(algorithm, parameters, callback)` and `crypto.argon2Sync(algorithm,
  parameters)` were both `added: v24.7.0`. Parameters are `message`, `nonce` ("must be at least 8
  bytes long. This is the salt"), `parallelism`, `tagLength`, `memory` ("memory cost in 1KiB blocks"),
  `passes`, and the optional `secret` ("known as pepper") and `associatedData`. The documentation
  recommends "a nonce is random and at least 16 bytes long". **Neither section carries a Stability
  marker** in the v24.21.0 documentation source, while other sections in the same file carry
  `> Stability: 1.1 - Active development`. The changelog records
  `doc,crypto: mark argon2 and encap/decap as stable` landing in **24.19.0 (2026-08-03)**, which
  precedes the pinned 24.21.0 (2026-09-08).
- **Measured:** `typeof require('node:crypto').argon2 === 'function'`; argon2id at `memory: 19456,
  passes: 2, parallelism: 1, tagLength: 32` with a 16-byte nonce completed in **~43 ms** and printed
  no `ExperimentalWarning`. OpenSSL reports 3.5.8.
- **Affects the plan:** T-10 uses the built-in, with no hashing dependency. T-10 also raises
  `engines.node` to `>=24.21.0 <25.0.0`, because the current floor of `>=24.0.0` admits versions
  before v24.7.0 where the function does not exist — and there the failure appears only at the first
  registration, after install, build and every non-hashing test have passed.
- **Contradicted source, recorded deliberately:** `node_modules/@types/node/crypto.d.ts` still tags
  the function `@experimental` alongside `@since v24.7.0`. That is a stale type annotation, not the
  runtime contract; the changelog and the absence of a Stability marker in the runtime's own
  documentation govern. T-10 nonetheless pins a fixed PHC test vector so any future backend change
  must prove it can still verify existing hashes.
- Not a spec matter: `docs/spec.md` names "Argon2 or bcrypt" and no version of anything.

## Q: What argon2id parameters should a password hash use?

- **Source:** OWASP Password Storage Cheat Sheet,
  `https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html` — accessed
  2026-09-13.
- **Says:** "Use Argon2id with a minimum configuration of 19 MiB of memory, an iteration count of 2,
  and 1 degree of parallelism." Several equivalent-security configurations are given, from
  "m=47104 (46 MiB), t=1, p=1" to "m=7168 (7 MiB), t=5, p=1". Where Argon2id is unavailable the order
  of preference is scrypt, then bcrypt for legacy systems, then PBKDF2 for FIPS-140. bcrypt's 72-byte
  input limit and the dangers of pre-hashing are discussed; neither applies to Argon2id.
- **Affects the plan:** T-10 uses `memory: 19456` (19 MiB in 1 KiB blocks), `passes: 2`,
  `parallelism: 1`, `tagLength: 32`, with a 16-byte random salt. The PHC string records those
  parameters, so `needsRehash` can raise them later without invalidating stored hashes.
- **Deliberately not used:** the optional `secret` parameter, which is a pepper. A pepper must be
  stored outside the database to be worth anything, and this deployment has no second secret store;
  adding one is an operational decision, not a hashing one.

## Q: What is a sound cookie-session design without an auth library?

- **Source:** Lucia's session guide for Drizzle ORM,
  `https://lucia-next.pages.dev/sessions/basic-api/drizzle-orm` — accessed 2026-09-13.
- **Says:** generate a random token client-side of the database and store only its hash:
  `const sessionId = encodeHexLowerCase(sha256(new TextEncoder().encode(token)))`. The reference
  implementation uses 20 random bytes base32-encoded for the token, a 30-day expiry
  (`Date.now() + 1000 * 60 * 60 * 24 * 30`), and slides it when fewer than 15 days remain
  (`if (Date.now() >= session.expiresAt.getTime() - 1000 * 60 * 60 * 24 * 15)`), deleting the row when
  it has expired. The session table holds `id` (the hash), `userId` and `expiresAt`.
- **Affects the plan:** T-12 follows this shape, with 32 random bytes rather than 20 and base64url
  encoding. The 30-day lifetime and the 15-day slide threshold are adopted as written. `sessions.id`
  is the hex SHA-256 of the token, so a database leak yields hashes rather than usable sessions.
- **Deviation, stated:** T-12 additionally returns `null` when the user is inactive, and returns a
  narrow `Principal` rather than the whole user row. Both are matcami requirements — the first so
  deactivating an employee takes effect on the next request, the second so a hash cannot reach the
  page payload.
- Not a spec matter: spec 9 requires cookie sessions with HttpOnly, Secure and SameSite and forbids
  `localStorage`; it prescribes no token format.

## Q: What are SvelteKit's actual cookie, redirect and route-id behaviours in the installed version?

- **Source:** the installed `@sveltejs/kit` 2.70.3 in `node_modules`, read directly — 2026-09-13.
  Configuration reference `https://svelte.dev/docs/kit/configuration` — accessed 2026-09-12 (recorded
  in `tasks/project-init.md` and re-used here).
- **Says, measured in the source:**
  - `src/runtime/server/cookie.js` lines 63 to 65 set the defaults `httpOnly: true`,
    `sameSite: 'lax'`, and `secure: url.hostname === 'localhost' && url.protocol === 'http:' ? false
    : true`.
  - `src/exports/index.js` `redirect(status, location)` throws a `Redirect` carrying
    `location.toString()` with no validation of any kind.
  - the generated `.svelte-kit/types` tree contains route ids `"/(dashboard)"` and `"/(pos)"`, so
    group names are part of `event.route.id`.
  - `sequence` is exported from `@sveltejs/kit/hooks`.
  - `csrf.checkOrigin` defaults to `true`, is deprecated in favour of `trustedOrigins`, and CSRF
    protection "only function[s] in production environments, not during local development".
- **Affects the plan:** T-12 relies on the cookie defaults rather than setting them by hand, so a
  future SvelteKit change to a safer default is inherited. T-18 must validate `?next` itself, because
  `redirect()` will forward anything. T-17's guard can test `event.route.id.startsWith('/(dashboard)')`.
  T-24 runs against the production build, because the origin check is inert under the dev server.
- **Operational consequence:** on a plain-HTTP LAN address the session cookie is `Secure` and the
  browser discards it, producing a silent endless login loop. T-26 documents HTTPS-only, including for
  a LAN trial.

## Q: How does adapter-node determine the client address and the origin behind a proxy?

- **Source:** the installed `@sveltejs/adapter-node` 5.5.7, `files/handler.js`, read directly —
  2026-09-13.
- **Says:** the handler reads `ORIGIN` (parsed and validated at startup), `XFF_DEPTH` (default `'1'`),
  `ADDRESS_HEADER` (default `''`), `PROTOCOL_HEADER` and `HOST_HEADER`. With `ADDRESS_HEADER` unset,
  `getClientAddress()` returns the socket peer address. With `ORIGIN` unset, the request origin is
  derived from the `Host` header.
- **Affects the plan:** T-26 puts `ORIGIN`, `ADDRESS_HEADER=x-forwarded-for` and `XFF_DEPTH=1` in
  `.env.example` with the matching Nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
  in `docs/deployment.md`, and `env.ts` refuses to start in production without a valid `ORIGIN`.
  Without these, every audit row's `ip` is the proxy's address — which makes invariant 10's audit
  trail unable to identify who attacked an account — and every login form post can return
  `403 Cross-site POST form submissions are forbidden`.
- **GAP — for the user:** `docs/spec.md` section 29 says deployment is "Docker + Nginx, HTTPS only"
  and section 9 says the origin check stays enabled, but the spec nowhere states the proxy header
  configuration those two together require. This plan proposes the three variables above. Nothing in
  the spec contradicts them; it is silent.

## Q: How does Drizzle behave on a thrown error inside a transaction, and does it set any session variable?

- **Source:** the installed `drizzle-orm` 0.45.2, `node-postgres/session.js` and
  `pg-core/dialect.js`, read directly — 2026-09-13.
- **Says:** `transaction()` wraps the callback in `begin` / `commit`, and its `catch` branch issues
  `rollback` and rethrows. The migrator path executes a migration run's statements inside one
  transaction and sets no session variable of any kind.
- **Affects the plan:** T-13 and T-14 return discriminated result objects and commit on every branch.
  Signalling a failed login by throwing would roll back the very rows the failure was meant to write,
  so `failed_password_count` would never increment and no `login.failed` audit row would ever exist —
  while every unit test of the hash comparison still passed.
- **Affects a later plan:** the migrator setting no session variable is why row-level security, if it
  is ever added, must not depend on a tenant variable being set during migrations.

## Q: Does the installed Drizzle support row-level security, and what does PostgreSQL require to make it apply to the app?

- **Source:** the installed `drizzle-orm` 0.45.2 (`pg-core/policies.d.ts` exports `pgPolicy`;
  `pg-core/table.d.ts` exposes `enableRLS()`), read directly — 2026-09-13. Drizzle documentation
  `https://orm.drizzle.team/docs/rls` — accessed 2026-09-13. PostgreSQL 16 documentation
  `https://www.postgresql.org/docs/16/ddl-rowsecurity.html` — accessed 2026-09-13.
- **Says:** Drizzle can declare policies and drizzle-kit emits `CREATE POLICY` and
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; the documentation does not mention
  `FORCE ROW LEVEL SECURITY`. PostgreSQL: "Superusers and roles with the `BYPASSRLS` attribute always
  bypass the row security system when accessing a table. Table owners normally bypass row security as
  well, though a table owner can choose to be subject to row security with `ALTER TABLE ... FORCE ROW
  LEVEL SECURITY`." And: "If no policy exists for the table, a default-deny policy is used, meaning
  that no rows are visible or can be modified."
- **Affects the plan:** T-02 splits the database roles now, so the runtime role is **not** the table
  owner. That means policies added later apply to the application automatically, with no `FORCE` and
  no bootstrap rewrite. It also avoids the failure the risk panel rated a blocker: with `FORCE` on
  tables owned by the role that runs `pg_dump`, the dump fails, and `pnpm db:migrate` chains
  `pnpm db:backup`, so the whole migration pipeline stops.
- **Deferred, deliberately:** no policy is created by this plan. Whoever adds them must first decide
  which tables are **resolvers** — `users` looked up by email, `sessions` looked up by token hash, and
  the future `pos_devices` looked up by cookie hash are all read before any tenant is known, so they
  cannot be filtered by a tenant variable that is not yet set.
- Not a spec matter: `docs/spec.md` never mentions row-level security.

## Q: Does the connection pool reset session state between checkouts?

- **Source:** the installed `pg-pool`, `index.js`, read directly — 2026-09-13.
- **Says:** no `DISCARD` and no `RESET` appears anywhere in the file. A connection returned to the
  pool keeps whatever session state was set on it.
- **Affects the plan:** T-14 uses `pg_advisory_xact_lock`, which releases at transaction end, and not
  `pg_advisory_lock`, which is session-scoped and would leak a held lock onto whoever checks that
  connection out next. The same fact is why any future tenant variable must be set with `SET LOCAL`
  inside a transaction rather than with a plain `SET`.

## Q: Is `Intl.supportedValuesOf('timeZone')` a safe validator for an IANA time zone? — **measured**

- **Source:** run on this machine on the pinned Node 24.21.0, 2026-09-13:
  `node -e "const z=new Set(Intl.supportedValuesOf('timeZone')); ..."`
- **Says:** the list holds **418** entries. It does **not** contain `UTC`, `Etc/UTC`, `Asia/Kolkata`,
  `Europe/Kyiv` or `America/Argentina/Buenos_Aires`. It does contain `Asia/Calcutta`, `Europe/Kiev`
  and `America/Buenos_Aires`. `new Intl.DateTimeFormat('en', { timeZone: t })` accepts **every** one
  of those names and resolves the aliases to the canonical spelling the list carries.
- **Affects the plan:** T-16 validates by constructing a formatter and catching `RangeError`, then
  stores `resolvedOptions().timeZone`. A list-membership check would tell an owner in Kyiv or Kolkata
  that their own time zone is invalid, reject a test fixture using `UTC`, and — worse — could start
  rejecting a **stored** value after a Node or ICU update changed which alias is canonical, at a
  moment when the owner was only renaming the restaurant.
- Relevant because spec 17 says "the restaurant's time zone is a setting" and invariant 11 makes the
  business date depend on it.

## Q: Which validation library, and at what version?

- **Source:** npm registry via `npm view` — accessed 2026-09-13.
- **Says:** `zod` 4.6.4, `valibot` 1.5.0. (Also checked and not adopted: `@node-rs/argon2` 2.2.1,
  `hash-wasm` 4.12.0, `@oslojs/crypto` 1.0.1, `@oslojs/encoding` 1.1.0.)
- **Affects the plan:** T-03 installs `zod`, pinned exactly, answering the question
  `tasks/project-init.md` assumption 4 left to "the first task that writes a route with a request
  body". `valibot` was the alternative; its advantage is bundle size, which does not apply because
  validation in this plan runs only on the server. `@node-rs/argon2` and `hash-wasm` were candidates
  only if the built-in argon2 had proved unusable, which it did not.
- **Two lookups disagreed, recorded rather than reconciled:** an earlier `npm view zod version` on the
  same day returned **4.6.2**, a later one returned **4.6.4**. Either a release landed between them or
  one hit a stale cache. This is exactly why T-03 does not simply copy a number from this document.
- **Re-check before pinning:** these numbers were current on 2026-09-13. T-03 says to read the
  registry again and record the version actually pinned.

## Q: What does the POS eventually need from the tables this plan creates?

- **Source:** `docs/spec.md` sections 4 and 6 — read 2026-09-13.
- **Says:** section 4 lists what the POS caches in IndexedDB, including "Restaurant settings" and the
  "Employee list for PIN login". Section 6 says "Switching employees offline uses PIN hashes cached on
  the registered device (slow, salted hashes, refreshed on each sync)" and "Offline logins are
  recorded locally and synced to the audit log".
- **Affects the plan:** three seams, all of them cheap now and expensive later.
  - `users` will be snapshot data, so its shape matters: T-04 omits `pin_hash` entirely, because the
    POS must verify PINs **in the browser** and may therefore need an algorithm available in WebCrypto
    or WASM rather than the server-side argon2id parameters T-10 uses. A column added now would
    hard-code the wrong assumption into the first migration.
  - the lockout counters are named `failed_password_count` and `password_locked_until` so the PIN plan
    adds its own pair. Sharing them would let five wrong PINs typed by a waiter lock the owner out of
    the dashboard.
  - `audit_log` gets an `occurred_at` column separate from `created_at`, so a device-time event synced
    hours later keeps its real time. T-05 records that the sync plan must also add `device_id` and a
    client operation id with a partial unique index **before** the first device-sourced row exists,
    since the append-only trigger blocks `UPDATE` and `DELETE` but not `ALTER TABLE`.
- No conflict: the spec is being anticipated, not contradicted.

---

## Open questions this plan does NOT answer

Recorded here so a later session does not mistake silence for a decision.

- **Which tables are resolvers under row-level security.** Needed before any policy is written. See
  the Drizzle and PostgreSQL entry above.
- **The PIN hash algorithm and parameters.** Constrained by spec 6's offline browser verification.
  Belongs to the POS authentication plan.
- **Tax mode, tax rate, currency, rounding, approval limits and idle-lock timing.** Open decisions 3,
  4 and 6. `restaurant_settings` deliberately has no column for any of them, and when they arrive they
  must land nullable with completeness gating, never with a column `DEFAULT`.
- **Where the money module lives.** `tasks/project-init.md` assumption 3 records the conflict between
  CLAUDE.md invariant 1 and spec 17. This plan writes no money code.
- **Whether the owner's dashboard session should be forcibly ended when a device is registered on that
  browser.** Spec 7 has the owner log in on the POS tablet to register it. T-12 records the
  constraint; the device plan decides.
