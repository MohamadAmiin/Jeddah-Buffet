# Phase 4 — Dashboard UI

The owner's management surface: a shell, an overview that tells them what to do next, and the one
settings page this plan can actually deliver. Online only.

**Depends on:** Phase 3 (T-17 for the locals and the guard, T-16 for the settings module).

Read `00-overview.md` first for the requirements, assumptions and the file-tag convention.

**Rules that bind every task in this phase**, from `docs/design-system.md` and
`src/lib/styles/tokens.css`:

- Every colour, size and type value comes from a token. Write `bg-raise`, `text-ink-2`,
  `border-line`, `shadow-card`, `font-display`. An arbitrary value such as `bg-[#123456]` or
  `p-[57px]` in a component is a bug; add a token to `tokens.css` instead.
- The dashboard uses **Tailwind's default spacing and type scale**. It is seated, mouse-driven work.
  The POS touch tokens (`p-touch`, `min-h-touch-xl`) and the POS chrome tokens (`--c-screen`,
  `--c-key`) belong to the other surface and must not appear here.
- Light is the default; dark comes from the existing three-state theme contract in `tokens.css`.
  Every pair of text and surface colours must meet WCAG AA at normal size, in both themes.
- **Colour never carries meaning alone.** Pair every status with a glyph. This plan's only statuses
  are onboarding steps; use a done glyph and a not-started glyph, not green and grey alone.
- The UI does no money arithmetic and displays no money. The money module does not exist.
- Every load function and every action calls its own guard, even though the hook already guards the
  group (invariant 8).

---

### T-21 — The `(dashboard)` shell layout

