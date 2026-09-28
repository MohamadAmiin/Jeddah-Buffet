# Phase 3 — The type system and the Tailwind namespace closure

**Depends on:** Phase 2 — the palette is re-tuned at source and the contrast census is green in all
three surface states, so this phase can add the *non-colour* half of the token file (type roles,
elevation, measure) and then close the door Tailwind leaves open: its own default `--text-*`,
`--radius-*`, `--shadow-*` and `--container-*` scales, which resolve from
`node_modules/tailwindcss/theme.css` rather than from `src/lib/styles/tokens.css` and are a second
source of size and type truth that nothing in the repository currently detects.

---

### T-09 — Add the semantic type scale to `src/lib/styles/tokens.css`

**Needs:** T-01 (records in CLAUDE.md and `docs/design-system.md` that `docs/design-system.md` is
normative for UI and subordinate to CLAUDE.md's invariants, which is the authority this task edits
under)
**Files:**
- `src/lib/styles/tokens.css` — EDIT (the **plain** `@theme` block, section 3 "static tokens", which
  opens near line 145; add the roles beside the existing `--text-pos` and `--text-total` near lines
  154–155. NOT the `@theme inline` block near line 106)
- `src/lib/styles/tokens.test.ts` — EDIT (add one `it()` inside the existing
  `describe('the token contract')` block, beside `it('declares the dashboard scale tokens T-02
  added')` near line 144)

