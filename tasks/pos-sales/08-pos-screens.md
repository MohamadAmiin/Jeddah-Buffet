# Phase 5 (UI) — the till (T-30 … T-34)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 3 and Phase 4.

Everything in this phase lives under `src/routes/(pos)/pos/` and obeys that group's rules, which
are not negotiable: never import `$lib/server/**` (SvelteKit build-blocks it from the browser and
`eslint.config.js` errors on it, because a screen that needs the server cannot work offline); no
`+page.server.ts`, no `+layout.server.ts` and no blocking server `load` anywhere under the group;
every screen renders from what IndexedDB holds (`src/lib/pos/store.ts`, `orders.ts`, `session.ts`,
`queue.ts`) and treats the network as an accelerator, never a prerequisite. Colour never carries
meaning alone: every status is a glyph AND a word (`◇ NEW`, `● PAID`, `○`/`●`/`◐` for orders,
`● online` / `◆ offline` with the unsynced count, `✕` for a refusal, `▲` for an overage). Every
amount on screen is a `Minor` handed to the money module's formatter (`formatMoney`, or
`formatAmount` in a column whose header carries the currency code) and rendered in `font-mono
tabular-nums text-right`; a negative amount gets the formatter's leading `−` AND `text-danger`. The
screens never add, multiply, compare-and-adjust or round money: totals come from
`computeOrderTotals` (T-10), change from `changeDue` (T-11), and a component that contains
`parseFloat`, `toFixed`, `Number(` on an amount, or a call to `roundToMinor` is a bug — a tripwire
test in T-33 reads the page sources to say so. Every pressable surface takes `border
border-control-line` (a white key on the POS ground is 1.22:1; elevation cannot carry an edge) and
one of the four touch floors from `tokens.css`: `min-h-touch-min` (56px) for chips, segments and
per-line keys, `min-h-touch` (64px) standard, `min-h-touch-lg` (72px) for menu and keypad keys,
`min-h-touch-xl` (96px) for the one-touch closers Open session, Close session and Pay. No arbitrary
Tailwind value (`bg-[#…]`, `p-[57px]`, `grid-cols-[…]`) and no literal colour or size anywhere;
`text-ink-3` is legal ONLY on `bg-raise` — use `text-ink-2` on every other ground; a disabled
control swaps to `bg-disabled-bg text-disabled-ink`, keeps its border, and says WHY in words —
never `opacity`, never a dead key. Before writing any markup read `docs/design-system.md` §3
(status glyphs), §5 (touch targets), §6 (money rendering) and §7 (POS component rules), and open
the two untracked mockups `design/04-pos-order.html` and `design/05-pos-payment.html` in a
browser: they are the layout grammar (permanent guest check on the right, category tabs and a
generated key grid on the left, tenders that disable with a written reason, one horizontal
scroller and never a sideways-scrolling page). Components take their data as props or read it from
`src/lib/pos/**` and do no arithmetic of any kind on money.

---

### T-30 — The POS layout: employee state, idle watch, session chip, flush triggers, clock skew

**Needs:** T-25, T-26, T-28 (Do 8 types and caches the keys T-28 adds to `GET /api/pos/employees`)
**Files:**
- `src/routes/(pos)/pos/+layout.svelte` — EDIT (in `<script>`, after the second `onMount` — the
  one that declares `recount` and subscribes with `onUnsyncedChange` — and before the
  service-worker `onMount`; in the markup, inside the existing `<div role="status">` status bar,
  after the `{#if unsynced !== null}…{/if}` block. Keep EVERY existing comment and every existing
  line: the connection indicator, the unsynced count and the service-worker registration are not
  rewritten, only added to)
- `src/routes/(pos)/pos/+page.svelte` — EDIT (the employee-select screen: inside
  `loadDirectory()`, after the existing `await cacheSettings([{ key: 'posIdleLockSeconds', … }])`
  line and inside the same `try` block; and inside the `onMount` callback, as its first statement,
  before `void loadDirectory()`)
- `src/lib/pos/employee.svelte.ts` — EXTEND (created by T-26; add ONE exported constant,
  `RESTORED_CONTEXT`, beside `restoreFromMirror`. Do not rewrite the file)
- (no change to `src/lib/pos/queue.ts` or `src/lib/pos/session.ts`: the skew readers `lastSkewMs()`
  and `onSkew()` are T-25's exports — Do 7 — and `adoptServerSession` is T-24's — Do 8)
**Spec:** 6 ("The number of unsynced operations is always visible on screen"; the queue flushes
when "Internet returns"), 7 ("The POS returns to the employee selection screen after a set idle
time (default 2 minutes, configurable)"), 10 (a session belongs to one business date, shown as
chrome), 29 (no new server route, so no new permission row)
**Invariants:** 5 (offline work is protected; the unsynced count stays on screen; a parked op is
never dropped), 11 (business date, never the calendar date, is what the chip shows), 12 (device +
PIN; the idle lock is the nullable owner setting with NO fallback number anywhere in code)

