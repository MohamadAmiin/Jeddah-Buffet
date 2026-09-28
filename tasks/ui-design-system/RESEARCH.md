# Research — the matcami UI design system

Findings are evidence, not decisions. Every entry records where it came from and when it was checked.
Nothing here silently overrides `docs/spec.md` or `CLAUDE.md`.

Where a finding came from **computation**, the formula is stated so a future session can recompute it
rather than trust this file. Where it came from an **installed package**, the path is given so it can
be re-read rather than re-googled — the package on disk is better evidence than the documentation.

---

## Q: Does `docs/spec.md` constrain the UI at all?

- **Source:** `grep -ci <word> docs/spec.md` over the whole specification — run 2026-09-14.
- **Says:** `font` 0 · `color` 0 · `colour` 0 · `typograph` 0 · `WCAG` 0 · `accessib` 0 · `contrast` 0
  · `layout` 0 · `resolution` 0 · `touch` 0. Only `screen` 5, `tablet` 1, `design` 1. A control grep
  (`grep -c 'the'`) returns 130, so the file was genuinely searched.
- **The two exceptions**, both of which DO reach the screen:
  - spec 6, line 68, under *Protecting unsynced data*: **"The number of unsynced operations is always
    visible on screen."** This is the only UI rule the specification actually mandates.
  - spec 11: receipts are ESC/POS, **32 or 48 fixed characters**, no colour, reprints marked `COPY`.
- **Affects the plan:** **no task may cite a spec section for a design rule** — there is no design
  text to cite. The authorities are `CLAUDE.md`'s "Design & UI" section, `docs/design-system.md`, and
  WCAG success criteria by number. T-13 quotes spec 6 line 68 directly, because it is the one rule
  with real specification backing.
- **GAP — surfaced to the user 2026-09-14 and ANSWERED.** Because the spec is silent, nothing said
  whether `docs/design-system.md` is normative, or what happens when it and `CLAUDE.md` disagree.
  The user's decision, recorded by **T-01**: design-system.md **is normative for UI** and is
  **subordinate to CLAUDE.md's twelve invariants**. Not a conflict with the spec — the spec has no
  position to conflict with.

---

## Q: Which theme namespaces does Tailwind v4.3.3 recognise, and does it ship its own defaults?

- **Source:** the installed package — `node_modules/tailwindcss/dist/lib.js` and
  `node_modules/tailwindcss/theme.css`, version confirmed `4.3.3` from its own `package.json`.
  Read 2026-09-14.
- **Says — the namespaces:** `--color` `--font` `--text` `--font-weight` `--tracking` `--leading`
  `--breakpoint` `--container` `--spacing` `--radius` `--shadow` `--inset-shadow` `--drop-shadow`
  `--blur` `--perspective` `--aspect` `--ease` `--animate`.
- **Says — it ships defaults**, in `theme.css`: `--radius-xs` … `--radius-4xl` (397–404),
  `--text-xs` … `--text-9xl` each with a `--line-height` modifier (347–372),
  `--tracking-tighter` … `--tracking-widest` (384–389), `--leading-tight` … `--leading-loose`
  (391–395), `--shadow-2xs` … (406+), `--container-3xs` … `--container-7xl` (333–345).
- **Says — spacing is different:** `--spacing: 0.25rem` (line 325) is a single multiplier. Every
  spacing utility is *derived* from it at build time; there is no hardcoded spacing scale.
- **Affects the plan:** this is a defect nothing in the repo currently detects. `rounded-lg` and
  `text-3xl` in a component resolve to `node_modules/tailwindcss/theme.css`, **not** to
  `src/lib/styles/tokens.css` — a second source of size and type truth, which `CLAUDE.md` forbids
  ("the ONLY place a colour, size or type value is defined"). **T-11** bans the default-scale
  utilities in the four namespaces matcami redefines semantically (`text`, `radius`, `shadow`,
  `container`). It deliberately does **not** ban spacing utilities: `p-4` is computed from one
  token, so banning it would be dogma with no benefit. **T-10** states that reasoning inline so a
  later session does not "fix" the omission.

