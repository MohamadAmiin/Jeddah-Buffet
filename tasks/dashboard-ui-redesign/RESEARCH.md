# Research — dashboard UI redesign

Findings are evidence, not decisions. Every entry records where it came from and when it was checked.
Nothing here silently overrides `docs/spec.md` or `CLAUDE.md`.

---

## Q: Which `@fontsource` packages exist for Archivo, IBM Plex Sans and IBM Plex Mono, at what versions?

- **Source:** the npm registry, queried with `npm view <package> version` — accessed 2026-09-14.
- **Says:**

  | Package | Version | Exists? |
  |---|---|---|
  | `@fontsource-variable/archivo` | `5.3.0` | yes |
  | `@fontsource-variable/ibm-plex-sans` | `5.3.0` | yes |
  | `@fontsource-variable/ibm-plex-mono` | — | **NO — the package does not exist** |
  | `@fontsource/ibm-plex-mono` | `5.3.0` | yes (static weights) |
  | `@fontsource/archivo` | `5.3.0` | yes (static weights) |
  | `@fontsource/ibm-plex-sans` | `5.3.0` | yes (static weights) |

- **Affects the plan:** T-04 installs **two variable packages and one static package**. IBM Plex Mono
  has no official variable font, so `@fontsource-variable/ibm-plex-mono` cannot be installed — a task
  that asks for it fails at `pnpm add` with 404. All three are pinned exactly, with no `^` or `~`, as
  every other dependency in `package.json` is.

---

## Q: What CSS entry points do those packages actually expose?

- **Source:** the published tarballs themselves, listed with
  `curl -sfL "$(npm view <pkg> dist.tarball)" | tar -tz` — accessed 2026-09-14.
- **Says:**
  - `@fontsource-variable/archivo@5.3.0` exposes `index.css`, `wght.css`, `wght-italic.css`,
    `standard.css`, `standard-italic.css`, `wdth.css`, `wdth-italic.css`, and 18 `.woff2` files under
    `files/`, subset-split (`archivo-latin-*`, `archivo-latin-ext-*`, and so on).
  - `@fontsource-variable/ibm-plex-sans@5.3.0` exposes the same seven CSS entry points and 36
    `.woff2` files.
  - `@fontsource/ibm-plex-mono@5.3.0` exposes per-weight CSS (`400.css`, `500.css`, `700.css`, each
    with an `-italic` sibling) plus subset-scoped variants (`latin-400.css`, `cyrillic-400.css`, …)
    and 70 `.woff2` files.
- **Affects the plan:** T-04 imports `wght.css` from each variable package (the weight axis only, not
  the width axis the design system never asks for) and two static weights from Mono. Every one of
  those CSS files declares `@font-face` per subset with a `unicode-range`, so a browser downloads only
  the subset it needs — importing the un-prefixed file does not ship Cyrillic to a Latin page.

---

## Q: Does SvelteKit 2.70.3 permit a custom `%placeholder%` in `src/app.html`?

- **Source:** the installed framework source,
  `node_modules/@sveltejs/kit/src/core/config/index.js`, function `load_template` — read 2026-09-14.
  Version confirmed as `2.70.3` from the package's own `package.json`.
- **Says:** `load_template` enforces exactly two things. It throws if the template is missing
  `%sveltekit.head%` or `%sveltekit.body%` (`const expected_tags = ['%sveltekit.head%',
  '%sveltekit.body%']`), and it throws if a `%sveltekit.env.X%` placeholder names a variable without
  the public prefix. **There is no validation of any other `%…%` token**, so an unrecognised
  placeholder is passed through into the rendered HTML untouched.
  `node_modules/@sveltejs/kit/src/runtime/server/page/render.js:635` confirms `transformPageChunk` is
  applied to the rendered output.
- **Affects the plan:** T-18 may put a custom placeholder in the opening `<html>` tag of
  `src/app.html` and substitute it inside `handle` via `transformPageChunk`. That is what lets the
  server stamp `data-theme` before the first byte reaches the browser, which is the whole point of
  using a cookie rather than `localStorage` — there is no flash of the wrong theme. The placeholder
  sits in the first chunk of the document, so a `String.replace` on it is safe even under streaming.
