# Phase 1 — The POS device surface

The POS gets its own token scope, `[data-surface="pos"]`, re-declaring the SAME `--c-*` names so
components stay portable between the dashboard and the till.

**THE RULE, in one sentence:** `[data-surface="pos"]` is **LIGHT IN BOTH THEMES** and it pins the
**COMPLETE** palette — grounds, inks, accent, semantic and status colours, the two `var()` aliases and
the shadow — and **no dark block overrides any of it**. The till is a device: its surface is a
property of the hardware standing on the counter, not of the viewer's OS preference. **The dashboard
themes; the POS does not.**

**The lesson that rule encodes, because it was learned twice in one day: pinning a surface means
pinning EVERY token on it, not just the grounds.** A half-pinned surface puts one palette's ink on the
other palette's ground, and it does so on someone else's machine, where nobody looking at the samples
will see it.

## Decision history — all three positions, two of them SUPERSEDED

This rule flipped twice on 2026-09-14. A fresh session needs the whole record, because each flip was
the repair of a measured defect and the record is what stops a third flip back.

1. **SUPERSEDED — "the shell is pinned DARK in both themes."** `--c-screen`, `--c-key`,
   `--c-key-line`, `--c-key-ink` in the bare `:root`, themed nowhere. The operational argument was
   real: dark cuts counter glare and keeps the keys the brightest thing on screen. **It broke because
   the inks kept theming.** In the LIGHT theme 26 of 26 POS-shell pairs failed — `--c-ink` on
   `--c-screen` measures **1.08:1**, black on black, and spec 6's always-visible unsynced count
   measured 3.10:1. (Also measured then: `--c-ink-2` 2.50:1; `--c-danger` on `--c-key` 1.98:1; and in
   dark `--c-ink-3` 4.26, `--c-ok` 4.19, `--c-danger` 4.07 on `--c-key`.) The user reviewed a
   light-mode commercial POS reference and **overruled the glare argument**. A deliberate reversal,
   never an oversight.
2. **SUPERSEDED — "a LIGHT device surface that FOLLOWS THE THEME", the scope overriding grounds only
   and inheriting every ink.** This is the position the plan carried for about an hour, and **it was
   disproved by measurement.** The user opened the samples on a dark-mode OS and the POS rendered
   dark. Pin only the grounds and let the inks theme, and a dark-theme viewer gets, on the white key
   face `--c-raise` `#ffffff`:

   ```
   --c-ink   #e6eaec on #ffffff = 1.21:1
   --c-ink-2 #a8b3bc on #ffffff = 2.13:1
   --c-ink-3 #97a0a8 on #ffffff = 2.65:1
   ```

   That is **the identical defect position 1 was created to fix, mirrored** — 1.08:1 became 1.21:1 and
   changed sides. Anything in this repository still reading "the POS follows the theme", "the scope
   overrides grounds only", "it inherits every ink from the theme" or "the re-tune reaches the POS for
   free" is **this superseded position**, not current fact.
3. **CURRENT — light in both themes, complete palette pinned, no dark override.** What the scope buys
   beyond being light is the till's **ground/key relationship and its density**: the dashboard puts
   white cards on a light ground for reading; the POS uses a **deeper ground so the white key faces
   read as the raised, pressable thing.** Audited over the sample implementation:
   **182 ink × ground pairs, 0 failures, tightest 4.60** (`ink-3` on `bg-2`).

**The working, audited implementation is `design/tokens.css` section 3. T-03 mirrors it.** Read that
section before writing the block; it carries the same comment, including the 1.21:1 trap. It is a
**design sample, not application code** — plain CSS with no build step — and it is **untracked on the
base branch**, so it may be absent from a fresh worktree. That is not a blocker: T-03's CSS block is
complete on its own and is the authority if the two ever disagree.

## The one hard consequence, and it is unchanged by either flip

A white key on the POS ground measures **1.22:1**. Elevation ALONE cannot carry a control's edge — at
any blur radius; this is a ground/face relationship, not a shadow that needs tuning. WCAG **1.4.11**
asks **3:1** for the boundary of a UI component, so **every pressable surface on the POS takes
`border: 1px solid var(--c-control-line)`** — `--c-control-line` measures **4.73:1** on the POS ground
and **5.78:1** on the key face. `--c-line` (**1.27:1** on the ground, **1.55:1** on the key face) is
for decorative rules and non-interactive block edges only. **A shadow-only key is pretty and
non-compliant.**

## And it retires four tokens

`--c-screen`, `--c-key`, `--c-key-line`, `--c-key-ink` exist in the bare `:root` on the base branch and
an existing test pins them there. Once the scope re-declares the ordinary names for the POS, those
four have **no consumer** — two vocabularies for one surface is exactly what the scope removes. T-03
retires them; T-04 replaces the test that guarded them.

## The coupling with T-06, decided one way, stated here and in both tasks

The scope pins the **light** values, and **T-06 (Phase 2) re-tunes one light value**: `--c-ink-3`
`#646f7a` → `#5c6771`. Those two can silently drift apart, so the decision is made here and is not
open:

- **T-03 writes `#5c6771` directly** — the final, post-re-tune value, in the POS block, today.
- **T-06 must VERIFY the POS block already carries `#5c6771` and must not edit it again.**
- **T-04's guard asserts that every non-ground token the POS pins equals the bare `:root`'s value**,
  so a future edit to one and not the other fails the suite. The single expected divergence between
  T-03 and T-06 — `--c-ink-3` — is carried as a dated, self-expiring `PENDING_RETUNE` entry that
  asserts the divergence is **still** exactly that one, and prints "delete me" the moment T-06 lands.

The claim that "the re-tune reaches the POS for free because the scope overrides grounds only" is
**false** and belongs to superseded position 2. Delete it wherever it appears.

**Depends on:** Phase 0

---

## Cross-file couplings this rule creates — report as findings, fix in the file that owns them

Non-blocking. **None of these stops T-03, T-04 or T-05**, and none of them may be fixed from this
phase — each belongs to the task that owns the file. Report them when the phase is executed.

- **`01-decisions.md` (T-01) and `00-overview.md`** may still describe the POS as a light surface that
  **follows the theme**, re-declaring **grounds only** and inheriting every ink. That is superseded
  position 2. T-03 step 1 corrects the one `CLAUDE.md` bullet it is responsible for; the plan files
  themselves are not this phase's to edit.
- **`03-palette.md` (T-06)** states that the scope "re-declares **no ink**" and that the single
  `PENDING_RETUNE` entry it must delete is `pos-dark:danger:raise`, a contrast deferral. Both are
  superseded: the scope pins every ink, there is no `pos-dark` state at all, and no POS contrast pair
  fails before the re-tune. The entry T-06 must delete is the `--c-ink-3` **value-drift** entry T-04
  creates, and T-06's job on the POS block is to **verify, not edit**.
- **`04-type-scale.md` (T-10)** states that the three new shadow rungs "need no entry anywhere" in the
  POS block. Under the pinned rule they do: T-03 pins today's single `--c-shadow` at its light value,
  and when T-10 splits it into `--c-shadow-flat` / `--c-shadow-raised` / `--c-shadow-floating` the POS
  block must take the three **light** rungs and keep a re-declared `--c-shadow: var(--c-shadow-raised)`
  — an alias on a `<div>` does not recompute (same reason as `--c-ring`). T-04's exact
  `POS_PINNED.length` assertion is what makes T-10 notice instead of silently leaking a dark rung into
  the till.
- **`docs/design-system.md` line 141 (section 7b)** names all four retired tokens as "the POS chrome
  tokens". T-12 owns that document; `05-document.md` as written does not cover that line.

---

### T-03 — Add the `[data-surface="pos"]` device-surface scope and retire the four chrome tokens