---

## Q: How many modifiers does `--text-<name>` accept in v4.3.3?

- **Source:** the compiled `node_modules/tailwindcss/dist/lib.js` — read 2026-09-14. The literal
  expression found:

  ```js
  e.resolveWith(a.value.value, ["--text"], ["--line-height", "--letter-spacing", "--font-weight"])
  ```

- **Says:** exactly three — `--text-<name>--line-height`, `--text-<name>--letter-spacing` and
  `--text-<name>--font-weight`. Tailwind's own defaults use only the first, which is why this is easy
  to miss.
- **Affects the plan:** this is the mechanism that makes **one class name a complete typographic
  role** rather than a bare size. **T-09** defines `--text-display`, `--text-title`, `--text-section`,
  `--text-body`, `--text-caption` and `--text-eyebrow`, each carrying its own size, line-height,
  letter-spacing and weight. That is how `docs/pos-layout-grammar.html` achieves its look by hand
  (`h1 { font-size: clamp(30px,5vw,46px); letter-spacing: -.02em; line-height: 1.08 }`), and moving
  it into tokens is what lets the app inherit that look instead of re-deriving it per component.

---

## Q: Which `@fontsource` packages exist, at what versions?

- **Source:** the npm registry, `npm view <package> version` — queried 2026-09-14. Independently
  re-verified on this date; the same answer was recorded during the previous plan.
- **Says:** `@fontsource-variable/archivo` **5.3.0** · `@fontsource-variable/ibm-plex-sans` **5.3.0**
  · `@fontsource/ibm-plex-mono` **5.3.0** · **`@fontsource-variable/ibm-plex-mono` does NOT exist** —
  IBM Plex Mono has no official variable font, so that name 404s at `pnpm add`.
- **Affects the plan:** nothing — **this is already done** on the base branch, with all three pinned
  exactly. Recorded here so a future session does not "fix" the asymmetry of two variable packages
  and one static one by reaching for a package that does not exist.

---

## Q: Do the current token pairs meet the AA floor `CLAUDE.md` calls non-negotiable?

- **Source:** direct computation from the hex values in `src/lib/styles/tokens.css` on the base
  branch, using the WCAG 2.x relative-luminance formula `docs/design-system.md` §9 itself quotes —
  `L = 0.2126·R + 0.7152·G + 0.0722·B` over linearised sRGB, `ratio = (L_lighter + 0.05) /
  (L_darker + 0.05)`. Computed 2026-09-14, over the full cross product of **14 surface tokens × 13
  ink tokens** in each theme.
- **Says — 30 failures below 4.5:1, not the 12 previously recorded.** The earlier census swept eight
  surfaces and omitted the six `--c-st-*-bg` grounds.
  - **Light, 12:** `--c-ink-3` `#646f7a` on `bg` 4.35, `bg-2` 4.03, `accent-soft` 4.29, `ok-bg` 4.33,
    `warn-bg` 4.38, `danger-bg` 4.23, and the six `st-*-bg` grounds 4.23–4.38.
  - **Dark, 18:** `ink-3`/`raise-2` 4.25 · `ok`/`raise-2` 4.18 · `danger`/`raise-2` 4.06 ·
    `ink-3`/`accent-soft` 4.39 · `ok`/`accent-soft` 4.31 · `danger`/`accent-soft` 4.19 ·
    `ink-3`/`st-new-bg` 3.98 · `ok`/`st-new-bg` 3.92 · `danger`/`st-new-bg` 3.81 ·
    `ink-3`/`st-sent-bg` 4.36 · `ok`/`st-sent-bg` 4.29 · `danger`/`st-sent-bg` 4.17 ·
    `danger`/`st-voided-bg` 4.43 · `danger`/`st-billed-bg` 4.39 · `ink-3`/`st-paid-bg` 4.36 ·
    `ok`/`st-paid-bg` 4.29 · `danger`/`st-paid-bg` 4.17 · `danger`/`st-offline-bg` 4.39.
