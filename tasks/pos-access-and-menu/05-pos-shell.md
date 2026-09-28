# Phase 4 — The POS shell

The screens on the counter. This phase gives the till a real `/pos/...` URL prefix, pins the POS
surface so the device looks the same under either viewer theme, and builds the three screens the
access half needs — device registration, employee select, PIN entry — plus the service worker, the
web app manifest and the first IndexedDB store in the repository. Everything here is a `.svelte`
page or a `src/lib/pos/` module; the server work it calls was built in Phase 3 and is reached over
`fetch`. The till after this phase can be registered, can sign an employee in and can survive a
reload with no network. **It still cannot sell** — orders, payment, printing and the sync queue are
a later plan.

**Depends on:** Phase 3 (T-17 opened `/pos` and `/api/pos` in the route guard; T-18, T-19, T-20 and
T-21 are the endpoints these screens call). **Nothing under `src/routes/(pos)/**` may import
`$lib/server`** — `eslint.config.js` already carries a `no-restricted-imports` block targeting
`src/lib/pos/**/*.{ts,svelte}` and `src/routes/(pos)/**/*.{ts,svelte}` with the groups
`$lib/server/*`, `$lib/server/**`, `../server/*` and `**/lib/server/**`. SvelteKit build-blocks
`$lib/server` from the browser anyway; the eslint rule catches the `lib/pos/` half that SvelteKit
does not police. These pages talk to the Phase 3 endpoints over `fetch` and to nothing else.

**No `+layout.server.ts` and no `+page.server.ts` anywhere under `src/routes/(pos)/`.** That is a
standing rule of the group, written into `src/routes/(pos)/+layout.svelte`, and no task in this
phase may break it: a blocking server `load` is the seam that makes the till useless the moment the
network drops. A consequence worth knowing before you start: `src/routes/route-guards.test.ts` walks
only `+page.server.ts`, `+layout.server.ts` and `+server.ts`, so it never sees these pages at all.
Do **not** add a server file under `(pos)` to satisfy that test — the guard decision for `/pos/...`
was made by T-17 in `src/hooks.server.ts`.

---

### T-23 — Move the `(pos)` group under a real `/pos` URL prefix and pin the POS surface

**Needs:** T-02 (the `/pos` URL prefix and service-worker policy decision), T-17 (`/pos` opened in
the route guard)
**Files:**

- `src/routes/(pos)/pos/+layout.svelte` — NEW (the POS shell: the `data-surface="pos"` stamp and
  the page ground)
- `src/routes/(pos)/+layout.svelte` — EDIT (the whole file is a `<script>` comment block plus
  `{@render children()}`; extend the comment, keep the pass-through markup unchanged)
- `src/lib/styles/tokens.test.ts` — EDIT (inside the existing `describe('the token contract', …)`
  block, beside the existing `it('pins the POS scope — it declares every token the dark blocks
  theme', …)`)

**Spec:** 6 (the offline POS: no blocking server load, the till keeps working with no network),
7 (POS authentication — the till is a distinct surface from the dashboard)
**Invariants:** 12 (POS access = registered device + PIN; the POS shell is what a registered device
shows)

**Do:**

1. **Understand the thing that is most likely to be "simplified" away: a route GROUP is not a URL
   segment.** `src/routes/(dashboard)/dashboard/+page.svelte` serves at `/dashboard` because of the
   inner `dashboard/` directory, **not** because the group is called `(dashboard)`. The parenthesised
   name contributes nothing to any path — it appears in `event.route.id` and nowhere in the URL. So
   `src/routes/(pos)/+layout.svelte` contributes nothing to any URL today and **there is no `/pos`
   path in this application at all**. A page put at `src/routes/(pos)/till/+page.svelte` would serve
   at `/till`. Every POS page must therefore sit under an inner `pos/` directory to serve at
   `/pos/...`. Do not "flatten" that directory away later: the service worker scope (T-27), the web
   app manifest scope (T-27) and the route ids T-17 opened in `src/hooks.server.ts` all key off the
   real `/pos` prefix.
2. **Create `src/routes/(pos)/pos/+layout.svelte`** as the POS shell. **Keep the group layout where
   it is and add an inner one — do not move, rename or delete
   `src/routes/(pos)/+layout.svelte`.** Two reasons, both of which belong in the new file's
   comment:
   - The group layout wraps whatever is inside the group regardless of URL. Stamping the surface
     there would also stamp a page someone later adds at `src/routes/(pos)/anything/+page.svelte`,
     which serves at `/anything` — outside the service worker's scope, outside the manifest's scope
     and outside the route ids T-17 opened. That page would *look* correct (right palette, right
     touch sizes) while being unreachable offline and guarded differently. Putting the shell on the
     inner `pos/` layout makes the URL prefix structural: to get the POS shell you must be under
     `/pos`.
   - The group layout is the written record of the group's two hard constraints (never import
     `$lib/server`; no server `load`). Deleting it deletes the reason the group has no
     `+layout.server.ts`.
3. The shell's markup is one element that stamps the surface and paints the ground:

   ```svelte
   <script lang="ts">
   	let { children } = $props();
   </script>

   <div data-surface="pos" class="text-pos bg-bg text-ink min-h-screen">
   	{@render children()}
   </div>
   ```

   `bg-bg` and `text-ink` are **not** redundant. `src/lib/styles/base.css` sets
   `body { background-color: var(--c-bg); color: var(--c-ink); }`, and `body` sits *outside* the
   `[data-surface="pos"]` scope, so it resolves the page's themed `--c-bg` — the dashboard's dark
   ground for a dark-theme viewer. Painting the stamped element with `bg-bg` makes it resolve the
   **pinned** value from inside the scope. `min-h-screen` stops the themed body ground showing
   through under a short page.

4. **The POS surface is LIGHT and PINNED in BOTH themes.** `src/lib/styles/tokens.css` already
   carries the `[data-surface="pos"]` block and it pins the **complete** palette — grounds, inks,
   accent, the semantic and status families, the disabled pair, the `var()` aliases `--c-ring` and
   `--c-control-line`, the rail family and all four shadow rungs. Do not add a `@media
   (prefers-color-scheme: dark)` override for this scope, and do not remove a declaration from it
   because "the POS does not use the rail". A surface pinned one way whose inks still theme is the
   defect that has already shipped twice in this project — pinned dark with light inks (1.08:1),
   then pinned light with dark inks (1.21:1).
5. **The four retired chrome tokens `--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink` must
   not reappear** — not in `tokens.css`, not in a component, not in a comment.
   `src/lib/styles/tokens.test.ts` already asserts their absence from `tokens.css`; do not write a
   replacement vocabulary for them. The POS uses the ordinary ground names (`bg-bg`, `bg-raise`,
   `text-ink`) so a component is portable between surfaces.
6. **Every pressable POS surface takes a `border border-control-line` edge.** A white key
   (`--c-raise` `#ffffff`) on the POS ground (`--c-bg` `#e4e9ee`) measures **1.22:1**, so elevation
   alone cannot carry a control's boundary and WCAG 1.4.11 asks 3:1 of one. `--c-control-line`
   resolves to `--c-ink-3` (`#5c6771`), 4.73:1 on that ground. `border-line` is 1.55:1 here and is
   decorative only — never a control edge. Write this rule into the shell's comment; T-24, T-25 and
   T-26 all depend on having read it.
