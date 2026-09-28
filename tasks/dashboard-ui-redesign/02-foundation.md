# Phase 2 — Typefaces and the element base layer

This phase makes the three typefaces the design system has always named actually reach the browser,
proves it with a test that cannot pass in the broken state, and adds the element base layer — page
ground, heading face, visible focus ring, reduced-motion handling, control defaults — so the screens
in Phase 4 stop re-declaring the basics by hand.

**Depends on:** Phase 1 — **T-06 only**, which uses the `--c-ring` token T-02 adds **and** extends
the `src/lib/styles/tokens.test.ts` file T-03 creates, so it needs **both T-02 and T-03**. **T-04
and T-05 depend on nothing in Phase 1** and may run first, or in parallel with T-01..T-03 — but
**T-05 still needs T-04**, because it reads the packages T-04 installs.

**Read `00-overview.md` in this directory first.** It carries the goal, the requirements as agreed
with the user, the assumptions this plan rides on, the workspace state at plan time, the complete
task index, and the NEW / EXTEND / EDIT tag convention every `Files:` list below uses.

---

### T-04 — Self-host Archivo, IBM Plex Sans and IBM Plex Mono

**Needs:** -
**Files:**
- `package.json` — EDIT (the `devDependencies` object)
- `src/routes/+layout.svelte` — EDIT (the `<script lang="ts">` block, beside the existing
  `import '../app.css';`)
- `src/lib/styles/tokens.css` — EDIT (the `--font-display` and `--font-sans` declarations in the
  plain static `@theme` block, around lines 139-140)

**Spec:** none directly — `docs/spec.md` does not govern typography or visual design; it says nothing
about fonts, brand or colour. Spec 7 (the owner signs in with email and password and enters the
management dashboard) names the only surface these faces render on. Typography is governed by
`CLAUDE.md`'s "Design & UI" section and by `docs/design-system.md`.

**Invariants:** none directly — this task engages the invariants by **avoidance**, and that is the
honest answer. 8 (permissions are enforced server-side on every route, reads included): it adds no
route, no `+server.ts` and no form action, so there is nothing to guard. 12 (session cookies are
HttpOnly + Secure + SameSite and never `localStorage`): it stores nothing and reads no cookie. The
rules it does engage are `CLAUDE.md`'s "Design & UI" section — `src/lib/styles/tokens.css` is the
ONLY place a colour, size or type value is defined, and money renders in `--font-mono` with
`tabular-nums`, which is why Mono must ship even though nothing renders money yet.

**Background a fresh session must have.** `src/lib/styles/tokens.css` has always named Archivo, IBM
Plex Sans and IBM Plex Mono, but **no font has ever been loaded** — there is no `@font-face`, no font
package, no `<link>`, and `static/` holds only `robots.txt`. Every page has been rendering in the
`system-ui` fallback for the life of the project, and every check stayed green. This task fixes that.

**Do:**
1. Run `nvm use` before any `pnpm` command in this task. Node is pinned to **24.21.0** in `.nvmrc`
   and `engines` refuses anything else.
2. Add these three entries to the `devDependencies` object in `package.json`, pinned **EXACTLY** —
   no `^` and no `~`, because every dependency in this repository is pinned exactly:
   ```json
   "@fontsource-variable/archivo": "5.3.0",
   "@fontsource-variable/ibm-plex-sans": "5.3.0",
   "@fontsource/ibm-plex-mono": "5.3.0",
   ```
   They belong in `devDependencies`, not `dependencies`: Vite bundles them into the client assets at
   build time, and nothing imports them at runtime on the server.
3. Note the asymmetry and do not "fix" it: there is **NO `@fontsource-variable/ibm-plex-mono`**. IBM
   Plex Mono has no official variable font, and asking for that package fails with a 404. Mono comes
   from the static package `@fontsource/ibm-plex-mono`; Archivo and IBM Plex Sans come from variable
   packages.
