# Phase 0 — Decisions and guardrails

This phase resolves everything that must not be guessed, **before any schema, any arithmetic and any
route lands**. Two of the four blockers in `00-overview.md` are answered here by writing a decision
down (T-01 the money module's placement, T-02 the `/pos` URL prefix, the service-worker scope and the
route-naming rule that keeps a dashboard page out of that scope), one is answered by asking the user
(T-03, the four questions nobody has answered), and one is turned into a test that fails loudly
forever after (T-04, the schema guard that today would accept `numeric(12,2)` for a price). Nothing
in this phase writes a money function, a table, a migration or a route — it writes the rules the rest
of the plan is held to.

**Depends on:** nothing. This is the first phase; every later phase depends on it.

---

### T-01 — Resolve the money module placement and correct CLAUDE.md invariant 1

**Needs:** -
**Files:**

- `src/lib/money/README.md` — NEW (creates the `src/lib/money/` directory; a README and nothing else,
  exactly as `src/lib/server/money/` is a README and nothing else today)
- `src/lib/server/money/README.md` — EDIT (replace the section headed
  `## Read this before writing any code here — the placement is UNRESOLVED`)
- `CLAUDE.md` — EDIT (**six** separate spots, because the `src/` tree block takes two of them:
  invariant 1 on line 11; the existing `money/` line **under `server/`** inside the `src/` tree
  block; a **new** `money/` line inserted in that same tree block beside `pos/`; the
  "House convention" paragraph below that tree; the
  `| Prices, totals, tax, rounding, currency |` row of the "Task routing & skill map" table; a new
  bullet appended to "Decisions already made (NOT open — do not re-litigate)")
