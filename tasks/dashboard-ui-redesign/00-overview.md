# Dashboard UI redesign and the missing dashboard design system

**Goal.** Make the six screens that already exist look like a product instead of unstyled markup, and
fix the reason they came out unstyled: `docs/design-system.md` is a POS document that never defines
what a dashboard page looks like. This plan writes that grammar, actually loads the three typefaces
the design system has always named but never delivered, builds a small primitives layer so the
grammar is implemented once rather than retyped per page, restyles the six screens onto it, and adds
the light/dark/system theme control the tokens have always supported but nothing ever switched.

**This plan writes no money code, no journal entry, no stock movement, no migration, no database
column, no server route and no permission key.** It is design system, CSS and Svelte components only.

## Requirements (as agreed with the user, 2026-09-14)

The user's words: *"i almost implement this but this has a bad UI, please review the design system and
generate new task for the UI, review this branch to get the latest updates: feat/restaurant-identity-
and-dashboard"*. Four decisions were put to them before this plan was written, and answered:

1. **Scope — the dashboard and auth surfaces ONLY.** `/`, `/login`, `/register`, the `(dashboard)`
   shell, `/dashboard`, `/settings`. The `(pos)` route group keeps its current comment-only shell.
   No POS chrome, no touch-target screens, no POS components. Reason accepted: no POS screen exists
   yet, and spec 33 open decision 1 (one shared device, or a second registered terminal later) sets
   the POS target resolution, so POS visual work now would be redone.
2. **Fonts — self-hosted, pinned `@fontsource` packages** bundled by Vite and served from matcami's
   own origin. Explicitly REJECTED by the user: a Google Fonts `<link>` (a third-party origin in the
   critical path of a till, and it fails with no network), and dropping the typefaces for a system
   stack.
3. **Structure — a primitives layer AND an element base layer.** `src/lib/components/ui/` is created,
   and `CLAUDE.md`'s "Where code lives" module layout gains a components entry. That layout currently
   lists no components folder, so this is a house-convention extension, made deliberately.
4. **Theme toggle — in scope.** Light / dark / system, persisted in a cookie so the server can stamp
   `data-theme` on `<html>` during SSR and the page never flashes the wrong theme. NOT `localStorage`.

**Deliberately excluded by the user, and not to be "helpfully" added:**

- The favicon stays as it is. `src/lib/assets/favicon.svg` is still literally the Svelte logo (it
  contains `<title>svelte-logo</title>`). No wordmark, no brand mark. Do not replace it.
- The palette is NOT re-tuned. `--c-accent` stays `#0f6b7e`. No task may change a colour VALUE in
  `src/lib/styles/tokens.css`. See Risk 2 — the AA failures found here are fixed by rules about which
  token may sit on which surface, never by editing a hex value.
- Three of the four false claims in `docs/design-system.md` stay unfixed and are recorded as an open
  item below. Only the `:focus-visible` claim becomes true, because a primitives layer without a
  visible focus state is an accessibility regression this plan would itself be causing.

## Scope

**IN** — the dashboard layout grammar as a new section of `docs/design-system.md` · dashboard scale
tokens (radius, elevation, focus ring, control border, container width) in `tokens.css` · three
self-hosted font families · an element base layer (`:focus-visible`, `prefers-reduced-motion`,
`text-wrap: balance`, control defaults) · six primitives in `src/lib/components/ui/` · the six
existing screens restyled onto them · a cookie-backed light/dark/system theme with an SSR stamp ·
node-side tests for token completeness, contrast in both themes, arbitrary-value discipline, font
delivery and the component import boundary · an extension to the existing Playwright journey ·
`CLAUDE.md`'s module layout.

**OUT** — everything on `CLAUDE.md`'s "Do NOT build" list · the entire `(pos)` surface, POS chrome,
touch-target screens and POS components · any money rendering, money formatter or money component
(`src/lib/server/money/` is a README only) · any new route, `+server.ts`, `+page.server.ts`, form
action, permission key or `PUBLIC_ROUTE_IDS` entry · any schema, column, migration or seed row · the
favicon, a wordmark and any brand mark · re-tuning any colour value · a component test harness
(`jsdom`, `@testing-library/svelte`, Vitest browser mode) · the seven nav destinations that render as
"coming soon" (Employees, Menu, Inventory, Purchases, Expenses, Reports, Devices) — this plan restyles
those entries, it does not build their pages.

