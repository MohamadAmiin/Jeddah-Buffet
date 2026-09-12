# Verification lenses — the five adversarial briefs

Lenses run in parallel, each hunting in one dimension: **the full five before the PR; the `invariants`
and `tests` pair at each intermediate phase gate, scoped to that phase's task IDs**
(`references/verification.md` §2 is the authority on which run when — defer to it). Dispatch each
section below as one subagent's entire brief, with the **dispatch block** prepended verbatim — the
subagent has no other context.

## Dispatch block — prepend to every lens, filling the values in

```bash
PLAN='<path to tasks/<slug>.md, or the plan directory>'
SCOPE='<the task IDs this run verifies — one phase, or all>'
WORKTREE='<absolute path of the worktree or repo you inspect>'
BASE='<base ref or sha the branch forked from, or ROOT if the branch has no base>'
HEAD='<branch name>'
```

**These are shell assignments, not a header.** Substitute every value before running anything: an unset
one does not fail loudly — `cd ""` succeeds and returns 0, and an empty `$RANGE` makes `git diff` show
the working tree instead of the branch, so a lens can verify the wrong tree and report PASS.
**Judge only the task IDs in `SCOPE`.** A task outside it is not missing; it has not been started yet.

You are an adversarial verifier: **prove the work is not done.** You are not a reviewer suggesting
improvements. The executor's own report is a claim, never evidence.

**Read-only.** Allowed: `git log/show/diff/status/rev-parse`, `cat`, `sed`, `grep`, `find`, and —
lenses 1 and 2 only — the project's non-writing test/check command. Forbidden: editing any file,
`git add/commit/checkout/switch/stash/reset/clean/worktree/push`, installing packages, running
migrations, touching the database. Scratch output goes in your scratchpad; what you cannot check
read-only is `UNVERIFIED`, never a pass.

Get the diff — nothing below is guaranteed to exist today:

```bash
[ -n "$WORKTREE" ] && [ -d "$WORKTREE" ] || { echo "WORKTREE unset or missing — report and stop"; exit 1; }
[ -n "$BASE" ] || { echo "BASE unset — report and stop; never guess a base branch"; exit 1; }
cd "$WORKTREE" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOT A GIT REPO — report and stop"; exit 1; }
if [ "$BASE" = "ROOT" ] || ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  EMPTY=$(git hash-object -t tree /dev/null); RANGE="$EMPTY..HEAD"; LOGRANGE="HEAD"  # no base branch
else
  RANGE="$BASE...HEAD"; LOGRANGE="$BASE..HEAD"
fi
git log --oneline $LOGRANGE   # one commit per task is the contract
git diff --stat $RANGE        # shape
git diff $RANGE               # the text you must quote from
git status --porcelain        # uncommitted work is itself a finding
```

**Evidence or silence.** Every finding carries `path:line`, the commit sha and the offending code
quoted from the diff. A finding you cannot anchor that way is not reportable — drop it.

**Severity** (identical to references/verification.md): **BLOCKER** — breaks a CLAUDE.md invariant,
corrupts money, accounting, inventory, permissions or offline correctness, or an in-scope task is not
actually done; it blocks the PR until fixed or explicitly overridden by the user. **MAJOR** — a real
defect or a divergence from plan or spec that does not corrupt money, posted data or access control.
**MINOR** — naming, dead code, a missing comment. Tie-break: money, double-entry, immutability,
permissions or offline idempotency involved ⇒ BLOCKER.

**Report nothing rather than pad. An empty findings list is a valid and respectable result.** A
manufactured MINOR costs the user more than it saves. Output exactly:

```
LENS: <name>   VERDICT: PASS | FINDINGS
### <BLOCKER|MAJOR|MINOR> — <one-line claim>
Evidence: <path>:<line> (<sha7>)
    <quoted code>
Violates: invariant <n> (<name>) | spec <n> | task T-nn <field> | plan <section>
Fix: <smallest concrete change that resolves it>
Checked and clean: <one line naming what you verified and found sound>
UNVERIFIED: <what you could not check read-only, and why>
```

