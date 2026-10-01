# matcami — Layout redesign: implementation brief for an AI coding agent

**Repo:** matcami (SvelteKit + Svelte 5 + Tailwind CSS v4, tokens in `src/lib/styles/tokens.css`) · **Baseline:** `main @ e69db78` · **Scope:** layout of the till (`/pos/**`) and the owner dashboard. Colours, fonts, radii, the status-glyph vocabulary and the pinned-light till stay as they are.

This file is written to be handed to an AI coding agent (Claude Code, Cursor, Codex, …) that has the repository open. Put this folder in the repo as `docs/redesign/` (this file plus `mockups/` and `screens/`), then paste the master prompt below.

---

## 0 · Master prompt (paste this into the agent)

```text
You are working in the matcami repository (SvelteKit, Svelte 5 runes, Tailwind CSS v4 configured
only in CSS, design tokens in src/lib/styles/tokens.css). Implement the layout redesign described in
docs/redesign/INSTRUCTIONS.md, one phase at a time, in the order given.

- docs/redesign/mockups/*.html are the reference. Each file is a static page at an exact viewport
  size, written with real Tailwind utility classes and the repo's own token utilities (bg-raise,
  text-ink-2, min-h-touch-xl, rounded-card, …). Port their structure and class strings into the
  Svelte components named in each phase. docs/redesign/screens/*.png show how they render.
- Do not change server code (hooks.server.ts and handleTheme included), the database, the sync
  queue, the service worker, API routes or the money module. The redesign is markup, classes, a few
  new presentational components and tests.
- Where a mockup and the brief disagree, the brief wins. The mockups show layout; the brief is the spec.
- Obey every rule in section 3 of the brief (tokens only, no arbitrary values, glyph + word, money
  in mono from the formatter, one role="alert" per page, touch tokens only on the till).
- Keep the accessible names the e2e suite relies on unless the brief says to change one; when it
  does, update the tests it names in the same commit.
- After each phase run the type check, the unit tests (vitest) and the e2e suite (Playwright) from
  package.json, fix what breaks, then commit: "redesign(phase N): <summary>".
- Stop after Phase 8. Phase 9 needs server changes; do it only when the owner asks for it.
- Stop and report instead of guessing if a phase conflicts with code you find.
```

---

## 1 · What is wrong today (measured on the reference captures)

The UI & Design Reference (425 pages, captured from `main @ e69db78`) shows one root cause across both surfaces: **the primary action of a screen is the last thing in a long document, so it lands below the fold.**

| Surface | Screen | Where the primary action is today | Target |
|---|---|---|---|
| Till 1280×800 | `/pos/session` Open | Open session at **832–928 px** (entirely below 800) | inside the viewport, bottom of the keypad card |
| Till 1280×800 | `/pos/session` Close | Close session at **876–970 px**; blocked: 990–1086 px | inside the viewport |
| Till 1280×800 | `/pos/order`, 4 lines | Pay at **896–990 px**; the page is 1109 px tall | pinned bottom-right of the check, always visible |
| Till 1280×800 | `/pos/pay` with change | Pay · Cash at 794–888 px | pinned bottom-right, same spot as Pay |
| Till 1280×800 | `/pos/pin` wrong PIN | the error line pushes Sign in down (the capture is 853 px tall) | inside the viewport, last element of the keypad card |
| Till 1280×800 | `/pos/register` error | Register starts at ~786 px | inside the viewport |
| Dashboard | `/employees`, `/inventory`, `/menu` | "Add …" create forms stacked **under** the whole list; `/menu` has four create cards at the very bottom | beside the list (≥1280 px) or opened at the top |
| Dashboard | `/settings`, `/purchases/new` | Save / Record delivery at the end of a long form | sticky action bar at the bottom of the viewport |
| Dashboard | every page at 1440 px | no shared container: form pages stop flush-left at `max-w-form` (512 px), Overview / Reports / Flagged at `max-w-6xl`, 16 pages have no cap | one centred container, two-column page templates |
| Phone < 1024 px | every dashboard page | the rail becomes a tall dark block (brand, sideways-scrolling nav, written cue, identity, theme, sign out) above the content | 56 px top bar + navigation drawer |
| Phone | `/login` | 505 px brand block first; Sign in at 808–844 px of 844 | form first |

Why the till fails: the chrome is two stacked bands (~162–176 px) in normal flow, the wrapper is `min-h-screen`, nothing is `sticky` or height-bounded, and the check's line list is a `max-h-96` box inside a page that scrolls. The unsynced count scrolls away with the page (spec 6 and invariant 5 say it must always be on screen).

## 2 · Layout principles the new UI follows

1. **The viewport is the frame on the till.** One fixed-height shell (`h-dvh`): a 64 px bar on top; below it, panes that scroll *inside themselves*; every closer pinned to the bottom of its pane. The document never scrolls on the till.
2. **The primary action always lives in the same place.** On `/pos/order` and `/pos/pay` it is the 96 px closer at the bottom-right of the check column. On the keypad screens (session, PIN) it is the last element of the keypad card, and on the register screen the last element of the form card; the card is vertically centred and always fits.
3. **One till bar instead of two bands.** 64 px (`h-touch`) holding brand, POS tab, restaurant + till code, Online/Offline + unsynced (always visible), clock, a real *session key*, and the employee menu.
4. **Dashboard pages read top-down:** header (title, one primary action) → content. Create forms sit **beside** the list they add to at ≥1280 px, and open **at the top** below that — never at the bottom.
5. **Long dashboard forms get a sticky action bar** at the bottom of the viewport (Save is always visible, results appear next to it).
6. **One centred container** (`max-w-page`, 72 rem) and one gutter rule on every dashboard page.
7. **Phones:** a 56 px top bar and a navigation drawer; the page title starts right under the bar.
8. **Keep the brand:** same tokens, typefaces, radii, glyph + word statuses, drawn control edges on the till, pinned-light till.

## 3 · Non-negotiable rules (from CLAUDE.md, docs/design-system.md and the guard tests)

- `tokens.css` is the only place a colour, size or type value is defined. No arbitrary values (`bg-[#…]`, `p-[57px]`, `grid-cols-[…]`), no raw hex, no Tailwind palette colours (`bg-white`, `text-red-*`), no `opacity-*`. Need a value that has no token? Add a token (section 5).
- Touch tokens (`touch-min`, `touch`, `touch-lg`, `touch-xl`) only on the till; never on dashboard screens or in `src/lib/components/ui/`.
- Every pressable till surface keeps `border border-control-line`. Disabled = `bg-disabled-bg text-disabled-ink` + the edge + a stated reason tied with `aria-describedby`. Never `opacity`.
- Status is always glyph + word; the glyph is `aria-hidden`. Colour never carries meaning alone — every *selected* key gets a glyph too (check-circle / check), not only a fill.
- Money is the formatter's output (`formatMoney` / `formatAmount`), `font-mono tabular-nums`, right-aligned. No arithmetic in components: the till screens' tripwire (`menu-view.test.ts:99-125`) forbids `parseFloat`, `.toFixed(`, `Number(`, `roundToMinor(` or a tax helper, and Phase 0 extends it to `src/lib/components/pos/**`.
- IBM Plex Mono ships only at 400 and 500: mono figures use `font-medium` at most (no synthesised bold).
- At most one `role="alert"` per page. Labels are the accessible names. The till's failure banners get `role="alert"`, progress gets `role="status"`.
- No dashboard URL may begin with `pos`. The till stays `[data-surface="pos"]`, pinned light.
- Keep `components.test.ts`, `tokens.test.ts`, `primitives.test.ts`, `sidebar.test.ts`, `fonts.test.ts`, `theme.test.ts`, `service-worker.test.ts` and `menu-view.test.ts` green; change them only where a phase says so.

## 4 · Reference mockups

