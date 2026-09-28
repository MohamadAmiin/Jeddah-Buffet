# Phase 2 — Re-tune the palette at source

Thirty ink-on-surface pairs in the shared palette measure below WCAG 1.4.3's 4.5:1 floor — twelve in
the light theme, eighteen in the dark — and the current guard works around them by asserting only a
narrowed "legal pairs" subset; this phase fixes the four token values that cause all thirty, widens
the guard from that subset to the full census, and re-syncs the one document that keeps its own
hand-copied copy of the palette.

**Depends on:** Phase 1

---

### T-06 — Re-tune the four failing ink values in `src/lib/styles/tokens.css`

**Needs:** T-01 (records that the palette freeze is lifted: colour VALUES may now change, subject to
a computed contrast gate), T-03 (adds the `[data-surface="pos"]` block this task must VERIFY and must
not edit — see step 1)
**Files:**
- `src/lib/styles/tokens.css` — EDIT (three separate places: the bare `:root` block, the
  `@media (prefers-color-scheme: dark)` block, and the `:root[data-theme="dark"]` block — the dark
  palette is declared TWICE, byte-identical, and both copies must change)
- `docs/design-system.md` — EDIT (section `## 7b. Dashboard component rules` only — the
  `### Legal ink-on-surface pairs` sub-section and the `**Control borders.**` paragraph. Leave
  sections 2, 4 and 9 alone; a later task in this plan rewrites those)

**Spec:** none. `docs/spec.md` is silent on UI — zero occurrences of font, colour, typography, WCAG,
accessibility, contrast, layout or touch — so no spec section may be cited for a design rule here.
The authority is CLAUDE.md's "Design & UI" section ("WCAG AA (4.5:1) at normal text size, in both
themes, for every text-on-surface pair. Verify before adding a colour.") and `docs/design-system.md`.
WCAG is cited by success criterion: **1.4.3** text contrast 4.5:1, **1.4.11** non-text contrast 3:1.

**Invariants:** 1 (money is integer minor units, and the UI never formats or does arithmetic on
money — this task adds no formatter, no `.toFixed`, no `/100`, no `Intl.NumberFormat`, and no money
component anywhere); 5 (a completed offline sale is a recorded fact, so the POS surface must work
with no network — `tokens.css` is loaded by the POS shell, so nothing added here may introduce a
fetch, a third-party origin or a build step). This task writes NO migration, NO schema, NO database
column, NO server route, NO `+server.ts`, NO form action and NO permission key. If it appears to need
one, stop and report it rather than adding it.

**Do:**

1. Open `src/lib/styles/tokens.css`. **Locate every edit by selector and token name, never by line
   number** — an earlier task in this plan inserted a `[data-surface="pos"]` block into this file and
   the line numbers below no longer hold. **Do not touch that block**, and when you grep, confirm
   which block each hit is in before editing.

   **THE POS BLOCK IS A VERIFICATION DUTY OF THIS TASK, NOT AN EDIT.** `[data-surface="pos"]` is
   **light in both themes and pins the COMPLETE palette** — grounds, all three inks, accent, the
   semantic colours, the six `--c-st-*` status colours with their soft grounds, the `--c-ring` and
   `--c-control-line` aliases and the three shadow rungs — and **no dark block overrides any of it**.
   Because it pins the LIGHT values and this task RE-TUNES the light palette, the two declarations of
   `--c-ink-3` can silently drift apart. That is decided one way, and this is the half of it you own:

   - **T-03 already wrote the final value** `--c-ink-3:#5c6771` inside the POS block. It never carried
     the pre-re-tune `#646f7a`.
   - **You VERIFY it; you do not edit it.** Run
     ``grep -n -- '--c-ink-3' src/lib/styles/tokens.css`` before touching anything. Expect **four**
     hits: the bare `:root` (still `#646f7a` at this point — step 2 is what changes it), the two dark
     blocks (`#8a949d` at this point), and the `[data-surface="pos"]` block already at **`#5c6771`**.
     If the POS block holds anything other than `#5c6771`, **stop and report it** — Phase 1 landed a
     block this task's numbers were not solved against, and editing it here would hide that.
   - **Do not add, remove or change a single declaration inside `[data-surface="pos"]`.** There is no
     "the re-tune reaches the POS for free" — that sentence belonged to a superseded draft in which
     the scope overrode grounds only and inherited its inks, and it is FALSE. The POS holds its own
     copy of every ink; this task keeps the copies in agreement by leaving the POS one alone and
     bringing the bare `:root` up to it.
   - T-04's guard asserts every **non-ground** token the POS pins equals the bare `:root`'s value —
     the three inks included, so the POS must carry the post-re-tune light triple `--c-ink` `#161b20`,
     `--c-ink-2` `#4a5661`, `--c-ink-3` `#5c6771`. After step 2 those two declarations agree for the
     first time; before step 2 only the POS side is final, which is exactly what T-04's one
     `PENDING_RETUNE` entry records. A drift introduced later fails the suite rather than reaching a
     screen.

   The POS state itself is already audited at **182 ink × ground pairs, 0 failures, tightest 4.60:1**
   (`ink-3` on `--c-bg-2` `#e1e6eb`) — solved against the re-tuned inks from the start, which is why
   T-03 wrote them. The un-tuned `#646f7a` would measure **4.08:1** there and fail; that is precisely
   why it is not what T-03 wrote. **The POS has no dark state** — no dark block overrides the scope —
   so there is no `pos-dark` half of the census anywhere in this phase.

   **One thing this task must DELETE, and it lives in another file: T-04's `PENDING_RETUNE` entry
   for `--c-ink-3`.** It is a **VALUE divergence, not a contrast deferral** — there is no failing POS
   pair to defer, because T-03 wrote the re-tuned inks and the POS census is clean from that commit.
   T-04 put exactly one entry in `PENDING_RETUNE` in `src/lib/styles/tokens.test.ts`, keyed
   `'--c-ink-3'`, recording the one deliberate disagreement between the POS block (`pos: '#5c6771'`)
   and the bare `:root` (`bare: '#646f7a'`), and asserting the divergence is **still exactly that**.
   Step 2 installs `#5c6771` in the bare `:root`, which makes that entry's `bare` assertion fail by
   design and print the instruction to delete the entry. **Deleting it is part of THIS task's diff**,
   not T-07's: the task that removes the cause removes the deferral, or this task ships a red suite.

   Delete the one entry only. Leave the `PENDING_RETUNE` map itself, and its
   `it('every PENDING_RETUNE key names a token the POS actually pins')` guard, in place for T-07,
   which removes the machinery when it widens the census. With the entry gone, T-04's
   `it('the POS block carries the page LIGHT palette, value for value')` drift guard stands on its
   own: every non-ground token the POS pins must equal the bare `:root`'s value, `--c-ink-3` now
   included.

   *(If you instead find an entry keyed `pos-dark:danger:raise`, Phase 1 landed a superseded draft in
   which the POS had a dark state and one contrast pair was deferred. Report it — the POS is pinned
   light in both themes and has no dark half — rather than deleting around it.)*

