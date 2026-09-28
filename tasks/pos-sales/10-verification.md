# Phase 6 — verification, e2e and docs (T-38 … T-41)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: Phase 0 (`01-decisions.md`),
> Phase 1 (`02-schema.md`), Phase 2 (`03-money.md`, `04-accounting.md`,
> `05-orders-sessions-sync.md`), Phase 3 (`06-offline-queue.md`), Phase 4 (`07-sync-api.md`) and
> Phase 5 (`08-pos-screens.md`, `09-dashboard.md`) — every earlier phase.

Every unit and integration test in this plan ships inside the task that writes the code it tests:
T-10's totals tests live beside `computeOrderTotals`, T-14's balance tests beside the journal
writer, T-21's replay tests beside the sync handler. Nothing in this file is a test a domain task
deferred. This phase holds only what no single task can own because it spans every layer at once:
two Playwright journeys that drive the PRODUCTION build through the browser, the till's IndexedDB,
`POST /api/pos/sync`, the payment transaction, the ledger and the dashboard report in one run; the
documentation the next plans (printing, approvals, inventory) open before they touch this code; and
one final gate that runs every check, every test and the schema-drift probe in the one order that
leaves the shared test database consistent. The phase's own rules: an e2e assertion is written
against the database's own rows and the screen's own text, never against timing — a wait is always
for the `0 unsynced` text, never a sleep; a spec 29 assertion is never weakened to "at least one";
documentation is appended, never re-litigated — a decision already recorded in `CLAUDE.md` is quoted,
not reworded; and the gate passes only when every command prints what this file says it prints.

**Ground shared by T-38 and T-39** (stated once; both tasks rely on it):

- `playwright.config.ts` runs `pnpm build && pnpm preview --port 4173` against `TEST_DATABASE_URL`
  (`matcami_test`, owner role), with `workers: 1`. Every spec that touches the database calls
  `acquireRunLock()` then `resetDb()` in `test.beforeAll` and `closeResetPool()` in `test.afterAll`
  (`src/lib/server/db/test/reset.ts`); the integration project takes the same advisory lock, so the
  two never interleave — they wait. Never run `pnpm test:e2e` and `pnpm test:integration`
  concurrently by hand either.
- Money on screen comes from `src/lib/money/format.ts`: `formatAmount(minor(2200n), usd)` renders
  `22.00`, `formatMoney` renders `22.00 USD` with a NO-BREAK SPACE before the code, and a negative
  carries a leading U+2212 MINUS SIGN (`−1.00`), never a hyphen. Assert with a regular expression
  on the digits (`/22\.00/`), and NEVER compute a figure in a test: every expected value below is a
  literal.
- `pg` returns a `bigint` column and every `sum()` as a STRING. Compare to `'1100'`, never to
  `1100`, and never wrap a value in `Number()`.
- Spellings. The till's IndexedDB is `matcami-pos`; its stores are `employees`, `settings`, `menu`,
  `offline_logins` (keyPath `clientOpId`) and, from T-22, `orders` (keyPath `id`), `sync_queue`
  (keyPath `clientOpId`), `invoice_sequence` (keyPath `deviceId`), `session` (keyPath `deviceId`).
  The status bar is the `role="status"` element of `src/routes/(pos)/pos/+layout.svelte` (T-30):
  `● Online` or `◆ Offline`, `· N unsynced`, then the employee chip `{displayName} · {roleName}`
  (`The Cashier · Cashier`) or `Nobody signed in`, then the session chip `○ No session` /
  `● Session · business date pending sync` / `● Session · business date YYYY-MM-DD`, which is a
  LINK to `/pos/session` while an employee is signed in and the only navigation the layout offers.
  Landing on `/pos` (employee-select) IS signing out — that page's `onMount` calls `signOut()`
  (T-30 step 9); there is no separate sign-out control. Employee-select's heading is `Who is
  signing in?`; the PIN screen's is `Enter your PIN`; a correct PIN lands on `/pos/session` when
  no session is open and on `/pos/order` when one is (T-31).
- Column names in the SQL below are the ones `02-schema.md` declares (`orders.order_type`,
  `table_label`, `tax_mode`, `currency_code`, `subtotal_minor`, `discount_minor`, `tax_minor`,
  `total_minor`, `paid_at`; `order_lines.unit_price_minor`, `tax_rate_bp`, `quantity`;
  `payments.method`, `amount_minor`, `tendered_minor`, `change_minor`; `invoices.invoice_number`;
  `journal_entries.event`, `business_date`; `journal_entry_lines.account_id`, `line_no`,
  `debit_minor`, `credit_minor`; `accounts.code`; `pos_sessions.status`, `business_date`,
  `opening_cash_minor`, `expected_cash_minor`, `counted_cash_minor`, `difference_minor`;
  `pos_sync_ops.kind`, `status`, `client_op_id`, `device_id`, `invoice_seq`, `order_id`, `flag`;
  `pos_devices.device_code`; `audit_log.event`, `device_id`, `client_op_id`, `occurred_at`). Before
  writing any SQL, `ls src/lib/server/db/schema/` and open the files T-04–T-07 created; the schema's
  spelling wins over this file's if they ever differ, and the schema is never edited to match.

### T-38 — e2e: a full shift, online and offline, syncing exactly once

**Needs:** T-27, T-28, T-31, T-32, T-34, T-36
**Files:**
- `e2e/pos-sale.spec.ts` — NEW
- `e2e/fixtures.ts` — EDIT (append after `pickEmployee()`, currently the last export: `storeRows`
  moved in from `e2e/pos-offline.spec.ts`, then `dbRows` and `closeDbRows`, `completeSettings`,
  `createCategory`, `createMenuItem`, `openSession`, `addItem`, `chooseOrderType`, `payCash`,
  `closeSession`)
- `e2e/pos-offline.spec.ts` — EDIT (ONLY the `storeRows` move: delete the local function under
  the comment `/** Every row of one store in the till's IndexedDB, read inside the page. */` and add
  `storeRows` to the `from './fixtures'` import list; every other line of that file is T-39's)
**Spec:** 6 (a completed offline cash sale is a recorded fact; every operation carries a
device-generated idempotency key so a retried sync is ignored; invoice numbers `POS1-000001` from
the device's gap-free sequence; the unsynced count always on screen), 10 (a POS session with
opening cash, expected cash, the counted difference posted to Cash Over/Short; close needs a
connection and an empty queue; business date), 13 (dine-in / takeaway; the all-or-nothing payment
transaction), 17 (tax-exclusive: 10% added on top; business date, not calendar date), 24 (cash
sale: Debit Cash on Hand, Credit Sales Revenue + Tax Payable; cash shortage at session close:
Debit Cash Over/Short, Credit Cash on Hand), 26 (sales by product, category, payment method, order
type, employee; cashier sessions with opening, expected, actual and difference), 29 ("Offline
sync: retries never create duplicates")
**Invariants:** 1 (money is integer minor units in `bigint`; the test types no float and computes
nothing), 2 (posted records are permanent — the test only reads them), 3 (journal entries balance in
the database), 4 (one all-or-nothing transaction at payment — the rows below exist together or not
at all), 5 (an offline cash sale is a recorded fact; idempotency; the device sequence), 7 (each line
snapshots its own price and tax rate), 10 (sensitive actions are audit-logged in the same
transaction as the action), 11 (business date, not calendar date), 12 (registered device + PIN)

**Do:**

1. Read the screens the helpers drive before writing a locator, and match by ACCESSIBLE NAME only
   (`getByRole`, `getByLabel`, `getByText`) — never a CSS class. Dashboard, each reached by its
   rail link with `exact: true` and never by a typed URL (the fixtures file says why): `Settings`
   → `/settings` with the fields `Tax mode` (a text input with a datalist — type `exclusive`),
   `Tax rate (basis points)`, `Currency code`, the button `Save settings` and the alert `Settings
   saved.`; `POS` → `/device` with the field `Auto-lock after (seconds)`, the button `Save
   auto-lock` and the alert `Auto-lock saved.` (the idle lock lives on `/device`, not `/settings`,
   so `completeSettings` covers both pages); `Menu` → `/menu` with `Category name` + `Add
   category` → alert `<name> added.`, the select labelled `Category`, the fields `Item name` and
   `Price` (MAJOR units as text: `8.00`), the button `Add item` → alert `<name> added.`; `Reports`
   → `/reports` (T-36 gives the rail item its href). Till, as `08-pos-screens.md` specifies them —
   open the four files and confirm each word before using it: `src/routes/(pos)/pos/session/
   +page.svelte` (T-32): heading `Open a session`, a money keypad with keys `1`–`9`, `0`, `⌫`,
   `Clear` whose DIGITS ARE MINOR UNITS (typing `50000` reads `500.00 USD`), the line `Business
   date: YYYY-MM-DD`, the closer `Open session`; in the close view the heading `Close this
   session`, the keypad `Counted cash`, the closer `Close session`, the result rows `Expected`,
   `Counted`, `Difference` with the marks `● Balanced` / `✕ Short` / `▲ Over`, the sentence
   `Nothing was posted` or `The server posted the difference to 6800 Cash Over/Short`, and the
   closer `Done` (which signs out and returns to `/pos`); `src/routes/(pos)/pos/order/+page.svelte`
   (T-33): the order-type segments `Sit now`, `Waiting for a table`, `Takeaway` (a `Sit now` press
   reveals the field labelled `Table`), category tabs (`role="tab"`) over ONE `role="tabpanel"` of
   item keys whose name is the category, the item name and its price, the guest check (a `<table>`
   whose rows carry `◇ NEW`, the quantity, the name, the snapshot line `@ 8.00 · tax 10.00%` and
   the amount; a totals list `Subtotal`, `Tax`, `Total`), and the closer `Pay` with the amount;
   `src/routes/(pos)/pos/pay/+page.svelte` (T-34): heading `Amount due`, the tender group `Tender`
   with keys `Cash`, `Card`, `Mobile money`, `Quick cash` keys (`Exact`, then `12.00 USD`,
   `15.00 USD`, `20.00 USD` for a total of `11.00`), the same money keypad under `Amount tendered`,
   the readout `Change due`, the closer `Pay · Cash`, and the success panel `● Paid`, `Invoice
   POS1-000001`, rows `Total` / `Tendered` / `Change`, closer `New sale`. If a word differs in the
   built file, use the built word; if a control has no accessible name, that is a defect of the
   task that built it (design-system §7, WCAG) — stop and report rather than matching on a class.
2. Move `storeRows`. Cut the function `storeRows<T>(tillPage: Page, store: string): Promise<T[]>`
   out of `e2e/pos-offline.spec.ts` (it opens `indexedDB.open('matcami-pos')` inside
   `tillPage.evaluate` and resolves `getAll()` of one store), paste it into `e2e/fixtures.ts` as
   an `export function`, byte-identical, and import it in `pos-offline.spec.ts` from `./fixtures`.
   `pos-offline.spec.ts` must still compile and pass after this step alone.
3. Add `dbRows` to `e2e/fixtures.ts` — a read-only query against the TEST database, mirroring
   `getPool()` in `src/lib/server/db/test/reset.ts`: `import pg from 'pg'`; a lazily created
   `pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c timezone=UTC' })`;
   throw if `TEST_DATABASE_URL` is unset or its database name does not end in `_test` (copy the
   check verbatim — a query helper that could reach development data is the bug the check
   prevents). `export async function dbRows<T>(text: string, params: unknown[] = []): Promise<T[]>`
   returns `(await pool.query(text, params)).rows`; `export async function closeDbRows()` ends the
   pool. The spec's `test.afterAll` calls `closeDbRows()` and then `closeResetPool()`.
