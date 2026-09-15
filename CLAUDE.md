# matcami — Restaurant Management & POS (MVP v1.1)

One restaurant, one branch, one registered POS device, one owner + one cashier + one waiter. Dine-in (tables) and takeaway.
Stack: SvelteKit + TypeScript (UI **and** server) · Node.js · PostgreSQL · Drizzle ORM · IndexedDB + Service Worker for the offline POS · a local Print Agent over WebSocket/HTTP (→ ESC/POS) for receipts, kitchen tickets and the drawer. Modular monolith. No Redis, no server push in the MVP (spec 28, 30, 32).
Full spec: `docs/spec.md` (v1.1, sections 1–33; the signed-off PDF sits beside it). Cite as `(spec 17)`. The spec outranks this file; if they disagree, follow the spec and fix this file.

## Non-negotiable invariants

If a change breaks one, stop and say so.

1. **Money is integer minor units.** Integer cents in `bigint` columns; `$8.50` is `850`. NEVER a float or a `numeric` money column, NEVER arithmetic on money outside `src/lib/money` — the ISOMORPHIC module that owns rounding and tax and is imported by the server, the POS and reports alike; `src/lib/server/money/` holds ONLY helpers that touch the database — a float literal, `parseFloat` or a second rounding helper in money code is a bug. Ingredient quantities are the one exception: `numeric(12,3)`. One currency in the MVP. (spec 17, 3)
2. **Posted records are permanent.** NEVER `UPDATE` or `DELETE` a paid order, invoice, payment, stock movement, journal entry or journal line — not in app code, not in a repair script, not in a migration. Correct with a reversing record plus a new correct one. Normal path `OPEN → BILLED → PAID`; adding items to a BILLED order re-opens it; re-opening a PAID order needs owner-PIN approval and writes NEW records — it never rewinds posted ones. (spec 3, 13, 22)
3. **Journal entries balance in the database.** Debits = credits, enforced by a DB constraint checked at COMMIT, not only in TypeScript; a migration creating journal tables without it is incomplete. Entries are generated from business events by the spec 24 posting-rule table — nobody types a debit. (spec 3, 22, 24)
4. **One all-or-nothing transaction, and it runs AT PAYMENT.** One DB transaction, in order: record payment(s) → finalize totals → take the invoice number → deduct inventory (recipe × qty, incl. modifiers) → create invoice → post journal entries (sale **and** COGS) → mark order PAID. Adding items and sending to the kitchen are ordinary saves; printing NEVER happens inside the transaction. Splitting it across requests or committing part of it alone is a bug; an offline sale runs the SAME transaction server-side on sync. (spec 13)
5. **A completed offline CASH sale is a recorded FACT, not a request the server may reject.** Price and tax rate at time of sale win; stock may go negative; a synced sale that fails validation is stored and flagged for owner review, NEVER discarded. Every queued operation carries a device-generated idempotency key; a retry MUST be a no-op. Invoice numbers come from the device's gap-free sequence (`POS1-000001`), online or offline — the server enforces `UNIQUE (device_id, invoice_number)`, never renumbers, no global sequence, no `max(number)+1`. Card and mobile payments are NEVER auto-completed offline unless the provider/terminal explicitly supports offline authorization; house rule for that case: fail closed — no receipt, no invoice number, no Payment Clearing posting, order stays BILLED. Protect unsynced work: `navigator.storage.persist()`, unsynced count always on screen, logout and POS session close BLOCKED while the queue is non-empty (close needs a connection; reconciliation runs on the server). (spec 6)
6. **Inventory is a ledger.** Stock on hand is the sum of stock movements (purchase, sale consumption, waste, comp, count adjustment). A cached quantity may exist for speed but is NEVER the truth and NEVER written without the movement that caused it. Sales are NEVER blocked by stock levels; negative stock is flagged, not prevented. Costing is weighted average, recalculated on EVERY purchase (purchase units converted to base units first); every sale posts Dr COGS / Cr Inventory. (spec 3, 15, 16, 24)
7. **Discounts before tax; each line snapshots its own numbers.** Discount first, then tax the discounted amount. Every order line stores the unit price AND tax rate used, so later menu or rate changes cannot alter past sales. Tax mode (inclusive vs exclusive) is a restaurant setting read at calculation time, never hardcoded. ONE rounding rule in ONE function used by POS, server and reports: full precision per line, round once on the invoice total — spec 17's default, still subject to open decision 3. (spec 14, 17, 6)
8. **Permissions are enforced SERVER-side on every POS API route, reads included.** Each route checks its own permission and returns `403`; hiding a button is not security. A new `+server.ts` or form action with no permission check is unfinished. (spec 8, 29)
9. **Owner PIN approval is required** for: refund, void of an item already SENT to the kitchen, discount above the configured limit, comp/staff meal, re-opening a paid order, opening the cash drawer without a sale, cash pay-out above the limit, and voiding a whole order any of whose items were already SENT. Store action, acting employee, approver and reason code together in one audit record. Reason codes are mandatory on voids, refunds, discounts and comps — deleting a NEW (unsent) item needs none. (spec 8, 14)
10. **Sensitive actions are audit-logged**: logins, failed PINs, voids, refunds, discounts, comps, approvals, cash-drawer opens, price changes. House rule: write the audit row in the same transaction as the action — offline logins excepted, recorded locally and synced later. (spec 3, 6, 7)
11. **Business date, not calendar date.** A sale belongs to the business date of its POS session — 01:30 belongs to the previous evening. Reports, end-of-day and reconciliation group by it, never `created_at::date`. Timestamps stored UTC in `timestamptz`; the restaurant's time zone is a setting. (spec 10, 17)
12. **POS access = registered device + PIN.** PINs are 4–6 digits stored ONLY as slow salted hashes (spec 7's "e.g. Argon2 or bcrypt"; PINs use PBKDF2-SHA256 at 600,000 iterations so the offline till can verify them — see "Decisions already made"), never reversible, never logged; 5 wrong attempts lock the employee out for 5 minutes and write an audit event; the POS returns to employee-select after idle (default 2 min, configurable). The PIN screen is shown ONLY on a device the owner registered (long-lived HttpOnly+Secure device cookie, revocable from the dashboard). Sessions are HttpOnly + Secure + SameSite cookies — NEVER `localStorage` — and SvelteKit's origin/CSRF check stays ON. (spec 7, 9)

## Tests that are mandatory, not optional (spec 29)

A change in these areas without its test is not done.
- Money arithmetic and rounding; tax calculated in **both** modes.
- Journal entries always balance — property test over generated events, plus the DB rejecting an unbalanced entry.
- One posting-rule test per business event in the spec 24 table.
- Offline sync: retries never create duplicates.
- A permission check test on every POS API route.

## Where code lives

Business rules live in `src/lib/server/**`; routes validate input, check permissions, call a module, return.

```
src/
  lib/
    server/
      db/           Drizzle schema (one file per aggregate), generated migrations, client — the ONLY place tables are defined
      money/        ONLY money helpers that touch the DB — the arithmetic is src/lib/money/
      accounting/   chart of accounts, posting rules (one per business event), journal writer
      inventory/    stock movements, recipes + unit conversion, weighted-average costing
      orders/       order/item lifecycle, split & merge bills, THE payment transaction
      auth/         cookie sessions, PIN hash + lockout, POS device registration
      permissions/  RBAC checks + owner-PIN approval gates
      audit/        audit log writer
      restaurants/  restaurant record, settings, and the onRestaurantCreated initializer list
    money/          ISOMORPHIC: integer minor units, allocation, THE rounding rule, tax in both modes — imported by lib/server/** AND by (pos)
    pos/            IndexedDB, sync queue, service worker, device invoice sequence, print-agent client
    components/ui/  shared dashboard primitives — Button, Field, Card, PageHeader, Alert, StatusMark, ThemeToggle; they implement `docs/design-system.md` §7b
    styles/         tokens.css — THE design tokens; no colour, size or type literal lives anywhere else
  routes/
    login/          email + password sign-in — OUTSIDE the route groups: reachable without a session
    register/       first-run owner registration, gated by SETUP_TOKEN — likewise outside the groups
    logout/         form action only; its load returns 405 so a GET cannot sign anyone out — likewise outside the groups
    (dashboard)/    owner/admin: menu, purchases, expenses, reports — online only
    (pos)/pos/      POS shell at the REAL /pos/... URL prefix: PIN login, orders, payment, session open/close — MUST work offline. The group name is not a URL segment; the inner pos/ directory is what creates the path
    api/            JSON endpoints: POS sync, menu version/snapshot — no printing endpoint, printing is local
```

Migrations live in `src/lib/server/db/migrations` (point `drizzle.config.ts` there), are COMMITTED, and are NEVER hand-edited once they have run — add a new one instead.

House convention, not spec (spec 30/32 say only "modular monolith"): `lib/server/**` MUST NOT be imported by client-side code or by `lib/pos/`; `src/lib/money/` is ISOMORPHIC — imported by `lib/server/**`, by `lib/pos/` and by `routes/(pos)/**`, and it imports nothing at all: no sibling, no `lib/server/**`, no Node builtin; `orders/` calls `accounting/`, `inventory/`, `permissions/`, `audit/`, and none of them call back. `restaurants/` is called by routes and by `orders/`-style modules, and calls only `audit/`. `lib/components/**` takes its data as props and imports nothing from `lib/server`; `src/lib/components/components.test.ts` enforces it.

## Design & UI

Styling is **Tailwind CSS v4** (a user decision, recorded in `tasks/project-init.md`; configured in CSS via `@theme` — there is no `tailwind.config.js` and must not be). Tokens live in `src/lib/styles/tokens.css`, imported by `src/app.css` — the ONLY place a colour, size or type value is defined. Write `bg-raise text-ink p-touch`; an arbitrary value like `bg-[#123456]` or `p-[57px]` in a component is a bug — add a token instead. Full reference `docs/design-system.md`; the researched layout grammar, with adopt/adapt/reject verdicts, is `docs/pos-layout-grammar.html`.

- **Light is the default.** The bare `:root` holds the COMPLETE light palette; dark is `@media (prefers-color-scheme:dark)` guarded as `:root:not([data-theme="light"])`, plus a `:root[data-theme="dark"]` stamp so an explicit choice wins either way. Every `--c-*` MUST exist in the bare `:root` — one defined only inside a media or `[data-theme]` block is invisible in the un-stamped state. Themeable tokens are exposed to Tailwind via **`@theme inline`**, which is required: plain `@theme` bakes the light value into the utility, while `inline` emits `var(--c-bg)` so the utility follows the theme.
- **The POS is a device surface, and it is LIGHT and PINNED in both themes** — `[data-surface="pos"]`, stamped on the `(pos)` route group. It does not follow the viewer's theme: the till's appearance is a property of the hardware on the counter. *(Reversed 2026-09-14. It was dark in both themes; the glare argument was raised and overruled.)* **The scope pins the COMPLETE palette, not just the grounds** — a surface pinned one way whose inks still theme is the defect that has appeared twice, pinned dark with light inks (1.08:1) and pinned light with dark inks (1.21:1). The four old chrome tokens `--screen`/`--key`/`--key-line`/`--key-ink` are RETIRED and a test forbids their return. And because a white key on the POS ground is 1.22:1, **every pressable POS surface takes a `border-control-line` edge** — elevation alone cannot carry a control's boundary (WCAG 1.4.11).
- **Colour NEVER carries meaning alone** — pair every status with its glyph. Item `NEW ◇` / `SENT ▲` / `VOIDED ✕` (struck through, with reason + approver); order `OPEN ○` / `BILLED ◐` / `PAID ●` / `VOIDED ✕` / `REFUNDED ↩`; table free `○` / occupied `●` + open amount; sync online `●` / offline `◆` + unsynced count. (WCAG 1.4.1; ~1 in 12 men has red-green CVD.)
- **Money renders through the money module's formatter**, in `--font-mono` with `tabular-nums`, right-aligned, negatives with a leading `−` AND `--danger`. Each line shows the price and tax rate STORED on it. The UI never does money arithmetic and never rounds (invariants 1, 7).
- **The dashboard's layout grammar is `docs/design-system.md` §7b**, implemented by `src/lib/components/ui/`: a screen composes primitives rather than retyping class strings.
- **Legal ink-on-surface pairs — both themes, no per-theme reasoning.** `text-ink-3` is legal ONLY on `bg-raise` (5.13:1 light, 4.87:1 dark) — use `text-ink-2` on every other surface. `text-ok` and `text-danger` are never used on `bg-raise-2` (4.18:1, 4.06:1 dark) or `bg-accent-soft` (4.31:1, 4.19:1 dark). Interactive control borders use `border-control-line`; `border-line` is decorative only, at 1.58:1 on `bg-raise`.
- **The three typefaces are self-hosted** from pinned `@fontsource` packages. The variable packages declare the family names `Archivo Variable` and `IBM Plex Sans Variable`, so the `--font-*` stacks must keep naming what the packages declare — `src/lib/styles/fonts.test.ts` asserts it. A stack naming plain `Archivo` renders in `system-ui` with every check, lint, test and e2e spec still green.
- **Touch targets** on the POS: floor `touch-min` 56px, standard `touch` 64px, keys `touch-lg` 72px, Pay / Send-to-kitchen `touch-xl` 96px (`p-touch`, `min-h-touch-xl`). Dashboard uses Tailwind's default scale. Apple 44pt and Material 48dp assume a seated user holding the device — too small for a counter.
- **The guest check is permanent**; tabs and the item grid swap around it. Modals are for reason codes, owner approval and errors only — never ordinary ordering.
- **Offline state is permanent chrome** carrying the unsynced count (spec 6), never a toast. A control disabled by a non-empty queue must say why rather than sit dead. Card and mobile tenders visibly disable offline — they never fail after the tap (invariant 5).
- **Receipts are a separate problem**: 32 or 48 fixed characters, no colour, monospace, `COPY` on reprints (spec 11). None of the screen tokens apply.
- **WCAG AA (4.5:1) at normal text size, in both themes**, for every text-on-surface pair. Verify before adding a colour.

## Commands & setup

Every command below has been run in this repo. The database has TWO roles: `matcami` **owns** the tables (migrations, `pg_dump`, `db:studio`) and `matcami_app` is the **runtime** role, which owns nothing — so `db-bootstrap.sh` takes two passwords and `.env` carries `DATABASE_URL` (runtime) alongside `MIGRATE_DATABASE_URL` and `TEST_DATABASE_URL` (owner). Node is pinned to **24.21.0** (`.nvmrc`); `engines` refuses anything else, so `nvm use` before any pnpm command. `package.json` remains the source of truth for scripts. The database is the host-installed PostgreSQL 16 — there is **no** compose file.

```bash
nvm use                                   # 24.21.0 — engine-strict refuses anything else
pnpm install
pnpm exec playwright install chromium     # browser binary, separate from the npm package

bash scripts/db-bootstrap.sh <owner-pw> <app-pw>   # roles matcami + matcami_app, both DBs UTC; needs sudo
cp .env.example .env                      # then fill in the password; .env is NEVER committed

pnpm dev
pnpm build                                # adapter-node → build/index.js
pnpm check && pnpm lint                   # svelte-check; prettier --check . && eslint .
pnpm format                               # prettier --write .
pnpm test                                 # Vitest: unit + integration
pnpm test:unit                            # unit project only
pnpm test:integration                     # integration only — refuses any DB not ending in _test
pnpm test:e2e                             # Playwright, against the production build
pnpm db:generate                          # drizzle-kit — SQL from src/lib/server/db/schema
pnpm db:migrate                           # runs db:backup FIRST, automatically (spec 29), then migrates
pnpm db:backup                            # pg_dump into backups/ (gitignored)
pnpm db:studio                            # row editor over the live DB — never edit a posted record
```

Three pins look wrong and are not: **Node 24.21.0** (`vitest@5` excludes Node 25 outright), **TypeScript 6.0.3** not 7.x (the only version `@sveltejs/kit`, `svelte-check` and `typescript-eslint` all accept), and **`@types/node` 24.13.4** (must match the Node 24 runtime, so neither the `latest` 22.x nor the `ts6.0` tag's 26.x). Every dependency is pinned exactly, with no `^` or `~`. `README.md` has the details.

## Domain glossary

- **Account codes** — use spec 23's numbers verbatim (1000 Cash on Hand … 6900 Other Expenses). Never invent one; propose it instead.
- **POS session** — a cashier shift: opening cash → sales → count → reconciliation → end-of-day report. Distinct from the auth session.
- **Item status** — `NEW` (change or delete freely) → `SENT` (kitchen ticket printed; removal is a void, not a delete) → `VOIDED` (waste if already prepared).
- **Void / refund / comp** — void before payment; refund after payment, back to the original method, food does not come back; comp = no revenue, cost to 5200 Comps & Staff Meals.
- **Base unit vs purchase unit** — recipes use base units (g, pcs, can); purchases are entered in purchase units (kg, bag, case) and converted.
- **Modifier** — a menu option that changes price **and** recipe (Extra Cheese → +1 cheese, +$0.50), so it changes the deduction too.
- **Clearing account** — 1020 card / 1030 mobile hold funds until they land in 1010 Bank; settlement posts fees to 6400.
- **Cash Over/Short (6800)** — absorbs the expected-vs-counted cash difference at session close.
- **Pay-out** — cash out of the drawer at the POS; it becomes an expense entry automatically.
- **Print agent** — local ESC/POS service owning the printers and drawer; the browser NEVER talks to hardware. Queues jobs while a printer is down; reprints are marked COPY.
- **Menu version** — integer the POS compares against `/api/menu/version`; on a mismatch it downloads the FULL snapshot and replaces its local copy. No change-only sync.

## Open decisions — UNRESOLVED (spec 33)

When work touches one, SURFACE the question and its default, ASK, and record the assumption in the commit/PR. NEVER assume one silently; when a decision is made, record it here and delete its row. This applies beyond the seven: if a task raises a question the spec does not answer — a service charge, a tip line, a new account, a new payment method — treat it the same way, and NEVER bake an answer into the schema or the chart of accounts silently.

1. Waiter order entry with one device → shared POS at the counter; a tablet becomes terminal 2 later.
2. Hosting: cloud or in-restaurant server → cloud (Docker + Nginx) with the offline POS.
3. Local tax rules — still open: legal receipt/invoice requirements and tax on staff meals → confirm with a local accountant. (Tax mode, the tax rate's shape and the rounding rule were answered 2026-09-15 — see "Decisions already made".)
4. Payment methods at launch → cash + one card or mobile-money method. (The currency was answered 2026-09-15 — see "Decisions already made".)
5. Who approves refunds/voids when the owner is away → owner PIN only; Manager role later.
6. Approval limits for discounts and pay-outs → discounts above 10% and pay-outs above a set amount need approval. (Lock timing was answered 2026-09-15 — see "Decisions already made".)
7. Inventory costing method → weighted average.

## Decisions already made (NOT open — do not re-litigate)

Settled by `tasks/restaurant-identity-and-dashboard`. Separate from the open-decisions table above: these have answers, and changing one is a new decision, not a gap to fill.

- **Validation library — `zod`, pinned exactly.** Server-side only; no schema is imported into a `.svelte` component, so the client cannot disagree with the server about what is valid.
- **The `admin.*` permission keys are a PLAN-LEVEL EXTENSION, not spec 8 text.** Spec 8 introduces its list with "For example" and names no dashboard key. Spec 8's ten POS keys are reproduced verbatim and tested against the spec; the eight `admin.*` keys are granted to the owner only. Needing a key that is in neither list is still a reason to stop and ask.
- **Password login lockout is a HOUSE RULE adapted from spec 7's PIN rule**, and is paired with a per-IP throttle in front of the hashing. Spec 7's five-attempts/five-minutes is written for PINs on a registered device; applied naively to a public endpoint it is a denial-of-service lever against the only owner account.
- **Registration is first-run plus `SETUP_TOKEN`.** `/register` answers only while zero restaurants exist AND the submitted token matches. There is NO environment variable that re-opens it; additional restaurants are created with `pnpm restaurant:create`.
- **The database has TWO roles.** `matcami` owns the tables (migrations, `pg_dump`, `db:studio`); `matcami_app` is the runtime role and owns nothing — no DDL, no `TRUNCATE`. That split is what makes row-level security a later one-line migration instead of a database re-bootstrap, and it is why `.env` carries `DATABASE_URL` alongside `MIGRATE_DATABASE_URL`. Do not point the application at the owner role. See `docs/deployment.md`.
- **The money arithmetic is ISOMORPHIC, in `src/lib/money/`.** Spec 17 requires one rounding rule in one function used by POS, server and reports; SvelteKit build-blocks `$lib/server/**` from the browser and `eslint.config.js` errors on it from `(pos)`; the spec outranks this file, so invariant 1's wording was corrected rather than the spec bent. `src/lib/server/money/` remains, for DB-touching helpers only. Copying a rounding function into `src/lib/pos/` stays forbidden — two copies of a rounding rule is the bug spec 17 exists to prevent.
- **The POS is served at a real `/pos` URL prefix, and its service worker is registered by hand, scoped to exactly `/pos`, with one precached shell.** Six parts, each with its reason; the user confirmed this policy on 2026-09-15 over an earlier draft that made `/pos` navigations network-only with no offline fallback, which would have left the till unable to start offline. (1) **Pages live under `src/routes/(pos)/pos/**`, which serve at `/pos/...`.** A route group is NOT a URL segment: `src/routes/(dashboard)/dashboard/+page.svelte` serves at `/dashboard` because of the inner `dashboard/` directory, not because of the group name, and `src/routes/(pos)/+layout.svelte` contributes nothing to any path — so without the inner `pos/` directory there is no `/pos` URL at all and nothing for a worker to be scoped to. (2) **`kit.serviceWorker.register` is `false` in `svelte.config.js`.** The default is `true`, which injects a registration into every server-rendered page at scope `/`; a worker at `/` controls `/dashboard` as well as the till, so authenticated dashboard HTML and `__data.json` responses would land in Cache Storage — which `/logout` does not clear, because deleting a session cookie does not delete a cache. (3) **The worker is registered manually, from the POS layout only, with `{ scope: '/pos' }` — NO trailing slash, and that is the trap in the whole decision.** The Service Worker specification lets a script at `/service-worker.js` claim any scope at or below its own directory, so narrowing to `/pos` is legal and needs no `Service-Worker-Allowed` header; only widening beyond the script's directory would need one, and nothing here does. Scope matching is a plain STRING prefix on the client URL — the specification's "Match Service Worker Registration" algorithm, whose own canonical example is that a scope of `https://www.google.com/maps` matches `https://www.google.com/mapsearch` (https://github.com/w3c/ServiceWorker/issues/1272, accessed 2026-09-14). MDN's prose implies a path-segment match; MDN is wrong on this point and the specification governs — do not "correct" this back. So `/pos` matches `/pos` — the till's own landing screen — as well as `/pos/register` and `/pos/pin`, while `/pos/` would match the latter two and NOT the landing screen; SvelteKit's `trailingSlash: 'never'` default means there is no `/pos/` URL at all, so a `/pos/` scope would leave the till's entry page uncontrolled and unable to load offline, defeating the whole surface. The web app manifest's `scope` and `start_url` are the same literal `/pos`, which keeps one spelling across worker and manifest and avoids that default answering `/pos/` with a redirect. If an assertion anywhere is ever "fixed" by adding a trailing slash, the fix is wrong. (4) **No route outside the `(pos)` group may have a URL path beginning with the characters `pos`, because the service-worker scope is a string prefix, so a `/pos` scope controls every such route too** — a dashboard page at `/poster`, or at `/pos` followed by any other suffix, would be controlled by the POS worker, which could then serve that authenticated page's HTML and `__data.json` out of Cache Storage after logout, which `/logout` does not clear. That is why the dashboard page that registers, revokes and launches the till is `/device` (directory `src/routes/(dashboard)/device/`; the `NavItem` href union in `src/lib/components/ui/Sidebar.svelte` carries `'/device'`): `/device` cannot be prefixed by `/pos` under any matching rule, so the collision is removed structurally and no future reader has to reason about scope semantics to stay safe. The rail item's LABEL stays `POS` while its URL is `/device` — they differ on purpose: `/pos` belongs to the till, so the dashboard page that manages it cannot have that URL. The service-worker test that ships with the worker walks the route tree and fails on any route outside the group whose path begins with `pos`. (5) **The worker precaches the POS shell's own build assets AND one POS app-shell document, in its single install-time `addAll`, and serves that shell as the navigation fallback for every navigation it controls — every document request under the `/pos` prefix — ONLY when the network fetch throws.** Without a cached navigation response nothing answers a reload or a cold start of `/pos/...` with the network down: the request fails, the precached build assets are never reached, and the till cannot start offline at all. Spec 6 requires the opposite ("the POS should be capable of continuing to work when the Internet temporarily disappears", built on a Service Worker plus IndexedDB), and this file's own `(pos)/ … MUST work offline` says the same. The cached shell carries NO per-employee and NO per-session data — no employee list, no employee name, no PIN hash, no rendered session state, nothing that identifies who is signed in — so a shell served from the cache cannot outlive a revoked device cookie or a signed-out employee; everything session-shaped is fetched at runtime into that shell and fails closed when it cannot be. (6) **Everything else is network-only, and the shell is the only document ever written to Cache Storage.** The worker never caches a document outside `/pos`, never caches a `__data.json` and never caches an API response, and two mechanisms hold that, not one: the `{ scope: '/pos' }` above means a `/dashboard` navigation never reaches the worker in the first place, and inside `/pos` the worker's only cache write is the shell precache — there is no runtime `cache.put`, so an authenticated response has no path into the cache even for a URL the worker does control. Spec 5's menu snapshot is cached in IndexedDB by the application, not in Cache Storage by the worker, so there is exactly one place a stale menu can live and one version number that governs it.
- **Tax — spec 33 open decision 3, the parts answered 2026-09-15.** Tax mode is a NULLABLE per-restaurant owner setting with NO column DEFAULT: the owner picks `exclusive` or `inclusive` on `/settings`, and nothing hardcodes one. The rate is ONE per restaurant, an integer in basis points (`825` = 8.25%, never `0.0825`), plus a NULLABLE per-item `menu_items.tax_rate_bp` that means "inherit the restaurant rate". Tax is carried at full precision per line and rounded ONCE on the invoice total, and a tie goes half AWAY FROM ZERO (`ROUNDING_RULE = 'half-up'`, so a reversing entry cancels the entry it reverses exactly). Legal receipt/invoice requirements and tax on staff meals stay open in row 3. The user accepted these as stated, in the words "Yes, all defaults (Recommended)" (`tasks/pos-access-and-menu` T-03).
- **Currency — spec 33 open decision 4, the part answered 2026-09-15: USD (ISO 4217), minor-unit exponent 2.** `$8.50` is stored as `850`; one currency. The user's words: "USD — 2 decimals". Which payment methods launch stays open in row 4.
- **POS idle lock — spec 33 open decision 6, the part answered 2026-09-15.** No number of seconds lives in code: the idle lock is a NULLABLE per-restaurant setting, `restaurant_settings.pos_idle_lock_seconds`, with NO column DEFAULT and NO code fallback (never `?? 120`), bounded 30–1800 seconds and set by the owner on `/device`. Spec 7's "default 2 minutes" is the value an owner would type, not one the code assumes. Approval limits for discounts and pay-outs stay open in row 6. The user accepted this in the words "Yes, all defaults (Recommended)".
- **PIN hash — not in spec 33; `tasks/pos-access-and-menu` forced the question, answered 2026-09-15.** PBKDF2-HMAC-SHA256 at 600,000 iterations (OWASP's figure), a 16-byte random salt and a 32-byte derived key, through WebCrypto `crypto.subtle.deriveBits`, stored as a PHC-style string `$pbkdf2-sha256$i=600000$<salt>$<tag>` (standard base64, `=` stripped) so the cost can be raised later without invalidating stored hashes, and implemented ONCE in the isomorphic `src/lib/pin/` that the server and the offline till both import. Not argon2id: WebCrypto has no Argon2, `node:crypto`'s has no browser build, and spec 6 requires the till to verify a PIN offline from hashes cached on the device; spec 7's "e.g. Argon2 or bcrypt" names examples, not a closed list. PINs stay 4–6 digits (spec 7). The residual risk that a 4–6 digit PIN is brute-forceable over 10^6 values from hashes cached on a stolen tablet is ACCEPTED (option 1 of the GAP in that plan's `RESEARCH.md`): no 6-digit minimum and no expiry on the cached bundle; the controls are device registration, revocation from the dashboard and owner-PIN approval of every money-moving action. The user accepted this in the words "Yes, all defaults (Recommended)".
- **A second cashier or waiter is ALLOWED — answered 2026-09-15.** Spec 31's "one owner, one cashier, one waiter" is MVP scope, not a database constraint: there is no unique index on `(restaurant_id, role)`, so a mistyped employee is fixed by adding the right one rather than by a database edit. The user accepted this in the words "Yes, all defaults (Recommended)".

## Do NOT build (spec 31, 28, 27, 5, 15)

Delivery · multiple branches, terminals, warehouses or tenants · Kitchen Display System · waiter handhelds · Manager role and remote approvals, advanced RBAC, advanced employee management · sub-recipes and batch prep · supplier management, Accounts Receivable, payroll, bank reconciliation, any accounting beyond spec 23's chart — the Accounts Payable *account* (2000) IS in the MVP, supplier management is not · change-only menu sync · Redis and server WebSocket push · biometrics · advanced analytics · summary tables, materialized views and background report jobs (plain indexed SQL until a report is measurably slow, spec 27). Leave seams, not implementations: keep `device_id` on POS-created rows so a second terminal is a data change, not a rewrite.

## Task routing & skill map

`plan-feature` (brainstorm → risk panel → approval gate → `tasks/`) and `execute-plan` (worktree → commit per task → verify → PR) EXIST in `.claude/skills/`. Everything in the table below is still PLANNED — until one exists, read the cited spec sections.

| Task smells like | Code | Spec | Skill (planned) |
|---|---|---|---|
| "What does the spec say about X?" | — | `docs/spec.md` | `spec-lookup` |
| New table, column, index, migration | `lib/server/db` | 3, 17 | `drizzle-schema` |
| Prices, totals, tax, rounding, currency | `lib/money` | 17, 18 | `money-tax` |
| Debits, credits, accounts, journal entries | `lib/server/accounting` | 22–25 | `accounting-posting` |
| Wrong data already posted / "fix yesterday's X" | `lib/server/accounting` | 3, 14, 22 | `accounting-posting` — reversing entry, NEVER an edit |
| Recipes, stock, waste, purchases, COGS | `lib/server/inventory` | 15, 16, 19 | `inventory-cogs` |
| Order flow, payment, split/merge bills | `lib/server/orders` | 13, 14 | `order-payment` |
| IndexedDB, sync queue, idempotency, menu version | `lib/pos` | 4, 5, 6 | `offline-sync` |
| Who may do what, PIN approval, 403s | `lib/server/permissions` | 7, 8, 9, 14 | `permissions-approvals` |
| Receipts, kitchen tickets, drawer kick | `lib/pos` print-agent client | 11 | `pos-printing` |
| Reports, end-of-day, trial balance | `routes/(dashboard)` | 10, 26, 27 | `reporting` |