2. In the **bare `:root`** block, change the light `--c-ink-3` value and its inline annotation.
   The declaration sits on its own line among the three ink annotations:

   ```
   from:   --c-ink-3:#646f7a;  /* labels, table heads       5.1:1 */
   to:     --c-ink-3:#5c6771;  /* labels, table heads       4.55:1 on --c-bg-2, its tightest ground */
   ```

   The old `5.1:1` was measured against `--c-raise` only, while the dashboard navigation puts this
   ink on `--c-bg`. The new value measures **5.78:1** on `--c-raise`, **4.91:1** on `--c-bg` and
   **4.55:1** on `--c-bg-2` — the tightest ground, which is the honest number to annotate. Leave the
   `--c-ink` and `--c-ink-2` annotations exactly as they are: each already names the surface it was
   measured on.

3. In the **`@media (prefers-color-scheme: dark)`** block (selector `:root:not([data-theme="light"])`),
   make exactly three value changes, preserving the existing spacing so the columns stay aligned —
   every replacement hex is also six digits, so the alignment survives a straight swap:

   ```
   from:   --c-ink:#e6eaec; --c-ink-2:#a8b3bc; --c-ink-3:#8a949d;
   to:     --c-ink:#e6eaec; --c-ink-2:#a8b3bc; --c-ink-3:#97a0a8;

   from:   --c-ok:#5aa06f;   --c-ok-bg:#1b2a21;
   to:     --c-ok:#6eac81;   --c-ok-bg:#1b2a21;

   from:   --c-danger:#d97165; --c-danger-bg:#2c1d1b;
   to:     --c-danger:#df877c; --c-danger-bg:#2c1d1b;
   ```

4. Make the **same three changes** in the `:root[data-theme="dark"]` block. The two dark blocks are
   one palette reached by two selectors — the media query for an OS preference, the stamp for an
   explicit choice — and an existing test (`declares the SAME token names in both dark blocks`)
   plus the theme toggle both assume they agree. Changing one and not the other ships a page whose
   colours shift when the user picks the theme they already had.

5. **Change nothing else.** `--c-accent` (`#0f6b7e` / `#5cb4c9`), `--c-warn`, `--c-line`,
   `--c-line-soft`, the light `--c-ok` (`#2c6a48`) and light `--c-danger` (`#a13a2e`), every ground
   (`--c-bg`, `--c-bg-2`, `--c-raise`, `--c-raise-2`, `--c-accent-soft`, `--c-ok-bg`, `--c-warn-bg`,
   `--c-danger-bg`, the six `--c-st-*-bg`) and every `--c-st-*` ink all stay byte-identical. Those
   four values are the complete solution; a fifth change is a regression waiting to be found by the
   census in T-07. **Do not look for the four POS chrome tokens** (`--c-screen`, `--c-key`,
   `--c-key-line`, `--c-key-ink`) while you are in this file — Phase 1 retired them when the scope
   took over the POS grounds, so they are already gone. An earlier draft of this step listed them
   among the values that stay byte-identical; if you find them still present, Phase 1 is incomplete
   and that is a finding to report, not a thing to fix here.

6. `src/lib/styles/tokens.css` is listed in `.prettierignore`, so the formatter will neither fix nor
   complain about layout here. Keep the file's hand-laid-out compact groups by hand.

