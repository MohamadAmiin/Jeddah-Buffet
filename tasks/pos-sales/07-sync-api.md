# Phase 4 — API (T-27, T-28, T-29)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 2 and Phase 3.

A route in this phase does five things, in this order, and nothing else. It resolves the registered
device with `await requireDevice(event)` FIRST, before a byte of the body is read, so a missing,
unknown or revoked device cookie answers 403 whatever else is wrong with the request. It validates
the input — the content type, then the JSON envelope through zod. It checks the permission: on the
till the caller's credential is the device (spec 7), there is no dashboard session, and the employee
named inside a device-sourced operation is checked by the module, keyed on the tender class (the
overview's R9 — a failed check on a cash sale or a session open is a soft flag; on a card/mobile
sale or a session close it is 403). It calls ONE module function. It returns JSON with
`cache-control: no-store`. A route never reads `event.locals.restaurantId` (null outside the
dashboard by design — the tenant is the device row's), never runs a query that decides anything,
never does money arithmetic, and never prints. Every `/api/pos` route added here gets its row in the
behavioural permission walk (`src/routes/api/pos/permissions.integration.test.ts`) AND its id in the
static walk's exact list (`src/routes/route-guards.test.ts`) in the same commit, or the mandatory
spec 29 test fails, deliberately. T-29 sits in this phase because the accepted-tender settings are
the dashboard API surface (a form action) that T-28's response and the till's tender keys read from,
and because a tax-setting change must bump the menu version the till polls — the only signal the
till ever receives that its cached tax mode, rate or currency is stale.

### T-27 — `POST /api/pos/sync` with its permission rows

**Needs:** T-21 (`handleOp` in `src/lib/server/orders/sync.ts`; through it T-03's
`src/lib/sync-ops/`, T-19's `recordSale` and T-20's session module)
**Files:**
- `src/routes/api/pos/sync/+server.ts` — NEW
- `src/routes/api/pos/sync/sync.integration.test.ts` — NEW
- `src/routes/api/pos/permissions.integration.test.ts` — EDIT (the imports; `seed()` and the
  `Seed` type; the `DEVICE_GUARDED` table; two new `it`s inside the third `describe`,
  `'MANDATORY (spec 29): insufficient role with a valid session'`)
- `src/routes/route-guards.test.ts` — EDIT (inside `describe('every /api route is guarded')`, the
  `it('finds exactly the /api routes the plan has shipped')` list. Not in the overview's file list,
  but its exact-list assertion fails the moment the route file exists, so the edit belongs to this
  commit)

**Spec:** 6 ("Once a cash sale is completed offline … the server records the sale; it does not
treat it as a request it can reject"; "Idempotency keys … the server ignores duplicates when a
sync is retried"; "If a synced sale fails validation, it is stored and flagged for owner review,
never discarded"; "Closing a session requires a connection, because reconciliation runs on the
server"), 8 ("the server returns 403 Forbidden. So hiding buttons in the frontend is not
considered security"), 10 (session close "Requires a connection and an empty sync queue"), 13
("For an offline cash sale, the POS prints the receipt
immediately and the same transaction runs on the server when the sale syncs"), 29 ("Offline sync:
retries never create duplicates"; "Permission checks on every POS API")
**Invariants:** 4 (one all-or-nothing transaction at payment — the route hands the whole op to one
module call and never splits it), 5 (a completed offline cash sale is a recorded fact; every op
carries a device idempotency key; a retry is a no-op), 8 (permissions enforced server-side on every
POS API route, answering 403), 10 (audit rows in the same transaction as the action — written by
the module, never by the route), 12 (POS access = registered device: `requireDevice` is the first
statement)

**Do:**
1. Create `src/routes/api/pos/sync/+server.ts`. Imports: `json` and `type RequestHandler` from
   `@sveltejs/kit`; `z` from `zod` (`package.json` pins `zod` 4.6.4 exactly; `z.uuid()` is the v4
   spelling `src/routes/(dashboard)/employees/[id]/+page.server.ts` already uses, and
   `z.iso.datetime({ offset: true })` is zod 4's API for an ISO-8601 instant — nothing in `src/`
   uses `z.iso.` yet, so do not look for a precedent, and do not fall back to the zod 3
   `z.string().datetime()` spelling); `db` from
   `$lib/server/db/client`; `requireDevice` from `$lib/server/auth/pos-context`; `requestContext`
   from `$lib/server/audit`; `handleOp` from `$lib/server/orders/sync`; `OP_KINDS` and the types
   `OpEnvelope`, `OpKind` from `$lib/sync-ops`. Export ONLY `POST`; SvelteKit answers 405 to every
   other method on its own.
2. First statement of the handler: `const device = await requireDevice(event);` — AWAIT it.
   `requireDevice` is async; a forgotten `await` yields a pending promise, which is truthy, and the
   route would carry on as if the device were valid. It throws `error(403)` for no cookie, an
   unknown token and a REVOKED device alike, before the body is read. This IS the route's own
   permission check in invariant 8's sense: on the till the credential is the registered device,
   `event.locals.user` is null here, and the employee named in the op is checked by `handleOp`
   against the op's tender class — `pos.sell` + `pos.payment` for `sale.complete`, `pos.payment`
   for `session.open` and `session.close`, none for `pin.login` and `sale.abandoned` (they are
   facts). Do not add `requireUser`, `requireOwner` or `requirePermission` here.
3. Content type, second: `const contentType = event.request.headers.get('content-type') ?? '';`
   and if `!contentType.toLowerCase().startsWith('application/json')`, return
   `json({ error: 'unsupported_media_type' }, { status: 415, headers: NO_STORE })`, where
   `const NO_STORE = { 'cache-control': 'no-store' } as const` sits at module level. `startsWith`,
   not equality: the till sends `application/json`, and a fetch polyfill or a proxy may append
   `; charset=utf-8`.
4. Body, third: `let body: unknown; try { body = await event.request.json(); } catch { return
   json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE }); }`. Read the body
   exactly once — never `text()` and then `json()`.
5. Envelope, fourth. A module-level schema:

   ```ts
   const envelopeSchema = z.object({
   	kind: z.enum(OP_KINDS),
   	clientOpId: z.uuid(),
   	deviceId: z.uuid(),
   	employeeId: z.uuid(),
   	occurredAt: z.iso.datetime({ offset: true }),
   	seq: z.number().int().min(0),
   	payload: z.unknown()
   });
   ```

   `const parsed = envelopeSchema.safeParse(body);` — on failure return
   `json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE })`. The PAYLOAD is
   deliberately `z.unknown()`: its schema belongs to `validateSale` (T-18) for `sale.complete` and
   to `handleOp`'s small per-kind schemas (T-21) for the other four kinds, because a payload defect
   on a CASH sale must become `200 { status: 'unrecorded' }` with the op row STORED and flagged
   (spec 6: "stored and flagged for owner review, never discarded"), never a 400 that leaves
   nothing behind. The seven envelope fields are exactly what the server needs to KEY the op
   (`pos_sync_ops` `UNIQUE (device_id, client_op_id)`) and to fill its row's NOT NULL columns
   as T-07's `posSyncOps` table (`src/lib/server/db/schema/pos-sync.ts`) actually declares them:
   `client_op_id`, `device_id`, `kind`, `occurred_at` and `payload` (`received_via_device_id`,
   `status` and `received_at` are the server's own). There is NO `device_seq` column and no
   column at all for the envelope's `seq`: it survives only inside the `payload` jsonb. `seq`
   stays in this schema because `OpEnvelope.seq` is part of T-03's wire contract (the till's
   FIFO order), not because any column stores it. Do not add a `device_seq` column — here, in
   T-21's `storeUnrecorded`, or anywhere — to satisfy a brief that names one; that is schema
   drift against the generated migration 0011, and a session that meets the name `device_seq`
   in T-21's text should read it as "the envelope's `seq`, kept in `payload`". An envelope that
   fails this schema cannot be stored at all, and that is the only thing 400 may mean on this
   route. `{ offset: true }` because the till
   stamps `occurredAt` with `new Date().toISOString()` (a `Z` suffix) today and a later device may
   send an offset; both name an instant.
6. Dispatch, fifth: `const result = await handleOp(db, device, requestContext(event),
   parsed.data as OpEnvelope<OpKind, unknown>);`. `device` is the `PosDeviceContext`
   (`{ restaurantId, deviceId, deviceCode }`) from step 2; `requestContext(event)` is
   `{ ip, userAgent }` from `src/lib/server/audit/index.ts`. `handleOp` owns everything after this
   line: the replay of a stored result for a known `(device_id, client_op_id)`, the device-lineage
   check (the op's `deviceId` must be a device row of `device.restaurantId`, revoked or not,
   otherwise 409 `foreign_device` with nothing stored), the employee check keyed on tender, the
   transaction, the outcome mapping and the audit rows.
7. Return, sixth and last: `return json(result.body, { status: result.http, headers: NO_STORE });`.
   `result.http` is 200, 400, 403, 409 or 422 and the route passes it through untouched — it never
   inspects `result.http` or `result.body`. `result.body` is serialisable by construction — every
   `*Minor` field of a `SyncResult` is a decimal STRING (`'920'`), never a bigint
   (`JSON.stringify` throws on a bigint). A bigint reaching this line is a T-21 bug to fix in
   T-21's file, not something to patch here with a replacer.
8. Nothing else in the file. In particular: no read of `event.locals.restaurantId` (null outside
   `/(dashboard)` by design — `src/hooks.server.ts` gives a tenant only to dashboard route ids),
   and do not write the literal text `locals.restaurantId` in a comment either, because the
   Done-when greps the whole file for it — say "the tenant is the device row's" instead;
   no comparison of `parsed.data.deviceId` with `device.deviceId` (that is `handleOp`'s lineage
   check, and the two legitimately differ after a revoke-and-re-register: the op is recorded under
   the OLD device's invoice namespace); no query; no money arithmetic; no `setHeaders`; no ETag;
   and no printing of any kind (spec 11 — printing is local to the till and never inside the
   payment transaction).
9. `src/routes/route-guards.test.ts`: in `it('finds exactly the /api routes the plan has
   shipped')`, add `'/api/pos/sync'` to the sorted list, after `'/api/pos/register'`. Do NOT add
   the route to `PUBLIC_ROUTE_IDS` in `src/lib/public-routes.ts`: the walk's `it('has exactly one
   public /api route: /api/pos/register')` would fail, and correctly so — the sync endpoint is
   device-guarded.
10. `src/routes/api/pos/permissions.integration.test.ts`, the EDIT, in four places:
    - Imports: add `import { randomUUID } from 'node:crypto';`, `import { POST as syncPost } from
      './sync/+server';`, `import { onRestaurantCreated, updateSettings } from
      '$lib/server/restaurants';`, `import { restaurantSettings } from
      '$lib/server/db/schema/restaurant-settings';`, `import { createCategory, createItem,
      getMenuVersion } from '$lib/server/menu';`, `import { computeOrderTotals, serializeTotals }
      from '$lib/money/order-totals';`, `import { minor, ROUNDING_RULE } from '$lib/money';` and
      `import { formatInvoiceNumber } from '$lib/sync-ops';` (`seedStaff` from
      `$lib/server/db/test/seed` is already imported after PR #11).
    - `seed()`: right after the `restaurants` insert, run the initializers —
      `await db.transaction((tx) => onRestaurantCreated(tx, restaurant.id, { restaurantName:
      'Cafe One', timeZone: 'UTC' }));` — so the settings row exists (a session needs the time
      zone for its business date), the default `Cashier` and `Waiter` roles exist (PR #11's
      `initializeDefaultRoles`; the existing `seedStaff(db, restaurant.id, { displayName: 'Sam' })`
      then finds `Cashier` instead of creating it), and T-12's `ensureChart` has seeded the 23
      accounts the journal writer resolves codes against. The initializers write no audit rows, so
      `sideEffects()` and every existing assertion are unchanged. Then add `const waiter = await
      seedStaff(db, restaurant.id, { roleName: 'Waiter', displayName: 'Wren' });` and return
      `waiterId: waiter.id` and `activeToken: active.token`; extend the `Seed` type with both.
    - `DEVICE_GUARDED` gains one row: `{ routeId: '/api/pos/sync', method: 'POST', body: (s: Seed)
      => ({ kind: 'session.open', clientOpId: randomUUID(), deviceId: s.activeDeviceId,
      employeeId: s.cashierId, occurredAt: new Date().toISOString(), seq: 0, payload: {
      posSessionId: randomUUID(), openingCashMinor: '0' } }), handler: syncPost }`. A
      `session.open` is the lightest well-formed op; blocks (a) and (b) throw 403 at
      `requireDevice` before it is read, and `sideEffects()` stays equal, which the existing
      `it.each` asserts.
    - The third `describe` ('insufficient role with a valid session') gains the two `it`s marked
      *(walk)* under **Tests**. Its comment says "A later plan adding a role-sensitive POS endpoint
      adds its row here" — this is that plan; reword the comment's first sentence to name
      `/api/pos/sync` as that endpoint.

**Tests:** all in `src/routes/api/pos/sync/sync.integration.test.ts` unless marked *(walk)*;
integration project, driving the REAL `POST`. The route module imports the app's `db`; the
integration project's aliases and `integration-setup.ts` point it at `matcami_test`, exactly as
`employees.integration.test.ts` relies on today. Every 200 body from `handleOp` carries more keys
than the ones named below (`posSessionId`, `businessDate`, an undefined `flag`), so assert bodies
with `toMatchObject`, never `toEqual`.

Fixture, once per file:
- `makeRestaurant(name, email)`: insert `restaurants`; `onRestaurantCreated(tx, id, {
  restaurantName: name, timeZone: 'UTC' })`; the owner (`role: 'owner'`, `email`, `passwordHash:
  'not-a-real-hash'`); `seedStaff(db, id, { roleName: 'Cashier', displayName: 'Sam' })`;
  `seedStaff(db, id, { roleName: 'Waiter', displayName: 'Wren' })` (the `Waiter` role holds spec
  8's five waiter keys and neither `pos.sell` nor `pos.payment`); `registerDevice(tx, {
  restaurantId: id, actorUserId: owner.id, label: 'Till' })`. Returns `{ restaurantId, ownerId,
  cashierId, waiterId, deviceId, deviceCode, token }` — `deviceCode` is `'POS1'` for a
  restaurant's first device.
- `readyToSell(r)`: `updateSettings(tx, r.restaurantId, { taxMode: 'exclusive', taxRateBp: 825,
  currencyCode: 'USD', posIdleLockSeconds: 120 }, { actorUserId: r.ownerId, ip: null, userAgent:
  null })`; `db.update(restaurantSettings).set({ acceptsCard: true, acceptsMobile: false
  }).where(eq(restaurantSettings.restaurantId, r.restaurantId))` (a direct column write is fine in
  a TEST — T-07 added the columns; T-29's audited writer is not a dependency of this task, and
  `validateSale` refuses a card sale outright while `accepts_card` is not `true`);
  `createCategory(tx, id, { name: 'Drinks' })` then `createItem(tx, id, { categoryId, name:
  'Tea', priceMinor: 850n })` → `itemId`; `menuVersion = await getMenuVersion(db, id)`; open a
  session through the route — `post(r.token, envelope(r, 'session.open', r.cashierId, {
  posSessionId: randomUUID(), openingCashMinor: '50000' }))` → expect `200` and
  `body.status === 'accepted'`, take `body.posSessionId`. Returns `{ itemId, menuVersion,
  posSessionId }`.
- `envelope(r, kind, employeeId, payload, clientOpId = randomUUID())` → `{ kind, clientOpId,
  deviceId: r.deviceId, employeeId, occurredAt: new Date().toISOString(), seq: nextSeq++,
  payload }` with a file-level `let nextSeq = 0`.
- `saleEnvelope(r, ready, { employeeId, method, invoiceSeq, clientOpId? })`: one line `{ lineId:
  randomUUID(), lineNo: 1, menuItemId: ready.itemId, itemName: 'Tea', quantity: 1,
  unitPriceMinor: '850', taxRateBp: 825, discountMinor: '0', modifiers: [] }`; totals from THE
  money function — `const t = computeOrderTotals({ taxMode: 'exclusive', lines: [{
  unitPriceMinor: minor(850n), quantity: 1n, modifierDeltasMinor: [], taxRateBp: 825,
  discountMinor: minor(0n) }] }, ROUNDING_RULE)` and `totals = serializeTotals(t)`, which must
  equal `{ subtotalMinor: '850', discountMinor: '0', taxMinor: '70', totalMinor: '920' }` (850 ×
  8.25% = 70.125; tax rounds ONCE to 70, the total 920.125 rounds once to 920, ties away from
  zero; net 850 = 920 − 70) — assert those four literals in one `it`, so a drift in T-10 fails
  here rather than surfacing as a `totals_mismatch` flag. Payments: `method === 'cash'` →
  `[{ paymentId: randomUUID(), method: 'cash', amountMinor: '920', tenderedMinor: '1000',
  changeMinor: '80' }]`; `'card'` → `[{ paymentId: randomUUID(), method: 'card', amountMinor:
  '920', tenderedMinor: null, changeMinor: null }]`. Payload: `{ orderId: randomUUID(),
  posSessionId: ready.posSessionId, orderType: 'takeaway', tableLabel: null, taxMode:
  'exclusive', currencyCode: 'USD', menuVersion: ready.menuVersion, invoiceSeq, invoiceNumber:
  formatInvoiceNumber(r.deviceCode, invoiceSeq), openedAt: new Date().toISOString(), lines,
  totals, payments }`, wrapped by `envelope(r, 'sale.complete', employeeId, payload, clientOpId)`.
- `rowCounts()`: `count(*)::int` over `orders`, `payments`, `invoices`, `journal_entries`,
  `journal_entry_lines` and `pos_sync_ops` — `db.execute(sql\`select count(*)::int as n from
  orders\`)` per table (the table names are the overview's contract; importing the Drizzle
  objects `orders`, `payments`, `invoices` from `src/lib/server/db/schema/orders.ts` (T-06),
  `journalEntries`, `journalEntryLines` from `schema/accounting.ts` (T-04) and `posSyncOps` from
  `schema/pos-sync.ts` (T-07) is equally fine) → one object the tests `toEqual` before and after
  a call.
- `makeEvent({ cookies, body, contentType })`: the cookie jar and `locals` exactly as in
  `employees.integration.test.ts` (`locals: { user: null, restaurantId: null, sessionToken: null,
  posDevice: null }`), `route: { id: '/api/pos/sync' }`, `request: new
  Request('http://localhost/api/pos/sync', { method: 'POST', headers: { origin:
  'http://localhost', ...(contentType ? { 'content-type': contentType } : {}) }, body })` —
  `body` is already a string (`JSON.stringify(envelope)`, or a raw string for the parse-failure
  case).
- `post(token | null, body, contentType = 'application/json')` → `{ status, body, headers }`,
  catching a thrown `error(403)` the way `get()` does in the employees test (`body: null` then).

Cases:
- MANDATORY (spec 29 — permission checks on every POS API): with a well-formed cash
  `saleEnvelope` naming the cashier — no cookie → 403, `body` null, `rowCounts()` unchanged; an
  unknown token (`generateDeviceToken()`) → 403; the token of a device revoked with
  `revokeDevice` → 403. And the no-cookie request sent with `content-type: text/plain` → 403,
  NOT 415: the device check runs before the body is looked at.
- Live cookie, `content-type: text/plain`, body `JSON.stringify(envelope)` → 415 `{ error:
  'unsupported_media_type' }`, `rowCounts()` unchanged. `content-type: application/json;
  charset=utf-8` → 200.
- Live cookie, `content-type: application/json`, body `'{not json'` → 400 `{ error:
  'invalid_request' }`, `rowCounts()` unchanged.
- `it.each` of envelope defects, each → 400 `{ error: 'invalid_request' }` and no `pos_sync_ops`
  row for its `clientOpId`: `kind: 'sale.steal'`; `clientOpId: 'not-a-uuid'`; `deviceId: 42`;
  `seq: -1`; `seq: 1.5`; `occurredAt: 'yesterday'`; `employeeId` missing; a body of `[]`.
- MANDATORY (spec 29 — permission checks): a CASH `sale.complete` naming the WAITER
  (`invoiceSeq: 1`) → 200, body `toMatchObject({ clientOpId, status: 'recorded_flagged', flag:
  'employee_not_permitted', posSessionId })`. Afterwards: `orders` has exactly one row and its
  `status` is `'paid'`; `invoices` has one row with `invoice_number = 'POS1-000001'`; `payments`
  has one row with `method = 'cash'` and `amount_minor = 920`; `journal_entries` has at least one
  row; the `pos_sync_ops` row for that `client_op_id` has `status = 'recorded_flagged'` and a
  non-null `order_id`. The fact was recorded in full; the flag is the owner's to review
  (invariant 5 — the TENDER decides the class, never the employee check's outcome and never
  connectivity).
- MANDATORY (spec 29 — permission checks): a CARD `sale.complete` naming the WAITER → 403
  `{ error: 'not_permitted' }` and `rowCounts()` unchanged — zero orders, payments, invoices,
  journal entries, journal lines and sync-op rows added. The SAME envelope (a fresh `clientOpId`,
  `invoiceSeq: 2` — the till would have burned 1 with a `sale.abandoned`) naming the CASHIER →
  200 with `status: 'accepted'`: the control that proves the fixture was valid and only the
  employee was wrong.
- MANDATORY (spec 29 — permission checks): `session.close` with payload `{ posSessionId,
  countedCashMinor: '50000' }` naming the WAITER → 403 `{ error: 'not_permitted' }`;
  `db.execute(sql\`select status from pos_sessions where id = ${posSessionId}\`)` → still
  `'open'`. The same close naming the CASHIER → 200, body `toMatchObject({ clientOpId, status:
  'accepted', posSessionId, expectedCashMinor: '50000', differenceMinor: '0' })` with
  `businessDate` matching `/^\d{4}-\d{2}-\d{2}$/` (no sale in this session: the opening float
  50000 equals the count).
- Foreign device: `b = await makeRestaurant('Cafe B', 'b@cafe.com')`; a cash sale envelope built
  for A but with `deviceId: b.deviceId`, posted with A's cookie → 409 `{ error: 'foreign_device'
  }`; no `pos_sync_ops` row with that `client_op_id` in either restaurant; `rowCounts()`
  unchanged.
- MANDATORY (spec 29 — offline sync: retries never create duplicates): the SAME cash sale
  envelope (same `clientOpId`, cashier, `invoiceSeq: 1`) posted twice → first 200 with `status:
  'accepted'`, second 200 with `status: 'replayed'` and the same `clientOpId`; `rowCounts()`
  after the second call `toEqual` the counts after the first; exactly one `invoices` row with
  `invoice_number = 'POS1-000001'`.
- `cache-control: no-store` on the 200, the 400, the 409 and the handler's 403 (the thrown
  `requireDevice` 403 carries no headers of ours — do not assert on it).
- *(walk)* In `permissions.integration.test.ts`'s third `describe`: `'POST /api/pos/sync answers
  exactly 403 to a card sale.complete naming a waiter, and stores nothing'` and `'POST
  /api/pos/sync answers exactly 403 to a session.close naming a waiter, and the session stays
  open'` — the same two assertions as above, using `s.activeToken`, `s.waiterId` and
  `s.cashierId`, with a local copy of `readyToSell`, `envelope`, `saleEnvelope` AND `rowCounts`
  (duplicated on purpose: a test file imports helpers from no other test file). The walk file's
  existing `sideEffects()` counts only audit rows and the cashier's failed-PIN count, which does
  not prove that no `orders` / `payments` / `invoices` / `pos_sync_ops` row was written — so
  "stores nothing" is asserted as BOTH `rowCounts()` (the local copy, over `orders`, `payments`,
  `invoices`, `journal_entries`, `journal_entry_lines`, `pos_sync_ops`) `toEqual` before and
  after, AND `sideEffects()` `toEqual` before and after for the audit side.

**Done when:** `pnpm test:integration src/routes/api/pos/sync/sync.integration.test.ts
src/routes/api/pos/permissions.integration.test.ts` passes; `pnpm test:unit
src/routes/route-guards.test.ts` passes with `'/api/pos/sync'` in its exact list and
`/api/pos/register` still the only public `/api` route; `pnpm check` and `pnpm lint` pass;
`grep -c 'locals.restaurantId' src/routes/api/pos/sync/+server.ts` prints `0`.

**Watch out:** The two 403s are different things. `requireDevice`'s THROWN 403 (device) comes
first and, on the till, stops the flush and runs `forgetDevice` (T-25); `handleOp`'s RETURNED
`{ error: 'not_permitted' }` 403 (employee — card/mobile sale or session close only) is answered
by the route as an ordinary JSON response. Keep the order: a revoked device sending garbage must
learn it is revoked, not that its content type is wrong. A 400 from this route is a TILL BUG,
never a business outcome — the till builds every envelope itself — and it stores nothing, so it
must never be treated as recorded. zod 4's `z.uuid()` ACCEPTS the nil UUID
`00000000-0000-0000-0000-000000000000` and the max UUID `ffffffff-ffff-ffff-ffff-ffffffffffff`
(both are listed explicitly in its regex), so do not write a 400 test for a nil id and do not
rely on the envelope schema to stop a nil `employeeId` or `deviceId`: a nil `employeeId` passes
and is caught downstream by `handleOp` (`employee_unknown` soft flag on a cash sale or a
session open, 403 on a card/mobile sale or a close), and a nil `deviceId` answers 409
`foreign_device`. Fixtures use `randomUUID()`. `event.request.json()`
consumes the body; never call `text()` before it. Do not "help" a bigint through `json()` with a
replacer — the contract is strings on the wire, and the fix belongs in T-21.

### T-28 — `GET /api/pos/employees`: device code, invoice hint, accepted tenders, open session, time zone

**Needs:** T-07 (the `accepts_card` / `accepts_mobile` columns on `restaurant_settings` and
`pos_sync_ops.invoice_seq`), T-20 (`pos_sessions` and the session module), T-21 (`handleOp` in
`src/lib/server/orders/sync.ts`, which the tests drive: the fixture records its sales through it,
and the hint test needs `validateSale`'s hard `unknown_item` to land as a stored `unrecorded` op
whose `invoice_seq` T-21's `storeUnrecorded` filled). Do not start this task before T-21 has run.
**Files:**
- `src/routes/api/pos/employees/+server.ts` — EDIT (inside `GET`, after `listPosEmployees(...)`:
  the `settings` object and the final `json({ device: { id: device.deviceId }, employees,
  settings }, …)` literal; every existing key and every comment stays, including the block that
  opens "WHY THE PIN HASH IS IN THIS RESPONSE" and ends "Do not soften or drop this comment")
- `src/routes/api/pos/employees/employees.integration.test.ts` — EDIT (the `get()` helper's body
  type; the `it('serialises exactly the seven keys of the read model, and exactly three top-level
  keys')` case; the `it('passes the idle lock through as null until set, then as the stored
  integer')` case; a new `describe` at the end. Not in the overview's file list, but it existed
  at Phase 1 — EDIT is the right tag; do not treat it as NEW)
- `src/lib/server/orders/invoice-hint.ts` — NEW (`lastInvoiceSeqForDevice`, a reader — so the
  route stays a route)
- `src/lib/server/pos-sessions/index.ts` — EXTEND (created by T-20; add `openSessionForDevice`
  beside `expectedCash`. If T-20 already exports a reader of a device's open session, use it and
  add nothing. Do not rewrite the file)
- `src/lib/server/restaurants/index.ts` — EDIT (`RestaurantWithSettings` and the `select({...})`
  inside `getRestaurantWithSettings` gain the two tender fields — the READ side; T-29 adds the
  writer)

**Spec:** 4 (what the POS caches: the employee list and the restaurant settings), 6 ("The POS
assigns invoice numbers from its own local sequence … `POS1-000001` … gap-free per device, and
the server enforces uniqueness on (device, number)"), 7 (the idle lock; PIN hashes cached on the
registered device), 10 ("Every POS session belongs to one business date" — spec 10 says nothing
about one session per till; one open session per device is the overview's R6, enforced by T-05's
partial unique index `pos_sessions_one_open_per_device`), 33 decision 4 (which of card and mobile
money a restaurant accepts — the overview's assumption 3)
**Invariants:** 1 (money is integer minor units — a bigint column becomes a decimal string on the
wire, never a JS number), 5 (the device sequence is gap-free per device; a server hint may only
RAISE the till's counter, so it is the max over BOTH tables and ALL op statuses), 8
(`requireDevice` first — a GET is not exempt, and this one ships PIN hashes), 11 (the business
date belongs to the session, never `created_at::date`), 12 (the bundle is served only to a
registered device)

**Do:**
1. `src/lib/server/orders/invoice-hint.ts` — NEW. Export `lastInvoiceSeqForDevice(database:
   Executor, restaurantId: string, deviceId: string): Promise<number>` (`Executor` from
   `../auth/session`, `sql` from `drizzle-orm`). One statement:

   ```ts
   const result = await database.execute(sql`
   	select greatest(
   		coalesce((select max(invoice_seq) from invoices
   		          where restaurant_id = ${restaurantId} and device_id = ${deviceId}), 0),
   		coalesce((select max(invoice_seq) from pos_sync_ops
   		          where restaurant_id = ${restaurantId} and device_id = ${deviceId}), 0)
   	)::int as last_seq`);
   return Number((result.rows[0] as { last_seq: number }).last_seq);
   ```

   `::int` is right here — a sequence number is a count, not money; `Number()` never touches a
   `*_minor` column. BOTH tables, and EVERY status of `pos_sync_ops` (`accepted`,
   `recorded_flagged`, `unrecorded`): an unrecorded sale burned its number just the same
   (T-21's `storeUnrecorded` fills `invoice_seq` on that row whenever the payload carried one),
   and a hint that ignored it would let a re-bound till reuse a number already printed on a
   receipt. Scoped by `restaurant_id` AND `device_id` (a device id is unique; the tenant predicate
   is the house rule). Writing it with the Drizzle objects `invoices`
   (`src/lib/server/db/schema/orders.ts`, T-06) and `posSyncOps` (`schema/pos-sync.ts`, T-07) as
   two selects of `sql<number>\`coalesce(max(…), 0)::int\`` joined by `Math.max` is equally
   acceptable. This task is keyed on PR #11's tree — assumption 2 of 00-overview.md; the
   PosEmployee shape with isOwner/roleName/permissions is PR #11's.
2. `src/lib/server/pos-sessions/index.ts` — EXTEND. Export `openSessionForDevice(database:
   Executor, restaurantId: string, deviceId: string): Promise<{ id: string; openedByUserId:
   string; businessDate: string; openingCashMinor: bigint; openedAt: Date } | null>`: select
   `id`, `openedByUserId`, `businessDate`, `openingCashMinor`, `openedAt` from `posSessions`
   (`src/lib/server/db/schema/pos-sessions.ts`, T-05) where `restaurant_id = restaurantId`,
   `device_id = deviceId` and `status = 'open'`, `limit 1` (T-05's partial unique index
   `pos_sessions_one_open_per_device` makes `limit 1` exact). `business_date` is declared
   `date('business_date', { mode: 'string' })`, so it arrives as `'YYYY-MM-DD'` — keep it a
   string end to end; a `date` has no time zone and must never pass through a JS `Date`.
3. `src/lib/server/restaurants/index.ts` — EDIT, the read side only. `RestaurantWithSettings`
   gains `acceptsCard: boolean | null;` and `acceptsMobile: boolean | null;`, each documented as
   "null until the owner chooses on /settings; no default anywhere"; the `select({...})` in
   `getRestaurantWithSettings` gains `acceptsCard: restaurantSettings.acceptsCard, acceptsMobile:
   restaurantSettings.acceptsMobile` (the T-07 column properties). `settingsComplete` is NOT
   changed: the tenders are optional, cash is always accepted, and a tender in the missing list
   would lock every till out of session-open (a refuted risk in the overview).
4. The route, `src/routes/api/pos/employees/+server.ts`, keeping the existing order —
   `requireDevice` first, then `listPosEmployees`, then `getRestaurantWithSettings`:
   - `device: { id: device.deviceId, code: device.deviceCode }` — `requireDevice` already returns
     `deviceCode`, so no query. Do NOT use `getRegisteredDevice(db, restaurantId)`: it returns the
     restaurant's MOST RECENT device, which is the wrong question — the cookie's device is the one
     being served.
   - `lastInvoiceSeq: await lastInvoiceSeqForDevice(db, device.restaurantId, device.deviceId)` —
     a plain integer, `0` when the device has never sold. Comment beside it: the till's
     `adoptServerHint` (T-23) folds it into `max(local counter, highest queued number, server
     hint)`, so the hint can only raise the till's counter, never lower it; the code beside it is
     what `formatInvoiceNumber(code, seq)` needs to print `POS1-000001`.
   - `settings: { posIdleLockSeconds: restaurant?.posIdleLockSeconds ?? null, timeZone:
     restaurant?.timeZone ?? null, acceptsCard: restaurant?.acceptsCard ?? null, acceptsMobile:
     restaurant?.acceptsMobile ?? null }` — nulls travel as nulls. The till disables a tender key
     whose setting is null with the reason "not chosen on the dashboard" rather than assuming an
     answer (invariant 5's "visibly disable"; a disabled control says why). `timeZone` is what the
     session-open screen (T-32) uses to show the business date it is about to use.
   - `const open = await openSessionForDevice(db, device.restaurantId, device.deviceId);` then
     `openSession: open ? { id: open.id, openedByUserId: open.openedByUserId, businessDate:
     open.businessDate, openingCashMinor: String(open.openingCashMinor), openedAt:
     open.openedAt.toISOString() } : null`. `String(...)` because `bigint` columns come back as
     `bigint` (Drizzle `mode: 'bigint'`): `JSON.stringify` throws on a bigint, and a `Number()`
     would be a float in disguise. `openedByUserId` is there because the till's
     `adoptServerSession` (T-24) stores the opener as `employeeId` beside `posSessionId`; T-30 maps
     `id` → `posSessionId` and `openedByUserId` → `employeeId` at the call site.
   - The response literal becomes `{ device, employees, lastInvoiceSeq, openSession, settings }` —
     exactly five top-level keys — with the same `{ status: 200, headers: { 'cache-control':
     'no-store' } }`.
5. Extend the route's closing comment (the `no-store` block) with one line per new key rather
   than a new essay; keep every existing sentence.

**Tests:** `src/routes/api/pos/employees/employees.integration.test.ts`, integration project.
- Widen the `get()` body type to `{ device: { id: string; code: string }; employees:
  Array<Record<string, unknown>>; settings: { posIdleLockSeconds: number | null; timeZone: string
  | null; acceptsCard: boolean | null; acceptsMobile: boolean | null }; lastInvoiceSeq: number;
  openSession: { id: string; openedByUserId: string; businessDate: string; openingCashMinor:
  string; openedAt: string } | null }`.
- The keys case becomes `'serialises exactly the seven keys of the read model, and exactly FIVE
  top-level keys'`: `Object.keys(body).sort()` → `['device', 'employees', 'lastInvoiceSeq',
  'openSession', 'settings']`; `body.device` → `{ id: a.deviceId, code: 'POS1' }`; the seven
  per-employee keys unchanged.
- The idle-lock case: `settings` → `{ posIdleLockSeconds: null, timeZone: 'UTC', acceptsCard:
  null, acceptsMobile: null }` before and `{ posIdleLockSeconds: 120, timeZone: 'UTC',
  acceptsCard: null, acceptsMobile: null }` after — the nulls STAY null: no number and no `false`
  substituted anywhere.
- The MANDATORY (spec 29 — a permission check test on every POS API route) 403 case at the top
  of the file stays exactly as it is.
- New `describe("the till's sale bootstrap (T-28)")`, with a fixture that mirrors T-27's
  (`readyToSell`, `envelope`, `saleEnvelope`, spelled out again in this file; `seedStaff(db, id,
  { roleName: 'Cashier', displayName: 'Sam' })` for the cashier; ops recorded with `handleOp(db,
  { restaurantId, deviceId, deviceCode }, { ip: null, userAgent: null }, envelope)` from
  `$lib/server/orders/sync`, asserting `result.http === 200` and `result.body.status`):
  - `'reports lastInvoiceSeq 0 and openSession null for a device that has never sold'` →
    `lastInvoiceSeq: 0`, `openSession: null`.
  - `'reports the highest invoice sequence across recorded sales AND an unrecorded op'`:
    `session.open` by the cashier (`openingCashMinor: '50000'`); cash sales with `invoiceSeq` 3
    and 7 → each `status: 'accepted'`; a cash sale with `invoiceSeq` 9 whose only line names
    `menuItemId: randomUUID()` (no such item → hard `unknown_item`) → `status: 'unrecorded'`;
    GET → `lastInvoiceSeq: 9`; and `select count(*)::int from invoices` → `2`, proving 9 came
    from `pos_sync_ops`, not from an invoice row.
  - `'keys the hint and the session on the cookie device, not on the restaurant'`: after the
    above, `revokeDevice` the first device and `registerDevice` a second (`deviceCode` `'POS2'`);
    GET with the second token → `device: { id: second.deviceId, code: 'POS2' }`,
    `lastInvoiceSeq: 0` and `openSession: null` — a new till starts at `POS2-000001` whatever
    POS1 sold, and POS1's still-open session is not its session.
  - `'shows the open session and hides a closed one'`: after `session.open` → `openSession`
    toEqual `{ id: posSessionId, openedByUserId: cashierId, businessDate:
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), openingCashMinor: '50000', openedAt:
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) }`; then `session.close` `{ posSessionId,
    countedCashMinor: '50000' }` by the cashier → `status: 'accepted'`; GET → `openSession:
    null`.
  - `'passes the accepted tenders through as stored'`: `db.update(restaurantSettings).set({
    acceptsCard: true, acceptsMobile: false })` → `settings.acceptsCard === true`,
    `settings.acceptsMobile === false` (a `false` is a chosen answer, distinct from null).
  - The existing `'tells every cache not to keep the response'` stays.

**Done when:** `pnpm test:integration src/routes/api/pos/employees/employees.integration.test.ts`
passes; `pnpm test:e2e e2e/pos-access.spec.ts` still passes — the till's employee-select screen
(`src/routes/(pos)/pos/+page.svelte`, the `fetch('/api/pos/employees')` handler) reads
`body.device.id`, `body.employees` and `body.settings.posIdleLockSeconds` through a local type
cast and ignores the new keys until T-30 maps them; do not tighten that cast into a runtime check
of the key set; `pnpm check` and `pnpm lint` pass; `pnpm test:integration
src/routes/api/pos/permissions.integration.test.ts` still passes (the route's existing walk row is
unchanged).

**Watch out:** `bigint` columns come back as `bigint` — every amount becomes a decimal string in
the JSON (`String(x)`), and a `Number()` on a `*_minor` value is the float invariant 1 forbids;
`lastInvoiceSeq` is the one integer, cast with `::int` in SQL. `business_date` is a `date`: a
string in, a string out, never a `Date` (a JS `Date` at "midnight" shifts with the process time
zone). The hint must include `unrecorded` ops: filtering `pos_sync_ops` by status here would
rewind a re-bound till onto a number an unrecorded sale already printed (the overview's MAJOR
"invoice counter in a store the device wipes"). A revoked device's ops do not leak into the new
device's hint because the hint is keyed on the cookie device's id, not on the restaurant — the
test above pins it.

### T-29 — Accepted-tender settings and the menu-version bump on tax changes

**Needs:** T-07 (the `accepts_card` / `accepts_mobile` columns; `menu_version` exists since
PR #10). T-28 added the READ side of the two fields to `getRestaurantWithSettings`; step 1 says
what to do if it is missing.
**Files:**
- `src/lib/server/restaurants/index.ts` — EDIT (`SettingsChanges`; `UpdateSettingsResult`'s
  reason union; inside `updateSettings`: after the `currencyCode` validation block and before the
  "A no-op submission must not produce a meaningless audit row" comment, then the
  `if (diff.timeZone || …)` condition and the `tx.update(restaurantSettings).set({...})` payload
  beneath it; the module's header comment on what it may import)
- `src/lib/server/restaurants/settings.integration.test.ts` — EDIT (a new `describe` after
  `'the tax and currency settings (T-36)'`. Not in the overview's file list, but it existed at
  Phase 1 — EDIT is the right tag; do not treat it as NEW)
- `src/routes/api/menu/version/version.integration.test.ts` — EDIT (one `it` beside `'moves
  after a menu write, and the old ETag no longer matches'` — the "GET /api/menu/version reflects
  it" assertion belongs where that route's helpers already live. Not in the overview's file list,
  but it existed at Phase 1 — EDIT is the right tag; do not treat it as NEW)
- `src/routes/(dashboard)/settings/+page.server.ts` — EDIT (`load`'s return; `settingsSchema`;
  the `safeParse({...})` input and the `updateSettings(...)` call inside `actions.default`; the
  `messages` map)
- `src/routes/(dashboard)/settings/+page.svelte` — EDIT (the `<script>` imports and two
  constants; the markup: the `<form>` moves outside the `Card` so that it wraps two Cards; a
  second `Card`, "Payment methods")
- `src/routes/(dashboard)/settings/settings-page.integration.test.ts` — NEW (the action
  round-trip; modelled on `src/routes/(dashboard)/menu/menu-page.integration.test.ts`)

**Spec:** 5 ("If the versions differ … the POS downloads the full menu snapshot and replaces its
local copy"), 17 ("Tax mode is a restaurant setting"; "Each order line stores the tax rate used,
so later rate changes don't alter past sales"), 3 ("Sensitive actions are audit-logged" — spec 3
names neither settings changes nor old/new values; the old/new `changes` diff is the EXISTING
`settings.updated` audit event in `src/lib/server/audit/events.ts`, typed `Record<string, { old:
unknown; new: unknown }>`, which this task reuses unchanged), 33 decision 4 ("Cash plus one card
or mobile-money method" — which of the two a
restaurant takes is this per-restaurant pair; the overview's assumption 3, recorded by T-02)
**Invariants:** 7 (tax mode and rate are read at calculation time — on the till, from its cached
snapshot — so a change must reach the till, and the version is the only signal), 10 (the audit
row is written in the same transaction as the change; `updateSettings` already does this), 8 (the
form action checks `admin.settings` and answers 403 inside the action, not only in `load` —
already true; keep it), 1 (no money here at all: two booleans and an integer version)

**Do:**
1. `SettingsChanges` gains `acceptsCard?: boolean;` and `acceptsMobile?: boolean;`.
   `UpdateSettingsResult`'s failure reasons gain `'invalid_tender'`. If `RestaurantWithSettings`
   does not yet carry `acceptsCard: boolean | null` and `acceptsMobile: boolean | null` (T-28
   adds them), add them now, with `acceptsCard: restaurantSettings.acceptsCard, acceptsMobile:
   restaurantSettings.acceptsMobile` in `getRestaurantWithSettings`'s select.
2. In `updateSettings`, after the `currencyCode` block:

   ```ts
   for (const key of ['acceptsCard', 'acceptsMobile'] as const) {
   	const value = changes[key];
   	if (value === undefined) continue;
   	if (typeof value !== 'boolean') return { ok: false, reason: 'invalid_tender' };
   	if (value !== current[key]) diff[key] = { old: current[key], new: value };
   }
   ```

   `false` is a chosen answer ("not accepted") and diffs against `null` ("not chosen");
   `undefined` means "not submitted, leave it alone", like every other optional field here. There
   is NO default: nothing in this module, the schema or the page turns a null into `false`.
3. The version bump, in the SAME `UPDATE` statement as the settings write. After the diff is
   complete: `const bumpMenuVersion = Boolean(diff.taxMode || diff.taxRateBp ||
   diff.currencyCode);`. Widen the condition to `if (diff.timeZone || diff.posIdleLockSeconds ||
   diff.taxMode || diff.taxRateBp || diff.currencyCode || diff.acceptsCard ||
   diff.acceptsMobile)` and add to the `.set({...})` payload: `...(diff.acceptsCard ? {
   acceptsCard: changes.acceptsCard! } : {})`, `...(diff.acceptsMobile ? { acceptsMobile:
   changes.acceptsMobile! } : {})` and `...(bumpMenuVersion ? { menuVersion:
   sql\`${restaurantSettings.menuVersion} + 1\` } : {})` (`import { sql } from 'drizzle-orm'`).
   A `diff` entry is an object, so `diff.acceptsCard` is truthy even when the new value is
   `false`. INLINE SQL, `menu_version + 1` — never read-modify-write in TypeScript (two concurrent
   saves must not both read 7 and both write 8), and never a call into `src/lib/server/menu/`:
   `restaurants/` may not import `menu/`, and T-02 recorded this inline increment as the one
   sanctioned exception in CLAUDE.md's house-convention paragraph. Add that sentence to this
   module's header comment.
   WHY: the till's menu snapshot (`readMenuSnapshot` in `src/lib/server/menu/index.ts`) carries
   `taxMode`, `taxRateBp` and `currencyCode` beside the items, and the till totals every bill from
   that copy. The server's recomputation in `validateSale` (T-18) uses the OP's OWN rate and
   mode, never the live settings — so a stale rate on the till is never even flagged. The version
   the till polls at `/api/menu/version` is therefore the ONLY thing that can make it re-download
   the snapshot after a tax or currency change (the overview's MAJOR "a tax setting change never
   bumps the menu version").
4. `updatedAt: now` stays exactly as it is in that payload; the bump changes nothing else about
   the statement — no second `UPDATE`, and no touch of `updated_at` beyond what the existing code
   already does.
5. The audit row needs nothing new: `details: { changes: diff }` already carries every key, and
   the `settings.updated` member of the union in `src/lib/server/audit/events.ts` is
   `Record<string, { old: unknown; new: unknown }>`. Expected row for a first `{ acceptsCard:
   true }`: `{ changes: { acceptsCard: { old: null, new: true } } }`.
6. `settingsComplete` is NOT touched: the tenders never appear in `missing`.
7. `src/routes/(dashboard)/settings/+page.server.ts`:
   - `load` returns `acceptsCard: restaurant.acceptsCard` and `acceptsMobile:
     restaurant.acceptsMobile` (`boolean | null` each) beside the existing keys.
   - `settingsSchema` gains `acceptsCard: z.enum(['unset', 'yes', 'no']).optional()` and
     `acceptsMobile: z.enum(['unset', 'yes', 'no']).optional()`; the `safeParse({...})` input
     gains `acceptsCard: optionalField(form.get('acceptsCard'))` and `acceptsMobile:
     optionalField(form.get('acceptsMobile'))`.
   - One mapper: `function tender(value: 'unset' | 'yes' | 'no' | undefined): boolean |
     undefined { return value === undefined || value === 'unset' ? undefined : value === 'yes';
     }` — `'unset'` → `undefined` (not submitted: a stored answer is left as it is, and a null
     stays null), `'yes'` → `true`, `'no'` → `false`. The `updateSettings` call gains
     `acceptsCard: tender(parsed.data.acceptsCard)` and `acceptsMobile:
     tender(parsed.data.acceptsMobile)`.
   - `messages` gains `invalid_tender: 'Choose Accepted or Not accepted for each payment
     method.'`.
   - The action's first line stays `const user = requirePermission(event, 'admin.settings');` —
     the static walk checks that the guard sits inside `actions`.
8. `src/routes/(dashboard)/settings/+page.svelte`:
   - Import `SelectField` beside the other primitives from `$lib/components/ui` (PR #11 added
     `SelectField.svelte` and its `index.ts` export — if it is missing after the merge, stop and
     report; do not write a `<select>` by hand with retyped class strings).
   - Two constants in the script: `const TENDER_OPTIONS = [{ value: 'unset', label: 'Not chosen'
     }, { value: 'yes', label: 'Accepted' }, { value: 'no', label: 'Not accepted' }];` and
     `const tenderValue = (v: boolean | null) => (v === null ? 'unset' : v ? 'yes' : 'no');`.
   - Markup: the `<form method="POST" class="flex flex-col gap-5" use:enhance={…}>` (its
     `use:enhance` block unchanged) now WRAPS two `Card`s and the button row. The first `Card
     class="max-w-form"` keeps every existing `Field` and `datalist` inside a `<div class="flex
     flex-col gap-5">`. The second `Card class="max-w-form"` holds `<h3 class="text-ink
     font-semibold">Payment methods</h3>`, then `<p class="text-ink-2 text-sm">Cash is always
     accepted. Card and mobile-money payments are taken on a standalone terminal and recorded here
     as the tender; the till never talks to a payment provider, and a method you have not chosen
     is disabled on the till with that reason shown.</p>`, then `<SelectField id="acceptsCard"
     name="acceptsCard" label="Card terminal" value={tenderValue(data.acceptsCard)}
     options={TENDER_OPTIONS} hint="Accepted: the till offers a Card key and the cashier records
     what the terminal approved." />` and `<SelectField id="acceptsMobile" name="acceptsMobile"
     label="Mobile money" value={tenderValue(data.acceptsMobile)} options={TENDER_OPTIONS}
     hint="Accepted: the till offers a Mobile key and the cashier records the confirmed
     transfer." />`. The existing button row (`Save settings` / `Saving…` and its caption) sits
     after the second Card, inside the form, in a `<div class="max-w-form flex flex-wrap
     items-center gap-3">`. Still exactly one `role="alert"` on the page (the `Alert` above the
     form); `Card` does not nest in `Card`; no arbitrary Tailwind value; no money figure anywhere
     on the page.

**Tests:**
- `settings.integration.test.ts`, new `describe('accepted tenders and the menu-version bump
  (T-29)')`, with `async function menuVersionOf(id)` selecting `restaurantSettings.menuVersion`
  where `restaurantId = id`:
  - `'a tax rate change bumps menu_version by exactly 1, and re-saving the same rate does not'`:
    a fresh restaurant → `1`; `updateSettings(tx, id, { taxRateBp: 825 }, ctx)` → `2`; the same
    call again → `{ ok: true, changed: false }` and still `2`.
  - `'a tax mode change and a currency change each bump by exactly 1; one save changing all
    three bumps once'`: `{ taxMode: 'inclusive' }` → +1; `{ currencyCode: 'USD' }` → +1; on a
    fresh restaurant `{ taxMode: 'exclusive', taxRateBp: 825, currencyCode: 'USD' }` → `1`
    becomes `2`, not `4`.
  - `'saving only the name, the time zone, the idle lock or a tender does not bump'`: four saves
    on a fresh restaurant (`{ name: 'Renamed' }`, `{ timeZone: 'Asia/Riyadh' }`, `{
    posIdleLockSeconds: 120 }`, `{ acceptsCard: true }`) → `menuVersionOf(id)` is `1` after each.
  - `'saving acceptsCard true writes the column and ONE audit row'`: the result
    `toEqual({ ok: true, changed: true, changes: { acceptsCard: { old: null, new: true } } })`;
    `getRestaurantWithSettings(db, id)` → `acceptsCard === true` and `acceptsMobile === null`;
    `auditLog` has one row, `event: 'settings.updated'`, `details: { changes: { acceptsCard: {
    old: null, new: true } } }`.
  - `'acceptsMobile false is an answer, not "unset"'`: `{ acceptsMobile: false }` →
    `changes: { acceptsMobile: { old: null, new: false } }`, the column `false`; saving `false`
    again → `changed: false`, still one audit row.
  - `'rejects a non-boolean tender and writes nothing'`: `{ acceptsCard: 'yes' as unknown as
    boolean }` → `{ ok: false, reason: 'invalid_tender' }`; no audit row; the column still `null`.
  - `'the tenders are not part of settingsComplete'`: with the four required settings chosen and
    both tenders null → `{ complete: true, missing: [] }`.
  - The file's existing MANDATORY (spec 29 — tax in BOTH modes) case stays and must still pass.
- `version.integration.test.ts`, `it('moves after a tax-setting change, so the till re-downloads
  the snapshot')`: first GET → `{ version: 1, restaurantId }`; `updateSettings(tx, id, {
  taxRateBp: 825 }, { actorUserId: a.ownerId, ip: null, userAgent: null })`; GET with the old
  ETag → `200` `{ version: 2, restaurantId }`; then `updateSettings(tx, id, { name: 'Renamed' },
  …)` → GET with the version-2 ETag → `304` (a rename moves nothing).
- `settings-page.integration.test.ts` — NEW, copying `menu-page.integration.test.ts`'s
  `makeRestaurant` / `principal` / `makeEvent` / `statusOf` shape with `route: { id:
  '/(dashboard)/settings' }` and the url `http://localhost/settings`; staff seeded with
  `seedStaff(db, restaurantId, { displayName: 'Staff' })` and a `'staff'` principal:
  - MANDATORY (spec 29 — permission checks; this repository applies the rule to every route):
    the staff principal → `403` from `load` and from `actions.default`.
  - `'round-trips the tri-state'`: the owner posts `{ name: 'Cafe One', timeZone: 'UTC',
    acceptsCard: 'yes', acceptsMobile: 'no' }` → the action returns `{ message: 'Settings saved.'
    }`; `getRestaurantWithSettings` → `acceptsCard: true`, `acceptsMobile: false`; `load` →
    `acceptsCard: true`, `acceptsMobile: false`; posting `acceptsCard: 'unset', acceptsMobile:
    'unset'` (same name and time zone) → `{ message: 'No changes to save.' }` and both values
    unchanged; posting `acceptsCard: 'maybe'` → a `fail(400)` result (`status === 400`) with a
    message, nothing written.
  - `'a tax rate saved through the page bumps the menu version'`: post `taxRateBp: '825'` (with
    the name and time zone) → `menu_version` `1` → `2`.

**Done when:** `pnpm test:integration src/lib/server/restaurants/settings.integration.test.ts
src/routes/api/menu/version/version.integration.test.ts
"src/routes/(dashboard)/settings/settings-page.integration.test.ts"` passes; `pnpm check` and
`pnpm lint` pass; `pnpm test:unit src/routes/route-guards.test.ts` still passes (the action keeps
its guard); `grep -c "menuVersion} + 1" src/lib/server/restaurants/index.ts` prints `1` and
`grep -c "from '../menu'" src/lib/server/restaurants/index.ts` prints `0`; `pnpm test:e2e
e2e/smoke.spec.ts e2e/auth.spec.ts` still pass (the settings form's labels and its single alert
are unchanged).

**Watch out:** No default anywhere for the two booleans: not a column `DEFAULT`, not a `?? false`
in the route, the read model or the page, not a pre-selected `'no'` — `null` renders as
"Not chosen" and travels to the till as `null`. Do not add the tenders to `settingsComplete`. Do
not touch `updated_at` semantics beyond what `updateSettings` already does (it is set on every
settings write here; the menu module's own bump deliberately does NOT set it, and that stays true
there). The bump condition is the DIFF, not the submission: re-saving the same rate must not bump
(every till would re-download for nothing), and one save changing mode, rate and currency together
bumps once, not three times. `'unset'` maps to `undefined`, so the page cannot clear a chosen
tender back to null — a deliberate mirror of the other optional fields, which is why the test
asserts `'No changes to save.'` rather than a null.
