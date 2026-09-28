# Phase 1 — The dashboard design system

This phase writes the contract the rest of the plan implements. `docs/design-system.md` today is a POS
document: seven sections about the counter, one table row about the dashboard. T-01 gives the
dashboard its own layout grammar — named tokens, legal ink-on-surface pairs with measured ratios,
control borders, focus, button variants, form anatomy, cards, navigation, typography and what must
never appear on a dashboard screen. T-02 adds the four scale tokens that grammar names to
`src/lib/styles/tokens.css`. T-03 locks both down with node tests that read the CSS as text: token
completeness across the three theme states, the WCAG contrast floor in both themes, and a scan that
keeps arbitrary Tailwind values out of every `.svelte` file.

Nothing in this phase renders a pixel. It exists so that T-06's base layer, T-07..T-12's primitives
and T-13..T-17's screens all implement one written rule rather than six improvisations.

**Depends on:** nothing — this is the first phase of the plan. T-04 (`02-foundation.md`) also has no
dependencies and may run in parallel with T-01..T-03.

**Read `00-overview.md` in this directory FIRST.** It carries the goal, the requirements as agreed
with the user, the scope boundaries, the surviving risks, the five assumptions this plan rides on,
the complete task index, and the `NEW` / `EXTEND` / `EDIT` tag convention used in every `Files:` list
below. A task executed without that header will "helpfully" do things the user explicitly excluded —
re-tune the palette, replace the favicon, repair the known-false claims in `docs/design-system.md`.

---

### T-01 — Write the dashboard layout grammar into `docs/design-system.md`

**Needs:** -
**Files:**
- `docs/design-system.md` — EDIT (insert a NEW section titled `## 7b. Dashboard component rules`
  immediately AFTER the whole of `## 7. POS component rules` and BEFORE `## 8. Receipts are a
  separate problem`. At plan time section 7 ends with the paragraph beginning
  `**Worth stealing from the incumbents:**`, followed by a `---` rule, then `## 8`. Insert between
  that `---` and the `## 8` heading, and close the new section with its own `---` so the file's
  existing rhythm of `section / --- / section` is unbroken.)

**Spec:** 7 (the owner signs in with email and password and enters the management dashboard — the
surface this grammar governs), 26 (the reporting list the dashboard navigation anticipates).
Beyond naming that surface, **the specification does not govern visual design at all**: grepping
`docs/spec.md` for logo, brand, theme, font, typography, colour, responsive, resolution and icon
returns only unrelated matter. Visual design is governed by `CLAUDE.md`'s "Design & UI" section and
by `docs/design-system.md` itself, which is the document this task edits. Do not manufacture a spec
citation for any rule below.

**Invariants:** none directly — see below. This task edits a document. It adds no route, so
invariant 8 (*permissions are enforced SERVER-side on every POS API route, reads included*) is
engaged only by avoidance; it touches no cookie, so invariant 12 (*sessions are HttpOnly + Secure +
SameSite cookies, NEVER `localStorage`*) likewise. The rules it does engage are `CLAUDE.md`'s
"Design & UI" section: `src/lib/styles/tokens.css` is the ONLY place a colour, size or type value is
defined; colour NEVER carries meaning alone (pair every status with its glyph); money renders only
through the money module's formatter in `--font-mono` with `tabular-nums`; the POS shell stays dark
in BOTH themes and is not page chrome; WCAG AA (4.5:1) at normal text size, in both themes, for every
text-on-surface pair.

**Do:**

1. Open `docs/design-system.md` and locate the boundary between `## 7. POS component rules` and
   `## 8. Receipts are a separate problem`. If either heading is absent, stop and report — the file
   is not in the state this plan assumed.

2. Use the number **7b** deliberately. Sections 8, 9 and 10 keep their numbers, so nothing that cites
   them breaks. **Do not renumber anything in this file.**

3. Do not touch sections 4, 5 or 9. Three of their claims are known to be false (section 9 says
   `prefers-reduced-motion` "is honoured (already in `tokens.css`)" and it is not; section 4 says
   headings get `text-wrap: balance` and they do not; section 5's token table has a duplicated header
   row so it renders broken). Assumption 5 in `00-overview.md` records that the user was asked and
   chose not to include these repairs. **Report them if you notice them; never repair them.**

