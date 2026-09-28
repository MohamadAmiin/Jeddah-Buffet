# Phase 0 — Decisions and the document repair

Three design-authority decisions and four false documentation claims block every later phase: the
palette may not be re-tuned until the freeze is lifted in writing, the POS surface scope may not be
built until it supersedes the "four exempt tokens" wording it contradicts **and until CLAUDE.md's
"stays dark in BOTH themes" rule is rewritten rather than worked around**, and `docs/design-system.md`
cannot be extended while it still points at the wrong file for three of its own rules.

**T-01 now carries a REVERSAL, and that is the heaviest thing in this phase.** On 2026-09-14 the user
reviewed a light-mode commercial POS reference and reversed the pinned-dark POS shell: **the POS is a
LIGHT device surface in BOTH themes, and `[data-surface="pos"]` pins the COMPLETE palette** — grounds,
inks, accent, semantic and status colours, the two aliases and the shadow rungs — with **no dark block
overriding any of it**. The glare argument for a dark till — dark cuts counter glare and keeps the
keys the brightest thing on screen — was raised once and **overruled**. A rule in `CLAUDE.md` is
therefore being changed, not extended, and the record must say so.

**The sentence this phase exists to write into the rulebook: pinning a surface means pinning EVERY
token on it, not just the grounds.** *(Decision history, SUPERSEDED — do not write either of these as
current fact. The scope was first specified as pinned DARK in both themes, which put light-theme ink
on a permanently dark shell at **1.08:1**. It was then re-authored as light **but theme-following**,
overriding grounds only, which put dark-theme ink on the pinned white key face at **1.21:1** — the
same defect mirrored. The phrase "follows the theme" must not survive anywhere in this phase's output
as a description of the POS.)*

**Depends on:** the base branch only

Both tasks change Markdown only. No token, no colour value, no `.svelte` file, no test file and no
code of any kind is touched in this phase — `git diff --name-only` after T-02 must list exactly
`CLAUDE.md` and `docs/design-system.md` and nothing else.

---

### T-01 — Record the three design-authority decisions in CLAUDE.md and docs/design-system.md

**Needs:** -
**Files:**
- `CLAUDE.md` — EDIT (two places: the `## Design & UI` section, which runs from that heading to
  `## Commands & setup`; and the `## Decisions already made (NOT open — do not re-litigate)` section,
  which runs from that heading to `## Do NOT build`)
- `docs/design-system.md` — EDIT (insert a blockquote note immediately after the
  ``Visual reference: `docs/pos-layout-grammar.html` …`` paragraph near the top and before the `---`
  rule that precedes `## 1. Principles`. Do not touch any numbered section in this task)

**Spec:** none, and that is the point. `docs/spec.md` is SILENT on UI — verified by `grep -ci` over
the file: `font` 0, `color` 0, `colour` 0, `typograph` 0, `WCAG` 0, `accessib` 0, `contrast` 0,
`layout` 0, `resolution` 0, `touch` 0. The only spec text that reaches a screen is section 6's line
"The number of unsynced operations is always visible on screen." (`docs/spec.md` line 328, under
"Protecting unsynced data") and section 11's fixed-width ESC/POS receipts. **Never cite a spec
section for a design rule.** The one section this task legitimately names is spec 33 (the open
decisions table), for the decision-1 note in step 5.

**Invariants:** 5 (a completed offline sale is a recorded fact — the POS surface must keep working
with no network, so nothing this phase writes may imply a POS screen fetches anything), 1 (money is
integer minor units, rendered only by the money module's formatter — the UI never does money
arithmetic), 7 (each order line stores the unit price and tax rate used, and the screen shows what is
stored on the line, never a recomputed current price).

**Do:**

Every fenced block below is the LITERAL text to write. It is indented only to sit inside its
numbered step — paste it dedented to the left margin of the list it joins in the target file.

1. Read `CLAUDE.md`'s `## Design & UI` section before editing. On this branch it is a paragraph plus
   twelve bullets, beginning `Styling is **Tailwind CSS v4**`. If it has a different shape, stop and
   report — the repo is not in the state this plan assumed.

