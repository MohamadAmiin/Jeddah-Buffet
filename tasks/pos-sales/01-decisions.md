# Phase 0 — decisions and preconditions (T-01, T-02, T-03)

> Part of tasks/pos-sales/ — read 00-overview.md first. Depends on: none — this is the first phase.

This plan departs from the default phase list (schema → domain → API → UI → tests) by running a
decisions phase first, for three reasons that are each a rule of this phase. First, the thirteen
defaults in `00-overview.md`'s Assumptions table were accepted by one instruction ("write the plan
with the defaults") rather than answered one by one, so before any code encodes one of them it is
written into CLAUDE.md as a decision that names its provenance and the tasks a reversal would
re-plan (T-02) — an unrecorded default is an answer baked in silently, which CLAUDE.md's open-
decisions rule forbids. Second, the base tree MUST already contain PR #11's migrations 0008–0010
before any schema task generates 0011: Drizzle's migrator applies files by their journal `when`
and skips every file older than the newest row already applied, so a 0011 generated on a tree
without 0008–0010 would make those three unreachable forever on any database that took 0011 first
(T-01 verifies the tree and repairs any database migrated out of order). Third, the isomorphic op
contract — the op kinds, the payload shapes, the status and flag lists, the invoice-number format
— must exist before either the server (T-18–T-21, T-27) or the till (T-22–T-25) is written, so
both sides import ONE set of names instead of each restating them (T-03). Nothing in this phase
creates a table, posts an entry or touches money; T-03 is the only task that writes code. Every
later phase (`02` schema, `03`–`05` domain, `06` offline, `07` API, `08`–`09` UI, `10`
verification) depends on this one.

### T-01 — Verify the base tree holds PR #11's migrations and reset any database migrated out of order

