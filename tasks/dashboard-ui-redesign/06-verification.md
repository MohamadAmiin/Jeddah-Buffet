# Phase 6 — End-to-end verification and the documentation record

Two tasks that close the plan. T-20 extends the existing Playwright journey with the one thing only
a real browser can prove: that the theme cookie is read on the server and stamped on `<html>` before
the first byte reaches the browser. T-21 records the components layer in `CLAUDE.md`, so the
always-loaded rulebook's module map matches the directory tree this plan created.

Nothing here changes a screen, a token, a component or a colour. T-20 adds assertions and T-21 edits
a document.

**Depends on:** Phases 3, 4 and 5 — every screen and the theme control must exist. T-20 needs
T-13..T-19; T-21 needs T-12.

Read `00-overview.md` first for the requirements, the assumptions and the NEW / EXTEND / EDIT tag
convention.

---

### T-20 — Extend the end-to-end journey with the theme control

**Needs:** T-13, T-14, T-15, T-16, T-17, T-18, T-19
**Files:**
- `e2e/auth.spec.ts` — EDIT (ADD steps only; inside the single
  `test('the owner registers, works, signs out and signs back in', …)`, immediately after the block
  commented `// ── 3. the overview shows the restaurant and the checklist ──`, while the owner is
  signed in and on `/dashboard`)
