# The matcami UI design system — one vocabulary, two surfaces

**Goal.** Turn `docs/design-system.md` from a document the code partly contradicts into the contract
the whole product is built against, and close the four things that stop it being one: the POS has no
surface of its own — four pinned chrome hexes where a pinned-LIGHT device ground belongs, and no rule
giving a pressable key an edge — the palette has thirty measured WCAG failures nobody fixed,
Tailwind's own scales quietly stand in for matcami tokens, and nothing in the planning or
verification tooling knows the design system exists.

**This plan writes no money code, no journal entry, no stock movement, no migration, no database
column, no server route, no `+server.ts`, no form action and no permission key.** It is tokens, CSS,
one Svelte layout attribute, node-side guard tests, documentation, and the two skills.

> **Builds on `tasks/dashboard-ui-redesign/` (executed).** That plan is **not superseded** — it
> shipped. Its 21 tasks are committed on `feat/dashboard-ui-redesign` as PR #4, with 247 unit tests
> passing. This plan is the layer above it: the work it deliberately left out, plus the two things it
> could not have covered because they were out of its scope (the POS surface) or outside the repo
> (the skills).

## Branch — read this before running T-01

This plan runs on **`feat/ui-design-system`, cut from `feat/dashboard-ui-redesign`** — *not* from
`main`, and *not* from `feat/restaurant-identity-and-dashboard`.

Every task edits files that exist **only on that branch**: `src/lib/styles/base.css`,
`src/lib/components/ui/`, the `--c-ring` and `--c-control-line` tokens, and the three guard-test
files. Cut from the wrong base and half of this plan's `EDIT` tags point at files that are not there.

```bash
git worktree add ../matcami-ui-design-system -b feat/ui-design-system feat/dashboard-ui-redesign
```

**PR #4 must merge before, or together with, this plan's PR.** If PR #4 changes in review, re-read
the files this plan tags `EDIT` before trusting a line number quoted below.

## Requirements (as agreed with the user, 2026-09-14)

The user asked for "a new system design for the UI… the system will follow that… this skill will take
care about it when generating the tasks… make the UI premium". Six decisions were put to them and
answered:

1. **Relationship to the executed plan — build on it.** *(Corrected mid-planning: the first reading
   of this question assumed that plan had never been executed. It had. The answer below is the one
   given once the real state was established.)* Branch off PR #4 and add the layer above it.
2. **"Premium" extends to type, space, elevation and a re-tuned palette.** The previous plan's hard
   rule — *"No task may change a colour VALUE in tokens.css"* — is **revoked**. Colour values may now
   change, subject to a computed contrast gate. **Excluded:** brand identity. No wordmark, no brand
   mark, no app icon, and `src/lib/assets/favicon.svg` stays exactly as it is.
3. **Both surfaces, but the POS as written grammar only.** One design system covering dashboard and
   POS. The POS gets documented grammar, tokens and component contracts — **no POS screen, no POS
   component, no POS chrome is built**, because none exists yet and spec 33 decision 1 is unanswered.
4. **Enforcement is skill briefs AND repo tests.** Skill edits alone are insufficient: three
   typefaces stayed missing for the project's entire life while `pnpm check`, `pnpm lint`,
   `pnpm test` and both Playwright specs stayed green. **The repo tests are the load-bearing half.**