4. Write the new section. Every rule below must be expressed with **token names, utility names and
   measured numbers — never an adjective.** "Generous padding" is acceptable only where the section
   also names the surface and the radius; "a muted grey" is not acceptable anywhere. The section must
   define all thirteen of the following:

   1. **Page skeleton.** A dashboard page is: a `PageHeader` (heading + optional one-line description
      + optional action area), then content. Content width is capped by the new `--container-page`
      token (utility `max-w-page`), which T-02 adds. The dashboard uses **Tailwind's DEFAULT spacing
      and type scale**. The POS touch tokens (`p-touch`, `min-h-touch-xl`, `touch-min`, `touch-lg`)
      and the POS chrome tokens (`--c-screen`, `--c-key`, `--c-key-line`, `--c-key-ink`) **MUST NOT
      appear on any dashboard screen**.

   2. **Surface hierarchy.** `bg-bg` is the page ground. `bg-raise` is a card or panel. `bg-raise-2`
      is an inset region nested inside a card. The header bar is `bg-raise` with a `border-line`
      bottom edge.

   3. **Legal ink-on-surface pairs — a hard rule, with the measured numbers.** Present this as a
      table. The ratios come from `RESEARCH.md` in this directory, computed per WCAG relative
      luminance from the hex values in `src/lib/styles/tokens.css`. Every rule below is stated so a
      developer can apply it without reasoning per theme: the rules are deliberately the
      **intersection of both themes**, so no screen has to be reasoned about twice.
      - `text-ink-3` is legal **ONLY** on `bg-raise`, in **both** themes (**5.13:1** light,
        **4.87:1** dark). On `bg-bg` it is **4.35:1** light, on `bg-bg-2` **4.03:1** light, on the
        four tinted grounds `bg-accent-soft` / `bg-ok-bg` / `bg-warn-bg` / `bg-danger-bg`
        **4.23–4.38:1** light, and on `bg-raise-2` **4.25:1** dark and `bg-accent-soft` **4.39:1**
        dark. Anywhere else, use `text-ink-2` (**6.38:1** on light `bg`, **6.15:1** on dark
        `raise-2`, **6.34:1** on dark `accent-soft`).
      - `text-ok` and `text-danger` are legal on `bg-bg` and `bg-raise`, and are **ILLEGAL** on
        `bg-raise-2` (**4.18:1** and **4.06:1** dark) and on `bg-accent-soft` (**4.31:1** and
        **4.19:1** dark).
      - `text-ink` and `text-ink-2` are legal on **every** surface in both themes.
      - The six `--c-st-*` status colours pass on every surface in **both** themes.
      State the rule in words as: *before pairing an ink with a surface, check this table; adding a
      new pair means measuring it.*

   4. **Control borders.** An interactive control — a text input, a select, the secondary button's
      outline — draws its boundary with `border-control-line`, which resolves to `--c-ink-3`:
      **5.13:1** in light and **4.87:1** in dark, both above the **3:1** that WCAG 1.4.11 requires of
      a UI component boundary. `border-line` measures **1.58:1** on `bg-raise` and is for
      **DECORATIVE** edges only — card outlines, dividers, the header rule. Explain why the two are
      separated: a form control whose only boundary is a 1.58:1 line is effectively unbounded.

   5. **Focus.** Every interactive element shows a `:focus-visible` ring: `2px` `outline` in
      `--c-ring`, with `2px` `outline-offset`. `--c-ring` derives from `--c-accent` and measures
      **5.21:1** on light `bg` and **7.49:1** on dark `bg`. **Never remove a focus ring without
      replacing it.**

   6. **Button variants.** Four, named:
      - `primary` — `bg-accent` / `text-accent-ink` (**6.13:1** light, **7.82:1** dark). **One per
        view**: the view's main action.
      - `secondary` — transparent ground, `border-control-line`, `text-ink`.
      - `ghost` — text only, for tertiary actions such as navigation.
      - `danger` — for destructive actions. None exists on the dashboard yet.
      A disabled control **must SAY WHY**. That rule already applies on the POS (section 7) and
      applies here identically — a control disabled without a stated reason sits dead.

   7. **Form field anatomy.** In order: label above the control, then the control, then the hint,
      then the error. The label's text **is** the control's accessible name, so it must be the plain
      field name — **no required asterisk, no suffix, no marker of any kind inside the `<label>`
      element**. Errors use `role="alert"`, and **at most one `role="alert"` region is visible per
      page at a time**.

   8. **Card.** `bg-raise`, `border-line`, `rounded-card`, `shadow-card`, generous internal padding.
      **Cards do not nest inside cards**; an inset region uses `bg-raise-2` with `rounded-control`.

   9. **Empty and not-started states.** A glyph plus text, never colour alone. Reuse section 3's
      glyph vocabulary rather than coining new marks. The dashboard's only status today is
      onboarding-step completion.

   10. **Navigation.** The current page carries `aria-current="page"`. An unavailable destination is
       `aria-disabled="true"` with **NO link target** and a **visible reason** — never a hidden item,
       and never a dead link that 404s.

   11. **Typography on the dashboard.** `font-display` for headings, `font-sans` for body,
       `font-mono` for money, quantities, account codes, invoice numbers and IDs. Headings get
       `text-wrap: balance`. Reiterate section 4's rule: **a price set in the body face is a bug.**

   12. **What must NOT appear on a dashboard screen.** The POS touch tokens; the POS chrome tokens;
       an arbitrary Tailwind value such as `bg-[#123456]` or `p-[57px]`; a raw hex; and **any money
       figure at all** for as long as `src/lib/server/money/` exports no formatter — check that
       directory before writing one, and if it holds only a `README.md`, a money figure on a
       dashboard screen could only be hardcoded, which section 6 and invariants 1 and 7 forbid.

   13. **Responsive.** Single column below Tailwind's `md`. The navigation collapses above the
       content. **Nothing scrolls horizontally at any width.**