**Needs:** T-17
**Files:**
- `src/routes/(dashboard)/+layout.server.ts` — NEW
- `src/routes/(dashboard)/+layout.svelte` — EDIT (the file exists and contains only comments
  describing the group's rules; keep those comments and add the shell below them)
- `src/routes/+page.svelte` — EDIT (the landing page exists with two placeholder links pointing at
  `/`; point them at the real routes)
**Spec:** 7 (the owner enters the management dashboard), 26 (the reports the navigation anticipates:
sales, POS, inventory, finance, accounting), 8 (permissions)
**Invariants:** 8 (every route checks server-side, reads included)

**Do:**

1. `+layout.server.ts`: call `requirePermission(event, 'admin.settings')` — the capability that means
   "may use the management dashboard" in this plan — then return only what the shell renders:
   the restaurant name, the owner's display name and their role. Nothing more.

   **Return an explicit object literal.** Do not spread `locals.user` into the payload: SvelteKit
   serialises load data into the page HTML and into `__data.json`, and a widened projection later
   would publish whatever `Principal` grows into. T-12 already narrows the query; this is the second
   layer.

2. `+layout.svelte`: build the shell around `{@render children()}`. Keep the existing comments at the
   top of the file; they record why this group is online-only and why its permission checks are
   server-side.

   - **Header:** the restaurant name in `font-display`, the owner's display name, and a logout
     control. The logout control is a `<form method="POST" action="/logout">` with a submit button —
     never an anchor, because `/logout` refuses `GET` and a link would be triggerable by any image
     tag on any page.
   - **Side navigation:** one entry per dashboard permission key from `src/lib/server/permissions/
     keys.ts`, in the order an owner sets the restaurant up: Overview, Settings, Employees, Menu,
     Inventory, Purchases, Expenses, Reports, Devices.
   - Overview and Settings link to the real routes. **Every other entry renders as disabled with a
     visible "coming soon" label** — not as a dead link that 404s, and not as a hidden item that makes
     the owner wonder whether the product has those features. A disabled control must say why; that
     rule comes from the design system and applies here as much as it does on the POS.

3. Mark the current page in the navigation with `aria-current="page"`, and make the disabled entries
   genuinely non-interactive: `aria-disabled="true"` and no link target, so a keyboard user does not
   tab into a control that does nothing.

4. Responsive: the navigation collapses above the content on narrow screens. The owner may open this
   on a phone to check something; nothing here should scroll horizontally.

5. In `src/routes/+page.svelte`, change the two placeholder links. The first points at `/dashboard`
   and the second at `/login`. Leave the `<h1>` text intact: project-init's Playwright smoke test
   asserts on it.

**Tests:** guard coverage comes from T-20's walk, which will now see this `+layout.server.ts` and
require its guard call. Write no snapshot test of the markup.

**Done when:** an owner session renders the shell with the restaurant name; the logout button posts
and works; disabled navigation entries are visibly disabled, labelled, and not focusable as links;
`pnpm check && pnpm lint` exits 0; and `grep -nE '\[#|\[[0-9]+px\]' src/routes/\(dashboard\)/` finds
no arbitrary values.

**Watch out:** the layout server load runs for every page in the group, so anything expensive added
here is paid on every navigation. Keep it to the one query it needs, and resist the temptation to
preload counts for the navigation badges — there is nothing to count yet, and spec 27 says plain
indexed SQL until a report is measurably slow.

---

### T-22 — `/dashboard` overview and the onboarding checklist

**Needs:** T-16, T-21
**Files:**
- `src/routes/(dashboard)/dashboard/+page.server.ts` — NEW
- `src/routes/(dashboard)/dashboard/+page.svelte` — NEW
**Spec:** 26 (the reports this page will eventually carry), 10 (the end-of-day report and cashier
sessions, named in the checklist as later steps), 31 (the MVP feature list the checklist mirrors)
**Invariants:** 8 (server-side check on this read), 11 (business date is the POS session's date —
nothing here computes one)

**Do:**

1. `+page.server.ts`: call `requirePermission(event, 'admin.settings')`, then call
   `settingsComplete(locals.restaurantId)` from `src/lib/server/restaurants/`. Return the checklist
   state and the restaurant name. Take the restaurant id from `locals.restaurantId`, which T-17 sets
   for dashboard routes only.

2. Render an onboarding checklist naming the real sequence of work, in order:

   | Step | State today |
   |---|---|
   | Restaurant settings | computed by `settingsComplete()` |
   | Employees and PINs | not started |
   | Menu, categories and modifiers | not started |
   | Dining tables | not started |
   | Register the POS device | not started |
   | Open the first POS session | not started |

   Only the first is computable, because only its feature exists. Show the rest as "not started" with
   one line saying what each will do. Do not fake progress and do not link them to routes that do not
   exist.

3. Compute the first step's state through `settingsComplete()` rather than by checking that a settings
   row exists. The row is created by registration, so an existence check would always say done — and
   the moment a later plan adds a required setting such as tax mode or currency, an existence check
   would keep saying done while the restaurant is not in fact configured, and the owner would open
   their first POS session with a tax mode nobody chose. `settingsComplete()` is the extension point;
   T-16 records that every later plan must add its required fields to it.

4. Pair each state with a glyph as well as a colour: a done mark and a not-started mark, using the
   status tokens from `tokens.css`. Colour alone fails WCAG 1.4.1, and roughly one man in twelve has
   red-green colour vision deficiency.

5. **Show no money figures at all.** Not revenue, not today's takings, not a zero. The money module
   does not exist, the UI never does money arithmetic, and a zero on a dashboard is indistinguishable
   from a broken query. When sales reports arrive they come with their own plan and their own
   formatter.

6. Where the page has a natural place for "what happens next", say in plain words what the owner
   should do: finish settings, then add employees, then build the menu. That is the business workflow
   this whole feature exists to start.

**Tests:** T-20 covers the guard. Add no unit test of the checklist markup; its one piece of logic
lives in `settingsComplete()`, which T-16 tests.

**Done when:** `/dashboard` renders for an owner with the restaurant name and six checklist entries;
the settings entry reflects `settingsComplete()`; no currency symbol or numeric total appears
anywhere on the page; and each status carries a glyph as well as a colour.

**Watch out:** resist adding a count of employees or menu items "since it is easy". Those tables do
not exist, the query would not compile, and the checklist is deliberately built to be correct before
them rather than rewritten after.

---

### T-23 — `/settings` page

**Needs:** T-16, T-21
**Files:**
- `src/routes/(dashboard)/settings/+page.server.ts` — NEW
- `src/routes/(dashboard)/settings/+page.svelte` — NEW
**Spec:** 17 ("the restaurant's time zone is a setting"), 3 (sensitive actions are audit-logged), 8
(permissions; 403)
**Invariants:** 8 (the check goes in the action as well as the load), 10 (the audit row is written in
the same transaction as the change), 11 (timestamps UTC; the time zone is a setting)

**Do:**

1. `load`: call `requirePermission(event, 'admin.settings')`, then return the restaurant's current
   name and time zone from `getRestaurantWithSettings(locals.restaurantId)`. Also return a list of
   time-zone suggestions built from `Intl.supportedValuesOf('timeZone')` for the picker — as
   **suggestions only**. The validator is `isValidTimeZone`, which works by construction, because that
   list omits `UTC`, `Asia/Kolkata`, `Europe/Kyiv` and others that are perfectly valid.

2. The default action:
   - calls `requirePermission(event, 'admin.settings')` **again**, in the action itself. A form action
     is a separately reachable POST endpoint; guarding only the `load` leaves it open. Invariant 8
     says a form action with no permission check is unfinished;
   - parses with zod: name non-empty and length-bounded, time zone a non-empty string;
   - calls `updateSettings(tx, locals.restaurantId, changes, ctx)` in one transaction, which writes
     the change and the `settings.updated` audit row together with the old and new values;
   - returns a success message, or `fail(400, ...)` with the field-level errors.

3. Pass `locals.restaurantId` explicitly. Never let the module infer the tenant, and never accept a
   restaurant id from the form body — that is the cross-tenant write T-16's test exists to catch.

4. Let the owner enter a time zone not present in the suggestion list. Offer the list as a datalist or
   a combobox with free text, so an owner whose browser reports `Asia/Kolkata` can submit it and have
   it stored canonically.

5. Warn, in one plain sentence next to the time-zone field, that it decides which business day a sale
   belongs to. Spec 10 puts a 01:30 sale in the previous evening's business date, and the time zone is
   what makes that true. Changing it later is allowed, audited with old and new values, and does not
   rewrite anything already recorded.

6. Do **not** add fields for tax mode, tax rate, currency, approval limits or idle-lock timing, not
   even disabled ones. Open decisions 3, 4 and 6 are unresolved, and a greyed-out field showing a
   plausible default is how an unmade decision becomes a remembered fact.

7. Form and feedback follow the same accessibility rules as the login page: labels tied to inputs,
   errors in a `role="alert"` region, and the submit button disabled while submitting.

**Tests:** T-20 covers the guards on both the load and the action. The behaviour — the diff, the audit
row, the cross-tenant refusal — is tested at the module level in T-16.

**Done when:** an owner can change the restaurant name and time zone; the change is reflected on
reload; exactly one `settings.updated` audit row appears per real change, carrying old and new
values; submitting unchanged values writes no audit row; an invalid time zone is rejected with a
field error; and a `cashier` session receives 403 from both the page and a direct POST to the action.

**Watch out:** `updateSettings` returns early when nothing changed, so the page must not report
success in a way that implies a write happened. Say "no changes to save" rather than "saved" when the
diff was empty, or the audit log and the user's memory will disagree about whether anything occurred.
