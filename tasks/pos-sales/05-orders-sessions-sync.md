# Phase 2 (domain) — orders, sessions and the sync handler (T-15 … T-21)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 1 (02-schema.md), 03-money.md, 04-accounting.md.

Every business rule in this phase lives under `src/lib/server/**`. The HTTP route that will call it
(07-sync-api.md, T-27) does three things and nothing more: it validates the envelope of one queued
operation, resolves the registered device from its cookie, and calls `handleOp`. It never reads a
payload field, never opens a transaction and never decides an outcome. The payment transaction is
ONE function, `recordSale` in `src/lib/server/orders/pay.ts`; its only caller is the sync handler in
`src/lib/server/orders/sync.ts`, which runs it inside a single `db.transaction` in the order spec 13
prints: payment(s) → totals → invoice number → inventory → invoice → journal entries → mark PAID.
And the TENDER decides what a failed check means, never connectivity: a cash sale was completed on
the device before the server ever saw it, so it is a fact that is recorded and flagged; a card or
mobile sale and a session close are requests the server may refuse with 403 or 422 (the 422 for a
`session.close` WIDENS the overview's HTTP contract, which lists 422 only for a card/mobile
`sale.complete`; T-21 step 3.8 records the widening and its till-side consequence). Two conventions
hold for every task below. (1) Phase 1 owns the tables: the overview fixes the names this file uses
(`orders.tax_mode`, `subtotal_minor`, `flag_reason`, `payments.amount_minor`, `invoices.invoice_seq`,
`pos_sessions.business_date`, `pos_sync_ops.status`, the two invoice uniques, …); where this file
names a column the overview does not, it uses the name it expects 02-schema.md to have declared —
open that schema file before writing a query, use the name it declares, and NEVER add a column here.
(2) `audit_log` carries a partial unique index `audit_log_device_client_op_unique` on
`(device_id, client_op_id)`, so exactly ONE audit row per operation may carry `clientOpId`: the row
that records the operation's own fact (`sale.recorded`, `pos.session.opened`, `pos.session.closed`,
`sale.abandoned`, `pos.pin.offline_*`). Every other row about the same operation (`sale.flagged`,
`sync.op_unrecorded`, `sync.op_retried`, `sync.op_dismissed`) passes `clientOpId: null` and names
the operation in its `details` instead — a second keyed row raises 23505 and rolls the sale back.

### T-15 — Extend the audit event union with the sales, session, sync and offline-PIN events

**Needs:** T-02
**Files:**
- `src/lib/server/audit/events.ts` — EDIT (append ten union members after the last member,
  `menu.price_changed`, and their names at the end of `AUDIT_EVENT_NAMES`; the compile-time
  completeness assertion `_NoMissingAuditEventNames` stays exactly as it is)
- `src/routes/(dashboard)/dashboard/event-text.ts` — EDIT (one sentence per new name, appended after
  `'menu.price_changed'` in the `EVENT_TEXT: Record<AuditEventName, string>` object)
- `src/routes/(dashboard)/dashboard/event-text.test.ts` — EDIT (open it first: it walks
  `AUDIT_EVENT_NAMES` and asserts `Object.keys(EVENT_TEXT)` equals that list, so the new labels make
  it pass with no change; if the version you find lists names literally, add the ten there too)
- `src/lib/server/audit/audit.test.ts` — EDIT (add an `it.each` block beside the existing
  `'passes for %s'` block, and one typed sample array — step 6)
