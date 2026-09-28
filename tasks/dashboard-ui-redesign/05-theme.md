# Phase 5 — The theme control

This phase delivers the half of the theme system that has never existed. `src/lib/styles/tokens.css`
has always declared three theme states — the bare `:root` holding the complete light palette, a
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` block so an explicit
light choice beats a dark operating system, and a `:root[data-theme="dark"] { … }` block so an
explicit dark choice wins the other way. Check those three selectors before starting; if they are not
there, stop and report it, because everything below assumes them. What has never existed is anything
that **sets** `data-theme`: no code in `src/` writes that attribute, so only the operating-system
preference has ever applied and the owner has never been able to choose. T-18 adds the cookie and the
server-side stamp that puts the attribute on `<html>` before the first byte reaches the browser;
T-19 adds the three-option control in the dashboard header that writes the cookie.

**Depends on:** Phase 1 (T-02 — the dashboard scale tokens) and, for T-19, Phase 4 (T-14 — the
restyled `(dashboard)` header this control is placed into).

**Read `00-overview.md` in this directory first.** It carries the goal, the agreed requirements, the
scope boundaries, the assumptions this phase rides on, the frozen accessible surface of the e2e
suite, and the `NEW` / `EXTEND` / `EDIT` tag convention used in every `Files:` list below.

---

### T-18 — Add the theme cookie and stamp `data-theme` on `<html>` from the server

**Needs:** T-02 (the dashboard scale tokens in `src/lib/styles/tokens.css`)
**Files:**
- `src/lib/theme.ts` — NEW
- `src/lib/theme.test.ts` — NEW
- `src/app.html` — EDIT (the opening `<html>` tag, line 2 — the line after `<!doctype html>`)
- `src/hooks.server.ts` — EDIT (add an exported `handleTheme` beside the existing `handleSession` and
  `handleGuard`, and extend the `sequence(…)` call on the last line of the file)
**Spec:** 7 (the owner signs in with email and password and enters the management dashboard — the
surface this preference applies to). The specification does **not** govern visual design or theming
at all: grepping `docs/spec.md` for theme, font, colour, typography and responsive returns only
unrelated matter, so there is no section to cite for the rest of this task. Visual design is governed
by `CLAUDE.md`'s "Design & UI" section and by `docs/design-system.md`. Do not invent a citation.
**Invariants:**
- 8 (permissions are enforced SERVER-side on every route, reads included; a route with no permission
  check is unfinished) — engaged **by avoidance**. This task adds no route, so there is nothing new
  to guard. See the hard constraint below.
- 12 (POS access = registered device + PIN; sessions are HttpOnly + Secure + SameSite cookies, NEVER
  `localStorage`, and SvelteKit's origin/CSRF check stays ON) — engaged because the cookie this task
  introduces sits beside the session cookie and must never be confused with it. Invariant 12 governs
  `matcami_dashboard_session` (declared as `SESSION_COOKIE` in `src/lib/server/auth/session.ts`).
  `matcami_theme` is a different kind of thing: it holds no secret, it is never read for
  authorisation, and it is deliberately readable by client JavaScript because the client is what
  writes it.
- CLAUDE.md "Design & UI": *"Light is the default … plus a `:root[data-theme="dark"]` stamp so an
  explicit choice wins either way."* This task is what produces that stamp.

**THE HARD CONSTRAINT, AND THE REASON THIS TASK IS SHAPED THIS WAY.** The theme preference is written
by **client JavaScript** via `document.cookie` (T-19) and is only **READ** on the server. This task
adds NO `+server.ts`, NO `+page.server.ts`, NO `+layout.server.ts`, NO form action, NO entry in
`PUBLIC_ROUTE_IDS` and NO permission key. The instinct for "persist a preference" is a server route,
and here it would be wrong three times over:

1. `src/hooks.server.ts` denies by default — a route that is not in `PUBLIC_ROUTE_IDS` and has no
   session redirects to `/login`, so a theme-write route would fail for a signed-out visitor.
2. The control must eventually be able to work on `/login` and `/register`, which are
   unauthenticated, so the escape hatch would be making the theme route public.
3. `src/lib/public-routes.ts` is asserted for its **exact** contents by `src/routes/route-guards.test.ts`,
   precisely so that adding a public route is a deliberate, reviewed act rather than a convenience.

A client-written cookie needs none of that. Note also that `route-guards.test.ts` walks the route tree
for `+page.server.ts`, `+layout.server.ts` and `+server.ts` only — `src/hooks.server.ts` is not in
that walk, so editing the hook requires no new guard entry, and this task adds no route for it to
guard.

**Do:**
1. Create `src/lib/theme.ts` as an **isomorphic** module — importable from both server and client
   code. It sits in `src/lib/`, NOT in `src/lib/server/` and NOT in `src/lib/pos/`;
   `src/lib/public-routes.ts` is the existing precedent for exactly that placement (a small module
   the hook and a test both import without dragging in the database client or `$env`).
2. Export from it, with these exact names and values:
   ```ts
   export const THEME_COOKIE = 'matcami_theme';
   export const THEME_MAX_AGE_SECONDS = 31536000; // one year, for the client to use

   export type Theme = 'light' | 'dark';

   export function parseTheme(value: string | undefined): Theme | null {
   	return value === 'light' || value === 'dark' ? value : null;
   }

   export function themeAttribute(theme: Theme | null): string {
   	return theme === null ? '' : `data-theme="${theme}"`;
   }
   ```
   `parseTheme` returns `null` for anything that is not exactly `'light'` or `'dark'` — including
   `undefined`, `''`, `'system'` and `'DARK'`. `themeAttribute` returns the **EMPTY STRING** when the
   preference is absent. The empty string IS the "system" state: no attribute at all on `<html>`, so
   the `@media (prefers-color-scheme: dark)` block in `tokens.css` governs. There is deliberately no
   third `Theme` value for "system" — absence is how system is represented, in the cookie and in the
   DOM alike.
3. Edit `src/app.html`. Change the opening tag from `<html lang="en">` to:
   ```html
   <html lang="en" %matcami.theme%>
   ```
   Change nothing else in that file — the `<head>` contents, `%sveltekit.head%`, the
   `data-sveltekit-preload-data="hover"` attribute on `<body>` and the `<div style="display: contents">`
   wrapper all stay as they are. SvelteKit 2.70.3 validates only that the template contains
   `%sveltekit.head%` and `%sveltekit.body%`, plus the public prefix on any `%sveltekit.env.*%`
   placeholder; it does not validate or substitute any other `%…%` token, so a custom placeholder
   passes through to the renderer untouched.
4. In `src/hooks.server.ts`, add the import `import { THEME_COOKIE, parseTheme, themeAttribute } from '$lib/theme';`
   (the `type Handle` import from `@sveltejs/kit` is already at the top of the file) and add the
   handler, exported individually the way `handleSession` and `handleGuard` already are so a test can
   drive the real handler:
   ```ts
   export const handleTheme: Handle = async ({ event, resolve }) => {
   	const theme = parseTheme(event.cookies.get(THEME_COOKIE));
   	return resolve(event, {
   		transformPageChunk: ({ html }) => html.replace('%matcami.theme%', themeAttribute(theme))
   	});
   };
   ```
   It MUST NOT read `event.locals` — it runs before the session is resolved, and a theme is not a
   privilege.
5. Put it **FIRST** in the sequence on the last line of the file:
   ```ts
   export const handle = sequence(handleTheme, handleSession, handleGuard);
   ```
6. **THE PLACEHOLDER MUST ALWAYS BE REPLACED, including in the system state**, where it is replaced
   with an empty string. Miss that branch — by only calling `transformPageChunk` when a cookie is
   present, for example — and the literal text `%matcami.theme%` ships inside the `<html>` tag of
   every page of the application. That is why `themeAttribute` takes `Theme | null` and returns a
   string in all three cases, rather than the handler branching on the cookie.
7. **Keep every existing comment in `src/hooks.server.ts`.** The notes on deny-by-default, on why
   `restaurantId` is set for dashboard routes only, on the origin/CSRF check staying on, and on the
   proxy dependency for `getClientAddress()` are the reasons those lines are written the way they
   are. Add the new handler beside them; delete none of them.

**Tests:** `src/lib/theme.test.ts`, a plain unit test in the existing node `unit` project (Vitest's
`unit` project includes `src/**/*.test.ts` with `environment: 'node'` — no new harness, no jsdom, no
browser mode). This is **not** one of spec 29's six mandatory areas (money arithmetic and rounding,
tax in both modes, journal entries balance, one posting rule per business event, offline sync retries
never duplicating, a permission check per POS API route) — do **not** label it MANDATORY.
- `parseTheme('light')` → `'light'`.
- `parseTheme('dark')` → `'dark'`.
- `parseTheme(undefined)`, `parseTheme('')`, `parseTheme('system')` and `parseTheme('DARK')` → all
  `null`.
- `themeAttribute(null)` → `''`.
- `themeAttribute('dark')` → `data-theme="dark"`.
- Read `src/app.html` as text (`readFileSync(fileURLToPath(new URL('../app.html', import.meta.url)), 'utf8')`
  from `src/lib/theme.test.ts`) and assert it contains `%matcami.theme%` **exactly once**:
  `expect(template.match(/%matcami\.theme%/g)).toHaveLength(1)`.
- Read `src/hooks.server.ts` as text (`../hooks.server.ts` from the same directory), slice from
  `source.indexOf('sequence(')` — the import line reads `sequence }`, so that index is the call, not
  the import — and assert the call text contains `handleTheme`, and that `handleTheme` appears before
  `handleSession` within it. A placeholder nobody substitutes is the failure mode worth pinning: both
  halves compile and both test suites stay green while every page ships broken markup.

**Done when:** `pnpm test:unit` passes; `pnpm check && pnpm lint` exit 0; `pnpm build` succeeds; and
against a running preview server (`pnpm build && pnpm preview --port 4173`, the port
`playwright.config.ts` already uses) both of these hold — note the opening tag is on the document's
second line, after `<!doctype html>`, so match it rather than taking the first line:

`pnpm preview` serves a PRODUCTION build, so `src/lib/server/env.ts` requires ORIGIN to be set. Put
`ORIGIN=http://localhost:4173` in `.env` first — it ships empty in `.env.example`, and a loopback
origin is the one value env.ts accepts for local use, which is why `playwright.config.ts` sets
exactly that. `.env` is gitignored, so this commits nothing.

