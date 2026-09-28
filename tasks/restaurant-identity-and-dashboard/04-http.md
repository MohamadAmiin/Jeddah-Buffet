# Phase 3 — HTTP surface: hook, routes, guards

Routes validate input, check their own permission, call a module and return. Nothing in this phase
contains a business rule, opens a transaction, or touches the database client directly.

**Depends on:** Phase 2 (T-12 and T-15 for the hook, T-13 and T-14 for the routes).

Read `00-overview.md` first for the requirements, assumptions and the file-tag convention.

**The rule that binds every task in this phase:** invariant 8 says permissions are enforced
server-side on every route, reads included, and "a new `+server.ts` or form action with no permission
check is unfinished". The hook in T-17 is a **backstop**, not the check. Every load function and every
form action calls its own guard as well. Two independent layers, because a hook is one refactor away
from not matching a route id it used to match.

---

### T-17 — `src/hooks.server.ts` — deny-by-default guard and `App.Locals`

**Needs:** T-12, T-15
**Files:**
- `src/hooks.server.ts` — NEW
- `src/app.d.ts` — EDIT (replace the commented-out `App.Locals` stub; the file exists and holds only
  commented placeholders)
**Spec:** 8 ("If a waiter tries to call an unauthorized API directly... the server returns 403
Forbidden. So hiding buttons in the frontend is not considered security"), 9 (cookie sessions;
SvelteKit's origin check stays enabled), 7 (the owner enters the management dashboard)
**Invariants:** 8 (permissions enforced server-side on every route, reads included), 12 (cookie
sessions, HttpOnly + Secure + SameSite, origin check ON)

**Do:**

1. In `src/app.d.ts`, declare the locals this hook populates. Use the `Principal` type T-12 exports —
   do not redeclare its fields, and do not add a `user` shape that could drift from it:

   ```ts
   declare global {
     namespace App {
       interface Locals {
         user: import('$lib/server/auth/session').Principal | null
         restaurantId: string | null
         sessionToken: string | null
       }
     }
   }
   ```

2. Write the hook as `sequence(handleSession, handleGuard)` from `@sveltejs/kit/hooks`.

3. `handleSession`:
   - read the session cookie; if absent, set all three locals to null and continue;
   - call `validateSessionToken`; on null, delete the cookie and continue as anonymous;
   - set `locals.user`, and set `locals.restaurantId` **only when the matched route id is under
     `/(dashboard)`**. Everywhere else leave it null.

   That restriction looks odd and is deliberate. A future POS or sync route must resolve its tenant
   from the registered device row and its actor from the queued operation, never from whichever
   owner last logged in on that browser. Leaving `restaurantId` null outside the dashboard means such
   a route fails loudly the first time somebody wires it to `locals` by habit, instead of silently
   posting one restaurant's sales under another restaurant's id.

   - re-set the cookie when `validateSessionToken` extended the expiry, so the sliding window reaches
     the browser. Slide **only on dashboard route requests**; an owner's cookie left on a counter
     tablet must not renew itself forever through POS or asset traffic.

4. `handleGuard` is **deny by default**. Keep an explicit allow-list of public route ids and deny
   everything else:

   ```ts
   const PUBLIC_ROUTE_IDS = new Set(['/', '/login', '/register'])
   ```

   Then:
   - a route id in the allow-list continues, whoever is asking;
   - `/login` or `/register` with a valid session redirects to `/dashboard` (303);
   - any other route with no session redirects to `/login?next=<encoded pathname + search>` (303);
   - a route id starting with `/(dashboard)` additionally requires `role === 'owner'`, returning
     **403** otherwise — not 404, because spec 8 names 403;
   - a null route id (no route matched) is left alone for SvelteKit to 404.

   Route group names **are** part of `event.route.id`: the generated types in `.svelte-kit/types`
   contain `"/(dashboard)"` and `"/(pos)"`, so the prefix test works. Verify it still does rather
   than assuming.

   The inversion matters. A guard that protects only `/(dashboard)` leaves every future top-level
   route public unless it remembers its own check — and this plan already puts `/logout` at top level,
   and spec 7's device registration will add another owner-only page beside it. T-20 turns the
   allow-list into a test that fails when a new route joins neither side.

5. Add `(pos)` and `/api` to neither list yet. When those surfaces arrive they authenticate by
   registered device and employee PIN, not by this cookie, and they must be added to this hook
   deliberately with their own resolution — which the deny-by-default rule forces.

6. Do not set any CSRF or origin option in `svelte.config.js`. The default origin check is on and
   invariant 12 requires it stay on. If a production deployment returns 403 on form posts, the fix is
   the `ORIGIN` environment variable for adapter-node, which T-26 documents, and never disabling the
   check.

7. Add a comment recording the proxy dependency: `event.getClientAddress()` returns the socket peer
   unless `ADDRESS_HEADER` is set, so behind Nginx every audit row and every throttle bucket sees
   `127.0.0.1` until T-26's variables are configured. That degrades silently, which is why it is
   written down here where the locals are built.

**Tests:** T-20 tests the guard across the whole route tree. Write no separate hook unit test; the
route walk is the stronger check.

**Done when:** `pnpm check` passes; an anonymous request to `/dashboard` receives a 303 to `/login`
carrying a `next` parameter; a session whose role is not `owner` receives 403 from a dashboard route;
and a logged-in request to `/login` receives a 303 to `/dashboard`.

**Watch out:** build the `next` parameter with `encodeURIComponent` over `url.pathname + url.search`.
An unencoded query string truncates the target at the first ampersand, and T-18 has to be able to
reject an unsafe value cleanly rather than parse a mangled one.

---

### T-18 — `/login` and `/logout` routes

**Needs:** T-03, T-13, T-17
**Files:**
- `src/routes/login/+page.server.ts` — NEW
- `src/routes/login/+page.svelte` — NEW
- `src/routes/logout/+page.server.ts` — NEW
**Spec:** 7 (the Owner/Admin uses email and password), 9 (cookie sessions; origin check on), 32
(management login is email and password)
**Invariants:** 8 (server-side checks on every route), 12 (cookies, never `localStorage`)

**Do:**

1. `login/+page.server.ts` `load`: if `locals.user` exists, redirect to `/dashboard`. Return nothing
   else — no user list, no restaurant name, nothing that tells an anonymous visitor whether this
   installation has been set up.

2. The default form action:
   - parse the body with a zod schema: `email` trimmed, lowercased, non-empty, and shaped like an
     email; `password` a non-empty string of at most 1024 bytes; plus the optional `next`;
   - call `loginWithPassword` with the client address and user agent;
   - on `ok: false`, return `fail(400, ...)` with a **single generic message** for both `invalid` and
     `locked` — "Email or password is incorrect" — so the response cannot be used to discover which
     addresses are registered or which accounts are currently locked. Include a `retryAfterMs` only
     when the throttle refused the request, since that is about the caller's own behaviour;
   - on `ok: true`, set the session cookie and redirect (303) to the validated `next` or `/dashboard`.

3. **The `fail()` payload must never contain the password.** The idiomatic
   `return fail(400, { ...data })` serialises the whole submitted body into the action response and
   into `__data.json`, from where it reaches the browser cache, the history entry and any error
   tooling that captures page data. Return `{ email, message }` and nothing else. Write a unit test
   asserting the payload has no `password` key.

4. **Validate `next` before redirecting.** SvelteKit's `redirect()` passes the location straight
   through, so an unvalidated value is an open redirect: a phishing mail linking
   `/login?next=https://evil.example` gets the owner to log in correctly and then lands them on a
   look-alike "session expired, sign in again" page. Accept the value only when both hold:
   - it matches `/^\/(?![/\\])/` — starts with a single slash that is not followed by another slash
     or a backslash, so `//evil.example` and `/\evil.example` are refused;
   - `new URL(next, url.origin).origin === url.origin`.

   Otherwise use `/dashboard`. Unit-test all four of `https://evil.example`, `//evil.example`,
   `/\evil.example` and `javascript:alert(1)`.

5. `login/+page.svelte`: a form posting to the default action, progressively enhanced with
   `use:enhance`. Email and password inputs with correct `autocomplete` attributes
   (`username` and `current-password`), labels tied to inputs, the error message rendered in a region
   with `role="alert"`, and the submit button disabled while submitting. Use the dashboard's visual
   language from `src/lib/styles/tokens.css` — `bg-bg`, `bg-raise`, `text-ink`, `text-ink-2`,
   `border-line`, `shadow-card`, `font-display` for the heading — and Tailwind's default spacing
   scale. No arbitrary values such as `bg-[#123456]` or `p-[57px]`; if a value is missing, add a token
   instead. Nothing from the POS dark chrome tokens belongs here.

6. `logout/+page.server.ts` is a **form action only**. Export an `actions` object and no `load`, so a
   `GET` receives 405. A logout reachable by `GET` is triggerable by any image tag on any page.
   In the action: invalidate the session row and write the `logout` audit row in one transaction,
   delete the cookie, redirect to `/login`.

7. Because logout needs a session, it is **not** in the hook's public allow-list, so an anonymous
   `POST /logout` is redirected to `/login` before the action runs. That is correct; do not add a
   special case.

**Tests:**
- unit: the `next` validator accepts `/dashboard` and `/settings?tab=a` and rejects the four hostile
  forms in step 4;
- unit: the `fail` payload for a bad password contains no `password` key;
- the route-level guard assertions live in T-20.

**Done when:** logging in with correct credentials sets a cookie and lands on `/dashboard`; a wrong
password returns the generic message and no cookie; `GET /logout` returns 405; the logout form clears
the cookie and the session row; and `?next=https://evil.example` lands on `/dashboard`.

**Watch out:** the same `/login` page is what spec 7's device registration will use on the POS tablet,
because the owner logs in there with email and password before registering the device. Do not build a
separate POS login page, and do not add anything to this page that assumes a desktop browser.

---

### T-19 — `/register` route

**Needs:** T-03, T-14, T-17
**Files:**
- `src/routes/register/+page.server.ts` — NEW
- `src/routes/register/+page.svelte` — NEW
**Spec:** 7 (the Owner/Admin uses email and password and enters the management dashboard), 17 (the
restaurant's time zone is a setting)
**Invariants:** 8 (server-side checks on every route), 11 (the time zone is a restaurant setting), 12
(slow salted hashing; cookie sessions)

**Do:**

1. `load`: call `isRegistrationOpen()`. When it returns false, throw a 404. Not a redirect and not a
   friendly "registration is closed" page: the existence of a closed registration endpoint is not
   information an anonymous visitor needs. When it returns true but `SETUP_TOKEN` is unset, return a
   503 whose message names the variable, so the operator can see what to do.

2. The form collects: restaurant name, time zone, owner display name, email, password, password
   confirmation, and the setup token. Pre-fill the time zone from
   `Intl.DateTimeFormat().resolvedOptions().timeZone` in the browser and let the owner change it —
   and remember that this value may be a spelling that a list-membership check would reject, which is
   exactly why T-16 validates by construction.

3. The action:
   - validates with zod: names non-empty and length-bounded; email shaped and lowercased; password at
     least 8 characters and at most 1024 bytes, matching its confirmation; the token non-empty. Do not
     impose character-class rules; length is the useful constraint;
   - calls `registerRestaurant`, which **re-checks that registration is open inside its own
     transaction** — the `load` check is a courtesy to the user, not the gate;
   - on `ok: false`, returns `fail()` with a message per reason: closed, bad token, email taken,
     invalid time zone;
   - on `ok: true`, sets the session cookie and redirects to `/dashboard`.

4. **Never echo the password or the setup token back in a `fail()` payload.** Return the restaurant
   name, time zone, display name and email so the form can be repopulated, and nothing else.

5. `register/+page.svelte`: the same visual language and the same accessibility rules as the login
   page. Explain the setup token in one sentence so the operator and the owner are not guessing: it
   is the one-time value from the server's environment, and it is required only for the first
   restaurant.

6. Do not add a "forgot password" link. There is no self-service reset in this plan; recovery is the
   operator script in T-25, and a link to a page that does not exist is worse than no link.

**Tests:** the route-guard assertions live in T-20; the end-to-end journey is T-24. The interesting
behaviour here — atomicity, the gate, concurrency — is tested at the module level in T-14, which is
where it belongs.

**Done when:** with a restaurant already present, `/register` returns 404; with none and no
`SETUP_TOKEN`, it returns 503 naming the variable; with none and the token set, a valid submission
lands on `/dashboard` and a second attempt afterwards returns 404.

**Watch out:** the `load` check and the action's check are deliberately duplicated. Removing the one
in the transaction because "the load already checked" reintroduces the race two simultaneous
submissions exploit, and the advisory lock in T-14 exists precisely to close it.

---

### T-20 — The route-guard test that walks `src/routes`

**Needs:** T-17, T-18, T-19
**Files:**
- `src/routes/route-guards.test.ts` — NEW
- `src/routes/route-guards.integration.test.ts` — NEW
**Spec:** 8 (the server returns 403; hiding buttons is not security), 29 ("Permission checks on every
POS API" is one of the six areas that get automated tests from day one)
**Invariants:** 8 (permissions are enforced server-side on every POS API route, reads included; a new
`+server.ts` or form action with no permission check is unfinished)

**Do:**

1. Write the **static walk** first, as a unit test. Enumerate every `+page.server.ts`,
   `+layout.server.ts` and `+server.ts` under `src/routes/`. For each file, assert one of:
   - its route id is in the hook's public allow-list (import the real constant from
     `src/hooks.server.ts`; do not copy the list into the test, or the two drift); or
   - its source contains a call to one of `requireUser`, `requireOwner` or `requirePermission`.

   Fail with a message naming the file and telling the author to add a guard or to add the route to
   the allow-list deliberately. This is the test that makes invariant 8's "a route with no permission
   check is unfinished" mechanical rather than a matter of reviewer attention, and it is the reason a
   later plan cannot quietly add an unguarded device-registration page beside `/logout`.

2. Additionally assert that every file exporting an `actions` object contains a guard call **inside
   the actions**, not only in `load`. SvelteKit form actions are separately reachable POST endpoints:
   a page whose `load` is guarded and whose action is not is wide open to anyone who posts to it
   directly.

3. Write the **behavioural** test as an integration test, using the T-08 harness for fixtures. For
   each non-public route, assert:
   - anonymous receives a 303 to `/login`;
   - a session whose role is `cashier` or `waiter` receives 403 from every `(dashboard)` route,
     including `load` functions, because invariant 8 says reads included.

   Build those non-owner sessions by inserting the user row directly, since the CHECK constraint
   forbids giving them credentials and `loginWithPassword` refuses them. That is the point: the only
   way such a session could exist is a later plan creating one, and this test proves the dashboard is
   closed to it in advance.

4. Assert that `GET /logout` returns 405.

5. Keep the static walk free of a hard-coded file list. Discover the files, so that adding a route
   makes the test consider it automatically.

**Tests:** the two files above. Mark **both** of them in a header comment as

```
MANDATORY (spec 29 — "Permission checks on every POS API")
```

This is the one of spec 29's six mandatory areas that this feature lands in. Spec 29 names the POS
API; the dashboard routes are the first routes that exist, invariant 8 says the rule covers every
route with reads included, and the walk in step 1 is written so that the POS routes are covered
automatically the day they are added. Marking them is what stops a future refactor deleting them as
redundant with the hook — they are not redundant: the hook is one changed route id away from
silently guarding nothing.

- MANDATORY (spec 29): every non-public route returns 303 to `/login` for an anonymous request.
- MANDATORY (spec 29): every `(dashboard)` route returns **403**, not 404 and not a redirect, for an
  authenticated session whose role is not `owner` — loads included.
- MANDATORY (spec 29): every file exporting `actions` guards inside the actions, not only in `load`.
- `GET /logout` returns 405.

**Done when:** both files pass; adding a new `+page.server.ts` with no guard makes the static walk
fail; and a cashier session receives 403 rather than 404 from every dashboard route.

**Watch out:** the static walk searches source text, so it can be satisfied by a guard call that sits
in a comment or in dead code. Keep it as a cheap tripwire and let the behavioural test be the real
evidence. Do not try to make the static test clever; make it impossible to ignore.
