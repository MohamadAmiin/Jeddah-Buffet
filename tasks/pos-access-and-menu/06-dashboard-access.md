# Phase 5 — Dashboard, access half

The owner's side of the till. Four tasks: the dashboard page that shows the registered POS device,
revokes it, sets the idle lock and launches the till in a new tab; the rail change that replaces the
dead `Devices` row with a live `POS` one; the `Employees` page that creates the cashier and the
waiter with their PINs and sets the owner's approval PIN; and the onboarding checklist, which stops
guessing about two of its six steps and computes them. Everything here is a `(dashboard)` route:
server `load` functions and form actions are allowed, `$lib/server` imports are allowed, and **every
load and every action checks its own permission server-side and returns `403`** — reads included
(invariant 8: hiding a button is not security).

**Depends on:** Phase 3 (T-13 device registration/revocation, T-14 the audit events and the
`event-text.ts` map, T-21 the `/device` page's `load` and revoke action) **and Phase 4** — T-29
links to the till with `resolve('/pos')`, which is a type error until T-25 has created
`src/routes/(pos)/pos/+page.svelte`. T-31 also needs T-06's PIN columns and T-11's `hashPin`, and
T-29 needs T-08's `posIdleLockSeconds` setting.

> **URL DECISION MADE IN THIS FILE, AND IT IS NOT OPTIONAL.** The dashboard POS page lives at
> **`/device`** — not at `/pos`, and **no longer at `/pos-device`**. Two independent reasons force
> that name, and both have to survive:
>
> 1. **`/pos` belongs to the till.** T-23 puts the till itself at a real `/pos` URL prefix
>    (`src/routes/(pos)/pos/**`), and **route groups are not URL segments** — so
>    `src/routes/(dashboard)/pos/+page.svelte` would also serve `/pos`, and SvelteKit refuses to
>    build with two routes claiming one path (`vite build` fails with a route-conflict error).
> 2. **Service-worker scope matching is a SIMPLE STRING PREFIX MATCH, not a path-segment match.**
>    This is the W3C ServiceWorker specification's "Match Service Worker Registration" algorithm —
>    see https://github.com/w3c/ServiceWorker/issues/1272 (accessed 2026-09-14), which states it
>    outright and gives the canonical example: a scope of `https://www.google.com/maps` matches
>    `https://www.google.com/mapsearch`. **MDN's prose implies path-segment matching; MDN is wrong
>    on this point and the specification governs. Do not "correct" this back.** So the scope T-27
>    registers, `/pos`, **would control `/pos-device`**, because the string `/pos-device` starts
>    with the string `/pos` — and `/pos-device` was a **dashboard** route. A POS worker taking
>    control of an authenticated dashboard page and serving its HTML and its `__data.json` out of
>    Cache Storage after logout — which `/logout` does not clear — is precisely the blocker this
>    plan exists to prevent.
>
> **The fix is structural rather than a rule somebody must remember: the dashboard page is
> `/device`.** `/device` cannot be prefixed by `/pos` under any matching rule, so no future reader
> has to reason about scope semantics to stay safe. The scope literal stays **`/pos`, with no
> trailing slash**, and so do the manifest's `scope` and `start_url`: the till's own entry page
> serves at `/pos` (SvelteKit's default `trailingSlash: 'never'` means there is no `/pos/` URL), so
> a `/pos/` scope would leave the till's landing screen UNCONTROLLED and therefore unable to work
> offline, which defeats the whole surface.
>
> **The rail item's label stays `POS` while its href becomes `/device` — the label and the URL
> differ on purpose.** The user asked for a rail item called `POS` and that does not change; `/pos`
> belongs to the till, so the dashboard page that manages it cannot have that URL.
>
> **The guard that keeps this true.** T-02 records in `CLAUDE.md`, and T-45 asserts with a test that
> walks the route tree, that **no route outside the `(pos)` group may have a path beginning with the
> characters `pos`** — because the service-worker scope is a string prefix. Wherever that rule
> appears, state the reason in the same sentence: a rule without its reason gets deleted by the next
> person who finds it arbitrary. T-45 also keeps asserting that loading the dashboard is NOT
> controlled by a service worker, and now asserts it against `/device` specifically, plus
> `/dashboard`, `/settings`, `/menu` and `/employees`.
>
> T-21 creates this page's directory, at `src/routes/(dashboard)/device/`.
>
> Two tasks below list five to eight `Files:` entries rather than the usual four. The extra entries
> are one-line edits (a route id added to a test array, a rail row switched on, a test count, an
> audit-event variant). They are listed rather than hidden inside a step because a file you may edit
> belongs in `Files:`.

---

### T-29 — Build the dashboard POS page — register, revoke, launch

**Needs:** T-13 (POS device registration and revocation), T-21 (`POST /api/pos/revoke` and the
dashboard revocation action)

> **The `Needs:` line above is the one in `00-overview.md` and is reproduced verbatim. It is
> incomplete, and this note is the correction.** Step 6 calls `resolve('/pos')`, which type-checks
> only once a page exists under `src/routes/(pos)/pos/` — that page is
> `src/routes/(pos)/pos/+page.svelte`, created by **T-25** (T-23 creates only the `+layout.svelte`
> and says so itself). Step 5 calls `updateSettings(..., { posIdleLockSeconds })`, which needs
> **T-08**. So the real prerequisites are T-13, T-21, T-08 and T-25 — do not start this task before
> Phase 4 has run. *(Follow-up for the plan owner: add `T-08, T-25` to this row in
> `00-overview.md`'s Phase 5 index and to the `Needs:` line here.)*

**Files:**

- `src/routes/(dashboard)/device/+page.server.ts` — EXTEND (created by T-21, which wrote the
  `load` and the `revoke` action at this exact path. **ADD** the settings gate and the extra device
  fields to the **existing** `load`, and **ADD** a second action, `setIdleLock`, beside `revoke`.
  Do not touch the `revoke` action and do not rewrite the file — `revoke.integration.test.ts`
  asserts against what is already there.)
- `src/routes/(dashboard)/device/+page.svelte` — NEW
- `src/routes/(dashboard)/device/device.integration.test.ts` — NEW
- `src/lib/server/auth/pos-device.ts` — EXTEND (created by T-13; add the single-device read helper
  beside the registration and revocation functions if T-13 exported none. CLAUDE.md puts "POS device
  registration" in `src/lib/server/auth/`; confirm the real path and the real exported names with
  `grep -rn "pos_devices\|posDevices" src/lib/server` before writing an import.)
- `src/routes/route-guards.integration.test.ts` — EDIT (one line: add `'/(dashboard)/device'` to
  the `DASHBOARD_ROUTE_IDS` array near the top, so the hook-level anonymous-redirect, non-owner-403
  and owner-200 cases cover this route too)

**Spec:** 7 (POS device registration — the owner signs in **on the device** with email and password,
the server issues a long-lived HttpOnly + Secure device cookie, and "The owner can revoke a device
from the dashboard"; "The POS returns to the employee selection screen after a set idle time"),
8 (server enforcement — the server returns `403 Forbidden`; hiding buttons in the frontend is not
security), 29 (automated tests: permission checks)
**Invariants:** 8 (permissions enforced server-side on every route, reads included — a route with no
permission check is unfinished), 10 (a settings change writes its audit row in the SAME transaction
as the change — which is why the idle lock goes through `updateSettings()` and never through
`tx.update(restaurantSettings)`), 12 (POS access = registered device + PIN; the device cookie is
long-lived, HttpOnly + Secure, and **revocable from the dashboard**; the POS returns to
employee-select after a **configurable** idle time; nothing authenticating ever goes in
`localStorage`)

**Do:**

1. In `src/lib/server/auth/pos-device.ts`, make sure a read exists that returns ONE restaurant's
   device with an **explicit column list that omits the device token and its hash**. If T-13 did not
   export one, add it there — not in the route, because business rules live in `src/lib/server/**`
   and routes validate, check permissions, call a module and return:

   ```ts
   export type RegisteredDevice = {
   	id: string;
   	deviceCode: string; // 'POS1'
   	label: string;
   	registeredAt: Date;
   	lastSeenAt: Date | null;
   	revokedAt: Date | null;
   };
   export async function getRegisteredDevice(
   	tx: Executor,
   	restaurantId: string
   ): Promise<RegisteredDevice | null>;
   ```

   `Executor` is `Db | DbTx` from `src/lib/server/auth/session.ts` — the type this codebase already
   uses for reads. Read the column names T-05 actually created from
   `src/lib/server/db/schema/pos-devices.ts`; if a column here is spelled differently there, follow
   the schema, and never invent a second column. Filter by `restaurantId` **inside the query** —
   there is no ambient tenant in this codebase.
2. **Amend T-21's `load`. Do not write a new one.** `src/routes/(dashboard)/device/+page.server.ts`
   already exports `const load`, guarded by `requirePermission(event, 'admin.devices')` and reading
   `event.locals.restaurantId` with `error(500, 'No restaurant in scope')` when it is null. Leave
   both of those statements exactly as they are — a second `export const load` in one module is a
   duplicate-export build error, and rewriting the file destroys the action its own integration test
   covers. `admin.devices` already exists in `ADMIN_KEYS` (`src/lib/server/permissions/keys.ts`) — do
   not coin a new permission key. Everything this task adds to the `load` goes **after** those two
   statements.
3. Inside that existing `load`, alongside T-21's device read, call `settingsComplete(db, restaurantId)`
   and `getRestaurantWithSettings(db, restaurantId)` from `$lib/server/restaurants` — `settingsComplete`
   returns `{ complete: boolean; missing: string[] }`, and T-08 added `'POS idle lock'` to that list
   and `posIdleLockSeconds: number | null` to `RestaurantWithSettings`. Then **widen T-21's return
   literal** — keep its keys and its spelling, add two fields to the device object and two top-level
   fields:

   ```ts
   return {
   	// T-21's shape, unchanged, plus lastSeenAt. The key is T-21's: `deviceCode`,
   	// never `code` — T-05 declares `deviceCode` on `pos_devices`, T-21's literal
   	// returns it under that name, and this task only widens that literal.
   	device: row && {
   		id: row.id,
   		deviceCode: row.deviceCode,
   		label: row.label,
   		registeredAt: row.registeredAt,
   		lastSeenAt: row.lastSeenAt,
   		revokedAt: row.revokedAt
   	},
   	settings: { complete: settings.complete, missing: settings.missing },
   	idleLockSeconds: restaurant.posIdleLockSeconds
   };
   ```

   It stays an **explicit object literal** — never a spread of a database row, because SvelteKit
   serialises load data into the page HTML and into `__data.json`, and `pos_devices` holds the token
   hash. **`device` is not nulled for a revoked row**, because T-21's shape returns `revokedAt` and
   `revoke.integration.test.ts` is written against it. The page decides: a device is *registered*
   only when `data.device && data.device.revokedAt === null`. That is the same predicate T-32 uses
   for its checklist step, so the two screens cannot disagree.
4. Guard every action in the file. The first statement inside T-21's `revoke` action must be
   `requirePermission(event, 'admin.devices')` (or `requireOwner(event)` — both `error(403)`; spec 7
   ties device registration to the owner as a person and `requireOwner`'s own comment reserves it for
   exactly that). If T-21's action already calls one of them, leave it as it is: a form action is a
   separately reachable POST endpoint, and `src/routes/route-guards.test.ts` fails the build of any
   `export const actions` block that calls no guard.
5. **Add the second action, `setIdleLock` — without it the owner can never register a till.** T-08
   made `settingsComplete()` depend on `posIdleLockSeconds`, step 8 gates the launch on
   `settingsComplete()`, and **no other task in this plan puts an idle-lock control on any screen**
   (T-08's `Files:` deliberately exclude `src/routes/(dashboard)/settings/+page.svelte`). So it lands
   here, beside the device it protects. In `export const actions`, beside `revoke`:

   ```ts
   const idleLockSchema = z.object({
   	posIdleLockSeconds: z.coerce.number().int().min(30).max(1800)
   });
   ```

   - First statement: `const user = requirePermission(event, 'admin.settings');` — a **different**
     key from the load's `admin.devices`, because this writes a restaurant setting; both are in
     `ADMIN_KEYS` and the owner holds every key. Then `event.locals.restaurantId`, `error(500, …)`
     when null, exactly as the load does.
   - `safeParse` the posted `FormData`; `return fail(400, { message: 'Choose between 30 seconds and 30 minutes.' })`
     on a miss.
   - `const result = await db.transaction((tx) => updateSettings(tx, restaurantId, { posIdleLockSeconds }, { actorUserId: user.userId, ip, userAgent }))`
     with `{ ip, userAgent }` from `requestContext(event)` (`$lib/server/audit`). **Call
     `updateSettings()` and nothing else.** A direct `tx.update(restaurantSettings)` changes a
     setting with no audit row and breaks invariant 10; `updateSettings` writes the
     `settings.updated` row in the same transaction.
   - `if (!result.ok)` → `fail(400, { message: result.reason === 'invalid_idle_lock' ? 'Choose between 30 seconds and 30 minutes.' : 'That setting could not be saved.' })`.
     On success: `{ message: result.changed ? 'Auto-lock saved.' : 'No change to save.' }`.
   - `src/routes/(dashboard)/settings/+page.server.ts` is the worked example of this whole shape.
6. Build `+page.svelte` from the primitives in `$lib/components/ui` — `PageHeader`, `Card`, `Field`,
   `Button`, `Alert` — and do not retype class strings those components own. Structure:
   - `<PageHeader eyebrow="Setup" title="POS device" description="…" />` (h2 — the layout's h1 is
     the restaurant name).
   - **Exactly one `role="alert"` region may be visible at a time.** Render the form message when
     there is one, and otherwise the settings-incomplete message — never both. Two visible alerts is
     a Playwright strict-mode failure ("resolved to 2 elements") that looks nothing like a styling
     bug. `Alert` takes `tone="info" | "success" | "danger"`.
   - A `Card` for the device, keyed off
     `const registered = $derived(data.device && data.device.revokedAt === null)`. When it is false,
     explain how registration works instead of offering a button (step 7). When it is true, show
     label, the device code (`data.device.deviceCode` — T-21's key spelling, not `code`), the
     registration date and the last-seen date — money-free figures, so plain `Intl.DateTimeFormat`;
     render "never" for a null `lastSeenAt` rather than an empty cell.
   - A `Card` for the auto-lock: one `Field` `id="idle-lock"` `name="posIdleLockSeconds"`
     `label="Auto-lock after (seconds)"` `type="number"` `required` `value={String(data.idleLockSeconds ?? '')}`
     with a `hint` naming the 30–1800 range and saying the till returns to employee-select after it,
     inside `<form method="POST" action="?/setIdleLock">` with a `Save auto-lock` submit. A `Field`'s
     label text is its control's accessible name and is rendered verbatim: no asterisk, no
     `(required)`, no unit suffix beyond what is inside the label string itself.
   - Revocation behind a confirmation: a native `<details>` whose `<summary>` reads
     `Revoke this device…` and whose body carries one sentence of consequence ("the till stops
     accepting PIN logins immediately and the owner must sign in on it again to re-register") plus

     ```svelte
     <form method="POST" action="?/revoke">
     	<input type="hidden" name="deviceId" value={data.device.id} />
     	<Button variant="danger" type="submit">Revoke device</Button>
     </form>
     ```

     **The hidden `deviceId` is not optional.** T-21's action reads `deviceId` from the posted
     `FormData` and validates it with `z.object({ deviceId: z.string().uuid() })`, returning
     `fail(400)` on a miss — a form without the field makes every revoke click a `400`. This is the
     side of the seam that changes: T-21's action stays exactly as written, and the page supplies
     what it asks for. That is also why step 3 keeps `id` in the load's device literal. Render this
     block only when `registered` is true. Two distinct accessible names (`Revoke this device…` and
     `Revoke device`), so a test can address either without ambiguity. No modal: modals are for POS
     reason codes, owner approval and errors.
   - The launch affordance:
     `<Button href={resolve('/pos')} target="_blank" rel="noopener">Open the POS</Button>` — `Button`
     renders an `<a>` when given `href` and forwards the rest of its attributes. `resolve` comes from
     `$app/paths`; the `svelte/no-navigation-without-resolve` lint rule requires it and a raw string
     fails `pnpm lint`. `/pos` is **T-25's page** (`src/routes/(pos)/pos/+page.svelte`); T-23 creates
     only the layout, and its own note says `resolve('/pos')` stays a type error until a page exists
     under that directory. If `resolve('/pos')` does not type-check, T-25 has not run — stop and
     report rather than working around it.
7. Page copy, in the card and in plain words: **the device is registered on the till itself, not from
   here.** The owner opens `/pos` on the tablet, signs in there once with their email and password,
   and the server issues that tablet a long-lived device cookie; this page is where it is seen and
   revoked (spec 7). Say it whether or not a device exists.
8. Gate the launch on `data.settings.complete`. When it is false, render no launch control at all —
   not a dead one — and instead say which settings are missing, using `data.settings.missing`
   verbatim. The list holds the literals `settingsComplete()` pushes, so on a fresh restaurant the
   sentence reads exactly `Still needed: POS idle lock.` and after the time zone is cleared too,
   `Still needed: time zone, POS idle lock.` Link to `/settings` via `resolve('/settings')` for the
   time zone; the idle lock is settable on this page by step 6's form, so say that rather than
   sending the owner away for a field that is on screen.

**Tests:**

- MANDATORY (spec 29 — permission checks. Spec 29 names the POS API; this repository applies the
  rule to every route, and the headers of `src/routes/route-guards.test.ts` and
  `route-guards.integration.test.ts` say so): in
  `src/routes/(dashboard)/device/device.integration.test.ts`, import the real `load` from
  `./+page.server` and call it with a hand-built event whose `locals.user` is a **cashier**
  `Principal` (`{ userId, restaurantId, role: 'cashier', displayName, email: null, sessionId, expiresAt }`
  from `src/lib/server/auth/session.ts`) — expect it to reject with `{ status: 403 }`. Repeat for
  **both** exported actions, `revoke` and `setIdleLock`. A minimal event object cast
  `as unknown as RequestEvent` is enough: the guards read only `locals`, and `locals.url` is used
  solely for the anonymous redirect. `src/routes/route-guards.integration.test.ts` is the worked
  example of this shape.
- The load returns the device for an owner: seed a `pos_devices` row with `testDb()` from
  `$lib/server/db/test/db`, call `load`, assert `result.device.deviceCode === 'POS1'` (T-21's key
  spelling) and `result.device.revokedAt === null`.
- **The device token never leaves the server.** Read the seeded row's token-hash column directly with
  `testDb()`, then assert that `JSON.stringify(await load(ownerEvent))` contains neither that value
  nor the substring `token` in any casing. That string is exactly what SvelteKit serialises into the
  page HTML and `__data.json`.
- A revoked device (`revoked_at` set) still comes back from `load`, with a non-null `revokedAt` — so
  the page's `registered` predicate is false and no launch or revoke control renders. T-32's
  `deviceRegistered` uses the same predicate.
- `setIdleLock` with `posIdleLockSeconds: 120` as the owner returns a success message, and
  `settingsComplete(db, restaurantId)` afterwards is `{ complete: true, missing: [] }`. With `29` and
  with `1801` it returns `400` and `settingsComplete` is still
  `{ complete: false, missing: ['POS idle lock'] }`.
- The one-line addition of `'/(dashboard)/device'` to `DASHBOARD_ROUTE_IDS` keeps
  `pnpm test:integration` green: anonymous → `303` to `/login?next=`, cashier and waiter → `403`
  (GET and a direct POST), owner → `200`.

**Done when:** `pnpm build` succeeds — that is what proves this page claims no path the till
already claims — and `pnpm check && pnpm lint && pnpm test` pass; signed in as the owner, `/device`
renders the page, saving an auto-lock of 120 makes the launch control appear, and `Open the POS`
opens `/pos` in a new tab; a cashier session on `/device` gets `403`, not a redirect and not a
`404`. And `grep -rn "pos" src/routes --include=+page.svelte -l` shows no route file outside
`src/routes/(pos)/` whose own path segment begins with `pos` — the rule T-02 records and T-45
tests, because the service-worker scope is a string prefix.

**Watch out:** Do not create `src/routes/(dashboard)/pos/` — it collides with T-23's till at `/pos`
and the build fails. Do not name it `pos-device`, `pos-setup` or anything else starting with `pos`
either: that build passes, and then the till's `/pos`-scoped service worker silently controls an
authenticated dashboard page, because scope matching is a **string prefix**, not a path-segment
match (see the note at the top of this file). T-21 already put this page at `device/`, so there is
nothing to move. Never
render the device token or its hash anywhere on this page; the label and the device code are the only
identifiers an owner needs. `target="_blank"` without `rel="noopener"` hands the opened till a
`window.opener` reference to an authenticated dashboard page. Do not write `posIdleLockSeconds` with
`tx.update(restaurantSettings)` and do not add a `?? 120` fallback anywhere — T-08 forbids both, and
a fallback is a column default wearing a disguise. If `pos_devices` is missing from the hardcoded
`TABLES` list in `src/lib/server/db/test/reset.ts`, T-10 has not run and the integration test will
leak rows between cases — stop and report the mismatch rather than truncating by hand.

---

### T-30 — Replace the `Devices` rail item with `POS`

**Needs:** T-29 (the `/device` page the row points at)
**Files:**

- `src/lib/components/ui/Sidebar.svelte` — EDIT (four places: the `IconName` union near the top of
  the `<script>`; the `NavItem` type's `href` union on the line after it; the `Setup` group inside the
  `groups` array, currently `{ label: 'Devices', href: null, icon: 'devices' }`; and the
  `{#if name === …}` chain inside the `{#snippet icon(name, tone)}` block, which has a
  `{:else if name === 'devices'}` branch drawing a tablet)
- `src/lib/components/ui/sidebar.test.ts` — NEW

**Spec:** 7 (the owner registers and revokes the POS device from the dashboard), 31 (MVP: one
registered POS device)
**Invariants:** 8 (a rail item is navigation, never a permission — the `/device` route guards
itself server-side)

**Do:**

1. In the `IconName` union, remove `'devices'` and add `'pos'`. The union is the closed list the
   icon snippet switches on; leaving a stale member or forgetting a branch renders an **empty
   `<svg>`** with no error anywhere.
2. In `type NavItem`, widen `href` from `'/dashboard' | '/settings' | null` to
   `'/dashboard' | '/settings' | '/device' | null`. The literal it gains is **`'/device'`, never
   `'/pos-device'`.** It is a literal union because `resolve()` from `$app/paths` takes a known
   route, and a plain `string` would not type-check at the call site.
3. In the `Setup` group, in place (between `Employees` and `Settings`), replace the Devices entry
   with `{ label: 'POS', href: '/device', icon: 'pos' }`. **The label and the URL differ on
   purpose, and both halves are deliberate.** The label stays `POS` because that is the row the
   owner asked for and is looking for. The href is `/device` — not `/pos`, which is the till itself
   (T-23, T-25), and not `/pos-device`, because the till's service worker is scoped to `/pos` and
   scope matching is a **string prefix**, so any dashboard URL beginning with the characters `pos`
   falls inside the till's scope (see the note at the top of this file). This row leads to the
   owner's register/revoke/launch page.
4. In the icon snippet, replace the whole `{:else if name === 'devices'}` branch with the one below.
   Stroke-only, `aria-hidden`, `viewBox="0 0 24 24"`, `stroke-width="1.6"` — all four are already set
   on the parent `<svg>`, so the branch contributes shapes only, exactly like its neighbours. A till:
   a body, a raised display hood, two key rows:

   ```svelte
   {:else if name === 'pos'}
   	<rect x="3.5" y="9.5" width="17" height="11" rx="2" />
   	<path d="M7.5 9.5V5A1.5 1.5 0 0 1 9 3.5h6A1.5 1.5 0 0 1 16.5 5v4.5" />
   	<path d="M7.5 13.5h5" />
   	<path d="M7.5 17h5" />
   	<path d="M16 15.5h.5" />
   ```

5. Change nothing else. The row count is still nine, so the mobile scroll-cue paragraph ("all nine
   sections are in it") stays correct. The row now renders through the `{#if item.href}` branch — a
   real `<a>` with `aria-current="page"` when `pathname === item.href` — instead of the
   `aria-disabled` span with the `Soon` pill, which is the visible change.
6. `Sidebar` stays a PROPS-ONLY primitive. It reads no store, no session and no server module;
   `src/lib/components/components.test.ts` walks every file in `src/lib/components/**` and fails any
   that mentions `$lib/server`, `lib/server` or `../server/`, or that uses a POS-only token
   (`p-touch`, `min-h-touch`, `touch-min`, `touch-lg`, `touch-xl`, `bg-screen`, `bg-key`,
   `text-key-ink`) or an arbitrary value like `bg-[#123456]`.
7. Write `src/lib/components/ui/sidebar.test.ts` as a **source-text** test that reads
   `Sidebar.svelte` with `readFileSync`. It is not a render test on purpose: the `unit` Vitest
   project runs in the `node` environment with no Svelte compiler and no SvelteKit aliases, so a
   `.svelte` import cannot be compiled and `$app/paths` cannot resolve. `src/lib/styles/tokens.test.ts`
   and `src/lib/components/components.test.ts` are the precedents. The real rendering is exercised by
   `pnpm test:e2e`.
8. **The `href: null` count is a running total that every later task must maintain, and this file is
   the only place it is written down.** Put this sentence in a comment above that assertion, naming
   its callers: *"Every task that turns a rail row on must decrement this number in the same commit.
   T-31 turns `Employees` on (6 → 5) and T-39 turns `Menu` on (5 → 4)."* **`Menu` is turned on by
   T-39, not by T-43** — T-39 step 8 is the step that writes `{ label: 'Menu', href: '/menu', icon:
   'menu' }`, and T-43 step 5 only confirms the row is already live. So the task that must decrement
   this count to `4`, and add the live-`Menu` assertion beside it, is T-39, in T-39's own commit.
   Without the comment the number goes stale silently in another task's diff and `pnpm test` fails
   there, pointing at this file.

**Tests:** (in `src/lib/components/ui/sidebar.test.ts`, all against the file's raw text)

- The rail has a POS row pointing at the dashboard page:
  `expect(source).toMatch(/label:\s*'POS',\s*href:\s*'\/device',\s*icon:\s*'pos'/)` — a regex, not
  an exact string, so Prettier's line wrapping cannot break it.
- No Devices row survives: `expect(source).not.toContain("'Devices'")` and
  `expect(source).not.toContain("'devices'")`.
- **No rail href begins with `/pos` at all:** `expect(source).not.toMatch(/href:\s*'\/pos/)` — note
  there is no closing quote in that pattern, deliberately, so it fails on `'/pos'` (the till) **and**
  on `'/pos-device'` or any other dashboard URL sharing the `pos` prefix. A `/pos`-scoped service
  worker matches by string prefix, so a rail row is the easiest way for such a URL to come back.
- **Every `IconName` member has a branch, and every branch is a member.** Slice the union out
  (`source.slice(source.indexOf('type IconName'), source.indexOf('type NavItem'))`), collect its
  members with `/'([a-z-]+)'/g`, assert the list contains `'pos'` and not `'devices'`, assert
  `source.includes(\`name === '${member}'\`)` for each, and assert the reverse — every
  `name === 'x'` found by `/name === '([a-z-]+)'/g` is in the union. This is the check that catches
  the empty `<svg>`.
- The number of not-yet-built rows drops by one:
  `expect(source.match(/href: null/g)?.length).toBe(6)` — it is 7 before this task (verified against
  the checked-in file), and step 8's comment above the assertion tells T-31 and T-39 to decrement it.
  (The `NavItem` type line reads `href: '/dashboard' | '/settings' | '/device' | null` and does
  not match.)

**Done when:** `pnpm test:unit` passes including the new file, `pnpm check && pnpm lint` pass, and
the running dashboard rail shows a `POS` row that navigates to `/device` and is highlighted with
`aria-current="page"` while you are on it, with no `Devices` row anywhere.

**Watch out:** A stale union member or a missing `{:else if}` branch produces an empty `<svg>` — no
error, no warning, a row with a blank square. The new `.ts` test file lives inside the directory
`components.test.ts` walks, so it is itself checked: keep the literal strings `$lib/server`,
`lib/server`, `../server/` and the POS tokens out of it, including out of its comments.

---

### T-31 — Build the `Employees` page

**Needs:** T-06 (the PIN columns on `users`), T-11 (the isomorphic PIN hash module), T-14 (the POS
audit events)
**Files:**

- `src/lib/server/auth/employees.ts` — NEW. (T-15's `src/lib/server/auth/employee-directory.ts` is a
  **different file** and stays separate: it is the POS read model that ships cached PIN hashes to a
  registered device, and this one is the dashboard's write model, which never reads a hash at all.
  Do not merge them.)
- `src/routes/(dashboard)/employees/+page.server.ts` — NEW
- `src/routes/(dashboard)/employees/+page.svelte` — NEW
- `src/lib/server/auth/employees.integration.test.ts` — NEW
- `src/lib/components/ui/Sidebar.svelte` — EDIT (the `Setup` group's
  `{ label: 'Employees', href: null, icon: 'employees' }` entry, and the `NavItem` `href` union on
  the line after `type IconName`)
- `src/lib/components/ui/sidebar.test.ts` — EXTEND (created by T-30; change the `href: null` count
  from `6` to `5` and add an assertion for the live `Employees` row — see step 8. Do not rewrite the
  file.)
- `src/routes/route-guards.integration.test.ts` — EDIT (one line: add `'/(dashboard)/employees'` to
  `DASHBOARD_ROUTE_IDS`)
- `src/lib/server/audit/events.ts` — EDIT (**only if** T-14 did not already add the two variants named
  in step 4)

**Spec:** 7 (PIN rules — "PINs are 4–6 digits, stored only as slow salted hashes"; five wrong
attempts lock the employee for five minutes; "The owner also has a POS PIN, used to approve sensitive
actions"), 8 (owner-PIN approvals; server returns `403`), 31 (MVP: one owner, one cashier, one
waiter), 29 (permission checks)
**Invariants:** 8 (permissions server-side on the load and on every action, `403`), 10 (sensitive
actions are audit-logged, and the audit row is written in the SAME transaction as the action),
12 (PINs are 4–6 digits, stored only as slow salted hashes, never reversible, never logged)

**Do:**

1. Create `src/lib/server/auth/employees.ts`. Convention in `src/lib/server`: functions that WRITE
   take `DbTx`, functions that only READ take `Executor` (`Db | DbTx`). Export:
   - `listEmployees(tx: Executor, restaurantId: string): Promise<EmployeeRow[]>` where
     `EmployeeRow = { id: string; role: UserRole; displayName: string; hasPin: boolean; isActive: boolean }`.
     Select an explicit column list and compute `hasPin` **in SQL** —
     ``hasPin: sql<boolean>`${users.pinHash} is not null` `` — so the hash is never read into
     application memory at all. Filter `eq(users.restaurantId, restaurantId)` inside the query, order
     by `role` then `displayName`.
   - `createEmployee(tx: DbTx, restaurantId: string, input: { role: 'cashier' | 'waiter'; displayName: string; pin: string }, ctx: { actorUserId: string; ip: string | null; userAgent: string | null })`.
     Insert with `email: null` and `passwordHash: null` — the existing CHECK
     `users_non_owner_has_no_credentials` rejects a cashier or waiter that has either, which is why
     the form below must not collect them — and `pinHash: await hashPin(input.pin)`.
   - `setEmployeePin(tx: DbTx, restaurantId: string, userId: string, pin: string, ctx)` — a single
     `UPDATE users SET pin_hash = …, failed_pin_count = 0, pin_locked_until = null, updated_at = now()`
     with **`WHERE id = userId AND restaurant_id = restaurantId`** (the tenant goes in the WHERE; the
     user id arrives from a form and is not trusted on its own). Return `{ ok: false, reason: 'not_found' }`
     when no row was updated. Resetting the lockout pair is deliberate: a new PIN must not arrive
     already locked. Read the real column names from `src/lib/server/db/schema/users.ts` — T-06 added
     `pinHash` and its own lockout pair, deliberately separate from `failedPasswordCount` /
     `passwordLockedUntil` so five wrong PINs at the counter cannot lock the owner out of the
     dashboard; if T-06 spelled them differently, follow the schema and never add a second column.
   - `users` is not a posted record. Invariant 2 forbids UPDATE/DELETE on a paid order, invoice,
     payment, stock movement, journal entry or journal line — changing an employee's PIN hash is an
     ordinary update, and it is audited.
2. `hashPin` comes from T-11's **isomorphic** module (`src/lib/pin/`, imported as `$lib/pin`). Never
   use `hashPassword` from `src/lib/server/auth/password.ts` here: that is `node:crypto`'s argon2id,
   which has no browser build, and spec 6 requires the same hash to be verified **in the browser**
   from the bundle cached on the till. Confirm the exported name with
   `grep -rn "export" src/lib/pin`.
3. Validate with `zod`, server-side only — no schema is imported into a `.svelte` component:

   ```ts
   const pin = z.string().regex(/^[0-9]{4,6}$/, 'The PIN must be 4 to 6 digits.');
   const createSchema = z.object({
   	role: z.enum(['cashier', 'waiter']),
   	displayName: z.string().trim().min(1, 'Enter a name.').max(200),
   	pin
   });
   const setPinSchema = z.object({ userId: z.uuid(), pin });
   ```

4. Audit, in the SAME transaction as the write (invariant 10; `writeAudit(tx, …)` takes the
   transaction handle and must not open its own). Use the variants T-14 added to the discriminated
   union in `src/lib/server/audit/events.ts`; this plan names them
   `{ event: 'employee.created'; details: { role: UserRole; displayName: string } }` and
   `{ event: 'employee.pin_set'; details: { role: UserRole } }`. If either is absent from the union,
   add it in this commit with an exact `details` shape — **never widen the union to
   `Record<string, unknown>`** — and add its sentence to
   `src/routes/(dashboard)/dashboard/event-text.ts`, whose `Record<AuditEventName, string>` type
   makes the omission a compile error. Set `subjectUserId` to the employee and `actorUserId` to the
   owner, and pass `ip` / `userAgent` from `requestContext(event)` (`$lib/server/audit`).
5. `+page.server.ts`. `load`: first statement `requirePermission(event, 'admin.employees')` — the key
   already exists in `ADMIN_KEYS`; do not coin a new one — then
   `const restaurantId = event.locals.restaurantId; if (!restaurantId) error(500, 'No restaurant in scope');`,
   then `listEmployees(db, restaurantId)`. Return an **explicit object literal**,
   `{ employees: rows.map((r) => ({ id: r.id, role: r.role, displayName: r.displayName, hasPin: r.hasPin, isActive: r.isActive })) }`
   — never a spread of a user row, because load data is serialised into the page HTML and into
   `__data.json`. Two actions, `createEmployee` and `setPin`, **each** beginning with
   `requirePermission(event, 'admin.employees')` (a form action is a separately reachable POST
   endpoint; `403` for anyone without the key), each parsing with `safeParse` and returning
   `fail(400, { message })` on a validation error, each wrapping its module call in
   `db.transaction((tx) => …)` — the pattern in `src/routes/(dashboard)/settings/+page.server.ts`.
6. **A second cashier or waiter is ALLOWED, and no database constraint forbids it. This is an
   assumption this plan carries, not a rule the spec states — surface it, do not bury it.** Spec 31
   says "one owner, one cashier, one waiter", which is an MVP scope statement about what the product
   is designed around; whether a *row* may be refused is a question spec 31 does not answer, and
   CLAUDE.md's open-decisions rule covers exactly that case: surface the question and its default,
   ask, and record the assumption in the commit/PR. **Default carried: allow it.** This page builds
   no deactivate and no delete action, so refusing the second would make a single mistyped name
   unrecoverable without a database edit, and a dead end in the first screen of onboarding is worse
   than an extra row on the POS employee-select list. Concretely:
   - Record the reasoning in a comment in `+page.server.ts` and state it in the page copy as a plain
     `<p class="text-caption text-ink-2">` (not an `Alert` — see step 7).
   - **Never add a unique index on `(restaurant_id, role)`** — that would turn a scope statement into
     a migration.
   - Name the assumption in this task's commit message and in the PR body.
   - *Follow-up for the plan owner: this belongs in `00-overview.md`'s **Assumptions** section as a
     row of its own ("a second cashier or waiter is allowed; spec 31's one-each is scope, not a
     constraint"), so a reader of the overview learns it without opening this file. It is not there
     yet.* Once it is, cite that row here instead of re-deciding.
7. `+page.svelte`, from `$lib/components/ui` (`PageHeader`, `Card`, `Field`, `Button`, `Alert`,
   `StatusMark`):
   - `<PageHeader eyebrow="Setup" title="Employees" description="…" />`.
   - **Exactly one visible `role="alert"`**: render `form?.message` only, with
     `tone={page.status === 200 ? 'success' : 'danger'}` as `settings/+page.svelte` does.
   - One `Card` listing the employees: display name, role, and PIN state as
     `<StatusMark status={e.hasPin ? 'done' : 'not-started'} />` plus its own visible words — colour
     never carries meaning alone. Each row carries a small `POST` form to `?/setPin` with a hidden
     `userId`, a `Field` of `type="password"` `inputmode="numeric"` labelled `New PIN`, and a
     `Set PIN` submit. **The owner's row is in this list too** — that is how the owner's approval PIN
     (spec 7, spec 8) gets set, and nothing else in this plan provides one.
   - One `Card` with the create form: `Field` `Name`; a `<fieldset>` with `<legend>Role</legend>` and
     two radios labelled `Cashier` and `Waiter` (`Field` renders an `<input>` only, so the radios are
     hand-built here); `Field` `PIN`, `type="password"`, `inputmode="numeric"`; a `Create employee`
     submit. **No email field and no password field** — the CHECK constraint forbids both on a
     non-owner, and collecting them would be collecting something that cannot be stored.
   - A `Field`'s label text is its control's accessible name and is rendered verbatim: no asterisk,
     no `(required)`, no suffix. Mark required-ness with the `required` attribute.
8. Turn the rail row on, **and fix the test that counts the dead rows in the same commit**:
   - In `src/lib/components/ui/Sidebar.svelte` replace
     `{ label: 'Employees', href: null, icon: 'employees' }` with
     `{ label: 'Employees', href: '/employees', icon: 'employees' }` and add `'/employees'` to the
     `NavItem` `href` union. The `employees` icon already exists — do not touch the `IconName` union
     or the icon snippet. `Sidebar` stays props-only.
   - In `src/lib/components/ui/sidebar.test.ts` (T-30's file) change
     `expect(source.match(/href: null/g)?.length).toBe(6)` to `.toBe(5)` and add
     `expect(source).toMatch(/label:\s*'Employees',\s*href:\s*'\/employees'/)`. **This is not
     optional and cannot be deferred:** T-30's assertion is written against the rail as T-30 left it,
     so the moment this task turns the row on, `pnpm test` — named in this task's own `Done when` —
     fails on the unit project. T-30 step 8's comment above that assertion says so by name.

**Tests:** (`src/lib/server/auth/employees.integration.test.ts`, plus the load/action cases; the
integration project points `DATABASE_URL` at `matcami_test` and truncates between tests)

- MANDATORY (spec 29 — permission checks; this repository applies the rule to every route, see the
  header of `src/routes/route-guards.integration.test.ts`): the exported `load` and **both** actions
  reject a cashier `Principal` with `{ status: 403 }`, and the one-line `DASHBOARD_ROUTE_IDS`
  addition keeps the hook-level anonymous-`303`, non-owner-`403` (GET and direct POST) and
  owner-`200` cases green.
- A created cashier has `email` NULL and `password_hash` NULL: insert through `createEmployee`, then
  read the row back with `testDb()` and assert both are `null`. Same for a waiter.
- **`pin_hash` never reaches the browser**: read the stored hash directly with `testDb()`, then
  assert `JSON.stringify(await load(ownerEvent))` contains neither that value nor the substrings
  `pinHash`, `pin_hash` or `passwordHash`. That string is what SvelteKit puts in the page HTML and
  `__data.json`.
- A 3-digit PIN is rejected: the action returns `400` **and** no `users` row is created. A 7-digit
  PIN and a PIN containing a non-digit are rejected the same way; `1234` (4) and `123456` (6) are
  accepted.
- `createEmployee` writes exactly one `employee.created` audit row in the same transaction: force the
  insert to fail (a duplicate id, or throw from a stub) and assert that **no** audit row remains.
- `setEmployeePin` resets the PIN lockout pair to `0` / `null`, and refuses a `userId` belonging to
  another restaurant (`{ ok: false, reason: 'not_found' }`, no row touched).
- `pnpm test:unit` stays green, including `src/lib/components/ui/sidebar.test.ts` with its count
  decremented to `5`.

**Done when:** `pnpm check && pnpm lint && pnpm test` pass; from `/employees` as the owner, creating
a cashier produces one `users` row with `email` NULL, `password_hash` NULL and a non-null `pin_hash`,
plus exactly one `employee.created` row in `audit_log`; a cashier session on `/employees` gets `403`;
and the rail's `Employees` row is a live link with no `Soon` pill.

**Watch out:** `assertNoSecrets` in `src/lib/server/audit/index.ts` walks the `details` object at
every depth and **throws** on any KEY matching `/pass|pin|token|hash|secret|cookie|authorization/i`
— so `details: { role }` is fine but a key such as `pinLength` or `pinHash` aborts the write. Only
`details` is scanned; the event NAME `employee.pin_set` is not. The PIN itself is never logged,
never returned and never put in a redirect. Do not reuse `hashPassword` for a PIN, and do not
re-hash a PIN on every render. The `users_owner_has_credentials` CHECK means the owner keeps email
and password_hash — `setEmployeePin` touches `pin_hash` and the lockout pair only. PINs are not
checked for uniqueness and need not be: spec 7's flow selects the employee first and then asks for
the PIN, so two people sharing `1234` is not an authentication ambiguity.

---

### T-32 — Make the onboarding checklist compute the employee and device steps

**Needs:** T-29 (the device read and the `/device` page), T-31 (the employees module and the
`/employees` page)
**Files:**

- `src/routes/(dashboard)/dashboard/+page.server.ts` — EDIT (inside `load`, after the
  `settingsComplete(db, restaurantId)` call and before the `return`)
- `src/routes/(dashboard)/dashboard/+page.svelte` — EDIT (two places: the `steps` array at the top
  of the `<script>`, entries 2 and 5; and the hardcoded
  `href={resolve(step.href as '/settings')}` / `Open settings` anchor near the bottom of the
  checklist `<Card>`. **Not** `EVENT_TEXT` — T-14 moved that map out of this component into
  `./event-text.ts` and gave it a sentence for every union member.)
- `src/lib/server/auth/employees.ts` — EXTEND (created by T-31; add `employeeSetupStatus` beside
  `listEmployees` — do not rewrite the file)
- `e2e/auth.spec.ts` — EDIT (the `getByText('not started', { exact: true })` count assertion in
  step 3, which **T-08 already changed to `toHaveCount(6)`**. **Expected to need no change** — see
  step 6 — but it is listed because this is the task that must prove it)

**Spec:** 7 (a registered device and employee PINs are what the POS needs before it can be used),
31 (MVP scope: one registered POS device, one cashier, one waiter), 29 (tests)
**Invariants:** 8 (the dashboard load keeps its own server-side permission check), 11 (business date
and the restaurant's own time zone — this screen already reports the local date from the restaurant's
zone; do not replace it with the browser's)

**Do:**

1. Add to `src/lib/server/auth/employees.ts`:

   ```ts
   export async function employeeSetupStatus(
   	tx: Executor,
   	restaurantId: string
   ): Promise<{ cashierWithPin: boolean; waiterWithPin: boolean }>;
   ```

   One query: select `role` from `users` where `restaurant_id = restaurantId`, `is_active` is true,
   `pin_hash is not null` and `role in ('cashier','waiter')`, grouped by role; map the returned roles
   to the two booleans. It returns booleans and never the hash. **Only active employees count** — a
   deactivated cashier cannot sign into the till, so the step is not done.
2. In `src/routes/(dashboard)/dashboard/+page.server.ts`, call `employeeSetupStatus(db, restaurantId)`
   and `getRegisteredDevice(db, restaurantId)` (from `src/lib/server/auth/pos-device.ts`, the read
   T-29 uses) and add two fields to the existing explicit return literal:

   ```ts
   employeesReady: status.cashierWithPin && status.waiterWithPin,
   deviceRegistered: device !== null && device.revokedAt === null
   ```

   That is the same predicate T-29's page uses for `registered`, deliberately — one definition of
   "the till is registered", used by both screens. Do not return the device or the employee rows
   themselves; the overview needs two booleans. **Leave the existing
   `requirePermission(event, 'admin.settings')` guard exactly as it is**: it is this route's own
   check, the owner holds every key, and adding a second key check would guard against a role that
   does not exist.
3. In `+page.svelte`, rewrite two entries of the `steps` array:

   ```ts
   { label: 'Employees and PINs', done: data.employeesReady, href: '/employees',
     cta: 'Add employees', detail: '…' }
   { label: 'Register the POS device', done: data.deviceRegistered, href: '/device',
     cta: 'Open the POS page', detail: '…' }
   ```

   Keep both labels byte-identical to what is there now, and keep them in their current positions
   (2nd and 5th of six). Make the details honest about what "done" means — "Add the cashier and waiter, each with a PIN for
   the POS." is already exactly right; for the device say the till registers itself and this page
   shows and revokes it.
4. The anchor at the bottom of each step currently reads `Open settings` for every step that has an
   `href`, because only one step had one. Add a `cta` field to each of the three linked steps
   (`'Open settings'`, `'Add employees'`, `'Open the POS page'`) and render `{step.cta}`. Widen the
   cast to `resolve(step.href as '/settings' | '/employees' | '/device')`. T-43 later adds
   `'/menu'` to both the array and this cast — leave a comment saying so, so it extends this shape
   rather than inventing a second one.
5. The remaining three steps — `Menu, categories and modifiers`, `Dining tables`,
   `Open the first POS session` — **stay `done: false` with `href: null`** and their existing
   one-line detail. Do not fake progress and do not link to a route that does not exist. `doneCount`
   is derived by counting, not written down; leave it alone.
6. **The e2e count, against the post-T-08 reality.** `e2e/auth.spec.ts` step 3 runs immediately after
   a fresh registration: the fixture resets the database, registers one restaurant with one owner,
   and creates **no cashier, no waiter, no `pos_devices` row and no idle-lock setting** before that
   line. T-08 already moved the assertion from `toHaveCount(5)` to **`toHaveCount(6)`**, because a
   freshly registered restaurant has a null `pos_idle_lock_seconds`, so `data.settings.complete` is
   false and the first step renders `not started` too. This task makes steps 2 and 5 computable and
   **both are `false` in that fixture**, so **zero of six steps are done and the count stays 6** — the
   assertion needs no change. Run `pnpm test:e2e` and confirm it. If Playwright reports anything
   other than 6, change that number and nothing else in the same commit. The DOM text is the
   lowercase literal `not started`, uppercased by CSS; never capitalise it in the markup, and never
   give `StatusMark` a `label` on this screen — either would change the count.

**Tests:**

- `employeeSetupStatus` (integration): `{ false, false }` with no employees; `{ false, false }` with a
  cashier who has **no** PIN; `{ true, false }` with a cashier who has one and no waiter;
  `{ true, true }` when both have a `pin_hash`; back to `{ false, true }` when the cashier is set
  `is_active = false`.
- The dashboard `load` (integration): returns `employeesReady: false, deviceRegistered: false` for a
  freshly registered restaurant; `deviceRegistered: true` after a `pos_devices` row exists;
  `deviceRegistered: false` again once that row's `revoked_at` is set; `employeesReady: true` once a
  cashier and a waiter both have a `pin_hash`.
- The load still returns no hash and no device token: assert `JSON.stringify(result)` contains none
  of `pinHash`, `pin_hash`, `passwordHash`, `token`.
- `pnpm test:e2e` passes with the count assertion matching reality (6 for the fresh-registration
  fixture).

**Done when:** `pnpm test && pnpm test:e2e` pass, and on `/dashboard` each of the three data
conditions moves `doneCount` by exactly one, in this order (six steps throughout):

| State of the restaurant | Checklist reads |
|---|---|
| Freshly registered — settings incomplete, no PINs, no device | `0 of 6 done` |
| Auto-lock saved on `/device`, so `settingsComplete()` is true | `1 of 6 done` |
| …and a cashier and a waiter both have PINs | `2 of 6 done` |
| …and the till has been registered | `3 of 6 done` |

The `Employees and PINs` and `Register the POS device` rows link to `/employees` and `/device`.

**Watch out:** The absolute numbers above are only correct **after T-08** — before it, a fresh
restaurant read `1 of 6` because the settings step was done on registration. If you are verifying
against a checkout where `pos_idle_lock_seconds` does not exist yet, T-08 has not run; stop and
report rather than adjusting the numbers. Do not compute the employee step from a row count: a
cashier with no PIN cannot sign into the till, so the step is about the PIN, not about the row. Do
not compute the device step from "a `pos_devices` row exists" either — a revoked device is not a
registered one. Both steps must go back to `not started` when the data goes away, which is why the
tests above assert the reverse direction as well.
