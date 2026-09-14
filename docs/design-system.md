# matcami — design system

Two surfaces, one token set.

| | **POS** `routes/(pos)/` | **Dashboard** `routes/(dashboard)/` |
|---|---|---|
| Used by | cashier / waiter, standing, at speed | owner, seated |
| Input | touch, gloved or greasy hands | mouse and keyboard |
| Network | MUST work offline (spec 6) | online only |
| Density | large targets, few of them | dense tables and forms |
| Body size | `text-pos` 17px | Tailwind default `text-base` |
| Target size | `p-touch` 64px / `touch-lg` 72px | Tailwind default scale |

They share `src/lib/styles/tokens.css` and diverge only in scale. Two design languages, one vocabulary.

**`src/lib/styles/tokens.css` is the single source of truth**, imported by `src/app.css` right after `@import 'tailwindcss'`. A raw hex, a px font-size or an arbitrary Tailwind value (`bg-[#123456]`, `p-[57px]`) in a component is a bug — add a token instead. This document explains the tokens; it does not duplicate their values.

**Styling is Tailwind CSS v4** — a user decision recorded in `tasks/project-init.md`, configured entirely in CSS via `@theme`. There is no `tailwind.config.js` and there must not be one. The file has three layers:

1. the raw palette as plain `--c-*` custom properties, which the theme swaps;
2. `@theme inline { --color-raise: var(--c-raise) }` — exposing them as utilities. **`inline` is required**: plain `@theme` bakes the light value into the utility, while `inline` emits `var(--c-raise)` so `bg-raise` follows the theme;
3. plain `@theme` for static things — fonts, the touch scale, `--text-pos`, `--text-total`.

You write `bg-raise`, `text-ink-2`, `border-line`, `shadow-card`, `min-h-touch-xl`, `font-mono`. Tailwind tree-shakes unused tokens, so a token you add here produces no CSS until a component uses it — that is expected, not a failure.

Visual reference: `docs/pos-layout-grammar.html` (open in a browser) — the researched QSR layout grammar with adopt/adapt/reject verdicts.

---

## 1. Principles

1. **Money is the most important thing on screen.** The total, the line prices, the change due. Everything else is chrome around them.
2. **Colour never carries meaning alone.** ~1 in 12 men has red-green colour vision deficiency, and a counter screen is read under glare. WCAG SC 1.4.1, Level A.
3. **The cashier must never navigate away to see what has been rung in.** This is the one rule every POS vendor states outright.
4. **Destructive actions are fast to reach deliberately and hard to hit by accident.** Those pull in opposite directions; resolve it with separation and confirmation, never by hiding.
5. **Degraded state is permanent chrome, not a toast.** A toast that was missed is indistinguishable from one that never fired.

---

## 2. The theme contract

Light is the default. The viewer has **three** states, not two:

```css
:root { /* the COMPLETE light palette — every token declared here */ }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark overrides; explicit light still wins */ }
}

:root[data-theme="dark"] { /* explicit dark wins over a light OS */ }
```

**Every token must exist in the bare `:root`.** A colour whose only definition sits inside a media query or a `[data-theme]` block does not apply in the un-stamped state, and the page renders one theme's text on the other theme's ground.

**There is a FOURTH state: the POS.** `[data-surface="pos"]`, stamped on the `(pos)` route group, is a *device surface* — its appearance is a property of the hardware on the counter, not of the viewer's OS preference. It is **LIGHT and PINNED in both themes**. The dashboard themes; the till does not.

*(Reversed 2026-09-14. The shell was dark in both themes, for glare; that argument was raised and overruled. The four tokens `--screen`, `--key`, `--key-line`, `--key-ink` are RETIRED — once the scope re-declares the ordinary ground names there is nothing left for them to do, and two vocabularies for one surface is what the scope removes. `src/lib/styles/tokens.test.ts` asserts they do not come back.)*

**The scope pins the COMPLETE palette, not just the grounds.** This has been got wrong twice, in opposite directions, and each failure had the same shape — a surface pinned one way with inks that still themed: pinned dark with light inks put `--c-ink` on the shell at **1.08:1**; pinned light with dark inks put it on the key face at **1.21:1**. If a dark block themes a token, the POS scope declares its own value for it.

**Aliases must be re-declared inside the scope.** A custom property's `var()` is substituted at **computed-value time on the element that declares it**, and the resolved literal is what inherits. The dark blocks need no copy — they target `:root`, the same element. `[data-surface="pos"]` is an element inside `<body>`, so an alias declared above it never recomputes there: without its own line, `--c-ring` inside the till stays the *page* accent.