2. In `CLAUDE.md`, REPLACE the bullet that currently begins
   ``- **The POS shell stays dark in BOTH themes** (`--screen`, `--key`, `--key-ink`).`` **This is a
   REVERSAL, not a clarification.** That sentence is the rule the user overturned on 2026-09-14, so
   the words "stays dark in BOTH themes" must not survive anywhere in the replacement — a reader who
   greps CLAUDE.md for the old rule has to find the new one, not a softened version of the old one.
   Note also that the old bullet names three tokens without the `--c-` prefix while
   `src/lib/styles/tokens.css` actually declares four with it; the replacement stops naming them as
   live tokens at all, because Phase 1 retires them. Write exactly:

   ```markdown
   - **The POS shell is a SURFACE SCOPE, and it is LIGHT IN BOTH THEMES.** `src/routes/(pos)/` renders
     inside an element carrying `data-surface="pos"`, and `src/lib/styles/tokens.css` re-declares the
     ordinary `--c-*` names inside `[data-surface="pos"]` — the COMPLETE palette: the six grounds, the
     three inks, accent, the semantic colours, the six `--c-st-*` status colours with their six soft
     grounds, the `--c-ring` and `--c-control-line` aliases and the three shadow rungs, under
     `color-scheme: light`. **No dark block overrides any of it.** The till is a DEVICE: its surface is
     a property of the hardware on the counter, not of the viewer's OS preference — the dashboard
     themes, the POS does not. **Pinning a surface means pinning EVERY token on it, not just the
     grounds:** pin the grounds and let the inks theme, and a dark-mode viewer gets `--c-ink` `#e6eaec`
     on the white key face — **1.21:1**. Token names are the same on every surface and only their
     values differ, so `bg-raise text-ink` is correct on the dashboard AND inside the shell; a
     component never branches on surface. Beyond being light the scope carries the till's **ground/key
     relationship and its density**: the dashboard puts white cards on a light ground for reading,
     while the POS uses a **deeper ground so the white key faces read as the raised, pressable
     thing**.
   - **Every pressable surface on the POS carries `border-control-line`.** A white key face on the
     till's ground measures **1.22:1**, so elevation ALONE cannot carry a control's boundary. WCAG
     1.4.11 wants 3:1; `--c-control-line` measures 4.73:1 there. `border-line` (1.55:1 on the key
     face) is for decorative rules and non-interactive block edges only. A shadow-only key is pretty
     and non-compliant.
   ```

   **Why the replacement is two bullets and not one.** The border rule is not a detail of the scope —
   it is the consequence that makes the light till legal, and it is the rule most likely to be lost
   if it is buried in a sentence about token names. Keep them adjacent and in this order.

3. In `CLAUDE.md`, REPLACE the bullet that currently begins
   `- **Legal ink-on-surface pairs — both themes, no per-theme reasoning.**` with a rule that stays
   true before and after the palette is re-tuned. The existing bullet hardcodes the consequences of
   four un-tuned ink values (`text-ink-3` legal only on `bg-raise`; `text-ok`/`text-danger` never on
   `bg-raise-2` or `bg-accent-soft`), which decision (b) below exists to remove — leaving it would
   leave a stale prohibition in the rulebook with no task pointed at it. Write exactly:

   ```markdown
   - **Contrast is a COMPUTED census, not a remembered pair list.** `src/lib/styles/tokens.test.ts`
     measures every surface × ink pair by WCAG relative luminance in every surface state and fails
     the build below 4.5:1 for text (WCAG 1.4.3) or 3:1 for a control boundary or focus ring (WCAG
     1.4.11). A failing pair is fixed by RE-SOLVING the token's value and re-running the census —
     never by narrowing the rule, and never by deleting the pair from the list. Interactive control
     borders use `border-control-line`; `border-line` is decorative only.
   ```

4. In `CLAUDE.md`, EXTEND the final bullet of the section, which currently reads
   `- **WCAG AA (4.5:1) at normal text size, in both themes**, for every text-on-surface pair. Verify before adding a colour.`
   so it names all three surface states. Write exactly:

   ```markdown
   - **WCAG AA (4.5:1) at normal text size, in ALL THREE surface states** — light, dark, and
     `[data-surface="pos"]` — for every text-on-surface pair. Verify by computation before adding or
     changing a colour; a ratio that was eyeballed was not verified.
   ```

5. In `CLAUDE.md`'s `## Decisions already made (NOT open — do not re-litigate)` section: its lead
   sentence currently reads ``Settled by `tasks/restaurant-identity-and-dashboard`.`` — change it to
   ``Settled by `tasks/restaurant-identity-and-dashboard` and by `tasks/ui-design-system` (the three design-authority decisions, 2026-09-14).``
   then APPEND these three bullets after the existing five, keeping the existing five byte-for-byte:

   ```markdown
   - **`docs/design-system.md` is NORMATIVE for the UI, and subordinate to the twelve invariants
     above.** `docs/spec.md` says nothing about fonts, colour, contrast, typography, layout, touch or
     accessibility — each of those words appears ZERO times in it — so on UI there is nothing for the
     spec to outrank. The authority chain for anything on a screen is: the twelve invariants → this
     "Design & UI" section → `docs/design-system.md`. A UI rule attributed to a spec section is a
     fabricated citation. A design question the spec does not answer is an OPEN DECISION under the
     rule above — surface it, state the default, ask — not a gap to fill silently. (2026-09-14)
   - **The palette freeze is LIFTED.** The previous plan recorded that "No task may fix a failing pair
     by editing a hex value — the user deferred palette work, and re-tuning it is their decision".
     That deferral is over: colour VALUES in `src/lib/styles/tokens.css` may now be re-tuned. The gate
     is computed, not visual — the contrast census in `src/lib/styles/tokens.test.ts` — and the repair
     for a failing pair is to re-solve the value and re-run the census, never to drop the pair.
     (2026-09-14)
   - **The POS shell is a SURFACE SCOPE, not an exemption list — and it is LIGHT IN BOTH THEMES.** It
     is `[data-surface="pos"]` in `src/lib/styles/tokens.css`, re-declaring the ordinary `--c-*` names
     with the COMPLETE device palette — a deeper `--c-bg` than the page, a white `--c-raise` key face,
     plus every ink, the accent, the semantic and `--c-st-*` status colours, the `--c-ring` and
     `--c-control-line` aliases and the three shadow rungs — with **no dark block overriding any of
     it**, so components stay portable across surfaces. The till is a device; the dashboard themes and
     the POS does not. This SUPERSEDES `docs/design-system.md` section 2's "The POS terminal chrome is
     exempt" paragraph. **Recorded as a reversal, twice over:** the shell was specified earlier the
     same day as *pinned dark in both themes* — the operational argument for that, dark cuts counter
     glare and keeps the keys the brightest thing on screen, was raised and **overruled** after the
     user reviewed a light-mode commercial POS reference — and the first light draft then pinned only
     the GROUNDS, which put dark-theme ink on the white key face at **1.21:1**, the same defect
     mirrored. Hence the rule in one sentence: **pinning a surface means pinning every token on it.**
     Two further consequences are part of the decision, not tidying after it: the four device-chrome
     tokens `--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink` lose their last consumer and are
     **retired**, and because a white key on the till's ground measures only **1.22:1**, every
     pressable POS surface must carry a `--c-control-line` border (4.73:1) rather than relying on
     elevation — WCAG 1.4.11. (2026-09-14)
   - **Menu keys carry a category BAND, not a photo.** Six wayfinding tokens (`--c-cat-grills`,
     `--c-cat-rice`, `--c-cat-somali`, `--c-cat-drinks`, `--c-cat-sides`, `--c-cat-sweets`), each
     clearing 3:1 on the white key face. A band is **never a status and never the only carrier** —
     the category name is always written beside it (WCAG 1.4.1). The consequence that reaches past
     CSS, and the reason this is a recorded decision rather than a stylesheet detail: **no image
     column in the menu schema, no image payload in the offline menu snapshot, and nothing to
     invalidate when the menu version bumps.** (2026-09-14)
   ```