4. Run `pnpm install`.
5. In `src/routes/+layout.svelte`, inside the existing `<script lang="ts">` block, beside the
   existing `import '../app.css';`, add exactly these four lines:
   ```ts
   import '@fontsource-variable/archivo/wght.css';
   import '@fontsource-variable/ibm-plex-sans/wght.css';
   import '@fontsource/ibm-plex-mono/400.css';
   import '@fontsource/ibm-plex-mono/500.css';
   ```
   Keep the existing comment that explains why `app.css` is imported here
   (`// Imported once here so the stylesheet loads for every route.`) — edit around it, do not delete
   it. `wght.css` is the **weight axis only**; the variable packages also ship a width axis
   (`wdth.css`) the design system never asks for. Each of these CSS files declares one `@font-face`
   per unicode subset with a `unicode-range`, so a browser downloads only the subsets a page actually
   uses — importing the un-prefixed file does not ship Cyrillic to a Latin page.
6. **This is the step that makes the difference between working and silently not working.** The
   variable packages do not declare the plain family names: `@fontsource-variable/archivo` declares
   `font-family: 'Archivo Variable'` and `@fontsource-variable/ibm-plex-sans` declares
   `font-family: 'IBM Plex Sans Variable'`. A browser matches `@font-face` by the declared family
   string, so the token stacks as they stand would not match, the faces would go unused, and every
   page would keep rendering in `system-ui` — with `pnpm check`, `pnpm lint`, `pnpm test` and both
   e2e specs still green. In `src/lib/styles/tokens.css`, edit the two stacks so the declared name
   comes first and the plain name stays as the next fallback:
   ```css
   --font-display: "Archivo Variable", Archivo, system-ui, -apple-system, sans-serif;
   --font-sans:    "IBM Plex Sans Variable", "IBM Plex Sans", system-ui, -apple-system, sans-serif;
   ```
   These are font stacks, not colours — `00-overview.md`'s rule that no task may change a colour
   VALUE in `tokens.css` governs colour and does not forbid this edit.
7. Leave `--font-mono` exactly as it is:
   ```css
   --font-mono:    "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
   ```
   `@fontsource/ibm-plex-mono` declares `font-family: 'IBM Plex Mono'`, which this stack already
   names.
8. Note for later work in this plan, and leave it as a note — nothing here acts on it:
   `IBM Plex Sans Variable` covers weights **100-700**, so `font-bold` (700) resolves to a real face
   while `font-black` (900) would be synthesised. `Archivo Variable` covers the full **100-900**.

**Tests:** T-05 writes the test that proves this delivery, and **this task is not finished without
it** — the failure mode here (packages installed, imports present, family names mismatched, every
page still `system-ui`) is invisible to every check that exists today. This is **not** one of spec
29's six mandatory areas — those are money arithmetic and rounding, tax in both modes, journal
entries balancing, one posting rule per spec 24 business event, offline sync retries never
duplicating, and a permission check per POS API route. Do **not** label it MANDATORY.

**Done when:**
- `pnpm install` succeeds.
- `pnpm build` succeeds.
- `pnpm check && pnpm lint` both exit 0.
- After that build, `ls build/client/_app/immutable/assets/ | grep -ci woff2` returns a **non-zero**
  count, proving the font files were actually emitted into the bundle.
- `pnpm dev` opened in a browser shows headings in Archivo rather than the system face.

**Watch out:**
- Importing the fonts in `src/app.css` with `@import '@fontsource-variable/archivo/wght.css';` is the
  alternative many guides show, and it is **NOT** what this task asks for. Importing from the root
  layout's `<script>` block keeps resolution in Vite's ordinary JavaScript path.
- Do **not** add a `<link>` to `fonts.googleapis.com`. The user rejected it explicitly: a third-party
  origin in a till's critical path fails when there is no network.
- `src/lib/styles/tokens.css` is listed in `.prettierignore` (it is hand-laid-out in aligned columns
  that Prettier explodes). Preserve the existing column alignment by hand when editing those lines —
  the formatter will neither fix it nor complain about it.

---

### T-05 — Prove the typefaces actually ship