5. **The POS shell is a surface scope,** `[data-surface="pos"]`, re-declaring the existing `--c-*`
   names — not a second `--c-key-*` token family. Token names stay identical on every surface and
   only their values differ, so a component written for one surface is correct on the other.
   **The scope's colour scheme was reversed twice on 2026-09-14, and the final rule is the larger
   decision: `[data-surface="pos"]` is LIGHT IN BOTH THEMES, and it pins the COMPLETE palette.**
   Grounds, inks, accent, the three semantic colours, the six `--c-st-*` status colours and their six
   soft grounds, the two aliases and the three shadow rungs are all declared inside the scope, and
   **no dark block overrides any of them**. The till is a DEVICE: its surface is a property of the
   hardware on the counter, not of the viewer's OS preference. The dashboard themes; the POS does
   not. What the scope buys beyond being light is the till's **ground/key relationship and its
   density**: the dashboard puts white cards on a light ground for reading, while the POS uses a
   **deeper ground so the white key faces read as the raised, pressable thing**.

   **The lesson to carry wherever this rule is stated — it is the whole finding: pinning a surface
   means pinning EVERY token on it, not just the grounds.** *(Decision history, SUPERSEDED, kept
   because the rule flipped twice in one day and the record of why is worth more than a clean file.
   (i) The scope was first specified as a shell **pinned dark in both themes**. That broke: the inks
   kept theming, so light-theme ink landed on a permanently dark shell at **1.08:1**. (ii) After
   reviewing a light-mode commercial POS reference the user chose LIGHT, and the scope was re-authored
   to override **grounds only** and inherit every ink from the theme. Measurement disproved that the
   same day — opened on a dark-mode OS the POS rendered dark-theme ink on the white key face,
   `--c-ink` `#e6eaec` on `--c-raise` `#ffffff` = **1.21:1**, the identical defect mirrored. Neither
   wording may be quoted as current fact. The glare argument for a dark till — dark cuts counter glare
   and keeps the keys the brightest thing on screen — was raised once, **overruled**, and stays
   overruled.)* (2026-09-14)
6. **`docs/design-system.md` is normative for UI, subordinate to `CLAUDE.md`'s twelve invariants.**
   `docs/spec.md` says nothing about UI, so there is nothing for it to outrank.

## Scope

**IN** — the `[data-surface="pos"]` token scope (the COMPLETE palette, pinned light in both themes) and the
`data-surface` stamp on the `(pos)` shell · the mandatory `--c-control-line` border on every pressable
POS surface · the retirement of the four now-consumerless POS chrome tokens · the six `--c-cat-*`
category-band tokens · the four-value palette re-tune · the contrast guard widened from a legal-pair
subset to the full generated census across three surface states · the semantic type scale using Tailwind's three
`--text-*` modifiers · the elevation ladder and the prose measure · a guard banning Tailwind's
default scales where matcami defines a role · the rewrite of `docs/design-system.md` sections 2, 4, 7
and 9 and the repair of its four false claims · the POS layout grammar as component *contracts* ·
a sixth planning lens wired into the array that actually dispatches it · design rules in the task
output contract · a sixth verification lens in `execute-plan`.

**OUT** — everything on `CLAUDE.md`'s "Do NOT build" list · **any POS screen, POS component or POS
chrome** (documented only; spec 33 decision 1 is unanswered) · any money component, formatter or
arithmetic — `src/lib/server/money/` is a README only · any new route, `+server.ts`,
`+page.server.ts`, form action, permission key or `PUBLIC_ROUTE_IDS` entry · any schema, column,
migration or seed row · the favicon, a wordmark and any brand mark · any new dependency · a component
test harness (`jsdom`, `@testing-library/svelte`, Vitest browser mode) — every guard test here is
node-side and reads files as text · rebuilding anything PR #4 already shipped.

## Approach

**Chosen: build the missing surface first, then the values, then the vocabulary, then the document,
then the tooling.** The order is a dependency chain, not a preference. The POS scope (Phase 1) must
land before the palette re-tune (Phase 2) because Phase 1 introduces the third palette state that
Phase 2's census has to cover — widening a guard to a state that does not exist yet is not a thing
that can be done.

**THE COUPLING BETWEEN PHASE 1 AND PHASE 2 — read this before writing either.** Because
`[data-surface="pos"]` is pinned light in both themes, the values it pins **are light-palette values**
— and **T-06 re-tunes the light palette** (light `--c-ink-3` `#646f7a` → `#5c6771`). The POS block's
`--c-ink-3` must therefore be the **re-tuned** value, and the two declarations can silently drift
apart. That is decided one way, and it is stated the same way in every file of this plan:

- **T-03 writes the FINAL value directly** — `--c-ink-3:#5c6771` inside the POS block, never the
  pre-re-tune `#646f7a`. The POS state is correct from the commit that creates it.
- **T-06 VERIFIES the POS block already carries `#5c6771` rather than editing it again.** T-06 changes
  the bare `:root` and the two dark blocks; if it also edits the POS block it has either re-tuned a
  value twice or written a different one, and both are the drift this rule exists to prevent.
