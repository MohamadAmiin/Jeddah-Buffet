# matcami — UI/UX design samples

Open `index.html` in a browser. No build step, no server: every file opens straight from the
filesystem, the same choice `docs/pos-layout-grammar.html` makes.

## What these are

A **visual specification** of the design system that `tasks/ui-design-system/` implements. They exist
so the plan's token decisions can be judged by looking at them rather than by reading hex values —
and so the token set gets tested against real screens _before_ anyone writes Svelte.

That test is the point. Every sample links `tokens.css` and **contains no colour value of its own**.
If a screen needed a colour the token set does not have, that is a gap in the design system, and it
shows up here as a missing token rather than three months later as a hardcoded hex in a component.

## What these are NOT

- **Not application code.** Nothing here is imported by `src/`. The app's real tokens live in
  `src/lib/styles/tokens.css` and reach components through Tailwind v4's `@theme` / `@theme inline`.
  This directory restates the same values as plain CSS so the files stand alone.
- **Not a component library.** The real primitives are `src/lib/components/ui/`.
- **Not a commitment to POS layout.** Samples 04 and 05 show the _grammar_ — the permanent guest
  check, the status vocabulary, the touch floors, the offline rules. They do **not** fix a screen
  size or a breakpoint set, because spec 33 open decision 1 (one shared counter device, or a tablet
  as a second registered terminal) is unanswered and is what sets the target hardware.

## The samples

| File                  | Surface     | What it demonstrates                                                                                           |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `01-foundations.html` | all three   | The system made visible — surfaces, palette, type roles, money, status marks, controls, elevation, touch scale |
| `02-dashboard.html`   | dashboard   | The owner's shell, the onboarding checklist and the settings form                                              |
| `03-auth.html`        | dashboard   | Sign-in (including its error state) and first-run registration                                                 |
| `04-pos-order.html`   | **POS**     | The order screen: permanent guest check, category tabs, item statuses, the 96px closers                        |
| `05-pos-payment.html` | **POS**     | Tender, the offline rules made visible, and the owner-PIN approval dialog                                      |
| `06-receipt.html`     | **neither** | 32- and 48-character ESC/POS output, and a `COPY` reprint                                                      |

## Three surface states, one vocabulary

The thing to look at first. Token **names** are identical everywhere; only their values differ:

- **light** — the bare `:root`, the complete palette
- **dark** — `prefers-color-scheme`, plus a `[data-theme="dark"]` stamp so an explicit choice wins
- **POS** — `[data-surface="pos"]`, a **light** device surface, **pinned in both themes**

**The POS surface rule flipped twice on 2026-09-14, and both flips are worth knowing.**

It began **dark in both themes** (dark cuts counter glare, keeps the keys the brightest thing on
screen). That broke: the inks kept theming, so light-theme ink on the permanently dark shell measured
**1.08:1** — black on black.

The user then reviewed a light-mode commercial POS reference and chose **light**. The glare argument
was raised once and overruled. The first attempt at that made the POS _follow the theme_ — which put
it straight back in the hole from the other side: on a dark-mode machine, `--c-ink` `#e6eaec` on the
white key face measures **1.21:1**.

**The lesson, which is the whole finding: pinning a surface means pinning EVERY token on it, not just
the grounds.** So `[data-surface="pos"]` now declares the complete palette — grounds, inks, accent,
status, both aliases and the shadow rungs — and no dark block overrides any of it. The till is a
device: its surface is a property of the hardware on the counter, not of the viewer's OS preference.
The dashboard themes; the POS does not.

`CLAUDE.md` still says the shell stays dark in both themes — **that line and this directory
disagree**, and `tasks/ui-design-system/` carries the correction.

One hard consequence of going light, measured: a white key on the POS ground is only **1.22:1**, so
elevation alone cannot carry its edge. WCAG 1.4.11 asks 3:1 of a UI component boundary, so **every
key takes a `--c-control-line` border** (4.73 on the ground). A shadow-only key is pretty and
non-compliant.

**The samples open in light.** Each page carries `data-theme="light"` so the first view is the design
as drawn, whatever your OS is set to. The **Toggle theme** button in the bar flips the dashboard and
auth pages to dark — the POS deliberately will not move.

## Contrast

Every ink × ground pair, in all three states, was computed by WCAG relative luminance and clears the
4.5:1 floor. Boundaries clear 3:1 per WCAG 1.4.11.

| State | Pairs | Failures | Tightest                   |
| ----- | ----- | -------- | -------------------------- |
| light | 182   | 0        | 4.55 — `ink-3` on `bg-2`   |
| dark  | 182   | 0        | 4.62 — `ok` on `st-new-bg` |
| POS   | 182   | 0        | 4.60 — `danger` on `raise` |

Four palette values differ from what is on `feat/dashboard-ui-redesign` today, and each is a value
`tasks/ui-design-system/` task **T-06** changes: light `--c-ink-3`, dark `--c-ink-3`, dark `--c-ok`,
dark `--c-danger`. Together they close 30 measured failures.

## Two rules worth understanding before reading any sample

**Colour never carries meaning alone.** Every status is a colour _and_ a glyph — item `NEW ◇` /
`SENT ▲` / `VOIDED ✕`, order `OPEN ○` / `BILLED ◐` / `PAID ●` / `REFUNDED ↩`, sync `● online` /
`◆ offline`. Roughly one man in twelve has red-green colour vision deficiency, and a counter screen
is read under glare (WCAG 1.4.1).

**Money is always mono, tabular-nums, right-aligned.** Negatives get a leading `−` _and_ the danger
colour — never colour alone. Every amount in these samples is a static display string: the UI never
does money arithmetic and never rounds, because one rounding rule lives in one function shared by the
POS, the server and the reports.

## Fonts

The samples load Archivo and IBM Plex from Google Fonts, as `docs/pos-layout-grammar.html` does. That
is fine **here** and would be a bug in the app: these are documents a human opens in a browser, not
the offline POS, which self-hosts all three from `@fontsource` packages so it keeps working with no
network.
