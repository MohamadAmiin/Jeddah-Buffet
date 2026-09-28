# POS access and Menu

**Goal.** Give the owner a working till. The dashboard loses its `Devices` rail item and gains a
`POS` one; that page registers and revokes the single POS device (spec 7) and launches the till in a
new tab. The till is the same SvelteKit app served under a real `/pos/...` URL prefix, installable to
a tablet home screen, where the owner authenticates **once** with email + password to register the
device and every later sign-in is an employee PIN. Alongside it, the `Menu` rail item becomes real:
categories, items and modifiers with integer-minor-unit prices, published to the POS as a versioned
full snapshot (spec 5).

## Requirements (as agreed with the user)

- The `Devices` rail item is **removed**. A single `POS` item replaces it and leads to a page that
  does register + revoke + launch. It reuses the existing `admin.devices` permission key — no new
  key is coined.
- The till opens in a **new tab on the same origin**, not a separate deployment. It carries its own
  web app manifest, fullscreen display mode and service worker so it installs and looks like a
  separate application.
- Device registration asks for the owner's **email and password** (spec 7), once. The user's first
  instinct was email only; that was argued against — an email address is public, is printed on
  receipts, and spec 6 ships cached employee PIN hashes to any registered device — and the user
  changed the decision to email + password.
- After registration the owner's **dashboard session on that device is destroyed**, so no live owner
  session is left on a counter tablet.
- Employees (cashier, waiter) sign in with a 4-6 digit PIN. Five wrong attempts lock that employee
  for five minutes and write an audit event. The till returns to employee-select after an idle
  timeout. PIN lockout is **independent** of the existing password lockout.
- The `Menu` page manages categories, items and modifiers. Prices are integer minor units.
- Delivered in two halves: **POS access first** (needs no money, no tax, no currency), then
  **money + menu**.

## Scope

**IN** — `src/lib/money/` (isomorphic), `src/lib/pin/` (isomorphic), `pos_devices`, PIN columns on
`users`, `device_id` + `client_op_id` on `audit_log`, nullable settings columns, the menu tables,
the `/pos/...` route tree, the POS service worker and manifest, `/api/pos/*` and `/api/menu/*`, the
dashboard `POS`, `Employees` and `Menu` pages, the rail change, the onboarding checklist.

**OUT** — taking an order, the payment transaction, invoices, journal entries, stock movements,
printing, POS sessions and shifts, the sync queue for sales, dining tables. The till in this plan can
be registered and logged into; **it cannot sell.** The `Inventory`, `Purchases`, `Expenses` and
`Reports` rail items stay `Soon` and get their own later plans. Everything on CLAUDE.md's
"Do NOT build" list stays out.

## Approach

**Chosen: two shippable halves, POS access first, money and menu second.**

The access half depends on no money arithmetic, no tax mode and no currency, so it is not blocked by
the accountant question behind open decisions 3 and 4. It delivers the thing the user actually asked
for — a POS page that opens the till — while those answers are still outstanding. The money and menu
half follows and is where those decisions must land.

Two amendments were forced by the risk panel and are not optional:
1. A **decisions phase runs first** (T-01..T-04) and resolves the money-module placement and the
   `/pos` URL prefix + service-worker policy *before any code*, recording both in `CLAUDE.md`.
2. The `audit_log` device columns land in the **access half's first migration**, not the menu half's
   — see the BLOCKER below.

Rejected — *foundation first (money, settings, menu, then access)*: every task would block on open
decisions 3 and 4. If the accountant takes two weeks, nothing ships, and the service-worker URL
decision would land after the routes were already written.

Rejected — *layered (all schema, then all domain, then all API, then all UI)*: nothing is
demonstrable until the end, and a single schema phase forces **all** open decisions into the first
migration, which is exactly what `src/lib/server/db/schema/restaurant-settings.ts` forbids.

## Risks that survived adversarial verification

Five lenses produced 55 findings; 48 were refuted. These survived.

- **BLOCKER — the money module cannot live where CLAUDE.md says it does.** CLAUDE.md invariant 1
  says arithmetic outside `src/lib/server/money` is a bug. Spec 17 requires one rounding function
  used by POS, server **and** reports. SvelteKit build-blocks `$lib/server` from the browser and
  `eslint.config.js` errors on it from `(pos)`. All three cannot hold.
  `src/lib/server/money/README.md` already records this as UNRESOLVED and reserves it for the first
  money task. Unfixed, the POS gets a copied rounding rule, the copies drift when open decision 3
  lands, and a receipt prints a different total from the one the books record.
  **Mitigated by T-01**, which must run before any arithmetic is written.
