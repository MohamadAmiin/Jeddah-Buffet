# Phase 8 — Verification

Every unit test in this plan already shipped inside the task that wrote the code it covers; nothing
was deferred here. What is left are the four checks that **cannot** live inside a single task because
they span layers: a browser journey that crosses the dashboard, the `/api/pos/*` endpoints and the
till; a real-browser assertion about the service worker's scope and what it is allowed to keep in
Cache Storage; an offline PIN login driven through Playwright's offline context; and a full sweep
that runs every command the house documents, hand-checks the seven invariant-shaped things a green
suite can still get wrong, and writes down what the next plan inherits.

**Depends on:** every phase above — Phase 0 (`01-decisions.md`), Phase 1 (`02-schema-access.md`),
Phase 2 (`03-domain-access.md`), Phase 3 (`04-api-pos.md`), Phase 4 (`05-pos-shell.md`), Phase 5
(`06-dashboard-access.md`), Phase 6 (`07-money.md`) and Phase 7 (`08-menu.md`). Per-task `Needs:` IDs
below are the binding contract; the phase line is the redundant second declaration.

**One spelling of the POS prefix, fixed here and used by every task in this phase: `/pos`, with no
trailing slash.** It is what T-02 decided, what T-23 serves, what T-25's landing screen answers on,
and what T-27 passes to `navigator.serviceWorker.register` and writes into the manifest's `scope`
and `start_url`. Service-worker scope matching is a plain **string prefix** on the client URL, so a
`/pos` scope contains `/pos`, `/pos/register` and `/pos/pin`, while a `/pos/` scope would not match
`/pos` at all and would leave the till's own landing screen uncontrolled and unable to load offline.
SvelteKit's `trailingSlash` default is `never`, so `/pos/` additionally answers with a redirect. If
any assertion below is ever "fixed" by adding a trailing slash, the fix is wrong.