**Spec:** 3 (sensitive actions are audit-logged), 6 (offline logins "are recorded locally and synced
to the audit log"; problems are flagged, never dropped), 10 (the session count "gives us a useful
audit trail")
**Invariants:** 10 (sensitive actions are audit-logged, in the same transaction as the action), 1
(money is integer minor units — inside `details` an amount is a DECIMAL STRING of the bigint, because
jsonb cannot hold a bigint)

**Do:**
1. Open `src/lib/server/audit/events.ts`. After PR #11 merges its last union member is
   `menu.price_changed` and `pos.pin.success` carries `{ deviceCode: string; roleName: string }`.
   Touch no existing member. Under a section comment `// ── POS sales (tasks/pos-sales T-15) ──`
   append exactly these ten members, in this order:

   ```ts
   | {
       event: 'pos.session.opened';
       details: { deviceCode: string; businessDate: string; openingCashMinor: string; attached: boolean };
     }
   | {
       event: 'pos.session.closed';
       details: {
         deviceCode: string;
         businessDate: string;
         expectedCashMinor: string;
         countedCashMinor: string;
         differenceMinor: string;
       };
     }
   | {
       event: 'sale.recorded';
       details: {
         deviceCode: string;
         invoiceNumber: string;
         orderType: 'dine_in' | 'takeaway';
         method: 'cash' | 'card' | 'mobile';
         totalMinor: string;
       };
     }
   | { event: 'sale.flagged'; details: { deviceCode: string; invoiceNumber: string; flags: string[] } }
   | {
       event: 'sale.abandoned';
       details: { deviceCode: string; invoiceNumber: string; reason: 'rejected' | 'cancelled' };
     }
   | {
       event: 'sync.op_unrecorded';
       details: { deviceCode: string; kind: string; flag: string; detail: string };
     }
   | {
       event: 'sync.op_retried';
       details: { opId: string; outcome: 'accepted' | 'recorded_flagged' | 'unrecorded' };
     }
   | { event: 'sync.op_dismissed'; details: { opId: string; reason: string } }
   | { event: 'pos.pin.offline_success'; details: { deviceCode: string } }
   | { event: 'pos.pin.offline_failed'; details: { deviceCode: string; reason: 'bad_pin' } }
   ```

2. Write a comment above them stating the key rule and why every key above obeys it: `writeAudit`
   calls `assertNoSecrets(details)`, which throws on any KEY at any depth matching
   `/pass|pin|token|hash|secret|cookie|authorization/i`, and it throws INSIDE the action's own
   transaction — so a key such as `pinLogin`, `deviceToken` or `opToken` would roll back the very sale
   it was recording. Hence `deviceCode` (the printed `POS1`, never a token), `opId` (the
   `pos_sync_ops.id` bigint identity, written as its decimal string — `row.id.toString()`, as T-37
   does), `kind` (the op kind string such as `sale.complete`), and the offline PIN
   rows carry only `deviceCode` and `reason`. The word "pin" in the event NAME
   (`pos.pin.offline_failed`) is a column VALUE, not a details key, and is fine — `pos.pin.failed`
   already exists. `pos.pin.offline_failed` has NO `failedCount`: the offline path runs no lockout
   counter (spec 7's five-attempt lock lives in the server verifier; the device only records that an
   attempt was made and failed).
3. Amounts in `details` are decimal strings of the integer minor value (`openingCashMinor: '50000'`
   for $500.00), produced with `.toString()` on the bigint at the call site. Never `Number()`, never a
   float, never a formatted `$500.00`.
4. Append the ten names to `AUDIT_EVENT_NAMES`, after `'menu.price_changed'`, in the same order as
   the members. The `as const satisfies readonly AuditEventName[]` rejects a misspelt name and
   `_NoMissingAuditEventNames` rejects a member left out of the list; `pnpm check` proves both. The
   list holds 34 names after this task (24 from PR #11 plus these 10).
5. In `event-text.ts` append, after `'menu.price_changed': 'Menu price changed'`:

   ```ts
   'pos.session.opened': 'POS session opened',
   'pos.session.closed': 'POS session closed and drawer counted',
   'sale.recorded': 'Sale recorded',
   'sale.flagged': 'Sale recorded with a flag for review',
   'sale.abandoned': 'Sale abandoned; its invoice number was burned',
   'sync.op_unrecorded': 'A synced operation could not be recorded and needs review',
   'sync.op_retried': 'Flagged operation retried',
   'sync.op_dismissed': 'Flagged operation dismissed',
   'pos.pin.offline_success': 'Signed in at the POS while offline',
   'pos.pin.offline_failed': 'Failed POS sign-in attempt while offline'
   ```

   The object is typed as a TOTAL `Record<AuditEventName, string>`, so a missing sentence is a
   compile error, not a dotted name on the owner's screen.
6. In `src/lib/server/audit/audit.test.ts` add two things beside the existing `'passes for %s'`
   block. (a) An `it.each` with one sample `details` object per new event —
   `{ deviceCode: 'POS1', businessDate: '2026-09-28', openingCashMinor: '50000', attached: false }`,
   `{ deviceCode: 'POS1', businessDate: '2026-09-28', expectedCashMinor: '200000',
   countedCashMinor: '199000', differenceMinor: '-1000' }`,
   `{ deviceCode: 'POS1', invoiceNumber: 'POS1-000001', orderType: 'takeaway', method: 'cash',
   totalMinor: '1100' }`,
   `{ deviceCode: 'POS1', invoiceNumber: 'POS1-000001', flags: ['employee_not_permitted'] }`,
   `{ deviceCode: 'POS1', invoiceNumber: 'POS1-000002', reason: 'rejected' }`,
   `{ deviceCode: 'POS1', kind: 'sale.complete', flag: 'unknown_session', detail: '…' }`,
   `{ opId: '42', outcome: 'accepted' }`, `{ opId: '42', reason: 'Test sale during training' }`,
   `{ deviceCode: 'POS1' }`, `{ deviceCode: 'POS1', reason: 'bad_pin' }` — each asserting
   `expect(() => assertNoSecrets(details)).not.toThrow()`. (b) A compile-time proof that `writeAudit`
   accepts each member: `const samples = [{ event: 'pos.session.opened', details: {…} }, …]
   satisfies AuditEvent[];` (import `type AuditEvent` from `./events`), one element per new event,
   then
   `expect(samples).toHaveLength(10)` so the array is used at runtime as well.
7. Nothing else changes: no writer, no reader, no schema. `audit_log` already carries `device_id`,
   `client_op_id` and `occurred_at` (their columns landed in `tasks/pos-access-and-menu`), and
   `writeAudit`'s `AuditEntry` already takes `deviceId`, `clientOpId` and `occurredAt` — T-19, T-20
   and T-21 pass them.

**Tests:**
- `src/routes/(dashboard)/dashboard/event-text.test.ts` (existing): every one of the 34 names has a
  non-empty sentence, and the sorted keys of `EVENT_TEXT` equal the sorted `AUDIT_EVENT_NAMES`.
- `src/lib/server/audit/audit.test.ts` (new cases): the ten sample details objects pass
  `assertNoSecrets`; `samples` has length 10 and compiles against `AuditEvent[]`.
- `pnpm check`: `_NoMissingAuditEventNames` still resolves to `true` (a name left out of the list
  fails the build).

**Done when:** `pnpm check` passes, and
`pnpm test:unit src/lib/server/audit "src/routes/(dashboard)/dashboard"` passes with the new cases
counted (quote the parenthesised path in zsh).

**Watch out:** amounts in `details` are decimal strings, never numbers. PR #11 changed
`pos.pin.success`'s details from `role` to `roleName` — do not touch it or any other existing
member, and do not reorder the list. Do not add a `clientOpId` or `deviceId` key to any `details`
shape: those are `AuditEntry` fields written to their own columns, and a `deviceToken`-style key
would trip `assertNoSecrets`.

### T-16 — `checkEmployee`: an employee permission check for device-sourced operations

**Needs:** T-01
**Files:**
- `src/lib/server/permissions/employee.ts` — NEW
- `src/lib/server/permissions/employee.integration.test.ts` — NEW
- `src/lib/server/permissions/index.ts` — EDIT (add
  `export { checkEmployee } from './employee';` and
  `export type { EmployeeCheck, EmployeeCheckFailure } from './employee';` beside the existing
  `export { listRoles, … permissionsForUser } from './roles';` block)
**Spec:** 8 (permissions are enforced on the server; "hiding buttons in the frontend is not
considered security"), 6 (a completed offline cash sale is a recorded fact — so the CALLER decides
what a failed check means, by tender), 7 (PIN sign-in on a registered device; five wrong attempts
lock the employee out). The spec never mentions deactivation: the inactive check below rests on
the existing `users.is_active` column and the `employee.deactivated` audit event, a HOUSE RULE from
`tasks/pos-access-and-menu` — do not go hunting for a spec sentence that is not there.
**Invariants:** 8 (permissions are enforced server-side on every POS API route, reads included), 5
(an offline cash sale is a fact; the consequence of this check is a flag for cash and a 403 for
card/mobile and session close — decided by the caller, never here)

**Do:**
1. Export the types and the function:

   ```ts
   export type EmployeeCheckFailure = 'employee_unknown' | 'employee_inactive' | 'employee_not_permitted';
   export type EmployeeCheck = { ok: true } | { ok: false; reason: EmployeeCheckFailure };
   export async function checkEmployee(
     database: Executor,
     restaurantId: string,
     userId: string,
     keys: readonly PermissionKey[]
   ): Promise<EmployeeCheck>;
   ```

   `Executor` (`Db | DbTx`) is imported from `../auth/session`, `PermissionKey` from `./keys`,
   `permissionsForUser` from `./roles` (PR #11's resolver:
   `permissionsForUser(database, restaurantId, userId): Promise<ReadonlySet<PermissionKey>>`), and
   the `users` table from `../db/schema/users`. It takes `Executor`, not `DbTx`, because it only
   reads — the codebase convention is that readers accept either handle.
2. Select `{ id: users.id, isActive: users.isActive }` from `users` where `users.id = userId` AND
   `users.restaurantId = restaurantId`, `limit(1)`. Name the two columns explicitly — never
   `select()` the whole row, which carries `password_hash` and `pin_hash`. No row →
   `{ ok: false, reason: 'employee_unknown' }`. This one query also answers "another restaurant's
   user": scoping by `restaurantId` makes a foreign id indistinguishable from a random one, which is
   the intent.
3. `isActive === false` → `{ ok: false, reason: 'employee_inactive' }`.
4. `const held = await permissionsForUser(database, restaurantId, userId);` then for every key in
   `keys`, `held.has(key)` must be true, else `{ ok: false, reason: 'employee_not_permitted' }`. An
   owner needs no special case: the resolver returns `ALL_KEYS` for `users.role = 'owner'`. An empty
   `keys` array passes after steps 2–3 (an identity-only check).
5. It never throws for a failed check — every failure is a return value, because callers run it
   inside the payment transaction and a thrown error there would roll back a real cash sale (the
   same reason `verifyEmployeePin` in `src/lib/server/auth/pin.ts` returns rather than throws).
6. Header comment naming the callers and the tender rule: `validateSale` (T-18) with
   `['pos.sell', 'pos.payment']` for `sale.complete`; `handleOp` (T-21) with `['pos.payment']` for
   `session.open` and `session.close` (assumption 6 in the overview: `pos.payment` is reused, no new
   key is coined). A failure on a cash sale or a session open becomes a SOFT flag carried on the
   recorded row; on a card/mobile sale or a session close it becomes `403 not_permitted`. `pin.login`
   and `sale.abandoned` are facts and never call this.

**Tests:** (integration; the file resets the database before each test via the project's
`integration-setup.ts`) Fixture per test: insert a `restaurants` row; run
`db.transaction((tx) => onRestaurantCreated(tx, id, { restaurantName, timeZone: 'UTC' }))` from
`../restaurants` (after PR #11 this seeds the settings row AND the two default roles `Cashier` with
`CASHIER_KEYS` and `Waiter` with `WAITER_KEYS`); insert the owner (`role: 'owner'`, an email, a
placeholder `passwordHash`); then `seedStaff` from `../db/test/seed`:
`seedStaff(db, restaurantId, { displayName: 'Sam', roleName: 'Cashier' })`,
`seedStaff(db, restaurantId, { displayName: 'Wren', roleName: 'Waiter' })`,
`seedStaff(db, restaurantId, { displayName: 'Dee', roleName: 'Cashier', isActive: false })`.
- owner, `['pos.sell', 'pos.payment']` → `{ ok: true }`.
- Sam (Cashier), `['pos.sell', 'pos.payment']` → `{ ok: true }`.
- Wren (Waiter), `['pos.sell', 'pos.payment']` → `{ ok: false, reason: 'employee_not_permitted' }`;
  Wren, `['pos.view_menu']` → `{ ok: true }` (the check is per key, not per role name).
- Dee, `['pos.sell']` → `{ ok: false, reason: 'employee_inactive' }`.
- a second restaurant's owner id checked against the first restaurant →
  `{ ok: false, reason: 'employee_unknown' }`.
- `crypto.randomUUID()` → `{ ok: false, reason: 'employee_unknown' }`.
- Sam, `[]` → `{ ok: true }`; Dee, `[]` → `employee_inactive` (identity checks still run).
- The check reads on a `DbTx` too: run one case inside `db.transaction((tx) => checkEmployee(tx, …))`.

**Done when:** `pnpm test:integration src/lib/server/permissions/employee.integration.test.ts`
passes and `pnpm check` passes.

**Watch out:** `ROLE_KEYS` (the old role-name → keys map) no longer exists after PR #11; `keys.ts`
exports `OWNER_KEYS`, `POS_KEYS` and `DEFAULT_ROLES` instead. Never map a role NAME to keys — the
owner may have renamed or re-permissioned "Cashier" on `/employees/roles`; `permissionsForUser` is
the single source. That resolver returns an EMPTY set for an unknown or inactive user, which is why
steps 2 and 3 run BEFORE it: without them every such failure would read `employee_not_permitted`,
and the dashboard could not tell "deactivated" from "wrong role". If `onRestaurantCreated` does not
create a live `Cashier` role in the fixture, PR #11 is not in the tree — T-01's precondition
failed; stop and report.

### T-17 — `consumeForSale`: the inventory step as a documented no-op

**Needs:** T-03
**Files:**
- `src/lib/server/inventory/consume.ts` — NEW
- `src/lib/server/inventory/consume.test.ts` — NEW (unit, no database)
- `src/lib/server/inventory/README.md` — EDIT (add a `## Status` section after the bullet list and
  before the line `Called by \`orders/\`. Never calls \`orders/\` back.`)
**Spec:** 13 ("Deduct Inventory — recipes × quantity, incl. modifiers" is a step of the payment
transaction, between "Record Invoice Number" and "Create Invoice"), 16 ("COGS is posted to the
ledger on every sale (section 24), so gross profit comes straight from the books"; weighted average),
15 (recipes and modifier recipes belong to the inventory plan)
**Invariants:** 6 (inventory is a ledger; every sale posts Dr COGS / Cr Inventory — deferred, stated
in code, never faked), 4 (the step exists in its spec 13 slot inside the one transaction), 1
(`cogsMinor` is a `Minor` bigint, never a number)

**Do:**
1. Export:

   ```ts
   import type { DbTx } from '../db/client';
   import { minor, type Minor } from '../../money';        // relative: the unit project has no $lib alias
   import type { SaleLine } from '../../sync-ops';         // T-03's isomorphic contract

   export type ConsumeArgs = { restaurantId: string; orderId: string; lines: SaleLine[] };
   export type ConsumeResult = { movements: never[]; cogsMinor: Minor };

   export async function consumeForSale(tx: DbTx, args: ConsumeArgs): Promise<ConsumeResult> {
     void tx;   // the caller's transaction handle — used the day recipes exist (invariant 4)
     void args; // recipe × quantity, incl. modifiers, the day recipes exist (spec 13, 15)
     return { movements: [], cogsMinor: minor(0n) };
   }
   ```

   The `void` statements keep the parameters in the signature under the repo's default
   `no-unused-vars` rule (no `argsIgnorePattern` is configured) without renaming them.
2. Header comment, verbatim in substance: invariant 6 — "Inventory is a ledger. Stock on hand is
   the sum of stock movements … Every sale posts Dr COGS / Cr Inventory"; spec 16 — the sentence
   quoted above; and: THIS FUNCTION IS THE ONLY PLACE THE INVENTORY PLAN MUST CHANGE to make every
   sale post `Dr 5000 Cost of Goods Sold / Cr 1200 Inventory`. `recordSale` (T-19) already calls it
   in spec 13's slot and already posts `cogsLines(cogsMinor)` whenever `cogsMinor > 0n`. Until then:
   no stock movement is written, no COGS entry is posted, gross profit equals revenue in the books,
   and sales made before recipes exist will NEVER carry COGS — posted records are permanent
   (invariant 2), so a later plan may not back-fill movements onto them.
3. It writes nothing, reads nothing, never throws, and takes the caller's `tx` rather than opening
   its own (invariant 4). It does NOT read `menu_items`: cost is the inventory ledger's weighted
   average, never a number on a menu row (invariant 6).
4. README `## Status` paragraph (the substance): no inventory tables exist yet; `consumeForSale` in
   `consume.ts` is the seam the payment transaction (`orders/pay.ts`) calls; the inventory plan
   replaces its body with recipe × quantity deductions (modifiers included) costed at the weighted
   average and returns the movements and their total cost; until then no stock movement is written
   and no COGS entry is posted, so gross profit equals revenue in the books, and sales recorded
   before recipes exist will never carry COGS.

**Tests:** (unit, `consume.test.ts`)
- A two-line sale (`SaleLine[]` with quantities 1 and 2, one line carrying a modifier) →
  `{ movements: [], cogsMinor: 0n }`; `result.movements.length === 0`;
  `typeof result.cogsMinor === 'bigint'`.
- The call type-checks with `lines: SaleLine[]` from `src/lib/sync-ops` (build the lines with that
  type annotation; `pnpm check` is the assertion). `tx` may be `{} as DbTx` — it is not touched.

**Done when:** `pnpm test:unit src/lib/server/inventory` passes and `pnpm check` passes.

**Watch out:** do not add tables, a cached quantity, or a recipe column anywhere — `menu.ts`'s
header says why the seam is the stable item uuid and nothing else. Do not "helpfully" return a cost
from any menu field. Returning `minor(0n)` is what makes T-19 skip the COGS entry (`cogsMinor > 0n`
is its guard; the journal writer would drop zero lines anyway, but the guard keeps an empty entry
from ever being attempted).

### T-18 — `validateSale`: the payload schema, hard failures, soft flags

**Needs:** T-03, T-08, T-10, T-11, T-16
**Files:**
- `src/lib/server/orders/validate.ts` — NEW
- `src/lib/server/orders/validate.integration.test.ts` — NEW
**Spec:** 6 ("Price at time of sale wins", "Problems are flagged, not dropped", device invoice
numbers), 8 and 14 (a discount needs owner approval and a reason — this slice's screens produce
none, so the validator pins it to zero), 13 (the invoice number comes from the device sequence), 17
(one rounding rule; each line stores its rate), 33 decision 4 (which tenders are accepted is a
setting: `accepts_card`, `accepts_mobile` from T-07)
**Invariants:** 1 (integer minor units; every comparison is `bigint === bigint`), 5 (an offline cash
sale is a fact — the hard/soft split below is what keeps a real sale out of the payload-only path), 7
(discount before tax; each line snapshots its own price and rate; ONE rounding function —
`computeOrderTotals`), 8 (server-side permission through `checkEmployee`), 9 (nothing gated by an
owner PIN is reachable: `discountMinor` must be `'0'`)

**Do:**
1. Define and export the shared request context here — T-19, T-20 and T-21 use it. This file
   EXTENDS the overview's `SyncContext` contract (`{ restaurantId; cookieDeviceId; opDeviceId;
   opDeviceCode; employeeId; clientOpId; occurredAt; receivedAt; ip; userAgent }`) by EXACTLY ONE
   field, `employeeUserId: string | null`, and the overview's "Shared contracts" block is to carry it
   too. Why: `employeeId` is the envelope's raw string, which may name nobody; `employeeUserId` is the
   only value ever written into a `users` foreign-key column (`orders.employee_user_id`,
   `pos_sessions.opened_by_user_id`, `pos_sync_ops.employee_user_id`, `audit_log.actor_user_id`).
   T-19, T-20 and T-21 all depend on it — a session that cross-checks the overview and drops the
   field breaks three tasks.

   ```ts
   export type SyncContext = {
     restaurantId: string;      // the COOKIE device's restaurant (requireDevice)
     cookieDeviceId: string;    // the device that sent the request
     opDeviceId: string;        // the device the op was RECORDED under (envelope.deviceId)
     opDeviceCode: string;      // that device's printed code, 'POS1' — the invoice prefix
     employeeId: string;        // the envelope's raw employeeId, as sent
     employeeUserId: string | null; // employeeId when a users row with that id exists in
                                    // restaurantId (active or not), else null — the ONLY value
                                    // ever written into a foreign-key column (T-19, T-20, T-21)
     clientOpId: string;
     occurredAt: Date;          // device time of the op
     receivedAt: Date;          // server time the request arrived
     ip: string | null;
     userAgent: string | null;
   };
   export type SoftFlag = (typeof SOFT_FLAGS)[number];
   export type HardFlag = (typeof HARD_FLAGS)[number];
   ```

   `SOFT_FLAGS`, `HARD_FLAGS`, `ORDER_TYPES`, `PAYMENT_METHODS`, `formatInvoiceNumber`, `OpEnvelope`
   and `SaleLine` come from `../../sync-ops` (T-03); `TAX_MODES`/`TaxMode` from `../../money/tax`;
   `minor`, `Minor`, `ROUNDING_RULE` from `../../money`; `computeOrderTotals` and `totalsEqual` from
   `../../money/order-totals` (T-10); `changeDue` from `../../money/change` (T-11).
2. The zod schema, server-side only (zod 4.6.4 is pinned; nothing here is imported by a `.svelte`
   file). Every `*Minor` field on the wire is a decimal string:

   ```ts
   const MINOR = /^-?[0-9]{1,15}$/;
   const minorString = z.string().regex(MINOR).transform((s) => BigInt(s));
   const nonNegativeMinor = minorString.refine((v) => v >= 0n, 'must not be negative');
   const zeroMinor = z.literal('0').transform(() => 0n);   // spec 8/14: no discount without approval
   const modifierSchema = z.object({
     modifierId: z.uuid(),
     modifierName: z.string().min(1).max(120),
     priceDeltaMinor: minorString                           // may be negative ("No cheese −$0.50")
   });
   const lineSchema = z.object({
     lineId: z.uuid(),
     lineNo: z.number().int().min(1),
     menuItemId: z.uuid(),
     itemName: z.string().min(1).max(120),
     quantity: z.number().int().min(1).max(999),
     unitPriceMinor: nonNegativeMinor,
     taxRateBp: z.number().int().min(0).max(10000),
     discountMinor: zeroMinor,
     modifiers: z.array(modifierSchema).max(20)
   });
   const paymentSchema = z
     .object({
       paymentId: z.uuid(),
       method: z.enum(PAYMENT_METHODS),
       amountMinor: nonNegativeMinor,
       tenderedMinor: minorString.nullable(),
       changeMinor: minorString.nullable()
     })
     .superRefine((p, ctx) => {
       const cash = p.method === 'cash';
       if (cash && (p.tenderedMinor === null || p.changeMinor === null)) ctx.addIssue({ code: 'custom', message: 'cash needs tendered and change' });
       if (!cash && (p.tenderedMinor !== null || p.changeMinor !== null)) ctx.addIssue({ code: 'custom', message: 'only cash carries tendered and change' });
     });
   export const saleCompletePayloadSchema = z.object({
     orderId: z.uuid(),
     posSessionId: z.uuid(),
     orderType: z.enum(ORDER_TYPES),
     tableLabel: z.string().min(1).max(32).nullable(),
     taxMode: z.enum(TAX_MODES),
     currencyCode: z.string().regex(/^[A-Z]{3}$/),
     menuVersion: z.number().int().min(1),
     invoiceSeq: z.number().int().min(1).max(999999),
     invoiceNumber: z.string().min(1).max(15),
     openedAt: z.iso.datetime({ offset: true }),
     lines: z.array(lineSchema).min(1).max(200),
     totals: z.object({ subtotalMinor: minorString, discountMinor: minorString, taxMinor: minorString, totalMinor: minorString }),
     payments: z.array(paymentSchema).length(1)             // one tender per order in this plan (R4)
   }).superRefine((p, ctx) => {
     const ids = new Set(p.lines.map((l) => l.lineId));
     const nos = new Set(p.lines.map((l) => l.lineNo));
     if (ids.size !== p.lines.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'duplicate lineId' });
     if (nos.size !== p.lines.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'duplicate lineNo' });
   });
   ```

   Never `z.coerce` and never `z.number()` for money: a number on the wire is the type invariant 1
   forbids. A schema failure is HARD `invalid_payload`; its `detail` is
   `` `${issue.path.join('.')}: ${issue.message}` `` of the first issue.
3. Define and export `ParsedSale` in this file — the bigint-typed, row-resolved sale T-19 records:

   ```ts
   export type ParsedSale = {
     orderId: string; posSessionId: string; businessDate: string;   // businessDate from the session row
     orderType: 'dine_in' | 'takeaway'; tableLabel: string | null;
     taxMode: TaxMode; currencyCode: string; menuVersion: number;
     invoiceSeq: number; invoiceNumber: string; openedAt: Date;
     lines: {
       lineId: string; lineNo: number; menuItemId: string; itemName: string; quantity: number;
       unitPriceMinor: Minor; taxRateBp: number; discountMinor: Minor;
       modifiers: { modifierId: string; modifierName: string; priceDeltaMinor: Minor }[];
     }[];
     totals: { subtotalMinor: Minor; discountMinor: Minor; taxMinor: Minor; totalMinor: Minor };
     payment: { paymentId: string; method: 'cash' | 'card' | 'mobile'; amountMinor: Minor; tenderedMinor: Minor | null; changeMinor: Minor | null };
     session: { id: string; deviceId: string; businessDate: string; status: 'open' | 'closed' };
   };
   export type ValidateResult =
     | { ok: true; sale: ParsedSale; softFlags: SoftFlag[] }
     | { ok: false; hard: HardFlag; detail: string };
   ```

4. The function:

   ```ts
   export async function validateSale(
     tx: DbTx,
     ctx: SyncContext,
     envelope: OpEnvelope<'sale.complete', unknown>
   ): Promise<ValidateResult>
   ```

   It runs these checks IN THIS ORDER. A HARD check returns immediately; a SOFT check pushes its
   flag and continues; the flags are deduplicated and returned in the order collected.
   1. Schema (step 2) → HARD `invalid_payload`.
   2. Invoice number: `payload.invoiceNumber !== formatInvoiceNumber(ctx.opDeviceCode, payload.invoiceSeq)`
      → HARD `invalid_payload`, detail `invoice_number_mismatch`. The prefix is the OP device's code
      (a revoked `POS1` tablet re-registered as `POS2` still numbers its old queue `POS1-…`).
   3. Session: select `id, device_id, business_date, status` from `pos_sessions` where
      `id = payload.posSessionId` AND `restaurant_id = ctx.restaurantId`. None → HARD
      `unknown_session`, detail = the id. `device_id !== ctx.opDeviceId` → HARD `invalid_payload`,
      detail `session_device_mismatch`. `status === 'closed'` → SOFT `session_closed` (the sale is
      still recorded against it; the report shows it).
   4. Settings: select `tax_mode, tax_rate_bp, currency_code, menu_version, accepts_card, accepts_mobile`
      from `restaurant_settings` for `ctx.restaurantId` (one row; missing → HARD `database_error`,
      detail `settings_missing`).
   5. Items: select `id, price_minor, tax_rate_bp` from `menu_items` where
      `restaurant_id = ctx.restaurantId` and `id in (distinct menuItemIds)` — NO `archived_at`
      filter: an item archived while the till was offline still sold (spec 6). Any id missing →
      HARD `unknown_item`, detail = that id.
   6. Modifiers: select `m.id, m.price_delta_minor, l.menu_item_id` from `modifiers m` joined to
      `menu_item_modifier_groups l` on `l.modifier_group_id = m.group_id` and
      `l.restaurant_id = m.restaurant_id`, where `m.restaurant_id = ctx.restaurantId` and `m.id in (…)`.
      Every `(line.menuItemId, modifier.modifierId)` pair must appear → else HARD `unknown_modifier`,
      detail `\`${lineId}:${modifierId}\``.
   7. Tenders: `method === 'card'` requires `accepts_card === true`; `'mobile'` requires
      `accepts_mobile === true` (null counts as off) → else HARD `invalid_payload`, detail
      `tender_not_accepted`. Safe because the till completes card/mobile only after the server's 200
      (R4), so a 422 here is a sale that has not happened.
   8. Prices — read ONLY to compare, never to change a number: for every line
      `line.unitPriceMinor === item.price_minor`; for every modifier
      `priceDeltaMinor === modifier.price_delta_minor`;
      `line.taxRateBp === (item.tax_rate_bp ?? settings.tax_rate_bp)` (a null restaurant rate can
      equal nothing, so it counts as different); and
      `payload.taxMode === settings.tax_mode`. When ALL are equal, nothing. When any differs and
      `payload.menuVersion === settings.menu_version` → HARD `price_tamper`, detail naming the first
      difference: `line:<lineId>:unit_price`, `line:<lineId>:modifier:<modifierId>`,
      `line:<lineId>:tax_rate` or `tax_mode`. When any differs and the versions differ → SOFT
      `stale_menu_price` (spec 6: price at time of sale wins).
   9. Totals: rebuild the input from the PAYLOAD's own lines and mode:

      ```ts
      const recomputed = computeOrderTotals(
        {
          taxMode: payload.taxMode,
          lines: payload.lines.map((l) => ({
            unitPriceMinor: minor(l.unitPriceMinor),
            quantity: BigInt(l.quantity),
            modifierDeltasMinor: l.modifiers.map((m) => minor(m.priceDeltaMinor)),
            taxRateBp: l.taxRateBp,
            discountMinor: minor(0n)
          }))
        },
        ROUNDING_RULE
      );
      ```

      Then `totalsEqual(recomputed, { subtotal: payload.totals.subtotalMinor, discount:
      payload.totals.discountMinor, tax: payload.totals.taxMinor, total: payload.totals.totalMinor })`
      (T-10) → `false` is the SOFT flag `totals_mismatch`. Never from live `menu_items` or
      `restaurant_settings` (R5): the recomputation checks the device's arithmetic, not its prices.
   10. Payment: `amountMinor === payload.totals.totalMinor` → else HARD `invalid_payload`, detail
       `payment_amount`. Cash: `tenderedMinor >= amountMinor` (a comparison) and
       `changeMinor === changeDue(tenderedMinor, amountMinor)` (T-11) — never a subtraction in this
       file (invariant 1: arithmetic lives in `src/lib/money`) → else HARD `invalid_payload`, detail
       `cash_change`.
   11. Clock: `ctx.occurredAt.getTime() - ctx.receivedAt.getTime() > 5 * 60 * 1000` → SOFT
       `clock_ahead`.
   12. Employee: `await checkEmployee(tx, ctx.restaurantId, ctx.employeeId, ['pos.sell', 'pos.payment'])`
       → `ok: false` → SOFT flag equal to `reason` (`employee_unknown`, `employee_inactive` or
       `employee_not_permitted`). NOTE on `employee_unknown`: this validator EMITS it as a soft flag
       (`ok: true`, so the test below with `randomUUID()` passes), but such a sale is NEVER recorded —
       02-schema.md T-06 declares `orders.employee_user_id` NOT NULL, so T-21 step 3.7 turns
       `ctx.employeeUserId === null` into HARD `invalid_payload` / `employee_unknown` before it calls
       `recordSale`. The flag stays in `SOFT_FLAGS` because the overview lists it there; the
       handler, not this file, decides that it cannot be stored.
   13. Return `{ ok: true, sale, softFlags }` with every `*Minor` a `Minor` (via `minor(BigInt)` from
       the transform), `openedAt: new Date(payload.openedAt)`, `businessDate` and `session` from
       step 3.