6. In `docs/design-system.md`, INSERT this blockquote after the `Visual reference:` paragraph and
   before the `---` that precedes `## 1. Principles`. Write exactly:

   ```markdown
   > **Authority.** This document is NORMATIVE for the matcami UI, and subordinate to CLAUDE.md's
   > twelve invariants. `docs/spec.md` — the signed-off authority that outranks CLAUDE.md everywhere
   > else — says nothing about UI: `font`, `color`, `colour`, `typograph`, `WCAG`, `accessib`,
   > `contrast`, `layout`, `resolution` and `touch` each appear **zero** times in it. The only spec
   > text that reaches a screen is section 6's "The number of unsynced operations is always visible on
   > screen." and section 11's fixed-width ESC/POS receipts. **Never cite a spec section for a design
   > rule** — cite CLAUDE.md's "Design & UI" section, this document, or a WCAG success criterion by
   > number. A design question the spec does not answer is an open decision under CLAUDE.md's rule.
   >
   > **Decided 2026-09-14.** (a) This document's status, above. (b) The palette freeze recorded by the
   > previous plan is LIFTED: colour VALUES in `src/lib/styles/tokens.css` may change, gated by a
   > computed contrast census rather than by eye, and a failing pair is repaired at the value, never
   > by narrowing the rule. (c) The POS shell is a SURFACE SCOPE — `[data-surface="pos"]`, which is
   > **LIGHT IN BOTH THEMES** and re-declares the ordinary `--c-*` names with the COMPLETE device
   > palette — not a list of four exempt token names, which **supersedes section 2's "The POS terminal
   > chrome is exempt" paragraph.**
   >
   > **(c) is a REVERSAL, recorded as one — and it flipped twice.** Earlier the same day the scope was
   > specified as a shell *pinned dark in both themes*, and CLAUDE.md still carried that as a rule.
   > After reviewing a light-mode commercial POS reference the user reversed it to LIGHT; the
   > operational argument for a dark till — dark cuts counter glare and keeps the keys the brightest
   > thing on screen — was raised once and **overruled**. The first light draft then pinned only the
   > grounds and let the inks theme, and measurement killed that too: on a dark-mode OS the shell
   > painted `--c-ink` `#e6eaec` on the white key face, **1.21:1**, the pinned-dark defect mirrored.
   > **The rule that stands, and the lesson with it: pinning a surface means pinning EVERY token on
   > it, not just the grounds.** So `[data-surface="pos"]` declares grounds, inks, accent, the
   > semantic and `--c-st-*` status colours with their soft grounds, the `--c-ring` and
   > `--c-control-line` aliases and the three shadow rungs, under `color-scheme: light`, and **no dark
   > block overrides any of it**. What the scope adds beyond being light is the till's **ground/key
   > relationship and its density**: a deeper ground than the page, so the white key face reads as the
   > raised, pressable thing. Two consequences are part of the decision rather than tidying after it —
   > the four device-chrome tokens `--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink` lose their
   > last consumer and are **retired**, and because a white key on that ground measures only
   > **1.22:1**, every pressable POS surface takes a `--c-control-line` border (4.73:1) instead of
   > relying on elevation (WCAG 1.4.11).
   >
   > **Still open:** spec 33 decision 1 — one shared POS device at the counter, or a tablet registered
   > as terminal 2 later — is UNANSWERED, and it is what sets the target hardware, and therefore the
   > target resolution and physical target sizes. That is why section 7 records the POS layout grammar
   > as CONTRACTS and no POS screen is built against it.
   ```

7. Do NOT edit `docs/design-system.md` section 2 in this task, even though step 6 declares it
   superseded. Section 2 is rewritten later in this plan; editing it twice makes the later diff
   unreadable. Same for sections 4, 5, 7, 7b and 9.

8. Change no colour value, no token name and no file under `src/` in this task.

**Tests:**
- No new test. This task changes two Markdown documents and no code. The repo's tests are node-side
  and read files as TEXT: `vitest.config.ts` sets `environment: 'node'` with `include:
  ['src/**/*.test.ts']`, and there is no jsdom, no browser mode, no `@testing-library/svelte` and no
  Svelte plugin — a `.svelte` file cannot be mounted in a test here, and a `docs/` file is not in the
  `include` glob at all.
- House guard test (CLAUDE.md "Design & UI") already present and must stay green:
  `pnpm test:unit` still reports 13 files and 247 passing tests. A changed count means something
  other than documentation was edited.
- Verification greps, with their expected output:
  - `sed -n '/^## Design & UI/,/^## Commands & setup/p' CLAUDE.md | grep -o 'spec [0-9]\+' | sort -u`
    → exactly two lines, `spec 11` and `spec 6`. Any third number is a design rule citing the spec.
  - `grep -c 'data-surface="pos"' CLAUDE.md` → at least `2` (the replaced bullet and the new
    decision bullet).
  - `grep -c 'data-surface="pos"' docs/design-system.md` → at least `1`.
  - ``grep -cF '`text-ink-3` is legal ONLY' CLAUDE.md`` → `0`; the hardcoded pair prohibition is
    gone.
  - **The reversal greps — these are the ones that prove step 2 changed the rule instead of softening
    it.** `grep -cF 'stays dark in BOTH themes' CLAUDE.md` → `0`, and the same grep over
    `docs/design-system.md` → `0`. `grep -cF 'LIGHT IN BOTH THEMES' CLAUDE.md` → at least `1`.
    ``grep -cF 'border-control-line' CLAUDE.md`` → at least `1` (the new POS boundary bullet; the
    contrast-census bullet in step 3 names it too, so `2` is also correct).
  - **The greps that prove the superseded LIGHT-BUT-THEMED draft did not survive either.**
    `grep -cF 'FOLLOWS THE THEME' CLAUDE.md` → `0`. Then `grep -nF 'follows the theme' CLAUDE.md` →
    **exactly one line**, and it must be the `@theme inline` sentence about a Tailwind utility
    (``…`inline` emits `var(--c-bg)` so the utility follows the theme``), which is a true statement
    about utilities and nothing to do with the POS. A second hit means the POS rule was softened back
    into the draft wording. Same check on `docs/design-system.md`:
    `grep -ciF 'follows the theme' docs/design-system.md` must not increase by this task.
  - `grep -cF '1.22:1' CLAUDE.md` → at least `1`. If the border bullet landed without its measured
    ratio, the rule reads as taste rather than as WCAG 1.4.11.
  - `grep -cF '1.21:1' CLAUDE.md` → at least `1`. That is the measured mirrored defect
    (`--c-ink` `#e6eaec` on `--c-raise` `#ffffff`) and it is what makes "pin every token, not just the
    grounds" a finding rather than a preference. If it is missing, step 2's bullet was trimmed.