**Needs:** -
**Files:** none created or edited — this task runs commands, compares their output with the
expected values below, and reports. It produces no diff.
**Spec:** 29 ("A backup is always taken before running database migrations"; "database changes go
through Drizzle migrations"), 8 (permission keys — PR #11's `permissionsForUser` is what every
employee check in this plan resolves against)
**Invariants:** 2 (posted records are permanent — a migration that has run is never hand-edited
or renumbered; a database in the wrong order is rebuilt, not patched), 12 (POS access = registered
device + PIN — PR #11's `roles` and `users.role_id` are the shape the till's cached employee bundle
and T-16's `checkEmployee` assume)

**Do:**
1. **Confirm PR #11 is merged, from the checkout you will execute this plan in.** Run
   `nvm use` first (Node 24.21.0; `engines` refuses anything else). Then:
   - `gh pr view 11 --json state,headRefName,mergeCommit` must print `"state": "MERGED"` and
     `"headRefName": "feat/employee-roles"`. The plan was written on 2026-09-28 while this PR was
     still OPEN at head `e174bfe`, with `main` at `1741344` — so if `git log --oneline -1` still
     prints `1741344`, the tree is the PRE-merge tree and the answer to this step is "not merged".
   - `git merge-base --is-ancestor origin/feat/employee-roles HEAD && echo ancestor` prints
     `ancestor` when the PR landed as a merge commit (the repository's convention so far: PR #10
     landed as `1741344 Merge pull request #10`). If the PR was squash-merged this prints nothing
     even though the PR is merged; the `gh` answer governs.
   - If the state is anything but `MERGED`: **STOP and ask the user.** Never start this plan from
     a tree without PR #11 and never branch from `origin/feat/employee-roles` on your own
     initiative: this plan's migration numbers (0011 in T-08, 0012 in T-09) and its foreign keys to
     `users.role_id` and `roles` (T-05, T-06) are only correct on the merged tree.
2. **The migration folder holds 0000–0010.** `ls src/lib/server/db/migrations/` must list eleven
   `.sql` files plus `meta/`, including exactly `0008_roles_and_role_id.sql`,
   `0009_seed_default_roles.sql` and `0010_user_role_owner_staff.sql`. The journal must end at
   idx 10:
   ```bash
   node -e 'const j=require("./src/lib/server/db/migrations/meta/_journal.json");const l=j.entries.at(-1);console.log(j.entries.length,l.idx,l.tag)'
   ```
   prints `11 10 0010_user_role_owner_staff`. Any other count or tag: stop and report — either
   PR #11 is not in the tree, or somebody has already generated a migration on top of it, and the
   overview's numbering (0011, 0012) is then wrong for this tree.
3. **The roles code is present.** `ls src/lib/server/permissions/roles.ts
   src/lib/server/db/schema/roles.ts` lists both files (on `main` at `1741344` neither exists — they
   arrive with PR #11). `grep -n 'export async function permissionsForUser'
   src/lib/server/permissions/roles.ts` prints one line; the signature is `permissionsForUser(
   database: Executor, restaurantId: string, userId: string): Promise<ReadonlySet<PermissionKey>>`,
   and it returns an EMPTY set for an unknown or inactive user rather than throwing — T-16 relies
   on that.
4. **The snapshots are consistent.** `pnpm exec drizzle-kit check` prints `Everything's fine 🐶🔥`.
   It reads `drizzle.config.ts` and `meta/*_snapshot.json` only and opens no connection, so it
   needs no database — but `drizzle.config.ts` loads `.env` through dotenv, so `.env` must exist
   (see Watch out).
5. **Both migration ledgers hold exactly the journal's eleven rows, in journal order.** Two
   databases: the DEV database named by `MIGRATE_DATABASE_URL` (the owner role `matcami`, the only
   role that can read the `drizzle` schema) and the TEST database named by `TEST_DATABASE_URL`.
   Source `.env` in a subshell so the URLs — which carry the owner password — are never printed:
   ```bash
   ( set -a; . ./.env; set +a
     for url in "$MIGRATE_DATABASE_URL" "$TEST_DATABASE_URL"; do
       echo "--- $(psql "$url" -X -At -c 'select current_database()') ---"
       psql "$url" -X -At -F ' ' -c 'select id, hash, created_at from drizzle.__drizzle_migrations order by created_at'
     done )
   ```
   The expected rows come from the journal, not from this file. Drizzle stores `created_at` as the
   journal entry's `when` (an integer of milliseconds in a `bigint` column — not a timestamp) and
   `hash` as the SHA-256 of the migration file's text (`readMigrationFiles` in
   `node_modules/drizzle-orm/migrator.js`). Print the expected `hash when tag` triples with the
   same computation:
   ```bash
   node -e '
   const fs=require("node:fs"),c=require("node:crypto"),d="src/lib/server/db/migrations";
   for (const e of require("./"+d+"/meta/_journal.json").entries)
     console.log(c.createHash("sha256").update(fs.readFileSync(`${d}/${e.tag}.sql`).toString()).digest("hex"), e.when, e.tag)'
   ```
   As of PR head `e174bfe` the three new `when` values are `1789643989864` (0008), `1789653082875`
   (0009) and `1789682390695` (0010); trust the journal over these numbers if the PR was
   regenerated before it merged. Compare each database's rows with the eleven triples:
   - **Eleven rows, hashes and `created_at` equal to the eleven triples, ascending:** the database
     is correct; go to step 6.
   - **Fewer rows, and the newest row IS one of the eleven** (typically eight rows ending at 0007
     `1789498089983`): the database simply has not taken 0008–0010 yet. For the dev database run
     `pnpm db:migrate` (it runs `pnpm db:backup` — a `pg_dump` into `backups/` — first, then applies
     0008–0010 in ONE transaction) and re-run the query: eleven rows. For the test database do
     nothing here — step 6 migrates it.
   - **A row whose `created_at` is GREATER than 0010's `when` and whose hash is NOT one of the
     eleven** — a migration generated on the wrong base, for example an earlier attempt at 0011
     generated before PR #11 merged, applied to this database and later discarded from the tree.
     Drizzle's migrator (`migrate()` in `node_modules/drizzle-orm/pg-core/dialect.js`) reads ONLY the
     newest row (`order by created_at desc limit 1`) and applies a file only when that row's
     `created_at < folderMillis`, so on this database 0008–0010 will be skipped FOREVER. Rows from
     0008–0010 themselves with matching hashes are of course fine. In this case: **ASK the user,
     showing them the offending row**, and tell them what the reset costs — there is no production
     database ("dev and test only; no production database exists (checked read-only 2026-09-16)",
     `tasks/employees-roles.md`), so the loss is the dev data only — and the dump taken first is
     kept in `backups/`, so the dev data can be restored with `pg_restore` if needed. With their
     yes, and only then:
     ```bash
     # stop `pnpm dev`, `pnpm db:studio`, any psql session first
     pnpm db:backup   # pg_dump of the dev database into backups/ — the only copy once dropdb runs
     sudo -u postgres dropdb --force matcami
     sudo -u postgres dropdb --force matcami_test
     bash scripts/db-bootstrap.sh <owner-pw> <app-pw>   # the SAME passwords .env already holds
     pnpm db:migrate                                    # dumps the now-empty matcami, then applies 0000–0010
     ```
     `db-bootstrap.sh` is idempotent: it leaves the two roles untouched (it never rotates a
     password), recreates BOTH databases owned by `matcami` with `timezone = UTC`, and re-runs the
     `GRANT`s and the `ALTER DEFAULT PRIVILEGES FOR ROLE matcami` statements the runtime role needs
     — those grants live in the bootstrap script, not in a migration, which is why `dropdb` alone
     followed by `createdb` is NOT enough. Passing the passwords `.env` already holds means `.env`
     does not change. Re-run the query on the dev database: eleven rows. The test database is
     recreated empty here and migrated in step 6.
   - **Any other pattern** — a hash that matches none of the eleven at any position, or the right
     count with a mismatched hash — is the same defect as the previous bullet: STOP, show the user
     the offending rows, and with their yes perform the same backup-then-drop-and-recreate reset;
     never delete ledger rows.
6. **Prove the test harness migrates matcami_test to 0010.** `pnpm test:integration` must exit 0
   on the unmodified tree. Its global setup (`src/lib/server/db/test/global-setup.ts`) runs
   Drizzle's runtime migrator against `TEST_DATABASE_URL` before any test file, refusing any
   database whose name does not end in `_test`. After the run, repeat step 5's query for the test
   database: eleven rows, matching the triples.
7. **Record the result.** Nothing changed, so there is no diff to commit; record the six checks'
   outputs as an empty commit so the plan's one-commit-per-task trail is unbroken:
   `git commit --allow-empty -m 'T-01 chore(db): verify the base tree holds PR #11 (0008–0010)'`
   with the outputs of steps 1–6 in the body — the ledger rows, the `drizzle-kit check` line, the
   test summary line — and NEVER a URL, a password or a `.env` line.

**Tests:** none — this is a verification task. It runs the existing suite (`pnpm test:integration`)
and adds nothing to it.

**Done when:** `gh pr view 11 --json state` prints `{"state":"MERGED"}`; the journal one-liner prints
`11 10 0010_user_role_owner_staff`; `grep -c 'export async function permissionsForUser'
src/lib/server/permissions/roles.ts` prints `1`; `pnpm exec drizzle-kit check` prints
`Everything's fine`; the ledger query prints exactly eleven rows on BOTH databases whose `hash` and
`created_at` columns equal the eleven computed triples in ascending `created_at` order, with no
extra row; `pnpm test:integration` exits 0; and `git status --porcelain` shows no modified tracked
file (an untracked directory such as `design/`, present at plan time, is not a modification).

**Watch out:** CLAUDE.md forbids hand-editing a migration that has run. House rule of this task,
for the reason that follows: never "repair" the ledger by deleting rows from
`drizzle.__drizzle_migrations` — that leaves behind the tables and columns the foreign migration
created, and the next `db:generate` diffs against a schema that does not match the snapshots.
Drop and recreate. Drizzle applies migrations by journal `when` in ONE transaction and skips
anything older than the newest applied row — the whole reason this task exists. `pnpm db:backup`
fails if `backups/` cannot be written (a read-only checkout, a full disk): that failure MUST stop
the reset — never run `dropdb` after a failed backup, because the dump is the only copy of the dev
data once the database is gone. `pnpm db:migrate` chains `pg_dump` FIRST, so it fails if the
database does not exist yet: bootstrap before migrate, never the other way round. Never print
`MIGRATE_DATABASE_URL` or `TEST_DATABASE_URL`. If this plan executes in a git worktree (the
repository's usual practice), `.env` is gitignored and therefore absent there: copy it from the
main checkout, never commit it. `dropdb --force` (PostgreSQL 13+) terminates the connections that
would otherwise block the drop; the app's `matcami_app` connections from a running `pnpm dev` are
the usual culprit.

### T-02 — Record the thirteen defaults and the sales-plan decisions in CLAUDE.md

**Needs:** T-01
**Files:**
- `CLAUDE.md` — EDIT (four places, found by `grep`, never by line number: (1) the "Decisions
  already made (NOT open — do not re-litigate)" section — APPEND bullets after its last bullet,
  which on the merged tree is the one beginning `- **Roles are owner-editable rows, per restaurant
  — decided 2026-09-16`; (2) the "Open decisions — UNRESOLVED (spec 33)" table — amend the line
  beginning `4. Payment methods at launch`; (3) the "Where code lives" tree — add
  `pos-sessions/`, `reports/` under `server/` and `sync-ops/` under `lib/`; (4) the paragraph
  beginning `House convention, not spec` — two amendments)
**Spec:** 33 (open decision 4, payment methods — the tender set is answered here; decision 6,
approval limits — stays open), 13 ("Dine-in … Takeaway … Delivery comes later"), 6 (offline sales
are recorded facts; "Online card/mobile payments should not automatically be treated as successful
offline"), 23 (the chart; "Only the payment methods the restaurant accepts are created"), 24
(posting rules keyed by tender: cash sale, card / mobile sale, sale with discount, cash shortage /
overage at session close), 17 (one rounding rule in one function), 8 (`pos.sell`, `pos.payment`),
10 (session close "requires a connection and an empty sync queue"), 31 (delivery and multiple
terminals under Later)
**Invariants:** 3 (journal entries balance in the database), 5 (a completed offline cash sale is a
recorded fact; card and mobile never auto-complete offline), 7 (discounts before tax; each line
snapshots its numbers; one rounding rule), 8 (permissions enforced server-side on every POS route),
9 (owner-PIN approval — nothing that needs one is built in this plan), 10 (sensitive actions are
audit-logged in the same transaction), 12 (POS access = registered device + PIN)

**Do:**
1. Locate the four anchors and stop if any is missing (the file is then not in the state this
   plan assumed — PR #11 not merged, or a section reworded):
   ```bash
   grep -n 'Roles are owner-editable rows' CLAUDE.md          # last bullet of "Decisions already made"
   grep -n '^4\. Payment methods at launch' CLAUDE.md          # open-decisions row 4
   grep -n '^      restaurants/  restaurant record' CLAUDE.md  # tree: last line under server/
   grep -n '^    money/          ISOMORPHIC' CLAUDE.md         # tree: the money line under lib/
   grep -n '^House convention, not spec' CLAUDE.md            # the convention paragraph
   grep -c '2026-09-28' CLAUDE.md                             # must print 0 before you start
   ```
2. **Append the decision bullets** directly after the roles bullet and before the
   `## Do NOT build` heading, in the file's existing style: ONE bullet is ONE line (no hard
   wrapping — every existing bullet in that section is a single long line), a bold lead-in that
   names the decision and ends with the date, then the substance, then the provenance. Every
   bullet MUST contain the literal date `2026-09-28` and this provenance sentence verbatim:
   > presented with a default on 2026-09-28; the user directed the plan be written with the
   > defaults and did not answer individually — confirm at the first opportunity; a reversal
   > re-plans the tasks named
   and MUST end by naming the tasks that depend on it (`tasks/pos-sales`, T-NN …). Write these
   bullets, in this order, with this substance (the wording is yours; the facts are not):
   - **(a) Order types — `dine_in` | `takeaway` — decided 2026-09-28.** `orders.order_type` is
     `text` with `CHECK (order_type IN ('dine_in', 'takeaway'))` — the `TAX_MODES` idiom, a text
     CHECK and never a Postgres enum, so a value added later is one constraint swap; `orders.
     table_label` is `text` NULL, at most 32 characters; no `dining_tables` table. The till offers
     three buttons: **Sit now** = `dine_in` + optional table label; **Waiting for a table** =
     `dine_in` + NULL label; **Takeaway** = `takeaway`. Home delivery is NOT built: it is first in
     this file's "Do NOT build", spec 13 says "Delivery comes later", spec 31 lists it under Later;
     the user's word "delivery" in the request was read as takeaway (assumption 1). Tasks: T-06,
     T-33.
   - **(b) Tenders — spec 33 open decision 4, the tender SET answered 2026-09-28.** `payments.
     method` is `text` with `CHECK (method IN ('cash', 'card', 'mobile'))`. Cash is always on. Card
     and mobile are RECORDED external-terminal tenders: the terminal on the counter authorises,
     the till records the outcome; no provider integration, no fee posting (clearing settlement is
     a later plan). Two NULLABLE boolean settings with NO column DEFAULT, `restaurant_settings.
     accepts_card` and `restaurant_settings.accepts_mobile`, set by the owner on `/settings`
     (NULL or false = off), say WHICH of the two is enabled — that is a setting, not a decision.
     Offline, the card and mobile keys are disabled with the reason shown in words, and invariant
     5's sentence stands unchanged and is quoted in the bullet verbatim: "Card and mobile payments
     are NEVER auto-completed offline unless the provider/terminal explicitly supports offline
     authorization; house rule for that case: fail closed — no receipt, no invoice number, no
     Payment Clearing posting, order stays BILLED." The alternative — "a standalone terminal
     authorises on its own, so the tender is a fact offline" — was presented and NOT chosen. A
     PENDING card/mobile op (its response lost) never blocks cash sales: it stays queued with its
     invoice number and replays in order. A card/mobile op the server REJECTS (403 or 422), or one
     the cashier cancels while pending, becomes a `sale.abandoned` op carrying the burned invoice
     number so the server can explain the hole in the gap-free sequence. The currency was answered
     2026-09-15 (USD, exponent 2). Tasks: T-07, T-13, T-25, T-29, T-34.
   - **(c) Chart of accounts — all 23 spec 23 accounts seeded per restaurant — decided
     2026-09-28.** `ensureChart` seeds every code from 1000 Cash on Hand to 6900 Other Expenses
     verbatim for every restaurant — an initializer entry for new restaurants, the custom
     migration 0012 backfill for existing ones — idempotently (`ON CONFLICT (restaurant_id, code)
     DO NOTHING`). This DEVIATES from spec 23's sentence "Only the payment methods the restaurant
     accepts are created (section 33)": 1020 Payment Clearing – Card and 1030 Payment Clearing –
     Mobile Money exist even while the tender is off. Reason: turning a tender on later must not
     need a migration or a seed step, and an account with no lines is invisible on every report.
     Tasks: T-12.
   - **(d) Session open and close are gated by `pos.payment` — no new key — decided 2026-09-28.**
     `session.open` and `session.close` require spec 8's cashier key `pos.payment` (the cashier
     owns the drawer); `sale.complete` requires `pos.sell` AND `pos.payment`; `pin.login` and
     `sale.abandoned` require none (they are facts). No key is coined — this file's rule that a key
     in neither list is a reason to stop and ask was followed, and the default was accepted.
     Tasks: T-16, T-21.
   - **(e) Rounding — a clarification of the 2026-09-15 decision, 2026-09-28.** `computeOrderTotals`
     in `src/lib/money/order-totals.ts` rounds exactly three sums, once each, with
     `roundToMinor(…, ROUNDING_RULE)`: `total = round(Σ line gross)`, `tax = round(Σ line tax)`,
     `discount = round(Σ (undiscountedNet − net))`; then `net = total − tax` and `subtotal = net +
     discount` are DERIVED by integer arithmetic and never rounded. So `subtotal − discount + tax =
     total` holds by construction, and every sale entry — Dr tender `total`, Dr 4100 `discount` /
     Cr 4000 `subtotal`, Cr 2100 `tax` — balances by construction: no second rounding site, and no
     one-cent inclusive-mode mismatch (20% inclusive on 999: net 833 + tax 167 ≠ 999 when each is
     rounded on its own). Still full precision per line, one rounding on the invoice total, ties
     half away from zero; not a new rule. Tasks: T-10.
   - **(f) Flagged-sale semantics — decided 2026-09-28.** Two flag classes. SOFT
     (`employee_not_permitted`, `employee_inactive`, `employee_unknown`, `totals_mismatch`,
     `stale_menu_price`, `session_closed`, `clock_ahead`): the sale is recorded IN FULL from the
     device's numbers — order, lines, payment, invoice, journal entry — and the op row is `status =
     'recorded_flagged'` with the order id. HARD (`invalid_payload`, `price_tamper`,
     `unknown_session`, `unknown_item`, `unknown_modifier`, `invoice_collision`, `database_error`):
     the transaction rolls back and the op is stored `status = 'unrecorded'` with its payload only
     — stored and flagged, never discarded (spec 6). Session close is refused with `409
     {error:'session_has_unrecorded_ops', count}` while any unrecorded op references the session.
     `/reports/flagged` gives the owner two actions: retry (the same op key, the same transaction)
     and dismiss (with a reason). The HTTP class is decided by the TENDER, never by connectivity: a
     cash `sale.complete` and a `session.open` always answer `200` (`accepted`, `recorded_flagged`
     or `unrecorded`) because the sale has already happened on the device; only a card/mobile
     `sale.complete` and a `session.close` may answer `403` (employee check) or `422` (hard flag),
     because those have not completed on the till yet. Tasks: T-18, T-19, T-20, T-21, T-27, T-37.
   - **(g) Employee identity on device-sourced requests — decided 2026-09-28.** No new cookie. The
     device cookie (`requireDevice`) authenticates the DEVICE; every op envelope carries
     `employeeId` and `deviceId`; the server checks that the employee belongs to the op's device's
     restaurant, is active, and holds the keys named in (d). ACCEPTED RESIDUAL, recorded: whoever
     holds the registered device can craft a request naming another employee. Mitigations: the
     audit trail carries device AND employee on every row; the till is a shared physical device on
     the counter (spec 33 decision 1); every money-moving action beyond a plain sale needs the
     owner's PIN. Tasks: T-16, T-21, T-27.
   - **(h) Device lineage of queued ops — decided 2026-09-28.** Every op carries the `deviceId` it
     was recorded under. The server records an op under THAT device — invoice namespace, audit
     `device_id`, session — whenever the device row belongs to the cookie's restaurant, REVOKED OR
     NOT, so the documented revoke-and-re-register reset neither strands nor misattributes a sale.
     An op whose device belongs to another restaurant answers `409 {error:'foreign_device'}` and
     nothing is stored; the till parks it under permanent chrome. `session.close` from any live
     device of the restaurant may close an older device's open session. Tasks: T-21, T-25, T-27.
   - **(i) One queued op per sale, `sale.complete` — decided 2026-09-28.** The server first sees an
     order when it is paid: the op carries the whole order (lines, modifiers, totals, the one
     payment, the invoice number, the session). THE payment transaction inserts the order with
     `status = 'open'` and marks it `'paid'` in the same transaction — spec 13's "Mark Order PAID"
     step; there is no server-side OPEN phase in this slice. `billed`, `voided`, `refunded` and the
     item statuses `sent`, `voided` exist in the CHECKs and nothing writes them. Tasks: T-06, T-19,
     T-24.
   - **(j) Three new modules — decided 2026-09-28.** `src/lib/sync-ops/` is ISOMORPHIC exactly like
     `src/lib/pin/` and `src/lib/money/`: op kinds, payload types, status and flag lists, the
     invoice-number format and parser; imported by `lib/server/**`, `lib/pos/` and `routes/(pos)/
     **`; it imports NOTHING — no sibling, no `$lib`, no Node builtin — and `eslint.config.js`
     restricts it as it restricts `src/lib/money`. `src/lib/server/pos-sessions/` is a server
     module: session open (attach to an already-open one), close (expected cash, over/short posting
     to 6800), business date derived in SQL; it calls `accounting/`, `permissions/` and `audit/`
     and is called by `orders/sync.ts`. `src/lib/server/reports/` holds read-only report queries
     over STORED columns, called by `(dashboard)` routes only; it never recomputes money. Tasks:
     T-03, T-20, T-35.
   - **(k) Two convention amendments — decided 2026-09-28.** `restaurants/` may import the `CHART`
     constant and `ensureChart` from `accounting/chart.ts` for its `restaurantInitializers` entry
     (it still calls no other module, and `accounting/` never calls back). `updateSettings` bumps
     `restaurant_settings.menu_version` with an inline SQL increment (`menu_version = menu_version +
     1`) in the same transaction whenever `tax_mode`, `tax_rate_bp` or `currency_code` changes —
     rather than by calling `menu/`, which `restaurants/` may not import — so the till's cached
     snapshot, which carries those settings, goes stale at once and the next version check
     replaces it. Tasks: T-12, T-29.
   - **(l) The remaining defaults of the Assumptions table — decided 2026-09-28.** One bullet
     that lists defaults 2 and 8–13 of `00-overview.md` with their tasks: PR #11 merges before this
     plan executes and its migrations start at 0011 (T-01, T-16, T-28); the dashboard report covers
     sales, sessions and flagged ops only — journal and trial-balance views are a later plan
     (T-35–T-37); one active cart at a time, no hold/resume (T-24, T-33); the till does NOT return
     to employee-select after each payment — spec 7's optional lock is off (T-34); the order screen
     has no kitchen closer, Pay is the only closer while printing is out of scope (T-33); cart edits
     are not audited — deleting a NEW line needs no reason (spec 14; invariant 9) (T-24, T-33);
     synced sales are pruned from the device after 30 days, in the flush (T-22, T-25).
3. **Amend open-decisions row 4.** Replace the whole line beginning `4. Payment methods at
   launch` with one that says: the tender SET was answered 2026-09-28 — cash, card and mobile as
   recorded external-terminal tenders, cash always on; only WHICH of card/mobile the owner turns on
   remains, and that is a setting (`accepts_card`, `accepts_mobile`), not a decision — see
   "Decisions already made"; the currency was answered 2026-09-15. Keep the row (rows 2, 3 and 6
   set the precedent: an answered part is recorded in place, not deleted) and keep its number.
4. **Extend the "Where code lives" tree** — three new lines, each ONE line inside the code fence
   (they wrap only in this task file), aligned with their neighbours (six-space indent under
   `server/`, four-space under `lib/`, the name padded so the description starts in the same
   column as the surrounding lines):
   - after `      restaurants/  …`: `      pos-sessions/ POS shift open (attach) and close
     (expected cash, over/short to 6800), business date in SQL — called by orders/sync.ts; calls
     accounting/, permissions/, audit/`
   - after that: `      reports/      read-only report queries over STORED columns (sales by
     business date, sessions, flagged ops) — called by (dashboard) routes; never recomputes money`
   - after `    money/          …`: `    sync-ops/       ISOMORPHIC: op kinds, payloads, status and
     flag lists, invoice-number format — imported by lib/server/**, lib/pos/ and (pos); imports
     nothing`
5. **Amend the house-convention paragraph** (one line in the file; keep it one line). Two
   changes: (i) extend the sentence "`restaurants/` is called by routes and by `orders/`-style
   modules, and calls only `audit/` and reads constants from `permissions/keys.ts`." with "and may
   import `CHART` and `ensureChart` from `accounting/chart.ts` for its initializer entry
   (`accounting/` never calls back); `updateSettings` bumps `menu_version` by an inline SQL
   increment, never by calling `menu/`"; (ii) add, after the `src/lib/money/` sentence, "`src/lib/
   sync-ops/` is ISOMORPHIC under the same rule and imports nothing at all; `pos-sessions/` calls
   `accounting/`, `permissions/` and `audit/` and is called by `orders/`; `reports/` is called by
   `(dashboard)` routes only and calls nothing."
6. Read the whole diff once: `git diff CLAUDE.md`. Exactly two lines may begin with a single `-`
   (the old row 4 and the old house-convention paragraph); everything else is an insertion. If a
   third `-` line appears, an existing decision was touched — undo that.
7. Commit: `T-02 docs(claude): record the pos-sales defaults and decisions`.

**Tests:**
- `pnpm lint` passes. Note that `.prettierignore` lists `CLAUDE.md` ("The rulebook. … a
  whole-file reformat makes impossible to satisfy"), so Prettier neither checks nor reflows this
  file: the lint run guards against collateral damage elsewhere, and the Markdown itself is checked
  by eye against the neighbouring bullets — one bullet per line, `- **…**` lead-in, no wrapped
  lines.
- `grep -c '2026-09-28' CLAUDE.md` prints 13 (twelve bullets plus row 4 make 13; a lower count
  means a bullet or the row-4 amendment is missing).
- `grep -c 'presented with a default on 2026-09-28' CLAUDE.md` prints at least 12 — the
  provenance sentence is in every appended bullet.
- `grep -c 'NEVER auto-completed offline unless the provider/terminal explicitly supports offline
  authorization' CLAUDE.md` prints `2` — the invariant 5 sentence, once in invariant 5 and once
  quoted verbatim in bullet (b).
- `grep -n 'pos-sessions/\|sync-ops/\|reports/' CLAUDE.md` prints the three tree lines (and the
  bullets that mention them).
- `git diff CLAUDE.md | grep -c '^-[^-]'` prints `2`.

**Done when:** `grep -c '2026-09-28' CLAUDE.md` prints 13; the tree in "Where code lives"
lists `pos-sessions/`, `sync-ops/` and `reports/`; `git diff CLAUDE.md | grep -c '^-[^-]'` prints
`2`; `pnpm lint` exits 0.

**Watch out:** Do not remove or reword any existing decision — append only; a diff that touches
the roles bullet, the tax bullet or the currency bullet is wrong. Never soften the invariant 5
sentence: quote it, do not paraphrase it. Do not delete row 4 (precedent: rows 2, 3, 6). Nothing
here decides approval limits (open decision 6), a Manager role (decision 5) or a delivery order
type — do not let a bullet imply one. Anchors by `grep`, never by line number: PR #11 moved every
line below "Where code lives". Every `*_minor` mention in a bullet is an integer of minor units in
a `bigint` column — write `850` for $8.50, never `8.50`.

### T-03 — Create the isomorphic sync-op contract `src/lib/sync-ops/`

**Needs:** T-02
**Files:**
- `src/lib/sync-ops/index.ts` — NEW
- `src/lib/sync-ops/index.test.ts` — NEW
- `eslint.config.js` — EDIT (the SECOND `no-restricted-imports` config object — the one whose
  `files` is `['src/lib/money/**/*.ts']`, directly under the comment beginning `// src/lib/money is
  ISOMORPHIC`; add `'src/lib/sync-ops/**/*.ts'` to that `files` array and widen the comment and the
  rule's `message` to name both modules. Leave the FIRST block — `files: ['src/lib/pos/**/*.{ts,
  svelte}', 'src/routes/(pos)/**/*.{ts,svelte}']` — untouched: it must keep allowing imports of
  `$lib/sync-ops`, exactly as it allows `$lib/money`)
**Spec:** 6 ("Every operation carries a unique ID generated on the device"; invoice numbers
`POS1-000001` from the device's own sequence, "gap-free per device, and the server enforces
uniqueness on (device, number)"; "A second terminal later simply gets its own prefix (`POS2-…`)"),
13 (order types; the order and item status tables), 10 (POS sessions; opening cash; counted cash),
17 (money is integers in minor units)
**Invariants:** 1 (money is integer minor units — on the wire a DECIMAL STRING of that integer,
never a JavaScript `number`), 5 (every queued operation carries a device-generated idempotency
key; invoice numbers come from the device's gap-free sequence), 7 (each line snapshots its own unit
price and tax rate — the payload carries both), 8 (permissions are enforced server-side — the
envelope carries `employeeId` and `deviceId` so the server can check them)

**Do:**
1. Pre-check: `ls src/lib/sync-ops` must FAIL (`No such file or directory`). If the directory
   exists, stop and report: the repo is not in the state this plan assumed.
2. Create `src/lib/sync-ops/index.ts`. Open with a header comment in the style of
   `src/lib/pin/index.ts` and `src/lib/money/index.ts` that says, in this order: THE SYNC-OP
   CONTRACT — the one definition of what the till queues and the server records; it is
   ISOMORPHIC, imported by `src/lib/server/**` (T-18's validator, T-21's handler), by
   `src/lib/pos/**` (the queue and the cart) and by `src/routes/(pos)/**`; and it **imports
   NOTHING** — no sibling module, no `$lib/*`, no `$app/*`, no package, no `node:` builtin — with
   the literal phrase `imports NOTHING` in the comment (the test in step 8 looks for it). State
   that every `*Minor` field is a DECIMAL STRING of the integer minor value (`"850"` is $8.50)
   because `JSON.stringify` throws on a `bigint` and a `number` would silently drop the money
   brand and, above 2^53, precision; the conversion to `Minor` happens in the consumer at the
   boundary with `minor(BigInt(value))` from `src/lib/money`, never here; this module does no
   arithmetic and no rounding.
3. Export EXACTLY the constants, types and two functions from `00-overview.md`'s "Shared
   contracts" block, with the names, literal values, member order and field names copied verbatim:
   `OP_KINDS`, `OpKind`, `ORDER_TYPES`, `PAYMENT_METHODS`, `ORDER_STATUSES`, `LINE_STATUSES`,
   `SESSION_STATUSES`, `OP_STATUSES`, `SOFT_FLAGS`, `HARD_FLAGS`, `OpEnvelope<K, P>`,
   `SaleCompletePayload`, `SaleLine`, `SalePayment`, `SessionOpenPayload`, `SessionClosePayload`,
   `SaleAbandonedPayload`, `PinLoginPayload`, `SyncResult`, `formatInvoiceNumber`,
   `parseInvoiceNumber`. Every list is `as const`. Add these TYPE aliases (types only — no further
   runtime export, no `default` export): `OrderType`, `PaymentMethod`, `OrderStatus`,
   `LineStatus`, `SessionStatus`, `OpStatus`, `SoftFlag`, `HardFlag`, each `(typeof LIST)[number]`
   of its list — later tasks name `SoftFlag` and `HardFlag` (`validateSale`, `recordSale`). In the
   payload types write the unions through those aliases (`orderType: OrderType`, `method:
   PaymentMethod`) so a list and its use cannot drift. `taxMode` is `'exclusive' | 'inclusive'`,
   spelled locally as `type TaxMode = 'exclusive' | 'inclusive'` — NOT imported from
   `src/lib/money/tax.ts` (this module imports nothing); the test in step 8 pins the two spellings
   together, and `restaurant_settings_tax_mode_valid` in the database holds the same two literals.
4. The `*Minor` fields — `unitPriceMinor`, `discountMinor`, `priceDeltaMinor`, `subtotalMinor`,
   `taxMinor`, `totalMinor`, `amountMinor`, `tenderedMinor`, `changeMinor`, `openingCashMinor`,
   `countedCashMinor`, `expectedCashMinor`, `differenceMinor` — are typed `string` (or `string |
   null` exactly where the contract says so: `tenderedMinor`, `changeMinor`), never `bigint`,
   never `number`. Put the one-line comment `// DECIMAL STRING of the integer minor value ("850" is
   $8.50) — never a number, never a bigint` beside the first of them and a shorter `// decimal
   string` beside each of the others. `quantity`, `taxRateBp`, `lineNo`, `seq`, `invoiceSeq` and
   `menuVersion` are integers of things, not money, and stay `number`.
5. `formatInvoiceNumber(deviceCode: string, seq: number): string`. Module-private constants
   (`const`, not exported): `DEVICE_CODE_PATTERN = /^[A-Z0-9]{1,8}$/`, `INVOICE_SEQ_MIN = 1`,
   `INVOICE_SEQ_MAX = 999_999`, `INVOICE_SEQ_DIGITS = 6`. Validate in this order and throw a
   `RangeError` (never a plain `Error`, so a caller can distinguish a contract violation from an
   I/O failure): `typeof deviceCode !== 'string' || !DEVICE_CODE_PATTERN.test(deviceCode)` →
   `RangeError('device code must match /^[A-Z0-9]{1,8}$/')`; `!Number.isInteger(seq) || seq <
   INVOICE_SEQ_MIN || seq > INVOICE_SEQ_MAX` → `RangeError('invoice seq must be an integer from 1
   to 999999')`. Return `` `${deviceCode}-${String(seq).padStart(INVOICE_SEQ_DIGITS, '0')}` ``. So
   `formatInvoiceNumber('POS1', 6)` is `'POS1-000006'` — spec 6's `POS1-000001` shape, six digits,
   one hyphen, upper-case device code.
6. `parseInvoiceNumber(value: string): { deviceCode: string; seq: number } | null`. Never throws.
   Module-private `INVOICE_NUMBER_PATTERN = /^([A-Z0-9]{1,8})-(\d{6})$/` — no `u` flag, so `\d`
   is ASCII `0-9` only (the same reason `src/lib/pin/index.ts` gives: a full-width or Arabic-Indic
   digit must not parse), and no `m` flag, so `$` does not match before a trailing newline. Return
   `null` when `typeof value !== 'string'` or the pattern does not match; parse `seq =
   Number(match[2])`; return `null` when `seq < INVOICE_SEQ_MIN` (`POS1-000000` is not a number the
   sequence can issue); otherwise `{ deviceCode: match[1], seq }`. Round trip:
   `parseInvoiceNumber(formatInvoiceNumber(c, s))` deep-equals `{ deviceCode: c, seq: s }` for
   every valid `c`, `s`.
7. Edit `eslint.config.js`: in the second `no-restricted-imports` block change `files:
   ['src/lib/money/**/*.ts']` to `files: ['src/lib/money/**/*.ts', 'src/lib/sync-ops/**/*.ts']`,
   change the comment's opening to say both `src/lib/money` and `src/lib/sync-ops` are ISOMORPHIC,
   and change the `message` so it names the file that tripped it in general terms ("this module is
   isomorphic — the POS imports it in the browser, so an import of $lib/server/** from here cannot
   work offline …"). The `patterns[0].group` list stays byte-identical to the first block's, as
   its comment demands. ESLint blocks only the `$lib/server` import here; "imports nothing" in
   full is enforced by the source-text test below — the same division of labour `src/lib/money`
   uses (`eslint.config.js` for the dangerous import, a test for all of them).
8. Create `src/lib/sync-ops/index.test.ts` (Vitest `describe`/`it`/`expect`; the `unit` project
   picks up `src/**/*.test.ts` automatically, and it defines NO `$lib` alias — see
   `vitest.config.ts` — so import RELATIVELY: `./index` and `../money/tax`). The test file may
   import `node:fs`; only the module under test may not. Cases, each with its expected value, are
   in **Tests** below. For the source-text case use the repository's idiom (`src/lib/theme.test.
   ts`, `src/lib/pos/menu-snapshot.test.ts`): `readFileSync(new URL('./index.ts', import.meta.url),
   'utf8')`, then strip comments before matching with the three-regex `stripComments` from
   `src/lib/components/components.test.ts` (HTML comments, block comments, line comments — nothing
   else), because
   the header comment legitimately contains the word "import".
9. Run `pnpm test:unit src/lib/sync-ops`, `pnpm lint` and `pnpm check`. Commit:
   `T-03 feat(sync-ops): isomorphic sync-op contract`.

**Tests:** (`src/lib/sync-ops/index.test.ts`; none of spec 29's six areas is touched here — this
module holds no arithmetic, no posting and no route — so nothing is marked MANDATORY)
- `formatInvoiceNumber('POS1', 6)` → `'POS1-000006'`; `('POS1', 1)` → `'POS1-000001'`;
  `('POS1', 999999)` → `'POS1-999999'`; `('A', 42)` → `'A-000042'`; `('ABCDEFGH', 7)` →
  `'ABCDEFGH-000007'`.
- Out-of-range sequence throws `RangeError`: `('POS1', 0)`, `('POS1', 1000000)`, `('POS1', 1.5)`,
  `('POS1', NaN)`, `('POS1', -1)` — each `expect(() => …).toThrow(RangeError)`.
- Bad device code throws `RangeError`: `('pos1', 1)` (lower case), `('', 1)`, `('POS-1', 1)`
  (hyphen), `('ABCDEFGHI', 1)` (nine characters), `('POS 1', 1)` (space).
- Parse round-trips: for every `deviceCode` in `['POS1', 'A', 'ABCDEFGH', 'T2']` and every `seq`
  in `[1, 42, 999999]`, `parseInvoiceNumber(formatInvoiceNumber(deviceCode, seq))` deep-equals
  `{ deviceCode, seq }`.
- `parseInvoiceNumber('POS1-1')` → `null`; `'POS1-000000'` → `null`; `'pos1-000001'` → `null`;
  `'POS1-0000001'` (seven digits) → `null`; `'POS1-00001'` (five digits) → `null`; `''` →
  `null`; `'POS1-000001\n'` → `null`; `'POS1-00000１'` (full-width digit) → `null`;
  `'POS1-000001-2'` → `null`; `undefined as unknown as string` → `null` (no throw).
- The lists: `OP_KINDS` deep-equals `['session.open', 'session.close', 'sale.complete',
  'sale.abandoned', 'pin.login']`; `OP_STATUSES` deep-equals `['accepted', 'recorded_flagged',
  'unrecorded']`; `SOFT_FLAGS` has length 7 and `HARD_FLAGS` length 7 and the two share no
  member; `ORDER_TYPES` deep-equals `['dine_in', 'takeaway']`; `PAYMENT_METHODS` deep-equals
  `['cash', 'card', 'mobile']`; `ORDER_STATUSES` deep-equals `['open', 'billed', 'paid', 'voided',
  'refunded']`; `LINE_STATUSES` deep-equals `['new', 'sent', 'voided']`; `SESSION_STATUSES`
  deep-equals `['open', 'closed']`.
- Tax-mode pin: `TAX_MODES` imported from `../money/tax` deep-equals `['exclusive', 'inclusive']`,
  and a compile-time assertion that the two spellings are the same type — for example `const
  sameTaxMode: SaleCompletePayload['taxMode'] extends TaxMode ? (TaxMode extends
  SaleCompletePayload['taxMode'] ? true : never) : never = true;` with `TaxMode` imported from
  `../money/tax`, followed by `expect(sameTaxMode).toBe(true)` so the constant is USED (an unused
  constant fails `pnpm lint` under `no-unused-vars`) — a drift makes the type `never` and fails
  `pnpm check`.
- Wire safety: an `OpEnvelope<'sale.complete', SaleCompletePayload>` literal with `taxMode:
  'exclusive'`, one line at `unitPriceMinor: '850'`, `taxRateBp: 825`, `quantity: 2`, one modifier
  at `priceDeltaMinor: '50'`, totals `{ subtotalMinor: '1800', discountMinor: '0', taxMinor: '149',
  totalMinor: '1949' }` (1800 × 8.25% = 148.5, half away from zero → 149) and one cash payment
  `{ amountMinor: '1949', tenderedMinor: '2000', changeMinor: '51' }` survives
  `JSON.parse(JSON.stringify(envelope))` deep-equal to itself. Beside it, the reason the wire type
  is `string`, asserted on a plain object so it compiles: `expect(() => JSON.stringify({ v: 850n
  })).toThrow(TypeError)` (`Do not know how to serialize a BigInt`).
- Source-text guard on `index.ts` after comment stripping: `expect(stripped).not.toMatch(
  /^\s*import\b/m)`; `not.toMatch(/\bfrom\s+['"]/)` (catches `export … from`); `not.toMatch(
  /\bimport\(/)`; `not.toMatch(/\brequire\(/)`. On the RAW text: `expect(source).toContain(
  'imports NOTHING')` — the header's promise must stay written down.

**Done when:** `pnpm test:unit src/lib/sync-ops` passes every case above; `pnpm lint` exits 0
(ESLint's widened block accepts the new files, Prettier accepts their formatting); `pnpm check`
reports 0 errors; `grep -c '^import' src/lib/sync-ops/index.ts` prints `0`; and `grep -n
'sync-ops' eslint.config.js` prints the widened `files` line.

**Watch out:** Every `*Minor` field on the wire is a decimal STRING; the types must say `string`,
never `bigint` or `number`, because `JSON.stringify` throws on a bigint — a `bigint` typed here
would compile, pass every unit test that never serialises, and then throw on the first real flush.
Do not import `TaxMode`, `Minor` or anything else from `src/lib/money` into `index.ts` — restate
the two-literal union locally and let the test pin it. Keep `\d` without the `u` flag. Validate
`seq` as an integer BEFORE `String(seq)`, so exponent notation (`1e21`) can never reach `padStart`.
This module only FORMATS and PARSES invoice numbers; taking the NEXT number is
`src/lib/pos/invoice-sequence.ts` (T-23) on the device, and the server never numbers anything
(invariant 5: no global sequence, no `max(number)+1`). Do not rename, reorder or add a member to
any list — `pos_sync_ops`, `orders`, `order_lines`, `payments` and `pos_sessions` (T-04–T-07) copy
these literals into text CHECKs by hand, and a test in T-08 pins each pair together.