- **Not a conflict.** The specification says nothing about templates or theming.

---

## Q: Do the existing token pairs meet the WCAG AA floor `CLAUDE.md` calls non-negotiable?

- **Source:** direct computation from the hex values in `src/lib/styles/tokens.css`, using the WCAG
  2.x relative-luminance formula the design system itself quotes in section 9
  (`L = 0.2126·R + 0.7152·G + 0.0722·B` over linearised sRGB;
  `ratio = (L_lighter + 0.05) / (L_darker + 0.05)`) — computed 2026-09-14.
- **Says — failures below the 4.5:1 normal-text floor:**

  | Theme | Ink | Surface | Ratio |
  |---|---|---|---|
  | light | `--c-ink-3` `#646f7a` | `--c-bg` `#e9edf0` | **4.35** |
  | light | `--c-ink-3` | `--c-bg-2` `#dfe5e9` | **4.03** |
  | light | `--c-ink-3` | `--c-accent-soft` / `--c-ok-bg` / `--c-warn-bg` / `--c-danger-bg` | **4.23 – 4.38** |
  | dark | `--c-danger` `#d97165` | `--c-raise-2` `#2b3139` | **4.06** |
  | dark | `--c-ok` `#5aa06f` | `--c-raise-2` | **4.18** |
  | dark | `--c-ink-3` `#8a949d` | `--c-raise-2` | **4.25** |
  | dark | `--c-danger` | `--c-accent-soft` `#16323a` | **4.19** |
  | dark | `--c-ok` | `--c-accent-soft` | **4.31** |
  | dark | `--c-ink-3` | `--c-accent-soft` | **4.39** |

  That is **twelve** failing text-on-surface pairs, six per theme.

  **Says — the same tokens pass on other surfaces**, so these are pairing defects, not palette
  defects: light `--c-ink-3` on `--c-raise` `#ffffff` is **5.13** and on `--c-raise-2` `#f4f7f9` is
  **4.76**; dark `--c-danger` on `--c-raise` is 4.65 and on `--c-bg` 5.52; dark `--c-ink-3` passes on `--c-bg`
  (5.77), `--c-bg-2` (5.37), `--c-raise` (4.87), `--c-ok-bg` (4.86), `--c-warn-bg` (4.96) and
  `--c-danger-bg` (5.24). The ONLY surface on which `--c-ink-3` clears 4.5:1 in **both** themes is
  `--c-raise`, which is why the grammar restricts it to that one. Every other text pair in
  both themes passes, most of them comfortably — light `--c-ink` reaches 14.72 on `--c-bg`, and the
  six dark `--c-st-*` status colours all sit between 7.31 and 10.60.

  **Says — non-text contrast (WCAG 1.4.11, 3:1 floor for UI component boundaries):** `--c-line`
  `#c5cfd6` is **1.58** on `--c-raise` and **1.34** on `--c-bg`; dark `--c-line` `#333b44` is **1.32**
  on `--c-raise`. By contrast `--c-ink-3` as a border reaches **5.13** light and **4.87** dark, and
  `--c-accent` as a focus ring reaches **5.21** on light `--c-bg` and **7.49** on dark `--c-bg`.

  **Says — the on-accent pairs are fine:** light `--c-accent-ink` `#ffffff` on `--c-accent` `#0f6b7e`
  is **6.13**; dark `#0d1416` on `#5cb4c9` is **7.82**.

- **Affects the plan:** T-01 writes these as grammar rules — which ink is legal on which surface, and
  which token a control border uses — and T-03 enforces them. **No colour value changes.** Note that
  `tokens.css` line 31 annotates `--c-ink-3` as "labels, table heads 5.1:1"; that figure is correct
  *against `--c-raise`* and the current dashboard navigation puts the same token on `--c-bg`, where it
  measures 4.35. The annotation is not wrong, the usage is.