**Do:**
1. Imports to add to the layout's `<script>`: `setContext` from `svelte`; `goto` from
   `$app/navigation`; `resolve` from `$app/paths`; `page` from `$app/state`; `createIdleWatch`
   from `$lib/pos/idle`; `readBoundDeviceId`, `readCachedIdleSeconds` from `$lib/pos/store` (add
   them to the existing import line); `signedIn`, `signOut`, `touch`, `restoreFromMirror`,
   `RESTORED_CONTEXT` from `$lib/pos/employee.svelte`; `flush`, `parkedCount`, `onFlushResult`,
   `lastSkewMs`, `onSkew` from `$lib/pos/queue` (all five are T-25's exports); `readLocalSession`
   from `$lib/pos/session`. Open
   `src/lib/pos/employee.svelte.ts` (T-26) for the exact form of `signedIn`: a module cannot
   export a reassignable `$state` binding, so it is either a `$state` object read as
   `signedIn.current` or a getter function — read it that way everywhere below, and never copy it
   into a local variable that would stop being reactive.
2. **The restore gate.** In `employee.svelte.ts` add
   `export const RESTORED_CONTEXT = 'pos.employee.restored';`. In the layout's `<script>` BODY —
   synchronously, before any `await`, because `setContext` only works during component
   initialisation — create one promise and publish it:
   ```ts
   let markRestored!: () => void;
   const restored = new Promise<void>((done) => (markRestored = done));
   setContext(RESTORED_CONTEXT, restored);
   ```
   Then in a new `onMount`: read `readCachedIdleSeconds()` into `let idleSeconds =
   $state<number | null>(null)` (a thrown read leaves it `null` — the inert case, never a
   number), call `restoreFromMirror(idleSeconds)` — ONE argument; T-26 declares the signature
   `restoreFromMirror(idleSeconds: number | null, now = Date.now())` and the module reads the
   clock itself, so the layout never passes a `now` — and then call `markRestored()`.
   Why the gate exists: in Svelte 5 a child page's `onMount` runs BEFORE its layout's, so a page
   guard that reads `signedIn` on mount would see `null` on every reload — before the mirror has
   been restored — and bounce the cashier to `/pos` mid-shift. T-31 to T-34 therefore `await
   getContext<Promise<void>>(RESTORED_CONTEXT)` before their first guard. `restoreFromMirror`
   refuses to restore when `idleSeconds` is `null` or when the mirror's `lastActiveAt` is more
   than `idleSeconds` ago (T-26's rule); nothing here softens that.
3. **The idle watch**, in a `$effect` (not `onMount`, because it must re-run when the employee,
   the route or the cached seconds change):
   ```ts
   $effect(() => {
     const here = page.url.pathname;
     const armed = signedIn.current !== null && here !== '/pos' && here !== '/pos/pin';
     if (!armed) return;
     const watch = createIdleWatch({
       seconds: idleSeconds,
       onIdle: () => { signOut(); void goto(resolve('/pos')); }
     });
     const poke = () => { watch.poke(); touch(); };
     addEventListener('pointerdown', poke);
     addEventListener('keydown', poke);
     return () => {
       removeEventListener('pointerdown', poke);
       removeEventListener('keydown', poke);
       watch.stop();
     };
   });
   ```
   `/pos/pin` keeps its own watch (it already has one; T-31 leaves it). `touch()` stamps the
   mirror's `lastActiveAt` on every interaction so a reload inside the idle window restores the
   employee and a reload outside it does not. `signOut()` clears the mirror in the same tick as
   the navigation. When `idleSeconds` is `null` the watch is inert by `createIdleWatch`'s own
   contract; there is NO `?? 120`, no `|| 120`, no constant of seconds in this file.
4. **Flush triggers.** Add a third `onMount`: call `void flush().catch(() => {})` once; add an
   `online` listener that calls it again; subscribe a SECOND `onUnsyncedChange` listener (leave
   the existing `recount` one untouched) that, when `navigator.onLine` is `true`, debounces 500 ms
   with `setTimeout` (clear the previous timer first) and then calls `flush()`. Remove both
   listeners and clear the timer in the cleanup. The bare `flush()` is T-25's
   `flush(fetchFn: typeof fetch = fetch, opts: FlushOptions = {}): Promise<FlushSummary>` with
   both defaults, and T-25 Do 4 makes it single-flight: a call while a run is in progress returns
   THAT run's promise and starts nothing (T-25's test "two concurrent `flush()` calls return the
   SAME promise object, and only one set of bodies is recorded"), so the three triggers here
   coalesce and this layout adds no lock. Open `src/lib/pos/queue.ts` and confirm the
   module-level `running` guard is there before relying on it; if it is absent, T-25 is not done
   — stop and report it rather than adding a second guard in the layout.
5. **The chips**, rendered inside the existing `<div role="status">` after the unsynced block,
   each as a `<span>` group separated by the existing `<span aria-hidden="true">·</span>`
   idiom:
   - the employee: `{signedIn.current.displayName} · {signedIn.current.isOwner ? 'Owner' :
     signedIn.current.roleName}` when signed in, else the words `Nobody signed in`;
   - the session chip, from `let session = $state<LocalSession | null>(null)` (the type
     `readLocalSession` returns; open `session.ts`): `○ No session` when `null`; when present,
     `● Session · business date {session.businessDate}` when the server has answered the
     `session.open` op (the field is a `YYYY-MM-DD` string) and `● Session · business date
     pending sync` while it is still `null`. When an employee is signed in the chip is an
     `<a href={resolve('/pos/session')}>` with `min-h-touch-min border border-control-line
     rounded-control bg-raise text-ink px-3 inline-flex items-center` — it is the way a cashier
     reaches the close screen (T-32), and the only navigation the layout offers;
   - `◆ {n} operations from a previous registration` when `parkedCount()` resolves `> 0`, in
     `bg-st-offline-bg text-st-offline` — permanent chrome, never a toast (T-25 parks an op the
     server answered `409 foreign_device`; it stays until the owner acts on the dashboard);
   - `◆ Clock is off by {n} min` when `Math.abs(skewMs) > 5 * 60 * 1000`, where `n` is
     `Math.round(Math.abs(skewMs) / 60000)` — a duration in minutes, not money, so `Math.round`
     is fine here;
   - `Idle lock not set` when an employee is signed in and `idleSeconds === null`. These words
     are NEW to this chip; the PIN page's own sentence for the same state, `Automatic return to
     employee select is not configured yet.`, stays exactly as it is — the chip is short because
     it sits in the status bar, and T-31 does not touch that sentence.
   Re-read `session` (via `readBoundDeviceId()` then `readLocalSession(deviceId)`; a `null`
   device id means no session) and the parked count on mount, on every `onUnsyncedChange`
   signal, on every `onFlushResult` event, and whenever `page.url.pathname` changes (a page
   writes the session store and then navigates, so the navigation is the signal). Use the same
   "only the newest read may land" counter the existing `recount` uses. The skew is read once on
   mount with `lastSkewMs()` and thereafter updated by an `onSkew` subscription (Do 7) — it needs
   no re-read of its own.
   The session-close-blocked reasons are NOT rendered here: they belong to T-32's close form.
6. Every `goto` in this file wraps its path in `resolve()` — the `svelte/no-navigation-without-
   resolve` rule that the `choose()` comment in the employee-select page,
   `src/routes/(pos)/pos/+page.svelte`, explains; a bare string path fails `pnpm lint`.
7. **Clock skew source.** T-25's flush measures the skew itself: on every `200` it reads the
   response's `Date` header and, when `Date.parse` gives a number, stores `skewMs =
   Date.parse(header) − now()` (server minus device — the sign is irrelevant here because Do 5
   shows `Math.abs`) and emits a `'skew'` flush event. T-25 exports two readers in `queue.ts`,
   beside `flush`: `lastSkewMs(): number | null` (`null` before any measured response) and
   `onSkew(listener: (skewMs: number) => void): () => void` (returns the unsubscribe). In the
   third `onMount`: `skewMs = lastSkewMs()`, then `const stopSkew = onSkew((value) => { skewMs =
   value; })`, and call `stopSkew()` in the cleanup. Do not fetch anything to measure it and do
   not add a reader of your own: the flush's own responses are the measurement, and the reader
   is T-25's. If `queue.ts` exports neither name, T-25 is not done — stop and report it.
8. **Employee-select page** (`src/routes/(pos)/pos/+page.svelte`). Extend the typed response
   body with what T-28 (a `Needs` of this task) added to `GET /api/pos/employees`. T-28 Do 4
   places the keys so: `device: { id: string; code: string }` (`code` is `POS1`); top-level
   `lastInvoiceSeq: number` (`0` when the device has no invoice yet); `settings: {
   posIdleLockSeconds: number | null; timeZone: string | null; acceptsCard: boolean | null;
   acceptsMobile: boolean | null }`; top-level `openSession: { id: string; openedByUserId:
   string; businessDate: string; openingCashMinor: string; openedAt: string } | null`. Open
   `src/routes/api/pos/employees/+server.ts` to confirm the placement before typing the body;
   a key that is not where T-28 put it means T-28 is not done — stop and report it. Then, inside
   the existing `try`, directly after the `cacheSettings` call for `posIdleLockSeconds`:
   ```ts
   await cacheSettings([
     { key: 'acceptsCard', value: body.settings.acceptsCard },
     { key: 'acceptsMobile', value: body.settings.acceptsMobile },
     { key: 'timeZone', value: body.settings.timeZone },
     { key: 'deviceCode', value: body.device.code }
   ]);
   await adoptServerHint(body.device.id, body.lastInvoiceSeq);
   await adoptServerSession(
     body.device.id,
     body.openSession === null
       ? null
       : {
           posSessionId: body.openSession.id,
           employeeId: body.openSession.openedByUserId,
           openingCashMinor: body.openSession.openingCashMinor,
           openedAt: body.openSession.openedAt,
           businessDate: body.openSession.businessDate
         }
   );
   ```
   `adoptServerHint` comes from `$lib/pos/invoice-sequence` (T-23) and only ever moves the
   device's next number UP. `adoptServerSession` comes from `$lib/pos/session`, where T-24 Do 9
   declares it as `adoptServerSession(deviceId: string, serverOpen: { posSessionId: string;
   employeeId: string; openingCashMinor: string; openedAt: string; businessDate: string | null }
   | null): Promise<'adopted' | 'closed' | 'unchanged'>` — the wire-to-argument mapping above is
   THIS page's job (T-24 says so: "T-30 maps the response into this shape at the call site"), so
   `session.ts` stays uncoupled from T-28's key names. Its behaviour, which nothing here changes:
   a non-null `serverOpen` whose `posSessionId` differs from the local row (or with no local row,
   or a `'closed'` one) is adopted as the local `'open'` session; a local row in state
   `'opening'` or `'closing'` (an op in flight) is left `'unchanged'`; `null` marks a local
   `'open'` row `'closed'` ONLY when no `sync_queue` entry for this device is `'pending'` or
   `'sending'` — an offline-opened session whose `session.open` op has not synced is unsynced work
   and is never touched; every other case is `'unchanged'`. Ignore the returned string here; the
   session chip re-reads `readLocalSession` on the navigation that follows. These four setting
   keys are the ones T-32 and T-34 read back with `readCachedSetting`. Values are cached AS THEY
   ARRIVED: `null` stays `null`.
9. In the same page's `onMount`, before `void loadDirectory()`, call `signOut()`: landing on the
   employee-select screen IS signing out, whichever way the cashier arrived (idle return, the Done
   key after a close, the browser's back button).

**Tests:**
- None automatable beyond `pnpm check` and `pnpm lint` (the idle watch itself is covered by
  `src/lib/pos/idle.test.ts`, the mirror by T-26's tests); T-38's e2e drives the idle return and
  the chips. `pnpm test:unit` must stay green: `src/lib/pos/service-worker-policy.test.ts` and
  `src/routes/route-guards.test.ts` walk the route tree and nothing here adds a server file or a
  route outside the group.

**Done when:** `pnpm build`, `pnpm check` and `pnpm lint` succeed; with an owner who set the idle
lock to 30 seconds on `/device`, signing in and leaving `/pos/order` untouched for 30 seconds
returns the till to `/pos` with `Nobody signed in` in the status bar; a reload of `/pos/order`
within those 30 seconds keeps the employee's name in the bar; the bar shows `○ No session` before
a session is opened and `● Session · business date YYYY-MM-DD` after the open op syncs; setting
the tablet clock 10 minutes ahead and syncing once shows `◆ Clock is off by 10 min`.

**Watch out:** `resolve()` for every `goto` (the eslint rule the `choose()` comment in
`src/routes/(pos)/pos/+page.svelte` explains). No `?? 120` fallback for the idle seconds: `null` stays inert and the chip says `Idle lock not set`.
The restore gate promise MUST be created in the script body, not inside `onMount` — `setContext`
after initialisation throws. Do not gate `{@render children()}` on the restore instead: that
would blank the server-rendered shell the service worker precaches for offline start. The layout
never reads `sessionStorage` itself; the mirror is T-26's, reached only through `restoreFromMirror`,
`touch` and `signOut`.

---

### T-31 — The PIN screen hands off to the session or order screen

**Needs:** T-30
**Files:**
- `src/routes/(pos)/pos/pin/+page.svelte` — EDIT (in `submit()`, the `response.status === 200`
  branch, which currently assigns `signedIn = { displayName: …, roleName: … }`; and the last statement
  of `signInOffline()`, which assigns the same `signedIn` from the cached record; plus the import
  block at the top of `<script>`)
**Spec:** 7 (PIN login; the employee then works the till), 10 (a shift starts with "Start POS
Session"), 6 ("The employee who is logged in keeps working" offline)
**Invariants:** 10 (the offline attempt is already recorded by `recordOfflineLogin` before this
hand-off; nothing here changes that), 12 (the PIN is cleared from memory exactly as before; nothing
new is stored in `localStorage`, `sessionStorage` or IndexedDB by this screen — the mirror write is
`signIn`'s, in T-26)

**Do:**
1. Add to the imports: `signIn` from `$lib/pos/employee.svelte`; `readLocalSession` from
   `$lib/pos/session`; `readBoundDeviceId` is already imported from `$lib/pos/store` — reuse it.
2. Write one local helper, `async function handOff(employee: SignedInEmployee)` (name the
   parameter type whatever T-26 exports for `signIn`'s first argument — open
   `employee.svelte.ts`): it calls `signIn(employee)` — ONE argument; T-26 declares
   `signIn(employee: SignedInEmployee, now = Date.now())` and stamps the mirror's `lastActiveAt`
   itself, so this page never passes a `now` — then reads
   `const deviceId = await readBoundDeviceId()`, then `const session = deviceId === null ? null :
   await readLocalSession(deviceId)` (a thrown read counts as `null`), then navigates with
   `void goto(resolve(session !== null ? '/pos/order' : '/pos/session'))`. `readLocalSession`
   returns the till's open session or `null` (T-24).
3. **The 200 branch.** PR #11 (`feat/employee-roles`, merged before this plan — T-01 verified it)
   made `POST /api/pos/pin` answer `200 { employeeId, displayName, isOwner, roleName }`. Replace
   the `signedIn = …` assignment with: look the employee up in the cache for the permission set —
   `const cached = (await readCachedEmployees()).find((e) => e.id === body.employeeId)` (a thrown
   read counts as not found) — then call
   `await handOff({ id: body.employeeId, displayName: body.displayName, isOwner: body.isOwner,
   roleName: body.roleName, permissions: cached?.permissions ?? [] })`. The permissions come from
   the cached record because the PIN endpoint does not return them; an empty set only hides
   nothing on these screens (this plan gates nothing on the till by permission — the server does,
   per op), so an unfilled cache is not an error.
4. **The offline branch.** In `signInOffline()`, replace the final `signedIn = { displayName:
   cached.displayName, roleName: cached.roleName }` with `await handOff({ id: cached.id, displayName:
   cached.displayName, isOwner: cached.isOwner, roleName: cached.roleName, permissions:
   cached.permissions })` — every field is on the cached employee record as PR #11 shaped it
   (`{ id, displayName, isOwner, roleName, permissions, isActive, pinPhc }`). This runs ONLY after
   `recordOfflineLogin` succeeded, exactly where the old assignment sat: an offline sign-in that
   could not be recorded still does not happen.
5. Keep the page's local `signedIn` state and its `{#if signedIn}` markup ONLY as the interim
   message that shows for the instant between `signIn` and the navigation landing: set it in
   `handOff` right before the `goto` (`signedIn = { displayName: employee.displayName, roleName:
   employee.roleName }` — the state's shape is `{ displayName: string; roleName: string }` and
   the markup reads `signedIn.roleName`; keep both as they are, and do not re-derive `'Owner'`
   from `isOwner`: the PIN endpoint and the cached record already carry `roleName = 'Owner'` for
   an owner) so the heading `Signed in as …` renders instead of an empty keypad. Delete the
   `Back to employee select` button under it and its comment about `/pos/order` not existing —
   it now does.
6. Nothing else changes: the two-try fetch with one `clientOpId`, the 423 lockout countdown, the
   401 and 403 branches, `forgetDevice` on 403, the page's own idle watch, and the `finally`
   that clears `digits` all stay exactly as they are.

**Tests:**
- None automatable beyond `pnpm check` and `pnpm lint`; T-38's e2e signs in online and offline and
  asserts the landing screen. `pnpm test:unit` stays green.

**Done when:** `pnpm build`, `pnpm check` and `pnpm lint` succeed; with no session open, a correct
PIN online lands on `/pos/session`; with the network disconnected (DevTools → Offline) and a cached
directory, a correct PIN lands on `/pos/session` too and the status bar shows `1 unsynced`; after a
session is opened, a correct PIN — online or offline — lands on `/pos/order`; the status bar shows
the employee's name and role on both screens.

**Watch out:** The PIN itself is cleared exactly as before (`digits = ''` in `finally` and in the
idle cleanup); nothing new is stored by this page. Do not read the session in the 200 branch before
`signIn` has run: T-32's and T-33's guards check the employee first, and a hand-off that navigates
before `signIn` completes lands on a guard that sends the cashier straight back to `/pos`.
`resolve()` around both destination strings.

---

### T-32 — `/pos/session`: open with a float, close with a count

**Needs:** T-30
**Files:**
- `src/routes/(pos)/pos/session/+page.svelte` — NEW
**Spec:** 10 ("Start POS Session → Opening Cash = $500 → … → Close POS Session → Count Cash →
Reconciliation"; "Every POS session belongs to one business date"; "Session close: requires a
connection and an empty sync queue"), 6 ("Logout and POS session close are blocked while the sync
queue is not empty. Closing a session requires a connection, because reconciliation runs on the
server"), 17 (money in integer minor units; business day, not calendar day), 24 (the over/short
posting is the server's — `cash_shortage_at_close` / `cash_overage_at_close`, T-20)
**Invariants:** 1 (money is integer minor units in bigint; the keypad builds a `Minor` from digits,
never a float), 5 (`session.open` is a queued op that works offline; close needs a connection and an
empty queue, and the control says why), 11 (the business date is the server's derivation from
`opened_at` in the restaurant's time zone; the till only previews it), 8 (server-side: `pos.payment`
is checked by the sync handler for both ops — a `403` on close is rendered here, never pre-empted)

**Do:**
1. Imports (all from the isomorphic or `lib/pos` side, none from `$lib/server`): `getContext`,
   `onMount` from `svelte`; `goto` from `$app/navigation`; `resolve` from `$app/paths`;
   `formatMoney`, `moneyFormatFor` from `$lib/money/format`; `minor`, type `Minor` from
   `$lib/money`; `signedIn`, `signOut`, `RESTORED_CONTEXT` from `$lib/pos/employee.svelte`;
   `openLocalSession`, `closeLocalSession`, `readLocalSession` from `$lib/pos/session` (T-24);
   `flush`, `parkedCount`, `onFlushResult` from `$lib/pos/queue` (T-25); `countUnsynced`,
   `onUnsyncedChange`, `readBoundDeviceId`, `readCachedSetting`, `readMenu`, `syncMenu` from
   `$lib/pos/store`.
2. **Guards**, in `onMount`, in this order, each a `goto(resolve(…))` followed by `return`:
   `await getContext<Promise<void>>(RESTORED_CONTEXT)`; no signed-in employee → `/pos`;
   `readBoundDeviceId()` null → `/pos` (the directory fetch there binds the device). Then load:
   `session = await readLocalSession(deviceId)`; `menu = await readMenu()`; the cached settings
   `timeZone` (string or `null`) via `readCachedSetting('timeZone')`. The money format is
   `moneyFormatFor(menu.currency)` — when `menu` is `null` or `menu.currency` is `null` render
   `◆ No menu on this device yet — connect once so the till can download it` with a `Retry` key
   (`min-h-touch-lg`) that calls `syncMenu()` then reloads the page state; no form is shown
   without a currency, because a float typed with no currency cannot be displayed.
3. **Connection and queue state**, read locally (the layout's `online` is not shared): `let
   online = $state(true)`, set from `navigator.onLine` in `onMount` with `online`/`offline`
   listeners removed in the cleanup; `let unsynced = $state<number | null>(null)` from
   `countUnsynced()`, re-read on every `onUnsyncedChange` signal; `let parked = $state(0)` from
   `parkedCount()`, re-read on the same signal.
4. **The money keypad**, one component-local snippet reused by both forms: `let digits =
   $state('')`; keys `1`–`9`, `0`, `⌫` (with `sr-only` "Delete the last digit"), `Clear`, each
   `min-h-touch-lg min-w-touch-lg border border-control-line rounded-control bg-raise text-ink
   font-mono text-title`; a press appends one digit and ignores a 13th (`digits.length < 12`);
   the readout above the keys is `formatMoney(minor(BigInt(digits === '' ? '0' : digits)),
   format)` in `font-mono tabular-nums text-right text-total text-ink` — the digits ARE minor
   units (`50000` reads `500.00 USD`), a caption in `text-ink-2` says `Keys enter cents: 50000 is
   500.00 USD`. `BigInt(digits)` is a conversion of a digit string, the one permitted way a typed
   amount becomes money; no `Number(`, no `parseFloat`, no decimal point key.
5. **OPEN form** — when `session === null`:
   - heading `Open a session` (`text-title`); the keypad labelled `Opening cash (the float)`;
   - the business date the till EXPECTS, for DISPLAY ONLY, computed as
     `new Intl.DateTimeFormat('en-CA', { timeZone: cachedTimeZone, year: 'numeric', month:
     '2-digit', day: '2-digit' }).format(new Date())` (`en-CA` yields `YYYY-MM-DD`), rendered as
     `Business date: 2026-09-28` in `font-mono`; when `cachedTimeZone` is `null` render `Business
     date: set when the server confirms (no time zone cached)` instead and do not call
     `Intl.DateTimeFormat` with an undefined zone; beside it the device clock,
     `new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new
     Date())`, refreshed every 30 seconds by an interval cleared on destroy; under both, the
     sentence `The server sets the business date from the moment you open` in `text-ink-2`;
   - the closer `Open session`: `min-h-touch-xl w-full border border-control-line rounded-control
     bg-accent text-accent-ink font-semibold text-pos`. On press: `const { posSessionId } = await
     openLocalSession({ deviceId, employeeId: signedIn.current.id, openingCashMinor:
     minor(BigInt(digits || '0')), now: new Date() })` (T-24 declares `{ deviceId: string;
     employeeId: string; openingCashMinor: bigint; now: Date }` — `now: Date`, not `occurredAt`;
     open `session.ts` and match it; it writes the local session record AND enqueues
     the `session.open` op with a fresh `clientOpId` in one IndexedDB transaction, offline or not),
     then `void flush().catch(() => {})` (NOT awaited — offline, the op waits in the queue and the
     shift starts anyway; R6: the server attaches to an already-open server session for this
     device instead of refusing), then `goto(resolve('/pos/order'))`. A thrown
     `openLocalSession` renders `✕ This device could not record the session — try again` in
     `bg-danger-bg text-danger` and stays on the form; nothing is retried automatically.
   - whenever a session record IS present — whether this till opened it or T-30's employee-select
     edit adopted it from the server through `adoptServerSession` (the case the employees
     endpoint reports: a server-side session still open on this device) — the open form is
     replaced by the CLOSE view below, whose top line reads `A session is already open on this
     till since <openedAt, formatted with the device's Intl default>` with a `Continue` closer
     (`min-h-touch-xl`, `bg-accent text-accent-ink`) that goes to `/pos/order`.
6. **CLOSE view** — when `session !== null`: the `A session is already open …` line and the
   `Continue` closer from step 5; then `Close this session` as a section heading; then the THREE
   blocking conditions, each rendered as its own line in `bg-st-offline-bg text-st-offline
   rounded-control px-3 py-2` ONLY while it holds, and the closer disabled while any holds:
   - `!online` → `◆ Offline — closing needs a connection`;
   - `unsynced !== null && unsynced > 0` → `◆ {unsynced} operations still syncing` (the count
     includes this session's own `session.open` op if it has not been answered yet; the close
     cannot go before it);
   - `parked > 0` → `◆ {parked} operations from a previous registration need the owner — see
     the dashboard`;
   and while `unsynced === null` (the count could not be read) the closer is disabled with
   `◆ Unsynced count unavailable — this device cannot prove its queue is empty`. A disabled closer
   is `bg-disabled-bg text-disabled-ink` with its border kept, and `aria-describedby` pointing at
   the reason lines' `id`s; it is never a dead key with no reason beside it.
   Then the keypad labelled `Counted cash`, and the closer `Close session` (`min-h-touch-xl`,
   `bg-accent text-accent-ink`) — the keypad and the closer are rendered ONLY while
   `session.state === 'open'`. On press: `const { clientOpId } = await closeLocalSession({
   deviceId, employeeId: signedIn.current.id, countedCashMinor: minor(BigInt(digits || '0')),
   now: new Date() })` (T-24 declares `{ deviceId; employeeId; countedCashMinor: bigint; now:
   Date }` — there is NO `posSessionId` argument: the module reads the session id from the local
   row; again match `session.ts`); SUBSCRIBE FIRST — `const stop = onFlushResult((event) => …)`,
   filtering on `event.clientOpId === clientOpId` — and only then `void flush().catch(() => {})`.
   While `session.state === 'closing'` (the row `closeLocalSession` wrote, whether this visit or
   an earlier one put it there) render the pending line `◐ Closing… waiting for the server` and
   NO Close form: no keypad, no closer. A re-read of `readLocalSession` after any flush event is
   what moves the view on.
7. **The server's answer**, from the flush event (open `queue.ts` for the event union's exact
   field names; a `done` event carries the server's `SyncResult` as `event.body`, its statuses
   are the `SyncResult` statuses in `00-overview.md`, and T-25's `rejected` and `stopped` events
   carry the HTTP status and body of a refusal):
   - `done` with `event.body.status` `accepted` (or `replayed`) → the result panel: three rows
     `Expected` = `minor(BigInt(event.body.expectedCashMinor))`, `Counted` = the amount typed,
     `Difference` = `minor(BigInt(event.body.differenceMinor))` — all through `formatMoney`,
     `font-mono tabular-nums text-right`; `event.body.businessDate` is the business date the
     session closed under, rendered as `Business date {businessDate}` in `font-mono` above the
     rows; the difference row carries its mark: negative → the formatter's leading `−`,
     `text-danger`, and the glyph `✕` with the word `Short`; positive → `▲` with the word `Over`
     in `text-warn`; zero (`=== 0n`) → `● Balanced` in `text-ok`. Under it: `The server posted
     the difference to 6800 Cash Over/Short` (negative or positive) or `Nothing was posted`
     (zero). Then a `Done` closer (`min-h-touch-xl`) that calls `signOut()` and
     `goto(resolve('/pos'))`. The till never computes expected cash: `expectedCashMinor` and
     `differenceMinor` are the server's decimal strings converted with `BigInt` and displayed.
   - `rejected` with http `403` (`{ error: 'not_permitted' }`) → `✕ Not permitted: this employee
     cannot close a session` in `bg-danger-bg text-danger`. The close op stays queued
     (`'pending'`, T-25 step 8) and the local row stays `'closing'`: show the refusal line, keep
     the Close form hidden, and tell the cashier in words that the close will retry once the
     owner has resolved it on `/reports/flagged` (`The close will retry by itself once the owner
     has resolved this on the dashboard`). `Done` is not offered; the cashier may sign out from
     the status bar.
   - `stopped` with `reason 'session_has_unrecorded_ops'` (http `409`, `count`) → `✕ {count}
     operations from this session need the owner's review on the dashboard before it can close`.
     Same handling: the close op stays queued (`'pending'`, T-25 step 8) and the local row stays
     `'closing'`; show the refusal line, keep the Close form hidden, tell the cashier the close
     will retry once the owner has resolved it on `/reports/flagged`; `Done` is not offered.
   - `stopped` with `reason 'network'` (a network error or a `5xx`) → the op stays queued and
     T-25 retries with backoff; keep the pending state and the words `◆ Waiting for a connection
     — the close is queued`; the subscription stays until an outcome arrives or the page is left.
   The two refusal lines are the ONLY mapping of `rejected` (http 403) and `stopped` (reason
   `'session_has_unrecorded_ops'`, with its `count`); every other event for this `clientOpId` is
   ignored. Unsubscribe (`stop()`) in the page's cleanup.
8. Every amount on this page goes through `formatMoney`; no `+`, `-`, `*`, `<` or `>` is
   applied to a `Minor` anywhere in the file except the `=== 0n` and `< 0n` tests on the
   difference, which classify and do not compute.
9. `<svelte:head><title>Session · matcami</title></svelte:head>`; `<main class="mx-auto flex
   max-w-2xl flex-col gap-4 px-4 py-8">` — the classes of the employee-select page's `<main>`
   (`src/routes/(pos)/pos/+page.svelte`; the PIN page's `<main>` is narrower, `max-w-md
   … items-center`, and is NOT the model here); every key `border
   border-control-line`; headings `text-title text-ink`; explanatory lines `text-ink-2` (this page
   sits on `bg-bg`, where `text-ink-3` is not legal).

**Tests:**
- None automatable beyond `pnpm check` and `pnpm lint`; the server figures are asserted by
  T-20's integration tests and T-38's e2e (open with `50000`, sell, count, assert the numbers the
  page shows equal `pos_sessions.expected_cash_minor` and `difference_minor`). T-33's source
  tripwire (`src/lib/pos/menu-view.test.ts`) reads THIS file too and fails on `parseFloat`,
  `.toFixed(`, `Number(`, `roundToMinor(`, `taxOnAmount(` or `taxOnLine(`.

**Done when:** `pnpm build`, `pnpm check` and `pnpm lint` pass; manually: from `/pos/session`
with no session, typing `50000` shows `500.00 USD`, the expected business date and the device
clock; `Open session` lands on `/pos/order` and the status bar shows `● Session · business date
pending sync` offline and the real date once online; after one cash sale of `20.57 USD` (T-34's
example) and a reconnect, `/pos/session` shows the close form with no blocking line, typing
`52057` and pressing `Close session` shows `Expected 520.57 USD · Counted 520.57 USD ·
● Balanced`; typing `51057` instead shows `Difference −10.00 USD ✕ Short` in `text-danger`, and
`53057` shows `Difference 10.00 USD ▲ Over`; with the network off the closer is disabled and
`◆ Offline — closing needs a connection` is on screen; `Done` returns to `/pos` with `Nobody
signed in`.

**Watch out:** The till never computes expected cash; it displays the server's answer. Subscribe
to `onFlushResult` BEFORE calling `flush()`, or a fast answer is missed and the page waits for
ever. The business date preview is `Intl` formatting of the device clock in the RESTAURANT's zone —
it is not stored, not sent, and not what the server uses (the server derives `business_date` in
SQL from `opened_at`, T-20); the sentence under it says so. `en-CA` is chosen because its default
date pattern is `YYYY-MM-DD` — not a locale preference, and not to be "corrected" to the user's
locale. No `+page.server.ts` beside this file, ever.

---

### T-33 — `/pos/order`: the split screen

**Needs:** T-30, T-32 (the source tripwire in `menu-view.test.ts` reads
`src/routes/(pos)/pos/session/+page.svelte`, which T-32 creates; run before T-32 the test throws
`ENOENT`)
**Files:**
- `src/routes/(pos)/pos/order/+page.svelte` — NEW
- `src/lib/pos/menu-view.ts` — NEW (pure helpers over `LocalMenu`; imports only
  `./store`'s types)
- `src/lib/pos/menu-view.test.ts` — NEW
- `src/lib/pos/orders.ts` — EXTEND (created by T-24; add exactly two pure functions,
  `setOrderType` and `lineAmounts`, beside `cartTotals` — Do 3. Every other cart helper this page
  uses is T-24's and is NOT re-declared. Do not rewrite the file)
- `src/lib/pos/orders.test.ts` — EXTEND (created by T-24; add one `describe('T-33 cart helpers')`
  block after T-24's blocks — the MANDATORY test below. Do not rewrite the file)
**Spec:** 5 (the grid is GENERATED from the cached menu snapshot; a hand-placed key is a second
source of truth), 13 ("Dine-in: linked to a table. Takeaway: no table; usually paid immediately";
item status `NEW` — "can be changed or deleted freely"), 14 ("Delete item | Before sending to
kitchen | None | None | No" — no reason code, no approval, no audit), 17 ("Each order line stores
the tax rate used"; one rounding rule, once, on the invoice total), 18 (the worked sale example
the totals block reproduces)
**Invariants:** 1 (integer minor units; the page contains no money arithmetic), 7 (each cart line
snapshots the unit price and the RESOLVED tax rate at the moment it is added; discount before tax
— the discount is `0n` throughout this plan; totals via the ONE `computeOrderTotals`), 9 (nothing
gated by owner PIN is built: no discount, no void, no comp — deleting a `NEW` line needs nothing),
12 (the screen works from IndexedDB only)

**Do:**
1. **`src/lib/pos/menu-view.ts`** — pure, DOM-free, no IndexedDB, no fetch, no money arithmetic:
   ```ts
   import type { LocalMenu } from './store';
   export type MenuItem = LocalMenu['items'][number];
   export type MenuGroup = LocalMenu['modifierGroups'][number];
   export type CategoryTab = { id: string; name: string; items: MenuItem[] };
   /** Categories in sortOrder, each with its items in sortOrder; an empty category is KEPT
    *  (its tab renders "No items"); items whose categoryId matches no category go under a
    *  final synthetic tab { id: 'other', name: 'Other' }, present only when such items exist. */
   export function itemsByCategory(menu: LocalMenu): CategoryTab[];
   /** The rate a line snapshots: the item's own taxRateBp when it is a number (0 is a rate,
    *  not "unset"), else the snapshot's; throws a TypeError naming the item when both are null. */
   export function resolveTaxRate(
     item: Pick<MenuItem, 'name' | 'taxRateBp'>,
     snapshot: Pick<LocalMenu, 'taxRateBp'>
   ): number;
   /** The item's modifier groups in the order of item.modifierGroupIds; throws a RangeError
    *  naming the item id and the group id when an id matches no group. */
   export function modifierGroupsFor(item: MenuItem, menu: LocalMenu): MenuGroup[];
   /** Basis points to "x.xx%": 825 → "8.25%", 0 → "0.00%", 10000 → "100.00%". A rate is not
    *  money; Math.trunc(bp / 100) and bp % 100 are integer arithmetic on a number. */
   export function formatTaxRate(rateBp: number): string;
   ```
   `formatTaxRate` throws the same `TypeError` as `tax.ts`'s guard for a non-integer or a value
   outside `0..10000`.
2. **Page load and guards** (`onMount`): `await getContext<Promise<void>>(RESTORED_CONTEXT)`; no
   signed-in employee → `goto(resolve('/pos'))`; `readBoundDeviceId()` null → `/pos`;
   `readLocalSession(deviceId)` null → `goto(resolve('/pos/session'))`. Then `menu = await
   readMenu()`: `null` → the left column shows `◆ No menu on this device yet — connect once so the
   till can download it` with a `Retry` key (`min-h-touch-lg`) calling `syncMenu()` then
   `readMenu()` again; `menu.currency === null` or `menu.taxMode` not one of `TAX_MODES` (import
   `TAX_MODES` from `$lib/money/tax`) → `✕ The restaurant's currency or tax mode is not set yet —
   the owner sets both on the dashboard Settings page` and no grid, because `computeOrderTotals`
   throws on an unset mode and `moneyFormatFor` on an unknown currency. Then `cart = await
   readCart(deviceId)` (T-24's `readCart(deviceId: string): Promise<Cart | null>`); when it
   resolves `null` (nothing stored yet) create one with T-24's `newCart(deviceId, 'dine_in',
   null)` and `await saveCart(cart)` at once, so a reload restores the check either way. The
   money format is `moneyFormatFor(menu.currency)`; the tax mode is `menu.taxMode` narrowed to
   `TaxMode`.
3. **Cart helpers and their types.** The page mutates the cart ONLY through
   `src/lib/pos/orders.ts` and calls `await saveCart(next); cart = next;` after every mutation
   (T-24's `saveCart(cart: Cart): Promise<void>` returns nothing). T-24 Do 2 declares the types:
   `CartLine` carries the wire contract's `SaleLine` names (`lineId`, `lineNo`, `menuItemId`,
   `itemName`, `quantity: number`, `unitPriceMinor: bigint`, `taxRateBp: number`, `discountMinor:
   0n`, `modifiers: CartModifier[]` with `priceDeltaMinor: bigint`) and `Cart` carries `orderId`,
   `deviceId`, `orderType: 'dine_in' | 'takeaway'`, `tableLabel: string | null`, `lines`,
   `openedAt`. **The cart's money fields are PLAIN `bigint`, exactly like `LocalMenu.items[].
   priceMinor` and `modifiers[].priceDeltaMinor` in `src/lib/pos/store.ts` — not the branded
   `Minor`.** The brand is applied ONCE at each boundary into `$lib/money`: T-24's `cartTotals`
   wraps every line in its `toTotalsLine` (`minor(l.unitPriceMinor)`, `minor(m.priceDeltaMinor)`,
   `minor(0n)`, `BigInt(l.quantity)`), `lineAmounts` below wraps the same way, and THIS PAGE wraps
   at the formatter — `formatAmount(minor(item.priceMinor), format)`,
   `formatAmount(minor(line.unitPriceMinor), format)`, `formatAmount(minor(m.priceDeltaMinor),
   format)` — because `formatAmount`, `formatMoney`, `add`, `sum` and `multiplyByInteger` all take
   `Minor` and `pnpm check` rejects a bare `bigint`. `minor()` is a brand, not arithmetic; a
   `Minor` is never widened back to `bigint`, and the page never calls `minor()` on anything but
   a value it is about to hand to `$lib/money`. The helpers, with T-24's signatures — open
   `orders.ts` and match them; a different signature means T-24 is not done, so stop and report
   it rather than adding a parallel helper:
   - T-24's `newCart(deviceId, orderType, tableLabel = null, now = new Date()): Cart`;
   - T-24's `addLine(cart, item: LocalMenu['items'][number], restaurantTaxRateBp: number | null,
     modifiers: LocalMenu['modifierGroups'][number]['modifiers'] = [], quantity = 1): Cart` —
     it takes the MENU item and the SNAPSHOT's rate (`menu.taxRateBp`), resolves the line's rate
     itself (`item.taxRateBp ?? restaurantTaxRateBp`, throwing when both are `null`), snapshots
     `unitPriceMinor: item.priceMinor` and each chosen modifier as `{ modifierId: m.id,
     modifierName: m.name, priceDeltaMinor: m.priceDeltaMinor }`, sets `lineId` (a secure UUID),
     `lineNo = cart.lines.length + 1`, `quantity`, `discountMinor: 0n`, and never merges two taps
     of the same item into one line (two taps = two lines; the `+`/`−` keys change a quantity);
   - T-24's `changeQuantity(cart, lineId, quantity: number): Cart` — an ABSOLUTE quantity, not a
     delta, validated as `addLine` validates it (a safe integer ≥ 1; `0` THROWS). The page's `+`
     key calls `changeQuantity(cart, line.lineId, line.quantity + 1)`; its `−` key calls
     `changeQuantity(cart, line.lineId, line.quantity - 1)` when `line.quantity > 1` and
     `removeLine(cart, line.lineId)` when it is `1` — the "one fewer than one removes the line"
     rule lives in the page, and `line.quantity ± 1` is integer arithmetic on a count, not money;
   - T-24's `removeLine(cart, lineId): Cart` — removes and renumbers `lineNo` 1..n;
   - T-24's `clearCart(deviceId): Promise<void>` — deletes the device's stored cart rows. The
     Clear key's `Yes, clear` therefore runs `await clearCart(deviceId); cart =
     newCart(deviceId, cart.orderType, cart.tableLabel); await saveCart(cart);` — a fresh
     `orderId`, an empty line list, the order type and table label kept;
   - T-24's `cartTotals(cart: Cart, taxMode: TaxMode): OrderTotals` — THE call to
     `computeOrderTotals({ taxMode, lines: cart.lines.map(toTotalsLine) }, ROUNDING_RULE)`, with
     `unitPriceMinor` and `taxRateBp` taken FROM THE LINE, never re-read from the menu
     (invariant 7);
   - **NEW in this task**, `export function setOrderType(cart: Cart, orderType: Cart['orderType'],
     tableLabel: string | null): Cart` — returns a new cart with the two fields replaced and
     everything else (lines, `orderId`, `openedAt`) untouched; `'takeaway'` forces `tableLabel`
     to `null`; a label longer than 32 characters or an empty/whitespace-only string throws the
     same way `newCart` does (trim first; store `null` for an empty trim);
   - **NEW in this task**, `export function lineAmounts(cart: Cart): Minor[]` — for each line,
     `multiplyByInteger(add(minor(line.unitPriceMinor), sum(line.modifiers.map((m) =>
     minor(m.priceDeltaMinor)))), BigInt(line.quantity))`: three `$lib/money` calls, integers in
     and out, NO rounding. It is spec 17's per-line `base` — `(unitPrice + Σdeltas) × quantity`,
     an exact whole number of minor units — and with every discount `0n` it is the line's own
     amount in BOTH tax modes (in exclusive mode the tax sits in the totals block; in inclusive
     mode the price already contains it). **Accepted duplication, on purpose:** T-10's
     `computeOrderTotals` computes this same `base` internally (03-money.md Do steps 3–4) but its
     `OrderTotals.lines[]` records are `{ undiscountedNet, net, tax, gross }` — all `Exact` — and
     the overview's contract fixes that shape, so no integer base comes back out of it. Rather
     than widen a contract every other task already builds against, the till recomputes the one
     integer it needs with the same three `$lib/money` calls T-10 uses; both are integer-exact
     (`add`/`sum`/`multiplyByInteger` cannot round), so the two computations cannot disagree,
     and the MANDATORY test below pins `lineAmounts` to the figures `cartTotals` produces from the
     same cart.
   The page reads `totals` and `amounts` from ONE `$derived.by(() => ({ totals: cartTotals(cart,
   taxMode), amounts: lineAmounts(cart) }))`. `crypto.randomUUID` needs a secure context; T-24's
   helpers throw `This device cannot record a sale securely. Open the till over https.` when it
   is absent — catch that on the first `addLine`/`newCart`, render `✕ {message}` and disable the
   grid, as the PIN page does for its op key.
4. **LEFT column** — `<section aria-label="Order entry" class="flex-1 min-w-0 flex flex-col
   gap-4">`:
   - **Block 1 · Order type**: an `<h3 id="ordertype-label">Order type</h3>` and a `<div
     role="group" aria-labelledby="ordertype-label">` of three `<button type="button"
     aria-pressed={…}>` segments — `Sit now`, `Waiting for a table`, `Takeaway` — each
     `min-h-touch-min border border-control-line rounded-control text-pos`, the pressed one
     `bg-accent text-accent-ink`, the others `bg-raise text-ink`. Mapping: Sit now →
     `orderType 'dine_in'` and a revealed `<label>Table<input type="text" maxlength="32"
     …></label>` (optional; `border border-control-line rounded-control min-h-touch bg-raise
     text-ink px-3`; its trimmed value or `null` is the `tableLabel`); Waiting for a table →
     `'dine_in'` with `tableLabel null` (the field is hidden and its value dropped); Takeaway →
     `'takeaway'`, `tableLabel null`. Each change goes through `setOrderType` and `saveCart`.
     There is no fourth segment: home delivery is on CLAUDE.md's "Do NOT build" list (assumption 1
     in `00-overview.md`), and a disabled fourth key would still be a promise.
   - **Block 2 · Menu**: a `<nav aria-label="Menu categories">` of tabs — `<div role="tablist">`
     with one `<button role="tab" aria-selected={…} id="tab-{id}" aria-controls="grid-{id}">` per
     `CategoryTab` from `itemsByCategory(menu)`, `min-h-touch-min border border-control-line
     rounded-control px-4`, the selected tab `bg-accent text-accent-ink`, the others `bg-raise
     text-ink`; the first tab selected on load; then ONE `<div role="tabpanel" id="grid-{id}"
     aria-labelledby="tab-{id}" class="grid grid-cols-2 gap-2 sm:grid-cols-3">` for the selected
     tab's items, generated from the snapshot and nothing else. Each item is a `<button
     type="button" class="min-h-touch-lg border border-control-line rounded-control flex flex-col
     items-start justify-center px-3 py-2 text-left">` showing the category name (`text-caption`),
     the item name (`text-pos font-semibold`) and `formatAmount(minor(item.priceMinor), format)`
     (`item.priceMinor` is a plain `bigint` in `LocalMenu`; `minor()` brands it for the
     formatter — Do 3) in `font-mono tabular-nums`; available items `bg-raise text-ink`;
     `isAvailable === false` →
     `disabled`, `bg-disabled-bg text-disabled-ink`, and the word `Unavailable` under the name.
     Optional wayfinding: a coloured left band from the six `bg-cat-*` tokens by tab index — the
     category NAME is always written on the key, the band is never the only carrier. A caption
     under the tabs reads `snapshot v{menu.version} · {menu.items.length} items` in `text-ink-2`.
   - **Tapping an item**: no modifier groups (`item.modifierGroupIds.length === 0`) → `next =
     addLine(cart, item, menu.taxRateBp)` (T-24 resolves and snapshots the rate from `item` and
     the snapshot's rate with the same rule as `resolveTaxRate`, and snapshots `unitPriceMinor`
     from `item.priceMinor`; the page passes the menu item, not a hand-built line), then
     `saveCart`. With groups → the **inline modifier panel** REPLACES the tabpanel
     (the tabs stay; the check on the right never moves): a heading `{item.name} — options`,
     then for each group from `modifierGroupsFor(item, menu)` a labelled `<fieldset>` with
     `<legend>{group.name} · choose {min}–{max}</legend>` (`choose exactly 1` when `min === max ===
     1`, `optional, up to N` when `min === 0`) and one `<button type="button" aria-pressed>` per
     modifier (`min-h-touch-lg border border-control-line rounded-control`, showing the name and
     `formatAmount(minor(m.priceDeltaMinor), format)`; a negative delta renders with the formatter's `−`
     and `text-danger`, a zero delta shows `0.00`, a positive one `+` is NOT prepended — the
     formatter owns the sign). Selection rules: `maxSelect === 1` → pressing a modifier deselects
     the other (radio behaviour); `maxSelect > 1` → toggles, and once `maxSelect` are selected the
     unselected keys go `bg-disabled-bg text-disabled-ink` with the caption `Choose up to
     {maxSelect}`. The `Add` closer (`min-h-touch-lg bg-accent text-accent-ink`) is enabled only
     when every group has between `minSelect` and `maxSelect` selections; otherwise disabled with
     the reason `Choose at least {minSelect} in {group.name}` for the first unmet group; `Cancel`
     (`min-h-touch-lg bg-raise text-ink`) returns to the grid. `Add` calls `addLine(cart, item,
     menu.taxRateBp, chosen)` where `chosen` is the array of the chosen modifier records from the
     groups (`LocalMenu['modifierGroups'][number]['modifiers']` elements; T-24 maps each to `{
     modifierId, modifierName, priceDeltaMinor }`), then `saveCart`, then returns to the grid. A
     thrown `modifierGroupsFor` (a dangling group id) or a thrown `addLine` (no tax rate anywhere,
     T-24's `No tax rate is configured` error) renders `✕ {message}` inline above the grid and
     adds nothing; the cashier reports it, the owner fixes the menu.
5. **RIGHT column — the permanent guest check**: `<section aria-labelledby="check-h" class="w-full
   md:w-96 md:shrink-0 bg-raise border border-line rounded-card flex flex-col">` — a sibling of
   the left column, OUTSIDE every `{#if}` that depends on the menu load state or the modifier
   panel, so it never unmounts (the mockup's rule: the cashier never navigates away to see what
   has been rung in). Contents, top to bottom:
   - header: `<h2 id="check-h">` = `Sit now · Table {label}` / `Sit now` / `Waiting for a table`
     / `Takeaway`, and the mark `<span class="bg-st-new-bg text-st-new rounded-control px-2">○
     OPEN</span>` (an order that exists only on this device is OPEN; `◐ BILLED` and `● PAID` are
     T-34's);
   - the lines, a `<table>` with `sr-only` column headers and, in the amount column's header, the
     currency code once (`USD`), so `formatAmount` (no code) is right for every cell; for each
     line (`{#each cart.lines as line (line.lineId)}`): the mark `<span class="bg-st-new-bg
     text-st-new">◇ NEW</span>`; the quantity `{line.quantity}×` in `font-mono`; the name in
     `text-ink`; each modifier on its own indented row `+ {modifierName}` with
     `formatAmount(minor(m.priceDeltaMinor), format)` (`text-danger` when `m.priceDeltaMinor <
     0n`); the snapshot line `@ {formatAmount(minor(line.unitPriceMinor), format)} · tax
     {formatTaxRate(line.taxRateBp)}` in `text-caption text-ink-2` — the price and rate STORED
     ON THE LINE, never the menu's current ones; the line amount `formatAmount(amounts[i],
     format)` (already `Minor`, from `lineAmounts`) in `font-mono tabular-nums text-right`; then
     three keys on a row under the line, each `min-h-touch-min min-w-touch-min border
     border-control-line rounded-control bg-raise text-ink`: `−` (`sr-only` "One fewer"), `+`
     (`sr-only` "One more"), and `✕ Remove`. `+` calls `changeQuantity(cart, line.lineId,
     line.quantity + 1)`; `−` calls `changeQuantity(cart, line.lineId, line.quantity - 1)` when
     `line.quantity > 1` and `removeLine(cart, line.lineId)` when it is `1` (Do 3); `✕ Remove`
     calls `removeLine` at once — deleting a `NEW` line needs no reason, no approval and no
     confirmation (spec 14, invariant 9; assumption 12: cart edits are not audited);
   - the totals `<dl>`, `font-mono tabular-nums text-right`: `Subtotal` =
     `formatMoney(totals.subtotal, format)` and `Tax` = `formatMoney(totals.tax, format)` in
     `text-ink-2`; `Discount` = `formatMoney(totals.discount, format)` rendered ONLY when
     `totals.discount !== 0n` — it is always `0n` in this plan, so the row never shows, and the
     branch exists so the approvals plan does not have to touch this file; `Total` =
     `formatMoney(totals.total, format)` in `text-total text-ink`; a caption `tax {mode} at the
     rate stored on each line` in `text-caption text-ink-2` (`text-ink-3` would be legal here on
     `bg-raise`, but `text-ink-2` keeps one rule for the whole page). `totals` and `amounts`
     come from the ONE `$derived.by` of Do 3 (`cartTotals(cart, taxMode)` and
     `lineAmounts(cart)`); with an empty cart every figure is `0.00 USD`;
   - the closer `Pay`: `min-h-touch-xl w-full border border-control-line rounded-control
     text-pos font-semibold`, enabled → `bg-accent text-accent-ink` showing `Pay` and
     `formatMoney(totals.total, format)`; `cart.lines.length === 0` → `disabled`, `bg-disabled-bg
     text-disabled-ink`, and the words `Add an item first` on the key. On press:
     `goto(resolve('/pos/pay'))` — the cart is already saved, T-34 reads it back. There is NO
     `Send to kitchen` closer on this screen (assumption 11 in `00-overview.md`: printing is a
     later plan and the only closer is Pay);
   - a `Clear` key (`min-h-touch-min bg-raise text-ink border border-control-line`), enabled
     only when the cart has lines, with an INLINE two-step confirm — pressing it swaps the key for
     the sentence `Clear all {n} lines?` and two keys `Yes, clear` (runs the `clearCart(deviceId)`
     → `newCart` → `saveCart` sequence of Do 3) and `Keep` — never a modal: modals are for reason
     codes, owner approval and errors only.
6. **Layout**: `<main class="flex flex-col gap-4 px-4 py-4 md:flex-row md:items-start">` with the
   left `<section>` then the check; the check's line list gets `overflow-y-auto` and the page
   never scrolls sideways (`overflow-x-hidden` on `<main>`); `<svelte:head><title>Order ·
   matcami</title></svelte:head>`. Body text is `text-pos`; headings `text-title` /
   `text-section`; every key has `border border-control-line`; no `bg-[…]`, no literal px.
7. Persist on every change: after each mutation `await saveCart(next); cart = next;` (T-24's
   `saveCart` resolves `void`), so a reload — or the idle return and a fresh sign-in — restores
   the check. One active cart at a time (assumption 9): there is no hold, park or resume.

**Tests:**
- `src/lib/pos/menu-view.test.ts` (unit project, `node` environment, no IndexedDB needed):
  - `resolveTaxRate`: item `500`, snapshot `825` → `500`; item `null`, snapshot `825` → `825`;
    item `0`, snapshot `825` → `0` (zero is a rate, not "unset"); item `null`, snapshot `null`
    → throws `/tax rate/` naming the item;
  - `itemsByCategory`: categories `[{c2, sortOrder 1}, {c1, sortOrder 0}]` with items in `c1`
    at sortOrders `2, 0` → tabs `[c1, c2]`, `c1`'s items in the order `0, 2`, `c2` present with
    `items: []`; an item with `categoryId 'ghost'` → a final tab `{ id: 'other', name: 'Other' }`
    holding it, and NO such tab when every item has a category;
  - `modifierGroupsFor`: `modifierGroupIds ['g2', 'g1']` → `[g2, g1]` in that order; `['g9']`
    → throws `/g9/`;
  - `formatTaxRate`: `825 → '8.25%'`, `0 → '0.00%'`, `10000 → '100.00%'`, `5 → '0.05%'`,
    `1050 → '10.50%'`; `8.25` and `-1` throw;
  - MANDATORY (spec 29 — money arithmetic and rounding), a source tripwire in the idiom of
    `menu-snapshot.test.ts` ("holds no number conversion of money"): read
    `src/routes/(pos)/pos/session/+page.svelte`, `src/routes/(pos)/pos/order/+page.svelte` and
    `src/lib/pos/menu-view.ts` with `readFileSync` and assert none contains `parseFloat`,
    `.toFixed(`, `Number(`, `roundToMinor(`, `taxOnAmount(` or `taxOnLine(` — the four screens
    display what `src/lib/money` computed and never round; the positive control is that
    `src/lib/money/index.ts` DOES contain `roundToMinor(`, so the pattern cannot pass by a typo.
    T-34 adds its page to this list.
- `src/lib/pos/orders.test.ts` — EXTEND (created by T-24), a new `describe('T-33 cart helpers')`
  block using T-24's fixtures (fake-indexeddb, `deleteDatabase()` in `beforeEach`, the fixed
  `now`, menu items as `LocalMenu['items'][number]` literals):
  - MANDATORY (spec 29 — money arithmetic and rounding; tax in BOTH modes): the Done-when cart,
    built through the helpers — `newCart('device-A', 'dine_in', null, now)`, then `addLine` with
    `Tea` (`priceMinor 850n`, `taxRateBp null`) and restaurant rate `825`, then `addLine` with
    `Coffee` (`priceMinor 1000n`, `taxRateBp null`) and one modifier `Oat` (`priceDeltaMinor
    50n`) → `lineAmounts(cart)` is `[850n, 1050n]` and both lines carry `taxRateBp 825`;
    `cartTotals(cart, 'exclusive')` is `subtotal 1900n, discount 0n, tax 157n, total 2057n`
    (1,900 × 8.25% = 156.75 → 157, rounded once); `cartTotals(cart, 'inclusive')` is `subtotal
    1755n, discount 0n, tax 145n, total 1900n` (tax = 1,900 × 825 / 10,825 = 144.80… → 145; net
    = 1,755); and in both modes `sum(lineAmounts(cart))` equals `totals.subtotal` in exclusive
    mode and `totals.total` in inclusive mode — the pin that keeps `lineAmounts` and T-10's
    internal `base` from ever disagreeing (Do 3's accepted duplication).
  - Two `addLine` calls with the same `Tea` → two lines, `lineNo` `[1, 2]`, never one line at
    quantity 2; `changeQuantity(cart, teaLineId, 3)` → that line's `quantity 3` and
    `lineAmounts` `[2550n, 1050n]`; `changeQuantity(cart, teaLineId, 0)` THROWS (T-24's
    validation — the page calls `removeLine` instead); `removeLine` of line 1 of three →
    `lineNo` `[1, 2]`.
  - `setOrderType(cart, 'dine_in', ' 12 ')` → `orderType 'dine_in'`, `tableLabel '12'`, lines
    untouched (same `lineId`s, same `orderId`); `setOrderType(cart, 'dine_in', '')` →
    `tableLabel null`; `setOrderType(cart, 'takeaway', '12')` → `tableLabel null`;
    `setOrderType(cart, 'dine_in', 'x'.repeat(33))` throws.
- The tie cases, the property test and the rate sweep are T-10's (`order-totals.test.ts`) and
  are not repeated here; `cartTotals` is a mapping onto that function and the block above proves
  the mapping (modifier deltas included, quantity as a `bigint`) on the Done-when figures.

**Done when:** `pnpm test:unit src/lib/pos/menu-view.test.ts` and `pnpm test:unit
src/lib/pos/orders.test.ts` pass; `pnpm build`, `pnpm check`
and `pnpm lint` pass; manually, with a menu holding a `Tea` at `850` (rate inherited, restaurant
`825`) and a `Coffee` at `1000` with a `Milk` group (`min 0, max 1`, `Oat +50`): on a restaurant
set to exclusive, adding one Tea and one Coffee with Oat shows `Subtotal 19.00 USD · Tax 1.57 USD ·
Total 20.57 USD` (1,900 × 8.25% = 156.75 → 157, rounded once); switching the restaurant to
inclusive and re-syncing the menu shows `Subtotal 17.55 USD · Tax 1.45 USD · Total 19.00 USD`
(tax = 1,900 × 825 / 10,825 = 144.80… → 145; net = 1,755); `✕ Remove` on the Coffee line drops
it with no prompt; a reload restores the remaining line; `Pay` is disabled with `Add an item
first` on an empty check and lands on `/pos/pay` otherwise. T-38's e2e covers the same flow.

**Watch out:** No `bg-[#…]`, no literal sizes, no `grid-cols-[…]`. The check is permanent: it must
not sit inside the `{#if menu}` block or inside the modifier panel's branch — put the load-state
messages in the LEFT column only. A modal is never used for ordering; the modifier panel and the
Clear confirm are inline. `unitPriceMinor` and `taxRateBp` are read FROM THE CART LINE when
totalling — re-reading the menu at render time would let a menu edit move a rung-in line, the
defect invariant 7 exists to prevent. `BigInt(line.quantity)` is the one conversion `cartTotals`
and `lineAmounts` make: `bigint * number` throws at runtime, and `computeOrderTotals` wants a
`bigint` quantity. The cart's money fields are plain `bigint` (T-24) and `$lib/money` takes
`Minor`: brand with `minor()` at the call into the money module or the formatter, never store a
`Minor` in the cart and never cast a `Minor` back — `pnpm check` is the tripwire for both.

---

### T-34 — `/pos/pay`: the tender step

**Needs:** T-33
**Files:**
- `src/routes/(pos)/pos/pay/+page.svelte` — NEW
- `src/lib/pos/menu-view.test.ts` — EXTEND (created by T-33; add this page's path to the source
  tripwire's file list. Do not rewrite the file)
**Spec:** 13 (the payment transaction: "Record Payment(s) — cash / card / mobile"; "For an
offline cash sale, the POS prints the receipt immediately and the same transaction runs on the
server when the sale syncs"), 6 ("Once a cash sale is completed offline … the sale has happened";
"Online card/mobile payments should not automatically be treated as successful offline unless the
payment provider/terminal explicitly supports offline authorization"; invoice numbers "from its
own local sequence, whether online or offline"), 7 ("optionally after each payment" — the return
to employee select is NOT taken, assumption 10), 17 (money in integer minor units), 33 (decision 4:
which of card/mobile is accepted is the owner's setting — assumption 3)
**Invariants:** 1 (integer minor units; change comes from `changeDue`, never a subtraction in the
page), 5 (a completed CASH sale is a recorded fact with its device invoice number, online or
offline; card and mobile NEVER complete offline — fail closed, with the reason shown BEFORE the
tap; a retry is a no-op because the op carries one `clientOpId`), 7 (the totals shown are the
cart's stored numbers through `computeOrderTotals`), 9 (no refund, no void, no discount here),
11 (the sale belongs to the open session's business date — `completeSale` stamps the session id)

**Do:**
1. Imports: `getContext`, `onMount` from `svelte`; `goto`, `resolve`; `formatMoney`,
   `moneyFormatFor` from `$lib/money/format`; `minor`, type `Minor` from `$lib/money`;
   `changeDue`, `quickTenders` from `$lib/money/change` (T-11); `TAX_MODES` from
   `$lib/money/tax`; `signedIn`, `RESTORED_CONTEXT` from `$lib/pos/employee.svelte`; `readCart`,
   `cartTotals`, `completeSale`, `abandonSale` from `$lib/pos/orders` (T-24/T-33); `readLocalSession`
   from `$lib/pos/session`; `flush`, `onFlushEvent` from `$lib/pos/queue` (T-25 Do 13; the
   overview's `onFlushResult` is the same export); `readBoundDeviceId`,
   `readCachedSetting`, `readMenu` from `$lib/pos/store`.
2. **Guards** (`onMount`, after `await getContext<Promise<void>>(RESTORED_CONTEXT)`): no employee
   → `/pos`; no bound device → `/pos`; no local session → `/pos/session`; `menu` null or without
   a currency and a valid tax mode → `/pos/order` (which explains why); `cart = await
   readCart(deviceId)` (T-24 declares `readCart(deviceId: string): Promise<Cart | null>`) —
   `null` or `cart.lines.length === 0` → `/pos/order`. Read `acceptsCard = (await
   readCachedSetting('acceptsCard')) === true` and `acceptsMobile` likewise — ONLY the boolean
   `true` enables a tender; `undefined`, `null` or a string means "not accepted" (a till that
   never cached the setting cannot claim the owner accepts card). Read `deviceCode` the same way
   (T-30 cached it) for the invoice number `completeSale` builds. Track `online` exactly as T-32
   does (`navigator.onLine` plus the two listeners).
3. **Header**: `<h1>Amount due</h1>` and `formatMoney(totals.total, format)` in `text-total
   font-mono tabular-nums text-right text-ink`, where `{ totals } = cartTotals(cart, taxMode)` —
   the same numbers the check showed; under it the compact line list (name, `×qty`,
   `formatAmount` of each line amount) and the three rows Subtotal / Tax / Total in `text-ink-2`,
   Discount only when non-zero. The order's mark here is `◐ BILLED` (`bg-st-billed-bg
   text-st-billed`): the bill is being settled.
4. **Tender keys** — a `<div role="group" aria-label="Tender">` of three `<button type="button"
   aria-pressed>` keys, `min-h-touch-lg border border-control-line rounded-control`, the pressed
   one `bg-accent text-accent-ink`, enabled others `bg-raise text-ink`:
   - `Cash` — always enabled;
   - `Card` — enabled only when `acceptsCard && online`; otherwise `disabled`, `bg-disabled-bg
     text-disabled-ink`, with the reason written ON the key under its name: `Not accepted in
     settings` when `!acceptsCard`, else `◆ Cash only while offline` when `!online`. Each disabled
     key carries `aria-describedby` pointing at a `<p id="why-{tender}">` that repeats the reason;
   - `Mobile money` — the same two reasons over `acceptsMobile`.
   When `online` flips while a card/mobile tender is selected, the selection falls back to Cash
   and the reason appears — the tender must never fail AFTER the tap for a reason the screen could
   have shown before it (`docs/design-system.md` §7; assumption 4: card and mobile are recorded
   external-terminal tenders with no provider integration and no offline authorization).
5. **Cash tender panel** (shown when Cash is selected):
   - `Quick cash`: one key per `Minor` in `quickTenders(totals.total, format.exponent)` —
     `min-h-touch-lg border border-control-line rounded-control bg-raise text-ink font-mono`,
     the first labelled `Exact` — pressing one sets `tendered = value`. For a total of `2750n`
     at exponent 2 the keys are `[2750n, 2800n, 3000n]` (exact, the next whole unit, the next
     multiple of 5; `3000` is also the next multiple of 10 and T-11 de-duplicates it — the list
     is whatever T-11 returns, never a literal in the page);
   - the keypad from T-32 (same classes, same `digits`/`BigInt` rule, 12 digits max) under the
     readout `Amount tendered: {formatMoney(tendered ?? minor(0n), format)}`; typing sets
     `tendered = minor(BigInt(digits))` and clears the quick-key selection;
   - `Change due`: `let change = $derived(tendered !== null && tendered >= totals.total ?
     changeDue(tendered, totals.total) : null)` — `>=` between two bigints is a comparison that
     gates the call, not arithmetic; the markup renders `formatMoney(change, format)` in
     `text-total font-mono tabular-nums` when `change !== null`, else the words `Tendered is less
     than the amount due` in `text-ink-2`. `changeDue` throws when `tendered < total`; the guard
     above is what keeps it from being called then.
6. **The `Pay` closer**: `min-h-touch-xl w-full border border-control-line rounded-control
   text-pos font-semibold`, label `Pay · {Cash|Card|Mobile money}` with
   `formatMoney(totals.total, format)`; disabled (`bg-disabled-bg text-disabled-ink`, reason on
   the key) when no tender is selected (`Choose a tender`), when Cash is selected and `change ===
   null` (`Enter the amount tendered`), or while a completion is in flight. On press, build ONE
   payment in T-24's `CompleteSaleArgs['payment']` shape — `payment = { method, tenderedMinor:
   method === 'cash' ? tendered : null }` (a plain `bigint` or `null`; there is NO `amountMinor`
   and NO `changeMinor` argument: `completeSale` takes the amount from its own `cartTotals` and
   computes the change with `changeDue` itself) — and call
   `const result = await completeSale({ cart, deviceId, deviceCode, posSessionId:
   session.posSessionId, employeeId: signedIn.current.id, taxMode, currencyCode: menu.currency,
   menuVersion: menu.version, payment, now: new Date() })` (T-24's `CompleteSaleArgs` — `now:
   Date`, never `occurredAt`; open `orders.ts` and match it). The result is T-24's
   `CompleteSaleResult = { orderId, invoiceNumber, changeMinor, clientOpId }`, resolved after the
   completed order, the queue entry and the next invoice number were written in ONE IndexedDB
   transaction. The completed row overwrites the cart row under `cart.orderId` (same `id`, state
   `'completed'`), so `readCart(deviceId)` now returns `null` and T-33 creates a fresh cart on
   the next visit — nothing here writes a cart. Recompute nothing before the call: `completeSale`
   runs `computeOrderTotals` itself and the page's `totals` were the same function over the same
   lines.
7. **CASH outcome**: the moment `completeSale` resolves the sale is a recorded fact (online or
   not — being online only makes the flush immediate). Render the success panel: `● Paid` in
   `bg-st-paid-bg text-st-paid`; `Invoice {result.invoiceNumber}` in `font-mono` (`POS1-000042`
   — the DEVICE's number from its gap-free sequence, T-23; the server never renumbers); rows
   `Total`, `Tendered`, `Change` through `formatMoney` — the Change row renders
   `formatMoney(minor(result.changeMinor), format)`, T-24's figure, not the page's `change`
   derivation; and the closer `New sale`
   (`min-h-touch-xl bg-accent text-accent-ink`) → `goto(resolve('/pos/order'))`, which finds no
   cart (`readCart` is `null` after the completion) and creates a fresh empty one (T-33 Do 2).
   Then `void flush().catch(() => {})`. Nothing waits for the server, and there
   is no return to employee select (assumption 10 — spec 7's "optionally after each payment" is
   not taken: the same cashier keeps selling).
8. **CARD / MOBILE outcome**: after `completeSale` resolves, SUBSCRIBE FIRST — `const stop =
   onFlushEvent((event) => …)` (T-25's `onFlushEvent`; `onFlushResult` is the same function
   under the overview's name) filtered on `event.clientOpId === result.clientOpId` — then
   `void flush().catch(() => {})`, and render the pending panel: `◐ Waiting for the server to
   confirm…` in `bg-st-billed-bg text-st-billed`, the invoice number, and two keys: `Cancel`
   (`min-h-touch-lg bg-raise text-ink`) and `New sale` (`min-h-touch-xl bg-accent
   text-accent-ink`, ENABLED — a pending card op never blocks the next cash sale; the op stays
   queued with its number and replays in order, `00-overview.md`, "blocking the till on a pending
   card op"). Outcomes, mapped from the event:
   - `done` with `status` `accepted` | `recorded_flagged` (and `replayed`) → the success panel of
     step 7 with `Tendered` and `Change` rows omitted;
   - `done` with `status` `unrecorded` (the server stored the payload for owner review) →
     the `◆ Recorded for the owner's review` panel — no `● Paid` mark, the words `not confirmed
     as paid`, and `Back to order`. Only a CASH sale can reach this status (a card/mobile hard
     failure is `422`, below); the branch exists because the subscription is shared and the
     mapping must be total;
   - `rejected` — http `403` (`{ error: 'not_permitted' }`) or `422` (`{ error: 'rejected',
     flag }`), the event carrying `error` and `flag` — → `✕ Not recorded: {reason}` in
     `bg-danger-bg text-danger`, where `reason` is `this employee may not take payments` for 403
     and the `flag` string (`price_tamper`, `unknown_item`, …) for 422; the flush has ALREADY
     abandoned the sale (T-25 writes the `sale.abandoned` op carrying the burned invoice number so
     the server can explain the gap); the page shows `The card terminal's charge, if any, must be
     voided on the terminal` and a `Back to order` key → `/pos/order`;
   - `stopped` with `reason 'network'` (a network error or a `5xx`) → stay pending: the op is
     queued and T-25 retries; the panel says `◆ Waiting for a connection` under the pending line.
   The cash panel of step 7 also subscribes with the same mapping, so a cash sale that the server
   answers `unrecorded` while the cashier is still on the page swaps `● Paid` for the
   `◆ Recorded for the owner's review` panel — the fact is stored either way (invariant 5).
   `Cancel` while pending calls `await abandonSale(result.orderId, 'cancelled')` (T-24: it
   removes the queued `sale.complete` op if it has not been sent and enqueues `sale.abandoned`
   with the same invoice number and reason `cancelled`) and then `goto(resolve('/pos/order'))`;
   whether the abandoned lines come back as the active cart is `abandonSale`'s documented
   behaviour — read its comment and add nothing here. Unsubscribe in the page's cleanup.
9. `<svelte:head><title>Pay · matcami</title></svelte:head>`; two columns like the mockup
   (`md:flex-row`: amount due and tenders left, quick cash, keypad, change and the closer right),
   stacked below `md`; `overflow-x-hidden` on `<main>`; every key `border border-control-line`;
   `text-ink-2` for captions on `bg-bg`; no arbitrary value anywhere.
10. Add `src/routes/(pos)/pos/pay/+page.svelte` to the file list of T-33's source tripwire in
    `src/lib/pos/menu-view.test.ts`.

**Tests:**
- MANDATORY (spec 29 — money arithmetic and rounding): the extended tripwire in
  `src/lib/pos/menu-view.test.ts` now reads this page too and fails on `parseFloat`,
  `.toFixed(`, `Number(`, `roundToMinor(`, `taxOnAmount(` or `taxOnLine(`; expected: green.
- MANDATORY (spec 29 — offline sync: retries never create duplicates) is exercised end to end by
  T-38's e2e (an offline cash sale from this page syncs exactly once after reconnect: one
  `orders` row, one `invoices` row, one journal entry set for the `clientOpId`), and at unit level
  by T-25's queue tests; nothing is repeated here.
- The change and quick-tender values are T-11's tests (`change.test.ts`: `changeDue(3000n,
  2750n) = 250n`, `changeDue(3000n, 2057n) = 943n`, and the `quickTenders` lists exactly as T-11
  specifies them); this page renders them and asserts nothing about them.

**Done when:** `pnpm test:unit src/lib/pos/menu-view.test.ts`, `pnpm build`, `pnpm check` and
`pnpm lint` pass; manually: with the network off, a cart totalling `20.57 USD` paid with the
`30.00 USD` quick key shows `Change due 9.43 USD`, and `Pay · Cash` shows `● Paid` with
`Invoice POS1-000001` INSTANTLY, the status bar counting one more unsynced; reconnecting drains it
to `0 unsynced` and `psql "$TEST_DATABASE_URL" -c "select kind, status, invoice_seq,
invoice_number from pos_sync_ops order by received_at"` (or the dev database's owner URL) shows
ONE row `sale.complete · accepted · 1 · POS1-000001` for that sale, and `select count(*) from
invoices where invoice_number = 'POS1-000001'` is `1` after a second reconnect cycle too; with
the network on and `acceptsCard` true, `Pay · Card` shows `◐ Waiting for the server to confirm…`
and then `● Paid` within the flush; with the network off the `Card` key is disabled and reads
`◆ Cash only while offline`; with `acceptsCard` false it reads `Not accepted in settings`;
`Cancel` on a pending card sale returns to `/pos/order` and, once the queue drains, the same
`psql` query shows a `sale.abandoned` row whose `invoice_seq` and `invoice_number` are the
burned number and NO `sale.complete` row for that order. (That the sale appears on `/reports`
and the abandoned number on `/reports/flagged` is observed in T-38's Done-when, after T-36 and
T-37 exist — neither page does when this task completes.)

**Watch out:** Card and mobile must never fail AFTER the tap for a reason the screen could have
shown before it (the design-system rule): the two disabled reasons are computed from state the
page already holds, and an `online` flip deselects the tender instead of letting `Pay` proceed.
The invoice number shown is the DEVICE's, taken by `completeSale` inside its IndexedDB
transaction — never a number the page invents, never the server's. Subscribe to `onFlushResult`
BEFORE calling `flush()`. `tendered >= totals.total` is the only comparison on money in the file
and it exists to gate `changeDue`, which throws below the total; do not replace it with a
subtraction. Leaving the page while a card op is pending loses only the on-screen confirmation,
never the outcome: the flush records or abandons the op regardless. `completeSale` overwrites
the cart row with the completed order (same `id`), so no cart is left to clear; a page that calls
`saveCart` with an empty cart afterwards resurrects a cart row beside the completed one and is
the double write that could confuse `readCart` — write nothing after `completeSale`.