**The prefix is a string prefix over the whole URL, not over path segments** — the W3C
ServiceWorker specification's "Match Service Worker Registration" algorithm, which gives
`https://www.google.com/maps` matching `https://www.google.com/mapsearch` as its own example
(https://github.com/w3c/ServiceWorker/issues/1272, accessed 2026-09-14). MDN's prose implies
path-segment matching; **MDN is wrong here and the specification governs** — do not "correct" it
back. So a `/pos` scope would also control a `/pos-device` or a `/poster`, which is why the
dashboard page that registers, revokes and launches the till is named **`/device`** (T-21, T-29) and
why **no route outside the `(pos)` group may have a path beginning with the characters `pos`**.
T-02 records that rule and its reason in `CLAUDE.md`; **T-45 step 8 is the test that enforces it**,
and T-45 step 4 asserts the consequence — `/device` is not controlled by the worker. The rail item
is still *labelled* `POS`; only its href differs, on purpose.

---

### T-44 — Extend the e2e journey through device registration and PIN login

**Needs:** T-32 (the onboarding checklist computes the employee and device steps), T-30 (the `POS`
rail item replaces `Devices`)
**Files:**
- `e2e/pos-access.spec.ts` — NEW
- `e2e/fixtures.ts` — NEW (shared helpers for the three new POS specs; **not** a Playwright fixture
  file — Playwright's default `testMatch` is `**/*.@(spec|test).?(c|m)[jt]s?(x)`, so a file named
  `fixtures.ts` is never collected as a test)
- `e2e/auth.spec.ts` — **verify only; expected to need no change** (step 3's count assertion, around
  line 63, which after T-08 reads
  `await expect(page.getByText('not started', { exact: true })).toHaveCount(6);`, plus the comment
  block immediately above it. T-08 moved that number from 5 to 6 when `pos_idle_lock_seconds` joined
  `settingsComplete()`, and T-32, T-36 and T-43 each re-checked it and each confirmed it stays
  **6** — a freshly registered restaurant completes no step at all. Read the number that is in the
  file rather than retyping one from this plan, re-verify it against the `steps` array in
  `src/routes/(dashboard)/dashboard/+page.svelte`, and touch it only if Playwright reports something
  else; change nothing else in this file)
**Spec:** 7 (POS device registration — "Owner logs in on the POS device (email + password)" →
"Register this device as POS1" → "Server issues a long-lived device cookie (HttpOnly, Secure)" →
"PIN login accepted only from registered devices"; PIN rules — 4-6 digits), 9 (cookie sessions are
HttpOnly + Secure + SameSite, never `localStorage`, and SvelteKit's origin/CSRF check stays on),
8 (server enforcement — an unauthorised call gets `403 Forbidden`, hiding buttons is not security)
**Invariants:** 12 (POS access = registered device + PIN; the device cookie is HttpOnly + Secure and
revocable from the dashboard; session tokens never in `localStorage`; CSRF stays on),
8 (permissions enforced server-side on every POS API route, reads included)

**Do:**

1. **Decision, made here so nobody re-opens it: a NEW spec file, not an extension of
   `e2e/auth.spec.ts`.** Reason, and write it into the new file's header comment: `auth.spec.ts` is
   one 216-line sequential journey whose final steps deliberately end **signed out**, with
   `/register` returning 404. Grafting a device-registration and PIN journey onto that end means
   signing back in first and pushes one test past 400 lines, where a failure anywhere in the auth
   half hides the POS half entirely. Two files stay independently diagnosable. The two files are
   safe to run together because both call `acquireRunLock()` from
   `src/lib/server/db/test/reset.ts` before `resetDb()`, and that is a
   **session-scoped `pg_advisory_lock` held across processes** — a second Playwright worker waits
   rather than truncating `matcami_test` out from under the first.
   Do **not** refactor `auth.spec.ts`'s inline steps to call the new helpers: that journey is a
   document of record and a whole-file rewrite makes its diff unreadable. A little duplication is
   the cheaper of the two.

2. **Write `e2e/fixtures.ts`** — plain exported async functions taking a `Page`/`BrowserContext`, no
   Playwright fixture machinery:
   - `export const TILL_URL = '/pos';` — the till's landing screen, created by T-25 at
     `src/routes/(pos)/pos/+page.svelte`. The constant exists so the three POS specs cannot drift
     apart, **not** because the path is in doubt: `/pos` is T-02's prefix decision, it is the URL
     T-23 serves the group under, and it is the same literal T-27 hands the service worker and the
     manifest (`scope: '/pos'`, `start_url: '/pos'`). **Never write `/pos/`** — see the phase note
     above; a trailing slash breaks both the worker scope and the manifest.
   - `registerRestaurant(page, { name, email, password, timeZone, token })` — `goto('/register')`,
     fill `Restaurant name`, `Time zone`, `Your name`, `Email`, `Password` (`{ exact: true }`),
     `Confirm password`, `Setup token`, click `Create restaurant`, await `/dashboard`. The token
     value is `E2E_SETUP_TOKEN`, imported from `../playwright.config`.
   - `signIn(page, { email, password })` — `goto('/login')`, fill, click `Sign in`, await
     `/dashboard`.
   - `createCashier(page, { displayName, pin })` — click the rail link named `Employees`
     (`page.getByRole('link', { name: 'Employees' })`), fill T-31's form, submit, await the row.
     **Reach every dashboard page by clicking its rail link, never by a hardcoded URL** — the URLs
     belong to T-29 and T-31, the rail labels are fixed by T-30, and clicking is itself the
     assertion that T-30 wired the rail.
   - `registerDevice(tillPage, { email, password })` — `goto(TILL_URL)`, fill T-24's owner email and
     password fields, submit, await the employee-select screen.

3. **Set the spec up exactly as `auth.spec.ts` does**: `test.beforeAll` calls
   `await acquireRunLock()` then `await resetDb()`; `test.afterAll` calls `await closeResetPool()`
   (which releases the lock). Import all three from `../src/lib/server/db/test/reset`. One `test()`
   with sequential `// ── N. … ──` steps, taking `{ page, browser }`.

4. **Owner context (the default `page`).** `registerRestaurant(...)`, then on `/dashboard` assert
   the checklist's starting state: `await expect(page.getByText('not started', { exact: true })).toHaveCount(6)`.
   **Six, not five: a freshly registered restaurant has completed none of the six steps.** T-08 made
   `settingsComplete()` depend on `pos_idle_lock_seconds`, which registration leaves null, and T-36
   added tax mode, tax rate and currency to the same `missing` list — so `Restaurant settings`
   renders `not started` too, and nothing has yet created an employee, a device, a menu item, a
   table or a POS session. This is the same number `e2e/auth.spec.ts` step 3 asserts after the same
   fixture, set there by T-08 and re-confirmed by T-32, T-36 and T-43.
   `exact: true` matters — each step renders the phrase twice (a visible badge plus an
   `sr-only` `" — not started"`), so a loose match counts twelve. Then click the rail link named `POS`
   (`page.getByRole('link', { name: 'POS' })`) and assert the empty state: the device code `POS1`
   is **not** on the page — `await expect(page.getByText('POS1')).toHaveCount(0)`.
   **The rail item's label is `POS` and its href is `/device` — that mismatch is deliberate** (T-30):
   `/pos` belongs to the till, so the dashboard page that manages it cannot have that URL, and no
   route outside the `(pos)` group may begin with the characters `pos` at all, because the
   service-worker scope is a string prefix (T-45 step 8 is the test). Click the label; never type the
   URL.

5. **Till context.** `const till = await browser.newContext(); const tillPage = await till.newPage();`
   **Do not pass `{ serviceWorkers: 'block' }`** — the till must be exercised in the configuration
   that ships. `playwright.config.ts` runs `pnpm build && pnpm preview`, so this is the PRODUCTION
   build and the service worker file really exists (SvelteKit bundles a service worker for
   production only — under `vite dev` it does not exist at all, which is why this suite must never
   be "fixed" by pointing it at the dev server). T-27 registers it manually with `{ scope: '/pos' }`
   after setting `kit.serviceWorker.register: false` — that is `/pos`, no trailing slash, because
   scope matching is a string prefix and `/pos/` would not match the landing URL `/pos`.
   Registration is asynchronous, so immediately after the first till page load call
   `await tillPage.evaluate(() => navigator.serviceWorker.ready)` once, so a later reload cannot
   race an activating worker. Close the context at the end of the test.
   In that context: `signIn(tillPage, owner)` — this is the step that puts a **real dashboard
   session on the counter device**, which is the thing step 7 then proves is destroyed.

6. **Register the device.** `registerDevice(tillPage, owner)`, then assert:
   - the employee-select screen is showing (T-25);
   - the device cookie exists with the right flags. Import its name as a constant from the module
     T-13 defined it in rather than retyping the string; assert `httpOnly === true` and
     `sameSite` is set, and assert `secure === true` **only** when
     `new URL(tillPage.url()).protocol === 'https:'` — this suite runs on `http://localhost:4173`,
     where the browser discards a `Secure` cookie. Copy the conditional shape from
     `e2e/auth.spec.ts` lines 155-162. **Never drop the `Secure` attribute to make local testing
     easier**: `localhost` is exempted from the secure-context rule, which is why this works.
   - **no token is in browser storage** (invariant 12): evaluate `Object.entries(localStorage)` and
     `Object.entries(sessionStorage)` in the till page and assert neither mentions the device cookie
     name or the word `session`.

7. **Assert the dashboard session on that device is GONE.** In the till context:
   `expect((await till.cookies()).find((c) => c.name === 'matcami_dashboard_session')).toBeUndefined()`,
   and `await tillPage.goto('/dashboard')` lands on `/login?next=` —
   `await expect(tillPage).toHaveURL(/\/login\?next=/)`. The owner context's own session is
   untouched: assert `page.goto('/dashboard')` still resolves to `/dashboard`.

8. **Create the cashier, then sign in at the till.** In the owner context,
   `createCashier(page, { displayName: 'The Cashier', pin: '4321' })` — four digits, the floor of
   spec 7's 4-6. Back in the till: `tillPage.goto(TILL_URL)`, pick `The Cashier`, enter one
   **wrong** PIN first (`9999`) and assert an error is shown and the till has **not** navigated,
   then enter `4321` and assert the till reaches the signed-in screen showing `The Cashier`.
   Finally, in the owner context, `page.reload()` on `/dashboard` and assert the checklist moved by
   exactly one step:
   `await expect(page.getByText('not started', { exact: true })).toHaveCount(5)`.
   **Five, and the arithmetic is six minus one.** The only step this journey completes is
   `Register the POS device` — T-32's `deviceRegistered`, true from step 6. Each of the other five
   is still `not started` for a reason this journey does not remove:
   - `Restaurant settings` — the journey never saves an auto-lock on `/device` (T-29's
     `?/setIdleLock`) and never fills the settings form, so `settingsComplete()` still reports
     `POS idle lock` missing, plus tax mode, tax rate and currency after T-36;
   - `Employees and PINs` — T-32's predicate is `status.cashierWithPin && status.waiterWithPin`, an
     **AND**, and this journey creates only the cashier;
   - `Menu, categories and modifiers` — no menu item is created, so T-43's step stays not started;
   - `Dining tables` and `Open the first POS session` — this plan builds neither.
   **Do not turn the 5 back into a 3 by claiming steps this journey never completes.** If a richer
   journey is wanted later, it must first create a waiter, save an auto-lock and fill the settings
   form — three more assertions, each naming the task it proves — and only then may the number drop.
   **Recount against `src/routes/(dashboard)/dashboard/+page.svelte`'s `steps` array before
   committing** — if a later task adds or removes a step, this number moves in that task's commit.

**Tests:** this task *is* a test. The named cases and their expected values:
- `/dashboard` immediately after registration → exactly 6 elements with the exact text
  `not started` — all six steps, because registration completes none of them (T-08, T-36).
- The dashboard `POS` page before registration → zero elements containing `POS1`; after → `POS1`
  visible.
- The device cookie after `POST /api/pos/register` → `httpOnly: true`, a `sameSite` value present,
  `secure: true` when and only when the page origin is `https:`.
- `matcami_dashboard_session` in the till context after registration → `undefined`; `/dashboard` in
  that context → redirected to a URL matching `/\/login\?next=/`.
- PIN `9999` for `The Cashier` → an error is visible and the URL is unchanged; PIN `4321` → the till
  shows `The Cashier`.
- `/dashboard` at the end → exactly 5 elements with the exact text `not started`: only
  `Register the POS device` has been completed by this journey.

**Done when:** `pnpm test:e2e` passes with `e2e/auth.spec.ts`, `e2e/smoke.spec.ts` and the new
`e2e/pos-access.spec.ts` all green in one run, and `pnpm lint` passes (`prettier --check .` and
`eslint .` both cover `e2e/`).

**Watch out:** `pnpm check` does **not** type-check `e2e/`. SvelteKit's generated
`.svelte-kit/tsconfig.json` includes `../src/**`, `../test/**` and `../tests/**` — not `../e2e/**` —
and Playwright strips types without checking them. So a type error in this spec is invisible to
`svelte-check` and only surfaces as a runtime failure. Read the symbols you import instead of
trusting autocomplete.
Second trap: `page.getByRole('link', { name: 'Employees' })` fails while the rail item is still
disabled. `src/lib/components/ui/Sidebar.svelte` renders an item with `href: null` as a
non-interactive `<span aria-disabled="true">` with a `Soon` pill — there is no link to click. T-31
and T-30 must have given `Employees` and `POS` real hrefs before this spec can pass; if they have
not, that is the bug, not the selector.

---

### T-45 — Add the service-worker scope and cache-policy test

**Needs:** T-27 (the service worker, scoped to `/pos`, and the web app manifest)
**Files:**
- `e2e/pos-service-worker.spec.ts` — NEW
- `src/service-worker.test.ts` — NEW (the companion unit test for T-27's four source-text
  conditions — step 8. `vitest.config.ts`'s `unit` project includes `src/**/*.test.ts`, so a file
  here is collected automatically and runs under `pnpm test`)
- `e2e/fixtures.ts` — EXTEND (created by T-44, which runs immediately before this task in this
  phase; import `TILL_URL`, `registerRestaurant`, `signIn` and `registerDevice`. Do not rewrite the
  file — T-44 wrote it and this task only imports from it.)
**Spec:** 6 (offline POS — Service Worker + IndexedDB; "The management dashboard (menu edits,
purchases, expenses, reports) requires a connection"), 9 (cookie sessions; authentication state
lives in HttpOnly cookies, never in client-readable storage), 5 (the POS asks
`GET /api/menu/version` and downloads `GET /api/menu` — a stale cached answer here is a POS selling
at last week's prices)
**Invariants:** 12 (POS access = registered device + PIN; the device cookie is revocable from the
dashboard — a revocation the browser serves from a cache is not a revocation), 8 (permissions are
enforced server-side on every route, reads included — an `/api` response answered from a cache was
enforced by nobody)

**Do:**

1. **Say in the file header why this test exists, so nobody deletes it as redundant.** Verbatim
   intent: *this pins the blocker the whole plan was shaped around.* `kit.serviceWorker.register`
   defaults to **true** and registers at scope **`/`**; route groups are not URL segments, so before
   T-23 there was no `/pos` path to scope a worker to at all. Left alone, the POS worker would
   control `/dashboard`, and authenticated dashboard HTML plus `__data.json` payloads would sit in
   Cache Storage — which `/logout` does not clear, and which therefore survives the owner signing
   out on a tablet that sits on a public counter. Every assertion below is load-bearing.

2. **One browser context for the whole test.** Cache Storage is partitioned per context, so the
   dashboard visit and the till visit must happen in the *same* context or the cache assertion
   proves nothing. `test.beforeAll`: `await acquireRunLock(); await resetDb();` from
   `../src/lib/server/db/test/reset`; `test.afterAll`: `await closeResetPool()`. Then
   `registerRestaurant(page, …)` — which leaves the owner signed in on `/dashboard`.

3. **Visit the dashboard, then the till, then come back.** `page.goto('/dashboard')` and
   `page.goto('/settings')` while signed in (these are the authenticated pages whose HTML must never
   be cached). Then `page.goto(TILL_URL)` and `await page.evaluate(() => navigator.serviceWorker.ready)`.
   Assert the scope:
   ```ts
   const scopes = await page.evaluate(async () =>
     (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)
   );
   expect(scopes).toHaveLength(1);
   expect(new URL(scopes[0]).pathname).toBe('/pos');
   ```
   and assert the till's own URL is *inside* that scope:
   `expect(new URL(page.url()).pathname.startsWith('/pos')).toBe(true)`. **No trailing slash in
   either literal, and this is the point of the assertion, not an oversight.** Scope matching is a
   plain string prefix on the client URL: `/pos` matches `/pos` — T-25's landing screen, which is
   `TILL_URL` — as well as `/pos/register` and `/pos/pin`. A `/pos/` scope would match the latter two
   and **not** the landing screen, so the till would work offline on every URL except the one it
   starts at. `toHaveLength(1)` is the other half: two registrations means SvelteKit's automatic
   root-scoped one came back because `serviceWorker: { register: false }` was dropped from
   `svelte.config.js`.
   A `/pos` scope is a string prefix over the **whole URL, not over path segments** — the W3C
   ServiceWorker specification's "Match Service Worker Registration" algorithm, whose own canonical
   example is that a scope of `https://www.google.com/maps` matches `https://www.google.com/mapsearch`
   (w3c/ServiceWorker issue 1272). MDN's prose implies path-segment matching; MDN is wrong on this
   point and the specification governs, so do not "correct" this back. The consequence is that any
   route outside the group whose path merely *starts* with the characters `pos` — a `/pos-device`, a
   hypothetical `/poster` — would be controlled by the till's worker. That is why the dashboard page
   which registers, revokes and launches the till is named **`/device`** (T-21, T-29, T-30) and not
   `/pos-device`: `/device` cannot be prefixed by `/pos` under any matching rule, so the collision is
   removed structurally instead of being reasoned about by every future reader. Step 8's companion
   test is the **ban** that keeps it removed — no route outside the `(pos)` group may have a path
   beginning with the characters `pos` — and T-02 records the same rule, with the same reason, in
   `CLAUDE.md`.

4. **Assert no dashboard route is controlled — `/device` above all.** Navigate back to `/dashboard`
   (still signed in, the worker now active) and assert
   `await page.evaluate(() => navigator.serviceWorker.controller) === null`. Repeat on `/login` and
   on **every** dashboard URL this plan ships: **`/device`** (the page that registers, revokes and
   launches the till — T-21, T-29), `/settings`, `/menu` (T-39) and `/employees` (T-31). Do all of
   them while still signed in — this is before step 5 registers the device and destroys the dashboard
   session on this context — and drive the list from an array so adding a route is one line.
   Controlled-ness is what decides whether a worker gets to answer a request at all, so this single
   assertion is the difference between a POS worker and a site-wide one.
   **`/device` is the load-bearing case, and it passes because of its name.** It is the dashboard
   page most likely to be sitting open on the counter tablet, and it is called `/device` rather than
   `/pos-device` precisely so the till's `/pos` scope — a string prefix over the whole URL — cannot
   reach it. If this assertion ever reads non-null for `/device`, a dashboard route has been put back
   inside the till's scope: either it was renamed to a path beginning with `pos` (T-45 step 8's test
   should have caught that first) or the registered scope widened. The fix is the route name or the
   scope — **never** a `.put(` in `src/service-worker.ts`, and never deleting the case.

5. **Assert the API and navigations are answered by the server, not a cache — by making the
   server's answer change.** Back on the till, evaluate
   `fetch('/api/pos/employees', { credentials: 'include' }).then((r) => r.status)`: with no device
   registered it is **403** (T-20 checks its permission server-side and returns 403 — invariant 8).
   Now `registerDevice(page, owner)`, and evaluate the *same* fetch again: it is **200**. A cached
   403 would still read 403. Do the same for the navigation: before registration `page.goto(TILL_URL)`
   shows T-24's registration screen; after registration the same URL shows T-25's employee-select
   screen. Same URL, same context, active worker, different answer — that is "from the network",
   asserted without depending on `Response.fromServiceWorker()`, which reports only that a worker
   called `respondWith`, not where the bytes came from.

6. **Enumerate Cache Storage and assert what is absent.** Registration destroys the owner's
   dashboard session on the device (T-18), which is this plan's logout on a POS device; assert
   `matcami_dashboard_session` is gone from `context.cookies()` first, then:
   ```ts
   const cached = await page.evaluate(async () => {
     const urls: string[] = [];
     for (const name of await caches.keys()) {
       const cache = await caches.open(name);
       for (const req of await cache.keys()) urls.push(req.url);
     }
     return urls;
   });
   ```
   Assert **no** entry whose pathname starts with `/dashboard`, `/settings`, `/login` or
   `/device`; **no** entry ending in `__data.json`; **no** entry whose pathname starts with
   `/api/`. `/device` belongs in that list even though step 4 just proved it sits outside the
   worker's scope: it is the dashboard page that lives on the counter tablet, so it is the
   authenticated HTML whose appearance in Cache Storage would matter most, and an assertion that
   holds only because of a route name is worth stating out loud rather than assuming. Assert with the
   offending URLs in the failure message (`expect(offenders, offenders.join('; ')).toEqual([])`), so
   a failure names the file instead of printing `false !== true`.

7. **Assert the manifest.** Read the href from the till document rather than hardcoding a filename
   T-27 chose: `await page.getAttribute('link[rel="manifest"]', 'href')`, then
   `const m = await (await page.request.get(href)).json()`. Assert
   `new URL(m.scope, page.url()).pathname === '/pos'`,
   `new URL(m.start_url, page.url()).pathname === '/pos'`, that **neither** resolves to `/`, and
   `m.display === 'fullscreen'` — the till is meant to install to a tablet home screen and look like
   a separate application, not a browser tab on the dashboard's origin. Both literals are `/pos`
   with no trailing slash, and T-27 step 6 explains why: `trailingSlash` is `never`, so a
   `start_url` of `/pos/` redirects, and a `start_url` that redirects is launched out of its own
   scope and the browser decorates the window with out-of-scope chrome.

8. **Assert the four source-text conditions T-27 handed to this task, in a companion unit test.**
   T-27 wrote "the tests themselves are **T-45**'s task" and listed its acceptance conditions; four
   of them are properties of the source, not of a running browser, so they belong in the Vitest
   `unit` project rather than in Playwright and would otherwise land nowhere. Create
   `src/service-worker.test.ts`, beside the file most of it asserts on.
   `src/lib/styles/tokens.test.ts` and `src/lib/components/components.test.ts` are the existing
   `readFileSync`-on-source precedent in this repo — read them and copy their shape, including
   putting the reason for each assertion in a comment so nobody deletes it as trivia. The four:
   - **The manifest colours still equal the POS ground.** Parse `static/pos.webmanifest` as JSON,
     and read the `--c-bg` declaration from inside the `[data-surface="pos"]` block of
     `src/lib/styles/tokens.css`; assert `background_color` and `theme_color` both equal it,
     compared case-insensitively. `src/lib/styles/tokens.test.ts` already has a
     `blockOf(css, selector)` that extracts a rule block by balancing braces (around line 40) and a
     `parseTokens` that splits its declarations — reuse that approach rather than writing a third
     CSS parser. A manifest is JSON: it cannot reference a custom property and cannot carry a
     comment, so this is the one colour in the repository that is legitimately duplicated, and
     T-27 step 6 says outright that this task is what keeps the two equal.
   - **Exactly one registration call in the whole source tree.** Walk `src/` and assert the literal
     `navigator.serviceWorker.register(` appears in exactly one file, and that that file is
     `src/routes/(pos)/pos/+layout.svelte`, and that the same line passes `scope: '/pos'`. Exclude
     this test file from its own walk — it contains every string it searches for, and included it
     would fail on its own source; `src/lib/components/components.test.ts` documents that trap at
     its `full !== SELF` line.
   - **No `put` in the worker.** Assert `src/service-worker.ts` contains no `.put(` at all and
     exactly one `addAll(`. T-27 made "never cache a response that varies by session" *structural*
     by allowing exactly one cache write — the `addAll` inside `install` — and this is the
     assertion that keeps it structural rather than remembered.
   - **No route outside the POS group may have a URL path beginning with the characters `pos`.**
     This is the structural guard, and it is this task's to own. A worker scoped to `/pos` matches by
     string prefix over the **whole URL, not by path segment** (the W3C algorithm; its own example is
     `/maps` matching `/mapsearch`), so a `/pos-device` or a future `/poster` would be controlled by
     the till's worker and served from the till's Cache Storage — which is why the dashboard POS page
     is `/device` (T-21, T-29, T-30) and why this is a test rather than a convention. Put that reason
     in one sentence in a comment beside the assertion: **a rule without its reason gets deleted by
     the next person who finds it arbitrary.** T-02 records the same rule and the same reason in
     `CLAUDE.md`; this assertion is what makes it true.
     Walk the route tree, build each route's URL path, and fail on any route outside the `(pos)`
     group whose path begins with `pos` — the failure message names the offending route id and
     repeats the reason. There is deliberately **no allow-list**: this plan ships no such route, the
     rename to `/device` is what removed the only candidate, and the answer to a future one is to
     rename it, never to widen this test. The rule subsumes the narrower "nothing else claims `/pos`
     or a path under `/pos/`", which are the till's own URLs — a dashboard page there would be
     answered from the till's cache offline, and SvelteKit would refuse to build a second `/pos`
     anyway.
     Walk `src/routes` the way `src/routes/route-guards.test.ts`'s `findServerFiles` and `routeIdOf`
     do (read them and reuse the idiom, including keeping `(group)` segments out of the URL path),
     but **widen the file set** to `+page.svelte` as well as the three server files that walk looks
     for: a route with only a `+page.svelte` still claims a URL, and `src/routes/(pos)/pos/+page.svelte`
     (T-25) is exactly such a route.
     Sanity-check the test before trusting it: rename a fixture route — or temporarily point the walk
     at a path list containing `/pos-device` — and confirm it **fails**. A prefix test that passes on
     `/pos-device` is asserting nothing, and `/pos-device` is the exact name this plan renamed away
     from.
   T-27's fifth source-level condition — `svelte.config.js` setting `serviceWorker: { register: false }`
   — is deliberately **not** repeated here: step 3's `toHaveLength(1)` fails the moment SvelteKit's
   automatic root-scoped registration returns, which is the behaviour that setting exists to
   prevent, and T-47 step 5 hand-checks the setting itself.

**Tests:** this task *is* a test; the named cases and expected values are in the steps above. Not
one of spec 29's six mandatory areas, but it is the regression test for the plan's headline blocker,
so it is not optional either.

**Done when:** `pnpm test:e2e` passes with `e2e/pos-service-worker.spec.ts` green, `pnpm test`
passes with `src/service-worker.test.ts` green, and deleting `{ scope: '/pos' }` from T-27's
`navigator.serviceWorker.register(...)` call makes the e2e spec **fail** (without the option the
scope defaults to the script's own directory, `/`, so step 3's pathname assertion and step 4's
`controller === null` on `/dashboard` both break) — check that by hand once, then put the option
back. A test that passes with the bug reintroduced is not a test.

**Watch out:** service workers require a secure context; `localhost` is exempt, which is the only
reason this runs at `http://localhost:4173`. Nothing here may be "fixed" by relaxing an attribute or
by pointing Playwright at `pnpm dev` — SvelteKit does not bundle a service worker in development, so
under the dev server this entire spec would silently assert nothing.
Second: `caches.keys()` legitimately returns the build's immutable asset cache (`/_app/immutable/…`).
Assert against a **deny list** of path shapes, never `toHaveLength(0)`, or this test fails on every
unrelated build.
Third: every **till** path literal in this task is `/pos`. If an assertion here fails and adding a
trailing slash makes it pass, the change under test broke T-27's scope, and the slash is hiding it.
**No other literal in this task begins with `pos`**, and that is the point of step 8's test: the
dashboard page that manages the till is `/device` (T-21, T-29), a different route and not a till
URL. Never "tidy" it into `/pos/device` or back into `/pos-device` — the first puts a dashboard page
inside the till's scope outright, the second puts it there by string prefix, and the second is the
one that looks harmless.

---

### T-46 — Add the offline PIN login e2e path

**Needs:** T-28 (the employee PIN bundle cached in IndexedDB, with `navigator.storage.persist()`),
T-44 (`e2e/fixtures.ts` and the registration + cashier journey)
**Files:**
- `e2e/pos-offline.spec.ts` — NEW
- `e2e/fixtures.ts` — EXTEND (created by T-44; import `TILL_URL`, `registerRestaurant`, `signIn`,
  `createCashier` and `registerDevice`. Do not rewrite it.)
**Spec:** 6 (Employee login while offline — "Switching employees offline uses PIN hashes cached on
the registered device (slow, salted hashes, refreshed on each sync)" and "Offline logins are
recorded locally and synced to the audit log"; "Idempotency keys. Every operation carries a unique ID
generated on the device, so the server ignores duplicates when a sync is retried"; "The POS calls
`navigator.storage.persist()`"), 7 (PIN rules — 4-6 digits, stored only as slow salted hashes),
29 (automated tests — "Offline sync: retries never create duplicates")
**Invariants:** 5 (every queued operation carries a device-generated idempotency key; a retry MUST be
a no-op; unsynced work is protected — `navigator.storage.persist()`), 12 (POS access = registered
device + PIN; PINs are 4-6 digits and stored only as slow salted hashes, never reversible, never
logged), 10 (sensitive actions are audit-logged; offline logins are the documented exception —
recorded locally and synced later)

**Do:**

1. **Before writing a single assertion, open `src/lib/pos/store.ts` and read what T-28 actually
   created** — the IndexedDB database name, the object store names, their `keyPath`s, and the shape
   of the cached employee bundle. As T-28 specifies them: database `matcami-pos`, stores
   `employees` (keyPath `id`), `settings` (keyPath `key`) and `offline_logins` (keyPath
   `clientOpId`), with an `offline_logins` record of
   `{ clientOpId, employeeId, event, occurredAt, outcome, synced }`. Every assertion below uses
   those exact spellings — **`clientOpId`, camelCase, is the local record's field**; the snake_case
   `client_op_id` is the `audit_log` **column** T-07 added and appears in this phase only in T-47
   step 6. Reading `client_op_id` off a cached record yields `undefined`, which makes an idempotency
   assertion pass or fail for the wrong reason. If the names in the code differ from the ones here,
   the code wins — report the mismatch rather than asserting against a shape nobody wrote.

2. **Scope statement, and it is part of the task, not a caveat:** *this plan does not build the sales
   sync queue or its flush.* Nothing between T-11 and T-28 posts a locally recorded offline login
   back to the server, so **this spec must not assert that it does.** The three assertions the brief
   wants about the flush — that coming back online writes exactly one `audit_log` row, and that
   replaying the same idempotency key into `audit_log.client_op_id` writes none — are the **next
   plan's obligation** and are recorded as such by T-47. Write that sentence into the file's header
   comment so the next author knows the gap is deliberate rather than forgotten. What *is* asserted
   below is the half this plan built: local verification, the locally stored record, and idempotency
   **at the local store**, which is a real "a retry never duplicates" assertion on a real layer.

3. **Set up online, then go offline.** `acquireRunLock()` + `resetDb()` in `beforeAll`,
   `closeResetPool()` in `afterAll`. `registerRestaurant(page, …)`, then three employees, because
   the behaviour under test is *switching* between them and one of them is spent on the lockout
   check in step 5: `createCashier(page, { displayName: 'The Cashier', pin: '4321' })`,
   `{ displayName: 'The Waiter', pin: '5678' }` and `{ displayName: 'The Runner', pin: '6789' }`.
   Then a till context (`browser.newContext()`, **no** `serviceWorkers: 'block'`), the persistence
   instrumentation from step 4 installed **before** the first page load, `signIn`, `registerDevice`,
   sign in once as `The Cashier` while online so the bundle is cached, and
   `await tillPage.evaluate(() => navigator.serviceWorker.ready)`.
   Assert the bundle landed: read the `employees` store through `page.evaluate` and assert it holds
   three records, each with a `pinHash` string and **no plaintext PIN anywhere in it** — assert the
   serialised bundle contains none of `4321`, `5678` or `6789`.

4. **Assert persistent storage was REQUESTED, not that the browser granted it.** T-28's
   `requestPersistentStorage()` calls `navigator.storage.persist()` from `openPosDb()` on first open
   and **returns the browser's boolean to the caller** so a screen can warn when it was refused.
   What this spec can assert deterministically is the call, not the grant: Chromium hands persistent
   storage only to an origin that is installed, bookmarked, holds notification permission or has
   accumulated site engagement, and a fresh Playwright context has none of those — so
   `navigator.storage.persisted()` returns `false` there against a perfectly correct implementation.
   - Before the till context's first page load, install a counter with `tillContext.addInitScript(…)`
     that wraps `navigator.storage.persist`, increments a `window.__persistCalls` counter and
     delegates to the original. The real method lives on `StorageManager.prototype`, so assigning to
     `navigator.storage.persist` shadows it with an own property; bind the original before
     replacing it.
   - After the first `/pos` load, assert `await tillPage.evaluate(() => window.__persistCalls)` is at
     least `1`. **That is the assertion** — spec 6 requires the till to ask.
   - Read `await tillPage.evaluate(() => navigator.storage.persisted())` and put it in the test
     output; **do not assert it is `true`.** If a hard `true` is wanted, earn it first:
     `await tillContext.grantPermissions(['notifications'], { origin: 'http://localhost:4173' })`
     before the first till load satisfies one of Chromium's grant heuristics, and only then is the
     assertion legitimate — say in a comment that the grant is what makes it deterministic.
   A `false` from `persisted()` is browser policy, not a defect: T-28 called
   `navigator.storage.persist()` exactly as specified. Do **not** "fix" it by editing
   `src/lib/pos/store.ts`.

5. **Prove the boundary T-28 step 7 draws: a server answer wins, and only a thrown `fetch` falls
   back to the cache.** Two halves, and the offline half is meaningless without the online one.

   **Online half — a server rejection is never retried against the cache.** Still online, on the PIN
   screen for `The Runner`, enter the wrong PIN `0000` five times. T-12's lockout then locks that
   employee for five minutes and `POST /api/pos/pin` starts answering with its locked-out response —
   read `src/routes/api/pos/pin/+server.ts` (T-19) for the exact status and body rather than
   hardcoding one. Now enter the **correct** PIN `6789`, still online, and assert the till **still
   refuses** and does not sign in. The cached hash for `The Runner` says that PIN is right, so a
   till that fell back to `verifyCachedPin` on a server *answer* would sign in here — that is an
   unlimited-guesses bypass of spec 7's five-attempts rule, and this is the only assertion in the
   plan that would catch it.

   **Offline half — the fallback fires, and the failed request is the proof.** Attach
   `tillPage.on('requestfailed', …)` into an array, then `await tillContext.setOffline(true)`.
   Return to employee-select, pick `The Waiter`, enter one **wrong** PIN (`0000`) and assert it is
   rejected offline — only a cached hash can produce that verdict with no network. Then enter `5678`
   and assert the till proceeds and shows `The Waiter`. Now assert **at least one failed request to
   `/api/pos/pin` was recorded** during the offline stretch, and that the till signed the employee in
   anyway from the cached hash. That failed request *is* the fallback: T-28 step 7 specifies it as a
   `catch` on a thrown `fetch`, and T-26 generates the `clientOpId` **before** the first `fetch`, so
   a correct till attempts the network on every offline attempt and fails. **Never assert the
   opposite.** Zero failed requests would mean the till short-circuited on `navigator.onLine` before
   calling the server — a design T-28 does not specify, and one that would make the online half
   above unreachable.

6. **Assert the offline session survives a reload.** Still offline, `tillPage.reload()` and assert
   the till renders rather than showing the browser's offline error page. This is spec 6's actual
   guarantee: a till that dies on refresh is not an offline till.
   **If this assertion fails, stop and report it — do not loosen it and do not touch the worker.**
   T-27 step 4 makes navigations **network-only with no offline fallback page**, deliberately,
   because a cached navigation response is authenticated HTML; and T-45 step 8 asserts the worker
   contains no `.put(` at all. So a failure here is a design question owed back to T-27 — whether
   the `/pos` shell needs a precached navigation response of its own, and how that can be made safe —
   not a licence to add a cache write to `src/service-worker.ts` or to drop this case.

7. **Assert the offline login was recorded locally with an idempotency key.** Read the
   `offline_logins` store (keyPath `clientOpId`) the record T-26 / T-28 wrote and assert: its
   `employeeId` names the employee who signed in, it carries an `occurredAt` ISO 8601 UTC string,
   and it carries a **non-empty string** `clientOpId`. Do the wrong-PIN-then-right-PIN switch a
   second time (back to `The Cashier`, PIN `4321`, still offline) and assert the two records'
   `clientOpId` values are **different** — a device-generated id that repeats is not an idempotency
   key. `clientOpId`, camelCase: that is the record's `keyPath`, not the `audit_log` column.

8. **MANDATORY (spec 29 — offline sync retries never create duplicates), at the layer this plan
   built.** Through `page.evaluate`, open `matcami-pos` and `add()` one of those records into
   `offline_logins` a **second time, byte-identical, same `clientOpId`** — exactly what a retried
   flush does. The request fails with a `ConstraintError`, which is precisely T-28's no-op
   semantics: `recordOfflineLogin` uses `add()` and swallows that one error name. Catch it in the
   evaluate, and assert the store still holds exactly the same number of records, with the same keys
   and with the **first** attempt's `occurredAt` intact. **Do not use `put()`** — it would silently
   overwrite and look identical in a row-count test, which is the failure T-28 chose `add()` to make
   impossible. If `offline_logins` does not key on `clientOpId`, that is the finding: report it,
   because a store that appends on retry makes the duplicate permanent the moment it reaches
   `audit_log`, whose append-only trigger (migration `0004_audit_log_append_only.sql`) blocks both
   `UPDATE` and `DELETE` and leaves no way to correct it. Then come back online
   (`setOffline(false)`), reload, and assert the local record is **still there** — unsynced work is
   never discarded (invariant 5).

**Tests:**
- MANDATORY (spec 29 — offline sync retries never create duplicates): `add()`ing the same
  `clientOpId` into `offline_logins` a second time rejects with `ConstraintError`, leaves the record
  count unchanged, and leaves the first `occurredAt` in place.
- Offline switch to `The Waiter` with PIN `5678` → the till shows `The Waiter`, **and at least one
  failed request to `/api/pos/pin` was recorded** — the fallback attempted the network and caught
  the throw.
- Online, `The Runner` locked out after five wrong PINs, then the correct PIN `6789` → still
  refused. A server answer is never retried against the cache.
- Offline wrong PIN `0000` for `The Waiter` → rejected from the cached hash.
- The cached `employees` bundle serialised to a string contains none of `4321`, `5678`, `6789`.
- `window.__persistCalls` after the first `/pos` load → at least `1`. The value of
  `navigator.storage.persisted()` is reported, not asserted, unless the notification permission was
  granted to the context first.
- Two offline logins → two `offline_logins` records with two different `clientOpId` values.
- Reload while offline → the till renders; reload after coming back online → the local record
  survives.

**Done when:** `pnpm test:e2e` passes with `e2e/pos-offline.spec.ts` green, and the file's header
comment names, in one sentence each, the three flush assertions this plan does not build and the
plan that owes them.

**Watch out:** `context.setOffline(true)` cuts the *page's* network; it deliberately does not stop
the service worker serving from its cache — that is the mechanism under test, not interference.
Do not "fix" a failing reload by disabling the worker.
Second trap: a PIN is 4-6 **digits**, so `4321` is a string, not a number. Leading zeros are legal —
which is why the wrong PIN in step 5 is `0000` — and anything that round-trips a PIN through
`Number()` loses them. Never write a plaintext PIN into a log, a cookie, a query string or an
assertion message — and never assert on the hash's *value*, only on its presence and on the absence
of the plaintext.
Third: the till's IndexedDB record field is `clientOpId` and the `audit_log` column is
`client_op_id`. They hold the same id and are spelled differently on purpose; mixing them up reads
`undefined` and the assertion silently stops testing anything.

---

### T-47 — Run the full verification sweep and record what is still open

**Needs:** T-44 (the device + PIN e2e journey), T-45 (the service-worker scope and cache test),
T-46 (the offline PIN login path), T-43 (the `Menu` rail item and its onboarding step)
**Files:**
- `CLAUDE.md` — EDIT (**verify only**; three places: the `## Non-negotiable invariants` item **1**,
  whose wording T-01 corrected to match where the money module actually lives; the
  `## Open decisions — UNRESOLVED (spec 33)` table, whose rows T-03 deleted for the decisions it
  obtained, moving them to `## Decisions already made (NOT open — do not re-litigate)`; and T-02's
  bullet in that same "Decisions already made" section recording the `/pos` prefix rule — no route
  outside the `(pos)` group may have a path beginning with the characters `pos`, because the
  service-worker scope is a string prefix — **with its reason**, which is the half that keeps it from
  being deleted. T-01, T-03 and T-02 own those edits. Touch this file here **only** if the sweep
  finds a mismatch, and confine the diff to those three places — `.prettierignore` excludes
  `CLAUDE.md` precisely so a formatter cannot widen it.)
- No other file is expected to change. The deliverable of this task is the sweep result and the
  hand-off list, written into the pull request description.
**Spec:** 29 (Operations — the six areas that get automated tests from day one, and "A backup is
always taken before running database migrations"), 8 (server enforcement — `403 Forbidden`, "hiding
buttons in the frontend is not considered security"), 33 (open decisions), 31 (MVP vs Future — what
is deliberately not built)
**Invariants:** 1 (money is integer minor units in `bigint`; no float, no `parseFloat`, no second
rounding helper), 2 (posted records are permanent — `audit_log` is append-only at the database
level), 8 (permissions enforced server-side on every POS API route, reads included, returning `403`),
11 (timestamps stored UTC in `timestamptz`), 12 (POS access = registered device + PIN)

**Do:**

1. **Run all six, in this order, one at a time — never two at once.** `pnpm test`,
   `pnpm test:integration` and `pnpm test:e2e` all point at `matcami_test` and all truncate it; the
   advisory lock in `src/lib/server/db/test/reset.ts` serialises concurrent runners, but do not rely
   on it to paper over a parallel invocation. `nvm use` first — `engines` refuses any Node but
   24.21.0.
   ```
   pnpm check            # svelte-kit sync && svelte-check
   pnpm lint             # prettier --check . && eslint .
   pnpm test             # vitest run — BOTH projects, unit and integration
   pnpm test:integration # the integration project alone
   pnpm build            # adapter-node → build/index.js
   pnpm test:e2e         # playwright, against `pnpm build && pnpm preview --port 4173`
   ```
   `pnpm test` already runs the integration project (`vitest.config.ts` declares `unit` and
   `integration`), so the fourth command is a re-run — run it anyway: it is the command the house
   documents and it is the one that proves the guard in
   `src/lib/server/db/test/reset.ts` still **refuses any database whose name does not end in
   `_test`**. All six must exit 0. Record each result.

2. **Permissions (invariant 8).** List every `+server.ts` under `src/routes/api/` and every
   `export const actions` under `src/routes/(dashboard)/`, and confirm each one calls
   `requirePermission`, `requireOwner` or `requireUser` from `$lib/server/permissions` **in its own
   body** — including `GET` handlers, because reads count — and that a denial produces `403`, not a
   redirect. Confirm `src/routes/route-guards.test.ts` is green and that its assertion
   `expect([...PUBLIC_ROUTE_IDS].sort()).toEqual([...])` (line 103 before this plan) lists exactly
   the set T-17 deliberately opened and nothing more. Confirm T-22's per-route permission test
   covers every one of `/api/pos/register`, `/api/pos/pin`, `/api/pos/employees`,
   `/api/menu/version` and `/api/menu`, and that revocation's permission test is T-22 step 7's case
   **(c)** — `actions.revoke` in `src/routes/(dashboard)/device/+page.server.ts`, called with a
   cashier principal and expected to be exactly `403`. **There is deliberately no `/api/pos/revoke`
   route**: T-21 rejected the endpoint and kept revocation as a dashboard form action, which gets
   SvelteKit's origin/CSRF check for free, and T-22 step 4's pinned route-id array — the one T-40
   and T-41 extend with `/api/menu/version` and `/api/menu` — is what keeps one from appearing.
   Finding no `/api/pos/revoke` coverage is therefore the design working, not a gap in the sweep:
   confirm instead that `ls src/routes/api/pos/` shows exactly `employees`, `pin` and `register`.
   **Never create that route to satisfy this list** — the file fails T-22 step 4 the moment it
   exists. Confirm **no new permission key was coined**: the only keys
   in `src/lib/server/permissions/keys.ts` are spec 8's ten POS keys plus the eight
   `admin.*` extension keys (`admin.settings`, `admin.menu`, `admin.inventory`, `admin.purchases`,
   `admin.expenses`, `admin.reports`, `admin.employees`, `admin.devices`).

3. **Money (invariant 1).** Confirm every money column in `src/lib/server/db/schema/` is `bigint`
   holding integer minor units, that every tax rate is an integer in **basis points** (`825` =
   8.25%, never `0.0825`), and that `src/lib/server/db/schema-guards/schema.test.ts` now carries
   T-04's **positive** assertion — the pre-existing test only rejected `real`, `double precision` and
   *unconstrained* `numeric`, so `numeric(12,2)` for a price would have sailed through. Confirm the
   guard actually **sees** the menu tables: it discovers tables by walking the schema barrel, so a
   schema file nobody imports is invisible to all three guards. Cross-check the same table names
   appear in `TABLES` in `src/lib/server/db/test/reset.ts` (before this plan:
   `['audit_log','sessions','users','restaurant_settings','restaurants']`).

4. **No float, no second rounding rule.** `grep -rnE "parseFloat|toFixed|\bNumber\(|[0-9]+\.[0-9]+" src/lib src/routes`
   and check every hit by hand: none may be money or tax arithmetic, and none may be a rounding
   helper outside `src/lib/money/`. Spec 17 requires **one** rounding rule in **one** function used
   by the POS, the server and reports; two implementations that agree today diverge the day open
   decision 3 is answered, and a receipt then prints a different total from the one the books record.
   Confirm `src/lib/server/money/` holds only DB-touching helpers, per T-01.

5. **The POS boundary, and the worker's registration switch.**
   `grep -rn "lib/server" src/lib/pos "src/routes/(pos)"` must return nothing —
   `eslint.config.js`'s `no-restricted-imports` block enforces it, and `pnpm lint` passing is the
   proof, but run the grep too because a `.svelte` file with an unusual import spelling is exactly
   the case a rule can miss. Confirm `svelte.config.js` now sets `kit.serviceWorker.register: false`
   (before this plan it set no `serviceWorker` key at all, and the default is **true**, which
   registers at scope `/`), and confirm `kit.csrf` is still unset so SvelteKit's origin check stays
   on.
   Then hand-check the **prefix rule**, which is the thing that keeps the scope's reach harmless.
   T-27 registers `/pos`, and scope matching is a string prefix over the whole URL — not over path
   segments — so any route outside the group whose path begins with the characters `pos` would be
   controlled by the till's worker. This plan removes that class of bug structurally rather than by
   vigilance: the dashboard POS page is **`/device`** (T-21, T-29), and its rail item is still
   *labelled* `POS` (T-30) — only the href differs, because `/pos` belongs to the till. Confirm four
   things and record a pass/fail for each:
   - `ls "src/routes/(dashboard)/"` shows `device/` and **no** `pos-device/`;
   - `grep -rn "pos-device" src/routes/ e2e/` returns nothing. **Scope the walk to `src/routes/`
     and `e2e/`, never to all of `src/`.** The rename was of a ROUTE, not of the modules: this
     plan deliberately keeps `src/lib/server/auth/pos-device.ts` (T-13) and
     `src/lib/server/db/schema/pos-devices.ts` (T-05), and a grep over all of `src/` would
     therefore record a failure against a correct implementation;
   - `CLAUDE.md` carries T-02's bullet stating the rule **and its one-sentence reason** — a rule
     recorded without its reason is one the next reader deletes as arbitrary, so a bullet that has
     lost the reason is a finding, not a nitpick;
   - T-45 step 8's route-prefix test and T-45 step 4's `/device` controller assertion are both green.
     They are the enforcement; do not re-derive them by hand here.
   **Fix nothing here** — this task edits no source file (see its `Files:` block), and `CLAUDE.md` is
   touched only under the narrow terms that block sets out. Anything that fails goes into the PR.

6. **`audit_log`'s device columns, and their ordering (invariant 2).** Against `matcami_test`,
   confirm `audit_log` has `device_id` and `client_op_id` and a **partial** `UNIQUE
   (device_id, client_op_id)`. Then confirm the migration that added them is numbered **before** any
   migration or code path that writes a device-sourced row — that ordering is the whole point:
   migration `0004_audit_log_append_only.sql` blocks `UPDATE` and `DELETE`, so a duplicate written
   before the constraint existed can never be corrected, only reversed. `client_op_id` is the column
   spelling; the till's local record spells the same id `clientOpId` (T-28), and T-46 asserts on
   that one.

7. **The POS surface, and the retired tokens.** Run the unit project over
   `src/lib/styles/tokens.test.ts` and confirm it is green, including the `RETIRED_CHROME` assertion
   (`['--c-screen','--c-key','--c-key-line','--c-key-ink']`, around line 95) and the
   `[data-surface="pos"]` block assertions (around lines 79 and 155-170) that require the POS scope
   to re-declare the **complete** palette — grounds, inks, accent, status, `var()` aliases and
   shadow rungs — not just the grounds. Confirm `src/service-worker.test.ts` (T-45 step 8) is green
   too, including its assertion that the manifest's `background_color` and `theme_color` still equal
   the `--c-bg` declared inside that same `[data-surface="pos"]` block. Spot-check T-23's POS
   screens: every pressable surface carries a `border-control-line` edge (a white key on the POS
   ground is 1.22:1, so elevation alone cannot carry a control's boundary — WCAG 1.4.11), and every
   status is paired with its glyph, never colour alone. Confirm no arbitrary Tailwind value
   (`bg-[#…]`, `p-[57px]`) entered any new component.

8. **Write the hand-off into the pull request description**, under two headings.
   `## Verification sweep` — the six commands with their results, and the six hand-checks above with
   a pass/fail each.
   `## What this plan did not build, and what the next plan inherits` — name every one, because a
   till that cannot sell looks finished from the outside:
   - the **sales sync queue and its flush**, including posting locally recorded offline logins to
     the server; T-46 asserts local idempotency only and says so;
   - the **device invoice sequence** (`POS1-000001`, gap-free per device, `UNIQUE (device_id, invoice_number)`);
   - **POS sessions and shifts** — opening cash, count, reconciliation, end-of-day, and the business
     date every report groups by;
   - **printing** — receipts, kitchen tickets and the drawer, through the local print agent;
   - **the order and payment transaction** — spec 13's single all-or-nothing transaction, invoices,
     journal entries and stock movements. This plan writes **no** journal entry and **no** posting
     rule at all;
   - **dining tables** and the floor plan;
   - the **Inventory**, **Purchases**, **Expenses** and **Reports** dashboard pages, still `Soon` in
     the rail.
   Then name every open decision still unanswered after T-03 — check `CLAUDE.md`'s
   `## Open decisions — UNRESOLVED (spec 33)` table and list the rows that are still there, plus the
   `RESEARCH.md` **GAP** about a 4-6 digit PIN being brute-forceable over 10^6 once the cached
   hashes are on a stolen tablet, and which of its three options (accept / require 6 digits / expire
   the cached bundle) the user chose. If a row T-03 was supposed to answer is still in the table,
   say so plainly rather than closing the plan over it.

**Tests:** no new test file. The six commands in step 1 are the test, and every one must exit 0.
Spec 29's six mandatory areas, and where this plan stands on each: **money arithmetic and rounding**
— covered by T-33's unit tests; **tax in both modes** — covered by T-34's; **permission check on
every POS API route** — covered by T-22; **offline sync retries never duplicate** — covered at the
local-store layer by T-28's unit test and T-46's browser test, with the server flush owed by the next
plan; **journal entries balance** and **one posting-rule test per spec 24 event** — *not applicable*,
this plan writes no journal entry and no posting rule. Say that explicitly in the PR rather than
leaving two of six unmentioned.

**Done when:** all six commands exit 0 on a clean checkout of the feature branch with nothing
uncommitted; each of the six hand-checks in steps 2-7 is recorded with a pass/fail; and the pull
request description contains both headings from step 8, with the open-decision list filled in rather
than left as a placeholder.

**Watch out:** `pnpm db:migrate` runs `pnpm db:backup` **first, automatically** — do not run
`drizzle-kit migrate` directly to "save time"; spec 29 requires the backup and the script is where
that requirement lives. And never hand-edit a migration that has already run (invariant 2 governs
the same instinct): if step 6 finds the `audit_log` columns missing or mis-ordered, the fix is a new
migration, not an edit to `0004_audit_log_append_only.sql` or to any of the five that shipped before
this plan.
Second: a green suite is not the same as a correct one. Four of the six hand-checks above —
`bigint` money columns, the `$lib/server` boundary, the partial `UNIQUE`, and the complete POS
palette — exist precisely because each of them has a failure mode where **every test stays green**.
Do not shorten this step because the commands passed.
