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

**The POS terminal chrome is exempt.** `--screen`, `--key`, `--key-line`, `--key-ink` stay dark in both themes. The POS shell is a *device surface*, not page chrome: dark reduces counter glare and keeps the key faces the brightest thing on screen. Do not theme them.

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
