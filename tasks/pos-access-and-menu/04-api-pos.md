# Phase 3 — API, access half

The HTTP surfaces the till needs before it can show a PIN screen: opening `/pos` and `/api/pos` in
the deny-by-default route guard, registering the device with the owner's email and password,
verifying an employee PIN, serving the employee directory, and revoking the device from the
dashboard. Every route here checks its own permission **server-side** and returns `403` — hiding a
button is not security (invariant 8, spec 8: *"the server returns 403 Forbidden. So hiding buttons in
the frontend is not considered security."*). Three of the four endpoints live under
`src/routes/api/pos/` and **not** under `src/routes/(pos)/`; revocation is the fourth and is a
**dashboard form action** (T-21), because spec 7 places that control on the dashboard and a form
action gets SvelteKit's origin check for free on its form-encoded body. The three `/api` endpoints
are there for two reasons that are both load-bearing: `eslint.config.js` forbids importing
`$lib/server/**` from `src/routes/(pos)/**/*.{ts,svelte}`, so POS server work cannot be a
`+page.server.ts` inside the group at all; and `src/routes/route-guards.test.ts` only walks routes
that have a `+page.server.ts`, `+layout.server.ts` or `+server.ts`, so putting the endpoints under
`src/routes/api/` is what makes spec 29's *"Permission checks on every POS API"* mechanically
checkable rather than a promise.

**Depends on:** Phase 2 (T-11 … T-16). Nothing in this phase may be started before T-16 exists,
because two of its five routes are guarded by `requireDevice` — T-19 (`/api/pos/pin`) and T-20
(`/api/pos/employees`). T-18 authenticates from the **body** with the owner's email and password and
is exempted by name in T-22 step 3; T-21 authenticates from the dashboard session with
`requirePermission(event, 'admin.devices')`; T-17 is the hook itself.

---

### T-17 — Open `/pos` and `/api/pos` in the route guard, deliberately

**Needs:** T-02 (the `/pos` URL prefix decision), T-16 (`requireDevice`)
**Files:**
- `src/lib/public-routes.ts` — EDIT (the whole file is one exported `Set`; add entries and two new
  exports beside it)
- `src/hooks.server.ts` — EDIT (inside `handleGuard`, at the top of the function body and at the
  `PUBLIC_ROUTE_IDS.has(id)` branch; do not touch `handleTheme` or `handleSession`)
- `src/routes/route-guards.test.ts` — EDIT (the `if (PUBLIC_ROUTE_IDS.has(routeId)) return;` lines at
  ~63 and ~87, and the exact-contents assertion at ~103)
- `src/routes/route-guards.integration.test.ts` — EDIT (add new `describe` blocks at the end; keep
  every existing one)
**Spec:** 6 (the POS keeps working with no connection, so it cannot depend on a dashboard session),
7 (*"Only a registered device may show the PIN screen"* — the device cookie is the credential), 8
(server enforcement, 403), 9 (HttpOnly + Secure cookies, SvelteKit's origin/CSRF check stays on)
**Invariants:** 8 (permissions enforced server-side on every route, reads included), 12 (POS access =
registered device + PIN; sessions are HttpOnly + Secure + SameSite cookies, never `localStorage`;
SvelteKit's origin check stays ON)

Read the closing comment at the bottom of `src/hooks.server.ts` before editing anything. It says:
*"(pos) and /api are in NEITHER list yet, on purpose. When those surfaces arrive they authenticate by
registered device and employee PIN rather than by this cookie, and the deny-by-default rule forces
them to be added here deliberately, with their own tenant and actor resolution."* This task is that
deliberate addition. Update that comment to say what was decided, rather than deleting it.

**"Public" here means "no DASHBOARD session required". It does not mean unauthenticated.** A POS page
is reachable with no `matcami_dashboard_session` cookie because its credential is the long-lived
HttpOnly device cookie plus an employee PIN — and because a POS page must still render its device
registration screen when no device cookie exists at all, which is impossible if the hook redirects
the browser to `/login` first.

**Do:**

1. In `src/lib/public-routes.ts`, add two route ids to `PUBLIC_ROUTE_IDS` and export a prefix list
   and a matcher beside it. Keep the existing doc comment and extend it:

   ```ts
   export const PUBLIC_ROUTE_IDS: ReadonlySet<string> = new Set([
     '/',
     '/login',
     '/register',
     // The POS shell index. Route GROUPS are not URL segments, so this id is the
     // page at src/routes/(pos)/pos/ that T-23 creates, serving the URL /pos.
     '/(pos)/pos',
     // Credential-authenticated, exactly like /login: it takes the owner's email
     // and password in the body and answers with no session of its own. It is the
     // ONE /api route that is not device-guarded, and T-22 asserts it by name.
     '/api/pos/register'
   ]);

   /** Route ids UNDER these are public too — the POS screens T-24..T-26 add. Pages only, never /api. */
   export const PUBLIC_ROUTE_PREFIXES: readonly string[] = ['/(pos)/pos'];

   export function isPublicRouteId(id: string): boolean {
     if (PUBLIC_ROUTE_IDS.has(id)) return true;
     return PUBLIC_ROUTE_PREFIXES.some((prefix) => id.startsWith(prefix + '/'));
   }
   ```

   The prefix list exists so T-24, T-25 and T-26 can add screens under `/pos/…` without a fourth
   edit to the guard. It covers **pages only**: no `/api` id may ever be added to it.
2. In `handleGuard`, **before** the `isPublicRouteId` branch, add a same-origin check for
   state-changing `/api` requests:

   ```ts
   const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
   if (id.startsWith('/api/') && UNSAFE_METHODS.has(event.request.method)) {
     if (event.request.headers.get('origin') !== event.url.origin) error(403, 'Forbidden');
   }
   ```

   It is first so that `/api/pos/register` being public does not skip it. It exists because
   SvelteKit's built-in origin check only covers `application/x-www-form-urlencoded`,
   `multipart/form-data` and `text/plain` bodies — the POS endpoints post `application/json`, which
   that check does not see. Invariant 12 keeps the built-in check on; this adds the case it omits,
   in one place, rather than in four route files. Behind Nginx `event.url.origin` depends on the
   `ORIGIN` environment variable for adapter-node, which `docs/deployment.md` already covers.
3. In `handleGuard`, replace both `PUBLIC_ROUTE_IDS.has(id)` with `isPublicRouteId(id)`. Leave the
   inner redirect exactly as it is — it fires only for `id === '/login' || id === '/register'`, so a
   signed-in owner opening `/pos` on the counter tablet is **not** bounced to `/dashboard`. That is
   the behaviour T-24 depends on: the owner signs in on the dashboard, walks to `/pos`, and registers
   the device there.
4. In `handleGuard`, after the public branch and **before** the `if (!user)` deny-by-default
   redirect, let `/api` through to the route module:

   ```ts
   // /api routes resolve their own tenant and actor: a POS endpoint from the
   // registered device row (requireDevice), a dashboard endpoint from the session
   // (requirePermission). They must answer 403 with a JSON body, never a 303 to an
   // HTML login page that a fetch() caller cannot follow. T-22's walk asserts that
   // every +server.ts under src/routes/api/ actually calls one of those guards, so
   // a route added later cannot inherit this pass-through and stay open.
   if (id.startsWith('/api/')) return resolve(event);
   ```
5. Do **not** change `handleSession`. It already sets `locals.restaurantId` and re-sets the session
   cookie only when `isDashboardRoute(event.route.id)` is true, so a POS request neither inherits a
   tenant from whichever owner last signed in on that browser nor renews an owner cookie left on the
   counter. Add the assertions in step 7 to pin that, and extend `handleSession`'s existing comment
   to name `/(pos)/pos` as the surface it is protecting against.
6. In `src/routes/route-guards.test.ts`: import `isPublicRouteId`, `PUBLIC_ROUTE_PREFIXES` alongside
   `PUBLIC_ROUTE_IDS` from `../lib/public-routes`, use `isPublicRouteId(routeId)` in place of
   `PUBLIC_ROUTE_IDS.has(routeId)` in both `it.each` bodies, and change the exact-contents assertion
   at ~line 103 to the new, deliberate list:

   ```ts
   expect([...PUBLIC_ROUTE_IDS].sort()).toEqual([
     '/', '/(pos)/pos', '/api/pos/register', '/login', '/register'
   ]);
   expect([...PUBLIC_ROUTE_PREFIXES].sort()).toEqual(['/(pos)/pos']);
   ```

   Keep that test's comment — *"If this grows, someone made a route public"* — and add one line
   saying what each new entry buys and why it is safe.
7. In `src/routes/route-guards.integration.test.ts`, which drives the REAL `handleSession` and
   `handleGuard` through its existing `runHook` / `runBothHandlers` helpers, add the cases in
   **Tests** below. Use the existing `makeEvent(routeId, token, method)` helper; it already accepts a
   method.

**Tests:**
- MANDATORY (spec 29 — a permission check test on every POS API route). In
  `route-guards.integration.test.ts`, driving the real hook:
  - `runHook('/(pos)/pos')` with no cookie returns `{ status: 200 }` — **not** a 303 to `/login`.
  - `runHook('/(pos)/pos/register')` with no cookie returns `{ status: 200 }`, proving
    `PUBLIC_ROUTE_PREFIXES` covers the child screens T-24..T-26 add.
  - `runHook('/(dashboard)/dashboard')` with no cookie still returns `303` with a
    `/login?next=` location — the existing behaviour must not have been widened.
  - `runHook('/api/pos/pin')` with no cookie returns `200` **from the hook** (pass-through), because
    the 403 is the route module's job via `requireDevice`, not the hook's. Assert the status is not
    `303`; a redirect here would hand a `fetch()` caller an HTML login page.
  - A `POST` to `/api/pos/pin` whose `Origin` header is `https://evil.test` while `event.url.origin`
    is `http://localhost` throws `403`. Build it with `makeEvent('/api/pos/pin', undefined, 'POST')`
    and set the header on `event.request`.
- `runHook('/(pos)/pos', ownerToken)` returns `200` and **not** a `303` to `/dashboard` — a signed-in
  owner reaching the till is the registration flow, not a mistake.
- Session isolation: for `makeEvent('/(pos)/pos', ownerToken)`, after `runBothHandlers`,
  `event.locals.user` is non-null, `event.locals.restaurantId` is `null`, and `event.cookies.set` was
  never called with `SESSION_COOKIE`. Install the spy with
  `const setSpy = vi.fn(); event.cookies.set = setSpy;` before the call, and import `vi` from
  `vitest`. Compare against `makeEvent('/(dashboard)/dashboard', ownerToken)`, where the spy **is**
  called — otherwise the assertion passes for the wrong reason.

**Done when:** `pnpm test src/routes/route-guards.test.ts` and
`pnpm test:integration src/routes/route-guards.integration.test.ts` both pass, `pnpm check` and
`pnpm lint` are clean, and `grep -n "PUBLIC_ROUTE_IDS" src/lib/public-routes.ts src/hooks.server.ts
src/routes/route-guards.test.ts` shows the list is still defined in exactly one place and imported
everywhere else.

**Watch out:** **`/pos` is claimed by the till, so the dashboard's POS page cannot use it.** SvelteKit
refuses to build two routes that resolve to the same URL, and `src/routes/(pos)/pos/` (T-23) and a
hypothetical `src/routes/(dashboard)/pos/` both resolve to `/pos`. T-21 and T-29 therefore put the
dashboard page at `/device`. Do not "tidy" that to `/pos` — and do not "tidy" it to a URL that merely
*starts with* `pos` either. **Service-worker scope matching is a plain string prefix match over the
whole URL, not a path-segment match** (the W3C ServiceWorker specification's "Match Service Worker
Registration" algorithm — see w3c/ServiceWorker#1272, whose canonical example is a scope of
`https://www.google.com/maps` matching `https://www.google.com/mapsearch`; MDN's prose implies
path-segment matching and **MDN is wrong on this point**). So T-27's worker, registered at scope
`/pos`, would control `/pos-device`, `/poster` and every other dashboard path beginning with those
three characters, and would serve that authenticated HTML and its `__data.json` out of Cache Storage
after `/logout`, which does not clear it. `/device` cannot be prefixed by `/pos` under any matching
rule, so the collision is removed structurally rather than by a rule somebody has to remember. T-02
records that rule in `CLAUDE.md` and T-45 asserts it with a test: **no route outside the `(pos)`
group may have a path beginning with the characters `pos`, because the service-worker scope is a
string prefix.** The scope literal itself stays `/pos` with no trailing slash — SvelteKit's default
`trailingSlash: 'never'` means there is no `/pos/` URL, so a `/pos/` scope would leave the till's own
landing screen uncontrolled and unable to work offline.
Second trap: route group names **are** part of `event.route.id` (`/(pos)/pos`) but are **not** part of
the URL (`/pos`). `PUBLIC_ROUTE_IDS` holds route ids; the hook compares against `event.route.id`.
Writing `'/pos'` there silently matches nothing and every POS page stays behind a login redirect.

---

### T-18 — Create `POST /api/pos/register`

**Needs:** T-13 (`registerDevice`, the device cookie helpers), T-14 (the `pos.device.registered`
audit event), T-17 (the route guard opens `/api` and adds the same-origin check)
**Files:**
- `src/routes/api/pos/register/+server.ts` — NEW
- `src/routes/api/pos/register/register.integration.test.ts` — NEW
**Spec:** 7 (*"Owner logs in on the POS device (email + password) → 'Register this device as POS1' →
Server issues a long-lived device cookie (HttpOnly, Secure) → PIN login accepted only from registered
devices"*), 9 (cookie sessions, HttpOnly + Secure + SameSite), 31 (MVP = **one** registered POS
device)
**Invariants:** 8 (server-side permission on every route, 403), 10 (the audit row is written in the
SAME transaction as the action), 11 (timestamps `timestamptz`), 12 (long-lived HttpOnly + Secure
device cookie, revocable from the dashboard; never `localStorage`)

**Do:**

1. Export `export const POST: RequestHandler = async (event) => { … }` from
   `@sveltejs/kit`. Refuse anything whose `content-type` is not `application/json` with
   `json({ error: 'unsupported_media_type' }, { status: 415 })`. Parse the body with a **zod** schema
   declared in this file — zod is server-side only in this codebase and no schema is ever imported
   into a `.svelte` component:

   ```ts
   const registerSchema = z.object({
     email: z.string().trim().toLowerCase().min(1).max(320).email(),
     password: z.string().min(1).max(MAX_PASSWORD_BYTES),   // from $lib/server/auth/password
     label: z.string().trim().min(1).max(60)                // e.g. "Counter tablet"
   });
   ```

   On a parse failure return `json({ error: 'invalid_request' }, { status: 400 })` and echo nothing
   back — never the password, and never the email.
   **The device code is NOT in the body, and the schema above must never grow a field for it.** T-13
   **allocates** the code and returns it — its step 6 reads every `deviceCode` for this restaurant,
   revoked rows **included**, and takes `max(n) + 1` — so the first registration gets the literal
   `'POS1'` without this route ever naming it. A client that could pick the code could later pick the
   invoice-number prefix.
2. Get `{ ip, userAgent }` from `requestContext(event)` (`$lib/server/audit`) and verify the
   credentials with the **existing** login path — `loginWithPassword(db, { email, password }, { ip,
   userAgent })` from `$lib/server/auth/login`. Do not write a second password check anywhere: that
   function owns the per-IP throttle (`consume`, run *before* any hashing), the constant-time dummy
   verify for unknown emails, the five-attempt lockout, and the `login.failed` /
   `login.locked_out` / `login.rejected_locked` / `login.success` audit rows. Map its result:
   - `reason: 'throttled'` → `json({ error: 'too_many_attempts' }, { status: 429, headers: {
     'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) } })`.
   - `reason: 'invalid'` **and** `reason: 'locked'` → the identical response,
     `json({ error: 'invalid_credentials' }, { status: 403 })`. One body and one status for both, on
     purpose: `loginWithPassword` already collapses "unknown email", "not the owner", "deactivated"
     and "wrong password" into `'invalid'`, so this endpoint cannot be used to discover which
     addresses exist, which accounts are locked, or who the owner is. **403, not 401** — spec 8's
     status for "you may not do this", and the status T-22's mandatory walk asserts for every POS
     API route.
3. On success `loginWithPassword` has **already created a dashboard session row and returned its
   token**, along with `restaurantId` and `userId`. Read that as a fact of the function you are
   reusing, not an accident: step 4.4 deletes the session. Re-assert the role as a second layer —
   select `role` and `restaurantId` for `result.userId` from `users` and, if `role !== 'owner'`,
   delete the session it just created, clear the session cookie and return the same
   `403 invalid_credentials`. This must never fire today (login.ts refuses non-owners at line ~95);
   it exists so a later relaxation of `login.ts` cannot silently turn device registration into a
   cashier capability.
4. Open ONE `db.transaction(async (tx) => { … })` and do all of the following inside it:
   1. **Refuse a second device, and take the lock that makes the refusal race-safe.** `select id from
      posDevices where restaurantId = result.restaurantId and revokedAt is null`, with
      `.for('update')`. If a row comes back, stop: skip `registerDevice`, write no audit row, touch
      the existing device not at all, and return a sentinel from the transaction callback
      (`{ ok: false, reason: 'already_registered' }`) that step 6 turns into
      `json({ error: 'device_already_registered' }, { status: 409 })` — the response is built after
      the callback, the way T-19 step 5 builds its own. Spec 31's MVP is **one** registered POS
      device, and T-13 step 7 delegates that enforcement to this route by name: *"this function does
      not revoke, supersede or replace anything… **T-18 is where that is enforced**, with a
      `.for('update')` select and a `409 device_already_registered` when an active row exists."*
      Registering silently over a live device would leave a second tablet armed with a valid cookie
      nobody knows about; the owner revokes the old one from the dashboard (T-21) first, which is
      exactly what T-24 step 7 tells the screen to say — *"a device already registered (tell them to
      revoke it from the dashboard first)"*. The `.for('update')` is what stops two concurrent
      registrations both finding nothing and both inserting. Before returning the sentinel, still make
      step 4.4's first call — `invalidateSession(tx, sessionIdFromToken(result.token))` — so a refused
      registration leaves no orphan session row behind; leave any session cookie already in this
      browser alone, because nothing changed for it.
      **Do not allocate the device code here.** T-13 step 6 owns the allocator, and a code is burned,
      never reused: T-05's `pos_devices_restaurant_device_code_unique` is deliberately **not** partial
      on `revoked_at is null`, and its "Watch out" explains why — reusing `POS1` would put two devices
      behind one printed invoice prefix and `POS1-000001` would then name two different sales. So
      after `POS1` has been revoked the next registration takes `POS2`, decided inside T-13.
   2. `registerDevice(tx, { restaurantId: result.restaurantId, actorUserId: result.userId, label })`
      from `$lib/server/auth/pos-device` (T-13), destructured as
      `{ deviceId, deviceCode, token, expiresAt }`. The raw token is returned once and is never
      stored — the row holds its SHA-256 hash, the same idiom `sessions.id` uses. **The field names
      are T-13's contract, and this route matches them rather than amending it:** the actor is
      `actorUserId` (never `ownerUserId`), `label` is already declared on its `args`, and
      `deviceCode` is **returned, never passed in**. `expiresAt` is
      `now + DEVICE_COOKIE_MAX_AGE_SECONDS` expressed as a `Date`, computed there so step 5 can set
      the cookie without recomputing the arithmetic. Do **not** insert the `pos_devices` row from
      this route, and do **not** rewrite T-13 to fit this one: 03-domain-access.md's phase header
      makes its printed signature authoritative — *"Phase 3's routes must match it exactly, and a
      route that cannot is a bug in the route, not a licence to rewrite the module."*
   3. `writeAudit(tx, { restaurantId: result.restaurantId, actorUserId: result.userId,
      subjectUserId: null, event: 'pos.device.registered', details: { deviceCode, label }, deviceId,
      ip, userAgent })` — in this transaction, not after it (invariant 10). `details` is **exactly**
      `{ deviceCode, label }`: T-14 fixes that union member as
      `| { event: 'pos.device.registered'; details: { deviceCode: string; label: string } }` and
      forbids widening the union, so a **missing** `label` is a type error just as an extra key would
      be. If T-14's shape differs, use **T-14's** and adjust here. **Pass `deviceId`** — the id
      `registerDevice` just returned. T-14 step 6 added optional `deviceId` / `clientOpId` to
      `AuditEntry` beside `ip` and `userAgent`, and T-07 step 1 names this row as one of the first
      device-sourced rows the plan writes: *"This plan writes the first device-sourced rows (T-19's
      PIN logins and T-18's device registration)"*. Pass **no** `clientOpId`: the owner typed this on
      a keyboard at the counter, it is not a queued device operation, and this plan has no sync queue
      to replay it from. `assertNoSecrets` runs inside `writeAudit`
      and throws on any key matching `/pass|pin|token|hash|secret|cookie|authorization/i`, so never
      put the token, the cookie or the owner's password anywhere near `details`.
   4. **Destroy the owner's dashboard sessions on this browser**, as its own step here rather than
      inside `registerDevice` (which has no business knowing about dashboard sessions): call
      `invalidateSession(tx, sessionIdFromToken(result.token))` for the session step 2 created, and,
      if `event.cookies.get(SESSION_COOKIE)` is present, `invalidateSession(tx,
      sessionIdFromToken(thatToken))` for it too. Both helpers are exported by
      `$lib/server/auth/session`. Do this inside the transaction so a registered device and the owner
      session that created it can never coexist. Use **exactly these two session ids** — not
      `invalidateAllForUser`, which would also sign the owner out of the laptop in the office, a
      side effect nobody asked for.
5. After the transaction commits, and only on the `ok` branch:
   `setDeviceCookie(event.cookies, token, expiresAt)` (T-13 — **three** arguments, the third being
   the `expiresAt` step 4.2 returned: T-13 step 10 declares it as
   `setDeviceCookie(cookies, token, expiresAt?)` and says *"passing it is what T-18 does"*, and it
   names the same instant as the helper's own `DEVICE_COOKIE_MAX_AGE_SECONDS`, with `path: '/'` so
   the cookie is sent to both `/pos/…` and `/api/pos/…`, and HttpOnly, SameSite and Secure from
   SvelteKit's defaults — the same three-argument shape
   `setSessionCookie(cookies, token, expiresAt)` already has in `src/lib/server/auth/session.ts`),
   then `deleteSessionCookie(event.cookies)` from `$lib/server/auth/session`.
6. On the `ok` branch return `json({ deviceCode, label }, { status: 201 })`; on step 4.1's
   short-circuit return `json({ error: 'device_already_registered' }, { status: 409 })` and set no
   cookie. **Never put the device token in the response body**; it lives only in the HttpOnly
   cookie, exactly as the session token does.

**Tests:** in `register.integration.test.ts`, importing the real `POST` handler and driving it with a
fake `RequestEvent` built the way `src/routes/route-guards.integration.test.ts` builds one (a cookie
jar backed by a `Map`, `getClientAddress`, a real `Request`). Use `testDb()` from
`$lib/server/db/test/db` and `resetThrottle()` from `$lib/server/auth/throttle` in `beforeEach`, or
the ten-attempt bucket exhausts partway through the file and later cases fail as `429`.
- MANDATORY (spec 29 — a permission check test on every POS API route): a **cashier's** row cannot
  hold credentials (the `users_non_owner_has_no_credentials` CHECK forbids `email` and
  `password_hash` on a non-owner), so prove the rule the other way round — a second restaurant's
  owner credentials register a device for **their own** restaurant and never for restaurant A, and an
  unknown email returns `403 invalid_credentials` with **zero** new `pos_devices` rows. Assert the
  status is exactly `403`.
- A wrong password returns `403` with body `{ error: 'invalid_credentials' }`, writes **one**
  `login.failed` audit row for that owner, and increments `users.failed_password_count` to 1.
- A successful registration returns `201`, inserts exactly one `pos_devices` row with
  `revoked_at IS NULL` and `device_code = 'POS1'`, writes one `pos.device.registered` audit row whose
  `details.deviceCode` is `'POS1'`, whose `details.label` is the posted label and whose
  `audit_log.device_id` is that new row's id, and leaves **zero** rows in `sessions` for that
  owner — assert the count, having created a session before the call so the assertion can fail.
- The response body has no `token`, no `deviceToken` and no `deviceId` key: assert
  `Object.keys(body)` equals `['deviceCode', 'label']`.
- A second registration while one is active is **refused**, never silently honoured: the response is
  `409` with body `{ error: 'device_already_registered' }`, `pos_devices` still holds exactly **one**
  row for that restaurant, no second `pos.device.registered` audit row was written, no `Set-Cookie`
  replaced the device cookie, and `validateDeviceToken(db, firstToken)` still resolves the **first**
  device. Then revoke it (T-13's `revokeDevice`) and register again: now the response is `201`, the
  new row's `device_code` is `'POS2'` (the code is burned, T-05), and `pos_devices` holds **two**
  rows for that restaurant with exactly one `revoked_at IS NULL`.
- `content-type: text/plain` returns `415`; a body missing `label` returns `400`; a body that
  **contains** `deviceCode` still registers as `POS1` — the field is ignored, never honoured.

**Done when:** `pnpm test:integration src/routes/api/pos/register/register.integration.test.ts`
passes, `pnpm check` and `pnpm lint` are clean, and a manual `curl -X POST
http://localhost:5173/api/pos/register -H 'content-type: application/json' -H 'origin:
http://localhost:5173' -d '{"email":"…","password":"…","label":"Counter tablet"}' -i` returns `201`
with a `Set-Cookie` carrying `HttpOnly` on the device cookie and an expired
`matcami_dashboard_session`.

**Watch out:** `loginWithPassword` **commits on every branch, including failure** — its own comment
explains that throwing inside the callback would roll back the very failure counters and audit rows
the failure exists to write. So by the time you read its result, a session row exists on success and
counters have moved on failure. Do not wrap it in your transaction; call it first, then open yours.
Second trap: `assertNoSecrets` walks `details` at every depth and throws on a *key* whose name
matches the secret pattern. `{ deviceCode }` and `{ label }` are both fine; `{ deviceToken }`,
`{ pinPolicy }` and `{ cookieName }` all throw, and the audit row is append-only, so this is a hard
failure at write time, not a lint.

---

### T-19 — Create `POST /api/pos/pin`

**Needs:** T-12 (server-side PIN verification and lockout), T-14 (the `pos.pin.*` audit events),
T-16 (`requireDevice`), T-17 (the route guard opens `/api`)
**Files:**
- `src/routes/api/pos/pin/+server.ts` — NEW
- `src/routes/api/pos/pin/pin.integration.test.ts` — NEW
**Spec:** 6 (an offline PIN login is recorded locally and synced to the audit log later; nothing in
this plan queues one, because this plan's till cannot sell), 7 (*"PINs are 4–6 digits… After 5 wrong
attempts, the employee is locked out for 5 minutes and an audit event is logged"*), 8 (server
enforcement, 403)
**Invariants:** 8 (server-side permission on every route, 403), 10 (sensitive actions audit-logged,
in the same transaction — failed PINs are named explicitly; T-12 writes the row inside the
transaction this route opens), 5 (every device-generated operation carries an idempotency key and a
retry MUST be a no-op — step 6), 12 (POS
access = registered device + PIN; 4–6 digits; slow salted hash, never reversible, never logged; 5
wrong attempts lock for 5 minutes and write an audit event)

**Do:**

1. `export const POST: RequestHandler = async (event) => { … }`. **First line of the body:**
   `const device = await requireDevice(event);` from `$lib/server/auth/pos-context` (T-16 — that is
   the file it creates; there is no `src/lib/server/permissions/device.ts`). It reads the
   `matcami_pos_device` cookie, resolves the row and throws `error(403, 'Forbidden')` when the cookie
   is absent, unparseable, unknown or `revoked_at IS NOT NULL`. Nothing else in this handler runs
   before it. The returned `PosDeviceContext` is exactly `{ restaurantId, deviceId, deviceCode }` —
   three fields, no `code` and no `label`; the tenant comes from **there** and from nowhere else.
   `event.locals.restaurantId` is `null` outside the dashboard by design, and a `restaurantId` in the
   body would be a cross-tenant write.
2. Require `application/json` (else `415`) and parse with zod:

   ```ts
   const pinSchema = z.object({
     employeeId: z.string().uuid(),
     pin: z.string().regex(/^\d{4,6}$/),         // spec 7: 4–6 DIGITS
     clientOpId: z.string().uuid().optional()    // the device's idempotency key — step 6
   });
   ```

   A malformed body is `400 { error: 'invalid_request' }`. The parsed `pin` never leaves this
   function: it is not logged, not echoed, not put in `details`, and not returned.
   **`clientOpId` is the device-generated idempotency key** (invariant 5, spec 6). It is
   `.optional()` on the wire — a caller may legitimately have none — and is forwarded as
   `clientOpId ?? null`, which is exactly what T-12's `PinAttemptContext.clientOpId`, a **required**
   `string | null` field, expects. T-26 generates it with `crypto.randomUUID()` before its first
   `fetch` and reuses that same value when it retries **that** attempt; step 6 is what turns the
   retry into a no-op. A `uuid()` rather than a free string: a key the device can collide with is not
   a key.
3. Get `{ ip, userAgent }` from `requestContext(event)` (`$lib/server/audit`), then open **one**
   `db.transaction` — this route owns it, for the reason step 6 gives — and call T-12's verifier with
   that transaction handle, **never** the `db` singleton:

   ```ts
   const result = await verifyEmployeePin(
     tx,
     { restaurantId: device.restaurantId, employeeId, pin },
     {
       deviceId: device.deviceId,
       deviceCode: device.deviceCode,
       clientOpId: clientOpId ?? null,
       ip,
       userAgent
     }
   );
   ```

   from `$lib/server/auth/pin` (T-12). Three arguments in that order — `DbTx`, `PinAttemptInput`,
   `PinAttemptContext` — and the input field is `employeeId`, the same name the wire uses. `ctx` is
   **required**: `deviceCode` is the field T-12 puts in every `pos.pin.*` audit row's `details`, and
   `deviceId` plus `clientOpId` are T-07's two columns, which T-14 taught `writeAudit` to fill.
   **`deviceId` is not optional here** — a row written with a `clientOpId` and no `deviceId` can never
   be matched to its retry, because the partial `UNIQUE (device_id, client_op_id)` never fires on it
   (PostgreSQL's `NULLS DISTINCT`), and step 6 would then silently stop being a no-op.
   `device.deviceId` is already on `PosDeviceContext`: T-16 returns
   `{ restaurantId, deviceId, deviceCode }`. Do not pass `now`: `ctx.now` exists so T-12's own
   integration test can inject time.
   T-12 step 10 is explicit that this function **does not open a transaction** — it takes the one it
   is handed, exactly as `writeAudit` and T-13's device functions do, because the counter update, the
   lock and the audit row are one indivisible decision that must commit with whatever else the
   request is doing. **This route is what opens it**, and step 6's idempotency lookup and its `23505`
   path are why the whole attempt has to sit inside a transaction this route controls. It returns the
   discriminated result
   `{ ok: true; employee: { id; displayName; role } } | { ok: false; reason: 'invalid' } | { ok:
   false; reason: 'locked'; retryAfterMs }` — the success payload is `employee`, and there is no
   `userId` field on it. T-12 owns the PIN counter pair on `users` — `failed_pin_count` /
   `pin_locked_until` (Drizzle `failedPinCount` / `pinLockedUntil`, added by T-06) — which is
   **separate** from `failed_password_count` / `password_locked_until` so five wrong PINs at the
   counter cannot lock the owner out of the dashboard.
4. **This route writes no audit row.** T-12 writes the `pos.pin.*` audit row inside the transaction
   this route opened: `pos.pin.failed` with `details: { deviceCode, reason, failedCount }`,
   `pos.pin.locked_out` with `{ deviceCode, failedCount, lockedForMs }`, `pos.pin.success` with
   `{ deviceCode, role }` — the exact shapes T-14 pins in the `AuditEvent` union, where the counter is
   **`failedCount`** (never `attemptedCount`) and the duration is **`lockedForMs`** (never minutes).
   If T-14's shapes differ from these, use **T-14's**: it is the contract every consumer quotes. Do
   not import `writeAudit` here. A second row per attempt would double every count this route's own
   tests assert and would break step 6's lookup, which expects at most one row per
   `(device_id, client_op_id)`; the keys would not type-check either, because T-14 types `reason` as
   `'bad_pin' | 'rejected_locked'`, so there is no `unknown_employee` member to write. T-12 also
   writes **zero** rows for an unknown, foreign or inactive employee id, on purpose — the row would
   be about nobody, and it folds that case into `{ ok: false, reason: 'invalid' }`, which this route
   maps to `401`.
5. Map the result to a response **after** the transaction commits — build it outside the
   `db.transaction` callback, from the value that callback returned, so a rolled-back attempt can
   never have had a success response sent for it:
   - `ok: true` → `json({ employeeId: result.employee.id, displayName: result.employee.displayName,
     role: result.employee.role }, { status: 200 })`. Nothing else: no email, no `pinPhc`, no
     permission list. The wire name stays `employeeId`; `result.employee.id` is where it comes from.
   - `reason: 'invalid'` → `json({ error: 'invalid_pin' }, { status: 401 })`. T-12 has already
     collapsed "wrong PIN", "unknown id", "another restaurant's employee", "deactivated" and "no PIN
     set" into this one reason, byte for byte, so the response cannot be used to enumerate which
     employee ids exist on this device.
   - `reason: 'locked'` → `json({ error: 'locked_out', retryAfterMs: result.retryAfterMs },
     { status: 423 })`. **423 Locked** (RFC 4918) rather than 403: it has to be distinguishable from
     the device refusal in step 1, because T-22's mandatory walk asserts that every POS API route
     answers `403` when the device cookie is missing or revoked, and a lockout must not be able to
     satisfy that assertion by accident. The till shows "locked for 5 minutes" from this body.
6. **The idempotency key, and what makes a retry a no-op.** Invariant 5 requires every
   device-generated operation to carry a key and every retry to be a no-op. T-07 added
   `audit_log.device_id` / `client_op_id` with a partial
   `UNIQUE (device_id, client_op_id) WHERE client_op_id IS NOT NULL` **for this route**, and T-12
   stamps both columns on every `pos.pin.*` row it writes. There is still no sync **queue** here —
   `00-overview.md` keeps invariant 5 as a seam, "this plan does not sell, so it leaves `device_id`
   and `client_op_id` in place rather than building a sync queue" — but the key itself is live,
   because T-26 retries a PIN POST whose response was lost on a flaky counter connection, and a
   second audit row for one typed PIN is a lie in an append-only table. Write the following as a
   comment in the file, then implement it:
   - Inside the transaction opened in step 3 and **before** calling `verifyEmployeePin`, when
     `clientOpId` is present, select the prior row: `where device_id = device.deviceId and
     client_op_id = clientOpId`, reading `event`, `subject_user_id` and `details`. At most one row
     exists — the partial UNIQUE guarantees it.
   - **On a hit, do not call the verifier.** No counter moves, no second row is written, and the
     response is rebuilt from the stored row: `pos.pin.success` → `200`, re-reading `displayName` and
     `role` from `users` by `subject_user_id` **scoped to `device.restaurantId`**; `pos.pin.locked_out`
     and `pos.pin.failed` with `details.reason === 'rejected_locked'` → `423` with `retryAfterMs`
     recomputed as `Math.max(0, pinLockedUntil - now)`; `pos.pin.failed` with
     `details.reason === 'bad_pin'` → `401`. The retry therefore returns the answer the lost response
     carried, and step 5's three shapes are the only shapes either path can produce.
   - With no `clientOpId` there is nothing to look up and nothing to deduplicate: run the attempt.
     An unkeyed caller gets no retry protection — the honest behaviour, rather than a silent global
     lock that would make two employees typing PINs at once look like a retry of each other.
   - **The database is the backstop for two retries racing**, where both miss the lookup. Catch the
     unique violation the second commit raises — `error.code === '23505'` **and**
     `error.constraint === 'audit_log_device_client_op_unique'`, asserted on those two fields and
     never on message text, the way `src/lib/server/db/schema-guards/constraints.integration.test.ts`
     already does — and on that pair alone re-run the lookup in a fresh read and answer from the row
     the winner wrote. The loser's transaction rolled back whole, counter increment included
     (invariant 10 keeps the row and the counter together), so nothing partial survives it. Every
     other error rethrows.
7. **This route creates no dashboard session and sets no session cookie.** The till's employee
   identity is not a dashboard login: there is no `createSession`, no `setSessionCookie` and no
   `Principal` here. This plan's till cannot sell, so no employee token is issued either — the later
   plan that lets the till act on the server must decide how the employee identity travels with a
   request, and it is not decided here. Write that as a comment at the bottom of the file so nobody
   fills the gap by habit with a session cookie.

**Tests:** in `pin.integration.test.ts`, importing the real `POST` handler.
- MANDATORY (spec 29 — a permission check test on every POS API route): a request with **no** device
  cookie throws `403`; a request carrying a **revoked** device's cookie throws `403`. Assert the
  status is exactly `403` and that neither call wrote any `audit_log` row.
- MANDATORY (spec 29 — *offline sync: retries never create duplicates*). Post the **same** body
  twice, `clientOpId` included, with the same device cookie: the second call returns the **identical
  status and body** as the first, `audit_log` holds exactly **one** `pos.pin.*` row for that
  `client_op_id`, and `users.failed_pin_count` moved **once**, not twice. Do it for all three
  outcomes — a correct PIN, a wrong PIN, and the fifth wrong PIN that locks — so the replay is proved
  for `200`, `401` and `423`. Then repost the same `employeeId` and `pin` with a **different**
  `clientOpId` and assert a **second** row: the dedupe is per key, not per body. Finally post twice
  with **no** `clientOpId` at all and assert **two** rows — an unkeyed retry is deliberately not
  deduplicated, which is why T-26 always sends one.
- A correct PIN returns `200` with `{ employeeId, displayName, role }` and exactly one
  `pos.pin.success` row (written by T-12, not by this route).
- Five wrong PINs, **each with its own `clientOpId`** (T-26 generates one per attempt, so five
  attempts are five keys and none of them is a retry of another): attempts 1–4 return `401`, the
  fifth returns `423`, exactly one
  `pos.pin.locked_out` row exists alongside exactly four `pos.pin.failed` rows, and a sixth attempt
  **with the correct PIN** still returns `423` while the lock holds. Afterwards `failed_pin_count`
  is `0` and `pin_locked_until` is set — T-12 step 8 resets the counter when it sets the lock — and
  `failed_password_count` is unchanged.
- An `employeeId` belonging to restaurant B, posted with restaurant A's device cookie, returns `401`
  with the identical body as a wrong PIN, writes **zero** audit rows, and does **not** touch
  restaurant B's `failed_pin_count`.
- A `pin` of `123` and a `pin` of `1234567` both return `400` (spec 7: 4–6 digits).
- No response body in this file contains a `pinPhc`, `pinHash`, `passwordHash` or `email` key.

**Done when:** `pnpm test:integration src/routes/api/pos/pin/pin.integration.test.ts` passes,
`pnpm check` and `pnpm lint` are clean,
`grep -n "setSessionCookie\|createSession\|writeAudit" 'src/routes/api/pos/pin/+server.ts'` prints
nothing (no session is issued here, and T-12 writes every audit row), and
`grep -n "clientOpId\|db.transaction" 'src/routes/api/pos/pin/+server.ts'` prints **both** — the key
is forwarded and this route owns the transaction.

**Watch out:** `verifyEmployeePin` takes a `DbTx` and opens **no** transaction of its own, exactly
like T-13's `registerDevice` / `revokeDevice`. Passing the `db` singleton here compiles only if
someone widens T-12's signature, and it leaves the counter update, the lock and the audit row
committing outside the transaction that is supposed to make a retry a no-op — step 6's `23505`
backstop would then have nothing to roll back. T-12 never throws for a failed PIN (it returns a
result object) precisely so an ordinary wrong PIN cannot roll back the caller's transaction; the only
thing that may abort this one is the unique violation step 6 catches. Second trap: `requireDevice` is
`async` while `requireUser` / `requireOwner` / `requirePermission` are synchronous — a forgotten `await` yields a
pending promise that is truthy, so the route would proceed as if the device were valid. And
`audit_log` is append-only in the database (migration `0004_audit_log_append_only.sql` blocks
`UPDATE` and `DELETE`), so a row written with the wrong shape can never be corrected — which is
precisely why this route adds none of its own.

---

### T-20 — Create `GET /api/pos/employees`

**Needs:** T-15 (the employee directory read model), T-16 (`requireDevice`), T-17 (the route guard
opens `/api`), T-08 (the nullable `pos_idle_lock_seconds` column)
**Files:**
- `src/routes/api/pos/employees/+server.ts` — NEW
- `src/routes/api/pos/employees/employees.integration.test.ts` — NEW
**Spec:** 6 (*"Switching employees offline uses PIN hashes cached on the registered device (slow,
salted hashes, refreshed on each sync)"*), 7 (the employee-select screen; only a registered device
may show the PIN screen), 8 (server enforcement, 403)
**Invariants:** 8 (permissions enforced server-side on every POS API route, **reads included** — a
`GET` is not exempt), 12 (POS access = registered device + PIN)

**Do:**

1. `export const GET: RequestHandler = async (event) => { … }`, whose first line is
   `const device = await requireDevice(event);` from `$lib/server/auth/pos-context` (T-16). Without a
   valid, non-revoked device cookie this throws `error(403, 'Forbidden')`. **This is a read and it
   still checks permission**: invariant 8 says every POS API route checks its own permission, reads
   included, and this particular read ships password-equivalent material.
2. Call T-15's read model with the tenant from the **device row**:
   `listPosEmployees(db, device.restaurantId)` from `$lib/server/auth/employee-directory` (T-15 — that
   is the exported name and the file it creates). It returns `PosEmployee[]`, where `PosEmployee` is
   `{ id: string; displayName: string; role: UserRole; isActive: boolean; pinPhc: string | null }`.
   Do **not** re-implement the query here, or the projection drifts from the one T-15's shape-lock
   test pins. Never read the restaurant id from a query parameter, from the body, or from
   `event.locals` — the hook leaves `locals.restaurantId` `null` outside `(dashboard)` precisely so a
   route that reaches for it by habit fails loudly instead of serving the wrong tenant.

   **Then read the till's own settings for the same tenant, in the same handler.** Call
   `getRestaurantWithSettings(db, device.restaurantId)` from `$lib/server/restaurants` and build
   `const settings = { posIdleLockSeconds: row?.posIdleLockSeconds ?? null };`.
   `pos_idle_lock_seconds` is the **nullable** column T-08 added with **no** column default, because
   spec 33 open decision 6 ("approval limits and lock timing") is unanswered. **Pass `null` straight
   through — never substitute `120` or any other number here.** A default written into a route
   silently answers an open decision for every restaurant already registered, which is exactly what
   the prohibition comment in `src/lib/server/db/schema/restaurant-settings.ts` forbids.
   **This block is the only transport this plan gives the till for a restaurant setting, and it is
   not optional.** Invariant 12 requires the POS to return to employee-select after an idle period,
   and `(pos)` has no server `load` by design and must not gain one, so without this the till could
   never learn the value and no idle timer could ever run. T-28 caches it; T-26 consumes it.
3. Return `json({ employees, settings }, { status: 200 })` with the rows **exactly as T-15 returned them** —
   five fields, `{ id, displayName, role, isActive, pinPhc }`, and nothing more. No `email`, no
   `passwordHash`, no `failedPasswordCount`, no `passwordLockedUntil`, no `failedPinCount`. T-15's
   read model **is** the projection; this route neither widens it nor narrows it, and must not map
   the rows into a new object literal on the way out.
   **The field is `pinPhc`, not `pinHash`, and the name is load-bearing.** T-15 step 4 chose it
   because `SECRET_KEY_PATTERN` in `src/lib/server/audit/index.ts` matches it, so if one of these
   objects is ever passed to `writeAudit` the write throws instead of putting a credential
   derivative into an append-only table. Renaming it in the response destroys exactly the tripwire it
   was named for.
   The list includes the **owner**, because spec 7 says *"The owner also has a POS PIN, used to
   approve sensitive actions"*. T-15's query already filters `restaurant_id` **and**
   `is_active = true`, so this route filters nothing of its own. In particular it does **not** drop
   employees whose `pinPhc` is `null`: T-15 step 8 returns them deliberately and T-25 renders them as
   unavailable, because hiding them makes "why is Sam missing from the till?" unanswerable from the
   screen.
4. Set `Cache-Control: no-store` on the response. The browser HTTP cache and any intermediary must
   not keep this body; the device stores it deliberately in IndexedDB in T-28, which is a different
   thing with a different lifetime and an explicit `navigator.storage.persist()` behind it.
5. **Say in a comment at the top of the file why `pinPhc` is in this response, and where the residual
   risk is recorded.** Spec 6 requires offline employee switching from hashes cached on the
   registered device, so the bundle must reach the device; `RESEARCH.md` beside this plan records the
   open `GAP` — a 4–6 digit PIN has at most 10^6 values, so anyone holding the tablet holds both the
   hashes and unlimited offline guesses, and no hash algorithm changes that. The compensating
   controls are: the bundle is served **only** to a registered device (this route's `requireDevice`),
   the owner can revoke that device from the dashboard (T-21), and every action that moves money
   needs an owner PIN approval (spec 8). Do not silently soften or drop that comment.

**Tests:** in `employees.integration.test.ts`, importing the real `GET` handler.
- MANDATORY (spec 29 — a permission check test on every POS API route): no device cookie throws
  exactly `403`; a **revoked** device's cookie throws exactly `403`; a syntactically valid but
  unknown cookie value throws exactly `403`. In all three cases assert nothing was returned — the
  helper must catch the thrown `error`, as `route-guards.integration.test.ts` does.
- Tenant isolation: restaurant A's device cookie returns only A's employees. Seed restaurant B with
  an employee named `'Should Not Appear'` and assert that name is absent and that
  `employees.length` equals A's count exactly.
- The projection is exactly T-15's: for every entry, `Object.keys(entry).sort()` equals
  `['displayName', 'id', 'isActive', 'pinPhc', 'role']`. Assert on the **serialised body**
  (`JSON.parse(await response.text())`), not on the value returned by the read model — the leak this
  catches is a route that spreads a database row.
- An employee whose `pin_hash` is `NULL` **is present**, with `pinPhc: null` (T-15 step 8). A
  deactivated employee is **absent**, filtered out by T-15's query and not by this route.
- The top-level body has exactly two keys: `Object.keys(body).sort()` equals `['employees',
  'settings']`. The per-entry projection assertion above is **unaffected** by this second key — it
  pins the keys of each entry, not the keys of the body.
- `settings.posIdleLockSeconds` is `null` for a restaurant that has never set it, and is the stored
  integer after `updateSettings` writes one. Assert both, and assert that the `null` case returns
  `null` rather than a substituted number.
- The response carries `cache-control: no-store`.

**Done when:** `pnpm test:integration src/routes/api/pos/employees/employees.integration.test.ts`
passes, `pnpm check` and `pnpm lint` are clean, and
`grep -n "locals.restaurantId\|url.searchParams\|pinHash\|120" 'src/routes/api/pos/employees/+server.ts'`
prints nothing (the `120` guards against a hardcoded idle default).

**Watch out:** a `GET` feels harmless and this one is the most sensitive response in the plan. The
two ways it goes wrong are forgetting `requireDevice` because "it only reads", and taking the tenant
from a query string so the dashboard can reuse the endpoint. Both are caught by the tests above; both
are also the reason those tests are marked MANDATORY.

---

### T-21 — Create `POST /api/pos/revoke` and the dashboard revocation action

**Needs:** T-13 (`revokeDevice`, `validateDeviceToken`), T-14 (the `pos.device.revoked` audit event)
**Files:**
- `src/routes/(dashboard)/device/+page.server.ts` — NEW (a `load` and a `revoke` action; T-29
  adds `+page.svelte` in the same directory and builds the screen around this action)
- `src/routes/(dashboard)/device/revoke.integration.test.ts` — NEW
**Spec:** 7 (*"The owner can revoke a device from the dashboard. This is minimal device management,
not the complex kind excluded from the MVP."*), 8 (server enforcement, 403), 9 (SvelteKit's origin /
CSRF check stays on)
**Invariants:** 8 (permissions enforced server-side; a form action is a separately reachable POST
endpoint, so it checks its own permission), 10 (the audit row is written in the same transaction as
the action), 11 (timestamps `timestamptz`)

**The title names two shapes and only the second is built. Read this paragraph before the title.**
The `Files:` block above is the whole surface: revocation is a **form action on the dashboard page**,
and `POST /api/pos/revoke` is **NOT created**. The title keeps both names only because the plan index
in `00-overview.md` names this task by it; the endpoint is the rejected shape, not a second
deliverable. Three reasons it was rejected: spec 7 places the control on the dashboard (*"The owner
can revoke a device from the dashboard"*), so the actor is a dashboard session and not a device; a
form action gets SvelteKit's built-in origin/CSRF check for free on its
`application/x-www-form-urlencoded` body, where a JSON `/api` endpoint needs T-17's extra header
check; and it keeps the only privileged POS write on the surface that already resolves the tenant
from `locals.restaurantId`. **Do not create `src/routes/api/pos/revoke/+server.ts`** — one revocation
path, or the two drift. T-22 step 4 pins the `/api` route list **by name**, and `/api/pos/revoke` is
deliberately not on it, so creating that file fails the mandatory guard test.

**The URL is `/device` — not `/pos`, and not `/pos-device` either.** `/pos` belongs to the till
(T-23 puts pages under `src/routes/(pos)/pos/`), and SvelteKit refuses to build two routes resolving
to the same URL. `/pos-device` would build, and is still wrong: **service-worker scope matching is a
plain string prefix match over the whole URL, not a path-segment match** (the W3C ServiceWorker
specification's "Match Service Worker Registration" algorithm; see w3c/ServiceWorker#1272 — MDN's
prose implies path-segment matching and MDN is wrong on this point). T-27's worker is registered at
scope `/pos`, and the string `/pos-device` starts with the string `/pos`, so that worker would
control **this** page — an authenticated dashboard route — and serve its HTML and its `__data.json`
out of Cache Storage after `/logout`, which does not clear Cache Storage. `/device` cannot be
prefixed by `/pos` under any matching rule, so the collision is gone structurally instead of resting
on a rule someone must remember. T-02 records that rule in `CLAUDE.md` and T-45 asserts it with a
test that walks the route tree: **no route outside the `(pos)` group may have a path beginning with
the characters `pos`, because the service-worker scope is a string prefix.**

**The rail item's label stays `POS`; only its href changes.** The `POS` rail item T-30 adds points at
`/device`. The label and the URL differ **on purpose** — the user asked for a rail item called `POS`
and that does not change, but `/pos` belongs to the till, so the dashboard page that manages the till
cannot have that URL. The `NavItem` href literal union in `src/lib/components/ui/Sidebar.svelte`
therefore gains `'/device'`, never `'/pos-device'`.

**Do:**

1. Create `src/routes/(dashboard)/device/+page.server.ts` exporting a `load` and
   `export const actions: Actions = { revoke: async (event) => { … } }`.
2. `load` calls `requirePermission(event, 'admin.devices')` — a key that already exists in
   `src/lib/server/permissions/keys.ts`'s `ADMIN_KEYS`; do **not** coin a new one. It throws
   `error(403, 'Forbidden')` for anyone without it. Then read `event.locals.restaurantId` (set for
   `(dashboard)` route ids only; `error(500, 'No restaurant in scope')` if null, exactly as
   `src/routes/(dashboard)/settings/+page.server.ts` does), select the restaurant's **most recent**
   device row — `order by registered_at desc limit 1`, with **no** `revoked_at is null` filter — and
   return it as an **explicit object literal**:
   `{ device: row && { id, deviceCode, label, registeredAt, revokedAt } }`. The property is
   `deviceCode` — that is the name T-05 declares on `pos_devices`, and T-29 reads it. **A revoked row
   still comes back, with a non-null `revokedAt`**, and the page decides what that means: T-29 step 3
   defines *registered* as `data.device && data.device.revokedAt === null`, T-32 computes
   `deviceRegistered` with that identical predicate, and T-29's own test asserts that a revoked
   device still comes back from this `load`. Filtering it out here would make `revokedAt` in this
   literal permanently `null`, turn both predicates into dead code and fail that test. Never spread
   the row: `pos_devices` holds the token hash, and SvelteKit serialises load data into the page HTML
   and into `__data.json`.
3. The `revoke` action calls `requirePermission(event, 'admin.devices')` **again, inside the
   action**, and binds its return: `const user = requirePermission(event, 'admin.devices');` — it
   returns the `Principal`, whose `userId` step 5 and step 6 both need. The `(dashboard)` layout
   guard and the hook both already 403 a non-owner, and that is not enough:
   `src/routes/route-guards.test.ts` has a dedicated case asserting that a file exporting `actions`
   calls a guard *inside* them, because a form action is a separately reachable POST endpoint
   (invariant 8).
4. Read `deviceId` from the posted `FormData` and validate it with zod
   (`z.object({ deviceId: z.string().uuid() })`); `return fail(400, { message: … })` on a miss.
5. In ONE `db.transaction`, call
   `revokeDevice(tx, { deviceId, restaurantId, actorUserId: user.userId })` from
   `$lib/server/auth/pos-device` (T-13). **The field names are T-13's contract and this route matches
   them:** the actor argument is `actorUserId`, the same name `registerDevice` takes, even though the
   column it lands in is `revoked_by_user_id` — T-13 step 8 already stamps `revokedAt = now` **and**
   `revokedByUserId = args.actorUserId` together in one `UPDATE`, which T-05 step 4 calls "the
   `revoked_at` / `revoked_by_user_id` stamp", because a null actor makes the trail unable to answer
   who pulled the till offline. Do **not** amend T-13 and do **not** rename the argument to match the
   column: 03-domain-access.md's phase header makes its printed signature authoritative — *"Phase 3's
   routes must match it exactly, and a route that cannot is a bug in the route, not a licence to
   rewrite the module."* Everything else about T-13 step 8 stands: it scopes the `UPDATE` by **both**
   `id` and `restaurant_id` — the `deviceId` came from the request body and `restaurantId` from
   `locals`, and only the pair is safe — and by `revoked_at is null`, it stamps a `timestamptz`
   (invariant 11), it returns `{ deviceCode, label }` for the row it stamped and `null` when there
   was nothing to revoke, and it **never deletes the row**: the registration and its revocation are
   the audit trail for who had a till cookie and when.
6. In the same transaction, `writeAudit(tx, { restaurantId, actorUserId: user.userId,
   subjectUserId: null, event: 'pos.device.revoked', details: { deviceCode, label }, ip, userAgent })`
   with **both** `deviceCode` and `label` taken from `revokeDevice`'s return and `{ ip, userAgent }`
   from `requestContext(event)` (invariant 10). `details` is **exactly** `{ deviceCode, label }`:
   T-14 fixes that union member as
   `| { event: 'pos.device.revoked'; details: { deviceCode: string; label: string } }` and forbids
   widening the union, so a **missing** `label` is a type error just as an extra key would be. That
   is the whole reason T-13 step 8 returns `label` — *"T-21 needs it for `details` and must not
   re-query for it"* — so take it from there rather than selecting the row a second time. If T-14's
   shape differs, use **T-14's** and adjust here. **Pass no `deviceId`**: T-14 step 6 did add the
   optional field to `AuditEntry`, but this revocation is a dashboard action by a dashboard session,
   and T-07's own column comment is *"Which registered till produced this row. Null for every
   dashboard event."* The device is named in `details.deviceCode`. *(Follow-up for the plan owner:
   T-14 step 6's closing sentence lists "T-12 (via T-19), T-18 and T-21" as writers of those two
   columns. T-21 writes neither, deliberately; T-07 step 1's narrower list — "T-19's PIN logins and
   T-18's device registration" — is the accurate one.)*
7. Make it idempotent by branching on T-13's `{ deviceCode, label } | null` return, which already
   reports whether it changed a row — this is not new work to add to T-13. `null` means the device
   was already revoked, belongs to another restaurant, or does not exist: change nothing, write
   **no** audit row, and return `{ message: 'That device was already revoked.' }`. On a non-null
   return, write the audit row of step 6 and return
   `{ message: 'Device revoked. It can no longer show the PIN screen.' }`.
8. Nothing here clears a cookie: the device cookie is on the tablet, not in this browser. Revocation
   takes effect because `validateDeviceToken` (T-13) refuses a row with `revoked_at IS NOT NULL` on
   the **next** request the tablet makes — which is what step 2 of the tests asserts.

**Tests:** in `revoke.integration.test.ts`, importing the real module
(`await import('./+page.server')`) and calling `mod.actions.revoke(event)` directly, the way
`route-guards.integration.test.ts` imports and calls `logout/+page.server`'s `load`.
- MANDATORY (spec 29 — a permission check test on every POS API route): a **cashier** principal in
  `event.locals.user` gets exactly `403` from the action, and the `pos_devices` row is untouched
  (`revoked_at` still `NULL`). Repeat for `load`. A `403`, never a `404` and never a `303`.
- After a successful revoke, `validateDeviceToken(db, thatToken)` returns `null`.
- The row still exists: `select count(*) from pos_devices` is unchanged, that row's `revoked_at` is
  non-null, and its `revoked_by_user_id` is the owner's id — T-13 step 8 stamps both columns in the
  one `UPDATE`, from `args.actorUserId`, so a null here means `revokeDevice` was built against an
  older signature than the one 03-domain-access.md prints.
- Exactly one `pos.device.revoked` audit row, whose `details.deviceCode` is the revoked device's code
  and whose `details.label` is its label — both from `revokeDevice`'s return. Assert its
  `audit_log.device_id` is **`null`**: revocation is a dashboard-actor event, which is what T-07's
  column comment ("Null for every dashboard event") describes.
- Revoking twice returns the "already revoked" message and still leaves exactly one
  `pos.device.revoked` audit row.
- An owner of restaurant B posting restaurant A's `deviceId` changes nothing: A's row keeps
  `revoked_at IS NULL` and no audit row is written.

**Done when:** `pnpm test:integration src/routes/(dashboard)/device/revoke.integration.test.ts`
passes, `pnpm test src/routes/route-guards.test.ts` still passes (the new file exports `actions` and
is picked up by the walk that requires a guard inside them), `pnpm check` and `pnpm lint` are clean,
and `ls src/routes/api/pos/` shows exactly `employees`, `pin` and `register` — no `revoke`.

**Watch out:** this directory has a `+page.server.ts` and **no** `+page.svelte` until T-29 adds one.
That is a supported shape — `src/routes/logout/+page.server.ts` already ships that way — and
`pnpm build` and `pnpm check` both pass. A browser `GET /device` before T-29 lands will error
with "Missing +page.svelte component"; that is expected between the two tasks, not a regression, and
no e2e spec visits the URL yet.

---

### T-22 — Add the permission-check test for every POS API route

**Needs:** T-18, T-19, T-20, T-21
**Files:**
- `src/routes/route-guards.test.ts` — EDIT (the `GUARD_CALLS` constant at ~line 25, and a new
  `describe` block after the existing one; keep every current test)
- `src/routes/api/pos/permissions.integration.test.ts` — NEW
**Spec:** 29 (the mandatory test list: *"Permission checks on every POS API"*), 8 (server
enforcement, 403)
**Invariants:** 8 (permissions enforced server-side on every POS API route, reads included — a new
`+server.ts` or form action with no permission check is unfinished)

This is spec 29's *"a permission check test on every POS API route"* obligation made **mechanical**,
so a route added by a later plan cannot skip it by forgetting. Mark the whole file
`MANDATORY (spec 29)` in its header comment, as `route-guards.test.ts` and
`route-guards.integration.test.ts` already are.

**Do:**

1. In `src/routes/route-guards.test.ts`, extend the recognised guard calls:
   `const GUARD_CALLS = ['requireUser', 'requireOwner', 'requirePermission', 'requireDevice'];`
   `requireDevice` (T-16, in `src/lib/server/auth/pos-context.ts`) is a real guard — it throws
   `error(403, 'Forbidden')` when the device cookie is missing, unknown or revoked — and without this
   line every POS endpoint fails the existing walk despite being correctly guarded. Update the
   failure message in that test, which currently names only three helpers.
2. Add a second, narrower walk in a new `describe('every /api route is guarded', …)`: enumerate every
   `+server.ts` under `src/routes/api/` (reuse `findServerFiles`, rooted at
   `join(ROUTES_DIR, 'api')`, and guard it with `existsSync` so the file still passes before the
   directory exists) and assert each one's source contains one of `GUARD_CALLS`.
3. Exempt exactly one route, by name and with its reason in the assertion message:
   `/api/pos/register`, which is in `PUBLIC_ROUTE_IDS` because it authenticates from the **body**
   with the owner's email and password via `loginWithPassword`, has no session and no device cookie
   to check, and destroys the dashboard session it creates. Express the exemption as
   `if (PUBLIC_ROUTE_IDS.has(routeIdOf(file))) return;` so the exemption and the public list cannot
   disagree — and pin it with `expect([...PUBLIC_ROUTE_IDS].filter((id) => id.startsWith('/api/')))
   .toEqual(['/api/pos/register'])`, so a second public `/api` id is a test failure rather than a
   discovery.
4. Assert the `/api` walk is not vacuous, and express it as a **named list** rather than a bare
   count, so that a task adding a route later extends it deliberately instead of bumping a number it
   cannot interpret:

   ```ts
   // Every +server.ts under src/routes/api/, by route id. A task that adds an /api
   // route adds its id here IN THE SAME COMMIT — that is the point of this assertion.
   // A walk that silently found nothing would otherwise pass every check in step 2.
   expect(apiServerFiles.map(routeIdOf).sort()).toEqual([
     '/api/pos/employees', '/api/pos/pin', '/api/pos/register'
   ]);
   ```

   **This list grows in Phase 7, by plan and not by accident:** T-40 adds `/api/menu/version` and
   T-41 adds `/api/menu`, each extending this array in its own commit alongside the route it creates.
   What must **never** appear is `/api/pos/revoke` — revocation is deliberately a dashboard form
   action and not an `/api` route (T-21) — so a `src/routes/api/pos/revoke/+server.ts` turning up
   here is exactly the mistake this assertion exists to catch.
5. Create `src/routes/api/pos/permissions.integration.test.ts`. Seed one restaurant with an owner, a
   cashier, one **active** device and one **revoked** device, using `testDb()` from
   `$lib/server/db/test/db`. Build events with the same fake-`RequestEvent` helper shape as
   `src/routes/route-guards.integration.test.ts` (a `Map`-backed cookie jar, `getClientAddress`, a
   real `Request`, `route: { id }`).
6. Drive every device-guarded POS route through a table — `['/api/pos/pin', POST,
   validJsonBody]`, `['/api/pos/employees', GET, undefined]`, importing each real handler — and
   assert:
   - **(a)** with **no cookies at all** → exactly `403`;
   - **(b)** with the **revoked** device's cookie → exactly `403`;
   - and that neither case wrote any `audit_log` row or mutated any `users` counter.
   `/api/pos/register` is excluded from (a) and (b) by construction — it has no device guard — so
   assert its own rule instead: it returns `403` for credentials that are not the owner's, which is
   T-18's case re-asserted here so the table is complete rather than silently short.
7. Add case **(c)**, insufficient role with a valid session, for the one POS surface that has a role
   check: import `src/routes/(dashboard)/device/+page.server.ts` and call `actions.revoke` with a
   **cashier** principal in `event.locals.user` — exactly `403`, and the `pos_devices` row unchanged.
   Say in a comment that (c) has no `/api/pos/*` target because the device-guarded routes are
   authorised by the device, not by a role, and that a later plan adding a role-sensitive POS
   endpoint adds its row here.

**Tests:** the file *is* the test. Mark every block `MANDATORY (spec 29 — permission checks on every
POS API)`. Then prove the harness can fail, once, by hand before committing:
- Temporarily delete the `requireDevice` line from `src/routes/api/pos/employees/+server.ts` and
  confirm **both** the static walk (step 2) and the integration table (step 6a) go red. Restore it.
  A guard test that cannot fail is the defect this whole file exists to prevent — the comment already
  in `src/lib/server/permissions/guards.test.ts` records that exact mistake happening once in this
  codebase.
- Temporarily add `src/routes/api/pos/scratch/+server.ts` exporting an unguarded `GET`, confirm step
  2 names it in the failure message, and delete it.

**Done when:** `pnpm test src/routes/route-guards.test.ts` and `pnpm test:integration
src/routes/api/pos/permissions.integration.test.ts` both pass, `pnpm test` is green overall, and the
two deliberate breakages above were each observed to fail before being reverted.

**Watch out:** the static walk in `route-guards.test.ts` searches **source text**, so a
`requireDevice` sitting in a comment satisfies it. That is why it is described in its own header as a
cheap tripwire and why step 5's integration file is the real evidence — do not drop one on the
grounds that the other exists. Second trap: `findServerFiles` uses `statSync(...).isDirectory()` and
throws on a missing root, so wrap the `src/routes/api` walk in `existsSync` rather than assuming the
directory is there.