7. **Extend the comment in `src/routes/(pos)/+layout.svelte`** with a third numbered constraint
   beside the two already there: pages live under the inner `pos/` directory so they serve at
   `/pos/...`; a page placed directly in the group serves at a top-level URL and silently escapes
   the service-worker scope, the manifest scope and T-17's guard opening. Leave the existing two
   constraints and the `{@render children()}` markup exactly as they are.
8. Add nothing else to this task: no `+page.svelte` (T-25 creates the landing screen), no
   `+layout.server.ts`, no `+page.server.ts`, no manifest link (T-27), no connection indicator
   (T-25). `/pos` legitimately 404s until T-25 runs.

**Tests:**

- `pnpm lint` passes. That is the check that no file under `src/routes/(pos)/` imports
  `$lib/server` — `eslint.config.js` already has the `no-restricted-imports` block for
  `src/routes/(pos)/**/*.{ts,svelte}`. **Do not add a second grep-based test for the same rule**: a
  duplicate of an existing enforcement drifts from it and then passes against the wrong pattern.
- `src/lib/styles/tokens.test.ts` — add one `it(…)` beside the existing POS-pinning assertion:
  `[data-surface="pos"]` declares a value for **every** `--c-*` name declared in the bare `:root`,
  with exactly one exemption list — the six menu-category bands `--c-cat-grills`, `--c-cat-rice`,
  `--c-cat-somali`, `--c-cat-drinks`, `--c-cat-sides`, `--c-cat-sweets`. The test must **prove the
  exemption rather than trust it**: assert each exempted name is absent from *both* dark blocks
  (`mediaDark` and `stampDark`), so a token may only be exempt while it is theme-invariant. The
  existing parsed maps `bare`, `mediaDark`, `stampDark` and `posScope` are already in scope at the
  top of the file; reuse them, do not re-parse. With `tokens.css` as it stands this passes
  unchanged — its value is that adding a themed token to `:root` and forgetting the POS scope now
  fails.
- The existing `describe('no arbitrary value escapes the token file', …)` block walks every
  `.svelte` file under `src/` and rejects `[#rrggbb]`, `[NNpx]` and raw `#rrggbb`. The new layout
  must pass it: tokens only, no arbitrary Tailwind values.

**Done when:** `pnpm lint`, `pnpm check`, `pnpm test src/lib/styles/tokens.test.ts` and `pnpm build`
all pass; `src/routes/(pos)/pos/+layout.svelte` exists and contains the literal
`data-surface="pos"`; `src/routes/(pos)/+layout.svelte` still exists and still renders
`{@render children()}`; and `find "src/routes/(pos)" -name '+*.server.ts'` prints nothing.

**Watch out:** `resolve` from `$app/paths` types its argument against the routes that currently
exist, so `resolve('/pos')` is a type error until a page exists under `src/routes/(pos)/pos/`. That
is T-25's problem, not this task's — do not create a placeholder page to make an import type-check.

---

### T-24 — Build the device registration screen

**Needs:** T-18 (`POST /api/pos/register`), T-23 (the `/pos` prefix and the POS shell)
**Files:**

- `src/routes/(pos)/pos/register/+page.svelte` — NEW

**Spec:** 7 (POS device registration: "Owner logs in on the POS device (email + password)" →
"Register this device as POS1" → "Server issues a long-lived device cookie (HttpOnly, Secure)" →
"PIN login accepted only from registered devices"), 9 (HttpOnly + Secure + SameSite cookies; no
tokens in `localStorage`)
**Invariants:** 12 (POS access = registered device + PIN; the device cookie is HttpOnly + Secure and
revocable from the dashboard; never `localStorage`), 8 (permissions are enforced server-side — this
screen is a form, not a gate)

**Do:**

1. Create `src/routes/(pos)/pos/register/+page.svelte`, serving at `/pos/register`. It is shown when
   the till has no valid device cookie; T-25's landing screen sends the user here when
   `GET /api/pos/employees` answers **403**, which is the one status T-20 returns for a missing,
   unknown or revoked device cookie.
2. **Write the reason for email + password into a comment at the top of the file, in these terms.**
   The first instinct is to ask for the owner's email alone. It is wrong twice over: an email
   address is **public** — it is printed on receipts and sits on the restaurant's own signage — and
   a registered device is the thing spec 6 ships **cached employee PIN hashes** to, so that anyone
   can switch employees while the network is down. Email alone would let anyone standing at the
   counter mint a till and walk away with the staff's PIN hashes. Spec 7 asks for email **and**
   password, once, on the device itself.
3. The form collects three values: owner **email**, owner **password**, and a **device label** the
   owner will recognise in the dashboard's device list ("counter tablet"). Read
   `src/routes/api/pos/register/+server.ts` (created by T-18) and use its zod schema's field names
   **verbatim** — do not invent names and do not change the endpoint to match the screen.
4. Submit with `fetch`, not a native form POST. There is no `+page.server.ts` under `(pos)` to
   receive a form action, and there must not be one.

   ```ts
   const res = await fetch('/api/pos/register', {
   	method: 'POST',
   	headers: { 'content-type': 'application/json' },
   	body: JSON.stringify({ /* T-18's field names */ })
   });
   ```

   Do **not** pass `credentials: 'include'`. `fetch`'s default is `same-origin`, which already sends
   and accepts cookies for this same-origin request; `include` is a cross-origin signal a till on
   its own origin never needs. Use a real `<form onsubmit={(event) => { event.preventDefault(); … }}>`
   so Enter submits and the browser's own autofill works.
5. On a 2xx the server has already set the long-lived device cookie **and** destroyed the owner's
   dashboard session on this device. Both cookies are HttpOnly: this page must not try to read, set
   or clear either, and must not store anything in `localStorage` or `sessionStorage`. Navigate to
   the till's landing screen with `goto(resolve('/pos'))`, importing `goto` from `$app/navigation`
   and `resolve` from `$app/paths` — the `svelte/no-navigation-without-resolve` eslint rule fails
   lint on a bare path string.
6. **Say on screen, before the owner submits, that registering signs them out of the dashboard on
   this device.** Plain words, in the form itself, not a tooltip and not after the fact: "Registering
   this device signs you out of the dashboard here. Use another computer for the dashboard — this
   tablet becomes the till." An owner who discovers that after the fact assumes the app broke.
7. Errors are shown **inline**, never a toast: one `<p role="alert">` region above the submit key,
   `bg-danger-bg text-danger`, carrying a glyph as well as the colour (`✕` marked `aria-hidden`)
   because colour never carries meaning alone. Read the status codes
   `src/routes/api/pos/register/+server.ts` actually returns and map each to one sentence a person at
   a counter can act on — wrong credentials, not the owner account, a device already registered
   (tell them to revoke it from the dashboard first), too many attempts. Never render a bare status
   code, a stack, or the response body verbatim.
8. Touch sizing and tokens — the POS floors, no arbitrary values:
   - both text inputs and the label input: `min-h-touch` (64px), `bg-raise`, `border
     border-control-line`, `rounded-control`, `text-pos`
   - the submit key: `min-h-touch-lg` (72px), `bg-accent text-accent-ink border border-control-line`
   - at least `gap-2` between controls
   - a control disabled while the request is in flight uses `bg-disabled-bg text-disabled-ink` and
     keeps its `border-control-line` edge — **never `opacity`**, which composites fill and ink
     together and defeats every contrast pair `tokens.css` audits
   - **do not import `$lib/components/ui`'s `Button`**: its own comment says it is a dashboard
     control on Tailwind's default spacing and must never take the POS touch tokens. Write the key's
     markup here.