- **T-04's guard asserts the POS block's three ink values equal the bare `:root`'s post-re-tune light
  values** (`--c-ink` `#161b20`, `--c-ink-2` `#4a5661`, `--c-ink-3` `#5c6771`), so a future drift in
  either declaration fails the suite rather than reaching a screen.

There is **no** "the re-tune reaches the POS for free" — that sentence belonged to the superseded
grounds-only wording and is FALSE under the pinned rule. The POS carries its own copy of every ink,
and a copy is a thing that has to be kept in step deliberately.

**What the pinned rule removes from Phase 1: the POS has no dark state.** No dark block overrides the
scope, so there is no `pos-dark` half of the census to solve, and the single CONTRAST pair this plan
used to defer — `pos-dark` `danger` on `raise` at **4.42:1** — no longer exists to defer. The POS
state is audited at **182 ink × ground pairs, 0 failures, tightest 4.60:1** (`ink-3` on `--c-bg-2`
`#e1e6eb`) from T-03 onward, because T-03 writes the re-tuned inks in the first place.

T-04's `PENDING_RETUNE` mechanism survives, repurposed and holding **one** entry — keyed
`--c-ink-3`, recording a **value divergence** rather than a contrast failure: the POS block holds
`#5c6771` while the bare `:root` still holds `#646f7a` until T-06. It asserts the divergence is still
exactly that one, so it cannot quietly become an exemption, and **T-06 deletes it in the same commit
that closes its cause**; T-07 removes the map when it widens the census. Phase 1 and Phase 2 still
ship in **one PR**.

The type scale (Phase 3) must land before the document (Phase 4) describes it. The document must be
right before the lenses (Phase 5) cite it.

**Rejected — a second `--c-key-*` token family** for the POS. It matches the precedent already in
`tokens.css` (`--c-key-ink`, since retired) and is more explicit. It was rejected because it makes components
surface-bound: a `StatusMark` written for the dashboard could not be reused on the POS without a
parallel set of class names, and the grammar would have to enumerate every legal pairing by hand.
The surface scope also answers a question the token family leaves open: what a `--c-raise` surface
sits ON inside the till. Under the scope that answer is structural rather than chromatic — `--c-raise`
is still `#ffffff`, and it is the till's deeper `--c-bg` underneath it that makes the same white key
face read as the raised, pressable thing. *(Before the 2026-09-14 reversal this paragraph answered the
opposite question — whether a white card may sit inside a dark shell — and said it could not, because
`--c-raise` was not white inside the scope. The surface scope survived the reversal; that particular
reasoning did not.)*

**CHOSEN, by reversal — a LIGHT till, PINNED in both themes.** A light POS was written up as
*rejected* earlier on 2026-09-14, on the grounds that it **breaks `CLAUDE.md`'s explicit rule** that
the shell stays dark in both themes, along with the operational reason for that rule: dark cuts
counter glare and keeps the key faces the brightest thing on screen. The user reviewed a light-mode
commercial POS reference and **chose it anyway**; the glare argument was raised once and overruled.
`CLAUDE.md`'s rule is the thing that gives way here — **T-01 rewrites that line rather than preserving
it.**

**Pinned, not themed — and that half was settled by measurement, not by taste.** *(Superseded wording:
between those two points the scope was authored as light-but-theme-following, overriding grounds only.
Do not restore it.)* A surface that pins its grounds and lets its inks theme puts dark-theme ink on the
white key face for every viewer whose OS is in dark mode: `--c-ink` `#e6eaec` on `--c-raise` `#ffffff`
is **1.21:1**, `--c-ink-2` **2.13:1**, `--c-ink-3` **2.65:1**. So the scope declares the COMPLETE
palette — grounds, inks, accent, semantic, the six status colours and their soft grounds, the two
aliases and the three shadow rungs — and **no dark block overrides any of it**. The till is a device;
the dashboard themes and the POS does not.