**A white key on the POS ground is 1.22:1**, so elevation alone cannot carry a control's edge. Every pressable POS surface takes a `border-control-line` boundary; `--c-line` is decorative only. WCAG 1.4.11.

---

## 3. Domain status — colour plus a glyph, always

Every status token has a non-colour companion. Use both, every time.

| Domain | State | Token | Glyph | Extra signal |
|---|---|---|---|---|
| Item (spec 13) | `NEW` | `--st-new` | `◇` | freely editable |
| | `SENT` | `--st-sent` | `▲` | removal is a void, not a delete |
| | `VOIDED` | `--st-voided` | `✕` | **struck through** + reason + approver |
| Order (spec 13) | `OPEN` | `--ink-2` | `○` | |
| | `BILLED` | `--st-billed` | `◐` | adding an item re-opens it |
| | `PAID` | `--st-paid` | `●` | terminal; re-open needs owner PIN |
| | `VOIDED` | `--st-voided` | `✕` | |
| | `REFUNDED` | `--st-voided` | `↩` | |
| Table | free | `--ink-3` | `○` | outline only |
| | occupied | `--accent` | `●` | filled, **with the open amount** |
| Sync (spec 6) | online | `--ok` | `●` | |
| | offline | `--st-offline` | `◆` | **plus the unsynced count** |

---

## 4. Typography

- **Archivo** — display, headings only.
- **IBM Plex Sans** — body. Drawn for an equipment maker; the right provenance for a till.
- **IBM Plex Mono** — **all** money, quantities, account codes, invoice numbers, IDs and receipt previews.

**A price set in the body face is a bug.** Money and quantities always use `--font-mono` with `font-variant-numeric: tabular-nums`, so digits align down a column and a cashier can scan a check without reading it.

Tailwind's default type scale covers the dashboard. Two tokens are added because the default has no equivalent: `text-pos` (17px — POS body, read standing at arm's length) and `text-total` (40px — the order total, the most-read number on the screen). Headings get `text-wrap: balance`.

---

## 5. Touch targets

| Token | Size | Use |
|---|---|---|
| Token | Utility | Size | Use |
|---|---|---|---|
| `--spacing-touch-min` | `p-touch-min`, `min-h-touch-min` | 56px | absolute floor anywhere on the POS (~10mm) |
| `--spacing-touch` | `p-touch` | 64px | standard POS target — **set by T-04, already in use** |
| `--spacing-touch-lg` | `min-h-touch-lg` | 72px | menu keys, function rail |
| `--spacing-touch-xl` | `min-h-touch-xl` | 96px | **Pay**, **Send to kitchen** — the one-touch closers |

The dashboard uses Tailwind's default spacing; it is seated, mouse-driven work. Spacing between targets independently reduces mis-taps — keep at least `gap-2` between POS keys.

Touch-accuracy research puts the floor near **9.2mm** and shows error rate flattening around **10mm**; standing-kiosk guidance goes to **20mm**. Apple's 44pt and Material's 48dp assume a seated user holding the device — both are **too small** for a counter.

**Verify in millimetres on the real hardware, not in pixels in a browser.** Real POS terminals ship at ~500 nits with anti-glare coating and optical bonding; a web app on a generic tablet will be dimmer and harder to read than whatever it replaces. That is a procurement constraint, not a CSS one.

---

## 6. Money rendering

One formatter, in `src/lib/server/money`, integer cents in and a string out (invariant 1). The UI **never** does money arithmetic and **never** rounds — invariant 7 gives exactly one rounding rule in one function, shared by POS, server and reports. A second rounding in a Svelte component is the bug that makes the receipt disagree with the books.

- Right-align money in any column.
- Negative amounts (refunds, pay-outs, discounts) get a leading `−` **and** `--danger` — never colour alone.
- Each line renders the price and tax rate **stored on that line**, never a recomputed current price (invariant 7).
- The total gets `--text-total`. Subtotal, discount and tax sit above it in `--ink-2`, smaller.

---

## 7. POS component rules

**The guest check is permanent.** It occupies a fixed region and never unmounts. Category tabs and the item grid swap *around* it. Modals are reserved for exceptions only — reason codes, owner approval, errors — never for ordinary ordering.

**Categories are tabs, not drill-down-and-back.** Generate the grid from the menu snapshot (spec 5); never hand-place buttons, which creates a second source of truth that drifts from the menu version.

**The offline indicator is permanent chrome** carrying the unsynced count (spec 6 mandates it on screen at all times). When the queue is non-empty, logout and session close are blocked — the disabled control must *say why*, not sit dead.