**Done when:** `git diff --name-only` lists exactly `CLAUDE.md` and `docs/design-system.md`;
`git diff CLAUDE.md` shows hunks only inside the `## Design & UI` and
`## Decisions already made` sections and nowhere else; `git diff docs/design-system.md` shows one
added blockquote and no change to any `## <n>.` section; and `pnpm lint && pnpm check && pnpm test:unit`
all pass.

**Watch out:**
- **The rulebook deliberately leads the code in this one phase.** `[data-surface="pos"]` and the
  three-state census do not exist in `src/` yet — later tasks in this plan build them. Do NOT "fix"
  the mismatch by writing tokens or tests here, and do NOT soften the wording into a future tense
  that reads like a proposal. A decision that is recorded as a plan is a decision nobody can cite.
- **The four device-chrome tokens are retired in PHASE 1, not here.** This task stops describing
  `--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink` as live rules in `CLAUDE.md`; it must not
  delete them from `src/lib/styles/tokens.css`, and it must not touch the existing
  `keeps the POS chrome un-themed` test. Both belong to the task that adds the scope, for the same
  reason the rest of this phase writes no code. If the mismatch feels wrong while you are in the
  file, that feeling is the phase working as designed.
- **Do not re-argue the glare question.** It was raised and overruled on 2026-09-14 by the person who
  owns the decision. Record it as overruled — that is why the wording above says so explicitly — and
  do not add a hedge, a "revisit later", or a note recommending a dark option. A reversal that reads
  as reluctant invites the next session to reverse it back.
