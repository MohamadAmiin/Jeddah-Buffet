# Executing one task, and closing a phase

Isolation is already done when you get here: the branch exists, you are in the worktree or on the branch, and the base ref is
recorded (`references/intake.md`). This file owns everything from there to the phase report; verification lives in
`references/verify-lenses.md`.

## 0. Run context — read once, carry it for the whole run

Before the first task of a run, and again after any session restart (context does not survive one):

1. **Read the plan header in full.** In a directory plan the header lives in `00-overview.md`, not in the phase file — a
   session handed `03-domain.md` alone is missing the entire why. Read `00-overview.md` first, with its full task index.
2. Write down and keep: the **Goal**; **Scope OUT**; the **chosen approach and the rejected ones with their reasons**; the
   **risks that survived adversarial verification** and the mitigation each is owed; the **Assumptions** (every open decision
   the plan rides on, with the task that resolves it); the **In play** spec sections and invariants; the **Workspace state**.
3. **Read `CLAUDE.md` in full** — 12 invariants, module layout, glossary, open decisions, "Do NOT build". Not from memory,
   not from the plan's summary of it.
4. Note which invariants the plan flagged: the risk panel judged this feature could break them, so they get the closest reading
   at commit time (§4).

Two header facts decide whether you may start at all. **Rejected approaches** — mid-run a rejected approach looks like the
obvious simplification, and the header records that it was weighed and lost ("*synthetic order item*: breaks recipe deduction
and COGS, inv. 6"); do not re-derive it. **Assumptions** — when the header says an open decision is unresolved and names the
task that must resolve it ("T-01 must obtain the account code from the owner before any schema, seed row or posting rule
references it"), no later task runs until that answer exists. Inventing an account code is forbidden by CLAUDE.md, and a
schema that encodes a guess becomes a migration you are not allowed to hand-edit back (inv. 2).

## 1. The per-task loop

Run a–j in order, for every task, every time.

**a. Read the task in full, including `Watch out`** — that field is a trap someone already found ("`bigint` columns return as
`bigint`/string, not `number`; seed the sum with `0n`"), so read it before writing, not after the test fails. Then check
`Needs:`: every ID listed must already be a commit **on this branch**, checked range-scoped and anchored —
`git log --format='%s' "$BASE..HEAD" | grep -qE '^T-05( |$)' || echo "T-05 is NOT committed on this branch — STOP"`.
A bare `git log --oneline | grep ' T-05'` walks the whole history including the base branch and matches `T-050` or a subject like
`T-12 fix: restore what T-05 removed`, so it can pass on a task that never landed here. A missing one is a STOP.

**b. Open the cited spec sections in `docs/spec.md`** — `grep -n '^## 24\.' docs/spec.md`, then read the section. The task
writes `(spec 24)` so that you open it, not so you can trust its one-line rendering. Spec 24's `Cash refund` row reads
**Debit** `Sales Refunds`, `Tax Payable` / **Credit** `Cash on Hand`; a task that compressed that to "credit Sales Refunds"
would post refunds backwards — and it would still balance, so no test catches it. The spec outranks CLAUDE.md and the task.

**c. Read the named invariants by number in `CLAUDE.md`.** `Invariants: 4 (one all-or-nothing transaction at payment)` means
open invariant 4 and read the whole clause — including that printing never happens inside the transaction, which those four
words do not say.

**d. Verify every `Files:` marker against reality before writing a line.** `NEW` must **not** exist. `EDIT` must exist (it was
present at plan time). `EXTEND` must exist because the task named in `EXTEND (created by T-06; …)` already ran — confirm the
creator with `git log --oneline -- <path>`, existence with `test -e <path> && echo EXISTS || echo ABSENT`. This is not
bureaucracy: a path wrongly treated as `NEW` is written from scratch, which **silently deletes what the earlier task wrote** —
T-06's `postSale` vanishes while T-06's commit still claims it, and nothing fails until a later task imports a symbol that is
gone. The mirror mistake is as bad, "adding to" a file that does not exist. A mismatch means the repo is not in the state the
plan assumed: STOP and report, never improvise.

**e. Read the files you are about to touch, end to end, and the real signature of everything you will call.** Never code
against a remembered API: find out whether `deductInventory` returns movements carrying `cost_minor`, and whether it arrives as
`bigint` or a string, by reading T-05's code. On a greenfield phase there is nothing to read — then read what phase 0 actually
produced (`package.json` scripts, `drizzle.config.ts`'s `out:` path), not CLAUDE.md's command block, which is labelled ASSUMED.

**f. Implement exactly the `Do:` steps. Nothing more.** Seven steps means seven steps. If step 3 says "if
`totalCostMinor === 0n`, write nothing and return `null`", that branch exists in your code.

**g. Write the `Tests:` the task names.** Where a case is marked `MANDATORY (spec 29)` the task is not done without it — no "the
integration test covers it". The six areas: money arithmetic and rounding; tax in **both** modes; journal entries always balance;
one posting-rule test per spec 24 business event; offline retries never duplicate; a permission check on every POS API route.

**h. RUN the tests and the typecheck; record the actual output.** `pnpm test <path>`, `pnpm check`. Copy what the terminal
printed; never paraphrase a pass. A script that does not exist yet is a phase-0 gap and a STOP, not a skipped step.

**Exception — the scaffolding phase.** Inside phase 0b the toolchain is what is being built, so a missing script is expected, not a gap:
`pnpm check` and `pnpm test` do not exist while T-01 is creating `package.json`. Verify against what the task's own `Done when:` names —
`node -e "JSON.parse(require('fs').readFileSync('package.json'))"`, `pnpm install` exiting 0, `pnpm vitest --run` once the vitest task
lands — and paste that output. A missing script is a STOP only when a task **outside** phase 0b needs it, which means phase 0b did not
deliver what it promised.

**i. Evaluate `Done when:` literally** — a condition, not a sentiment. "a manually paid order produces exactly two journal
entries whose lines sum debit = credit" means produce one and count the rows. Unsatisfied means not done: back to f, or STOP.

**j. Stage precisely, review the staged diff, commit.** Stage the paths this task's `Files:` list names, plus anything §2's
exception forced — never `git add -A`.

```bash
CUR=$(git -C "$WT" rev-parse --abbrev-ref HEAD)
[ "$CUR" = "$BRANCH" ] || { echo "HEAD is on '$CUR', expected '$BRANCH' — STOP. Stage nothing, commit nothing; re-establish isolation per worktree-git.md §2."; exit 1; }
git status                          # inspect BEFORE staging — every time
git add src/lib/server/accounting/posting-rules.ts src/lib/server/orders/payment.ts \
        src/lib/server/accounting/posting-rules.test.ts
git diff --cached                   # read it, then run §4 against it
git commit -F - <<'MSG'             # never bare `git commit` — no editor in a tool call, so it aborts silently
T-07 feat(accounting): post the COGS entry in payOrder

postCogs sums the movement costs T-05 recorded and writes Dr 5000 / Cr 1200
inside the existing payOrder transaction, after postSale, before markPaid.
Spec 13, 16, 24. Invariants 1, 3, 4, 6.
Tests: pnpm test src/lib/server/accounting/posting-rules.test.ts — 9 passed.
MSG
git show --stat HEAD                # confirm the commit exists and contains exactly the Files: paths
```

Never `git add -A`, never `git add .`, and never a bare `git commit`: with no editor it prints `Aborting commit due to empty commit
message` and makes **no commit** — and inside a pipeline the exit status can still read 0, so the failure is easy to miss. The task's
work then sits staged, gets swept into the *next* task's commit, and the 1:1 plan-to-history map the whole protocol rests on is gone.
Subject form is `references/worktree-git.md` §3's: `T-nn <type>(<scope>): <imperative title>`, ≤72 chars.

Append whatever commit attribution trailer your own session's guidance specifies — from that guidance each run, not from here.

## 2. Scope discipline

You will spot a refactor, a missing test elsewhere, a nearby bug, a "while I am here" tidy. **None of it goes in the commit.**
All of it goes in the phase report under Observations. Why: it breaks the 1:1 map between plan and history, so reverting a bad
T-07 also reverts an unrelated refactor nobody reviewed; it makes the PR unreviewable, because the reviewer cannot separate the
planned change from the drive-by; and it smuggles an unplanned decision past the planning gate — the risk panel, the approach
comparison and the user's approval all happened before this session, and an execution-time schema or posting change had none.

**The one exception**: a change genuinely required to make the stated task work. T-07 needs `cost_minor` as `bigint` and T-05
typed it `number`; you cannot write step 2 without fixing it. Fix it, commit it **with** T-07, and call it out in the commit
body (`Also: widened StockMovement.cost_minor to bigint — required because …`) and in the phase report.

Not covered: while editing `payment.ts` you notice a route with no permission check (inv. 8). It is real and it matters — park it
and raise it in the phase report as a blocking-class finding for the user. Fixing it silently means choosing a permission key,
which is a decision (§3), not a detail.

## 3. When a task cannot be done as written

**The test:** does it change behaviour, scope, schema, money handling, accounting treatment, or permissions? Yes → STOP and
ask. No → it is a detail: decide, proceed, report it.

**DETAIL — decide and report**
- The plan says "sum the movements" and names no helper → name it `sumMovementCost` and move on.
- The `Do:` steps do not say how to lay out the Vitest `describe` blocks, or which of two order-independent inserts goes first.
- A task exports a symbol but its `Files:` list omits the barrel that re-exports it → touch it, say so.

**DECISION — STOP and ask**
- The task hardcodes an account code the header's Assumptions say is **not yet assigned** — CLAUDE.md forbids inventing one.
- The task specifies a money column as `numeric(12,2)`; invariant 1 and spec 17 say integer minor units in `bigint`. "Obviously
  right" does not make the fix yours — the type ripples into the money module, every posting rule, and a migration (inv. 2).
- The `Do:` steps order the payment transaction deduct-inventory-then-record-payment, contradicting spec 13's order.
- `Done when` can only pass by `UPDATE`ing a `journal_entries` row (inv. 2) — the answer is a reversing entry, its own task.
- A new `+server.ts` whose steps contain no permission check (inv. 8) — adding one means picking a permission key.
- A queued POS operation whose steps define no idempotency key (inv. 5).

**The identifier sets you may never coin from.** A value outside these lists is an identifier **you** invented — propose it, never
pick it, exactly as with an account code.
- **Permission keys, spec 8** — cashier: `pos.sell`, `pos.payment`, `pos.print_receipt`, `pos.void_unsent_item`, `pos.cash_payout`;
  waiter: `pos.create_order`, `pos.view_menu`, `pos.modify_order`, `pos.send_to_kitchen`, `pos.transfer_table`. Spec 8 introduces these
  with *"For example:"*, so unlike spec 23's codes the set is extensible — but extending it is the **plan's** call, taken from the task's
  `Do:` steps. Needing a key that is neither in the list nor in the task is the signal to stop and ask, not to coin one.
- **Reason codes, spec 14** — customer changed mind, wrong item entered, kitchen error, quality complaint, other (with a note).
- **Account codes, spec 23** — the 23 codes; CLAUDE.md forbids inventing one.

**The STOP procedure**
1. Keep everything already committed. Commit nothing for the task you are stopping.
2. Do not leave a half-edited working tree: run `git status`, list the exact dirty paths, say whether they typecheck. Do **not**
   `git reset --hard`, `git clean -fd` or `git restore` them without asking — offer it, let the user choose.
3. State, in order: what the plan says (quote the line and the task ID); what is actually true (the command output, the file
   content, the spec line); why this is a decision, not a detail.
4. Propose the **smallest** correction — one task amended, not a re-plan — and say what you would do under each answer.
5. Wait. Do not implement the correction ahead of the answer.

## 4. Invariant self-check before each commit

Read `git diff --cached` against this list every commit — a hit is a prompt to look, not proof of a bug. Catching one here costs
a minute; catching it in verification costs the phase; catching it after the migration ran costs a reversing migration.

- A float literal, `parseFloat` or `toFixed` in money code; money arithmetic outside `src/lib/server/money` (inv. 1).
- An `UPDATE`/`DELETE` touching a paid order, invoice, payment, stock movement, journal entry or line — in app code, a repair
  script **or** a migration (inv. 2).
- A migration creating journal tables without the deferred debits = credits constraint; drizzle-kit does not generate it, so if
  you did not write raw SQL, it is not there (inv. 3).
- A new `+server.ts` or form action with no permission check returning `403` (inv. 8).
- A void, refund, discount, comp, approval or drawer open with no audit row written **in the same transaction** (inv. 10).
- A money column that is not `bigint`; an **ingredient or stock-movement** quantity that is not `numeric(12,3)` (inv. 1 — an order-line
  item count is an ordinary `integer`); a timestamp not `timestamptz` (inv. 11).
- A queued POS operation with no device-generated idempotency key, or a retry that is not a no-op (inv. 5).

```bash
git diff --cached -U0 | grep -nE 'parseFloat|toFixed|[0-9]\.[0-9]'
git diff --cached -U0 | grep -niE 'update |delete from|numeric\(|real|double precision|timestamp[^t]'
git diff --cached --name-only | grep -E '\+server\.ts$'    # each one: permission check + 403?
git status --porcelain | grep -E '^[A-Z ][A-Z ] (tasks/|\.env($|\.))' | grep -v '\.env\.example$'   # must print nothing
```

## 5. Closing a phase

Every task in the phase is committed. Then:

1. **Run the full build, typecheck and whole test suite** — `pnpm check`, `pnpm lint`, `pnpm build`, `pnpm test` — not only
   this phase's tests: a phase-3 route can break a phase-2 unit test. Record the output verbatim; if a script does not exist,
   report that rather than a pass you did not see.
2. **Schema phase, additionally:** open the generated SQL in `src/lib/server/db/migrations` and read it line by line —
   generated is not reviewed. Confirm verbatim money columns `bigint`, ingredient and stock-movement quantities `numeric(12,3)`
   (order-item counts stay `integer`), timestamps `timestamptz`, the deferred debits = credits constraint,
   `UNIQUE (device_id, invoice_number)` wherever invoice numbers land. Then confirm it **applies**: `pnpm db:migrate` on a scratch
   database, backup first (spec 29); a migration that has run is never hand-edited.

   **No database yet — the normal case right after phase 0b.** Check first: `docker compose ps 2>/dev/null` and
   `pg_isready -d "$DATABASE_URL" 2>/dev/null`. If nothing answers, say so and **offer** — do not run it silently, it starts a
   container and binds a port — `docker compose up -d db`, then `cp .env.example .env` and fill `DATABASE_URL`. Report exactly what
   you started. **The spec 29 backup is required only when the target database holds data**; a `pg_dump` of a database you just
   created empty is not evidence, so write `no backup taken — database created empty this phase` rather than pretend. If the user
   declines to start a database, record the migration in the phase report as
   `UNVERIFIED (no database) — reviewed by eye only, not applied`, never as applied, and carry that line into the PR body.
3. **Run the phase-gate lenses** — `invariants` and `tests` only, dispatched with `args.scope` set to **this phase's task IDs
   alone** (`references/verification.md` §2 is the authority). The full five-lens panel runs **once**, after the final phase, before
   any push or PR. A finding against a task outside this phase is a scoping error in the dispatch, never a blocker — re-run with the
   correct scope rather than implementing ahead, which would break the phase-boundary stop. Fix a surviving in-scope BLOCKER before
   the report, or carry it into the report as an explicit blocker.
4. **Produce the phase report and STOP.** No commit from the next phase until the user answers: schema landing wrong is far
   cheaper to catch now than after the domain has been built on it.

````markdown
## Phase 1 — Schema — complete
**Branch:** feat/service-charge · **Worktree:** ../matcami-service-charge · **Base:** main @ 4f1a90c

| Task | Commit | Result |
|---|---|---|
| T-02 journal tables + deferred balance constraint | a1b2c3d | 3 tables; constraint rejects an unbalanced entry (asserted) |
| T-03 seed spec 23 chart of accounts | e4f5a6b | 23 accounts, codes verbatim from spec 23 |

**Files:** 5 created, 1 modified (`git diff --stat <base>..HEAD`).
**Verification (verbatim):**
```
$ pnpm check    svelte-check found 0 errors and 0 warnings
$ pnpm test     Test Files 3 passed (3)   Tests 21 passed (21)
```
**Migration:** `0001_journal.sql` read line by line — `debit_minor`/`credit_minor` `bigint`, `created_at` `timestamptz`,
constraint `DEFERRABLE INITIALLY DEFERRED`; applied to a scratch DB, an unbalanced insert was rejected at COMMIT.
**Deviations and decisions taken:** T-02 — plan did not name the constraint; used `journal_entry_balanced`. No behaviour change.
**Observations parked (NOT in these commits):** `payment.ts` has no permission check — API phase, no task owns it. Invariant 8.
**Open decisions still unresolved:** none blocking Phase 2.
**Next phase:** Phase 2 — Domain — T-05..T-08: weighted-average cost lookup, `postSale`, `postCogs`.
**Ask:** Phase 1 is verified and committed. Say the word and I start Phase 2 — or tell me what to change first.
````

## 6. Resuming a partial run

1. **Find the work:** `git worktree list`, `git branch --list`, and the branch name the plan slug implies. Nothing there means
   this is a fresh run — go to `references/intake.md`.
2. **Find the stopping point:** `git log --format='%s' "$BASE..HEAD"` gives the T-nn subjects in order; test a specific ID
   range-scoped and anchored (`| grep -qE '^T-05( |$)'`), never with a bare `git log --oneline | grep`. Cross-reference the plan's
   full task index in `00-overview.md`. The last committed ID is not necessarily the highest-numbered one. Re-use the `$BASE`
   recorded in Phase B — never re-derive it from a HEAD that is already the feature branch (`worktree-git.md` §1.6).
3. **Do not assume the last commit was actually done.** Re-read that task's `Done when` and evaluate it now — run the named
   command, check the constraint, count the rows. A previous session may have committed and then been interrupted before it verified.
4. **Account for an uncommitted tree:** `git status`. Dirty paths mean a task was interrupted mid-implementation; identify which
   by matching paths against the `Files:` lists. Show the diff and ask — never commit it blind, never `reset --hard`/`clean -fd`.
5. **Check the phase boundary.** If the last commit is the final task of a phase and no phase report was delivered, close that
   phase (§5) and report. Do not start the next phase.
6. **Re-read the run context (§0) before the next task.** A resumed session has none of it.