**Needs:** T-01 (records in CLAUDE.md that the POS shell is a surface SCOPE re-declaring the ordinary
`--c-*` names, superseding `docs/design-system.md` section 2's "The POS terminal chrome is exempt"
wording — but T-01's text may predate the pinned rule; step 1 below is what reconciles that)
**Files:**
- `src/lib/styles/tokens.css` — EDIT (three places. (a) inside the bare `:root` block, the POS-chrome
  comment and declaration at lines 60–63; (b) one new rule inserted between the closing brace of
  `:root[data-theme="dark"] { … }` at line 103 and the `/* ── 2. themeable tokens → Tailwind
  utilities */` comment at line 105; (c) the `@theme inline` block at lines 106–142, where four
  entries leave and six arrive. Touch nothing else in this file)
- `src/lib/components/components.test.ts` — EDIT (the `POS_TOKENS` array at lines 60–69 only)

**Spec:** none. `docs/spec.md` is **silent on UI** — zero occurrences of font, colour, typography,
WCAG, accessibility, contrast, layout or touch. Never cite a spec section for a design rule. The
authority here is CLAUDE.md's "Design & UI" section and `docs/design-system.md`. The only spec text
that reaches a screen is spec 6 line 68, "The number of unsynced operations is always visible on
screen" — which is why `--c-st-offline` must clear 4.5:1 on the POS grounds (it measures **4.96:1** on
`--c-bg`, **6.05:1** on the key face) and not merely look fine.
**Invariants:** 5 (a completed offline CASH sale is a recorded FACT — the POS surface must keep
working with no network, so this is plain CSS in the bundled stylesheet and adds no runtime, no
script and no request), plus CLAUDE.md's design rules: every `--c-*` exists in the bare `:root`;
colour never carries meaning alone; WCAG AA 4.5:1 for text (SC 1.4.3) and 3:1 for UI component
boundaries and focus indicators (SC 1.4.11).

**Do:**

Every fenced block below is the LITERAL text to write. It is indented only to sit inside its numbered
step — paste it dedented to the left margin of the block it joins in the target file, so the scope's
selector starts at column 0 and its declarations sit at the file's two-space indent.

1. **Check the rulebook first.** Open `CLAUDE.md`'s `## Design & UI` section and find the POS bullet.
   **Two different wordings are stale, and either one must be corrected:**
   - the base-branch wording, ``- **The POS shell stays dark in BOTH themes** (`--screen`, `--key`, `--key-ink`).`` — superseded position 1;
   - anything saying the shell **follows the theme**, that the scope re-declares the **GROUND** names
     only, or that every ink / status colour is **inherited from the theme** (T-01 may have written
     exactly this) — superseded position 2.

   Report whichever you find as a finding, and correct that one bullet to what this task implements:
   **the POS is a device surface, pinned LIGHT in BOTH themes, declaring the COMPLETE palette inside
   `[data-surface="pos"]` — grounds, inks, accent, semantic, status, both aliases and the shadow — with
   no dark block overriding any of it; it carries a deeper ground than the page so the white key faces
   read as raised; and the four chrome tokens are retired.** Keep the adjacent
   `border-control-line` bullet if T-01 wrote one: it is still true and still the most easily lost rule
   in the system. Do not restructure the section; one bullet.

2. **Retire the four chrome tokens.** In the bare `:root`, DELETE the comment and the declaration at
   lines 60–63:
   ```css
   /* POS terminal chrome — stays dark in BOTH themes. It is a device surface,
      not page chrome: dark cuts counter glare and keeps the keys the brightest
      thing on screen. Do not theme these. */
   --c-screen:#0f1215; --c-key:#2a313a; --c-key-line:#3a434e; --c-key-ink:#e3e9ee;
   ```
   and write the menu category bands in their place, **inside the same bare `:root` block** — never a
   second `:root { … }` rule, because `src/lib/styles/tokens.test.ts` parses the bare palette with
   `blockOf(css, ':root {')`, which takes the FIRST match only, so tokens in a second block are
   invisible to every assertion:
   ```css
   /* Menu category bands. A menu key carries a category COLOUR instead of a photo:
      no image column in the schema, no image payload in the offline menu snapshot,
      and nothing to invalidate when the menu version bumps.

      WAYFINDING, never status, and NEVER the only carrier — the category name is
      always written beside the band (WCAG 1.4.1; ~1 in 12 men has red-green CVD).

      LIGHT VALUES ONLY, and that is now sufficient rather than a gap: bands render
      on the POS device surface, which is pinned LIGHT in both themes. Each clears
      3:1 on the key face --c-raise (6.13-7.70) and on the POS grounds (4.88-6.31),
      so the band itself is perceivable. They are declared here and in no dark block,
      so they cannot pick up a dark value. Using one on the DASHBOARD would re-open
      the question — see the note in this task. */
   --c-cat-grills:#8a4a2b;  --c-cat-rice:#7a5c12;   --c-cat-somali:#0f6b7e;
   --c-cat-drinks:#3f5ba8;  --c-cat-sides:#5a4a80;  --c-cat-sweets:#8f3d63;
   ```

