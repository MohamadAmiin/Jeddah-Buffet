# Phase 2 — Domain modules

All business rules live in `src/lib/server/**`. Routes validate input, check permissions, call a
module and return. Every function in this phase that writes to the database takes a transaction
handle as its first parameter and never opens its own — the habit invariant 4 will depend on at
payment starts here, where it is cheap.

**Depends on:** Phase 1 (T-04 and T-05 for the tables, T-08 for the test harness).

Read `00-overview.md` first for the requirements, assumptions and the file-tag convention.

**Rules that bind every task in this phase:**

- Nothing here may be imported by `src/lib/pos/` or by any client-side code. SvelteKit build-blocks
  `$lib/server/**` from the browser, and `eslint.config.js` enforces the rest.
- Every function that touches tenant data takes `restaurantId` as an explicit parameter and filters
  by it. There is no ambient tenant. This is what makes the schema's `restaurant_id` columns load
  bearing rather than decorative.
- Audit rows are written **inside the same transaction as the action they record** (invariant 10).
- No module in this phase does money arithmetic, writes a journal entry, or touches stock.

---

### T-10 — `auth/password.ts` — argon2id in PHC format

**Needs:** T-01
**Files:**
- `src/lib/server/auth/password.ts` — NEW
- `src/lib/server/auth/password.test.ts` — NEW
- `package.json` — EDIT (raise the `engines.node` floor; see step 7)
- `src/lib/server/env.ts` — EDIT (created by project-init T-06; add the boot assertion from step 7)
**Spec:** 7 ("PINs are 4–6 digits, stored only as slow salted hashes (e.g. Argon2 or bcrypt)" — the
same standard applies to the owner's password), 32 (authentication is secure HttpOnly cookies)
**Invariants:** 12 (stored ONLY as slow salted hashes, never reversible, never logged)

**Do:**

1. Use Node's built-in `crypto.argon2`. It needs no dependency, no native build step and no prebuilt
   binary. On the pinned Node 24.21.0 with OpenSSL 3.5.8 it produced a 32-byte tag in about 43 ms at
   the parameters below. Node marked the API stable in 24.19.0; the `@types/node` JSDoc still carries
   an `@experimental` tag, which is a stale annotation rather than the runtime contract.

2. Export `hashPassword(password: string): Promise<string>`:
   - generate a 16-byte random salt with `randomBytes(16)`;
   - call the **asynchronous** `argon2('argon2id', { message, nonce: salt, parallelism: 1,
     tagLength: 32, memory: 19456, passes: 2 })`, promisified;
   - return a PHC string: `$argon2id$v=19$m=19456,t=2,p=1$<salt-b64>$<hash-b64>` where both encodings
     are standard base64 **without** padding, as the PHC specification requires.

   The parameters are OWASP's baseline recommendation for argon2id: at least 19 MiB of memory, two
   iterations and one degree of parallelism. `memory` is counted in 1 KiB blocks, so 19456 is 19 MiB.

   Use `argon2`, never `argon2Sync`. The synchronous form blocks the event loop for the whole 43 ms,
   which on a public login endpoint is a denial-of-service primitive rather than a performance note.

3. Export `verifyPassword(phc: string, password: string): Promise<boolean>`:
   - parse the PHC string and reject anything malformed by returning `false`, never by throwing a
     message that quotes the input;
   - re-derive with the parameters **read from the string**, not with the constants, so that a hash
     produced under older parameters still verifies;
   - compare with `crypto.timingSafeEqual` on equal-length buffers; if the lengths differ, return
     `false` without calling it, because it throws on a length mismatch.

4. Export `needsRehash(phc: string): boolean`, true when the stored parameters are weaker than the
   current constants. T-13 calls it after a successful verify and re-hashes in the same transaction.
   This is what makes raising the cost factor later a no-downtime change.

5. Export a maximum length constant and enforce it in `hashPassword`: reject passwords longer than
   1024 bytes. Argon2 has no short input limit the way bcrypt does, but an unbounded input is an
   unbounded amount of hashing work triggered by an anonymous request.

6. **Never log, return, or embed a password or a hash.** No `console.log` of either, not truncated,
   not in a thrown error's message. A parse failure returns `false`; it does not explain what was
   wrong with the string.

7. Two guards so a wrong runtime fails loudly rather than at the owner's first login:
   - In `package.json`, raise `engines.node` from `>=24.0.0 <25.0.0` to `>=24.21.0 <25.0.0`.
     `crypto.argon2` first shipped in **v24.7.0**, so the current floor admits versions where this
     module throws `TypeError: crypto.argon2 is not a function` — after `pnpm install`, `pnpm build`
     and every non-hashing test have passed.
   - In `src/lib/server/env.ts`, add an assertion at module load that
     `typeof crypto.argon2 === 'function'`, throwing a message that names the required Node version.

8. Write `password.test.ts` covering:
   - a round trip: hash then verify returns `true`;
   - a wrong password returns `false`;
   - two hashes of the same password differ (the salt is random);
   - a malformed PHC string returns `false` and does not throw;
   - a PHC string with lower parameters still verifies, and `needsRehash` returns `true` for it;
   - **a fixed, checked-in PHC vector verifies.** Generate one once with these exact parameters,
     paste it into the test as a literal, and assert `verifyPassword(vector, 'correct horse battery
     staple')` is `true`. This is the test that makes any future backend swap — to `@node-rs/argon2`
     or anything else — prove interoperability with hashes already in the database, instead of
     silently rejecting every existing owner.

**Tests:** the file above. None of these is one of spec 29's six mandatory areas, but the fixed vector
is mandatory in this plan's own terms: without it, a hashing change is an untestable migration of
credentials nobody can recover.

**Done when:** `pnpm test src/lib/server/auth/password.test.ts` passes including the fixed vector;
`grep -rn 'argon2Sync' src/` finds nothing; and `package.json` says `>=24.21.0 <25.0.0`.

**Watch out:** base64 in PHC strings is unpadded. Encoding with padding produces a string that other
argon2 implementations reject, which defeats the point of choosing a self-describing format. Strip
the `=` characters on the way out and restore them on the way in.

---

### T-11 — `audit/` — the typed, secret-refusing audit writer

**Needs:** T-05, T-08
**Files:**
- `src/lib/server/audit/events.ts` — NEW
- `src/lib/server/audit/index.ts` — NEW
- `src/lib/server/audit/audit.test.ts` — NEW
**Spec:** 3 ("Sensitive actions are audit-logged: logins, failed PINs, voids, refunds, discounts,
comps, approvals, cash drawer opens and price changes"), 6 (offline logins are recorded locally and
synced to the audit log), 8 (the action, the employee, the approver and the reason are stored
together)
**Invariants:** 10 (sensitive actions are audit-logged; the audit row is written in the same
transaction as the action), 12 (never log a PIN, a hash, a password or a session token)

**Do:**

1. In `events.ts`, define the event names this plan emits as a discriminated union, each with the
   exact shape of its `details` object. Nothing else may be written:

   | event | details |
   |---|---|
   | `restaurant.registered` | `{ restaurantName: string, timeZone: string }` |
   | `user.created` | `{ role: 'owner' \| 'cashier' \| 'waiter', displayName: string }` |
   | `login.success` | `{ email: string }` |
   | `login.failed` | `{ email: string, reason: 'bad_password' }` |
   | `login.locked_out` | `{ email: string, failedCount: number }` |
   | `login.rejected_locked` | `{ email: string }` |
   | `logout` | `{}` |
   | `settings.updated` | `{ changes: Record<string, { old: unknown, new: unknown }> }` |
   | `user.password_reset_by_operator` | `{ via: 'cli' }` |

   A typed union rather than `Record<string, unknown>` is the mechanism; "never put a password in
   `details`" as a comment is only a wish. Later plans extend this union; they do not widen it.

2. In `index.ts`, export `writeAudit(tx: DbTx, entry: AuditEntry): Promise<void>` where `AuditEntry`
   carries, explicitly:
   - `restaurantId: string` — **required and non-nullable.** There is no tenant-less audit row.
   - `actorUserId: string | null` — who did it. Null for an unauthenticated or operator-script event.
   - `subjectUserId: string | null` — who it was about. A failed login is about the owner whose email
     was tried, and was performed by nobody.
   - `event` and `details`, typed together by the union from step 1.
   - `ip: string | null`, `userAgent: string | null`.
   - `occurredAt?: Date` — defaults to now. It exists so the offline plan can record a device-time
     event without altering a table whose rows cannot be updated.

   It takes the transaction handle as its first parameter and **must not open its own transaction**.
   Writing the audit row in the same transaction as the action is invariant 10's house rule: either
   both commit or neither does.

3. Add a `assertNoSecrets(details)` guard that walks the object at every depth and throws if any key
   matches `/pass|pin|token|hash|secret|cookie|authorization/i`. Call it in `writeAudit` before the
   insert. The append-only trigger from T-07 means a leaked secret in `details` can never be removed
   without dropping the trigger, which would itself violate invariant 2 — so the only workable defence
   is refusing to write it.

4. Export a helper that extracts `ip` and `userAgent` from a SvelteKit `RequestEvent`, using
   `event.getClientAddress()` and the `user-agent` header. Add a comment recording that behind Nginx
   this returns the proxy's address unless `ADDRESS_HEADER` and `XFF_DEPTH` are configured, and point
   at T-26, which sets them. An audit log that records `127.0.0.1` for every event cannot identify
   who attacked an account.

5. Export nothing that reads audit rows. This plan writes them and does not display them; an
   owner-facing audit view is a later plan, and it will need its own permission key.

6. Write `audit.test.ts`:
   - a unit test that `assertNoSecrets` throws for `{ password: 'x' }`, `{ user: { pinHash: 'x' } }`
     and `{ sessionToken: 'x' }`, and passes for `{ email: 'a@b.c' }`;
   - **an integration test** that a `writeAudit` call inside a transaction that then rolls back
     leaves **no** row behind, and inside a transaction that commits leaves exactly one. That is the
     only test that actually proves invariant 10's same-transaction rule.

**Tests:** the file above. The rollback test is the important one; it is what stops a later refactor
moving `writeAudit` outside the transaction "for clarity".

**Done when:** `pnpm test` passes both projects; `writeAudit` has no code path that opens a
transaction; and passing a `details` object containing a key matching the secret pattern throws
before any SQL runs.

**Watch out:** `assertNoSecrets` must walk nested objects and arrays, not just top-level keys. The
realistic leak is not `{ password }`; it is somebody passing a whole parsed form body or a whole
database row through, where the dangerous key is one level down.

---

### T-12 — `auth/session.ts` — cookie sessions and the `Principal` projection

**Needs:** T-05, T-08
**Files:**
- `src/lib/server/auth/session.ts` — NEW
- `src/lib/server/auth/session.integration.test.ts` — NEW
**Spec:** 9 ("We agreed to use secure cookie-based sessions... HttpOnly + Secure Cookies... We do not
need to put authentication tokens in localStorage. Cookies use SameSite, and state-changing requests
keep SvelteKit's built-in origin check (CSRF protection) enabled"), 32 (authentication is secure
HttpOnly cookies)
**Invariants:** 12 (sessions are HttpOnly + Secure + SameSite cookies, NEVER `localStorage`, and
SvelteKit's origin/CSRF check stays ON), 8 (authorisation is decided server-side)

**Do:**

1. Export `generateSessionToken(): string` — 32 random bytes from `randomBytes`, encoded base64url.
   This value goes in the cookie and is never stored.

2. Export `sessionIdFromToken(token: string): string` — the lowercase hex SHA-256 of the token. This
   is what the `sessions.id` column holds. The separation matters: a database leak then yields
   hashes, not usable sessions, exactly as password hashes do.

3. Export `createSession(tx: DbTx, userId: string): Promise<{ token: string, expiresAt: Date }>` —
   generate a token, insert a row keyed by its hash with `expiresAt` 30 days out, return the raw
   token to the caller once. Takes the transaction handle so a login commits its session, its counter
   reset and its audit row together.

4. Export `validateSessionToken(token: string): Promise<Principal | null>` where

   ```ts
   type Principal = {
     userId: string
     restaurantId: string
     role: 'owner' | 'cashier' | 'waiter'
     displayName: string
     email: string | null
     sessionId: string
     expiresAt: Date
   }
   ```

   **`Principal` is the only shape that ever leaves this module**, and the query must select exactly
   those columns by name. Do not `select()` the whole `users` row and narrow it afterwards: the
   session is put into `event.locals`, the dashboard layout returns parts of it, and SvelteKit
   serialises load data into the page HTML and into `__data.json`. A `users.*` projection therefore
   publishes `password_hash`, the failure counter and the lock timestamp into the browser's cache and
   history — and when a later plan adds employees, every employee's PIN hash with it.

   The function must also:
   - return `null` and delete the row when `expiresAt` has passed;
   - return `null` when `users.is_active` is false, so deactivating an employee ends their access on
     the next request rather than in 30 days;
   - slide the expiry: when fewer than 15 days remain, set a new 30-day expiry and update
     `last_seen_at`. The caller re-sets the cookie.

5. Export `invalidateSession(tx, sessionId)` and `invalidateAllForUser(tx, userId)`. The second is
   what a password reset calls, so changing a password ends every other session.

6. Export cookie helpers `setSessionCookie(cookies, token, expiresAt)` and
   `deleteSessionCookie(cookies)`. Name the cookie something that says what it is, such as
   `matcami_dashboard_session`. Use SvelteKit's `cookies.set` **defaults** for `httpOnly`,
   `sameSite` and `secure` — verified in the installed version, they are `httpOnly: true`,
   `sameSite: 'lax'`, and `secure: true` for every origin except `http://localhost`. Set `path: '/'`.

   Do not weaken any of them, and never store the token anywhere but the cookie. `sameSite: 'lax'`
   plus SvelteKit's origin check, which `svelte.config.js` deliberately leaves at its default, is the
   CSRF story; there is no token field in any form in this plan.

7. Add a comment recording two constraints the POS plans inherit, because this module is where they
   will be tempted to shortcut:
   - `Principal` is the **dashboard** principal. POS and sync routes must resolve their tenant from
     the registered device row and their actor from the queued operation, never from this cookie.
   - the sliding refresh belongs on dashboard requests only (T-17 calls it there), so an owner's
     cookie left on a counter tablet cannot renew itself indefinitely through POS traffic.

8. Delete expired sessions opportunistically, inside `createSession`, with a bounded statement such as
   `delete from sessions where expires_at < now()`. No cron, no background job — CLAUDE.md excludes
   background jobs, and the table is small.

9. Write `session.integration.test.ts`:
   - create then validate returns the `Principal` with the right restaurant and role;
   - a token that was never issued returns `null`;
   - an expired session returns `null` **and** its row is gone afterwards;
   - a session whose user has `is_active = false` returns `null`;
   - a session with 14 days left is extended and `last_seen_at` moves; one with 20 days left is not;
   - `invalidateAllForUser` removes every session for that user and none for another user;
   - **the returned object has no key matching `/hash|password|pin|locked|failed/`** — assert over
     `Object.keys` and over `JSON.stringify`, so the test fails if someone widens the projection.

**Tests:** the file above. The projection test is the one that must never be deleted.

**Done when:** `pnpm test:integration` passes every case; `grep -n 'localStorage' src/` finds nothing;
and the session query names its columns explicitly rather than selecting a whole table.

**Watch out:** inject the clock. Take an optional `now: Date` parameter on `validateSessionToken` and
default it to the current time, and compare against that value rather than SQL `now()`. Otherwise the
expiry and sliding tests can only be written by sleeping, and the lockout tests in T-13 have the same
problem with no way to solve it.

---

### T-13 — `auth/login.ts` — lockout, throttle and the commit-on-every-branch rule

**Needs:** T-10, T-11, T-12
**Files:**
- `src/lib/server/auth/throttle.ts` — NEW
- `src/lib/server/auth/login.ts` — NEW
- `src/lib/server/auth/login.integration.test.ts` — NEW
**Spec:** 7 ("After 5 wrong attempts, the employee is locked out for 5 minutes and an audit event is
logged" — stated for PINs; see the house-rule note below), 3 (failed logins are audit-logged), 9
(cookie sessions), 29 (automated tests where mistakes cost money)
**Invariants:** 10 (logins and failed logins are audit-logged, in the same transaction as the
action), 12 (slow salted hashing; sessions are cookies)

**Do:**

1. Read this before writing code. Spec 7's five-attempt, five-minute lockout is written for **PINs
   entered on a registered POS device**. Applying it unchanged to a public email-and-password
   endpoint is this plan's **house rule**, recorded in `00-overview.md` assumption 3, and the naive
   form is a weapon: anyone who knows the owner's email can send five wrong passwords every five
   minutes and keep the only owner account locked out forever, while the audit rows all say
   `127.0.0.1`. Two changes make it safe, and both are required.

2. Write `throttle.ts`: a small in-memory per-key token bucket, with no dependency and no Redis
   (spec 28 removed Redis from the MVP). Export `consume(key: string): { ok: boolean, retryAfterMs:
   number }`. Suggested budget for login and registration: 10 attempts per IP per 10 minutes,
   refilling continuously. Keep the map bounded by evicting entries that have fully refilled.

   Record in a comment what this is and is not: it is process-local, so it resets on restart and
   would not be shared if a second Node instance were ever added, and it sees the proxy's address
   unless `ADDRESS_HEADER` is configured. T-26's deploy notes make Nginx `limit_req` the primary
   throttle; this is the in-application backstop.

3. Write `loginWithPassword(input, ctx)` in `login.ts`. It runs in **one** transaction and returns a
   discriminated result:

   ```ts
   type LoginResult =
     | { ok: true; token: string; expiresAt: Date; restaurantId: string }
     | { ok: false; reason: 'invalid' | 'locked'; retryAfterMs?: number }
   ```

4. **The transaction must COMMIT on every branch, including failure.** Never signal a failed login by
   throwing inside the transaction callback: Drizzle's node-postgres session catches any thrown error,
   issues `rollback` and rethrows — verified in the installed version. A thrown "invalid password"
   therefore rolls back the very rows the failure was supposed to write, so `failed_password_count`
   stays at zero forever, no `login.failed` audit row is ever created, and the five-attempt lockout
   silently does not exist while every unit test of `verifyPassword` passes. Return the result object;
   let the route translate it into an HTTP response after the commit.

5. Inside the transaction, in this order:
   - look the user up by `lower(email)` with `FOR UPDATE`, so two concurrent attempts cannot both
     read a count of 4 and both write 5;
   - if no user is found, or the user's role is not `owner`, or `is_active` is false: run a **dummy
     verify** against a constant PHC string so the response time matches a real failure, write **no**
     audit row, and return `{ ok: false, reason: 'invalid' }`. A tenant-less audit row has no
     restaurant to belong to and would be visible to nobody; unknown-email attempts are the
     throttle's business and the server log's, not the audit log's;
   - if `password_locked_until` is in the future: write `login.rejected_locked` and return
     `{ ok: false, reason: 'locked' }`;
   - verify the password;
   - **on failure:** increment `failed_password_count`; if it now reaches 5, set
     `password_locked_until = now + 5 minutes` **and reset the counter to 0**, and write
     `login.locked_out`; otherwise write `login.failed`. Return `{ ok: false, reason: 'invalid' }`;
   - **on success:** reset the counter and clear the lock; if `needsRehash` says so, re-hash and
     store; create the session; write `login.success`; return `{ ok: true, ... }`.

6. Resetting the counter when the lock is set is not a detail. If the counter keeps climbing, a
   condition written as `count === 5` never fires again and the account can be guessed at full speed
   forever after one warm-up cycle; a condition written as `count >= 5` re-locks on every single
   subsequent miss, which is stricter than spec 7 and locks an owner who mistypes once. Resetting
   makes five fresh misses the price of each new lock.

7. Every audit row gets `subjectUserId` set to the user whose account was targeted, and
   `actorUserId` set to that same user only on success. A failed login was performed by nobody.

8. Compare `password_locked_until` against an **injected clock** passed into the function, not SQL
   `now()`. Otherwise the "lock expires after five minutes" test cannot be written without sleeping.

9. Write `login.integration.test.ts`. These assertions check database state, not only the returned
   value, because the whole point of step 4 is that the return value can look right while nothing was
   written:
   - a correct password returns `ok: true` and leaves exactly one session row and one `login.success`
     audit row;
   - a wrong password returns `ok: false`, and `failed_password_count` is now **1** in the database,
     with exactly one `login.failed` row;
   - five wrong passwords leave `password_locked_until` in the future, the counter back at 0, four
     `login.failed` rows and one `login.locked_out` row;
   - a correct password while locked returns `reason: 'locked'`, creates **no** session, and writes
     `login.rejected_locked`;
   - with the clock advanced past the lock, one wrong attempt does **not** re-lock; five more do;
   - an unknown email returns `ok: false` and writes **zero** audit rows;
   - a `cashier` row with an email and password (inserted with the CHECK constraint temporarily
     irrelevant because the constraint forbids it — assert instead that such a row cannot be created)
     confirms the role restriction is enforced by the database, and `loginWithPassword` additionally
     refuses a non-owner;
   - the throttle refuses the eleventh attempt from one IP within the window, **before** any hashing
     happens. Assert the timing or assert that no audit row was written by the refused attempt.

**Tests:** the file above. Treat the five-failure and lock-expiry cases as mandatory in this plan's
own terms: they are the only evidence that invariant 10's audit rows and the lockout both survive a
failed login.

**Done when:** `pnpm test:integration` passes every case above, and `grep -n 'throw' src/lib/server/
auth/login.ts` shows no throw inside the transaction callback for an authentication failure.

**Watch out:** the dummy verify must use a real PHC string with the same parameters as a live hash,
generated once and stored as a module constant. A dummy that is cheaper than a real verify restores
the timing difference it exists to remove.

---

### T-14 — `auth/register.ts` — token-gated first-run registration

**Needs:** T-10, T-11, T-12, T-16
**Files:**
- `src/lib/server/auth/register.ts` — NEW
- `src/lib/server/auth/register.integration.test.ts` — NEW
- `src/lib/server/env.ts` — EDIT (created by project-init T-06; add `SETUP_TOKEN` as optional, plus
  the boot warning in step 8)
**Spec:** 7 (the Owner/Admin uses email and password and enters the management dashboard), 3
(sensitive actions are audit-logged), 17 (the restaurant's time zone is a setting)
**Invariants:** 10 (audit rows in the same transaction as the action), 11 (the time zone is a
restaurant setting, chosen by the owner, never an environment variable), 12 (slow salted hashing)

**Do:**

1. Export `isRegistrationOpen(): Promise<boolean>` — true only when `select count(*) from restaurants`
   is zero. There is no environment variable that re-opens it. Additional restaurants are created by
   `scripts/create-restaurant.ts` (T-25), which calls the same function below with no HTTP surface at
   all. An environment flag that re-opens an unauthenticated account-creating endpoint is one
   forgotten variable away from public signup with none of public signup's guards.

2. Export `registerRestaurant(input, ctx): Promise<RegisterResult>` taking `restaurantName`,
   `timeZone`, `ownerDisplayName`, `email`, `password` and `setupToken`, and returning a
   discriminated result the same way T-13 does — `{ ok: true, token, expiresAt, restaurantId }` or
   `{ ok: false, reason: 'closed' | 'bad_token' | 'email_taken' | 'invalid_time_zone' }`. Commit on
   every branch; never signal a rejection by throwing inside the transaction.

3. **The setup token is the gate.** Compare the submitted token against the `SETUP_TOKEN` environment
   variable using `timingSafeEqual` on equal-length buffers. If `SETUP_TOKEN` is unset, registration
   is **not** open regardless of the restaurant count, and the result says so, so a freshly deployed
   instance is not claimable by the first stranger who finds its hostname. The certificate for a new
   public host appears in Certificate Transparency logs within minutes of issuance; the window
   between deployment and the owner's first login is real and is scanned.

4. Inside one transaction, in this order:
   - take `pg_advisory_xact_lock(<a constant this module owns>)`, so two simultaneous submissions
     serialise;
   - **re-check `isRegistrationOpen()` inside the lock.** Checking before the lock is a
     time-of-check-to-time-of-use bug that lets two restaurants be created;
   - verify the setup token;
   - validate the time zone through `restaurants/` (T-16), which validates by construction rather
     than by list membership;
   - generate the restaurant id in application code with `crypto.randomUUID()` rather than letting
     the database default supply it. The rows that follow reference it, and a future row-level
     security `WITH CHECK` policy cannot be satisfied by an id the database has not returned yet;
   - insert the restaurant;
   - run `onRestaurantCreated(tx, restaurantId, input)` — see step 5;
   - hash the password and insert the owner: `role = 'owner'`, the given display name and email;
   - write `restaurant.registered` and `user.created` audit rows, both with the new restaurant id;
   - create the session;
   - return the token.

5. Export `onRestaurantCreated(tx, restaurantId, input)` as an **ordered list of initializer
   functions** that this module runs inside the registration transaction. Ship it with exactly one
   entry: the one that inserts the `restaurant_settings` row with the chosen time zone. The list
   exists so that a later plan — the accounting plan needing a per-restaurant chart of accounts, for
   instance — adds an idempotent entry here instead of writing a migration that cross-joins every
   existing restaurant and then silently does nothing for the next one created. Say that in a comment.

6. On a duplicate email the database's lower-case unique index raises. Catch that specific violation
   by constraint name and return `{ ok: false, reason: 'email_taken' }` — do not pre-check with a
   select, which races.

7. Run the registration attempt through the same throttle as login, keyed by IP.

8. In `env.ts`, treat `SETUP_TOKEN` as optional. Add a boot-time check: if no restaurant exists and
   `SETUP_TOKEN` is unset, log a clear warning naming the variable; if no restaurant exists and it
   **is** set, log that registration is open. An operator should never have to guess whether the
   window is open.

9. Write `register.integration.test.ts`:
   - a valid registration creates exactly one restaurant, one settings row, one owner and two audit
     rows, and returns a working session token;
   - **atomicity: forcing the audit write to fail leaves zero restaurants, zero settings rows and
     zero users.** This is the test that proves invariant 10's same-transaction rule for the most
     important write in the plan;
   - a second registration afterwards returns `reason: 'closed'`;
   - a wrong or missing setup token returns `reason: 'bad_token'` and creates nothing;
   - with `SETUP_TOKEN` unset, a correct-looking submission still returns `bad_token` or `closed` and
     creates nothing;
   - **two concurrent registrations both submitted with a valid token result in exactly one
     restaurant.** Run them as two genuinely committed transactions on two connections — this is why
     T-08 refused a rollback-per-test wrapper;
   - two concurrent registrations with the same email: exactly one succeeds, the other returns
     `email_taken`;
   - an invalid time zone returns `invalid_time_zone` and creates nothing.

**Tests:** the file above. The atomicity test and the concurrency test are both mandatory in this
plan's own terms.

**Done when:** every case in step 9 passes, and `grep -rn 'REGISTRATION_MODE' src/ .env.example`
finds nothing.

**Watch out:** `pg_advisory_xact_lock` releases at the end of the transaction, which is what you want.
Do not use `pg_advisory_lock`, which is session-scoped and, on a pooled connection, leaks a held lock
onto whoever checks that connection out next — the connection pool in use never resets session state
between checkouts.

---

### T-15 — `permissions/` — the key map and the guards

**Needs:** T-12
**Files:**
- `src/lib/server/permissions/keys.ts` — NEW
- `src/lib/server/permissions/index.ts` — NEW
- `src/lib/server/permissions/keys.test.ts` — NEW
**Spec:** 8 (User → Role → Permissions; the cashier and waiter key lists; "If a waiter tries to call an
unauthorized API directly... the server returns 403 Forbidden. So hiding buttons in the frontend is
not considered security"), 7 (the owner also has a POS PIN, used to approve sensitive actions), 31
(owner, one cashier, one waiter; Manager role is Later)
**Invariants:** 8 (permissions enforced SERVER-side on every route, reads included, returning 403)

**Do:**

1. In `keys.ts`, reproduce spec 8's keys **verbatim**, in two groups exactly as the spec lists them:
   - cashier: `pos.sell`, `pos.payment`, `pos.print_receipt`, `pos.void_unsent_item`,
     `pos.cash_payout`
   - waiter: `pos.create_order`, `pos.view_menu`, `pos.modify_order`, `pos.send_to_kitchen`,
     `pos.transfer_table`

2. Add the dashboard keys this plan needs. **Mark them clearly in the file as a plan-level extension,
   not spec text:** spec 8 introduces its list with "For example", and
   `src/lib/server/permissions/README.md` records that extending the list "is a plan's call, never
   coined mid-task". The new keys, granted to the owner only:
   `admin.settings`, `admin.menu`, `admin.inventory`, `admin.purchases`, `admin.expenses`,
   `admin.reports`, `admin.employees`, `admin.devices`.

   Only `admin.settings` is used by this plan. The rest exist so the dashboard navigation in T-21 can
   render an entry per key, and so each later plan finds its key already named rather than coining
   one mid-task.

3. Build the role-to-keys map. **The owner gets every key, enumerated explicitly**, including the POS
   keys: spec 7 gives the owner a POS PIN used to approve sensitive actions, so an owner who cannot
   hold `pos.sell` would be unable to act at the till the day the POS exists. Do not write the owner's
   grant as a wildcard; enumerate, so adding a key is a deliberate decision about who receives it.

4. In `index.ts`, export:
   - `hasPermission(principal, key): boolean` — a pure function over the map;
   - `requireUser(event)` — throws a redirect to `/login?next=<encoded current path>` when
     `locals.user` is null;
   - `requireOwner(event)` — `requireUser` plus a 403 when the role is not `owner`;
   - `requirePermission(event, key)` — `requireUser` plus a 403 when `hasPermission` is false.

   Dashboard loads and actions in this plan call `requirePermission(event, 'admin.settings')` and its
   siblings. Reserve `requireOwner` for actions that spec 7 ties to the owner **identity** rather than
   to a capability, such as registering a POS device in a later plan.

5. Every guard returns **403** for an authenticated user who lacks the capability, and a redirect for
   an anonymous one. Do not return 404 to "hide" the route; spec 8 names 403 explicitly.

6. These guards read `event.locals`, which T-17's hook populates. They do not query the database.
   Keep them synchronous and cheap so that calling one in every load and every action costs nothing
   and nobody is tempted to skip it.

7. Write `keys.test.ts`:
   - the cashier list equals spec 8's five keys exactly, and the waiter list equals its five exactly —
     write the expected arrays as literals copied from the spec, so a drift is a test failure rather
     than a discovery;
   - the owner holds every key defined anywhere in the map, including all ten POS keys;
   - a waiter does not hold `pos.payment`, and a cashier does not hold `pos.transfer_table`;
   - no role other than owner holds any `admin.*` key.

**Tests:** the file above. Per-route enforcement tests live in T-20, which walks the route tree.

**Done when:** `pnpm test src/lib/server/permissions/keys.test.ts` passes, and the file marks which
keys come from spec 8 and which this plan added.

**Watch out:** do not create database tables for roles and permissions. Spec 3 lists "Roles,
Permissions" among the things PostgreSQL will contain, and a code map plus the `users.role` column
satisfies that; editable RBAC tables are the "advanced RBAC" CLAUDE.md's do-not-build list excludes,
and they would need their own management screens, their own audit events and their own migration
story before a single permission could be checked.

---

### T-16 — `restaurants/` — settings, time-zone validation, `settingsComplete`

**Needs:** T-04, T-11
**Files:**
- `src/lib/server/restaurants/index.ts` — NEW
- `src/lib/server/restaurants/time-zone.ts` — NEW
- `src/lib/server/restaurants/time-zone.test.ts` — NEW
- `src/lib/server/restaurants/settings.integration.test.ts` — NEW
**Spec:** 17 ("Timestamps are stored in UTC (`timestamptz`); the restaurant's time zone is a
setting"), 10 (reports group by business date, which the POS session will derive), 3 (price changes
and other sensitive actions are audit-logged)
**Invariants:** 11 (business date, not calendar date; timestamps stored UTC; the restaurant's time
zone is a setting), 10 (settings changes are audit-logged in the same transaction)

**Do:**

1. This is a **new module directory** that CLAUDE.md's "Where code lives" does not list. T-26 adds it.
   It holds restaurant identity and settings, calls `audit/`, and is called by routes and by
   `auth/register.ts`. It calls nothing else.

2. In `time-zone.ts`, export `isValidTimeZone(tz: string): boolean` implemented by **construction**,
   not by list membership:

   ```ts
   try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true }
   catch { return false }
   ```

   Do **not** validate against `Intl.supportedValuesOf('timeZone')`. Measured on the pinned Node
   24.21.0, that list holds 418 entries and does **not** contain `UTC`, `Etc/UTC`, `Asia/Kolkata`,
   `Europe/Kyiv` or `America/Argentina/Buenos_Aires`, while `Intl.DateTimeFormat` accepts every one of
   them. Firefox's `Intl.DateTimeFormat().resolvedOptions().timeZone` — the obvious way to pre-fill
   the registration form — reports `Asia/Kolkata` and `Europe/Kyiv`, so an owner in Kyiv or Kolkata
   would be told their own time zone is invalid, and a test fixture using `UTC` would be rejected.

   Also export `canonicalTimeZone(tz)` returning
   `new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone`, and store that
   canonical form. Build any picker from `Intl.supportedValuesOf('timeZone')` if you like — as a list
   of suggestions, never as the validator.

3. In `index.ts`, export `getRestaurantWithSettings(restaurantId)` returning the name, time zone and
   creation date. Take `restaurantId` explicitly and filter by it. There is no ambient tenant in this
   codebase.

4. Export `updateSettings(tx, restaurantId, changes, ctx)`. It:
   - reads the current row **first**, inside the same transaction;
   - computes a diff of only the fields that actually changed;
   - returns early without writing anything when the diff is empty, so a no-op submission does not
     produce a meaningless audit row;
   - validates and canonicalises the time zone if it is among the changes;
   - writes the update and a `settings.updated` audit row carrying
     `{ changes: { field: { old, new } } }` in the **same transaction**.

   Recording old and new values is what makes the audit row useful. The restaurant's time zone
   determines which business day a POS session belongs to, and its name will be printed on receipts;
   a row that says only "settings were updated" cannot answer, months later, what changed and when.

5. Export `settingsComplete(restaurantId): Promise<{ complete: boolean, missing: string[] }>`. Today
   the only required field is the time zone, so it is effectively always true after registration —
   and that is the point. Write in a comment that **every later plan adding a required setting must
   add it to this function's list**, because T-22's onboarding checklist and, later, POS session
   opening read it. Money-relevant settings must land nullable and be reported here as missing, never
   supplied by a column `DEFAULT` that silently answers open decision 3 or 4 for a restaurant whose
   owner never visited the settings page.

6. Do **not** add tax mode, tax rate, currency, approval limits or idle-lock timing here in any form,
   not even as a commented-out column. They are open decisions 3, 4 and 6.

7. Write `time-zone.test.ts` asserting that `UTC`, `Etc/UTC`, `Asia/Kolkata`, `Europe/Kyiv`,
   `Asia/Riyadh`, `Africa/Mogadishu` and `America/Argentina/Buenos_Aires` are all valid, and that
   `Not/AZone`, the empty string and `'; drop table users; --'` are not. Those first entries are
   exactly the values a list-membership check rejects, so this test would fail against the
   implementation this task forbids.

8. Write `settings.integration.test.ts`:
   - updating the name writes one audit row whose details carry the old and new names;
   - updating nothing writes no audit row;
   - an invalid time zone is rejected and nothing is written;
   - a time zone given in an alias form is stored canonically;
   - **a caller passing restaurant B's id cannot read or update restaurant A's settings** — create two
     restaurants and assert the cross-tenant read returns nothing and the cross-tenant update affects
     zero rows. This is the test that makes explicit tenant scoping real, and it is the one every
     later module's tests should copy.

**Tests:** the two files above. The cross-tenant case is the load-bearing one.

**Done when:** both test files pass; `grep -rn 'supportedValuesOf' src/lib/server/` finds no use as a
validator; and every exported function that touches tenant data takes `restaurantId` as a parameter.

**Watch out:** never re-validate a field the form did not submit. If a future Node or ICU update
changes which spelling of a zone is canonical, re-validating a stored value while the owner is only
renaming the restaurant would reject a setting that has been working for months.
