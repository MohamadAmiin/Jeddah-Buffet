# Phase 5 — Skill and verification enforcement

This phase makes the design rules the rest of the plan wrote **survive the next feature**: a sixth
planning lens that hunts design and accessibility defects before a plan is approved, its dispatch
wired into the code that actually spawns the lens agents, the design obligations added to the task
output contract, and a sixth verification lens that reads a finished diff for the same defects.
Nothing here touches `src/`.

**Depends on:** Phase 4

Every file in this phase lives under `.claude/skills/**`. Two consequences, true for all four tasks:
`.prettierignore` lists `.claude/` and ESLint lints only `.ts`/`.js`/`.svelte`, so **neither half of
`pnpm lint` reads these files** — alignment and wrapping are hand-maintained, and `pnpm format` will
not fix them. And `vitest.config.ts` defines two projects whose `include` globs are
`src/**/*.test.ts` and `src/**/*.integration.test.ts`, so **no Vitest test covers these files**; each
task below verifies itself with shell assertions instead, and none of them may change the test counts.

---

### T-14 — Write the design lens brief

**Needs:** T-12 (docs/design-system.md sections 2, 4 and 9 rewritten around the surface scope and the
type roles), T-13 (docs/design-system.md section 7 rewritten as POS component contracts)
**Files:**
- `.claude/skills/plan-feature/references/lenses/design.md` — NEW (the directory already holds
  `accounting.md`, `data-model.md`, `offline-sync.md`, `ops-migration.md`, `permissions.md`; this is
  the sixth file beside them)