**Its trade-off, stated rather than waved past.** A light till gives up the glare margin a dark
ground buys under counter lighting, and gives up "the keys are the brightest thing on screen" as a
free consequence of the palette. Both have to be bought back **structurally instead of
chromatically**, and that is what the scope exists to do now: a **deeper ground** (`--c-bg` `#e4e9ee`,
deeper than the page's `#e9edf0`) so the white key face is still the brightest surface on it, plus a
mandatory **1px `--c-control-line` border on every pressable surface** — because a white key on that
ground measures only **1.22:1**, and elevation alone cannot carry a control's edge. The resulting
palette was solved and audited at **182 ink × ground pairs, 0 failures, tightest 4.60:1**.

**What the scope is NOT:** an exemption list, and not a second token family. It is the complete device
palette re-declared under the ordinary token names, so components stay portable across surfaces.

**Rejected — overriding Tailwind's default scales in place** (redefining `--text-sm`, `--radius-lg`
and so on with matcami values). Cheapest possible migration — every existing class string keeps
working and silently becomes compliant. Rejected because the names carry no meaning: `text-3xl` does
not say "page title", so a developer picks a size by eye, which is how the inconsistency this plan
exists to fix comes back. Semantic roles cost ~64 class-string edits across six files that are
already restyled.

## Risks that survived adversarial verification

A six-lens risk panel — accounting, data model, offline/sync, permissions, ops/migration, and a
design lens written for this feature — ran 55 agents with independent adversarial refutation:
**41 findings, 11 survivors, 30 refuted.** Three refuters died on API errors; findings they were
assigned survive by the panel's fail-safe rule rather than by winning the argument, and each of those
was re-verified by hand before being kept. Two survivors (the focus-ring regression, the duplicated
dark block) turned out to be **already fixed on the base branch** and were dropped after the branch's
real state was established.

- **CLOSED BY DECISION on 2026-09-14, and kept because it is decision history — the dark POS shell.**
  Until that date the design was a shell *pinned dark in both themes*, and this bullet recorded its
  measured consequence. Found independently by three lenses, then verified by direct computation:
  `--c-screen` and `--c-key` were pinned dark while every ink and status token inverted, so in the
  light theme **26 of 26 POS-shell pairs failed** — `--c-ink` on `--c-screen` measured **1.08:1**,
  black on black, and spec 6 line 68's mandated unsynced count measured **2.17:1** on a key. Three
  more failed in dark, `--c-key-line` on `--c-key` was **1.31:1** against WCAG 1.4.11's 3:1 so
  adjacent keys had no edge, and `tokens.css` offered one on-dark ink and zero on-dark status colours,
  leaving a POS component nothing compliant to reach for. It was **pre-existing** — the base branch
  neither caused nor addressed it, and its test `keeps the POS chrome un-themed` in fact *enforced*
  the structure that produced it. **None of that is true any longer.** The user reversed the
  pinned-dark rule, the POS is now pinned **light in both themes**, and every one of those pairs
  ceases to exist along with the surfaces they were measured against. Recorded because it is *why*
  the surface scope exists — not because it is still open. **Do not cite these ratios as a live
  defect.**

- **CLOSED BY MEASUREMENT on 2026-09-14 — the same defect, mirrored, in the first light draft.** Worth
  keeping because it is the reason the scope pins everything rather than the grounds. A re-authoring
  of this plan specified the POS as light **but theme-following**, overriding grounds only and
  inheriting the inks. Opened on a dark-mode OS the samples rendered dark-theme ink on the pinned
  white key face: `--c-ink` `#e6eaec` on `#ffffff` **1.21:1**, `--c-ink-2` `#a8b3bc` **2.13:1**,
  `--c-ink-3` `#97a0a8` **2.65:1** — the 1.08:1 defect above, with the surfaces swapped. **The rule
  that closes it, and the sentence to repeat wherever the scope is described: pinning a surface means
  pinning EVERY token on it, not just the grounds.** `[data-surface="pos"]` therefore declares the
  complete palette and no dark block overrides any of it; T-04's guard asserts it.