9. The password never leaves this page: `type="password"`, `autocomplete="current-password"` (and
   `autocomplete="username"` `inputmode="email"` on the email field), no `console.log` of the
   request body or the response, never in a URL or a query string, and set the bound value back to
   `''` in the submit handler's `finally` branch.

**Tests:**

- This is a `.svelte` page and `vitest.config.ts` defines exactly two projects, both
  `environment: 'node'` with no jsdom and no browser mode, so there is no component test to write.
  Its automated coverage is: `pnpm check` (svelte-check), `pnpm lint` (eslint, including the
  `$lib/server` import ban for `src/routes/(pos)/**`), and the existing
  `describe('no arbitrary value escapes the token file', …)` in `src/lib/styles/tokens.test.ts`,
  which walks every `.svelte` file under `src/` and fails on `[#rrggbb]`, `[NNpx]` or a raw hex.
- The end-to-end journey through registration is T-44's; do not write a partial version of it here.

**Done when:** `pnpm lint`, `pnpm check`, `pnpm test src/lib/styles/tokens.test.ts` and `pnpm build`
all pass, and against a running build a manual registration with the owner's real email and password
leaves the browser holding a device cookie and no session cookie, with the till showing `/pos`.

**Watch out:** the device cookie is `Secure`, and a service worker and `navigator.storage.persist()`
both require a secure context. `localhost` is exempted by every browser, which is why the till works
under `pnpm preview` on `http://localhost:4173`. **Never drop `Secure` to make some other local host
name work** — that is a production-grade hole opened for a development convenience, and
`docs/deployment.md` already covers TLS for the real deployment.

---

### T-25 — Build the employee-select screen

**Needs:** T-20 (`GET /api/pos/employees`), T-23 (the `/pos` prefix and the POS shell)
**Files:**