```bash
curl -s localhost:4173 | grep -m1 '<html'
# → <html lang="en" >                      ← no cookie: no attribute, no placeholder text left

curl -s --cookie 'matcami_theme=dark' localhost:4173 | grep -m1 '<html'
# → <html lang="en" data-theme="dark">
```

`/` is in `PUBLIC_ROUTE_IDS`, so neither request needs a session.

**Watch out:**
- Invariant 12 governs the SESSION cookie `matcami_dashboard_session` — HttpOnly, Secure, SameSite,
  never in `localStorage`. `matcami_theme` is a different thing. Do not add it to any session logic,
  do not set it from the server, do not give it the session cookie's lifetime or flags, and do not
  let it influence any guard, redirect or permission decision. The only place it is read is
  `handleTheme`, and the only thing it can affect is one attribute on `<html>`.
- A cookie value is attacker-supplied input: anyone who can run script on the origin, or hand the
  owner a crafted link on a shared machine, controls that string, and it is being interpolated into
  the opening tag of every page. This is exactly why `themeAttribute` accepts `Theme | null` and not
  a raw string — by the time it runs, `parseTheme` has already reduced the input to one of two
  literals or `null`, so the function can only ever emit one of three fixed strings. Never widen
  `themeAttribute` to take the cookie value directly, and never skip `parseTheme` "because the value
  looks fine".