7. Repair `docs/design-system.md` section 7b, which publishes measurements of the values you just
   changed and would otherwise state four things that are no longer true:
   - Replace the whole `### Legal ink-on-surface pairs` sub-section — its heading, the
     `Check this table before pairing an ink with a surface…` paragraph, the six-row legal-pairs
     table, the `**The twelve measured failures — never write these.**` paragraph, its twelve-row
     table, and the closing `So: **text-ink-3 is legal only on bg-raise**…` paragraph — with:

     ```markdown
     ### Ink-on-surface pairs — the census

     **Every ink is legal on every themed surface, in both themes.** That is a property of the token
     values, not a rule of thumb: `src/lib/styles/tokens.test.ts` recomputes the full census on every
     `pnpm test:unit` run — each ground token against each ink token, in each palette state — and a
     pair below WCAG 1.4.3's 4.5:1 fails the suite.

     The census grounds are `bg`, `bg-2`, `raise`, `raise-2`, `accent-soft`, `ok-bg`, `warn-bg`,
     `danger-bg` and the six `st-*-bg`; the inks are `ink`, `ink-2`, `ink-3`, `accent`, `ok`, `warn`,
     `danger` and the six `st-*`. That is **182 pairs per palette state**, and **none** of them
     fails. The tightest is **4.55:1** in light (`text-ink-3` on `bg-bg-2`) and **4.62:1** in dark
     (`text-ok` on `bg-st-new-bg`). `text-accent-ink` on `bg-accent` measures **6.13:1** light and
     **7.82:1** dark.

     **A failing pair is repaired by re-solving the token's value and re-running the census — never
     by narrowing which pairs a screen may use.** This supersedes the earlier rule that `text-ink-3`
     was legal on `bg-raise` only and that `text-ok` and `text-danger` were illegal on `bg-raise-2`
     and `bg-accent-soft`: the twelve light and eighteen dark failures behind those restrictions were
     closed by re-tuning four values — `--c-ink-3` to `#5c6771` light and `#97a0a8` dark, `--c-ok` to
     `#6eac81` dark and `--c-danger` to `#df877c` dark.
     ```
   - In the `**Control borders.**` paragraph, replace `**5.13:1** light and **4.87:1** dark` with
     `**5.78:1** light and **5.66:1** dark on bg-raise, and never below **4.55:1** light /
     **4.63:1** dark on any themed ground`. Leave the rest of that paragraph alone — `border-line`
     still measures **1.58:1** on `bg-raise` and is still decorative-only, because `--c-line` is not
     one of the four values this task changes.
   - Leave the `**Focus.**` paragraph untouched: `--c-ring` derives from `--c-accent`, which does not
     change, so its **5.21:1** light / **7.49:1** dark figures remain correct.
   - `docs/` is listed in `.prettierignore`, so nothing will reflow these tables for you or against
     you.

8. Verify with the census before committing — see **Done when**.

**Tests:** House guard test (CLAUDE.md "Design & UI"). No test file changes in this task: the
existing `src/lib/styles/tokens.test.ts` asserts a deliberately narrowed pair list and stays green
throughout, because all four changes move contrast **up** on every pair it already checks
(`text-ink-3` on `bg-raise` goes 5.13 → 5.78 light and 4.87 → 5.66 dark; dark `text-ok` and
`text-danger` on `bg-bg` and `bg-raise` all rise). The next task widens that list to the full census.
The check for this task is the census script below, run before and after the edit.

- Before the edit it must print `light … 12 below 4.5:1`, `dark … 18 below 4.5:1` and
  `pos … 182 pairs, 0 below 4.5:1`. **The pos line is already clean before you start**, because the
  scope pins its own inks and T-03 wrote the re-tuned ones — see step 1. A pos line with failures
  means Phase 1 landed a block solved against the un-tuned values: stop and report.
- After the edit all three lines must print `182 pairs, 0 below 4.5:1`. Tightest surviving pairs:
  light `ink-3`/`bg-2` **4.55**, dark `ok`/`st-new-bg` **4.62**, pos `ink-3`/`bg-2` **4.60**.

**Done when:**

1. `grep -c -e '#646f7a' -e '#8a949d' -e '#5aa06f' -e '#d97165' src/lib/styles/tokens.css` prints
   `0`, and the same grep over `docs/design-system.md` prints `0`.
2. `grep -c -- '--c-ink-3:#97a0a8' src/lib/styles/tokens.css` prints `2` — the two dark blocks, and
   only those. **Two, not three.** `#97a0a8` is a DARK value and `[data-surface="pos"]` is pinned
   LIGHT in both themes, so the scope must never hold it; a `3` means Phase 1 landed a pinned-dark
   block, which is a finding to report rather than a line to delete here.
   Then `grep -c -- '--c-ink-3:#5c6771' src/lib/styles/tokens.css` prints `2` — the bare `:root`,
   changed by step 2, and the `[data-surface="pos"]` block, written by T-03 and untouched by this
   task. **The same grep printed `1` before this task, and that one hit was the POS block.** A `1`
   afterwards means step 2 never landed; a `3` means a declaration this plan does not specify was
   added. This pair of counts is the drift check in grep form — the same thing T-04's guard asserts
   in the suite.