| File | Size | Shows |
|---|---|---|
| `mockups/Main.html` | 1280×800 | `/pos/order`, three lines, newest line selected, Pay pinned |
| `mockups/Till-Options.html` | 1280×800 | modifier panel in the entry pane with Add / Cancel pinned |
| `mockups/Till-Pay.html` | 1280×800 | `/pos/pay`: tender pane + the same check, read-only, "Pay · Cash" pinned |
| `mockups/Till-Session-Open.html` | 1280×800 | open a session: context column + keypad card |
| `mockups/Till-Session-Close.html` | 1280×800 | close blocked offline: blockers, Back to the order, disabled closer with reason |
| `mockups/Till-PIN.html` | 1280×800 | PIN: who it is for, dot slots, hint, "Not Amina?" key; keypad card ending in Sign in |
| `mockups/Till-Register.html` | 1280×800 | register the device: context column + form card with the error at its top |
| `mockups/Till-1024.html` | 1024×768 | order screen on a 10″ tablet (Table field wraps to its own row) |
| `mockups/Phone-Till.html` | 390×844 | order screen below `md`: pinned check bar with Pay |
| `mockups/Dash-Overview.html` | 1440×900 | Overview: callout, tiles, Activity 3/5 + Getting set up 2/5 |
| `mockups/Dash-Employees.html` | 1440×900 | list + create panel (right column) |
| `mockups/Dash-Menu.html` | 1440×900 | Items / Modifier groups tabs, per-category tables, inline editor, add panel |
| `mockups/Dash-Settings.html` | 1440×900 | sectioned form + sticky Save bar |
| `mockups/Dash-Reports.html` | 1440×900 | date navigation in the header, totals row, two-column report grid |
| `mockups/Phone-Overview.html` | 390×844 | 56 px bar, header, content |
| `mockups/Phone-Navigation.html` | 390×844 | navigation drawer open |
| `mockups/Phone-Employees.html` | 390×844 | "Add an employee" in the header, create panel closed |
| `mockups/Phone-Sign-in.html` | 390×844 | `/login`: form first, brand band after it |

How to read them:

