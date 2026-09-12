---
name: execute-plan
description: Execute an existing matcami task plan — read tasks/<slug>.md (or a plan directory or .zip), isolate the work in a git worktree on one feat/<slug> branch, implement every task in dependency order with ONE COMMIT PER TASK, stop for approval between phases, run an adversarial verification panel, then push and open a pull request. Trigger when the user says "execute the plan", "implement tasks/<x>.md", "run this task file", "build this feature from the plan", "start on T-01", "continue with phase 2", "verify the implementation", or "open a PR for this". This skill BUILDS from a plan; plan-feature WRITES the plan — if no plan file exists yet, that is plan-feature's job, not this one.
---

# execute-plan — isolate, implement, prove, ship

## The protocol at a glance

| Phase | What happens | Where |
|---|---|---|
| A | **Intake** — load the plan, parse it into a task graph, validate, confirm | conversation |
| B | **Preconditions** — repo, commit, remote, `gh`, clean tree, unresolved decisions | conversation + repo root |
| C | **Isolate** — one branch `feat/<slug>`, worktree at a sibling path, or in-place fallback | git |
| D | **Execute** — task by task, one commit each; **stop after every phase** | the worktree |
| E | **Verify** — adversarial panel tries to prove the work is NOT done | the worktree |
| F | **Ship** — push, open the PR, report the URL | GitHub |

Run them in order. A–B happen before a single byte of git state changes. Never start C because A "obviously" passed.

## Who you are

You hold the same three-way expertise as the planner — **this stack** (SvelteKit, Drizzle, PostgreSQL, IndexedDB/Service Worker, Vitest/Playwright), **this business** (dine-in and takeaway, shifts, drawer counts, voids and comps, a POS that must keep selling offline), and **finance** (double-entry, spec 23's chart of accounts, spec 24's posting rules, weighted-average COGS, tax modes and rounding). Your discipline is different. The planner decides; **you execute faithfully.**

That is the core tension of this skill: you are *not* re-planning. You have the knowledge to second-guess the plan and you must not spend it that way. But you also refuse to follow a plan off a cliff. The rule that separates the two:

- **A detail the plan did not anticipate is yours** — a variable name, a helper's file position, an import order, an obvious missing `null` guard inside the task's own scope. Decide it, implement it, and **report it** in the phase report.
- **A decision the plan got wrong is the user's** — a column type, an account code, a posting side, a transaction boundary, a permission, anything an open decision rides on, anything that contradicts an invariant. **Stop and say so.** Do not quietly improve it.

If you cannot tell which side a question falls on, it is the user's. Ask.

## Ground truth — never work from memory

Open these every run; none is quotable from recall:

- `CLAUDE.md` — 12 non-negotiable invariants, the module layout under `src/lib/server/**`, the glossary, the seven unresolved open decisions, the "Do NOT build" list.
- `docs/spec.md` — sections 1–33. The spec outranks CLAUDE.md; CLAUDE.md outranks the plan; the plan outranks your instinct.
- The plan itself, in full — the document header carries the *why* (goal, scope, approach, rejected alternatives, surviving risks, assumptions). A task read without its header gets "improved" in exactly the direction the planning session ruled out.

**Today's repo is near-empty**: `CLAUDE.md`, `docs/spec.md`, the spec PDF, `.gitignore`, `.claude/skills/`. There is no `src/`, no `package.json`, no database, no tests, no `node_modules` — and **it is not a git repository**. Every command below may fail on a first run. Detect, then handle; never assume success.

## NEVER — the hard stops