5. It reads only; it writes nothing; it never mutates a payload number; it never throws for a
   validation outcome (only a genuine programming error throws, and T-21 maps that to
   `database_error`).

**Tests:** (integration) Fixture: restaurant + `onRestaurantCreated` (settings, roles, chart) +
owner; settings via `updateSettings` from `../restaurants` — its real signature is
`updateSettings(tx, restaurantId, changes, ctx: UpdateSettingsContext)`, so the call is
`updateSettings(tx, restaurantId, { taxMode: 'exclusive', taxRateBp: 1000, currencyCode: 'USD',
posIdleLockSeconds: 120 }, { actorUserId: ownerId, ip: null, userAgent: null })`; a menu
through `../menu`: `createCategory` "Drinks", `createItem` "Tea"
`priceMinor: 850n`, `createModifierGroup` "Milk" (`minSelect 0, maxSelect 1`), `createModifier`
"Oat milk" `priceDeltaMinor: 50n` in that group, `linkModifierGroup(item, group)`, plus a second
group "Extras" with modifier "Syrup" `+100n` NOT linked to Tea; a device via
`registerDevice(tx, { restaurantId, actorUserId: ownerId, label: 'Counter' })` (code `POS1`); an
open `pos_sessions` row inserted directly, listing every NOT NULL column (`id: randomUUID()`,
`restaurant_id`, `device_id`, `opened_by_user_id: ownerId`, `opened_at`,
`business_date: '2026-09-28'`, `opening_cash_minor: 0n`, `status: 'open'` — T-05 makes
`restaurant_id` and `opened_by_user_id` NOT NULL, so an insert without them fails with 23502); Sam via
`seedStaff(…, { roleName: 'Cashier' })`, Wren via `seedStaff(…, { roleName: 'Waiter' })`. A helper
`envelope(overrides)` returns a well-formed cash sale: one line Tea × 1 at `'850'`, `taxRateBp 1000`,
no modifiers; totals `{ subtotalMinor: '850', discountMinor: '0', taxMinor: '85', totalMinor: '935' }`;
one cash payment `amountMinor '935', tenderedMinor '1000', changeMinor '65'`; `menuVersion` = the
restaurant's current `menu_version` (read it with `getMenuVersion`); `invoiceSeq 1`,
`invoiceNumber 'POS1-000001'`. A helper `ctxFor(employeeId, occurredAt = new Date())` builds the
`SyncContext` with `opDeviceId = cookieDeviceId = device`, `opDeviceCode 'POS1'`, `receivedAt = new Date()`.
Run each case inside `db.transaction((tx) => validateSale(tx, ctx, env))`.
- well-formed cash sale, Sam → `{ ok: true, softFlags: [] }`, `sale.totals.totalMinor === 935n`,
  `sale.session.businessDate === '2026-09-28'`.
- `discountMinor: '5'` on the line → `{ ok: false, hard: 'invalid_payload' }`, detail contains
  `lines.0.discountMinor`.
- `quantity: 0` → `invalid_payload`.
- `unitPriceMinor: '1'` at the CURRENT menu version, totals recomputed to match → `price_tamper`,
  detail `line:<lineId>:unit_price`.
- the same at `menuVersion: current − 1` (bump the real version first with `updateItem` to a new
  price, then send the OLD price with the OLD version) → `{ ok: true }` with
  `softFlags: ['stale_menu_price']`.