## Approach

**Chosen: design-system-first.** T-01 writes the dashboard grammar into `docs/design-system.md`
before any token or component exists; T-02 adds the tokens that grammar names; T-06 implements the
element defaults; T-07..T-12 implement the components the grammar describes; T-13..T-17 consume them.

The reason is the diagnosis, not taste. The current screens are correct and unstyled *by plan*:
`tasks/restaurant-identity-and-dashboard/05-dashboard.md` line 81 instructed "Write no snapshot test
of the markup", and `docs/design-system.md` gives the dashboard exactly one row of guidance ("Tailwind
default scale, seated, mouse-driven") against seven full sections about the POS. Seven further
dashboard sections are already stubbed in the navigation, and each will be built by a fresh session
reading that document. Restyling only the pixels buys six screens; writing the grammar and
implementing it buys thirteen.

**Rejected — bottom-up (tokens, then components, then screens, doc last or never).** Marginally
fewer tasks. It leaves the document still silent about the dashboard, so the next plan regenerates
exactly the UI this one is fixing.

**Rejected — adopt shadcn-svelte / bits-ui / Skeleton.** Fastest route to a polished look, and wrong
here for three reasons. It copies in components carrying their own CSS-variable naming, which creates
a second source of colour and size truth in direct conflict with CLAUDE.md's "tokens.css is the ONLY
place a colour, size or type value is defined". Its densities target a seated desktop, so the POS's
56-96px targets would still need a separate system — two design systems in one product. And the
library's conventions quietly become the real contract in place of `docs/design-system.md`, which is
the document this plan exists to repair.

## Risks that survived adversarial verification

A five-lens risk panel (accounting, data model, offline/sync, permissions, ops/migration) with
independent adversarial refutation returned **22 findings and zero survivors** — a plausible result
for a feature that touches no money, no ledger, no schema and no offline path, and the refutations
were evidenced at file and line level. The risks below come from the workspace investigation and from
direct measurement, in areas those five lenses do not cover.

- **HIGH — the Playwright journey is a tripwire laid across exactly the six screens being restyled.**
  `e2e/auth.spec.ts` pins seven field labels, four button names, four heading texts, the restaurant
  name's *heading role*, `role="alert"` carrying `Settings saved.`, and `getByText('not started',
  { exact: true })` at **count exactly 5**. `e2e/smoke.spec.ts` pins `h1` = `matcami` on `/`. The
  damage is not a red build; it is the repair — a session that breaks this "fixes" it by loosening
  the assertions, silently deleting the accessibility contract they encode. **Mitigation:** every
  screen task declares the accessible surface FROZEN and lists the exact strings and roles it must
  preserve; restyling changes classes and wrapper elements only. No task in this plan may edit
  `e2e/auth.spec.ts` or `e2e/smoke.spec.ts` except T-20, and T-20 only ADDS assertions.

- **HIGH — twelve pre-existing WCAG AA failures, measured, including pairs the current UI uses today.**
  Computed per WCAG relative luminance from the hex values in `tokens.css` (full table in
  `RESEARCH.md`). In LIGHT, `--c-ink-3` `#646f7a` fails on six surfaces: `--c-bg` **4.35:1**, `--c-bg-2`
  **4.03:1**, and the four tinted grounds `--c-accent-soft` / `--c-ok-bg` / `--c-warn-bg` /
  `--c-danger-bg` (**4.23 – 4.38:1**). The `bg` case is the dashboard navigation's "coming soon"
  labels today. In DARK, six more fail — `--c-danger` (**4.06:1**), `--c-ok` (**4.18:1**) and
  `--c-ink-3` (**4.25:1**) on `--c-raise-2`, and the same three on `--c-accent-soft` (**4.19:1**,
  **4.31:1**, **4.39:1**). Separately, for non-text contrast (WCAG 1.4.11, 3:1), `--c-line` `#c5cfd6`
  is **1.58:1** on `--c-raise` — a form control whose only boundary is that border is effectively
  unbounded, which is a large part of why the current screens read as washed out.
  **Mitigation, and it changes no colour value:** T-01's grammar states which ink is legal on which
  surface, choosing rules that hold in BOTH themes so a developer never has to reason per theme —
  `text-ink-3` only on `bg-raise` (5.13:1 light, 4.87:1 dark); `text-ok` and `text-danger` never on
  `bg-raise-2` or `bg-accent-soft`; `text-ink-2` (6.38:1 on light `bg`) wherever `text-ink-3` would
  have sat on the page ground. Interactive controls get a `--c-ink-3` border (5.13:1 light, 4.87:1
  dark, both above 3:1) while `--c-line` stays for decorative edges. T-03's test then enforces the
  legal pairs, asserting ONLY combinations that pass in both themes. **No task may fix a failing pair
  by editing a hex value** — the user deferred palette work, and re-tuning it is their decision, not
  this plan's.