3. **Insert the scope — ONE rule, and only one.** Find where `:root[data-theme="dark"] {` closes
   (line 103 — it is the third and last palette block, ending just before the section-2 comment) and
   insert the rule **there**, after it.

   **There is no dark counterpart, and adding one is the defect this correction exists to prevent.**
   Do not write `:root[data-theme="dark"] [data-surface="pos"]`, do not nest a `[data-surface="pos"]`
   rule inside `@media (prefers-color-scheme: dark)`, and do not add `--c-*` for the POS anywhere
   except this one block. After this task `[data-surface="pos"]` appears **exactly once** as a
   selector in `tokens.css`; T-04 asserts that count.

   Do **not** edit the three palette blocks in this task: re-tuning `--c-ink-3`, `--c-ok` and
   `--c-danger` is T-06 in the next phase, and mixing the two makes both diffs unreviewable. The one
   value this block shares with that re-tune — light `--c-ink-3` — is written here at its **final**
   value `#5c6771`, not its current one; see the two details noted under this step.

   Insert this verbatim, keeping the file's hand-laid-out compact grouping. It mirrors
   `design/tokens.css` section 3, the audited implementation — read that file first if it is present
   in your worktree (it is untracked on the base branch, so it may not be; this block is complete
   without it, and wins if they disagree):

   ```css
   /* ── 1b. THE POS DEVICE SURFACE — LIGHT IN BOTH THEMES ────────────────────
      The till is a DEVICE. Its surface is a property of the hardware on the
      counter, not of the viewer's OS preference — so it does not follow the page
      theme. The dashboard themes; the POS does not.

      DECISION HISTORY. This rule flipped twice on 2026-09-14, and both flips
      matter:
        1. It was DARK in both themes (glare; keys brightest). That broke, because
           the inks kept theming: light-theme ink on a permanently dark shell
           measured 1.08:1, black on black.
        2. The user reviewed a light-mode commercial POS reference and chose LIGHT.
           The glare argument was raised once and overruled.

      THE LESSON FROM THE FIRST FLIP, WHICH THE SECOND MUST NOT REPEAT: pinning a
      surface means pinning EVERY token on it, not just the grounds. Pin the
      grounds light and let the inks theme, and a dark-theme viewer gets --c-ink
      #e6eaec on a white key face — 1.21:1. That is the identical defect,
      mirrored. So this block declares the COMPLETE device palette, and NO dark
      block overrides any of it.

      What the scope buys beyond being light: the till's ground/key relationship.
      The dashboard puts white cards on a light ground for reading; the POS uses a
      DEEPER ground so the white key faces read as the raised, pressable thing.

      AND ONE HARD CONSEQUENCE, MEASURED: a white key on that ground is 1.22:1, so
      elevation ALONE cannot carry a control's edge. WCAG 1.4.11 wants 3:1 for the
      boundary of a UI component, so every pressable surface takes a
      --c-control-line border (4.73 on the ground, 5.78 on the key face). A
      shadow-only key is pretty and non-compliant. --c-line (1.27 on the ground,
      1.55 on the key face) is for decorative rules only.

      Audited: 182 ink x ground pairs, 0 failures, tightest 4.60 (ink-3 on bg-2).

      Reached by a wrapper element carrying data-surface="pos" INSIDE <body>
      (src/routes/(pos)/+layout.svelte) — NEVER by a stamp on <html>. */
   [data-surface="pos"] {
     /* UA scrollbars, form controls and the caret follow the surface, not the page. */
     color-scheme: light;

     /* grounds — deeper than the page, so a white key reads as raised */
     --c-bg:#e4e9ee; --c-bg-2:#e1e6eb; --c-raise:#ffffff; --c-raise-2:#f4f7f9;
     --c-line:#c8d1d8; --c-line-soft:#dce3e8;

     /* inks — PINNED. Letting these theme is the 1.21:1 bug described above. */
     --c-ink:#161b20; --c-ink-2:#4a5661; --c-ink-3:#5c6771;

     --c-accent:#0f6b7e; --c-accent-ink:#ffffff; --c-accent-soft:#ddeef2;

     --c-ok:#2c6a48;     --c-ok-bg:#e2efe7;
     --c-warn:#855a12;   --c-warn-bg:#f7ecd8;
     --c-danger:#a13a2e; --c-danger-bg:#f9e5e2;

     --c-st-new:#0f6b7e;     --c-st-new-bg:#ddeef2;
     --c-st-sent:#2c6a48;    --c-st-sent-bg:#e2efe7;
     --c-st-voided:#a13a2e;  --c-st-voided-bg:#f9e5e2;
     --c-st-billed:#855a12;  --c-st-billed-bg:#f7ecd8;
     --c-st-paid:#2c6a48;    --c-st-paid-bg:#e2efe7;
     --c-st-offline:#855a12; --c-st-offline-bg:#f7ecd8;

     /* Aliases RE-DECLARED, and this is not redundancy. A custom property's var()
        is substituted at COMPUTED-VALUE time on the element that DECLARES it, and
        the resolved literal is what inherits. The dark blocks need no copy because
        they target :root — the same element the alias sits on — so --c-ring
        recomputes there. This scope is a <div>, so an alias declared above it NEVER
        recomputes here. Measured in Chromium without these two lines, on a
        dark-theme page: --c-accent is #0f6b7e inside the scope, as pinned, but
        --c-ring is #5cb4c9 — the PAGE's accent, riding in on the alias. */
     --c-ring: var(--c-accent);         /* → #0f6b7e · 5.02 on --c-bg · 6.13 on --c-raise */
     --c-control-line: var(--c-ink-3);  /* → #5c6771 · 4.73 on --c-bg · 5.78 on --c-raise
                                           THE key edge — WCAG 1.4.11 wants 3:1 */

     /* The light shadow: its white top highlight belongs on a light ground, and
        the dark one would inherit in from a dark page. Byte-identical to the bare
        :root's --c-shadow — copy it, do not retype it. When T-10 splits this into
        three rungs, the POS block takes the three LIGHT rungs and keeps a
        re-declared --c-shadow alias, for the same <div>-not-:root reason as above. */
     --c-shadow:0 1px 0 rgb(255 255 255 / .8), 0 6px 20px -14px rgb(22 27 32 / .45);
   }
   ```

   **Two details in that block that are easy to get wrong.**
   - **`--c-ink-3` is `#5c6771`, not `#646f7a`.** `#5c6771` is the value T-06 installs in the bare
     `:root` next phase; the POS grounds were solved against it (`4.73` on `--c-bg`, `4.60` on
     `--c-bg-2`, where the un-tuned `#646f7a` measures `4.20` and `4.08`). Writing the final value
     here, once, is the decision: **T-06 verifies this line, it does not edit it.** Between this task
     and T-06 the POS and the page legitimately disagree on exactly this one token, and T-04 carries
     that divergence as a dated entry that expires the day T-06 lands.
   - **`design/tokens.css` section 3 also declares `--c-danger-ink: #ffffff`. Do NOT copy that line.**
     `--c-danger-ink` does not exist in `src/lib/styles/tokens.css` — the samples invented it for a
     danger button, the app palette has no such token, and declaring it only inside the scope would
     break CLAUDE.md's "every `--c-*` exists in the bare `:root`" rule and fail T-04's completeness
     test. Adding that token to the palette is a new decision for a later task, not a side effect of
     this one. Report the discrepancy; do not resolve it here.

4. **Fix the `@theme inline` block.** DELETE the four entries at lines 136–139 —
   `--color-screen`, `--color-key`, `--color-key-line`, `--color-key-ink`. Leaving them is worse than
   untidy: `@theme inline` emits `var(--c-screen)` into the utility, and with the custom property
   gone `bg-screen` compiles to an unresolvable reference that renders as nothing, with no error
   anywhere. In their place add the six band utilities:
   ```css
   --color-cat-grills: var(--c-cat-grills);  --color-cat-rice:   var(--c-cat-rice);
   --color-cat-somali: var(--c-cat-somali);  --color-cat-drinks: var(--c-cat-drinks);
   --color-cat-sides:  var(--c-cat-sides);   --color-cat-sweets: var(--c-cat-sweets);
   ```
   `inline` and not plain `@theme`: plain `@theme` bakes today's literal into the utility, and a token
   with no `--color-*` entry has no utility at all, which leaves the first component that needs a band
   reaching for an arbitrary value — the exact bug `src/lib/styles/tokens.test.ts` already fails the
   build for.

   Add **nothing else** to `@theme inline` and nothing to the plain `@theme` block. Every name the
   scope re-declares already has its entry (`--color-ink: var(--c-ink)` and the rest), and
   `@theme inline` emits `var(--c-ink)` so `text-ink` resolves per element and picks the scope up for
   free. **The surface scope introduces no new token name** — therefore no new utility and no
   component change anywhere. That is what keeps a component portable: `bg-raise text-ink` is correct
   on a dashboard card AND on a menu key, with no conditional class and no second vocabulary. Only the
   VALUES differ, and on the POS they stop differing by theme.

5. **Retarget the POS-only utility list.** In `src/lib/components/components.test.ts`, the `POS_TOKENS`
   array (lines 60–69) lists the utilities a **dashboard** component may not use. Delete `'bg-screen'`,
   `'bg-key'` and `'text-key-ink'` — those utilities no longer compile — keep the five touch entries
   (`p-touch`, `min-h-touch`, `touch-min`, `touch-lg`, `touch-xl`), and add the six band stems:
   ```ts
   'cat-grills',
   'cat-rice',
   'cat-somali',
   'cat-drinks',
   'cat-sides',
   'cat-sweets'
   ```
   The check is `code.includes(token)`, so the bare stem catches `bg-cat-rice`, `text-cat-rice` and
   `border-cat-rice` in one entry. Replace the array's comment with the new truth in two lines: after
   the surface scope there is **no POS-only ink, ground or status utility** — every one of those names
   is legal on every surface and only its value differs — and the POS-only list is now the
   standing-thumb touch sizes **plus the six category bands, which are solved against the pinned-light
   device grounds only and have no dark values**. The test keeps passing either way (no component uses
   any of these strings), which is precisely why a stale list would survive unnoticed.

6. `src/lib/styles/tokens.css` is listed in `.prettierignore` — its compact aligned grouping is
   deliberate and Prettier explodes it to one declaration per line. `pnpm format` will therefore not
   tidy a messy insert; match the surrounding layout by hand. `components.test.ts` is **not** ignored:
   run `pnpm format` after editing it, or `pnpm lint` fails on `prettier --check`.

7. **Do not name the four retired tokens in any comment you write in this file.** T-04's retirement
   guard reads comment-stripped CSS and would tolerate it, but the `grep` in **Done when** below reads
   the raw file and must print `0`. The explanation of what was retired and why lives in this plan, in
   `CLAUDE.md` and in `docs/design-system.md` — not in `tokens.css`.