- **BLOCKER — on the light POS a pressable surface has no edge.** This is what the reversal put in the
  old blocker's place, and it is the single most important rule in Phase 1. A white key face
  `--c-raise` `#ffffff` on the till's ground `--c-bg` `#e4e9ee` measures **1.22:1**. WCAG **1.4.11**
  requires **3:1** for the boundary of a UI component, so **elevation alone cannot carry a key** — a
  shadow-only key is pretty and non-compliant, and no amount of tuning the shadow fixes a 1.22:1
  ground/face relationship. **Mitigation:** every pressable surface on the POS takes
  `border: 1px solid var(--c-control-line)`, which measures **4.73:1** on that ground. `--c-line`
  (**1.55:1** on the key face) is for decorative rules and non-interactive block edges only; a
  component reaching for it to outline a button has reintroduced the defect. T-10 states the rule
  where it declares the elevation ladder, T-13 may describe no shadow-only control, and T-14's design
  lens hunts for violations.

- **MED — the four POS chrome tokens are now dead, and a test still asserts them.** `--c-screen`,
  `--c-key`, `--c-key-line` and `--c-key-ink` are declared in the bare `:root` on the base branch, and
  the existing test `keeps the POS chrome un-themed` asserts they appear there and in neither dark
  block. Once the scope re-declares `--c-bg`, `--c-raise` and `--c-line` for the POS, those four have
  **no consumer** — two vocabularies for one surface is exactly what the scope removes. **Mitigation:**
  retire them in Phase 1 and update that test, stating the reason in the commit. Flagged as a direct
  consequence of the reversal rather than as tidying: any task, document or comment that still names
  them as live tokens is stale, and several did until this sweep.

- **HIGH — the contrast census everyone has been working from is wrong.** Not 12 failures: **30**.
  The earlier sweep omitted the six `--c-st-*-bg` grounds, which add 6 light and 3 dark failures, and
  the dark sweep missed 9 more. A guard built to the old number certifies a broken palette green.
  **Mitigation:** T-07 *generates* the pair list as a full cross product rather than listing it, and
  asserts the count of pairs checked so a silently shrinking list fails.

- **HIGH — Tailwind v4.3.3 ships its own `--radius-*`, `--text-*`, `--shadow-*` and `--container-*`
  scales,** so `rounded-lg` and `text-3xl` resolve to `node_modules`, not to `tokens.css`. That is a
  second source of size and type truth, which `CLAUDE.md` forbids, and **nothing in the repo detects
  it** — `pnpm check`, `pnpm lint` and all 247 tests pass with it. **Mitigation:** T-11, with an
  explicit exemption list where each entry carries its reason, following the `schema-guards`
  precedent. Spacing is deliberately excluded — see T-10.

- **HIGH — adding the design lens to the lens *table* dispatches nothing.**
  `.claude/skills/plan-feature/SKILL.md`'s Phase 2 table is documentation; the literal `LENSES`
  array inside the workflow script in `references/brainstorm-workflow.md` is what actually spawns the
  agents. A plan that edits only the table ships a lens that runs on **zero** future plans and looks
  complete in review. **Mitigation:** T-15 edits both, and says why.

- **MED — `docs/pos-layout-grammar.html` hardcodes its own copy of the palette.** The re-tune turns
  the document `CLAUDE.md` cites as the POS visual reference into a stale second source of colour
  truth. **Mitigation:** T-08 re-syncs the four changed values and marks the copy a snapshot.

- **MED — the two dark palette blocks are byte-identical duplicates.** A re-tune applied to one and
  not the other passes a last-wins cascade in the browser but disagrees with the theme toggle.
  Already guarded on the base branch by `declares the SAME token names in both dark blocks` — which
  checks *names*, not *values*. **Mitigation:** T-06 changes both blocks explicitly, and T-07's
  census reads whichever block the parser resolves, so a value drift surfaces as a contrast failure.

*Refuted and dropped, one line each:* a Google-Fonts origin in the till's critical path (the base
branch self-hosts) · a `transformPageChunk` HTML-attribute injection sink (the stamp is written by
the base branch, not by this plan) · a theme endpoint needing a permission key (no route is created)
· `oklch()` defeating the text greps (no task introduces one) · an SSR stamp permanently disabling
the dark media query (the guarded `:root:not([data-theme="light"])` selector handles it) · a
module-level Svelte store leaking restaurant identity across SSR requests (no store is added) · a
`theme` column on `restaurant_settings` (no schema) · an elevation ladder baking a white highlight
into dark mode (T-10 declares it per theme) · a money formatter reaching a primitive (none is built)
· renaming the old plan orphaning its `.zip` (no rename — the plan is not superseded) · a glyph in
the "not started" badge breaking `toHaveCount(5)` (no screen is restyled by this plan) · and 19 more.