- `src/routes/(pos)/pos/+page.svelte` — NEW (the till's landing screen at `/pos`)
- `src/routes/(pos)/pos/+layout.svelte` — EXTEND (created by T-23; add the connection indicator bar
  above `{@render children()}` inside the `data-surface="pos"` element — do not rewrite the file)

**Spec:** 7 (the POS shows "Select Employee / Cashier / Waiter / PIN", and only a registered device
may show the PIN screen), 6 (the offline POS; the connection state is on screen at all times)
**Invariants:** 12 (POS access = registered device + PIN), 8 (permissions are enforced server-side —
`GET /api/pos/employees` does its own check and returns 403; this screen renders the answer, it does
not decide it)

**Do:**

1. Create `src/routes/(pos)/pos/+page.svelte`. This is spec 7's **"Select Employee"** screen and the
   till's landing URL.
2. Fetch the directory in `onMount`: `await fetch('/api/pos/employees')`. Read
   `src/routes/api/pos/employees/+server.ts` (created by T-20) for the exact JSON shape and use it
   verbatim; it carries at least each employee's id, display name and role. **It also carries each
   employee's PIN hash**, deliberately — spec 6 requires a registered device to hold cached hashes so
   an employee can be switched while offline. This screen must never render that field, never put it
   in the DOM, never `console.log` the response and never write it anywhere except the IndexedDB
   store T-28 adds.
3. Render one large key per employee, showing the display name and the role beneath it. Each key:
   `min-h-touch-lg` (72px), `bg-raise`, `border border-control-line`, `rounded-control`, name in
   `text-ink`, role line in `text-ink-2`; at least `gap-2` between keys. The key face is `bg-raise`,
   which is the one surface `text-ink-3` is legal on (5.13:1) — use `text-ink-2` for anything that
   sits on the POS ground instead. Do not use `$lib/components/ui`'s `Button`: it is a dashboard
   control and its own comment forbids the POS touch tokens.
4. Selecting an employee navigates to the PIN screen:
   `goto(resolve('/pos/pin') + '?employee=' + encodeURIComponent(id))`, with `goto` from
   `$app/navigation` and `resolve` from `$app/paths` (bare path strings fail the
   `svelte/no-navigation-without-resolve` lint rule). An employee id is not a secret and already
   appears in this list; **the PIN never appears in a URL** (T-26).
5. **Failure states get words, not a dead screen.** Branch on the response and render an explanation
   plus an action, each inside a `role="alert"` region with a glyph as well as a colour:
   - **403** — the only device-related status T-20 returns, and it covers all three device states:
     no device cookie at all, a cookie value the server does not recognise, and a device the owner
     revoked from the dashboard. T-20's first line is `requireDevice(event)`, which throws
     `error(403, 'Forbidden')` for every one of them, and its mandatory test asserts exactly `403`
     in all three cases — so **write no 401 branch**: nothing can reach it, and splitting the two
     would put revocation wording in front of an owner whose till was simply never registered. One
     sentence covering both states: "This device is not registered as a till, or its registration
     was revoked. Register it again to use it as a till." plus a key that goes to `/pos/register`.
   - **A thrown `fetch`** (no network): "No connection, and this device has not cached an employee
     list yet." plus a **Retry** key. T-28 replaces this branch with a read of the cached directory;
     leave a comment naming T-28 so the next session finds the seam.
     Confirm the actual codes against `src/routes/api/pos/employees/+server.ts` before writing the
     branches — if T-20 returns something else, follow the endpoint and do not change it.
6. **The connection indicator is permanent chrome**, which is why it goes in the layout and not in
   this page: every POS screen carries it, and a toast that disappears is exactly what spec 6
   forbids. In `src/routes/(pos)/pos/+layout.svelte`, above `{@render children()}` and inside the
   `data-surface="pos"` element, add a bar that renders:
   - online — the glyph `●` (`aria-hidden`, `font-mono`) **and the word "Online"**, `text-ok` on
     `bg-ok-bg`
   - offline — the glyph `◆` (`aria-hidden`, `font-mono`) **and the word "Offline"**,
     `text-st-offline` on `bg-st-offline-bg`

   Both the glyph and the word, always: colour never carries meaning alone (WCAG 1.4.1; roughly one
   man in twelve has red-green colour vision deficiency). Both pairs are already in the contrast
   census in `src/lib/styles/tokens.test.ts`. Drive it from `navigator.onLine` seeded in `onMount`
   plus `online` and `offline` window listeners, removed in the effect's cleanup; initialise the
   `$state` to `true` so server-rendered HTML does not claim "Offline" before any listener exists.
7. **There is no unsynced count yet** — this plan builds no sync queue. Show the connection state
   only, and write a comment beside it saying so: spec 6 requires the number of unsynced operations
   to be on screen at all times, and that number arrives with the sales plan that creates the queue.
   Do **not** render a hardcoded `0`: a count that is always zero is a lie the moment a queue exists.

**Tests:**

- No component test exists to write: `vitest.config.ts` has two `environment: 'node'` projects, no
  jsdom, no browser mode. Coverage is `pnpm check`, `pnpm lint` (including the `$lib/server` import
  ban for `src/routes/(pos)/**`) and the `.svelte` arbitrary-value scan in
  `src/lib/styles/tokens.test.ts`.
- The registered-device journey through this screen is T-44's and the offline path is T-46's. Do not
  write partial versions here.

**Done when:** `pnpm lint`, `pnpm check`, `pnpm test src/lib/styles/tokens.test.ts` and `pnpm build`
all pass; against a running build `/pos` on a registered device lists every active employee with
their role and the bar reads `● Online`; toggling the browser to offline changes it to `◆ Offline`
with no reload; and `/pos` on a browser with no device cookie shows the "not registered" sentence
and a key that reaches `/pos/register`.

**Watch out:** `navigator` does not exist during SSR. Read `navigator.onLine` only inside `onMount`
or an `$effect`, never in a top-level `$state` initialiser, or `pnpm build` fails while prerendering
nothing in particular and the error points at the wrong file.

---

### T-26 — Build the PIN entry screen with lockout and idle return

**Needs:** T-19 (`POST /api/pos/pin`), T-25 (the employee-select screen that navigates here),
T-08 (the nullable `pos_idle_lock_seconds` column on `restaurant_settings`)
**Files:**

- `src/routes/(pos)/pos/pin/+page.svelte` — NEW
- `src/lib/pos/idle.ts` — NEW (the idle watch, kept pure so it is unit-testable in a node
  environment)
- `src/lib/pos/idle.test.ts` — NEW

**Spec:** 7 ("PINs are 4–6 digits… After 5 wrong attempts, the employee is locked out for 5 minutes
and an audit event is logged. The POS returns to the employee selection screen after a set idle
time (default 2 minutes, configurable)"), 6 (every operation carries an idempotency key generated on
the device, so the server ignores duplicates when a sync is retried)
**Invariants:** 12 (PINs are 4–6 digits, stored only as slow salted hashes, never reversible, never
logged; 5 wrong attempts lock the employee for 5 minutes; the POS returns to employee-select after
idle), 5 (every queued operation carries a device-generated idempotency key and a retry MUST be a
no-op), 10 (the audit row is written in the same transaction as the action — the server's job; this
screen supplies the idempotency key that stops a retry writing a second one)

**Do:**

1. Create `src/routes/(pos)/pos/pin/+page.svelte`, serving at `/pos/pin`. Read the selected employee
   from `page.url.searchParams.get('employee')` (`page` from `$app/state`); with no `employee`
   parameter, send the user back to `/pos` with `goto(resolve('/pos'))` rather than rendering an
   anonymous keypad.
2. Render a numeric keypad: keys `0`–`9`, a backspace key and a clear key, each
   `min-h-touch-lg min-w-touch-lg` (72px square), `bg-raise`, `border border-control-line`,
   `rounded-control`, digits in `font-mono text-ink`, at least `gap-2` between keys. The submit key
   is `min-h-touch-lg`, `bg-accent text-accent-ink border border-control-line`. Do not import
   `$lib/components/ui`'s `Button` — it is a dashboard control and must never take the POS touch
   tokens.
3. **Never render the PIN.** Show one `●` per entered digit (`aria-hidden`, `font-mono`) and an
   `aria-live="polite"` count such as "4 digits entered" for a screen reader. Accept 4 to 6 digits:
   ignore a keypress past the sixth, and keep the submit key disabled below four with a visible
   reason ("Enter at least 4 digits") rather than a dead grey key. A disabled key uses
   `bg-disabled-bg text-disabled-ink` and keeps its `border-control-line` edge — never `opacity`.
4. **Generate the idempotency key once per attempt.** At the top of the submit handler, before the
   first `fetch`, call `crypto.randomUUID()` into a local `clientOpId` and send it with the request.
   Reuse that same value if you retry **the same** attempt after a network failure — that is what
   makes T-19's retry a no-op instead of a second audit row — and generate a **new** one for the
   next attempt the person makes. Store it in a local, not in module scope: a module-level value
   would be shared by the next employee.
5. Submit by `fetch`, never a native form POST (there is no `+page.server.ts` under `(pos)` and there
   must not be one):

   ```ts
   const res = await fetch('/api/pos/pin', {
   	method: 'POST',
   	headers: { 'content-type': 'application/json' },
   	body: JSON.stringify({ /* T-19's field names: the employee id, the pin, the client op id */ })
   });
   ```

   Read `src/routes/api/pos/pin/+server.ts` (created by T-19) and use its zod schema's field names
   verbatim. Never `GET`, never a query string, never a header: **the PIN goes in the request body
   and nowhere else.** No `console.log` of the body, the response or the digits.
6. On success the server returns `{ employeeId, displayName, role }` and sets **no** cookie — T-19
   issues no employee session in this plan — so the signed-in employee lives only in this page's
   local state; the later sales plan decides how an employee identity travels with a request. There
   is nothing here to read, set or clear, and nothing goes into `localStorage` or `sessionStorage`
   either. Replace the keypad in place with a panel reading "Signed in as {displayName} ({role})"
   and one key back to `/pos`, and leave a comment saying the order screen arrives with the sales
   plan. **Do not invent an order screen or a `/pos/order` route here**: this plan's scope is
   explicit that the till can be registered and logged into and cannot sell.
7. **Lockout: the server owns the counter, the screen renders it.** Read the failure shapes from
   `src/routes/api/pos/pin/+server.ts` (T-19) and branch on exactly these two:
   - **`401`** with body `{ error: 'invalid_pin' }` — a wrong PIN **and** an employee id the server
     does not recognise return the identical status and the identical body, deliberately, so the
     screen cannot be used to enumerate which employee ids exist on this device. Show one wrong-PIN
     sentence for both; do not try to tell them apart.
   - **`423`** with body `{ error: 'locked_out', retryAfterMs }` — `retryAfterMs` is a **duration in
     milliseconds**, not a timestamp. There is no date field in this body: the lock's `timestamptz`
     column is a server-side detail that never leaves the server, so do not look for an ISO 8601
     string and do not parse one.

   Compute the unlock moment **once**, at the instant the `423` arrives —
   `const unlockAt = Date.now() + retryAfterMs` — and tick the remaining time down from that with a
   one-second `setInterval` rendering `Math.max(0, unlockAt - Date.now())`, so the countdown cannot
   drift with the interval's own lateness. Disable every key while locked and put the reason in
   words beside them: "Locked after 5 wrong attempts. Try again in 4:12." A disabled control must
   **say why** rather than sit dead. Do **not** count attempts client-side as the source of truth —
   a page reload would reset it, which is exactly the bypass the server-side counter exists to
   close. Clear the interval on destroy, and when the remaining time reaches zero clear it and
   re-enable the keys rather than leaving it running.
8. **Create `src/lib/pos/idle.ts`** — the idle watch, pure and DOM-free so it unit-tests in the node
   environment `vitest.config.ts` provides:

   ```ts
   export interface IdleWatch {
   	poke(): void;
   	stop(): void;
   }
   export function createIdleWatch(options: {
   	seconds: number | null;
   	onIdle: () => void;
   }): IdleWatch;
   ```

   - `seconds === null` returns an **inert** watch: `poke()` and `stop()` are no-ops and `onIdle`
     never fires. That is the behaviour when nothing has been cached yet.
   - Otherwise it arms a `setTimeout` for `seconds * 1000`; `poke()` restarts it; `stop()` clears it;
     `onIdle` fires at most once per armed period.
   - The module attaches **no** DOM listeners. The page wires `pointerdown` and `keydown` to
     `poke()` and removes them in its own cleanup, so the module stays testable.

9. **Take the idle timeout from the restaurant setting, and never hardcode one.** The value is the
   restaurant setting `pos_idle_lock_seconds` that T-08 added as a **nullable** column with **no**
   column default, because open decision 6 ("approval limits and lock timing") is still unanswered
   and spec 7's "default 2 minutes" is a spec default, not a decision this plan has been given.
   It reaches the device from `GET /api/pos/employees` (T-20), whose body is
   `{ employees, settings }` with `settings.posIdleLockSeconds` typed `number | null` and passed
   through unsubstituted; T-28 caches it in the POS IndexedDB `settings` store and wires this page
   to read it back with `readCachedIdleSeconds()`. A server `load` is not an option and never was —
   there is none under `(pos)` and there must not be one — which is precisely why the value travels
   in that response and through the cache. **That transport is what satisfies invariant 12's "the
   POS returns to employee-select after idle".**
   **In this task the store does not exist yet** (T-28 creates `src/lib/pos/store.ts`), so pass
   `seconds: null` here and leave a comment at the call site naming T-28 as the task that replaces
   the literal with the cached read. `null` is `createIdleWatch`'s defined inert case (step 8): no
   timer is armed, and the page renders one line saying so — "Automatic return to employee select
   is not configured yet." That line is also the honest state **after** T-28, whenever the owner has
   not set the value or nothing has been cached on this device yet, so write it as a real branch on
   the value rather than as a placeholder to be deleted later.
   **Never write `120` — or any other number — here**, and none may appear in `src/lib/pos/idle.ts`
   either. Writing one would silently answer an open decision in a Svelte component, which is the
   worst place in the repository for an answer to hide: invisible to the settings page, invisible to
   the schema, and invisible to whoever finally puts the question to the owner. The answer belongs
   in `restaurant_settings.pos_idle_lock_seconds` and nowhere else.
10. When the watch does fire, it clears the entered digits and navigates to `resolve('/pos')`.
11. **Clear the PIN from memory on navigation.** Set the digits `$state` back to `''` in the submit
    handler's `finally` branch, in the `$effect` cleanup and in `onDestroy`. Never put it in
    `localStorage`, `sessionStorage`, IndexedDB, a store, a URL or a data attribute.

**Tests:**

- `src/lib/pos/idle.test.ts`, with `vi.useFakeTimers()`:
  - `createIdleWatch({ seconds: null, onIdle })` — advancing the clock ten minutes calls `onIdle`
    **zero** times, and `poke()` and `stop()` do not throw. This is the assertion that stops a
    default sneaking back in.
  - `createIdleWatch({ seconds: 120, onIdle })` — `onIdle` has been called **0** times at 119,999 ms
    and **1** time at 120,000 ms.
  - `poke()` at 100,000 ms — `onIdle` has been called **0** times at 219,999 ms and **1** time at
    220,000 ms.
  - `stop()` at 10,000 ms — `onIdle` is called **0** times after advancing a further ten minutes.
  - the watch fires **once**, not repeatedly: after `onIdle` fires, advancing another ten minutes
    leaves the call count at **1**.
- The page itself has no component test to write (two `environment: 'node'` vitest projects, no
  jsdom, no browser mode). Its coverage is `pnpm check`, `pnpm lint` and the `.svelte`
  arbitrary-value scan in `src/lib/styles/tokens.test.ts`. The lockout and offline journeys are
  T-44's and T-46's.

**Done when:** `pnpm test src/lib/pos/idle.test.ts` passes with all five cases; `pnpm lint`,
`pnpm check` and `pnpm build` pass; against a running build a correct PIN shows the signed-in panel,
five wrong PINs produce a locked keypad whose visible countdown ticks down and whose keys carry a
written reason, and `grep -rn "console.log" src/routes/\(pos\)/pos/pin/` prints nothing.

**Watch out:** `crypto.randomUUID()` needs a **secure context**. It is available on `https://` and on
`localhost` (which is why `pnpm preview` on `http://localhost:4173` works) and is `undefined` on a
plain-`http` LAN address. If it is missing, fail the attempt with a written message — do **not**
substitute `Math.random()`, which would hand invariant 5's idempotency key a collision-prone source
and let a retry write a second audit row that migration `0004_audit_log_append_only.sql` makes
permanent.

---

### T-27 — Add the service worker, scoped to the POS prefix, and the web app manifest

**Needs:** T-02 (the `/pos` URL prefix and service-worker registration policy decision), T-23 (the
POS shell, which is the only place the worker is registered from)
**Files:**

- `src/service-worker.ts` — NEW
- `static/pos.webmanifest` — NEW
- `static/pos-icon.svg` — NEW (a byte-for-byte copy of `src/lib/assets/favicon.svg`; the bundled
  asset has a hashed URL and a manifest needs a stable one)
- `svelte.config.js` — EDIT (inside the `kit` block, beside `adapter: adapter()`)
- `src/routes/(pos)/pos/+layout.svelte` — EXTEND (created by T-23; add the manifest `<link>` and the
  manual registration — do not rewrite the file)

**Spec:** 6 (the offline POS uses a service worker, IndexedDB and a local sync queue), 9 (cookie
sessions; nothing authenticating is stored where it can be read back), 29 (deployment is HTTPS only)
**Invariants:** 12 (sessions are HttpOnly + Secure cookies, never `localStorage` — and never a cached
authenticated response either), 5 (the till protects unsynced work; its shell must load with no
network)

**Do:**

1. **Override the default, and know what you are overriding.** SvelteKit automatically registers a
   `src/service-worker.ts` **at scope `/`**, injected into every server-rendered page. Left alone,
   the POS worker would control `/dashboard`, and cached authenticated HTML and `__data.json`
   payloads would sit in Cache Storage — which `/logout` does not clear, because signing out deletes
   a cookie and knows nothing about a cache. In `svelte.config.js`, inside `kit`, beside the existing
   `adapter: adapter()` (mind the comma; a long comment about the CSRF origin check follows it and
   must be left in place):

   ```js
   	adapter: adapter(),

   	// Registered BY HAND from the POS layout, scoped to the till — see
   	// src/routes/(pos)/pos/+layout.svelte. The default is automatic registration
   	// at scope '/', which would put the POS worker in charge of /dashboard and
   	// leave cached authenticated HTML and __data.json in Cache Storage that
   	// /logout does not clear.
   	serviceWorker: { register: false }
   ```

   `register: false` turns off **registration only**. SvelteKit still bundles `src/service-worker.ts`
   and still serves it at `/service-worker.js`.

2. **Register it from the POS layout and from nowhere else.** In
   `src/routes/(pos)/pos/+layout.svelte`:

   ```ts
   import { dev } from '$app/environment';
   import { onMount } from 'svelte';

   onMount(() => {
   	if (!('serviceWorker' in navigator)) return;
   	const register = () =>
   		navigator.serviceWorker.register('/service-worker.js', {
   			scope: '/pos',
   			type: dev ? 'module' : 'classic'
   		});
   	if (document.readyState === 'complete') register();
   	else addEventListener('load', register, { once: true });
   });
   ```

   `type: 'module'` is required in dev because the worker is served unbundled there; the production
   build is classic. Do not wrap a bare `addEventListener('load', …)` without the `readyState`
   check — `onMount` frequently runs after `load` has already fired, and the listener would never
   run. Registering a script at `/service-worker.js` with a **narrower** scope needs no
   `Service-Worker-Allowed` header; only widening beyond the script's own directory would.
   `$app/environment` is not `$lib/server`, so the `(pos)` import ban does not apply to it.
3. **The scope is `/pos`, not `/pos/`, and this is the trap in the whole task.** Service-worker scope
   matching is a plain **string prefix** on the client URL. `/pos/` does not match the URL `/pos`,
   which is the till's own landing screen (T-25) — so a `/pos/` scope would leave the landing screen
   **uncontrolled**, none of its subresources would come from the cache, and the till would fail to
   load offline while `/pos/pin` worked. `/pos` matches `/pos`, `/pos/register` and `/pos/pin`. It
   would also match a future `/poster`, so record in the layout's comment that no route id outside
   the POS group may begin with the literal `pos`.
4. **Write `src/service-worker.ts` as network-only for anything that can vary by session, and
   cache-only for the shell.** There is exactly **one** cache write in the file, `addAll` inside
   `install`. There is **no** `cache.put` anywhere, which is how the rule "never cache a response
   that varies by session" is made structural rather than remembered.

   ```ts
   /// <reference types="@sveltejs/kit" />
   /// <reference lib="webworker" />
   import { build, files, version } from '$service-worker';

   const sw = self as unknown as ServiceWorkerGlobalScope;
   const CACHE = `matcami-pos-${version}`;
   const PRECACHE = [...build, ...files];
   const PRECACHE_SET = new Set(PRECACHE);
   ```

   - `install` — `caches.open(CACHE)` then `addAll(PRECACHE)`, then `sw.skipWaiting()`.
   - `activate` — delete every cache key that is not `CACHE`, then `sw.clients.claim()`.
   - `fetch` — return without calling `event.respondWith` (i.e. let the network handle it) for
     **every** one of these, in this order: a request whose `method` is not `GET`; a request whose
     `url` origin is not `location.origin`; a request whose `mode` is `'navigate'`; a URL whose
     pathname starts with `/api/`. Only a pathname present in `PRECACHE_SET` is answered, and then
     from the cache alone. Everything else — `__data.json`, the manifest fetch, anything unforeseen —
     falls through to the network untouched.
   - **Navigations are network-only with no offline fallback page.** A cached navigation response is
     authenticated HTML, and the whole reason for `register: false` is that such a response must
     never reach Cache Storage.

   Write the reason for each network-only branch as a comment: the next person's instinct will be to
   add a stale-while-revalidate for navigations, and that is the exact defect this file exists to
   avoid.
5. `build` and `files` are **empty during development** and the worker is bundled only for
   production. Note it in the file: nothing precaches under `pnpm dev`, so offline behaviour is only
   observable against `pnpm build && pnpm preview` — which is also why `playwright.config.ts` runs
   the e2e suite against the production build rather than the dev server.
6. **Write `static/pos.webmanifest`** (prettier formats `.webmanifest` as JSON — tabs, per
   `.prettierrc` — so run `pnpm format` afterwards):

   ```json
   {
   	"name": "matcami POS",
   	"short_name": "matcami POS",
   	"scope": "/pos",
   	"start_url": "/pos",
   	"display": "fullscreen",
   	"orientation": "landscape",
   	"background_color": "#e4e9ee",
   	"theme_color": "#e4e9ee",
   	"icons": [
   		{ "src": "/pos-icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
   	]
   }
   ```

   - **Never `/`.** `src/routes/+page.server.ts` redirects `/` to `/dashboard` or `/login`, so an
     installed till launched at `/` would open the dashboard's login screen instead of the till.
   - **`/pos`, not `/pos/`.** SvelteKit's `trailingSlash` default is `never`, so `/pos/` answers with
     a redirect to `/pos`; a `start_url` that redirects outside its own `scope` launches the
     installed app out of scope and the browser decorates the window with out-of-scope chrome. The
     scope and the `start_url` are both `/pos` and never `/pos/`, for the trailing-slash reason in
     step 3 — which also keeps the manifest scope and the worker scope identical, one fewer thing to
     get out of step.
   - `background_color` and `theme_color` are the **literal value of `--c-bg` inside
     `[data-surface="pos"]`** in `src/lib/styles/tokens.css` (`#e4e9ee`). A manifest is JSON and
     cannot reference a CSS custom property and cannot carry a comment, so this is the one place in
     the repository a colour is legitimately duplicated — and T-45 asserts the two stay equal rather
     than trusting them to.
7. Copy the icon: `cp src/lib/assets/favicon.svg static/pos-icon.svg`. Record the known gap in the
   layout's comment rather than leaving it to be discovered: Chromium accepts an SVG manifest icon,
   **iOS Safari does not** — it uses `<link rel="apple-touch-icon">` with a PNG, and no PNG is
   generated here, so an iPad home-screen install shows a page thumbnail instead of an icon. That is
   a cosmetic gap on one platform, not a functional one, and generating raster icons is not this
   task's work.
8. Link the manifest from the POS shell only, so no dashboard page advertises the till as
   installable. In `src/routes/(pos)/pos/+layout.svelte`:

   ```svelte
   <svelte:head>
   	<link rel="manifest" href="/pos.webmanifest" />
   </svelte:head>
   ```

**Tests:** the tests themselves are **T-45**'s task. State these as its acceptance conditions and do
not write a partial version here:

- `svelte.config.js` sets `serviceWorker: { register: false }`.
- The only `navigator.serviceWorker.register(` call anywhere under `src/` is in
  `src/routes/(pos)/pos/+layout.svelte`, and it passes `scope: '/pos'`.
- `src/service-worker.ts` contains **no** `cache.put(`, and its only cache write is an `addAll`
  inside the `install` handler.
- `src/service-worker.ts` returns without responding for `mode === 'navigate'` and for a pathname
  starting with `/api/`.
- `static/pos.webmanifest` parses as JSON with `scope === '/pos'`, `start_url === '/pos'` and
  `display === 'fullscreen'`.
- `background_color` and `theme_color` equal the `--c-bg` value declared inside the
  `[data-surface="pos"]` block of `src/lib/styles/tokens.css`.
- No route id outside the POS group begins with the literal `pos`.

**Done when:** `pnpm build` succeeds and emits a `service-worker.js` at the client root of `build/`;
`pnpm lint` and `pnpm check` pass; and against `pnpm preview`, DevTools → Application → Service
Workers shows **one** worker whose scope is `http://localhost:4173/pos`, `/dashboard` reports **no**
controller, and Cache Storage after visiting `/pos` and `/dashboard` contains only hashed `_app`
assets and static files — no HTML document and no `__data.json`.

**Watch out:** a service worker sees the subresource requests of every **client it controls**, not
only URLs under its scope. That is why the scope is what decides whether `/dashboard` is affected,
and why `/pos` versus `/pos/` decides whether the till's own landing screen can load offline. Verify
the controller on the real URLs rather than reasoning about the string.

---

### T-28 — Cache the employee PIN bundle in IndexedDB and persist storage

**Needs:** T-11 (the isomorphic PIN hash module `src/lib/pin/`), T-15 (the employee directory read
model), T-20 (`GET /api/pos/employees` — its `{ employees, settings }` body is what this store
caches), T-27 (the service worker and the secure-context requirements it shares)
**Files:**

- `src/lib/pos/store.ts` — NEW (the first IndexedDB code in this repository)
- `src/lib/pos/store.test.ts` — NEW
- `src/routes/(pos)/pos/+page.svelte` — EXTEND (created by T-25; after a successful
  `GET /api/pos/employees`, write the employee directory **and** the settings block through to the
  store, and read from the store in the no-network branch — do not rewrite the file)
- `src/routes/(pos)/pos/pin/+page.svelte` — EXTEND (created by T-26; add the offline verification
  fallback beside the existing `fetch` call, and replace T-26's placeholder `seconds: null` at the
  `createIdleWatch` call site with the cached value — do not rewrite the file)

**Spec:** 4 (IndexedDB holds the menu, prices, tax configuration, restaurant settings and the
employee list for PIN login), 6 ("Switching employees offline uses PIN hashes cached on the
registered device (slow, salted hashes, refreshed on each sync)"; "Offline logins are recorded
locally and synced to the audit log"; "The POS calls `navigator.storage.persist()` so the browser
does not evict its IndexedDB data"), 29 (mandatory test: offline sync retries never create
duplicates)
**Invariants:** 5 (every queued operation carries a device-generated idempotency key and a retry MUST
be a no-op; unsynced work is protected with `navigator.storage.persist()`), 12 (PINs are 4–6 digits
stored only as slow salted hashes, never reversible, never logged), 10 (sensitive actions are
audit-logged; an offline login is recorded locally and synced later)

**Do:**

1. **Create `src/lib/pos/store.ts`.** This is the first IndexedDB code in the repository and the
   menu-snapshot store, the order store and the sync queue will all be copied from its shape, so the
   `onupgradeneeded` idiom must be explicit and versioned rather than clever:

   ```ts
   const DB_NAME = 'matcami-pos';
   const DB_VERSION = 1;

   function upgrade(db: IDBDatabase, oldVersion: number): void {
   	// A fall-through switch on oldVersion, one case per version step. Each case
   	// creates only what THAT version added and must NOT `break` — a browser two
   	// versions behind runs every later case in order. Adding a store later means
   	// adding `case 1:` below and bumping DB_VERSION; it never means editing case 0,
   	// because a device already at version 1 will never run it again.
   	switch (oldVersion) {
   		case 0:
   			db.createObjectStore('employees', { keyPath: 'id' });
   			db.createObjectStore('settings', { keyPath: 'key' });
   			db.createObjectStore('offline_logins', { keyPath: 'clientOpId' });
   		// falls through
   	}
   }
   ```

   Export `openPosDb(): Promise<IDBDatabase>` wrapping `indexedDB.open(DB_NAME, DB_VERSION)`, with
   `onupgradeneeded` calling `upgrade`, and `onerror`/`onblocked` rejecting with a message naming the
   database — a silent open failure is a till that looks fine and forgets everything.
2. **The three stores and their exact shapes.**
   - `employees`, keyPath `id`: `{ id: string; displayName: string; role: 'owner' | 'cashier' |
     'waiter'; isActive: boolean; pinPhc: string | null }` — **exactly the five keys
     `GET /api/pos/employees` returns, and no sixth.** T-20 returns T-15's projection unchanged and
     pins it with a mandatory test asserting, for every entry, that `Object.keys(entry).sort()`
     equals `['displayName', 'id', 'isActive', 'pinPhc', 'role']`. A field declared here that the
     response does not carry fails `pnpm check` at step 6's write-through and tempts a session into
     widening the endpoint to satisfy the type; a field the response carries and this store drops
     throws part of the bundle away silently.
     **The field is `pinPhc`, not `pinHash`, and the name is load-bearing — keep it on the device
     too.** T-15 step 4 chose it because `SECRET_KEY_PATTERN` in `src/lib/server/audit/index.ts`
     (`/pass|pin|token|hash|secret|cookie|authorization/i`) matches it, so passing one of these
     objects to `writeAudit` throws instead of writing a credential derivative into an append-only
     table. Renaming it here destroys that tripwire on the one copy of the bundle that lives outside
     the server.
     `pinPhc` is `null` for an employee who has no PIN set. T-15 step 8 returns those rows
     deliberately and T-20 does **not** drop them — T-25 renders them as unavailable, because hiding
     them makes "why is Sam missing from the till?" unanswerable from the screen — so the cached type
     is `string | null` and `verifyCachedPin` must handle it (step 3). `isActive` is `true` on every
     row that arrives, because T-15's own query filters `is_active = true`; it is cached to keep the
     shape honest, not to be re-checked here. The value of `pinPhc` is the PHC-style string T-06
     stores in the database and T-11 produces — parameters travel inside it, so a later cost-factor
     change does not invalidate cached hashes. **Never log it, never render it, never copy it into
     `localStorage`.**
   - `settings`, keyPath `key`: `{ key: string; value: unknown }`. Store only the keys the till needs
     offline. The one this plan names is `posIdleLockSeconds`, whose value is `number | null` — the
     column T-08 added is nullable with **no** column default because open decision 6 is unanswered.
     **Store `null` as `null`.** Do not coalesce it to `120` on the way in or on the way out: that
     would answer an open decision inside a cache, which is the hardest place in the product to find
     it later.
     **This store has a real writer and a real reader in this plan.** `GET /api/pos/employees`
     (T-20) answers `{ employees, settings }`, where `settings` is
     `{ posIdleLockSeconds: number | null }` read from `getRestaurantWithSettings` and passed
     through without substitution. Step 6 caches it here beside the employees, and T-26's PIN screen
     reads it back through `readCachedIdleSeconds()` to arm its idle watch (step 7). That transport
     exists because invariant 12 requires the POS to return to employee-select after an idle period,
     and `(pos)` has no server `load` by design and must not gain one — so this cache is the only
     path the value has to the screen.
   - `offline_logins`, keyPath `clientOpId`: `{ clientOpId: string; employeeId: string; event:
     string; occurredAt: string; outcome: 'success' | 'failed'; synced: false }`. `occurredAt` is an
     ISO 8601 **UTC** string capturing the real moment of the login, because `audit_log.occurred_at`
     is deliberately distinct from the row's write time so an offline login carries its true time.
     `event` is the literal event name T-14 added to the `AuditEvent` discriminated union in
     `src/lib/server/audit/events.ts` — open that file and copy the string. It is copied rather than
     imported because `src/lib/pos/**` may not import `$lib/server/**`; say so in a comment beside
     it, so the duplication is deliberate and findable.
3. **Export the operations, each taking no `IDBDatabase` argument and opening the db itself.**
   - `cacheEmployees(employees): Promise<void>` — one `readwrite` transaction that **clears** the
     `employees` store and then `put`s every row. A clear-and-replace, never a merge: an employee the
     owner deactivated must disappear from the till, and a merge leaves them signable-in forever.
   - `readCachedEmployees(): Promise<CachedEmployee[]>`
   - `cacheSettings(entries): Promise<void>` and `readCachedSetting(key)`
   - `readCachedIdleSeconds(): Promise<number | null>` — `readCachedSetting('posIdleLockSeconds')`,
     returning `null` when nothing is cached **and** when the cached value is `null`.
   - `verifyCachedPin(employeeId, pin): Promise<boolean>` — reads the cached `pinPhc` and calls
     **T-11's `verifyPin`** from `$lib/pin`. Open `src/lib/pin/` for the exact export name and
     signature and use it. It is the **same isomorphic module the server calls**, which is the whole
     point: a second implementation here would be a second opinion about whether a PIN is correct,
     and the two would drift the first time the cost factor changes. Return `false` — never throw,
     and never call `verifyPin` — for an employee id that is not in the cache **and** for a cached
     row whose `pinPhc` is `null`, which is an employee with no PIN set; T-20 returns those rows on
     purpose, so they really do reach this store. Do not re-check `isActive`: every cached row
     carries `isActive: true` because T-15's query filters `is_active = true` before the response
     leaves the server, and `cacheEmployees` clear-and-replaces, so an employee the owner
     deactivated disappears from the cache on the next successful directory fetch.
   - `recordOfflineLogin(record): Promise<void>` — see step 4.
   - `requestPersistentStorage(): Promise<boolean>` — see step 5.
4. **`recordOfflineLogin` uses `add()`, not `put()`, and swallows exactly one error.** `add()` on an
   existing key rejects with a `ConstraintError`; catch **that name only**, return without writing,
   and let every other error propagate. That gives invariant 5's semantics precisely: a retry of the
   same operation is a **no-op**, and the record keeps the **first** attempt's `occurredAt` rather
   than being silently overwritten with a later clock reading. `put()` would look identical in a
   row-count test and quietly rewrite history.
5. **`requestPersistentStorage()`** — spec 6 requires it, because an evicted IndexedDB is unsynced
   work destroyed:

   ```ts
   if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
   if (await navigator.storage.persisted()) return true;
   return await navigator.storage.persist();
   ```

   Check `persisted()` first so a till that already holds the grant does not re-prompt on every open.
   Return the boolean to the caller rather than swallowing it, so a screen can warn when the browser
   refused. Call it from `openPosDb()` on first open. `navigator.storage` requires a secure context —
   `https://` or `localhost` — the same constraint T-27's service worker carries.
6. **Wire the write-through in `src/routes/(pos)/pos/+page.svelte`** (created by T-25): after a
   successful `GET /api/pos/employees`, write **both halves of that one response** through to the
   store, in sequence:

   ```ts
   await cacheEmployees(body.employees);
   await cacheSettings([{ key: 'posIdleLockSeconds', value: body.settings.posIdleLockSeconds }]);
   ```

   The rows go through exactly as they arrived (step 2's five keys), and
   `settings.posIdleLockSeconds` is cached **as it arrived** — `null` stays `null`, never coalesced
   to `120`. No transaction spans the two calls and none is needed: there is no cross-store
   invariant to hold, and `cacheEmployees` already clear-and-replaces its own store inside one
   `readwrite` transaction of its own. Then change the no-network branch — which T-25 left as
   "No connection, and this device has not cached an employee list yet" with a comment naming this
   task — to call `readCachedEmployees()` first and render the cached list, falling back to that
   sentence only when the cache is genuinely empty. Keep the connection indicator showing `◆ Offline`
   while doing it: a cached list must not look like a live one.
7. **Wire the offline path in `src/routes/(pos)/pos/pin/+page.svelte`** (created by T-26), and keep
   the boundary sharp:
   - When `POST /api/pos/pin` **throws** (no network), fall back to `verifyCachedPin`. On `true`,
     `recordOfflineLogin` with the **same `clientOpId` the attempt already generated**, then show the
     signed-in panel. On `false`, show the wrong-PIN message.
   - When the POST **answers** with any status, that answer wins. A 401 is a wrong PIN and a lockout
     response is a lockout — **never** retry a server rejection against the cache. The server owns
     the lockout counter, and a cache fallback on a rejected attempt is an unlimited-guesses bypass
     of spec 7's five-attempts rule.
   - **Wire the idle watch to the cache, at its call site and nowhere else.** Replace T-26's
     placeholder `seconds: null` in `src/routes/(pos)/pos/pin/+page.svelte` (T-26 step 9) with the
     cached value: read `await readCachedIdleSeconds()` once after mount and pass the result as
     `createIdleWatch`'s `seconds`. That is the value T-20 sent in `settings.posIdleLockSeconds` and
     step 6 cached, and wiring it is what satisfies invariant 12's "the POS returns to
     employee-select after idle". The change is in the page only — **not** in `src/lib/pos/idle.ts`,
     which only defines `createIdleWatch`, is not in this task's `Files:` list, and must not be
     opened or changed: `null` is already its defined inert case (T-26 step 8).
     `null` is a legitimate answer, not an error to retry. It comes back when open decision 6 is
     still unanswered and the owner has set no `pos_idle_lock_seconds`, and when nothing has been
     cached on this device yet — in both cases no timer runs and T-26's line "Automatic return to
     employee select is not configured yet." stays on screen. **Nobody may bake `120` into either
     file to make that line go away**: that would answer an open decision inside a Svelte component.
     The answer belongs in `restaurant_settings.pos_idle_lock_seconds`, and the whole transport from
     that column to this call site now exists.
8. **Build no sync queue.** This plan has no queue and no flush, and none may be invented here.
   `offline_logins` rows are written and left with `synced: false`; the flush, the retry policy and
   the unsynced count on screen are the sales plan's work. Write that sentence into `store.ts` as a
   comment so the next session does not read the store's silence as an omission to fix.

**Tests:**

- The vitest `unit` project runs in `environment: 'node'`, which has no `indexedDB`. Add
  **`fake-indexeddb` as a devDependency, pinned exactly** (`pnpm add -D -E fake-indexeddb`; every
  dependency in this repo is pinned with no `^` or `~`), and `import 'fake-indexeddb/auto'` at the
  top of `src/lib/pos/store.test.ts` so the global exists for that file only. It is a test-only
  package and adds nothing to the three runtime dependencies (`drizzle-orm`, `pg`, `zod`).
- **MANDATORY (spec 29 — offline sync: retries never create duplicates):** calling
  `recordOfflineLogin` twice with the **same `clientOpId`** and a later `occurredAt` leaves exactly
  **1** row in `offline_logins`, and that row's `occurredAt` is the **first** call's value. Two
  different `clientOpId`s leave **2** rows.
- **MANDATORY (spec 29 — offline sync: retries never create duplicates):** `cacheEmployees` called
  twice with the same three employees leaves exactly **3** rows; called again with two of them leaves
  exactly **2** — the removed employee is gone, not merged.
- **The store survives a reopen:** write employees and a setting, close the database, call
  `openPosDb()` again, and read the same values back. Assert `onupgradeneeded` fires on the **first**
  open and **not** on the second (set a module-level flag inside `upgrade` and check it).
- **`verifyPin` against a cached hash agrees with the server's verdict:** hash a PIN with T-11's hash
  function, store it as an employee's `pinPhc`, then assert `verifyCachedPin(id, pin) === true` and
  `verifyCachedPin(id, wrongPin) === false` — the same isomorphic module, so the two verdicts cannot
  diverge. Also assert `verifyCachedPin` returns `false` for an id that is not in the cache, and
  `false` for a cached employee whose `pinPhc` is `null` — T-20 returns PIN-less employees on
  purpose, so such a row really does reach this store. There is no inactive-employee case to assert:
  every cached row carries `isActive: true`, because T-15's query filters `is_active = true` before
  the response ever leaves the server (step 2).
- `readCachedIdleSeconds()` returns `null` when nothing has been cached, and `null` when `null` was
  cached — it never returns a number nobody stored.

**Done when:** `pnpm test src/lib/pos/store.test.ts` passes with every case above; `pnpm lint`
(including the `$lib/server` import ban for `src/lib/pos/**`), `pnpm check` and `pnpm build` pass;
`package.json` lists `fake-indexeddb` under `devDependencies` at an exact version with no range
prefix; and against `pnpm preview` a registered till that has loaded `/pos` once, then been put
offline in DevTools, still lists its employees and signs one in with the correct PIN, while
DevTools → Application → IndexedDB → `matcami-pos` shows one `offline_logins` row and Storage reports
persistent storage granted.

**Watch out:** the mandatory dedupe assertion is not negotiable. If a new devDependency is refused,
the fallback is to move that assertion into T-46's Playwright spec, which runs in a real browser with
a real IndexedDB — **not** to drop it, and **not** to test a re-implementation of the dedupe in
plain objects, which would prove nothing about the `add()`/`ConstraintError` behaviour that actually
enforces it.

---

**Six tasks.** After this phase the till at `/pos` registers itself, lists its employees, takes a
PIN, locks out after five wrong ones, installs to a home screen and reloads with no network. It does
not take an order, does not take payment and has no sync queue — those are the sales plan's.