- **GAP — for the user, NOT resolved here.** `CLAUDE.md` states "WCAG AA (4.5:1) at normal text size,
  in both themes, for every text-on-surface pair" as a non-negotiable, and the measurements above show
  the current palette cannot satisfy that for *every* pair — only for the legal subset this plan
  defines (twelve pairs fail). Two ways to close it properly, and the choice is the user's: restrict the pairs (what this
  plan does, no colour changes), or darken `--c-ink-3` and lighten dark `--c-danger`/`--c-ok` so every
  combination passes. The user explicitly deferred palette re-tuning when this plan was agreed, so
  **no task here may edit a colour value**; if the second option is later chosen it is its own plan,
  and T-03's test is where the new floor would be asserted.

---

## Q: Is there a component test harness this plan could use?

- **Source:** `vitest.config.ts` and `package.json` in this repository — read 2026-09-14.
- **Says:** Vitest defines exactly two projects, `unit` and `integration`, both
  `environment: 'node'`. There is no `jsdom`, no `@testing-library/svelte`, no `vitest-browser-svelte`
  and no browser mode. Playwright exists and runs against the production build.
- **Affects the plan:** UI verification uses what is already here — node-project tests that read CSS,
  `package.json` and component source as **text**, plus the Playwright journey. No test dependency is
  added. That is a deliberate limit, not an oversight: it means these tests can assert that a token
  exists, that a pair meets a ratio and that an import is present, but they cannot assert that a
  rendered component looks right. Visual correctness is checked by a human opening `pnpm dev`.

---

## Q: Do the `@fontsource` packages declare the same family NAMES that `tokens.css` asks for?

**This is the most important finding in this file. Installing the packages without acting on it
reproduces the exact bug this plan exists to fix, and every test stays green.**

- **Source:** the `@font-face` blocks inside the published packages, extracted with
  `tar -xzOf <tarball> package/wght.css` (and `package/400.css` for Mono) — accessed 2026-09-14.
- **Says:**

  | Package | Declares `font-family` | `font-weight` range | Matches the token? |
  |---|---|---|---|
  | `@fontsource-variable/archivo@5.3.0` | `'Archivo Variable'` | `100 900` | **NO** — the token says `Archivo` |
  | `@fontsource-variable/ibm-plex-sans@5.3.0` | `'IBM Plex Sans Variable'` | `100 700` | **NO** — the token says `IBM Plex Sans` |
  | `@fontsource/ibm-plex-mono@5.3.0` | `'IBM Plex Mono'` | per file (`400`, `500`, …) | yes |

  All three set `font-display: swap`.

- **Affects the plan:** `src/lib/styles/tokens.css` lines 139-141 currently read
  `--font-display: Archivo, system-ui, …` and `--font-sans: "IBM Plex Sans", system-ui, …`. A browser
  matches `@font-face` by the declared family string, so those two stacks would **not** match the
  variable packages, the faces would go unused, and both surfaces would keep rendering in
  `system-ui` — indistinguishable from today's bug, with `pnpm check`, `pnpm lint`, `pnpm test` and
  both e2e specs still passing. T-04 therefore edits the two stacks to put the declared name first
  and keep the plain name as the next fallback:

  ```css
  --font-display: "Archivo Variable", Archivo, system-ui, -apple-system, sans-serif;
  --font-sans:    "IBM Plex Sans Variable", "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  --font-mono:    "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;  /* unchanged */
  ```

  Note this is a **font stack**, not a colour: the "no palette changes" rule in `00-overview.md`
  governs colour values and does not forbid this edit.

  Note also that `IBM Plex Sans Variable` tops out at weight 700, so `font-bold` resolves to a real
  face while `font-black` (900) would be synthesised. Archivo Variable covers the full 100-900.

- **Affects the plan, second consequence:** T-05's test compares the family names declared in the
  installed packages against the `--font-*` tokens, rather than merely checking that an import line
  exists. A test that only greps for the import would pass in exactly the broken state described
  above, which is the failure mode that let three typefaces stay missing for the project's whole life.