## Assumptions (decisions this plan rides on)

- **Spec 33 decision 1 — the POS device question — is UNANSWERED, and this plan does not answer it.**
  It is the stated reason the POS grammar is documented (T-13) and no POS screen is built. **No task
  may choose a target resolution, a breakpoint set or a device orientation for the POS.**
- **`docs/design-system.md` is normative for UI, subordinate to `CLAUDE.md`.** Decided by the user
  2026-09-14. T-01 records it; every later task and both new lenses depend on it, because the spec
  gives them nothing to cite.
- **The palette freeze is lifted.** Decided by the user 2026-09-14, reversing the constraint recorded
  in `src/lib/styles/tokens.test.ts` on the base branch. T-01 records the reversal before T-06 acts
  on it, and T-07 deletes the comment that forbids it.
- **The POS is a LIGHT device surface IN BOTH THEMES, and `[data-surface="pos"]` pins the COMPLETE
  palette.** Decided by the user 2026-09-14, reversing the pinned-dark rule that `CLAUDE.md` states
  and that this plan's first draft argued from throughout. The glare argument for a dark till was
  raised once and overruled. The scope pins grounds, inks, accent, semantic, the six status colours
  and their soft grounds, the two aliases and the three shadow rungs; **no dark block overrides any of
  it**, and no nested `[data-surface="pos"]` rule may appear inside a dark block. **T-01 records the
  reversal and rewrites `CLAUDE.md`'s "The POS shell stays dark in BOTH themes" line rather than
  preserving it.** Every later task depends on this; anything still arguing from the dark shell — or
  from the superseded "follows the theme" / "grounds only" draft — is stale by definition.
- **Menu keys carry a category BAND, not a photo.** The user's choice, 2026-09-14. Six wayfinding
  tokens — `--c-cat-grills`, `--c-cat-rice`, `--c-cat-somali`, `--c-cat-drinks`, `--c-cat-sides`,
  `--c-cat-sweets` — each clearing 3:1 on the white key face. They are **never status and never the
  only carrier**: the category name is always written beside the band (WCAG 1.4.1). The consequence
  that reaches past CSS is the reason it is recorded here rather than left to a stylesheet — **no
  image column in the schema, no image payload in the offline menu snapshot, and nothing to
  invalidate on a menu-version bump.** This plan writes no schema and no snapshot; it records the
  choice so a future POS plan does not quietly add one.
- **CLOSED — the bands have no dark values, and with the POS pinned light they do not need any.**
  This was recorded as an open question while the POS still themed: the six `--c-cat-*` tokens are
  declared in the bare `:root` and in no dark block, so a dark-theme POS would have painted the light
  band hexes on a dark key face at **1.85–2.33:1**. **`[data-surface="pos"]` is now pinned light in
  both themes, so that state does not exist** — a band only ever renders on the white key face of the
  pinned-light device surface, where all six clear 3:1 (5.02–7.70). The question is **MOOT for the
  POS** and no task adds dark values for it. It re-opens **only** if a `--c-cat-*` band is ever used
  on the dashboard, which themes; no task in this plan does that, and a future one that wants to must
  surface the question again before declaring a band outside the POS scope.
- **`docs/design-system.md` §10's claim that spec 33 decision 1 "sets the target resolution" is an
  inference, not spec text.** Left standing as a reasonable inference; T-13 does not repeat it as a
  quotation.

## In play

**Spec:** 6 (line 68 — the unsynced count is always visible on screen; the only UI rule the
specification mandates), 11 (ESC/POS receipts, 32 or 48 fixed characters), 33 (decision 1,
unanswered). **The specification is otherwise silent on UI** — verified by grep; no task may cite it
for a design rule.