**A QUESTION THIS TASK CLOSES: the category bands have no dark values, and no longer need any.**
The six hexes are solved for the light key face and the light POS grounds (**4.88–7.70** across all
four). They were recorded as an open question while the POS was expected to have a dark state: on a
dark key face `#252b33` the same hues measure **1.85–2.33:1**, below the 3:1 WCAG 1.4.11 asks of a
perceivable UI element. **With the POS pinned light in both themes that question is moot for the POS**
— a band only ever renders on the device surface, whose grounds are now constants. The bands are
therefore declared in the bare `:root` and in no dark block, and T-04 asserts exactly that.
**It stays open in one case only: if a band is ever used on the DASHBOARD**, which does theme, the six
values must be re-solved against the dark page grounds first and the decision recorded — CLAUDE.md's
open-decision rule applies beyond spec 33's seven. Step 5's `POS_TOKENS` entry is what makes that
attempt fail loudly instead of shipping a 2.3:1 band. Note the closure in the commit message.

**Tests:**
- House guard test (CLAUDE.md "Design & UI") — the computed guard for this block is **T-04**, in this
  same phase. Land both before the phase gate; the values above are only as good as the test that
  re-derives them.
- Immediate check, before T-04 exists: `pnpm test:unit src/lib/styles/tokens.test.ts` must show
  **exactly one** failing case, `keeps the POS chrome un-themed — bare :root only, neither dark
  block`, failing with `--c-screen must be declared in the bare :root`. That test asserts the four
  tokens step 2 retires, and T-04 replaces it. **Any other failure means step 2, 3 or 4 went wrong**
  — in particular, `declares every dark-block token in the bare :root as well` and `declares the SAME
  token names in both dark blocks` must both still pass, because this task adds no name to either
  root dark block.
- `pnpm test:unit src/lib/components/components.test.ts` passes with no failure after step 5.

**Done when:** `pnpm lint` and `pnpm build` are clean;

```bash
grep -cE '^\[data-surface="pos"\] \{' src/lib/styles/tokens.css   # 1 — the scope, at column 0
grep -c '\[data-surface="pos"\]' src/lib/styles/tokens.css        # 1 — and NOTHING else
grep -c -- '--c-screen\|--c-key\|--color-screen\|--color-key' src/lib/styles/tokens.css   # 0
grep -c -- '--c-cat-' src/lib/styles/tokens.css                   # 5
grep -c -- '--c-ink-3:#5c6771' src/lib/styles/tokens.css          # 1 — the POS block, ahead of T-06
```

and `pnpm test:unit` fails only the single case named above, which T-04 then replaces.

The second grep is the important one: **anything above 1 means a second rule mentions the scope**, and
the only way that happens is the dark override this task forbids. Anchor the first pattern to the
selector — an unanchored count would also match a comment that spells the attribute in prose, which is
why step 3's comment deliberately writes `data-surface="pos"` without brackets. The `--c-cat-` count of
5 is two declaration lines plus three `@theme inline` lines; the band comment deliberately spells no
`--c-cat-*` name.

**Watch out:**
- **Never add a dark rule for this scope.** Not `:root[data-theme="dark"] [data-surface="pos"]`, not a
  nested rule inside the dark media query, not `@media (prefers-color-scheme: dark) [data-surface=…]`.
  The POS is pinned; a dark override re-creates superseded position 2 and, with it, 1.21:1 ink on the
  key face for every dark-theme viewer. If a POS screen looks "too bright" on someone's dark desktop,
  that is the device surface working as specified.
- **Never move the attribute to `<html>`.** On the same element `:root[data-theme="dark"]`
  (specificity 0,2,0) outranks `[data-surface="pos"]` (0,1,0), so a dark-stamped page would beat every
  pinned value and the till would render the dark palette — the defect, restored, by a one-word move.
  In light mode it would apply the POS grounds to the entire document, dashboard included. On a
  **descendant** element specificity never competes: the nearer declaration wins by inheritance. Do
  not "fix" a perceived specificity problem with `:root [data-surface="pos"]`, a higher-specificity
  selector or `!important` — there is no problem to fix.
- **Pin every token, not a subset.** The block declares **33** names: the 6 grounds, 3 inks, 3 accent,
  6 semantic, 12 status, the 2 aliases and `--c-shadow`. That is not a style preference — it is every
  token either dark block re-declares, plus the two aliases that do not recompute on a `<div>`. Any
  name you leave out inherits the PAGE value for the active theme, which on a dark desktop is a dark
  value on a white key. T-04 derives the required list from the dark blocks and asserts it in both
  directions, so an omission fails the build with the token's name in the message.
- **The two alias lines are the subtle part**, and deleting one is the easiest mistake in the system.
  The existing comment above `--c-ring` in the bare `:root` says derived tokens follow the theme
  automatically and must not be repeated in a dark block. That is TRUE for the theme (same element)
  and FALSE for a scope (descendant element). Both halves are verified in Chromium and both are
  written into the block comment — keep them.
- **Do not copy the sample file's component rules.** `design/tokens.css` ends with
  `[data-surface="pos"] .btn, [data-surface="pos"] button { min-height: var(--touch-min); }`. That is
  a RULE, not a token, and `src/lib/styles/tokens.css` is the token file. The POS touch floor is a
  component contract T-13 documents; element-level defaults live in `src/lib/styles/base.css`. Note
  that copying it would also break the "exactly one `[data-surface="pos"]`" count above.
- **`docs/design-system.md` line 141 (section 7b) names all four retired tokens** as "the POS chrome
  tokens" that must not appear on a dashboard screen. Do **not** edit it here — T-12 owns that
  document — but report it, because T-12 as written in `05-document.md` does not cover that line.
- No POS page exists yet and this plan builds none — the target hardware is an unanswered open
  decision (spec 33 decision 1: one shared POS device, or a tablet as a second registered terminal
  later). This block produces no visible CSS for any current route; that is expected, not a failure.

---

### T-04 — Guard the pinned device surface and the retirement

**Needs:** T-03 (the `[data-surface="pos"]` block this test parses, and the retirement it asserts)
**Files:**
- `src/lib/styles/tokens.test.ts` — EDIT (six places; **locate each by symbol, not by line number** —
  the line numbers below are from the base branch and T-03 does not touch this file, so they should
  hold, but a symbol never goes stale: the parsed constants and the `palettes` map at lines 74–87;
  `it('parsed a real palette out of all three blocks')` at line 90;
  `it('declares every dark-block token in the bare :root as well')` at line 97;
  `it('keeps the POS chrome un-themed — bare :root only, neither dark block')` at line 127, which is
  replaced entirely; the `ratioOf` signature at line 202; and the state loop inside
  `describe('the contrast floor holds in BOTH themes')` at lines 245–266, plus one new `describe`
  appended after it)

**Spec:** none — `docs/spec.md` says nothing about colour or contrast. The floors asserted here are
WCAG SC 1.4.3 (text 4.5:1) and SC 1.4.11 (UI components and focus indicators 3:1), which CLAUDE.md's
"Design & UI" section calls non-negotiable in every surface state.
**Invariants:** 5 (the POS surface must work offline — this test is node-side file parsing and starts
no browser and no server). CLAUDE.md design rules: every `--c-*` exists in the bare `:root`; one
source of colour truth; a failing pair is re-solved, never dropped.

**What this task must prove, stated before the steps, because the steps are the implementation of
it.** Six properties, and the first three are the correction this guard exists for:

1. the scope declares the **full** token set, not just the grounds;
2. **no dark block re-declares any of it** — `[data-surface="pos"]` appears exactly once;
3. the scope's non-ground values **equal the bare `:root`'s post-re-tune light values**, so the two
   cannot silently drift;
4. both `var()` aliases are **declared inside the scope**;
5. the four chrome tokens are **gone**, from the palette and from `@theme inline`;
6. the six category bands clear **3:1** on the key face and on every POS ground.