**Needs:** T-04
**Files:**
- `src/lib/styles/fonts.test.ts` — NEW

**Spec:** none directly — `docs/spec.md` does not govern typography. Spec 29 (the tests that are
mandatory) is cited only to record that this test is **not** one of its six areas; see **Tests:**.

**Invariants:** none directly — engaged by avoidance, as in T-04: 8 (server-side permission checks on
every route) has nothing to check because no route is added, and 12 (session cookies HttpOnly +
Secure + SameSite, never `localStorage`) is untouched. What this test enforces is `CLAUDE.md`'s
"Design & UI" rule that `src/lib/styles/tokens.css` is the ONLY place a type value is defined — and
that a page actually renders in the face its token names.

**Why this test is shaped this way.** A test that merely greps for the presence of an import line
would **PASS in the exact broken state this plan exists to fix**: packages installed, imports
present, family names mismatched, every page still in `system-ui`. So the test must compare the
family names the **installed packages actually declare** against the `--font-*` tokens.

**Do:**
1. Create `src/lib/styles/fonts.test.ts`. It joins the existing `unit` Vitest project automatically —
   `vitest.config.ts` defines that project with `environment: 'node'`, `include: ['src/**/*.test.ts']`
   and an exclude for `*.integration.test.ts` only. Do **not** add jsdom, `@testing-library/svelte` or
   Vitest browser mode; this plan adds no test dependency.
2. Resolve the repository root from the test file and read everything with `node:fs`, the way
   `src/routes/route-guards.test.ts` already does, so the unit project needs no `$lib` alias.
   `src/lib/styles/` is three levels below the root:
   ```ts
   const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
   ```
3. Read and parse `package.json`. Assert all three font packages are present in `devDependencies`
   (`@fontsource-variable/archivo`, `@fontsource-variable/ibm-plex-sans`, `@fontsource/ibm-plex-mono`)
   and that each version string is pinned exactly — it must match `/^\d+\.\d+\.\d+$/`, with no `^` and
   no `~`.
4. Read `src/routes/+layout.svelte` as text and assert it imports each of the four CSS entry points
   T-04 added: `@fontsource-variable/archivo/wght.css`,
   `@fontsource-variable/ibm-plex-sans/wght.css`, `@fontsource/ibm-plex-mono/400.css` and
   `@fontsource/ibm-plex-mono/500.css`.
5. For each installed package, read its CSS entry point out of `node_modules` —
   `node_modules/@fontsource-variable/archivo/wght.css`,
   `node_modules/@fontsource-variable/ibm-plex-sans/wght.css`,
   `node_modules/@fontsource/ibm-plex-mono/400.css` — extract every `font-family: '…'` declaration
   from it, and assert the declared name appears inside the corresponding `--font-*` stack in
   `src/lib/styles/tokens.css`:

   | Package entry point read | Declared family today | Must appear in |
   |---|---|---|
   | `@fontsource-variable/archivo/wght.css` | `Archivo Variable` | `--font-display` |
   | `@fontsource-variable/ibm-plex-sans/wght.css` | `IBM Plex Sans Variable` | `--font-sans` |
   | `@fontsource/ibm-plex-mono/400.css` | `IBM Plex Mono` | `--font-mono` |

   **This is the assertion that catches the silent failure.** Extract the declared name from the
   package rather than hardcoding the three strings, so a future package release that renames a
   family fails the test instead of passing it.
6. Extract each token stack from `src/lib/styles/tokens.css` by finding the declaration that starts
   with `--font-display:` / `--font-sans:` / `--font-mono:` and taking it up to the `;`. Compare
   ignoring the surrounding quote style — the package writes `'Archivo Variable'` and the token
   writes `"Archivo Variable"`.
7. Assert each `--font-*` stack still **ends in a generic family**: `--font-display` and `--font-sans`
   end in `sans-serif`, `--font-mono` ends in `monospace`. A failed download must degrade to
   something readable.
8. Guard every `node_modules` read with `existsSync` first and fail with a clear message naming the
   package and telling the reader to run `pnpm install` — not an opaque `ENOENT` from `readFileSync`.