**Tenders.** Quick tenders in two flavours: exact amount due, and next-highest-dollar. Card and mobile **cannot** auto-complete offline (invariant 5) — those buttons visibly disable with a reason; they must never fail *after* the tap.

**Owner-PIN actions** (invariant 9: refund · void of a SENT item · discount above limit · comp · re-open a paid order · drawer without a sale · pay-out above limit · void of an order with SENT items) are visually separated from ordinary functions. The approval dialog captures reason code and approver identity together (invariant 10) — reason codes are mandatory and are never made optional.

**Worth stealing from the incumbents:** a persistent manager-mode state signalled by a border around the whole screen; and a battery interlock that blocks opening a check below 5%, warns at 15%, logs both, and cannot be dismissed — a tablet dying with unsynced operations is the worst case, and it is preventable in the UI.

---

## 7b. Dashboard component rules

The dashboard is the owner's surface: seated, mouse-driven, online only (spec 7). It shares the token set with the POS and diverges in scale — **Tailwind's default spacing and type scale throughout**. The POS touch tokens (`p-touch`, `min-h-touch-xl`, `touch-min`, `touch-lg`) and the POS chrome tokens (`--c-screen`, `--c-key`, `--c-key-line`, `--c-key-ink`) **MUST NOT appear on any dashboard screen**. These rules are implemented once, in `src/lib/components/ui/`; a screen composes those primitives rather than retyping class strings.

**Page skeleton.** A dashboard page is a `PageHeader` — heading, optional one-line description, optional action area — and then content. Content width is capped by `--container-page` (utility `max-w-page`), so a page stops at a readable measure instead of stretching across a wide monitor.

**Surface hierarchy.** `bg-bg` is the page ground. `bg-raise` is a card or panel. `bg-raise-2` is an inset region nested *inside* a card. The header bar is `bg-raise` with a `border-line` bottom edge.

### Legal ink-on-surface pairs

**Check this table before pairing an ink with a surface. Adding a new pair means measuring it.** Ratios are WCAG relative luminance computed from the hex values in `src/lib/styles/tokens.css`. Every rule is the **intersection of both themes**, so no screen has to be reasoned about twice.

| Ink | Legal on | Light | Dark |
|---|---|---|---|
| `text-ink` | every surface | 13.63–17.33 | 10.83–14.72 |
| `text-ink-2` | every surface | 5.91–7.51 | 6.15–8.35 |
| `text-ink-3` | **`bg-raise` ONLY** | 5.13 | 4.87 |
| `text-ok`, `text-danger` | `bg-bg` and `bg-raise` **only** | 5.47–6.65 | 4.65–5.68 |
| the six `--c-st-*` | `bg-bg` and `bg-raise` | 5.14–6.65 | 6.23–10.60 |
| `text-accent-ink` | `bg-accent` | 6.13 | 7.82 |

**There are none left.** `src/lib/styles/tokens.test.ts` recomputes the full census on every `pnpm test:unit` run — every ground token against every ink token, in every surface state — and a pair below WCAG 1.4.3's 4.5:1 fails the suite. The grounds are `bg`, `bg-2`, `raise`, `raise-2`, `accent-soft`, `ok-bg`, `warn-bg`, `danger-bg` and the six `st-*-bg`; the inks are `ink`, `ink-2`, `ink-3`, `accent`, `ok`, `warn`, `danger` and the six `st-*`. **Zero fail**, in light, in dark, and on the POS surface.

*(Until 2026-09-14 this section listed twelve failing pairs and narrowed the legal ones around them — `text-ink-3` on `bg-raise` only, `text-ok` and `text-danger` off `bg-raise-2` and `bg-accent-soft`. The census over all fourteen grounds actually found **thirty**: the earlier sweep omitted the six `st-*-bg` grounds. Four token values closed all thirty — light `--c-ink-3` to `#5c6771`, dark `--c-ink-3` to `#97a0a8`, dark `--c-ok` to `#6eac81`, dark `--c-danger` to `#df877c` — so the restrictions are gone and every ink is legal on every ground.)*

**A failing pair is repaired by re-solving the token's VALUE and re-running the census — never by narrowing which pairs a screen may use.** A hand-written list of legal pairs is how thirty real failures stayed hidden: it simply did not name them.