- **BLOCKER — a tax rate as a JS float puts floating point inside the money module.**
  `2415 * 0.0825 = 199.23749999999998`. Spec 17 carries full precision per line and rounds once at
  the total, so the error accumulates before any rounding and lands on the figure a tax filing
  reconciles against. **Mitigated by T-34**: integer basis points, integer multiply-then-divide.
- **BLOCKER — the schema guard would accept `numeric(12,2)` for a price.**
  `src/lib/server/db/schema-guards/schema.test.ts` rejects `real`, `double precision` and
  *unconstrained* `numeric`, but never asserts a money column **is** `bigint`. The menu schema is
  written beside a legitimate `numeric(12,3)` quantity idiom, so copying it passes every check while
  `pg` returns the value as a string and the first multiplication coerces to float.
  **Mitigated by T-04**, which adds the positive assertion before the first price column exists.
- **BLOCKER — `audit_log` needs `device_id` and `client_op_id` before its first device-sourced row.**
  This plan writes the first ones. `src/lib/server/db/schema/audit.ts` says so itself: add them
  "BEFORE the first device-sourced audit row is written, or a retried sync writes a duplicate that
  the append-only trigger then makes permanent". Migration `0004_audit_log_append_only.sql` blocks
  UPDATE and DELETE, so a duplicated login trail can never be corrected.
  **Mitigated by T-07.**
- **BLOCKER — the service worker would take over the dashboard, and there is no `/pos` URL to scope
  it to.** Raised independently by two lenses. `kit.serviceWorker.register` defaults to true and
  registers at scope `/`. Route groups are **not** URL segments, so `(pos)/till/+page.svelte` serves
  at `/till` and no `/pos` path exists today. The POS worker would therefore control `/dashboard`,
  and cached authenticated HTML and `__data.json` would sit in Cache Storage, which `/logout` does
  not clear. **Mitigated by T-02, T-27 and T-45.**

  **Settled while writing the tasks, and it changed a URL.** Service-worker scope matching is a
  **simple string prefix match, not a path-segment match** — the W3C ServiceWorker specification's
  "Match Service Worker Registration" algorithm, confirmed at
  https://github.com/w3c/ServiceWorker/issues/1272 (accessed 2026-09-14), whose canonical example is
  that a scope of `/maps` matches `/mapsearch`. MDN's prose implies path-segment matching and is
  wrong on this point. So a worker scoped to `/pos` **would** control a dashboard page at
  `/pos-device`, which is the very blocker above. The scope stays `/pos` with **no** trailing slash,
  because the till's own entry serves at `/pos` and a `/pos/` scope would leave the landing screen
  uncontrolled and therefore unable to work offline. Instead the **dashboard page moved to
  `/device`**, which no prefix rule can capture. Its rail item is still **labelled `POS`** — the
  label and the URL differ on purpose, because `/pos` belongs to the till. T-02 records in
  `CLAUDE.md`, and T-45 pins with a test, that no route outside the `(pos)` group may have a path
  beginning with the characters `pos`.
- **MINOR — a new schema file nobody imports escapes all three schema guards** while every test stays
  green, and `src/lib/server/db/test/reset.ts` carries a hardcoded `TABLES` list.
  **Mitigated by T-04**, and wiring both is an acceptance criterion on every schema task.

*Refuted and dropped* (48; the ones most likely to be raised again): cached PIN hashes are
brute-forceable over 10^6 — refuted twice, spec 6 mandates the design, so it is recorded as a GAP in
`RESEARCH.md` instead; device registration leaves a live owner session — the plan already destroys
it; the device cookie must be an opaque hashed token — spec 7 already settles it; the currency's
minor-unit exponent is assumed — spec 17 fixes it; `pos_devices` reusing the `POS1` prefix
duplicates invoice numbers — no invoice exists in this plan; the Employees page serialises
`pin_hash` — `assertNoSecrets` and the explicit-object-literal load pattern both block it;
`/api/menu` has no tenant — it resolves from the device row.

## Assumptions (open decisions this plan rides on)

**No task below may encode any of these before T-03 has obtained the answer and recorded it.**