- **Says — four values close all thirty**, solved against the WCAG AA floor of **4.5**:

  | | current | re-tuned |
  |---|---|---|
  | light `--c-ink-3` | `#646f7a` | `#5c6771` |
  | dark `--c-ink-3` | `#8a949d` | `#97a0a8` |
  | dark `--c-ok` | `#5aa06f` | `#6eac81` |
  | dark `--c-danger` | `#d97165` | `#df877c` |

  After those four edits the census returns **0 failures in both themes**. Tightest remaining pairs:
  light `ink-3`/`bg-2` = **4.5470**, dark `ok`/`st-new-bg` = **4.6157**.

  **A margin of ≥4.6 was attempted and does not hold, so no task may assert one.** Light `--c-ink-3`
  would have to darken one further step to `#5c6670` (4.6028 on `bg-2`) to clear it. `#5c6771` is the
  value the census was solved for and the value every task quotes; it clears the 4.5 floor
  `CLAUDE.md` calls non-negotiable, with 0.047 to spare. **T-07 must assert 4.5, not 4.6** — a 4.6
  floor invented for margin fails light `ink-3` on `bg-2` on a correct implementation.
- **Affects the plan:** **T-06** makes the four edits — in the bare `:root` *and* in **both** dark
  blocks, which are byte-identical duplicates. **T-07** then replaces the restricted legal-pair list
  in `src/lib/styles/tokens.test.ts` with the generated full cross product, and deletes the comment
  forbidding colour-value changes, which T-01 has superseded.
- **Not a conflict with the spec.** The spec has no accessibility text. `CLAUDE.md`'s "WCAG AA in
  both themes" is the rule being satisfied.

---

## Q: Does the POS shell satisfy that same floor?

> **SUPERSEDED BY DECISION, 2026-09-14 — kept because it is why the surface scope exists.** This
> section measured a POS shell **pinned dark in both themes**, which was the design when the question
> was asked. Later the same day the user reviewed a light-mode commercial POS reference and **reversed
> that rule**: the POS is a **light device surface, LIGHT IN BOTH THEMES**, and `[data-surface="pos"]`
> pins the **complete** palette — no dark block overrides any of it. The glare argument for a dark
> till — dark cuts counter glare and keeps the keys the brightest thing on screen — was raised once
> and **overruled**; it is a deliberate reversal, not an oversight. *(A second, intermediate draft
> said the POS was light but **followed the theme**, overriding grounds only. That is ALSO superseded
> — disproved by measurement the same day; see "Why the POS pins every token" below.)* Every ratio
> below was really measured and is recorded honestly, but the surfaces they were measured against
> (`--c-screen`, `--c-key`) **no longer exist**: they were retired when the scope took over the till's
> grounds. **Do not cite anything in this section as a live defect.** The two sections that follow
> carry the measurements that replaced it.

- **Source:** the same computation, applied to the tokens `docs/design-system.md` §3 and §6 assign to
  POS status and money, against the two shell surfaces `--c-screen` `#0f1215` and `--c-key`
  `#2a313a`. Computed 2026-09-14.
- **Says — in the LIGHT theme, 26 of 26 pairs failed.** The shell *was* pinned dark in both themes
  while every ink and status token inverted with the theme, so light-theme inks were dark ink on a
  dark ground. (Past tense throughout this section: see the banner above.)

  | token | on `--c-screen` | on `--c-key` |
  |---|---|---|
  | `--c-ink` | **1.08** | **1.32** |
  | `--c-ink-2` | **2.50** | **1.75** |
  | `--c-danger` | **2.83** | **1.98** |
  | `--c-st-offline` | **3.10** | **2.17** |

  The order total (`--text-total`, the most-read number in the product) would render at **1.08:1**,
  and spec 6 line 68's mandated unsynced count at **2.17:1**.