**Invariants:** 1 (money is integer minor units — constrains what any component may do with an
amount), 5 (the POS surface must work offline — governs the `(pos)` shell and forbids any network
dependency there), 7 (each line snapshots its own price and tax rate — constrains any future money
rendering the grammar describes), 8 (permissions are enforced server-side — this plan creates no
route, and that is deliberate). Plus the whole of `CLAUDE.md`'s "Design & UI" section.

**WCAG:** 1.4.1 (colour is never the only carrier), 1.4.3 (4.5:1 normal text), 1.4.11 (3:1 for UI
component boundaries and focus indicators), 2.4.7 (focus visible), 2.3.3 (reduced motion).

## Research

See `RESEARCH.md` in this directory. Every `GAP` recorded there also appears under **Assumptions**
above and in the handoff message.

## Workspace state at plan time (Phase 1, 2026-09-14)

This describes the repo **as `feat/dashboard-ui-redesign` stands before T-01 runs** — head commit
`74dd9a0`, 21 commits ahead of `cf41397`, 13 test files, 247 unit tests passing under Node 24.21.0.

Almost every path in this plan is tagged `EDIT`, because the base branch already created it. There are
exactly **two** `NEW` files in the whole plan:

- `src/routes/surface-scope.test.ts` (created by T-05)
- `.claude/skills/plan-feature/references/lenses/design.md` (created by T-14)

Files created by **earlier tasks in this plan** are tagged `EXTEND`, naming the task that created
them. **Stop and report a mismatch only** when a path tagged `NEW` already exists, or a path tagged
`EXTEND`/`EDIT` does not — either means the branch was cut from the wrong base. The most likely cause
is cutting from `main` or from `feat/restaurant-identity-and-dashboard` instead of from
`feat/dashboard-ui-redesign`.

---

## Task index — every task in this plan

| ID | Title | Phase | File | Needs |
|---|---|---|---|---|
| T-01 | Record the three design-authority decisions | 0 | `01-decisions.md` | — |
| T-02 | Repair the four false claims in `design-system.md` | 0 | `01-decisions.md` | — |
| T-03 | Add the `[data-surface="pos"]` device-surface scope and retire the four chrome tokens | 1 | `02-pos-surface.md` | T-01 |
| T-04 | Guard the pinned device surface and the retirement | 1 | `02-pos-surface.md` | T-03 |
| T-05 | Stamp `data-surface="pos"` on the `(pos)` shell | 1 | `02-pos-surface.md` | T-03 |
| T-06 | Re-tune the four failing ink values | 2 | `03-palette.md` | T-01, T-03 |
| T-07 | Widen the contrast guard to the full census | 2 | `03-palette.md` | T-06, T-04 |
| T-08 | Re-sync the palette in `pos-layout-grammar.html` | 2 | `03-palette.md` | T-06 |
| T-09 | Add the semantic type scale | 3 | `04-type-scale.md` | T-01 |
| T-10 | Add the elevation ladder and the prose measure | 3 | `04-type-scale.md` | T-09, T-03, T-04 |
| T-11 | Guard against Tailwind's default scales | 3 | `04-type-scale.md` | T-09, T-10 |
| T-12 | Rewrite sections 2, 4 and 9 of `design-system.md` | 4 | `05-document.md` | T-03, T-09, T-10, T-02 |
| T-13 | Write the POS layout grammar as contracts | 4 | `05-document.md` | T-12 |
| T-14 | Write the design lens brief | 5 | `06-skill.md` | T-12, T-13 |
| T-15 | Dispatch the lens — the array, not just the table | 5 | `06-skill.md` | T-14 |
| T-16 | Add design rules to the task output contract | 5 | `06-skill.md` | T-14 |
| T-17 | Add the design verification lens to `execute-plan` | 5 | `06-skill.md` | T-14 |

**Phase order is a dependency chain.** Phase 1 before Phase 2 — Phase 1 introduces the third palette
state Phase 2's census must cover, and the POS block **pins its own copy** of the light inks T-06
re-tunes, so T-03 writes the final `#5c6771` and T-06 verifies it rather than editing it (see **THE
COUPLING** under Approach). Phase 3 before Phase 4 (the document describes the type roles). Phase 4
before Phase 5 (the lenses cite the document).

**Start with T-01.**