---

## LENS 1 — COMPLETENESS

**Prove that a task reported done is not done.** Not "could be better" — not done.

Checklist, per task ID in SCOPE:

1. **Inventory the plan.** `grep -rn '^### T-' "$PLAN"`. In a directory plan, cross-check the IDs in
   the phase files against the complete index in `00-overview.md`: an ID in one and not the other is
   a finding on its own (MAJOR), because the executor may have run a partial list.
2. **One commit per task.** Every in-scope `T-nn` must appear in exactly one commit subject in
   `git log --oneline $LOGRANGE`. No commit → the task never landed (BLOCKER). One commit carrying
   two IDs → the 1:1 revert guarantee is gone (MAJOR). Two commits for one ID → MINOR, unless the
   second is an unreported fix for a defect, which you then report on its own merits.
   **Exception.** A task may legitimately have no commit when an earlier task already satisfied it
   (`references/worktree-git.md` §3 forbids an `--allow-empty` commit for it). That is acceptable only
   if the phase report and the PR checklist carry the line
   `T-nn <title> — no commit (already satisfied by T-mm)` **and** T-mm's diff actually contains what
   T-nn's `Done when:` requires — check it, do not take the claim. Verified ⇒ MINOR (note it).
   Unverified or unrecorded ⇒ BLOCKER, the task never landed.
3. **Files tags.** `git diff --name-status $RANGE`. `NEW` must appear as `A`; a `NEW` path showing
   `M` means it already existed and the plan's assumption is broken (BLOCKER — stop, the repo is
   not in the state the plan assumed). `EXTEND` must show `M` **and** keep everything the creating
   task wrote: `git show <creating-sha>:<path> | diff - <path>` — if symbols from the creating task
   vanished, the file was rewritten wholesale, which task-format forbids (BLOCKER). `EDIT` must land
   at the stated location: the new code inside `payOrder()`, not appended at the end of the file.
4. **Evaluate `Done when:` — do not read it.** If it names a command, run it if and only if the
   command is read-only (`pnpm test`, `pnpm check`, `git log`). `pnpm db:migrate`, `db:generate`,
   `db:push`, `docker compose up` write — never run them; mark `UNVERIFIED (writes)` and hand it to
   the user. If it names a DB constraint rejecting a row and there is no database, say
   `UNVERIFIED (no database)` explicitly. Silence is not a pass.
5. **Compare the wording.** Quote the plan's `Done when:` beside the executor's claim. Any softening
   — "the rollback test passes" claimed as "the code compiles", "a manually paid order produces two
   entries" claimed as "the function returns two objects" — is MAJOR, and BLOCKER when that check was
   the only proof of a money or posting behaviour.
6. **Stub hunt** in every added file: `grep -rnE 'TODO|FIXME|not implemented|throw new Error\(.[Nn]ot|: any\b' -- <added paths>`. A file that exists with a body that
   does nothing satisfies no Done-when (BLOCKER). A bare `return null` / `return []` / `return {}` is a
   stub **only when the task's `Do:` steps do not call for it** — task-format's own worked T-07 step 3
   mandates `return null` for a zero-cost COGS entry ("a zero entry is trial-balance noise"). Match it
   with `grep -rnE '^\s*return (null|\[\]|\{\});?\s*$' -- <added paths>` if you like, then read the
   task's `Do:` steps before reporting: a planned early return is not a stub.
7. **Wiring.** For every symbol a task said to call from a named place, grep for the call site:
   `grep -rn 'postCogs(' src/`. Defined and exported but never called from the place the task named
   is the single most common false "done" (BLOCKER).
8. **Named tests exist and bite.** For each path `$f` under `Tests:`: `test -f "$f"`;
   `grep -cE 'it\(|test\(' "$f"` > 0; `grep -nE '\.skip|\.todo|xit\(|^\s*//.*expect\(' "$f"` returns
   nothing; `grep -c 'expect(' "$f"` > 0. **Give every grep a file operand** — one without reads stdin
   and blocks until your tool call times out. A test file with zero assertions is a stub (BLOCKER when
   the case was marked `MANDATORY (spec 29)`).