5. Keep the section's voice consistent with the rest of the file: short rules, bold on the load-
   bearing clause, tables where there are measured numbers.

**Tests:** none. This task changes a document; there is nothing to assert against. Stated explicitly
so a reader does not go looking for a missing test file. This is **not** one of spec 29's six
mandatory areas — spec 29 names money arithmetic and rounding, tax in both modes, journal entries
balancing, one posting rule per business event, offline retries never duplicating, and a permission
check per POS API route. None of them is this.

**Done when:**
- `grep -n '^## 7b' docs/design-system.md` prints exactly one line.
- `grep -n '^## 8\.\|^## 9\.\|^## 10\.' docs/design-system.md` still prints those three headings with
  their original numbers.
- `grep -n -e '--container-page' -e 'border-control-line' -e '--c-ring' docs/design-system.md` prints
  at least one line for each of the three names.
- The legal-pair table lists all **twelve** measured failing combinations with their ratios, and
  marks which theme each belongs to — the **light six**, all of them `ink-3`: on `bg` (4.35:1), on
  `bg-2` (4.03:1), on `accent-soft` (4.29:1), on `ok-bg` (4.33:1), on `warn-bg` (4.38:1) and on
  `danger-bg` (4.23:1); and the **dark six**: `danger` (4.06:1), `ok` (4.18:1) and `ink-3` (4.25:1)
  on `raise-2`, and `danger` (4.19:1), `ok` (4.31:1) and `ink-3` (4.39:1) on `accent-soft`.
- `git diff docs/design-system.md` shows additions only inside the new section — no line of sections
  1–7 or 8–10 is modified.

**Watch out:** this section is the contract that T-02's tokens and T-07..T-12's components
implement. Anything vague here becomes a vague component, and the vagueness is discovered six tasks
later when it is expensive. **Do not invent a colour, and do not propose changing one** — the user
deferred palette work (`00-overview.md`, "Deliberately excluded"), and every AA failure above is
fixed by a rule about which token may sit on which surface, never by editing a hex value.

---

### T-02 — Add the dashboard scale tokens to `tokens.css`

**Needs:** T-01 (the grammar names `--container-page`, `border-control-line` and `--c-ring`; this
task makes those names real)
**Files:**
- `src/lib/styles/tokens.css` — EDIT (three separate places: the bare `:root` palette block, beside
  the existing semantic colours; the `@theme inline` block; the plain static `@theme` block at the
  end of the file)

**Spec:** none governs this. The specification says nothing about design tokens, CSS or visual
design — see T-01's `Spec:` note. The governing documents are `CLAUDE.md`'s "Design & UI" section and
`docs/design-system.md` (including the `## 7b` section T-01 just wrote).