**Control borders.** An interactive control — a text input, a select, the secondary button's outline — draws its boundary with `border-control-line` (`--c-control-line`, derived from `--c-ink-3`): **5.78:1** light and **4.87:1** dark, both above the **3:1** WCAG 1.4.11 asks of a UI component boundary. `border-line` measures **1.58:1** on `bg-raise` and is for **DECORATIVE** edges only — card outlines, dividers, the header rule. The two are separate because a form control whose only boundary is a 1.58:1 line is effectively unbounded, and that is a large part of why an unstyled dashboard reads as washed out.

**Focus.** Every interactive element shows a `:focus-visible` ring: `2px` `outline` in `--c-ring`, with `2px` `outline-offset`. `--c-ring` derives from `--c-accent` and measures **5.21:1** on light `bg` and **7.49:1** on dark `bg`. **Never remove a focus ring without replacing it.**

**Button variants.** Four, and no more.

| Variant | Treatment | Use |
|---|---|---|
| `primary` | `bg-accent` / `text-accent-ink` (6.13 light, 7.82 dark) | **one per view** — the view's main action |
| `secondary` | transparent ground, `border-control-line`, `text-ink` | everything else |
| `ghost` | text only, `text-ink` | tertiary actions, navigation |
| `danger` | `--c-danger` as ink and border | destructive actions; none exists on the dashboard yet |

**A disabled control must SAY WHY.** That rule is §7's and applies here identically — a control disabled without a stated reason sits dead.

**Form field anatomy.** In order: label above the control, then the control, then the hint, then the error. **The label's text IS the control's accessible name**, so it is the plain field name — no required asterisk, no suffix, no marker of any kind inside the `<label>` element. Mark required-ness with the `required` attribute on the control. Errors use `role="alert"`, and **at most one `role="alert"` region is visible per page at a time**.

**Card.** `bg-raise`, `border-line`, `rounded-card`, `shadow-card`, generous internal padding (`p-6` on the default scale). **Cards do not nest inside cards** — an inset region uses `bg-raise-2` with `rounded-control`.

**Empty and not-started states.** A glyph plus text, never colour alone. Reuse §3's glyph vocabulary rather than coining new marks; the dashboard's only status today is onboarding-step completion (`●` done, `○` not started).

**Navigation.** The current page carries `aria-current="page"`. An unavailable destination is `aria-disabled="true"` with **NO link target** and a **visible reason** — never a hidden item, and never a dead link that 404s.

**Typography.** `font-display` for headings, `font-sans` for body, `font-mono` for money, quantities, account codes, invoice numbers and IDs. Headings get `text-wrap: balance`. As §4 says: **a price set in the body face is a bug.**

**What must NOT appear on a dashboard screen.** The POS touch tokens; the POS chrome tokens; an arbitrary Tailwind value (`bg-[#123456]`, `p-[57px]`); a raw hex; and **any money figure at all** for as long as `src/lib/server/money/` exports no formatter — check that directory before writing one, and if it holds only a `README.md`, a money figure here could only be hardcoded, which §6 and invariants 1 and 7 forbid.

**Responsive.** Single column below Tailwind's `md`; the navigation collapses above the content. **Nothing scrolls horizontally at any width.**

---

## 8. Receipts are a separate problem

Thermal ESC/POS output is not a screen (spec 11). Fixed **32 or 48 characters** per line, no colour, no images, monospace only. Reprints are marked `COPY`; a voided SENT item prints a `VOID` ticket to the kitchen. None of the tokens above apply — plan receipt layout in characters, and preview it in `--font-mono` at the target width.

---

## 9. Accessibility floor

- **WCAG AA, 4.5:1** at normal text size, for every text-on-surface pair, in **both** themes. Verified values are noted in `tokens.css`.
- Colour is never the only carrier of state (§3).
- Counter and kitchen noise routinely reaches 85 dBA — **audio can never be the primary confirmation channel**.
- Every interactive element has a visible `:focus-visible` state.
- `prefers-reduced-motion` is honoured (already in `tokens.css`).

Check a pair before adding it — relative luminance per WCAG:

```
L = 0.2126·R + 0.7152·G + 0.0722·B   (linearised sRGB)
ratio = (L_lighter + 0.05) / (L_darker + 0.05)
```

---

## 10. Where this came from

The layout grammar is drawn from NCR Voyix's *Aloha Quick Service* manuals and Oracle's *Simphony POS User Guide*, both of which publish annotated screenshots and pixel-level grid specifications, plus operator reports of what actually goes wrong. `docs/pos-layout-grammar.html` carries the full study with sources and per-convention verdicts.

Open questions that touch design: spec 33 decision 1 (one device or a second terminal) sets the target resolution; decision 3 (tax mode) changes what the check displays; decision 6 (approval limits) sets when the approval dialog appears.