**Do:**

1. **Parse the one new block.** After
   `const stampDark = parseTokens(blockOf(css, ':root[data-theme="dark"]'));` (line 78), add:
   ```ts
   // Anchored to the START OF A LINE, deliberately. The device surface is reached
   // by a BARE selector at column 0; a match that is preceded by anything is a
   // descendant rule such as `:root[data-theme="dark"] [data-surface="pos"]`, which
   // is exactly what the POS must never have. The count assertion below is what
   // turns that from a comment into a guard.
   const posAt = css.search(/^\[data-surface="pos"\]\s*\{/m);
   expect(
   	posAt,
   	'the bare [data-surface="pos"] scope is missing from tokens.css'
   ).toBeGreaterThanOrEqual(0);

   const posScopeBlock = blockAt(css, posAt);
   const posScope = parseTokens(posScopeBlock);
   ```
   `stripComments()` already ran on line 72, so no selector can be matched inside a comment.

2. **Extend the `palettes` map from two states to three — three, not four.** Replace the map at lines
   82–85:
   ```ts
   const palettes = {
   	light: bare,
   	dark: new Map([...bare, ...stampDark]),
   	// ONE POS state, not two. The device surface is pinned LIGHT in BOTH themes:
   	// the scope declares the COMPLETE palette and no dark block re-declares any of
   	// it, so a dark-theme viewer sees these same values. `bare` is spread first
   	// only to carry the few names the scope does not pin — the six --c-cat-* bands,
   	// which are declared in the bare :root and in no dark block and therefore
   	// cannot carry a dark value into the till.
   	pos: new Map([...bare, ...posScope])
   } as const;

   // The same wrapper under a DARK root, resolved in cascade order. It must be
   // value-for-value identical to `pos`; that identity IS the pinning rule, and the
   // test below is the only thing standing between a dark-theme viewer and --c-ink
   // #e6eaec on the white key face (1.21:1).
   const posUnderDark = new Map([...bare, ...stampDark, ...posScope]);
   ```
   Widen `ratioOf`'s third parameter from `theme: 'light' | 'dark'` to
   `state: keyof typeof palettes` (line 202) and rename the local uses accordingly. Change nothing
   else in `ratioOf` — its `resolve()` calls and its "did not resolve to a hex" assertions already do
   the right thing, and `resolve()`'s one-level `var()` follow is what makes `--c-ring` and
   `--c-control-line` evaluate per state.

3. **Replace `POS_CHROME` (line 87)** with the four lists this file now needs. Three of them are
   DERIVED — the house pattern is discover, then assert the discovery, then assert the rule, and a
   hand-maintained list of "what the POS must pin" is exactly the thing that goes stale the day a
   token is added to the palette:
   ```ts
   // Retired by T-03 on 2026-09-14 when the POS stopped being a pinned-dark shell.
   // Once [data-surface="pos"] re-declares the ordinary names for the till, these
   // four had no consumer: two vocabularies for one surface is exactly what the
   // scope removes.
   const RETIRED_CHROME = ['--c-screen', '--c-key', '--c-key-line', '--c-key-ink'];

   // Every token a dark block re-declares is a token whose value CHANGES with the
   // theme — so the pinned device surface must declare it or inherit the dark one.
   const THEMED = [...new Set([...mediaDark.keys(), ...stampDark.keys()])];

   // Aliases: a bare-:root token whose value is a var() reference. They are NOT in
   // THEMED, because they are declared once on :root and recompute there. They do
   // not recompute on a <div>, so the scope must carry its own copy of each.
   // Derived, so the day T-10 turns --c-shadow into var(--c-shadow-raised) this
   // list grows on its own instead of silently leaking a dark rung into the till.
   const ALIASES = [...bare]
   	.filter(([, value]) => /^var\(/.test(value.trim()))
   	.map(([name]) => name);

   const POS_PINNED = [...new Set([...THEMED, ...ALIASES])];

   // The six the till sets to its OWN values. Everything else it pins must match
   // the page's light palette exactly — see the drift guard below.
   const POS_GROUNDS: Record<string, string> = {
   	'--c-bg': '#e4e9ee',
   	'--c-bg-2': '#e1e6eb',
   	'--c-raise': '#ffffff',
   	'--c-raise-2': '#f4f7f9',
   	'--c-line': '#c8d1d8',
   	'--c-line-soft': '#dce3e8'
   };

   const CATEGORY_BANDS = [
   	'cat-grills', 'cat-rice', 'cat-somali', 'cat-drinks', 'cat-sides', 'cat-sweets'
   ];
   ```

4. **Assert the discovery** (line 90). Rename
   `it('parsed a real palette out of all three blocks')` to
   `it('parsed a real palette out of all four blocks')` and add:
   ```ts
   expect(posScope.size).toBe(POS_PINNED.length);
   // A derived list that silently shrank would make every check below vacuous.
   expect(POS_PINNED.length, 'the POS surface pins 33 tokens: 6 grounds, 3 inks, 3 accent, ' +
   	'6 semantic, 12 status, 2 aliases and --c-shadow. A different number means the palette ' +
   	'gained or lost a themed token and the device surface has not been re-solved for it.').toBe(33);
   expect(ALIASES).toContain('--c-ring');
   expect(ALIASES).toContain('--c-control-line');
   ```
   A selector typo would otherwise yield an empty map that passes every assertion below it.

5. **Completeness** (line 97). Add `['[data-surface="pos"]', posScope]` to the array
   `it('declares every dark-block token in the bare :root as well')` loops over, and rename the test
   to `'declares every non-bare-block token in the bare :root as well'`. A name that exists only
   inside the scope would be undefined on every other surface — and this is the assertion that
   catches `--c-danger-ink` if someone copies it out of `design/tokens.css` section 3, which declares
   a token the application palette does not have.

6. **Four new cases inside `describe('the token contract')`** — properties 1 to 4 of the six above:
   - `it('the POS scope pins the COMPLETE palette, not just the grounds')` — assert **both
     directions** against `POS_PINNED`: no entry missing from `posScope`, and no key in `posScope`
     outside the list. Failure message for a **missing** key, and it is the most important string in
     this file: *pinning a surface means pinning EVERY token on it, not just the grounds. `<name>` is
     re-declared by the dark theme, so a POS that does not pin it inherits the PAGE value — on a
     dark-theme machine that is dark-theme ink on a white key face, measured at 1.21:1 for `--c-ink`,
     2.13 for `--c-ink-2` and 2.65 for `--c-ink-3`. That is the same defect as the original
     pinned-dark shell (1.08:1), mirrored. Declare it in `[data-surface="pos"]`.* Failure message for
     an **extra** key: *it is not part of the palette either dark block declares, so nothing can
     change it per theme and the scope should not restate it.*
   - `it('no dark block touches the POS surface')` —
     `expect(css.match(/\[data-surface="pos"\]/g)?.length).toBe(1)`, and assert that neither
     `blockOf(css, '@media (prefers-color-scheme: dark)')` nor
     `blockOf(css, ':root[data-theme="dark"]')` contains the string `data-surface`. Failure message:
     *the till is a device, not page chrome: it does not follow the viewer's OS preference. A dark
     override re-creates the half-pinned surface this guard exists to prevent.*
   - `it('a dark root cannot change a single POS value')` — diff `posUnderDark` against
     `palettes.pos` key by key and expect the list of differing names to be `[]`, naming them in the
     message. This is property 2 proved by cascade rather than by grep: whatever the page theme
     resolves to, the till resolves to the same 33 values.
   - `it('the POS block carries the page LIGHT palette, value for value')` — the drift guard. For
     every `POS_PINNED` name that is **not** in `POS_GROUNDS`, assert `posScope.get(name)` equals
     `bare.get(name)`, comparing on whitespace-normalised strings (`v.replace(/\s+/g, ' ').trim()`)
     so the multi-part `--c-shadow` value does not fail on spacing. Failure message: *the POS pins the
     LIGHT palette. If the page's light value changed, the till's copy must change with it — a surface
     that is pinned to a stale palette is a second source of colour truth.* Then assert the six
     `POS_GROUNDS` literally, so the till's own values are pinned rather than merely different.