- **Open decision 3 (tax rules) — ANSWERED 2026-09-15:** the user accepted the stated defaults in
  the words "Yes, all defaults (Recommended)". Tax mode is a NULLABLE per-restaurant owner setting
  with NO column DEFAULT (the owner picks 'exclusive' or 'inclusive' on /settings; nothing hardcodes
  one). ONE tax rate per restaurant in integer basis points (825 = 8.25%), plus a NULLABLE per-item
  `menu_items.tax_rate_bp` meaning 'inherit the restaurant rate' — so the rate is per-restaurant,
  with a per-item override. Tax at full precision per line, rounded ONCE on the invoice total; ties
  go half AWAY FROM ZERO, i.e. `ROUNDING_RULE = 'half-up'`. Still OPEN in spec 33 row 3: legal
  receipt/invoice requirements and tax on staff meals (confirm with a local accountant). Recorded
  in `CLAUDE.md`, "Decisions already made". As carried before the answer:
  Tax mode (inclusive vs exclusive), the rounding rule
  and whether a rate is per-item or per-restaurant. Default carried: mode is a **nullable** setting,
  round once on the invoice total, confirm with a local accountant. Blocks T-08, T-34, T-37.
- **Open decision 4 (currency) — ANSWERED 2026-09-15:** USD (ISO 4217), minor-unit exponent 2. One
  currency. The user's words: "USD — 2 decimals". Still OPEN in spec 33 row 4: which payment
  methods launch. Recorded in `CLAUDE.md`, "Decisions already made". As carried before the answer:
  One currency. The formatter needs a code and a
  minor-unit exponent. Blocks T-35, T-36.
- **Open decision 6 (idle lock) — ANSWERED 2026-09-15:** the user accepted the stated default in
  the words "Yes, all defaults (Recommended)". No number of seconds lives in code: the POS idle
  lock is a NULLABLE per-restaurant setting `restaurant_settings.pos_idle_lock_seconds` with NO
  column DEFAULT and NO code fallback (never `?? 120`); sanity bound 30–1800 seconds; the owner
  sets it on /device; spec 7's 2 minutes (120) is the value the owner would type — which is all
  the "120 seconds" below now means. Still OPEN in spec 33 row 6: approval limits (discount
  percentage, pay-out amount). Recorded in `CLAUDE.md`, "Decisions already made". As carried
  before the answer: Default carried: 120 seconds, nullable column.
  Blocks T-08, T-26.
- **PIN hash algorithm — NOT IN SPEC 33; this plan forced the question, ANSWERED 2026-09-15:** the
  user accepted the recommendation in the words "Yes, all defaults (Recommended)".
  PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte random salt, 32-byte derived key, via WebCrypto
  `crypto.subtle.deriveBits`, stored as a PHC-style string `$pbkdf2-sha256$i=600000$<salt>$<tag>`
  (standard base64, '=' stripped); one isomorphic module `src/lib/pin/` for server and offline
  till. Digit bound: 4–6 (spec 7). GAP (`RESEARCH.md`: cached PIN hashes brute-forceable over
  10^6 on a stolen tablet): option 1, ACCEPT the residual risk. PINs stay 4–6 digits (spec 7). No
  bundle expiry. Recorded in `CLAUDE.md`, "Decisions already made". As carried before the answer:
  WebCrypto offers PBKDF2 and
  **not** Argon2; the server's `node:crypto` argon2id cannot run in a browser, and spec 6 requires
  offline PIN verification from hashes cached on the device. Default carried:
  **PBKDF2-HMAC-SHA256 at 600,000 iterations** (OWASP), because it is the one algorithm with an
  identical code path in Node 24 and the browser and adds no runtime dependency to a project whose
  dependencies are exactly `drizzle-orm`, `pg` and `zod`. Blocks T-06, T-11.
- **Open decision 1 (one device vs a later second terminal).** Assumed one. `pos_devices` carries a
  device code (`POS1`) from the start so a second terminal is a data change, not a rewrite.

## In play

**Spec:** 5 (menu version + full snapshot + ETag), 6 (offline POS, cached PIN hashes,
`navigator.storage.persist`), 7 (POS authentication, device registration, dashboard revocation, PIN
rules), 8 (roles and permissions, server-side 403), 9 (cookie sessions, HttpOnly + Secure +
SameSite, CSRF on), 17 (money, tax, rounding), 18 (sales and tax), 29 (mandatory tests), 31 (MVP vs
Future), 33 (open decisions).

