# Phase 4 — The six screens

This phase spends the design system. Every screen that exists today — `/login`, `/register`, the
`(dashboard)` shell, `/dashboard`, `/settings` and the landing page — is rebuilt on the primitives
from Phase 3 and the tokens from Phase 1, so that the grammar is applied once per screen instead of
re-typed per element. It also lands the one contrast repair this plan makes: the dashboard
navigation's disabled entries move off an ink that measures **4.35:1** on the page ground. Nothing in
this phase changes behaviour, data or the accessible surface.

**Depends on:** Phase 3 — specifically **T-12** (`src/lib/components/ui/index.ts`, the barrel, plus
every primitive it re-exports: `Button`, `Field`, `Card`, `PageHeader`, `Alert`, `StatusMark`).
T-14 additionally depends on T-02's `max-w-page` container token from Phase 1.

**Read `00-overview.md` in this directory first.** It carries the goal, the requirements as agreed
with the user, the scope boundaries, the surviving risks, the assumptions this plan rides on, the
complete task index, and the `NEW` / `EXTEND` / `EDIT` tag convention every `Files:` list below uses.
None of that is repeated here.

---

## Shared context — read this before touching any screen in T-13…T-17

These five tasks **restyle screens that already exist and already work.** They change classes,
wrapper elements and which component renders a control. They do **not** change behaviour, data, load
functions, form actions or validation, and they do **not** change the accessible surface.

**THE ACCESSIBLE SURFACE IS FROZEN.** `e2e/auth.spec.ts` is one long ordered journey that pins the
exact text and roles listed under each task's *FROZEN* heading, and `e2e/smoke.spec.ts` pins the
landing page's `h1`. If a restyle breaks one of these, **the fix is the restyle, never the
assertion.** No task in this phase may edit, weaken or delete anything in `e2e/`. Those assertions
encode the accessibility contract — heading roles, label text, the alert role — and loosening them
silently deletes it.

**Keep the explanatory comments already at the top of each screen file.** They record why the
`(dashboard)` group is online-only, why sign-out is a form and not a link, why no money is displayed,
and why certain settings fields deliberately do not exist. Those comments are load-bearing context
for later plans — preserve them, and add to them rather than replacing them. Some of those comments
cite task IDs (`T-05`, `T-09`) from the **earlier** plan
`tasks/restaurant-identity-and-dashboard/`; they are not IDs from this plan and must not be
renumbered.

**Every screen must end with** no arbitrary Tailwind value (`bg-[#123456]`, `p-[57px]`) and no raw
hex — tokens only — and must not use the POS touch scale (`p-touch`, `touch-min`, `touch-lg`,
`touch-xl`) or the POS chrome tokens (`bg-screen`, `bg-key`, `text-key-ink`, `border-key-line`).
`docs/design-system.md` section 5 reserves the touch scale for the POS surface and says the dashboard
"uses Tailwind's default spacing; it is seated, mouse-driven work". Import every primitive from
`$lib/components/ui`.

**Run `pnpm check && pnpm lint` after each task**, and run `pnpm test:e2e` at the end of the phase.
`pnpm test:e2e` and `pnpm test:integration` share the `matcami_test` database and **must not run at
the same time**.

---

### T-13 — Restyle `/login` and `/register` onto the primitives

**Needs:** T-12 (the `$lib/components/ui` barrel and the primitives it exports)
**Files:**
- `src/routes/login/+page.svelte` — EDIT (the whole markup below the existing `<script lang="ts">`
  block; the script and the `<svelte:head>` title are not touched)
- `src/routes/register/+page.svelte` — EDIT (likewise — the whole markup below the existing
  `<script lang="ts">` block)