- `eslint.config.js` — EDIT (add one new config object immediately **after** the existing
  `files: ['src/lib/pos/**/*.{ts,svelte}', 'src/routes/(pos)/**/*.{ts,svelte}']` block and **before**
  the `prettier` entry, which the file's own comment requires to stay last)

**Spec:** 17 (money is integer minor units in `bigint`; "**One rounding rule**, implemented in one
function and used everywhere (POS, server, reports)"), 6 (the offline POS totals a bill in the
browser, so that one function must run in the browser)
**Invariants:** 1 (money is integer minor units — integer cents in `bigint`, never a float, never a
`numeric` money column), 7 (ONE rounding rule in ONE function used by POS, server and reports)

**Do:**

1. Read `src/lib/server/money/README.md` in full first. It states the conflict and reserves this
   decision for the first money task, "before it writes a single arithmetic function". Do not skip
   this: the README is the record of what was already considered and rejected (copying the function
   into `src/lib/pos/` is explicitly rejected there and stays rejected).
2. **The resolution, which this task records:** pure money arithmetic lives in an **isomorphic**
   `src/lib/money/`, importable by `src/lib/server/**`, by `src/lib/pos/**` and by
   `src/routes/(pos)/**` alike. `src/lib/server/money/` is **kept**, and keeps only helpers that
   touch the database (reading a rate out of `restaurant_settings`, mapping a `bigint` column). The
   reason, in one line for the commit message: the spec outranks `CLAUDE.md`, spec 17 requires one
   rounding function used by the POS as well as the server, and SvelteKit build-blocks
   `$lib/server/**` from the browser — so the arithmetic cannot live under `server/`.
3. **Verify the eslint boundary rather than guessing at it, then say what you found in the commit
   message.** The existing restriction in `eslint.config.js` lists the patterns `$lib/server/*`,
   `$lib/server/**`, `../server/*` and `**/lib/server/**`. None of them matches `$lib/money`, so
   `src/routes/(pos)/**` and `src/lib/pos/**` may already import `$lib/money` today. **No allowance
   is needed and none may be added** — do not widen or weaken that restriction.
4. Create `src/lib/money/README.md`. It must state, in prose:
   - what lives here (integer minor units, allocation, THE rounding rule, tax in both modes) and
     what does not (anything that touches the database — that is `src/lib/server/money/`);
   - that this module is **isomorphic** and therefore imports **nothing**: no sibling module, no
     `$lib/server/**`, and **no Node builtin** (`node:crypto`, `node:fs` …) — a `node:` import here
     breaks the browser build and takes the offline POS with it;
   - that money is integer minor units in `bigint` columns (`$8.50` is `850`) and that a float
     literal, `parseFloat`, `toFixed` or a second rounding helper anywhere in here is a bug
     (invariant 1);
   - that a tax **rate** is an integer in **basis points** (`825` = 8.25%), never a float like
     `0.0825` — `2415 * 0.0825` is `199.23749999999998`, and spec 17 carries full precision per line
     before rounding once at the total, so that error accumulates into the figure a tax filing
     reconciles against;
   - that ONE rounding rule lives in ONE function used by POS, server and reports: full precision per
     line, round once on the invoice total (spec 17's default, still subject to open decision 3 —
     T-03 obtains the answer, and nothing here may encode one before it does);
   - a pointer: `Spec 17, 18. Invariants 1, 7.`
5. In `eslint.config.js`, add a config object for `files: ['src/lib/money/**/*.ts']` whose
   `no-restricted-imports` uses the **same four patterns copied verbatim** from the existing
   `(pos)` block (`$lib/server/*`, `$lib/server/**`, `../server/*`, `**/lib/server/**`) with a
   message saying: `src/lib/money` is isomorphic — the POS totals a bill in the browser, so an
   import of `$lib/server/**` from here cannot work offline; DB-touching helpers belong in
   `src/lib/server/money/`. Copy the proven pattern list rather than inventing a new one.
6. Make the six `CLAUDE.md` edits (the `src/` tree block takes two of them — one line rewritten and
   one line inserted):
   - **invariant 1**: replace `NEVER arithmetic on money outside \`src/lib/server/money\`, which owns
     rounding and tax` with `NEVER arithmetic on money outside \`src/lib/money\` — the ISOMORPHIC
     module that owns rounding and tax and is imported by the server, the POS and reports alike;
     \`src/lib/server/money/\` holds ONLY helpers that touch the database`. Leave the rest of the
     sentence (float, `numeric` money column, `numeric(12,3)` quantities, one currency) untouched.
   - **the `src/` tree**: change the `server/` child line
     `money/        integer cents, allocation, THE rounding rule, tax in both modes` to
     `money/        ONLY money helpers that touch the DB — the arithmetic is src/lib/money/`, and
     insert a new line directly **above** the `pos/` line, at the same indentation as `pos/`:
     `money/          ISOMORPHIC: integer minor units, allocation, THE rounding rule, tax in both modes — imported by lib/server/** AND by (pos)`.
   - **the House convention paragraph**: replace `` `money/` is imported by everything and imports no
     sibling `` with `` `src/lib/money/` is ISOMORPHIC — imported by `lib/server/**`, by `lib/pos/`
     and by `routes/(pos)/**`, and it imports nothing at all: no sibling, no `lib/server/**`, no Node
     builtin ``.
   - **the routing table**: in the row `| Prices, totals, tax, rounding, currency | ... |`, change the
     code cell from `` `lib/server/money` `` to `` `lib/money` ``.
   - **"Decisions already made"**: append a bullet —
     `**The money arithmetic is ISOMORPHIC, in \`src/lib/money/\`.** Spec 17 requires one rounding
     rule in one function used by POS, server and reports; SvelteKit build-blocks \`$lib/server/**\`
     from the browser and \`eslint.config.js\` errors on it from \`(pos)\`; the spec outranks this
     file, so invariant 1's wording was corrected rather than the spec bent.
     \`src/lib/server/money/\` remains, for DB-touching helpers only. Copying a rounding function into
     \`src/lib/pos/\` stays forbidden — two copies of a rounding rule is the bug spec 17 exists to
     prevent.`
7. Rewrite the `## Read this before writing any code here — the placement is UNRESOLVED` section of
   `src/lib/server/money/README.md` as `## The placement is RESOLVED (2026-09-14)`, stating the same
   decision and what is left here (DB-touching helpers only). Keep the rest of that README's rules
   section. Do **not** delete the directory.
8. **Write no arithmetic.** No `index.ts`, no function, no constant, no type. `src/lib/money/`
   contains exactly one file — `README.md` — when this task is done. The first function is T-33's.

**Tests:**

- No unit test: this task writes no code to test. It is verified by lint, by typecheck, and by two
  throwaway probes below.
- **Probe A (server boundary)** — create `src/lib/money/probe.ts` containing
  `import { db } from '$lib/server/db/client';` and `export const x = db;`, run `pnpm lint`, confirm
  ESLint reports `no-restricted-imports` on that line, then **delete the file**. If it does not
  error, the new eslint block is not matching and the task is not done.
- **Probe B (POS may import money)** — create `src/lib/money/probe.ts` containing
  `export const ok = 1;` and `src/lib/pos/probe.ts` containing
  `import { ok } from '$lib/money/probe'; export const v = ok;`, run `pnpm lint`, confirm there is
  **no** error, then **delete both files**. This is the assertion that no eslint allowance was
  needed.
- `pnpm lint && pnpm check && pnpm test` all pass with no probe files left behind.

**Done when:** `git status` shows exactly the four files above changed or added; `ls src/lib/money/`
prints `README.md` and nothing else; `pnpm lint && pnpm check && pnpm test` pass. And these three
greps, whose expected counts are written out because each names a different subset of step 6's six
edits. `CLAUDE.md` is not hard-wrapped, so each of those edits occupies exactly one line and the
counts below are line counts:

- `grep -n 'src/lib/server/money' CLAUDE.md` returns **exactly two** lines — the rewritten invariant 1
  and the new "Decisions already made" bullet, both saying that path holds only DB-touching helpers.
  The rewritten `server/money/` tree line is deliberately **not** among them: step 6 writes it as
  `money/        ONLY money helpers that touch the DB — the arithmetic is src/lib/money/`, which names
  the new path and not the old one. Do not "fix" the tree line into matching, and do not delete the
  invariant-1 clause to make this grep return one line — that clause is the correction this whole
  task exists to make.
- `grep -n 'lib/money' CLAUDE.md` returns **exactly five** lines — invariant 1, the `server/money/`
  tree line (it points at `src/lib/money/`), the House convention paragraph, the routing-table row and
  the new decision bullet. The inserted `money/` tree line is not among them because it names no path,
  which is what the next grep is for.
- `grep -n 'ISOMORPHIC: integer minor units' CLAUDE.md` returns **exactly one** line — the `money/`
  line inserted beside `pos/` in the tree block, the sixth edit.

**Watch out:** Do not delete or move `src/lib/server/money/` — it stays, for helpers that touch the
database, and deleting it would make the invariant-1 correction read as "money moved out of the
server", which is not what was decided. Do not add `src/lib/money` to the `(pos)` eslint restriction:
that import is the entire point. Do not create `src/lib/money/index.ts` — a fresh session arriving at
T-33 must find an empty directory and a README, not a half-written module. `src/lib/pos/README.md`
already tells the reader to "move the pure function into an isomorphic module both sides import" and
needs no change; the `CLAUDE.md` design bullet "Money renders through the money module's formatter"
names no path and needs no change either.

---

### T-02 — Decide the `/pos` URL prefix and the service-worker registration policy

**Needs:** -
**Files:**

- `svelte.config.js` — EDIT (inside the `kit: { … }` object, beside `adapter: adapter()` and above
  the existing block comment about the CSRF origin check)
- `CLAUDE.md` — EDIT (two spots: the `(pos)/` line in the `src/` tree block; a new bullet appended to
  "Decisions already made (NOT open — do not re-litigate)")
- `src/lib/pos/service-worker-policy.test.ts` — NEW

**Spec:** 6 (the offline POS is built on a Service Worker + IndexedDB), 5 (the POS checks
`GET /api/menu/version` and downloads the full snapshot on a mismatch — a cached version response
would freeze the menu), 9 (cookie sessions: an authenticated page that survives logout in a cache is
a session that outlives the cookie)
**Invariants:** 12 (POS access = registered device + PIN; sessions are HttpOnly + Secure + SameSite
cookies, never `localStorage`, and SvelteKit's origin/CSRF check stays ON)

**Do:**

1. Read `svelte.config.js` first. Today `kit` contains exactly one key, `adapter: adapter()`,
   followed by a long comment explaining that no `csrf` option is set deliberately. Leave that
   comment and that behaviour alone.
2. Add `serviceWorker: { register: false }` to `kit`, with a comment saying why, in these terms:
   SvelteKit auto-registers `src/service-worker.ts` **at scope `/`** on every server-rendered page.
   A worker at scope `/` controls `/dashboard` as well as the till, so authenticated dashboard HTML
   and `__data.json` responses land in Cache Storage — which `/logout` does not clear, because
   deleting a session cookie does not delete a cache. The POS worker is therefore registered by hand,
   from the POS layout only, with `{ scope: '/pos' }` — no trailing slash, for the string-prefix
   reason spelled out in step 3.
3. Record the whole policy in `CLAUDE.md` under "Decisions already made", as one bullet with these
   six parts, each with its reason:
   - **The POS serves at a real `/pos/...` URL prefix.** Pages live under `src/routes/(pos)/pos/**`.
     A route group is **not** a URL segment: `src/routes/(dashboard)/dashboard/+page.svelte` serves
     at `/dashboard` because of the inner `dashboard/` directory, not because of the group name, and
     `src/routes/(pos)/+layout.svelte` contributes nothing to any path — so today there is no `/pos`
     URL at all and nothing for a worker to be scoped to.
   - **`kit.serviceWorker.register` is `false`.** The default is `true` and registers at scope `/`.
   - **The worker is registered manually from the POS layout, with `{ scope: '/pos' }` — no
     trailing slash, and that is the trap in the whole decision.** The Service Worker specification
     lets a script at `/service-worker.js` claim any scope at or below its own directory, so
     narrowing to `/pos` is legal and needs no `Service-Worker-Allowed` header; widening beyond the
     script's directory is what would need one, and this plan never needs it. Scope matching is a
     plain **string prefix** on the client URL — that is the specification's "Match Service Worker
     Registration" algorithm, whose own canonical example is that a scope of
     `https://www.google.com/maps` matches `https://www.google.com/mapsearch`
     (`https://github.com/w3c/ServiceWorker/issues/1272`, accessed 2026-09-14). **MDN's prose implies
     a path-segment match; MDN is wrong on this point and the specification governs — do not
     "correct" this back.** So `/pos` matches `/pos` — the till's own landing screen — as well as
     `/pos/register` and `/pos/pin`, while `/pos/` would match the latter two and **not** the landing
     screen, leaving the URL the till starts at uncontrolled and unable to load offline; SvelteKit's
     `trailingSlash: 'never'` default means there is no `/pos/` URL at all, so a `/pos/` scope would
     leave the till's entry page uncontrolled and defeat the whole surface. The web app manifest's
     `scope` and `start_url` are the same literal `/pos`, which keeps one spelling across worker and
     manifest and avoids that default answering `/pos/` with a redirect. If an assertion anywhere in
     this plan is ever "fixed" by adding a trailing slash, the fix is wrong.
   - **The rule that keeps that scope safe, and it is structural rather than something to remember:
     no route outside the `(pos)` group may have a URL path beginning with the characters `pos`,
     because the service-worker scope is a string prefix.** Write that reason into `CLAUDE.md` in the
     same sentence as the rule, and repeat it wherever the rule appears — a rule without its reason
     gets deleted by the next person who finds it arbitrary. The consequence for this plan: the
     dashboard page that registers, revokes and launches the till is **`/device`**, not
     `/pos-device`. A worker scoped to `/pos` **would** control `/pos-device`, because the string
     `/pos-device` starts with the string `/pos`, and `/pos-device` is a dashboard route — which is
     precisely the blocker this phase exists to prevent: the POS worker taking control of an
     authenticated dashboard page and serving its HTML and `__data.json` out of Cache Storage after
     logout, which `/logout` does not clear. Renaming the route removes the collision structurally,
     because `/device` cannot be prefixed by `/pos` under any matching rule, so no future reader has
     to reason about scope semantics to stay safe. The route directory is
     `src/routes/(dashboard)/device/` (T-21 creates it, T-29 finishes it), the `NavItem` href literal
     union in `src/lib/components/ui/Sidebar.svelte` gains `'/device'`, and the rail item's **label
     stays `POS`** — the user asked for a rail item called POS and that does not change; only its
     `href` is `/device`. Say in `CLAUDE.md` that the label and the URL differ on purpose: `/pos`
     belongs to the till, so the dashboard page that manages it cannot have that URL. T-45 walks the
     route tree and fails on any route outside the group whose path begins with `pos`.
   - **The worker precaches the POS shell's own build assets AND one POS app-shell document, and
     serves that shell as the navigation fallback for every navigation it controls — every document
     request under the `/pos` prefix — whenever the network is unavailable.** Without a cached
     navigation response there is nothing to answer a reload or a cold start of `/pos/...` with the
     network down: the request fails, the precached build assets are never reached, and the till
     cannot start offline at all. Spec 6 requires the opposite ("the POS should be capable of
     continuing to work when the Internet temporarily disappears", built on a Service Worker plus
     IndexedDB), and this file's own `(pos)/ … MUST work offline` says the same. **The cached shell
     carries no per-employee and no per-session data** — no employee list, no employee name, no PIN
     hash, no rendered session state, nothing that identifies who is signed in — so a shell served
     from the cache cannot outlive a revoked device cookie or a signed-out employee. Everything
     session-shaped is fetched at runtime into that shell and fails closed when it cannot be.
   - **Everything else is network-only, and the shell is the only document ever written to Cache
     Storage.** The worker never caches a document outside `/pos`, never caches a `__data.json`, and
     never caches an API response. Two mechanisms hold that, not one: the `{ scope: '/pos' }` above
     means a `/dashboard` navigation never reaches the worker in the first place, and inside `/pos`
     the worker's only cache write is the shell precache — there is no runtime `cache.put`, so an
     authenticated response has no path into the cache even for a URL the worker does control. Spec
     5's menu snapshot is cached in **IndexedDB by the application**, not in Cache Storage by the
     worker, so there is exactly one place a stale menu can live and one version number that governs
     it.
4. Edit the `(pos)/` line of the `src/` tree in `CLAUDE.md` to read
   `(pos)/pos/      POS shell at the REAL /pos/... URL prefix: PIN login, orders, payment, session open/close — MUST work offline. The group name is not a URL segment; the inner pos/ directory is what creates the path`.
5. Add `src/lib/pos/service-worker-policy.test.ts`, a plain unit test (the `unit` Vitest project
   picks up `src/**/*.test.ts` automatically, no config change):
   - `import svelteConfig from '../../../svelte.config.js';`
   - one `it('does not auto-register a service worker — the default scope is / and would control the dashboard')`
     asserting `svelteConfig.kit?.serviceWorker?.register` is `false`.
   - a comment saying the scope and cache-policy assertions arrive with the worker itself (T-45) and
     must not be stubbed here.
6. Do **not** create `src/service-worker.ts` and do **not** register anything — that is T-27. Do
   **not** move, create or rename any route — the till's own move under `/pos` is T-23, and the
   dashboard device page is created at `src/routes/(dashboard)/device/` by T-21. This task changes
   configuration and writes the decision down; nothing under `src/routes/` is touched.

**Tests:**

- `src/lib/pos/service-worker-policy.test.ts`: `svelteConfig.kit.serviceWorker.register === false`.
  Flipping it to `true` (or deleting the key) makes the test fail — check that by hand once before
  committing.

**Done when:** `pnpm test:unit` passes including the new file; `grep -n 'serviceWorker' svelte.config.js`
shows `register: false`; `grep -n '(pos)/pos/' CLAUDE.md` finds the tree line; the new
"Decisions already made" bullet states the route-naming rule **with its string-prefix reason in the
same sentence** and names `/device` as the dashboard page's URL; `grep -n 'pos-device' CLAUDE.md`
returns **nothing** — the rejected name appears in this plan file as the worked example and must not
be copied into `CLAUDE.md` as a path; `pnpm check` and `pnpm lint` pass; `src/service-worker.ts`
still does not exist and `src/routes/` is unchanged.

**Watch out:** `kit.serviceWorker` is optional in SvelteKit's `Config` type, so write
`svelteConfig.kit?.serviceWorker?.register` — a non-optional access will not typecheck under
`strict`. `svelte.config.js` is not in the generated tsconfig's `include` list, but `allowJs` and
`checkJs` are on and TypeScript pulls in an imported file regardless, so the import typechecks; do
not "fix" this by adding the file to `include`. `eslint.config.js` restricts `src/lib/pos/**` from
importing `$lib/server/**` — a relative import of `../../../svelte.config.js` matches none of those
patterns and is fine. Service workers require a secure context (HTTPS, with `localhost` exempted for
development): no task may drop the `Secure` cookie attribute or work around HTTPS to make local
testing easier.

---

### T-03 — Obtain and record the four unanswered decisions (tax mode, currency, idle lock, PIN hash)

**Needs:** -
**Files:**

- `CLAUDE.md` — EDIT (the numbered list under "Open decisions — UNRESOLVED (spec 33)": narrow or
  delete rows 3, 4 and 6 according to the answers; and "Decisions already made (NOT open — do not
  re-litigate)": append one bullet per answer)
- `tasks/pos-access-and-menu/00-overview.md` — EDIT (four of the **five** bullets under
  "## Assumptions (open decisions this plan rides on)", found by their leading text and never by
  counting or by searching for one marker: **Open decision 3 (tax rules)**, **Open decision 4
  (currency)** and **Open decision 6 (idle lock)** each carry `— UNANSWERED.`; the **PIN hash
  algorithm** bullet carries `— NOT IN SPEC 33, and this plan forces it.` instead and must be edited
  too; **Open decision 1 (one device vs a later second terminal)** carries no marker, is not one of
  T-03's questions, and is left exactly as it is)

**Spec:** 33 (open decisions 3, 4 and 6, each with its recommended default), 17 (tax mode is a
restaurant setting; one rounding rule; default is full precision per line, rounded once on the
invoice total, "Confirm against local requirements"), 7 (PIN rules: 4–6 digits, "stored only as slow
salted hashes (e.g. Argon2 or bcrypt)"; idle return to employee select, "default 2 minutes,
configurable"), 6 (switching employees offline uses PIN hashes **cached on the registered device**)
**Invariants:** 1 (money is integer minor units; one currency in the MVP), 7 (tax mode is a
restaurant setting read at calculation time, never hardcoded; ONE rounding rule), 12 (PINs are 4–6
digits stored only as slow salted hashes; idle return, default 2 min, configurable)

**This is a STOP-AND-ASK task.** It writes no code. Put all four questions to the user in one
message, wait for answers, then record them. A default may be carried **only** if the user says so
in words; silence, a shrug, or your own confidence is not an answer, and "no reply" is not
"proceed". If the user answers some and not others, record what was answered and stop on the rest.

**Do:**

1. Ask **(a) — open decision 3, tax.** Three questions:
   - Are menu prices **tax-inclusive** or **tax-exclusive**? (Spec 17's worked example: at 10%, an
     exclusive $10.00 menu price bills $11.00; an inclusive $11.00 menu price bills $11.00 and books
     $10.00 of revenue. Either way the customer pays $11.00 and revenue is $10.00 — the difference is
     which number the owner types into the menu.)
   - **Rounding**: confirm spec 17's default — calculate tax at full precision per line and round
     **once** on the invoice total — or name the rule local law requires instead.
   - Is the tax rate **one per restaurant**, or per menu item / per category? (A per-item rate is a
     column on the menu item; a per-restaurant rate is a settings column. Changing this later is a
     migration.)
   - **Default carried if the user says to proceed:** tax mode is a **nullable** settings column with
     **no column DEFAULT**, one rate per restaurant stored as an integer in basis points, round once
     on the invoice total.
   - Say plainly that spec 33 row 3 also covers legal receipt requirements and tax on staff meals,
     that this plan builds neither receipts nor comps, and that those parts of the row stay open.
2. Ask **(b) — open decision 4, currency.** Which **ISO 4217 code** (`USD`, `SOS`, `KES`, …) and what
   **minor-unit exponent** (2 for cents, 0 for a currency with no minor unit)? The formatter and
   every `bigint` minor-unit value depend on it: at exponent 2, `850` is `8.50`; at exponent 0, `850`
   is `850`. Spec 17's "$8.50 is 850" is an illustration, not a decision. Say that spec 33 row 4 also
   asks which payment methods launch, that this plan takes no payments, and that that half of the row
   stays open.
3. Ask **(c) — open decision 6, idle lock.** How many **seconds** of inactivity before the POS
   returns to the employee-select screen? **Default carried:** 120 (spec 7's "default 2 minutes,
   configurable"), stored as a **nullable** settings column with no column DEFAULT. Say that spec 33
   row 6 also covers approval limits for discounts and pay-outs, that this plan builds neither, and
   that that half of the row stays open.
4. Ask **(d) — the PIN hash algorithm. This is not in spec 33; this plan forces the question.**
   Present it as a recommendation with its reasoning, not as a menu:
   - **Recommended: PBKDF2-HMAC-SHA256, 600,000 iterations** (the OWASP Password Storage Cheat Sheet's
     figure), a 16-byte random salt and a 32-byte derived key, via WebCrypto's
     `crypto.subtle.deriveBits`, stored as a PHC-style string so the parameters travel with the hash
     and the cost can be raised later without invalidating stored hashes — exactly the shape
     `src/lib/server/auth/password.ts` already uses for passwords.
   - **Why not the server's argon2id:** WebCrypto has **no** Argon2, `node:crypto`'s argon2 has no
     browser build, and spec 6 requires the browser to verify a PIN **offline** from hashes cached on
     the device. PBKDF2 is the one algorithm with an identical code path in Node 24 and in every
     target browser, and it adds **no** runtime dependency to a project whose dependencies are
     exactly `drizzle-orm`, `pg` and `zod` — a WASM Argon2 would be the first.
   - **Why this does not contradict spec 7:** spec 7 says "stored only as slow salted hashes (e.g.
     Argon2 or bcrypt)". The "e.g." names examples, not a closed list, and neither example runs in a
     browser.
   - Ask whether 600,000 iterations is acceptable **on the actual counter tablet** — it is
     deliberately slow, and on a low-end device a PIN check can take the better part of a second. If
     it is too slow, the iteration count is the thing to change, and it must be changed **by
     decision, recorded here**, never quietly in code.
5. In the same message, put the **GAP** to the user, because T-06 writes the PIN column right after
   this and the answer changes what gets built: a 4–6 digit PIN has at most **10^6** possible values,
   and spec 6 requires those hashes to be cached on the registered device — so whoever takes the
   tablet holds both the hashes and unlimited offline guesses, and **no choice of algorithm changes
   that**. The controls that already exist: the PIN is useless without a **registered device**, the
   owner can **revoke** that device from the dashboard (spec 7), and every action that moves money
   needs an **owner PIN approval** (spec 8). Offer the three options:
   1. **Accept it** — the plan proceeds as written; this is the default it currently carries.
   2. **Require 6 digits** rather than spec 7's 4–6: 100× the guessing work, and it changes one
      validation bound in T-06 and T-26.
   3. **Expire the cached bundle** — refuse offline employee *switching* after N hours without a
      sync, while the already-signed-in employee keeps working (spec 6 guarantees only the latter).
      This changes what T-28 stores.
6. Record every answer in `CLAUDE.md`, which is the **committed** record:
   - Append one bullet per answer to "Decisions already made (NOT open — do not re-litigate)", each
     stating the answer, the date, and — when a default was carried — the fact that the user
     explicitly said to proceed with it.
   - In the "Open decisions — UNRESOLVED (spec 33)" list: **delete** a row only when every part of
     that decision is answered; otherwise **rewrite** the row so it asks only what is still open
     (row 3 keeps legal receipt requirements and tax on staff meals; row 4 keeps payment methods;
     row 6 keeps approval limits). **Never renumber the remaining rows** — those numbers are spec
     33's, and a renumbered row 5 silently re-points every `(spec 33)` citation in the codebase.
7. Mirror the same answers into `tasks/pos-access-and-menu/00-overview.md`, under
   "## Assumptions (open decisions this plan rides on)". That section has **five** bullets and only
   **three** of them contain the string `— UNANSWERED.`, so locate each by its leading text — a
   session that greps for `UNANSWERED` and stops will silently skip the one answer this task
   *creates*:
   - **Open decision 3 (tax rules) — UNANSWERED.** → replace that marker with `— ANSWERED <date>:`
     plus the tax mode, the rounding rule, and whether the rate is per-restaurant or per-item.
   - **Open decision 4 (currency) — UNANSWERED.** → `— ANSWERED <date>:` plus the ISO 4217 code and
     the minor-unit exponent.
   - **Open decision 6 (idle lock) — UNANSWERED.** → `— ANSWERED <date>:` plus the number of seconds.
   - **PIN hash algorithm — NOT IN SPEC 33, and this plan forces it.** → replace that marker with
     `— NOT IN SPEC 33; this plan forced the question, ANSWERED <date>:` plus the algorithm and its
     parameters, the digit bound (4–6 or 6), and which of step 5's three GAP options the user chose.
     This bullet has no `UNANSWERED` marker and is the easiest edit in the task to miss, and it is
     the one answer that exists nowhere else: spec 33 does not carry the question, so if it is not
     written here and in `CLAUDE.md` it is not written down at all.
   - **Open decision 1 (one device vs a later second terminal).** → **leave it untouched.** T-03 does
     not ask it, it carries no marker, and answering it here would be inventing a decision.
   Change only the marker and add the answer after it; keep each bullet's `Blocks T-xx` tail, which is
   how a later session sees which tasks the answer unblocked.
8. State in the task's commit message which tasks were unblocked. **Blocked until this task records
   answers:** T-06 (PIN columns on `users` — needs the hash algorithm and the digit bound), T-08 (the
   nullable idle-lock setting — needs the seconds), T-11 (the isomorphic PIN hash module — needs the
   algorithm and its parameters), T-34 (tax in both modes — needs the mode and the rounding rule),
   T-35 (the money formatter — needs the currency code and exponent), T-36 (the tax-mode and currency
   settings columns), and T-37 transitively (the menu schema, whose price columns depend on T-36).

**Tests:** none — this task writes no code. Its output is a record, and the "Done when" below is what
checks it.

**Done when:** `git diff CLAUDE.md` shows one new "Decisions already made" bullet per answer given;
no row still standing in "Open decisions — UNRESOLVED" asks a question that has now been answered;
the surviving rows keep their original spec 33 numbers; every carried default is written down
together with the words in which the user authorised it; and in
`tasks/pos-access-and-menu/00-overview.md` each of the four Assumptions bullets T-03 asks about
(decisions 3, 4 and 6 plus the PIN hash) carries an `ANSWERED <date>:` marker for every question that
was answered — including the PIN-hash bullet, which never said `UNANSWERED` — while the fifth bullet,
open decision 1, is byte-for-byte unchanged.

**Watch out:** `tasks/` is in `.gitignore`, so the `00-overview.md` edit will **not** appear in the
commit — `CLAUDE.md` is the record that survives, and an answer recorded only in `tasks/` is an
answer that is lost. Never encode an answer anywhere else in this task: not in a schema file, not in
a migration, not in a column `DEFAULT`, not in a constant.
`src/lib/server/db/schema/restaurant-settings.ts` already carries a comment forbidding tax mode, tax
rate, currency, approval limits and idle-lock seconds from being added "with a sensible default", and
explaining why: a migration that has run cannot be hand-edited back (invariant 2), and a column
`DEFAULT` answers the open decision for every restaurant already registered. If the user answers only
some of the four, record those and **stop** — do not start T-06 or T-34 on the strength of a default
nobody confirmed.

---

### T-04 — Make the schema guard require `bigint` for money and notice undiscovered tables

**Needs:** -
**Files:**

- `src/lib/server/db/schema-guards/schema.test.ts` — EDIT (three places: the
  `it('discovers the tables it is meant to guard')` block near the top of the `describe`; the
  `it('no floating-point or unconstrained decimal column exists (invariant 1)')` block at the bottom
  of the file; and the module scope above the `describe`, where the new helper and its constants go)
- `src/lib/server/db/test/reset.ts` — EDIT (the `const TABLES = [...] as const;` declaration near the
  top — add `export`; change nothing else in the file)

**Spec:** 17 ("Amounts are stored as **integers in minor units** (cents) in `bigint` columns";
"Ingredient quantities use fixed-precision decimals (e.g. `numeric(12,3)`)"), 3 (the database is the
source of truth and its data-integrity rules are enforced in the schema), 29 (money arithmetic is one
of the six areas that gets automated tests from day one)
**Invariants:** 1 (money is integer minor units in `bigint`; NEVER a float or a `numeric` money
column; ingredient quantities are the one exception, `numeric(12,3)`), 11 (every timestamp is
`timestamptz` — the existing guard this one is extended beside)

**Do:**

1. Read `src/lib/server/db/schema-guards/schema.test.ts` in full first. It discovers tables from the
   schema modules' exports, exempts three tables from the `restaurant_id` rule by name, asserts every
   timestamp is `timestamptz`, and rejects `real`, `double precision` and bare `numeric` / `decimal`.
   What it never does is assert that a money column **is** `bigint` — so `numeric(12,2)` for a price
   passes today, and `pg` then returns that value as a **string**, which the first arithmetic turns
   into a float.
2. **Establish and write down the naming convention this guard enforces**, as a comment block above
   the new helper. It is a decision this task makes, and every later schema task is held to it:
   - a **money** column's name ends in `_minor` and its type is `bigint` — `price_minor`,
     `total_minor`, `opening_cash_minor`;
   - a **rate or percentage** is an integer in **basis points** and its name ends in `_bp` —
     `tax_rate_bp`, where `825` means 8.25%; never a float, never a `numeric`;
   - an **ingredient quantity** is `numeric(12, 3)` and its name contains `qty` or `quantity`.
3. Replace the body of the existing float/decimal test with a call to one new module-level helper so
   the same code can be pointed at fixture tables:
   `function numericColumnOffenders(list: { name: string; table: PgTable }[]): string[]`.
   For each column take `sql = column.getSQLType().toLowerCase()` and
   `compact = sql.replace(/\s+/g, '')` — **drizzle returns `numeric(12, 3)` with a space after the
   comma**, so every comparison must be against the whitespace-stripped form. Build one location
   prefix per column — a `where` string reading `<table>.<column> is "<sql type>"`, with the
   lowercased `sql` — and push one message per offence, each being that prefix followed by the
   ` — <what to do instead>` tail quoted below.

   **The rules do NOT short-circuit: every rule a column violates pushes its own message.** Write
   them as independent `if` statements over the same column — **no `continue`, no `else if`, no early
   `break`**. The existing test the helper replaces ends its first branch with `continue`; that line
   is the thing to drop, not the thing to copy. This matters concretely: a `price_minor` column typed
   `numeric(12, 2)` — the exact defect T-04 exists to catch — violates the fixed-point rule *and* the
   `_minor` rule, and only the second message names `bigint`, which is what step 5's fixture case and
   the "Done when" check below both assert on. A short-circuiting helper emits only the fixed-point
   message and both of those checks fail.

   The rules, with the message tail each one pushes verbatim:
   - `sql === 'real' || sql === 'double precision'` →
     ` — money is bigint minor units, never a float`.
   - `compact === 'numeric' || compact === 'decimal'` →
     ` — numeric needs explicit precision and scale, e.g. numeric(12,3)`.
   - `compact` starts with `numeric(` or `decimal(` and is **not** `numeric(12,3)` →
     ` — the only permitted fixed-point type is numeric(12, 3), for ingredient quantities`.
   - `compact === 'numeric(12,3)'` but the column name does **not** match
     `/(^|_)(qty|quantity)(_|$)/` →
     ` — a numeric(12, 3) column is an ingredient quantity; name it <thing>_qty`.
   - the column name ends in `_minor` and `sql !== 'bigint'` →
     ` — money is integer minor units in bigint (invariant 1)`. **This is the positive assertion the
     file was missing**, and the substring `money is integer minor units in bigint` is what the
     fixture assertion looks for, so write it exactly.
   - the column name ends in `_bp` and `sql !== 'integer'` →
     ` — a rate is an integer in basis points`.
   - the column name matches
     `/(^|_)(price|amount|total|subtotal|cost|fee|tax|discount|charge|tip|balance|cash)(_|$)/`, its
     name ends in neither `_minor` nor `_bp`, it is not listed in `MONEY_NAME_EXEMPT`, **and** its
     SQL type is one of `bigint`, `integer`, `smallint`, `real`, `double precision`, `money` or
     anything starting `numeric(`/`decimal(` → a money column is named `<thing>_minor` and typed
     `bigint`; a rate is an integer named `<thing>_bp`. Restricting this last rule to numeric-ish
     types is deliberate: a `text` column called `tax_mode` is a setting, not an amount. Message
     tail: ` — a money column is named <thing>_minor and typed bigint; a rate is an integer named
     <thing>_bp`.
   Add `const MONEY_NAME_EXEMPT: Record<string, string> = {};` — keyed `table.column`, valued with
   the reason — carrying the same header the existing `TENANT_COLUMN_EXEMPT` uses: adding to this
   list is a plan's decision, never a convenience. It starts **empty**.
4. Keep the existing assertion running over the real tables, renaming its title to
   `'every money column is bigint minor units, and no float or unconstrained decimal exists (invariant 1)'`
   and asserting `expect(numericColumnOffenders(tables), …).toEqual([])`. It must pass against
   today's schema, which has no money column at all — including `audit_log.id`, which is `bigint` and
   must not be flagged, because every money rule keys off the column **name**, never the type.
5. Add a second `it` that runs the helper over **fixture** tables declared in this test file with
   `pgTable` (never exported, never added to the `modules` object). Cases and expected results:
   - `numeric('price_minor', { precision: 12, scale: 2 })` → **flagged twice**, once by the
     fixed-point rule and once by the `_minor` rule (this is what "the rules do not short-circuit" in
     step 3 buys). Assert the `bigint` one specifically:
     `expect(offenders.some((m) => m.includes('price_minor') && m.includes('money is integer minor units in bigint'))).toBe(true)`
     — asserting only that the list is non-empty would pass on the fixed-point message alone, which
     never names `bigint` and would not have caught the defect;
   - `bigint('price', { mode: 'bigint' })` → **flagged** (right type, wrong name);
   - `integer('tax_rate')` → **flagged** (a rate must be `_bp`);
   - `numeric('flour', { precision: 12, scale: 3 })` → **flagged** (a quantity must be named so);
   - `bigint('total_amount_minor', { mode: 'bigint' })` → **not** flagged;
   - `integer('tax_rate_bp')` → **not** flagged;
   - `numeric('flour_qty', { precision: 12, scale: 3 })` → **not** flagged;
   - `text('tax_mode')` → **not** flagged.
6. Strengthen the discovery test so a schema file nobody imports cannot pass silently. Add a
   module-level `const IMPORTED_SCHEMA_FILES = ['audit.ts', 'restaurant-settings.ts',
   'restaurants.ts', 'sessions.ts', 'users.ts'];` beside the existing imports, and an
   `it('imports every file in src/lib/server/db/schema')` that does
   `readdirSync(new URL('../schema', import.meta.url))` (`node:fs`; the `unit` project runs in the
   `node` environment), filters to names ending `.ts`, sorts, and compares to
   `[...IMPORTED_SCHEMA_FILES].sort()`. Adding a schema file then fails this test until the file is
   both imported at the top of the guard and listed in the constant. Keep the existing
   `'discovers the tables it is meant to guard'` assertion as it is.
7. Add `export` to `const TABLES` in `src/lib/server/db/test/reset.ts` and nothing else — the
   comment above it already says every later plan that adds a tenant table must add it there. Then
   add a third `it('truncates every table it guards')` to the schema guard importing
   `{ TABLES } from '../test/reset'` and asserting `[...TABLES].sort()` equals
   `tables.map((t) => t.name).sort()`. A table that exists but is never truncated leaks rows between
   integration test files, and the symptoms point away from the cause.
8. Run `pnpm test:unit` and confirm all of it passes against today's schema, which contains no money
   column — the money rules earn their keep the first time T-05, T-06 or T-37 adds one.

**Tests:** MANDATORY (spec 29 — money arithmetic and rounding: this is the schema-level half of it,
the guard that stops a money value ever being stored as anything but integer minor units).

- Real schema: `numericColumnOffenders(tables)` is `[]` today.
- Fixture: `price_minor` as `numeric(12, 2)` produces a message containing `price_minor` **and** the
  substring `money is integer minor units in bigint` (two messages are pushed for this column; this
  assertion is about the second). **This is the case the guard did not catch before this task.**
- Fixture: `price` as `bigint` is flagged (naming convention), `total_amount_minor` as `bigint` is
  not.
- Fixture: `tax_rate` as `integer` is flagged, `tax_rate_bp` as `integer` is not.
- Fixture: `flour` as `numeric(12, 3)` is flagged, `flour_qty` as `numeric(12, 3)` is not.
- Fixture: `tax_mode` as `text` is not flagged.
- Discovery: the file list read from `src/lib/server/db/schema/` equals `IMPORTED_SCHEMA_FILES`.
- Reset list: `TABLES` equals the discovered table names.

**Done when:** `pnpm test:unit` passes; temporarily adding
`priceMinor: numeric('price_minor', { precision: 12, scale: 2 })` to
`src/lib/server/db/schema/restaurants.ts` makes the money test **fail** with a message containing
`money is integer minor units in bigint` — not merely with the fixed-point message, which is the
symptom of a helper that short-circuited (revert it afterwards — do not run `pnpm db:generate`); temporarily creating an empty
`src/lib/server/db/schema/probe.ts` makes the discovery test **fail** (delete it afterwards);
`pnpm lint` and `pnpm check` pass.

**Watch out:** Do **not** put the fixture `pgTable`s in `src/lib/server/db/schema/` — that folder's
own header explains why: drizzle-kit `readdirSync()`s it with no extension filter and `require()`s
everything in it, so a file importing Vitest makes `pnpm db:generate` and `pnpm db:studio` abort with
"Vitest cannot be imported in a CommonJS module". They belong in the test file, and must not be
spread into the `modules` object or they will be picked up by the tenant and timestamp guards too.
`getSQLType()` returns `numeric(12, 3)` **with a space** — compare against the whitespace-stripped
form or every quantity column in the project will be reported as an offender. `audit_log.id` is a
`bigint` identity column and must stay unflagged: the rules key off the column name, never the type.
Leave `resetDb()` truncating in ONE statement — the foreign keys are `RESTRICT` and truncating
separately in the wrong order fails. This task adds no column and runs no migration; it only makes
the next plan's mistake impossible to commit quietly.