**Invariants:** 1 (money is integer minor units in `bigint`), 7 (discount before tax; each line
snapshots its own price and tax rate; ONE rounding rule in ONE function), 8 (permissions enforced
server-side on every route, reads included), 9 (owner PIN approval — the PIN itself is created
here), 10 (sensitive actions audit-logged, in the same transaction), 11 (timestamps `timestamptz`),
12 (POS access = registered device + PIN; 4-6 digits; slow salted hash; 5 attempts / 5 minutes;
idle return; HttpOnly + Secure device cookie revocable from the dashboard; never `localStorage`;
CSRF stays on). Invariant 5 is engaged as a **seam only** — this plan does not sell, so it leaves
`device_id` and `client_op_id` in place rather than building a sync queue.

## Workspace state at plan time (Phase 1, 2026-09-14)

**REPO PHASE: partially-built.** SvelteKit + TypeScript + Drizzle + PostgreSQL are scaffolded and
working. Five migrations are committed and have run.

Present and opened during planning: `src/hooks.server.ts`, `src/lib/public-routes.ts`,
`src/lib/rail.ts`, `src/lib/components/ui/Sidebar.svelte`, `src/lib/server/permissions/{index,keys}.ts`,
`src/lib/server/auth/password.ts`, `src/lib/server/audit/{index,events}.ts`,
`src/lib/server/restaurants/index.ts`, `src/lib/server/db/schema/{restaurants,restaurant-settings,users,sessions,audit}.ts`,
`src/lib/server/db/schema-guards/schema.test.ts`, `src/lib/server/db/test/reset.ts`,
`src/routes/route-guards.test.ts`, `src/routes/(dashboard)/**`, `src/routes/(pos)/+layout.svelte`.

Tables that exist: `restaurants`, `restaurant_settings`, `users`, `sessions`, `audit_log`. **That is
all.** There is no `pos_devices`, no menu table, and no money column anywhere in the schema.

`src/lib/server/{money,accounting,inventory,orders}/` and `src/lib/pos/` contain **only** a
`README.md` each — no code. There is no service worker, no manifest, no IndexedDB code and no PWA
tooling anywhere.

Two hard boundaries that shape several tasks:
- `eslint.config.js` forbids importing `$lib/server/**` from `src/lib/pos/**` and
  `src/routes/(pos)/**/*.{ts,svelte}`. POS server work therefore **cannot** be a `+page.server.ts`
  under the group; it goes to `src/routes/api/pos/*`, which is also the only place
  `route-guards.test.ts` can see it.
- `src/routes/route-guards.test.ts` asserts `PUBLIC_ROUTE_IDS` equals exactly
  `['/', '/login', '/register']`, and `src/hooks.server.ts` is deny-by-default, so every new route
  requires a deliberate edit to both.

This describes the repo **before T-01 runs**. Each task's `Files:` tag says which case it is:
`NEW` = this task creates it, `EXTEND` = an earlier task in this plan created it (and names which),
`EDIT` = it already existed at Phase 1. **Stop and report a mismatch only** when a path tagged `NEW`
already exists, or a path tagged `EXTEND`/`EDIT` does not — either means the repo is not in the
state this plan assumed.

## Task index

Every task in the plan, in dependency order. `Needs` is by ID, never "the previous work".

### Phase 0 — Decisions and guardrails (`01-decisions.md`)
No schema, no arithmetic and no route may land before this phase completes.

| ID | Title | Needs |
|---|---|---|
| T-01 | Resolve the money module placement and correct CLAUDE.md invariant 1 | - |
| T-02 | Decide the `/pos` URL prefix and the service-worker registration policy | - |
| T-03 | Obtain and record the four unanswered decisions (tax mode, currency, idle lock, PIN hash) | - |
| T-04 | Make the schema guard require `bigint` for money and notice undiscovered tables | - |

### Phase 1 — Schema, access half (`02-schema-access.md`)
**Depends on:** Phase 0

| ID | Title | Needs |
|---|---|---|
| T-05 | Create the `pos_devices` table | T-02, T-04 |
| T-06 | Add the PIN columns to `users` | T-03, T-04 |
| T-07 | Add `device_id` and `client_op_id` to `audit_log` with a partial UNIQUE | T-05 |
| T-08 | Add the nullable idle-lock setting to `restaurant_settings` | T-03 |
| T-09 | Generate and run the access migration | T-05, T-06, T-07, T-08 |
| T-10 | Wire the new tables into the schema guard and the test reset list | T-09 |

### Phase 2 — Domain, access half (`03-domain-access.md`)
**Depends on:** Phase 1