- **Do not soften "light in both themes" back into "light, and it follows the theme".** That was a
  real draft of this rule and it was disproved by measurement: pinning the grounds while the inks
  theme gives a dark-mode viewer `--c-ink` `#e6eaec` on the white key face, **1.21:1**. The whole
  finding is one sentence — **pinning a surface means pinning EVERY token on it, not just the
  grounds** — and it must appear in the text you write, not only in this plan. Equally, do not write
  a nested `[data-surface="pos"]` rule inside a dark block anywhere in `CLAUDE.md`'s examples: the
  scope has no dark variant.
- `docs/`, `CLAUDE.md`, `tasks/` and `.claude/` are all listed in `.prettierignore` (read its comment
  block for why: `docs/spec.md` is signed off and CLAUDE.md diffs must stay confined to one section).
  So `pnpm format` will NOT reflow these edits and `prettier --check .` will not complain about them —
  formatting them correctly is your job, not the formatter's.
- The quoted deferral wording in step 5 comes from `tasks/dashboard-ui-redesign/00-overview.md`.
  `tasks/` is gitignored, so a fresh worktree may not contain that directory — the sentence is quoted
  here so you never need to open it. Do not add a cross-reference that sends a reader to a file that
  may be absent.
- Do not renumber, reorder or reword the five existing bullets in "Decisions already made". They were
  settled by an earlier plan and changing one is a new decision, not an edit.