**Spec:** none. `docs/spec.md` is silent on UI — zero occurrences of *font*, *colour*, *typography*,
*WCAG*, *contrast*, *layout* or *touch*. The authority for this task is CLAUDE.md's "Design & UI"
section ("Tokens live in `src/lib/styles/tokens.css` … the ONLY place a colour, size or type value
is defined") and `docs/design-system.md` section 4. Do not cite a spec section for a design rule.
**Invariants:** 5 (the POS surface must keep working with no network — every font face is served
from the app's own build, never from a third-party origin), 1 (money is integer minor units and the
UI never formats or rounds it — a type token is a *size*, never a formatter)

**Do:**

1. Open `src/lib/styles/tokens.css` and find the **plain** `@theme` block — the one introduced by
   the comment `/* ── 3. static tokens ── */`, opening near line 145 with `--font-display`. If the
   file has no such block, stop and report: the repo is not in the state this plan assumes.

2. Add the six semantic roles immediately after the existing `--text-pos` / `--text-total` lines,
   verbatim:

   ```css
     /* Semantic type roles. ONE utility is ONE complete typographic role — size,
        leading, tracking and weight together — not a bare size. Tailwind v4.3.3
        resolves exactly three modifiers on --text-<name>; all three are declared on
        every role below, because a role that omits one emits font-size ALONE. */
     --text-display: clamp(1.875rem, 5vw, 2.875rem);  /* 30→46px — one per page, the page's subject */
     --text-display--line-height: 1.08;
     --text-display--letter-spacing: -0.02em;
     --text-display--font-weight: 700;

     --text-title: clamp(1.3125rem, 2.6vw, 1.6875rem); /* 21→27px — the page title (PageHeader) */
     --text-title--line-height: 1.2;
     --text-title--letter-spacing: -0.01em;
     --text-title--font-weight: 600;

     --text-section: 1rem;        /* 16px — card heads, sub-heads, the app-bar wordmark */
     --text-section--line-height: 1.35;
     --text-section--letter-spacing: 0em;
     --text-section--font-weight: 600;

     --text-body: 0.9375rem;      /* 15px — body copy, labels, control text */
     --text-body--line-height: 1.55;
     --text-body--letter-spacing: 0em;
     --text-body--font-weight: 400;

     --text-caption: 0.8125rem;   /* 13px — hints, secondary notes, "coming soon" */
     --text-caption--line-height: 1.45;
     --text-caption--letter-spacing: 0em;
     --text-caption--font-weight: 400;

     --text-eyebrow: 0.6875rem;   /* 11px — mono uppercase kicker / table head */
     --text-eyebrow--line-height: 1.2;
     --text-eyebrow--letter-spacing: 0.16em;
     --text-eyebrow--font-weight: 500;
   ```

   The two largest use `clamp()` because a heading that is right on a 1024px counter tablet is
   cramped on a 1920px desk monitor. The values follow the hand-built grammar in
   `docs/pos-layout-grammar.html` (`h1 clamp(30px,5vw,46px)` at `-.02em/1.08`,
   `h2 clamp(21px,2.6vw,27px)` at `-.01em`, and a mono uppercase eyebrow at `11px/.16em`), which is
   the researched layout reference CLAUDE.md cites.

3. **Plain `@theme`, not `@theme inline` — and say so in the comment you write.** `@theme inline`
   exists so a utility emits `var(--c-bg)` and therefore *follows the theme*; a font size that is
   identical in light, in dark and inside the POS surface gains nothing from that indirection. The
   converse is the bug the file's header warns about: a **colour** in plain `@theme` bakes the light
   value into the utility. Colour → `@theme inline`. Size and type → plain `@theme`.

4. Declare **all three** modifiers on **all six** roles. Tailwind v4.3.3 accepts exactly
   `--text-<name>--line-height`, `--text-<name>--letter-spacing` and `--text-<name>--font-weight`
   (confirmed in its compiled source: `resolveWith(value, ['--text'], ['--line-height',
   '--letter-spacing', '--font-weight'])`). A role that declares only the size compiles to nothing
   but `font-size` — the existing `--text-pos` proves it, emitting exactly
   `.text-pos { font-size: var(--text-pos); }` — so the size would change and the leading would not.
   A complete role compiles to:

   ```css
   .text-body {
     font-size: var(--text-body);
     line-height: var(--tw-leading, var(--text-body--line-height));
     letter-spacing: var(--tw-tracking, var(--text-body--letter-spacing));
     font-weight: var(--tw-font-weight, var(--text-body--font-weight));
   }
   ```

5. Note in the same comment how a role **composes** with the weight/leading/tracking utilities,
   because the emitted shape above is not obvious: `font-medium` sets `--tw-font-weight`, so
   `class="text-body font-medium"` is 15px/1.55 at weight 500, and the order of the two classes in
   the attribute is irrelevant — the override travels through the custom property, not through CSS
   source order. The same holds for `leading-*` (`--tw-leading`) and `tracking-*` (`--tw-tracking`).

6. `--text-eyebrow` carries size, leading, tracking and weight **only**. A `--text-*` role cannot
   carry a font family or a text transform — no such modifier exists — so an eyebrow is written
   `class="font-mono uppercase text-eyebrow"`. Write that in the comment; a future session will
   otherwise assume `text-eyebrow` is self-contained and ship a sans-serif lowercase kicker.

7. Leave `--text-pos: 1.0625rem` and `--text-total: 2.5rem` **exactly as they are** — same names,
   same values, no modifiers added. They size the POS surface, which this plan documents but does
   not build, and a future POS plan owns them.

8. Do **not** add `@import url(https://fonts.googleapis.com/…)` or any other third-party font
   origin. The three faces are already delivered from packages pinned exactly in `package.json` —
   `@fontsource-variable/archivo`, `@fontsource-variable/ibm-plex-sans`, `@fontsource/ibm-plex-mono`
   (IBM Plex Mono has no official variable build, which is why that one is the non-variable
   package). A font fetched from a third-party origin dies the moment the restaurant's connection
   does, and the POS surface must keep working with no network at all.

9. Do **not** reformat the file. `src/lib/styles/tokens.css` is listed in `.prettierignore` on
   purpose — Prettier explodes its compact aligned groups from 156 lines to 197 and destroys the
   grouping the design system reads by. Match the one-declaration-per-line style the neighbouring
   `@theme` declarations already use.

10. Do **not** edit `docs/design-system.md` here. Its section 4 still says "Tailwind's default type
    scale covers the dashboard", which this task makes false; T-12 rewrites that section. Two tasks
    editing the same prose produces a conflict and a half-repaired document.

**Tests:** House guard test (CLAUDE.md "Design & UI"). These are node-side **text** assertions:
`vitest.config.ts` defines exactly two projects, `unit` and `integration`, both
`environment: 'node'` — there is no jsdom, no browser mode, no `@testing-library/svelte` and no
Svelte plugin, so **a `.svelte` file cannot be mounted and a computed style cannot be read here.**
The test proves the tokens exist and are well-formed; a person running `pnpm dev` proves the page
looks right.

- Add `it('declares the six semantic type roles with all three modifiers')` inside
  `describe('the token contract')`. For each of `display`, `title`, `section`, `body`, `caption`,
  `eyebrow`, assert the stripped stylesheet contains `--text-<name>:`,
  `--text-<name>--line-height:`, `--text-<name>--letter-spacing:` and `--text-<name>--font-weight:`
  — 24 declarations in total. Use the module-level `css` constant (the comment-stripped copy near
  line 72), **not** `source`: a role name mentioned only in a comment would satisfy `source` and
  prove nothing.
- In the same test assert `--text-pos:` and `--text-total:` are still present, so a later "tidy-up"
  cannot delete the two POS sizes while nothing on that surface is built yet.
- Failure message must name the fix: "add the missing modifier to the role in the plain `@theme`
  block of src/lib/styles/tokens.css" — never "loosen the assertion".

**Done when:** `nvm use && pnpm test:unit src/lib/styles/tokens.test.ts` passes, and
`pnpm check && pnpm lint` pass.

**Watch out:** Tailwind **tree-shakes** unused theme keys — a token produces no CSS until a
component uses the utility. After this task `pnpm build` will emit **no** `.text-body` rule at all,
and that is correct, not a failure (`docs/design-system.md` line 24 already records this). Do not
chase it by adding a class to a component here; T-11 migrates the call sites and checks the built
CSS. Second trap: the block you are editing is the **plain** `@theme` near line 145 — adding a type
role to the `@theme inline` block near line 106 also "works", but it puts a static value into the
themeable layer and teaches the next reader the wrong rule.

---

### T-10 — Add the elevation ladder and the measure tokens

**Needs:** T-09 (the plain `@theme` block is the one this task adds container tokens to, and T-09's
comment establishes the plain-vs-`inline` rule this task applies in the other direction),
T-03 (created the `[data-surface="pos"]` block, which this task must extend with the LIGHT rungs and
its own `--c-shadow` alias — step 7),
T-04 (whose POS constants in `src/lib/styles/tokens.test.ts` assert what the scope declares; adding
shadow tokens to the scope means extending that list in the same commit — step 7)
**Files:**
- `src/lib/styles/tokens.css` — EDIT (six places: the bare `:root` where `--c-shadow` is declared
  near line 65; the `@media (prefers-color-scheme: dark)` block near line 84; the
  `:root[data-theme="dark"]` block near line 102; the `[data-surface="pos"]` block added by T-03;
  the `@theme inline` block where `--shadow-card: var(--c-shadow);` sits near line 141; and the plain
  `@theme` block beside `--container-page` near line 161. **Locate every edit by selector and token
  name, never by line number** — T-03 inserted a block into this file and the line numbers have
  moved)
- `src/lib/styles/tokens.test.ts` — EDIT (extend the "must not be repeated in either dark block"
  loop inside `it('declares the dashboard scale tokens T-02 added')` near line 144, and add two new
  `it()`s in the same `describe('the token contract')`)

**Spec:** none — `docs/spec.md` says nothing about elevation, shadows or line length. Authority:
CLAUDE.md "Design & UI" (tokens are the only place a size value is defined) and
`docs/design-system.md` section 7b, which names `shadow-card` as part of the Card rule.
**Invariants:** 5 (the POS surface must keep working with no network — every value added here is
local CSS; nothing is fetched at runtime)

**Do:**

1. In the **bare `:root`**, replace the single `--c-shadow:` declaration with a three-rung ladder
   plus a derived alias:

   ```css
     /* Elevation ladder: flat (resting) → raised (card, panel) → floating (modal,
        popover, the owner-approval dialog). Declared per THEME, not in @theme,
        because the light rungs carry a white top highlight that must not appear in
        dark, where it reads as a glowing hairline.
        ELEVATION IS NOT A BOUNDARY. On the POS a white key face on the till's ground
        measures 1.22:1, so a shadow can never satisfy WCAG 1.4.11's 3:1 for the edge
        of a UI component: every pressable POS surface also takes
        `border: 1px solid var(--c-control-line)` (4.73:1). A rung raises a surface;
        it does not outline one. */
     --c-shadow-flat:0 1px 0 rgb(255 255 255 / .8), 0 1px 2px -1px rgb(22 27 32 / .18);
     --c-shadow-raised:0 1px 0 rgb(255 255 255 / .8), 0 6px 20px -14px rgb(22 27 32 / .45);
     --c-shadow-floating:0 1px 0 rgb(255 255 255 / .8), 0 18px 44px -20px rgb(22 27 32 / .55);
     --c-shadow: var(--c-shadow-raised);
   ```

   `--c-shadow-raised`'s value is **byte-identical to today's `--c-shadow`**, so nothing that
   currently renders with `shadow-card` changes appearance.

2. In **both** dark blocks — `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])`
   and `:root[data-theme="dark"]`, which are byte-identical duplicates — replace the `--c-shadow:`
   line with the three dark rungs:

   ```css
     --c-shadow-flat:0 1px 0 rgb(255 255 255 / .04), 0 1px 2px -1px rgb(0 0 0 / .6);
     --c-shadow-raised:0 1px 0 rgb(255 255 255 / .04), 0 8px 24px -12px rgb(0 0 0 / .8);
     --c-shadow-floating:0 1px 0 rgb(255 255 255 / .04), 0 20px 48px -18px rgb(0 0 0 / .9);
   ```

   and **delete `--c-shadow` from both dark blocks**. It is now a derived alias and follows the
   convention already used by `--c-ring: var(--c-accent)` and `--c-control-line: var(--c-ink-3)`:
   declared **once**, in the bare `:root` only. **State the reason precisely, because the loose
   version of it is the single easiest thing in this system to get backwards.** A custom property's
   `var()` is substituted at **computed-value time on the element that declares it** — not at use
   time — and what inherits down the tree is the already-resolved literal. `--c-shadow` is safe in
   the bare `:root` alone because the dark blocks target **`:root` too**, the same element the alias
   sits on, so it recomputes there. The rule generalises to the element, not to the theme:
   **re-declare an alias in any scope that overrides its source on a DIFFERENT element.** That is
   exactly why `[data-surface="pos"]` — a `<div>` — carries its own `--c-ring` and
   `--c-control-line` copies and must keep them, **and why step 7 gives it a `--c-shadow` copy too**:
   the scope is pinned light and overrides all three rungs, so without its own alias line the shell
   inherits `:root`'s already-resolved `--c-shadow` and paints the page theme's raised shadow — the
   dark one, on a white key face — for every dark-mode viewer. Redeclaring `--c-shadow` inside a
   **dark block** is the opposite case and is still wrong: that would **pin** it to one theme's value.
   Both dark blocks must change together or the theme toggle and the existing
   `it('declares the SAME token names in both dark blocks')` will disagree.

3. In the `@theme inline` block, beside the existing `--shadow-card` line:

   ```css
     --shadow-flat:     var(--c-shadow-flat);
     --shadow-raised:   var(--c-shadow-raised);
     --shadow-floating: var(--c-shadow-floating);
     --shadow-card:     var(--c-shadow);  /* alias of the raised rung — see below */
   ```

   `@theme inline` is required here, not optional: a plain `@theme` shadow would bake the light
   rung, white highlight and all, into both themes. One consequence is worth knowing and worth a
   half-line of comment — an inline `var()` value means Tailwind cannot inject its
   `var(--tw-shadow-color, …)` hook, so `shadow-<colour>` overrides do not apply to these rungs.
   matcami never colours a shadow, and what is required is that the utility resolve **per surface
   state** — the two themes and the pinned-light POS scope — which is exactly what `inline` buys.

4. **Keep `--shadow-card`.** `src/lib/components/ui/Card.svelte` line 21 uses `shadow-card`, and
   `docs/design-system.md` names it twice — line 24's example list and section 7b's Card rule. It
   resolves `--shadow-card` → `--c-shadow` → `--c-shadow-raised`, so there is still exactly **one**
   value behind that rung; the second utility name is an alias, not a second source of truth.
   Renaming it is a documentation change belonging to whoever rewrites section 7b, and no task in
   this plan does.

5. In the **plain** `@theme` block, beside `--container-page: 72rem`, add the two measure tokens:

   ```css
     --container-measure: 68ch;   /* body-copy measure — 45–75 characters is the readable band */
     --container-form:    32rem;  /* 512px — the single-column form / auth card */
   ```

   **Name check, verified against the installed Tailwind v4.3.3 — do not call either token
   `prose`.** `max-w-prose` is a *hardcoded static* utility that compiles to `max-width: 65ch` and
   does **not** read the `--container-*` namespace at all: defining `--container-prose` emits no
   utility of its own and `max-w-prose` silently keeps Tailwind's 65ch. `max-w-measure` and
   `max-w-form` are unclaimed and compile to `max-width: var(--container-measure)` and
   `max-width: var(--container-form)`. `32rem` is exactly Tailwind's own `--container-lg`, so the
   two cards that use `max-w-lg` today are pixel-identical after T-11 swaps them.

6. **Do not add a spacing scale, and do not let a later session "fix" its absence.** Tailwind v4
   derives every spacing utility from a single multiplier — `--spacing: 0.25rem`, one line in
   `node_modules/tailwindcss/theme.css` — so `p-4` compiles to `calc(var(--spacing) * 4)` and
   `gap-6` to `calc(var(--spacing) * 6)`. They are already expressed in the project's own unit, not
   a second hardcoded scale, and banning them would be dogma with no benefit. Write that reasoning
   into the comment above the touch tokens. The POS touch tokens
   (`--spacing-touch-min` 3.5rem / `--spacing-touch` 4rem / `--spacing-touch-lg` 4.5rem /
   `--spacing-touch-xl` 6rem) stay exactly as they are: they name sizes the multiplier cannot
   express as a *decision*, which is why they earn names.

7. **The elevation ladder is part of the POS's pinned palette, so this task edits the
   `[data-surface="pos"]` block too.** `[data-surface="pos"]` is **light in both themes** and pins the
   COMPLETE palette; **pinning a surface means pinning EVERY token on it, not just the grounds**, and
   elevation is one of those tokens. The reason is concrete rather than doctrinal: the dark rungs
   carry a `rgb(255 255 255 / .04)` top highlight and a heavy `rgb(0 0 0 / .8)` spread, both wrong on
   a white key face, and the alias `--c-shadow` resolves on the element that declares it (step 2), so
   a scope that overrides the rungs but not the alias still paints the page theme's shadow inside the
   till.

   *(Superseded — do not restore. An earlier draft said "the three shadow rungs need no entry
   anywhere… elevation is inherited from the active theme like every other token the scope leaves
   alone." That belonged to a grounds-only scope which no longer exists, and it is the same
   pin-half-the-palette mistake that put dark-theme ink on the white key face at 1.21:1. An earlier
   draft still told you to maintain a `POS_FALLS_THROUGH` map of tokens the scope deliberately does
   not re-declare; the scope now leaves nothing out, so no such map is correct either.)*

   **Do this, discovering rather than assuming:**
   - Open `src/lib/styles/tokens.css` and read the `[data-surface="pos"]` block T-03 wrote.
   - **The expected shape:** T-03 pinned today's single `--c-shadow` at its LIGHT value, because the
     ladder did not exist in Phase 1. **Replace that one line with the three light rungs**,
     byte-identical to the ones step 1 puts in the bare `:root` — T-04's drift guard compares the two
     on whitespace-normalised strings, so "byte-identical" is the safe way to satisfy it.
   - If the block already declares `--c-shadow-flat`, `--c-shadow-raised` and `--c-shadow-floating` at
     the light values (each containing `rgb(255 255 255 / .8)`), change none of them — say so in the
     commit message.
   - Either way, make sure the block ends this task carrying **`--c-shadow: var(--c-shadow-raised);`**
     of its own, beside its existing `--c-ring` and `--c-control-line` alias lines and for the same
     reason: the scope is a `<div>`, not `:root`, so an alias declared above it never recomputes here.
     Add a one-line comment saying so. T-03's own comment above the shadow line predicts this edit;
     read it before you make it.
   - If the block declares no shadow token at all, add all four (three rungs + the alias) and report
     it — T-03 was specified to pin the complete palette, so an absent shadow means Phase 1 landed
     incomplete.

   **Then reconcile T-04's constants, in this same commit.** T-04 declares the list of names the scope
   pins (`POS_PINNED`, split against `POS_GROUNDS`) and asserts the scope declares **exactly** those,
   via an exact `POS_PINNED.length` count whose failure message spells out the composition — on the
   draft this plan was written against, "6 grounds, 3 inks, 3 accent, 6 semantic, 12 status, 2 aliases
   and `--c-shadow`". Read the file for the real names and the real number. Swapping one `--c-shadow`
   for three rungs plus the alias **changes that count**, so the assertion fails until the list and
   the number are updated together — **extend them, do not weaken the assertion.** The list is a
   mirror of the block, not a cap on it; an exact count is what makes the block's contents reviewable,
   and loosening it to `toBeGreaterThanOrEqual` throws the guard away. Update the failure message's
   composition text too, or it describes a block that no longer exists.
   `it('the POS block carries the page LIGHT palette, value for value')` then covers the three new
   rungs automatically — they are non-ground tokens, so it requires them to equal the bare `:root`'s
   light rungs, which is exactly the rule that keeps a dark rung out of the till.

   The `--c-shadow` deletion in step 2 needs nothing added: the existing
   `it('declares every dark-block token in the bare :root as well')` and
   `it('declares the SAME token names in both dark blocks')` discover names rather than hand-listing
   them, so they pick the three rungs up without an edit.
8. Do not reformat the file — it is `.prettierignore`d for the reason given in T-09 step 9.

**Tests:** House guard test (CLAUDE.md "Design & UI"). Text assertions only, for the reason given in
T-09 (node-only Vitest projects; no component can be mounted).

- Extend the existing "must not be repeated in either dark block" loop inside
  `it('declares the dashboard scale tokens T-02 added')` from `['--c-ring', '--c-control-line']` to
  `['--c-ring', '--c-control-line', '--c-shadow']`. Expected: `mediaDark.has('--c-shadow') === false`
  and `stampDark.has('--c-shadow') === false`.
- Add `it('declares the elevation ladder in every palette block, POS included')`: for each of
  `--c-shadow-flat`, `--c-shadow-raised`, `--c-shadow-floating`, assert `bare.has(name)`,
  `mediaDark.has(name)`, `stampDark.has(name)` **and `posScope.has(name)`** are all `true`. Then
  assert the **light** rungs contain `rgb(255 255 255 / .8)` and the **dark** rungs do not — the dark
  highlight is `rgb(255 255 255 / .04)` — and assert the **POS** rungs are the LIGHT ones, byte-equal
  to the bare `:root`'s, because the scope is pinned light in both themes. Add
  `it('the POS scope re-declares the --c-shadow alias')`: `posScope.get('--c-shadow')` is
  `'var(--c-shadow-raised)'`, while `mediaDark.has('--c-shadow')` and `stampDark.has('--c-shadow')`
  are both `false`. The two cases are opposite for a reason worth stating in the test name — a dark
  block shares `:root` with the alias and must NOT re-declare it; a `<div>` scope does not and MUST. The two existing tests
  (`declares every dark-block token in the bare :root as well`, `declares the SAME token names in
  both dark blocks`) then cover the new names automatically.
- Add `it('names the measure tokens so Tailwind cannot shadow them')`: assert the stripped `css`
  contains `--container-measure:` and `--container-form:`, and that it does **not** contain
  `--container-prose`. Failure message: "Tailwind ships a static `max-w-prose` at 65ch that ignores
  the `--container-*` namespace, so a `--container-prose` token compiles to nothing and the utility
  silently keeps Tailwind's value."
- No contrast assertion applies to a shadow: `resolve()` returns `null` for anything that is not a
  hex, and a shadow token is never a member of `TEXT_PAIRS` or `NON_TEXT_PAIRS`.

**Done when:** `nvm use && pnpm test:unit src/lib/styles/tokens.test.ts` passes;
`grep -c -- '--c-shadow-raised:' src/lib/styles/tokens.css` prints **4** (bare `:root`, both dark
blocks, and the pinned-light `[data-surface="pos"]` block);
`grep -c -- '--c-shadow:' src/lib/styles/tokens.css` prints **2** (the bare-`:root` alias and the
POS scope's own copy of it, and no dark block); and `pnpm check && pnpm lint` pass.

(**Keep the trailing colon on the first pattern.** Without it the grep also matches the two alias
lines `--c-shadow: var(--c-shadow-raised);` and the `@theme inline` line
`--shadow-raised: var(--c-shadow-raised);`, so it prints **7** on a correct implementation.)

**Watch out:** The dark palette is declared **twice**, byte-identical, and both copies must change —
edit one and the media-query theme and the explicit-toggle theme render different elevation, which
no screenshot of a single theme will reveal. And do not "simplify" by deleting `--shadow-card`: one
component and two lines of `docs/design-system.md` name it, and no task in this plan repairs section
7b.

**And the POS-specific trap, which is the same class of bug as the one this plan was created to fix.**
`[data-surface="pos"]` is pinned light in both themes; a scope that pins its rungs but not the
`--c-shadow` alias, or its grounds but not its rungs, is half-pinned, and half-pinned is how a
dark-theme viewer ends up with dark-mode elevation — or dark-mode ink at 1.21:1 — on a white key
face. **Pinning a surface means pinning EVERY token on it, not just the grounds.** Three rungs plus
the alias, or the block is not finished.

---

### T-11 — Guard that Tailwind's default scales cannot stand in for a matcami token

**Needs:** T-09 (the six type roles the migration below swaps onto), T-10 (`--container-form`, the
token the `max-w-*` call sites swap onto)
**Files:**
- `src/lib/styles/tokens.test.ts` — EDIT (a new `describe()` beside the existing
  `describe('no arbitrary value escapes the token file')` near line 281, reusing the module-level
  `svelteFiles` produced by `findSvelte(SRC)` near line 305; plus one added import)
- `src/routes/+page.svelte` — EDIT (the `<h1>` near line 22)
- `src/lib/components/ui/PageHeader.svelte` — EDIT (the heading near line 29, the description `<p>`
  near line 36)
- `src/lib/components/ui/Button.svelte` — EDIT (the `base` class constant near line 36, the
  disabled-reason `<span>` near line 78)
- `src/lib/components/ui/Field.svelte` — EDIT (label near line 71, hint near line 95, error near
  line 106)
- `src/lib/components/ui/Alert.svelte` — EDIT (the `classes` `$derived` near line 39)
- `src/lib/components/ui/ThemeToggle.svelte` — EDIT (the three button class templates near lines
  101, 109, 117)
- `src/lib/components/ui/Card.svelte` — EDIT (the HTML comment near line 19 only — no class change)
- `src/routes/(dashboard)/+layout.svelte` — EDIT (lines near 43, 50, 58, 88, 101, 104)
- `src/routes/(dashboard)/dashboard/+page.svelte` — EDIT (lines near 82, 85, 88, 92)
- `src/routes/(dashboard)/settings/+page.svelte` — EDIT (the `<Card>` near line 42)
- `src/routes/login/+page.svelte` — EDIT (the `<Card>` near line 20)
- `src/routes/register/+page.svelte` — EDIT (the `<Card>` near line 31)

> **Sizing note — this task is over the usual four-file ceiling on purpose.** The guard and the
> migration cannot be separate commits: a guard committed before the migration is 17 red
> assertions, and a migration committed without the guard is undefended. Every one of the eleven
> component edits is a single class-string swap from the table in step 1; none changes markup, text,
> element names, roles or attributes.

**Spec:** none — `docs/spec.md` is silent on UI. Authority: CLAUDE.md "Design & UI" ("Tokens live in
`src/lib/styles/tokens.css` … the ONLY place a colour, size or type value is defined"). The
guard-test shape follows `src/lib/server/db/schema-guards/schema.test.ts`, whose rule is that what
you guard is **discovered**, never hand-listed, because "a hand-maintained list is a list someone
forgets to update, which is exactly the failure these tests exist to prevent".
**Invariants:** 1 (money is integer minor units, and the UI never formats or does arithmetic on it —
`src/lib/server/money/` holds a README and no formatter, so nothing in this migration may introduce
a `.toFixed`, a `/ 100` or an `Intl.NumberFormat`), 5 (the POS surface must keep working with no
network — the scan covers every `.svelte` file under `src/`, the `(pos)` shell included, and a
violation there is fixed with a token, never with a fetch)

**Do:**

1. **Migrate every call site first**, so the guard lands green. This table is exhaustive — it is the
   complete set of default-scale utilities in the tree. Line numbers are as of the base branch;
   match on the class string, which is unambiguous even if a line has moved.

   | File | ~Line | Replace | With |
   |---|---|---|---|
   | `src/routes/+page.svelte` | 22 | `font-display text-3xl font-bold` | `font-display text-display` |
   | `src/lib/components/ui/PageHeader.svelte` | 29 | `font-display text-xl font-bold` | `font-display text-title` |
   | `src/lib/components/ui/PageHeader.svelte` | 36 | `text-ink-2 mt-1 text-sm` | `text-ink-2 mt-1 text-body` |
   | `src/routes/(dashboard)/+layout.svelte` | 43 | `font-display text-lg font-bold` | `font-display text-section` |
   | `src/routes/(dashboard)/+layout.svelte` | 50 | `text-ink-2 text-sm` | `text-ink-2 text-body` |
   | `src/routes/(dashboard)/+layout.svelte` | 58 | `… px-3 py-1 text-sm` | `… px-3 py-1 text-body` |
   | `src/routes/(dashboard)/+layout.svelte` | 88 | `… px-3 py-2 text-sm` | `… px-3 py-2 text-body` |
   | `src/routes/(dashboard)/+layout.svelte` | 101 | `… px-3 py-2 text-sm` | `… px-3 py-2 text-body` |
   | `src/routes/(dashboard)/+layout.svelte` | 104 | `text-ink-3 text-xs` | `text-ink-3 text-caption` |
   | `src/routes/(dashboard)/dashboard/+page.svelte` | 82 | `text-ink text-sm font-medium` | `text-ink text-body font-medium` |
   | `src/routes/(dashboard)/dashboard/+page.svelte` | 85 | `text-ink-3 ml-2 text-xs font-normal` | `text-ink-3 ml-2 text-caption` |
   | `src/routes/(dashboard)/dashboard/+page.svelte` | 88 | `text-ink-2 mt-0.5 text-sm` | `text-ink-2 mt-0.5 text-body` |
   | `src/routes/(dashboard)/dashboard/+page.svelte` | 92 | `text-accent mt-1 inline-block text-sm underline` | `text-accent mt-1 inline-block text-body underline` |
   | `src/lib/components/ui/Button.svelte` | 36 | `rounded-control px-3 py-2 text-sm font-medium disabled:opacity-60` | `rounded-control px-3 py-2 text-body font-medium disabled:opacity-60` |
   | `src/lib/components/ui/Button.svelte` | 78 | `text-ink-2 text-xs` | `text-ink-2 text-caption` |
   | `src/lib/components/ui/Field.svelte` | 71 | `text-ink-2 text-sm font-medium` | `text-ink-2 text-body font-medium` |
   | `src/lib/components/ui/Field.svelte` | 95 | `text-ink-3 text-xs` | `text-ink-3 text-caption` |
   | `src/lib/components/ui/Field.svelte` | 106 | `text-danger text-sm` | `text-danger text-body` |
   | `src/lib/components/ui/Alert.svelte` | 39 | `'rounded-control border px-3 py-2 text-sm '` | `'rounded-control border px-3 py-2 text-body '` |
   | `src/lib/components/ui/ThemeToggle.svelte` | 101, 109, 117 | `rounded-control border px-2 py-1 text-xs` (three identical templates) | `rounded-control border px-2 py-1 text-caption` |
   | `src/routes/(dashboard)/settings/+page.svelte` | 42 | `mt-4 max-w-lg` | `mt-4 max-w-form` |
   | `src/routes/register/+page.svelte` | 31 | `w-full max-w-lg` | `w-full max-w-form` |
   | `src/routes/login/+page.svelte` | 20 | `w-full max-w-sm` | `w-full max-w-form` |
   | `src/lib/components/ui/Card.svelte` | 19 | the HTML comment's example `(max-w-sm, mt-4)` | `(max-w-form, mt-4)` |

2. **Weight utilities — keep or drop, deliberately.** Drop `font-bold` at the three heading sites
   (`+page.svelte:22`, `PageHeader.svelte:29`, `(dashboard)/+layout.svelte:43`) and `font-normal` at
   `dashboard/+page.svelte:85`: the role now carries the weight, and a leftover weight utility
   quietly overrides the role. **Keep** `font-medium` at `Button.svelte:36`, `Field.svelte:71` and
   `dashboard/+page.svelte:82` — those are deliberate 500 overrides of the body role's 400, and they
   win regardless of class order because Tailwind compiles the role's weight as
   `font-weight: var(--tw-font-weight, var(--text-body--font-weight))` and `.font-medium` sets
   `--tw-font-weight`.

3. **Record the intended visual changes in the commit message**, because a reviewer seeing only
   class swaps will assume there are none: the landing `<h1>` goes from a fixed 30px to
   clamp(30→46px); the page title from 20px/700 to clamp(21→27px)/600; the dashboard app-bar
   restaurant-name heading from 18px/700 to 16px/600 (it is an app-bar wordmark, not the page title
   — `PageHeader` owns that); body copy 14px → 15px; captions 12px → 13px; and the sign-in card
   24rem → 32rem, now the same width as the registration and settings cards.

4. **The e2e specs are frozen.** Do not open `e2e/auth.spec.ts` or `e2e/smoke.spec.ts` in this task
   at all — not to adjust, not to "keep in sync". Every edit above is inside a `class` attribute or
   a class-string constant; no text node, element name, `role`, `aria-*`, `for`/`id`, label text or
   accessible name changes. In particular `dashboard/+page.svelte:85` keeps the exact text
   `not started` (asserted as `getByText('not started', { exact: true }).toHaveCount(5)`), and
   `(dashboard)/+layout.svelte:43` stays an `<h1>` carrying the restaurant name (asserted through
   `getByRole('heading', …)` twice). If a Playwright assertion fails after this task, the
   restyling broke the accessible surface — fix the component, never the spec.

5. Add the import the guard needs at the top of `src/lib/styles/tokens.test.ts`, beside the existing
   `node:fs` / `node:path` / `node:url` imports:

   ```ts
   import { createRequire } from 'node:module';
   ```

6. Add the new `describe` block after `describe('no arbitrary value escapes the token file')`. It
   **discovers both sides** — the files to scan and the names to ban — and then asserts each
   discovery, so an empty glob or a broken parse fails loudly instead of passing green:

   ```ts
   /* ── Tailwind's default scales must not stand in for a matcami token ────── */

   // Tailwind v4.3.3 SHIPS its own --text-*, --radius-*, --shadow-* and --container-*
   // defaults in node_modules/tailwindcss/theme.css. So `text-3xl` and `rounded-lg`
   // resolve to Tailwind's values, not to matcami's — a second source of size and type
   // truth, in a project whose rule is that tokens.css is the ONLY place a size or type
   // value is defined. Nothing else in this repository detects that.
   //
   // The ban list is DISCOVERED from the installed package, never hand-written: a
   // hand-maintained list is a list someone forgets to update when Tailwind adds a key
   // (src/lib/server/db/schema-guards/schema.test.ts, same reasoning).
   const THEME_CSS = createRequire(import.meta.url).resolve('tailwindcss/theme.css');
   const themeCss = readFileSync(THEME_CSS, 'utf8');

   function defaultKeys(namespace: string): string[] {
     const re = new RegExp(`^\\s*--${namespace}-([a-z0-9-]+)\\s*:`, 'gm');
     return [...new Set([...themeCss.matchAll(re)].map((m) => m[1]))]
       // `--text-sm--line-height` is a MODIFIER of --text-sm, not a scale key.
       .filter((k) => !k.includes('--'));
   }

   const BANNED = [
     // --text-shadow-* lives in the --text- prefix but drives text-shadow-*, which is
     // a legitimate utility and not a font size.
     ...defaultKeys('text').filter((k) => !k.startsWith('shadow-')).map((k) => `text-${k}`),
     ...defaultKeys('radius').map((k) => `rounded-${k}`),
     ...defaultKeys('shadow').map((k) => `shadow-${k}`),
     ...defaultKeys('container').flatMap((k) => [`max-w-${k}`, `min-w-${k}`, `w-${k}`]),
     // Bare `rounded` compiles to a literal 0.25rem and bare `shadow` to a literal
     // 0 1px 3px …; neither reads a theme key, so both are raw values with a friendly
     // name. `rounded-full` and `rounded-none` are NOT banned — a pill and a square
     // corner are shape decisions, not steps on a radius scale.
     'rounded',
     'shadow'
   ].filter((u) => !ALLOWED.has(u));
   ```

7. Declare `ALLOWED` **above** `BANNED`, seeded **empty**, carrying the rule:

   ```ts
   // Exempt utilities, each with its reason. Seeded EMPTY: once the call sites are
   // migrated, nothing in the tree needs an exemption. The map exists so the next
   // exemption is a visible, reasoned diff — following the schema-guards precedent,
   // where adding an entry "IS A PLAN'S DECISION, NEVER A CONVENIENCE". Never add an
   // entry to turn a red assertion green: the fix is a token in tokens.css, or the
   // right role on the element.
   const ALLOWED = new Map<string, string>();
   ```

8. Write the two tests inside that `describe`:

   ```ts
   it('found .svelte files and Tailwind default scales to check at all', () => {
     expect(svelteFiles.length).toBeGreaterThan(0);
     expect(BANNED.length).toBeGreaterThan(40);
     for (const u of ['text-sm', 'text-3xl', 'rounded-lg', 'shadow-md', 'max-w-lg'])
       expect(BANNED, `${u} should be banned`).toContain(u);
     for (const u of ['text-body', 'text-total', 'rounded-card', 'max-w-page', 'max-w-form'])
       expect(BANNED, `${u} is a matcami token and must NOT be banned`).not.toContain(u);
   });
   ```

   The second test is one `it.each` over `svelteFiles` (same shape as the existing arbitrary-value
   scan): strip comments, then flag any banned utility present as a whole class token.

   ```ts
   // Strip <!-- --> and /* */ before scanning: a class named inside a comment is dead
   // text, and Card.svelte's comment cites an example class. Do NOT strip `//` line
   // comments — that would swallow the rest of a line containing https:// and hide a
   // real violation.
   const stripMarkupComments = (s: string) =>
     s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
   ```

   Match each banned name with `new RegExp(`(?<![\\w-])${u}(?![\\w-])`)`. The lookbehind stops
   `w-sm` matching inside `max-w-sm`; the lookahead stops `rounded` matching inside
   `rounded-control` and `text-xs` matching inside a longer word. Both still allow a variant prefix,
   because `:` is neither `\w` nor `-`, so `md:text-sm` and `hover:shadow-lg` are caught.

   The failure message must name the repair: "`<file>` uses `<utility>`, which resolves to
   Tailwind's default scale in node_modules, not to a matcami token. Use a semantic role from
   `src/lib/styles/tokens.css` (`text-display`, `text-title`, `text-section`, `text-body`,
   `text-caption`, `text-eyebrow`; `rounded-card`, `rounded-control`; `shadow-flat`,
   `shadow-raised`, `shadow-floating`; `max-w-page`, `max-w-measure`, `max-w-form`) or add a token —
   never add to ALLOWED."

9. Do **not** ban spacing utilities. Tailwind v4 derives every one of them from the single
   `--spacing: 0.25rem` multiplier, so `p-4` and `gap-6` are computed from the project's own unit
   rather than being a second hardcoded scale. Put that sentence in the `describe`'s comment so a
   later session does not "complete" the guard by adding them.

**Tests:** House guard test (CLAUDE.md "Design & UI"). Node-side text scanning only — no `.svelte`
file can be mounted (`vitest.config.ts` has two `environment: 'node'` projects, no jsdom, no browser
mode, no Svelte plugin), so the guard reads component source as text.

- `it('found .svelte files and Tailwind default scales to check at all')` — expected on the base
  branch: **15** `.svelte` files discovered, and **70** banned names (13 `text-*`, 8 `rounded-*`,
  8 `shadow-*`, 13 × 3 `max-w-*`/`min-w-*`/`w-*`, plus bare `rounded` and `shadow`). Assert lower
  bounds, not equality, so a Tailwind patch release that adds a key does not fail the *discovery*.
- `it.each(svelteFiles)('%s uses matcami tokens, not Tailwind default scales')` — expected **zero**
  violations across all 15 files once step 1's table is applied. Before the migration the same scan
  reports 17 file/utility pairs across 11 files; that is the number this task drives to zero.
- Verify the exemption path is unused: `expect(ALLOWED.size).toBe(0)` is *not* asserted (a future
  plan may legitimately add one), but every entry must carry a non-empty reason string —
  `for (const [u, why] of ALLOWED) expect(why.length, `${u} needs a reason`).toBeGreaterThan(0);`

**Done when:**
- `nvm use && pnpm test:unit src/lib/styles/tokens.test.ts` passes with the new describe reporting
  zero violations.
- `pnpm check && pnpm lint` pass.
- `pnpm test:e2e` passes with **no diff at all** under `e2e/` (`git diff --stat e2e/` prints
  nothing).
- After `pnpm build`, the emitted CSS carries the real rule:
  `grep -ho '\.text-body{[^}]*}' $(find build -name '*.css')` prints a rule containing `font-size`,
  `line-height`, `letter-spacing` **and** `font-weight`. Before this task that grep printed nothing,
  because Tailwind tree-shakes a theme key no component uses.

**Watch out:** Four traps, all of them silent.
1. The guard scans file **text**, so a banned class inside a comment trips it — which is exactly
   what `src/lib/components/ui/Card.svelte` line 19 does today by citing `max-w-sm` as an example.
   That is why comments are stripped *and* why step 1 fixes the comment; do neither and the run is
   red for a reason that has nothing to do with rendered CSS.
2. `createRequire(import.meta.url).resolve('tailwindcss/theme.css')` goes through the package's
   `exports` map and is the supported path. Do not hardcode `node_modules/tailwindcss/theme.css`
   relative to the test file — it breaks under a different install layout and gives no error worth
   reading.
3. Do not resolve a red assertion by adding to `ALLOWED`. The fix is the right semantic role on the
   element, or a new token in `src/lib/styles/tokens.css` — an exemption is a plan's decision.
4. `src/lib/server/money/` contains a README and no formatter. While editing eleven components,
   nothing here may render an amount: money is integer minor units, formatted only by the money
   module, and a `.toFixed()`, a `/ 100` or an `Intl.NumberFormat` in a component is the bug that
   makes the receipt disagree with the books.