**Invariants:** none directly — see below. This task adds four CSS custom properties and two Tailwind
theme entries; it adds no route (invariant 8, *permissions enforced SERVER-side on every POS API
route, reads included*, engaged by avoidance) and no cookie (invariant 12, *sessions are HttpOnly +
Secure + SameSite, NEVER `localStorage`*, likewise). The rules it does engage are `CLAUDE.md`'s
"Design & UI" section: `tokens.css` is THE design tokens and the ONLY place a colour, size or type
value is defined; every `--c-*` MUST exist in the bare `:root`; themeable tokens are exposed to
Tailwind via `@theme inline`, which is required.

**Do:**

1. Open `src/lib/styles/tokens.css` and confirm its three layers before editing. If any is absent,
   stop and report — the split is load-bearing and the rest of this task assumes it:
   1. the raw `--c-*` palette in the **bare `:root`**, plus a
      `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` block and a
      `:root[data-theme="dark"] { … }` block;
   2. an **`@theme inline`** block exposing themeable values to Tailwind;
   3. a **plain `@theme`** block for static values.
   `inline` is REQUIRED for anything themeable: plain `@theme` bakes the light value into the
   utility, while `@theme inline` emits `var(--c-x)` so the utility follows the theme. Static things
   — fonts, spacing, radii, container widths — use plain `@theme`.

2. In the **bare `:root`**, beside the existing semantic colours (the `--c-accent` / `--c-ok` /
   `--c-warn` / `--c-danger` group), add exactly these two declarations together with the comment:

   ```css
   /* Derived, and declared ONCE — in the bare :root only. Do NOT repeat these in
      either dark block: they reference tokens the dark blocks already redefine,
      and custom-property substitution resolves at USE time, so they follow the
      theme automatically. The header rule above ("every --c-* MUST be declared in
      the bare :root") means declared there at all — not declared in every block. */
   --c-ring: var(--c-accent);
   --c-control-line: var(--c-ink-3);
   ```

   The comment is not decoration. Without it the file's own header rule reads as "and also in every
   dark block", and the next session duplicates both tokens into the two dark blocks, where they
   would then be pinned to whatever `var()` resolved to at that point.

3. Do **NOT** add `--c-ring` or `--c-control-line` to
   `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`, and do **NOT** add them
   to `:root[data-theme="dark"]`.

4. In the **`@theme inline`** block, add:

   ```css
   --color-ring:         var(--c-ring);
   --color-control-line: var(--c-control-line);
   ```

   These yield the `border-control-line` utility that T-01's grammar names for interactive control
   boundaries, and the `outline-ring` / `ring-ring` / `text-ring` family for the focus ring T-06 will
   implement.

5. In the **plain static `@theme`** block (the one holding `--font-display`, `--text-pos` and the
   `--spacing-touch-*` scale), add:

   ```css
   --radius-card:    0.75rem;
   --radius-control: 0.5rem;
   --container-page: 72rem;
   ```

   These yield `rounded-card`, `rounded-control` and `max-w-page` respectively. They are static
   values, not themeable ones, so plain `@theme` is correct here and `@theme inline` is not.

6. Add **nothing else**. In particular:
   - Do **NOT** add a type-scale token. `docs/design-system.md` states the dashboard uses Tailwind's
     default type scale, and adding one would contradict the document T-01 just wrote.
   - Do **NOT** change any existing colour VALUE. The user deferred palette re-tuning and
     `00-overview.md` forbids it under "Deliberately excluded".

7. Run `pnpm lint`. If prettier reports the file, run `pnpm format` and re-run `pnpm lint`.

**Tests:** none in this task — **T-03 is where the assertions live**, and this task must not ship
without it. T-03 reads this file as text and asserts the token contract and the contrast floor. Not
one of spec 29's six mandatory areas (money arithmetic and rounding, tax in both modes, journal
entries balancing, one posting rule per business event, offline retries never duplicating, a
permission check per POS API route) — none of them is this.

**Done when:**
- `pnpm check` exits 0 and `pnpm lint` exits 0.
- `grep -c 'c-ring' src/lib/styles/tokens.css` prints at least `2` (the bare-`:root` declaration and
  the `@theme inline` reference).
- `grep -c 'c-control-line' src/lib/styles/tokens.css` prints at least `2`.
- `grep -n -e '--radius-card' -e '--radius-control' -e '--container-page' src/lib/styles/tokens.css`
  prints three lines, all inside the plain `@theme` block.
- `git diff src/lib/styles/tokens.css` shows **no change to any existing hex value** — every `#`
  literal in the diff is on an added line only if it is part of the comment, and no existing `#rrggbb`
  line appears as removed.