- **Never force-push.** No `git push --force`, no `--force-with-lease`, no rewriting history that has been pushed.
- **Never commit to `main`/`master`**, and never `git checkout main` to work there. All work lands on `feat/<slug>`.
- **Assert the branch before every commit.** `git rev-parse --abbrev-ref HEAD` must equal `feat/<slug>`, checked in the same shell call that stages and commits. Prose is not a guard — the in-place fallback leaves the main checkout one stray `git switch` away from a commit on the base branch, and §7 of `references/worktree-git.md` forbids the force-push that would undo it.
- **Never `git add -A`.** Stage the paths the task's `Files:` list names, and read `git status --short` before every commit.
- **Never commit `.env`, credentials, or anything under `tasks/`** — `tasks/` is gitignored deliberately (`.gitignore` line 2); a plan is a working artifact, not a project document.
- **Never `git reset --hard`, `git clean -fd`,** or remove a worktree holding uncommitted work, without asking first.
- **Never create a GitHub repository without confirming**, and default to `--private`.
- Pushing the feature branch and opening the PR **are** authorised normal operation — always report the resulting URL.
- Follow **your own session's** attribution guidance for commit trailers and PR bodies. Never hardcode a model name into a template here; it changes between sessions.

## PHASE A — INTAKE

**Read `references/intake.md` and follow it.** In short: accept a path to a single `.md` plan, a plan **directory** (`00-overview.md` plus numbered phase files, maybe `RESEARCH.md`), or a `.zip` of one — unpack a zip to the scratchpad and read the directory, never edit inside the archive. With **no path**, list `tasks/` and ask which plan; never pick for the user.

| Invoked with | What you do |
|---|---|
| `tasks/<slug>.md` | Read it whole — header **and** every task. |
| `tasks/<slug>/` | Read `00-overview.md` first, then every numbered phase file, plus `RESEARCH.md` if present. |
| `tasks/<slug>.zip` | Unpack to the scratchpad, read the directory, treat the zip as a read-only snapshot. |
| *nothing* | `ls tasks/`, show what is there with its task count, and ask which plan. |
| a plan **plus** an existing branch or worktree, "verify only" | Skip B–D entirely and enter **Phase E**. |

The **plan slug** is the plan's own basename — `tasks/service-charge.md` and `tasks/service-charge/` both give `service-charge`. It names the branch, the worktree and the PR; derive it once and reuse it.

Parse the plan into a task graph: every `T-NN`, its phase, its `Needs:` IDs, its `Files:` paths with `NEW` / `EXTEND` / `EDIT` tags, its `Spec:` and `Invariants:` citations, `Do:`, `Tests:`, `Done when:`, `Watch out:`. Validate it — IDs unique, every `Needs:` target present, no dependency cycle, no `Needs:` pointing forward into a later phase, every task carrying a checkable `Done when:`. In a split plan, `00-overview.md` lists **every** task ID; if the index and the phase files disagree, that is a validation failure.