4. Dashboard helpers, each taking the owner's `page`:
   - `completeSettings(page, { taxMode, taxRateBp, currency, idleSeconds }: { taxMode:
     'exclusive' | 'inclusive'; taxRateBp: number; currency: string; idleSeconds: number })`: click
     the `Settings` rail link, expect URL `/\/settings$/`, fill the three fields (rate and seconds
     as `String(n)`), click `Save settings`, expect the alert `Settings saved.`; then click the
     `POS` rail link, expect `/\/device$/`, fill `Auto-lock after (seconds)`, click `Save auto-lock`,
     expect `Auto-lock saved.`.
   - `createCategory(page, name: string)`: `Menu` rail link → `/\/menu$/`, fill `Category name`,
     click `Add category`, expect the alert `${name} added.`.
   - `createMenuItem(page, { category, name, priceMinor }: { category: string; name: string;
     priceMinor: bigint })`: `Menu` rail link, `getByLabel('Category', { exact: true })
     .selectOption({ label: category })`, fill `Item name`, fill `Price` with the MAJOR-unit text
     the page's `parsePriceInput` expects, built by string surgery over the digits — `const d =
     String(priceMinor).padStart(3, '0'); const typed = d.slice(0, -2) + '.' + d.slice(-2);` so
     `800n` types `8.00` and `200n` types `2.00` — NEVER `priceMinor / 100` or any division; click
     `Add item`; expect `${name} added.`. The menu page refuses a price until the currency is set,
     so `completeSettings` must run first.
5. Till helpers, each taking `tillPage`. One local helper `typeMinor(tillPage, amount: bigint)`
   presses, for each character of `String(amount)`, `getByRole('button', { name: digit, exact:
   true })` — exactly what `enterPin` does with a PIN; the keypad's digits are minor units, so
   `50000n` is five presses and reads `500.00 USD`. Each screen shows one keypad at a time, so no
   scoping is needed; if a screen ever shows two, scope the locator to the labelled region.
   - `openSession(tillPage, openingCashMinor: bigint)`: expect URL `/\/pos\/session$/` and the
     heading `Open a session`; `typeMinor`; press `Open session`; expect URL `/\/pos\/order$/`.
   - `addItem(tillPage, name: string)`: `tillPage.getByRole('tabpanel').getByRole('button', {
     name: new RegExp(name) })` — scoped to the tabpanel so the guest check's own text cannot
     match — click it, then expect `tillPage.getByRole('table')` (the check) to contain `name`.
   - `chooseOrderType(tillPage, type: 'Sit now' | 'Waiting for a table' | 'Takeaway', options:
     { tableLabel?: string } = {})`: press `getByRole('button', { name: type, exact: true })`;
     when `options.tableLabel` is given, fill `getByLabel('Table', { exact: true })` with it and
     press Tab (the field's trimmed value becomes the label on change); expect the check heading
     (`role="heading"`, level 2) to read `Sit now · Table 4` / `Sit now` / `Waiting for a table` /
     `Takeaway`.
   - `payCash(tillPage, tenderedMinor: bigint)`: press the `Pay` closer on the order screen —
     `getByRole('button', { name: /^Pay\b/ })` (its name carries the amount) — expect URL
     `/\/pos\/pay$/` and the heading `Amount due`; press `Cash` inside the group named `Tender`
     (`getByRole('group', { name: 'Tender' }).getByRole('button', { name: 'Cash', exact: true })`);
     `typeMinor(tenderedMinor)` on the keypad (typing, not the quick keys, so the helper is
     deterministic for any amount); expect the text `Change due` to be visible; press
     `getByRole('button', { name: /^Pay · Cash/ })`; expect `● Paid` to be visible. Return
     nothing; the caller asserts the invoice number and the change.
   - `closeSession(tillPage, countedCashMinor: bigint)`: from wherever the till is, click the
     session chip link `getByRole('link', { name: /Session · business date/ })` → URL
     `/\/pos\/session$/` and the heading `Close this session`; expect none of the blocking lines
     (`◆ Offline — closing needs a connection`, `operations still syncing`, `from a previous
     registration`) to be present; `typeMinor`; press `Close session`; expect the row `Expected` to
     be visible (the server has answered). Return nothing.
6. Write `e2e/pos-sale.spec.ts` in the shape of `e2e/pos-offline.spec.ts`: imports from
   `@playwright/test`, `../src/lib/server/db/test/reset` and `./fixtures`; a header comment naming
   the journey and the MANDATORY spec 29 assertion; `const OWNER = { name: 'The Sale Cafe', email:
   'owner@sale.test', password: 'a strong enough password' }` (the fixtures' pattern —
   `owner@till.test`, `owner@offline.test`, `owner@worker.test`); `test.beforeAll` →
   `acquireRunLock(); resetDb()`; `test.afterAll` → `closeDbRows(); closeResetPool()`; ONE `test(…)`
   with sequential numbered steps (the journey is order-dependent by nature; independent tests that
   share database state are the flakiest thing a suite can contain). First line of the test body:
   `test.setTimeout(300_000)` — PBKDF2 at 600,000 iterations runs several times and every sync is
   waited for. The idle lock is 120 s and every step below interacts well inside it.
7. Steps 1–5, the set-up, in the owner's `page`: `registerRestaurant(page, OWNER)` (the default
   time zone is `Africa/Mogadishu`); `completeSettings(page, { taxMode: 'exclusive', taxRateBp:
   1000, currency: 'USD', idleSeconds: 120 })`; `createCategory(page, 'Counter')`;
   `createMenuItem(page, { category: 'Counter', name: 'Burger', priceMinor: 800n })` and `{ …,
   name: 'Drink', priceMinor: 200n }`; `createCashier(page, { displayName: 'The Cashier', pin:
   '4321' })`. Then the till: `const till = await browser.newContext(); const tillPage = await
   till.newPage(); await signIn(tillPage, OWNER); await registerDevice(tillPage, OWNER);` and
   `await tillPage.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))` — the
   service worker must control the page before the offline reload of step 13, exactly as
   `pos-offline.spec.ts` step 2 does. The device's code is `POS1` (the restaurant's first device).
8. Step 6, sign in: `pickEmployee(tillPage, 'The Cashier'); enterPin(tillPage, '4321')`; expect
   URL `/\/pos\/session$/` (T-31: no session is open), the status bar to contain `The Cashier ·
   Cashier` and `○ No session`, and the line `getByText(/Business date: \d{4}-\d{2}-\d{2}/)` to be
   visible (T-32 shows the date it EXPECTS; the server derives the real one).
9. Step 7, open: `openSession(tillPage, 50000n)` → `/pos/order`; then wait `await
   expect(tillPage.getByRole('status')).toContainText('0 unsynced')` — the `session.open` op has
   been flushed — and then `toContainText(/Session · business date \d{4}-\d{2}-\d{2}/)`. Read the
   date out of the chip: `const businessDate = /business date (\d{4}-\d{2}-\d{2})/.exec(await
   tillPage.getByRole('status').innerText())![1]`. Assert `select status, opening_cash_minor,
   business_date::text as business_date from pos_sessions` → exactly 1 row, `status = 'open'`,
   `opening_cash_minor = '50000'`, `business_date === businessDate` — the SERVER's derivation in
   the restaurant's time zone is what the chip shows (invariant 11).
10. Step 8, the first sale (online): `addItem(tillPage, 'Burger'); addItem(tillPage, 'Drink')`;
    the check's table contains `@ 8.00 · tax 10.00%` and `@ 2.00 · tax 10.00%` (design-system §6:
    each line shows the price and rate STORED on it — T-33 renders the rate through
    `formatTaxRate`, so `1000` bp is `10.00%`), and the totals list reads Subtotal `10.00`, Tax
    `1.00`, Total `11.00`; `chooseOrderType(tillPage, 'Takeaway')`; `payCash(tillPage, 2000n)`;
    the success panel shows `Invoice POS1-000001` and its `Change` row `9.00 USD`
    (`getByText(/\b9\.00/)` — the `\b` keeps `19.00` from matching); wait for `0 unsynced`; press
    `New sale` → `/pos/order` with an empty check (`0.00` totals).
11. Step 9, the database after sale 1 (all via `dbRows`, all AFTER the `0 unsynced` wait):
    - `orders`: 1 row; `status = 'paid'`, `order_type = 'takeaway'`, `table_label IS NULL`,
      `tax_mode = 'exclusive'`, `currency_code = 'USD'`, `subtotal_minor = '1000'`,
      `discount_minor = '0'`, `tax_minor = '100'`, `total_minor = '1100'`.
    - `order_lines`: 2 rows, `quantity` 1 each, `unit_price_minor` `'800'` and `'200'`,
      `tax_rate_bp = 1000` on both (the RESOLVED rate: the items inherit the restaurant's),
      `discount_minor = '0'`.
    - `payments`: 1 row, `method = 'cash'`, `amount_minor = '1100'`, `tendered_minor = '2000'`,
      `change_minor = '900'`.
    - `invoices`: 1 row, `invoice_number = 'POS1-000001'`, `device_id` = the `pos_devices` row
      whose `device_code = 'POS1'`.
    - `journal_entries`: 1 row, `event = 'cash_sale'`, `business_date::text = businessDate`;
      its `journal_entry_lines`: exactly 3 rows — `select a.code, l.debit_minor::text as debit,
      l.credit_minor::text as credit from journal_entry_lines l join accounts a on a.id =
      l.account_id where l.entry_id = $1 order by l.line_no` — code `1000` (Cash on Hand) debit
      `'1100'` credit `'0'`; code `4000` (Sales Revenue)
      credit `'1000'`; code `2100` (Tax Payable) credit `'100'`; no `4100` line (the discount is
      `0n` and the writer drops zero lines); `sum(debit_minor)::text = sum(credit_minor)::text =
      '1100'`. No COGS entry: `consumeForSale` returns zero cost in this plan, so `select count(*)
      from journal_entries where event = 'cost_of_goods_sold'` is `'0'`.
    - `pos_sync_ops`: exactly 1 row with `kind = 'sale.complete'`, `status = 'accepted'`,
      `invoice_seq = 1`, `order_id` = the order; the `session.open` row is also `accepted`; no row
      has any other status.
    - `audit_log`: exactly 1 row with `event = 'sale.recorded'`, its `device_id` = the POS1 device
      id and its `client_op_id` = the sale op's `client_op_id` (invariant 10: written in the same
      transaction as the sale).
12. Step 10, offline: `await till.setOffline(true)`; expect the status bar to contain `Offline`.
    `addItem` Burger and Drink again; `chooseOrderType(tillPage, 'Sit now', { tableLabel: '4' })`;
    `payCash(tillPage, 1100n)`. The success panel shows `Invoice POS1-000002` IMMEDIATELY (the
    number is the device's, taken in the same IndexedDB transaction as the sale — no server round
    trip happened) and `Change` `0.00 USD`; the status bar says `1 unsynced`. Now, while the entry
    is certainly still queued, capture it: `const queued = await storeRows<{ clientOpId: string;
    kind: string; envelope: { payload: { invoiceNumber: string } } }>(tillPage, 'sync_queue')`;
    `const op = queued.find((q) => q.kind === 'sale.complete' && q.envelope.payload.invoiceNumber
    === 'POS1-000002')`; `expect(op).toBeDefined()` (T-22's `QueueEntry` nests the wire envelope
    under `envelope`; the assertion is on the `clientOpId` and the invoice number). Also register, BEFORE reconnecting, a capture of the flush's request bodies: `const
    syncBodies: string[] = []; tillPage.on('request', (r) => { if (r.method() === 'POST' &&
    r.url().endsWith('/api/pos/sync')) syncBodies.push(r.postData() ?? ''); });`. Press `New
    sale` → `/pos/order`.
13. Step 11, reload offline: `await tillPage.reload()`. The shell comes from the service worker's
    precache and the employee from T-26's mirror (`lastActiveAt` is within the 120 s idle limit).
    Assert: `expect(tillPage.getByRole('heading', { name: 'Who is signing in?' })).toHaveCount(0)`
    (NOT employee-select); the status bar contains `Offline`, `1 unsynced`, `The Cashier ·
    Cashier` and `Session · business date ${businessDate}` (the chip was answered before the till
    went offline); the URL is still `/pos/order`.
14. Step 12, reconnect: `await till.setOffline(false)` (the `online` event is one of T-30's flush
    triggers); `await expect(tillPage.getByRole('status')).toContainText('0 unsynced')`. Then
    assert: `orders` 2 rows, both `paid`, the second `order_type = 'dine_in'` with `table_label =
    '4'`; `invoices` 2 rows, numbers `POS1-000001` and `POS1-000002`, both under the POS1 device;
    `payments` 2 rows; `journal_entries` 2 rows, `journal_entry_lines` 6 rows, and for every entry
    `sum(debit_minor) = sum(credit_minor)`; `pos_sync_ops` with `kind = 'sale.complete'`: 2 rows,
    both `accepted`, `invoice_seq` 1 and 2; `select count(*) from pos_sync_ops where status <>
    'accepted'` = `'0'`; `audit_log` `sale.recorded` rows: 2. Wrap these counts in a local
    `snapshot()` helper returning one object, so step 15 can `toEqual` it.
15. Step 13 — MANDATORY (spec 29 — retries never create duplicates), end to end. `const before =
    await snapshot()`. Three retries, each followed by `expect(await snapshot()).toEqual(before)`:
    (a) the SAME op again, byte-identical, from the page: `const body = syncBodies.find((b) =>
    b.includes('"POS1-000002"'))` — fall back to `JSON.stringify(op.envelope)` (exactly the body
    T-25's flush sends) if the capture is empty — then `const result = await tillPage.evaluate((b) =>
    fetch('/api/pos/sync', { method: 'POST', credentials: 'same-origin', headers: { 'content-type':
    'application/json' }, body: b }).then((r) => r.json()), body)`; `expect(result.status)
    .toBe('replayed')` and `expect(result.clientOpId).toBe(op.clientOpId)` — the server keyed the
    op on `(device_id, client_op_id)` and replayed its stored result; (b) T-30's load trigger:
    `await tillPage.reload()` then wait for `0 unsynced`; (c) T-30's online trigger: `await
    till.setOffline(true); await till.setOffline(false)` then wait for `0 unsynced`. After all
    three: still 2 orders, 2 invoices, 2 payments, 2 entries, 6 lines, 2 `sale.complete` ops, 2
    `sale.recorded` audit rows — exactly `before`.
16. Step 14, close the shift: `closeSession(tillPage, 52200n)`. Expected cash is the opening float
    plus the session's cash payments: `50000 + 1100 + 1100 = 52200`, so the result rows read
    `Expected` `522.00 USD`, `Counted` `522.00 USD`, `Difference` `0.00 USD` with `● Balanced`,
    and the sentence `Nothing was posted`. Wait for `0 unsynced` (the `session.close` op). Assert
    `pos_sessions`: 1 row, `status = 'closed'`, `expected_cash_minor = '52200'`,
    `counted_cash_minor = '52200'`, `difference_minor = '0'`; `journal_entries` still 2 rows — a
    zero difference posts NOTHING (`overShortLines(0n) = []`). Press `Done` → URL `/pos` and the
    status bar reads `Nobody signed in`.
17. Step 15, the shortage variant — a second session on the same till and the same business date.
    Sign in again: `pickEmployee(tillPage, 'The Cashier'); enterPin(tillPage, '4321')` →
    `/pos/session` (the first session is closed, so no local session remains). The drawer still
    holds `52200`, so `openSession(tillPage, 52200n)` → `/pos/order`; make no sale;
    `closeSession(tillPage, 52100n)`; the result rows read `Expected` `522.00 USD`, `Counted`
    `521.00 USD`, `Difference` `−1.00 USD` with `✕ Short` (the U+2212 sign, in the `--danger` ink)
    and the sentence `The server posted the difference to 6800 Cash Over/Short`. Wait for `0
    unsynced`. Assert `pos_sessions`: 2 rows, both `closed`; the second has `opening_cash_minor =
    '52200'`, `expected_cash_minor = '52200'`, `counted_cash_minor = '52100'`, `difference_minor =
    '-100'`; `select count(distinct business_date) from pos_sessions` = `'1'`; `journal_entries`:
    3 rows, the new one `event = 'cash_shortage_at_close'` with exactly 2 lines: code `6800` (Cash
    Over/Short) debit `'100'`, code `1000` (Cash on Hand) credit `'100'`. Press `Done`.
18. Step 16, the report, in the owner's `page` (still signed in from registration — the till's
    registration destroyed the TILL context's dashboard session, not this one; if it has expired,
    `signIn(page, OWNER)`): click the `Reports` rail link, expect URL `/\/reports/`. The default
    date is `businessDate` because the restaurant's most recent session opened within the last 24
    hours (R12); `page.goto('/reports?date=' + businessDate)` shows the same page. Assert, on the
    figures T-36 renders from STORED columns: Gross Sales `20.00`, Discounts `0.00`, Net Sales
    `20.00`, Tax `2.00`, Takings `22.00`; by tender: Cash `22.00` and no card or mobile amount
    other than zero; by order type: dine-in `11.00`, takeaway `11.00`; by employee: `The Cashier`
    `22.00`; by item: the `Burger` row shows quantity `2` and amount `16.00`, the `Drink` row
    quantity `2` and amount `4.00` (T-35's `byItem.amount` is net of tax — `Σ((unit_price_minor +
    Σdelta) × quantity − discount_minor)`, and its test asserts `Σ byItem.amount ===
    totals.grossSales`); by category: `Counter` quantity `4`; sessions: 2 rows — opening `500.00`,
    expected `522.00`, counted `522.00`, difference `0.00`; and opening `522.00`, expected `522.00`,
    counted `521.00`, difference `−1.00`; flagged: `await expect(page.getByRole('alert'))
    .toHaveCount(0)` on `/reports?date=…` (T-36 renders the flagged alert only when `flagged.count
    > 0`, and the page has at most one `role="alert"`), and `/dashboard` carries NO flagged-sales
    alert (T-37's alert is absent).
19. `await till.close()`.

**Tests:**
- MANDATORY (spec 29 — offline sync: retries never create duplicates), end to end (step 15): after
  an offline sale synced on reconnect, re-POSTing its envelope with the same `clientOpId` answers
  HTTP 200 with `status: 'replayed'`, and after that plus a reload-triggered flush plus an
  online-event flush the database holds exactly 2 `orders`, 2 `invoices`, 2 `payments`, 2
  `journal_entries`, 6 `journal_entry_lines`, 2 `pos_sync_ops` of kind `sale.complete` and 2
  `sale.recorded` audit rows — the same object as before the retries.
- Ledger (steps 11, 17): the cash-sale entry has 3 lines — `1000` Dr `1100`, `4000` Cr `1000`,
  `2100` Cr `100` — and the shortage entry has 2 — `6800` Dr `100`, `1000` Cr `100`; every entry's
  `sum(debit_minor) = sum(credit_minor)`; a zero difference writes no entry.
- Facts (steps 12–14): `Invoice POS1-000002` is shown while offline before any server round trip;
  the reload while offline keeps the employee signed in and shows `1 unsynced`; the report's
  Takings `22.00` equals Net Sales `20.00` + Tax `2.00`; the chip's business date equals
  `pos_sessions.business_date`.

**Done when:** `pnpm build && pnpm test:e2e e2e/pos-sale.spec.ts` passes; `pnpm test:e2e` (every
spec, including `pos-offline.spec.ts` now importing `storeRows` from `./fixtures`) passes; and
`pnpm lint` passes.

**Watch out:** The e2e runs against the production build and shares `matcami_test` with the
integration project under the advisory lock — never run both at once, and never point it at
development data. Use the fixtures' owner email pattern (`owner@sale.test`). Never assert on
timing: every database assertion follows an `await expect(status).toContainText('0 unsynced')`,
and a bare `waitForTimeout` anywhere in the file is a defect. Capture the `sync_queue` entry while
OFFLINE — T-25 may prune or mark it once it is accepted. The keypads take MINOR units as digits
(`50000` → `500.00 USD`) while the dashboard's `Price` field takes MAJOR units as text (`8.00`);
build the latter from the digits, never with `/ 100`. `pos_sessions` rows of one run can straddle
midnight in `Africa/Mogadishu` and split across two business dates — a run that does so is rerun,
not weakened. Nothing here `UPDATE`s or `DELETE`s a row: the helper is read-only and the reset is
`resetDb()`'s `TRUNCATE`.

### T-39 — e2e: the three offline-login flush assertions

**Needs:** T-25, T-27, T-30, T-31
**Files:**
- `e2e/pos-offline.spec.ts` — EDIT (the header comment that begins `// THE OFFLINE PIN LOGIN`
  and says the three flush behaviours are "deliberate, not forgotten"; the `./fixtures` import
  list; the PIN-success locators of steps 4–7; step 10 `back online`; step 11 `REVOKED`; a new
  step 12)
