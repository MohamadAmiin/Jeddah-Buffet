# Phase 3 — The `ui/` primitives

This phase creates `src/lib/components/`, which does not exist in this repository in any form, and
fills `src/lib/components/ui/` with the six dashboard primitives the layout grammar describes —
`Button`, `Field`, `Card`, `PageHeader`, `Alert` and `StatusMark` — plus a barrel so a screen imports
them in one line, and a node test that keeps the whole folder on the correct side of the
`$lib/server` boundary. Nothing here renders a screen: Phase 3 builds the parts, Phase 4 (T-13..T-17)
rebuilds the six existing screens on top of them.

**Depends on:** Phase 1 (T-02's dashboard scale tokens in `src/lib/styles/tokens.css`) and Phase 2
(T-06's element base layer in `src/app.css`). Both are declared again per task as `Needs:`.

**Read `00-overview.md` in this directory before starting any task below.** It carries the goal, the
requirements as agreed with the user, the assumptions this plan rides on, the surviving risks, the
full task index, and the `NEW` / `EXTEND` / `EDIT` tag convention that every `Files:` line uses.
Without it you will not know why, for example, no task here may edit a colour value in `tokens.css`.

## Shared context — true of every task in this phase

Read this once; each task repeats the parts it cannot survive without.

- **Every file in this phase is tagged `NEW`.** `src/lib/components/` is absent in any form at plan
  time — there is no shared UI component anywhere in this repository. That absence is the defect this
  phase fixes: the input class string `border-line bg-bg text-ink rounded border px-3 py-2` is
  hand-repeated across `/login`, `/register` and `/settings`
  (`grep -rn 'border-line bg-bg text-ink rounded border px-3 py-2' src/` lists every occurrence), and
  the button string `bg-accent text-accent-ink rounded px-3 py-2 font-medium disabled:opacity-60`
  appears exactly TWICE verbatim — in `src/routes/register/+page.svelte` and
  `src/routes/login/+page.svelte` — with a third near-identical copy in
  `src/routes/(dashboard)/settings/+page.svelte` that inserts `text-sm`. The directory
  `src/lib/components/ui/` itself may already exist when your task runs,
  because a sibling task in this phase created it — that is expected and is not a mismatch. Only the
  `.svelte` or `.ts` **file** your task is tagged `NEW` for must be absent; if it already exists,
  stop and report, per `00-overview.md`.
- **Svelte 5 with runes.** The repository pins `svelte@5.57.0`. Declare props with
  `let { … } = $props()`, hold local state with `$state`, derive with `$derived`, and render children
  with `{@render children()}`. Do not write `export let`, `$:` or `<slot>`.
- **These are DASHBOARD components.** They must import nothing from `$lib/server` (T-12 enforces
  this), must contain no arbitrary Tailwind value (`bg-[#123456]`, `p-[57px]`) and no raw six-digit
  hex, must use only tokens from `src/lib/styles/tokens.css`, and must not use the POS touch or
  chrome tokens — no `p-touch`, `min-h-touch-*`, `bg-screen`, `bg-key`, `text-key-ink`. Dashboard
  spacing comes from Tailwind's default scale (`px-3`, `py-2`, `p-6`, `gap-4`).
- **Read `docs/design-system.md` section 7b before writing any component.** T-01 writes the dashboard
  layout grammar into that section, and these components implement it. If section 7b is absent, T-01
  has not run — stop and say so rather than inventing the grammar.
- **THE ACCESSIBLE SURFACE IS FROZEN.** `e2e/auth.spec.ts` locates controls by their ACCESSIBLE NAME,
  and Phase 4 will put these components under exactly those assertions. A component must therefore
  never alter the accessible name of what it renders. Specifically: a label renders its text verbatim
  with no asterisk, no suffix and no marker inside the `<label>` element; a button's accessible name
  is exactly its children text; a heading renders a real `h1`-`h4` element with exactly the text it
  is given. No task in this phase may edit `e2e/auth.spec.ts` or `e2e/smoke.spec.ts`.
- **No component test harness exists and none is added.** `vitest.config.ts` defines exactly two
  projects, `unit` and `integration`, both `environment: 'node'`. Do not add `jsdom`,
  `@testing-library/svelte` or Vitest browser mode — `00-overview.md` lists a component test harness
  under **OUT**. Verification here is T-12's text-level node test plus the Playwright journey, and a
  human opening `pnpm dev`.
- **`pnpm lint` runs `prettier --check . && eslint .`**, and `.prettierrc` sets `useTabs: true`,
  `singleQuote: true`, `printWidth: 100`. Run `pnpm format` after writing a file, or lint fails on
  indentation alone.

---

### T-07 — Build the `Button.svelte` primitive

**Needs:** T-02 (dashboard scale tokens: `rounded-control`, the focus ring, `border-control-line`),
T-06 (the element base layer: `:focus-visible`, `prefers-reduced-motion`, control defaults)

**Files:**
- `src/lib/components/ui/Button.svelte` — NEW

**Spec:** `docs/spec.md` does not govern visual design and must not be cited as though it does —
grepping it for logo, brand, theme, font, typography, colour, responsive, resolution and icon returns
only unrelated matter. The nearest real context is **7** (the owner signs in with email and password
and enters the management dashboard): every button this component replaces lives on that journey.
Visual design is governed by `CLAUDE.md`'s "Design & UI" section and by `docs/design-system.md`.

**Invariants:** **8** (permissions are enforced server-side on every route, reads included) — engaged
by **avoidance**: this task adds no route, no `+server.ts` and no form action, so there is nothing new
for `src/routes/route-guards.test.ts` to guard. **12** (POS access = registered device + PIN; session
cookies are HttpOnly + Secure + SameSite and never `localStorage`) — engaged by **avoidance**: this
component reads and writes no cookie and no browser storage. The rules it genuinely engages are
`CLAUDE.md`'s "Design & UI": tokens only, no arbitrary value, WCAG AA in both themes, and the POS
touch scale is not used here.

**Do:**
1. Create `src/lib/components/ui/` if it does not yet exist, then create
   `src/lib/components/ui/Button.svelte`. Read `docs/design-system.md` section 7b first.
2. Declare the props with runes, defaults as shown, and collect the remainder:
   ```svelte
   <script lang="ts">
   	let {
   		variant = 'primary',
   		type = 'button',
   		disabled = false,
   		disabledReason = '',
   		href = undefined,
   		children,
   		...rest
   	}: {
   		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
   		type?: 'button' | 'submit' | 'reset';
   		disabled?: boolean;
   		disabledReason?: string;
   		href?: string;
   		children: import('svelte').Snippet;
   		[key: string]: unknown;
   	} = $props();
   </script>
   ```
3. Render one `<button>` whose only content is `{@render children()}` — that is the default form;
   step 8 adds the `<a>` form for the case where `href` is passed. Spread the remainder so
   callers can pass `form`, `name`, `onclick` and `aria-*`:
   `<button {type} {disabled} aria-describedby={describedBy} {...rest} class={classes}>`. Put
   `{...rest}` before `class` deliberately — a later attribute wins in Svelte, so the token-built
   class string can never be clobbered by a caller passing `class`.
4. Build `classes` from a base plus a per-variant string, tokens only:
   - base — `rounded-control` (T-02's token) plus Tailwind's default spacing, e.g.
     `px-3 py-2 text-sm font-medium disabled:opacity-60`. NEVER `p-touch`, `min-h-touch-xl` or any
     other POS touch token: those are 56-96px targets for a standing thumb, and the dashboard is
     seated and mouse-driven.
   - `primary` — `bg-accent text-accent-ink` (measured 6.13:1 light, 7.82:1 dark in `RESEARCH.md`).
   - `secondary` — transparent ground with `border border-control-line text-ink`. The border token is
     T-02's, derived from `--c-ink-3`: 5.13:1 light and 4.87:1 dark, both above WCAG 1.4.11's 3:1
     floor for a control boundary. Do NOT use `border-line` for a control edge — it measures 1.58:1
     on `--c-raise` and is decorative only.
   - `ghost` — text only: `text-ink`, no ground, no border, with a hover ground from an existing
     token (`hover:bg-raise-2`).
   - `danger` — `--c-danger` as ink and border on the surrounding card ground:
     `border border-danger text-danger`. Do **not** invent a filled `bg-danger` treatment:
     `--c-accent-ink` on `--c-danger` is not a measured pair in `RESEARCH.md`, and no task in this
     plan may add or re-tune a colour value.
5. Keep the existing `disabled:opacity-60` behaviour — that class is already on all three hand-written
   buttons and Phase 4 must not lose it.
6. When the button is disabled, say why rather than sitting dead. Mint a stable id with `$props.id()`
   (available since Svelte 5.20; the repo pins 5.57.0), and when `disabled && disabledReason` render a
   SIBLING element after the button — never inside it:
   ```svelte
   {#if disabled && disabledReason}
   	<span id={reasonId} class="text-ink-2 text-xs">{disabledReason}</span>
   {/if}
   ```
   with `const describedBy = $derived(disabled && disabledReason ? reasonId : undefined);`. It must
   be `$derived` and NOT a plain `const`: in Svelte 5 runes mode a top-level `const` initialiser is
   evaluated once at component setup and then freezes, so a `const` here would keep whatever value
   `disabled` had at mount and the description would never appear or never leave. For the same
   reason the variant class string in step 4 must be `$derived` from `variant`, not a plain `const`.
   A Svelte component may have several root nodes, so no wrapper `<div>` is needed here — `Field`
   (T-08) is the one deliberate exception in this phase: its label, control, hint and error must sit
   inside ONE wrapper element, because the caller's form is `flex flex-col gap-4` and a multi-root
   Field would arrive as three independently spaced children instead of one (see T-08 step 3).
   `aria-describedby` adds a description; it does not change the accessible NAME, which is what
   step 7 protects.
7. The accessible name must be exactly the children text. Do not set `aria-label`, do not render an
   icon, a spinner, a badge or any other text node inside the `<button>` by default.
8. **An optional `href` renders the link form.** When `href` is present the component renders an
   `<a href={href}>` carrying the SAME variant classes; when it is absent it renders the
   `<button type={type}>` of step 3. Use `<svelte:element this={href ? 'a' : 'button'}>` or an
   explicit `{#if}` branch. `type`, `disabled` and `disabledReason` apply only to the BUTTON form —
   an anchor has neither attribute, so do not emit them on it. The caller passes an `href` ALREADY
   produced by `resolve()` from `$app/paths`, because `svelte/no-navigation-without-resolve` requires
   it for internal navigation and `pnpm lint` fails without it; this component neither calls
   `resolve()` nor rewrites the value it is given. This prop exists so that a link styled as a button
   does not have to duplicate the class string — which is the duplication this whole phase removes.
   Note that an `<a>` has the `link` role, NOT `button`: a caller must not use the href form where a
   Playwright `getByRole('button', …)` assertion applies.
9. Run `pnpm format`, then `pnpm check && pnpm lint`.

**Tests:** none of spec 29's six mandatory areas is touched here — this is not money arithmetic, tax,
a journal entry, a posting rule, offline sync or a POS API permission check, so nothing in this task
is marked MANDATORY. Coverage comes from T-12's boundary test and from the Phase 4 screens running
under the existing Playwright journey. Do not add a component test harness.

**Done when:** `pnpm check && pnpm lint` both exit 0, and
`grep -nE '\[#|\[[0-9]+px\]' src/lib/components/ui/Button.svelte` prints nothing (exit status 1).

**Watch out:** do NOT render an icon, a loading spinner or any extra text node inside the button by
default. Anything that adds to the accessible name breaks `getByRole('button', { name: 'Sign in' })`
in `e2e/auth.spec.ts` line 108, and the same spec pins `Create restaurant` (line 52), `Save settings`
(line 93) and `Sign out` (lines 98 and 136). The failure mode to fear is not a red build: it is the
next session "fixing" it by loosening the assertion, which silently deletes the accessibility
contract. Callers keep passing dynamic children such as `{submitting ? 'Signing in…' : 'Sign in'}` —
that is their business, not this component's.

---

### T-08 — Build the `Field.svelte` primitive

**Needs:** T-02 (`rounded-control`, `border-control-line`), T-06 (the element base layer)

**Files:**
- `src/lib/components/ui/Field.svelte` — NEW

**Spec:** the specification does not govern visual design; the honest citation is **7** (the owner
signs in with email and password and enters the management dashboard), which is the journey every
field this component replaces sits on. Field appearance and labelling are governed by `CLAUDE.md`'s
"Design & UI" section and `docs/design-system.md` section 7b.

**Invariants:** **8** (server-side permission checks on every route, reads included) — engaged by
**avoidance**: no route, `+server.ts` or form action is added, and this component performs no
validation of its own. Server-side validation stays where it is, in the existing form actions with
`zod`. **12** (session cookies are HttpOnly/Secure/SameSite, never `localStorage`) — engaged by
**avoidance**: this component touches no cookie and no storage. Genuinely engaged: `CLAUDE.md`'s
"Design & UI" WCAG AA rule, which is why the border and hint tokens below are specified exactly.

**Do:**
1. Create `src/lib/components/ui/Field.svelte`. Read `docs/design-system.md` section 7b first.
2. Declare the props with runes:
   `let { id, label, name, type = 'text', value = '', required = false, hint = '', error = '', list = undefined, autocomplete = undefined, minlength = undefined, ...rest } = $props();`
   Type them: `id: string`, `label: string`, `name: string`,
   `type?: string`, `value?: string`, `required?: boolean`,
   `hint?: string | import('svelte').Snippet`, `error?: string`,
   `list?: string`, `autocomplete?: string`, `minlength?: number`. `hint` is deliberately NOT
   `string` alone — step 3 says why, and a plain `string` would break `/register`.
3. Render the four parts INSIDE ONE WRAPPER ELEMENT — `<div class="flex flex-col gap-1">` — and
   render nothing else. That wrapper is the component's single root node, and it is the whole point:
   the caller's form is `flex flex-col gap-4`, so every `Field` must arrive as ONE flex child of it.
   The caller therefore does NOT keep a grouping div of its own — T-13 and T-16 delete the existing
   `<div class="flex flex-col gap-1">` that groups each label, input and hint today, precisely
   because this component now owns it. Render four sibling root nodes instead and the label, the
   control and the hint become three independent children of the form, spaced 16px apart instead of
   4px — every label floating a full gap above its input on `/login`, `/register` and `/settings`.
   The wrapper's own `gap-1` is what preserves the 4px label-to-control rhythm inside a 16px form
   gap. Inside the wrapper, in this order:
   - `<label for={id} class="text-ink-2 text-sm font-medium">{label}</label>` — the element's text
     content is EXACTLY the `label` prop. No asterisk, no `(required)`, no unit, no `{#if required}`
     branch inside the `<label>`.
   - the control, carrying the matching `id`:
     `<input {id} {name} {type} {value} {required} {list} {autocomplete} {minlength} {...rest} class={controlClass} />`.
     `{...rest}` sits before `class` on purpose — a later attribute wins in Svelte, so the class string
     stays token-built whatever a caller passes.
   - the hint, when `hint` is non-empty:
     ```svelte
     <p id={hintId} class="text-ink-3 text-xs">
     	{#if typeof hint === 'string'}{hint}{:else if hint}{@render hint()}{/if}
     </p>
     ```
     A hint may contain inline elements such as `<code>`: `/register`'s setup-token hint is
     `The one-time value from the server's <code>SETUP_TOKEN</code> environment variable. It is
     required only for the first restaurant, and should be unset afterwards.`, and T-13 keeps it
     verbatim. A plain `string` prop cannot carry that — Svelte HTML-escapes `{hint}`, so the
     registration screen would show the literal text `<code>SETUP_TOKEN</code>` — which is why the
     prop is `string | Snippet`. **NEVER use `{@html …}` for this.** A snippet stays type-checked and
     escaping-safe; `{@html}` hands markup straight to the DOM. The `id={hintId}` stays on the `<p>`
     in both cases, so step 6's `aria-describedby` wiring keeps the hint associated with the control
     whether it arrived as a string or as a snippet.
   - the error, when `error` is non-empty: `<p id={errorId} class="text-danger text-sm">{error}</p>`.
4. `controlClass` is `border-control-line bg-bg text-ink rounded-control border px-3 py-2` — the
   token-correct replacement for the hand-repeated
   `border-line bg-bg text-ink rounded border px-3 py-2`. The border MUST be `border-control-line`
   (5.13:1 light, 4.87:1 dark — above WCAG 1.4.11's 3:1 floor for a UI component boundary), NOT
   `border-line`, which measures 1.58:1 on `--c-raise` and is decorative only. A control whose only
   boundary is `--c-line` is effectively unbounded, and that is a large part of why the current
   screens read as washed out.
5. Put this in a comment above the hint, in the file: the hint uses `text-ink-3`, which is legal HERE
   only because the field sits inside a `bg-raise` card — `--c-ink-3` measures 5.13:1 on `--c-raise`
   but only 4.35:1 on `--c-bg`, below the 4.5:1 floor. A Field placed directly on the page ground
   must not show a hint in `ink-3`.
6. Mint ids with `$props.id()` (Svelte 5.20+; the repo pins 5.57.0) for the hint and error, e.g.
   `const uid = $props.id();` then `const hintId = uid + '-hint';` and `const errorId = uid + '-err';`.
   Wire them with `aria-describedby` (hint and error ids, space-joined, or `undefined` when both are
   empty) and set `aria-invalid="true"` on the control when `error` is non-empty. Never place error or
   hint text inside the `<label>`.
7. Support the `list` attribute so `/settings` and `/register` keep their time-zone `<datalist>`: the
   caller continues to render `<datalist id="time-zones">` itself and passes `list="time-zones"` to
   the Field. This component renders no `<datalist>`.
8. Run `pnpm format`, then `pnpm check && pnpm lint`.

**Tests:** not one of spec 29's six mandatory areas — do not mark anything here MANDATORY. Covered by
T-12's boundary test and by the Playwright journey once Phase 4 puts the component on the screens.

**Done when:** `pnpm check && pnpm lint` both exit 0; the `<label>` element in the file contains the
single expression `{label}` and no other text node (read the file and confirm); and a field rendered
with `label="Password"` is found by Playwright's `getByLabel('Password', { exact: true })` — observably
true when `pnpm test:e2e` passes after T-13 restyles `/login`.

**Watch out:** this is the single highest-risk component in the plan. `e2e/auth.spec.ts` locates SEVEN
fields by exact label text — `Restaurant name` (lines 45 and 92), `Time zone` (46), `Your name` (47),
`Email` (48, 106), `Password` with `{ exact: true }` (49, 107), `Confirm password` (50) and
`Setup token` (51). Adding a required asterisk, a `(required)` suffix, a unit, or any other text node
inside the `<label>` changes the accessible name and breaks the journey. Note in particular that
`getByLabel('Password', { exact: true })` is written to distinguish `Password` from
`Confirm password`; a suffix of any kind on either one destroys that distinction. Mark required-ness
with the `required` attribute on the control only.

---

### T-09 — Build the `Card.svelte` and `PageHeader.svelte` primitives

**Needs:** T-02 (`rounded-card`, `rounded-control`; `shadow-card` already exists in `tokens.css`),
T-06 (the element base layer, which is where `text-wrap: balance` on headings lands)

**Files:**
- `src/lib/components/ui/Card.svelte` — NEW
- `src/lib/components/ui/PageHeader.svelte` — NEW

**Spec:** **7** (the owner signs in and enters the management dashboard) for the surfaces these two
components frame, and **26** (the report list the navigation anticipates) for the pages `PageHeader`
will title as they are built. Beyond naming those surfaces the specification does not govern visual
design at all — `CLAUDE.md`'s "Design & UI" section and `docs/design-system.md` section 7b do.

**Invariants:** **8** (server-side permission checks on every route, reads included) — engaged by
**avoidance**: no route is added. **12** (session cookies HttpOnly/Secure/SameSite, never
`localStorage`) — engaged by **avoidance**: neither component touches a cookie or storage. Genuinely
engaged: `CLAUDE.md`'s "Design & UI" rule that `tokens.css` is the only place a colour, size or type
value is defined.

**Do:**
1. Create `src/lib/components/ui/Card.svelte`. Props: `children` and an optional `class`. `class` is a
   reserved word, so destructure it renamed:
   `let { children, class: className = '' } = $props();`
2. Card renders one element with `bg-raise border border-line rounded-card shadow-card` plus generous
   internal padding from Tailwind's default scale (`p-6`), then `{@render children()}`. Append
   `className` last so a caller can add layout classes:
   ``class={`bg-raise border-line shadow-card rounded-card border p-6 ${className}`}``.
   `border-line` is correct here — a card edge is decorative, not a control boundary (contrast the
   rule in T-07 and T-08, where a control edge must be `border-control-line`).
3. Create `src/lib/components/ui/PageHeader.svelte`. Props: `title: string`, optional
   `description?: string`, optional `level?: 1 | 2 | 3 | 4` defaulting to `2`, and an optional
   `actions?: import('svelte').Snippet`.
4. PageHeader renders a REAL heading element of the given level containing exactly `title`:
   ```svelte
   <svelte:element this={`h${level}`} class="font-display text-xl font-bold">{title}</svelte:element>
   ```
   An explicit `{#if level === 1}…{:else if level === 2}…` branch is equally acceptable. What is NOT
   acceptable is a styled `<div>` with `role="heading"` — the element must be a genuine `h1`-`h4`.
5. Below the heading, when `description` is non-empty, render
   `<p class="text-ink-2 mt-1 text-sm">{description}</p>`. `text-ink-2` measures 7.5:1 on `--c-raise`
   and passes on the page ground too, unlike `text-ink-3`.
6. When `actions` is supplied, render it beside the heading — a flex row that puts the heading block
   left and `{@render actions()}` right, wrapping on narrow viewports. When it is not supplied, render
   nothing for it.
7. Headings use `font-display` (Archivo), per `docs/design-system.md` section 4 and the font stacks
   T-04 corrects. Sizes come from Tailwind's default scale; no arbitrary value.
8. Run `pnpm format`, then `pnpm check && pnpm lint`.

**Tests:** not one of spec 29's six mandatory areas; nothing here is MANDATORY. Covered by T-12's
boundary test and by the Playwright journey.

**Done when:** `pnpm check && pnpm lint` both exit 0; `grep -n 'role="heading"' src/lib/components/ui/PageHeader.svelte`
prints nothing; and a `PageHeader` with `title="Getting set up"` and `level={2}` is found by
`getByRole('heading', { name: 'Getting set up' })` — observably true when `pnpm test:e2e` passes after
T-15.

**Watch out:** `e2e/auth.spec.ts` asserts four headings by role and name — `Set up your restaurant`
(line 42), the RESTAURANT NAME in the dashboard header (lines 57, 95 and 111), `Getting set up`
(line 58) and `Restaurant settings` (line 91) — and `e2e/smoke.spec.ts` line 8 asserts
`getByRole('heading', { level: 1, name: 'matcami' })` on `/`, which is why `level` must be able to
render a real `h1`. If `PageHeader` ever wrapped the title in extra text, appended a description into
the same element, or rendered a `div`, those assertions break. Also: **cards do not nest inside
cards.** An inset region inside a card is `bg-raise-2` with `rounded-control`, not a second `Card`.

---

### T-10 — Build the `Alert.svelte` primitive

**Needs:** T-02 (`rounded-control`), T-06 (the element base layer)

**Files:**
- `src/lib/components/ui/Alert.svelte` — NEW

**Spec:** the specification does not govern visual design. The nearest honest citation is **7** (the
owner signs in and enters the management dashboard) — the messages this component carries are the sign-in
failure and the settings confirmation on that journey. The rules that actually govern it are
`CLAUDE.md`'s "Design & UI" ("Colour NEVER carries meaning alone — pair every status with its glyph")
and `docs/design-system.md` sections 3 and 9.

**Invariants:** **8** (server-side permission checks on every route, reads included) — engaged by
**avoidance**: no route is added; this component only displays a message a server action already
returned. **12** (session cookies HttpOnly/Secure/SameSite) — engaged by **avoidance**. Genuinely
engaged: `CLAUDE.md`'s colour-plus-glyph rule and the WCAG AA floor in both themes.

**Do:**
1. Create `src/lib/components/ui/Alert.svelte`. Read `docs/design-system.md` sections 3 and 7b first.
2. Props: `let { tone = 'info', children } = $props();` with
   `tone?: 'info' | 'success' | 'danger'` and `children: import('svelte').Snippet`.
3. Render a region carrying `role="alert"`, so a screen reader announces it without the user going
   looking for it. That is the same reason the current `/login` and `/settings` pages carry
   `role="alert"` on their message paragraph, and Phase 4 replaces those paragraphs with this
   component.
4. Tone → surface, tokens only, no hex:
   - `info` — the neutral pair: `bg-raise` ground, `border-line` border, `text-ink` text.
   - `success` — `bg-ok-bg` ground, `border-ok` border, `text-ok` text.
   - `danger` — `bg-danger-bg` ground, `border-danger` border, `text-danger` text.
   Radius `rounded-control`; padding from Tailwind's default scale (`px-3 py-2 text-sm`).
5. Pair every tone with a GLYPH as well as a colour — colour never carries meaning alone (WCAG 1.4.1;
   roughly one man in twelve has red-green colour vision deficiency). Use `info` → `•`,
   `success` → `✓`, `danger` → `✕`. Render the glyph in `font-mono` so it aligns, and mark it
   `aria-hidden="true"`: the message text supplied by the caller carries the meaning, and the glyph
   must not be read out or join the announced string.
6. The message body is `{@render children()}` and nothing else — no title, no dismiss button, no icon
   beyond the glyph in step 5.
7. Run `pnpm format`, then `pnpm check && pnpm lint`.

**Tests:** not one of spec 29's six mandatory areas; nothing here is MANDATORY. Covered by T-12's
boundary test and by the Playwright journey.

**Done when:** `pnpm check && pnpm lint` both exit 0, and `getByRole('alert')` finds an `Alert`
containing the text `Settings saved.` — observably true when `pnpm test:e2e` passes after T-16
restyles `/settings`.

**Watch out:** `e2e/auth.spec.ts` line 94 does
`await expect(page.getByRole('alert')).toContainText('Settings saved.');` against a SINGLE locator, so
a page showing two `role="alert"` regions at once triggers a Playwright strict-mode violation and the
journey fails. **At most one alert is visible per page at a time** — do not add a second standing
alert to any screen, and do not give this component a variant that renders two regions. Second trap:
in DARK, `--c-danger` and `--c-ok` are illegal on `bg-raise-2` (measured 4.06:1 and 4.18:1 in
`RESEARCH.md`, both below the 4.5:1 floor). Keep alert text on its own `-bg` tone or on `bg-raise`,
where the same tokens pass. If a pair fails, change the pair — **no task in this plan may fix contrast
by editing a colour value**; the user deferred palette work.

---

### T-11 — Build the `StatusMark.svelte` primitive

**Needs:** T-02 (dashboard scale tokens), T-06 (the element base layer)

**Files:**
- `src/lib/components/ui/StatusMark.svelte` — NEW

**Spec:** the specification does not govern visual design. Spec **13** defines the order and item
lifecycle whose statuses this component deliberately does NOT render yet (see step 4) — it is cited to
say what is being left alone, not to authorise building it. The governing documents are `CLAUDE.md`'s
"Design & UI" colour-plus-glyph rule and `docs/design-system.md` section 3.

**Invariants:** **8** (server-side permission checks on every route, reads included) — engaged by
**avoidance**: no route is added. **12** (session cookies HttpOnly/Secure/SameSite) — engaged by
**avoidance**. Genuinely engaged: `CLAUDE.md`'s "Colour NEVER carries meaning alone — pair every status
with its glyph", which is the entire reason this component exists rather than a coloured dot.

**Do:**
1. Create `src/lib/components/ui/StatusMark.svelte`. It renders a status as a GLYPH plus a colour plus
   accessible text — never colour alone.
2. Props: `let { status, label = '' } = $props();` with `status: 'done' | 'not-started'` and
   `label?: string`.
3. Support ONLY the two statuses this plan actually renders, the onboarding-step states:
   - `done` — glyph `●`, colour `text-ok`
   - `not-started` — glyph `○`, colour `text-ink-3`
   Render the glyph inside `<span aria-hidden="true" class="font-mono …">` so it aligns and is not
   announced, and render `{label}` as ordinary text beside it when `label` is non-empty. The meaning is
   carried by the visible or screen-reader text the CALLER supplies — this component bakes in no
   wording.
4. Put this comment in the file, verbatim in substance:

   > DELIBERATELY NOT SUPPORTED — spec 13's item and order statuses (`NEW ◇`, `SENT ▲`, `VOIDED ✕`,
   > `OPEN ○`, `BILLED ◐`, `PAID ●`, `REFUNDED ↩`) and the table and sync states. They are documented
   > in `docs/design-system.md` section 3 and their tokens exist (`--c-st-*`), but no order, item,
   > table or sync row exists in this repository — `src/lib/server/orders/` is a README only. Adding
   > them now would coin a client-side status vocabulary before the columns that define it exist.
   > Extend this component deliberately, in the plan that adds those columns.

   Do not add those statuses, do not reference a `--c-st-*` token, and do not add a `sync` or `table`
   variant "while you are here".
5. Note in a comment that `text-ink-3` is legal here because the onboarding steps render inside
   `bg-raise` cards: `--c-ink-3` measures 5.13:1 on `--c-raise` against 4.35:1 on `--c-bg`, and the
   4.5:1 floor is `CLAUDE.md`'s non-negotiable.
6. Run `pnpm format`, then `pnpm check && pnpm lint`.

**Tests:** not one of spec 29's six mandatory areas; nothing here is MANDATORY. Covered by T-12's
boundary test.

**Done when:** `pnpm check && pnpm lint` both exit 0; the file's status union has exactly two members
(`'done' | 'not-started'`); `grep -n 'st-new\|st-sent\|st-voided\|st-billed\|st-paid\|st-offline' src/lib/components/ui/StatusMark.svelte`
prints nothing; and the component renders a glyph for each supported status, plus the
caller-supplied `label` when `label` is non-empty and NO text when it is empty.

**Watch out:** the onboarding checklist's screen-reader text and its visible badge are asserted by the
e2e journey in a very specific way — `e2e/auth.spec.ts` line 63 requires
`getByText('not started', { exact: true })` to have **count exactly 5**, because each step currently
renders the phrase twice (a visible badge and a screen-reader-only ` — not started`). **T-15 owns
those exact strings**, so this component must not bake them in: let the caller pass the text, and do
not render a default label when `label` is empty. A default of `'not started'` here would change that
count and break the journey.

---

### T-12 — Add the `ui/` barrel and its import-boundary guard

**Needs:** T-07 (`Button.svelte`), T-08 (`Field.svelte`), T-09 (`Card.svelte`, `PageHeader.svelte`),
T-10 (`Alert.svelte`), T-11 (`StatusMark.svelte`)

**Files:**
- `src/lib/components/ui/index.ts` — NEW
- `src/lib/components/components.test.ts` — NEW

**Spec:** none — the specification does not cover component structure or import boundaries. What this
task enforces is `CLAUDE.md`'s house convention ("`lib/server/**` MUST NOT be imported by client-side
code or by `lib/pos/`") and its "Design & UI" rules (tokens only; the POS touch and chrome tokens are
not dashboard tokens).

**Invariants:** **8** (permissions are enforced server-side on every route, reads included) — engaged
by **avoidance and protection**: this plan adds no route, and the test written here stops a shared
component from becoming a back door that drags `$lib/server` into client bundles. **12** (session
cookies HttpOnly/Secure/SameSite, never `localStorage`) — engaged by **avoidance**: no component in
this folder reads a cookie or storage.

**Do:**
1. Create `src/lib/components/ui/index.ts` re-exporting every component in the folder, so a screen
   writes one import:
   ```ts
   export { default as Alert } from './Alert.svelte';
   export { default as Button } from './Button.svelte';
   export { default as Card } from './Card.svelte';
   export { default as Field } from './Field.svelte';
   export { default as PageHeader } from './PageHeader.svelte';
   export { default as StatusMark } from './StatusMark.svelte';
   ```
   If a file listed above is missing, its task has not run — stop and say which, rather than exporting
   a path that does not resolve.
2. Create `src/lib/components/components.test.ts`. It is a plain unit test in the EXISTING `unit`
   project: `vitest.config.ts` already includes `src/**/*.test.ts` there with `environment: 'node'`
   and excludes `src/**/*.integration.test.ts`. Change no config, add no dependency, add no harness.
3. Walk `src/lib/components/` recursively with `node:fs` (`readdirSync`, `statSync`, `readFileSync`),
   collecting every `.svelte` and `.ts` file, and **excluding this test file itself** (see
   **Watch out**). Assert, for every collected file:
   - **(a) no server import** — the source contains none of `$lib/server`, `../server/` or any path
     containing `lib/server`. Check the raw text, which catches static `import`, `export … from` and
     dynamic `import()` in one rule.
   - **(b) no arbitrary Tailwind value and no raw hex** — none of `/\[#[0-9a-fA-F]{3,8}\]/`,
     `/\[\d+(?:\.\d+)?px\]/` or `/#[0-9a-fA-F]{6}\b/` matches. Colours, sizes and type values live in
     `src/lib/styles/tokens.css` and nowhere else.
   - **(c) no POS-only token** — none of `p-touch`, `min-h-touch`, `touch-min`, `touch-lg`,
     `touch-xl`, `bg-screen`, `bg-key`, `text-key-ink` appears. These are the standing-thumb targets
     and the POS device chrome; the dashboard is seated and mouse-driven.
   Give each `expect` a message naming the offending file and what to do instead — a bare `toBe(false)`
   tells the next session nothing.
4. **Strip comments before applying (b) and (c).** The guard is text-level, and this plan repeatedly
   asks authors to record their rationale in a comment — including T-07's instruction that `p-touch`
   must never be used, and T-11's block about the statuses it deliberately does not support. A
   correct component would otherwise fail its own guard on its own prose. So, for each file, remove
   `/* … */` blocks, `//` line comments and `<!-- … -->` HTML comments from the text FIRST, and apply
   rules (b) and (c) to what is left, so the guard checks code rather than prose. **Rule (a) stays on
   the RAW text**: a commented-out `$lib/server` import is still worth flagging. Say this in a
   comment in the test, so the next session does not "simplify" the stripping away and then weaken
   the patterns to make the suite green again.
5. Guard the walk: assert it found files at all, following the pattern already in
   `src/routes/route-guards.test.ts` lines 53-57 —
   `expect(files.length).toBeGreaterThan(0)` with the comment that a walk which silently found nothing
   would pass every assertion below it.
6. Record the convention in a comment at the top of the test: a `ui/` primitive takes its data as
   props and imports nothing from `$lib/server`. Explain why the test is needed beside eslint:
   `eslint.config.js` scopes its `no-restricted-imports` rule to
   `['src/lib/pos/**/*.{ts,svelte}', 'src/routes/(pos)/**/*.{ts,svelte}']` — by IMPORTING FILE. That
   rule is syntactic and per-file, so it would not catch a future POS route importing a shared
   component that itself imports `$lib/server`. This test is what closes that gap.
7. Run `pnpm format`, then `pnpm test:unit`, then `pnpm check && pnpm lint`.

**Tests:** this task IS the test. It is **not** one of spec 29's six mandatory areas — not money
arithmetic or rounding, not tax in both modes, not journal entries balancing, not a posting rule per
business event, not offline sync retries, not a permission check per POS API route — so do **not**
label it MANDATORY.

**Done when:** `pnpm test:unit` passes; temporarily adding
`import { db } from '$lib/server/db/client';` to any component in `src/lib/components/ui/` makes it
FAIL (verify this, then remove the line); and `pnpm check && pnpm lint` both exit 0.

**Watch out:** two traps, both cheap to hit.
1. The walk must fail loudly if it finds ZERO files to check — a walk that silently finds nothing
   passes every assertion it makes, which is precisely how a "green" suite proves nothing.
   `src/routes/route-guards.test.ts` already uses that guard; follow the same pattern.
2. **The test file lives inside the directory it walks and contains every forbidden string it looks
   for** — `$lib/server`, a bracketed hex, `p-touch`, `bg-key`. It must exclude itself from the
   collected files (compare against `fileURLToPath(import.meta.url)`, not against a hard-coded name),
   or it fails against its own source the first time it runs and the next session "fixes" it by
   weakening the patterns.