**Spec:** 7 (POS Authentication — "Owner/Admin uses Email, Password and enters the management
dashboard"; this task restyles that sign-in and changes nothing about how it works). **The
specification does not govern visual design at all** — grepping `docs/spec.md` for logo, brand,
theme, font, typography, colour and responsive returns only unrelated matter. The rules this task
obeys come from `CLAUDE.md`'s "Design & UI" section and `docs/design-system.md`.

**Invariants:** 8 (permissions are enforced server-side on every POS API route, reads included) —
engaged by **avoidance**: this task adds no route, no `+server.ts` and no form action, and does not
edit `+page.server.ts`. 12 (POS access = registered device + PIN; sessions are HttpOnly + Secure +
SameSite cookies, never `localStorage`, and SvelteKit's origin/CSRF check stays ON) — also engaged by
avoidance: nothing here reads, writes or renders a cookie, and `use:enhance` keeps posting to the
same form action through the same origin check. The binding rules are `CLAUDE.md` "Design & UI":
`src/lib/styles/tokens.css` is the only place a colour, size or type value is defined, and WCAG AA
4.5:1 at normal text size in both themes.

**Do:**
1. Check that `src/lib/components/ui/index.ts` exists and exports `Button`, `Card`, `PageHeader`,
   `Field` and `Alert`. If it is absent, **stop and report** — T-12 has not run and the repository is
   not in the state this plan assumes. Then read both page files end to end before editing either.
2. Leave each file's `<script lang="ts">` block and `<svelte:head>` title exactly as they are, except
   for adding `import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';`. That
   means `use:enhance` and the `submitting = $state(false)` pattern stay byte for byte, including the
   button text expressions `{submitting ? 'Signing in…' : 'Sign in'}` on `/login` and
   `{submitting ? 'Creating…' : 'Create restaurant'}` on `/register` (the character after the verb is
   a single horizontal ellipsis `…`, not three periods), login's
   `const next = $derived(page.url.searchParams.get('next') ?? '')`, and register's
   `const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone` with the comment above
   it explaining why the server still validates by construction.
3. Page frame: both pages are **centred single-card pages on the `bg-bg` ground.** Keep the
   full-height centred `<main>` (today `flex min-h-screen items-center justify-center` plus padding)
   and **delete the `bg-bg text-ink` classes from it** — T-06's base layer now sets the page ground
   and ink on `body`, so repeating them here is dead weight. Verify by eye at `pnpm dev` that the
   card is still vertically and horizontally centred on a full-height ground afterwards. Render the
   card with T-09's `Card`, keeping the current widths: `max-w-sm` on `/login`, `max-w-lg` on
   `/register`.
4. Heading: render the title and its sub-line with T-09's `PageHeader`, **passing the heading level
   explicitly**. `PageHeader` defaults to `level` 2 (T-09), so omitting it silently demotes
   `/login`'s `<h1>Sign in</h1>` and `/register`'s `<h1>Set up your restaurant</h1>` to `h2`, leaving
   both pages with no `h1` at all. `/login` renders
   `<PageHeader level={1} title="Sign in" description="Management dashboard" />`; `/register` renders
   `<PageHeader level={1} title="Set up your restaurant" … />`, its sub-line being
   `This creates the restaurant and its owner account. It can only be done once.` These two pages sit
   OUTSIDE the `(dashboard)` group and carry their own `h1`, unlike `/dashboard` and `/settings`,
   where the `(dashboard)` layout already provides the `h1` and the page heading is correctly an
   `h2`. The title must remain a real heading element.
5. Error region: replace each `{#if form?.message}` paragraph with T-10's `Alert`, which must render
   `role="alert"`. Keep the comment above login's alert explaining that `role="alert"` is there so a
   screen reader announces the failure without the user having to go looking for it. Login's alert
   also keeps its throttle sentence inside the same region:
   `{#if form.retryAfterMs}Try again in {Math.ceil(form.retryAfterMs / 1000)} seconds.{/if}`.
6. Fields: replace every hand-built `<div><label …><input …></div>` with T-08's `Field`, carrying the
   attributes across unchanged — `id`, `name`, `type`, `autocomplete`, `required`, `minlength`,
   `list`, and the value expressions (`value={form?.email ?? ''}`,
   `value={form?.restaurantName ?? ''}`, `value={form?.ownerDisplayName ?? ''}`,
   `value={form?.timeZone || browserTimeZone}`). `/login` has two fields — `email` and `password`.
   `/register` has seven, in this order: `restaurantName`, `timeZone`, `ownerDisplayName`, `email`,
   `password`, `passwordConfirm`, `setupToken`.
7. Login keeps `<input type="hidden" name="next" value={next} />` as the first child of the `<form>`.
   It carries the hook's `?next=` through the POST; losing it means a redirected owner lands on
   `/dashboard` instead of where they were going.
8. Register keeps four things verbatim: the `<datalist id="time-zones">` fed by
   `{#each data.timeZones as tz (tz)}` together with the comment saying it is a datalist and not a
   `<select>` because the owner must be able to type a zone the suggestion list omits; the hint
   `At least 8 characters.` beside the password field, whose input keeps `minlength="8"`; the
   setup-token explanation `The one-time value from the server's <code>SETUP_TOKEN</code> environment
   variable. It is required only for the first restaurant, and should be unset afterwards.`; and the
   time-zone explanation that exists today in `src/routes/register/+page.svelte`, `This decides which
   business day a sale belongs to — a sale at 01:30 counts toward the previous evening. You can change
   it later.`, passed through `Field`'s `hint` prop so it stays associated with the input. That
   paragraph is the only place the registration screen explains why the field matters, and invariant
   11 (business date, not calendar date — a sale at 01:30 belongs to the previous evening) is the
   reason it is there; the same explanation on `/settings` is T-16's responsibility, not this task's.
   Render those hints through whatever hint or description slot `Field` exposes, so they stay
   associated with their input.
9. Submit: replace each hand-styled `<button class="bg-accent …">` with T-07's `Button` in its
   primary variant, keeping `type="submit"` and `disabled={submitting}`. Then sweep both files for
   leftover literals — no `bg-[#…]`, no `p-[…px]`, no raw hex, no `p-touch`.

**FROZEN — must still match exactly after the restyle:**

| Page | What is pinned | Where |
|---|---|---|
| `/login` | labels `Email` and `Password`; button `Sign in` | `e2e/auth.spec.ts` steps 9 |
| `/login` | heading `Sign in`; the error region is `role="alert"` | design-system requirement — NOT covered by the journey; verify by reading the rendered markup |
| `/register` | heading `Set up your restaurant`; labels `Restaurant name`, `Time zone`, `Your name`, `Email`, `Password`, `Confirm password`, `Setup token`; button `Create restaurant` | `e2e/auth.spec.ts` steps 1–2 |
| `/register` | the error region is `role="alert"` | design-system requirement — NOT covered by the journey; verify by reading the rendered markup |

All four items stay frozen; only the attribution differs. `e2e/auth.spec.ts` contains no
`getByRole('heading', { name: 'Sign in' })`, and its only `getByRole('alert')` is on `/settings`, so
**`pnpm test:e2e` passing is not evidence that login's heading or either error region survived** —
read the rendered markup for those three.

Playwright matches the password label with `page.getByLabel('Password', { exact: true })`, so
`Confirm password` must remain a **separate, distinctly-named** label — an exact match must resolve
to exactly one field.

**Tests:** none added. The existing Playwright journey `e2e/auth.spec.ts` already drives both pages
and is the regression net for this task. **Do not edit it.** This is not one of spec 29's six
mandatory areas (money arithmetic and rounding; tax in both modes; journal entries balancing; one
posting rule per spec 24 event; offline sync retries never duplicating; a permission check per POS
API route) — nothing in this plan is.

**Done when:** `pnpm check && pnpm lint` exit 0; `pnpm test:e2e` passes unchanged;
`git diff e2e/` prints nothing; and
`grep -nE '\[#|\[[0-9]+px\]' src/routes/login/+page.svelte src/routes/register/+page.svelte` finds
nothing.

**Watch out:** both pages today declare `bg-bg text-ink` on their own `<main>`. T-06's base layer sets
the page ground on `body`, so those classes can go — but check the page still has its **full-height
centred layout** afterwards; deleting the whole class attribute takes the centring with it. Second
trap: `Field` must render a real `<label for="…">` bound to the input's `id`. Playwright's
`getByLabel` resolves the accessible name, so a `Field` that renders a bare `<span>` caption compiles,
looks right and fails every fill in the journey.

---

### T-14 — Restyle the `(dashboard)` shell

**Needs:** T-12 (the `$lib/components/ui` barrel), T-02 (the `max-w-page` container token)
**Files:**
- `src/routes/(dashboard)/+layout.svelte` — EDIT (the markup below the existing comment block and
  `<script lang="ts">`; the `nav` array and the comments inside the script stay as they are)

**Spec:** 7 (POS Authentication — the owner signs in with email and password "and enters the
management dashboard"; this is that dashboard's chrome), 26 (Reporting — the report list the
navigation's disabled `Reports` entry anticipates; this task styles the entry, it does not build the
page). **Visual design is not specified anywhere in `docs/spec.md`**; `CLAUDE.md`'s "Design & UI"
section and `docs/design-system.md` govern it.

**Invariants:** 8 (permissions are enforced server-side on every POS API route, reads included) —
engaged **directly, by preservation**: the comment at the top of this file records that permissions
are enforced server-side and that hiding a button in this layout is not security, and this task must
keep it. The task itself adds no route and changes no check. 12 (sessions are HttpOnly + Secure +
SameSite cookies, never `localStorage`) — engaged by avoidance, and by keeping sign-out a POST.
Binding design rules: `CLAUDE.md` "Design & UI" — tokens only, and **WCAG AA 4.5:1 at normal text
size in both themes**, which is what step 6 below repairs.

**Do:**
1. Check that `src/lib/components/ui/index.ts` exists; if it is absent, **stop and report** — T-12
   has not run. Read the whole layout file before editing.
2. Keep the comment block at the very top of the `<script>` verbatim: `(dashboard)` is the
   owner/admin surface, it is **ONLINE ONLY**, server `load` functions and `$lib/server` imports are
   fine here, and permissions are still enforced server-side on every route because hiding a button
   is not security (invariant 8). Keep the comment above the `nav` array explaining why seven entries
   render as visibly disabled rather than as dead links or hidden items.
3. Header: restyle the bar carrying the restaurant name (`{data.restaurantName ?? 'matcami'}`), the
   signed-in person's display name (`{data.displayName}`) and the sign-out control. Give the header a
   **`border-line` bottom edge** (`border-b border-line`) so it reads as chrome separated from the
   content, and keep it wrapping gracefully at narrow widths.
4. Leave a sensible place in the header for a theme control. **T-19 adds `ThemeToggle` to this
   header** — a stable container beside the display name is enough; do not import or render a theme
   control in this task, and do not add a placeholder element.
5. Navigation: render the nine entries from the existing `nav` array, in the order an owner sets the
   restaurant up — **Overview, Settings, Employees, Menu, Inventory, Purchases, Expenses, Reports,
   Devices**. Do not retype or reorder the array. `Overview` (`/dashboard`) and `Settings`
   (`/settings`) link, through
   `resolve(item.href as '/dashboard' | '/settings')`; the other seven stay visibly disabled with
   their `coming soon` label.
6. **A contrast fix that changes no colour value.** The disabled navigation entries and their
   `coming soon` labels currently use `text-ink-3`, and they sit on the `bg-bg` page ground where
   that token measures **4.35:1** — below the 4.5:1 floor `CLAUDE.md` calls non-negotiable. Fix it by
   changing **which token is used**, never the token's value. Two legal repairs, pick one:
   - put the navigation on a `bg-raise` panel, where `text-ink-3` is legal at **5.13:1**; or
   - keep it on the `bg-bg` ground and use **`text-ink-2`** (**6.38:1** on `bg-bg`).

   **State which you chose in a comment** beside the change, with the ratio, so the next reader does
   not "tidy" it back. Do not edit `src/lib/styles/tokens.css` in this task — the user deferred
   palette work, and re-tuning a hex value is their decision, not this plan's.
7. Content region: wrap `{@render children()}` in the **`max-w-page`** container token added by T-02,
   so page content stops at a readable measure instead of stretching across a wide monitor.
8. Responsive: keep the navigation collapsing **above** the content below Tailwind's `md` breakpoint
   and sitting beside it at `md` and up (today `flex flex-col gap-6 p-4 md:flex-row` with
   `md:w-56 md:shrink-0` on the `<nav>`). Keep the comment saying the owner may open this on a phone
   and nothing here should scroll horizontally. Check it at **360px** wide in a browser.
9. Sweep the file for literals — no arbitrary values, no raw hex, no POS touch or chrome tokens.

**FROZEN — must still match exactly after the restyle:**
- The restaurant name renders inside a **real heading element** (it is currently an `h1`).
  `e2e/auth.spec.ts` asserts `page.getByRole('heading', { name: <the restaurant name> })` twice — at
  step 3 after registration, and at step 6 after the rename — so a `<div class="text-lg font-bold">`
  breaks the journey even though it looks identical.
- The sign-out control is a **`<button>` with the accessible name `Sign out`** inside a
  `<form method="POST" action="/logout">`. **NEVER an anchor.** `/logout` refuses `GET` (it returns
  405, asserted at step 10 of the journey) and a link would be triggerable by any image tag on any
  page. Keep the comment that says so.
- Disabled entries keep `aria-disabled="true"` and **no link target**, so a keyboard user does not tab
  into a control that does nothing, and keep their `coming soon` label.
- The current page keeps `aria-current={page.url.pathname === item.href ? 'page' : undefined}`.

**Tests:** none added. `e2e/auth.spec.ts` exercises this shell on every step of the journey and is the
regression net. **Do not edit it.** Not one of spec 29's six mandatory areas.

**Done when:** `pnpm check && pnpm lint` exit 0; `pnpm test:e2e` passes unchanged; `git diff e2e/`
prints nothing; the navigation collapses above the content below Tailwind's `md` breakpoint with **no
horizontal scrolling at 360px wide**; and
`grep -n 'text-ink-3' src/routes/\(dashboard\)/+layout.svelte` returns nothing — unless the element it
finds sits on a `bg-raise` surface, which the comment from step 6 must say.

**Watch out:** the comment block at the top of the file is not decoration. It is the only place
recording that this route group is online-only and that `$lib/server` imports are legal here but are
not a substitute for the server-side permission check — a later session restyling a POS screen reads
it to learn the opposite rule applies there. Preserve it, and add to it rather than replacing it.

---

### T-15 — Restyle the `/dashboard` onboarding checklist

**Needs:** T-12 (the `$lib/components/ui` barrel), T-14 (the restyled shell this page renders inside)
**Files:**
- `src/routes/(dashboard)/dashboard/+page.svelte` — EDIT (the markup below the existing
  `<script lang="ts">`; the `steps = $derived([…])` array, its comment and the `<svelte:head>` title
  stay as they are)

**Spec:** none that governs this. `docs/spec.md` describes the owner's dashboard as a destination
(section 7) but specifies nothing about an onboarding checklist or its appearance. `CLAUDE.md`'s
"Design & UI" section and `docs/design-system.md` are the governing documents.

**Invariants:** 8 (permissions are enforced server-side on every POS API route, reads included) —
engaged by avoidance: no route, no load function and no permission check is touched. The binding
rules here are `CLAUDE.md` "Design & UI": **colour never carries meaning alone — pair every status
with its glyph** (WCAG 1.4.1; roughly one man in twelve has red-green colour-vision deficiency), and
**money renders only through the money module's formatter**, which is why this page shows no money at
all (see step 8).

**Do:**
1. Check that `src/lib/components/ui/index.ts` exists and exports `Card`, `PageHeader` and
   `StatusMark`; if it is absent, **stop and report** — T-12 has not run. Read the whole page file
   before editing.
2. Leave the `<script lang="ts">` block untouched apart from adding
   `import { Card, PageHeader, StatusMark } from '$lib/components/ui';`. The `steps` array, its
   `$derived` wrapper and the comment above it explaining that only the first step is computable and
   that progress is not faked all stay byte for byte.
3. Heading: render `Getting set up` and its sub-line
   `Work down this list in order. Finish the settings, then add your employees, then build the menu.`
   through T-09's `PageHeader`. `Getting set up` must remain a **real heading element**, and it should
   stay an `h2`: the layout's `h1` is the restaurant name, and promoting this to a second `h1` breaks
   the document outline. If `PageHeader` renders an `h1` by default, pass whatever heading-level prop
   T-09 gave it; if it exposes none, keep the `<h2>` and use `PageHeader` for the sub-line only —
   **do not change `PageHeader` from this task.**
4. Keep the six steps, their order, their labels and their detail lines exactly as the `steps` array
   produces them: `Restaurant settings`, `Employees and PINs`, `Menu, categories and modifiers`,
   `Dining tables`, `Register the POS device`, `Open the first POS session`.
5. Render the list with T-09's `Card` — one card per step, or one card containing the rows; keep the
   `<ol>` so the sequence is exposed as an ordered list.
6. Replace the hand-written glyph `<span>` with T-11's `StatusMark`, which must keep **both** the
   glyph and the colour: `●` for a done step, `○` for one not started, `aria-hidden="true"` on the
   glyph itself, in `font-mono`. Colour never carries meaning alone. Keep the comment that says so.
7. Only the first step has a computed state (`data.settings.complete`) and a link. Render its
   `Open settings` link through `resolve(step.href as '/settings')` as it is now. **Do not fake
   progress on the other five and do not link to a route that does not exist** — the other seven
   dashboard destinations are not built, and a 404 from an onboarding checklist is worse than a
   disabled row.
8. Keep the standing comment at the bottom of the file: **NO MONEY FIGURES AT ALL** — not revenue,
   not today's takings, not a zero. `src/lib/server/money/` is still a README with no code, the UI
   never does money arithmetic, and a zero on a dashboard is indistinguishable from a broken query.
   **Do not add a stat tile, a metric row, a sparkline or a chart.**
9. Sweep the file for literals — no arbitrary values, no raw hex, no POS touch or chrome tokens.

**FROZEN — and this is the most fragile assertion in the suite.** The screen-reader text on each step
is exactly `' — done'` or `' — not started'` — **with a leading space and an EM DASH (U+2014)** — and
the visible badge on an incomplete step is exactly `not started`. `e2e/auth.spec.ts` line 63 asserts:

```ts
await expect(page.getByText('not started', { exact: true })).toHaveCount(5);
```

That passes **only because** the em-dashed screen-reader string does not exact-match, so the five
visible badges are counted and the six screen-reader strings are not. Reproduce both strings byte for
byte from the current file:

```svelte
<span class="sr-only">{step.done ? ' — done' : ' — not started'}</span>
{#if !step.done}<span class="…">not started</span>{/if}
```

Keep **exactly five** incomplete steps, and **do not add a sixth `not started` anywhere on the page** —
not in a legend, not in a tooltip, not in a `StatusMark` label prop. Also frozen: the heading
`Getting set up` as a real heading, the visible text `Restaurant settings`, and the `Open settings`
link on the first step.

**Tests:** none added. `e2e/auth.spec.ts` step 3 is the regression net. **Do not edit it.** Not one of
spec 29's six mandatory areas.

**Done when:** `pnpm check && pnpm lint` exit 0; `pnpm test:e2e` passes unchanged; `git diff e2e/`
prints nothing; and both of these match **at least once** —
`grep -cF "' — not started'" src/routes/(dashboard)/dashboard/+page.svelte` for the screen-reader
string (leading space, EM DASH U+2014) and
`grep -cF '>not started<' src/routes/(dashboard)/dashboard/+page.svelte` for the visible badge —
while `grep -o 'not started' src/routes/(dashboard)/dashboard/+page.svelte | wc -l` equals **3**:
the screen-reader string, the visible badge, and one occurrence inside the explanatory comment above
the `steps` array that step 2 of this task freezes byte for byte. Three is the count today and three
is the count afterwards — a result of 2 means something that must have been kept was deleted.

**Watch out:** `text-ink-3` is legal on the `bg-raise` card surface (**5.13:1**) and illegal on the
`bg-bg` page ground (**4.35:1**). If a step's detail line, its badge or its glyph moves out of a card
during the restyle, **change the ink token on that element, not the token's value** — `text-ink-2` is
**6.38:1** on `bg-bg`. Second trap: if `StatusMark` takes a visible text label as well as a glyph,
passing `not started` into it while the badge still renders makes the count 10 and the journey fails
with a message that points at Playwright rather than at this file.

---

### T-16 — Restyle `/settings`

**Needs:** T-12 (the `$lib/components/ui` barrel), T-14 (the restyled shell this page renders inside)
**Files:**
- `src/routes/(dashboard)/settings/+page.svelte` — EDIT (the markup below the existing
  `<script lang="ts">`; the script, the `<svelte:head>` title and the `use:enhance` block stay as they
  are)

**Spec:** 17 (Money, Tax & Business Day Rules — "the restaurant's time zone is a setting", which is
the field this form edits and the reason its explanation must survive the restyle). The specification
does not govern the form's appearance; `CLAUDE.md`'s "Design & UI" section and
`docs/design-system.md` do.

**Invariants:** 11 (business date, not calendar date — a sale belongs to the business date of its POS
session; 01:30 belongs to the previous evening, and the restaurant's time zone is a setting) —
engaged by **preservation**: the explanatory copy under the time-zone field is the only place in the
UI that tells the owner what that setting decides, so it must survive verbatim. 8 (permissions are
enforced server-side on every POS API route, reads included) — engaged by avoidance: the form action
in `+page.server.ts` is not touched. 12 — engaged by avoidance.

**Do:**
1. Check that `src/lib/components/ui/index.ts` exists and exports `Alert`, `Button`, `Card`, `Field`
   and `PageHeader`; if it is absent, **stop and report** — T-12 has not run. Read the whole page file
   before editing.
2. Leave the `<script lang="ts">` block untouched apart from adding
   `import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';`. `use:enhance` and
   the `submitting = $state(false)` pattern stay exactly as written, including the button text
   `{submitting ? 'Saving…' : 'Save settings'}` (a single horizontal ellipsis `…`, not three periods).
3. Heading: render `Restaurant settings` through T-09's `PageHeader`. It must remain a **real heading
   element**, and it should stay an `h2` — the layout's `h1` is the restaurant name. If `PageHeader`
   renders an `h1` by default, pass T-09's heading-level prop; do not change `PageHeader` from here.
4. Result message: render the `{#if form?.message}` region through T-10's `Alert`, which must render
   `role="alert"`. The journey asserts the text it carries verbatim.
5. Form body: wrap the form in T-09's `Card` and replace both hand-built field groups with T-08's
   `Field`, carrying attributes across unchanged — `id="name" name="name" required value={data.name}`
   and `id="timeZone" name="timeZone" list="time-zones" required value={data.timeZone}`.
6. Keep the `<datalist id="time-zones">` fed by `{#each data.timeZones as tz (tz)}`, together with the
   comment saying it is free text with a datalist rather than a `<select>` because the owner must be
   able to enter a zone the suggestion list omits. Keep its explanation verbatim: *"This decides which
   business day a sale belongs to — a sale at 01:30 counts toward the previous evening. Changing it is
   allowed and is recorded with the old and new values; it does not rewrite anything already
   recorded."*
7. Keep the comment recording that there are deliberately **NO fields for tax mode, tax rate,
   currency, approval limits or idle-lock timing — not even disabled ones.** Spec 33 open decisions
   3 (local tax rules), 4 (payment methods and currencies) and 6 (approval limits and lock timing)
   are unresolved, and a greyed-out field showing a plausible default is how an unmade decision
   becomes a remembered fact. **Do not add any of them**, in any state.
8. Submit: replace the hand-styled `<button class="bg-accent …">` with T-07's `Button` in its primary
   variant, keeping `type="submit"` and `disabled={submitting}`. Then sweep the file for literals — no
   arbitrary values, no raw hex, no POS touch or chrome tokens.

**FROZEN — must still match exactly after the restyle:** heading `Restaurant settings`; labels
`Restaurant name` and `Time zone`; button `Save settings`; and the result message renders inside a
`role="alert"` region carrying `Settings saved.` verbatim. `e2e/auth.spec.ts` step 6 fills
`Restaurant name`, clicks `Save settings`, then asserts
`await expect(page.getByRole('alert')).toContainText('Settings saved.')` and that the new name appears
as a heading in the shell.

**Tests:** none added. `e2e/auth.spec.ts` step 6 is the regression net. **Do not edit it.** Not one of
spec 29's six mandatory areas.

**Done when:** `pnpm check && pnpm lint` exit 0; `pnpm test:e2e` passes unchanged; and
`git diff e2e/` prints nothing.

**Watch out:** **exactly ONE `role="alert"` may be visible at a time on this page.**
`e2e/auth.spec.ts` asserts against a single `page.getByRole('alert')` locator, and a second alert
region is a Playwright strict-mode violation that fails the run with "resolved to 2 elements" — not
with anything that looks like a styling problem. The form renders one message region today. Do not add
a validation summary beside it, and check that T-08's `Field` does not itself render a per-field error
with `role="alert"`; if it does, either leave the field-level error off on this page or give it
`role="status"` — **without changing `Field`**, which belongs to T-08.

---

### T-17 — Restyle the landing page

**Needs:** T-12 (the `$lib/components/ui` barrel)
**Files:**
- `src/routes/+page.svelte` — EDIT (the whole file; the comment block at the top stays)

**Spec:** none. `docs/spec.md` says nothing about a public landing page — this is a stub that exists so
`pnpm dev` serves something and the Playwright smoke test has a stable `h1` to assert on.
`CLAUDE.md`'s "Design & UI" section and `docs/design-system.md` govern its appearance.

**Invariants:** none directly — 8 (permissions are enforced server-side on every POS API route, reads
included) and 12 (sessions are HttpOnly + Secure + SameSite cookies, never `localStorage`) are both
engaged by **avoidance**: this page has no load function, no form action and no cookie, and this task
adds none. The rules it does engage are `CLAUDE.md` "Design & UI": tokens only, and the touch scale
belongs to the POS.

**Do:**
1. Check that `src/lib/components/ui/index.ts` exists and exports `Button`; if it is absent, **stop
   and report** — T-12 has not run.
2. Keep the comment block at the top of the file, including the line saying the `<h1>` text is
   asserted by `e2e/smoke.spec.ts` and must not change without changing that test. (Its `(T-09)` and
   `T-05` references belong to the earlier plan `tasks/restaurant-identity-and-dashboard/` — leave
   them alone.)
3. **Remove `p-touch` from the `<main>` element.** That is a POS touch token (**64px**) on a page that
   is not the POS, and `docs/design-system.md` section 5 reserves the touch scale for the POS surface,
   stating that the dashboard "uses Tailwind's default spacing; it is seated, mouse-driven work".
   Replace it with Tailwind's default spacing scale (`p-6`, `p-8` or similar).
4. Restyle the stub as a heading, one line of description
   (`Restaurant management and point of sale.`) and the two links, on the `bg-bg` ground — T-06's base
   layer sets that on `body`, so this page does not need to declare it.
5. Render the two links — `Dashboard` → `/dashboard` and `Sign in` → `/login` — with T-07's `Button`,
   which takes an optional `href`: with `href` set it renders an `<a>` carrying the variant classes,
   without it a `<button>`. Use that directly — no conditional, no copying the variant classes onto a
   bare `<a>`, and **do not change `Button` from this task**:
   `<Button variant="secondary" href={resolve('/dashboard')}>Dashboard</Button>` and
   `<Button variant="secondary" href={resolve('/login')}>Sign in</Button>`. Keep `resolve()` —
   `svelte/no-navigation-without-resolve` requires it for internal navigation. The `href` form renders
   an anchor with the `link` role, which is correct here and is why no `getByRole('button', …)`
   assertion applies to this page. Never navigate from a `<button>` with a click handler, which is
   not a link to a keyboard or a screen reader.
6. Both hrefs must keep going through `resolve()` — `href={resolve('/dashboard')}` and
   `href={resolve('/login')}` — because the `svelte/no-navigation-without-resolve` ESLint rule
   requires it for internal navigation, and `pnpm lint` fails without it.
7. Sweep the file for literals — no arbitrary values, no raw hex, no POS touch or chrome tokens.

**FROZEN — the `<h1>` accessible name is exactly `matcami`.** `e2e/smoke.spec.ts` asserts
`page.getByRole('heading', { level: 1, name: 'matcami' })`, so it must stay an `h1` with exactly that
text. **Do not replace it with a logo image** and **do not add a tagline inside the heading element** —
a tagline in the `h1` changes the accessible name and fails the smoke test. Put the description in the
`<p>` that follows, as it is now.

**Tests:** none added. `e2e/smoke.spec.ts` is the regression net for this page. **Do not edit it.** Not
one of spec 29's six mandatory areas.

**Done when:** `pnpm check && pnpm lint` exit 0; `pnpm test:e2e` passes unchanged; `git diff e2e/`
prints nothing; and `grep -c 'p-touch' src/routes/+page.svelte` returns **0**.

**Watch out:** `grep -rn "p-touch" src/` currently returns this file and nothing else — it is the only
POS-token leak in the repository, so after this task that grep should return no results at all. If it
returns a `(pos)` file instead, that is a different and legitimate use; leave it.

---

## Closing the phase

After T-17, run the full gate once, with nothing else touching the test database:

```bash
pnpm check && pnpm lint
pnpm test:e2e            # NOT at the same time as pnpm test:integration — shared matcami_test
git diff --stat e2e/     # must print nothing
```

Then open `pnpm dev` and look at all six screens in **both** themes and at **360px** wide. The node
tests from T-03, T-05 and T-12 cannot tell you a rendered page looks right; only a person can. The
theme control that makes switching easy arrives in Phase 5 (T-18, T-19) — until then, switch the OS
preference, or stamp `data-theme="dark"` on `<html>` by hand in the browser's element inspector.
