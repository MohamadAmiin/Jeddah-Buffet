# matcami — Restaurant Management & POS (MVP v1.1)

One restaurant, one branch, one registered POS device, one owner + one cashier + one waiter. Dine-in (tables) and takeaway.
Stack: SvelteKit + TypeScript (UI **and** server) · Node.js · PostgreSQL · Drizzle ORM · IndexedDB + Service Worker for the offline POS · a local Print Agent over WebSocket/HTTP (→ ESC/POS) for receipts, kitchen tickets and the drawer. Modular monolith. No Redis, no server push in the MVP (spec 28, 30, 32).
Full spec: `docs/spec.md` (v1.1, sections 1–33; the signed-off PDF sits beside it). Cite as `(spec 17)`. The spec outranks this file; if they disagree, follow the spec and fix this file.

## Non-negotiable invariants

If a change breaks one, stop and say so.

1. **Money is integer minor units.** Integer cents in `bigint` columns; `$8.50` is `850`. NEVER a float or a `numeric` money column, NEVER arithmetic on money outside `src/lib/server/money`, which owns rounding and tax — a float literal, `parseFloat` or a second rounding helper in money code is a bug. Ingredient quantities are the one exception: `numeric(12,3)`. One currency in the MVP. (spec 17, 3)
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
12. **POS access = registered device + PIN.** PINs are 4–6 digits stored ONLY as slow salted hashes (Argon2/bcrypt), never reversible, never logged; 5 wrong attempts lock the employee out for 5 minutes and write an audit event; the POS returns to employee-select after idle (default 2 min, configurable). The PIN screen is shown ONLY on a device the owner registered (long-lived HttpOnly+Secure device cookie, revocable from the dashboard). Sessions are HttpOnly + Secure + SameSite cookies — NEVER `localStorage` — and SvelteKit's origin/CSRF check stays ON. (spec 7, 9)

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
      money/        integer cents, allocation, THE rounding rule, tax in both modes
      accounting/   chart of accounts, posting rules (one per business event), journal writer
      inventory/    stock movements, recipes + unit conversion, weighted-average costing
      orders/       order/item lifecycle, split & merge bills, THE payment transaction
      auth/         cookie sessions, PIN hash + lockout, POS device registration
      permissions/  RBAC checks + owner-PIN approval gates
      audit/        audit log writer
      restaurants/  restaurant record, settings, and the onRestaurantCreated initializer list
    pos/            IndexedDB, sync queue, service worker, device invoice sequence, print-agent client
    styles/         tokens.css — THE design tokens; no colour, size or type literal lives anywhere else
  routes/
    login/          email + password sign-in — OUTSIDE the route groups: reachable without a session
    register/       first-run owner registration, gated by SETUP_TOKEN — likewise outside the groups
    logout/         form action only; its load returns 405 so a GET cannot sign anyone out — likewise outside the groups
    (dashboard)/    owner/admin: menu, purchases, expenses, reports — online only
    (pos)/          POS shell: PIN login, orders, payment, session open/close — MUST work offline
    api/            JSON endpoints: POS sync, menu version/snapshot — no printing endpoint, printing is local