- Nothing in this phase adds a database column, a migration, a `+server.ts`, a form action or a
  permission key. If a step seems to need one, that is a finding to report, not a thing to add.

---

### T-02 — Repair the four false claims in docs/design-system.md

**Needs:** -
**Files:**
- `docs/design-system.md` — EDIT (three places: section `## 4. Typography`, its last paragraph;
  section `## 5. Touch targets`, the table header; section `## 9. Accessibility floor`, two bullets
  in the list)

**Spec:** none — `docs/spec.md` is silent on UI (see T-01's Spec line). Every claim repaired here is
a claim about THIS repo's own files, verified by reading them. Cite WCAG by success criterion number:
2.3.3 (animation from interactions / reduced motion) and 2.4.7 (focus visible).

**Invariants:** none of the twelve is engaged, and that is stated rather than a number being reached
for. This task changes prose only — no token, no component, no server code. Money stays out of the
diff entirely: `src/lib/server/money/` holds only a `README.md`, so there is no formatter to cite and
no figure to render (money is integer minor units and the UI never does money arithmetic). No rule
about offline behaviour, permissions or per-line price snapshots is touched.

**Do:**

Every fenced block below is the LITERAL text to write. It is indented only to sit inside its
numbered step — paste it dedented to the left margin of the list it joins in the target file.

1. Verify each claim against the code BEFORE rewriting it, in this order. Expected results on this
   branch:
   - `grep -n 'prefers-reduced-motion' src/lib/styles/tokens.css src/lib/styles/base.css` → matches in
     `base.css` ONLY, inside its `@layer base` block: a `@media (prefers-reduced-motion: reduce)` rule
     setting `animation-duration: 0.01ms`, `animation-iteration-count: 1`,
     `transition-duration: 0.01ms` and `scroll-behavior: auto` on `*`, `*::before`, `*::after`.
   - `grep -n 'text-wrap' src/lib/styles/base.css` → `text-wrap: balance` on `h1, h2, h3, h4` and
     `text-wrap: pretty` on `p`.
   - `grep -n 'focus-visible' src/lib/styles/base.css` → `:focus-visible { outline: 2px solid
     var(--c-ring); outline-offset: 2px }`, one global rule, not a per-component one. The file's
     header comment forbids `outline: none` anywhere.
   - `grep -c 'base.css' docs/design-system.md` → `0` today. After this task it must be at least `3`.
   If any of these differs, stop and report rather than writing a sentence that is false in a
   different direction.

2. Section 9 — the bullet ``- `prefers-reduced-motion` is honoured (already in `tokens.css`).`` is
   FALSE about the file (it is `base.css`) and about the history (it arrived with this branch, not
   with the token file). Replace it with:

   ```markdown
   - `prefers-reduced-motion: reduce` is honoured — implemented once in `src/lib/styles/base.css`
     (NOT in `tokens.css`), zeroing animation and transition durations for `*`, `*::before` and
     `*::after`. WCAG 2.3.3.
   ```

3. Section 9 — the bullet ``- Every interactive element has a visible `:focus-visible` state.`` is
   true only because one global rule makes it true, and a reader who believes it is per-component will
   "add" focus rings that already exist or remove the one that does the work. Replace it with:

   ```markdown
   - Every interactive element has a visible focus state, inherited rather than per-component:
     `src/lib/styles/base.css` sets `:focus-visible { outline: 2px solid var(--c-ring);
     outline-offset: 2px }` globally. `outline: none` is forbidden anywhere in the codebase — remove a
     focus ring only by replacing it. WCAG 2.4.7.
   ```

4. Section 4 — the sentence ``Headings get `text-wrap: balance`.`` at the end of the last paragraph
   names no file, so it reads as an aspiration. Replace that sentence with:

   ```markdown
   Headings get `text-wrap: balance` and body paragraphs get `text-wrap: pretty` — both set once on
   `h1, h2, h3, h4` and `p` in `src/lib/styles/base.css`, never per-component.
   ```

   Leave the rest of that paragraph (the `text-pos` and `text-total` sentences) unchanged.

5. Section 5 — the table emits TWO header rows, so it renders broken: a three-column header wins and
   the four-column body rows are mangled. It currently reads:

   ```markdown
   | Token | Size | Use |
   |---|---|---|
   | Token | Utility | Size | Use |
   |---|---|---|---|
   ```

   DELETE THE FIRST TWO LINES — the three-column header and its separator — keeping the four-column
   header, its separator and all four body rows. The repaired table is exactly:

   ```markdown
   | Token | Utility | Size | Use |
   |---|---|---|---|
   | `--spacing-touch-min` | `p-touch-min`, `min-h-touch-min` | 56px | absolute floor anywhere on the POS (~10mm) |
   | `--spacing-touch` | `p-touch` | 64px | standard POS target |
   | `--spacing-touch-lg` | `min-h-touch-lg` | 72px | menu keys, function rail |
   | `--spacing-touch-xl` | `min-h-touch-xl` | 96px | **Pay**, **Send to kitchen** — the one-touch closers |
   ```

   Note the one body-cell change, and make only this one: the `--spacing-touch` row's Use cell loses
   the clause `— **set by T-04, already in use**`. That `T-04` is a task ID from a DIFFERENT plan; this
   plan also has a T-04 meaning something entirely unrelated, and an unqualified task ID in a document
   that outlives both plans is a booby trap. The other three rows are retyped byte-for-byte.

6. Repair nothing else in this task. In particular leave alone:
   - section 9's first bullet, including its trailing ``Verified values are noted in `tokens.css`.``;
   - section 2's "The POS terminal chrome is exempt" paragraph;
   - section 7 and 7b in their entirety, including the legal-pairs and measured-failures tables.
   Each is rewritten by a later task in this plan, and editing it twice makes that diff unreadable.

7. Change no colour value, no token, no `.svelte` file and nothing under `src/`.

**Tests:**
- No new test, and none is possible here: `vitest.config.ts` runs `environment: 'node'` over
  `include: ['src/**/*.test.ts']`, so a file under `docs/` is outside every test project; there is no
  jsdom, no browser mode, no `@testing-library/svelte` and no Svelte plugin, so nothing renders.
- House guard test (CLAUDE.md "Design & UI") already present and must stay green: `pnpm test:unit`
  still reports 13 files and 247 passing tests, unchanged.
- Verification greps, with their expected output:
  - ``grep -cF 'already in `tokens.css`' docs/design-system.md`` → `0`.
  - `grep -c 'base.css' docs/design-system.md` → `3` or more.
  - `sed -n '/^## 5\. Touch targets/,/^---$/p' docs/design-system.md | grep -c '^| Token'` → `1`
    (it is `2` before this task — that is the defect).
  - `sed -n '/^## 5\. Touch targets/,/^---$/p' docs/design-system.md | grep -c '^|'` → `6`
    (one header, one separator, four body rows; it is `8` before this task).
  - `grep -c 'set by T-04' docs/design-system.md` → `0`.

**Done when:** `git diff --name-only` lists exactly `docs/design-system.md`; the five greps above
return the stated values; the section 5 table renders as a single four-column table in a Markdown
preview; and `pnpm lint && pnpm check && pnpm test:unit` all pass.

**Watch out:**
- **`docs/` is in `.prettierignore`.** No formatter will reformat your edit and no formatter would
  ever have caught the duplicated header row — which is exactly why a broken table survived into a
  merged branch and why this repair is a task rather than a `pnpm format`. Check the rendered Markdown
  by eye.
- The duplicated header is the FIRST of the two header rows. Deleting the second one instead leaves a
  three-column header over four-column rows — the same defect, harder to spot.
- Do not "helpfully" also correct section 9's ``Verified values are noted in `tokens.css`.`` or
  section 2's exemption paragraph. Both are owned by a later task in this plan; a second edit to the
  same lines turns that task's diff into a merge puzzle.
- T-01 also edits `docs/design-system.md`, in a different region: a blockquote near the top, above
  `## 1. Principles`. The two diffs must not overlap. If the blockquote is missing when you open the
  file, T-01 has not run — report that rather than writing it yourself.
- This is a documentation-truth task, not a rewrite. Every sentence you write must be checkable
  against a file you just grepped — if a claim cannot be verified by a command, do not write it.
