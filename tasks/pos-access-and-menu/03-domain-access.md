# Phase 2 — Domain, access half

Everything the till needs to authenticate, written as server (and, for the PIN hash, isomorphic)
modules with no route and no screen attached. Phase 1 put the columns in the database; this phase
puts the rules on top of them: one PIN hash format that runs identically in Node and in a browser,
the five-attempts/five-minutes employee lockout, the registered-device token and its revocation, the
audit vocabulary for all of it, the read model that ships cached PIN hashes to a registered device,
and the helper that resolves a POS request's tenant from the device row instead of from whichever
owner last signed in on that browser. Nothing here is reachable over HTTP — Phase 3 (`04-api-pos.md`)
adds the routes, and each of them checks its own permission and returns `403`.

**Depends on:** Phase 1 (`02-schema-access.md`) — T-05 `pos_devices`, T-06 the PIN columns on
`users`, T-07 `audit_log.device_id` / `client_op_id`, T-09 the generated migration, T-10 the schema
guard and test-reset wiring.

**This phase owns the module contracts Phase 3 calls.** Where a task below prints a signature or an
import specifier in a fenced block headed *the contract*, that text is authoritative: Phase 3's
routes must match it exactly, and a route that cannot is a bug in the route, not a licence to
rewrite the module. The three specifiers Phase 3 needs are
`$lib/server/auth/pos-device` (T-13), `$lib/server/auth/pin` (T-12) and
`$lib/server/auth/pos-context` (T-16). There is no `$lib/server/auth/device` and no
`$lib/server/permissions/device` in this plan.

---

### T-11 — Create the isomorphic PIN hash module

**Needs:** T-03 (the recorded PIN-hash decision and digit bound), T-06 (the `users.pin_hash` column
this format is stored in)
**Files:**
- `src/lib/pin/index.ts` — NEW
- `src/lib/pin/index.test.ts` — NEW
**Spec:** 7 (PINs are 4–6 digits, stored only as slow salted hashes), 6 (switching employees offline
uses PIN hashes cached on the registered device, so the same verification must run in the browser),
29 (automated tests from day one)
**Invariants:** 12 (POS access = registered device + PIN; PINs are 4–6 digits stored ONLY as slow
salted hashes, never reversible, never logged)

**Do:**

1. **Before writing a line, open `CLAUDE.md` and find the decision T-03 recorded.** T-03 obtains two
   answers this file encodes: the hash algorithm (the plan's default is **PBKDF2-HMAC-SHA256 at
   600,000 iterations**, OWASP's figure) and the digit bound (spec 7's **4–6**, or the six-digits-only
   option that `tasks/pos-access-and-menu/RESEARCH.md` puts to the user under its `GAP` heading).
   If `CLAUDE.md` records no such decision, **stop and ask** — do not pick one here. The steps below
   assume the defaults. If T-03 recorded **six digits only**, exactly three things change and they
   change together:
   - step 3: `PIN_MIN_DIGITS = 6` (`PIN_MAX_DIGITS` stays `6`);
   - steps 4 and 5 need **no** edit, because the regex and the error message are both *built from*
     those constants rather than typed out — which is why they are written that way below;
   - the Tests block is re-seeded to six digits: `hashPin('123456')`, `hashPin('654321')`,
     `verifyPin('999999', …)`, the too-short case becomes `hashPin('12345')` and the too-long case
     `hashPin('1234567')`. Leaving `hashPin('1234')` in the suite as a *valid* PIN would assert the
     opposite of the decision, and leaving `hashPin('123')` as the boundary case stops testing the
     boundary at all.
2. Create `src/lib/pin/index.ts`. It lives in `src/lib/`, **not** `src/lib/server/`, and that is the
   whole point: `eslint.config.js` errors on any import matching `$lib/server/*`, `$lib/server/**`,
   `../server/*` or `**/lib/server/**` from `src/lib/pos/**` and `src/routes/(pos)/**`, and SvelteKit
   build-blocks `$lib/server` from the browser — so a PIN module under `lib/server` could never run
   the offline verification spec 6 requires. **It must not import `node:crypto`** (no browser build)
   and must not use `Buffer` (a Node-only global). Use `globalThis.crypto.subtle`, which exists in
   Node 24 and in every target browser, and `globalThis.crypto.getRandomValues`.
3. Export the constants, so nothing downstream retypes a magic number:
   `export const PIN_ALGORITHM = 'pbkdf2-sha256';`, `export const PIN_ITERATIONS = 600_000;`,
   `export const PIN_MIN_DIGITS = 4;`, `export const PIN_MAX_DIGITS = 6;`. Keep `SALT_BYTES = 16` and
   `DERIVED_BYTES = 32` module-private.
