# Phase 3 — offline (T-22 … T-26)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 2 (03-money.md) and
> Phase 0 (T-03).

Offline is its own phase and never a UI concern: no task in this file touches a `.svelte` route,
and no task in `08-pos-screens.md` may reach into IndexedDB directly — every screen calls a function
written here. Everything in this phase lives in `src/lib/pos/`, plus one edit to `vitest.config.ts`
in T-26 (a root config, tagged EDIT there). Outside that directory it imports
ONLY `src/lib/money/` (the one rounding rule, spec 17), `src/lib/pin/` and `src/lib/sync-ops/`
(T-03's op contract) — never `src/lib/server/**` (`eslint.config.js` errors on it; SvelteKit
build-blocks it from the browser, and a till that cannot build cannot sell), never `$app/*` or
`$env/*` (the unit project runs in plain `node` with no SvelteKit), and never a copy of a money
function (two rounding rules is the bug spec 17 exists to prevent). Every module here is
unit-tested with `fake-indexeddb` (a pinned devDependency, `6.2.5`; `src/lib/pos/store.test.ts` is
the pattern: `import 'fake-indexeddb/auto'` first, `deleteDatabase()` in `beforeEach`, and the
real `add()`/`ConstraintError` behaviour rather than a re-implementation of it). Two rules bind
every IndexedDB transaction in this phase: a transaction auto-commits the moment the event loop
turns with no request outstanding against it, so the ONLY thing ever awaited inside one is another
request on that same transaction — every `fetch`, timer, PIN hash or second transaction is awaited
BEFORE the transaction opens (the comment above `syncMenu` in `store.ts` says why); and a `bigint`
never reaches `JSON.stringify` — a queue entry's `envelope` carries every `*Minor` value as a
decimal string from the moment it is written, while `bigint` values live only in local records
that never cross the wire. Money arithmetic in this phase is exactly one call, `computeOrderTotals`
from `src/lib/money/order-totals.ts` (T-10), plus `changeDue` from `src/lib/money/change.ts`
(T-11); nothing here adds, multiplies or rounds an amount itself (invariants 1 and 7). Execute in
ID order: T-22 → T-23 → T-24 → T-25 → T-26 (T-26 needs only T-22 and may run in parallel with
T-23–T-25). One commit per task, `T-NN <type>(<scope>): <title>`.

### T-22 — IndexedDB version 3: the four new stores, wipe exemptions, one unsynced count, pruning, `onblocked`

**Needs:** T-03
**Files:**
- `src/lib/pos/store.ts` — EDIT (the `DB_VERSION` constant and the comment above it; the
  `switch (oldVersion)` inside `upgrade()`, adding `case 2:` after `case 1:`; the four record types
  go directly after `export type OfflineLogin`; the private helpers `inTransaction`, `valueOf` and
  `withDb` become exports; `countUnsynced` and its doc comment; the doc comments of `bindDevice` and
  `forgetDevice`; `request.onblocked` inside `openPosDb`; new exports `countParked`,
  `pruneCompletedOrders` and `signalUnsyncedChange` placed after `onUnsyncedChange`)
- `src/lib/pos/store.test.ts` — EDIT (new `describe` blocks after the existing
  `describe('the POS store', …)`; reuse its `deleteDatabase()`, `offlineLogins()` and `login()`
  helpers — do not redefine them)