7. **The one expected divergence, dated and self-expiring.** T-03 writes the **post-re-tune** light
   `--c-ink-3` `#5c6771` into the POS block, while the bare `:root` still holds `#646f7a` until T-06.
   That is one deliberate disagreement, and it must not be allowed to become a habit:
   ```ts
   // NOT an exemption — a deferral with an expiry. T-03 writes the FINAL light
   // value into the POS block so the two can never be re-tuned apart; T-06 then
   // installs the same value in the bare :root and VERIFIES this block rather than
   // editing it. Each entry asserts the divergence is STILL exactly what was
   // predicted; the moment T-06 lands, the `bare` assertion fails and prints the
   // instruction to delete the entry. T-07 removes the map when it widens the
   // census in Phase 2.
   const PENDING_RETUNE: Record<string, { pos: string; bare: string; why: string }> = {
   	'--c-ink-3': {
   		pos: '#5c6771',
   		bare: '#646f7a',
   		why:
   			'T-06 re-tunes the light --c-ink-3 to #5c6771. The POS grounds were solved against ' +
   			'that value (4.73 on --c-bg, 4.60 on --c-bg-2; the un-tuned #646f7a measures 4.20 and ' +
   			'4.08 and fails), so T-03 wrote it here directly. When this assertion fails because ' +
   			'the bare :root now holds #5c6771 too, T-06 has landed: delete this entry and let the ' +
   			'equality rule stand on its own.'
   	}
   };
   ```
   Handle an entry inside step 6's drift loop: assert `posScope.get(name)` is `pending.pos` and
   `bare.get(name)` is `pending.bare`, then `continue`. Add
   `it('every PENDING_RETUNE key names a token the POS actually pins')` asserting each key is in
   `POS_PINNED` and not in `POS_GROUNDS`, so a typo cannot quietly defer nothing. Following the repo's
   schema-guard precedent (`src/lib/server/db/schema-guards/schema.test.ts`): the list is explicit,
   each entry carries its reason, and adding one is a plan's decision, never a convenience.

8. **Replace `it('keeps the POS chrome un-themed — bare :root only, neither dark block')` (line 127)
   entirely** with the retirement guard. Do not adapt it — the tokens it pinned are gone:
   ```ts
   it('the four POS chrome tokens are retired', () => {
   	// Until 2026-09-14 the POS shell was pinned dark in both themes and these four
   	// carried it. The shell is still pinned — light, now, and complete — but it is
   	// pinned in [data-surface="pos"] using the ordinary --c-bg / --c-raise /
   	// --c-ink names. Keeping the old family would leave two vocabularies for one
   	// surface, which is the thing the scope exists to remove.
   	const themeInline = blockOf(css, '@theme inline');
   	for (const token of RETIRED_CHROME) {
   		expect(
   			css.includes(token),
   			`${token} is still declared in tokens.css. It was retired with the pinned-dark ` +
   				'POS shell on 2026-09-14; the POS surface now declares the ordinary palette names ' +
   				'inside [data-surface="pos"]. Use those.'
   		).toBe(false);
   	}
   	for (const utility of ['--color-screen', '--color-key', '--color-key-line', '--color-key-ink']) {
   		expect(
   			themeInline.includes(utility),
   			`${utility} still maps a utility onto a retired token. @theme inline emits ` +
   				'var(--c-screen), so bg-screen would compile to an unresolvable reference and ' +
   				'render as nothing, with no error anywhere.'
   		).toBe(false);
   	}
   });
   ```
   Leave `it('declares the dashboard scale tokens T-02 added')` (line 144) alone. It asserts
   `--c-ring` and `--c-control-line` are not repeated in the two ROOT dark blocks, which is still
   true and still correct — those blocks target `:root`, the same element the alias sits on, so the
   alias recomputes there. The POS block is a different element and a different case; step 6 asserts
   the opposite rule for it, and the two are not in conflict.

9. **Run the existing pair lists over all three states.** In
   `describe('the contrast floor holds in BOTH themes')` (rename it to
   `describe('the contrast floor holds in every surface state')`), change the loop at line 246 from
   `for (const theme of ['light', 'dark'] as const)` to
   `for (const state of ['light', 'dark', 'pos'] as const)`, and write the reason in a comment so it
   is not undone from memory:

   > The POS is ONE state, not two, because it is pinned light in both themes. An
   > earlier version of this plan forbade adding the POS to this loop at all — the
   > pinned-dark shell re-declared only two grounds while `TEXT_PAIRS` reads four. The
   > scope now declares every ground AND every ink, so the whole list is legal on it.

   `TEXT_PAIRS` has 30 entries and `NON_TEXT_PAIRS` 4, giving 90 + 12 cases across three states.

   **No POS pair is deferred and none may be.** Every one of the 30 text pairs clears 4.5:1 on the
   device surface at the values T-03 writes (tightest **4.96**), and all four non-text pairs clear
   3:1 (tightest **4.73**). The `pos-dark: danger on raise` deferral that an earlier version of this task
   carried described a state that no longer exists.

10. **The new describe**, appended after the contrast block — the things the device surface has that
    no themed state does:
    ```ts
    /* ── The POS device surface ──────────────────────────────────────────────
       Pinned LIGHT in both themes. Properties the shared pair lists cannot
       express. */
    describe('the POS device surface', () => {
    ```
    - `it('sets color-scheme: light so the UA chrome follows the surface')` —
      `expect(posScopeBlock).toMatch(/color-scheme:\s*light/)`, so scrollbars, the caret and native
      controls match the till rather than the viewer's OS preference.
    - `it('re-declares its var() aliases instead of inheriting them')` — assert
      `posScope.has('--c-ring')` and `posScope.has('--c-control-line')`. **A declaration check,
      deliberately, not a contrast check.** `resolve()` follows `var()` inside whichever map it is
      handed, so it would happily report the POS accent for an alias the browser actually resolves at
      `:root`. Put the reason in the failure message: a custom property's `var()` is substituted at
      computed-value time on the element that declares it, and what inherits is the resolved literal,
      so an alias declared on `:root` carries the PAGE value into the shell. This is the only defence
      the test file has against it.
    - `it('a key face needs a border, not just elevation')` — assert `ratioOf('raise', 'bg', 'pos')`
      is **below 3** (it is 1.22), and that `ratioOf('control-line', 'raise', 'pos')` (5.78) and
      `ratioOf('control-line', 'bg', 'pos')` (4.73) are both **at or above 3**. The failure message
      carries the rule: the ground/key relationship is a density cue, not a boundary — WCAG 1.4.11
      wants 3:1 for the edge of a UI component, so every pressable surface on the POS takes
      `border: 1px solid var(--c-control-line)`, and `--c-line` (1.27 on the POS ground) is decorative
      only. Asserting the 1.22 **is the point**: if someone lightens the POS ground until the key
      "pops", this test tells them elevation still is not a boundary.
    - `it('every category band is declared in the bare :root only')` — each `--c-cat-*` present in
      `bare`, absent from `mediaDark`, `stampDark` **and** `posScope`. Failure message: *the bands are
      solved for the pinned-light device surface and have no dark values; declaring one in a dark
      block would put a 1.85–2.33:1 band on a dark ground. With the POS pinned light the bands need no
      dark value — unless a band is used on the DASHBOARD, which does theme, and that is a decision to
      surface and record, not a hex to invent here.*
    - `it.each(...)` over `CATEGORY_BANDS` × `['bg', 'bg-2', 'raise', 'raise-2']` through
      `ratioOf(band, ground, 'pos')` at `>= 3` — 24 cases, reusing the existing failure-message style:
      the measured ratio to two decimals, and the instruction that a failing band is re-solved, never
      dropped. Add one `expect(CATEGORY_BANDS).toHaveLength(6)` so a silently shrinking list fails.
    - `it('bg-bg is the POS ground and bg-raise the POS key face')` — assert
      `resolve('bg', palettes.pos)` is `'#e4e9ee'` and `resolve('raise', palettes.pos)` is
      `'#ffffff'`, **and that both are unchanged in `posUnderDark`**. Cheap, and it is what makes the
      portable class names in T-05 provable rather than asserted.