- totals `taxMinor: '86', totalMinor: '936'` (amount `'936'`, change `'64'`) → `ok: true`,
  `softFlags: ['totals_mismatch']`.
- `menuItemId: randomUUID()` → `unknown_item`, detail = that id.
- a modifier from the unlinked "Extras" group on the Tea line → `unknown_modifier`, detail
  `<lineId>:<syrupId>`; the linked "Oat milk" modifier with `priceDeltaMinor '50'` and totals
  `900/0/90/990` → `ok: true`, no flags.
- `method: 'card'` (tendered/change null, amount `'935'`) with `accepts_card` still null →
  `invalid_payload`, detail `tender_not_accepted`; after
  `db.update(restaurantSettings).set({ acceptsCard: true }).where(eq(restaurantSettings.restaurantId, restaurantId))`
  (the `.where` is not optional — without it every restaurant's settings row changes) → `ok: true`.
- `ctx.occurredAt` = receivedAt + 10 minutes → `ok: true`, `softFlags: ['clock_ahead']`.
- Wren as `employeeId` → `ok: true`, `softFlags: ['employee_not_permitted']`; `randomUUID()` →
  `['employee_unknown']`.
- `invoiceNumber: 'POS9-000001'` → `invalid_payload`, detail `invoice_number_mismatch`;
  `posSessionId: randomUUID()` → `unknown_session`.
- the session row updated to `status: 'closed'` → `ok: true`, `softFlags: ['session_closed']`.

**Done when:** `pnpm test:integration src/lib/server/orders/validate.integration.test.ts` passes
and `pnpm check` passes.

**Watch out:** never read live prices to CHANGE the sale — only to flag; the recorded numbers are
the device's (spec 6). Every money comparison is `bigint === bigint`: never `==` against the wire
string, never `Number()`. A stale snapshot whose prices still match is NOT a flag; only a differing
number at the SAME version is tamper. Archived items and archived modifiers are valid sale lines.
The hard/soft split is load-bearing: everything marked SOFT here is recorded in full by T-19 and
flagged; everything HARD lands as `unrecorded` (cash) or 422 (card/mobile) in T-21 — moving a check
from one class to the other is a plan change, not a tidy-up. `checkEmployee` runs LAST and its
result is a flag, never a return.

### T-19 — `recordSale`: THE payment transaction

**Needs:** T-14, T-15, T-17, T-18
**Files:**
- `src/lib/server/orders/pay.ts` — NEW
- `src/lib/server/orders/pay.integration.test.ts` — NEW
- `src/lib/server/orders/README.md` — EDIT (add a `## Status` section after the bullet list and
  before the line `This module calls \`accounting/\`, …`)
**Spec:** 13 (the payment transaction: "Record Payment(s) → Finalize Totals → Record Invoice Number →
Deduct Inventory → Create Invoice → Create Journal Entries (sale + COGS) → Mark Order PAID"; "For an
offline cash sale … the same transaction runs on the server when the sale syncs"), 6 (a recorded
fact; the device's numbers win), 22 and 24 (cash sale: Dr Cash on Hand / Cr Sales Revenue, Tax
Payable; card or mobile: Dr Payment Clearing; cost of food sold: Dr COGS / Cr Inventory), 10 and 17
(business date is the POS session's)
**Invariants:** 4 (ONE all-or-nothing transaction, at payment, in spec 13's order — this function runs
inside the caller's and never opens one), 2 (posted records are permanent: the ONLY update is
`orders.status` open → paid), 3 (entries balance in the database), 1 (bigint minor units), 7 (each line
snapshots its own price and rate), 10 (audit rows in the same transaction), 11 (business date from
the session, never from a timestamp), 6 (the inventory step is present, as T-17's no-op)

**Do:**
1. Export:

   ```ts
   export async function recordSale(
     tx: DbTx,
     ctx: SyncContext,
     sale: ParsedSale,
     softFlags: SoftFlag[]
   ): Promise<{ orderId: string; invoiceNumber: string; entryIds: string[] }>
   ```

   Import `SyncContext`, `ParsedSale`, `SoftFlag` from `./validate`; `consumeForSale` from
   `../inventory/consume`; `postEntry` from `../accounting/journal` and `saleLines`, `cogsLines`
   from `../accounting/posting-rules` (T-13, T-14); `writeAudit` from `../audit`; the table objects
   `orders`, `orderLines`, `orderLineModifiers`, `payments`, `invoices` from the schema file T-06
   created (see 02-schema.md for its path and the declared column names). `eventForMethod` from
   `../accounting/posting-rules` (T-13) — never a private copy; the rule table must not silently
   post an unknown tender.
2. Step 1 — the order and its lines (spec 13's "Order BILLED (or takeaway ready to pay)" is the
   device's state; here the order first exists): insert `orders` with `id = sale.orderId`,
   `restaurant_id = ctx.restaurantId`, `pos_session_id = sale.posSessionId`,
   `device_id = ctx.opDeviceId`, `employee_user_id = ctx.employeeUserId` (NEVER null here: T-06
   declares the column NOT NULL, and T-21 step 3.7 rejects an `employee_unknown` sale as HARD
   `invalid_payload` before it calls this function), `order_type`, `table_label`, `status = 'open'`, `tax_mode`,
   `currency_code`, `menu_version`, `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`
   (all from `sale.totals`, as bigint), `flag_reason = softFlags.length ? softFlags.join(',') : null`,
   `opened_at = sale.openedAt`, `paid_at = ctx.occurredAt` (the device's time of the sale, spec 6 —
   not `now()`). Insert `order_lines` one per `sale.lines[]` with `id = lineId`,
   `restaurant_id = ctx.restaurantId`, `order_id = sale.orderId` (both NOT NULL: `tenant()` and the
   composite FK `order_lines_order_fk`), `line_no`, `menu_item_id`, `item_name`, `quantity`,
   `unit_price_minor`, `tax_rate_bp` (the RESOLVED rate the device used), `discount_minor = 0n`,
   `status = 'new'`; and `order_line_modifiers` one per modifier with
   `restaurant_id = ctx.restaurantId` (NOT NULL via `tenant()` and `order_line_modifiers_line_fk`),
   `order_line_id`, `modifier_id`, `modifier_name`, `price_delta_minor`. The payload's ids are the
   row ids so a replay can never create a second copy under a fresh id.
3. Step 2 — record payment(s): insert `payments` with `id = sale.payment.paymentId`, `order_id`,
   `restaurant_id`, `method`, `amount_minor`, `tendered_minor`, `change_minor` (null for
   card/mobile), `paid_at = ctx.occurredAt`. T-06's `payments` has NO `device_id` column (its
   columns are id, restaurant_id, order_id, method, amount_minor, tendered_minor, change_minor,
   paid_at, received_at, created_at); the device is on `orders` and `invoices`.
4. Step 3 — finalize totals: the stored totals ARE the device's numbers written in Step 1 (the
   `orders` insert) — price at time of sale wins, spec 6. The server recomputation already happened
   in `validateSale`, and a disagreement is already the `totals_mismatch` soft flag on
   `flag_reason`. Nothing is recomputed here; say so in a comment at this step so nobody "fixes" it.
5. Step 4 — record the invoice number: insert `invoices` with `restaurant_id`, `order_id`,
   `device_id = ctx.opDeviceId`, `invoice_seq = sale.invoiceSeq`, `invoice_number = sale.invoiceNumber`,
   `total_minor = sale.totals.totalMinor` (bigint NOT NULL in T-06), `issued_at = ctx.occurredAt`.
   A 23505 on `invoices_device_number_unique` or
   `invoices_device_seq_unique` is a genuine collision in the device namespace: DO NOT catch it —
   let it propagate and roll everything back; T-21 maps it to HARD `invoice_collision`.
6. Step 5 — deduct inventory (today `[]` and `0n`, T-17):

   ```ts
   const { cogsMinor } = await consumeForSale(tx, {
     restaurantId: ctx.restaurantId,
     orderId: sale.orderId,
     lines: toSaleLines(sale.lines) // back to the wire shape: every Minor as a decimal string
   });
   ```
7. Step 6 — create the invoice: the row inserted in Step 4 is the invoice. Spec 13 and the
   overview's R8 list "Record Invoice Number" → "Deduct Inventory" → "Create Invoice" as three
   steps; this plan deliberately COLLAPSES the first and third into the Step 4 insert, because the
   invoice row IS the record of the number, so the row lands before `consumeForSale` runs. The
   departure is harmless (both steps are inside the one transaction, and the inventory step reads
   nothing from `invoices`) and is stated here so nobody moves the insert to "match the spec" and
   nobody inserts a second row. Write that as the comment at this step.
8. Step 7 — post journal entries. First the sale:

   ```ts
   const event = eventForMethod(sale.payment.method);
   const saleEntry = await postEntry(tx, {
     restaurantId: ctx.restaurantId,
     businessDate: sale.businessDate,
     event,
     sourceType: 'order',
     sourceId: sale.orderId,
     memo: `Sale ${sale.invoiceNumber}`,
     lines: saleLines(event, {
       subtotal: sale.totals.subtotalMinor,
       discount: sale.totals.discountMinor,
       tax: sale.totals.taxMinor,
       total: sale.totals.totalMinor
     })
   });
   ```

   Spec 24 with spec 23's names: `Dr 1000 Cash on Hand` (cash), `Dr 1020 Payment Clearing – Card`
   (card) or `Dr 1030 Payment Clearing – Mobile Money` (mobile) for the total, `Dr 4100 Sales
   Discounts` for the discount (always `0n` in this plan and dropped by the writer), `Cr 4000 Sales
   Revenue` for the subtotal, `Cr 2100 Tax Payable` for the tax. Then, ONLY when `cogsMinor > 0n`:

   ```ts
   const cogsEntry = await postEntry(tx, {
     restaurantId: ctx.restaurantId,
     businessDate: sale.businessDate,
     event: 'cost_of_goods_sold',
     sourceType: 'order',
     sourceId: sale.orderId,
     memo: `COGS ${sale.invoiceNumber}`,
     lines: cogsLines(cogsMinor)
   });
   ```

   `Dr 5000 Cost of Goods Sold / Cr 1200 Inventory`. `postEntry` returns `null` when every line is
   zero (a sale of free items only) — then `entryIds` is simply shorter; that is correct, not an
   error. Collect the non-null `entryId`s.
9. Step 8 — mark PAID, the ONE status change in the whole function, spec 13's "Mark Order PAID":

   ```ts
   await tx
     .update(orders)
     .set({ status: 'paid', updatedAt: new Date() })
     .where(and(eq(orders.id, sale.orderId), eq(orders.restaurantId, ctx.restaurantId)));
   ```
10. Step 9 — audit, both rows with `restaurantId: ctx.restaurantId`, `deviceId: ctx.opDeviceId`,
    `occurredAt: ctx.occurredAt`, `ip: ctx.ip`, `userAgent: ctx.userAgent`,
    `actorUserId: ctx.employeeUserId`, `subjectUserId: null`:
    `sale.recorded` with `clientOpId: ctx.clientOpId` and details `{ deviceCode: ctx.opDeviceCode,
    invoiceNumber, orderType, method, totalMinor: sale.totals.totalMinor.toString() }`;
    and, only when `softFlags.length > 0`, `sale.flagged` with `clientOpId: null` and details
    `{ deviceCode, invoiceNumber, flags: softFlags }`. The null is not optional: the partial unique
    index `audit_log_device_client_op_unique` allows ONE row per `(device_id, client_op_id)`.
11. Return `{ orderId: sale.orderId, invoiceNumber: sale.invoiceNumber, entryIds }`. The function
    never catches, never prints (spec 11 printing is local and never inside this transaction), never
    opens a transaction, and never reads `menu_items` or `restaurant_settings`.
12. README `## Status`: `pay.ts` holds THE payment transaction (`recordSale`), run inside the
    caller's transaction in spec 13's order; `sync.ts` (T-21) is its only caller and owns the
    transaction boundary; `validate.ts` (T-18) turns a queued `sale.complete` into a `ParsedSale`
    and its flags. Not built here: the server-side OPEN/BILLED lifecycle, split and merge bills,
    voids of SENT items, refunds, comps, re-opening a paid order, and printing.

**Tests:** (integration, `pay.integration.test.ts`) Fixture as in T-18 (restaurant +
`onRestaurantCreated`, which after T-12 also seeds the chart of accounts; settings exclusive /
1000 bp / USD; `accepts_card` and `accepts_mobile` set true directly; device `POS1`; an open session
with `business_date '2026-09-28'`; Sam the cashier; Wren the waiter; menu items priced to fit each
case). A helper `recordThrough(env, employeeId)` runs the REAL path in one transaction:

```ts
db.transaction(async (tx) => {
  const v = await validateSale(tx, ctx, env);
  if (!v.ok) throw new Error(v.hard);
  return recordSale(tx, ctx, v.sale, v.softFlags);
});
```

Read journal lines through a join of `journal_entry_lines` to `accounts` on `account_id`, selecting
`accounts.code`, `debit_minor`, `credit_minor`.
- MANDATORY (spec 29 — posting rules per business event, through the real path): a cash sale of two
  lines, `600 × 1` and `200 × 2`, both `taxRateBp 1000`, exclusive; totals `1000 / 0 / 100 / 1100`;
  cash tendered `2000`, change `900` → `orders`: one row, `status 'paid'`, `subtotal_minor 1000n`,
  `tax_minor 100n`, `total_minor 1100n`, `flag_reason null`, `paid_at` = `ctx.occurredAt`;
  `order_lines` 2; `payments` 1 with `amount_minor 1100n`, `tendered_minor 2000n`,
  `change_minor 900n`; `invoices` 1 with `invoice_seq 1`, `invoice_number 'POS1-000001'`,
  `device_id` = the device, `total_minor === 1100n`; `journal_entries` 1 with `event 'cash_sale'`, `source_type 'order'`,
  `source_id` = the order id, `business_date '2026-09-28'`, `memo 'Sale POS1-000001'`; its lines:
  `1000` debit `1100n`, `4000` credit `1000n`, `2100` credit `100n`, no other line; `audit_log`: one
  `sale.recorded` with `device_id` = the device, `client_op_id` = the envelope's, `actor_user_id` =
  Sam, `details.totalMinor '1100'`; zero `sale.flagged` rows.
- MANDATORY (spec 29 — posting rules per event): the same sale paid by `card` → the debit line's
  account code is `1020` (`1100n`), `event 'card_sale'`; by `mobile` → `1030`, `event 'mobile_sale'`.
- soft flags: the cash sale with Wren as employee → recorded in full, `orders.flag_reason
  'employee_not_permitted'`, plus a `sale.flagged` audit row with `details.flags
  ['employee_not_permitted']` and `client_op_id null`, beside the `sale.recorded` row.
- MANDATORY (spec 29 — offline sync / invariant 4 rollback): a restaurant created WITHOUT
  `onRestaurantCreated`, so it has NO chart of accounts. The no-chart fixture, spelled out because
  `recordThrough` runs `validateSale` first and needs everything that reads: insert a `restaurants`
  row and a `restaurant_settings` row DIRECTLY (`tax_mode 'exclusive'`, `tax_rate_bp 1000`,
  `currency_code 'USD'`, `time_zone 'UTC'`); insert an owner user directly (`role: 'owner'`, an
  email, a placeholder `passwordHash`) — `registerDevice` checks the actor is an owner of that
  restaurant; `registerDevice(tx, { restaurantId, actorUserId: ownerId, label: 'Counter' })`; insert
  an open `pos_sessions` row directly (as in T-18's fixture); create one item through `../menu`
  (`createCategory`, `createItem` priced to the case); and call
  `seedStaff(db, restaurantId, { displayName: 'Sam' })` WITHOUT `roleName` — PR #11's `seedStaff`
  THROWS `No live role named "Cashier"` when `roleName` is passed and no such role exists, and
  seeds a Cashier role of its own only when called without `roleName`/`roleId`. Then
  `recordThrough` rejects (T-14's `postEntry` throws on a code with no account row) and afterwards
  `orders`, `order_lines`, `payments`, `invoices`, `journal_entries`, `journal_entry_lines` and
  `audit_log` hold ZERO rows for that restaurant. (An equivalent seam — stubbing `consumeForSale`
  to throw — is not needed.)
- 0 % tax: one line `500 × 1` at `taxRateBp 0`, totals `500 / 0 / 0 / 500` → the entry has exactly
  two lines, `1000` debit `500n` and `4000` credit `500n` (the zero `2100` line is dropped by the
  writer); Σdebit = Σcredit = `500n`.
- MANDATORY (spec 29 — tax in both modes, entries balance): settings switched to `inclusive` at
  `2000` bp (bump through `updateSettings`; T-29's version bump is not needed here — send
  `menuVersion` = the current version); one line `999 × 1` at `taxRateBp 2000`, totals
  `832 / 0 / 167 / 999` → `1000` debit `999n`, `4000` credit `832n`, `2100` credit `167n`, and
  `sum(debit_minor) === sum(credit_minor) === 999n` for the entry.
- the order's status is the only update: after the cash case, `orders.updated_at >= created_at`
  and a second `recordSale` for the same `ParsedSale` inside a new transaction rejects with a 23505
  on the orders primary key and leaves the row counts unchanged.

**Done when:** `pnpm test:integration src/lib/server/orders/pay.integration.test.ts` passes and
`pnpm check` passes.

**Watch out:** the `orders.status` update is the ONLY update in this function — `invoices` and
`payments` carry append-only triggers from T-09, so an accidental second write to either fails
loudly rather than silently. Seed every bigint sum with `0n`; a `bigint + number` throws at runtime
and a `Number(total)` is the float invariant 1 forbids. The business date comes from the SESSION row
(`sale.businessDate`), never from `ctx.occurredAt` (invariant 11). `employee_user_id` and the audit
`actor_user_id` take `ctx.employeeUserId`; T-06 declares `orders.employee_user_id` NOT NULL, and
T-21 step 3.7 guarantees the value is non-null by the time this function runs (an
`employee_unknown` sale is HARD `invalid_payload` there and never reaches `recordSale`). Do not
invent a placeholder user and do not make the column nullable here — that would be a change to
02-schema.md T-06. Only `sale.recorded` carries `clientOpId`; `sale.flagged` must not.

### T-20 — The session module: open (attach), close (expected cash, over/short), business date in SQL

**Needs:** T-14, T-15
**Files:**
- `src/lib/server/pos-sessions/index.ts` — NEW
- `src/lib/server/pos-sessions/README.md` — NEW
- `src/lib/server/pos-sessions/sessions.integration.test.ts` — NEW
**Spec:** 10 (a POS session: opening cash → sales → count → reconciliation; "Expected Cash";
"Difference = −$10 … posts it to the Cash Over/Short account"; "Every POS session belongs to one
business date"; close "requires a connection and an empty sync queue"), 17 (timestamps in UTC; the
restaurant's time zone is a setting; reports group by business date), 24 ("Cash shortage at session
close: Debit Cash Over/Short, Credit Cash on Hand"; "Cash overage at session close: Debit Cash on
Hand, Credit Cash Over/Short"), 6 (unsynced work blocks a close — here the server refuses while an
unrecorded op references the session)
**Invariants:** 11 (business date, not calendar date — computed IN SQL in the restaurant's zone), 3
(the over/short entry balances in the database), 2 (the close writes the close columns of an OPEN
row once; no posted record is edited), 10 (audit rows in the same transaction), 1 (bigint), 4 (every
function takes the caller's `tx`)

**Do:**
1. Types and errors:

   ```ts
   export type SessionContext = {  // structurally IDENTICAL to SyncContext in orders/validate.ts
     restaurantId: string; cookieDeviceId: string; opDeviceId: string; opDeviceCode: string;
     employeeId: string; employeeUserId: string | null; clientOpId: string;
     occurredAt: Date; receivedAt: Date; ip: string | null; userAgent: string | null;
   };
   export type OpenSessionPayload = { posSessionId: string; openingCashMinor: Minor };
   export type CloseSessionPayload = { posSessionId: string; countedCashMinor: Minor };
   export type OpenResult = { posSessionId: string; businessDate: string; attached: boolean };
   export type CloseResult = {
     posSessionId: string; businessDate: string;
     expectedCashMinor: Minor; countedCashMinor: Minor; differenceMinor: Minor;
   };
   export class SessionNotFound extends Error { constructor(public readonly posSessionId: string) { super(`no session ${posSessionId}`); } }
   export class SessionAlreadyClosed extends Error { constructor(public readonly posSessionId: string) { super(`session ${posSessionId} is closed`); } }
   export class SessionHasUnrecordedOps extends Error { constructor(public readonly count: number) { super(`${count} unrecorded operation(s) reference this session`); } }
   ```

   `SessionContext` is declared here rather than imported because `orders/sync.ts` (T-21) calls
   this module and this module must never import `orders/` (a cycle, and the layering rule in the
   overview). T-21 passes its `SyncContext` to these functions unchanged — the shapes are the same,
   and T-21's test pins that with a type-level assignment. Imports: `DbTx` from `../db/client`;
   `Executor` from `../auth/session`; `minor`, `subtract`, `type Minor` from `../../money`;
   `postEntry` from `../accounting/journal` and `overShortLines`, `overShortEvent` from
   `../accounting/posting-rules` (T-13, T-14); `writeAudit` from `../audit`; `sql` from
   `drizzle-orm`; the `posSessions`, `posSyncOps`, `orders`, `payments` and `restaurantSettings`
   table objects from their schema files (T-05, T-07, T-06 and the existing
   `../db/schema/restaurant-settings`).
2. `openSession(tx: DbTx, ctx: SessionContext, payload: OpenSessionPayload): Promise<OpenResult>`:
   1. Serialise opens for one device:
      `` await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.opDeviceId}))`) ``.
      A `select … for update` locks nothing when no open row exists yet, so two racing opens for a
      brand-new device would both insert; the transaction-scoped advisory lock closes that gap and
      releases itself at commit or rollback.
   2. Select `id, business_date, opening_cash_minor` from `pos_sessions` where
      `restaurant_id = ctx.restaurantId` and `device_id = ctx.opDeviceId` and `status = 'open'`,
      `.for('update').limit(1)`.
   3. If one exists — ATTACH (R6: one open session per device; the till may have queued a second
      open after a reload): write `pos.session.opened` with `attached: true`, details
      `{ deviceCode: ctx.opDeviceCode, businessDate: existing.business_date, openingCashMinor:
      existing.opening_cash_minor.toString(), attached: true }`,
      `actorUserId: ctx.employeeUserId`, `subjectUserId: null`, `deviceId: ctx.opDeviceId`,
      `clientOpId: ctx.clientOpId`, `occurredAt: ctx.occurredAt`; return
      `{ posSessionId: existing.id, businessDate: existing.business_date, attached: true }`. Insert
      nothing; the payload's `openingCashMinor` is ignored (the drawer was counted once).
   4. Else read `time_zone` from `restaurant_settings` for `ctx.restaurantId` in the same
      transaction, and insert `pos_sessions` with `id = payload.posSessionId`,
      `restaurant_id`, `device_id = ctx.opDeviceId`, `opened_by_user_id = ctx.employeeUserId`
      (NEVER null here: T-05 declares the column NOT NULL, and T-21 step 3.7 rejects a
      `session.open` whose employee is unknown as HARD `invalid_payload` before calling this
      function), `opened_at = ctx.occurredAt`,
      `business_date = sql\`(${ctx.occurredAt.toISOString()}::timestamptz at time zone ${timeZone})::date\``,
      `opening_cash_minor = payload.openingCashMinor`, `status = 'open'`, and
      `.returning({ businessDate: posSessions.businessDate })` — the column is `date` in mode
      `'string'` (T-05), so it comes back as `'YYYY-MM-DD'`. `timestamptz AT TIME ZONE <zone>`
      yields the wall-clock time in that zone; casting it to `date` is the business date. It is
      computed by PostgreSQL, never by JavaScript — no `toLocaleDateString`, no date library.
   5. Audit `pos.session.opened` with `attached: false` and the inserted values; return
      `{ posSessionId: payload.posSessionId, businessDate, attached: false }`.
3. `expectedCash(tx: Executor, restaurantId: string, posSessionId: string): Promise<Minor>` — one
   SQL statement:

   ```sql
   select s.opening_cash_minor
        + coalesce(sum(p.amount_minor) filter (where p.method = 'cash' and o.status = 'paid'), 0)
        as expected
   from pos_sessions s
   left join orders o   on o.pos_session_id = s.id and o.restaurant_id = s.restaurant_id
   left join payments p on p.order_id = o.id and p.restaurant_id = o.restaurant_id
   where s.id = $1 and s.restaurant_id = $2
   group by s.id, s.opening_cash_minor
   ```

   `pg` returns int8 as a STRING (no type parsers, by design) → `minor(BigInt(row.expected))`.
   No row → throw `SessionNotFound`. Refunds, pay-ins and pay-outs are zero in this plan (R6);
   when their plans land they join this one statement.
4. `closeSession(tx: DbTx, ctx: SessionContext, payload: CloseSessionPayload): Promise<CloseResult>`:
   1. Select `id, device_id, business_date, status` from `pos_sessions` where
      `id = payload.posSessionId` and `restaurant_id = ctx.restaurantId`, `.for('update')`. No row →
      throw `SessionNotFound`. Any live device of the restaurant may close it — the session's own
      `device_id` is NOT required to equal `ctx.opDeviceId` (a revoked tablet's session is closed
      from its replacement); the closing device is recorded as `closed_from_device_id = ctx.cookieDeviceId`.
   2. `status === 'closed'` → throw `SessionAlreadyClosed`.
   3. Count `pos_sync_ops` where `restaurant_id = ctx.restaurantId` and `pos_session_id = id` and
      `status = 'unrecorded'` and `resolved_at is null` → `count > 0` → throw
      `SessionHasUnrecordedOps(count)` (T-21 maps it to `409 { error: 'session_has_unrecorded_ops', count }`).
      A cash sale the server could not record is cash in the drawer with no revenue posted; closing
      over it would book that cash to 6800 as an overage. The owner retries or dismisses the op on
      `/reports/flagged` first.
   4. `expected = await expectedCash(tx, ctx.restaurantId, id)`;
      `difference = subtract(payload.countedCashMinor, expected)` (from `../../money`).
   5. ONE update of the locked row, and only because it is still open:

      ```ts
      await tx
        .update(posSessions)
        .set({
          status: 'closed',
          closedAt: ctx.occurredAt,
          closedByUserId: ctx.employeeUserId,
          closedFromDeviceId: ctx.cookieDeviceId,
          countedCashMinor: payload.countedCashMinor,
          expectedCashMinor: expected,
          differenceMinor: difference
        })
        .where(and(eq(posSessions.id, id), eq(posSessions.status, 'open')));
      ```

      These columns are written once, on an open row; nothing here ever updates a closed session
      (invariant 2).
   6. When `difference !== 0n`:

      ```ts
      await postEntry(tx, {
        restaurantId: ctx.restaurantId,
        businessDate: session.businessDate,
        event: overShortEvent(difference)!, // non-null because the call is guarded by difference !== 0n
        sourceType: 'pos_session',
        sourceId: id,
        memo: 'Session close',
        lines: overShortLines(difference)
      });
      ```

      Spec 24: shortage `Dr 6800 Cash Over/Short |d| / Cr 1000 Cash on Hand |d|`; overage
      `Dr 1000 Cash on Hand d / Cr 6800 Cash Over/Short d`. A zero difference posts NOTHING (skip
      the call; `overShortLines(0n)` is `[]` and `postEntry` would return `null` anyway).
   7. Audit `pos.session.closed`, details `{ deviceCode: ctx.opDeviceCode, businessDate,
      expectedCashMinor: expected.toString(), countedCashMinor: payload.countedCashMinor.toString(),
      differenceMinor: difference.toString() }`,
      `actorUserId: ctx.employeeUserId`, `deviceId: ctx.opDeviceId`, `clientOpId: ctx.clientOpId`,
      `occurredAt: ctx.occurredAt`.
   8. Return `{ posSessionId: id, businessDate, expectedCashMinor: expected, countedCashMinor:
      payload.countedCashMinor, differenceMinor: difference }`.
5. Export `openSession`, `closeSession`, `expectedCash`, the three error classes and the types.
   Nothing here opens a transaction, prints, or reads the dashboard principal.
6. README: what the module is (a cashier shift: opening float → sales → count → reconciliation;
   distinct from the auth session); who calls it (`orders/sync.ts` only; it calls `accounting/`
   and `audit/` only, and never `orders/`); invariant 11 in words (a sale belongs to the business
   date of its session, computed in SQL in the restaurant's time zone — 01:30 belongs to the
   previous evening); spec 10's expected-cash formula and the 6800 posting; that close is refused
   while an unrecorded op references the session; and that CLAUDE.md's "Where code lives" gains
   this directory in T-40.

**Tests:** (integration) Fixture: restaurant + `onRestaurantCreated` (chart seeded) + owner; time
zone set through `updateSettings(tx, restaurantId, { timeZone }, { actorUserId: ownerId, ip: null,
userAgent: null })` (four arguments — the last is `UpdateSettingsContext`); a device `POS1`; Sam the cashier; a `ctx` helper with
`employeeUserId = Sam`. Paid orders are inserted DIRECTLY for these tests (an `orders` row with
`status 'paid'`, the session id, the required snapshot columns — `tax_mode 'exclusive'`,
`currency_code 'USD'`, `menu_version 1`, totals — and a `payments` row with the method and amount;
`recordSale`'s own test covers the real sale path). Amounts in cents.
- MANDATORY (spec 29 — posting rules per business event, through the real path): open with
  `openingCashMinor 50000n`; insert a paid order with a cash payment of `150000n`;
  `closeSession` with `countedCashMinor 199000n` → `expectedCashMinor 200000n`,
  `differenceMinor -1000n`; one `journal_entries` row with `event 'cash_shortage_at_close'`,
  `source_type 'pos_session'`, `source_id` = the session id, `business_date` = the session's,
  `memo 'Session close'`; lines: `6800` debit `1000n`, `1000` credit `1000n`; the `pos_sessions`
  row has `status 'closed'`, `counted_cash_minor 199000n`, `expected_cash_minor 200000n`,
  `difference_minor -1000n`, `closed_from_device_id` = the device. (Spec 10's own example includes
  refunds and pay-outs, which are zero in this plan — the same shape, different numbers.)
- MANDATORY (spec 29 — posting rules per event): counted `201000n` → `+1000n`, `event
  'cash_overage_at_close'`, `1000` debit `1000n` / `6800` credit `1000n`.
- exact count `200000n` → `differenceMinor 0n` and ZERO `journal_entries` rows with
  `source_id` = the session.
- a paid order with a `card` payment of `50000n` beside the cash one → expected is still
  `200000n`; `expectedCash` alone returns `200000n`.
- an unrecorded op: insert a `pos_sync_ops` row with `pos_session_id` = the session,
  `status 'unrecorded'`, `resolved_at null` → `closeSession` rejects with `SessionHasUnrecordedOps`
  and `count === 1`, the session stays `open`, no entry posted; after setting `resolved_at` and
  `resolution 'dismissed'` on that row, the close succeeds.
- closing twice → the second rejects with `SessionAlreadyClosed`; a session of another restaurant
  → `SessionNotFound`; a close from a SECOND registered device of the same restaurant (register
  `POS2`) succeeds with `closed_from_device_id` = `POS2`'s id.
- attach: `openSession` twice for the same device with different `posSessionId`s and `clientOpId`s
  → the second returns `{ posSessionId: <first id>, attached: true }`; `pos_sessions` holds ONE
  row; `audit_log` holds two `pos.session.opened` rows, the second with `details.attached true`.
- business date, computed by PostgreSQL: time zone `'America/New_York'`, `occurredAt
  2026-09-29T03:30:00Z` → `businessDate '2026-09-28'` (23:30 the evening before, EDT); time zone
  `'Asia/Tokyo'`, `2026-09-28T16:30:00Z` → `'2026-09-29'`; `'UTC'`, `2026-09-28T23:59:59Z` →
  `'2026-09-28'`.

**Done when:** `pnpm test:integration src/lib/server/pos-sessions/sessions.integration.test.ts`
passes and `pnpm check` passes.

**Watch out:** never compute the business date in JavaScript — `new Date().getDate()`,
`toLocaleDateString` and any date library are wrong here even when they agree today. Never post an
over/short entry for flagged-unrecorded cash: the close is refused (409) instead, so the owner
resolves the op first. `expectedCash` sums `payments.amount_minor` of PAID orders with `method =
'cash'` only; card and mobile takings are in clearing accounts, not the drawer. The close writes its
columns ONCE on a row locked `for update` and still `open`; the second close finds `closed` and
throws. The audit row `pos.session.closed` carries `clientOpId` (it is the op's fact row); a
`SessionAlreadyClosed` path writes NO audit row (T-21 answers from the existing state).
`opened_by_user_id` / `closed_by_user_id` take `ctx.employeeUserId`, and it is never null on
either path: T-05 declares `opened_by_user_id` NOT NULL (and its close CHECK requires
`closed_by_user_id` on a closed row), T-21 step 3.7 rejects an unknown employee on `session.open`
as HARD `invalid_payload` before `openSession` runs, and `session.close` is request-class, so its
`checkEmployee` pre-gate answers `403` for an unknown employee before `closeSession` runs. Do not
make either column nullable here — that would be a change to 02-schema.md T-05.

### T-21 — `handleOp`: dispatch, replay, device lineage, outcome mapping, unrecorded storage, retry and dismiss

**Needs:** T-19, T-20
**Files:**
- `src/lib/server/orders/sync.ts` — NEW
- `src/lib/server/orders/sync.integration.test.ts` — NEW
**Spec:** 6 ("Idempotency keys. Every operation carries a unique ID generated on the device, so the
server ignores duplicates when a sync is retried"; "Problems are flagged, not dropped … stored and
flagged for owner review, never discarded"; device-scoped invoice numbers), 8 (403 for an
unauthorised employee), 10 (a close needs the server; refused while work is unrecorded), 13 (the
same transaction runs on sync), 29 ("Offline sync: retries never create duplicates")
**Invariants:** 5 (a completed offline cash sale is a fact; a retry is a no-op; the device's
sequence is never renumbered), 4 (one transaction owns the whole recording), 8 (server-side
permission; 403 only where the tender allows it), 10 (audit rows in the same transaction), 12 (the
tenant is the registered device's; the actor is the op's employee, never a dashboard cookie), 2
(`pos_sync_ops` is a sync log — its status changes on retry/dismiss are not edits of a posted record;
T-07's schema comment says so)

**Do:**
1. Types and imports. `HandleResult`, widened by exactly one status the overview's HTTP list already
   carries (422) and one extra body property the till ignores:

   ```ts
   export type HandleResult =
     | { http: 200; body: SyncResult & { alreadyClosed?: true } }
     | { http: 400 | 403 | 409 | 422; body: { error: string; flag?: string; count?: number } };
   export class HardFailure extends Error { constructor(public readonly flag: HardFlag, public readonly detail: string) { super(`${flag}: ${detail}`); } }
   class Refused extends Error { constructor(public readonly result: HandleResult) { super('refused'); } } // 403/409 carriers
   ```

   The `400` member is carried because the overview's `HandleResult` contract lists it, but
   `handleOp` NEVER returns it — `400 { error: 'invalid_request' }` is the route's own answer (T-27
   owns it, for an envelope the server cannot key); nothing in this file constructs a 400.
   Imports: `type SyncContext`, `type HardFlag`, `type SoftFlag`, `validateSale` from `./validate`
   (`HardFailure` above is typed with `HardFlag`, so the type import is not optional); `recordSale`
   from `./pay`; `openSession`,
   `closeSession`, `SessionNotFound`, `SessionAlreadyClosed`, `SessionHasUnrecordedOps` and
   `type SessionContext` from `../pos-sessions`; `checkEmployee` from `../permissions`;
   `writeAudit` from `../audit`; `formatInvoiceNumber`, `OP_KINDS`, `PAYMENT_METHODS` and the
   types from `../../sync-ops`; `minor` from `../../money`; `type Db` from `../db/client`;
   `type PosDeviceContext` from `../auth/pos-context`; `z` from `zod`; the `posSyncOps` (T-07),
   `posDevices`, `posSessions` (T-05) and `users` table objects from their schema files.
   Pin the shape contract once: `const _ctxCompat: SessionContext = {} as SyncContext;` (exported
   as `_SessionContextIsSyncContext` so lint does not flag it) — a compile error here means the two
   types drifted.
2. Small server-only zod schemas for the four non-sale payloads (T-18 owns the sale schema); a
   failure → `HardFailure('invalid_payload', detail)`:

   ```ts
   const cashString = z.string().regex(/^[0-9]{1,15}$/);
   const sessionOpen = z.object({ posSessionId: z.uuid(), openingCashMinor: cashString });
   const sessionClose = z.object({ posSessionId: z.uuid(), countedCashMinor: cashString });
   const saleAbandoned = z.object({
     orderId: z.uuid(),
     invoiceSeq: z.number().int().min(1).max(999999),
     invoiceNumber: z.string().max(15),
     reason: z.enum(['rejected', 'cancelled'])
   });
   const pinLogin = z.object({ outcome: z.enum(['success', 'failed']) });
   ```
3. The handler:

   ```ts
   export async function handleOp(
     db: Db,
     device: PosDeviceContext,
     request: { ip: string | null; userAgent: string | null },
     envelope: OpEnvelope<OpKind, unknown>
   ): Promise<HandleResult>
   ```

   T-27's route has already proven `kind ∈ OP_KINDS`, `clientOpId`, `deviceId`, `employeeId`
   (uuids), `occurredAt` (ISO string) and `seq` (integer) are present; `payload` is opaque here.
   1. `receivedAt = new Date()`; `occurredAt = new Date(envelope.occurredAt)`; an invalid date is a
      `HardFailure('invalid_payload', 'occurredAt')` handled by the class rule in step 8.
   2. REPLAY, before anything else: select `pos_sync_ops` where `device_id = envelope.deviceId`
      and `client_op_id = envelope.clientOpId` and `restaurant_id = device.restaurantId`. Found →

      ```ts
      { http: 200, body: { clientOpId, status: 'replayed', flag: row.flag ?? undefined,
          error: row.error ?? undefined, posSessionId: row.posSessionId ?? undefined,
          businessDate, expectedCashMinor, differenceMinor } }
      ```

      — `businessDate` from the session row when `pos_session_id` is set; the two close numbers
      from that session's `expected_cash_minor` / `difference_minor` (as decimal strings) when
      `kind = 'session.close'` and the session is closed. Nothing is written. (The restaurant scope
      means a key that exists under another restaurant's device is "not found" here and falls to
      the lineage check, which answers 409.)
   3. LINEAGE: select `id, restaurant_id, device_code, revoked_at` from `pos_devices` where
      `id = envelope.deviceId`. Missing, or `restaurant_id !== device.restaurantId` →
      `{ http: 409, body: { error: 'foreign_device' } }`, nothing stored and no audit row (there is
      no tenant to write it under). Revoked but same restaurant → CONTINUE: the op is recorded under
      the OLD device — its invoice namespace, its `device_id` on every row — because a revoke-and-
      re-register reset must not strand or renumber a queue (overview, blocker 4).
   4. EMPLOYEE: select `id` from `users` where `id = envelope.employeeId` and
      `restaurant_id = device.restaurantId` → `employeeUserId = row?.id ?? null`.
   5. Build the context (`opDevice` is the `pos_devices` row from 3.3):

      ```ts
      const ctx: SyncContext = {
        restaurantId: device.restaurantId,
        cookieDeviceId: device.deviceId,
        opDeviceId: envelope.deviceId,
        opDeviceCode: opDevice.deviceCode,
        employeeId: envelope.employeeId,
        employeeUserId,
        clientOpId: envelope.clientOpId,
        occurredAt,
        receivedAt,
        ip: request.ip,
        userAgent: request.userAgent
      };
      ```
   6. CLASS: `requestClass = kind === 'session.close' || (kind === 'sale.complete' &&
      ['card', 'mobile'].includes(peekMethod(envelope.payload)))`, where `peekMethod` reads
      `payload?.payments?.[0]?.method` leniently and returns `null` for anything else. Everything
      not request-class is FACT-class (`sale.complete` with cash or an
      unreadable tender, `session.open`, `sale.abandoned`, `pin.login`): recorded and flagged,
      never refused. Pre-transaction gate for the request class only:
      `session.close` → `checkEmployee(db, restaurantId, employeeId, ['pos.payment'])` —
      `['pos.payment']` for both session kinds (`session.open` checks it in step 3.7): assumption 6
      of 00-overview.md, no new key coined; a card/mobile
      `sale.complete` → `checkEmployee(db, …, ['pos.sell', 'pos.payment'])`; a failure →
      `{ http: 403, body: { error: 'not_permitted' } }`, NOTHING stored. (For a cash sale the same
      check runs inside `validateSale` and becomes a soft flag.)
   7. THE TRANSACTION — `db.transaction(async (tx) => { … })`, returning the 200 body:
      - First statement: insert the `pos_sync_ops` row using EXACTLY T-07's columns — `restaurant_id`,
        `device_id = ctx.opDeviceId`, `received_via_device_id = ctx.cookieDeviceId` (NOT NULL in
        T-07; its header: `device_id` is the device the op was STAMPED with, `received_via_device_id`
        the cookie's device), `client_op_id`, `kind`, `status = 'accepted'`, `flag = null`,
        `error = null`, `payload` = the WHOLE envelope as received (`kind`, `clientOpId`, `deviceId`,
        `employeeId`, `occurredAt`, `seq`, `payload`)
        (so `retryOp` can rebuild it exactly, and an unknown `employeeId` survives even though the
        typed column is null; the envelope's `seq` stays inside `payload`; no column carries
        it), `employee_user_id = ctx.employeeUserId`, `occurred_at`,
        `received_at`, and the keyable ids peeked leniently from the payload (uuid-shaped strings
        only, else null): `pos_session_id` = the payload's `posSessionId` whenever it is a
        uuid-shaped string, REGARDLESS of whether that session row exists — T-07 declares the column
        with NO foreign key precisely because an `unrecorded` op may name a session that was never
        written, and T-20's close guard counts unrecorded ops by this very column (there is no FK to
        violate, so an id of a session that does not exist yet is stored as-is); `invoice_seq` and
        `invoice_number` when present; `order_id` stays null until `recordSale` has inserted the
        order. Keep the returned `id`.
      - Dispatch by `kind`:
        - `sale.complete`: `v = await validateSale(tx, ctx, envelope)`; `!v.ok` →
          `throw new HardFailure(v.hard, v.detail)`; then `ctx.employeeUserId === null` →
          `throw new HardFailure('invalid_payload', 'employee_unknown')` — the rule `pin.login`
          already uses: T-06 declares `orders.employee_user_id` NOT NULL, so the `employee_unknown`
          soft flag `validateSale` emits can never be recorded, and a typed hard failure beats a raw
          23502 `database_error` on the review page; `r = await recordSale(tx, ctx, v.sale, v.softFlags)`;
          update the op row `order_id = r.orderId`, `pos_session_id = v.sale.posSessionId`,
          `invoice_seq`, `invoice_number`; soft flags → `status = 'recorded_flagged'`,
          `flag = v.softFlags.join(',')`. Body: `{ clientOpId, status, flag?, posSessionId:
          v.sale.posSessionId, businessDate: v.sale.businessDate }`.
        - `session.open`: parse; `ctx.employeeUserId === null` →
          `throw new HardFailure('invalid_payload', 'employee_unknown')` (T-05 declares
          `pos_sessions.opened_by_user_id` NOT NULL — same rule as above); `check = await
          checkEmployee(tx, …, ['pos.payment'])`; soft flags = `[check.reason]` when it fails
          (`employee_inactive` or `employee_not_permitted` — `employee_unknown` was already thrown)
          plus `'clock_ahead'` when `occurredAt − receivedAt > 5 min`;
          `o = await openSession(tx, ctx, { posSessionId, openingCashMinor: minor(BigInt(s)) })`;
          op row `pos_session_id = o.posSessionId`, status/flag as above. Body: `{ clientOpId,
          status, flag?, posSessionId: o.posSessionId, businessDate: o.businessDate }`.
        - `session.close`: parse;
          `c = await closeSession(tx, ctx, { posSessionId, countedCashMinor: minor(BigInt(s)) })`;
          catch `SessionHasUnrecordedOps` → `throw new Refused({ http: 409, body: { error:
          'session_has_unrecorded_ops', count: e.count } })` (rolls the op row back — the till
          retries after the owner resolves); catch `SessionAlreadyClosed` → read the closed row and
          return `{ clientOpId, status: 'accepted', alreadyClosed: true, posSessionId, businessDate,
          expectedCashMinor, differenceMinor }` (the op row stays, status `accepted`, so a retry
          replays); catch `SessionNotFound` → `throw new HardFailure('unknown_session', posSessionId)`.
          Success body: `{ clientOpId, status: 'accepted', posSessionId, businessDate:
          c.businessDate, expectedCashMinor: c.expectedCashMinor.toString(), differenceMinor:
          c.differenceMinor.toString() }`; op row `pos_session_id`.
        - `sale.abandoned`: parse; `invoiceNumber !== formatInvoiceNumber(ctx.opDeviceCode, invoiceSeq)`
          → `HardFailure('invalid_payload', 'invoice_number_mismatch')`; op row `invoice_seq`,
          `invoice_number`; `writeAudit` `sale.abandoned` details
          `{ deviceCode: ctx.opDeviceCode, invoiceNumber, reason }`, `actorUserId: ctx.employeeUserId`,
          `deviceId: ctx.opDeviceId`, `clientOpId: ctx.clientOpId`, `occurredAt`. Body
          `{ clientOpId, status: 'accepted' }`. (This is how the server explains a hole in the
          device's gap-free sequence: the number was taken by a card sale the server rejected or the
          cashier cancelled.)
        - `pin.login`: parse; `ctx.employeeUserId === null` →
          `HardFailure('invalid_payload', 'employee_unknown')` (a row about nobody is never written —
          the online verifier does the same); `writeAudit` `pos.pin.offline_success` details
          `{ deviceCode }` or `pos.pin.offline_failed` details `{ deviceCode, reason: 'bad_pin' }`,
          with `actorUserId: ctx.employeeUserId`, `subjectUserId: ctx.employeeUserId`,
          `deviceId: ctx.opDeviceId`, `clientOpId: ctx.clientOpId`, `occurredAt: ctx.occurredAt`
          (spec 6: the device time of the login, not the sync time). Body
          `{ clientOpId, status: 'accepted' }`.
   8. ERROR MAPPING, in a `catch` around the transaction. Walk the `cause` chain (Drizzle wraps the
      pg error — copy the `isDuplicateOpKey` idiom from `src/routes/api/pos/pin/+server.ts`) and
      classify:
      - `Refused` → return `e.result` (the 409 above).
      - `23505` on `pos_sync_ops_device_client_op_unique` or `audit_log_device_client_op_unique` →
        a racing retry committed first: rerun step 2 (the replay lookup). Found → return its
        `replayed` answer. NOT found (possible only for the audit index: the clash came from an
        `audit_log` row that already carries this `(device_id, client_op_id)` while this op's own
        row was rolled back with the transaction) → there is no answer to replay, so treat it as
        `HardFailure('database_error', constraintName)` and continue down the class path below
        (422 for the request class, `storeUnrecorded` for the fact class). Never loop and never
        return `undefined`.
      - `23505` on `invoices_device_number_unique` or `invoices_device_seq_unique` →
        `HardFailure('invoice_collision', constraintName)`.
      - `HardFailure` → as thrown.
      - anything else → `HardFailure('database_error', message.slice(0, 500))`.
      Then the HARD path by class. REQUEST class (card/mobile `sale.complete`, `session.close`) →
      `{ http: 422, body: { error: 'rejected', flag } }` and NOTHING stored — the till has not
      completed a card sale until the 200 arrives (it records `sale.abandoned` next), and a close is
      reconciliation the server has not performed. CONTRACT WIDENING, recorded here on purpose: the
      overview's HTTP list gives 422 only for a card/mobile `sale.complete`; this file ALSO answers
      `422 { error: 'rejected', flag }` for a `session.close` that fails a HARD check
      (`unknown_session`, `invalid_payload`, `database_error`), with nothing stored. The overview's
      contract block is to carry the same sentence so the two briefs agree. Till-side consequence
      (06-offline-queue.md T-25 step 8 parks any non-sale 422): the close sits PARKED on the till
      with its flag in permanent chrome, and its recovery is: the owner resolves the cause on
      `/reports/flagged` (for `unknown_session`, retrying the `unrecorded` `session.open` that names
      the session creates it) and then re-issues the close from the till once the session exists on
      the server; the parked op is never silently retried and never dropped. FACT class (cash
      `sale.complete`, `session.open`, `sale.abandoned`, `pin.login`) →
      `storeUnrecorded(db, ctx, envelope, failure)`: its OWN small `db.transaction` (the failed one
      is gone) that inserts the `pos_sync_ops` row with T-07's columns — `restaurant_id`,
      `device_id = ctx.opDeviceId`, `received_via_device_id = ctx.cookieDeviceId`, `client_op_id`,
      `kind`, `status = 'unrecorded'`, `flag = failure.flag`, `error = failure.detail`, the whole
      envelope as `payload` (the envelope's `seq` stays inside `payload`; no column carries it),
      `employee_user_id`, `occurred_at`, `received_at`, `invoice_seq`/`invoice_number` when
      parseable, `pos_session_id` = the payload's `posSessionId` whenever it is a uuid-shaped string
      (stored whether or not that session exists — no FK, and the close guard depends on it),
      `order_id` null; then `writeAudit` `sync.op_unrecorded` details `{ deviceCode, kind, flag, detail }`,
      `actorUserId: ctx.employeeUserId`, `deviceId: ctx.opDeviceId`, `clientOpId: null`,
      `occurredAt: ctx.occurredAt`. Its own `23505` on the op unique → replay (step 2). Answer
      `{ http: 200, body: { clientOpId, status: 'unrecorded', flag, error: detail } }` — a 200,
      because the fact is now stored server-side and the till may clear it from its queue.
   9. The answer to the till is built from what the transaction RETURNED, after it committed — a
      rolled-back attempt can never have had an `accepted` answer sent for it.
4. The owner's retry:

   ```ts
   export async function retryOp(
     db: Db,
     restaurantId: string,
     opId: string,
     actorUserId: string,
     request: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null }
   ): Promise<
     | { ok: true; status: 'accepted' | 'recorded_flagged' }
     | { ok: false; reason: 'not_found' | 'still_unrecorded'; flag?: HardFlag; detail?: string }
   >
   ```

   1. Select the op where `id = opId`, `restaurant_id`, `status = 'unrecorded'`, `resolved_at is null`
      → none → `{ ok: false, reason: 'not_found' }`. Only fact-class ops are ever unrecorded, so
      a retry never meets a 403/409/422 path.
   2. Rebuild `envelope` from the `payload` jsonb (the whole envelope was stored) and `ctx` from the
      row: `opDeviceId = cookieDeviceId = row.device_id`, `opDeviceCode` from `pos_devices`,
      `employeeId` from the envelope, `employeeUserId` re-resolved as in 3.4, `occurredAt = row.occurred_at`,
      `receivedAt = new Date()`, `ip`/`userAgent` from the dashboard request.
   3. Run the SAME dispatch (factor step 3.7's body into `dispatch(tx, ctx, envelope, op)` where
      `op` is `{ mode: 'insert' } | { mode: 'update'; id }`) inside one `db.transaction`: in update
      mode the first statement UPDATES the existing row — `status = 'accepted'`, `flag = null`,
      `error = null`, `resolved_at = now()`, `resolved_by_user_id = actorUserId`,
      `resolution = 'retried'`; `received_via_device_id` is left exactly as stored (the retry comes
      from the dashboard, not a device, and the column records the ORIGINAL receipt) — and the
      dispatch then links `order_id`/`pos_session_id` and sets
      `recorded_flagged` exactly as on first receipt. SAME `client_op_id`, NO second row. Inside the
      transaction, `writeAudit` `sync.op_retried` details `{ opId, outcome: <the new status> }`,
      `actorUserId`, `deviceId: row.device_id`, `clientOpId: null`, `ip`, `userAgent`.
   4. A `HardFailure` again → the transaction rolled back, the row is unchanged (still
      `unrecorded`); in a small separate transaction update only `error = detail` and write
      `sync.op_retried` with `outcome: 'unrecorded'`; return
      `{ ok: false, reason: 'still_unrecorded', flag, detail }`. Nothing is posted.
5. The owner's dismiss, `dismissOp(db: Db, restaurantId: string, opId: string, actorUserId: string,
   reason: string, request = { ip: null, userAgent: null })`, returning
   `{ ok: true } | { ok: false; reason: 'not_found' | 'invalid_reason' }`:
   `reason` trimmed, 1–200 characters (else `{ ok: false, reason: 'invalid_reason' }`); in one
   transaction update the row where `id`, `restaurant_id`, `status in ('recorded_flagged',
   'unrecorded')`, `resolved_at is null` → `resolved_at = now()`, `resolved_by_user_id = actorUserId`,
   `resolution = 'dismissed'` (zero rows updated → `{ ok: false, reason: 'not_found' }`); write
   `sync.op_dismissed` details `{ opId, reason }`, `deviceId: row.device_id`, `clientOpId: null`.
   Nothing is posted; the status is never changed by dismiss, so the report can still list it as
   dismissed. Return `{ ok: true }`. (T-37's actions call `retryOp`/`dismissOp` after
   `requireOwner`.)

**Tests:** (integration, `sync.integration.test.ts`) Fixture as in T-19 (restaurant A with chart,
settings, menu, device `POS1`, an open session created THROUGH `handleOp` with a `session.open` op
carrying `openingCashMinor '0'` so the whole flow is real, Sam, Wren) plus restaurant B with its own
owner and device; `device` =
`{ restaurantId: A, deviceId, deviceCode: 'POS1' }`; `request = { ip: '203.0.113.7', userAgent: 'till' }`;
a helper `sale(overrides)` returning a `sale.complete` envelope (`clientOpId: randomUUID()`,
`deviceId`, `employeeId: Sam`, `occurredAt: new Date().toISOString()`, `seq`, a well-formed cash
payload against the open session with `invoiceSeq` counting up) — cash `935` for Tea as in T-18.
Count rows with `select count(*)::int` per table, scoped to the restaurant.
- MANDATORY (spec 29 — offline sync: retries never create duplicates): the SAME envelope twice →
  first `{ http: 200, body.status: 'accepted' }`, second `{ http: 200, body.status: 'replayed' }`;
  `orders` 1, `invoices` 1, `journal_entries` 1 (3 lines), `pos_sync_ops` 1, `audit_log`
  `sale.recorded` 1.
- MANDATORY (spec 29 — retries never duplicate, concurrently):
  `Promise.all([handleOp(db, device, request, env), handleOp(db, device, request, env)])` with one
  envelope → both `http 200`; one body `accepted` and the other `replayed` (or both
  replayed-equivalent); the same counts of ONE as above. (The test handle from `testDb()` is a
  pool, so the two calls run on two connections; the loser's 23505 on
  `pos_sync_ops_device_client_op_unique` is what the replay branch maps.)
- foreign device: an envelope whose `deviceId` is restaurant B's device, sent with A's `device`
  context → `{ http: 409, body: { error: 'foreign_device' } }`; `pos_sync_ops`, `orders` and
  `audit_log` rows for that `clientOpId` are ZERO in A and in B.
- revoked device of the same restaurant: register `POS1`, `revokeDevice`, register `POS2`; send an
  op with `deviceId = POS1`, `invoiceNumber 'POS1-000001'`, cookie context = `POS2` → `200
  accepted`; `invoices.device_id` = POS1's id and `invoice_number 'POS1-000001'`;
  `orders.device_id` = POS1; the `sale.recorded` audit row's `device_id` = POS1; the
  `pos_sync_ops` row has `device_id` = POS1's id and `received_via_device_id` = POS2's id.
- unknown employee, cash: `sale({ employeeId: randomUUID() })` → `{ http: 200, body: { status:
  'unrecorded', flag: 'invalid_payload', error: 'employee_unknown' } }`; ZERO `orders`;
  `pos_sync_ops` 1 with `status 'unrecorded'`, `employee_user_id null`, `payload.employeeId` = the
  random id (the fact survives in the jsonb even though nobody it names exists).
- cash + Wren → `200 { status: 'recorded_flagged', flag: 'employee_not_permitted' }`; `orders` 1
  with `flag_reason 'employee_not_permitted'`; `pos_sync_ops.status 'recorded_flagged'` with
  `order_id` set; `audit_log` has one `sale.recorded` and one `sale.flagged`.
- card + Wren (`accepts_card` true) → `{ http: 403, body: { error: 'not_permitted' } }`; ZERO
  `orders`, ZERO `pos_sync_ops`, ZERO audit rows for that `clientOpId`.
- unknown session, cash (`posSessionId: S = randomUUID()`) → `{ http: 200, body: { status:
  'unrecorded', flag: 'unknown_session' } }`; `pos_sync_ops` 1 with `status 'unrecorded'`,
  `flag 'unknown_session'`, `payload` deep-equal to the envelope, `invoice_seq 1`,
  `invoice_number 'POS1-000001'`, `pos_session_id` = S (the id the sale NAMED, stored although no
  such session exists — that is what lets the close guard count it), `order_id null`,
  `received_via_device_id` = the cookie device; ZERO `orders`; one `sync.op_unrecorded` audit row
  with `client_op_id null`.
- unknown session, card → `{ http: 422, body: { error: 'rejected', flag: 'unknown_session' } }`;
  ZERO rows of any kind for that `clientOpId`.
- session.close with an unrecorded op: a cash sale with `unitPriceMinor '1'` at the current menu
  version against the REAL session → `unrecorded` with `flag 'price_tamper'` and `pos_session_id`
  set; then a `session.close` op (Sam, `countedCashMinor '0'`) →
  `{ http: 409, body: { error: 'session_has_unrecorded_ops', count: 1 } }` and NO `pos_sync_ops`
  row for the close's `clientOpId`; after `dismissOp`, the same close → `200 accepted` with
  `expectedCashMinor '0'` (the fixture's opening float is `'0'` and the tampered sale recorded no
  payment) and `differenceMinor '0'`.
- The next THREE cases run WITHOUT the fixture's pre-opened session, because `openSession` ATTACHES
  to any open session of the device (T-20 step 2.3, `pos_sessions_one_open_per_device`): with the
  fixture's session open, a `session.open` naming another id would return the fixture's id and never
  create the named session, and a `'50000'` float would attach to the `'0'`-float session. Put them
  in a `describe('with no open session for POS1')` whose `beforeEach` FIRST closes the fixture's
  session through `handleOp` — `session.close` by Sam with `countedCashMinor '0'` (opening float
  `'0'`, no sales yet → `expectedCashMinor '0'`, `differenceMinor '0'`, nothing posted) — so every
  case in it starts from a device with no open session and the whole flow is still real.
- retryOp (in that describe): the unknown-session cash op naming `S` as above; then `session.open`
  THROUGH `handleOp` with `posSessionId: S` (as the till's own preceding op would have carried) →
  `200 accepted` with `posSessionId` = S and `attached` not set (a NEW session); then
  `retryOp(db, A, opId, ownerId)` → `{ ok: true, status: 'accepted' }`; the row is FLIPPED in place:
  `status 'accepted'`, `resolution 'retried'`, `resolved_by_user_id` = owner, `order_id` set;
  `pos_sync_ops` rows for `(device, clientOpId)` = 1; `orders` 1; `journal_entries` 1; an audit
  `sync.op_retried` row with `details.outcome 'accepted'`. Retrying it again → `not_found`.
- dismissOp with reason `'Training sale'` → `resolved_at` set, `resolution 'dismissed'`, `status`
  still `unrecorded`; a `sync.op_dismissed` audit row with `details.reason 'Training sale'`; ZERO
  `orders` and ZERO `journal_entries` for it.
- dismissOp on a `recorded_flagged` op (the cash + Wren sale above) → `{ ok: true }`, `resolution
  'dismissed'`, `resolved_at` set, `status` still `'recorded_flagged'`, one `sync.op_dismissed`
  audit row. (T-37 renders Dismiss on every listed op and tests exactly this.)
- pin.login twice with the same `clientOpId` (`outcome 'success'`, Sam) → ONE
  `pos.pin.offline_success` audit row with `device_id`, `client_op_id`, `occurred_at` = the
  envelope's `occurredAt`; second answer `replayed`. `outcome 'failed'` → one
  `pos.pin.offline_failed` row with `details.reason 'bad_pin'` and no `failedCount` key.
- open fails hard, the sale names the session, the owner retries the open, the close is refused (in
  that describe; this is the double-count the overview's first blocker exists to prevent):
  `db.update(restaurantSettings).set({ timeZone: 'Not/AZone' }).where(eq(restaurantSettings.restaurantId, A))`
  — a DIRECT write, past `updateSettings`' validation, so T-20's `at time zone` SQL raises
  (SQLSTATE 22023) — then `session.open` (Sam, `posSessionId: S2 = randomUUID()`,
  `openingCashMinor '0'`) → `200 { status: 'unrecorded', flag: 'database_error' }` and its
  `pos_sync_ops` row carries `pos_session_id` = S2; a cash sale (Sam, `posSessionId: S2`, next
  `invoiceSeq`) → `200 { status: 'unrecorded', flag: 'unknown_session' }` with `pos_session_id` = S2;
  restore the zone (`set({ timeZone: 'UTC' })`, same `.where`); `retryOp(db, A, <the open's opId>,
  ownerId)` → `{ ok: true, status: 'accepted' }` and `pos_sessions` now holds S2, `status 'open'`;
  `session.close` (Sam, `posSessionId: S2`, `countedCashMinor '935'`) →
  `{ http: 409, body: { error: 'session_has_unrecorded_ops', count: 1 } }` and no `pos_sync_ops` row
  for the close's `clientOpId` — the cash in the drawer is NOT booked to 6800; then `retryOp(db, A,
  <the sale's opId>, ownerId)` → `{ ok: true, status: 'accepted' }` (dismissing it instead would
  also unblock the close); the same close again → `200 accepted` with `expectedCashMinor '935'`,
  `differenceMinor '0'`, and ZERO `journal_entries` with `source_id` = S2.
- session lifecycle through `handleOp` (in that describe): `session.open` (`openingCashMinor
  '50000'`) → `200 accepted` with `posSessionId` and `businessDate`; a second `session.open` with a NEW `posSessionId` → `200
  accepted` with the FIRST id (attach); `session.close` (`countedCashMinor '50000'`) → `200 accepted`
  with `expectedCashMinor '50000'`, `differenceMinor '0'`; the same close again (same `clientOpId`)
  → `replayed` carrying the same two numbers; a close with a NEW `clientOpId` → `200` with
  `alreadyClosed: true`; `session.close` by Wren → `403 not_permitted`, nothing stored.
- `sale.abandoned` (`invoiceSeq 2`, `'POS1-000002'`, `reason 'rejected'`) → `200 accepted`;
  `pos_sync_ops` row with `invoice_seq 2`; one `sale.abandoned` audit row; ZERO `orders`.
- type pin: `const c: SessionContext = ctx as SyncContext` compiles (`pnpm check`).

**Done when:** `pnpm test:integration src/lib/server/orders/sync.integration.test.ts` passes,
`pnpm test:integration` passes as a whole, and `pnpm check` and `pnpm lint` pass.

**Watch out:** the unrecorded store MUST run OUTSIDE the failed transaction — a new
`db.transaction` — because the failed one has already been rolled back and its handle is dead. The
`pos_sync_ops` insert MUST be the first statement INSIDE the business transaction so a rollback
leaves no `accepted` row behind. Build the answer AFTER the transaction returns, never inside the
callback. Walk the `cause` chain when classifying 23505 — the constraint name is on the pg error,
not on Drizzle's wrapper. Scope the replay lookup by restaurant. Only the fact row of an op carries
`clientOpId` in `audit_log`; `sync.op_*` and `sale.flagged` rows pass `clientOpId: null` or the
partial unique index kills the transaction. `pos_session_id` on an unrecorded row is set whenever
the payload names a uuid-shaped session id, whether or not that session exists — T-07 declares NO
foreign key on it for exactly this reason, and T-20's close guard counts by it: a row left null
here lets `session.close` succeed once the owner retries the open, books the drawer cash to 6800 as
an overage, and then double-posts Dr 1000 when the sale is retried. Never map a cash
sale to 422 and never map a card sale to `unrecorded`: the tender decides the class, connectivity
never does. `retryOp` UPDATES the existing row under the same `client_op_id`; a second row would
be the duplicate spec 29 forbids.