```

Migrations live in `src/lib/server/db/migrations` (point `drizzle.config.ts` there), are COMMITTED, and are NEVER hand-edited once they have run — add a new one instead.

House convention, not spec (spec 30/32 say only "modular monolith"): `lib/server/**` MUST NOT be imported by client-side code or by `lib/pos/`; `money/` is imported by everything and imports no sibling; `orders/` calls `accounting/`, `inventory/`, `permissions/`, `audit/`, and none of them call back. `restaurants/` is called by routes and by `orders/`-style modules, and calls only `audit/`.

## Design & UI

Styling is **Tailwind CSS v4** (a user decision, recorded in `tasks/project-init.md`; configured in CSS via `@theme` — there is no `tailwind.config.js` and must not be). Tokens live in `src/lib/styles/tokens.css`, imported by `src/app.css` — the ONLY place a colour, size or type value is defined. Write `bg-raise text-ink p-touch`; an arbitrary value like `bg-[#123456]` or `p-[57px]` in a component is a bug — add a token instead. Full reference `docs/design-system.md`; the researched layout grammar, with adopt/adapt/reject verdicts, is `docs/pos-layout-grammar.html`.

- **Light is the default.** The bare `:root` holds the COMPLETE light palette; dark is `@media (prefers-color-scheme:dark)` guarded as `:root:not([data-theme="light"])`, plus a `:root[data-theme="dark"]` stamp so an explicit choice wins either way. Every `--c-*` MUST exist in the bare `:root` — one defined only inside a media or `[data-theme]` block is invisible in the un-stamped state. Themeable tokens are exposed to Tailwind via **`@theme inline`**, which is required: plain `@theme` bakes the light value into the utility, while `inline` emits `var(--c-bg)` so the utility follows the theme.
- **The POS shell stays dark in BOTH themes** (`--screen`, `--key`, `--key-ink`). It is a device surface, not page chrome. Do not theme it.
- **Colour NEVER carries meaning alone** — pair every status with its glyph. Item `NEW ◇` / `SENT ▲` / `VOIDED ✕` (struck through, with reason + approver); order `OPEN ○` / `BILLED ◐` / `PAID ●` / `VOIDED ✕` / `REFUNDED ↩`; table free `○` / occupied `●` + open amount; sync online `●` / offline `◆` + unsynced count. (WCAG 1.4.1; ~1 in 12 men has red-green CVD.)
- **Money renders through the money module's formatter**, in `--font-mono` with `tabular-nums`, right-aligned, negatives with a leading `−` AND `--danger`. Each line shows the price and tax rate STORED on it. The UI never does money arithmetic and never rounds (invariants 1, 7).
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
3. Local tax rules (inclusive/exclusive, rounding, legal receipt requirements, tax on staff meals) → tax mode as a setting, round on the invoice total, confirm with a local accountant.
4. Payment methods and currencies at launch → cash + one card or mobile-money method; one currency.
5. Who approves refunds/voids when the owner is away → owner PIN only; Manager role later.
6. Approval limits and lock timing → discounts above 10% and pay-outs above a set amount need approval; auto-lock after 2 minutes idle.
7. Inventory costing method → weighted average.

## Decisions already made (NOT open — do not re-litigate)

Settled by `tasks/restaurant-identity-and-dashboard`. Separate from the open-decisions table above: these have answers, and changing one is a new decision, not a gap to fill.

- **Validation library — `zod`, pinned exactly.** Server-side only; no schema is imported into a `.svelte` component, so the client cannot disagree with the server about what is valid.
- **The `admin.*` permission keys are a PLAN-LEVEL EXTENSION, not spec 8 text.** Spec 8 introduces its list with "For example" and names no dashboard key. Spec 8's ten POS keys are reproduced verbatim and tested against the spec; the eight `admin.*` keys are granted to the owner only. Needing a key that is in neither list is still a reason to stop and ask.
- **Password login lockout is a HOUSE RULE adapted from spec 7's PIN rule**, and is paired with a per-IP throttle in front of the hashing. Spec 7's five-attempts/five-minutes is written for PINs on a registered device; applied naively to a public endpoint it is a denial-of-service lever against the only owner account.
- **Registration is first-run plus `SETUP_TOKEN`.** `/register` answers only while zero restaurants exist AND the submitted token matches. There is NO environment variable that re-opens it; additional restaurants are created with `pnpm restaurant:create`.
- **The database has TWO roles.** `matcami` owns the tables (migrations, `pg_dump`, `db:studio`); `matcami_app` is the runtime role and owns nothing — no DDL, no `TRUNCATE`. That split is what makes row-level security a later one-line migration instead of a database re-bootstrap, and it is why `.env` carries `DATABASE_URL` alongside `MIGRATE_DATABASE_URL`. Do not point the application at the owner role. See `docs/deployment.md`.

## Do NOT build (spec 31, 28, 27, 5, 15)

Delivery · multiple branches, terminals, warehouses or tenants · Kitchen Display System · waiter handhelds · Manager role and remote approvals, advanced RBAC, advanced employee management · sub-recipes and batch prep · supplier management, Accounts Receivable, payroll, bank reconciliation, any accounting beyond spec 23's chart — the Accounts Payable *account* (2000) IS in the MVP, supplier management is not · change-only menu sync · Redis and server WebSocket push · biometrics · advanced analytics · summary tables, materialized views and background report jobs (plain indexed SQL until a report is measurably slow, spec 27). Leave seams, not implementations: keep `device_id` on POS-created rows so a second terminal is a data change, not a rewrite.

## Task routing & skill map

`plan-feature` (brainstorm → risk panel → approval gate → `tasks/`) and `execute-plan` (worktree → commit per task → verify → PR) EXIST in `.claude/skills/`. Everything in the table below is still PLANNED — until one exists, read the cited spec sections.

| Task smells like | Code | Spec | Skill (planned) |
|---|---|---|---|
| "What does the spec say about X?" | — | `docs/spec.md` | `spec-lookup` |
| New table, column, index, migration | `lib/server/db` | 3, 17 | `drizzle-schema` |
| Prices, totals, tax, rounding, currency | `lib/server/money` | 17, 18 | `money-tax` |
| Debits, credits, accounts, journal entries | `lib/server/accounting` | 22–25 | `accounting-posting` |
| Wrong data already posted / "fix yesterday's X" | `lib/server/accounting` | 3, 14, 22 | `accounting-posting` — reversing entry, NEVER an edit |
| Recipes, stock, waste, purchases, COGS | `lib/server/inventory` | 15, 16, 19 | `inventory-cogs` |
| Order flow, payment, split/merge bills | `lib/server/orders` | 13, 14 | `order-payment` |
| IndexedDB, sync queue, idempotency, menu version | `lib/pos` | 4, 5, 6 | `offline-sync` |
| Who may do what, PIN approval, 403s | `lib/server/permissions` | 7, 8, 9, 14 | `permissions-approvals` |
| Receipts, kitchen tickets, drawer kick | `lib/pos` print-agent client | 11 | `pos-printing` |
| Reports, end-of-day, trial balance | `routes/(dashboard)` | 10, 26, 27 | `reporting` |