- `String.prototype.replace` with a string argument replaces only the first occurrence. That is
  correct here and the test pins the placeholder at exactly one occurrence. Under streaming,
  `transformPageChunk` is called per chunk; the placeholder sits in the first chunk (the document
  head), so a single `.replace` is safe, and the call is a harmless no-op on every later chunk.

---

### T-19 — Add the `ThemeToggle` control to the dashboard header

**Needs:** T-18 (`src/lib/theme.ts` and the `data-theme` stamp), T-14 (the restyled `(dashboard)`
header this control is placed into)
**Files:**
- `src/lib/components/ui/ThemeToggle.svelte` — NEW
- `src/lib/components/ui/index.ts` — EXTEND (created by T-12; add the `ThemeToggle` export beside the
  other primitive exports. Do NOT rewrite the file — what is already in it was written by tasks that
  have run)
- `src/routes/(dashboard)/+layout.svelte` — EDIT (inside the `<header>` element, in the trailing
  right-hand group that holds `{data.displayName}` and the `<form method="POST" action="/logout">`;
  T-14 restyles that header, so match whatever that group looks like when you open the file)
- `src/lib/components/components.test.ts` — EXTEND (created by T-12; ONLY if its recursive walk
  of `src/lib/components/` does not already reach `ui/ThemeToggle.svelte` — widen the walk, add no
  new assertions, and do not rewrite the file)