Then **present the parsed plan back** — feature, phase list, task count, files to be created versus modified, open decisions the plan rides on — and get confirmation **before touching git**. State in that report **how many phase gates this plan has** and that this approval covers **the first phase only** (`references/intake.md` §7's template carries the line); "shall I proceed?" otherwise reads as approval of the whole run. A plan that fails validation is **reported, never guessed at**: quote the line, say what is missing, and stop. Do not repair the plan file yourself.

## PHASE B — PRECONDITIONS

The gate. Check every item, handle each explicitly, and report the whole set before proceeding.

1. **Is this a git repository?** `git rev-parse --is-inside-work-tree`. Today it is not. **Offer** `git init -b <main|master>` — and **ask which**, per `references/worktree-git.md` §1.1: `init.defaultBranch` is unset here, so a bare `git init` silently produces `master` while the user expects the PR to target `main`. Do not run it silently. Say what it does and what the first commit would contain.
2. **Is there at least one commit?** `git rev-parse --verify HEAD`. **A worktree cannot be created from a repo with zero commits.** If there is none, offer an initial commit of what already exists — `CLAUDE.md`, `docs/`, `.gitignore`, `.claude/` and the spec PDF, named explicitly, never `git add -A` — then confirm with `git status --short` that `tasks/` and `.env` are absent from the staged set. **If the user declines, that is a STOP, not a fallback**: against an unborn HEAD neither `git worktree add -b feat/<slug> <path> <base>` nor `git switch -c feat/<slug> <base>` can resolve the base — both exit 128 with `fatal: invalid reference: <base>` — and there is no base for a PR to target either. Say exactly that, offer (a) the initial commit or (b) stopping here, and wait. Do not attempt any branch creation.
3. **What is the base branch?** `git symbolic-ref --short HEAD` locally, or the remote's default (`gh repo view --json defaultBranchRef`). Record it; it is what you branch **from** and open the PR **against**. Never commit to it.
4. **Is there a remote?** `git remote -v`. If none, offer `gh repo create <name> --private --source=. --remote=origin` — **confirm first, private by default**. `--source=.` adds the remote but **pushes nothing**, so the remote is empty: publish the base branch straight away — `git push -u origin <base>`, then confirm `gh repo view --json defaultBranchRef` names it — **before any feature branch is pushed**. Otherwise GitHub adopts `feat/<slug>` as the repository's default and `gh pr create --base <base>` fails with *base branch not found* after every task has been committed and verified. That single push of an already-made commit is the only push to the base branch this skill performs; `references/worktree-git.md` §1.3 has the commands. If the user declines the repo, say plainly now that Phase F cannot push or open a PR and the work will stay local; do not discover that at the end.
5. **Is `gh` authenticated?** `gh auth status`. If not, everything through Phase E still runs; only F is blocked. Report it at B, not at F.
6. **Is the working tree clean?** `git status --porcelain`. Uncommitted work is the user's; ask what to do with it. Never stash, reset or clean on your own initiative.
7. **Does the plan carry unresolved decisions?** Grep the plan for `CONFLICT WITH SPEC`, `GAP`, `Open decision`, `not yet assigned`. **An unresolved open decision that a task would bake into the schema or the chart of accounts is a STOP, not a warning** — CLAUDE.md forbids answering one silently, and invariant 2 means a migration that has run cannot be hand-edited back. Settle it with the user **before schema lands**, and record the answer in the commit and the PR body.

## PHASE C — ISOLATE

**Read `references/worktree-git.md`** for the exact commands, the fallback and the PR body contract.

**One branch for the whole plan: `feat/<plan-slug>`**, the slug taken from the plan's own filename. Never a branch per phase, per task or per file. The worktree lives at a **sibling** path — `../matcami-<slug>`, outside the repo, so it never appears as an untracked directory inside it.

Fall back to an **in-place branch** (`git switch -c feat/<slug> <base>` in the main checkout) when: the sibling path exists or is not writable; the branch is already checked out in another worktree; `git worktree add` fails for any reason; the task plan needs `node_modules`, `.env` or a running database that exist only in the main checkout and installing them again is not worth it; or the user asks for it. Announce which mode you are in — every later command depends on it.

**Zero commits and a declined initial commit is a STOP, not a fallback.** The in-place branch cannot rescue it: `git switch -c feat/<slug> <base>` fails against an unborn HEAD with `fatal: invalid reference: <base>`, exactly as `git worktree add` does (measured, git 2.43), and the only command that succeeds — a bare `git switch -c feat/<slug>` — leaves an unborn feature branch with no base branch in existence, so Phase F has nothing to open a PR against. Say that, and wait: the only way forward is the Phase B initial commit (`references/worktree-git.md` §1.2).

**Resuming a half-run plan.** Before creating anything, check whether `feat/<slug>` already exists (`git branch --list`, `git worktree list`). If it does, do **not** create a second branch or a second worktree and do **not** start from T-01: read `git log --oneline <base>..feat/<slug>`, map the task IDs in those subject lines against the plan, report which tasks are already committed and which phase boundary you are standing on, and continue from there with the user's go-ahead.

Two consequences of a worktree, both easy to get wrong: `.env` is gitignored, so a fresh worktree has none — copy it by hand only with the user's say-so, and never commit it. And `tasks/` is gitignored too, so **the plan is not in the worktree**: read it from the main checkout by absolute path, and do not copy it across.

## PHASE D — EXECUTE

**Read `references/execution.md`** for how a single task is done — reading it against the repo, the `NEW`/`EXTEND`/`EDIT` tag check, writing the code and its tests, and proving `Done when:`.

The loop:

1. Take the phase's tasks in **dependency order** — a task starts only when every ID in its `Needs:` is already committed on this branch. Phases run in plan order (`0a decisions` / `0b scaffolding` → schema → domain → offline → API → UI → tests, or whatever this plan declares).
2. Implement one task. Unit tests ship **in the task that writes the code**, never deferred.
   A task touching one of spec 29's six mandatory areas — money arithmetic and rounding, tax in **both** modes, journal entries balancing (in TypeScript *and* rejected by the database), one posting-rule test per spec 24 event, offline retries never duplicating, a permission check per POS API route — is not done without the test the plan marked `MANDATORY (spec 29)`.
3. Prove `Done when:` by running it. `git status --short`, then `git add` the exact paths from `Files:`, then `git diff --cached --name-only` to confirm nothing stray came along.
4. **One commit per task**, in the single subject form `references/worktree-git.md` §3 fixes — `T-nn <type>(<scope>): <imperative title>`, ≤72 chars, scope being a CLAUDE.md module: `T-07 feat(accounting): post the COGS entry in payOrder`. The body names the files, the evidence that `Done when:` passed, any deviation and why, and any open-decision assumption the task rode on. Append whatever attribution trailer your session's instructions specify.
5. Repeat to the end of the phase, then run the **phase checks** — build, typecheck and the phase's tests (`pnpm check`, `pnpm lint`, `pnpm test`, `pnpm test:e2e` as the plan requires). Those commands are CLAUDE.md's *assumed* toolchain: until the scaffolding phase makes them real they do not exist, so if `package.json` has no such script, **say that** instead of reporting a pass. Before `pnpm db:migrate`, take a backup (spec 29); never hand-edit a migration that has already run.

Then **REPORT AND STOP.** The report:

- Each task done, with its **commit SHA** and title.
- Files created and modified, by path.
- **Actual command output** for the phase checks — pasted, not paraphrased. "Tests pass" is a claim; a test run is evidence.
- Anything that deviated from the plan, and why; any open-decision assumption recorded.
- What the next phase will do, and the first task ID in it.

**Stop means stop.** Do not begin the next phase because this one went well, because the next task looks trivial, or because the user said "go" once, three phases ago. Wait for a go-ahead on *this* boundary. Schema landing wrong is far cheaper to catch before domain code is built on it.

## PHASE E — VERIFY

**Read `references/verification.md`**; its **§2 is the single authority on which lenses run when**, and this file and `references/execution.md` both defer to it — `invariants` + `tests` scoped to that phase's task IDs at each intermediate phase gate, **all five** scoped to the whole plan after the final phase, before any `git push` and before `gh pr create`. Say which lenses ran, and with which scope, every time. It fans out the lens briefs in `references/verify-lenses.md` in parallel. The panel is **adversarial**: each lens tries to **prove the work is NOT done** — an unbalanced or missing posting, money outside `src/lib/server/money`, a `numeric` or float money column, an `UPDATE` on a posted record, a retry that duplicates, a `+server.ts` with no permission check and no `403`, a report grouping on `created_at::date`, a `Done when:` that was declared rather than run.

Severity decides what happens next. **A surviving BLOCKER blocks the pull request** until it is fixed or the user explicitly overrides it in their own words — and an override is recorded in the PR body, not swallowed. A fix is its own commit naming the task it repairs (`T-07 fix: …`); after fixing, re-run the lens that raised it.

**Standalone verify mode enters here directly**: given a plan plus an existing branch or worktree, resolve `PLAN` / `WORKTREE` / `BASE` / `HEAD` / `SCOPE` per `references/intake.md` **§8** — a branch name is not a worktree, and nothing else in the skill turns one into the other — then confirm the branch and its commits match the plan's task IDs, run the panel, report. Implement nothing, commit nothing, push nothing.

## PHASE F — SHIP

1. `git push -u origin feat/<slug>`. Never force. If there is no remote or `gh` is unauthenticated, you already said so at Phase B — go back there, do not improvise.
2. `gh pr create --base <base-branch> --head feat/<slug>` with a body built to the contract in `references/worktree-git.md`: what the feature does, the plan path, every task ID with its commit, the invariants and spec sections in scope, the verification results including anything the user overrode, every open-decision assumption the work rides on, and how to test it. Append your session's PR attribution line.
3. **Report the PR URL** back to the user. That is the deliverable.

Afterwards the **worktree is not removed automatically** — the user may still want it for review or fixes. Tell them how to clean up when they are done: `git worktree list`, then `git worktree remove ../matcami-<slug>` once it is clean (never with uncommitted work in it), and `git branch -d feat/<slug>` after the PR merges. Removing a worktree does not delete the branch, and neither is your call to make unasked. **The remote branch is not yours to delete at all**: GitHub removes the head branch on merge when the repo is configured to, and otherwise `git push origin --delete feat/<slug>` is a separate step the user must ask for **in words**, only after `gh pr view --json state` actually returned `MERGED` — deleting the head branch of an open PR closes it and discards the review.

## When the plan is wrong

This is the most common real failure, and the plan is a document, not scripture. In **every** case below the rule is identical: **STOP at that task. Keep everything already committed — do not unwind good work. Report precisely what the plan says versus what is true, quoting both. Propose the smallest correction. Then WAIT.** Never silently deviate, and never delete or rewrite the plan file — plans are decision history, and `../plan-feature/references/task-format.md` gives the planner rules for superseding one.

- **A `Files:` tag does not match reality** — a path tagged `NEW` already exists, or one tagged `EXTEND`/`EDIT` is absent. The plan's own header says this means the repo is not in the state the plan assumed. Stop; do not overwrite a file someone else wrote, and do not create a file the plan expected to open.
- **`Done when:` cannot be satisfied** — the command does not exist, the constraint does not reject what it should, the condition is untestable as written. Report what you ran and what happened. A task is not done because the file exists.
- **Two tasks conflict** — both claim the same symbol, or one's output contradicts another's assumption. Name both IDs and the collision.
- **A task would violate a CLAUDE.md invariant** — a float or `numeric` money column, an `UPDATE` on a posted record, a journal table with no database-level debits=credits constraint, a route with no permission check, a business date taken from `created_at`. This is never yours to soften. Name the invariant by number and stop.
- **The plan assumed an open decision that is still open** — an account code spec 23 does not define, a tax rounding rule, a payment method. Stop before any schema, seed row or posting rule encodes the answer.
- **Reality differs from the Phase 1 investigation the plan was built on** — a dependency version, an API that changed, a file whose contents are not what the plan describes. State what you observed, with the path.

## Common mistakes this skill must not make

- **A branch per phase, or per task.** One branch for the whole plan.
- **Committing to `main`/`master`**, or working there "just for the scaffolding commit".
- **Force-pushing** anything, ever — or rewriting a commit that has been pushed.
- **`git add -A`**, sweeping in `.env`, `node_modules/`, a stray scratch file or the plan itself.
- **Claiming tests pass without running them**, or reporting a pass from a script that does not exist yet.
- **Marking a task done because the file exists** rather than because `Done when:` was checked and satisfied.
- **Expanding a task past its stated scope** because the code "obviously needs" more. Report it; do not build it.
- **Skipping the phase stop** — or treating one go-ahead as blanket approval for the rest of the plan.
- **Opening the PR with a surviving BLOCKER**, or quietly downgrading one to get past the gate.
- **Committing `.env` or anything under `tasks/`.**
- **Re-planning instead of reporting** — rewriting the plan's design, renumbering its tasks, or "fixing" the plan file on disk.
- **Silently answering an open decision** so the task can proceed. That is the one mistake a migration makes permanent.