- **MED — the refutation of four panel findings depends on a choice only this plan can record.**
  Findings about a theme-write route colliding with deny-by-default, coining an `admin.*` key, adding
  a `PUBLIC_ROUTE_IDS` entry, and `cookies.set`'s HttpOnly default were all refuted with "the plan
  will not do that". That is only true if the plan says so, and a session's instinct for "persist a
  preference" is a `+server.ts`. **Mitigation:** T-18 states as a hard constraint that the theme
  cookie is written by client JavaScript via `document.cookie` and only READ on the server inside
  `handle`. No route, no form action, no public-route entry, no permission key, no CSRF surface.

- **MED — nothing in this repository verifies design-system compliance, which is exactly how three
  typefaces stayed missing for the project's entire life** while `pnpm check`, `pnpm lint`,
  `pnpm test` and both e2e specs stayed green (verified green at plan time: 772 files, 0 errors, 0
  warnings; prettier and eslint clean). Ship a prettier UI without closing that hole and the next
  regression is equally invisible. **Mitigation:** T-03 and T-05 add node-project tests that read
  `tokens.css`, `app.css` and `package.json` as text — no browser harness is added.

- **LOW — `src/lib/components/ui/` sits outside the eslint boundary in `eslint.config.js`,** which
  scopes its `no-restricted-imports` rule to `src/lib/pos/**` and `src/routes/(pos)/**` by importing
  file. That rule is syntactic and per-file, so it would not catch a POS route importing a shared
  component that itself imports `$lib/server`. Speculative today — these components are dashboard-only
  and the POS has no pages — but the fix costs one rule. **Mitigation:** T-12 states the convention
  (a `ui/` primitive takes data as props and imports nothing from `$lib/server`) and adds a test that
  enforces it.

- *Refuted and dropped, one line each (22 findings, all killed with file-level evidence):* money
  formatting migrating into `ui/` · placeholder money figures invented by the restyle · the dashboard
  grammar omitting the money-cell rule · `--c-danger` on `--c-raise-2` in dark *as a money colour*
  (the ratio is real and is carried above as a pairing rule; the money framing was refuted because no
  money renders here) · font subsets vs open decision 4's currency symbol · theme stored as a
  `restaurant_settings` column · checklist steps derived from tables that do not exist · new tokens
  landing in plain `@theme` instead of `@theme inline` · `StatusMark` coining spec 13's status
  vocabulary before any status column exists · the theme cookie inheriting the session cookie's
  lifetime · `components/**` outside every boundary guard · self-hosted fonts 404-ing in production
  undetected · a GET-driven theme control repeating the `/logout` state-changing-GET bug · a theme
  route colliding with deny-by-default (two framings) · `cookies.set`'s HttpOnly default pushing
  toward the `localStorage` the user rejected · a second `role="alert"` appearing on `/settings`.

## Assumptions (decisions this plan rides on)