4. Export `isValidPin(pin: string): boolean`. **Build the pattern from the two constants** rather
   than typing the bounds a second time:

   ```ts
   const PIN_PATTERN = new RegExp(`^\\d{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`);
   ```

   With the defaults that is `/^\d{4,6}$/`. JavaScript's `\d` without the `u` flag is ASCII `0`–`9`
   only, which is what is wanted: Arabic-Indic digits, a leading `+`, a space and a trailing newline
   must all be rejected.
5. Export `async function hashPin(pin: string): Promise<string>`. When `isValidPin` is false it
   throws a message **built from the same constants**, so the message can never contradict the
   validation:

   ```ts
   throw new Error(`A PIN must be ${PIN_MIN_DIGITS} to ${PIN_MAX_DIGITS} digits`);
   ```

   **The message must not interpolate the input**, exactly as `src/lib/server/auth/password.ts`
   refuses to quote a password. Otherwise: 16 random salt bytes from
   `globalThis.crypto.getRandomValues(new Uint8Array(16))`, derive 32 bytes, and return the PHC-style
   string `$pbkdf2-sha256$i=600000$<salt>$<derived>` — standard base64 with the `=` padding stripped,
   the same convention `password.ts` uses for its argon2id string. The parameters travel WITH the
   hash, which is what lets the iteration count be raised later without invalidating anything stored.
6. Export `async function verifyPin(pin: string, stored: string): Promise<boolean>`. Note the
   argument order: **pin first, stored hash second** — the opposite of `verifyPassword(phc, password)`
   in `src/lib/server/auth/password.ts`. Parse `stored` with
   `/^\$pbkdf2-sha256\$i=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/`; return `false` (never throw) for
   anything malformed, for an invalid `pin`, for a non-integer or absurd iteration count (reject
   `i > 10_000_000`, so a tampered stored string cannot pin a CPU), for a salt under 8 bytes or a
   zero-length tag. Re-derive with the iteration count **read out of the string**, not with
   `PIN_ITERATIONS`, so an older hash still verifies.
7. Compare with a constant-time helper, because `timingSafeEqual` is `node:crypto` and unavailable
   here: length check first, then `diff |= a[i] ^ b[i]` over the whole array, return `diff === 0`.
8. Also export `derivePinBits(secret: string, salt: Uint8Array, iterations: number, bytes: number):
   Promise<Uint8Array>` — the raw PBKDF2-HMAC-SHA256 derivation, with **no** digit validation. Its
   only two callers are `hashPin`/`verifyPin` and the known-answer test below; say so in a comment.
   Body: `crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false,
   ['deriveBits'])`, then `crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash:
   'SHA-256' }, key, bytes * 8)`.

**Tests:** in `src/lib/pin/index.test.ts` — the Vitest `unit` project, `environment: 'node'`, which
picks up `src/**/*.test.ts`. Import relatively (`./index`): the unit project defines **no** `$lib`
alias.
- Known answer — the one case that proves the offline till and the server derive the *same* bytes
  rather than merely agreeing with themselves. `derivePinBits('password', new
  TextEncoder().encode('salt'), 1, 32)` hex-encodes to
  `120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b`; with `iterations = 2` it is
  `ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43`; with `iterations = 4096` it is
  `c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a`. These are the published
  PBKDF2-HMAC-SHA256 vectors and they are what proves the parameters are the intended ones rather
  than merely self-consistent. (Required, but **not** one of spec 29's six mandatory areas — those
  are money arithmetic and rounding, tax in both modes, entries balance, one posting rule per spec 24
  event, offline retries never duplicating, and a permission check per POS API route. Do not mark it
  `MANDATORY`; in this plan that marker belongs to T-22 and to T-19's retry test.)
- `hashPin('1234')` then `verifyPin('1234', phc)` → `true`; `verifyPin('1235', phc)` → `false`.
- `hashPin('123')` and `hashPin('1234567')` both throw, and the thrown message contains neither
  `'123'` nor `'1234567'`. `verifyPin('123', phc)` → `false`.
- Non-digits rejected by `isValidPin` and by `verifyPin`: `'12a4'`, `'12 4'`, `'+123'`, `'1234\n'`,
  `'١٢٣٤'` (Arabic-Indic), `''`.
- Two calls to `hashPin('4321')` produce different strings (distinct random salts) and **both**
  verify.
- The string parses back: it matches
  `/^\$pbkdf2-sha256\$i=600000\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/`, neither base64 field contains `=`,
  the salt decodes to 16 bytes and the tag to 32.
- A hand-built PHC string with a lower iteration count still verifies (parameters are read from the
  string): build `$pbkdf2-sha256$i=1000$<salt>$<derived>` using `derivePinBits`, then
  `verifyPin('9999', it)` → `true`.
- Tampered strings return `false` rather than throwing: `'not a phc string'`, `i=0`,
  `i=99999999999`, a one-character salt.

**Done when:** `pnpm test:unit src/lib/pin/index.test.ts` passes, `pnpm check` and `pnpm lint` are
clean, and `grep -rn "node:crypto\|Buffer" src/lib/pin/` prints nothing.

**Watch out:** `btoa`/`atob` are the isomorphic base64 pair (both are Node globals since 16 and
browser globals everywhere) — convert via a `String.fromCharCode` loop over the `Uint8Array`, not via
`Buffer.from`. A 600,000-iteration derivation costs roughly 90 ms on this machine, so every test that
hashes costs that; keep the count of `hashPin` calls in the suite small and use `derivePinBits` with a
low iteration count wherever the test is about format rather than cost. And never log, `console.log`,
throw or return a PIN: `src/lib/server/audit/index.ts`'s `SECRET_KEY_PATTERN`
(`/pass|pin|token|hash|secret|cookie|authorization/i`) will throw if one ever reaches an audit
`details` payload, and that is the last line of defence, not the first.

---

### T-12 — Create the server-side PIN verification and lockout

**Needs:** T-11 (`verifyPin`), T-10 (the schema guard and `TABLES` reset list covering the PIN
columns)
**Files:**
- `src/lib/server/auth/pin.ts` — NEW
- `src/lib/server/auth/pin.integration.test.ts` — NEW
**Spec:** 7 (PIN rules: 4–6 digits, slow salted hashes, **after 5 wrong attempts the employee is
locked out for 5 minutes and an audit event is logged**), 8 (the audit log stores the action and the
employee together), 29 (automated tests from day one)
**Invariants:** 12 (5 wrong attempts lock the employee for 5 minutes and write an audit event; a PIN
is never reversible and never logged), 10 (the audit row is written in the SAME transaction as the
action), 11 (timestamps are `timestamptz`, stored UTC)

**Do:**

1. This module's audit rows use the three `pos.pin.*` event names that **T-14** adds to the
   discriminated union in `src/lib/server/audit/events.ts`, with the exact `details` shapes T-14
   prints. Open that file first. If `pos.pin.success`, `pos.pin.failed` and `pos.pin.locked_out` are
   not present, **run T-14 first** — it is in this same phase and depends only on Phase 1. Do not add
   union members here, and never widen the union to `Record<string, unknown>`. T-14 also adds
   `deviceId` and `clientOpId` to `AuditEntry`; this module sets both on every row it writes.
2. Create `src/lib/server/auth/pin.ts` exporting
   `export const MAX_FAILED_PIN_ATTEMPTS = 5;` and `export const PIN_LOCKOUT_MS = 5 * 60 * 1000;`,
   and these types verbatim. `UserRole` comes from `../db/schema/users`, `DbTx` from `../db/client`.

   ```ts
   export type PinAttemptInput = { restaurantId: string; employeeId: string; pin: string };
   export type PinAttemptContext = {
   	deviceId: string;
   	deviceCode: string;
   	/** T-07's idempotency key, carried onto every audit row this call writes. */
   	clientOpId: string | null;
   	ip: string | null;
   	userAgent: string | null;
   	now?: Date;
   };
   export type PosEmployeeIdentity = { id: string; displayName: string; role: UserRole };
   export type PinAttemptResult =
   	| { ok: true; employee: PosEmployeeIdentity }
   	| { ok: false; reason: 'invalid' }
   	| { ok: false; reason: 'locked'; retryAfterMs: number };
   ```

   The field is `employeeId`, not `userId`, and the success payload is `employee`, not a flattened
   `userId` / `role` / `displayName` — both because that is what T-19 calls and because "employee" is
   the word the till screen uses.
3. Export `async function verifyEmployeePin(tx: DbTx, input: PinAttemptInput, ctx:
   PinAttemptContext): Promise<PinAttemptResult>`, modelled line for line on `loginWithPassword` in
   `src/lib/server/auth/login.ts` **except** that it takes the transaction handle and does not open
   its own (step 10). **There is no throttle**: `login.ts` wraps a public email-and-password endpoint
   and needs a per-IP bucket in front of the hashing, whereas this call is reachable only from a
   registered device (T-16 proves the device cookie before T-19 calls this), so spec 7's rule applies
   unmodified.

   **The contract — T-19 is the only caller and must match it exactly:**

   ```ts
   const result = await verifyEmployeePin(
   	tx,
   	{ restaurantId: device.restaurantId, employeeId, pin },
   	{
   		deviceId: device.deviceId,
   		deviceCode: device.deviceCode,
   		clientOpId: clientOpId ?? null,
   		ip,
   		userAgent,
   		now
   	}
   );
   ```

   T-19 opens the one `db.transaction`, passes `tx` in here, and **writes no `pos.pin.*` audit row of
   its own**: every audit row for the attempt is written by this function, in that same transaction
   (invariant 10). This function is the only code in a position to know whether an attempt was the
   fifth one, and two writers would mean two rows per attempt — which would also break T-19's
   idempotency lookup, which expects exactly one row per `client_op_id`. On success T-19 reads
   `result.employee.id`, `result.employee.displayName` and `result.employee.role`; there is no
   `userId` field on the result.
4. **Never throw for a failed PIN — return a result object from every path.** The caller's
   transaction wraps this call, and Drizzle's node-postgres session catches a thrown error, issues
   `rollback` and rethrows — which would roll back the very counter increment and audit row the
   failure exists to write, so the lockout would silently not exist while every unit test of
   `verifyPin` still passed. A wrong PIN, an unknown employee id and a lockout are all ordinary
   return values here; throw only for a genuine programming error.
5. First statement: select `id, restaurantId, role, displayName, isActive, pinHash, failedPinCount,
   pinLockedUntil` from `users` where `id = input.employeeId` **and**
   `restaurantId = input.restaurantId`, with `.for('update')` so two concurrent attempts cannot both
   read a count of 4 and both write 5. Name the columns explicitly — never `select()` the whole row
   and narrow afterwards, for the reason the `Principal` comment in
   `src/lib/server/auth/session.ts` gives. These are the columns **T-06** added; open
   `src/lib/server/db/schema/users.ts` and use the names it declares. If the property names differ
   from `pinHash` / `failedPinCount` / `pinLockedUntil`, follow the schema file and add no column here.
   **Never read or write `failedPasswordCount` or `passwordLockedUntil`** — the two surfaces lock
   independently, and five wrong PINs typed at the counter must not lock the owner out of the
   dashboard.
6. No row, a row from another restaurant, `isActive === false`, or `pinHash === null`: spend the same
   time by awaiting `verifyPin(input.pin, DUMMY_PIN_PHC)`, write **no** audit row, and return
   `{ ok: false, reason: 'invalid' }` — byte for byte the same shape a wrong PIN returns, so an
   unknown employee id is indistinguishable from a wrong PIN by timing or by response. No audit row
   on purpose: the row would be about nobody, and letting a caller mint audit rows for ids that do
   not exist fills an append-only table that can never be pruned. Because nothing is written on this
   branch, a retry carrying the same `clientOpId` finds no row to replay and simply runs it again —
   which is still a no-op, since no counter moved and no row exists either time. Define
   `DUMMY_PIN_PHC` as a module constant — a real `hashPin` output over a random value nobody knows,
   produced once and pasted in as a literal, exactly as `login.ts` does with `DUMMY_PHC`. Generate it
   with
   `pnpm exec tsx -e "const { hashPin } = await import('./src/lib/pin/index.ts'); console.log(await hashPin(String(Math.floor(Math.random() * 900000) + 100000)));"`
   (if `-e` is awkward, put those two lines in a throwaway file under the scratch directory, run it
   with `pnpm exec tsx`, then delete the file). A dummy that is cheaper than a real verify restores
   the timing difference it exists to remove.
7. Already locked (`pinLockedUntil` set and in the future): write `pos.pin.failed` with
   `details: { deviceCode: ctx.deviceCode, reason: 'rejected_locked', failedCount: 0 }`,
   `actorUserId: null` (performed by nobody), `subjectUserId: user.id`, `occurredAt: now`, and return
   `{ ok: false, reason: 'locked', retryAfterMs: pinLockedUntil - now }`. Do **not** check the hash.
   `failedCount` is `0` here because step 8 zeroes the counter when it sets the lock — the number is
   the stored count, not a running tally of refusals.
8. Wrong PIN: `const failedCount = user.failedPinCount + 1`. At
   `failedCount >= MAX_FAILED_PIN_ATTEMPTS`, update the row to
   `{ failedPinCount: 0, pinLockedUntil: new Date(now.getTime() + PIN_LOCKOUT_MS), updatedAt: now }`
   and write `pos.pin.locked_out` with
   `details: { deviceCode: ctx.deviceCode, failedCount, lockedForMs: PIN_LOCKOUT_MS }`. **Reset the
   counter when setting the lock** — not a detail: a counter that kept climbing would make a `=== 5`
   test never fire again after one warm-up cycle, and `>= 5` would re-lock on every subsequent miss,
   which is stricter than spec 7 and punishes an employee who mistypes once. Below the threshold,
   update `{ failedPinCount: failedCount, updatedAt: now }` and write `pos.pin.failed` with
   `details: { deviceCode: ctx.deviceCode, reason: 'bad_pin', failedCount }`. Both branches return
   `{ ok: false, reason: 'invalid' }`.
9. Correct PIN: update `{ failedPinCount: 0, pinLockedUntil: null, updatedAt: now }`, write
   `pos.pin.success` with `details: { deviceCode: ctx.deviceCode, role: user.role }`,
   `actorUserId: user.id`, `subjectUserId: user.id`, and return
   `{ ok: true, employee: { id: user.id, displayName: user.displayName, role: user.role } }`.
   Every `writeAudit` call in this file takes **the `tx` this function was handed** — never the `db`
   singleton, never a new transaction — and every one of them carries `deviceId: ctx.deviceId`,
   `clientOpId: ctx.clientOpId`, `ip: ctx.ip`, `userAgent: ctx.userAgent` and `occurredAt: now`, so
   the counter change and its audit row commit together or not at all.
10. **This function does not open a transaction.** It takes one, exactly as `writeAudit` and T-13's
    device functions do, because the counter update, the lock and the audit row have to commit with
    whatever else the route is doing in the same request — and because T-19's idempotency lookup and
    its `23505` retry path need the whole attempt inside one transaction they control. The route
    turns the returned result into an HTTP response **after** that transaction commits.

**Tests:** `src/lib/server/auth/pin.integration.test.ts` — the `integration` project. Follow
`src/lib/server/auth/login.integration.test.ts`: `testDb()` / `closeTestDb()` from `../db/test/db`,
`afterAll` closing, and a `makeEmployee()` helper inserting a `restaurants` row and a `cashier` row
with `pinHash: await hashPin('1234')`. `src/lib/server/db/integration-setup.ts` truncates between
tests, so each test builds its own fixture. Because the function takes a transaction handle, wrap
every call the way T-19 will — `await db.transaction((tx) => verifyEmployeePin(tx, input, ctx))` —
and write one local `attempt()` helper that does it, rather than repeating the wrapper. The fixture
also needs a `pos_devices` row, because `ctx.deviceId` lands in `audit_log.device_id`, whose FK is
`restrict`; register one with T-13's `registerDevice`. Inject `now` through `ctx` rather than
sleeping.
- Four wrong PINs then the correct one: the result is `{ ok: true }` with
  `employee.id`/`displayName`/`role` matching the seeded cashier, and afterwards
  `failedPinCount === 0` and `pinLockedUntil === null`.
- Five wrong PINs: `pinLockedUntil` is within a second of `now + 300000`, `failedPinCount === 0`, the
  audit events written are exactly four `pos.pin.failed` then one `pos.pin.locked_out`, and the
  lockout row's `details` is `{ deviceCode, failedCount: 5, lockedForMs: 300000 }`.
- A locked employee giving the **correct** PIN inside the window gets
  `{ ok: false, reason: 'locked' }` with `retryAfterMs > 0`, and one more `pos.pin.failed` whose
  `details.reason` is `'rejected_locked'`; the same correct PIN with `now` set past
  `pinLockedUntil` returns `{ ok: true }`.
- **Every row this module writes carries the device and the op id.** After one successful attempt
  with `clientOpId: someUuid`, that `audit_log` row has `device_id` equal to the registered device
  and `client_op_id` equal to `someUuid`; after one with `clientOpId: null`, `client_op_id` is
  `null` and `device_id` is still set. This is the assertion that fails if T-14's `writeAudit` edit
  was skipped.
- **The caller's transaction owns the outcome.** Calling `verifyEmployeePin` inside a transaction
  that then throws leaves **zero** audit rows and an unchanged `failedPinCount` — proof that the
  function did not sneak its own commit in.
- **The password lockout columns are untouched.** Seed the employee with `failedPasswordCount: 3` and
  `passwordLockedUntil: null` before the run; after five failed PIN attempts assert
  `failedPasswordCount === 3` and `passwordLockedUntil === null`, and assert the same after a
  successful PIN.
- An unknown `employeeId` (a fresh `crypto.randomUUID()`) and a real employee from a **different**
  restaurant both return exactly `{ ok: false, reason: 'invalid' }` and write **zero** audit rows.
- An inactive employee and one with `pinHash === null` both return `{ ok: false, reason: 'invalid' }`.

**Done when:** `pnpm test:integration src/lib/server/auth/pin.integration.test.ts` passes,
`pnpm check` and `pnpm lint` are clean,
`grep -n "failedPasswordCount\|passwordLockedUntil" src/lib/server/auth/pin.ts` prints nothing, and
`grep -n "db.transaction" src/lib/server/auth/pin.ts` prints nothing (the handle comes from the
caller).

**Watch out:** `audit_log.id` is `bigint` with `mode: 'bigint'`, so assertions on it compare against
`1n`, not `1`. Each `verifyPin` costs roughly 90 ms, so a five-failure test costs about half a second
— that is correct, not a performance bug, and must not be "fixed" by lowering `PIN_ITERATIONS`. And
passing the `db` singleton to `writeAudit` instead of the handed-in `tx` compiles and passes a happy
-path test while quietly breaking invariant 10: the audit row would survive a rollback that undid the
lock it records.

---

### T-13 — Create POS device registration and revocation

**Needs:** T-05 (the `pos_devices` table), T-10 (the schema guard and `TABLES` reset list covering it)
**Files:**
- `src/lib/server/auth/pos-device.ts` — NEW
- `src/lib/server/auth/pos-device.integration.test.ts` — NEW
**Spec:** 7 (POS device registration: the owner signs in with email + password, the server issues a
long-lived HttpOnly + Secure device cookie, PIN login is accepted only from registered devices, and
the owner can revoke a device from the dashboard), 9 (HttpOnly + Secure + SameSite cookies; no
tokens in `localStorage`; SvelteKit's origin/CSRF check stays on)
**Invariants:** 12 (POS access = registered device + PIN; a long-lived HttpOnly + Secure device
cookie, revocable from the dashboard; never `localStorage`), 2 (a revocation stamps a column, it
never deletes a row), 11 (timestamps `timestamptz`, stored UTC)

**Do:**

1. Open `src/lib/server/db/schema/pos-devices.ts` (created by **T-05**) before writing a line and use
   the property names it declares. This task writes or reads `id`, `restaurantId`, `deviceCode`,
   `label`, `tokenHash`, `registeredByUserId`, `registeredAt`, `revokedAt` and `revokedByUserId`;
   if T-05 spelled one differently, follow the schema file. Note which of them are `notNull()` with
   **no** default — `deviceCode`, `label`, `tokenHash` and `registeredByUserId` all are, so every
   insert below sets all four or fails at runtime. **Do not add a column here** — a new column is a
   migration, which is T-05's phase, not this one.
2. Create `src/lib/server/auth/pos-device.ts` exporting `export const DEVICE_COOKIE =
   'matcami_pos_device';` and `export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;`
   (400 days — the ceiling browsers now clamp cookie lifetimes to, and "long-lived" in spec 7's
   sense). **The module path is `src/lib/server/auth/pos-device.ts` and its import specifier is
   `$lib/server/auth/pos-device`** — T-16's `pos-context.ts` sits beside it and T-18, T-21 and T-29
   all import from it. There is no `auth/device.ts` in this plan; if a later task's text says
   otherwise, this file is the one that exists.
3. Copy the token idiom from `src/lib/server/auth/session.ts` exactly, and export both halves so the
   test can prove the raw token is absent from the database:
   `generateDeviceToken(): string` returning `randomBytes(32).toString('base64url')`, and
   `deviceTokenHash(token: string): string` returning
   `createHash('sha256').update(token).digest('hex')` — the lowercase hex SHA-256, which is what
   `pos_devices.token_hash` holds. The raw token exists in the cookie and nowhere else; a database
   leak then yields hashes, not usable devices.
4. Export `registerDevice`, with this signature verbatim:

   ```ts
   export async function registerDevice(
   	tx: DbTx,
   	args: { restaurantId: string; actorUserId: string; label: string; now?: Date }
   ): Promise<{ deviceId: string; deviceCode: string; token: string; expiresAt: Date }>;
   ```

   **The field names are the contract** — `actorUserId` (not `ownerUserId`), `label`, and a
   `deviceCode` that is **returned, never passed in**. T-18 destructures `deviceCode`; there is no
   `code` field. It takes the **transaction handle** and must not open its own, so T-18's route can
   register the device, destroy the owner's dashboard session on that browser and write the audit row
   in one all-or-nothing transaction. `expiresAt` is `now + DEVICE_COOKIE_MAX_AGE_SECONDS` expressed
   as a `Date`: `pos_devices` has **no** `expires_at` column and a device row never expires on its
   own — the lifetime lives in the cookie, and this value exists so the caller can set it there and
   show it on the dashboard without recomputing the arithmetic.
5. `registerDevice` first verifies the actor's identity in the database: select `role, restaurantId`
   from `users` where `id = args.actorUserId`, and `throw new Error('registerDevice requires the
   owner of this restaurant')` unless `role === 'owner'` and `restaurantId` matches. This is belt and
   braces beside T-18's `requireOwner(event)` — the comment on `requireOwner` in
   `src/lib/server/permissions/index.ts` reserves that guard for exactly this action, "registering a
   POS device", because spec 7 ties it to the owner as a **person** rather than to a capability.
6. **Allocate the next unused device code.** Select every `deviceCode` for this `restaurantId` —
   revoked rows **included** — take the codes matching `/^POS(\d+)$/`, and use `max(n) + 1`, or `1`
   when there are none: `POS1`, then `POS2`, then `POS3`. A burned code is never reused. T-05's
   `pos_devices_restaurant_device_code_unique` is a **full** unique index on
   `(restaurant_id, device_code)` — it is deliberately *not* partial on `revoked_at is null`, and
   T-05's own Watch out explains why: `POS1` is the printed invoice prefix from spec 6, so reusing it
   after a revoke would let `POS1-000001` name two different sales, and the later
   `UNIQUE (device_id, invoice_number)` could not catch it because the device ids differ. **Do not
   "fix" a collision here by making that index partial.** Refuse above `POS99999` (T-05's CHECK is
   `^[A-Z0-9]{1,8}$`, so `POS` plus five digits is the ceiling) with a thrown error rather than
   writing a code the CHECK will reject. A concurrent second registration racing to the same number
   loses on the unique index with PostgreSQL `23505`, which is the loud failure T-05 designed for —
   let it propagate and roll the caller's transaction back.
7. Then insert the row, setting every `notNull` column: `restaurantId`, the allocated `deviceCode`,
   `label: args.label`, `tokenHash: deviceTokenHash(token)`, `registeredByUserId: args.actorUserId`
   and `registeredAt: now`. **Leave any existing active row alone.** This function does not revoke,
   supersede or replace anything: spec 31's MVP is one registered device and **T-18 is where that is
   enforced**, with a `.for('update')` select and a `409 device_already_registered` when an active
   row exists. Registering silently over a live device would leave a second tablet armed with a valid
   cookie nobody knows about, so the owner revokes the old device from the dashboard (T-21) first and
   the next registration takes the next code. **Never `DELETE` a `pos_devices` row**:
   `audit_log.device_id` (T-07) references devices with `ON DELETE RESTRICT`, and an old row is the
   only record that a device once existed.
8. Export `revokeDevice`, with this signature verbatim:

   ```ts
   export async function revokeDevice(
   	tx: DbTx,
   	args: { deviceId: string; restaurantId: string; actorUserId: string; now?: Date }
   ): Promise<{ deviceCode: string; label: string } | null>;
   ```

   One `UPDATE`, scoped by **both** `id` and `restaurantId` and by `revokedAt is null`, stamping
   `revokedAt = now` **and** `revokedByUserId = args.actorUserId` together — T-05 step 4 calls the
   pair "the `revoked_at` / `revoked_by_user_id` stamp", and a null actor makes the trail unable to
   answer who pulled the till offline. Return the stamped row's `deviceCode` and `label` (T-21 puts
   both into its audit `details`), and return `null` when nothing was stamped — no such device, the
   wrong restaurant, or already revoked — so T-21 can answer `404`/"already revoked" rather than
   pretend. Use the `UPDATE … RETURNING` form so the read and the write cannot disagree.
9. Export `async function validateDeviceToken(database: Executor, token: string):
   Promise<{ deviceId: string; restaurantId: string; deviceCode: string } | null>`. `Executor` is the
   `Db | DbTx` union already exported from `src/lib/server/auth/session.ts`. Look the row up by
   `tokenHash = deviceTokenHash(token)`, select the three columns explicitly, and **return `null`
   when `revokedAt` is not null** — that single condition is what makes spec 7's dashboard revocation
   actually enforceable rather than decorative. Do not write anything on this path (no `last_seen_at`
   touch): it runs on every POS request, and a write there is contention nobody asked for.
10. Export `setDeviceCookie(cookies: Cookies, token: string, expiresAt?: Date): void` calling
    `cookies.set(DEVICE_COOKIE, token, { path: '/', maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS, ...(expiresAt ? { expires: expiresAt } : {}) })`,
    and `deleteDeviceCookie(cookies: Cookies): void` calling
    `cookies.delete(DEVICE_COOKIE, { path: '/' })`. The optional third argument is the `expiresAt`
    `registerDevice` returned and names the same instant as `maxAge`; passing it is what T-18 does.
    Pass **only** those options and rely on SvelteKit's defaults for the rest, exactly as
    `setSessionCookie` does: `httpOnly: true`, `sameSite: 'lax'`, and `secure: true` for every origin
    except `http://localhost`. **Never pass `secure: false`** to make local testing easier —
    localhost is exempt by specification, which is the only reason it works there. `path: '/'` and
    not `/pos` because the endpoints that read this cookie live at `/api/pos/*`, outside the `/pos`
    prefix.
11. Write **no audit rows in this module.** The `pos.device.registered` and `pos.device.revoked`
    event names arrive with T-14, and registration and revocation are composite route-level actions —
    T-18 and T-21 call `writeAudit(tx, …)` with the same `tx` they pass in here, which is what keeps
    invariant 10's "same transaction as the action" true. That is also why `revokeDevice` returns
    `label`: T-21 needs it for `details` and must not re-query for it.

**Tests:** `src/lib/server/auth/pos-device.integration.test.ts` — the `integration` project, built
like `src/lib/server/auth/login.integration.test.ts` (`testDb()`, `closeTestDb()` in `afterAll`, a
fixture helper that inserts a `restaurants` row and an `owner` row with an `email` and a
`passwordHash`, since `users_owner_has_credentials` requires both).
- A registered device validates: `registerDevice` inside `db.transaction`, then
  `validateDeviceToken(db, token)` returns the same `deviceId`, `restaurantId` and `deviceCode`.
- The first registration for a restaurant gets `deviceCode === 'POS1'`, and the inserted row carries
  the `label` that was passed in and `registered_by_user_id` equal to the owner's id — the two
  `notNull` columns a naive insert forgets.
- `expiresAt` is within a second of `now + DEVICE_COOKIE_MAX_AGE_SECONDS * 1000`.
- A revoked device does not validate: after `revokeDevice`, `validateDeviceToken(db, token)` returns
  `null`, and the row is **still there** — assert `select count(*)` is unchanged, `revokedAt` is
  non-null, and `revoked_by_user_id` is the owner who revoked it.
- `revokeDevice` returns `{ deviceCode, label }` for the row it stamped, and returns `null` on a
  second call for the same device (already revoked), for an id that does not exist, and for a device
  belonging to another restaurant — leaving that other restaurant's device valid.
- The raw token never appears in the database: query
  `select count(*)::int as n from pos_devices where token_hash = $1` with the raw token and expect
  `0`, and with `deviceTokenHash(token)` and expect `1`.
- **Codes are never reused.** Register, revoke, register again: the second call returns
  `deviceCode === 'POS2'`, a different `deviceId` and a different token; the first token no longer
  validates; and `pos_devices` holds two rows for the restaurant with exactly one having
  `revokedAt === null`. (Under a partial unique index this test would pass with two `POS1` rows —
  which is exactly the outcome T-05 forbids.)
- **`registerDevice` does not replace an active device.** Calling it twice without a revoke leaves
  **two** active rows, `POS1` and `POS2`. That is deliberate: refusing a second registration is
  T-18's `409`, at the route, where the `.for('update')` select lives. Assert it here so nobody
  "helpfully" adds a silent supersede to this module.
- `registerDevice` throws when `actorUserId` names a `cashier`, and when it names an owner of a
  **different** restaurant — and no row is inserted in either case.

**Done when:** `pnpm test:integration src/lib/server/auth/pos-device.integration.test.ts` passes,
`pnpm check` and `pnpm lint` are clean, and
`grep -n "delete(posDevices)\|secure: false" src/lib/server/auth/pos-device.ts` prints nothing.

**Watch out:** `randomBytes` and `createHash` come from `node:crypto`, which is correct **here** —
this file is under `src/lib/server/` and never reaches a browser. Do not repeat that import in
`src/lib/pin/`, which must stay isomorphic. `registerDevice` taking `DbTx` rather than `Db` is load
bearing: an implementation that opens its own transaction makes T-18 unable to destroy the owner's
dashboard session in the same commit, which is the requirement that no live owner session is left on
a counter tablet. And the device-code allocator must read **all** rows, not just the active ones: a
`where revoked_at is null` there hands `POS1` straight back out and the insert then dies on T-05's
full unique index.

---

### T-14 — Extend the audit event union with the POS events

**Needs:** T-07 (`audit_log.device_id` / `client_op_id`), T-10 (the schema guard and reset list)
**Files:**
- `src/lib/server/audit/events.ts` — EDIT (extend the `AuditEvent` union; add a runtime name list
  below it. Never widen the union to `Record<string, unknown>`)
- `src/lib/server/audit/index.ts` — EDIT (add `deviceId` and `clientOpId` to the `AuditEntry` type,
  beside `ip` / `userAgent`, and to the `tx.insert(auditLog).values({ … })` call in `writeAudit`.
  Change nothing else in the file — `assertNoSecrets`, `requestContext` and `recentActivity` stay as
  they are)
- `src/routes/(dashboard)/dashboard/event-text.ts` — NEW (the `EVENT_TEXT` map, moved out of the
  component so a test can import it)
- `src/routes/(dashboard)/dashboard/+page.svelte` — EDIT (delete the inline `const EVENT_TEXT`
  declaration at roughly line 84, inside `<script lang="ts">` between the `localTime` `$derived` and
  the `activity` `$derived`, and import the map instead)
- `src/routes/(dashboard)/dashboard/event-text.test.ts` — NEW
- `src/lib/server/audit/audit.test.ts` — EDIT (add cases to the existing `it.each([...])('passes for
  %s')` block inside the `describe('assertNoSecrets')`)
- `src/lib/server/audit/audit.integration.test.ts` — EDIT (add one `it` to the existing
  `describe('writeAudit runs inside the caller transaction (invariant 10)')` block)
**Spec:** 3 (sensitive actions are audit-logged: logins, failed PINs, approvals), 7 (a lockout after
five wrong PINs writes an audit event), 8 (the action, the employee, the approver and the reason are
stored together), 6 (every operation carries a device-generated id so a retried sync is ignored)
**Invariants:** 10 (sensitive actions are audit-logged, in the same transaction as the action),
2 (`audit_log` is append-only — migration `0004_audit_log_append_only.sql` blocks `UPDATE` and
`DELETE`, so a wrong payload can never be removed), 5 (the idempotency key is carried on the row, so
a retry can be recognised as a no-op)

**Do:**

1. In `src/lib/server/audit/events.ts`, add eight members to the `AuditEvent` discriminated union,
   each with an exact `details` shape. `UserRole` is already imported at the top of that file.
   ```ts
   | { event: 'pos.device.registered'; details: { deviceCode: string; label: string } }
   | { event: 'pos.device.revoked'; details: { deviceCode: string; label: string } }
   | { event: 'pos.pin.success'; details: { deviceCode: string; role: UserRole } }
   | { event: 'pos.pin.failed';
       details: { deviceCode: string; reason: 'bad_pin' | 'rejected_locked'; failedCount: number } }
   | { event: 'pos.pin.locked_out';
       details: { deviceCode: string; failedCount: number; lockedForMs: number } }
   | { event: 'employee.created'; details: { role: UserRole; displayName: string } }
   | { event: 'employee.pin_set'; details: { role: UserRole } }
   | { event: 'employee.deactivated'; details: { role: UserRole; displayName: string } }
   ```
   **These shapes are the contract; every consumer quotes them verbatim.** Three choices in them were
   made here so they are made only once:
   - the counter is **`failedCount`**, matching the `login.locked_out` member already in this union,
     never `attemptedCount` and never a name derived from the `failed_pin_count` column;
   - the lock duration is **`lockedForMs`**, matching T-12's exported `PIN_LOCKOUT_MS`, so no caller
     converts to minutes and no two callers convert differently;
   - `pos.pin.failed.reason` has exactly two values, `'bad_pin'` and `'rejected_locked'`. There is
     **no `'unknown_employee'`**: T-12 step 6 writes no audit row at all for an id that is not an
     active employee of the device's restaurant, because the row would be about nobody and
     `audit_log` can never be pruned. A consumer that lists `'unknown_employee'` is describing a row
     this plan never writes.

   `failedCount` on `pos.pin.failed` is the running count **after** this attempt, and `0` when the
   attempt was refused because the employee was already locked (T-12 zeroes the counter when it sets
   the lock).
2. **Every key above was chosen to survive `assertNoSecrets`.** Open
   `src/lib/server/audit/index.ts` and read its `SECRET_KEY_PATTERN`: it is
   `/pass|pin|token|hash|secret|cookie|authorization/i`, tested case-insensitively as a **substring**
   against every key at every depth of `details`, and a match **throws**. So `pinLockedUntil`,
   `failedPinCount`, `deviceToken` and `tokenHash` would each abort the write — and, because the
   write happens inside the action's transaction (invariant 10), the throw would roll back the very
   lockout it was recording. That is why the counter field is `failedCount` and the device field is
   `deviceCode`. Event **names** are not inspected, only `details` keys, so `pos.pin.failed` is fine.
3. Below the union in the same file, add a runtime list and a compile-time exhaustiveness assertion,
   because a TypeScript union cannot be iterated at run time:
   ```ts
   export const AUDIT_EVENT_NAMES = [ /* all 17 names, existing nine first */ ] as const satisfies
     readonly AuditEventName[];
   /** Fails to compile if a union member is missing from AUDIT_EVENT_NAMES. Exported so the
       linter does not flag it as unused. */
   export type _NoMissingAuditEventNames =
     Exclude<AuditEventName, (typeof AUDIT_EVENT_NAMES)[number]> extends never ? true : never;
   ```
4. Create `src/routes/(dashboard)/dashboard/event-text.ts` holding
   `export const EVENT_TEXT: Record<AuditEventName, string> = { … }` — the nine entries currently in
   the component, verbatim, plus: `'pos.device.registered': 'POS device registered'`,
   `'pos.device.revoked': 'POS device revoked'`, `'pos.pin.success': 'Signed in at the POS'`,
   `'pos.pin.failed': 'Failed POS sign-in attempt'`,
   `'pos.pin.locked_out': 'Employee locked out at the POS after repeated failures'`,
   `'employee.created': 'Employee added'`, `'employee.pin_set': 'Employee PIN set'`,
   `'employee.deactivated': 'Employee deactivated'`. Import `AuditEventName` from
   `$lib/server/audit/events`. Typing it as a total `Record` means a future union member that nobody
   gives a sentence to is a **compile** error, not a dotted name on the owner's screen. A plain `.ts`
   file beside a route is an existing pattern (`src/routes/login/helpers.ts`), and
   `src/routes/route-guards.test.ts` only walks `+page.server.ts`, `+layout.server.ts` and
   `+server.ts`, so this file adds no route and needs no guard.
5. In `src/routes/(dashboard)/dashboard/+page.svelte`, delete the inline `const EVENT_TEXT` and add
   `import { EVENT_TEXT } from './event-text';` beside the existing `$lib/components/ui` import. Keep
   the `?? row.event` fallback in the `activity` `$derived` exactly as it is: `audit_log` is
   append-only, so a row written under a name later removed from the union lives forever and must
   still render as something.
6. **Extend `AuditEntry` and `writeAudit` with T-07's two columns.** This plan writes the first
   device-sourced audit rows, so the writer has to be able to fill them — T-07 step 7 says as much in
   `02-schema-access.md`: the columns land there, "the writer `writeAudit()` in
   `src/lib/server/audit/index.ts` gains its `deviceId` / `clientOpId` fields in T-14". In
   `src/lib/server/audit/index.ts`, add to the `AuditEntry` type, beside `ip` and `userAgent`:
   ```ts
   /**
    * The registered till this row came from, or null for a dashboard event.
    * T-19's idempotency lookup selects on (device_id, client_op_id), so a row
    * written with a clientOpId and no deviceId can never be matched to its retry.
    */
   deviceId?: string | null;
   /**
    * The device-generated idempotency key for the operation that produced this
    * row, or null when the server originated it. Backed by the partial
    * UNIQUE (device_id, client_op_id) WHERE client_op_id IS NOT NULL.
    */
   clientOpId?: string | null;
   ```
   and add `deviceId: entry.deviceId ?? null,` and `clientOpId: entry.clientOpId ?? null,` to the
   `tx.insert(auditLog).values({ … })` call. Both are optional so the nine existing dashboard
   callers keep compiling unchanged. What **does not** exist yet is a queued-operation *replay* —
   nothing in this plan flushes a sync queue, because this till cannot sell — and the comment beside
   the new union members should say that, rather than claiming nothing writes the columns: T-12 (via
   T-19), T-18 and T-21 all do.
7. T-12 (`pos.pin.*` — it owns those writes; T-19 passes it the transaction and writes none of its
   own), T-18 (`pos.device.registered`), T-21 (`pos.device.revoked`) and T-31 (`employee.*`) are the
   consumers. This task adds the vocabulary and the two writer fields only; it writes no audit row.

**Tests:**
- `src/routes/(dashboard)/dashboard/event-text.test.ts` — unit project. Import `EVENT_TEXT` from
  `./event-text` and `AUDIT_EVENT_NAMES` from `../../../lib/server/audit/events` (a **relative**
  path: the unit project defines no `$lib` alias — see `vitest.config.ts`, where `alias` is set on
  the `integration` project only). Assert that for every name in `AUDIT_EVENT_NAMES` the map has a
  non-empty string, and that `Object.keys(EVENT_TEXT).sort()` equals `[...AUDIT_EVENT_NAMES].sort()`
  so a stale entry for a deleted event is caught too.
- `src/lib/server/audit/audit.test.ts` — add one `['a POS pin failure', { deviceCode: 'POS1', reason:
  'bad_pin', failedCount: 3 }]` case and one `['a POS lockout', { deviceCode: 'POS1',
  failedCount: 5, lockedForMs: 300000 }]` case to the existing "passes for %s" `it.each`, plus
  `['a POS device registration', { deviceCode: 'POS1', label: 'Counter tablet' }]` and
  `['an employee record', { role: 'cashier', displayName: 'Sam' }]`. Write these as real cases, not
  as a comment: a `details` key that trips `assertNoSecrets` would roll back the transaction that was
  recording the lockout, and this is the test that would have caught `failedPinCount`.
- `src/lib/server/audit/audit.integration.test.ts` — one new case: a row written with both
  `deviceId` and `clientOpId` set lands them in the columns. The fixture needs a real `pos_devices`
  row, because `audit_log.device_id` references it with `ON DELETE RESTRICT`; insert a restaurant, an
  owner and a device (T-13's `registerDevice`), write one row inside `db.transaction`, then
  `select device_id, client_op_id from audit_log` and assert both match. Assert too that an entry
  written **without** them stores `null` in both — the nine existing dashboard callers must keep
  working untouched.

**Done when:** `pnpm test:unit` passes (including both unit files above),
`pnpm test:integration src/lib/server/audit/audit.integration.test.ts` passes, `pnpm check` is clean,
and temporarily deleting one entry from `EVENT_TEXT` makes `pnpm check` fail — verify that by hand
once, then restore it.

**Watch out:** `src/lib/server/audit/index.ts`'s `recentActivity` casts the text column with
`r.event as AuditEventName`, so the compiler cannot help with values already in the table. The
`?? row.event` fallback in the component is the only thing standing between an old row and a blank
cell. Route-group parentheses in a path (`(dashboard)`) are legal in an import specifier — the
relative import in the test resolves normally. And do not "tidy" the two new `AuditEntry` fields into
required ones: nine existing call sites pass neither, and making them required turns a vocabulary
change into a nine-file edit in an area where every edit risks invariant 10.

---

### T-15 — Create the employee directory read model for the POS

**Needs:** T-06 (the `users.pin_hash` column), T-11 (the PHC format the hash is stored in)
**Files:**
- `src/lib/server/auth/employee-directory.ts` — NEW
- `src/lib/server/auth/employee-directory.integration.test.ts` — NEW
**Spec:** 6 (switching employees while offline uses PIN hashes **cached on the registered device**,
refreshed on each sync), 7 (the POS shows a Select Employee list, then a PIN), 8 (server-side
enforcement)
**Invariants:** 12 (PINs stored only as slow salted hashes; the PIN screen is shown only on a
registered device), 8 (permissions enforced server-side on every route, reads included — the route
in T-20 is the enforcement point for this read)

**Do:**

1. Create `src/lib/server/auth/employee-directory.ts` exporting
   ```ts
   export type PosEmployee = {
     id: string;
     displayName: string;
     role: UserRole;
     isActive: boolean;
     pinPhc: string | null;
   };
   export async function listPosEmployees(database: Executor, restaurantId: string):
     Promise<PosEmployee[]>
   ```
   `Executor` (`Db | DbTx`) comes from `./session`; `UserRole` from `../db/schema/users`.
2. **This function deliberately returns the PIN hash, and that is the single most surprising line in
   the module — say so in a comment at the top of the file.** Spec 6 requires the registered device
   to verify a PIN offline from hashes cached on it, so the hash has to reach the device or offline
   employee switching cannot exist. The compensating controls are named in spec 6 and 7 and are all
   already in this plan: the bundle is served **only** to a registered device (T-16 resolves it,
   T-20 enforces it and returns `403` otherwise), the owner can revoke that device from the
   dashboard, and every money-moving action needs an owner PIN approval. Point the reader at the
   `GAP` heading in `tasks/pos-access-and-menu/RESEARCH.md`: a 4–6 digit PIN has at most 10^6 values,
   so anyone holding the tablet holds unlimited offline guesses whatever the algorithm — a recorded,
   accepted residual risk, not an oversight, and not something to "fix" by changing the hash here.
3. **It must never reach a dashboard page or a load function's return value.** SvelteKit serialises
   load data into the page HTML and into `__data.json`, which is exactly the reasoning the `Principal`
   comment in `src/lib/server/auth/session.ts` gives for never projecting `users.*`. The only caller
   is T-20's `GET /api/pos/employees`. Write that restriction into the file's comment.
4. Name the returned field `pinPhc` on purpose: `SECRET_KEY_PATTERN` in
   `src/lib/server/audit/index.ts` (`/pass|pin|token|hash|secret|cookie|authorization/i`) matches it,
   so if anyone ever passes one of these objects into `writeAudit` the write throws instead of
   writing a credential into an append-only table. The name is a tripwire, and that is worth a
   comment.
5. Select the five columns **explicitly** — `users.id`, `users.displayName`, `users.role`,
   `users.isActive`, `users.pinHash` — never `select()` the whole row. `email`, `passwordHash`,
   `failedPasswordCount`, `passwordLockedUntil`, `failedPinCount` and `pinLockedUntil` must not leave
   the server. Use the property name **T-06** declared in `src/lib/server/db/schema/users.ts`; if it
   is not `pinHash`, follow the schema file.
6. Filter `restaurantId = restaurantId` **and** `isActive = true` in the query itself, never in the
   caller — there is no tenant-less read of this table. Order by `role` then `displayName` so the
   list is stable between syncs. `isActive` is still returned even though only active rows come back:
   it keeps the shape honest for the device's cached copy and costs nothing.
7. Include the **owner**. Spec 7: "The owner also has a POS PIN, used to approve sensitive actions",
   and invariant 9 requires owner-PIN approval for refunds, voids of sent items, comps and the rest —
   which must work offline, so the owner's hash has to be in the same bundle. The `role` field is
   returned precisely so T-25's employee-select screen can decide what to render; that is a screen
   decision, not a query decision.
8. Employees whose `pinPhc` is `null` are returned as they are. They cannot sign in — T-12 refuses a
   null hash — and T-25 renders them as unavailable; hiding them would make "why is Sam missing from
   the till?" unanswerable from the screen.

**Tests:** `src/lib/server/auth/employee-directory.integration.test.ts` — the `integration` project,
built like `src/lib/server/auth/login.integration.test.ts`.
- Two restaurants each with employees: `listPosEmployees(db, restaurantA)` returns only restaurant
  A's rows. Assert on the ids, not just the count.
- An `isActive: false` cashier is excluded, while the same restaurant's active waiter is returned.
- The owner **is** included, with `role: 'owner'`.
- An employee with `pinHash: null` is returned with `pinPhc: null`.
- Shape lock: `Object.keys(rows[0]).sort()` equals
  `['displayName', 'id', 'isActive', 'pinPhc', 'role']`. This is the test that fails the day somebody
  widens the query to `select()` and quietly starts shipping `passwordHash` to a tablet.
- A round trip that proves the bundle is usable offline: `verifyPin('1234', rows[0].pinPhc!)` from
  `src/lib/pin` returns `true` for an employee seeded with `hashPin('1234')`.
- A revoked device receiving nothing is asserted at the **route** level in T-20, not here — this
  function takes a `restaurantId` and knows nothing about devices. Say so in a comment so nobody adds
  a device parameter to it.

**Done when:** `pnpm test:integration src/lib/server/auth/employee-directory.integration.test.ts`
passes, `pnpm check` and `pnpm lint` are clean, and
`grep -rn "listPosEmployees" 'src/routes/(dashboard)'` prints nothing. (Quote the path: an unquoted
`(dashboard)` is a shell syntax error in both bash and zsh, not a failing check.)

**Watch out:** this is the one read in the codebase that intentionally returns a credential
derivative. Anyone reviewing it will want to remove the field; the comment from step 2 is what stops
that, so write it properly rather than as a one-liner.

---

### T-16 — Add the POS device resolution helper for non-dashboard routes

**Needs:** T-13 (`DEVICE_COOKIE`, `validateDeviceToken`)
**Files:**
- `src/lib/server/auth/pos-context.ts` — NEW
- `src/app.d.ts` — EDIT (add `posDevice` to `interface Locals`, beside `restaurantId`, and extend the
  comment that already explains why `restaurantId` is dashboard-only)
- `src/hooks.server.ts` — EDIT (inside `handleSession`, beside the existing
  `event.locals.restaurantId = null;` and `event.locals.sessionToken = null;` initialisers at the top
  of the handler)
- `src/lib/server/auth/pos-context.integration.test.ts` — NEW
**Spec:** 7 (PIN login is accepted only from registered devices; the owner can revoke a device), 8
(server enforcement: an unauthorised call gets `403 Forbidden`), 9 (HttpOnly + Secure cookies)
**Invariants:** 12 (POS access = registered device + PIN; the device cookie is revocable from the
dashboard), 8 (permissions enforced server-side on every route, reads included)

**Do:**

1. **Why this file exists, and it must be the opening comment.** `src/hooks.server.ts`'s
   `handleSession` sets `event.locals.restaurantId` **only** when `event.route.id` starts with
   `/(dashboard)`, and slides the session cookie only there. Both `src/app.d.ts` and the hook carry
   the same comment: "a future POS or sync route must resolve its tenant from the REGISTERED DEVICE
   row and its actor from the queued operation, never from whichever owner last logged in on that
   browser. Leaving this null outside the dashboard means such a route fails loudly the first time
   somebody wires it to locals by habit." This helper is that resolution. It **must never** fall back
   to `event.locals.user` or `event.locals.restaurantId`, and it must not consult `SESSION_COOKIE`.
2. Create `src/lib/server/auth/pos-context.ts` exporting
   ```ts
   export type PosDeviceContext = { restaurantId: string; deviceId: string; deviceCode: string };
   export async function requireDevice(event: RequestEvent, database: Executor = db):
     Promise<PosDeviceContext>
   ```
   `RequestEvent` from `@sveltejs/kit`, `Executor` from `./session`, `db` from `../db/client`, and
   `DEVICE_COOKIE` / `validateDeviceToken` from `./pos-device` (T-13). The default parameter keeps
   route call sites to one argument while letting the integration test drive the test database
   handle, exactly as `route-guards.integration.test.ts` drives the real hook.

   **The contract — every `/api/pos/*` route in Phase 3 calls this and nothing else:**

   ```ts
   import { requireDevice } from '$lib/server/auth/pos-context';
   const device = await requireDevice(event); // { restaurantId, deviceId, deviceCode }
   ```

   The specifier is `$lib/server/auth/pos-context`; there is no `$lib/server/permissions/device` in
   this plan. The three fields are the whole context — there is no `code` and no `label` on it; a
   route that wants the label reads the row itself.
3. Body: read `event.cookies.get(DEVICE_COOKIE)`. If it is absent, `error(403, 'Forbidden')`. Call
   `validateDeviceToken(database, token)`; if it returns `null` — no such device, or `revoked_at` is
   not null — `error(403, 'Forbidden')`. Otherwise set `event.locals.posDevice = context` and return
   the context.
4. **403 on every failure, never a 303 redirect.** `requireUser` in
   `src/lib/server/permissions/index.ts` redirects an anonymous browser to `/login` because a person
   without an identity can go and get one; an unregistered device has no such page, and `/api/pos/*`
   is a JSON API where a redirect would be parsed as a successful response. Spec 8 names the status:
   "the server returns 403 Forbidden. So hiding buttons in the frontend is not considered security."
5. `requireDevice` answers **who the device is**, not **what the employee may do**. Each `/api/pos/*`
   route in Phase 3 still checks its own permission key and returns `403` on its own — T-22 is the
   test that proves every one of them does. Write that sentence into the file so nobody treats a
   device check as an authorisation check.
6. In `src/app.d.ts`, add to `interface Locals`:
   ```ts
   /**
    * The registered POS device for this request, or null. Set by requireDevice()
    * in $lib/server/auth/pos-context — NEVER by the hook, and never inferred from
    * a session cookie. A route that needs a tenant outside /(dashboard) reads it
    * from here after calling requireDevice, not from restaurantId above.
    */
   posDevice: import('$lib/server/auth/pos-context').PosDeviceContext | null;
   ```
7. In `src/hooks.server.ts`, add `event.locals.posDevice = null;` to the three initialisers at the
   top of `handleSession`, so the declared type is true on every request rather than `undefined` on
   most of them. Change nothing else in the hook — opening `/pos` and `/api/pos` in the guard is
   **T-17**'s task, and `PUBLIC_ROUTE_IDS` must not be touched here.

**Tests:** `src/lib/server/auth/pos-context.integration.test.ts` — the `integration` project, because
`validateDeviceToken` reads the database. Build the fake event from the `makeEvent` helper in
`src/routes/route-guards.integration.test.ts` (around line 51): a `Map` cookie jar behind
`cookies.get/getAll/set/delete`, `locals: {} as App.Locals`, a `route.id`, a `url` and a `request`.
Capture the thrown status the way `src/lib/server/permissions/guards.test.ts` does — catch and read
`(thrown as { status?: number }).status` — rather than asserting merely that it threw. These cases
are the **device half** of spec 29's "a permission check test on every POS API route"; the mandatory
walk itself is T-22, over the routes, and the marker lives there rather than on this helper.
- **No device cookie → status `403`.**
- A cookie holding a token that was never registered → `403`.
- A **revoked** device's token → `403`, proving revocation is enforced on the read path and not only
  at registration.
- A valid device returns `{ restaurantId, deviceId, deviceCode }` matching the registered row, and
  sets `event.locals.posDevice` to the same object.
- **A valid owner session and no device cookie still gets `403`**: put a real `Principal` on
  `event.locals.user` and a real `restaurantId` on `event.locals.restaurantId`, give the jar no
  device cookie, and assert `403`. This is the regression that the whole file exists to prevent.
- Tenant isolation: a device registered to restaurant A resolves to A's `restaurantId` even when
  `event.locals.restaurantId` has been set to restaurant B.

**Done when:** `pnpm test:integration src/lib/server/auth/pos-context.integration.test.ts` passes,
`pnpm check` and `pnpm lint` are clean, and
`grep -n "locals.user\|locals.restaurantId" src/lib/server/auth/pos-context.ts` prints nothing.

**Watch out:** `error(403, …)` from `@sveltejs/kit` **throws**; it does not return. Do not write
`return error(403, 'Forbidden')` and do not wrap the call in a `try` that swallows it. And
`requireDevice` is `async` while `requireUser`/`requireOwner`/`requirePermission` are synchronous —
every route call site needs `await`, and a forgotten `await` yields a pending promise that is truthy,
so the route would proceed as if the device were valid.