**Tests:** this task **is** the test. It is **not** one of spec 29's six mandatory areas — those are
money arithmetic and rounding, tax in both modes, journal entries balancing, one posting rule per
spec 24 business event, offline sync retries never duplicating, and a permission check per POS API
route. Do **not** label it MANDATORY. Named cases and expected results:
- `@fontsource-variable/archivo` present in `devDependencies` as `5.3.0` → passes; as `^5.3.0` →
  fails on the exact-pin assertion.
- `wght.css` of `@fontsource-variable/archivo` declares `Archivo Variable` → that string is found
  inside the `--font-display` stack.
- `src/routes/+layout.svelte` imports all four entry points → passes; remove one → fails naming it.
- `--font-mono` ends in `monospace` → passes.

**Done when:** `pnpm test:unit` passes; and editing `--font-display` in `src/lib/styles/tokens.css`
to remove `"Archivo Variable"` makes it fail (restore the token afterwards).

**Watch out:**
- Reading `node_modules` from a test is deliberate here, and it is safe because all three versions
  are pinned exactly. If a package is missing, the test must fail with a clear message telling the
  reader to run `pnpm install`, not throw an opaque `ENOENT`.
- Assert on the **declared family names**, never on the `.woff2` file list or its count — those
  change between fontsource releases and would make the test brittle for no gain.
- `.prettierignore` names `src/lib/styles/tokens.css` specifically, not the whole folder, so this new
  test file **is** formatted. Run `pnpm format` (tabs, single quotes — see `.prettierrc`) or
  `pnpm lint` fails on `prettier --check .`.

---

### T-06 — Add the element base layer

**Needs:** T-02 (the `--c-ring` token), T-03 (creates `src/lib/styles/tokens.test.ts`, which this
task extends), T-04 (the fonts it sets the defaults for)
**Files:**
- `src/lib/styles/base.css` — NEW
- `src/app.css` — EDIT (add one `@import` after the existing `@import './lib/styles/tokens.css';`)
- `src/lib/styles/tokens.test.ts` — EXTEND (created by T-03; add two assertions beside the existing
  token assertions. Do not rewrite the file)

**Spec:** none directly — `docs/spec.md` does not govern visual design, focus styling or motion
preferences. Spec 7 (the owner signs in with email and password and enters the management dashboard)
names the surface these defaults apply to. The governing documents are `CLAUDE.md`'s "Design & UI"
section and `docs/design-system.md`.

**Invariants:** none directly — engaged by avoidance: 8 (permissions are enforced server-side on
every route, reads included) — no route, `+server.ts` or form action is added here; 12 (session
cookies are HttpOnly + Secure + SameSite and never `localStorage`) — nothing is stored or read. The
rules this task engages are `CLAUDE.md`'s "Design & UI" section: `tokens.css` is the ONLY place a
colour, size or type value is defined, and **light is the default** with the bare `:root` holding the
complete light palette — so every COLOUR and every FONT value in this file must be a `var(--…)`
reference, never a literal, or it would freeze one theme into a layer that applies to both. That rule
binds colour and type only: the `2px` outline width and offset in step 5 and the `0.01ms`, `1` and
`auto` values in step 6 are literals on purpose, because they are neither colour nor type and no
token defines them. See step 9.

**Background a fresh session must have.** Open `src/app.css` before editing: at plan time it was
three lines — `@import 'tailwindcss';` then `@import './lib/styles/tokens.css';`. If the tokens
import is absent, stop and report rather than guessing the order. There is no `@layer base`, no
element-level styling, no focus styling, no reduced-motion handling and no `text-wrap` rule anywhere
in `src/`; every page re-declares `bg-bg text-ink` by hand today.

**Do:**
1. Create `src/lib/styles/base.css` containing a **single** `@layer base { … }` block. Everything
   below goes inside that one block.
2. Import it from `src/app.css` **after** the tokens import, so the tokens it references are already
   defined. The file becomes exactly:
   ```css
   @import 'tailwindcss';

   @import './lib/styles/tokens.css';
   @import './lib/styles/base.css';
   ```