1. **No spec 33 open decision is engaged.** Decision 1 is touched only indirectly — it sets the POS
   target resolution, which is why the POS surface is out of scope. Nothing here answers any of the
   seven.
2. **The theme control lives in the dashboard header only.** `/login` and `/register` follow the OS
   preference. Reversing this is adding one component to two pages; no task hardcodes an assumption
   that prevents it.
3. **The theme cookie is `matcami_theme`, values `light` or `dark`, absent meaning system.**
   `SameSite=Lax`, `path=/`, `Secure` only on HTTPS, `max-age` one year. It carries no user data, it
   is never read for authorisation, and it is not a session cookie — invariant 12 governs
   `matcami_dashboard_session`, which this plan does not touch.
4. **The focus ring is derived from the existing `--c-accent`**, not a new hue, so the palette the
   user deferred stays untouched and no new colour needs contrast verification. Measured: 5.21:1 on
   light `--c-bg`, 7.49:1 on dark `--c-bg` — both well above the 3:1 that WCAG 1.4.11 asks of a
   focus indicator.
5. **OPEN, NOT RESOLVED — three false claims in `docs/design-system.md`.** Section 9 states
   `prefers-reduced-motion` "is honoured (already in `tokens.css`)" and it is not; section 4 states
   headings get `text-wrap: balance` and they do not; section 5's token table has a duplicated header
   row at lines 95-98 so it renders broken. The user was asked and chose not to include these. T-06
   implements `prefers-reduced-motion` and `text-wrap: balance` in the base layer *because the base
   layer needs them*, which makes two of the claims incidentally true — but **no task may reword or
   repair section 4, 5 or 9 of that document.** If a session finds the text still wrong, that is
   expected: report it, do not fix it.
6. **`@fontsource-variable/ibm-plex-mono` does not exist.** IBM Plex Mono has no official variable
   font. Mono comes from the static `@fontsource/ibm-plex-mono`; Archivo and IBM Plex Sans come from
   variable packages. Verified against the npm registry — see `RESEARCH.md`.

## In play

Spec: 7 (the owner signs in with email and password and enters the management dashboard), 26 (the
report list the navigation anticipates), 33 (open decisions — none answered here). The specification
says essentially nothing about visual design; grepping it for logo, brand, theme, font, typography,
colour, responsive, resolution and icon returns only unrelated matter. Visual design is governed by
`CLAUDE.md`'s "Design & UI" section and by `docs/design-system.md`.

Invariants: 8 (permissions are enforced server-side on every route, reads included — engaged by
avoidance: this plan adds no route, and `src/routes/route-guards.test.ts` walks the route tree for
exactly that), 12 (POS access, session cookies are HttpOnly/Secure/SameSite and never `localStorage`,
and SvelteKit's origin/CSRF check stays ON — engaged because the theme cookie sits beside the session
cookie and must not be confused with it). Plus the whole of CLAUDE.md's "Design & UI" section:
`tokens.css` is the only place a colour, size or type value is defined; colour never carries meaning
alone; money renders only through the money module's formatter; the POS shell stays dark in both
themes; WCAG AA 4.5:1 in both themes.

## Workspace state at plan time (Phase 1, 2026-09-14)

Branch `feat/restaurant-identity-and-dashboard`, clean tree, level with origin, seven commits ahead of
`main`. `pnpm check` and `pnpm lint` both exit 0.

**Present and opened during the investigation** — `src/app.css` (three lines: `@import 'tailwindcss'`
then `@import './lib/styles/tokens.css'`), `src/app.html`, `src/lib/styles/tokens.css` (156 lines),
`src/routes/+layout.svelte`, `src/routes/+page.svelte`, `src/routes/login/+page.svelte`,
`src/routes/register/+page.svelte`, `src/routes/(dashboard)/+layout.svelte`,
`src/routes/(dashboard)/dashboard/+page.svelte`, `src/routes/(dashboard)/settings/+page.svelte`,
`src/routes/(pos)/+layout.svelte`, the three dashboard server load files, `src/hooks.server.ts`,
`src/lib/public-routes.ts`, `src/lib/server/permissions/keys.ts`, `eslint.config.js`, `package.json`,
`vitest.config.ts`, `playwright.config.ts`, `e2e/auth.spec.ts`, `e2e/smoke.spec.ts`,
`src/routes/route-guards.test.ts`, `docs/design-system.md`.