**Spec:** 4 (IndexedDB holds "Locally created orders" and the "Pending sync queue"), 6 ("The POS
assigns invoice numbers from its own local sequence, whether online or offline"; "The number of
unsynced operations is always visible on screen"; "Offline logins are recorded locally and synced
to the audit log"), 10 (every POS session belongs to one business date)
**Invariants:** 5 (a completed offline cash sale is a recorded fact; the unsynced count is always on
screen; the device's invoice sequence is never renumbered — so it is never wiped either), 12 (a
revoked till forgets its cached bundle but NEVER its unsynced work), 2 (posted records are
permanent — the prune below deletes only a LOCAL copy of a sale the server has already recorded and
answered for; it never touches a server row)

**Do:**
1. Open `src/lib/pos/store.ts`. Change `const DB_VERSION = 2;` to `const DB_VERSION = 3;` and
   replace the comment above it with: `// 3 since T-22 (tasks/pos-sales) added the order store, the
   sync queue, the invoice sequence and the session store (case 2 below).` Do not touch `DB_NAME`.
2. Directly after `export type OfflineLogin = { … };` add the four record types, exported, with
   these exact field names (they are the shared vocabulary of T-23–T-26 and `08-pos-screens.md`).
   The type-only import they need goes at the TOP of the file, beside
   `import { verifyPin } from '../pin';`:
   `import type { OpEnvelope, OpKind, SyncResult } from '../sync-ops';` (T-03).
   ```ts
   /** One order on this till. `cart` is T-24's Cart; typed as a parameter so this file does not
    *  import a module that does not exist yet — T-24 writes LocalOrder<Cart>. */
   export type LocalOrder<C = unknown> = {
   	id: string;                 // the orderId, a device-generated uuid (keyPath)
   	deviceId: string;           // the pos_devices uuid this order was recorded under — for ever
   	employeeId?: string;        // who completed it (set by completeSale; absent while 'cart')
   	clientOpId?: string;        // the sale.complete op's key (set by completeSale)
   	state: 'cart' | 'completed' | 'abandoned';
   	cart: C;
   	invoiceSeq?: number;
   	invoiceNumber?: string;     // 'POS1-000001'
   	completedAt?: string;       // ISO 8601 UTC, device clock
   	syncedAt?: string;          // ISO 8601 UTC, set by the flush when the server answered
   	syncStatus?: 'accepted' | 'recorded_flagged' | 'unrecorded' | 'rejected';
   };
   /** One queued operation. `envelope` is what goes on the wire: every *Minor field in it is a
    *  decimal STRING, never a bigint (bigint does not survive JSON). */
   export type QueueEntry = {
   	clientOpId: string;         // keyPath; the idempotency key
   	deviceId: string;
   	seq: number;                // tablet-wide FIFO position, unique across the store
   	kind: OpKind;
   	envelope: OpEnvelope<OpKind, unknown>;
   	state: 'pending' | 'sending' | 'done' | 'parked';
   	attempts: number;
   	lastError?: string;
   	lastResult?: SyncResult;
   };
   /** The per-device counters. NEVER cleared by bindDevice or forgetDevice. */
   export type SequenceRow = { deviceId: string; invoiceSeq: number; queueSeq: number };
   /** The cashier shift this device is in, if any. */
   export type LocalSession = {
   	deviceId: string;           // keyPath: one session row per device
   	posSessionId: string;       // device-generated uuid, or the id the server answered
   	employeeId: string;
   	openingCashMinor: string;   // decimal string of minor units
   	openedAt: string;           // ISO 8601 UTC
   	businessDate?: string;      // 'YYYY-MM-DD', from the server's session.open answer
   	state: 'opening' | 'open' | 'closing' | 'closed';
   	countedCashMinor?: string;  // set by closeLocalSession
   	closedAt?: string;
   	expectedCashMinor?: string; // from the server's session.close answer
   	differenceMinor?: string;
   	lastError?: string;         // the flush's last refusal of the open or close, in words
   };
   ```
   Check `src/lib/sync-ops/index.ts` (T-03) for an exported union of the five envelopes; if it
   exports one, type `envelope` with it instead of `OpEnvelope<OpKind, unknown>`.
3. In `upgrade()`, add `case 2:` after `case 1:`'s `// falls through`, and NEVER a `break`:
   ```ts
   case 2: {
   	// T-22 (tasks/pos-sales): the sales stores. A till at version 2 runs ONLY this
   	// case and keeps its employees, settings, menu and offline_logins.
   	const orders = db.createObjectStore('orders', { keyPath: 'id' });
   	// The index is NAMED 'status' (00-overview.md's name); its keyPath is the record
   	// field `state` — readCart and pruneCompletedOrders query it by that name.
   	orders.createIndex('status', 'state');
   	orders.createIndex('deviceId', 'deviceId');
   	const queue = db.createObjectStore('sync_queue', { keyPath: 'clientOpId' });
   	queue.createIndex('seq', 'seq', { unique: true });
   	queue.createIndex('deviceId', 'deviceId');
   	queue.createIndex('state', 'state');
   	db.createObjectStore('invoice_sequence', { keyPath: 'deviceId' });
   	db.createObjectStore('session', { keyPath: 'deviceId' });
   }
   // falls through
   ```
   `case 0` and `case 1` are not edited by one character: a device already at version 2 will never
   run them again, so a change there would run on fresh tills only and the two fleets would differ.
4. Export the three private helpers unchanged: `export function inTransaction(…)`,
   `export function valueOf<T>(…)`, `export async function withDb<T>(…)`. T-23–T-25 reuse them
   instead of copying six lines into four files.
5. Replace `countUnsynced` with ONE count over two stores, in one readonly transaction over
   `['offline_logins', 'sync_queue']`: the `offline_logins` rows whose `synced === false` PLUS the
   `sync_queue` rows whose `state` is neither `'done'` nor `'parked'`. Update its doc comment: this
   is THE number the connection bar shows; `'parked'` is excluded because a parked op is not waiting
   for a connection — it is waiting for the owner, and `countParked()` shows it as its own chrome
   (T-30); it must never be shown as a second "unsynced" number.
6. Add `export function countParked(): Promise<number>` — the `sync_queue` rows in state
   `'parked'`, via the `state` index (`index.count('parked')`).
7. Add `export function signalUnsyncedChange(): void` that does
   `unsyncedChanges.dispatchEvent(new Event('change'))`, and make `recordOfflineLogin` call it
   instead of dispatching inline. T-24's `completeSale`, `abandonSale`, `openLocalSession` and
   `closeLocalSession` and T-25's flush call it after every commit that changes the count.
8. `bindDevice` and `forgetDevice` keep their store lists exactly as they are —
   `['employees', 'settings', 'menu']`. Extend BOTH doc comments with this sentence: "`orders`,
   `sync_queue`, `invoice_sequence` and `session` are NEVER touched here, for the same reason as
   `offline_logins`: an unsynced sale is a recorded fact stamped with the device it was made on
   (invariant 5), and a wiped invoice counter would hand out a number that is already queued
   (00-overview.md, the 'invoice counter in a store the device wipes' risk)."
9. In `openPosDb`, replace the `request.onblocked` rejection with a warning that lets the promise
   settle on `onsuccess`/`onerror`:
   ```ts
   request.onblocked = () =>
   	console.warn(
   		`Opening the POS database "${DB_NAME}" is waiting for another tab to close its older connection`
   	);
   ```
   `onblocked` fires while another tab still holds a version-2 connection; the upgrade proceeds
   the moment that tab's connection closes, and since every function in this file closes its
   connection after each operation (`withDb`), the wait is momentary. Rejecting turned that
   moment into an error every caller surfaced as a broken till.
10. Add `export function pruneCompletedOrders(olderThanDays = 30, now = Date.now()):
    Promise<number>`: one readwrite transaction over `['orders', 'sync_queue']`;
    `cutoff = now − olderThanDays × 86_400_000`; for every `orders` row with `state === 'completed'`
    AND `typeof syncedAt === 'string'` AND `Date.parse(syncedAt) < cutoff`: delete the row and, in
    the same transaction, every `sync_queue` row in state `'done'` whose
    `envelope.payload.orderId === row.id` (the sale's own `sale.complete`, and a `sale.abandoned`
    if one exists — read them with the `state` index's `getAll('done')` and filter). A row with no
    `syncedAt` is NEVER pruned (the server has not answered for it); `'cart'` and `'abandoned'` rows
    are never pruned; a queue row in `'pending'`, `'sending'` or `'parked'` is never pruned. Resolve
    with the number of orders removed. No `signalUnsyncedChange`: nothing removed was counted.
    (Assumption 13 in 00-overview.md: synced sales are pruned after 30 days, from the flush, T-25.)

**Tests:** (`src/lib/pos/store.test.ts`, fake-indexeddb; each in a new `describe`)
- Upgrade 2 → 3 keeps data: after `beforeEach`'s `deleteDatabase()`, open the database BY HAND at
  version 2 (`indexedDB.open('matcami-pos', 2)`, `onupgradeneeded` creating `employees` (keyPath
  `id`), `settings` (`key`), `offline_logins` (`clientOpId`) and `menu` (`id`) — the version-2
  layout), add two `offline_logins` rows through that connection, close it; then `await openPosDb()`
  → `Array.from(db.objectStoreNames).sort()` equals `['employees', 'invoice_sequence', 'menu',
  'offline_logins', 'orders', 'session', 'settings', 'sync_queue']`, `offlineLogins()` still has
  2 rows, `upgradeRunsForTest()` rose by exactly 1, and the `sync_queue` store's `indexNames`
  contains `'seq'`, `'deviceId'` and `'state'` with `index('seq').unique === true`.
- Wipes exempt the four stores: seed one row in each — `orders` `{ id: 'o-1', deviceId:
  'device-A', state: 'completed', cart: {} }`, `sync_queue` `{ clientOpId: 'op-1', deviceId:
  'device-A', seq: 1, kind: 'sale.complete', envelope: {}, state: 'pending', attempts: 0 }`,
  `invoice_sequence` `{ deviceId: 'device-A', invoiceSeq: 7, queueSeq: 3 }`, `session` `{ deviceId:
  'device-A', posSessionId: 's-1', employeeId: 'e-1', openingCashMinor: '50000', openedAt:
  '2026-09-28T08:00:00.000Z', state: 'open' }` — then `await bindDevice('device-A')`, `await
  cacheEmployees([employee('a')])`, `await bindDevice('device-B')`, `await forgetDevice()` →
  each of the four stores still holds its one row unchanged, `readCachedEmployees()` is `[]` and
  `readBoundDeviceId()` is `null`.
- One count: two `recordOfflineLogin` rows (`synced: false`) + `sync_queue` rows in states
  `pending`, `pending`, `pending`, `parked`, `done` → `countUnsynced()` is `5` (2 logins + 3
  pending; parked and done excluded) and `countParked()` is `1`. Then add one row in state
  `'sending'` → `countUnsynced()` is `6` (`sending` is neither done nor parked, so it counts).
- Prune: with `now = Date.parse('2026-09-28T12:00:00Z')`, seed `orders` A (`completed`, `syncedAt`
  31 days before `now`), B (`completed`, 29 days before), C (`completed`, no `syncedAt`,
  `completedAt` 40 days before), D (`cart`), E (`abandoned`, `syncedAt` 40 days before); seed
  `sync_queue` a `done` `sale.complete` for A, a `done` `sale.abandoned` for A, a `pending`
  `sale.complete` for B → `pruneCompletedOrders(30, now)` resolves `1`; the `orders` store holds
  exactly B, C, D, E; the `sync_queue` store holds exactly B's pending entry.
- Existing tests: every test already in the file still passes unchanged — in particular
  `'counts the unsynced records, and signals only when one was added'`, which proves
  `signalUnsyncedChange` did not change `recordOfflineLogin`'s behaviour.

**Done when:** `pnpm test:unit src/lib/pos` passes with the four new cases green (upgrade 2 → 3,
wipe exemptions, one count, prune) and every pre-existing case unchanged, and `pnpm check` and
`pnpm lint` pass.

**Watch out:** never `break` inside the `switch` — a till two versions behind must fall through
every later case in order; never write a `case 0` or `case 1` change. The `status` index's keyPath
is `state`; a `createIndex('status', 'status')` indexes a field no record has, and `readCart`
(T-24) and the prune find nothing, silently. `LocalOrder<C = unknown>`'s type parameter is what
keeps `pnpm check` green at THIS commit: `src/lib/pos/orders.ts` does not exist until T-24.

### T-23 — The per-device invoice sequence store

**Needs:** T-22
**Files:**
- `src/lib/pos/invoice-sequence.ts` — NEW
- `src/lib/pos/invoice-sequence.test.ts` — NEW
**Spec:** 6 ("The POS assigns invoice numbers from its own local sequence, whether online or
offline … The sequence is gap-free per device, and the server enforces uniqueness on (device,
number)"), 13 ("Record Invoice Number — from the device sequence: POS1-000123")
**Invariants:** 5 (invoice numbers come from the device's gap-free sequence, online or offline; the
server never renumbers, there is no global sequence and no `max(number)+1`), 12 (the counter is
keyed by the `pos_devices` uuid the till is bound to — the device CODE `POS1` repeats in every
restaurant and is only the display prefix)

**Do:**
1. Create `src/lib/pos/invoice-sequence.ts` importing `formatInvoiceNumber` from `'../sync-ops'`
   (T-03: `'POS1'` + `6` → `'POS1-000006'`; throws when `seq < 1`, `seq > 999999` or the code fails
   `/^[A-Z0-9]{1,8}$/`) and `openPosDb`, `withDb`, `valueOf`, `type SequenceRow` from `'./store'`.
2. A private `readRow(tx: IDBTransaction, deviceId: string): Promise<SequenceRow>` — `valueOf(
   tx.objectStore('invoice_sequence').get(deviceId))`, defaulting to `{ deviceId, invoiceSeq: 0,
   queueSeq: 0 }` when the row is absent.
3. `export async function takeNextInvoice(tx: IDBTransaction, deviceId: string, deviceCode:
   string): Promise<{ seq: number; number: string }>` — runs INSIDE THE CALLER'S readwrite
   transaction, which must include `'invoice_sequence'`; it never opens a transaction of its own,
   so a caller that aborts leaves the counter exactly where it was. Steps: `row = await
   readRow(tx, deviceId)`; `next = row.invoiceSeq + 1`; `number = formatInvoiceNumber(deviceCode,
   next)` — called BEFORE any write, so a `seq` above `999999` or a bad code rejects with nothing
   put; then `put({ ...row, invoiceSeq: next })` and resolve `{ seq: next, number }` on that
   request's `onsuccess`. A request error rejects with `request.error` and the transaction aborts
   on its own.
4. `export async function takeNextQueueSeq(tx: IDBTransaction, deviceId: string): Promise<number>`
   — same transaction discipline, but the counter is TABLET-WIDE: `rows = await valueOf(
   tx.objectStore('invoice_sequence').getAll())`; `next = 1 + max(0, …rows.map(r => r.queueSeq))`;
   `put({ ...thisDeviceRow, queueSeq: next })`; resolve `next`. Why: T-22's `sync_queue.seq` index
   is UNIQUE across the whole store, and a tablet that is revoked and registered again holds
   entries under both device ids — a per-device counter would hand device B a `seq` of `1` that
   device A's still-queued entry already owns, and every sale after re-registration would abort.
   The FIFO is therefore one order across devices, which is also what "send an older device's
   ops before the new device's" needs.
5. `export function adoptServerHint(deviceId: string, lastInvoiceSeq: number): Promise<number>`
   — its OWN readwrite transaction over `['invoice_sequence', 'sync_queue']`. Reject with a
   `TypeError` unless `Number.isSafeInteger(lastInvoiceSeq) && lastInvoiceSeq >= 0`. Read the
   row (default as above); read every `sync_queue` row for this device through the `deviceId`
   index and take `highestQueued = max(envelope.payload.invoiceSeq)` over the rows whose
   `envelope.kind` is `'sale.complete'` or `'sale.abandoned'` (0 when none); `result =
   max(row.invoiceSeq, lastInvoiceSeq, highestQueued)`; `put` only when `result >
   row.invoiceSeq`; resolve `result`. A hint LOWER than the counter never rewinds it: the counter
   is the truth, the server hint (T-28's `GET /api/pos/employees`, computed over
   `pos_sync_ops.invoice_seq` and `invoices`) only ever moves it forward after a device whose
   IndexedDB was lost. T-30 calls this once per successful employees fetch, before any sale.
6. `export function readSequence(deviceId: string): Promise<SequenceRow>` — a readonly read
   with the same default; the session screen and tests use it.
7. Every function that opens a transaction uses `withDb` from `store.ts` so the connection is
   closed afterwards; the two `take*` functions take the caller's `tx` and open nothing.

**Tests:** (`src/lib/pos/invoice-sequence.test.ts`; `import 'fake-indexeddb/auto'`, delete the
database in `beforeEach` as `store.test.ts` does; a local helper `inTx(stores, work)` that opens
`openPosDb()`, runs `work(tx)` in a readwrite transaction and resolves on `tx.oncomplete`)
- Three takes in three transactions on `('device-A', 'POS1')` → `seq` `1`, `2`, `3` and `number`
  `'POS1-000001'`, `'POS1-000002'`, `'POS1-000003'`; `readSequence('device-A')` is
  `{ deviceId: 'device-A', invoiceSeq: 3, queueSeq: 0 }`.
- Abort leaves the counter: inside one transaction `await takeNextInvoice(tx, 'device-A', 'POS1')`
  resolves `{ seq: 1, … }`, then `tx.abort()` → `readSequence('device-A').invoiceSeq` is `0`, and
  the next take in a fresh transaction is `1` again (gap-free: an aborted sale burns nothing).
- Queue seq is tablet-wide: `takeNextQueueSeq(tx, 'device-A')` twice → `1`, `2`; then
  `takeNextQueueSeq(tx, 'device-B')` → `3`; `readSequence('device-B').queueSeq` is `3` and
  `readSequence('device-A').queueSeq` is still `2`.
- `adoptServerHint('device-A', 5)` on a counter at `7` resolves `7` and the row still reads `7`.
- `adoptServerHint('device-A', 9)` on a counter at `7` with a `sync_queue` row `{ clientOpId:
  'op-x', deviceId: 'device-A', seq: 1, kind: 'sale.complete', envelope: { kind: 'sale.complete',
  payload: { invoiceSeq: 10 } }, state: 'pending', attempts: 0 }` resolves `10`; the next take is
  `11`, `'POS1-000011'`.
- A fresh device (no row) with `adoptServerHint('device-C', 41)` → the next take is `42`,
  `'POS1-000042'`.
- Seed `{ deviceId: 'device-A', invoiceSeq: 999999, queueSeq: 0 }`; a take rejects with the
  `RangeError` that `formatInvoiceNumber` throws for `1000000` (T-03 step 5 mandates a
  `RangeError`, never a plain `Error`): `await expect(take).rejects.toThrow(RangeError)`, and
  `readSequence('device-A').invoiceSeq` is still `999999` — nothing was put.
- `takeNextInvoice(tx, 'device-A', 'pos1')` (lowercase code): `await expect(take).rejects.toThrow(
  RangeError)` and the counter stays at `0`.
- `adoptServerHint('device-A', -1)` and `adoptServerHint('device-A', 1.5)` reject with `TypeError`.

**Done when:** `pnpm test:unit src/lib/pos/invoice-sequence.test.ts` passes, and `pnpm check` and
`pnpm lint` pass.

**Watch out:** the invoice number is taken ONLY inside the transaction that also writes the
completed sale and its queue entry (T-24's `completeSale`) — never from a screen "to show the next
number", never on its own: a number taken and not written is a gap, and spec 6 says gap-free.
Format before put: `formatInvoiceNumber` is the guard against a seventh digit, and it must run
before the counter moves. Inside a transaction, `await` only the transaction's own requests.

### T-24 — The local cart, `completeSale` in one IndexedDB transaction, `abandonSale`, the local session

**Needs:** T-10, T-11, T-23
**Files:**
- `src/lib/pos/orders.ts` — NEW
- `src/lib/pos/orders.test.ts` — NEW
- `src/lib/pos/session.ts` — NEW
- `src/lib/pos/session.test.ts` — NEW
- `src/lib/pos/queue.ts` — NEW (ONLY `enqueue(tx, entry)` and its test-facing type; T-25 EXTENDS
  this file with the flush. It is created here because `completeSale` must enqueue inside its own
  transaction and T-25 has not run yet)
**Spec:** 6 (a completed offline cash sale is a recorded fact; "Every operation carries a unique ID
generated on the device"; invoice numbers from the device sequence; card/mobile payments are not
treated as successful offline), 13 (order types dine-in and takeaway; "Adding items … are small,
ordinary saves. The full all-or-nothing database transaction runs at payment"), 14 (deleting a NEW
item needs no reason, no approval and no audit), 17 (one rounding rule in one function; "Each order
line stores the tax rate used"), 10 (opening cash, count, one business date per session)
**Invariants:** 1 (money is integer minor units in `bigint`; the ONLY arithmetic in this task is the
call into `src/lib/money`), 5 (fact; idempotency key; device sequence; card and mobile never
auto-completed offline), 7 (discount before tax; every line snapshots its own unit price AND tax
rate; one rounding rule), 9 (nothing gated is built: every line's discount is `0n`, no void of a
SENT line, no comp), 12 (a secure context for `crypto.randomUUID`; nothing in `localStorage`)

**Do:**
1. `src/lib/pos/queue.ts` — create it with ONE export for now:
   `export async function enqueue(tx: IDBTransaction, entry: QueueEntry): Promise<'added' |
   'duplicate'>`. Inside the CALLER's readwrite transaction (which must include `'sync_queue'`):
   `existing = await valueOf(store.getKey(entry.clientOpId))`; if present resolve `'duplicate'`
   without writing — a retry of the same operation is a NO-OP that keeps the first attempt's
   envelope; otherwise `store.add(entry)` — `add()`, NEVER `put()`, which would overwrite the
   first attempt and rewrite history — and resolve `'added'` on success. A `ConstraintError` that
   still reaches the `add` can only be the unique `seq` index; it propagates (reject; the
   transaction aborts), because a sale silently not queued is worse than a sale that fails
   loudly. Head comment: "T-25 adds the flush below. `enqueue` is written by T-24 and is not
   rewritten." Import `valueOf` and `type QueueEntry` from `'./store'`.
2. `src/lib/pos/orders.ts` — types, exported:
   ```ts
   export type CartModifier = { modifierId: string; modifierName: string; priceDeltaMinor: bigint };
   export type CartLine = {
   	lineId: string;             // crypto.randomUUID()
   	lineNo: number;             // 1-based, in add order
   	menuItemId: string;
   	itemName: string;           // snapshot: the name at add time
   	quantity: number;           // safe integer ≥ 1
   	unitPriceMinor: bigint;     // snapshot: the item's priceMinor at add time
   	taxRateBp: number;          // RESOLVED at add time: item.taxRateBp ?? snapshot.taxRateBp
   	discountMinor: 0n;          // pinned to zero in this plan (invariant 9; T-18 rejects any other)
   	modifiers: CartModifier[];
   };
   export type Cart = {
   	orderId: string;            // crypto.randomUUID(); becomes orders.id on the server
   	deviceId: string;
   	orderType: 'dine_in' | 'takeaway';
   	tableLabel: string | null;  // ≤ 32 characters; null for "waiting for a table" and takeaway
   	lines: CartLine[];
   	openedAt: string;           // ISO 8601 UTC
   };
   ```
   Import `type LocalMenu` from `'./store'`, `type OrderTotals`, `computeOrderTotals` from
   `'../money/order-totals'` (T-10), `changeDue` from `'../money/change'` (T-11), `minor`,
   `ROUNDING_RULE`, `type Minor` from `'../money'`, `type TaxMode` from `'../money/tax'`,
   `PAYMENT_METHODS`, `type SaleCompletePayload`, `type SaleAbandonedPayload`, `type OpEnvelope`
   from `'../sync-ops'` (T-03), `takeNextInvoice`, `takeNextQueueSeq` from
   `'./invoice-sequence'`, `enqueue` from `'./queue'`, and `openPosDb`, `withDb`, `valueOf`,
   `signalUnsyncedChange`, `type LocalOrder` from `'./store'`.
3. A private `secureId(): string` — if `typeof crypto === 'undefined' || typeof
   crypto.randomUUID !== 'function'` throw `new Error('This device cannot record a sale securely.
   Open the till over https.')` (the PIN screen's rule, `src/routes/(pos)/pos/pin/+page.svelte`:
   never a `Math.random()` stand-in, which would let a retry become a second permanent record);
   otherwise `crypto.randomUUID()`.
4. Pure cart functions (no IndexedDB; each returns a NEW cart, never mutates):
   - `newCart(deviceId: string, orderType: Cart['orderType'], tableLabel: string | null = null,
     now = new Date()): Cart` — `orderId: secureId()`, `lines: []`, `openedAt: now.toISOString()`;
     `tableLabel` is trimmed; an empty result is stored as `null` (never `''` — T-18's schema is
     `z.string().min(1).max(32).nullable()`, so `''` on the wire is a HARD `invalid_payload`); a
     trimmed label longer than 32 characters throws `Error('table label is at most 32 characters')`.
   - `addLine(cart, item: LocalMenu['items'][number], restaurantTaxRateBp: number | null,
     modifiers: LocalMenu['modifierGroups'][number]['modifiers'] = [], quantity = 1): Cart` —
     `taxRateBp = item.taxRateBp ?? restaurantTaxRateBp`; when BOTH are `null` throw
     `new Error('No tax rate is configured. The owner sets one on /settings.')` (the line's rate
     is NOT NULL on the server, R5, and nothing here may invent one); `unitPriceMinor:
     item.priceMinor` (already a `bigint` from `readMenu`); `modifiers` mapped to
     `{ modifierId: m.id, modifierName: m.name, priceDeltaMinor: m.priceDeltaMinor }`; `lineNo =
     cart.lines.length + 1`; `discountMinor: 0n`; `quantity` must be a safe integer ≥ 1.
   - `removeLine(cart, lineId): Cart` — drops the line and renumbers `lineNo` 1..n. No reason, no
     approval, no audit: the line is NEW, never SENT (spec 14, invariant 9).
   - `changeQuantity(cart, lineId, quantity): Cart` — same validation as `addLine`.
5. Cart persistence (`orders` store, state `'cart'`; assumption 9: ONE active cart per device):
   - `saveCart(cart: Cart): Promise<void>` — `put({ id: cart.orderId, deviceId: cart.deviceId,
     state: 'cart', cart } satisfies LocalOrder<Cart>)`; a `bigint` inside `cart` is fine in
     IndexedDB (structured clone supports it) — it is the ENVELOPE that may not carry one.
   - `readCart(deviceId): Promise<Cart | null>` — `index('status').getAll('cart')`, filter
     `deviceId`, return the one with the latest `openedAt` (defensive: there should be one).
   - `clearCart(deviceId): Promise<void>` — delete every `'cart'` row of the device. A cleared
     cart leaves no trace (spec 14: nothing was sent, nothing was paid).
6. `export function cartTotals(cart: Cart, taxMode: TaxMode): OrderTotals` — THE ONLY money
   arithmetic in `src/lib/pos`, and it is a call:
   `computeOrderTotals({ taxMode, lines: cart.lines.map(toTotalsLine) }, ROUNDING_RULE)` with
   `toTotalsLine = (l) => ({ unitPriceMinor: minor(l.unitPriceMinor), quantity:
   BigInt(l.quantity), modifierDeltasMinor: l.modifiers.map((m) => minor(m.priceDeltaMinor)),
   taxRateBp: l.taxRateBp, discountMinor: minor(0n) })`. T-33 renders `subtotal`, `tax` and
   `total` from the returned `OrderTotals` and never computes a number of its own.
7. `export async function completeSale(args: CompleteSaleArgs, abortForTest = false):
   Promise<CompleteSaleResult>` with
   `CompleteSaleArgs = { cart: Cart; payment: { method: 'cash' | 'card' | 'mobile'; tenderedMinor:
   bigint | null }; employeeId: string; deviceId: string; deviceCode: string; posSessionId: string;
   taxMode: TaxMode; currencyCode: string; menuVersion: number; now: Date }` and
   `CompleteSaleResult = { orderId: string; invoiceNumber: string; changeMinor: bigint | null;
   clientOpId: string }`:
   1. Validate BEFORE anything is opened — throw a plain `Error` naming the field: `cart.lines`
      non-empty; every `quantity` a safe integer ≥ 1; every `unitPriceMinor ≥ 0n` and
      `priceDeltaMinor` a `bigint`; every `discountMinor === 0n`; `method` in
      `PAYMENT_METHODS`; cash ⇒ `tenderedMinor` is a `bigint`, card/mobile ⇒ `tenderedMinor ===
      null`; `cart.deviceId === deviceId`. These mirror T-18's validator so the till never
      produces a payload the server hard-fails.
   2. `totals = cartTotals(cart, taxMode)`; `changeMinor = method === 'cash' ? changeDue(
      minor(tenderedMinor), totals.total) : null` — `changeDue` THROWS when tendered < total, and
      that throw happens here, before the transaction, so nothing is written.
   3. `clientOpId = secureId()`, `paymentId = secureId()`, `occurredAt = now.toISOString()`.
   4. Build the payload with every amount as a decimal string (`.toString()` on the `bigint`):
      `{ orderId: cart.orderId, posSessionId, orderType, tableLabel, taxMode, currencyCode,
      menuVersion, invoiceSeq: 0, invoiceNumber: '', openedAt: cart.openedAt, lines: [{ lineId,
      lineNo, menuItemId, itemName, quantity, unitPriceMinor: String, taxRateBp, discountMinor:
      '0', modifiers: [{ modifierId, modifierName, priceDeltaMinor: String }] }], totals: {
      subtotalMinor: totals.subtotal.toString(), discountMinor: totals.discount.toString(),
      taxMinor: totals.tax.toString(), totalMinor: totals.total.toString() }, payments: [{
      paymentId, method, amountMinor: totals.total.toString(), tenderedMinor: tendered?.toString()
      ?? null, changeMinor: changeMinor?.toString() ?? null }] } satisfies SaleCompletePayload`.
      The invoice fields are filled in step 5, inside the transaction.
   5. ONE readwrite transaction over `['orders', 'sync_queue', 'invoice_sequence']`, in this
      order, awaiting nothing but its own requests: `invoice = await takeNextInvoice(tx,
      deviceId, deviceCode)`; `seq = await takeNextQueueSeq(tx, deviceId)`; set
      `payload.invoiceSeq = invoice.seq`, `payload.invoiceNumber = invoice.number`;
      `tx.objectStore('orders').put({ id: cart.orderId, deviceId, employeeId, clientOpId, state:
      'completed', cart, invoiceSeq: invoice.seq, invoiceNumber: invoice.number, completedAt:
      occurredAt } satisfies LocalOrder<Cart>)`; `await enqueue(tx, { clientOpId, deviceId, seq,
      kind: 'sale.complete', envelope: { kind: 'sale.complete', clientOpId, deviceId, employeeId,
      occurredAt, seq, payload }, state: 'pending', attempts: 0 })`; `if (abortForTest)
      tx.abort()`. Resolve ONLY in `tx.oncomplete` with `{ orderId: cart.orderId, invoiceNumber:
      invoice.number, changeMinor, clientOpId }`; reject in `tx.onabort`/`tx.onerror`; wrap the
      body in `try/catch` and on a throw `tx.abort()` then reject (the pattern of `replaceMenu` in
      `store.ts`). The order row, the queue entry and the two counter increments therefore land
      together or not at all — a sale with a number but no queue entry, or a queue entry for a
      sale that was never stored, cannot exist.
   6. After resolve: `signalUnsyncedChange()` (a pending entry was added).
   Card and mobile go through the SAME function: the entry is queued, and the till completes the
   tender only when the flush reports 200 (T-34 reads the entry's state; assumption 4: the keys
   are disabled offline). Nothing here blocks a cash sale behind a pending card op.
8. `export async function abandonSale(orderId: string, reason: 'rejected' | 'cancelled', now =
   new Date()): Promise<{ clientOpId: string }>` — `const clientOpId = secureId();` BEFORE the
   transaction opens (it is the one key used both on the entry and inside its envelope below);
   then one readwrite transaction over `['orders',
   'sync_queue', 'invoice_sequence']`: `order = await valueOf(orders.get(orderId))`; reject unless
   `order.state === 'completed'` with `invoiceSeq`, `invoiceNumber`, `employeeId` and
   `clientOpId` set; `put({ ...order, state: 'abandoned' })` (the invoice fields STAY on the row:
   the number is burned, and the server must be told which one); if the order's own entry
   (`sync_queue.get(order.clientOpId)`) is still `'pending'`, `put({ ...entry, state: 'done',
   lastError: 'cancelled_before_send' })` so a cancelled card sale is never sent — an entry already
   `'sending'` or `'done'` is left alone (the server's answer, when it comes, is applied normally,
   and the server reconciles an abandon against a sale it recorded, T-21); `seq = await
   takeNextQueueSeq(tx, orderId's deviceId)`; `enqueue(tx, { clientOpId, deviceId:
   order.deviceId, seq, kind: 'sale.abandoned', envelope: { kind: 'sale.abandoned', clientOpId,
   deviceId: order.deviceId, employeeId: order.employeeId, occurredAt: now.toISOString(), seq,
   payload: { orderId, invoiceSeq: order.invoiceSeq, invoiceNumber: order.invoiceNumber, reason }
   satisfies SaleAbandonedPayload }, state: 'pending', attempts: 0 })` — the SAME `clientOpId`
   variable in both places, never a second `secureId()` inline. Resolve on `oncomplete` with
   `{ clientOpId }`, then `signalUnsyncedChange()`. The one `secureId()` call happens BEFORE the
   transaction opens.
9. `src/lib/pos/session.ts` — imports as above plus `type SessionOpenPayload`,
   `type SessionClosePayload` from `'../sync-ops'` and `type LocalSession` from `'./store'`:
   - `openLocalSession({ deviceId, employeeId, openingCashMinor, now }: { deviceId: string;
     employeeId: string; openingCashMinor: bigint; now: Date }): Promise<{ posSessionId: string;
     clientOpId: string }>` — `openingCashMinor ≥ 0n` else throw; `posSessionId = secureId()`,
     `clientOpId = secureId()` before the transaction; ONE readwrite transaction over
     `['session', 'sync_queue', 'invoice_sequence']`: read the device's row — reject with
     `Error('session_already_open')` when its state is `'opening'`, `'open'` or `'closing'` (a
     `'closed'` row or no row is fine); `put({ deviceId, posSessionId, employeeId,
     openingCashMinor: openingCashMinor.toString(), openedAt: now.toISOString(), state:
     'opening' } satisfies LocalSession)`; `seq = await takeNextQueueSeq(tx, deviceId)`;
     `enqueue(tx, { clientOpId, deviceId, seq, kind: 'session.open', envelope: { kind:
     'session.open', clientOpId, deviceId, employeeId, occurredAt: now.toISOString(), seq, payload:
     { posSessionId, openingCashMinor: openingCashMinor.toString() } satisfies SessionOpenPayload
     }, state: 'pending', attempts: 0 })`; resolve on `oncomplete`; `signalUnsyncedChange()`.
   - `markSessionOpened(deviceId: string, result: { posSessionId: string; businessDate: string |
     null }): Promise<{ previousPosSessionId: string }>` — `put({ ...row, state: 'open',
     posSessionId: result.posSessionId, businessDate: result.businessDate ?? row.businessDate,
     lastError: undefined })`. The server may have ATTACHED the open to a session it already held
     for this device and answered THAT id (R6); the till adopts it, and returns the id it held
     before so T-25 can rewrite still-pending ops that named the old one.
   - `closeLocalSession({ deviceId, employeeId, countedCashMinor, now }: { …; countedCashMinor:
     bigint; now: Date }): Promise<{ clientOpId: string }>` — `countedCashMinor ≥ 0n`; the row must
     be `'open'` (reject `Error('no_open_session')` otherwise); `put({ ...row, state: 'closing',
     countedCashMinor: countedCashMinor.toString() })`; enqueue `session.close` with payload
     `{ posSessionId: row.posSessionId, countedCashMinor: countedCashMinor.toString() } satisfies
     SessionClosePayload`, one transaction as above. Spec 10's "requires a connection and an empty
     sync queue" is enforced by the SCREEN before it calls this (T-32 reads `countUnsynced()` and
     `navigator.onLine`); the op is still queued so that a connection lost mid-close retries with
     the same key instead of closing twice.
   - `markSessionClosed(deviceId: string, result: { expectedCashMinor: string | null;
     differenceMinor: string | null }, now = new Date()): Promise<void>` — `put({ ...row, state:
     'closed', closedAt: now.toISOString(), expectedCashMinor: result.expectedCashMinor ??
     undefined, differenceMinor: result.differenceMinor ?? undefined, lastError: undefined })`.
   - `readLocalSession(deviceId: string): Promise<LocalSession | null>` — returns the device's
     row ONLY when its `state` is `'opening'`, `'open'` or `'closing'`, else `null`: a `'closed'`
     row is not an open session, and T-30, T-31, T-32, T-33 and T-38 all treat a non-null answer
     as "this device is in a session".
   - `export function readSessionRow(deviceId: string): Promise<LocalSession | null>` — returns
     the device's row in ANY state (`null` only when there is no row). `adoptServerSession`,
     `markSessionClosed` and the tests read through this one; screens never do.
   - `adoptServerSession(deviceId: string, serverOpen: { posSessionId: string; employeeId:
     string; openingCashMinor: string; openedAt: string; businessDate: string | null } | null):
     Promise<'adopted' | 'closed' | 'unchanged'>` — for the `openSession` field of T-28's `GET
     /api/pos/employees`, whose wire shape is `{ id, openedByUserId, businessDate,
     openingCashMinor, openedAt } | null`. This module keeps its OWN input shape and is not
     coupled to the wire names: the mapping `id → posSessionId`, `openedByUserId → employeeId`
     (the other three names are identical) is done at the call site by `08-pos-screens.md` T-30
     step 8, which already contains that literal — a session running T-30 copies it, never
     passes `body.openSession` straight through (`pnpm check` would fail). When `serverOpen` is
     not null and the local row is absent, `'closed'`, or `'open'` with a different
     `posSessionId`: `put` the server's fields as state `'open'` → `'adopted'`. When the local
     row is `'opening'` or `'closing'` (an op is in flight): `'unchanged'`. **The null rule, in
     one line for T-30 to copy:** "`null` closes an `'open'` local row ONLY when no `sync_queue`
     entry of this device is `'pending'` or `'sending'`; an offline-opened session always has a
     pending `session.open`, so `null` never clears it." When that condition holds:
     `put({ ...row, state: 'closed' })` → `'closed'` (the server is the truth for sessions once
     the queue is empty; R6 lets a session be closed from another live device). Otherwise
     `'unchanged'`.
10. Every function that opens its own transaction uses `withDb`; every `secureId()` and every
    validation runs before the transaction opens; no `fetch` anywhere in these two files.

**Tests:** (`orders.test.ts` and `session.test.ts`; fake-indexeddb; `deleteDatabase()` in
`beforeEach`; a fixed `now = new Date('2026-09-28T10:00:00.000Z')`; menu items built as
`LocalMenu['items'][number]` literals with `priceMinor: 850n`)
- MANDATORY (spec 29 — money arithmetic and rounding; tax in both modes — here only as the
  proof that the till delegates): a cart with line 1 `unitPriceMinor 850n`, `quantity 2`, one
  modifier `+50n`, and line 2 `999n × 1`, all at `taxRateBp 825`, `taxMode 'exclusive'` →
  `cartTotals` returns `subtotal 2799n`, `discount 0n`, `tax 231n`, `total 3030n` (Σgross =
  1948.5 + 1081.4175 = 3029.9175 → 3030; Σtax = 230.9175 → 231; net = 3030 − 231 = 2799), and
  `toEqual(computeOrderTotals(sameLines, ROUNDING_RULE))` — the till's number IS the money
  module's number. The same cart at `'inclusive'` → `total 2799n`, `tax 213n` (2799 × 825 / 10825
  = 213.33… → 213), `subtotal 2586n`.
- `completeSale` is atomic: cash, `tenderedMinor 5000n` → resolves `{ invoiceNumber:
  'POS1-000001', changeMinor: 1970n, … }`; the `orders` row is `state 'completed'` with
  `invoiceSeq 1`, `employeeId`, `clientOpId`; exactly one `sync_queue` row, `kind 'sale.complete'`,
  `seq 1`, `state 'pending'`; `readSequence('device-A')` is `{ invoiceSeq: 1, queueSeq: 1 }`.
  With `abortForTest = true` on a fresh database: it rejects, there is NO `orders` row in state
  `'completed'` (the `'cart'` row saved before is untouched), NO `sync_queue` row, and
  `readSequence` is `{ invoiceSeq: 0, queueSeq: 0 }` — none of the three.
- Two sales → `invoiceSeq` `1`, `2`, numbers `'POS1-000001'`, `'POS1-000002'`, queue `seq` `1`,
  `2`, distinct `clientOpId`s.
- No bigint on the wire: for the stored entry, `JSON.stringify(entry.envelope)` does not throw;
  `typeof payload.totals.totalMinor === 'string'` and equals `'3030'`;
  `payload.lines[0].unitPriceMinor === '850'`, `payload.lines[0].modifiers[0].priceDeltaMinor ===
  '50'`, `payload.lines[0].discountMinor === '0'`; `payload.payments[0]` equals `{ paymentId:
  <uuid>, method: 'cash', amountMinor: '3030', tenderedMinor: '5000', changeMinor: '1970' }`.
- Card: `{ method: 'card', tenderedMinor: null }` → `changeMinor null`, `payments[0].tenderedMinor
  === null`, `changeMinor === null`, and the entry is `'pending'` like any other (never blocked).
- Cash short: `tenderedMinor 3000n` on a `3030n` total → rejects (from `changeDue`), no `orders`
  row in `'completed'`, no `sync_queue` row, counters unchanged.
- Validation: a cart with a line `quantity 0`, and a card sale with `tenderedMinor 100n`, each
  reject before writing anything.
- `addLine` resolves the rate: item `taxRateBp null` + restaurant `825` → `825`; item `500` +
  restaurant `825` → `500`; both `null` → throws; `removeLine` renumbers `lineNo` to `[1, 2]` after
  removing the middle of three.
- `abandonSale(orderId, 'rejected')` after a card sale: the `orders` row is `'abandoned'` and
  still carries `invoiceNumber 'POS1-000001'`; a new `sync_queue` row `kind 'sale.abandoned'`,
  `seq 2`, `payload` `{ orderId, invoiceSeq: 1, invoiceNumber: 'POS1-000001', reason: 'rejected'
  }`, `envelope.employeeId` equal to the sale's; the sale's own entry (still `'pending'` in this
  test) is now `'done'` with `lastError 'cancelled_before_send'`; for the abandon entry
  `entry.clientOpId === entry.envelope.clientOpId` and equals the `clientOpId` `abandonSale`
  resolved with; `abandonSale` of a `'cart'` order rejects.
- `newCart(d, 'dine_in', '   ')` → `tableLabel null`; `newCart(d, 'dine_in', ' T 12 ')` →
  `'T 12'`; a 33-character label throws `'table label is at most 32 characters'`; a 32-character
  label is stored as given.
- Session: `openLocalSession` → row `'opening'`, `openingCashMinor '50000'`, one entry
  `kind 'session.open'`, `seq 1`, `payload.openingCashMinor '50000'`; a second open rejects
  `'session_already_open'`; `markSessionOpened(deviceId, { posSessionId: 'srv-1', businessDate:
  '2026-09-28' })` → `'open'`, `posSessionId 'srv-1'`, returns `{ previousPosSessionId: <local
  uuid> }`; `closeLocalSession` with `countedCashMinor 123450n` → `'closing'`, entry `kind
  'session.close'`, `seq 2`, `payload.countedCashMinor '123450'`; `markSessionClosed(deviceId,
  { expectedCashMinor: '123000', differenceMinor: '450' })` → `'closed'` with both strings;
  after `markSessionClosed`, `readLocalSession` returns `null` and `readSessionRow` returns the
  closed row (`state 'closed'`, `expectedCashMinor '123000'`, `differenceMinor '450'`);
  `adoptServerSession(deviceId, { posSessionId: 'srv-9', employeeId: 'e-1', openingCashMinor:
  '50000', openedAt: '2026-09-28T08:00:00.000Z', businessDate: '2026-09-28' })` on that
  `'closed'` row (read through `readSessionRow` before adoption to assert it is `'closed'`) →
  `'adopted'` and `readLocalSession` is `'open'` with `posSessionId 'srv-9'`, `employeeId
  'e-1'`, `businessDate '2026-09-28'`; `adoptServerSession(deviceId, null)` on an `'open'` row
  with an empty queue → `'closed'`; the same with a `'pending'` entry of this device present →
  `'unchanged'` and the row still `'open'` (the null rule above); on an `'opening'` row a
  non-null `serverOpen` → `'unchanged'`.
- `countUnsynced()` after one sale + one session open is `2`, and `onUnsyncedChange` fired for
  each commit.

**Done when:** `pnpm test:unit src/lib/pos` passes (the new `orders.test.ts` and `session.test.ts`
plus every earlier file), and `pnpm check` and `pnpm lint` pass — including
`no-restricted-imports`, which fails the build if either file imports `lib/server`.

**Watch out:** every `await` of a network call, a timer, a PIN hash or ANOTHER transaction happens
BEFORE the IndexedDB transaction opens, never inside it — the `syncMenu` comment in `store.ts`
explains why (the transaction commits early and half a sale lands). `orders.ts` imports `enqueue`
from `queue.ts`, and T-25 makes `queue.ts` import `abandonSale` back: that cycle is safe ONLY while
every cross-import is a `function` declaration used at call time — no top-level code in either
file may call across it, and no `export const f = () => …` may replace a `function`. `bigint`
inside `cart` is fine in IndexedDB; a `bigint` in `envelope` throws in `JSON.stringify` in T-25.
Assumption 12: cart edits are not audited and need no reason — do not add an audit call here.

### T-25 — The flush: FIFO, backoff, outcome handling, parking, the offline-login flush, pruning

**Needs:** T-24
**Files:**
- `src/lib/pos/queue.ts` — EXTEND (created by T-24 with `enqueue`; add everything below AFTER
  `enqueue`; do not rewrite `enqueue`)
- `src/lib/pos/queue.test.ts` — NEW
- `src/lib/pos/store.ts` — EDIT (beside `recordOfflineLogin`: `markOfflineLoginSynced` and
  `markOfflineLoginParked`; the `OfflineLogin` type's `synced` field; `countUnsynced` and
  `countParked` from T-22. `signalUnsyncedChange` exists since T-22 — if it is absent, add it
  there now, exactly as T-22 step 7 says)
**Spec:** 6 ("Every operation carries a unique ID generated on the device, so the server ignores
duplicates when a sync is retried"; "Offline logins are recorded locally and synced to the audit
log"; "The number of unsynced operations is always visible"; "Online card/mobile payments should
not automatically be treated as successful offline"), 10 (session close requires a connection;
reconciliation runs on the server), 13 ("the same transaction runs on the server when the sale
syncs"), 29 ("Offline sync: retries never create duplicates")
**Invariants:** 5 (a fact; a retry is a no-op because it carries the SAME `clientOpId`; a rejected
card/mobile sale becomes an abandon that carries its burned number), 10 (offline logins are
recorded locally and synced later, one audit row each), 12 (a device 403 means unknown or revoked:
forget the bundle, keep the unsynced work), 11 (the business date comes back from the server with
the session open and is stored, never computed on the till)

**Do:**
1. The wire (00-overview.md, "HTTP answers of POST /api/pos/sync", T-27): one envelope per
   request — `fetchFn('/api/pos/sync', { method: 'POST', credentials: 'same-origin', headers: {
   'content-type': 'application/json' }, body: JSON.stringify(entry.envelope) })`. Answers: `200`
   with a `SyncResult` whose `status` is `accepted`, `recorded_flagged`, `unrecorded` or
   `replayed`; `403 { error: 'not_permitted' }` only for a card/mobile `sale.complete` or a
   `session.close`; `409 { error: 'foreign_device' }`; `409 { error:
   'session_has_unrecorded_ops', count }`; `400 { error: 'invalid_request' }`; `422 { error:
   'rejected', flag }` only for a card/mobile `sale.complete`; `415` for a non-JSON body; and a
   PLAIN `403` (no JSON body, no `error` field, or `error: 'Forbidden'`) from `requireDevice`
   for no, unknown or revoked device. Parse the body with `await response.json()` inside a
   `try/catch`; a body that does not parse is treated as no body.
2. Module state in `queue.ts`: `let running: Promise<FlushSummary> | null = null` (single-flight);
   `let consecutiveNetworkFailures = 0`; `let lastSkew: number | null = null`; `const events =
   new EventTarget()`; `let scheduledRetry: (() => void) | null = null` (the cancel function the
   `schedule` option returns).
3. `export type FlushOptions = { now?: () => number; schedule?: (delayMs: number, run: () => void)
   => () => void }` — defaults `Date.now` and a `setTimeout` wrapper returning its `clearTimeout`;
   `export type FlushSummary = { sent: number; outcome: 'drained' | 'offline' | 'network' |
   'stopped' }` — there is NO `'revoked'` outcome: a revoked run never resolves, it THROWS
   `DeviceRevoked` (step 9); `export class DeviceRevoked extends Error {}`;
   `export type FlushEvent = { type: 'done'; clientOpId: string; kind: OpKind; status:
   SyncResult['status']; body: SyncResult } | { type: 'rejected'; clientOpId: string; kind:
   OpKind; http: 403 | 422; error: string; flag?: string } | { type: 'parked'; clientOpId: string;
   kind: OpKind; error: string } | { type: 'stopped'; reason: 'network' | 'not_permitted' |
   'session_has_unrecorded_ops'; clientOpId?: string; count?: number; retryInMs?: number } |
   { type: 'revoked' } | { type: 'skew'; skewMs: number }`.
4. `export function flush(fetchFn: typeof fetch = fetch, opts: FlushOptions = {}):
   Promise<FlushSummary>` — if `running` is set, return it (concurrent callers await the same run);
   if `typeof navigator !== 'undefined' && navigator.onLine === false`, resolve `{ sent: 0,
   outcome: 'offline' }` without a timer (T-30 re-runs on the `online` event); otherwise set
   `running` to the run and clear it in `finally`. Cancel any `scheduledRetry` at the start of a
   run.
5. Run start: every `sync_queue` entry in state `'sending'` goes back to `'pending'` (one
   transaction) — a page that died mid-send; re-sending the SAME `clientOpId` replays on the
   server as a no-op, which is the whole point of the key.
6. Step A — the offline logins, BEFORE any sale (an audit row of the sign-in precedes the sales it
   made): every `offline_logins` row with `synced === false` and no `parked` flag, ascending
   `occurredAt`, becomes the envelope `{ kind: 'pin.login', clientOpId: row.clientOpId, deviceId:
   row.deviceId, employeeId: row.employeeId, occurredAt: row.occurredAt, seq: 0, payload: {
   outcome: row.outcome } }` — sent under the device it is STAMPED with, never the device the
   tablet is bound to now — through the same POST. `200` with any `status` (`replayed` included)
   → `markOfflineLoginSynced(row.clientOpId)`, `signalUnsyncedChange()`, count as a success.
   `409`, `400` or `415` → `markOfflineLoginParked(row.clientOpId)`, event `'parked'`, continue
   with the next row. Plain `403` → step 9's revoked path. A `403 not_permitted` or `422` is
   outside the contract for `pin.login` (the server needs no key for it, R9) → park it. A network
   error or a `5xx` → step 10's backoff path (stop the run).
7. Step B — the queue: loop: read the LOWEST-`seq` entry in state `'pending'` (walk the `seq`
   index with a cursor and skip other states; re-query every iteration, so a `sale.abandoned` that
   step 8 enqueues mid-run is sent in the same run, after everything already ahead of it); none →
   the run is `'drained'`. Mark it `'sending'` (own transaction), POST it, then apply exactly one
   of the outcomes in step 8 in its own transaction, then `signalUnsyncedChange()`. Never send
   two entries concurrently: a sale references its session, and an abandon references its sale.
8. Outcomes, by HTTP status and `kind`:
   - `200` (status `accepted` | `recorded_flagged` | `unrecorded` | `replayed`) → entry `state
     'done'`, `lastResult = body`, `lastError` cleared; event `'done'`; then by kind:
     `sale.complete` → the `orders` row gets `syncedAt = new Date(now()).toISOString()` and
     `syncStatus` = the status, except `replayed` keeps an existing `syncStatus` and otherwise
     writes `'accepted'`; `sale.abandoned` → the `orders` row gets `syncedAt`; `session.open` →
     `markSessionOpened(deviceId, { posSessionId: body.posSessionId ?? payload.posSessionId,
     businessDate: body.businessDate ?? null })`, and when the returned `previousPosSessionId`
     differs from the adopted id, rewrite `payload.posSessionId` from the old id to the new one on
     every entry of the same device still in state `'pending'` (`sale.complete` and
     `session.close`), in the same transaction as their read — the server attached the open to a
     session it already held (R6) and the sales queued behind it must name that session, or T-21
     stores them `unrecorded` with `unknown_session`; `session.close` → `markSessionClosed(
     deviceId, { expectedCashMinor: body.expectedCashMinor ?? null, differenceMinor:
     body.differenceMinor ?? null })`. `unrecorded` still ADVANCES the queue for every kind: the
     fact is now stored server-side for owner review (`/reports/flagged`, T-37), and the till has
     nothing more to send.
   - `403` with JSON `error: 'not_permitted'`: for `sale.complete` (by contract only card/mobile
     reach this; a card/mobile op is never completed offline and never auto-completed by the
     till: assumption 4 of 00-overview.md) → `orders` row `syncStatus 'rejected'`, entry `'done'`
     with `lastError 'not_permitted'`, event `'rejected'` with `http 403`, `error
     'not_permitted'`, then `await abandonSale(orderId, 'rejected')` (which enqueues
     `sale.abandoned` with the burned number; the loop sends it in this run); for `session.close`
     → the entry STAYS `'pending'`, `lastError 'not_permitted'`, the `session` row gets `lastError
     'not_permitted'`, event `'rejected'` with `http 403`, `error 'not_permitted'` AND event
     `'stopped'` with reason `'not_permitted'`, and the run ends `'stopped'` — the recovery is
     administrative (the owner grants `pos.payment` to the role; the next flush retries the SAME
     op and it succeeds); for any other kind → park (defensive: the contract never answers it).
   - `422` `error: 'rejected'` → for `sale.complete`: the same path as the `403 not_permitted`
     sale (`lastError` = `'rejected:' + flag`; event `'rejected'` with `http 422`, `error
     'rejected'`, `flag` = the body's flag; then `abandonSale` as above); any other kind → park.
   - `409` `error: 'foreign_device'` → entry `'parked'`, `lastError 'foreign_device'`, event
     `'parked'`, continue with the next entry. The op's `deviceId` belongs to another restaurant;
     the owner sorts it out from the dashboard, and the till shows `countParked()` as permanent
     chrome (T-30). Nothing is discarded.
   - `409` `error: 'session_has_unrecorded_ops'` (a `session.close`) → entry stays `'pending'`,
     `lastError = 'session_has_unrecorded_ops:' + body.count`, the `session` row's `lastError`
     likewise, event `'stopped'` with `count`, run ends `'stopped'`. T-32 shows "N sales need the
     owner's review before this session can close".
   - `400` or `415` → `'parked'` with `lastError 'invalid_request'` (a client bug: the envelope
     is malformed; parking keeps it for inspection), continue.
   - Plain `403` → step 9.
   - Network error (`fetchFn` rejects), `5xx`, or any status not listed → step 10.
9. Revoked: `await forgetDevice()` (the bundle goes: employees, settings, menu; the queue, the
   orders, the counters, the session and the offline logins STAY — invariant 5), the entry goes
   back to `'pending'`, event `'revoked'`, the run ends by THROWING `DeviceRevoked` (callers that
   `await flush()` must catch it and navigate to `/pos/register`, T-30).
10. Backoff: the entry goes back to `'pending'` with `attempts + 1` persisted (for a login,
    nothing is persisted); `consecutiveNetworkFailures += 1`; `delay = Math.min(60_000, 1_000 ×
    2 ** consecutiveNetworkFailures)` (2 s, 4 s, 8 s … 60 s); `scheduledRetry = schedule(delay,
    () => void flush(fetchFn, opts).catch(() => {}))`; event `'stopped'` with reason
    `'network'`, `clientOpId`, `retryInMs: delay`; the run ends `'network'`. The retry sends the
    SAME entry with the SAME `clientOpId` — nothing is regenerated. Any successful response
    (any status the server sent) resets `consecutiveNetworkFailures` to `0`.
11. Clock skew: on every `200`, read `response.headers.get('date')`; when present and
    `Date.parse` gives a number, `skewMs = Date.parse(header) − now()`; store it in `lastSkew`
    and emit `'skew'`. Export `lastSkewMs(): number | null` and `onSkew(listener: (skewMs:
    number) => void): () => void` (sugar over `onFlushEvent` for T-30's chrome, which warns above
    5 minutes either way).
12. After a run in which at least one entry or login succeeded: `await pruneCompletedOrders(30,
    now())` (T-22) (assumption 13 of 00-overview.md: prune completed, synced orders after 30
    days). Never before a run and never on a run that sent nothing.
13. Events and counts: `export function onFlushEvent(listener: (event: FlushEvent) => void): ()
    => void` (an `EventTarget` `CustomEvent('flush', { detail })` underneath; returns the
    unsubscribe); `export const onFlushResult = onFlushEvent` — 00-overview.md names the listener
    `onFlushResult` and `08-pos-screens.md` may use either spelling; `export function
    parkedCount(): Promise<number>` returning `countParked()` from `store.ts`.
14. `store.ts`: widen `OfflineLogin.synced` from the literal `false` to `boolean` and add
    `parked?: true`; add `export function markOfflineLoginSynced(clientOpId: string):
    Promise<void>` (`get` then `put({ ...row, synced: true })` in one transaction; every other
    field, `occurredAt` above all, is kept; a missing row resolves without writing) and
    `markOfflineLoginParked(clientOpId)` (`put({ ...row, parked: true })`, `synced` untouched);
    `countUnsynced` skips rows with `parked === true`; `countParked` adds them. Update the
    closing comment of `store.ts` ("NO SYNC QUEUE IS BUILT HERE…"): the flush now lives in
    `queue.ts`, and this file only stores.

**Tests:** (`src/lib/pos/queue.test.ts`; fake-indexeddb; a `mockFetch` that records every parsed
request body in order and answers from a scripted list — `new Response(JSON.stringify(body), {
status, headers: { 'content-type': 'application/json', date: dateHeader } })`, or `throw new
TypeError('Failed to fetch')` for a network error; a `schedule` stub that records `delayMs` and
keeps the callback for the test to invoke; `now = () => Date.parse('2026-09-28T10:00:00Z')`;
sales created through T-24's `completeSale` with `deviceCode 'POS1'`)
- MANDATORY (spec 29 — offline sync: retries never create duplicates, client side): one cash sale;
  fetch throws on the first call and answers `200 { clientOpId, status: 'accepted' }` on the
  second → the first run resolves `{ outcome: 'network' }`, the stub recorded `delayMs 2000`
  (`1000 × 2¹`) and the entry is `'pending'` with `attempts 1`; invoking the stored callback runs
  the second flush → the two recorded bodies have the SAME `clientOpId` and the SAME
  `invoiceNumber 'POS1-000001'`; exactly ONE `sync_queue` row exists, `'done'`; the `orders` row
  has `syncStatus 'accepted'` and a `syncedAt`.
- MANDATORY (spec 29 — offline sync): entries are sent in `seq` order and a stopped run resumes
  at the same entry: three sales (seq 1, 2, 3); answers `200`, network error → bodies `[seq 1,
  seq 2]`, entry 2 `'pending'`, entry 3 `'pending'` and never sent; the retry run → bodies `[seq
  2, seq 3]` with entry 2's `clientOpId` unchanged.
- An offline login is sent before any sale: one `recordOfflineLogin` row (`outcome 'success'`,
  `deviceId 'device-OLD'`, `occurredAt` earlier) and one sale on `device-A`; all `200` → bodies
  `[0].kind === 'pin.login'` with `clientOpId` = the row's, `deviceId 'device-OLD'`, `seq 0`,
  `payload.outcome 'success'`; then the sale; the row is `synced: true`; `countUnsynced()` is
  `0`.
- Parking: sale A answered `409 { error: 'foreign_device' }`, sale B `200 accepted` → A
  `'parked'`, B `'done'`, bodies include both, `parkedCount()` is `1`, `countUnsynced()` is `0`,
  one `'parked'` event.
- Plain `403` (`new Response('Forbidden', { status: 403 })`) after `bindDevice('device-A')` and
  `cacheEmployees([…])` → the run REJECTS with `DeviceRevoked`; `readBoundDeviceId()` is `null`
  and `readCachedEmployees()` is `[]` (forgetDevice ran); the entry is `'pending'`; no second POST
  was made; `countUnsynced()` is still `1`.
- A card sale answered `403 { error: 'not_permitted' }` → the `orders` row is `'abandoned'` with
  `syncStatus 'rejected'`; a `sale.abandoned` entry exists and was POSTed in the SAME run
  (`bodies[1].kind === 'sale.abandoned'`, `payload.invoiceNumber === 'POS1-000001'`, `reason
  'rejected'`) and is `'done'` after its `200`.
- `422 { error: 'rejected', flag: 'price_tamper' }` on a card sale → the same shape, with
  `lastError 'rejected:price_tamper'`.
- A 422 on a card sale emits rejected with http 422 and the flag: the same `422 { error:
  'rejected', flag: 'price_tamper' }` answer → exactly one `'rejected'` event was emitted, equal
  to `{ type: 'rejected', clientOpId: <the sale's>, kind: 'sale.complete', http: 422, error:
  'rejected', flag: 'price_tamper' }`.
- `session.open` answered `200 { status: 'accepted', posSessionId: 'srv-1', businessDate:
  '2026-09-28' }` with a `sale.complete` queued behind it under the local session id → the
  `session` row is `'open'`, `posSessionId 'srv-1'`, `businessDate '2026-09-28'`, and the sale's
  body (sent second) carries `payload.posSessionId 'srv-1'`.
- `session.close` answered `409 { error: 'session_has_unrecorded_ops', count: 2 }` → the entry is
  `'pending'` with `lastError 'session_has_unrecorded_ops:2'`, the `session` row is still
  `'closing'` with the same `lastError`, a `'stopped'` event with `count 2`, and no further POST.
- `session.close` answered `200 { status: 'accepted', expectedCashMinor: '123000',
  differenceMinor: '450' }` → the row is `'closed'` with both strings.
- Skew: a `200` whose `date` header is `'Mon, 28 Sep 2026 10:05:00 GMT'` with `now` at 10:00:00 →
  a `'skew'` event with `skewMs 300000` and `lastSkewMs()` is `300000`.
- Clean run: two sales and one login, all `200` → `countUnsynced()` is `0`, the summary is
  `{ sent: 3, outcome: 'drained' }`, and an `orders` row seeded as `'completed'` with `syncedAt`
  31 days before `now` is gone afterwards (the prune ran), while one 29 days old remains.
- Single-flight: two concurrent `flush()` calls return the SAME promise object, and only one set
  of bodies is recorded.
- A `503` answer → `'network'` outcome, `attempts 1`, retry scheduled at `2000`.
- `enqueue` (T-24) is idempotent: adding the same `clientOpId` twice inside one transaction
  resolves `'added'` then `'duplicate'`, and one row exists with the FIRST entry's envelope.

**Done when:** `pnpm test:unit src/lib/pos/queue.test.ts` passes, `pnpm test:unit src/lib/pos`
passes as a whole (the T-22 store tests still green after the `OfflineLogin` change), and
`pnpm check` and `pnpm lint` pass.

**Watch out:** a `bigint` must never reach `JSON.stringify` — the envelope already carries decimal
strings, and the flush sends `entry.envelope` and NOTHING ELSE (never the `orders` row, whose
`cart` holds `bigint`s). Never parallelise sends — order matters because a sale references its
session and an abandon references its sale. Do NOT call `vi.useFakeTimers()` in this test:
fake-indexeddb schedules its transactions on `globalThis.setImmediate`, which fake timers replace,
and every transaction then hangs — inject `schedule` and `now` through `FlushOptions` instead (if
a fake timer is ever unavoidable, fake ONLY `setTimeout`/`clearTimeout` via `toFake`). A `403`
whose body is not JSON, or has no `error`, or says `'Forbidden'`, is the DEVICE 403 — treat
`response.json()` throwing as "no body", never as a network error. `5xx` is transient (backoff),
never parked. The revoked path is a THROW of `DeviceRevoked`, never a resolved summary —
`FlushSummary.outcome` has no `'revoked'` member on purpose, and the test asserts the run
REJECTS; T-30 catches the throw and navigates to `/pos/register`.

### T-26 — The signed-in employee state with its mirror and idle rule

**Needs:** T-22 (ordering only: T-22 edits store.ts, whose CachedEmployee type this file imports;
nothing T-22 adds is used)
**Files:**
- `src/lib/pos/employee.svelte.ts` — NEW
- `src/lib/pos/employee.test.ts` — NEW
- `vitest.config.ts` — EDIT (the `unit` project entry inside `test.projects`: change
  `{ test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts'], exclude:
  ['src/**/*.integration.test.ts'] } }` to `{ plugins: [svelte()], test: { name: 'unit',
  environment: 'node', include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts']
  } }` — `plugins` is a SIBLING of `test`, never a key inside it — with `import { svelte } from
  '@sveltejs/vite-plugin-svelte'` at the top, so `.svelte.ts` runes modules compile under the
  unit project; nothing else in the file changes)
**Spec:** 7 ("The POS returns to the employee selection screen after a set idle time (default 2
minutes, configurable)"; PINs are never stored reversibly), 8 (the permission keys and the 403
rule), 6 ("The employee who is logged in keeps working")
**Invariants:** 12 (nothing session-shaped in `localStorage`; the idle lock is a nullable setting
with NO code fallback — no `?? 120`; the PIN hash is never copied anywhere), 8 (permissions are
enforced server-side on every op; "hiding a button is not security" — this state is a UI
convenience; T-16's `checkEmployee` and T-21's `handleOp` re-check the employee on every
operation the till sends)

**Do:**
1. `vitest.config.ts` first, because nothing in `employee.test.ts` runs without it:
   `vitest.config.ts` is its own root config (Vitest ignores `vite.config.ts` when
   `vitest.config.ts` exists), so `vite.config.ts`'s `sveltekit()` plugin — and with it the Svelte
   compiler — is NOT in play for unit tests, and `$state` in a `.svelte.ts` file is a bare
   `ReferenceError` at import time. The literal edit: change `{ test: { name: 'unit', environment:
   'node', include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts'] } }` to
   `{ plugins: [svelte()], test: { name: 'unit', environment: 'node', include:
   ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts'] } }`. `plugins` is a SIBLING
   of `test` (a project entry is a Vite config with an inline `test`), never a key inside `test`,
   where Vitest silently ignores it. The `unit` project ONLY (the
   integration project imports no `.svelte.ts` and stays as it is). `@sveltejs/vite-plugin-svelte`
   is already a pinned devDependency (`7.3.0`, imported by `svelte.config.js`); its
   `compile-module` plugin compiles `*.svelte.ts` and, because the unit project's environment is
   `node`, compiles them for the SERVER: `$state(v)` becomes a plain value with no proxy. Every
   function below is written to be correct under BOTH compilations, which means: no `$effect`, no
   `$derived`, plain functions over one `$state` box.
2. `src/lib/pos/employee.svelte.ts` — imports `type CachedEmployee` from `'./store'` (type
   only) and nothing else:
   ```ts
   /** The PR #11 cached shape MINUS pinPhc and isActive. The hash is NEVER copied here. */
   export type SignedInEmployee = {
   	id: string;
   	displayName: string;
   	isOwner: boolean;
   	roleName: string;
   	permissions: string[];
   };
   /** The one reactive value. A $state box, because a reassigned $state variable cannot be
    *  exported from a module; screens read `signedIn.current`. */
   export const signedIn = $state<{ current: SignedInEmployee | null }>({ current: null });
   const MIRROR_KEY = 'matcami_pos_employee';
   const TOUCH_THROTTLE_MS = 5_000;
   let lastActiveAt = 0;
   let lastMirrorWriteAt = 0;
   ```
3. `export function fromCachedEmployee(cached: CachedEmployee): SignedInEmployee` — picks the
   five fields BY NAME (`{ id: cached.id, displayName: …, isOwner: …, roleName: …, permissions:
   [...cached.permissions] }`); never `{ ...cached }`, which would copy `pinPhc`. The PIN screen
   (T-31) calls `signIn(fromCachedEmployee(cached))`.
4. Private `readMirror(): unknown | null`, `writeMirror(value: object): void`, `clearMirror():
   void` — every `sessionStorage` access inside `try/catch` (a private window or blocked site data
   makes the accessor itself throw), `typeof sessionStorage === 'undefined'` treated as absent.
   `sessionStorage`, never `localStorage` (invariant 12): the mirror is per tab and dies with it,
   and it holds no credential — no PIN, no hash, no cookie.
5. `export function signIn(employee: SignedInEmployee, now = Date.now()): void` —
   `signedIn.current = { …the five fields }`; `lastActiveAt = now`; `lastMirrorWriteAt = now`;
   `writeMirror({ ...employee, lastActiveAt: now })` (from the plain argument, never from the
   state box).
6. `export function touch(now = Date.now()): void` — nobody signed in → return; `lastActiveAt =
   now`; if `now − lastMirrorWriteAt >= TOUCH_THROTTLE_MS` → rewrite the mirror with the new
   `lastActiveAt` and set `lastMirrorWriteAt = now`. T-30 calls this on every `pointerdown` and
   `keydown` beside the idle watch's `poke()`.
7. `export function signOut(): void` — `signedIn.current = null`, `lastActiveAt = 0`,
   `lastMirrorWriteAt = 0`, `clearMirror()` — all synchronous, in the same tick, BEFORE the caller
   navigates, so a reload racing the navigation cannot restore a signed-out employee.
8. `export function restoreFromMirror(idleSeconds: number | null, now = Date.now()):
   SignedInEmployee | null` — returns `null` AND clears the mirror when: `idleSeconds === null`
   (no idle lock configured → no restore at all: the inert case, never a default number); the
   mirror is absent; `JSON.parse` throws; the parsed value fails the shape check (`id`,
   `displayName`, `roleName` strings, `isOwner` boolean, `permissions` an array of strings,
   `lastActiveAt` a finite number); or `now − lastActiveAt > idleSeconds × 1000`. Otherwise:
   `signedIn.current` = the five fields, `lastActiveAt = now`, `lastMirrorWriteAt = now`, rewrite
   the mirror with `lastActiveAt: now`, and return the employee. Never trust the mirror's own
   permissions beyond this session: the server re-checks every op (invariant 8).
9. `export function hasPermission(key: string): boolean` —
   `signedIn.current?.permissions.includes(key) ?? false`. It reads the LIST only and does not
   special-case `isOwner`: the server computed the list (PR #11's `permissionsForUser`), and a
   second opinion here is how a button ends up enabled for someone the server refuses. `isOwner`
   exists for display (the session chip) and for T-31's routing.
10. `export function lastActiveAtForTest(): number` — test seam only.

**Tests:** (`src/lib/pos/employee.test.ts`; before each test install an in-memory
`sessionStorage` with `vi.stubGlobal('sessionStorage', fakeStorage())` where `fakeStorage()`
implements `getItem`, `setItem`, `removeItem` and `clear` over a `Map`; call `signOut()` in
`beforeEach`; a fixed `T0 = Date.parse('2026-09-28T10:00:00Z')`; an employee `{ id: 'e-1',
displayName: 'Amina', isOwner: false, roleName: 'Cashier', permissions: ['pos.sell',
'pos.payment'] }`)
- Sign in then restore within the limit: `signIn(e, T0)`, `signedIn.current = null` (simulating a
  reload), `restoreFromMirror(120, T0 + 119_000)` returns the employee, `signedIn.current.id` is
  `'e-1'`, and the mirror's `lastActiveAt` is now `T0 + 119_000`.
- Past the limit: `signIn(e, T0)`, `restoreFromMirror(120, T0 + 120_001)` returns `null`,
  `signedIn.current` is `null`, and `sessionStorage.getItem('matcami_pos_employee')` is `null`.
  Exactly at the limit (`T0 + 120_000`) restores (the rule is `>`, not `>=`).
- `idleSeconds` null: `signIn(e, T0)`, `restoreFromMirror(null, T0 + 1)` returns `null` and the
  mirror is gone.
- Malformed: `sessionStorage.setItem('matcami_pos_employee', '{not json')` → `null`, mirror
  cleared; `JSON.stringify({ id: 'e-1' })` (missing fields) → `null`; a mirror whose
  `permissions` is `['pos.sell', 7]` → `null`.
- `touch` throttles: `signIn(e, T0)`, `touch(T0 + 1_000)` leaves the mirror's `lastActiveAt` at
  `T0` while `lastActiveAtForTest()` is `T0 + 1_000`; `touch(T0 + 5_000)` writes `T0 + 5_000`.
- `signOut` clears both: after `signIn(e, T0)` and `signOut()`, `signedIn.current` is `null` and
  the mirror key is absent; `touch()` afterwards writes nothing.
- `hasPermission`: `'pos.sell'` → `true`, `'pos.void'` → `false`, and `false` for every key when
  nobody is signed in; an owner with `permissions: []` still gets `false` (no special case).
- `fromCachedEmployee({ …, pinPhc: '$pbkdf2-sha256$…', isActive: true })` → `Object.keys(result)
  .sort()` equals `['displayName', 'id', 'isOwner', 'permissions', 'roleName']` — no `pinPhc`,
  and `JSON.stringify(result)` does not contain `'pbkdf2'`.
- Storage that throws: stub `sessionStorage` with a `getItem`/`setItem` that throw
  `DOMException('SecurityError')` → `signIn`, `touch`, `signOut` do not throw and
  `restoreFromMirror(120, T0)` returns `null`.

**Done when:** `pnpm test:unit src/lib/pos/employee.test.ts` passes; `pnpm test:unit` as a whole
still passes with the plugin added to the `unit` project (no other unit file changes behaviour);
`pnpm check` reports no error in `employee.svelte.ts`; `pnpm lint` passes (`eslint.config.js`
already parses `**/*.svelte.ts` with the Svelte parser).

**Watch out:** this state is a UI convenience only — the server re-checks the employee on every
op (T-16's `checkEmployee`, T-21's `handleOp`); nothing here may be the reason a request is
trusted. No `$effect` and no `$derived`: the module runs outside any component and under the
server compilation in tests, where neither exists. `sessionStorage`, never `localStorage`
(invariant 12). The mirror is what makes a reload survive the idle rule, so `restoreFromMirror`
must be the ONLY reader of it and must apply the idle limit BEFORE setting state; T-30 calls it
once, on mount, with `readCachedIdleSeconds()`'s value (`null` → no restore, ever). In
`vitest.config.ts`, `plugins: [svelte()]` is a SIBLING of the project's `test: {}` object, never
a key inside it: placed inside `test`, Vitest ignores it, `pnpm check` does not flag it (the
config is outside the generated tsconfig's include), and the only symptom is `$state is not
defined` at import time of `employee.svelte.ts` — if you see that error, check the placement
before anything else.