9. **Silently dropped tasks.** Walk `Needs:` chains: if T-05 has no commit because "T-07 covered
   it", that is a dropped task, not a merge — report it with both task texts quoted.
10. **Uncommitted leftovers.** `git status --porcelain`: a generated migration under
    `src/lib/server/db/migrations` left untracked means the schema lives in nobody's branch (BLOCKER).
    Anything under `tasks/` staged is a separate BLOCKER — `tasks/` is gitignored deliberately.

Known ways this project fakes completeness: the deferred `debits = credits` constraint omitted
because drizzle-kit does not generate it, so the migration "exists" but invariant 3 is unenforced; a
test file created empty because Phase 0 never installed Vitest; a posting rule written and never
called from `payOrder()`; a `Done when` naming a constraint nobody ever started PostgreSQL to test.

---

## LENS 2 — TESTS

**Prove the suite does not run, does not pass, or does not test anything.** A passing claim in a
report is not evidence; the only evidence is output you produced.

1. **Detect the harness before judging it.** `ls package.json` → absent: there is no suite, so any
   in-scope task whose `Done when:` names `pnpm test` cannot have passed (BLOCKER) — unless
   scaffolding was out of SCOPE, then `UNVERIFIED (no harness)`. `command -v pnpm || command -v npm`
   → neither: `UNVERIFIED (no package manager)`. `ls node_modules` → absent: do **not** install, that
   writes to the worktree; report `UNVERIFIED (deps not installed)` and name the command the user runs.
2. **Run it, keep the output.** `CI=1 pnpm test --run 2>&1 | tee "$SCRATCH/test.out"; echo "exit=${PIPESTATUS[0]}"`.
   `--run` is mandatory — Vitest otherwise enters watch mode and hangs the lens. A non-zero exit is
   a BLOCKER; quote the failing test names and the assertion diff verbatim from `test.out`.
3. **Read the summary line, not the green.** Any `skipped`, `todo`, or a file count lower than the
   test files on disk is a finding. `grep -rn '\.skip(\|\.only(\|\.todo(\|xit(\|xdescribe(' src/` —
   a single `.only` silently shrinks the run to one test while printing green (BLOCKER).
   `grep -rn '^\s*//\s*\(it\|test\|expect\)(' src/` catches tests commented out to get green.
4. **Spec 29's six mandatory areas.** For each one the diff touches, find a real test or report a
   BLOCKER:
   - *Money arithmetic and rounding* — asserts exact minor-unit integers. Tax is computed at full
     precision per line and rounded **once** on the invoice total (spec 17), so a test asserting a
     rounded per-line **tax** amount is itself a finding — while a per-line **subtotal** (qty ×
     unit price, exact in integer minor units) is correct and must **not** be flagged. Spec 17's
     rounding rule rides on open decision 3, so flag it, never assume it.
   - *Tax in **both** modes* — exclusive and inclusive. Spec 17's table is the oracle: 10% on a
     $10.00 exclusive menu price and on an $11.00 inclusive price both yield revenue $10.00, tax
     $1.00, customer pays $11.00. Only one mode tested = half a test (BLOCKER).
   - *Journal entries balance* — a property test over generated events **and** a test that the
     database rejects an unbalanced entry at COMMIT. A TypeScript-only assertion does not satisfy
     invariant 3; if the DB half cannot run here, say `UNVERIFIED (no database)` rather than pass it.
   - *One posting-rule test per spec 24 business event* the feature touches — enumerate the events
     from the spec 24 table and name any that has no test.
   - *Offline sync retries never duplicate* — the test must replay the identical idempotency key
     twice and assert row counts unchanged. "Second call does not throw" is not that (BLOCKER).
   - *Permission check per POS API route* — `find src/routes -name '+server.ts' -o -name '+page.server.ts'`,
     then check each has a test asserting `403` for a role that may not call it. Missing routes are
     a BLOCKER each.