| ID | Title | Needs |
|---|---|---|
| T-11 | Create the isomorphic PIN hash module | T-03, T-06 |
| T-12 | Create the server-side PIN verification and lockout | T-11, T-10 |
| T-13 | Create POS device registration and revocation | T-05, T-10 |
| T-14 | Extend the audit event union with the POS events | T-07, T-10 |
| T-15 | Create the employee directory read model for the POS | T-06, T-11 |
| T-16 | Add the POS device resolution helper for non-dashboard routes | T-13 |

### Phase 3 — API, access half (`04-api-pos.md`)
**Depends on:** Phase 2

| ID | Title | Needs |
|---|---|---|
| T-17 | Open `/pos` and `/api/pos` in the route guard, deliberately | T-02, T-16 |
| T-18 | Create `POST /api/pos/register` | T-13, T-14, T-17 |
| T-19 | Create `POST /api/pos/pin` | T-12, T-14, T-16, T-17 |
| T-20 | Create `GET /api/pos/employees` | T-15, T-16, T-17 |
| T-21 | Create `POST /api/pos/revoke` and the dashboard revocation action | T-13, T-14 |
| T-22 | Add the permission-check test for every POS API route | T-18, T-19, T-20, T-21 |

### Phase 4 — The POS shell (`05-pos-shell.md`)
**Depends on:** Phase 3

| ID | Title | Needs |
|---|---|---|
| T-23 | Move the `(pos)` group under a real `/pos` URL prefix and pin the POS surface | T-02, T-17 |
| T-24 | Build the device registration screen | T-18, T-23 |
| T-25 | Build the employee-select screen | T-20, T-23 |
| T-26 | Build the PIN entry screen with lockout and idle return | T-19, T-25, T-08 |
| T-27 | Add the service worker, scoped to the POS prefix, and the web app manifest | T-02, T-23 |
| T-28 | Cache the employee PIN bundle in IndexedDB and persist storage | T-11, T-15, T-20, T-27 |

### Phase 5 — Dashboard, access half (`06-dashboard-access.md`)
**Depends on:** Phase 3

| ID | Title | Needs |
|---|---|---|
| T-29 | Build the dashboard `POS` page — register, revoke, launch | T-13, T-21, T-08, T-25 |
| T-30 | Replace the `Devices` rail item with `POS` | T-29 |
| T-31 | Build the `Employees` page | T-06, T-11, T-14 |
| T-32 | Make the onboarding checklist compute the employee and device steps | T-29, T-31 |

### Phase 6 — Money (`07-money.md`)
**Depends on:** Phase 0. Independent of phases 1-5.

| ID | Title | Needs |
|---|---|---|
| T-33 | Create the isomorphic money core | T-01 |
| T-34 | Add tax in both modes, with the rate in integer basis points | T-33, T-03 |
| T-35 | Add the money formatter | T-33, T-03 |
| T-36 | Add the tax-mode and currency settings columns and surface them in settings | T-03, T-34, T-35 |

### Phase 7 — Menu (`08-menu.md`)
**Depends on:** Phase 6, and on Phase 3 for the snapshot endpoints.

| ID | Title | Needs |
|---|---|---|
| T-37 | Create the menu schema and its migration | T-04, T-33, T-36 |
| T-38 | Create the menu domain module and the version bump | T-37 |
| T-39 | Build the dashboard `Menu` page | T-38, T-35 |
| T-40 | Create `GET /api/menu/version` with an ETag | T-38, T-16, T-17 |
| T-41 | Create `GET /api/menu` — the full snapshot | T-38, T-16, T-17, T-40 |
| T-42 | Download and replace the menu snapshot in the POS IndexedDB store | T-28, T-41 |
| T-43 | Turn on the `Menu` rail item and its onboarding step | T-39, T-32 |

### Phase 8 — Verification (`09-verification.md`)
**Depends on:** every phase above.

| ID | Title | Needs |
|---|---|---|
| T-44 | Extend the e2e journey through device registration and PIN login | T-32, T-30 |
| T-45 | Add the service-worker scope and cache-policy test | T-27 |
| T-46 | Add the offline PIN login e2e path | T-28, T-44 |
| T-47 | Run the full verification sweep and record what is still open | T-44, T-45, T-46, T-43 |

**47 tasks, 9 phases.** Research findings, including one `GAP` the user must decide on, are in
`RESEARCH.md` beside this file.