3. Saved outside the repository so it is never committed (for example `/tmp/matcami-census.mjs`),
   this script, run from the repository root with `node /tmp/matcami-census.mjs`, prints
   `182 pairs, 0 below 4.5:1` for each of `light`, `dark` and `pos`. It throws by name if a selector
   is missing, so a scope that was never added fails loudly instead of printing a clean census of two
   states — and it throws again if the scope declares a ground or an ink short of the full palette,
   because a pinned surface that pins only some of its tokens is the defect this whole design closes:

   ```js
   import { readFileSync } from 'node:fs';
   const css = readFileSync('src/lib/styles/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
   const blockAt = (s, from) => { const o = s.indexOf('{', from); let d = 0;
     for (let i = o; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) return s.slice(o + 1, i); } };
   const parse = (b) => new Map(b.split(';').map((d) => /^\s*(--c-[a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(d)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
   const at = (sel) => { const i = css.indexOf(sel); if (i < 0) throw new Error(`selector not found: ${sel}`); return parse(blockAt(css, i)); };
   const bare = at(':root {');
   const dark = new Map([...bare, ...at(':root[data-theme="dark"]')]);
   // [data-surface="pos"] is LIGHT IN BOTH THEMES and pins the COMPLETE palette, so it is read
   // ON ITS OWN — never layered over the dark map, and there is no pos-dark state to build.
   const pos = at('[data-surface="pos"]');
   const ch = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
   const lum = (h) => { const x = h.replace('#', ''); const [r, g, b] = [0, 2, 4].map((i) => ch(parseInt(x.slice(i, i + 2), 16))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
   const ct = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
   const G = ['bg','bg-2','raise','raise-2','accent-soft','ok-bg','warn-bg','danger-bg','st-new-bg','st-sent-bg','st-voided-bg','st-billed-bg','st-paid-bg','st-offline-bg'];
   const I = ['ink','ink-2','ink-3','accent','ok','warn','danger','st-new','st-sent','st-voided','st-billed','st-paid','st-offline'];
   // Pinning a surface means pinning EVERY token on it, not just the grounds. Fail loudly on a
   // scope that leaves one to be inherited, rather than quietly censusing an inherited value.
   for (const n of [...G, ...I]) if (!pos.has(`--c-${n}`)) throw new Error(`[data-surface="pos"] does not pin --c-${n}`);
   for (const [name, p] of [['light', bare], ['dark', dark], ['pos', pos]]) {
     const fails = [];
     for (const g of G) for (const i of I) { const r = ct(p.get(`--c-${i}`), p.get(`--c-${g}`)); if (r < 4.5) fails.push(`${i}/${g} ${r.toFixed(2)}`); }
     console.log(name, G.length * I.length, 'pairs,', fails.length, 'below 4.5:1', fails.join(' '));
   }
   ```
4. `pnpm test:unit` and `pnpm lint` both pass, and `git status` shows exactly **three** modified
   files: `src/lib/styles/tokens.css`, `docs/design-system.md`, and `src/lib/styles/tokens.test.ts`
   for the single `PENDING_RETUNE` deletion described in step 1. The test-file diff must be that one
   entry and nothing else; any other change there belongs to T-07. And a diff touching the
   `[data-surface="pos"]` block inside `tokens.css` is wrong in every case: this task **verifies**
   that block, it does not edit it.

**Watch out:** The dark palette is written out **twice**. Editing only the `@media` copy leaves the
theme toggle serving the old values, and editing only the `:root[data-theme="dark"]` copy leaves a
dark-OS visitor on them — both are silent, and the existing "same token names in both dark blocks"
test does not compare *values*, so neither mistake fails a test. Also: do not chase the numbers
higher for margin. `#5c6771` on `--c-bg-2` measures 4.5470:1 — it clears WCAG 1.4.3 and is the value
the census was solved for; a "rounder" darker ink changes tokens that other screens already use.

**And the trap this task is most likely to spring: editing the `[data-surface="pos"]` block "while
you are in there".** The scope is pinned light and already holds the post-re-tune inks — `#161b20`,
`#4a5661`, `#5c6771` — written by T-03. Touching it here either re-tunes a value twice or introduces
the drift T-04's guard exists to catch. Verify it (step 1), leave it alone, and let the bare `:root`
come up to meet it.

---

### T-07 — Widen the contrast guard from the legal subset to the full census

**Needs:** T-06 (the four re-tuned values — asserting the full census before them fails 30 cases),
T-04 (the third palette state and the pos-surface assertions already added to this same test file)
**Files:**
- `src/lib/styles/tokens.test.ts` — EDIT (the comment block and the `GROUNDS` / `STATUS` /
  `TEXT_PAIRS` / `NON_TEXT_PAIRS` constants that precede `describe('the contrast floor holds in BOTH
  themes')`, plus the two failure-message strings inside that describe block). An earlier task in
  this plan already edited this file, so **locate by symbol, not by line number**, and do not rewrite
  the file wholesale.