- `e2e/pos-access.spec.ts` — EDIT (step 6: the `Signed in as The Cashier` heading assertion at
  the `// The right one.` comment)
- `e2e/fixtures.ts` — EDIT (only if T-38 has not yet run: add `storeRows` and `dbRows`/
  `closeDbRows` exactly as T-38 steps 2–3 specify, once, at the end of the file — never a second
  copy)
**Spec:** 6 ("Offline logins are recorded locally and synced to the audit log"; "Switching employees
offline uses PIN hashes cached on the registered device"; idempotency keys; the unsynced count
always on screen), 7 (PIN rules; the owner can revoke a device from the dashboard), 29 ("Offline
sync: retries never create duplicates")
**Invariants:** 2 (posted records are permanent — the audit rows under POS1 never change), 5 (every
queued operation carries a device-generated idempotency key and a retry is a no-op; unsynced work is
protected), 10 (logins and failed PINs are audit-logged), 12 (POS access is a registered device plus
a PIN; a revoked device is refused)

**Do:**

1. Check `e2e/fixtures.ts` exports `storeRows`, `dbRows` and `closeDbRows`. If it does (T-38 ran),
   import them; if not, add them as T-38 specifies and then import them. Add `closeDbRows()` to this
   spec's `test.afterAll`, before `closeResetPool()`. Delete the local `storeRows` if it is still in
   this file.
2. Rewrite the header comment. Replace the block from `// THIS PLAN DOES NOT BUILD THE SALES SYNC
   QUEUE OR ITS FLUSH` through `// STORE — a real "a retry never duplicates" assertion on a real
   layer.` with:
   ```
   // The sales plan (tasks/pos-sales, T-25) built the flush of offline_logins through
   // POST /api/pos/sync as `pin.login` ops. This spec therefore asserts BOTH halves:
   // the local half (verification against cached hashes, the locally stored record,
   // idempotency at the local store — step 9) and, from step 10, the server half:
   //   1. coming back online writes exactly one audit_log row per offline login —
   //      pos.pin.offline_success or pos.pin.offline_failed — under the device the
   //      record was stamped with and at the record's own occurredAt;
   //   2. flushing again, and replaying the same envelope, writes none;
   //   3. after a revoke and a re-registration as POS2, a new offline login syncs
   //      under POS2's device_id while the old rows keep POS1's.
   // MANDATORY (spec 29 — offline sync: retries never create duplicates).
   ```
   Keep the paragraph about spellings (`pinPhc`, `clientOpId`, `deviceId`) — it is still true.
3. Adapt steps 4–7 to the screens T-31 and T-30 rebuilt, only where the old locators no longer
   exist (check each in `src/routes/(pos)/pos/pin/+page.svelte` and `+layout.svelte` first):
   - the PIN screen shows the `Signed in as …` heading only for the instant before the hand-off
     (T-31 step 5); never assert on it: on success T-31 navigates to `/pos/session` (no session is
     open in this spec). Step 4's `toHaveCount(0)` on `/Signed in/`
     becomes `await expect(tillPage).toHaveURL(/\/pos\/pin/)` (still on the PIN screen, locked).
     Step 5's, 6's and 7's `Signed in as The Cashier` / `The Waiter` expectations become `await
     expect(tillPage).toHaveURL(/\/pos\/session$/)` plus `await expect(tillPage.getByRole('status'))
     .toContainText('The Cashier · Cashier')` (or `The Waiter · Waiter`) — T-30's employee chip.
   - `Back to employee select` was the PIN page's and is gone. Switching employees is now
     `await tillPage.goto(TILL_URL)`: landing on `/pos` IS signing out (T-30 step 9 calls
     `signOut()` in that page's `onMount`), and offline the navigation is answered by the service
     worker's precached shell, exactly as step 7's `reload()` already is while offline. It MUST
     work with a non-empty queue: spec 6 says "Switching employees offline uses PIN hashes cached
     on the registered device", and R11's blocked "logout" is the dashboard/device logout, not the
     employee switch. If T-30 blocks it, that is a T-30 defect — stop and report; do not weaken
     this spec. Keep the assertion that the cached-staff sentence `this is the staff list saved on
     this device` is visible after the offline switch.
   - step 7's reload assertions (`Offline`, `4 unsynced`) stay: after the reload the employee is
     restored from T-26's mirror (`lastActiveAt` within the idle limit) — add `expect(tillPage
     .getByRole('heading', { name: 'Who is signing in?' })).toHaveCount(0)` and the chip
     `The Cashier · Cashier` there.
   - if the till now spells a locally recorded failure `pos.pin.offline_failed` instead of
     `pos.pin.failed` (T-25 may have aligned the store's `event` with the audit event), update the
     one `r.event === 'pos.pin.failed'` assertion in step 8 to the spelling
     `recordOfflineLogin`'s caller writes. Step 8's `synced === false` assertions stay: they run
     BEFORE the flush. T-25 marks a flushed row `synced: true` (`markOfflineLoginSynced` does
     `put({ ...row, synced: true })`; it is never removed), so widen the `OfflineRecord` type's
     `synced` to `boolean` unconditionally.
4. Step 10 — assertion (1), after `await tillPage.goto(TILL_URL)`. Before `till.setOffline(false)`,
   register a capture of the flush's bodies: `const pinBodies: string[] = []; tillPage.on('request',
   (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/pos/sync')) pinBodies.push(
   r.postData() ?? ''); });`. After the `goto`: `await expect(tillPage.getByRole('status'))
   .toContainText('0 unsynced')`. Then query, with `records` (the 4 rows read in step 8) still in
   scope:
   ```sql
   select client_op_id, event, device_id,
          to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at_iso
   from audit_log
   where client_op_id = any($1::text[])
   order by client_op_id
   ```
   with `[records.map((r) => r.clientOpId)]`. Assert: `rows.length === records.length` (4 — two
   successes, two failures); for EVERY record exactly one row has its `clientOpId`, that row's
   `event` is `pos.pin.offline_success` when `record.outcome === 'success'` and
   `pos.pin.offline_failed` when `'failed'` (map by `outcome`; never copy the record's local
   `event` string), its `device_id` equals `record.deviceId`, and its `occurred_at_iso` equals
   `record.occurredAt` exactly (the ISO string the till wrote, millisecond precision). Also
   `select count(*)::text as n from audit_log where event in ('pos.pin.offline_success',
   'pos.pin.offline_failed')` = `'4'` — no keyless extra row.
5. Step 10 — assertion (2), immediately after: `const [{ n: before }] = await dbRows<{ n: string
   }>('select count(*)::text as n from audit_log')`. Then three retries, each followed by the same
   count query and `expect(after).toBe(before)`: (a) `await tillPage.reload()` and wait for
   `0 unsynced` (T-30's load trigger); (b) `await till.setOffline(true); await
   till.setOffline(false)` and wait for `0 unsynced` (the online trigger); (c) replay one envelope
   byte-identical: `const body = pinBodies.find((b) => b.includes('"pin.login"'))` — fall back to
   `JSON.stringify({ kind: 'pin.login', clientOpId, deviceId, employeeId, occurredAt, seq, payload:
   { outcome } })` built from `records[0]` with the `seq` T-25's flush uses, if the capture is
   empty — `POST`ed from the page with `credentials: 'same-origin'` as T-38 step 15 does; expect
   the JSON `status` to be `'replayed'`. The audit count after (c) equals `before` — the partial
   unique index `audit_log_device_client_op_unique` on `(device_id, client_op_id)` and the
   `pos_sync_ops` key both stood.
6. Step 11 — the two post-flush truths. The rows were flushed in step 10, so replace
   `expect(await storeRows<OfflineRecord>(tillPage, 'offline_logins')).toHaveLength(records.length)`
   with `expect((await storeRows<OfflineRecord>(tillPage, 'offline_logins')).filter((r) =>
   r.synced === false)).toHaveLength(0)` (T-25 marks a flushed row `synced: true` and never
   removes it, so the four rows are still there with `synced: true` — what matters is that the
   refused offline attempt on a revoked till added NO unsynced record), and replace
   `` `${records.length} unsynced` `` with `'0 unsynced'`. The `cannot check a PIN offline` alert,
   the empty `employees` store and the refusal to sign in stay exactly as they are.
7. Step 12 (new) — assertion (3). `await till.setOffline(false)`. Re-register the same tablet:
   `await registerDevice(tillPage, OWNER, 'Second tablet')` (the fixture fills `Owner email` and
   `Owner password` on the register screen; if the revoked landing screen shows no `Register this
   device` link, `signIn(tillPage, OWNER)` first, as step 2 did). The new device's code is `POS2`.
   Read both ids: `select id, device_code from pos_devices order by registered_at` → two rows,
   `POS1` (revoked) and `POS2`; keep `pos1Id` and `pos2Id`. Sign `The Cashier` in ONLINE
   (`pickEmployee`, `enterPin '4321'` → `/pos/session`) so the bundle is cached again; `await
   till.setOffline(true)`; `await tillPage.goto(TILL_URL)` (sign out, offline, from the shell);
   `pickEmployee(tillPage, 'The Waiter')`; `enterPin(tillPage, '5678')` → `/pos/session`, status
   `1 unsynced`; read `const newRecords = (await storeRows<OfflineRecord>(tillPage,
   'offline_logins')).filter((r) => r.synced === false)` → exactly 1, with `deviceId === pos2Id`.
   `await till.setOffline(false)`; wait for `0 unsynced`. Assert `select device_id from audit_log
   where client_op_id = $1` for the new record → `pos2Id`; and for each of the 4 old `records` →
   `pos1Id` (unchanged — `audit_log` is append-only and the old rows were never resent under the
   new device). Total offline-PIN audit rows now `'5'`. `await till.close()`.
8. `e2e/pos-access.spec.ts`, step 6 — under the comment `// The right one.`, after `await
   enterPin(tillPage, '4321')`, replace `await expect(tillPage.getByRole('heading', { name:
   /Signed in as The Cashier/ })).toBeVisible()` with `await expect(tillPage).toHaveURL(
   /\/pos\/session$/)` followed by `await expect(tillPage.getByRole('status')).toContainText('The
   Cashier · Cashier')` — the heading is T-31's interim flash before the hand-off and asserting on
   it is flaky-to-failing. Nothing else in that file changes.

**Tests:**
- MANDATORY (spec 29 — offline sync: retries never create duplicates): exactly 4 audit rows for the
  4 offline attempts, one per `clientOpId` (2 × `pos.pin.offline_success`, 2 ×
  `pos.pin.offline_failed`), each with `device_id` = POS1's id and `occurred_at` = the record's
  `occurredAt`; after a reload flush, an online-event flush and a byte-identical replay answered
  `replayed`, `count(*) from audit_log` is unchanged.
- Device lineage: after revoke and re-registration, the fifth row carries POS2's `device_id` and
  the four old rows still carry POS1's.

**Done when:** `pnpm test:e2e e2e/pos-offline.spec.ts` passes, `pnpm test:e2e
e2e/pos-access.spec.ts` passes, and `grep -c 'offline_success' e2e/pos-offline.spec.ts` prints a
number greater than 0.

**Watch out:** MANDATORY (spec 29) — do not weaken to "at least one row", to `toBeGreaterThan`, or
to a count over `audit_log` without the `client_op_id` join. Map the expected event by the record's
`outcome`, not by its local `event` spelling. The old rows keep POS1's `device_id` because
`audit_log` is append-only (migration 0004) — an assertion that they changed can never pass and an
implementation that made them change would have violated invariant 2. A hyphen in a timestamp
comparison is fine; a hyphen in a money figure is not (U+2212).

### T-40 — Docs: CLAUDE.md layout, module READMEs, the design-system note

**Needs:** T-27, T-28, T-29, T-34, T-37
**Files:**
- `CLAUDE.md` — EDIT (three places: the tree inside `## Where code lives`; the `## Domain glossary`
  list; the `## Tests that are mandatory, not optional (spec 29)` list)
- `src/lib/server/orders/README.md` — EDIT (append `## Files` after T-19's `## Status` section
  and before the paragraph `This module calls …`)
- `src/lib/server/accounting/README.md` — EDIT (append `## Files` after the rules, before
  `Called by …`)
- `src/lib/server/inventory/README.md` — EDIT (append `## Files` after T-17's `## Status` section
  and before `Called by …`)
- `src/lib/pos/README.md` — EDIT (present at Phase 1, with `## The one hard rule` and `## What the
  offline path guarantees`; append `## Stores and modules` after the guarantees list and before the
  closing `Spec 4, 5, 6, 11.` line — never rewrite the file)
- `docs/design-system.md` — EDIT (§7 `POS component rules`: one paragraph after the
  `**Tenders.**` paragraph and before `**Owner-PIN actions**`)
**Spec:** 6 (offline facts, idempotency keys, the unsynced count — what the POS README restates), 13
(the payment transaction the orders README describes), 22–24 (the accounting README's rules), 29
(the mandatory test list), 30 and 32 (modular monolith — the layout the tree documents)
**Invariants:** 2 (posted records permanent — the docs say which tables are append-only), 3 (entries
balance in the database — the accounting README names the trigger), 4 (one transaction at payment —
the orders README names the file that holds it), 5 (offline sale is a fact — the POS README names the
stores that hold it and why they survive a wipe), 8 (server-side permission on every route — the
tree says `/api/pos/sync` checks its device and employee)

**Do:**

1. Inventory before describing. Run `ls src/lib/server/orders src/lib/server/accounting
   src/lib/server/inventory src/lib/server/pos-sessions src/lib/server/permissions src/lib/sync-ops
   src/lib/pos src/lib/server/reports src/routes/api/pos/sync "src/routes/(pos)/pos"
   "src/routes/(dashboard)/reports"`. The plan expects: `orders/validate.ts` (T-18), `pay.ts`
   (T-19), `sync.ts` (T-21) with `validate.integration.test.ts`, `pay.integration.test.ts`,
   `sync.integration.test.ts`; `accounting/chart.ts` (T-12), `posting-rules.ts` (T-13),
   `journal.ts` (T-14) with `chart.integration.test.ts`, `posting-rules.test.ts`,
   `journal.integration.test.ts`, `journal-guards.integration.test.ts`; `inventory/consume.ts`
   (T-17); `pos-sessions/index.ts` (T-20) with `sessions.integration.test.ts`;
   `permissions/employee.ts` (T-16); `sync-ops/index.ts` (T-03); `pos/store.ts`,
   `invoice-sequence.ts`, `orders.ts`, `session.ts`, `queue.ts`, `employee.svelte.ts`,
   `menu-view.ts` (T-22–T-26, T-33); the report module T-35 created (expected
   `src/lib/server/reports/`); `api/pos/sync/+server.ts` (T-27); `(pos)/pos/session`, `order`,
   `pay` (T-32–T-34); `(dashboard)/reports` and `reports/flagged` (T-36, T-37). Describe ONLY what
   `ls` shows, under the path it shows; a path that does not exist is not written into `CLAUDE.md`
   (the Done-when walks every path).
2. `CLAUDE.md` tree. T-02 ALREADY inserted the lines `pos-sessions/`, `reports/` (under `server/`)
   and `sync-ops/` (under `lib/`) and amended the house-convention paragraph — `grep -n
   'pos-sessions/\|reports/\|sync-ops/' CLAUDE.md` shows them; never add a second copy of any.
   This task (a) REPLACES the descriptions of the three lines that predate the plan, keeping each
   ONE line inside the code fence, aligned with its neighbours (six-space indent, the description
   starting in the same column):
   ```
         accounting/   chart of accounts (chart.ts: the 23 spec 23 codes verbatim, ensureChart), posting rules (posting-rules.ts: one rule per business event, nobody types a debit), journal writer (journal.ts: drops zero lines, never opens its own transaction; migration 0012's deferred trigger enforces the balance at COMMIT)
         inventory/    consume.ts — consumeForSale, the payment transaction's inventory step; a documented NO-OP (no movements, zero cost, no COGS entry) until the inventory plan lands recipes and stock movements
         orders/       validate.ts (the sale payload: hard failures and soft flags), pay.ts (THE payment transaction — recordSale), sync.ts (handleOp: dispatch, replay by op key, unrecorded storage, retry and dismiss); reached only through /api/pos/sync, invoice-hint.ts (lastInvoiceSeqForDevice — the resume hint GET /api/pos/employees returns)
   ```
   and (b) AMENDS, in place, the lines T-02 wrote so each names the file that now exists —
   `pos-sessions/` gains `index.ts`, `reports/` gains the file names `ls` showed, `sync-ops/`
   gains `index.ts` and the words `formatInvoiceNumber, parseInvoiceNumber`; the `pos/` line names
   `store.ts` (IndexedDB version 3), `queue.ts` (the flush), `invoice-sequence.ts`, `orders.ts`,
   `session.ts`, `employee.svelte.ts`, and keeps `print-agent client` as a later plan; the
   `permissions/` line adds `employee.ts — checkEmployee for device-sourced ops`; the `routes/api/`
   line adds `POS sync (/api/pos/sync, one op per request, device + employee checked)`; the
   `(dashboard)/` line adds `reports (/reports, /reports/flagged)`. Nothing else in the tree moves.
3. `CLAUDE.md` glossary — append three entries at the end of the `## Domain glossary` list, in this
   wording:
   - **Sync op** — one queued operation from the till (`session.open`, `session.close`,
     `sale.complete`, `sale.abandoned`, `pin.login`) in an `OpEnvelope` with a device-generated
     `clientOpId`; the server keys it on `(device_id, client_op_id)` in `pos_sync_ops` and replays
     the stored result on a retry. A sync op is a log row, not a posted record: its `status` may
     move on owner retry or dismiss; the records it produced never do.
   - **Flagged sale (recorded / unrecorded)** — a synced `sale.complete` that failed a check.
     RECORDED (`recorded_flagged`): a SOFT failure — employee inactive, unknown or not permitted,
     totals mismatch, stale-menu price, closed session, clock ahead — the sale is stored in full
     from the device's numbers, posted and invoiced, and the op row carries the flag and the
     `order_id`. UNRECORDED (`unrecorded`): a HARD failure — invalid payload, price tamper, unknown
     session, item or modifier, invoice collision, database error — nothing is posted; the payload
     stays on the op row for the owner's retry or dismiss on `/reports/flagged`, and session close
     is refused with 409 while one references the session. Never discarded (spec 6).
   - **Abandoned sale** — a card or mobile tender the server rejected (403 or 422) or the cashier
     cancelled while pending. The till sends `sale.abandoned` carrying the burned invoice number so
     the device sequence stays gap-free and the hole is explained; no order, invoice, payment or
     journal entry exists for it.
4. `CLAUDE.md` mandatory-tests list — after each of the five bullets, append ` — held by: ` and the
   files, found by `grep -rl 'MANDATORY (spec 29' src e2e | grep -E '\.(test|spec)\.ts$' | sort`
   (test files only — the bare grep also hits helpers such as `src/lib/server/db/test/reset.ts`,
   whose comment mentions the phrase) and assigned by the area named in each file's header
   comment; verify every path with `ls` before citing it. Expected shape:
   money arithmetic, rounding and both tax modes → `src/lib/money/index.test.ts`,
   `src/lib/money/tax.test.ts`, `src/lib/money/order-totals.test.ts`, `src/lib/money/change.test.ts`,
   `src/lib/pos/menu-view.test.ts` (the source tripwire); journal balance →
   `src/lib/server/accounting/journal.integration.test.ts` (property test) and
   `src/lib/server/accounting/journal-guards.integration.test.ts` (COMMIT-time rejection,
   append-only), and T-08's `src/lib/server/db/schema-guards/constraints.integration.test.ts`; one posting
   rule per event → `src/lib/server/accounting/posting-rules.test.ts`; offline retries →
   `src/lib/server/orders/sync.integration.test.ts`, T-25's queue test under `src/lib/pos/`,
   `e2e/pos-sale.spec.ts`, `e2e/pos-offline.spec.ts`; permission per POS API route →
   `src/routes/api/pos/permissions.integration.test.ts` and `src/routes/route-guards.test.ts`. If
   the grep names a file this list does not, cite it under its area; if this list names a file the
   grep does not, do not cite it. Leave the five bullet texts themselves untouched.
5. The three server READMEs — append a `## Files` section, one bullet per file that exists, in
   this form (the orders module shown; write the other two the same way from their `ls`):
   ```
   ## Files

   - `validate.ts` — `validateSale`: the `sale.complete` payload schema; HARD failures
     (`invalid_payload`, `price_tamper`, `unknown_session`, `unknown_item`, `unknown_modifier`,
     `invoice_collision`, `database_error`) roll back; SOFT flags (`employee_*`, `totals_mismatch`,
     `stale_menu_price`, `session_closed`, `clock_ahead`) record the sale and flag the op.
   - `pay.ts` — `recordSale`: THE payment transaction in spec 13's order; called only by `sync.ts`;
     never opens its own transaction.
   - `sync.ts` — `handleOp`: replay by `(device_id, client_op_id)`, device lineage (`foreign_device`
     → 409), outcome mapping (the TENDER decides 403 vs flag), `unrecorded` storage, `retryOp`,
     `dismissOp`.
   - `*.integration.test.ts` — one line each naming what the file proves.
   ```
   For `accounting/`: `chart.ts` (`CHART`, `ensureChart`, idempotent `ON CONFLICT DO NOTHING`),
   `posting-rules.ts` (`saleLines` → `Dr 1000|1020|1030 total / Dr 4100 discount / Cr 4000 subtotal
   / Cr 2100 tax`; `cogsLines` → `Dr 5000 / Cr 1200`; `overShortLines` → `Dr 6800 / Cr 1000` for
   a shortage, `Dr 1000 / Cr 6800` for an overage, nothing for zero), `journal.ts` (`postEntry`:
   drops `0n` lines, returns `null` when none remain, resolves accounts by code within the
   restaurant; the deferred trigger of migration 0012 is what enforces the balance at COMMIT). For
   `inventory/`: `consume.ts` (`consumeForSale` returns `[]` movements and `0n` cost — the seam the
   inventory plan fills; the README's rules about movements and weighted average describe that
   plan, not this file). Keep every existing rule line unchanged.
6. `src/lib/pos/README.md` — append `## Stores and modules`: a table of the IndexedDB stores
   (`matcami-pos`, `DB_VERSION = 3`) with columns store · keyPath · owning module · cleared by
   `bindDevice`/`forgetDevice`? — `employees` (`id`, `store.ts`, yes: a per-device cache of the
   staff bundle), `settings` (`key`, `store.ts`, yes), `menu` (`id`, `menu-snapshot.ts`, yes),
   `offline_logins` (`clientOpId`, `store.ts` + `queue.ts`, NEVER: unsynced audit facts),
   `orders` (`id`, `orders.ts`, NEVER: completed sales are facts, pruned only 30 days after they
   sync), `sync_queue` (`clientOpId`, `queue.ts`, NEVER: the queue IS the unsynced work),
   `invoice_sequence` (`deviceId`, `invoice-sequence.ts`, NEVER: a rewind would reissue a number
   already queued; resume point `max(local counter, highest queued number for that device, server
   hint)`), `session` (`deviceId`, `session.ts`, NEVER: the open session's business date belongs to
   queued sales). Then one line per module: `queue.ts` (FIFO by device seq, one op per request,
   backoff with the same `clientOpId` on network errors; `accepted`, `recorded_flagged` and
   `unrecorded` all advance; 409 `foreign_device` parks; a device 403 stops the flush and forgets
   the device), `employee.svelte.ts` (the signed-in state; its mirror lives in `sessionStorage`
   with `lastActiveAt` and refuses to restore past the idle limit — NEVER `localStorage`),
   `idle.ts`, `menu-snapshot.ts`, `menu-view.ts`. State the reason for the exemptions in one
   sentence: a wipe protects a stolen or re-registered tablet's PIN hashes and menu, but the facts
   already recorded on it belong to the restaurant's books and are never the wipe's to lose
   (spec 6, invariant 5).
7. `docs/design-system.md` §7 — read `src/routes/(pos)/pos/+layout.svelte` (T-30),
   `session/+page.svelte` (T-32) and `pay/+page.svelte` (T-34) first, then write ONE paragraph,
   bold-led like its neighbours (`**The tender step's pending state, and the session chip.**`),
   that describes what those files actually do, in their own words: a card or mobile tender shows
   `◐ Waiting for the server to confirm…` with its invoice number until the server answers 200 —
   `Cancel` turns it into `sale.abandoned` carrying the burned number, and `New sale` stays ENABLED
   because a pending card op never blocks the next cash sale; the `Card` and `Mobile money` keys
   are disabled with the reason on the key — `Not accepted in settings` or `◆ Cash only while
   offline` — so a tender never fails after the tap (invariant 5); the session chip is permanent
   chrome in the status bar, `○ No session` / `● Session · business date YYYY-MM-DD` (or `pending
   sync`), a link to the close screen, glyph plus words and never colour alone; and the close
   control is disabled with its reason beside it — `◆ Offline — closing needs a connection`, `◆ {n}
   operations still syncing`, `◆ {n} operations from a previous registration need the owner` —
   never a dead key. Match the words to the built screens; invent none.
8. `pnpm format` then `pnpm lint`. Fix Prettier's complaints in the files this task touched only.

**Tests:** none written by this task. The checks are `pnpm lint` and the path walk below;
`src/lib/components/components.test.ts` and `src/lib/pos/service-worker-policy.test.ts` must still
pass (`pnpm test:unit`) because documentation edits touch nothing they police.

**Done when:** `pnpm lint` passes, `pnpm test:unit` passes, and every path named in the
`CLAUDE.md` tree exists — run, from the repo root, `for p in src/lib/server/db src/lib/server/money
src/lib/server/accounting src/lib/server/inventory src/lib/server/orders src/lib/server/auth
src/lib/server/permissions src/lib/server/audit src/lib/server/restaurants
src/lib/server/pos-sessions src/lib/server/reports src/lib/money src/lib/sync-ops src/lib/pos
src/lib/components/ui src/lib/styles src/routes/login src/routes/register src/routes/logout
"src/routes/(dashboard)" "src/routes/(dashboard)/reports" "src/routes/(pos)/pos" src/routes/api
src/routes/api/pos/sync; do ls -d "$p" >/dev/null || echo "MISSING $p"; done` and it prints
nothing; and `grep -c '^      pos-sessions/' CLAUDE.md` prints exactly `1`.

**Watch out:** Never reword an existing decision; append. The `Decisions already made` section is
T-02's to extend and nobody else's; the twelve invariants are not edited here; a sentence that is
wrong today (§7b still says `src/lib/server/money/` exports no formatter) is left for a plan that
owns it — this task documents the sales slice and nothing else. `src/lib/pos/README.md` EXISTS at
Phase 1 — a brief that calls it NEW is mistaken; extend it. `.prettierignore` lists `CLAUDE.md`, so
Prettier neither checks nor reflows it: keep every tree line on ONE line by hand.

### T-41 — Final verification: every check, every test, no schema drift, the quality checklist

**Needs:** T-38, T-39, T-40
**Files:** none. This task edits nothing. A failure is fixed in the task that owns the file,
committed as `T-NN fix(<scope>): <what>`, and this task is rerun from step 1.
**Spec:** 29 ("Automated tests: the parts where mistakes cost money get automated tests from day
one" — the six areas; "A backup is always taken before running database migrations"), 3 (data
integrity: `bigint` money, enforced balance), 6 (idempotent sync), 8 (server enforcement of
permissions), 17 (one rounding rule), 24 (posting rules)
**Invariants:** 1 (integer minor units, no float — grepped), 2 (posted records permanent — grepped),
3 (entries balance in the DB — tested at COMMIT), 5 (idempotent offline sync — tested end to end), 8
(server-side permission on every POS route — the table has a row per route), 12 (no secret in
`localStorage` — grepped); the other six are walked in the checklist

**Do:**

1. `nvm use && pnpm install --frozen-lockfile` — Node prints `24.21.0`; pnpm reports the lockfile
   is up to date and installs nothing new.
2. `pnpm check` — `svelte-check found 0 errors and 0 warnings`.
3. `pnpm lint` — Prettier `All matched files use Prettier code style!` and ESLint exits 0.
4. `pnpm test` — the unit AND integration projects; every file passes, none skipped. The
   integration project truncates `matcami_test`; it runs BEFORE the e2e in this task.
5. `pnpm build` — adapter-node writes `build/index.js`; no warning about `$lib/server` reaching the
   client bundle. Do not skip it: the e2e config builds again, but a build failure must be seen
   here, on its own.
6. `pnpm test:e2e` — every spec in `e2e/` passes: `auth`, `pos-access`, `pos-offline`,
   `pos-sale`, `pos-service-worker`, `smoke`. This runs AFTER step 4 by design: integration
   first, then e2e, never concurrently — both runners share `matcami_test` under the same
   advisory lock, and the e2e's `preview` server must start only after the integration project
   has released that lock.
7. `pnpm exec drizzle-kit check` — prints that the migrations are consistent (no conflicting or
   missing snapshots for 0000–0012).
8. `pnpm db:generate` — must print that there are no schema changes and create NO file:
   `git status --porcelain src/lib/server/db/migrations` prints nothing. If a migration WAS
   generated, the Drizzle schema and migrations 0011/0012 disagree: delete nothing, leave the
   generated file in the working tree as evidence, stop, and report the diff `git status` shows.
9. No float, no second rounding site (invariants 1, 7):
   `grep -rnE 'parseFloat|toFixed\(|Math\.round|Number\(' src/lib/money src/lib/server/accounting
   src/lib/server/orders src/lib/pos --include='*.ts' | grep -vE '\.test\.ts:' | grep -vE
   '^[^:]+:[0-9]+:\s*(//|\*)'` must print nothing. (The raw grep hits one COMMENT today,
   `src/lib/pos/menu-snapshot.ts:10`, which explains why `Number()` is forbidden — the last filter
   drops comment lines; a hit that is code fails this step. `src/routes/(pos)/pos/+layout.svelte`'s
   `Math.round` over a clock-skew duration in minutes is not money and is outside these paths.)
10. No secret in `localStorage` (invariant 12):
    `grep -rnE 'localStorage\s*\.\s*(getItem|setItem|removeItem|clear|key)\b|localStorage\[' src`
    must print nothing. (A plain `grep -rn localStorage src` prints only comments and READMEs that
    say "never `localStorage`" — read each hit; any that is code fails this step. `sessionStorage`
    for T-26's mirror is allowed and is not matched.)
11. No `UPDATE` or `DELETE` of a posted record (invariant 2):
    `grep -rnE '\.update\((invoices|payments|journalEntries|journalEntryLines)\)|\.delete\((invoices|payments|journalEntries|journalEntryLines|orders)\)' src`
    must print nothing. Then, by reading: the only `.update(orders)` in `src/lib/server/orders/`
    is the in-transaction `status` move `open → paid` inside `recordSale`, and the only
    `.update(posSyncOps)` is `retryOp`/`dismissOp` — `pos_sync_ops` is a sync log, not a posted
    record (T-07's schema comment says so).
12. Open `src/routes/api/pos/permissions.integration.test.ts` and confirm a row for
    `/api/pos/sync` in `DEVICE_GUARDED` (`grep -n "'/api/pos/sync'" src/routes/api/pos/
    permissions.integration.test.ts` prints at least one line) AND an "insufficient role" case for
    the sync route's employee check (a card `sale.complete` naming an employee without
    `pos.payment` → 403; a cash one → 200 `recorded_flagged`), the overview's HTTP contract for
    `POST /api/pos/sync` that T-27's permission rows cover.
13. Walk the quality bar of `.claude/skills/plan-feature/references/task-format.md` §9 against the
    BUILT tree, answering each with yes/no and the evidence:
    - a fresh session could run T-19 alone from `05-orders-sessions-sync.md` plus the overview —
      every symbol it names exists under the path it names;
    - every money-touching module names `bigint` minor units and the step-9 grep is empty;
    - every accounting file names its literal `Dr`/`Cr` codes from spec 23 (`1000`, `1020`,
      `1030`, `2100`, `4000`, `4100`, `5000`, `1200`, `6800`) and no other code appears in
      `src/lib/server/accounting/` outside `chart.ts`'s 23 rows;
    - every new `+server.ts` and form action checks its permission and answers 403:
      `src/routes/route-guards.test.ts` passed in step 4 with the new routes in its walk;
    - each spec 29 area has a MANDATORY-marked test with expected values: `grep -rl 'MANDATORY
      (spec 29' src e2e | sort` lists files for all six areas (money/rounding, both tax modes,
      balance, posting rules, retries, permissions), the same files `CLAUDE.md` now cites (T-40);
    - no invented path: every path in `00-overview.md`'s shared contracts and in `CLAUDE.md`'s
      tree exists (T-40's walk printed nothing);
    - no `UPDATE`/`DELETE` of a posted record: step 11;
    - every assumption in `00-overview.md`'s table of thirteen is recorded by T-02 in
      `CLAUDE.md` (`grep -c` for each row's subject prints ≥ 1);
    - every `Done when` of T-01–T-40 was a command or an observable condition, and it held.
14. Write the report: for each of steps 1–12 the command, its exit code and the decisive line of
    output (the counts, the `0 errors`, the empty grep), and for step 13 the nine answers. Put it in
    the pull request description under `## Verification (T-41)`; the same text is the task's
    commit-less final message. An open item anywhere means the task is not done.

**Tests:** none new. This task runs every existing test: `pnpm test` (unit + integration) and
`pnpm test:e2e`, in that order, and their passing IS the evidence — quoted, not summarised.

**Done when:** every command in steps 1–12 exits 0 and prints what the step says it prints, the
step-8 `git status` and the step-9, 10 and 11 greps print nothing, and the step-13 checklist has no
`no` and no open item.

**Watch out:** `pnpm test:e2e` must run AFTER `pnpm test` (which includes the integration project)
in this task — integration first, then e2e, never concurrently: both runners truncate
`matcami_test` under the same advisory lock, so never start one while the other runs. Do not skip the build. Do not "fix" a generated migration by deleting it or by editing
0011/0012 — a migration that has run is never hand-edited (CLAUDE.md); report instead. A grep that
prints a comment is read, not silenced with a broader exclusion.