**Absent at plan time** — `src/lib/components/` in any form; any `@layer base`, `:focus-visible`
rule, `prefers-reduced-motion` block or `text-wrap` rule anywhere in `src/`; any font file,
`@font-face`, `@fontsource` dependency or font `<link>` (`static/` holds only `robots.txt`); any
`data-theme` stamping, theme cookie or theme control outside `tokens.css`'s own selectors; any
component test harness. `src/lib/server/{money,accounting,inventory,orders}` and `src/lib/pos/` each
contain a `README.md` and no code.

Every path in this plan is tagged in its task. `NEW` = absent at Phase 1 and created by that task.
`EXTEND` = absent at Phase 1 but created by an earlier task in this plan, which the tag names — add
to it, never rewrite it. `EDIT` = present at Phase 1, with a location hint. **Stop and report a
mismatch only** when a path tagged `NEW` already exists, or a path tagged `EXTEND`/`EDIT` does not.

## Task index

Every task in this plan, in dependency order. Phase files are in this directory.

| ID | Title | Phase file | Needs |
|---|---|---|---|
| T-01 | Write the dashboard layout grammar into `docs/design-system.md` | `01-design-system.md` | - |
| T-02 | Add the dashboard scale tokens to `tokens.css` | `01-design-system.md` | T-01 |
| T-03 | Lock the token contract and the contrast floor with node tests | `01-design-system.md` | T-02 |
| T-04 | Self-host Archivo, IBM Plex Sans and IBM Plex Mono | `02-foundation.md` | - |
| T-05 | Prove the typefaces actually ship | `02-foundation.md` | T-04 |
| T-06 | Add the element base layer | `02-foundation.md` | T-02, T-03, T-04 |
| T-07 | `Button.svelte` | `03-primitives.md` | T-02, T-06 |
| T-08 | `Field.svelte` | `03-primitives.md` | T-02, T-06 |
| T-09 | `Card.svelte` and `PageHeader.svelte` | `03-primitives.md` | T-02, T-06 |
| T-10 | `Alert.svelte` | `03-primitives.md` | T-02, T-06 |
| T-11 | `StatusMark.svelte` | `03-primitives.md` | T-02, T-06 |
| T-12 | The `ui/` barrel and its import-boundary guard | `03-primitives.md` | T-07, T-08, T-09, T-10, T-11 |
| T-13 | Restyle `/login` and `/register` | `04-screens.md` | T-12 |
| T-14 | Restyle the `(dashboard)` shell | `04-screens.md` | T-12, T-02 |
| T-15 | Restyle the `/dashboard` onboarding checklist | `04-screens.md` | T-12, T-14 |
| T-16 | Restyle `/settings` | `04-screens.md` | T-12, T-14 |
| T-17 | Restyle the landing page | `04-screens.md` | T-12 |
| T-18 | The theme cookie and the server-side `data-theme` stamp | `05-theme.md` | T-02 |
| T-19 | The `ThemeToggle` control in the dashboard header | `05-theme.md` | T-18, T-14 |
| T-20 | Extend the end-to-end journey | `06-verification.md` | T-13..T-19 |
| T-21 | Record the components layer in `CLAUDE.md` | `06-verification.md` | T-12 |

**Start at T-01.** T-04 has no dependencies and may run in parallel with T-01..T-03 if desired.

## Phase order and why it deviates from the standard table

`references/task-format.md` §4's standard phases are scaffolding, schema, domain, API, UI, tests.
**This plan has no scaffolding, schema, domain or API phase**, because it adds no table, no column,
no migration, no server module and no route — the repository is already scaffolded and this feature
is design system plus UI. Unit tests are not deferred: T-03 ships with T-02's tokens, T-05 with
T-04's fonts, T-12's boundary test with the components. `06-verification.md` carries only the
end-to-end journey, which genuinely spans every screen, and the documentation record.