**Spec:** 7 (the owner signs in and enters the management dashboard — the surface this control sits
in). As in T-18, the specification does not govern visual design; `CLAUDE.md`'s "Design & UI" section
and `docs/design-system.md` do. Do not cite a spec section for the appearance of this control.
**Invariants:**
- 8 (permissions are enforced server-side on every route, reads included) — engaged **by avoidance**:
  this control makes no network request at all. No route, no form action, no `fetch`.
- 12 (session cookies are HttpOnly + Secure + SameSite and never `localStorage`) — engaged because
  this task writes a cookie from client JavaScript. That is correct for `matcami_theme` and would be
  a serious defect for `matcami_dashboard_session`; do not generalise the pattern.
- CLAUDE.md "Design & UI": every colour, size and type value comes from `src/lib/styles/tokens.css`
  — an arbitrary value such as `bg-[#123456]` or `p-[57px]` in a component is a bug, add a token
  instead; colour never carries meaning alone; the dashboard uses Tailwind's default scale, so the
  POS `touch-*` tokens and the POS shell tokens (`--screen`, `--key`, `--key-ink`) do not belong
  here.

**Do:**
1. Create `src/lib/components/ui/ThemeToggle.svelte` as a three-option control — `Light`, `Dark`,
   `System` — rendered as three `<button type="button">` elements inside one grouped container with
   an accessible group name, for example `<div role="group" aria-label="Theme">`. Each button's
   accessible name is **exactly its own word**: `Light`, `Dark`, `System`. No "Switch to…" prefix, no
   icon-only button leaning on a `title` attribute.
2. Give each button `aria-pressed` reflecting the current selection — exactly one of the three is
   pressed at a time. `aria-pressed` is what a screen-reader user gets; a sighted user gets the
   words, which already carry the meaning, so the selected option must additionally be
   distinguishable by more than hue alone (a surface change plus a weight or border change), never by
   colour alone.
3. Import the names rather than retyping the strings:
   `import { THEME_COOKIE, THEME_MAX_AGE_SECONDS, parseTheme, type Theme } from '$lib/theme';`