5. **Do the assertions assert?** `grep -rnE 'expect\(true\)|expect\(1\)\.toBe\(1\)|toBeDefined\(\)|toMatchSnapshot\(\)' src/`.
   `toBeDefined()` on a money total, and a snapshot recorded from the current (possibly wrong)
   output, are non-assertions. `await expect(fn()).rejects` missing its `await` passes regardless.
6. **Would it fail if the implementation were deleted?** Take the two or three assertions that carry
   the most weight and answer that question by reading test and implementation together (you may not
   edit to find out). `expect(total).toBeGreaterThanOrEqual(0)` survives every wrong implementation
   — MAJOR, BLOCKER if it is the only test for a mandatory area.
7. **Tests written to fit the code, not the spec.** Flag any expected value produced by calling the
   function under test, or transcribed from a console log. The oracle is the spec's worked example:
   spec 24's $10.00 menu / 10% discount / 10% tax must give `Dr Cash 990`, `Dr Sales Discounts 100`,
   `Cr Sales Revenue 1000`, `Cr Tax Payable 90` in minor units. A test asserting anything else is a
   BLOCKER even when it is green.
8. **bigint traps.** `expect(total).toBe(1550)` fails against `1550n`, so a passing test there is
   really asserting something else; `Number(total)` comparisons discard precision. Quote both.

---

## LENS 3 — INVARIANTS

**Read the diff against CLAUDE.md's twelve invariants, one at a time.** Open CLAUDE.md — do not
recall it. Every confirmed violation is a **BLOCKER**, including one the plan itself asked for (then
report the plan too). This lens finds the most; it still reports nothing when there is nothing. Run
each grep over the diff (`git diff $RANGE -U0 | grep -nE ...`) and over the added files.

**A grep that produced no output because it errored is not a pass — check the exit status.** `grep`
exits 1 when it matched nothing and **2** when the command itself was wrong (a directory with no `-r`,
a missing file operand, a bad pattern); a `2` means the item is `UNVERIFIED`, never clean. Give every
grep an explicit path list, and `-r` whenever the path is a directory.

1. **Money is integer minor units.** The money smell — `parseFloat`, `toFixed(`, `Number(` and a bare
   decimal literal — is searched **only in money paths**, never over the whole diff and never over
   `package.json`, `pnpm-lock.yaml` or `*.config.*`, where every version pin (`"vitest": "^1.6.0"`)
   matches and none of it is money:
   ```bash
   git diff $RANGE -U0 -- 'src/lib/server/money' 'src/lib/server/orders' 'src/lib/server/accounting' 'src/lib/pos' \
     | grep -nE 'parseFloat|toFixed\(|Number\(|[0-9]+\.[0-9]+'
   ```
   Also: a money column typed `numeric|decimal|real|doublePrecision` instead of `bigint` in
   `src/lib/server/db`; money arithmetic anywhere outside `src/lib/server/money`; a second rounding
   helper — `grep -rn 'Math\.round\|function round\|roundHalf' src/ | grep -v 'server/money/'`.
   **Ingredient and stock-movement quantities** must be `numeric(12,3)` — this is the ONE exception
   invariant 1 grants, and it covers recipe amounts and stock movements only. An order line's item
   count (how many burgers) is an ordinary `integer`; flagging it is a false positive.
2. **Posted records are permanent.** `git diff $RANGE | grep -nE '\.update\(|\.delete\(|UPDATE |DELETE FROM'`,
   then read the target: `orders` (once PAID), `invoices`, `payments`, `stock_movements`,
   `journal_entries`, `journal_entry_lines`. An `OPEN → BILLED → PAID` status write on an unpaid
   order is legitimate; anything that rewrites a paid order or the five posted tables is a BLOCKER,
   as is a migration doing it. The fix is always a reversing record plus a new correct one.