**Spec:** none — `docs/spec.md` says nothing about UI, colour or contrast, so no section is citable
here. The rule being enforced is CLAUDE.md "Design & UI" ("WCAG AA (4.5:1) at normal text size, in
both themes, for every text-on-surface pair") and `docs/design-system.md` section 7b. WCAG by
criterion: **1.4.3** (text 4.5:1) and **1.4.11** (non-text UI boundaries and focus indicators 3:1).

**Invariants:** 1 (money is integer minor units, and the UI never formats or computes money — this
test asserts colour only and must not grow a money assertion or a formatter); 5 (the POS surface must
work with no network — this guard stays node-side and adds no dependency, no browser and no fetch).
No migration, no schema, no route, no permission key.

**Do:**

1. This test file reads CSS as **text**, in Node. `vitest.config.ts` defines exactly two projects,
   `unit` and `integration`, both `environment: 'node'`: there is no jsdom, no browser mode, no
   `@testing-library/svelte` and no svelte plugin, so **a `.svelte` file cannot be mounted here** and
   no assertion may depend on rendering. Add none of those; the parsing helpers already in the file
   (`stripComments`, `blockAt`, `blockOf`, `parseTokens`, `resolve`, `contrast`, `ratioOf`) are what
   you build on.

2. Delete the comment that currently sits above `GROUNDS` and forbids the fix this plan just made —
   it reads `The LEGAL pairs from docs/design-system.md section 7b, and only those. The known failing
   pairs are deliberately NOT asserted… Palette re-tuning is a decision the user deferred.` Replace
   it with the rule that now holds:

   ```
   // The FULL census: every ground token against every ink token, in both themed
   // states. Not a curated list — a cross product, so a pair cannot be quietly
   // dropped to make a value pass. A failing pair is fixed by re-solving the
   // token's VALUE in src/lib/styles/tokens.css and re-running the census; it is
   // never fixed by deleting the pair from this file.
   ```

3. Replace `GROUNDS` and `STATUS` with the four classification lists below. Every token name is
   written without its `--c-` prefix because `resolve()` adds it.

   ```ts
   const GROUNDS = [
     'bg', 'bg-2', 'raise', 'raise-2', 'accent-soft',
     'ok-bg', 'warn-bg', 'danger-bg',
     'st-new-bg', 'st-sent-bg', 'st-voided-bg', 'st-billed-bg', 'st-paid-bg', 'st-offline-bg'
   ];
   const INKS = [
     'ink', 'ink-2', 'ink-3', 'accent', 'ok', 'warn', 'danger',
     'st-new', 'st-sent', 'st-voided', 'st-billed', 'st-paid', 'st-offline'
   ];
   // WCAG 1.4.11 — a UI component boundary or focus indicator, 3:1, not 4.5:1.
   const NON_TEXT_INKS = ['ring', 'control-line'];
   // A --c-* token that resolves to a hex and is in none of the lists above carries
   // its reason here. Adding an entry IS A PLAN'S DECISION, NEVER A CONVENIENCE —
   // the same rule src/lib/server/db/schema-guards/schema.test.ts states for its
   // exemptions.
   const EXEMPT: Record<string, string> = {
     '--c-line': 'decorative edges only — card outlines, dividers, the header rule. 1.58:1 on --c-raise by design, and 1.55:1 on the POS key face; a control boundary uses --c-control-line.',
     '--c-line-soft': 'decorative, softer than --c-line — same reason.',
     '--c-accent-ink': 'ink on --c-accent ONLY, never on a themed ground — asserted as the one explicit pair in TEXT_PAIRS.'
   };
   // The category bands are classified, not exempted-by-prefix: T-04 already declares
   // CATEGORY_BANDS in this file, so reuse that constant rather than coining a second
   // way to name the same six tokens.
   const BAND_REASON =
     'menu-key category band — wayfinding, never text and never status, and never the only carrier: the category NAME is always written beside it (WCAG 1.4.1). Measured at 3:1 against the key face, not across the themed census.';
   ```

   **Four names an earlier draft of this step exempted are simply gone.** `--c-screen`, `--c-key`,
   `--c-key-line` and `--c-key-ink` were exempted here as "POS chrome — measured in the pos surface
   state". The 2026-09-14 reversal made the scope re-declare `--c-bg`, `--c-raise` and `--c-line` for
   the POS, which left those four with no consumer, and Phase 1 retired them. Do not re-add them to
   `EXEMPT`: an exemption for a token that no longer exists is a dead comment that makes the next
   reader hunt for a surface that is not there. If they are still declared in the bare `:root` when
   you open the file, Phase 1 is incomplete — report it.

   **The bands come from Phase 1, and so does the constant.** `CATEGORY_BANDS` is declared by T-04 in
   this same file; if it is not there, Phase 1 is incomplete — report that rather than re-declaring
   the six names here and creating a second list to keep in sync. They are classified rather than
   measured because a band is never text and never a status: it is redundant wayfinding beside a
   written category name, and T-04 asserts its own 3:1 check against the key face. **The dark-values
   question recorded in `RESEARCH.md` is CLOSED as moot for the POS, and closed is not the same as
   answered:** the bands were measured at 1.85–2.33:1 on a dark POS key face, but
   `[data-surface="pos"]` is pinned LIGHT in both themes, so that key face does not exist. A band only
   ever renders on the white key face of the pinned-light device surface, where all six clear 3:1
   (5.02–7.70). Do **not** add dark hexes for them here, and do not fold the bands into the themed
   census — that would measure them on dashboard grounds they are not used on and re-open a question
   this plan closed. The question returns only if a `--c-cat-*` band is ever used on the dashboard,
   which themes; no task in this plan does that.

4. Build both pair arrays as cross products, keeping the one pair that is not ground × ink:

   ```ts
   const TEXT_PAIRS: Array<[string, string]> = [
     ...INKS.flatMap((ink): Array<[string, string]> => GROUNDS.map((g) => [ink, g])),
     ['accent-ink', 'accent'] // the primary button: ink on the accent itself
   ];
   const NON_TEXT_PAIRS: Array<[string, string]> = NON_TEXT_INKS.flatMap(
     (ink): Array<[string, string]> => GROUNDS.map((g) => [ink, g])
   );
   ```

   `--c-ring` aliases `var(--c-accent)` and `--c-control-line` aliases `var(--c-ink-3)`; `resolve()`
   already follows one level of `var()` indirection, so both evaluate per palette state without
   being redeclared anywhere.

5. Add a new `it()` at the top of the `describe('the contrast floor holds in BOTH themes')` block
   that asserts the discovery itself, so a list that silently shrinks fails loudly:

   ```ts
   it('checks the whole census, and classifies every colour token in the palette', () => {
     expect(GROUNDS.length, 'a ground was dropped from the census').toBe(14);
     expect(INKS.length, 'an ink was dropped from the census').toBe(13);
     expect(TEXT_PAIRS.length).toBe(GROUNDS.length * INKS.length + 1); // 183
     expect(NON_TEXT_PAIRS.length).toBe(GROUNDS.length * NON_TEXT_INKS.length); // 28
     const classified = new Set([
       ...[...GROUNDS, ...INKS, ...NON_TEXT_INKS, ...CATEGORY_BANDS].map((n) => `--c-${n}`),
       ...Object.keys(EXEMPT)
     ]);
     const unclassified = [...bare.keys()].filter(
       (name) => resolve(name.replace(/^--c-/, ''), palettes.light) !== null && !classified.has(name)
     );
     expect(
       unclassified,
       `${unclassified.join(', ')} is a colour in the bare :root that the census does not cover. ` +
         'Add it to GROUNDS, INKS or NON_TEXT_INKS, or to EXEMPT with the reason it is not measured.'
     ).toEqual([]);
   });
   ```

   Filtering on `resolve(...) !== null` is deliberate: it keeps the guard to things that are actually
   colours. `--c-shadow` holds a full box-shadow list with commas and `rgb(… / .8)` and must never
   reach `luminance()`; a later task in this plan adds more shadow tokens to the same palette blocks,
   and they fall outside the census by the same rule rather than by being named. Do **not** assert
   `bare.size` against a fixed number for the same reason.

6. Fix the two failure messages inside the `it.each` bodies — they currently instruct the reader to
   do the opposite of the rule this task installs. The 4.5:1 message ends
   `Change WHICH TOKEN is used, never the token's value — see docs/design-system.md section 7b.`;
   replace that sentence with `Re-solve the token's VALUE in src/lib/styles/tokens.css and re-run
   the census — do not remove the pair (docs/design-system.md section 7b).` Keep the measured ratio
   in both messages: `measures ${ratio.toFixed(2)}:1` is what makes a failure diagnosable.

7. **Iterate exactly THREE palette states — `['light', 'dark', 'pos'] as const`. Three, not four:
   `pos` is ONE state, because `[data-surface="pos"]` is light in both themes and no dark block
   overrides it.** Build the `pos` palette by reading the `[data-surface="pos"]` block **on its own**,
   never by layering it over the dark map; a `pos-dark` state is not a state this design has, and a
   selector like `:root[data-theme="dark"] [data-surface="pos"]` does not exist in `tokens.css` and
   must not be written into this test.

   *(Two superseded drafts of this step, labelled so nobody restores one. The first, written for a
   pinned-DARK shell, told you to iterate two states and leave the pos assertions entirely to T-04,
   because the scope re-declared the inks and two structural grounds but not the soft status grounds,
   so the cross product paired an on-dark ink with a light `st-*-bg` and failed roughly a hundred
   cases. The second, written for a light-but-theme-following scope, said the scope overrides grounds
   only and inherits every ink from the active theme. Neither describes the file you are editing.)*

   Under the pinned rule the scope declares every ground and every ink itself, so the pos state is
   read straight out of one block and all **182** pairs pass, tightest **4.60:1** (`ink-3`/`bg-2`).
   Because the scope pins the light values and T-06 re-tuned the light palette, **T-04's value-drift
   guard must survive this task** — `it('the POS block carries the page LIGHT palette, value for
   value')`, which asserts every non-ground token the POS pins equals the bare `:root`'s value. Do not
   fold it into the census and do not delete it: two copies of a value that must agree is exactly the
   kind of thing a census cannot catch, because every pair passes on both sides of a drift. What this
   task DOES remove is the now-empty `PENDING_RETUNE` machinery (T-06 deleted its last entry), along
   with `it('every PENDING_RETUNE key names a token the POS actually pins')`.

   **Division of labour with T-04, so neither task duplicates the other.** T-04 owns the pos state's
   *declaration* checks — whether the scope declares `--c-ring` and `--c-control-line` at all — and no
   contrast assertion can substitute for them, because `resolve()` models `var()` resolution **in
   text** and would report the intended value whether or not the scope re-declares the alias. T-07
   owns the *census* across whatever states exist. Leave T-04's block where it is; widen the loop
   here.

8. `src/lib/styles/tokens.test.ts` is **not** prettier-ignored (only `docs/`, `tasks/`, `CLAUDE.md`,
   `.claude/` and `src/lib/styles/tokens.css` are). Match the repo style — tabs, single quotes, no
   trailing commas, 100-column print width — or run `pnpm format` and re-read the diff.

**Tests:** House guard test (CLAUDE.md "Design & UI"). This task *is* the test; the expected results:

- `183` text pairs × 3 states = **549** passing cases, plus `28` non-text pairs × 3 = **84**, plus
  the one discovery test above. The unit suite grows by roughly 630 cases; that is expected, not a
  runaway. (`366` + `56` was the pre-reversal figure, when the pos state could not be fed through
  this cross product at all — see step 7. Three states, not four: there is no `pos-dark`.)
- Every census is **0** failures. Tightest measured text pairs — light `ink-3`/`bg-2` **4.55:1**,
  dark `ok`/`st-new-bg` **4.62:1**, pos `ink-3`/`bg-2` **4.60:1**. Tightest non-text, against a 3:1
  floor — `control-line`/`bg-2` **4.55:1** light and **4.60:1** pos, `control-line`/`st-new-bg`
  **4.63:1** dark.
- Mutation check, run by hand and then reverted: setting light `--c-ink-3` back to `#646f7a` makes
  exactly **12** light cases fail, every one of them `text-ink-3` on a ground. Setting dark
  `--c-danger` back to `#d97165` makes exactly **8** dark cases fail — `danger` on `raise-2` (4.06),
  `accent-soft` (4.19), `st-new-bg` (3.81), `st-sent-bg` (4.17), `st-voided-bg` (4.43),
  `st-billed-bg` (4.39), `st-paid-bg` (4.17) and `st-offline-bg` (4.39). **Eight, not six** — the six
  recorded in earlier notes omitted the two `st-*-bg` grounds that only fail once the other three
  values are already re-tuned.
- Adding a new `--c-*` colour to the bare `:root` without classifying it fails the discovery test by
  name.

**Done when:** `pnpm test:unit` passes with zero contrast failures; `pnpm lint` passes; and
`grep -c "the known failing pairs\|Palette re-tuning is a decision" src/lib/styles/tokens.test.ts`
prints `0`.

**Watch out:** Three traps here.
- **Do not add `--c-line` to `NON_TEXT_PAIRS`.** It measures 1.08:1–1.58:1 against every ground in
  every state — 1.55:1 on the POS key face, 1.27:1 on the POS ground — and is decorative by design;
  the token that must clear 3:1 is `--c-control-line`. A census that includes `--c-line` fails 42
  cases across three states and invites someone to "fix" a token whose whole purpose is to be quiet.
  The corollary is the POS boundary rule: a white key on the till's ground is only **1.22:1**, so a
  key outlined with `--c-line` — or with nothing but a shadow — is the defect, and the repair is
  `border-control-line` (4.73:1), never a louder `--c-line`.
- **Do not raise the thresholds.** They are WCAG's numbers: `4.5` for text (1.4.3) and `3` for
  non-text (1.4.11). A 4.6 floor invented for margin fails light `ink-3` on `bg-2` at 4.5470 — a
  pair that is compliant.
- **Do not delete a pair to make the suite green.** That is the exact defect this task removes; the
  repair is always the token's value in `src/lib/styles/tokens.css`.

---

### T-08 — Re-sync the hardcoded palette in `docs/pos-layout-grammar.html`

**Needs:** T-06 (the four re-tuned values this document keeps its own copy of)
**Files:**
- `docs/pos-layout-grammar.html` — EDIT (inside the `<style>` element that opens on line 5: the
  `:root{…}` block, the `@media (prefers-color-scheme:dark){ :root:not([data-theme="light"]){…} }`
  block and the `:root[data-theme="dark"]{…}` block, which are the first ~35 lines of that element)

**Spec:** none — `docs/spec.md` does not discuss colour, contrast or layout. This document is the
visual reference CLAUDE.md's "Design & UI" section names ("the researched layout grammar, with
adopt/adapt/reject verdicts, is `docs/pos-layout-grammar.html`") and `docs/design-system.md` line 26
names again, which is precisely why a stale palette in it is a second source of colour truth.

**Invariants:** 5 (a completed offline sale is a recorded fact, so the POS *surface* must work with
no network) — see the note about the Google Fonts link in step 5: this document is not part of the
application and that invariant does not reach it. 1 (money is integer minor units; the UI never
formats money) — the mockup's prices are static illustration text and must not be turned into
anything computed. No migration, no schema, no route, no permission key.

**Do:**

1. Read the token-name mapping before grepping. This document predates the `--c-` prefix and uses its
   own names, so a search for `--c-ok` finds nothing:

   | `tokens.css` | this document |
   |---|---|
   | `--c-ink-3` | `--ink-3` |
   | `--c-ok` | `--adopt` |
   | `--c-warn` | `--adapt` |
   | `--c-danger` | `--reject` |

2. In the light `:root{…}` block, change one value:
   `--ink:#161b20; --ink-2:#4a5661; --ink-3:#646f7a;` → `--ink-3:#5c6771` (the other two are
   unchanged). The light `--adopt:#2c6a48; --adapt:#855a12; --reject:#a13a2e;` line is **unchanged** —
   only the dark `--adopt` and `--reject` moved.

3. In **both** dark blocks — the one inside `@media (prefers-color-scheme:dark)` and the
   `:root[data-theme="dark"]` copy below it, which are byte-identical duplicates — change:

   ```
   from:   --ink:#e6eaec; --ink-2:#a8b3bc; --ink-3:#8a949d;
   to:     --ink:#e6eaec; --ink-2:#a8b3bc; --ink-3:#97a0a8;

   from:   --adopt:#5aa06f; --adapt:#d99a3c; --reject:#d97165;
   to:     --adopt:#6eac81; --adapt:#d99a3c; --reject:#df877c;
   ```

   That is five edited lines in total across the three palette blocks — one in the light `:root`,
   two in each dark block — and seven hex substitutions.

4. Add a provenance note as the first thing inside the `<style>` element, immediately after the
   `<style>` tag and above the existing `/* ── tokens: light is the default; dark follows the
   viewer ───── */` comment:

   ```
   /* PALETTE SNAPSHOT — src/lib/styles/tokens.css is the source of truth.
      The values below are a hand-copied snapshot of it, taken 2026-09-14, under this
      document's older names: --ink-3 is --c-ink-3, --adopt is --c-ok, --adapt is
      --c-warn, --reject is --c-danger. This file is a standalone research artifact
      that must open straight from the filesystem with no build step, so it cannot
      import the token file; when a palette value changes there, re-copy it here.
      The contrast census that governs those values is computed from tokens.css by
      src/lib/styles/tokens.test.ts, never from this copy.
      The Google Fonts <link> above stays: this page is opened in a browser by a
      person and is not served by the application, so the offline rule that governs
      the POS surface does not reach it. Do not swap it for the self-hosted
      @fontsource packages.
      THE MOCKUP BELOW IS PRE-REVERSAL. Its .pos/.rail/.key/.check rules paint a DARK
      till, which was the design until 2026-09-14, when the user reversed it: the POS
      is now a LIGHT device surface IN BOTH THEMES. [data-surface="pos"] in
      tokens.css pins the COMPLETE palette — grounds, inks, accent, semantic, status,
      the two aliases and the shadow rungs — and no dark block overrides any of it,
      because pinning a surface means pinning every token on it, not just the
      grounds. The till ground is deeper than the page so the white key faces read as
      raised, and every pressable surface carries a --c-control-line border because a
      white key on that ground is only 1.22:1. The four annotated zones and the
      adopt/adapt/reject verdicts still hold — the colours in the drawing do not.
      Read it for layout, never for palette. */
   ```

5. Do **not** convert the document to load `src/lib/styles/tokens.css`, and do **not** replace its
   `<link rel="stylesheet" href="https://fonts.googleapis.com/…">` with the self-hosted font
   packages. It is a research artifact that must open by double-clicking the file, with no dev
   server, no bundler and no relative path into `src/`.

6. Do **not** touch the literal colours inside the mockup rules further down the file — `.pos`,
   `.pos-status`, `.rail`, `.key`, `.check`, `.st.new` and friends carry their own hexes
   (`#1a1f25`, `#8e9ba5`, `#243745`, `#e3e9ee`, …). None of them is one of the four values this task
   syncs, and repainting them would change the picture rather than the palette.

   **Flag, do not fix: the drawing now depicts a superseded surface.** Those hexes render a *dark*
   till, which was the design until the 2026-09-14 reversal to a pinned-light POS. The document is a dated research artifact
   whose adopt/adapt/reject verdicts are still the reason `CLAUDE.md` cites it, and re-drawing a
   four-zone mockup in the light palette is a different piece of work from re-syncing four hex values
   — it is not smuggled into a task whose whole diff is meant to be seven substitutions. Record it in
   the snapshot banner (step 4) so nobody reads the picture as current, and report it as a known gap
   rather than opening it here.

7. `docs/` is listed in `.prettierignore`, so `prettier --check .` neither reformats nor rejects this
   file; nothing imports it and no test reads it. The verification is the grep in **Done when**.

**Tests:** House guard test (CLAUDE.md "Design & UI") — **none added here, deliberately.** An
automated guard would have to hand-maintain the four-name mapping in step 1, which is exactly the
"list someone forgets to update" the house guard-test pattern exists to avoid, and this file is a
dated snapshot of a research document rather than a live copy. The drift this task fixes is caught at
its real source instead: the census in `src/lib/styles/tokens.test.ts` is computed from
`src/lib/styles/tokens.css`, so the application can never drift behind the snapshot.

**Done when:**

1. `grep -c -e '#646f7a' -e '#8a949d' -e '#5aa06f' -e '#d97165' docs/pos-layout-grammar.html` prints
   `0`.
2. `grep -o -e '#5c6771' -e '#97a0a8' -e '#6eac81' -e '#df877c' docs/pos-layout-grammar.html | wc -l`
   prints `7`.
3. `grep -c 'PALETTE SNAPSHOT' docs/pos-layout-grammar.html` prints `1`, and
   `grep -c 'fonts.googleapis.com' docs/pos-layout-grammar.html` still prints `1`.
4. The file still opens in a browser from `file:///…/docs/pos-layout-grammar.html` and renders in
   both themes; `pnpm lint` and `pnpm test:unit` still pass, and `git status` shows exactly one
   modified file.

**Watch out:** The two dark blocks are duplicates here as well — the `@media` one and the
`:root[data-theme="dark"]` one — and a search-and-replace that stops at the first match leaves the
document rendering the old dark inks whenever the reader has stamped a theme. Check that both
`--ink-3:#97a0a8` and both `--adopt:#6eac81` landed. And note that this document's light
`--adopt`/`--reject` (`#2c6a48` / `#a13a2e`) are **not** among the changed values: touching them
because they sit on the same line as the dark ones would put two unmeasured colours into a document
CLAUDE.md cites as the POS visual reference.