**Watch out:**
- Tailwind tree-shakes unused theme tokens, so a token added here emits **no CSS** until a component
  uses it. `rounded-card` and `outline-ring` will produce nothing in the built stylesheet until T-06
  and T-09 consume them. That is expected and is not a failure — do not "fix" it by adding a dummy
  usage.
- Putting `--color-ring` in the plain `@theme` block instead of `@theme inline` would freeze the
  **light** accent into every focus ring, and the dark theme would then show the wrong colour. The
  same trap applies to `--color-control-line`. The two new colour entries go in `@theme inline`; the
  three new size entries go in plain `@theme`.

---

### T-03 — Lock the token contract and the contrast floor with node tests

**Needs:** T-02 (`--c-ring`, `--c-control-line`, `--radius-card`, `--radius-control`,
`--container-page`)
**Files:**
- `src/lib/styles/tokens.test.ts` — NEW

**Spec:** none governs this. The specification does not cover visual design, tokens or contrast — see
T-01's `Spec:` note. The governing documents are `CLAUDE.md`'s "Design & UI" section ("WCAG AA
(4.5:1) at normal text size, in both themes, for every text-on-surface pair"; "The POS shell stays
dark in BOTH themes"; "an arbitrary value like `bg-[#123456]` or `p-[57px]` in a component is a bug")
and `docs/design-system.md` sections 2, 9 and the `## 7b` section T-01 wrote.

**Invariants:** none directly — see below. This is a test file: no route (invariant 8, *permissions
enforced SERVER-side on every POS API route, reads included*, engaged by avoidance), no cookie
(invariant 12, *sessions HttpOnly + Secure + SameSite, NEVER `localStorage`*, likewise). It enforces
`CLAUDE.md`'s "Design & UI" rules: every `--c-*` declared in the bare `:root`; the POS chrome tokens
un-themed in both states; WCAG AA in both themes; no arbitrary Tailwind value or raw hex in any
component.

**Do:**

1. Create `src/lib/styles/tokens.test.ts` as a **UNIT** test in the existing `unit` Vitest project.
   Check `vitest.config.ts` before writing: the `unit` project is `environment: 'node'`, includes
   `src/**/*.test.ts` and excludes `src/**/*.integration.test.ts`. There is **NO jsdom, NO
   `@testing-library/svelte` and NO browser mode in this repository, and this task must not add
   one.** The test reads `src/lib/styles/tokens.css` as **TEXT** with `node:fs`
   (`readFileSync`), resolving the path from `import.meta.url` — the same approach
   `src/routes/route-guards.test.ts` already uses for file discovery.

2. **Parse the three declaration regions** out of the file:
   - the bare `:root { … }`,
   - the `@media (prefers-color-scheme: dark)` block (whose inner selector is
     `:root:not([data-theme="light"])`),
   - the `:root[data-theme="dark"] { … }` block.
   From each, extract the `--c-*: value` pairs. Build `light` from the bare `:root`, and build the
   dark palette as `{ ...bareRoot, ...darkThemeBlock }` so tokens the dark block does not redeclare
   (the POS chrome, and T-02's two derived tokens) fall through from the bare `:root` exactly as the
   cascade would resolve them.

3. **Assert every `--c-*` declared in EITHER dark block also exists in the bare `:root`.** A token
   defined only inside a media or `[data-theme]` block is invisible in the un-stamped state, which
   renders one theme's text on the other theme's ground. Name that consequence in the failure
   message.

4. **Assert the two dark blocks declare the SAME set of token names.** They are meant to be identical
   palettes reached by two different selectors; a token added to one and forgotten in the other is a
   silent half-themed page. Compare the name sets in both directions and report which names are
   missing from which block.

5. **Assert the four POS chrome tokens `--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink`
   appear in the bare `:root` and in NEITHER dark block.** The POS shell is a device surface, not
   page chrome, and stays dark in both themes.

6. **Implement the WCAG relative-luminance contrast function inline** — no dependency:
   - parse `#rgb` and `#rrggbb` into 0–255 channels;
   - linearise each channel `c` as `s = c / 255`, then `s <= 0.03928 ? s / 12.92 :
     ((s + 0.055) / 1.055) ** 2.4`;
   - `L = 0.2126·R + 0.7152·G + 0.0722·B` over those linearised values;
   - `ratio = (L_lighter + 0.05) / (L_darker + 0.05)`.
   Resolve `var(--c-x)` indirections **one level deep** against the palette map being tested, so
   `--c-ring` (→ `--c-accent`) and `--c-control-line` (→ `--c-ink-3`) evaluate in each theme.

7. **Assert the LEGAL pairs from the `## 7b` section T-01 wrote meet 4.5:1 in BOTH themes.** At
   minimum:
   - `ink` on each of `bg`, `bg-2`, `raise`, `raise-2`;
   - `ink-2` on each of those four;
   - `ink-3` on `raise` **ONLY** (raise only: it is the one surface where ink-3 clears 4.5:1 in both
     themes (5.13 light, 4.87 dark); light raise-2 passes at 4.76 but dark raise-2 is 4.25, so
     asserting it would fail);
   - `accent`, `ok`, `warn`, `danger` on `bg` and `raise`;
   - all six `st-*` colours (`st-new`, `st-sent`, `st-voided`, `st-billed`, `st-paid`, `st-offline`)
     on `bg` and `raise`;
   - `accent-ink` on `accent`.
   Put the measured ratio in the assertion message so a failure says *what* it measured, not just
   that it failed.

8. **Assert the non-text pairs meet 3:1** (WCAG 1.4.11, UI component boundaries and focus
   indicators): `control-line` on `raise` and on `bg`, and `ring` on `bg` and on `raise`, in both
   themes.

9. **Add a test that scans every `.svelte` file under `src/`** — discovered by walking the directory
   recursively, never a hard-coded list, so files added later are covered automatically — and asserts
   none contains an arbitrary Tailwind value (`[#`, or a bracketed px value such as `p-[57px]`) or a
   raw six-digit hex (`#rrggbb`). This property is **TRUE at plan time**: the same scan over
   `src/**/*.svelte` returns no matches today. The test locks it in. If it fails later, the fix is to
   add a token to `src/lib/styles/tokens.css`, never to loosen the regex.

**Tests:** this task **IS** the tests. It is **not** one of spec 29's six mandatory areas — spec 29
names money arithmetic and rounding, tax in both modes, journal entries balancing, one posting rule
per business event, offline sync retries never duplicating, and a permission check per POS API route,
and none of them is this. Stated explicitly so a reader does not mark it `MANDATORY` by analogy with
`src/routes/route-guards.test.ts`, which genuinely is one.

**Done when:**
- `pnpm test:unit` passes, with `src/lib/styles/tokens.test.ts` reported as a run file.
- Temporarily deleting one `--c-*` declaration from the bare `:root` makes the suite fail; restore it
  with `git checkout -- src/lib/styles/tokens.css` afterwards.
- Temporarily changing `--c-ink-3` to a lighter value (for example `#9aa4ad`) makes a contrast
  assertion fail; restore it with `git checkout -- src/lib/styles/tokens.css` afterwards.
- `pnpm check` and `pnpm lint` both exit 0.
- `git status` is clean apart from the new test file — the two probes above must leave no residue.

**Watch out:**
- **If a pair you were told is legal FAILS, STOP and report it — do NOT fix it by editing a colour
  value.** `00-overview.md` records that palette re-tuning is a decision the user deferred.
- **Do not assert on the known-failing pairs.** The grammar forbids using them, so pinning them with
  a test would merely freeze a defect in place and make the eventual palette fix look like a
  regression.
- **Strip `/* … */` comments before parsing.** The file's header comment names all three selectors in
  prose — `bare :root`, `:root:not([data-theme="light"])`, `:root[data-theme="dark"]` — and also
  writes `--c-*` and `var(--c-bg)`. A naive `indexOf(':root')` finds the comment, not the rule, and a
  naive token regex harvests the comment's example names.
- **Balance braces when extracting the media block.** The dark media query wraps a second selector,
  so its closing `}` is the second one, not the first. Stopping at the first `}` truncates the
  palette and the test then passes against almost nothing.
- **Parse by `;`-terminated declaration, not by line.** The palette packs several declarations onto
  one line (`--c-bg:#e9edf0; --c-bg-2:#dfe5e9; --c-raise:#ffffff; …`), so a line-based parser sees one
  token per line and silently misses most of them.
- **Skip non-colour values in the contrast helper.** `--c-shadow` holds a full box-shadow value with
  commas, parentheses and `rgb(… / .8)`; it is a `--c-*` token and will be in the map, but it is not a
  hex and must never be fed to the luminance function. `color-scheme: light;` also sits inside
  `:root` and is not a `--c-*` declaration at all.