4. Selecting `Light` or `Dark` writes the cookie and sets the attribute, in that order:
   ```ts
   const secure = location.protocol === 'https:' ? '; secure' : '';
   document.cookie = `${THEME_COOKIE}=${value}; path=/; max-age=${THEME_MAX_AGE_SECONDS}; samesite=lax${secure}`;
   document.documentElement.dataset.theme = value;
   ```
   The rendered cookie string is `matcami_theme=dark; path=/; max-age=31536000; samesite=lax`. Append
   `; secure` **only** when `location.protocol === 'https:'` — a `Secure` cookie sent over plain HTTP
   is discarded by the browser, and the Playwright suite runs against `http://localhost:4173`, so an
   unconditional `; secure` makes the preference silently fail to persist in exactly the environment
   that tests it. Setting `document.documentElement.dataset.theme` is what makes the change immediate,
   with no reload and no page transition.
5. Selecting `System` expires the cookie and **removes the attribute entirely**:
   ```ts
   document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
   delete document.documentElement.dataset.theme;
   ```
   Removing the attribute is what hands control back to `tokens.css`'s
   `@media (prefers-color-scheme: dark)` block. Setting it to `"system"` or to `""` would leave an
   attribute on `<html>` that matches neither `:root[data-theme="dark"]` nor
   `:root:not([data-theme="light"])` correctly — `data-theme=""` is not `data-theme="light"`, so a
   dark OS would still win, but the state would no longer be representable in the cookie, and a
   later reader would have three spellings of one idea. There are two cookie values and one absence;
   keep it that way.
6. Initialise the control's state from `document.documentElement.dataset.theme` — the attribute the
   server already stamped — rather than from the cookie. The stamp is the rendered truth; the cookie
   is merely how it got there. `parseTheme` takes `string | undefined` precisely so it can read
   `dataset.theme` directly: `let selected = $state<Theme | null>(null)`, then set it from
   `parseTheme(document.documentElement.dataset.theme)`. Read it in `onMount` or inside an `$effect`,
   never at module top level or in the component body: this component is server-rendered as part of
   the dashboard layout and `document` does not exist there. The consequence is that the first
   server-rendered frame shows `System` pressed and hydration corrects it — that settles a button's
   pressed state only; the page itself is already correctly themed by T-18's SSR stamp, which is the
   whole point of using a cookie.
7. After any change, derive the component's pressed state from the COOKIE, not from the attribute
   and not from the value that was clicked. Wrap the `document.cookie` write in
   `try { … } catch { … }` so a blocked-cookie exception cannot prevent the attribute update, then
   read the cookie back and let that decide what is shown as pressed:
   - after choosing `Light` or `Dark`:
     `const persisted = document.cookie.split('; ').some((c) => c === `${THEME_COOKIE}=${value}`);`
     — `selected` becomes `value` when `persisted` is true, and falls back to
     `parseTheme(document.documentElement.dataset.theme)` when it is false.
   - after choosing `System`: the cookie must be GONE, so check its absence —
     `const cleared = !document.cookie.split('; ').some((c) => c.startsWith(`${THEME_COOKIE}=`));`
     — `selected` becomes `null` (System pressed) when `cleared` is true, and stays on the previous
     choice when it is false.
   Reading the attribute back cannot serve this purpose: step 4 sets it unconditionally, so it always
   returns what was clicked. The cookie is the only thing that can disagree. See **Watch out**.
8. There is **NO network request, NO form and NO route**. If this component ends up importing
   `$app/forms`, calling `fetch`, or requiring a new file under `src/routes/`, the implementation has
   gone wrong — re-read T-18's hard constraint.
9. Export it from the barrel: add `ThemeToggle` beside the existing exports in
   `src/lib/components/ui/index.ts`, in the same style the other primitives use. If that file is
   absent, T-12 has not run — stop and report the mismatch rather than creating it here.