- Class names are real Tailwind v4 utilities plus the repo's token utilities. `mockup.css` is a *simulation* of the Tailwind build: it mirrors `tokens.css` and emits only the utilities the mockups use. **Do not copy `mockup.css` into the app** — the app's own Tailwind build produces these utilities from the same class names.
- Inside `mockup.css`, responsive prefixes (`sm: md: lg: xl:`) compile to container queries on `.mock-root`, and `h-dvh` to the frame height, so each file renders as a browser of that size would. In the app they are ordinary media queries and `100dvh`.
- `.pos-icon` / `.rail-icon` stand in for `PosIcon` and the rail's inline icons (stroke 1.8 / 1.6, `currentColor`).
- **The brief wins.** Where a mockup and this brief differ, follow the brief. The mockups are static pictures of one state each; the other states (empty cart, offline, busy, errors) follow the phase text.
- "You are here" styling uses a `data-current` attribute and Tailwind v4's built-in `data-current:` variant; `aria-current="page"` still marks the exact page for assistive tech. `aria-checked:`, `aria-pressed:`, `aria-selected:` and `aria-expanded:` are built in too, and `@container` / `@md:` / `@2xl:` are Tailwind v4 container queries. No custom variant is needed.
- The mockups link Google Fonts only so they render outside the app. Do not port that: the app self-hosts its fonts (`fonts.test.ts`).
- Copy follows today's product wording except the deliberate changes listed in §13.2, and three pieces of Phase 9 content: the Overview's **Selling** tile ("● Session open …") and the **done** badge on "Open the first POS session" (both need the sessions table — keep today's literals), and plural-aware counts such as "1 operation still syncing" (today "1 operations").

## 5 · Phase 0 — Groundwork

**Files:** `src/lib/styles/tokens.css`, `src/lib/styles/base.css`, `src/lib/styles/tokens.test.ts`, `src/lib/components/components.test.ts`, `menu-view.test.ts`, new `src/lib/components/ui/Icon.svelte`, `src/lib/components/pos/PosIcon.svelte`, new `src/lib/components/pos/keys.ts`, `docs/design-system.md`.

1. **"You are here" without a custom variant.** A nav row or tab that is current gets a `data-current` attribute (present or absent) and is styled with Tailwind v4's built-in `data-current:` variant. The exact page also keeps `aria-current="page"` for assistive tech.
2. **Complete two type roles** in the plain `@theme` block of `tokens.css` (they are bare sizes today, so the 40 px total sits in a 60 px line box):
   ```css
   --text-pos: 1.0625rem;
   --text-pos--line-height: 1.45;
   --text-total: 2.5rem;
   --text-total--line-height: 1.1;
   --text-total--letter-spacing: -0.01em;
   --text-total--font-weight: 500;
   ```
3. **Scrim token** for the navigation drawer and the phone check sheet. Declare `--c-scrim` on the bare `:root` (`rgb(22 27 32 / 0.55)`), in *both* dark blocks (`rgb(0 0 0 / 0.6)`) and in the `[data-surface="pos"]` scope; expose it in `@theme inline` as `--color-scrim: var(--c-scrim);`. If `tokens.test.ts` parses every `--c-*` as a 6-digit hex, either teach the parser to skip `--c-scrim` (it is not a text ground) or write it as the 8-digit hex `#161b208c` (dark `#00000099`).
4. **Rail focus ring as a token** (fixes 2.37:1 on the light rail and 1.58:1 on the till bar, WCAG 1.4.11). The contrast census reads `tokens.css` only, so the value has to live there:
   - `tokens.css`: add `--c-rail-ring: var(--c-rail-ink);` beside the `--c-ring` alias on `:root` (tokens.css:66) **and** beside the `--c-ring` re-declaration in the `[data-surface="pos"]` scope (tokens.css:226). An alias resolves where it is declared, so the till scope needs its own copy; the dark blocks target `:root` and need none.
   - `tokens.test.ts`: add the non-text census pair `['rail-ring', 'rail']` (≥ 3:1) for all four palette states. If the parser only resolves the aliases it already knows (`ring`, `control-line`), teach it `rail-ring` the same way.
   - `base.css`:
     ```css
     [data-rail] { --c-ring: var(--c-rail-ring); }
     [data-rail] [data-panel] { --c-ring: var(--c-accent); } /* light pop-overs inside a rail keep the normal ring */
     ::placeholder { color: var(--c-ink-2); }                /* the preflight placeholder is 3.33:1 */
     summary { list-style: none; }
     summary::-webkit-details-marker { display: none; }       /* Safari and iPad */
     ```
   - `data-rail` goes on every rail-coloured surface: the Sidebar `<aside>`, the phone top bar, the navigation drawer panel and the till bar. `data-panel` goes on the light panels that open inside them (the till's employee menu and warnings list), so their focus ring is not white on white.
5. **Let till components be shared.** `components.test.ts` walks all of `src/lib/components/**` and bans the touch tokens there. Narrow that one check to `src/lib/components/ui/**`; keep the server-import, hex and px guards on `pos/` too. This is what lets `Check`, `CheckLine`, `Closer`, `Keypad`, `TillBar` and `TillBanner` live in `src/lib/components/pos/`.
6. **Money tripwire follows the code.** `menu-view.test.ts` (lines 99–125) scans the order, pay and session route files for `parseFloat`, `.toFixed(`, `Number(`, `roundToMinor(` or a tax helper. Add `src/lib/components/pos/**` to the files it scans, because the new till components print money.
7. **Stacking scale** (document it in `docs/design-system.md` §7b; Tailwind's own `z-*` utilities): `z-10` sticky aside · `z-20` sticky action bar · `z-30` phone top bar · `z-40` drawer / sheet · `z-50` skip link and till menus.
8. **Mono weight cap.** IBM Plex Mono ships only 400 and 500. Wherever `font-mono` meets a role whose weight is 600 or more (`text-display`, `text-title`, `text-section`), add `font-medium`, and replace `font-bold` / `font-semibold` on mono figures with `font-medium`. Known places: the order Total (`font-bold` today), keypad digits, the Table field, the Overview counts, report totals, the rail initials and the Callout glyph.
9. **One icon set.** Create `src/lib/components/ui/Icon.svelte` with the PosIcon contract (24×24 viewBox, `stroke="currentColor"`, round caps and joins, `aria-hidden="true"`, `focusable="false"`, `class="shrink-0 {class}"`) and a `stroke` prop (1.8 by default, 1.6 on the rail). It holds today's 17 PosIcon names plus the ones the mockups use: `arrow-left`, `arrow-right`, `backspace`, `card`, `cash`, `check`, `chevron-left`, `chevron-right`, `chevron-up`, `log-out`, `menu`, `minus`, `monitor`, `moon`, `phone`, `plus`, `refresh`, `sun`, `user-plus`, `x`. Copy the paths from the inline `<svg>`s in `mockups/*.html`. Make `PosIcon.svelte` a one-line wrapper around `Icon` so existing imports keep working. The rail's nine inline nav icons stay as they are (`sidebar.test.ts` checks that snippet).
10. **Shared till class strings.** `src/lib/components/pos/keys.ts` exports the class strings every till key repeats today: `KEY` = `rounded-control border border-control-line bg-raise font-semibold disabled:bg-disabled-bg disabled:text-disabled-ink`; `KEY_CHOSEN` = `aria-checked:border-accent aria-checked:bg-accent aria-checked:text-accent-ink aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-ink`; `TILL_FIELD` = `min-h-touch rounded-control border border-control-line bg-raise px-3`. Route files and till components import these instead of re-typing them (Tailwind v4 scans `.ts` files, so the classes are still generated).

**Done when:** the type check, the unit tests (with the new census pair and the wider money scan) and `pnpm build` pass.

## 6 · Phase 1 — The till shell (fixed height)

**Files:** `src/routes/(pos)/pos/+layout.svelte`, new `src/lib/components/pos/TillBar.svelte`.

### 6.1 Shell

```svelte
<!-- (pos)/pos/+layout.svelte -->
<svelte:body use:tillBody />
<div data-surface="pos" class="flex h-dvh flex-col overflow-hidden bg-bg text-pos text-ink">
  <TillBar {...barState} />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    {@render children()}
  </div>
</div>
```

- Replace `min-h-screen` with `h-dvh` + `overflow-hidden`: the document never scrolls on the till. Each rebuilt page renders one `<main class="… min-h-0 flex-1 …">` and scrolls inside its panes.
- The wrapper's `overflow-y-auto` is the safety net between phases: session, pay, PIN, register and employee select are only rebuilt in Phases 3–4, and until then they must still scroll instead of being clipped (Open session sits at 832–928 px today). Keep it afterwards; a rebuilt page fits, so the wrapper never scrolls.
- `tillBody` is a small action that sets `data-surface="pos"` on `<body>` and removes it on destroy. The body then takes the till's pinned palette and `color-scheme: light`, so overscroll around the till never shows the viewer's dark ground. No server change — do not touch `handleTheme`.
- The live region shrinks: today `role="status"` wraps the whole chrome, controls included. In the new bar it wraps only the connection and sync pills (6.2).

### 6.2 TillBar (`mockups/Main.html`, first `<header>`)

`<header data-rail class="bg-rail flex h-touch shrink-0 items-center gap-2 px-3 text-rail-ink sm:gap-3 sm:px-4 lg:px-6">` — one row, 64 px, left to right:

| Element | Classes / behaviour |
|---|---|
| Brand tile + POS link | Keep `<nav aria-label="Till">` and a link named **POS**. Below `sm` the brand tile itself is that link (`<a aria-label="POS" class="grid size-10 … sm:hidden">m</a>`), so the register and PIN screens keep a way back on a phone. From `sm` the tile is decorative and the pill tab is the link (`hidden min-h-touch-min items-center gap-2 rounded-full border border-rail-line bg-rail-active px-5 font-semibold sm:flex`). Set `aria-current="page"` **only** on `/pos/order` (today it is hard-coded on every screen). |
| Restaurant · Till code | `hidden min-w-0 flex-col lg:flex`, both lines `truncate`; second line `text-body text-rail-ink-2` (15 px, not 13 px captions). The only item in the bar that may shrink. |
| Status group | `<div role="status" aria-label="Connection and sync" class="ml-auto flex shrink-0 items-center gap-2">` holding **only** the pills. Pills are `inline-flex h-10 items-center gap-1.5 rounded-full px-2.5 text-body sm:px-3`: `● Online` = `bg-ok-bg text-ok font-semibold`; `◆ Offline` = `bg-st-offline-bg text-st-offline font-semibold`; unsynced = `border border-rail-line text-rail-ink-2` at 0, and **`bg-st-offline-bg text-st-offline font-semibold` with `◆` when > 0**. The word "unsynced" is `sr-only sm:not-sr-only`: below `sm` the pill shows a refresh icon + "0" or "◆ 3", and a screen reader still hears "3 unsynced". |
| Warnings chip | Every other till warning — parked operations, clock skew, count unavailable, operations from a previous registration — merges into **one** `<details>` chip `◆ {n} warning(s)` in the same offline pair (the word is `sr-only sm:not-sr-only`). Its panel (white, `data-panel`, `z-50`) lists each warning in full. Never one chip per warning: that is what pushes the bar past the screen edge. |
| Clock | `hidden shrink-0 flex-col items-end xl:flex`: time (semibold, tabular) over date (`text-body text-rail-ink-2`). |
| Session key | When someone is signed in and a session exists: a real key, `<a href="/pos/session" class="hidden min-h-touch-min min-w-touch-min shrink-0 items-center justify-center gap-2 rounded-control border border-rail-line bg-rail-raise px-3 font-semibold sm:flex">` — lock icon, `● Session` (md+), "Close session" second line (xl), chevron (md+). Accessible name: `Session · business date {date} · Close session`, which contains the visible words (WCAG 2.5.3). While opening/closing show `◐ Opening…` / `◐ Closing…`. No session: static `○ No session / Open one to start selling` (md+). Below `sm` the key is hidden; the employee menu's **Close session…** is the way there. |
| Employee menu | `<details class="relative shrink-0">`; the `<summary>` is a key with the same edge (`flex min-h-touch-min items-center gap-2 rounded-control border border-rail-line bg-rail-raise p-1 sm:pr-3`): initials disc, name (md+), role (xl), chevron (sm+); sr-only "name · role" below md. The menu panel is white with `data-panel`. Items: **Switch employee** and **Close session…** (a second path to the close). Close the menu on Escape and on an outside tap. Nobody signed in: static "Nobody signed in". |

**How the bar degrades.** Only the restaurant block may shrink (it truncates, and it only shows from `lg`). Everything else is `shrink-0` and appears by breakpoint: `sm` adds the POS pill tab, the words on the pills and the session key (icon only); `md` the session label and the employee name; `lg` the restaurant and till; `xl` the clock, the "Close session" line and the role. In this order the bar stays one row with Offline + "◆ 3 unsynced" + two warnings at 390, 1024 and 1280 px (measured in the mockups: the content ends at 378, 1002 and 1256 px).

**Acceptance:** at 1280×800, 1280×720, 1024×768 and 390×844, online and offline with unsynced operations, the bar is one 64 px row and its content does not overflow (`scrollWidth <= clientWidth`); the unsynced pill is visible on every till screen; Tab focus on the POS link, the session key and the summary shows a white ring, and inside the employee menu the normal accent ring.

## 7 · Phase 2 — Order screen `/pos/order` and the `Check` component

**Files:** `src/routes/(pos)/pos/order/+page.svelte`, new `src/lib/components/pos/Check.svelte`, `CheckLine.svelte`, `Closer.svelte`. **Mockups:** `Main.html`, `Till-Options.html`, `Till-1024.html`, `Phone-Till.html`.

### 7.1 Page frame

```
┌────────────────────────── TillBar 64px ──────────────────────────┐
├──────────────── entry pane (flex-1) ───────────────┬─ Check (w-96 / xl:w-md) ─┐
│ [Sit now][Waiting for a table][Takeaway]  Table[4] │ ▓ Current Order · ○ OPEN  │ shrink-0
│ (Mains)(Drinks)                snapshot v21 · 6 items│ lines … (scrolls inside) │ flex-1
│ ┌ item grid — the only part that scrolls ────────┐ │                           │
│ │ [key][key][key][key]                            │ │ Subtotal / Tax            │
│ └─────────────────────────────────────────────────┘ │ Total 15.75 USD          │ shrink-0
│                                                      │ [Clear][ Pay 15.75 USD ] │ 96px
└──────────────────────────────────────────────────────┴───────────────────────────┘
```

```svelte
<main class="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row md:gap-4 md:p-4 lg:px-6">
  <section aria-labelledby="entry-h" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-raise shadow-flat">
    <h1 id="entry-h" class="sr-only">Ring up an order</h1>
    <!-- toolbar · tabs row · grid region (see below) -->
  </section>
  <Check mode="edit" display="hidden md:flex" … />     <!-- md and up -->
  <CheckBar class="md:hidden" … />                      <!-- below md -->
</main>
```

### 7.2 Entry pane

- **Toolbar** `flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft p-3 md:p-4`:
  - Order type becomes a radio group (the review's semantics fix): `<div role="radiogroup" aria-label="Order type" class="grid min-w-0 flex-1 basis-96 grid-cols-3 gap-2">`; each key `<button role="radio" aria-checked=… class="flex min-h-touch min-w-0 items-center gap-2 rounded-control border border-control-line bg-raise px-2 text-left text-body font-semibold leading-tight aria-checked:border-accent aria-checked:bg-accent aria-checked:text-accent-ink sm:px-3 sm:text-pos">`, icon `hidden size-6 sm:block`, the chosen key adds `check-circle`. Names stay **Sit now / Waiting for a table / Takeaway**. Radio keyboard rules: only the checked radio is in the tab order (`tabindex` 0, the others −1) and the arrow keys move the choice.
  - Table field (Sit now only): `flex shrink-0 items-center gap-2` → visible `<label>Table</label>` + `<input maxlength="32" placeholder="Table number or name, e.g. 4" class="min-h-touch w-32 rounded-control border border-control-line bg-raise px-3 font-mono text-title font-medium">`. Drop the magnifier icon (it is a label, not a search) and use `rounded-control`. The `basis-96` on the radio group makes the field wrap to its own row when there is no room (1024 px, portrait, phone) instead of overlapping.
- **Tabs row** `flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3 md:px-4 md:pt-4`: keep `role="tablist"` + generated tabs (`min-h-touch-min rounded-full px-5`, selected `aria-selected:border-accent aria-selected:bg-accent aria-selected:text-accent-ink` **plus a check icon**). The heading becomes `<h2 class="sr-only">Menu</h2>` and the snapshot caption moves out of it into `<p class="ml-auto text-body text-ink-2">snapshot v21 · 6 items</p>`. **Finish the tabs pattern** (decided; do not switch to pressed buttons): no `<nav>` wrapper; every tab has an `id`, `aria-controls="menu-grid"` and a roving `tabindex` (0 on the selected tab, −1 on the rest); Left/Right select the previous/next tab and Home/End the first/last; the grid region is the one `role="tabpanel" id="menu-grid"`, with `aria-labelledby` pointing at the selected tab.
- **Grid region** `@container min-h-0 flex-1 overflow-y-auto p-3 md:p-4` — the only part of the pane that scrolls. Item grid columns follow the **pane**, not the viewport (review finding): mark the region `@container` and use `grid grid-cols-2 gap-3 @md:grid-cols-3 @2xl:grid-cols-4` (Tailwind v4 container queries: 3 columns from a 28 rem pane, 4 from 42 rem — 4 at 1280 px, 3 at 1024 px, 2 on a phone). Item key: `flex h-full min-h-touch-xl w-full flex-col justify-between gap-2 rounded-card border border-control-line bg-raise p-4 text-left` → name (`font-semibold leading-snug`), then a row with a hint (`text-body text-ink-2`: "Options" when the item has modifier groups, "Tax 0%" when zero-rated, else empty) and the price (`font-mono font-medium tabular-nums text-accent`). Stop repeating the tab name on every key.
- **Modifier panel** replaces the grid region (never a modal) as `<section class="flex min-h-0 flex-1 flex-col">`: a scrolling body (`min-h-0 flex-1 overflow-y-auto p-3 md:p-4` → the options card) and a **pinned footer** `flex shrink-0 gap-3 border-t border-line-soft p-3 md:p-4` with **Add to order** (`min-h-touch-lg flex-1 … bg-accent`, keeps the "Choose at least N in {Group}" reason via `aria-describedby`) and **Cancel** (`min-h-touch-lg w-40`). Chosen modifier keys add a check-circle. Move focus to the panel heading when it opens (`<h3 tabindex="-1">`). Copy change: "Add" → "Add to order" (update e2e).

### 7.3 `Check.svelte` (shared by order and pay)

Props (strings only — formatting stays in the page/lib): `mode: 'edit' | 'bill'` (edit: lines are buttons with actions; bill: plain rows), `pill: { glyph: '○' | '◐' | '●' | '◆' | '✕'; word: string }` (○ OPEN on the order, ◐ BILLED on pay, then the pay outcome's glyph and today's word), `caption`, `lines: CheckLineView[]`, `totals: { subtotal, discount?, tax, taxMode, total }`, `totalLabel = 'Total'`, `selectedId`, `onselect(id)`, `onfewer(id)`, `onmore(id)`, `onremove(id)`, `display = 'flex'`, and a `closer` snippet. Build ids from `const uid = $props.id()` (Svelte ≥ 5.20; otherwise an `idPrefix` prop): the order page renders Check twice (column and phone sheet), and no id may repeat.

```svelte
<section aria-labelledby="{uid}-h"
  class="{display} w-96 shrink-0 flex-col overflow-hidden rounded-card border border-line bg-raise shadow-raised xl:w-md">
  <header class="flex shrink-0 items-center gap-3 bg-accent px-5 py-3 text-accent-ink">
    <PosIcon name="clipboard" class="size-7" />
    <div class="flex min-w-0 flex-1 flex-col">
      <h2 id="{uid}-h" class="text-title">Current Order</h2>
      <p class="truncate text-body">{caption}</p>
    </div>
    <!-- pill: {pill.glyph} {pill.word} -->
  </header>
  <ol aria-label="Lines on the check" class="min-h-0 flex-1 divide-y divide-line-soft overflow-y-auto">
    {#each lines as line (line.id)}<CheckLine {line} {mode} selected={line.id === selectedId} … />{/each}
  </ol>
  <footer class="shrink-0 border-t border-line px-5 pb-5 pt-3">
    <dl class="flex flex-col gap-0.5"> <!-- Subtotal, (Discount), Tax (exclusive|inclusive), Total --> </dl>
    <div class="mt-4 flex gap-3">{@render closer()}</div>
  </footer>
</section>
```

- The line list replaces `max-h-96`: it takes whatever height is left and scrolls inside. After adding a line, scroll it into view (`scrollIntoView({ block: 'nearest' })`).
- Total: `font-mono text-total tabular-nums text-accent` (the 40 px role; today it is `text-title`). Discount row, when present, gets `−` and `text-danger`.
- Tax label reads `Tax (exclusive)` / `Tax (inclusive)` from the cached tax mode; the per-line "@ 8.50 · tax 5.00%" captions stay on every line.

**CheckLine** (edit mode): the whole summary row is a `<button type="button" aria-expanded={selected} class="flex w-full items-start gap-3 py-3 pl-4 pr-5 text-left">` holding the `◇ NEW` pill, `1× Name` (qty in mono), modifier lines (`+ Banana on the side 0.50`, negative deltas in `text-danger`), the `@ unit · tax rate` caption and the right-aligned amount. The `<li>` is `border-l-4 border-transparent`, selected `border-accent bg-accent-soft`. **Only the selected line** shows its action row `flex items-center gap-2 pb-3 pl-4 pr-5`: `−` and `+` keys (`min-h-touch-min min-w-touch-min`, sr-only "One fewer {name}" / "One more {name}"), the quantity in mono between them, and `Remove` (`ml-auto … px-4`, sr-only item name). The newest line is selected after every add; tapping a line selects it; tapping the selected line collapses it. This is what makes a 4–6 line order fit above Pay. In `bill`/`paid` mode lines are plain rows (no button, no actions).

**Closers** (order screen), inside the footer row:
- Clear: `<button class="flex min-h-touch-xl w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-card border border-control-line bg-raise font-semibold">` trash icon + "Clear". The inline confirmation ("Clear all {n} lines?" · Yes, clear · Keep) replaces this row **at the same height** so nothing moves.
- Pay: `<a href="/pos/pay" class="flex min-h-touch-xl flex-1 items-center justify-center gap-3 rounded-card border border-control-line bg-accent text-title font-semibold text-accent-ink">Pay <span class="font-mono font-medium tabular-nums">{total}</span></a>`. Empty cart: a `<button disabled>` with the same name **Pay**, the disabled pair, and the reason "Add an item first" in a sibling line tied with `aria-describedby` (today the closer renames itself).

`Closer.svelte` wraps these rules once: props `href?`, `disabled`, `reason?` (renders the reason line and wires `aria-describedby`), `tone: 'accent' | 'raise'`, children.

### 7.4 Below `md` (portrait tablet, phone) — `CheckBar`

The full check is `hidden md:flex`. Below `md`, the last child of `<main>` is a pinned bar (always on screen because the entry pane above it is the part that scrolls):

```svelte
<section aria-label="Current Order" class="flex shrink-0 flex-col gap-2 rounded-card border border-line bg-raise p-3 shadow-floating md:hidden">
  <button type="button" aria-expanded="false" class="flex min-h-touch-min w-full items-center gap-3 rounded-control border border-control-line bg-raise-2 px-3 text-left">
    <!-- clipboard · "Current Order · 3 lines" / caption · chevron-up -->
  </button>
  <!-- the Pay closer, min-h-touch-xl -->
</section>
```

The summary button opens the same `Check` as a full-height sheet — a `<dialog>` built with the recipe in §10 (the dialog is the full-screen scrim, the sheet sits inside it) — so the cashier never navigates away to see what has been rung in.

**Acceptance (Playwright, see section 13):** at 1280×800, 1280×720 and 1024×768 with 1, 4 and 12 lines — no document scroll, Pay fully in the viewport, unsynced pill visible, no text clipped in the toolbar; at 390×844 — Pay visible, no sideways scroll.

## 8 · Phase 3 — Pay screen `/pos/pay`

**Files:** `src/routes/(pos)/pos/pay/+page.svelte`, new `src/lib/components/pos/Keypad.svelte`. **Mockup:** `Till-Pay.html`.

Same frame as the order screen: tender pane on the left, **the same `Check` in `bill` mode** on the right (fixes "Pay leaves the check, and the bill drops what the check shows": modifiers, unit price and tax rate stay visible), and the closer in the check footer — the exact spot where Pay was on the order screen.

- Tender pane `flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-raise shadow-flat`:
  - Header row `flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft p-3 md:p-4`: **Back to the check** as a key (`<a href="/pos/order" class="flex min-h-touch-min items-center gap-2 rounded-control border border-control-line bg-raise px-4 font-semibold">`, arrow-left icon; today it is a text link under the 56 px floor), `h1` **Amount due** (today's heading) and the total on the right (`font-mono text-title font-medium`).
  - Body `min-h-0 flex-1 overflow-y-auto p-3 md:p-4`, `flex flex-col gap-5`:
    - Tender: `role="radiogroup"` named **Tender** (today a group of pressed buttons) with Cash / Card / Mobile money keys (`min-h-touch-lg`, icon `hidden sm:block`, chosen adds check-circle, radio keyboard rules as in §7.2; disabled keys keep their reason on the key: "Not accepted in settings", "◆ Cash only while offline").
    - Cash: `grid gap-5 sm:grid-cols-2` → left: Quick cash (`grid grid-cols-3 gap-2`, Exact + round-ups in mono) and a readout card `rounded-card border border-line bg-raise-2 p-4` with "Amount tendered" and "Change due" (`text-right font-mono text-total tabular-nums`); right: the hint "Keys enter cents: 2000 is 20.00 USD" (built from the cached currency format, not hard-coded) and `<Keypad>`.
    - Card / Mobile money: replace quick cash and keypad with one instruction panel: "Charge {total} on the card terminal, then press Pay once it is approved."
- Closer (check footer): `Pay · Cash <span class="font-mono font-medium tabular-nums">{total}</span>` as a `min-h-touch-xl flex-1 rounded-card` accent key. When not payable it keeps its name (today the closer is renamed to the reason), turns to the disabled pair and shows "Enter the amount tendered" in a reason line above it, tied with `aria-describedby`.
- Outcomes (paid, pending, recorded-for-review, refused) render **in the tender pane** (a `TillBanner` + invoice + figures); the check's header pill becomes `● PAID` / `◐ …`; the closer slot holds **New sale** (or **Back to order**) — still bottom-right. Mount the outcome live region before it has content so the first message is announced.

**`TillBanner.svelte`** — one component for every till notice (pay outcomes, session blockers, PIN and register errors, the offline notice): props `tone: 'ok' | 'pending' | 'offline' | 'danger'`, `live: 'alert' | 'status' | 'off'`, `id?`, children. Classes `flex items-start gap-3 rounded-card border px-4 py-3` plus the tone pair: ok `border-ok bg-ok-bg text-ok` with ●, pending `border-line bg-raise-2 text-ink` with ◐, offline `border-st-offline bg-st-offline-bg text-st-offline` with ◆, danger `border-danger bg-danger-bg text-danger` with ✕. The banner draws its glyph (`font-mono`, `aria-hidden`); callers pass words only. Failures use `live="alert"` (one per page), progress and standing notices `status`, and blocker lines that a disabled closer points at with `aria-describedby` use `off`.
- Below `md`: the check is hidden; a pinned closer row sits under the tender pane.

**`Keypad.svelte`** (one component for PIN, pay and session; today there are three drifting copies): `grid grid-cols-3 gap-2`, keys `min-h-touch-lg rounded-control border border-control-line bg-raise`, digits `font-mono text-title font-medium`, **Clear** in the body face (`font-semibold`), `⌫` as an icon with sr-only "Delete the last digit". Props: `label` (group name), `disabled`, `reason?` (id of the line that says why; set as `aria-describedby` on every key while disabled), `onkey(key: '0'…'9' | 'clear' | 'back')`. Pages keep their own digit limits. Key classes come from `keys.ts`.

**Acceptance:** closer fully visible at 1280×800 / 1280×720 / 1024×768 in every state (before tender, cash with change, card, paid, pending).

## 9 · Phase 4 — Keypad screens: session, PIN, register, employee select

**Mockups:** `Till-Session-Open.html`, `Till-Session-Close.html`, `Till-PIN.html`, `Till-Register.html`.

Shared pattern — a two-column screen, vertically centred, that always fits:

```svelte
<main class="flex min-h-0 flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
  <div class="m-auto grid w-full max-w-5xl items-center gap-6 md:grid-cols-2 lg:gap-12">
    <div class="flex flex-col gap-5"><!-- context column --></div>
    <section class="flex flex-col gap-3 rounded-card border border-line bg-raise p-4 shadow-raised">
      <!-- title row · <output> readout · <Keypad> · reason line · closer -->
    </section>
  </div>
</main>
```

- **Open a session:** context = eyebrow "Start of shift", `h1.text-display` "Open a session", a `dl` card (Business date in mono, Device clock, Till, Cashier) and the info line. Keypad card = "Opening cash (the float)" + hint + `<output aria-live="polite" class="block rounded-control border border-control-line bg-bg px-4 py-2 text-right font-mono text-total tabular-nums">` + Keypad + **Open session** closer (`min-h-touch-xl w-full`). While busy the closer is disabled *with* a reason ("Saving the session on this till…").
- **Close this session:** context = eyebrow "End of shift", `h1` "Close this session", "Open on this till since …", blocker banners (`◆`, ids `why-offline`, `why-unsynced`, `why-parked`, …) and **Back to the order** as a 56 px secondary key. This replaces the full-width accent **Continue** (two accent closers on one screen) and must be **hidden while the session is closing** (review major: selling into a closing session). Blocker lines keep today's words ("◆ Offline — closing needs a connection", "◆ {n} operations still syncing", …). Keypad card = "Counted cash" + "A blind count" + readout + Keypad + a one-line reason right above the closer, built from the blockers ("◆ Can't close yet: offline · 1 unsynced") + **Close session** (disabled, `aria-describedby` = the reason line and the blocker ids). Keep the reason to one line: at 1280×720 the blocked card has about 40 px to spare.
- **Session closed:** one centred result card (`m-auto w-full max-w-xl`): h1, business date, Expected / Counted / Difference as right-aligned mono with glyph + word, the posting sentence, and **Done** inside the card.
- **PIN** (`/pos/pin`): context column = initials disc (`size-16 rounded-full bg-accent`), `h1` "Enter the PIN for {name}" (copy change from "Enter your PIN" — §13.2), role, a six-slot dot row (drawn circles: filled `border-ink bg-ink`, empty `border-control-line`, slots 5–6 dashed), the sr-only live count, one message line with a reserved height (`min-h-12`) that shows the hint "Enter at least 4 digits" and is replaced by the wrong-PIN `TillBanner` (`live="alert"`), then **"Not {first name}? Choose your name"** (56 px key → `/pos`). Keypad card = Keypad + **Sign in** (`min-h-touch-lg w-full`) as its **last element**, so below `md`, where the columns stack, Sign in sits under the keypad and never above it.
- **Register** (`/pos/register`): the same two columns. Context = eyebrow, `h1` "Register this device as the till", today's intro and the note that registering signs the owner out of the dashboard on this device (keep today's sentences where the mockup's differ). Form card (`flex flex-col gap-3 … p-4`) = the error `TillBanner` at the top of the card when there is one, Owner email, Owner password, Name for this device (`TILL_FIELD`), and **Register this device** (`min-h-touch-lg w-full`) last. Measured in the mockup with the error showing: the button ends at 624 px of 720 (1280×720) and 648 of 768 (1024×768).
- **Employee select** (`/pos`): one centred column (`m-auto w-full max-w-3xl`) inside the scrolling `<main>`; inputs use `TILL_FIELD`.

**Acceptance:** every closer inside the viewport at 1280×800, 1280×720 and 1024×768, including the error and blocked states.

## 10 · Phase 5 — Dashboard shell

**Files:** `src/routes/(dashboard)/+layout.svelte`, `src/lib/components/ui/Sidebar.svelte`, `ThemeToggle.svelte`, new `MobileBar.svelte`, `NavDrawer.svelte`, `src/lib/components/ui/index.ts`, `sidebar.test.ts`. **Mockups:** any `Dash-*.html` (desktop) and `Phone-*.html`.

```svelte
<!-- (dashboard)/+layout.svelte -->
<a href="#content" class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-raise focus:px-4 focus:py-2">Skip to content</a>
<div class="flex min-h-dvh flex-col bg-bg lg:flex-row">
  <Sidebar variant="rail" {...rail} />          <!-- hidden lg:flex, sticky top-0 h-dvh -->
  <MobileBar bind:navOpen {...rail} />          <!-- lg:hidden, sticky top-0 z-30 h-14 -->
  <main id="content" class="flex min-w-0 flex-1 flex-col">{@render children()}</main>
</div>
<NavDrawer bind:open={navOpen}><Sidebar variant="drawer" {...rail} /></NavDrawer>
```

- The root is `flex-col` below `lg` and `flex-row` from `lg`, so `<main>` always stretches to the full height and the ActionBar's `mt-auto` works at every width. Drop the current root's `lg:items-start`: the rail has its own `h-dvh` and stays sticky without it.
- **Sidebar** (`variant="rail"`): `<aside data-rail aria-label="Workspace" class="bg-rail sticky top-0 hidden h-dvh w-65 shrink-0 flex-col border-r border-rail-line text-rail-ink lg:flex">` (collapsed: `lg:w-18`). Brand row → nav (`flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4 pt-1`) → footer. **Delete the below-lg strip** (the sideways-scrolling row, the written cue, the wrapping footer); below lg the same content lives in the drawer. The Sidebar renders twice (rail and drawer), so build its ids (group headings) from `$props.id()` or the `variant`: no id may repeat on a page.
- **Current row by prefix:** a row is current when `pathname === href || pathname.startsWith(href + '/')` — give it `data-current`; give `aria-current="page"` to the exact match only. This fixes "you are here" missing on 11 of 19 screens. Row classes: `flex min-h-10 items-center gap-2.5 rounded-control border-l-4 border-rail px-2.5 text-caption font-medium text-rail-ink hover:bg-rail-raise data-current:border-rail-ink data-current:bg-rail-active data-current:font-semibold`.
- **One name per section:** rail row "Purchases" → **Deliveries** (the page is titled Deliveries), "POS" → **POS device**. Keep the `/device` and `/purchases` URLs. Update `sidebar.test.ts` (it checks that Purchases is live) and any e2e step that clicks the rail by name.
- **Footer:** identity row (initials disc, name, role) with a compact **Sign out** key on the right (`min-h-9 … border border-rail-line`, still a `<form method="POST" action="/logout">`); below it the theme group framed with `border-rail-line` (not `border-line`), three buttons with sun / moon / monitor icons whose accessible names stay **Light / Dark / System**. Collapsed rail: stack the three theme buttons as 40 px icon buttons instead of hiding them. Collapsed rows get a tooltip on hover and focus drawn in the top layer (Popover API, placed from the row's bounding box); a tooltip positioned inside the scrolling nav would be clipped.
- **Collapsed-cookie bug:** the unprefixed `px-2` on the brand row and footer must become `lg:px-2` (it misaligned phone gutters).
- **MobileBar** (`lg:hidden`): `<header data-rail class="bg-rail sticky top-0 z-30 flex h-14 items-center gap-3 px-4 text-rail-ink lg:hidden">` → menu button (`size-10`, `aria-label="Open navigation"`, `aria-expanded`, `aria-controls="nav-drawer"`), brand tile, **`<h1>` restaurant name** (the page's h1 below lg; the rail's h1 is `display:none` there), initials.
- **NavDrawer** — a native modal `<dialog>`. The dialog itself is the full-screen scrim and the rail panel sits inside it. That avoids `::backdrop` (it does not inherit custom properties before Safari 17.4) and makes "tap outside" a click whose target is the dialog:

```svelte
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  let { open = $bindable(false), children }: { open?: boolean; children: Snippet } = $props();
  let dialog: HTMLDialogElement;
  $effect(() => {
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
  afterNavigate(() => (open = false));
</script>

<dialog bind:this={dialog} id="nav-drawer" aria-label="Navigation"
  onclose={() => (open = false)}
  onclick={(e) => { if (e.target === dialog) dialog.close(); }}
  class="m-0 h-dvh max-h-none w-full max-w-none border-0 bg-scrim p-0 backdrop:bg-transparent">
  <div data-rail class="bg-rail flex h-full w-72 max-w-full flex-col text-rail-ink shadow-floating">
    {@render children()}
  </div>
</dialog>
```

  `showModal()` gives the focus trap, Escape, and focus return to the menu button. `onclose` keeps `open` in sync when Escape closes the dialog (without it the next "Open navigation" does nothing). `m-0 max-h-none max-w-none border-0 p-0` undo the browser's modal-dialog margin, border, padding and size caps. Inside, `Sidebar variant="drawer"` shows a **Close navigation** button instead of the collapse chevron and renders the restaurant name as a `<p>` (one h1 per page). The phone check sheet in §7.4 uses the same recipe.

**Acceptance:** at 390×844 the page title starts within 120 px of the top and nothing scrolls sideways; the drawer traps focus, closes on Escape, on a tap outside and on navigation, opens again on the next tap, and returns focus to the menu button; at ≥1024 px the rail is full height at every scroll position; keyboard focus on the rail shows a white ring.

## 11 · Phase 6 — Page templates (new primitives)

**Files:** `src/lib/components/ui/PageHeader.svelte` (modified), new `PageBody.svelte`, `PageColumns.svelte`, `CreatePanel.svelte`, `ActionBar.svelte`, `Callout.svelte`, `StatTile.svelte`; small fixes in `Button.svelte`, `Table.svelte`, `Field.svelte`, `SelectField.svelte`, `Alert.svelte`; export all from `index.ts`.

**PageHeader** — not sticky; band `border-b border-line bg-raise`; inner `mx-auto flex w-full max-w-page flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 lg:px-8 lg:py-5`; left column `flex min-w-0 flex-1 basis-80 flex-col gap-1` (the `basis-80` makes actions wrap under the title on phones instead of squeezing it): eyebrow (`text-eyebrow uppercase text-ink-3`) **or** breadcrumb (new `crumbs` prop → `nav[aria-label=Breadcrumb]`, links `text-caption font-medium text-accent underline underline-offset-2`), `h2.text-title` (page titles move from `text-display` to `text-title`: ~40 px less band on every page), description `max-w-measure text-body text-ink-2`; right column: `actions` snippet `flex flex-wrap items-center gap-2`. New `below` snippet for sub-navigation (tabs) rendered inside the band.

**PageBody** — `mx-auto flex w-full max-w-page flex-col gap-6 px-4 py-6 lg:px-8`. Replaces the 19 hand-typed `flex flex-col gap-N px-4 pt-8 pb-16 lg:px-7` wrappers and finally applies `max-w-page` everywhere (centred, `mx-auto`).

**PageColumns** — main content plus a side column. There are three kinds of side column, chosen with props:

```svelte
<script lang="ts">
  import type { Snippet } from 'svelte';
  let { aside, children, collapsible = false, asideOpen = false, asideFirst = false }: {
    aside: Snippet;
    children: Snippet;
    collapsible?: boolean; // create panels only: hidden below xl until opened
    asideOpen?: boolean;   // read only when collapsible
    asideFirst?: boolean;  // master–detail: the aside is a picker that comes first
  } = $props();
  const shown = $derived(!collapsible || asideOpen);
</script>

{#snippet side()}
  <div class="{shown ? 'flex' : 'hidden'} min-w-0 flex-col gap-6 xl:col-span-4 xl:flex {collapsible ? 'order-first xl:sticky xl:top-6 xl:order-none' : ''}">
    {@render aside()}
  </div>
{/snippet}

<div class="grid items-start gap-6 xl:grid-cols-12">
  {#if asideFirst}{@render side()}{/if}
  <div class="flex min-w-0 flex-col gap-6 xl:col-span-8">{@render children()}</div>
  {#if !asideFirst}{@render side()}{/if}
</div>
```

- **Default** (status cards, "Pay the supplier", the auto-lock form, …): always visible. The main content comes first in the DOM; at xl the aside is the right-hand column, below xl it follows the main content.
- **`collapsible`** (create panels only): at xl the right-hand column, always visible and sticky. Below xl it is hidden until opened, then shown **above** the list (`order-first`) with focus moved to its first field. The main content stays first in the DOM, so at xl the keyboard reaches the list before the panel.
- **`asideFirst`** (`/inventory/recipes`): the picker comes first in the DOM and on screen — the left column at xl, above the editor below xl.

**CreatePanel** — `section.rounded-card.border.border-line.bg-raise.shadow-card` with a header row (`h3.text-section` + icon, `border-b border-line-soft px-6 py-4`) and a body (`flex flex-col gap-4 p-6`). Below xl the page header shows the primary "Add …" button (`xl:hidden`) that opens the panel. Render it as `<a href="?add=1#{panel id}">` enhanced with an `onclick`, so it also works without JavaScript. The page starts with `asideOpen` true when the URL has `?add=1`, when the list is empty, or when the page has an action result for this form (success **or** failure), so after a submit — with or without JavaScript — the outcome is on screen.

**Where outcome messages go** (one rule for every page): an outcome `Alert` renders inside the card whose form produced it, above that form's fields — the CreatePanel, an edit card (`/employees/[id]`, `/purchases/[id]`, `/device`), the /menu inline editor — or in the ActionBar on pages that have one. Never at the top of the page, away from the button that was pressed. Still at most one `role="alert"` on the page: only the form that was just submitted shows its result.

**ActionBar** — sticky save bar for long forms:

```svelte
<div class="sticky bottom-0 z-20 mt-auto border-t border-line bg-raise shadow-floating">
  <div class="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-3 px-4 py-3 lg:px-8">
    {#if message}{@render message()}{:else}<p class="text-caption text-ink-2">{caption}</p>{/if}
    <div class="flex flex-wrap items-center gap-2">{@render children()}</div>
  </div>
</div>
```

Put it after `PageBody` inside `<main>`. `<main>` is `flex flex-1 flex-col` inside the `flex-col` root (§10), so `mt-auto` keeps the bar at the bottom of short pages at every width. The submit button inside it uses the `form="…"` attribute to submit the form above it. The page's outcome `Alert` goes into the `message` snippet, unchanged: a page that shows no success alert today still shows none (`e2e/fixtures.ts:319` asserts zero alerts after Save recipe).

**Callout** — attention banner with an action (the flagged-sales notice, the stock tripwire): `flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-st-offline bg-st-offline-bg px-5 py-4 text-st-offline` (danger variant: `border-danger bg-danger-bg text-danger`); glyph `font-mono text-title font-medium`, text column `flex min-w-0 flex-1 basis-72 flex-col gap-0.5` (title `h3.font-sans.text-section`, body `text-body`), then the action button. Standing notices use `role="status"`, not `role="alert"`. Fix the doubled glyph: `Alert`/`Callout` own the glyph; callers pass words only.

**StatTile** — `flex flex-col gap-1 rounded-card border border-line bg-raise p-4 shadow-flat`: `dt.text-eyebrow.uppercase.text-ink-3`, value (`text-section`, numbers `font-mono font-medium tabular-nums`), caption `text-caption text-ink-2`. Replaces the four hand-rolled Overview tiles.

**Small primitive fixes that affect layout consistency:**
- `Button`: default variant → `secondary` (so a primary is always chosen on purpose: one per view). **First audit every `<Button` without `variant=`** and make the intended primaries explicit: on `/menu` only the panel's main action (Add an item; Add a modifier group on the groups view) stays primary and Add a category / Add a modifier become secondary; on `/device` **Open the POS** is primary and Save auto-lock becomes secondary; on `/inventory/[id]` Save details stays primary, Add unit and Record opening stock become secondary. Also: `min-h-10 px-4`; hover and pressed styles on every variant; primary gets `border border-transparent` (no 2 px jump when disabled); merge a caller's `class` instead of dropping it.
- `Table`: header cells `px-6` (today `px-4`, `Table.svelte:25`) and body cells `md:px-6` (today only `md:pr-4`, `:40`), so every header sits over its values and both line up with the card title's 24 px inset; header row `bg-raise-2`; every header in the body face (numeric headers are mono today, `:26`). The caption stays `sr-only` (`primitives.test.ts` requires it); when a table needs a visible title (the /menu categories), put a heading above it.
- `Field` / `SelectField`: `disabled:` styles with the disabled pair (today a disabled input looks editable); a `numeric` variant (mono, right-aligned) for quantities and money inputs.

## 12 · Phase 7 — Apply the templates, page by page

| Route | Template | What moves where |
|---|---|---|
| `/dashboard` | PageBody | Header: title + description; the local date moves into a header meta chip ("Wednesday 30 September · 00:29 · Africa/Mogadishu"). Body: the flagged-sales **Callout** first with primary **Review them**; three StatTiles `grid gap-3 sm:grid-cols-3` (Setup, Recorded events, Selling — Selling keeps today's literal until Phase 9); then `grid items-start gap-6 xl:grid-cols-5` → Activity card `xl:col-span-3` (header row + divided list, rows `py-2.5`), Getting set up `xl:col-span-2` (progress bar; each step = glyph, title, its link or detail, and the **done / not started badge on every step** — `auth.spec.ts:81` counts six "not started" on a new restaurant). |
| `/employees` | PageColumns `collapsible` | Aside: CreatePanel "Add an employee" (Name, Role, PIN + Show PIN, Create employee; outcome inside). Main: Staff card (title + "5 people · 4 active" caption, Table). Header actions: Manage roles (secondary) + Add an employee (primary, `xl:hidden`). |
| `/employees/[id]` | PageColumns | Breadcrumb Employees › {name}. Main: Details, PIN cards. Aside: Status card (status, lockout, Deactivate/Reactivate with the consequence **above** the button). `update({ reset: false })` on the details form. |
| `/employees/roles` | PageColumns `collapsible` | Main: role cards `grid gap-6 lg:grid-cols-2`, each with an `h3` = role name, and `update({ reset: false })` on every role form (a reset re-submits unticked permissions). Aside: CreatePanel "New role". |
| `/menu` | PageColumns `collapsible` + tabs | Header `below` = tabs **Items n · Modifier groups n** (`/menu` and `/menu?view=groups`, server-rendered links, `data-current:` underline, `aria-current="page"` on the current one). **Items:** per category a visible heading (name + count) above a `Table` (sr-only caption; columns Item (+ tax caption), Modifier groups (chips), Price / Cost / Margin right-aligned mono, and an **Edit {name}** disclosure). The disclosure opens an inline editor row with Name, New price, Tax rate, the item's groups (detach ✕, "Attach a group"), "Edit recipe · cost 0.74", Save item / Cancel and the existing two-step "Archive {name}…", with `update({ reset: false })`. Aside: "Add an item" (primary) and "Add a category" (secondary); `?add=1` opens it. **Groups view:** groups with their modifiers (delta and cost in right-aligned columns) + aside "Add a modifier group" / "Add a modifier". |
| `/inventory` | PageColumns `collapsible` | Header `below` = section links (Recipes, Deliveries, Waste, Counts, Reports) — repeat them on **every** inventory sub-page. Tripwire as a danger Callout above the columns. Main: Ingredients table. Aside: CreatePanel "Add ingredient". |
| `/inventory/[id]` | PageColumns | Breadcrumb Inventory › {ingredient}. Main: movements, purchase units. Aside: Details, Opening stock, Archive (disclosure). One primary (Save details). |
| `/inventory/recipes` | PageColumns `asideFirst` | Picker as the aside (first), editor as main; the editor's Save in an ActionBar. Still no success alert after Save recipe. |
| `/inventory/waste` | PageColumns `collapsible` | Aside: the "Record waste" form. Main: recent waste. |
| `/inventory/counts`, `/inventory/counts/[id]` | PageBody + ActionBar | Count inputs in a table (numeric Field); **Post count** in the ActionBar with its blockers as the reason. |
| `/inventory/reports` | PageBody | Same report layout as `/reports`: range in the header actions, totals row, two-column card grid. |
| `/purchases` | PageBody | Header primary **Record a delivery**; full-width table card. |
| `/purchases/new` | PageBody + ActionBar | Breadcrumb Deliveries › Record a delivery (drop the ghost "All deliveries"). Cards: "Delivery" (Supplier, Business date, Paid by, Note in `md:grid-cols-2`), "Lines" (rows `md:grid-cols-3`). ActionBar: caption + **Add a line** (secondary) + **Record delivery** (primary, `form=` attribute). |
| `/purchases/[id]` | PageColumns | Main: facts, lines, payments. Aside: "Pay the supplier", "Reverse delivery" (danger, disclosure). |
| `/reports` | PageBody | Header actions = date navigation (`flex flex-wrap items-end gap-2`: Previous day, labelled date field, Show, Next day — aligned to the input). Callout for flagged sales. Totals card with six tiles `sm:grid-cols-3 xl:grid-cols-6`, values right-aligned. Breakdown cards in `grid items-start gap-6 xl:grid-cols-2`, each built on the `Table` primitive (today five hand-written tables; the mockup draws them with the primitive's classes). Sessions card last. |
| `/reports/flagged` | PageBody | One card per operation with an `h3` status line; Retry / Reason / Dismiss inside the card; the result shows in that card. |
| `/settings` | PageBody + ActionBar | Sections `grid gap-4 border-b border-line pb-8 lg:grid-cols-3 lg:gap-8`: description column + field card (`lg:col-span-2`, fields `md:grid-cols-2`) for Restaurant, Tax, Money and tenders; an info row linking to **POS device** for the auto-lock (the setup step needs it). Replace the two raw `<select>`s with `SelectField`; every other field keeps today's control. Save settings in the ActionBar with `form="settings-form"`. `update({ reset: false })` so unchanged fields stay filled after a save. |
| `/device` | PageColumns | Header primary **Open the POS** (explicit `variant="primary"`; when unavailable, the list of missing settings, each linked). Main: Registered device (Revoke disclosure). Aside: the auto-lock form (secondary Save), with `update({ reset: false })`. |
| `/login`, `/register` | AuthSplit | Below `lg`: the **form first**; the brand half becomes a compact band after it (eyebrow + statement; the specimen ticket `hidden sm:flex`). |

## 13 · Phase 8 — Tests and verification

### 13.1 Add `e2e/layout.spec.ts`

```ts
import { test, expect, type Page } from '@playwright/test';
// Reuse the helpers in e2e/fixtures.ts: register or sign in the owner, register the till, sign an
// employee in by PIN, open a session, add lines. `signInAsOwner` below stands for that helper.

const TILL = [
  { width: 1280, height: 800 },
  { width: 1280, height: 720 }, // Playwright's default, used by the rest of the suite
  { width: 1024, height: 768 },
];

async function expectNoDocumentScroll(page: Page) {
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight)).toBe(true);
}

async function expectTillBarFits(page: Page) {
  const bar = page.locator('[data-surface="pos"] > header');
  expect((await bar.boundingBox())!.height).toBe(64);
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
}

for (const viewport of TILL) {
  test.describe(`till at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('order: Pay and the unsynced count never leave the screen', async ({ page }) => {
      // …register the till, sign an employee in, open a session, go to /pos/order, add 12 lines…
      await expectNoDocumentScroll(page);
      await expect(page.getByRole('link', { name: /^Pay / })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('status', { name: 'Connection and sync' })).toBeInViewport();
      await expectTillBarFits(page);
    });

    test('offline: the bar stays one row', async ({ page, context }) => {
      // …same setup, then take the till offline and take one cash payment so the count is non-zero…
      await context.setOffline(true);
      await expect(page.getByText(/unsynced/)).toBeVisible();
      await expectTillBarFits(page);
    });

    test('keypad screens keep their closer on screen', async ({ page }) => {
      // /pos/session (open), /pos/pay with change, /pos/pin after a wrong PIN,
      // /pos/register after a refused sign-in, /pos/session (close) while blocked:
      // for each → await expect(closer).toBeInViewport({ ratio: 1 }); await expectNoDocumentScroll(page);
    });
  });
}

test.describe('dashboard on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('content starts under the top bar and nothing scrolls sideways', async ({ page }) => {
    await signInAsOwner(page); // the guard redirects to /login otherwise
    await page.goto('/dashboard');
    const title = page.getByRole('heading', { level: 2 }).first();
    expect((await title.boundingBox())!.y).toBeLessThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const menu = page.getByRole('button', { name: 'Open navigation' });
    for (let round = 0; round < 2; round++) { // the second round proves it opens again after Escape
      await menu.click();
      await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
      await expect(menu).toBeFocused();
    }
  });
});

test.describe('dashboard between 1024 and 1279 px', () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test('side columns that are not create forms stay reachable', async ({ page }) => {
    await signInAsOwner(page);
    await page.goto('/device');
    await expect(page.getByRole('button', { name: 'Save auto-lock' })).toBeVisible();
  });
});
```

### 13.2 Update existing tests for the deliberate changes

The master prompt keeps every accessible name unless this table changes it. Everything below is deliberate; update the named tests in the same commit.

| Change | Tests to update |
|---|---|
| Order type keys become `role="radio"` in a radiogroup "Order type" (names unchanged: Sit now / Waiting for a table / Takeaway) | `getByRole('button', { name: 'Sit now' })` → `getByRole('radio', …)` in `e2e/fixtures.ts` and the pos specs |
| Tender keys become `role="radio"` in a radiogroup "Tender" (today pressed buttons in a group "Tender"; names unchanged) | pay steps in pos-sale / pos-offline |
| Item keys drop the category prefix ("Mains Bariis Iskukaris 9.00" → "Bariis Iskukaris 9.00") and may add "Options" or "Tax 0%" | item clicks: match on the item name, e.g. `getByRole('button', { name: /^Bariis Iskukaris/ })` |
| The heading "Menu snapshot v21 · 6 items" becomes an sr-only heading "Menu" plus the caption "snapshot v21 · 6 items" | any assertion on that heading |
| The check's line table becomes a list; each line is a button (`aria-expanded`), and only the selected line shows its keys, now named with the item ("One fewer Shaah", "One more Shaah", "Remove Shaah") | the newest line is selected after every add, so its keys are already there — do **not** click its row (that collapses it). To change an older line, click its row first. Helper: click a row only when its `aria-expanded` is "false" |
| Modifier panel "Add" → "Add to order" | pos specs |
| Empty cart: the closer keeps the name **Pay** (disabled) with "Add an item first" beside it (today the closer is renamed) | pos-sale |
| Pay: the disabled closer keeps its name "Pay · Cash {total}" with "Enter the amount tendered" beside it (today it is renamed to the reason) | pos-sale / pos-offline |
| Session key name "Session · business date {date}" → "Session · business date {date} · Close session" | exact-name locators (a `/^Session · business date/` regex keeps working) |
| Close screen: "Continue" → "Back to the order" (secondary; hidden while closing); a one-line reason above Close session | pos-sale / pos-offline |
| PIN heading "Enter your PIN" → "Enter the PIN for {name}"; Sign in moves under the keypad | pos-offline and every step that signs in by PIN |
| Overview flagged-sales notice `role="alert"` → `role="status"` (Callout) | any `getByRole('alert')` on /dashboard |
| Rail rows "Purchases" → "Deliveries", "POS" → "POS device" | `sidebar.test.ts`, any e2e step clicking the rail |
| Below 1024 px the nav is in a drawer | phone-width e2e steps open "Open navigation" first |
| Menu: attach/detach/recipe/archive live inside **Edit {name}**; modifier groups on `?view=groups` | `e2e/inventory.spec.ts` and menu steps |
| Settings' Save lives in the sticky ActionBar (name unchanged) | none, unless a test scopes it to the form |
| Create panels are hidden below 1280 px until "Add …" | none at the default 1280×720 (`xl` starts at 1280) |
| The Overview keeps a badge on every step | none — `auth.spec.ts:81` (six "not started") must stay green |

Wording the mockups show that is **not** a change — keep today's text: "Amount due" (pay h1), "Back to the check", the Table placeholder "Table number or name, e.g. 4", the PIN hint "Enter at least 4 digits", the session blocker lines, "Recorded events". New wording this brief adds: "Add to order", "Back to the order", "Enter the PIN for {name}", "Not {first name}? Choose your name", "Can't close yet: …", the warnings chip and the ActionBar captions.

### 13.3 Visual check

Open each page at the sizes of the mockups and compare with `screens/*.png`. Check the dark theme on every dashboard page (the tokens already cover it; look for hard-coded light assumptions such as the rail frame colours).

## 14 · Phase 9 — Optional follow-ups (not part of this job)

Stop after Phase 8. These need server or data changes; do them as separate PRs only when the owner asks. Each comes from the reference's design review.

1. The Overview reads the sessions table for **Selling** and for "Open the first POS session" (both are literals today; the mockup shows the result). Reword the "Dining tables" step ("A table is a free-text label typed on the till for now.").
2. Disable Pay / Card / Close session **before** the tap for an employee without the permission, with the reason on the key ("Ask a cashier to take payment").
3. Keep the lines when a tender is refused or cancelled ("Back to order" promises it).
4. Plural-aware counts ("1 sale", "1 operation still syncing" — the mockups already show them).
5. `+error.svelte` inside the dashboard shell with a way back.

## 15 · Definition of done

- [ ] No till screen scrolls the document at 1280×800, 1280×720 or 1024×768; every closer (Pay, Pay · {tender}, Open session, Close session, Sign in, Register this device, Add to order, New sale, Done) is fully visible in every state, including errors and blocked states.
- [ ] The unsynced count and Online/Offline are visible on every till screen; a non-zero count is `◆` in the offline pair; extra warnings share one chip.
- [ ] The till bar is one 64 px row with no overflow at every width down to 390 px, online and offline.
- [ ] `/pos/order` and `/pos/pay` render the same `Check`; the pay screen shows modifiers, unit price and tax rate per line.
- [ ] One `Keypad`, one `Closer`, one `TillBanner`, one `Icon` set, and the key classes from `keys.ts`; no duplicated key class strings in the route files.
- [ ] Dashboard: the rail is full height at ≥1024 px; below it a 56 px bar and a drawer that opens again after Escape; the page title is within 120 px of the top on a phone.
- [ ] No create form sits below its list; side columns that are not create forms are visible at every width; long forms have a sticky ActionBar; outcome messages appear in the card or bar of the form that produced them.
- [ ] Every dashboard page uses `PageHeader` + `PageBody` (or `PageColumns`) with `max-w-page`, centred.
- [ ] Focus ring ≥ 3:1 on the rail and the till bar (census pair `rail-ring` on `rail`) and the normal ring inside light panels; skip link present; one `role="alert"` per page; no repeated ids.
- [ ] No arbitrary values, raw hex or touch tokens outside the till; all unit and e2e tests green, including `e2e/layout.spec.ts`.
- [ ] `docs/design-system.md` §7b updated: shell, page templates, stacking scale, the sticky-bar rule, and "the till never scrolls the document".