**Tests:** (this task *is* the test — House guard test, CLAUDE.md "Design & UI"; none of spec 29's
six mandatory areas is touched, so nothing here is marked MANDATORY)

Expected measurements on a correct implementation. The `pos` state is computed from the values T-03
writes, so — unlike `light` and `dark` — **none of these moves when T-06 lands**:

- `pos` text on the four grounds `bg` `#e4e9ee` / `bg-2` `#e1e6eb` / `raise` `#ffffff` /
  `raise-2` `#f4f7f9` — `ink` **14.19 / 13.80 / 17.33 / 16.11** · `ink-2` **6.15 / 5.98 / 7.51 /
  6.98** · `ink-3` **4.73 / 4.60 / 5.78 / 5.37** (only `ink-3 on raise` is in the narrowed
  `TEXT_PAIRS`; T-07's census asserts all four, where **4.60** is the tightest pair on the surface).
- `pos` text, ink on `bg` / `raise` — `accent` **5.02 / 6.13** · `ok` **5.27 / 6.44** ·
  `warn` **4.96 / 6.05** · `danger` **5.44 / 6.65** · `st-new` **5.02 / 6.13** ·
  `st-sent` and `st-paid` **5.27 / 6.44** · `st-voided` **5.44 / 6.65** ·
  `st-billed` and `st-offline` **4.96 / 6.05** (spec 6's unsynced count) ·
  `accent-ink on accent` **6.13**. Tightest asserted text pair: **4.96**.
- `pos` non-text at 3:1 — `control-line` **5.78** on `raise`, **4.73** on `bg` · `ring` **5.02** on
  `bg`, **6.13** on `raise`.
- Key face vs ground, asserted BELOW 3 — **1.22**. `--c-line` on that ground, for the record: **1.27**.
- Category bands at 3:1 in `pos` — on `raise`: grills 6.79 · rice 6.24 · somali 6.13 · drinks 6.42 ·
  sides 7.70 · sweets 6.96; on `bg`: 5.55 · 5.10 · 5.02 · 5.25 · 6.31 · 5.70; on `bg-2`: 5.40 · 4.97 ·
  4.88 · 5.11 · 6.13 · 5.54; on `raise-2`: 6.31 · 5.80 · 5.70 · 5.96 · 7.16 · 6.47. Tightest **4.88**.
- Structure — `posScope.size` is **33** and equals `POS_PINNED.length`; `[data-surface="pos"]` occurs
  **once** in comment-stripped `tokens.css`; `posUnderDark` differs from `palettes.pos` in **zero**
  tokens; every non-ground pinned value equals the bare `:root`'s, with exactly **one**
  `PENDING_RETUNE` entry (`--c-ink-3`) until T-06 lands; the four retired chrome names appear nowhere
  in comment-stripped `tokens.css` and nowhere in `@theme inline`; the six bands are in the bare
  `:root` and in no other block; `TEXT_PAIRS` × 3 states = **90** text cases and `NON_TEXT_PAIRS` × 3
  = **12**.

**Done when:** `pnpm test:unit src/lib/styles/tokens.test.ts` passes with **no test removed or
skipped**, `pnpm check` and `pnpm lint` are clean, and the guard is shown to actually guard by three
mutations, each reverted afterwards:

1. Delete the `--c-ink:#161b20;` declaration from the `[data-surface="pos"]` block → the suite must
   fail with the "pinning a surface means pinning EVERY token on it" message naming `--c-ink`. **This
   is the mutation that matters**: it is the exact defect — grounds pinned, ink inherited — that the
   previous version of this plan shipped as the design.
2. Change `--c-control-line: var(--c-ink-3)` to `var(--c-line)` in that block → the suite must fail
   with `control-line on bg measures 1.27:1 in pos`.
3. Delete the `--c-ring: var(--c-accent)` line from that block → the suite must fail with
   `[data-surface="pos"]` missing `--c-ring`, from step 6's both-directions check. It must **not**
   fail any contrast case, which is precisely why step 10's declaration check exists.

**Watch out:**
- These tests read CSS as **text**. `vitest.config.ts` defines exactly two projects, `unit` and
  `integration`, both `environment: 'node'` — no jsdom, no browser mode, no
  `@testing-library/svelte`, no svelte plugin — so nothing here can mount a component or read a
  computed style, and none of that is to be added. The test proves a token exists and that a pair
  meets a ratio; it cannot prove a page looks right.
- Keep using the existing `stripComments` / `blockAt` / `blockOf` / `parseTokens` helpers. Do not
  write a second parser: `blockAt` is brace-balanced for a reason (a dark media query WRAPS a second
  selector, so its closing brace is not the first one) and `parseTokens` splits on `;` because the
  palette packs several declarations per line.
- **`blockOf` matches the first occurrence of a selector STRING**, and two strings in this file are
  prefixes of another: `:root {` and `:root[data-theme="dark"]`. Those parses survive because T-03
  inserts the POS rule AFTER the root palette blocks. That is also why step 1 finds the scope with a
  line-anchored regex rather than `indexOf` — and why the anchor is not cosmetic: it is what would
  refuse to parse a `:root[data-theme="dark"] [data-surface="pos"]` rule as if it were the scope.
- **Never lower a floor to make a case green**, and never "fix" a POS failure by letting a token
  theme again. A pair that fails on the device surface is re-solved at the value. Deleting a pair from
  `TEXT_PAIRS` makes the guard pass while the screen still fails, and CLAUDE.md's repair rule is
  explicit about it.
- **`PENDING_RETUNE` holds ONE entry and it is a VALUE divergence, not a contrast deferral.**
  `03-palette.md`'s T-06 describes deleting an entry keyed `pos-dark:danger:raise` — that is the
  superseded shape, from when the POS had a dark state. Report the discrepancy; the entry T-06 must
  delete is `--c-ink-3`.
- The later task that regenerates `TEXT_PAIRS` as a full surface × ink census (T-07, Phase 2) must
  keep all three states in the loop and delete `PENDING_RETUNE` once T-06 has landed — it is the task
  that inherits both. The census on the device surface is **182 pairs, 0 failures, tightest 4.60**.

---

### T-05 — Stamp `data-surface="pos"` on the `(pos)` route group shell

**Needs:** T-03 (without the scope block the attribute selects nothing)
**Files:**
- `src/routes/(pos)/+layout.svelte` — EDIT (the markup after `</script>`, currently the single line
  `{@render children()}`; and the two-constraint comment block inside `<script lang="ts">`)
- `src/routes/surface-scope.test.ts` — NEW

**Spec:** none for the styling. Spec 6 is why the shell may not depend on the network: a completed
offline cash sale is a recorded fact, so the POS surface renders with no server reachable.
**Invariants:** 5 (a completed offline CASH sale is a recorded FACT, not a request the server may
reject — the POS shell must work with no network: no blocking server `load`, no `fetch`, no
`$lib/server` import), 8 (permissions are enforced server-side on every route — this task adds no
route, no `+server.ts`, no form action and no permission key, and must not).

**Do:**
1. Wrap the render tag in `src/routes/(pos)/+layout.svelte`:
   ```svelte
   <!-- The POS device surface. src/lib/styles/tokens.css declares the COMPLETE
        palette inside [data-surface="pos"], pinned LIGHT in both themes: the till
        is a device, and its surface is a property of the hardware on the counter,
        not of the viewer's OS preference. Its ground is DEEPER than the page's so
        the white key faces read as raised. Token names are the ordinary ones, so a
        component uses `bg-raise text-ink` here exactly as it does on a dashboard
        card — only the values differ, and here they stop differing by theme. -->
   <div data-surface="pos" class="bg-bg text-ink min-h-screen">
   	{@render children()}
   </div>
   ```
   Each class earns its place. `src/lib/styles/base.css` paints
   `body { background-color: var(--c-bg) }`, which resolves at the **root** and is therefore the PAGE
   ground — `#e9edf0` in light, `#15181b` in dark. Without `bg-bg` on this element, a dark-theme
   viewer gets a near-black page behind a light till, and in light the one visual difference the scope
   exists to create never appears. The shell must paint its own ground: inside the scope `bg-bg`
   resolves to `#e4e9ee` and `text-ink` to `#161b20` (**14.19:1**) — in **both** themes.
   `min-h-screen` keeps that ground covering the viewport on a short page. On the page ground a white
   key measures 1.18:1; on the POS ground, 1.22:1 — a small number that is the whole design, and the
   reason every pressable surface still needs its `border-control-line` (T-03, WCAG 1.4.11). Write the
   portable names (`bg-bg`, `text-ink`) — there is no other kind: the four POS-specific colour
   utilities were retired by T-03 and `bg-screen` / `text-key-ink` no longer compile.
2. Keep the existing two-constraint comment in the `<script>` block and add a third, in the same
   voice: the `data-surface="pos"` attribute is what selects the till's palette; it must stay on an
   element **inside `<body>`** and must never move to `<html>` or `<body>`. Give both reasons — on the
   same element `:root[data-theme="dark"]` (specificity 0,2,0) **outranks** `[data-surface="pos"]`
   (0,1,0), so a dark-stamped page would beat every pinned value and the till would render the dark
   palette, which is the exact defect the pinned scope exists to prevent; and in light mode the POS
   palette would apply to the entire document, dashboard included. `<body>` is shared with the
   dashboard, which must keep the page grounds. On a **descendant** element specificity never
   competes: the nearer declaration wins by inheritance, which is why the attribute belongs here.
3. Add nothing else to this file: no `import` from `$lib/server`, no `+layout.server.ts` and no
   `+page.server.ts` anywhere under `src/routes/(pos)/` (a blocking server load is the seam that makes
   offline impossible), no `fetch(`, no `onMount` network call. `eslint.config.js` already enforces
   the import half with `no-restricted-imports` over `src/routes/(pos)/**`; the rest is enforced by
   the test below.
4. Do **not** add a theme branch, a `dark:` variant or a `prefers-color-scheme` query anywhere in this
   file. The surface does not theme; that is settled in `tokens.css` and nowhere else.
5. Do **not** create a page under `(pos)`. There is none today and this plan builds none — the POS
   target hardware is an unanswered open decision (spec 33 decision 1). The wrapper renders nowhere
   until a POS page exists, so `pnpm dev` shows nothing new; the guard test is the verification.
6. Create `src/routes/surface-scope.test.ts`, modelled on `src/routes/route-guards.test.ts`:
   node-side, reading files as **text**. `vitest.config.ts` has two `environment: 'node'` projects and
   no jsdom, no browser mode, no `@testing-library/svelte` and no svelte plugin, so a `.svelte` file
   **cannot** be mounted — every assertion is a string or regex check on the source. The `unit`
   project's `include: ['src/**/*.test.ts']` picks the file up with no config change.
7. Discover, then assert the discovery, then assert the rules (the house pattern from
   `src/lib/server/db/schema-guards/schema.test.ts`: never hand-maintain the list of things you
   check, and make a walk that found nothing fail loudly):
   - `findLayouts()` — recursive walk of `src/routes` collecting every `+layout.svelte`.
   - `it('finds route layouts to check at all')` → `expect(layouts.length).toBeGreaterThanOrEqual(3)`
     (the root layout, `(dashboard)`, `(pos)`).
   - `it('exactly one layout opens the POS surface scope')` — the layouts whose source matches
     `/data-surface\s*=\s*"pos"/` are exactly `['(pos)/+layout.svelte']`. Compare on paths relative to
     `src/routes`, so the message names the file.
   - `it('the POS layout paints its own ground')` — that file's source contains `bg-bg` and `text-ink`
     on the same element as `data-surface="pos"`; failure message: `base.css` paints `body` from the
     ROOT palette, so without these the till renders on the page's ground — `#e9edf0` in light and
     `#15181b` in dark — instead of the POS ground `#e4e9ee`, and the ground/key relationship the
     scope exists to create is gone.
   - `it('no layout stamps a surface on the document root')` — neither `src/routes/+layout.svelte` nor
     `src/routes/(dashboard)/+layout.svelte` contains `data-surface`, and neither does `src/app.html`
     (where `%matcami.theme%` stamps the theme on `<html>` and where someone would be tempted to put
     it). Failure message: on `<html>` the theme stamp outranks the surface attribute, so the pinned
     palette loses to the dark palette on exactly the machines it was pinned for.
   - `it('the POS group has no blocking server load')` — no `+page.server.ts` and no
     `+layout.server.ts` exists anywhere under `src/routes/(pos)`.
   - `it('the POS layout imports no server module and fetches nothing')` — its source contains neither
     `$lib/server` nor `fetch(`.

**Tests:** House guard test (CLAUDE.md "Design & UI"; invariant 5's offline rule) — six cases as
listed in step 7. None of spec 29's six mandatory areas is touched, so nothing here is marked
MANDATORY. Expected results on a correct implementation: 3 layouts discovered; the POS-scope match
set is exactly `(pos)/+layout.svelte`; zero server files under `(pos)`; zero `data-surface`
occurrences in `src/app.html`, `src/routes/+layout.svelte` and
`src/routes/(dashboard)/+layout.svelte`.

**Done when:** `pnpm test:unit src/routes/surface-scope.test.ts` passes with 6 cases; `pnpm check`,
`pnpm lint` and `pnpm build` are clean; and `pnpm test:e2e` still passes with **no edit to any e2e
spec** — `e2e/auth.spec.ts` and `e2e/smoke.spec.ts` never reach the `(pos)` group, and a wrapper
`div` changes no role, accessible name or text anywhere.

**Watch out:**
- The e2e specs pin the accessible surface and are frozen: heading names (`matcami`,
  `Set up your restaurant`, `Getting set up`, `Restaurant settings`), label text, button names
  (`Create restaurant`, `Save settings`, `Sign out`, `Sign in`), `role="alert"`, and
  `getByText('not started', { exact: true }).toHaveCount(5)`. No task in this plan may edit an
  existing e2e assertion — only add one. If this change appears to require an e2e edit, that is a
  finding to report, not an edit to make.
- `src/app.html` renders `<div style="display: contents">%sveltekit.body%</div>`. That div lays out as
  though it were absent but is still in the inheritance chain; nothing about the scope depends on it,
  and it must not be "tidied away".
- `src/routes/(pos)/+layout.svelte` is **not** in `.prettierignore` — run `pnpm format` (or match the
  file's existing tab indentation) or `pnpm lint` fails on `prettier --check`.
- Parenthesised group directories are awkward in a shell: quote the path
  (`'src/routes/(pos)/+layout.svelte'`) in every command, and in the test build the path with
  `join(ROUTES_DIR, '(pos)', '+layout.svelte')` rather than a glob.
- Do not add `data-surface="pos"` to a component, a page or a nested wrapper. One element opens the
  surface, at the group's root. A second one inside it changes nothing (the values are identical) but
  breaks the `exactly one layout` guard's premise the day someone stamps a different surface name.
- **If the till looks "too bright" next to a dark dashboard, that is the specification, not a bug.**
  The fix for a glare complaint is a hardware or decision change the user makes — recorded as a
  reversal, the way the last two were — never a `dark:` class added here.