**Spec:** 7 (the owner signs in with email and password and enters the management dashboard — the
journey this file walks). The specification does not govern visual design or theming at all; grepping
`docs/spec.md` for theme, font, colour and typography returns only unrelated matter. The theme
control's rules come from `CLAUDE.md`'s "Design & UI" section (light is the default; the bare `:root`
holds the complete light palette; dark is `@media (prefers-color-scheme:dark)` guarded as
`:root:not([data-theme="light"])`, plus a `:root[data-theme="dark"]` stamp so an explicit choice wins
either way) and from `docs/design-system.md`.
**Invariants:** 12 (POS access = registered device + PIN; sessions are HttpOnly + Secure + SameSite
cookies, NEVER `localStorage`, and SvelteKit's origin/CSRF check stays ON) — engaged by proximity,
not by change: `matcami_theme` sits beside `matcami_dashboard_session` in the same jar and must never
be confused with it. It carries no user data, it is never read for authorisation, and it is not a
session cookie. The existing steps 4 and 5 already assert the session cookie's own flags; this task
adds assertions about a different cookie and touches neither those assertions nor the session.
8 (permissions are enforced server-side on every POS API route, reads included) — engaged by
avoidance: this plan adds no route, no `+server.ts` and no form action, and `src/routes/route-guards.test.ts`
walks the route tree for exactly that.

**Do:**

1. Read `e2e/auth.spec.ts` end to end before writing a line. It is **ONE** test —
   `test('the owner registers, works, signs out and signs back in', async ({ page, context }) => …)` —
   containing a numbered, ordered sequence of steps marked by `// ── N. … ──` comments, not several
   tests sharing state through the database. It is written that way deliberately: the journey is
   order-dependent by nature, and independent tests that secretly depend on execution order are the
   flakiest thing a suite can contain. Do not restructure it into separate tests, and do not move a
   step.

2. Know what the harness gives you. `playwright.config.ts` starts the server with
   `pnpm build && pnpm preview --port 4173` and sets `baseURL` to `http://localhost:4173`, so this
   spec runs against the **PRODUCTION build** — SvelteKit's origin check is inert under `vite dev`,
   so a dev-server run would prove nothing. `test.beforeAll` calls `acquireRunLock()` and `resetDb()`
   against the `matcami_test` database, because the journey's first step only works when **ZERO**
   restaurants exist. `pnpm test:e2e` and `pnpm test:integration` share that database and must not
   run concurrently.

3. **Hard constraint: this task is THE ONLY task in the whole plan permitted to touch `e2e/`, and it
   may only ADD.** Do not edit, weaken, re-word or delete a single existing assertion in
   `e2e/auth.spec.ts` or `e2e/smoke.spec.ts`. Those assertions pin seven field labels, four button
   names, four heading texts, the restaurant name's *heading role*, `role="alert"` carrying
   `Settings saved.`, and `getByText('not started', { exact: true })` at **count exactly 5** — they
   encode the accessibility contract of the screens Phases 3 to 5 restyled. If an existing assertion
   now fails, the restyle is wrong and the **screen** is what gets fixed; loosening the assertion
   silently deletes the contract.

4. Insert one new step **after** the existing step 3 — the block that asserts the `Getting set up`
   heading and `getByText('not started', { exact: true })` at count 5. At that point the owner is
   signed in and on `/dashboard`, which is where T-19 put the theme control. If that block is absent,
   stop and report: the file is not in the state this plan assumed. Label the inserted block
   `// ── 3b. the theme control ──`, exactly as written. `3b` is deliberate: it leaves every existing
   `// ── N. … ──` label byte-identical, which is the only way the additions-only gate in
   **Done when** can be met. Renumbering steps 4 to 11 to make room for a `4` is not worth a diff in
   which a reviewer can no longer see at a glance whether an assertion changed.

5. Assert the control is present, with `Light`, `Dark` and `System` reachable **by role and name** —
   never by CSS class or test id. Use the role that T-19's `src/lib/components/ui/ThemeToggle.svelte`
   actually renders (open it and look; if it renders `<button>` elements, that is
   `page.getByRole('button', { name: 'Light' })`), and use those three names exactly as written here.

6. Before any choice is made, assert `<html>` carries **NO** `data-theme` attribute — the system
   state, which is what an absent `matcami_theme` cookie means:
   `expect(await page.locator('html').getAttribute('data-theme')).toBeNull();`

7. Click `Dark`. Assert `data-theme="dark"` is now on `<html>` **immediately, without a reload** —
   assert it without navigating or reloading first, or the assertion proves nothing about the click.

8. Assert the cookie. The test already destructures `context`, so read `await context.cookies()` and
   find the one named `matcami_theme`. Assert it exists, that its value is `dark`, that its `path` is
   `/` and that its `sameSite` is `Lax`. Assert `secure` **only** when the page URL's protocol is
   `https:` — the suite runs on `http://localhost:4173`, where a `Secure` cookie would be discarded
   by the browser and the assertion would fail for a reason that has nothing to do with the theme.
   The existing session-cookie step uses exactly that conditional pattern
   (`if (new URL(page.url()).protocol === 'https:') { … }`); follow it.

9. Assert the SSR stamp against the **raw server response body**, never against the live DOM. A
   reloaded page hydrates, and the toggle's own client code sets `data-theme="dark"` on `<html>`
   whether or not the server ever stamped it — so `await page.reload()` followed by a
   `getAttribute('data-theme')` assertion passes identically for a client-only implementation, and
   the SSR stamp, the entire reason a cookie was chosen over `localStorage`, goes unverified. Use the
   `page.request` pattern this file already relies on at the `GET /logout` step: `page.request` shares
   the browser context's cookie jar, so `matcami_theme=dark` is sent automatically. Fetch
   `/dashboard`, read the body as text, and assert it contains `data-theme="dark"` inside the opening
   `<html` tag.

   ```ts
   // Only the RAW body can distinguish a server stamp from a client-side one:
   // after hydration the toggle would have set the same attribute either way.
   // This is the assertion protecting against a flash of the wrong theme.
   const ssr = await page.request.get('/dashboard');
   expect(ssr.status()).toBe(200);
   expect(await ssr.text()).toMatch(/<html[^>]*data-theme="dark"/);
   ```

   Then call `await page.reload();` if the journey needs the page back in a normal, freshly loaded
   state before the steps that follow.

10. Click `System`. Assert the `data-theme` attribute is removed from `<html>` **entirely** (the
    `getAttribute` call returns `null` again — not the string `"system"`, not an empty attribute) and
    that the `matcami_theme` cookie is expired: it is no longer present in `await context.cookies()`.

11. Click `Light` under an emulated dark operating system, and assert the **computed token**, not
    the attribute. Call `await page.emulateMedia({ colorScheme: 'dark' });` first, then click, then
    assert that a themeable custom property resolves to its LIGHT value while the OS is asking for
    dark.

    ```ts
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: 'Light' }).click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    // The attribute is written by the toggle regardless of any CSS, so asserting
    // it is identical with or without the emulation and says nothing about the
    // cascade. The COMPUTED value is what proves an explicit light choice beats
    // a dark operating system — i.e. that the `:root:not([data-theme="light"])`
    // guard in `src/lib/styles/tokens.css` does its job.
    const bg = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim()
    );
    expect(bg).toBe('#e9edf0');
    ```

    `#e9edf0` is the light `--c-bg` in `src/lib/styles/tokens.css`; open the file and use the value
    that is actually there rather than trusting this line. Then reset the emulation with
    `await page.emulateMedia({ colorScheme: null });` before the journey continues, so the later
    steps are not run under an emulation they never asked for.

12. Leave steps 4 through 11 exactly where they are. All eight of them: the browser-storage check
    (step 4 — the session token is in neither `localStorage` nor `sessionStorage`), the session-cookie
    flags (step 5), the settings rename (step 6 — the `Restaurant settings` heading, the
    `Save settings` button, the `role="alert"` carrying `Settings saved.` and the renamed
    restaurant's heading), sign out (step 7), the redirect carrying `next` (step 8), sign in
    (step 9), `GET /logout` returning 405 (step 10) and `/register` being closed (step 11). That list
    is exhaustive on purpose: step 6 carries exactly the frozen accessible surface step 3 declares
    untouchable, and a reader who takes a short list as complete concludes the unlisted steps are
    movable. Then run `pnpm test:e2e` from a clean `matcami_test` with no integration run in flight.

**Tests:** this task **is** the test — the assertions above are the deliverable, and no separate test
file is added. It is **not** one of spec 29's six mandatory areas. Those six are money arithmetic and
rounding, tax calculated in both modes, journal entries always balance, one posting rule per spec 24
business event, offline sync retries never creating duplicates, and a permission check on every POS
API route. This task touches none of them, so do **not** label it `MANDATORY (spec 29)`.

**Done when:** `pnpm test:e2e` passes; `git diff e2e/` shows **ONLY** additions — no modified and no
deleted assertion line anywhere in the diff; and the run is green starting from a clean
`matcami_test` database with no `pnpm test:integration` run in flight.

**Watch out:** the existing step numbering runs 1 to 11 in `// ── N. … ──` comments. Do **not**
renumber any of them; the inserted block is labelled `3b` precisely so that no existing label line
changes. Renumbering a comment is cosmetic and changing an assertion is not, and the two must never
travel in the same edit — a diff full of relabelled comments is a diff in which nobody can see
whether an assertion moved. Do not move the sign-out step before the theme
step: after sign-out the owner is on `/login`, the dashboard header is gone, and the control will not
be on screen. And `pnpm test:e2e` and `pnpm test:integration` both truncate `matcami_test` — running
them at once makes this journey fail at its registration step with "Registration is closed: a
restaurant already exists", a symptom that points nowhere near the cause.

---

### T-21 — Record the components layer in `CLAUDE.md`

**Needs:** T-12
**Files:**
- `CLAUDE.md` — EDIT (two places: the fenced `src/` tree inside the `## Where code lives` section and
  the house-convention paragraph directly under it; and the `## Design & UI` section's bullet list)
**Spec:** none — `docs/spec.md` governs neither the repository's directory layout nor its visual
design. Spec 7 (the owner signs in and enters the management dashboard) and 26 (the report list the
navigation anticipates) are the only sections the screens in this plan serve, and neither says
anything about where component files live or which ink token may sit on which surface. Those are
governed by `CLAUDE.md`'s "Design & UI" section and by `docs/design-system.md` — which is exactly
what this task edits, and why there is no spec citation to give. Do not invent one.
**Invariants:** none directly — see below. Engaged by avoidance: 8 (permissions are enforced
server-side on every POS API route, reads included) — this task adds no route; and 12 (session
cookies are HttpOnly + Secure + SameSite and never `localStorage`) — untouched, and the twelve
numbered invariants are the one part of this file the task must not modify. The `CLAUDE.md`
"Design & UI" rules it does engage are: `src/lib/styles/tokens.css` is the ONLY place a colour, size
or type value is defined; WCAG AA (4.5:1) at normal text size, in both themes, for every
text-on-surface pair; and the house convention that `lib/server/**` must not be imported by
client-side code or by `lib/pos/`.

**Do:**

1. Understand what this repairs. `CLAUDE.md` is the always-loaded rulebook. Its `## Where code lives`
   section shows a fenced directory tree under `src/` listing `lib/server/**`, `lib/pos/`,
   `lib/styles/` and the route groups. It lists **no** components folder, because none existed. This
   plan created one, so the map must match the territory — a rulebook that omits a directory is how
   the next session invents a second place for the same thing. First check that
   `src/lib/components/ui/` exists in the working tree; if it does not, stop and report, because T-12
   has not run and there is nothing here to record.

2. In that `src/` tree, add a `components/ui/` entry beneath `lib/`, indented and column-aligned to
   match the sibling entries (`pos/`, `styles/`), with a one-line description: the shared dashboard
   primitives — Button, Field, Card, PageHeader, Alert, StatusMark, ThemeToggle — that implement the
   dashboard layout grammar in `docs/design-system.md`. **Check the section number that grammar
   actually carries** and cite the real one: `7b` was this plan's working name for a section T-01
   creates, not a guarantee — open the document and read its headings. Never write a section number
   or a token name into `CLAUDE.md` without first confirming it exists in the tree; this file is
   loaded into every session, so a wrong symbol here is paid for on every future turn of every future
   session.

3. In the house-convention paragraph immediately below the tree — the one beginning "House
   convention, not spec (spec 30/32 say only "modular monolith")" and already stating that
   `lib/server/**` MUST NOT be imported by client-side code or by `lib/pos/`, and that `money/` is
   imported by everything and imports no sibling — add one clause: `lib/components/**` takes its data
   as props and imports nothing from `lib/server`; `src/lib/components/components.test.ts` enforces
   it. Check that test path against the working tree first; if T-12 named its guard something else,
   cite the real path rather than the one written here, and never cite a file that does not exist.

4. In the `## Design & UI` section, add two bullet lines to the existing list.
   - First: the dashboard's layout grammar lives in `docs/design-system.md` — cite the section number
     you confirmed in step 2 — and is implemented by `src/lib/components/ui/`: a screen composes
     primitives rather than retyping class strings.
   - Second, the legal-pair rule **with its numbers**, because it is a correctness rule and not a
     style preference. The rule that lands in `CLAUDE.md` must be the **both-theme-safe** one: an
     entry a reader has to re-derive per theme is an entry that gets applied wrongly, and
     `text-ink-3` on `bg-raise-2` is the trap — legal in light, 4.25:1 in dark. Write these three
     lines, and keep it to these three, because `CLAUDE.md` length has a real cost:
     - `text-ink-3` is legal ONLY on `bg-raise` (5.13:1 light, 4.87:1 dark) and nowhere else — use
       `text-ink-2` on every other surface.
     - `text-ok` and `text-danger` are never used on `bg-raise-2` (4.18:1, 4.06:1 dark) or
       `bg-accent-soft` (4.31:1, 4.19:1 dark).
     - Interactive control borders use the control-border token, and `border-line` is decorative only
       at 1.58:1 on `bg-raise`.

     For that third line, **check the name T-02 actually gave the token** in
     `src/lib/styles/tokens.css` and cite the real utility. This plan drafted it as
     `border-control-line`, but the file is the authority and the token does not exist until T-02 has
     run — a utility name in the rulebook that resolves to nothing is worse than no line at all.

5. Also in `## Design & UI`, note that the three typefaces are self-hosted from pinned `@fontsource`
   packages, and that the variable packages declare the family names `Archivo Variable` and
   `IBM Plex Sans Variable` — so the names in the `--font-*` stacks must keep matching the names the
   packages declare, which `src/lib/styles/fonts.test.ts` asserts. Check that test path against the
   working tree as in step 3 and cite the real one. This sentence exists because the mismatch it
   describes is invisible: a browser matches `@font-face` by the declared family string, so a stack
   naming `Archivo` while the package declares `Archivo Variable` renders in `system-ui` with every
   check, lint, test and e2e spec still green.

6. **CHANGE NOTHING ELSE.** Do not touch the twelve numbered invariants under
   `## Non-negotiable invariants`, the `## Open decisions — UNRESOLVED (spec 33)` table, the
   `## Decisions already made (NOT open — do not re-litigate)` list, the `## Do NOT build` list,
   `## Commands & setup`, the domain glossary or the task-routing table. This task records a house
   convention the user approved; it does not amend a rule, and amending one is a separate decision
   with its own conversation. While you are in the documents, do not "fix" sections 4, 5 or 9 of
   `docs/design-system.md` either — `00-overview.md` records those as deliberately left open, and a
   session finding that text still wrong should report it, not repair it.

7. Run `pnpm format` if prettier reflows the markdown, then `pnpm lint`. Prettier checks markdown in
   this repository, so a long unwrapped line fails the lint gate rather than merely looking untidy.

**Tests:** none — this task edits a document, and a document has no test. No test file is added and
no existing test changes. None of spec 29's six mandatory areas is touched (money arithmetic and
rounding, tax in both modes, journal entries balance, one posting rule per spec 24 business event,
offline sync retries never duplicating, a permission check per POS API route), so nothing here is
labelled `MANDATORY`.

**Done when:** `grep -n 'components/ui' CLAUDE.md` prints at least one line, and that line is inside
the `## Where code lives` tree; `git diff CLAUDE.md` shows no change anywhere inside the
`## Non-negotiable invariants` section, so the twelve numbered items are byte-identical to before the
edit; and `pnpm lint` exits 0.

**Watch out:** `CLAUDE.md` is loaded into every future session's context, so length has a real cost —
every line added here is a line paid for on every future turn of every future conversation. Add the
lines above and resist documenting the whole design system there. `docs/design-system.md` is where
the design system lives, and `CLAUDE.md` points at it.