3. **Journal entries balance in the database.** A migration creating the journal tables must carry
   the constraint as raw SQL — drizzle-kit will not generate it. Scope the check to the journal
   migration; a bare `CHECK` grep over the whole migrations directory matches any check constraint
   (`CHECK (status IN ('OPEN','BILLED',…))`, `CHECK (quantity >= 0)`) and false-passes on the most
   expensive invariant in the project:
   ```bash
   JM=$(grep -rlE 'CREATE TABLE[^;]*journal_entry_lines' src/lib/server/db/migrations)
   [ -n "$JM" ] && grep -nE 'DEFERRABLE|INITIALLY DEFERRED|CONSTRAINT TRIGGER|CREATE FUNCTION' "$JM"
   ```
   `$JM` empty **and** no in-scope task created the journal tables → report nothing. `$JM` non-empty
   with no hit, or a hit that does not name debit/credit → BLOCKER. **Read the matched line**: a
   `CHECK` on an unrelated column is not this constraint, and a row-level `CHECK` on a single line
   cannot enforce invariant 3 (the sum of an entry's debit and credit lines, checked at COMMIT) and is
   itself a BLOCKER. Also read every posting function: the lines it inserts must sum debit = credit for
   every branch, and no code path may type a debit that did not come from the spec 24 table.
4. **One all-or-nothing transaction, at payment.** `grep -n 'db\.transaction' src/lib/server/orders/*.ts`
   — the payment path opens exactly one, spanning spec 13's sequence. A posting, deduction or audit
   function opening its own instead of taking `tx`, printing inside the transaction callback
   (`print|printAgent|ws://|http://localhost|fetch\(`), or finishing payment in two requests: each a BLOCKER.
5. **Offline sales are facts.** Every queued op needs a device-generated key that is **stable across
   retries**: a `crypto.randomUUID()` evaluated at send time instead of at enqueue time regenerates
   per attempt and duplicates the sale (BLOCKER). The key must back a UNIQUE index server-side. A
   synced sale failing validation must be stored and flagged, never discarded or 400'd away. Invoice
   numbers: `POS1-000001` from the device's gap-free sequence — a hit for `max\(|nextval|SERIAL` near
   invoice numbering is a BLOCKER, as is a missing `UNIQUE (device_id, invoice_number)`. Card and
   mobile must not auto-complete offline (fail closed: no receipt, no invoice number, order BILLED).
   `navigator.storage.persist()` present; logout and session close blocked while the queue is non-empty.
6. **Inventory is a ledger.** A write to any cached quantity column without an accompanying
   `stock_movements` insert in the same transaction is a BLOCKER, and so is a sale refused for stock
   levels (`if (onHand < needed) throw`) — negative stock is flagged, never prevented. Every sale
   posts `Dr 5000 / Cr 1200`; a purchase that does not recalculate the weighted average is a BLOCKER.
7. **Discount before tax; lines snapshot.** Tax computed on the undiscounted amount is a BLOCKER.
   Each order line must persist **both the unit price in minor units and the tax rate used at the time
   of sale** — whatever the plan's schema task named those columns; take the names from the task's
   `Do:` steps, not from this file. A line that reads the product's current price at render or report
   time is a BLOCKER. Tax mode must come from settings, never hardcoded:
   ```bash
   grep -rn 'TAX_RATE *=\|taxRate *= *0\.\|inclusive *= *\(true\|false\)' src/lib/server src/lib/pos
   ```
   (No bare `0\.1` alternative: it matches the string `"0.1.0"` in `package.json`.)
8. **Permissions server-side on every route, reads included.** The gate's function name is the plan's
   to choose — take it from the task's `Do:` steps, never from this file. Use the grep as a *discovery
   aid*, not an oracle:
   ```bash
   for f in $(git diff --name-only $RANGE | grep -E '\+(server|page\.server)\.ts$'); do
     grep -qiE 'permission|403|forbidden|requireRole|locals\.(user|session)' "$f" || echo "NO PERMISSION SIGNAL — read $f"
   done
   ```
   Every file printed must then be **READ end to end**; report a BLOCKER only when the read confirms
   there is no server-side permission gate returning `403` on that route (invariant 8 covers reads
   too). A route that checks nothing on `GET` is the same BLOCKER.
9. **Owner PIN approval** for refund, voiding a SENT item, discount above the limit, comp/staff meal,
   re-opening a paid order, opening the drawer without a sale, cash pay-out above the limit, and
   voiding an order any of whose items were SENT. The approval record must store action, acting
   employee, approver and reason code together, in one row.
10. **Audit in the same transaction.** `writeAudit(db, …)` instead of `writeAudit(tx, …)`, or an
    audit write placed after the transaction closes, is a BLOCKER (offline logins excepted).
11. **Business date, not calendar date.** `grep -rn "created_at::date\|date_trunc('day', *created_at)\|createdAt.*toISOString"` in reports, end-of-day and reconciliation — group by the session's business date.
    Column types too: every timestamp column is `timestamptz`, never naked `timestamp` —
    `grep -rn 'timestamp(' src/lib/server/db | grep -v 'withTimezone'` (the `-r` is required; without
    it grep exits 2 on the directory and the check silently finds nothing). `business_date` is a
    `date`, not a timestamp, and is correct as such.
12. **Device + PIN.** PIN hashed with anything fast (`createHash|sha256|md5`) instead of Argon2/bcrypt,
    a PIN in a log line, `localStorage` holding a session or token, a cookie missing
    `httpOnly`/`secure`/`sameSite`, or `csrf: { checkOrigin: false }` in `svelte.config.js` — each a
    BLOCKER. PINs 4–6 digits; 5 failures → 5-minute lockout plus an audit event; PIN screen only on a
    registered device.

---

## LENS 4 — PLAN VS DIFF

**Hunt the gap in both directions**: work nobody asked for, and work asked for that never happened.

**Side A — in the diff, not in the plan.** Extract the planned paths with
`grep -rhoP '^- \x60\K[^\x60]+' "$PLAN" | sort -u` (no `-P` on this grep? read the `Files:` lines by
eye) and compare against `git diff --name-only $RANGE | sort -u`. Every changed path in neither an
in-scope task's `Files:` list nor these exceptions is unplanned scope: a lockfile implied by a planned
dependency, a generated migration under `src/lib/server/db/migrations` named by a schema task, a
`.gitignore` line the plan called for.
- **Dependencies**: `git diff $RANGE -- package.json`. Every new dependency must trace to a task.
  `decimal.js`, `dinero.js`, `big.js` sidestep invariant 1; `redis`/`ioredis`, `bull`, `node-cron`
  are on the do-not-build list. Untraceable dependency = MAJOR; money or do-not-build = BLOCKER.
- **Config**: `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `drizzle.config.ts`,
  `docker-compose.yml`, CI files. An unplanned change here is MAJOR; one that weakens CSRF, origin
  checks or cookie flags is a BLOCKER (invariant 12).
- **Opportunistic refactors**: renames, moves and reformatting in files no task listed. Find them in
  `git diff --stat $RANGE` outliers and `--name-status` `R` entries.
- **Do NOT build**: `git diff $RANGE | grep -niE 'redis|materialized view|summary table|cron|kitchen display|\bkds\b|deliveryOrder|delivery_order|order_type.*delivery|branch_id|tenant_id|warehouse|manager role'`.
  (A bare `delivery` is **not** the pattern: spec 10's own worked pay-out example is "paying for an ice
  delivery", so a reason string, fixture or comment trips it.) **Three legitimate hits you must NOT
  report**: the print agent's local WebSocket/HTTP (spec 11); `device_id` columns, which CLAUDE.md
  requires as a seam; and account `2000` Accounts Payable with its purchase-on-credit and
  supplier-paid postings, which spec 19 and CLAUDE.md put **in** the MVP — it is supplier
  *management* (supplier records, statements, ageing) that is on the Later list.

**Side B — in the plan, not in the diff.** For every in-scope task: each `Files:` path present; each
numbered `Do:` step observable somewhere in the diff — walk them one by one and name any step with no
diff evidence; each `Tests:` case present. Before calling something missing, check the phase boundary:
autonomy is per phase, so a task in a later phase is not missing, it is not started.

**Side C — decisions the executor was not entitled to take.**
- The header's **Approach** names one chosen option and the rejected ones with reasons. If the diff
  implements a rejected option, quote both lines — MAJOR, BLOCKER if the rejection reason was an
  invariant (e.g. "a synthetic order item breaks recipe deduction").
- The header's **Assumptions** lists open decisions the plan rides on and the task that must surface
  each one. If schema, a seed row or a posting rule hardcodes an answer that task had not obtained —
  an account code, a tax mode, a rounding rule, a currency, a payment method — that is a BLOCKER.
- **Spec 33's seven** answered silently: a costing method other than weighted average, a Manager
  role, a second terminal, a hardcoded tax mode, a second currency. BLOCKER.
- **Account codes**: every code in the diff must be one of spec 23's — 1000, 1010, 1020, 1030, 1200,
  2000, 2100, 3000, 3100, 3900, 4000, 4100, 4200, 5000, 5100, 5200, 6000, 6100, 6200, 6300, 6400,
  6800, 6900. An invented code is a BLOCKER; CLAUDE.md forbids inventing one — it must be proposed.
  A service charge, tip line, loyalty accrual or new payment method with no task behind it is the
  same defect, and the same BLOCKER.

**Severity rule for this lens:** unplanned scope is **MAJOR by default**, and **BLOCKER** when it
touches money, accounting or permissions, lands on the do-not-build list, or answers an open decision.
Do not soften it because the code looks good; the objection is that nobody agreed to it.

---

## LENS 5 — SPEC CONFORMANCE

**Open the spec sections each in-scope task cited and compare them with the code.** Never quote the
spec from memory: `grep -n '^## ' /home/mohamed-amiin/Desktop/matcami/docs/spec.md` to get the line
ranges, then `sed -n '<a>,<b>p'`. Every finding cites `docs/spec.md:<line>` **and** `path:line`.

- **Account codes and names verbatim from spec 23.** A wrong code is a BLOCKER; "Sales Discount" for
  `4100 Sales Discounts` is MINOR. 1020 is card clearing, 1030 mobile money — swapped is a BLOCKER.
- **Posting directions from the spec 24 table**, which side is debited:
  cash sale `Dr 1000 / Cr 4000 + Cr 2100`; card or mobile sale `Dr 1020` or `1030` in place of 1000;
  cost of food sold `Dr 5000 / Cr 1200`; sale with discount adds `Dr 4100 Sales Discounts` — a
  **debit**; cash refund `Dr 4200 + Dr 2100 / Cr 1000`; waste or void after preparation
  `Dr 5100 / Cr 1200`; comp or staff meal `Dr 5200 / Cr 1200`; count shortfall `Dr 5100 / Cr 1200`,
  surplus `Dr 1200 / Cr 5100`; purchase paid `Dr 1200 / Cr 1000|1010`, on credit `Dr 1200 / Cr 2000`,
  supplier paid `Dr 2000 / Cr 1000|1010`; clearing settled `Dr 1010 + Dr 6400 / Cr 1020|1030`;
  expense or POS pay-out `Dr <expense> / Cr 1000|1010`; cash shortage `Dr 6800 / Cr 1000`, overage
  `Dr 1000 / Cr 6800`; tax paid `Dr 2100 / Cr 1010`; owner invests `Cr 3000`; owner withdraws
  `Dr 3100`. The classic error: netting the discount out of revenue so 4000 is credited 900 instead
  of 1000 with no 4100 line. Spec 24's example is the oracle — `Dr Cash 990`, `Dr 4100 100`,
  `Cr 4000 1000`, `Cr 2100 90`, totals 1090 = 1090. BLOCKER.
- **Discount before tax** (spec 14, 17): tax is charged on the discounted amount. Check the order of
  operations in the totals function, not the comment above it.
- **Line snapshots** (spec 6, 17): every order line stores the unit price **and** the tax rate used,
  so a later menu or rate change cannot alter a past sale or its reprint.
- **Payment transaction order** (spec 13): record payment(s) → finalize totals → record invoice
  number → deduct inventory (recipe × quantity, **including modifiers** — a modifier changes the
  recipe as well as the price, spec 15 and CLAUDE.md's glossary; a deduction that walks only the base
  recipe understates COGS and consumption on every modified line, and is a BLOCKER) → create invoice →
  create journal entries (sale, then COGS) → mark PAID.
  A different order is MAJOR; taking the invoice number outside the transaction, or printing inside
  it, is a BLOCKER.
- **Statuses spelled exactly** (spec 13): orders `OPEN`, `BILLED`, `PAID`, `VOIDED`, `REFUNDED`;
  items `NEW`, `SENT`, `VOIDED`. `CANCELLED`, `COMPLETED`, `CLOSED` or lowercase variants: MAJOR, and
  BLOCKER if a constraint or report filter depends on the wrong spelling. Adding an item to a BILLED
  order re-opens it.
- **Approvals** (spec 8, 14): the seven owner-PIN actions, plus voiding an order any of whose items
  were SENT; reason codes mandatory on voids, refunds, discounts and comps; refunds go back to the
  original method and reduce expected drawer cash. Deleting a NEW item needs no approval, no reason
  code and no money or inventory effect — writing a void record there contradicts spec 14's table.
  **Permission keys** — spec 8 names cashier `pos.sell`, `pos.payment`, `pos.print_receipt`,
  `pos.void_unsent_item`, `pos.cash_payout`; waiter `pos.create_order`, `pos.view_menu`,
  `pos.modify_order`, `pos.send_to_kitchen`, `pos.transfer_table`. Spec 8 offers these as an example
  set, not a closed one (unlike spec 23's codes), so a key outside it is a finding **only when no
  in-scope task's `Do:` steps name it** — then it is an identifier the executor coined rather than
  proposed: MAJOR, BLOCKER if it gates money or an approval. A key the plan names but spelled
  differently in the code is a MAJOR on its own. **Reason codes come verbatim from spec 14**:
  customer changed mind, wrong item entered, kitchen error, quality complaint, other (with a note).
- **PIN rules** (spec 7): 4–6 digits; slow salted hash (Argon2 or bcrypt); 5 wrong attempts →
  5-minute lockout + audit event; idle return to employee select, default 2 minutes, configurable;
  the PIN screen only on a device the owner registered via a long-lived HttpOnly+Secure cookie,
  revocable from the dashboard; the owner has a POS PIN used for approvals.
- **Invoice numbering** (spec 6): device-scoped, gap-free, `POS1-000001` — prefix plus a zero-padded
  six-digit counter; the server enforces `UNIQUE (device, number)` and never renumbers; no global
  sequence, no `max(number)+1`.
- **Weighted average** (spec 16, 19): recalculated on **every** purchase, purchase units converted to
  base units first. Spec 16's oracle: 10 kg at $5.00 plus 10 kg at $6.00 = $110.00 / 20 kg = $5.50.
  Recipe cost and therefore COGS use the current average at the time of sale.
- **Session close** (spec 10): expected cash = opening + cash sales − refunds − pay-outs + pay-ins;
  the difference posts to 6800; close needs a connection and an empty queue; reports group by the
  session's one business date.
- **Menu sync** (spec 5): version compare, then the **full** snapshot replaces the local copy; a
  change-only sync endpoint is on the Later list (BLOCKER).

When the spec is silent on something the code decided, that is not a conformance finding — it is an
open decision and belongs to LENS 4. Say so rather than inventing a spec position.