- **Says — the DARK theme is not clean either:** `--c-ink-3` 4.26, `--c-ok` 4.19 and `--c-danger`
  4.07 all fail on `--c-key`. And `--c-key-line` `#3a434e` on `--c-key` measures **1.31**, against
  WCAG 1.4.11's 3:1 floor for a component boundary — so two adjacent keys (Pay beside Void) have no
  discernible edge.
- **Says — there is no compliant token to reach for.** `tokens.css` offers exactly **one** on-dark ink
  (`--c-key-ink` `#e3e9ee`, 15.35 on screen / 10.73 on key) and **zero** on-dark status colours.
- **Affected the plan, and still does — but not in the way this section originally said.** The
  finding was **pre-existing**: the base branch neither introduced nor addressed it, because the POS
  surface was out of that plan's scope. It is the reason **T-03** exists at all, and the reason the
  answer took the shape of a *surface scope* — re-declaring the existing `--c-*` names inside
  `[data-surface="pos"]` so token names stay identical across surfaces and only their values differ.
  **That much survived the reversal.** What did not: T-03 was originally specified to solve on-dark
  values for every ink to ≥4.6 on both shell surfaces and to raise `--c-line` to `#737a81` for 3.02:1
  on `--c-key`. None of that is built now: the scope pins a **light** palette instead, and the two
  shell hexes are gone. What DID survive intact is the shape of the answer — a scope pinning the
  complete palette under the ordinary token names — and the reason: an ink and its ground must be
  decided together, on the same surface. **T-04** still extends the contrast guard from two palette
  states to three, and that is unchanged.
- **Correction, verified in a browser rather than reasoned about.** An earlier note here claimed
  `--c-ring: var(--c-accent)` and `--c-control-line: var(--c-ink-3)` would follow the POS scope
  automatically, because the test's `resolve()` follows `var()` indirection. **That was wrong, and it
  is wrong in an instructive direction.** A custom property's `var()` is substituted at
  **computed-value time on the element that declares it**; the resolved literal is what inherits.
  Measured with Playwright against the base branch's own `tokens.css`:

  | | `--c-accent` | `--c-ring` | |
  |---|---|---|---|
  | dark page, `:root` | `#5cb4c9` | `#5cb4c9` | correct — the dark block targets the **same element** |
  | inside `[data-surface="pos"]` | `#5cb4c9` | `#0f6b7e` | **wrong** — a `<div>` never recomputes an alias declared above it |

  So the **dark blocks are fine as they are** and must not gain copies (an existing test asserts they
  have none, and that test is correct), while the **POS scope must re-declare both** — which T-03
  does. The general rule is about the *element*, not the theme: re-declare an alias in any scope that
  overrides its source **on a different element**.

  The reason this matters beyond two lines of CSS: `resolve()` in `tokens.test.ts` models `var()`
  resolution **in text**, so it would report the intended value in both rows above. A contrast
  assertion routed through it cannot detect the failure. T-04's guard is therefore written as a
  **declaration check** — does the scope declare the alias — not as a contrast check.

---

## Q: What does the LIGHT POS surface measure — and what does a key need to be seen?

- **Source:** the same WCAG relative-luminance computation as the two sections above, applied to the
  implemented light POS palette in `/home/mohamed-amiin/Desktop/matcami/design/tokens.css`, which is
  the working implementation of the reversed design. Recomputed independently 2026-09-14 rather than
  copied; the formula is the one quoted two sections up, so a future session can re-derive every
  number here instead of trusting the file.