**Spec:** none for any design rule. `docs/spec.md` is **silent on UI** — `grep -ci` over it returns 0
for font, color, colour, typograph, WCAG, accessib, contrast, layout, resolution and touch. The only
two spec texts that reach a screen are **spec 6** ("The number of unsynced operations is always
visible on screen") and **spec 11** (ESC/POS receipts at a fixed 32 or 48 characters). **Spec 33**
open decision 1 (one shared POS device, or a tablet as a second registered terminal later) is
unanswered and is the only spec text bearing on target hardware.
**Invariants:** 1 (money is integer minor units — the UI never formats, divides or rounds money),
5 (a completed offline sale is a recorded fact; the POS surface must keep working with no network),
7 (each order line snapshots the unit price and tax rate it was sold at, so a rendered line shows
what it stored — never today's menu price), 8 (permissions are enforced server-side on every route,
reads included — hiding a button is not security)

**Do:**

1. **Read a peer first** for tone, length and structure:
   `.claude/skills/plan-feature/references/lenses/ops-migration.md` (127 lines) and
   `.claude/skills/plan-feature/references/lenses/permissions.md` (133 lines). Match their shape
   exactly — an `#` title, a mandate paragraph, a ground-truth paragraph, `## Ask these questions`
   with lettered `###` subsections, `## Known failure modes` as a numbered list, a reference table,
   and `## What you must return`. Aim for **120–170 lines**; the five peers run 114–171.

2. Title it `# Risk lens: Design, tokens & accessibility`. Open the mandate paragraph with the single
   question this lens asks — *does this feature reach a human being who can actually read it, use it
   and trust it, on every surface it renders on?* — and name what it must never let through:
   contrast below the floor in any surface state; a colour value written into a component instead of
   a token; a status shown in colour with no glyph; money formatted or rounded in the UI; anything on
   the POS surface that needs the network; a touch target below the floor; an accessible name changed
   under cover of restyling.

3. **State the spec-silence rule in the second paragraph, in bold.** Verbatim requirement: the lens
   may **never** cite a `docs/spec.md` section for a design rule, because there is no such section —
   the greps in the `Spec:` line above return zero. Design rules are cited from **CLAUDE.md's
   "Design & UI" section**, from **`docs/design-system.md`** (normative for UI, subordinate to
   CLAUDE.md's twelve invariants), and from **WCAG success criteria by number**: 1.4.1 (colour is
   never the only carrier of meaning), 1.4.3 (text contrast 4.5:1), 1.4.11 (non-text and UI-boundary
   contrast 3:1), 2.4.7 (focus visible), 2.3.3 (animation from interactions / reduced motion). Name
   the two sanctioned spec citations — spec 6's unsynced count and spec 11's fixed-width receipts —
   and say that manufacturing any other spec position for a design rule is the same defect as
   inventing an account code.

4. State the open-decision rule: a design question neither `docs/spec.md` nor `docs/design-system.md`
   answers — a new colour, a new type role, a target screen size, a motion rule — is an **open
   decision** under CLAUDE.md's rule that the treatment applies beyond the seven listed ones. The
   lens surfaces it with a proposed default and never resolves it. Name spec 33 decision 1 explicitly:
   it sets the target hardware, so no finding may assume a viewport size or a device class.

5. Write the ground-truth paragraph the way `ops-migration.md` does: use the Phase 1 investigation as
   given, never re-survey the repo, and for each artefact say whether it **exists** or **does not
   exist yet** — `src/lib/styles/tokens.css`, `src/lib/styles/base.css`, `src/app.css`,
   `src/lib/components/ui/`, `src/routes/(pos)/+layout.svelte`, `src/lib/styles/tokens.test.ts`,
   `docs/design-system.md`, `docs/pos-layout-grammar.html`. A greenfield area does not silence the
   lens; it changes a finding from "this breaks" to "this will be built with no accessibility floor".

6. Write `## Ask these questions` with exactly these lettered subsections and this content:

   - **A. Tokens and the theme contract.** Is every `--c-*` the feature adds declared in the **bare
     `:root`**? A token declared only inside `@media (prefers-color-scheme: dark)` or
     `:root[data-theme="dark"]` does not exist in the un-stamped state and renders as nothing. Is the
     dark palette's **second copy** updated too — it is declared twice, once in the media query and
     once in the `[data-theme="dark"]` stamp, and a change to one alone makes the toggle disagree
     with the system preference. Is a themeable token exposed through **`@theme inline`**? Plain
     `@theme` bakes the light value into the compiled utility, so the utility stops following the
     theme. Are static tokens (the type scale, radii, containers) on plain `@theme`, which is correct
     for them? Does any component carry a raw hex, an `rgb()`/`hsl()`, or an arbitrary Tailwind value
     (`bg-[#123456]`, `p-[57px]`)? Is there a `tailwind.config.js` or `tailwind.config.ts` — there is
     none, Tailwind v4 is configured in CSS, and adding one is a defect on its own.
   - **B. Tailwind's defaults standing in for a matcami token.** Tailwind v4 ships its own
     `--radius-xs..4xl`, `--text-xs..9xl`, `--shadow-2xs..`, `--tracking-*`, `--leading-*` and
     `--container-3xs..7xl` in `node_modules/tailwindcss/theme.css`. So `rounded-lg`, `text-3xl`,
     `shadow-sm` and `max-w-2xl` resolve to Tailwind's values, not matcami's — a second source of
     size and type truth that CLAUDE.md forbids. Spacing is the deliberate exception: Tailwind derives
     every spacing utility from the single `--spacing` multiplier, so `p-4` and `gap-6` are computed
     rather than a second hardcoded scale, and flagging them is a false positive.
   - **C. Contrast, computed and never eyeballed.** Is every text-on-surface pair ≥ 4.5:1 (WCAG
     1.4.3), and every UI boundary, control outline and focus ring ≥ 3:1 (WCAG 1.4.11)? Is it
     computed across **all three surface states** — light, dark, and the `[data-surface="pos"]`
     surface scope, which is **LIGHT IN BOTH THEMES and pins the complete palette**? The signature
     defect is a pair that passes in one state and fails in another. Is a failing pair fixed by
     **re-solving the token value**, or "fixed" by dropping the pair from the guard's list? The
     second is the defect the guard exists to catch.

     **Do not flag the POS shell for being light — that is the design; flag it for being only HALF
     pinned.** The rule flipped twice on 2026-09-14 and the lesson is one sentence: **pinning a
     surface means pinning EVERY token on it, not just the grounds.** First the shell was pinned dark
     in both themes, which put light-theme ink on it at **1.08:1**; the user reversed that after
     reviewing a light-mode commercial POS reference, and the glare argument for a dark till was
     raised once and overruled. Then the first light draft pinned only the grounds and let the inks
     theme, which put dark-theme ink on the white key face at **1.21:1** — the same defect mirrored.
     The scope now declares grounds, inks, accent, semantic and status colours, the aliases and the
     shadow rungs, and **no dark block overrides any of it**. So: a `[data-surface="pos"]` rule nested
     inside a dark block, or a scope that leaves a themed token to be inherited, is a finding. The
     four defects to hunt for, in descending order of how often they will actually occur:
     - **A pressable POS surface whose only boundary is a shadow.** A white key face on the till's
       ground measures **1.22:1** — elevation cannot satisfy WCAG 1.4.11's 3:1, ever, at any blur
       radius. Every pressable POS surface needs `border-control-line` (4.73:1). `border-line`
       (1.55:1 on the key face) used to outline a control is the same defect wearing a token name.
     - **A themed token used where a scope value is needed**, or the reverse: a component reaching
       past the scope for a value the scope exists to supply, or a raw on-dark colour hardcoded
       because someone remembered the old dark shell.
     - **A half-pinned surface.** Any token the scope leaves to inherit — an ink, a status colour, a
       soft status ground, a shadow rung — renders the viewer's theme on a pinned-light device
       surface. Check the scope declares the whole census, not a subset; that is the 1.21:1 defect,
       and it is invisible to anyone reviewing on a light-mode machine.
     - **An alias not re-declared in a scope that overrides its source.** A custom property's `var()`
       is substituted at **computed-value time on the element that declares it**, so
       `--c-ring: var(--c-accent)` declared on `:root` inherits *already resolved*. The dark blocks
       need no copy — they target `:root`, the same element. `[data-surface="pos"]` is a `<div>` and
       **does** need one: without it, the focus ring inside the till is the page accent. Measured in
       a browser, not reasoned about: `--c-accent` `#5cb4c9` inside the shell while `--c-ring` still
       read `#0f6b7e`. The rule generalises to the ELEMENT, not the theme — and a text-based guard
       that models `var()` resolution cannot detect this, so it has to be a declaration check.
   - **D. Colour alone (WCAG 1.4.1).** Does every status carry its glyph beside its colour — item
     `NEW ◇` / `SENT ▲` / `VOIDED ✕`, order `OPEN ○` / `BILLED ◐` / `PAID ●` / `VOIDED ✕` /
     `REFUNDED ↩`, table free `○` / occupied `●`, sync online `●` / offline `◆` plus the unsynced
     count? About one man in twelve has red-green colour vision deficiency; a red total and a green
     total are the same total to him.
   - **E. Money and quantities in the UI.** Does any component contain `.toFixed(`, `/ 100`, `* 100`,
     `parseFloat`, `Intl.NumberFormat` or `Math.round`? Money is integer minor units and one rounding
     rule lives in one function (invariant 1) — the UI never does money arithmetic and never rounds.
     Does money render in `--font-mono` with `tabular-nums`, right-aligned, negatives with a leading
     `−` **and** the danger colour? Does each rendered line show the unit price and tax rate **stored
     on that line** rather than the menu's current value (invariant 7)? `src/lib/server/money/` is
     server-only and a component may not import `$lib/server` — a shared formatter must be an
     isomorphic module both sides import, never a copy.
   - **F. The POS surface and offline (invariant 5).** Does anything under `src/routes/(pos)/` need
     the network — a `+layout.server.ts`, a `+page.server.ts`, a blocking `load`, a `fetch` on mount,
     a stylesheet, font or icon sprite from a third-party origin? Fonts must be self-hosted; a font
     named in a token with no package delivering it renders as a silent system fallback nobody
     notices. Is the offline indicator **permanent chrome carrying the unsynced count** (spec 6's one
     UI sentence) rather than a toast? Are card and mobile tenders **visibly disabled** offline rather
     than failing after the tap? Does a control disabled by a non-empty sync queue **say why**, or
     does it sit dead?
   - **G. Touch and input.** POS floors are 56px (`touch-min`), 64px (`touch`), 72px (`touch-lg`) and
     96px for Pay and Send-to-kitchen (`touch-xl`). Apple's 44pt and Material's 48dp assume a seated
     user holding the device, not a standing cashier at a counter. Is a POS control sized by padding
     alone with no minimum height? Does the dashboard correctly use Tailwind's default scale instead?
   - **H. Focus, motion and the base layer.** Is `:focus-visible` visible on every interactive
     element (WCAG 2.4.7)? `outline: none` anywhere is a defect. Is
     `@media (prefers-reduced-motion: reduce)` honoured (WCAG 2.3.3)? The element base layer lives in
     `src/lib/styles/base.css` and must define no colour of its own — colour belongs to the tokens.
   - **I. The accessible surface changed under cover of restyling.** Restyling changes classes and
     wrappers. Does the plan change a heading's **level or text**, a **label**, a **button's
     accessible name**, a `role`, or a count an end-to-end spec pins? The tell is an edit to
     `e2e/auth.spec.ts` or `e2e/smoke.spec.ts` **in the same commit as a style change**: adding an
     assertion is fine, rewriting one to match new markup is the markup announcing it broke the
     contract. And the permissions crossover (invariant 8): a button hidden in the UI is not a
     permission check — the route checks server-side and returns `403` regardless of what renders.

7. Write `## Known failure modes` as a numbered list of 14–18 entries, one line each, in
   `ops-migration.md`'s voice — each naming the concrete defect, not the category. At minimum:
   token defined only in a dark block; dark palette's second copy left behind; plain `@theme` on a
   themeable token; raw hex or arbitrary value in a component; a Tailwind default-scale utility where
   a matcami token exists; contrast passing in light and failing in dark or on the POS surface; a
   guard list shrunk instead of a value re-solved; colour with no glyph; money formatted in a
   component; a line rendering the current menu price instead of the stored one; a server load or a
   third-party font origin on the POS surface; an offline state shown as a toast; a dead disabled
   control with no reason; a touch target under the floor; `outline: none`; motion with no
   reduced-motion branch; an e2e assertion edited rather than added.

8. Replace the peers' `## Spec sections you must consult` table with
   `## Where the rules actually live` — because for this lens they do not live in the spec. Two
   columns, `Source` and `What it settles`, with rows for: CLAUDE.md "Design & UI"; CLAUDE.md's
   twelve invariants (1, 5, 7, 8 named); `docs/design-system.md` (naming its sections — 2 the theme
   contract, 3 domain status glyphs, 4 typography, 5 touch targets, 6 money rendering, 7 POS
   component contracts, 9 accessibility floor); `src/lib/styles/tokens.css` as the only place a
   colour, size or type value is defined; `src/lib/styles/base.css` as the element base layer;
   `src/lib/styles/tokens.test.ts` as the computed contrast census;
   `docs/pos-layout-grammar.html` as a **research artifact with adopt/adapt/reject verdicts and a
   snapshot copy of the palette — never a source of truth**; `docs/spec.md` spec 6 (unsynced count on
   screen) and spec 11 (32/48-character receipts) as the only two spec touchpoints; spec 33 decision
   1 as unanswered; and WCAG 1.4.1, 1.4.3, 1.4.11, 2.4.7, 2.3.3.

9. Close with `## What you must return`, copying the peers' four-field finding shape exactly —
   **Severity** (`BLOCKER` / `MAJOR` / `MINOR` with what each means here: BLOCKER = unreadable or
   unusable output, contrast below the floor, money arithmetic in the UI, an offline-hostile POS
   surface, or an accessible name silently changed), **Finding** (one sentence), **Failure scenario**
   (concrete: "the **Pay** key is drawn with `shadow-raised` and no border; its white `--c-raise`
   face on the till's `--c-bg` ground measures 1.22:1, so under counter glare the cashier cannot see
   where the key ends and taps **Void** beside it"), **Violates** — and here state the citation rule again: write
   `CLAUDE.md "Design & UI"`, `invariant <n>`, `docs/design-system.md §<n>`, `WCAG 1.4.3` or
   `judgement call`, and **never** `spec <n>` for a design rule. Include the peers' read-only clause
   verbatim in substance: the lens reads and greps as much as it likes and **never** creates, edits,
   deletes or appends to any file, and never writes to `tasks/`.

10. Do not wire the lens into anything here. Creating the file does not make it run — T-15 does that,
    and this task is complete without it.

**Tests:** no Vitest test — `vitest.config.ts`'s two projects include only `src/**/*.test.ts` and
`src/**/*.integration.test.ts`, so nothing under `.claude/` is covered. The house guard tests for
this plan live in `src/lib/styles/tokens.test.ts` and are written by earlier tasks; this task adds
none. Run these shell assertions instead and paste their output into the commit body:

- `test -f .claude/skills/plan-feature/references/lenses/design.md` → exit 0.
- `wc -l < .claude/skills/plan-feature/references/lenses/design.md` → between 120 and 170.
- `grep -oE 'spec [0-9]+' .claude/skills/plan-feature/references/lenses/design.md | sort -u` → prints
  **only** `spec 11`, `spec 33` and `spec 6`. Any other number is a manufactured spec position and
  must be removed.
- `grep -cE '1\.4\.1|1\.4\.3|1\.4\.11|2\.4\.7|2\.3\.3' …/design.md` → at least 5 (the WCAG criteria
  are cited by number, not by name).
- `grep -c '^## ' …/design.md` → at least 4 (`Ask these questions`, `Known failure modes`,
  `Where the rules actually live`, `What you must return`).
- Re-verify the premise still holds:
  `for w in font color colour typograph WCAG accessib contrast layout resolution touch; do printf '%s %s\n' "$w" "$(grep -ci "$w" docs/spec.md)"; done` → every count is `0`. If any is non-zero the
  spec changed and this brief's opening claim must be rewritten before the task is done.

**Done when:** the file exists, every assertion above passes, and a reader who has never seen this
plan can tell from the brief alone which file to open for each rule — tokens, base layer, census,
design system document — without being told to search.

**Watch out:** the temptation is to cite `docs/spec.md` because every peer lens does. There is
nothing to cite; the spec contains no UI rule at all, and a fabricated citation here would be copied
forward by every plan the lens ever reviews. Second trap: this brief is a **prompt for a subagent**,
not documentation for a human — it must carry its own read-only clause and its own output shape, or
the agent will improvise both.

---

### T-15 — Dispatch the design lens: the hardcoded array, not just the table

**Needs:** T-14 (`references/lenses/design.md` exists)
**Files:**
- `.claude/skills/plan-feature/references/brainstorm-workflow.md` — EDIT (the literal `LENSES` array
  in §3's script, lines 77–88; `meta.description` line 58 and `meta.phases[0].detail` line 60; the
  opening sentence line 3; §1's scale-down sentence lines 13–14 and the non-trivial bullet list
  lines 16–23; §2 item 1's list of brief filenames lines 32–34; §4's sentence line 242; §6's fallback
  lines 277–284)
- `.claude/skills/plan-feature/SKILL.md` — EDIT (the frontmatter `description` line 3; the protocol
  table row for phase 2, line 14; Phase 2's opening sentence line 75 and the lens table lines 77–83;
  the Phase 0 intake bullet list, lines 55–63)

**Spec:** none — this task edits planning-skill text only. The design rules it dispatches carry no
spec citation, for the reasons stated in T-14.
**Invariants:** 1 (money is integer minor units), 5 (the POS surface must work with no network),
7 (each line snapshots its own price and tax rate), 8 (permissions are enforced server-side) — named
here because the new intake question and the lens `hunts` line must name them; this task itself
writes no code that could break one.

**Do:**

1. **The trap this task exists to avoid, stated first so it cannot be missed:** the lens table in
   `SKILL.md` is *documentation*. The `LENSES` array inside the workflow script in
   `brainstorm-workflow.md` §3 is *what actually spawns the agents*. Adding a table row alone means
   the design lens runs on **zero** future plans while every document claims it runs. Both files must
   change in this commit.

2. In `brainstorm-workflow.md` §3, add a **sixth entry** to the `LENSES` array, immediately after the
   `ops-migration` entry and before the closing `]`. The file is prettier-ignored, so the column
   alignment is hand-maintained — match the existing padding exactly:

   ```js
     { id: 'design',       brief: 'design.md',       title: 'Design & accessibility',
       hunts: 'contrast failing in one surface state but not another, a token missing from the bare :root, plain @theme where @theme inline was required, colour carrying a status with no glyph, a Tailwind default-scale utility standing in for a matcami token, a font named but not self-hosted, anything on the POS surface that needs the network, touch targets below the 56/64/72/96px floors, money formatted or rounded in a component, a missing focus ring or ignored prefers-reduced-motion, an accessible name or role changed under cover of restyling' },
   ```

3. Fix every lens count in `brainstorm-workflow.md`. There are six, and one decoy:
   - line 3 `Five specialist lenses hunt in parallel` → `Six specialist lenses`
   - line 58 `description: 'Five-lens risk panel with adversarial refutation…'` → `'Six-lens risk panel…'`
   - line 60 `detail: 'five specialist lenses hunt for what this feature breaks'` → `'six specialist lenses…'`
   - line 186 `log('Five lenses hunting in parallel; …')` → `log('Six lenses hunting in parallel; …')`
   - line 242 `…five agents asked "what could go wrong?" will always find something to say` → `six agents`
   - line 278 `the same five briefs sequentially in-conversation` → `the same six briefs`
   - line 282, inside the block quote the user is shown: `five lenses sequentially in-conversation` →
     `six lenses sequentially in-conversation`
   Leave line 229 alone — `LENSES.length` is computed and already correct.

4. In `brainstorm-workflow.md` §2 item 1, extend the list of brief filenames so it reads
   `accounting.md`, `data-model.md`, `offline-sync.md`, `permissions.md`, `ops-migration.md`,
   `design.md`. The instruction to `ls` that directory first and use the names actually present stays
   as it is.

5. In `brainstorm-workflow.md` §1, close the scale-down hole. Today the sentence lets "a cosmetic
   component" skip the panel, which would skip the design lens on exactly the changes it exists to
   review. Amend it so a change is **not** trivial when it changes a colour value, adds or renames a
   design token, changes a heading, label or button's accessible name, or touches the POS surface —
   and add one bullet to the non-trivial list:

   > - the design system: tokens, the palette, the type scale, the POS surface scope, touch targets,
   >   or anything that renders money or a domain status (CLAUDE.md "Design & UI"; WCAG 1.4.1, 1.4.3,
   >   1.4.11)

6. In `SKILL.md`, add a row to the Phase 2 lens table (after the `Ops / migration` row), keeping the
   three-column shape:

   ```markdown
   | Design / accessibility | `references/lenses/design.md` | contrast in all three surface states, tokens versus raw values, colour with no glyph, money formatted in a component, offline-hostile UI, touch floors |
   ```

   Then fix `SKILL.md`'s three counts: line 14 `Risk panel — five lenses in parallel` → `six lenses`;
   line 75 `fan out five specialist lenses` → `six specialist lenses`; and line 3's frontmatter
   `run a five-lens risk panel (accounting, data model, offline/sync, permissions, ops)` →
   `run a six-lens risk panel (accounting, data model, offline/sync, permissions, ops, design)`.
   **Change nothing else in the frontmatter description** — the trigger phrases after it are what
   route work to this skill.

7. In `SKILL.md` Phase 0, insert a new intake bullet **immediately after the "Scope and user story"
   bullet** — the surface decides which of the later questions even apply — reading:

   > - **Surface and design.** Which surface does it render on — dashboard (online only, and it
   >   themes) or the POS shell (the `[data-surface="pos"]` scope: LIGHT in both themes, pinning the
   >   complete palette, a deeper ground under white key faces, and every pressable surface outlined
   >   with `border-control-line` because a key on that ground is only 1.22:1 — and it must work
   >   offline)? Does it display money or a domain status, so it
   >   needs `--font-mono` with `tabular-nums` and a glyph beside the colour (CLAUDE.md "Design & UI";
   >   WCAG 1.4.1)? Does it need a design token that does not exist yet? And does any question about
   >   colour, type, spacing or target hardware land on something neither `docs/spec.md` nor
   >   `docs/design-system.md` answers — in which case it is an open decision, surfaced with a
   >   default and never decided silently?

8. Do **not** repair other stale statements you notice in `SKILL.md` — the "The repo is currently
   near-empty" paragraph near line 47 is out of date, and fixing it here is unplanned scope in a
   commit about lens dispatch. Leave it.

**Tests:** no Vitest test (nothing under `.claude/` is covered by either project). Shell assertions:

- `grep -n "id: 'design'" .claude/skills/plan-feature/references/brainstorm-workflow.md` → exactly
  **one** line, inside the `LENSES` array.
- The array literal has six entries:
  `grep -c "^  { id: '" .claude/skills/plan-feature/references/brainstorm-workflow.md` → `6`.
- `grep -niE '\bfive\b' .claude/skills/plan-feature/references/brainstorm-workflow.md .claude/skills/plan-feature/SKILL.md`
  → **no output**. Every occurrence listed in step 3 and step 6 was a lens count; none of them is a
  legitimate use of the word in these two files.
- `grep -c 'design.md' .claude/skills/plan-feature/references/brainstorm-workflow.md` → at least `2`
  (§2's filename list and the array entry).
- `grep -n 'references/lenses/design.md' .claude/skills/plan-feature/SKILL.md` → one line, in the
  Phase 2 table.
- `grep -c '^- \*\*' .claude/skills/plan-feature/SKILL.md` on the Phase 0 list → one more bullet than
  before the change (9 → 10); confirm by eye that the new bullet sits directly after
  "Scope and user story".

**Done when:** all six assertions above hold, and a dry read of `brainstorm-workflow.md` §3 shows the
script would spawn six agents — six `LENSES` entries, each with a `brief` filename that exists in
`.claude/skills/plan-feature/references/lenses/` (`ls` it and compare the six names).

**Watch out:** the array entry and the table row are easy to write and easy to half-write. A design
lens that exists in the documentation and not in the array is worse than no lens: every future plan
will claim six lenses reviewed it. Also: `design.md`'s `brief` value is a **bare filename**, because
the script joins it onto `BRIEFS` itself (`${BRIEFS}/${lens.brief}`) — writing a path there produces
a doubled directory and a subagent that cannot find its brief.

---

### T-16 — Add the design rules to the task output contract

**Needs:** T-14 (the lens brief the new rules mirror)
**Files:**
- `.claude/skills/plan-feature/references/task-format.md` — EDIT (§4's phase table, row 4 `UI` at
  line 129, plus the deviation guidance under the table at lines 132–145; §6's writing-rules bullet
  list at lines 259–272; §9's quality bar at lines 326–345)

**Spec:** none for the design rules added here. The file's existing spec-29 language (the six
mandatory test areas) is untouched and must stay exactly as it is.
**Invariants:** 1 (money is integer minor units; the UI never formats, divides or rounds it),
7 (discount before tax, and each line snapshots the unit price and tax rate used), 8 (permissions are
enforced server-side on every route — a hidden button is not a permission check)

**Do:**

1. In §4, replace the UI row of the phase table. Keep the three-column shape and the row's position
   (between `3 | API` and `5 | Tests`):

   ```markdown
   | 4 | UI | `routes/(pos)`, `routes/(dashboard)`, `src/lib/components/**`, `src/lib/styles/**` — every UI task names the design **tokens** it uses (never a raw hex, a `px` value or an arbitrary Tailwind value), the surface states it must hold in (light, dark, and the `[data-surface="pos"]` surface scope, which is light in BOTH themes and pins the complete palette — no dark block overrides it), the boundary of every pressable POS surface (`border-control-line`, never elevation alone), the glyph paired with every status colour, its `:focus-visible` state, and its POS touch floor (56/64/72/96px). It may ADD an end-to-end assertion; it may never edit or delete one |
   ```

2. Directly under §4's table, beside the existing deviation guidance ("Deviate with one line of why
   under the phase heading…"), add a short paragraph:

   > A **UI-only plan** — a design system, a restyle, an accessibility pass — has no schema, domain
   > or API phase; say so in one line under the phase heading. `docs/spec.md` is **silent on UI**: it
   > contains no font, colour, typography, contrast, accessibility, layout or touch rule at all. A UI
   > task's `Spec:` line therefore cites only the two places the spec reaches a screen — spec 6's
   > "The number of unsynced operations is always visible on screen" and spec 11's fixed-width 32- or
   > 48-character ESC/POS receipts — or says `none`. Design rules are cited from CLAUDE.md's
   > "Design & UI" section, from `docs/design-system.md`, and from WCAG success criteria **by number**
   > (1.4.1 colour alone, 1.4.3 text 4.5:1, 1.4.11 non-text 3:1, 2.4.7 focus visible, 2.3.3 reduced
   > motion). Inventing a spec citation for a design rule is the same defect as inventing an account
   > code.

3. In §6 ("Writing rules"), add four bullets after the existing "Give the numbers" bullet, in the
   file's existing voice:

   > - **Name the token, never the value.** `bg-raise`, `text-ink-2`, `p-touch`, `--text-section`. A
   >   raw hex or an arbitrary value (`bg-[#123456]`, `p-[57px]`) in a component is a bug, and the fix
   >   is a token in `src/lib/styles/tokens.css`, not a one-off. A Tailwind default-scale utility is
   >   the same bug wearing a nicer name: Tailwind v4 ships its own `--radius-*`, `--text-*`,
   >   `--shadow-*` and `--container-*`, so `rounded-lg`, `text-3xl`, `shadow-sm` and `max-w-2xl`
   >   resolve to `node_modules/tailwindcss/theme.css`, not to matcami. Spacing is the exception —
   >   every spacing utility is derived from the single `--spacing` multiplier, so `p-4` and `gap-6`
   >   are computed, not a second scale.
   > - **Colour never carries meaning alone.** Every status a task renders names its glyph beside its
   >   colour: item `NEW ◇` / `SENT ▲` / `VOIDED ✕`; order `OPEN ○` / `BILLED ◐` / `PAID ●` /
   >   `VOIDED ✕` / `REFUNDED ↩`; table free `○` / occupied `●`; sync online `●` / offline `◆` plus
   >   the unsynced count (WCAG 1.4.1).
   > - **The UI never does money arithmetic and never rounds.** No `.toFixed`, `/ 100`, `* 100`,
   >   `parseFloat`, `Intl.NumberFormat` or `Math.round` in a component or in a task step that writes
   >   one — money is integer minor units and one rounding rule lives in one function (inv. 1, 7).
   >   Each rendered line shows the unit price and tax rate **stored on that line**, never the menu's
   >   current price.
   > - **The accessible surface is frozen unless a task says otherwise.** Restyling changes classes
   >   and wrappers. A task that changes a heading's text or level, a label, a button's accessible
   >   name or a `role` must say so explicitly and name the end-to-end assertion that moves with it —
   >   and a UI task may only **add** assertions to `e2e/*.spec.ts`, never rewrite one to match new
   >   markup.

4. In §9 ("Quality bar"), add four checkboxes at the end of the list, after the `.gitignore` one:

   > - [ ] Does every UI task name the design **tokens** it uses, with no raw hex, no `px`, no
   >       arbitrary Tailwind value, and no Tailwind default-scale utility standing in for a matcami
   >       token?
   > - [ ] Does every status a UI task renders pair its colour with a glyph (WCAG 1.4.1), and does
   >       every ink-on-surface pair it introduces hold in **all three** surface states — light, dark,
   >       and the POS surface scope?
   > - [ ] Does any task put money **formatting, arithmetic or rounding** in a component (`.toFixed`,
   >       `/ 100`, `Intl.NumberFormat`), or render a price the line did not store (inv. 1, 7)?
   > - [ ] Does any UI task **edit or delete** an existing `e2e/` assertion rather than adding one?

5. Change nothing else. Do not renumber §1–§9, do not touch the worked example in §5 (it is an
   accounting task and stays one), and do not alter the six mandatory-test areas listed under §5's
   **Tests** guidance or in §9's spec-29 checkbox.

**Tests:** no Vitest test (nothing under `.claude/` is covered). Shell assertions:

- `grep -c '^- \[ \]' .claude/skills/plan-feature/references/task-format.md` → `14` (it is `10`
  before this task).
- `grep -c '^| 4 | UI |' …/task-format.md` → `1`, and the line contains `tokens`, `surface states`,
  `glyph`, `focus-visible` and `56/64/72/96px`.
- `grep -cE '1\.4\.1|1\.4\.3|1\.4\.11|2\.4\.7|2\.3\.3' …/task-format.md` → at least `2` (§4's
  paragraph and §6's glyph bullet).
- `grep -n 'toFixed' …/task-format.md` → at least two hits (the §6 bullet and the §9 checkbox).
- `grep -c '^| [0-9] |' …/task-format.md` → `6`, unchanged: the phase table still has six rows.
- `git diff --stat` for this commit lists exactly one file.

**Done when:** all assertions above pass, and re-reading §4, §6 and §9 end to end shows no rule stated
twice in conflicting words — the phase row, the bullets and the checkboxes must agree on the token
rule, the glyph rule, the money rule and the e2e rule.

**Watch out:** §9's checkbox list is what a planner actually runs before handing a plan over, so a
checkbox phrased as a description ("UI tasks should use tokens") is useless — each must be answerable
`yes` or `no` by grepping the plan. And the four new §6 bullets must not soften the existing money
rules above them: invariant 1's prohibition is on arithmetic and rounding **anywhere outside**
`src/lib/server/money`, and this addition narrows it to components, it does not replace it.

---

### T-17 — Add the design verification lens to execute-plan

**Needs:** T-14 (the planning-side brief this mirrors)
**Files:**
- `.claude/skills/execute-plan/references/verify-lenses.md` — EDIT (the H1 at line 1 and the opening
  paragraph at lines 3–7; LENS 3's money-smell grep path list at item 1, around line 200; a new
  `## LENS 6 — DESIGN & ACCESSIBILITY` appended after LENS 5's closing paragraph, which currently
  ends the file at line 409)
- `.claude/skills/execute-plan/references/verification.md` — EDIT (§2's authority table row at
  line 34; §4's "The five briefs live in…" sentence at line 108; `meta.phases[0].detail` at line 122;
  the `LENSES` array at lines 143–153, after the `spec-conformance` entry; the `log('Five lenses…')`
  at line 271; §6's "all five return PASS" at line 355; §7 step 3's "all five when the fix touched…"
  at line 375; §8's fallback at lines 417 and 422)
- `.claude/skills/execute-plan/SKILL.md` — EDIT (line 123, `**all five** scoped to the whole plan`)
- `.claude/skills/execute-plan/references/execution.md` — EDIT (line 205, `The full five-lens panel
  runs **once**, after the final phase`)
- `.claude/skills/execute-plan/references/intake.md` — EDIT (line 245, `an empty diff makes all five
  lenses pass on nothing`)

**Spec:** none for the design rules. The lens still checks spec-derived UI text where it exists: spec
6's "The number of unsynced operations is always visible on screen" and spec 11's fixed-width 32- or
48-character ESC/POS receipts. Spec 29's six mandatory-test areas are untouched by this task and stay
with LENS 2.
**Invariants:** 1 (money is integer minor units — no formatting, division or rounding in a
component), 5 (a completed offline sale is a fact; the POS surface must keep working with no
network), 7 (each line shows the unit price and tax rate stored on it), 8 (permissions are enforced
server-side; a hidden button is not a check)

**Do:**

1. **The same trap as T-15, in the other skill:** `verify-lenses.md` holds the *briefs*;
   `verification.md` §5's `LENSES` array is the *dispatcher*, and §2's table is the stated authority
   on which lenses run when. A LENS 6 added only to `verify-lenses.md` is never spawned. All three
   files change in this commit.

2. In `verify-lenses.md`: change the H1 to `# Verification lenses — the six adversarial briefs`, and
   the opening paragraph's `**the full five before the PR; …**` to `**the full six before the PR; …**`.
   Add one sentence to that paragraph: the design lens runs in the **final** panel only — intermediate
   phase gates stay `invariants` + `tests` so a gate stays cheap, and `references/verification.md` §2
   remains the authority. **Do not touch line 221** (`the five posted tables`): that is the count of
   posted tables in invariant 2, not a lens count.

3. In `verify-lenses.md`, extend LENS 3 item 1's money-smell grep. It currently scopes the search to
   `'src/lib/server/money' 'src/lib/server/orders' 'src/lib/server/accounting' 'src/lib/pos'`. Add
   `'src/lib/components'` to that path list, and add one sentence of false-positive guidance: that
   directory did not exist when the list was written, and inside it a bare decimal is almost always a
   CSS length or an opacity rather than money — read the line before reporting; the real money smells
   in a component are `toFixed(`, `/ 100`, `* 100`, `Intl.NumberFormat` and `Math.round`, and any of
   them is a BLOCKER under invariant 1.

4. Append `## LENS 6 — DESIGN & ACCESSIBILITY` to `verify-lenses.md`, after LENS 5's closing paragraph
   and separated by a `---` rule like the other lens boundaries. **Spell the heading exactly**, with
   an em dash (`—`, U+2014) and in capitals, because `verification.md`'s prompt tells the subagent to
   find the section headed `## ${lens.brief}` — a hyphen there leaves the agent with no brief. Write
   it as the verification counterpart of T-14's planning brief: it reads a **diff**, not a plan; it is
   read-only; it uses the same BLOCKER/MAJOR/MINOR severities and the same evidence-or-silence rule
   (every finding carries `path:line`, the commit sha and the quoted code); and it repeats LENS 3's
   caution that a grep exiting `2` is `UNVERIFIED`, never clean.

5. Give LENS 6 its greps, literally, in the file (they run inside the dispatch block's `$RANGE`):

   ```bash
   # raw colour and arbitrary values where a token belongs
   git diff $RANGE -U0 -- 'src/lib/components' 'src/routes' 'src/lib/styles' \
     | grep -nE '^\+' | grep -nE '#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|\b(bg|text|p|m|w|h|gap|min-h|max-w)-\['
   # Tailwind's own default scales standing in for a matcami token
   git diff $RANGE -U0 -- 'src/lib/components' 'src/routes' \
     | grep -nE '\b(rounded-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full)|text-(xs|sm|base|lg|xl|[2-9]xl)|shadow-(2xs|xs|sm|md|lg|xl|2xl)|max-w-(3xs|2xs|xs|sm|md|lg|xl|[2-7]xl))\b'
   # focus suppressed
   git diff $RANGE -U0 | grep -nE 'outline: *none|outline-none'
   # money formatted, divided or rounded in the UI
   git diff $RANGE -U0 -- 'src/lib/components' 'src/routes' \
     | grep -nE 'toFixed\(|/ *100|\* *100|Intl\.NumberFormat|parseFloat|Math\.round'
   # a new token that never reached the bare :root, or a themeable one on plain @theme
   git diff $RANGE -U0 -- 'src/lib/styles/tokens.css' | grep -nE '^\+\s*--c-[a-z0-9-]+\s*:'
   grep -n '@theme' src/lib/styles/tokens.css
   # a config file that must not exist (Tailwind v4 is configured in CSS)
   ls tailwind.config.js tailwind.config.ts 2>/dev/null
   # a network dependency on the offline POS surface
   git diff --name-only $RANGE | grep -E '^src/routes/\(pos\)/.*\+(layout|page)\.server\.ts$'
   git diff $RANGE -U0 -- 'src/routes' 'src/lib' | grep -nE 'https?://' | grep -v localhost
   # an end-to-end assertion edited or deleted rather than added
   git diff $RANGE -- 'e2e' | grep -nE '^-.*(getByRole|getByLabel|getByText|toHaveCount|toBeVisible)'
   # the contrast guard's pair list shrinking instead of a value being re-solved
   git diff $RANGE -- 'src/lib/styles/tokens.test.ts' | grep -nE '^-'
   ```

   Then the reads a grep cannot do: every `--c-*` name added to `tokens.css` must be declared in the
   **bare `:root`** (read the file and confirm, do not infer); every changed `.svelte` that names a
   status token (`st-new|st-sent|st-voided|st-billed|st-paid|st-offline`) must show a glyph beside
   the colour; and every POS control must carry a touch floor (`min-h-touch*`, `p-touch`), not
   padding alone.

6. Give LENS 6 its severity rule, explicitly, so it does not drift from the other five: **BLOCKER** —
   an ink-on-surface pair below 4.5:1 in any of the three surface states, money arithmetic or
   formatting in a component, a blocking server load or a third-party origin on the `(pos)` surface,
   an end-to-end assertion edited or deleted, a `tailwind.config.*` file, or a contrast-guard pair
   removed rather than a value re-solved. **MAJOR** — a raw hex or arbitrary value in a component, a
   Tailwind default-scale utility where a matcami token exists, `outline: none`, a status colour with
   no glyph, a touch target under its floor, a themeable token on plain `@theme`. **MINOR** — naming,
   a stale comment, an un-annotated token value. Add the citation rule: write `CLAUDE.md "Design &
   UI"`, `invariant <n>`, `docs/design-system.md §<n>`, `WCAG 1.4.3` or `judgement call` in the
   `Violates` field, and **never** `spec <n>` for a design rule.

7. Tell LENS 6 not to recompute the contrast census by hand when `src/lib/styles/tokens.test.ts`
   computes it: it checks that the test **ran and passed** in the supplied test output, and that the
   guard's pair list did not shrink. A shrinking list with a green suite is the signature defect and
   is a BLOCKER even though every test passes.

8. In `verification.md` §5, add the sixth entry to the `LENSES` array, after the `spec-conformance`
   entry, matching the surrounding two-line format exactly:

   ```js
     { id: 'design', title: 'Design & accessibility', brief: 'LENS 6 — DESIGN & ACCESSIBILITY', hunts:
       'a raw hex, an arbitrary Tailwind value or a Tailwind default-scale utility where a matcami token exists; a new --c-* token absent from the bare :root, or a themeable token exposed via plain @theme instead of @theme inline; an ink-on-surface pair below 4.5:1 in any of the three surface states, or a contrast guard whose pair list shrank; a [data-surface="pos"] scope that pins only part of its palette, or a [data-surface="pos"] rule nested inside a dark block; colour carrying a status with no glyph; money formatted, divided or rounded in a component; outline:none or a missing :focus-visible; a blocking server load, a fetch or a third-party font origin on the (pos) surface; an e2e assertion edited rather than added' },
   ```

   The `brief` value must be byte-identical to the heading written in step 4.

9. Fix every count in `verification.md`:
   - line 34, §2's table: `| After the final phase, … | all five | the whole plan |` → `all six`, and
     add one line under the table: the design lens runs in the final panel only; intermediate gates
     stay `invariants` + `tests`.
   - line 108, §4: `The five briefs live in …` → `The six briefs live in …`, and add **design** to the
     list of names (`completeness`, `tests`, `invariants`, `plan-vs-diff`, `spec-conformance`,
     `design`).
   - line 122: `detail: 'five lenses try to prove the work is not done'` → `'six lenses…'`.
   - line 271: `log('Six lenses hunting in parallel; …')`.
   - line 355, §6: `on an empty diff all five return PASS on nothing` → `all six`.
   - line 375, §7 step 3: `all five when the fix touched more than one task's files` → `all six`, and
     add `a token, palette or component fix re-runs \`design\`` to the same sentence's list.
   - lines 417 and 422, §8's fallback: `the same five briefs` → `six`, and the quoted sentence the
     user is shown, `five lenses sequentially in-conversation` → `six lenses`.

9b. **Two more files carry the same stale count, and a fourth carries a decoy that must NOT change.**
   `grep -rniE '\bfive\b' .claude/skills/execute-plan/` finds them all — work from that list, not
   from memory:
   - `references/execution.md` line 205: `The full five-lens panel runs **once**, after the final
     phase` → `six-lens`.
   - `references/intake.md` line 245: `an empty diff makes all five lenses pass on nothing` →
     `all six lenses`.
   - **`references/verify-lenses.md` line 221 is a DECOY — leave it exactly as it is.** It reads
     `anything that rewrites a paid order or the five posted tables is a BLOCKER`. That "five" counts
     the posted tables invariant 2 protects — paid orders, invoices, payments, stock movements,
     journal entries — and has nothing to do with the lens count. Changing it would corrupt an
     invariant-2 statement while "tidying up a count".

10. In `.claude/skills/execute-plan/SKILL.md` line 123, change `**all five** scoped to the whole plan`
    to `**all six** scoped to the whole plan`. Change nothing else on that line.

11. Do **not** touch `FINDING_SCHEMA`, the refutation logic, the READONLY clause or the severity
    definitions in `verification.md` — LENS 6 returns the same finding shape as the other five
    (severity, title, taskId, evidence, failureScenario, violates, fix) and reuses all of it unchanged.

**Tests:** no Vitest test (nothing under `.claude/` is covered by either project). Shell assertions:

- `grep -c "^  { id: '" .claude/skills/execute-plan/references/verification.md` → `6`.
- `grep -n "id: 'design'" .claude/skills/execute-plan/references/verification.md` → exactly one line.
- The brief name matches the heading:
  `BR=$(grep -oE "brief: 'LENS 6[^']*'" .claude/skills/execute-plan/references/verification.md | sed "s/brief: '//;s/'$//"); grep -c "^## $BR$" .claude/skills/execute-plan/references/verify-lenses.md`
  → `1`. A `0` means the em dash or the capitalisation differs and the subagent would get no brief.
- `grep -niE '\bfive\b' .claude/skills/execute-plan/references/verification.md .claude/skills/execute-plan/SKILL.md .claude/skills/execute-plan/references/execution.md .claude/skills/execute-plan/references/intake.md`
  → no output. **All four** files, not just the first two — `execution.md` and `intake.md` each carry
  a stale count as well (step 9b).
- `grep -niE '\bfive\b' .claude/skills/execute-plan/references/verify-lenses.md` → **exactly one**
  line, line 221, `the five posted tables` — the decoy, correctly left alone.
- `grep -c 'src/lib/components' .claude/skills/execute-plan/references/verify-lenses.md` → at least
  `3` (LENS 3's extended path list and LENS 6's greps).
- `grep -n 'LENS 6' .claude/skills/execute-plan/references/verify-lenses.md` → at least two hits
  (the heading and the opening paragraph's count sentence or the lens's own self-reference).

**Done when:** every assertion above passes; the brief-name check prints `1`; and a read of
`verification.md` §2 plus §5 shows the same six lens ids in both places, with `design` absent from the
intermediate-gate pair.

**Watch out:** three specific traps. First, the em dash — `LENS 6 — DESIGN & ACCESSIBILITY` must be
identical in the heading and in the `brief` string, or the lens spawns with no brief and improvises.
Second, line 221 of `verify-lenses.md` says "the five posted tables"; a blanket find-and-replace of
`five` corrupts invariant 2's wording in the invariants lens. Third, the money-smell grep in LENS 3
already carries a `[0-9]+\.[0-9]+` alternative that will now run over `src/lib/components` — without
the false-positive sentence from step 3, every `0.5` opacity and `1.5rem` length in a component
becomes a reported money defect, and a lens that cries wolf is a lens people stop reading.
