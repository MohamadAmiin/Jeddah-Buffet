# Phase 4 — The design system document

Phases 1–3 changed what the code *is*: a POS surface scope, a re-tuned palette, six semantic type
roles, an elevation ladder and three new guard tests. `docs/design-system.md` still describes the
code as it was before any of that, and it is the document a fresh session reads before writing a
screen — so until this phase runs, the normative UI document contradicts the CSS it governs. T-12
rewrites the regions the earlier phases falsified (the intro, the theme contract, typography, the
accessibility floor, and the dashboard's now-obsolete legal-pair tables) and locks the document to
the token file with a guard test. T-13 turns section 7 from a sketch into the contracts a future POS
plan must satisfy — and builds none of them, because the hardware question that sets the target
resolution is still unanswered.

**Depends on:** Phase 3

**Read `00-overview.md` in this directory FIRST.** It carries the goal, the decisions the user made
on 2026-09-14, the scope boundaries, the surviving risks, the complete task index, and the
`NEW` / `EXTEND` / `EDIT` tag convention used in every `Files:` list below.

**Two rules bind both tasks in this phase and are repeated inside each one.**

1. **`docs/spec.md` is silent on UI.** Grep it: `font` 0 hits, `colour`/`color` 0, `typograph` 0,
   `WCAG` 0, `accessib` 0, `contrast` 0, `layout` 0, `resolution` 0, `touch` 0. **Never cite a spec
   section for a design rule.** Exactly two pieces of spec text reach the screen: spec 6's bullet
   under `### Protecting unsynced data` — "The number of unsynced operations is always visible on
   screen." — and spec 11's fixed-width ESC/POS receipts. Everything else in this document is
   house rule, sourced to `CLAUDE.md`'s "Design & UI" section, to `docs/design-system.md` itself, or
   to a WCAG success criterion cited **by number** (1.4.1 colour alone · 1.4.3 text contrast 4.5:1 ·
   1.4.11 non-text contrast 3:1 · 2.3.3 animation from interactions · 2.4.7 focus visible).
2. **This phase writes documentation and one guard test. Nothing else.** No migration, no schema,
   no column, no route, no `+server.ts`, no form action, no permission key, no component, no
   `.svelte` file, no dependency. If a step below appears to need one, that is a finding to report,
   not a thing to add.

**`docs/` is in `.prettierignore`.** `pnpm lint` does not check `docs/design-system.md` and
`pnpm format` will not rewrite it — the ignore file records why ("Documents of record. The formatter
must never rewrite these."). Format the markdown by hand, matching the file's existing rhythm:
`##` section headings, a `---` rule between sections, sentence-case bold lead-ins, tables with
pipe-aligned headers. **Do not run Prettier on it and do not remove it from `.prettierignore`.**

---

### T-12 — Rewrite `docs/design-system.md` sections 2, 4 and 9 around the surface scope and the type roles

**Needs:** T-03 (`[data-surface="pos"]` token scope in `src/lib/styles/tokens.css`), T-09 (the six
`--text-*` semantic roles), T-10 (the elevation ladder and the `--container-measure` /
`--container-form` tokens), T-02 (the four false-claim repairs in sections 4, 5 and 9 — this task
must preserve them, not overwrite them), T-06 (**already rewrote §7b's census content** — step 6
below is reduced to the one edit T-06 did not make, and every string T-06 replaced is gone)
**Files:**
- `docs/design-system.md` — EDIT (the intro region ABOVE `## 1. Principles`: the two-surface
  comparison table, the sentence beginning "They share `src/lib/styles/tokens.css`", and the numbered
  "The file has three layers" list. Base-branch lines 5–24.)
- `docs/design-system.md` — EDIT (`## 2. The theme contract` — its whole body, base-branch lines
  42–56, up to but not including the `---` that precedes `## 3. Domain status`)
- `docs/design-system.md` — EDIT (`## 4. Typography` — base-branch lines 83–89)
- `docs/design-system.md` — EDIT (`## 9. Accessibility floor` — base-branch lines 218–229)
- `docs/design-system.md` — EDIT (`## 7b. Dashboard component rules`, **ONE region only**: the
  "**What must NOT appear on a dashboard screen**" list. Every other part of 7b — including the
  census sub-section, the "**Control borders.**" paragraph and the "**Focus.**" paragraph — was
  already rewritten or deliberately left alone by T-06, and must not be touched again. Leave the
  page skeleton, surface hierarchy, button variants, form anatomy, card, empty states, navigation,
  typography and responsive parts alone.)
- `src/lib/styles/tokens.test.ts` — EDIT (append ONE new `describe` block at the END of the file,
  after the existing `describe('the element base layer')` block near base-branch line 308. Do not
  touch the blocks earlier tasks in this plan added.)

**Spec:** none, and that is the point. `docs/spec.md` contains no UI text at all — 0 hits for
`font`, `colour`, `contrast`, `WCAG`, `accessib`, `layout`, `resolution` and `touch`. Section 4 and
section 9 must therefore cite `CLAUDE.md`'s "Design & UI" section and WCAG criteria by number
(1.4.1, 1.4.3, 1.4.11, 2.3.3, 2.4.7), and **must not** attribute a design rule to a spec section.
The single spec citation this task may make is spec 6's unsynced-count bullet, and that belongs to
T-13's section 7, not here.
**Invariants:** 1 (money is integer minor units; the UI never does money arithmetic and never
rounds), 7 (each order line stores the unit price and tax rate used, so the screen renders the
numbers stored on the line and never recomputes them), 5 (the POS surface must work with no network —
so everything it needs to render is already on the device)

**Do:**

1. **Open the file and locate every region by its heading text, not by line number.** The
   base-branch line numbers above are for orientation only: T-02 has already edited sections 4, 5
   and 9, so everything below its first edit has shifted. Read each region before replacing it —
   **T-02's repairs must survive this task**. Specifically: section 4's `text-wrap: balance`
   sentence must still name `src/lib/styles/base.css` as the file that implements it, and section
   9's `prefers-reduced-motion` bullet must still name `src/lib/styles/base.css` and not
   `tokens.css`. Re-breaking either is the exact defect T-02 exists to fix. Do not rewrite the whole
   document; sections 1, 3, 5, 6, 8, 10 are untouched here, and section 7 belongs to T-13.

2. **The intro region, above `## 1. Principles`.** Three edits:
   - In the two-surface comparison table, change the **Body size** row's dashboard cell from
     `Tailwind default \`text-base\`` to the T-09 body role (`text-body`), and keep the POS cell as
     `text-pos`. Then **add one row** to the table: `| Surface scope |
     \`data-surface="pos"\` — pinned LIGHT in both themes; pins the complete palette | none — takes
     the palette from \`:root\` and follows the viewer's theme |`.
     **Do not write "dark in both themes" in that cell, and do not write "follows the theme" of the
     POS either.** Both are superseded rules — the first reversed by the user on 2026-09-14, the
     second disproved by measurement the same day — and a comparison table is exactly where a
     superseded one-liner survives longest. The distinction the row carries is that the POS pins its
     whole palette, grounds and inks alike, at light values, with a deeper `--c-bg` so the white
     `--c-raise` key face reads as raised, while the dashboard declares no scope at all and themes.
   - Replace the sentence "They share `src/lib/styles/tokens.css` and diverge only in scale." with
     the rule this plan actually established: they share `src/lib/styles/tokens.css`, they use the
     **same token names**, and they diverge in scale and in what those names resolve to.
   - In the numbered "The file has three layers" list, item 3 currently reads "plain `@theme` for
     static things — fonts, the touch scale, `--text-pos`, `--text-total`." Update items 2 and 3 to
     match the file after T-09 and T-10: plain `@theme` now also carries the six semantic type
     roles, the radii, `--container-page`, `--container-measure` and `--container-form`; the
     elevation ladder is
     **themeable** and therefore lives in the palette blocks and is exposed through `@theme inline`,
     not plain `@theme`. Keep the existing explanation of why `inline` is required verbatim — plain
     `@theme` bakes the light value into the utility, `@theme inline` emits `var(--c-raise)` so the
     utility follows the theme.

3. **Section 2, `## 2. The theme contract` — replace the exemption with three surface states.**
   Keep the existing opening ("Light is the default…") and the CSS block showing the three theme
   states. Then **delete the paragraph that begins "**The POS terminal chrome is exempt.**"** — the
   one naming `--screen`, `--key`, `--key-line`, `--key-ink` — and write in its place:
   - A fourth CSS block showing the scope as it actually lands in `src/lib/styles/tokens.css` from
     T-03: a `[data-surface="pos"]` block carrying `color-scheme: light` and re-declaring the
     **COMPLETE** palette under the ordinary `--c-*` names — the six grounds, the three inks, the
     accent trio, the semantic colours, the six `--c-st-*` status colours with their six soft grounds,
     the `--c-ring` and `--c-control-line` aliases, and (after T-10) the three shadow rungs with their
     `--c-shadow` alias. **Show it with NO dark counterpart, because it has none**: there is no
     `[data-surface="pos"]` rule inside either dark block, and writing one into the example is how the
     rule gets un-done six months from now. Copy the selectors exactly as the file spells them; do not
     paste the values — the document names tokens, the token file owns numbers.
   - **The rule a developer needs, stated plainly and first:** token **names** are identical on every
     surface; only their **values** differ. `text-ink` is correct on a dashboard card *and* inside
     the POS shell — inside the shell it simply resolves against the till's own ground. A component
     therefore never branches on surface, never takes a `dark` prop, and never hardcodes a colour.
   - **What the scope is, and what it is not.** It is a *surface scope*: a fourth palette state that
     **replaces** the theme inside the `(pos)` group rather than composing with it. The POS shell
     renders identically under an explicit light theme, an explicit dark theme and a system default,
     because none of them reaches it. It is **not** a fourth theme the user can pick, and it is **not**
     a partial override — **pinning a surface means pinning EVERY token on it, not just the grounds.**
     Say that sentence in the document; it is the finding, not a stylistic preference. The till is a
     DEVICE: its surface is a property of the hardware on the counter, not of the viewer's OS
     preference. Beyond being light, what the scope carries is the till's **ground/key relationship
     and its density**: the dashboard puts white cards on a light ground for reading, while the POS
     uses a **deeper ground so the white key faces read as the raised, pressable thing**.
   - **The boundary rule, which is the load-bearing consequence and must not be buried.** A white key
     face on the till's ground measures **1.22:1**, so **elevation alone cannot carry a control's
     edge**: WCAG **1.4.11** wants 3:1, and every pressable POS surface therefore takes
     `border: 1px solid var(--c-control-line)` — 4.73:1 on that ground. `border-line` (1.55:1 on the
     key face) is decorative rules and non-interactive block edges only. A shadow-only key is pretty
     and non-compliant. Write this as a rule of the system, not as a note about the POS.
   - **Why the scope exists — and the history, labelled as history, because the rule flipped TWICE
     on 2026-09-14 and both flips teach the same lesson.** (i) Until that date the design was a POS
     shell *pinned dark in both themes*, and the measured consequence was that every one of the 26
     ink-on-ground pairs inside it failed WCAG 1.4.3 in the **light** theme (`--c-ink` on `--c-screen`
     was **1.08:1**; `--c-st-offline`, which carries the unsynced count, was **3.10:1**), with three
     still failing in **dark**. The user reviewed a light-mode commercial POS reference and **reversed
     the pinned-dark rule**; the glare argument for a dark till was raised once and overruled. (ii)
     The first light draft then pinned only the **grounds** and let the inks theme — and on a
     dark-mode machine that painted `--c-ink` `#e6eaec` on the white key face at **1.21:1**, the same
     defect with the surfaces swapped. **That is why the scope now pins the complete palette**, and it
     is the sentence the document must carry: *pinning a surface means pinning every token on it, not
     just the grounds.* Both sets of ratios are **dated historical measurements** — say so in the
     sentences that carry them, because the surfaces they were measured against no longer exist. The
     scope survived both flips; its justification changed from *making a dark shell legible* to
     *giving the till a ground its keys can sit on, under one palette that no viewer preference can
     alter*.
   - **`--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink` are RETIRED**, and the document must
     say so rather than describe them as live. Once the scope re-declares `--c-bg`, `--c-raise` and
     `--c-line` for the POS they have no consumer, and two vocabularies for one surface is exactly
     what the scope removes. Mention them **once**, in the history sentence, as the device-chrome
     tokens the scope replaced — and see step 8 for why they need an explicit exemption in the guard
     test rather than silence.
   - **`--c-ring`, `--c-control-line` and `--c-shadow` ARE re-declared in the scope, and the document
     must say why** — this is the single easiest thing in the whole system to get backwards. A custom
     property's `var()` is substituted at **computed-value time on the element that declares it**,
     and what inherits is the resolved literal. So:
     - the **dark blocks** need no copy: they target `:root`, the same element the alias is declared
       on, so `--c-ring` recomputes against `:root`'s own replaced `--c-accent`. Verified in a
       browser — on a dark page both `--c-accent` and `--c-ring` read `#5cb4c9`.
     - the **POS scope** does need a copy: `[data-surface="pos"]` is a `<div>`, not `:root`, so an
       alias declared above it never recomputes. Verified — without its own line, `--c-accent` inside
       the shell reads `#5cb4c9` while `--c-ring` still reads the page accent `#0f6b7e`.

     State both halves. Writing only "aliases follow automatically" invites a session to delete the
     scope's alias lines and silently put the page accent on the focus ring — or the page theme's
     elevation on a white key face — inside the till; writing only "always re-declare aliases" invites
     pointless duplication in the dark blocks and would contradict the existing test that asserts they
     are absent there. The rule generalises to the ELEMENT, not to the theme: **re-declare an alias in
     any scope that overrides its source on a different element.** That is one more face of the same
     finding — a pinned surface pins every token on it, aliases included.
   - **Where the attribute is stamped:** `src/routes/(pos)/+layout.svelte` wraps the route group's
     children in an element carrying `data-surface="pos"`. Nothing outside the `(pos)` group carries
     it, and no dashboard element may.
   - **One line recording the supersession**, so a reader who remembers the old rule knows it was
     replaced on purpose: the earlier "the POS chrome tokens are exempt from theming" wording is
     superseded by this scope.
   - **One line for invariant 5** (the POS surface must work with no network): everything the shell
     needs to render must already be on the device, which is why the three typefaces are self-hosted
     `@fontsource` packages bundled by Vite and never a third-party font link, and why the `(pos)`
     group has no blocking server load.

4. **Section 4, `## 4. Typography` — document the roles, not the sizes.** Keep the three families
   (Archivo display · IBM Plex Sans body · IBM Plex Mono money) and keep the paragraph beginning
   "**A price set in the body face is a bug.**" Replace the paragraph beginning "Tailwind's default
   type scale covers the dashboard." with:
   - **One utility is one complete typographic role.** Tailwind v4.3.3 resolves exactly three
     modifiers on a `--text-<name>` token — `--line-height`, `--letter-spacing` and `--font-weight`
     (confirmed in the installed package's compiled source, `resolveWith(value, ['--text'],
     ['--line-height','--letter-spacing','--font-weight'])`). T-09 uses all three, so `text-title`
     sets size, leading, tracking and weight together. **Writing `text-title font-semibold
     tracking-tight` is a regression**: it re-splits a role that was deliberately made whole.
   - A table of the roles T-09 defined — `text-display`, `text-title`, `text-section`, `text-body`,
     `text-caption`, `text-eyebrow`, plus `text-pos` and `text-total` — with a **Use** column and
     **no numbers**. Open `src/lib/styles/tokens.css` and copy the role names exactly as the `@theme`
     block spells them; do not write a name from memory. The values stay in the token file so there
     is exactly one place to change them — hand-copied numbers in this document are how sections 4,
     5 and 9 came to hold four false claims in the first place.
   - **Tailwind ships its own `--text-xs` … `--text-9xl`** in `node_modules/tailwindcss/theme.css`,
     so `text-sm` and `text-3xl` resolve to Tailwind's scale, not to matcami's — a second source of
     type truth. Use the role utilities; T-11's guard test in `src/lib/styles/tokens.test.ts` fails
     the build if a default-scale utility appears in a `.svelte` file, and its allowlist is a plan's
     decision, never a convenience.
   - **Measure.** Name T-10's two measure tokens and their utilities, beside the existing
     `--container-page` (`max-w-page`) for page width: **`--container-measure` (`max-w-measure`,
     68ch)** for body-copy line length, and **`--container-form` (`max-w-form`, 32rem)** for the
     single-column form and auth card.

     **Do not write `--container-prose` or `max-w-prose`, and say in the document why not.**
     Tailwind ships `prose: "65ch"` as a *hardcoded literal* in its `maxWidth` map — verified in
     `node_modules/tailwindcss/dist/lib.js`, and `--container-prose` appears nowhere in
     `node_modules/tailwindcss/theme.css`. So `max-w-prose` does **not** read the `--container-*`
     namespace at all: defining `--container-prose` would emit no utility, and `max-w-prose` would
     silently keep Tailwind's 65ch. That is precisely the second-source-of-truth defect T-11 exists
     to close, arriving through a name rather than a value. `max-w-measure` and `max-w-form` are
     unclaimed and compile to `var(--container-measure)` and `var(--container-form)`.
   - **Money, restated once and only here in this section:** money, quantities, account codes,
     invoice numbers and IDs always use `--font-mono` with `font-variant-numeric: tabular-nums`. The
     UI never formats money itself — one formatter lives in `src/lib/server/money`, integer minor
     units in and a string out (invariant 1), and the UI never rounds (invariant 7). **Check
     `src/lib/server/money/` before rendering any money figure: while it holds only a `README.md`,
     no money figure may appear in any component at all**, and `.toFixed`, `/ 100` and
     `Intl.NumberFormat` are bugs wherever they appear in `src/lib/components/` or `src/routes/`.

5. **Section 9, `## 9. Accessibility floor` — replace the honour-system floor with the census.**
   Keep the noise bullet (85 dBA — audio can never be the primary confirmation channel), the colour
   bullet (§3), and the relative-luminance formula block at the end. Rewrite the rest:
   - **The floor, with criteria numbered:** 4.5:1 for text at normal size (WCAG 1.4.3), 3:1 for UI
     component boundaries and focus indicators (WCAG 1.4.11), colour never the sole carrier of
     meaning (WCAG 1.4.1), a visible focus state on every interactive element (WCAG 2.4.7), and
     motion honouring `prefers-reduced-motion` (WCAG 2.3.3).
   - **The census is computed, not asserted by hand.** `src/lib/styles/tokens.test.ts` parses
     `src/lib/styles/tokens.css` as text and computes every surface × ink pair in **all three
     palette states** — light, dark, and `[data-surface="pos"]` — at 4.5:1, plus the non-text pairs
     at 3:1. It is the authority; this document names rules, not ratios.
   - **The repair rule, which is the opposite of the old one:** *a failing pair is fixed by
     re-solving the token value and re-running the census — never by removing the pair from the
     list, and never by narrowing where a token may be used.* Removing a pair makes the guard pass
     while the screen still fails. (The previous rule — repair by changing which token is used —
     was written while colour values were frozen. That freeze was lifted; record the lift in one
     line so the reversal reads as a decision rather than a drift.)
   - **Where the implementations live:** `:focus-visible` is `outline: 2px solid var(--c-ring)` with
     `outline-offset: 2px` in `src/lib/styles/base.css`, whose header comment forbids `outline: none`
     anywhere in the codebase; `prefers-reduced-motion` is honoured in the same file. Preserve
     T-02's wording here — both were previously and wrongly attributed to `tokens.css`.

6. **Section 7b — ONE edit only. T-06 already rewrote the census content of this section; do not
   rewrite it again.**

   **Read §7b before editing it.** T-06 (Phase 2) replaced the whole
   `### Legal ink-on-surface pairs` sub-section with `### Ink-on-surface pairs — the census`, deleted
   the `**The twelve measured failures — never write these.**` paragraph and its table, deleted the
   `So: **text-ink-3 is legal only on bg-raise**…` paragraph, and updated the ratios in the
   `**Control borders.**` paragraph. It deliberately left the `**Focus.**` paragraph untouched,
   because `--c-ring` derives from `--c-accent`, which no task changes. **All of that is done.**
   Searching for those strings will find nothing, and re-creating them would reintroduce the defect
   Phase 2 removed.

   The single edit this task owes §7b: in the **"What must NOT appear on a dashboard screen"** list,
   **add** `data-surface="pos"` beside the POS touch tokens and POS chrome tokens already listed —
   because T-03 made that attribute meaningful and T-05 stamps it on the `(pos)` group, so a
   dashboard screen carrying it would silently adopt the device palette.

7. **Sweep the whole document for numbers the earlier phases invalidated.** Run
   `grep -nE '[0-9]+\.[0-9]+ ?: ?1|\*\*[0-9]+\.[0-9]{2}\*\*' docs/design-system.md`. Every hit must
   be either (a) deleted, (b) replaced by a reference to `src/lib/styles/tokens.test.ts`, or (c)
   explicitly labelled as a dated historical measurement explaining why something changed — the
   pre-T-03 POS-shell figures in section 2 are the only case of (c) this task creates. **The
   standing rule to write down once, in section 9: a contrast ratio may appear in this document only
   as a labelled historical measurement, never as a rule.**

8. **Add the document guard test** — one new `describe('the design system document')` block appended
   to the END of `src/lib/styles/tokens.test.ts`, following the house guard pattern set by
   `src/lib/server/db/schema-guards/schema.test.ts`: **discover what you guard, never hand-maintain
   a list, then assert the discovery itself so a pattern matching nothing fails loudly instead of
   passing green.**
   - Add a path constant beside the existing `TOKENS`, `BASE`, `APP_CSS` and `SRC` consts — the
     document is at `../../../docs/design-system.md` relative to `src/lib/styles/`.
   - **Discover** every `--c-*` name the document mentions inside backticks, with a regex over the
     markdown text. **Assert the discovery first** (`it('finds --c-* token names in the document at
     all')` — expect the count to be greater than zero), then assert every discovered name is
     declared in the bare `:root` of `tokens.css`, reusing the existing `parseTokens(blockOf(css,
     ':root {'))` helpers rather than re-parsing. This is the test that would have caught section
     2's old `--screen` / `--key` spelling.
   - Assert the document mentions `[data-surface="pos"]` at least once, and that the three
     superseded strings are **absent**: `The POS terminal chrome is exempt`,
     `never the token's value`, and `twelve measured failures`.
   - **Do NOT add `dark in both themes` to that absent list, tempting as it is.** Step 3's history
     sentence quotes the reversed rule on purpose, so an absence assertion would fail the very
     document this task specifies. The same goes for the grounds-only wording the history sentence
     also quotes. Assert the **replacements** instead — positive assertions that cannot be satisfied
     by a document still arguing from either superseded rule. The section-2 region must contain:
     - `border-control-line` and the string `1.22` — a document describing the POS surface without
       its boundary rule is the failure mode worth catching;
     - the string `1.21` and the string `every token on it` — the measured mirrored defect and the
       rule it produced. A section 2 that says the POS is light but never says it pins **every**
       token has re-opened the 1.21:1 hole in prose, and this pair of assertions is what catches it.
   - **A RETIRED exemption is required, or step 3 fails your own guard.** The discovery assertion
     above says every `--c-*` name the document mentions in backticks is declared in the bare `:root`
     of `tokens.css`. Step 3 names `--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink` in its
     history sentence, and Phase 1 deleted all four from `tokens.css` — so the guard would fail on a
     correct document. Add a small map beside the discovery, following the house pattern of
     exemptions carrying their reason:

     ```ts
     // Retired by the 2026-09-14 POS reversal: the [data-surface="pos"] scope took over
     // the till's grounds and these four device-chrome tokens lost their last consumer.
     // The document may still NAME them, once, as the history of what the scope replaced.
     const RETIRED = new Set(['--c-screen', '--c-key', '--c-key-line', '--c-key-ink']);
     ```

     Filter the discovered names through it before asserting, and **assert the exemption is still
     earning its place**: every name in `RETIRED` must be absent from the bare `:root`. A retired
     token that reappears in `tokens.css` means Phase 1 was reverted, and the guard should say so
     rather than quietly permitting it.
   - Node-side text reading only. There is no jsdom, no browser mode, no
     `@testing-library/svelte` and no Svelte plugin in `vitest.config.ts`, so **no component can be
     mounted** — this test reads two files as strings and compares them.

**Tests:** House guard test (CLAUDE.md "Design & UI"). **Not** one of spec 29's six mandatory areas —
those are money arithmetic and rounding, tax in both modes, journal entries balancing, one posting
rule per spec 24 business event, offline sync retries never duplicating, and a permission check per
POS API route. None of them is this; stated so no reader marks it `MANDATORY` by analogy.

- `finds --c-* token names in the document at all` → the discovered set is non-empty (guard against
  a regex that silently matches nothing).
- Every `--c-*` name the document mentions is declared in the bare `:root` of
  `src/lib/styles/tokens.css` → passes. Probe it: temporarily write `` `--screen` `` into section 2,
  re-run, expect a failure naming `--screen`, then `git checkout -- docs/design-system.md`.
- The document mentions `[data-surface="pos"]` → at least one occurrence.
- `The POS terminal chrome is exempt` → 0 occurrences. `never the token's value` → 0 occurrences.
  `twelve measured failures` → 0 occurrences.
- The section-2 region contains `border-control-line`, `1.22`, `1.21` and `every token on it` → all
  four present. Probe: delete the `1.21` sentence, re-run, expect a failure, then
  `git checkout -- docs/design-system.md`.
- The whole existing suite still passes — in particular the blocks earlier tasks in this plan added
  to the same file must be untouched and still green.

**Done when:**
- `pnpm test:unit` passes, with `src/lib/styles/tokens.test.ts` reported as a run file.
- `grep -c 'data-surface="pos"' docs/design-system.md` prints a number ≥ 1.
- Each of these prints nothing and exits non-zero:
  `grep -n "The POS terminal chrome is exempt" docs/design-system.md`,
  `grep -n "never the token's value" docs/design-system.md`,
  `grep -n "twelve measured failures" docs/design-system.md`.
- `grep -n "already in \`tokens.css\`" docs/design-system.md` prints nothing — T-02's repair is
  still in place and this task did not regress it.
- `grep -n "base.css" docs/design-system.md` prints at least the `text-wrap: balance`,
  `:focus-visible` and `prefers-reduced-motion` mentions.
- ``sed -n '/^## 2\./,/^## 3\./p' docs/design-system.md | grep -c -e '1.22' -e '1.21' -e 'every token on it' -e 'border-control-line'``
  prints `4` or more — section 2 carries both measurements, the boundary rule and the pinning rule.
- ``grep -c 'data-theme="dark"\] \[data-surface="pos"\]' docs/design-system.md`` prints `0`. The
  scope has no dark counterpart; a nested example is the superseded design creeping back in.
- `pnpm check` and `pnpm lint` both exit 0 (`lint` does not read `docs/`, but the test file is
  `src/`, and it must be Prettier-clean).
- `git status` shows exactly two modified files: `docs/design-system.md` and
  `src/lib/styles/tokens.test.ts`. Any `.svelte`, `.css`, route or schema file in the diff means this
  task went out of bounds.

**Watch out:**
- **Do not run Prettier on `docs/design-system.md`.** `docs/` is listed in `.prettierignore` with its
  reason recorded there. Hand-format to match the file's existing rhythm.
- **Do not overwrite T-02's repairs.** T-02 already moved the `text-wrap: balance`,
  `:focus-visible` and `prefers-reduced-motion` claims from `tokens.css` to `base.css` and fixed
  section 5's duplicated table header row. Replacing a whole section wholesale from memory silently
  reverts them; re-read each region immediately before you replace it.
- **Do not copy token VALUES into this document.** Names and roles only. Every false claim T-02 had
  to repair began as a value or a location that was true when it was typed and rotted in place.
- **Do not "helpfully" re-measure and re-add a ratio table.** The census lives in the test. A table
  here is a second source of truth that is wrong the next time a value moves — which is exactly what
  step 6 is deleting.
- **`src/lib/components/ui/StatusMark.svelte` carries a comment citing `5.13:1 on --c-raise` and
  `4.35:1 on --c-bg`, both measured before T-06 re-solved `--c-ink-3`.** It is **not** in this
  task's file list — do not edit a component here. Do not copy those numbers into the document
  either, and note the staleness in the commit message so it is visible to the next session.
- **Section 7 is T-13's.** Leave it exactly as it is; a merge conflict between two tasks editing the
  same document is avoidable by staying inside your own headings.

---

### T-13 — Write the POS layout grammar into `docs/design-system.md` section 7 as CONTRACTS, not components

**Needs:** T-12 (sections 2, 4 and 9 rewritten around the surface scope and the type roles; the
document guard test in `src/lib/styles/tokens.test.ts` that section 7's token names must satisfy)
**Files:**
- `docs/design-system.md` — EDIT (`## 7. POS component rules` — replace its whole body, base-branch
  lines 125–135, up to but not including the `---` that precedes `## 7b. Dashboard component
  rules`. The section heading itself stays; `## 7b` and everything after it is untouched.)
- `src/lib/styles/tokens.test.ts` — EDIT (add two assertions to the
  `describe('the design system document')` block T-12 appended at the end of the file. Do not
  rewrite the block and do not touch any other block.)

**Spec:** 6 (`### Protecting unsynced data` — "The number of unsynced operations is always visible on
screen"; logout and POS session close blocked while the queue is not empty; online card/mobile
payments not automatically treated as successful offline), 5 (on a menu version mismatch the POS
downloads the **full menu snapshot** and replaces its local copy), 13 (the order statuses `OPEN`,
`BILLED`, `PAID`, `VOIDED`, `REFUNDED` and the item lifecycle, whose names this section reuses),
33 (open decision 1 — "How does the waiter enter orders with one POS device?", recommended default
"the waiter uses the shared POS at the counter; a tablet becomes a second registered terminal later"
— **UNANSWERED**). Everything else in this section is house rule from `CLAUDE.md`'s "Design & UI"
section or a WCAG criterion cited by number; **no design rule may be attributed to a spec section**,
because `docs/spec.md` contains no UI text.
**Invariants:** 5 (a completed offline cash sale is a recorded fact; card and mobile are never
auto-completed offline; logout and session close are blocked while the queue is non-empty),
9 (owner-PIN approval is required for refund, void of a SENT item, discount above the limit, comp,
re-opening a paid order, opening the drawer without a sale, cash pay-out above the limit, and voiding
an order with SENT items — with a mandatory reason code), 8 (permissions are enforced server-side on
every POS route, reads included, returning `403` — hiding a button is not security), 1 and 7 (money
is integer minor units, formatted by one formatter; each line renders the unit price and tax rate
**stored on that line**, never a recomputed current price)

**Do:**

1. **Open the section and read it before replacing it.** The current body runs from the paragraph
   beginning "**The guest check is permanent.**" to the paragraph beginning "**Worth stealing from
   the incumbents:**". Replace that body. Keep the `## 7. POS component rules` heading and the `---`
   rule that follows the section.

2. **Open with what this section is, in three short paragraphs.**
   - **No POS screen is built by this plan, deliberately.** Spec 33 open decision 1 — how the waiter
     enters orders with one POS device, whose recommended default is the shared counter POS with a
     tablet as a second registered terminal later — is **unanswered**, and it is the decision that
     sets the target hardware and therefore the target resolution. A POS screen built before that is
     answered is a screen built twice. `CLAUDE.md` requires an open decision to be surfaced and
     asked, never assumed silently.
   - **What this section is instead: contracts.** Each rule below states what a component must do,
     what it must never do, and the failure it prevents. A future POS plan implements them; this
     document does not describe anything that exists today. Say that outright so no session reads
     the section as an inventory of built components.
   - **Every POS component uses the token NAMES unchanged** — `text-ink`, `text-ink-2`, `bg-raise`,
     `border-control-line`, `text-st-offline`, `shadow-*` — and relies on §2's `[data-surface="pos"]`
     scope for their values. A POS component must **never** hardcode a colour and never branch on
     theme or surface. Two contracts that come straight from the 2026-09-14 reversal and are the
     easiest to get wrong:
     - **A pressable surface is outlined, not merely raised.** `border-control-line` (4.73:1 on the
       till's ground), because a white key face there measures **1.22:1** and WCAG 1.4.11 wants 3:1
       for the edge of a UI component. `border-line` is decorative only. A key drawn with a shadow
       and no border is the defect, however good it looks.
     - **Menu keys carry a category BAND, never a photo** — `--c-cat-grills`, `--c-cat-rice`,
       `--c-cat-somali`, `--c-cat-drinks`, `--c-cat-sides`, `--c-cat-sweets`, each clearing 3:1 on
       the key face. A band is **wayfinding, never a status, and never the only carrier**: the
       category name is always written beside it (WCAG 1.4.1). State the consequence that reaches
       past CSS, because it is a contract on a future plan and not a styling note — **no image column
       in the menu schema, no image payload in the offline menu snapshot, and nothing to invalidate
       when the menu version bumps** (spec 5).
     The four device-chrome tokens `--c-screen`, `--c-key`, `--c-key-line` and `--c-key-ink` are
     **retired** and no POS component may reach for them; §2 records what replaced them. And the two hard structural constraints already enforced in the repository:
     nothing under `src/routes/(pos)/` or `src/lib/pos/` may import `$lib/server` — `eslint.config.js`
     enforces it with `no-restricted-imports` — and the `(pos)` group has **no** `+layout.server.ts`
     and **no** `+page.server.ts`, because a blocking server load would make the POS unusable with no
     network (invariant 5).

3. **Contract — the check is permanent.** It occupies a fixed region and **never unmounts**; the
   cashier never navigates away to see what has been rung in. Category tabs and the item grid swap
   *around* it. Modals are for exceptions only — reason codes, owner approval, errors — and never
   for ordinary ordering. Failure it prevents: a modal ordering flow that hides the check at the
   moment the cashier most needs it. Add the note from the layout research that the check here is
   **long-lived** in a way no quick-service reference covers — a table opens, items arrive in rounds
   over an hour, the bill prints, more items land and re-open it — so `OPEN → BILLED → PAID` (spec
   13) must read at a glance and `BILLED` has no QSR equivalent to borrow from.

4. **Contract — categories are tabs, not drill-down-and-back**, and the grid is **generated from the
   menu snapshot**. Spec 5: when the POS's menu version differs from the server's, it downloads the
   full snapshot and replaces its local copy. Hand-placing keys creates a second source of truth
   that drifts from the menu version — the failure this contract prevents.

5. **Contract — the offline indicator is permanent chrome, and it carries the COUNT.** Introduce it
   as *the only screen rule `docs/spec.md` actually states*, and quote the sentence verbatim,
   attributed to spec 6 under `### Protecting unsynced data`:

   > The number of unsynced operations is always visible on screen.

   Then the house rules around it: online is `--c-ok` with `●`; offline is `--c-st-offline` with `◆`
   **plus the count** — colour never carries the meaning alone (WCAG 1.4.1), matching §3's glyph
   vocabulary. It is chrome, **never a toast**: a toast that was missed is indistinguishable from one
   that never fired. It stays visible on every POS screen, including while a modal is open.

6. **Contract — a control the queue disables must SAY WHY**, and **contract — card and mobile tenders
   visibly disable offline.**
   - Logout and POS session close are blocked while the sync queue is non-empty (spec 6; session
     close additionally needs a connection because reconciliation runs on the server). A control
     disabled without a stated reason sits dead and reads as a bug. The reason must be **visible
     adjacent text** carrying the current unsynced count — not a tooltip, which does not exist for a
     touch user, and not a title attribute alone.
   - Quick tenders come in two flavours: exact amount due, and next-highest note. **Card and mobile
     can never auto-complete offline** unless the provider or terminal explicitly supports offline
     authorization (invariant 5) — those tenders visibly disable with their reason, and must never
     fail *after* the tap. **Cash stays enabled**: a completed offline cash sale is a recorded fact,
     not a request the server may reject. The house rule for an offline card attempt is fail closed —
     no receipt, no invoice number, no clearing posting, the order stays `BILLED`.

7. **Contract — owner-PIN actions are visually separated, and separation is not security.** List
   invariant 9's eight actions by name: refund · void of an item already SENT to the kitchen ·
   discount above the configured limit · comp or staff meal · re-opening a paid order · opening the
   cash drawer without a sale · cash pay-out above the limit · voiding a whole order any of whose
   items were already SENT. They sit apart from ordinary functions — fast to reach deliberately, hard
   to hit by accident. The approval dialog captures action, acting employee, approver and reason code
   **together**; reason codes are mandatory on voids, refunds, discounts and comps and are **never**
   made optional or configurable-off. Then the sentence that keeps the contract honest: **every one
   of these is enforced server-side and returns `403` regardless of what the screen shows (invariant
   8) — visual separation is an affordance, not a control, and hiding a button is not security.**
   Keep the borrowed idea worth keeping: a persistent manager-mode state signalled by a border
   around the whole screen.

8. **Contract — touch floors; contract — money on the check; and the status vocabulary.**
   - **Touch:** name the four tokens and their floors — `touch-min` 56px absolute floor anywhere on
     the POS, `touch` 64px standard target, `touch-lg` 72px menu keys and function rail, `touch-xl`
     96px for **Pay** and **Send to kitchen**, the one-touch closers — and add the one clause a fresh
     session needs: Apple's 44pt and Material's 48dp assume a **seated** user holding the device and
     are too small for a counter. Keep at least `gap-2` between POS keys; spacing between targets
     reduces mis-taps independently of target size. **Do not restate §5's millimetre research here** —
     §5 owns it and a second copy is a second thing to get wrong; cross-reference it instead. Add
     the one non-visual floor that belongs to the POS: counter and kitchen noise routinely reaches
     85 dBA, so **audio can never be the primary confirmation channel**.
   - **Money:** the check's totals block uses `text-total` for the grand total, with subtotal,
     discount and tax above it in `text-ink-2` at a smaller role. All of it is `--font-mono` with
     `tabular-nums`, right-aligned; negatives carry a leading `−` **and** `--c-danger`, never colour
     alone. **Each line renders the unit price and the tax rate stored on that line** (invariant 7),
     so a later menu or rate change cannot alter a past sale on screen. The UI performs no arithmetic
     and no rounding (invariant 1) — and until `src/lib/server/money/` exports a formatter (it holds
     only a `README.md`), **no POS component may render a money figure at all**.
   - **Status:** reuse §3's glyph vocabulary — item `NEW ◇` / `SENT ▲` / `VOIDED ✕` (struck through,
     with reason and approver); order `OPEN ○` / `BILLED ◐` / `PAID ●` / `VOIDED ✕` / `REFUNDED ↩`;
     table free `○` / occupied `●` with the open amount. Record that
     `src/lib/components/ui/StatusMark.svelte` today supports only the dashboard's `done` /
     `not-started` pair and **deliberately** implements none of the spec 13 statuses, because no
     order, item, table or sync row exists in the repository yet — the plan that adds those columns
     extends that component rather than coining a second status vocabulary.

9. **Close the section with the four gaps and the reference.** The quick-service grammar runs out at
   four places, each of which is open design work, not a contract: the long-lived check; a table map
   as a primary screen (free vs occupied plus the open amount, transfer and merge — no QSR reference
   has one); split and merge bills, which is direct manipulation of a check that already exists and
   where mis-taps cost real money; and owner approval done properly. Add the battery interlock as a
   candidate worth building — block opening a check below 5%, warn at 15%, log both, not dismissible;
   a tablet dying with unsynced operations is the worst case and it is preventable in the UI. Finally
   point at `docs/pos-layout-grammar.html` as the visual reference with its four annotated zones
   (status bar · function rail · category tabs and item grid · the permanent check with totals and
   tender) and its adopt/adapt/reject verdicts — **and state that its palette is a dated snapshot
   while `src/lib/styles/tokens.css` is the source of truth**, matching the note T-08 added to that
   document.

10. **Extend T-12's document guard test with two assertions**, in the existing
    `describe('the design system document')` block at the end of `src/lib/styles/tokens.test.ts`:
    - The spec sentence is quoted **verbatim**: read both `docs/spec.md` and
      `docs/design-system.md` and assert the exact string `The number of unsynced operations is
      always visible on screen` appears in each. This catches a paraphrase drifting away from the
      one piece of spec text the UI is actually bound by.
    - Section 7 names the four touch tokens: assert `touch-min`, `touch`, `touch-lg` and `touch-xl`
      all appear in the document. Discover them from the `@theme` block of `src/lib/styles/tokens.css`
      (the `--spacing-touch*` declarations) rather than hardcoding the list, assert the discovery is
      non-empty first, then require each discovered name to be mentioned in the document — so adding
      a fifth touch token later fails until it is documented.
    - Node-side text reading only: `vitest.config.ts` has no jsdom, no browser mode, no
      `@testing-library/svelte` and no Svelte plugin, so **no `.svelte` file can be mounted**. These
      assertions read files as strings.

**Tests:** House guard test (CLAUDE.md "Design & UI"). **Not** one of spec 29's six mandatory areas —
money arithmetic and rounding, tax in both modes, journal balance, posting rules per business event,
offline retries never duplicating, and per-route permission checks. This task documents a UI contract
and asserts two strings; none of the six is in play.

- `The number of unsynced operations is always visible on screen` appears in `docs/spec.md` **and**
  in `docs/design-system.md` → both assertions pass. Probe: change one word of the quote in the
  document, re-run, expect a failure, then `git checkout -- docs/design-system.md`.
- `finds --spacing-touch* tokens in tokens.css at all` → the discovered set is non-empty.
- Every discovered touch token name is mentioned in `docs/design-system.md` → passes for
  `touch-min`, `touch`, `touch-lg`, `touch-xl`.
- T-12's assertions in the same block still pass: every `--c-*` name the document mentions —
  section 7 now adds `--c-ok`, `--c-st-offline`, `--c-danger`, `--c-control-line` and the six
  `--c-cat-*` bands — is declared in the bare `:root` of `src/lib/styles/tokens.css`. **`--c-key-ink`
  is no longer on that list**: it was retired by the 2026-09-14 reversal, section 7 no longer names
  it, and only §2's history sentence may, through T-12's `RETIRED` exemption.

**Done when:**
- `pnpm test:unit` passes, with `src/lib/styles/tokens.test.ts` reported as a run file.
- `grep -c "The number of unsynced operations is always visible on screen" docs/design-system.md`
  prints ≥ 1, and the same grep against `docs/spec.md` prints `1`.
- `grep -n "touch-xl" docs/design-system.md` prints a hit inside section 7.
- `sed -n '/^## 7\. POS component rules/,/^## 7b\./p' docs/design-system.md` shows the rewritten
  section, and reading it start to finish never claims a POS screen or POS component exists.
- `git status` shows exactly two modified files: `docs/design-system.md` and
  `src/lib/styles/tokens.test.ts`. No `.svelte` file, no route, no token file in the diff.
- `git diff -- docs/design-system.md` touches nothing between `## 1.` and `## 6.`, and nothing from
  `## 7b.` onward — this task owns section 7 only.

**Watch out:**
- **Do not build any of it.** Every rule here is a contract for a future plan. Creating a POS
  component, a POS route, a `data-surface` stamp or a touch-target screen in this task is out of
  bounds — the hardware decision that sets the target resolution is still unanswered, and
  `CLAUDE.md` requires an open decision to be surfaced and asked, never assumed.
- **Never cite a spec section for a design rule.** `docs/spec.md` has zero occurrences of `font`,
  `colour`, `contrast`, `WCAG`, `accessib`, `layout`, `resolution` and `touch`. The only spec
  citations legitimate in this section are the unsynced-count sentence and the queue-blocks-logout
  rule (spec 6), the full-snapshot menu sync (spec 5), the order statuses (spec 13) and open
  decision 1 (spec 33). Attribute everything else to `CLAUDE.md`'s "Design & UI" section or to a
  numbered WCAG criterion.
- **Quote spec 6 exactly.** Locate it by its heading `### Protecting unsynced data`, not by line
  number — it sits at `docs/spec.md` line 328 on the base branch and any spec edit moves it. A
  paraphrase breaks the guard assertion in step 10, which is the point of the assertion.
- **Do not restate §5's touch research or §3's status table.** Name the tokens and the glyphs,
  cross-reference the sections that own the reasoning. A second copy of a number is a second thing
  to get wrong — which is how sections 4, 5 and 9 acquired the false claims T-02 had to repair.
- **`docs/` is in `.prettierignore`** — hand-format, do not run Prettier on the document, and do not
  remove it from the ignore file.
- **Section 7b is not yours.** T-12 already edited four regions of it; leave the rest alone so the
  two tasks' diffs do not overlap.
- **The e2e specs are frozen.** `e2e/auth.spec.ts` and `e2e/smoke.spec.ts` pin heading text, label
  text, button names, `role="alert"` and `getByText('not started', { exact: true }).toHaveCount(5)`.
  This task changes no markup at all, so no e2e assertion may change — if one needs to, that is a
  finding to report, not an edit to make.