- **Says — the palette. The scope pins ALL of it, and there is exactly ONE POS state.** Grounds:
  `--c-bg:#e4e9ee` (deeper than the page's `#e9edf0`, which is the whole point) · `--c-bg-2:#e1e6eb` ·
  `--c-raise:#ffffff` (the key face) · `--c-raise-2:#f4f7f9` · `--c-line:#c8d1d8` ·
  `--c-line-soft:#dce3e8`. Inks: `--c-ink:#161b20` · `--c-ink-2:#4a5661` · `--c-ink-3:#5c6771`.
  Accent: `--c-accent:#0f6b7e` · `--c-accent-ink:#ffffff` · `--c-accent-soft:#ddeef2`. Semantic:
  `--c-ok:#2c6a48`/`--c-ok-bg:#e2efe7` · `--c-warn:#855a12`/`--c-warn-bg:#f7ecd8` ·
  `--c-danger:#a13a2e`/`--c-danger-bg:#f9e5e2`/`--c-danger-ink:#ffffff`. Plus the six `--c-st-*` and
  their six `--c-st-*-bg` at their light values, the `--c-ring` and `--c-control-line` aliases
  (re-declared because the scope is a `<div>`, not `:root`), and the three light shadow rungs.
  **No dark block overrides any of it**, so there is no POS dark palette to record here.
- **Says — the audit passes, and it passes against the RE-TUNED inks.** Over the same cross product
  used for the themed census (14 grounds × 13 inks): **182 pairs, 0 below 4.5:1.** Tightest is
  **4.60** (`ink-3` on `bg-2`). Note the dependency direction: light `--c-ink-3` `#5c6771` gives that
  4.60, while the **un-tuned** `#646f7a` measures **4.08** on the same ground. **The coupling that
  creates, and how the plan resolves it:** the scope pins LIGHT values and T-06 re-tunes the LIGHT
  palette, so the same token is declared twice and can drift. T-03 writes `#5c6771` into the scope
  directly (so the POS state is clean from the commit that creates it, with no window of failures),
  T-06 verifies the scope rather than editing it, and T-04's guard asserts the scope's three inks
  equal the bare `:root`'s post-re-tune light inks. There is **no** "the re-tune reaches the POS for
  free" — that sentence belonged to the superseded grounds-only draft and is false.
- **Says — the finding that changes how every POS control is built: a white key has no edge.**
  `--c-raise` `#ffffff` on `--c-bg` `#e4e9ee` measures **1.22:1**. WCAG **1.4.11** requires **3:1**
  for the boundary of a UI component, so **elevation alone cannot carry a key at any blur radius** —
  this is not a shadow that needs tuning, it is a ground/face relationship that cannot satisfy the
  criterion. `--c-control-line` (which aliases `--c-ink-3`) measures **4.73:1** on that ground, and
  `--c-line` measures **1.55:1** on the key face and **1.27:1** on the ground — legal for a divider,
  never for a control. **Every pressable surface on the POS therefore takes
  `border: 1px solid var(--c-control-line)`.** Non-text pairs are otherwise comfortable: `--c-ring`
  and `--c-control-line` clear the 3:1 floor against all 14 grounds in every state, tightest **4.60**
  (pos `control-line`/`bg-2`) and **4.63** (dark `control-line`/`st-new-bg`).
- **Says — the category bands, and a gap in them.** Menu keys carry a category colour instead of a
  photo — the user's choice, 2026-09-14 — so there is no image column in the schema, no image payload
  in the offline menu snapshot and nothing to invalidate on a menu-version bump. Six tokens declared
  in the bare `:root`: `--c-cat-grills:#8a4a2b` `--c-cat-rice:#7a5c12` `--c-cat-somali:#0f6b7e`
  `--c-cat-drinks:#3f5ba8` `--c-cat-sides:#5a4a80` `--c-cat-sweets:#8f3d63`. Against the **light** POS
  grounds they measure **5.02–7.70** (5.02–6.31 on `--c-bg`, 6.13–7.70 on the white key face), so the
  recorded "each clears 3:1 on the white key face" is correct — **in light**.
- **GAP — CLOSED AS MOOT by the pinning decision, and recorded rather than deleted.** While the POS
  still themed, this was an open question: the six bands are declared in the bare `:root` and in no
  dark block, so a dark-theme POS would have rendered the light band hexes on a dark key face at
  **1.85–2.33:1 on `--c-raise` `#252b33`** (all six) and 2.31–2.91:1 on `--c-bg`. **There is no
  dark-theme POS.** `[data-surface="pos"]` is pinned light in both themes, so a band only ever renders
  on the pinned-light device surface, where all six clear 3:1 (5.02–6.31 on `--c-bg`, 6.13–7.70 on the
  white key face). The recorded "each clears 3:1 on the white key face" is therefore correct without
  narrowing, and **no task adds dark values for them**. The question re-opens in exactly one case: if
  a `--c-cat-*` band is ever used on the **dashboard**, which does theme. No task in this plan does
  that, and a future one that wants to must surface the question again before declaring a band outside
  the POS scope. The reasoning that made the question genuinely arguable is kept for that day: a band
  is specified as **wayfinding, never a status, and never the only carrier** — the category name is
  always written beside it — and a purely decorative, redundant graphic is not a "graphical object
  required to understand the content" under WCAG 1.4.11.

---

## Q: Why does the POS pin EVERY token rather than just its grounds?

- **Source:** the design samples under `/home/mohamed-amiin/Desktop/matcami/design/`, opened by the
  user in a browser on a machine whose OS was set to dark mode — 2026-09-14 — and the same WCAG
  relative-luminance computation used throughout this file, applied to the dark-theme ink values
  against the POS's pinned white key face. Re-derived here rather than quoted, so a future session can
  check it: `--c-ink` `#e6eaec` has relative luminance 0.7947, `#ffffff` has 1.0, and
  `(1.0 + 0.05) / (0.7947 + 0.05)` = **1.21**.
- **Says — the observation first.** The POS samples, which had just been re-authored to pin the
  grounds light and let everything else follow the theme, **rendered dark**. That is the whole finding
  in one sentence: a scope that pins only part of a palette shows the viewer's theme in the part it
  did not pin.
- **Says — the measurement.** With the grounds pinned light and the inks left to the theme, a
  dark-mode viewer gets dark-theme ink on the pinned white key face `--c-raise` `#ffffff`:

  | token | dark-theme value | on `--c-raise` `#ffffff` | on `--c-bg` `#e4e9ee` |
  |---|---|---|---|
  | `--c-ink` | `#e6eaec` | **1.21** | **1.01** |
  | `--c-ink-2` | `#a8b3bc` | **2.13** | **1.75** |
  | `--c-ink-3` | `#97a0a8` | **2.65** | **2.17** |

  WCAG **1.4.3** wants **4.5:1**. `--c-ink` carries the order total — the most-read number in the
  product — at **1.21:1**, white on white.
- **Says — this is the SECOND time an ink/ground mismatch has been the defect in this design, and
  the two are the same bug mirrored.** The first (recorded two sections up) pinned the shell **dark**
  while the inks kept theming, and a light-theme viewer got `--c-ink` on `--c-screen` at **1.08:1** —
  black on black. The second pinned the **grounds light** while the inks kept theming, and a
  dark-theme viewer got **1.21:1** — white on white. Pinning half a palette fails in whichever
  direction the viewer's preference happens to point, and it fails **invisibly to whoever is
  reviewing**: each defect is undetectable on a machine set to the theme the reviewer happens to use.
- **Affects the plan — this is the rule, and it is stated wherever the scope is described:**
  **pinning a surface means pinning EVERY token on it, not just the grounds.** `[data-surface="pos"]`
  is **light in both themes** and declares the complete palette — grounds, the three inks, accent,
  the semantic colours, the six `--c-st-*` status colours with their six soft grounds, the `--c-ring`
  and `--c-control-line` aliases and the three shadow rungs — and **no dark block overrides any of
  it**. Concretely: **T-03** writes that block (including light `--c-ink-3` `#5c6771`, the re-tuned
  value); **T-04** asserts the scope's inks equal the bare `:root`'s post-re-tune light inks, so the
  two copies cannot drift; **T-06** verifies the block rather than editing it; **T-07** censuses three
  states — `light`, `dark`, `pos` — and never a fourth `pos-dark`; **T-10** pins the elevation rungs
  and the `--c-shadow` alias in the scope for the same reason; **T-12** writes the rule and both
  measurements into `docs/design-system.md` §2; **T-14** and **T-17** teach the two lenses to hunt for
  a half-pinned surface.
- **Not a conflict with the spec.** `docs/spec.md` has no UI or accessibility text at all. The rule
  being satisfied is `CLAUDE.md`'s "Design & UI" contrast floor and WCAG 1.4.3.

---

## Q: What is actually on the base branch, and has it been executed?

- **Source:** `git log --all --grep`, `git branch --contains`, `git worktree list`, `gh pr list`, and
  a direct run of `pnpm test:unit` in the sibling worktree under Node 24.21.0 — 2026-09-14.
- **Says:** `feat/dashboard-ui-redesign` is **21 commits (T-01…T-21)** on top of
  `feat/restaurant-identity-and-dashboard` (merge-base `cf41397`), checked out at
  `/home/mohamed-amiin/Desktop/matcami-dashboard-ui-redesign`, open as **PR #4**, **not merged to
  main**. `pnpm test:unit` reports **13 files, 247 tests, all passing**.
- **Says — already built there:** the three typefaces installed and pinned; `base.css` with
  `:focus-visible { outline: 2px solid var(--c-ring) }`, a `prefers-reduced-motion` block and
  `text-wrap: balance`; `--c-ring`, `--c-control-line`, `--radius-card`, `--radius-control`,
  `--container-page`; seven primitives plus `ThemeToggle` in `src/lib/components/ui/`; all six
  screens restyled; a cookie-backed theme stamped during SSR; and three guard-test files covering the
  token contract, bare-`:root` completeness, the two dark blocks agreeing, the POS chrome staying
  un-themed, contrast in both themes, arbitrary values, font delivery and the component boundary.
- **Says — deliberately NOT done there:** the palette re-tune. `tokens.test.ts` carries the reason in
  a comment above `TEXT_PAIRS`: *"The known failing pairs are deliberately NOT asserted: the grammar
  forbids using them… Palette re-tuning is a decision the user deferred."*
- **Affects the plan:** everything. This plan is a **stack on top of PR #4**, not a replacement for
  it — the branch is `feat/ui-design-system`, cut from `feat/dashboard-ui-redesign`. Every task
  targets files only that branch has. **PR #4 must merge before, or together with, this plan's PR.**

---

## Q: What sets the POS target hardware?

- **Source:** `docs/spec.md` §33, read in full — 2026-09-14.
- **Says:** decision 1 is *"How does the waiter enter orders with one POS device?"*, recommended
  default *"The waiter uses the shared POS at the counter; a tablet becomes a second registered
  terminal later"*, affecting *"Order flow, device count"*. **It says nothing about resolution or
  screen size.**
- **Affects the plan:** `docs/design-system.md` §10 currently asserts that decision 1 "sets the target
  resolution". That is an *inference*, not spec text, and a reasonable one — device count implies
  hardware — but it should not be read as a quotation. **This is the stated reason the plan documents
  the POS grammar (T-13) and builds no POS screen.**
- **GAP — NOT resolved here, and not resolvable by this plan.** Spec 33 decision 1 is still open. No
  task may pick a target resolution, a breakpoint set or a device orientation for the POS. T-13 says
  so explicitly at the top of the section it writes.