3. `body` gets `background-color: var(--c-bg);` and `color: var(--c-ink);`, so the page ground is set
   once rather than per route.
4. `h1, h2, h3, h4` get `text-wrap: balance;` and `font-family: var(--font-display);`. Paragraphs
   (`p`) get `text-wrap: pretty;`.
5. `:focus-visible` gets `outline: 2px solid var(--c-ring);` and `outline-offset: 2px;`. Do **not**
   suppress a focus outline anywhere in this file or any other — no `outline: none`. `--c-ring` is
   added by T-02; if it is not declared in `src/lib/styles/tokens.css`, stop and report rather than
   inventing it or substituting `--c-accent`.
6. Add a `@media (prefers-reduced-motion: reduce)` block that sets, on `*, *::before, *::after`:
   ```css
   animation-duration: 0.01ms !important;
   animation-iteration-count: 1 !important;
   transition-duration: 0.01ms !important;
   scroll-behavior: auto !important;
   ```
7. Form controls — `input, select, textarea, button` — inherit `font-family` and `font-size`
   (`font-family: inherit; font-size: inherit;`), so a control does not silently fall back to the
   browser's own face.
8. `::selection` uses `background-color: var(--c-accent-soft);` and `color: var(--c-ink);`.
9. Every COLOUR and every FONT value in this file must come from a token — `var(--c-…)` or
   `var(--font-…)`. A raw hex here is the same bug it would be in a component. The `2px` outline
   width and offset in step 5 and the `0.01ms`, `1` and `auto` values in step 6 are the only
   literals this file may contain; they are not colour or type values and there is no token for
   them.
10. Do **not** touch `docs/design-system.md`. Section 9 claims `prefers-reduced-motion` "is honoured
    (already in `tokens.css`)" and section 4 claims headings get `text-wrap: balance`; steps 4 and 6
    make those claims incidentally true, but rewording or repairing sections 4, 5 or 9 of that
    document is explicitly out of scope for this plan (`00-overview.md`, Assumptions 5). If the text
    still reads wrong afterwards, that is expected — report it, do not fix it.

**Tests:** none of its own. T-03's arbitrary-value scan covers `.svelte` files and this is a `.css`
file, so instead add assertions to `src/lib/styles/tokens.test.ts` (created by T-03 — add to it, do
not rewrite it): that `src/lib/styles/base.css` contains **no six-digit hex literal** (a
`/#[0-9a-fA-F]{6}\b/` match is a failure), and that `src/app.css` imports `./lib/styles/base.css`
**after** `./lib/styles/tokens.css` (compare the two indices — base must be the later one). This is
**not** one of spec 29's six mandatory areas — money arithmetic and rounding, tax in both modes,
journal entries balancing, one posting rule per spec 24 business event, offline sync retries never
duplicating, and a permission check per POS API route. Do **not** label it MANDATORY.

**Done when:**
- `pnpm check && pnpm lint` both exit 0.
- `pnpm build` succeeds.
- `pnpm test:unit` passes, including the two assertions added to `src/lib/styles/tokens.test.ts`.
- Tabbing through `/login` in a browser shows a visible ring on every focusable control.
- The `body` background comes from the base layer — removing a page's `bg-bg` class leaves the page
  ground unchanged, and the per-page `bg-bg` classes still present are harmless.

**Watch out:**
- Tailwind v4 processes `@layer base` through its own layer machinery. Put the declarations **inside**
  `@layer base { … }` rather than writing bare element selectors, or Tailwind's preflight and its
  utilities may win or lose against them unpredictably.
- Setting `background-color` on `html` instead of `body` interacts differently with overscroll. Use
  `body`.
- `.prettierignore` names `src/lib/styles/tokens.css` specifically, not the folder, so
  `src/lib/styles/base.css` **is** formatted by Prettier. Run `pnpm format` (tabs — `.prettierrc` sets
  `useTabs: true`) or `pnpm lint` fails on `prettier --check .`.