10. Place `<ThemeToggle />` in the dashboard header in `src/routes/(dashboard)/+layout.svelte`, in
    the trailing group beside the display name and the sign-out form, importing it from the barrel
    (`import { ThemeToggle } from '$lib/components/ui';`). Keep the existing comment above the logout
    form — *"A FORM, never an anchor. /logout refuses GET, and a link would be triggerable by any
    image tag on any page."* — and keep the form itself untouched.
11. Do **NOT** add it to `/login` or `/register`. Those two pages follow the operating-system
    preference; that is a recorded assumption in `00-overview.md`, and reversing it later is adding
    one component to two pages. Nothing in this task may hardcode something that prevents that.

**Tests:** none of its own. T-20 covers the behaviour end to end in the Playwright journey.
`src/lib/components/components.test.ts` (created by T-12) already walks
`src/lib/components/ui/`, so this component is picked up automatically by that file's boundary,
arbitrary-value and POS-token assertions — check that the new file is covered when you run
`pnpm test:unit`, and if that walk turns out not to reach it, extend the walk rather than adding a
component test harness (`jsdom`, `@testing-library/svelte` and Vitest browser mode are all out of
scope for this plan). Not one of spec 29's six mandatory areas — do **not** label anything here
MANDATORY.

**Done when:** `pnpm check && pnpm lint` exit 0; `pnpm test:unit` passes; and with `pnpm dev` running
and an owner signed in: clicking `Dark` switches the page immediately with no reload; reloading keeps
it dark **with no flash of light** on the way in; clicking `System` returns the page to the operating
system's preference and leaves no attribute behind —
`document.documentElement.hasAttribute('data-theme')` evaluates to `false` in the devtools console,
and `document.cookie` contains no `matcami_theme=` entry at all — the attribute going away and the
cookie going away are two different things, and both must happen.

**Watch out:**
- The control must not appear to work and then silently fail. If `document.cookie` throws or the
  write is blocked, the visible state and the persisted state disagree on the next load — the page
  looks dark now and comes back light tomorrow, which reads as a product bug rather than a browser
  setting. Reading the attribute back does NOT detect that: step 4 sets
  `document.documentElement.dataset.theme` unconditionally and only the cookie write is wrapped in
  `try`/`catch`, so that attribute returns the clicked value whether or not the cookie landed.
  Verify the cookie itself after writing —
  ``const persisted = document.cookie.split('; ').some((c) => c === `${THEME_COOKIE}=${value}`)``
  — and derive the pressed state from that, so a blocked or failed cookie write shows immediately
  instead of on the next load. The attribute is what makes the change visible now; the cookie is
  what makes it survive a reload, and only the cookie can be checked for having actually landed.
  The `System` branch needs the mirror-image check, because there the cookie is EXPIRED rather than
  written and there is no value to compare: assert its ABSENCE with
  ``!document.cookie.split('; ').some((c) => c.startsWith(`${THEME_COOKIE}=`))``. Step 7 spells out
  both branches. Without the System check the same failure hides in the one place it is hardest to
  notice — the owner clicks `System`, the deletion is blocked, and the page comes back dark tomorrow.
- **Do not reach for `localStorage`.** The cookie was chosen precisely so the server can stamp the
  attribute during SSR (T-18), which is what prevents the flash of the wrong theme. `localStorage` is
  unreadable from the server, so a `localStorage` implementation must repaint after hydration —
  which is the defect this design exists to avoid — and invariant 12 puts the project firmly off
  that road for anything cookie-shaped.
- `e2e/auth.spec.ts` and `e2e/smoke.spec.ts` are FROZEN for this plan: no task may edit them except
  T-20, and T-20 only ADDS assertions. Playwright matches the name you pass as a case-insensitive
  substring of an element's accessible name, so a new control is safe only while its accessible
  name does NOT contain `Sign out`, `Sign in`, `Save settings` or `Create restaurant`. `Light`,
  `Dark` and `System` contain none of them. A label such as `Sign out of light mode` would contain
  `Sign out` and would make step 7 of the journey resolve to two elements and fail.
