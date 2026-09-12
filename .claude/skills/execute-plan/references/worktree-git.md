# Git & GitHub operations — every command this skill runs

Run from the repo root unless a command names another directory, and re-set it in every shell call — the cwd does not survive between
tool calls. `ROOT=/home/mohamed-amiin/Desktop/matcami`. Work §1 through in order before touching a plan: **today this directory is not a
git repository**, so every check below fails on a first run. Never let a raw git error reach the user — detect the condition, name it,
offer the fix, wait for a yes. **A fenced block that contains a mutating command is a menu, not a script**: read the surrounding prose
and run the one branch that applies, never the block top to bottom.

## 1. Preconditions
Preflight — run verbatim, read every line of output.
```bash
cd "$ROOT"
git rev-parse --show-toplevel  2>&1                   # "fatal: not a git repository"  → §1.1
git rev-parse --verify -q HEAD || echo "NO COMMITS"   # no SHA printed                 → §1.2
git remote -v                                         # empty                          → §1.3
gh auth status 2>&1 | head -5                         # "not logged in"                → §1.4
git status --short                                    # non-empty                      → §1.5
git worktree list 2>&1                                # pre-existing worktrees         → §2.1
```
### 1.1 Not a git repository
**Offer; never run silently** — `git init` writes `.git/` into the user's project. Ask both at once: *may I initialise it*, and *is the
default branch `main` or `master`?* `init.defaultBranch` is unset here, so a bare `git init` makes `master` plus a hint; name it (git
2.43 supports `-b`). Prevents converting a directory into a repo behind the user's back, and a default branch that disagrees with the
`main` they expect a PR to target.
```bash
cd "$ROOT" && git init -b "$DEFAULT_BRANCH" && git status --short   # $DEFAULT_BRANCH = main or master, as the user answered
```
### 1.2 Repository with zero commits
`git rev-parse --verify -q HEAD` prints nothing — the state right after §1.1. It blocks everything: **`git worktree add` cannot create a
worktree in a repo with no commits**, there is nothing to branch from and nothing to open a PR against. An initial commit on the base
branch must exist first. Propose this content, confirm the list, stage by name.

**Zero commits is not a fallback case — it is a STOP.** Neither `git worktree add -b feat/x <path> main` nor `git switch -c feat/x main`
can resolve an unborn base: both exit 128 with `fatal: invalid reference: main` (measured, git 2.43). The only form that succeeds is a
bare `git switch -c feat/x`, which leaves an unborn feature branch with no `main` in existence — so §5's `gh pr create --base main` has
nothing to target either. If the user declines the initial commit, say: *"Without a first commit there is nothing to branch from and
nothing to open a PR against; I cannot isolate the work. The options are (a) let me make the initial commit of CLAUDE.md, docs/,
.gitignore, .claude/ and the spec PDF, or (b) stop here."* Then wait. **Do not attempt any branch creation.**
```bash
cd "$ROOT"
git add CLAUDE.md .gitignore docs/ .claude/ Restaurant-POS-MVP-Technical-Specification.pdf
git status --short                             # read it: nothing else may be listed
git check-ignore -v tasks/ .env 2>/dev/null    # tasks/ must show as ignored by .gitignore:2
# Wrongly staged something? Here, and ONLY here, unstage with `git rm --cached <path>`:
# `git restore --staged` needs a HEAD and dies with `fatal: could not resolve HEAD` (exit 128,
# measured) while the repo has no commit. After this commit exists, `git restore --staged` is the form.
git commit -m "chore(repo): initial commit — spec, CLAUDE.md, plan-feature skill"
```
`CLAUDE.md`, `docs/spec.md`, `.gitignore` and `.claude/skills/**` are the rulebook and belong in history; the 686 KB PDF is the
signed-off spec — include it, but say it is binary and let the user drop it; `tasks/` is gitignored deliberately and never enters a
commit. Prevents `fatal: invalid reference` from `worktree add`, and a first PR diffing everything.
### 1.3 No remote
`git remote -v` prints nothing → no push, no PR. Creating the GitHub repo **publishes this code**: confirm in words first, state the
visibility, default to private.
```bash
gh repo create "$REPO_NAME" --private --source=. --remote=origin   # confirm the NAME and the visibility first; NO --push
git remote -v && git ls-remote origin 2>&1 | head -3
```
If gh replies `Name already exists on this account`, **stop and ask for a different name** — never append a suffix on your own.

`gh repo create --source=.` adds the remote but **pushes nothing**, so the remote is empty and `origin/$BASE` does **not** exist yet.
Publish the base branch now, before any feature branch is created — otherwise the first `git push -u origin feat/<slug>` makes the
feature branch GitHub's default and `gh pr create --base "$BASE"` later fails with *base branch not found*, after every task has been
committed and verified:
```bash
cd "$ROOT" && git rev-parse --abbrev-ref HEAD        # must print $BASE — you are on the base branch, with the §1.2 initial commit
git push -u origin "$BASE"                           # publishes the ALREADY-MADE initial commit; this is not a commit to main
git remote set-head origin --auto || echo "could not set remote HEAD — continue, $BASE is already published"
gh repo view --json defaultBranchRef --jq .defaultBranchRef.name   # must equal $BASE before any feature branch is pushed
```
This one push of `$BASE` is the **only** push to the base branch this skill ever makes; it is part of the repo creation the user already
confirmed, and it must happen **before** the first `git push -u origin feat/<slug>`. Until it has happened, branch from the **local**
`$BASE` — §2 resolves that with `$START`.

Declined → carry on locally; report at the phase gate that the work sits on `feat/<slug>`, no remote, no PR. Never create the repo to
unblock yourself.
### 1.4 `gh` not authenticated
`gh auth login` is **interactive** (browser code, device flow) and will hang a tool call. Tell the user to run it themselves in the
Claude Code terminal — `!gh auth login` — then re-run `gh auth status`. gh 2.62.0 here is authenticated as `MohamadAmiin` with `repo`
scope; verify, never assume.
### 1.5 Dirty working tree
```bash
git status --short
git stash list          # pre-existing stashes are someone's work — never drop or pop one
```
Show the exact output and ask: commit first, stash it themselves, or proceed (untracked files are usually harmless, modified tracked ones
are not). **Never** run `git stash`, `git restore`, `git checkout -- .`, `git reset --hard` or `git clean` on your own initiative — it
destroys work no git command recovers. A worktree (§2) leaves it alone; the §2.3 fallback needs it gone.
### 1.6 Determine the base branch — never assume "main"
```bash
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-head origin --auto >/dev/null 2>&1 \
    || echo "could not determine remote HEAD (empty remote?) — falling back to the local refs below"
fi
BASE=$(git symbolic-ref --short -q refs/remotes/origin/HEAD); BASE=${BASE#origin/}
[ -n "$BASE" ] || for b in main master; do git show-ref --verify -q "refs/heads/$b" && { BASE=$b; break; }; done
[ -n "$BASE" ] || BASE=$(git symbolic-ref --short HEAD)   # works on an unborn branch; rev-parse HEAD does not
case "$BASE" in
  ""|feat/*|fix/*|chore/*) echo "BASE resolved to '$BASE' — that is not a base branch. STOP and ask the user which branch the PR should target.";;
esac
[ "$BASE" = "$BRANCH" ] && echo "BASE == BRANCH ($BASE) — STOP; you are standing on the feature branch."
echo "BASE=$BASE"
```
`set-head --auto` repairs a missing `refs/remotes/origin/HEAD`, but on an **empty** remote it prints `error: Cannot determine remote
HEAD` and exits 1 — handled above, never swallowed. The last fallback returns whatever HEAD points at, which on a **resumed** run is
`feat/<slug>` itself; that is what the two guards catch. Resolve `$BASE` **once, in Phase B, before Phase C creates or switches to
`$BRANCH`**, record it in the run context, and on a resume **re-use the recorded value** — never re-derive it from a HEAD that is
already the feature branch. `$BASE` is what you branch from and pass to `--base`; you never check it out (§7).
## 2. The worktree
One branch per **plan** — never per phase, per task or per file. Branch `feat/<plan-slug>`, directory a sibling of the repo so nothing
lands inside the user's checkout.
```bash
cd "$ROOT"; REPO=$(git rev-parse --show-toplevel); NAME=$(basename "$REPO")
SLUG=service-charge                       # the plan slug, from tasks/<slug>.md or tasks/<slug>/
BRANCH="feat/$SLUG"
WT="$(dirname "$REPO")/${NAME}-${SLUG}"   # → /home/mohamed-amiin/Desktop/matcami-service-charge
if git remote get-url origin >/dev/null 2>&1; then
  git fetch origin || echo "FETCH FAILED — report it; do NOT branch from a possibly stale origin/$BASE"
else
  echo "no remote — branching from the local $BASE"
fi
# Resolve the start ref ONCE. origin/$BASE does not exist until §1.3's base push has run.
if   git rev-parse --verify -q "refs/remotes/origin/$BASE" >/dev/null; then START="origin/$BASE"
elif git rev-parse --verify -q "refs/heads/$BASE"          >/dev/null; then START="$BASE"
else echo "Neither origin/$BASE nor $BASE resolves — STOP and ask."; fi
echo "branching $BRANCH from $START"
git worktree add -b "$BRANCH" "$WT" "$START" || echo "worktree add failed — see §2.1/§2.3; do not retry blindly"
git worktree list && git -C "$WT" status -sb            # confirm: On branch feat/<slug>
```
`2>/dev/null` on the fetch is wrong and is why it is gone: it swallows no-network, expired credentials and a
renamed remote alike, and the next line then branches from a stale or missing `origin/$BASE` — which surfaces
only as conflicts at PR time, after every task is committed.
Everything after this targets the worktree: `git -C "$WT" …`, or `cd "$WT"` at the top of the call.
### 2.1 The branch or the path already exists
```bash
git show-ref --verify -q "refs/heads/$BRANCH" && echo "LOCAL branch exists"
git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 && echo "REMOTE branch exists"
git log --oneline "$BASE..$BRANCH" 2>/dev/null | head -20    # what an earlier run already did
[ -e "$WT" ] && ls -la "$WT" | head
git worktree list --porcelain | grep -F "$WT" || echo "path exists but git does not know it"
```
Every command above is read-only — run the whole block to investigate. An existing branch is almost always a partial earlier run of this
plan; **ask**: resume this branch (the normal answer — SKILL.md Phase C, `references/execution.md` §6), or stop so the user can deal with
the existing branch themselves. **Never open a second branch for the same plan**: one branch per plan is not negotiable, and a different
slug is correct only for a genuinely different plan file. `fatal: '<branch>' is already checked out at …` means another worktree holds
it; reuse that path. A stale registered path (directory deleted by hand) → `git worktree prune`, then recreate. An unrelated directory at
`$WT` → stop and ask. Never delete or reset the branch to clear the way — its commits are finished tasks.

**Only after the user chooses RESUME**, and only if `git worktree list --porcelain` shows no worktree already holding `$BRANCH`:
```bash
git worktree add "$WT" "$BRANCH" || echo "already checked out elsewhere — reuse that path; see git worktree list"
```
### 2.2 The gitignored-files trap — read before running anything in the worktree
A fresh worktree holds **only tracked files**; everything `.gitignore` covers is absent, and the failures are non-obvious. **`.env` is
not there** (`.gitignore:15`) — `DATABASE_URL` is unset, so `pnpm db:migrate`, `pnpm dev` and every server test fail with what looks like
a database fault. **`node_modules/` is not there** (`:5`) — install, never assume; `.svelte-kit/`, `build/`, `coverage/`, `pgdata/` are
absent too and regenerate.
```bash
[ -f "$REPO/.env" ] && cp -v "$REPO/.env" "$WT/.env" \
  || { [ -f "$REPO/.env.example" ] && cp -v "$REPO/.env.example" "$WT/.env"; }
[ -f "$WT/package.json" ] && (cd "$WT" && pnpm install)
git -C "$WT" status --short        # still empty: .env and node_modules/ are ignored here too
```
Today neither file exists, so both are no-ops on a first run; they start mattering the moment the plan's phase-0 scaffolding task lands —
including later phases of the *same* plan. **Report what you copied and installed**: a silent `.env` copy is a surprise, a missing one is
an hour of misdiagnosis. That `.env` also points at the **same PostgreSQL database** as the main checkout, so migrations run here migrate
it — and spec 29 requires a backup before every migration, so say so at the phase gate before a schema phase runs `pnpm db:migrate`.
### 2.3 Fallback — an in-place branch
Trigger when `git worktree add` fails or `git worktree` is unavailable; `df -h .` shows disk pressure and a second `node_modules` will
not fit; the layout is bare or unusual; the project cannot be installed twice (one dev port, one database, native deps); or the user asks
for it. Three extra preconditions, all mandatory: the tree is **clean** (§1.5); you **said first** that the user's checkout is left
sitting on the feature branch (editor, terminal and dev server all follow it); and **at least one commit exists on `$BASE`** (§1.2) —
without it `git switch -c "$BRANCH" "$BASE"` fails with `fatal: invalid reference`, exactly as `worktree add` does, so zero commits is a
STOP here too, never a fallback. Downstream is identical with `$ROOT` for `$WT`; §6 then removes only the branch.
```bash
cd "$ROOT"; git status --short           # must be empty
if   git rev-parse --verify -q "refs/remotes/origin/$BASE" >/dev/null; then START="origin/$BASE"
elif git rev-parse --verify -q "refs/heads/$BASE"          >/dev/null; then START="$BASE"
else echo "Neither origin/$BASE nor $BASE resolves — STOP and ask."; fi
git switch -c "$BRANCH" "$START"
git status -sb                           # to return afterwards the user runs: git switch "$BASE"
```
## 3. Commits — exactly one per task
One commit per `T-nn`: history maps 1:1 to the plan, and a bad task reverts alone; never batch two tasks into one commit.
Subject `T-nn <type>(<scope>): <imperative title>`, ≤72 chars; types `feat`, `fix`, `test`, `chore`, `refactor`, `docs`; scope the
CLAUDE.md module — `money`, `accounting`, `inventory`, `orders`, `auth`, `permissions`, `audit`, `pos`, `db`. Body: the plan file and task ID,
whatever deviated from the plan's `Do:` steps and why, the invariants the task had to respect by number and name, and any open decision
(CLAUDE.md) it rides on. Trailer: the attribution **your own session's** guidance specifies, verbatim from that guidance — never from this
file, an older commit, or an invented model name, since it changes between sessions. No guidance in session, no trailer.
```bash
git -C "$WT" commit -F - <<'MSG'
T-07 feat(accounting): post the COGS entry in payOrder

Implements T-07 of tasks/service-charge/03-domain.md. Adds postCogs(tx, …) beside postSale
and calls it inside the existing payOrder() transaction, after the invoice row and before
markPaid (spec 13's order): Dr 5000 Cost of Goods Sold / Cr 1200 Inventory (spec 24).
Deviation from the plan: none.

Invariants respected: 1 money is integer minor units (summed as bigint, seeded 0n, no float);
3 journal entries balance in the DB (both lines in one entry); 4 one all-or-nothing
transaction at payment (postCogs takes the tx handle, opens none).
MSG
```
**Staging discipline.** Stage the paths the task's `Files:` block names, **by name**, then read the staged set — the reading is the
control, not the running. Each grep **and the `check-ignore`** printing **nothing** (exit 1) passes; a hit means
`git restore --staged <path>`, then re-check. **Assert the branch first**: prose is not a guard, and the in-place fallback (§2.3) puts
the main checkout one stray `git switch` away from a commit on `$BASE` that this skill may never undo (§7 forbids force-push).
```bash
cd "$WT"
CUR=$(git rev-parse --abbrev-ref HEAD)
[ "$CUR" = "$BRANCH" ] || { echo "HEAD is on '$CUR', expected '$BRANCH' — STOP. Stage nothing, commit nothing; re-establish isolation per §2."; exit 1; }
git status --short
git add src/lib/server/accounting/posting-rules.ts src/lib/server/orders/payment.ts \
        src/lib/server/accounting/posting-rules.test.ts
git status --short             # leftover ?? lines → a file you forgot, or one you must not add
git diff --cached --stat && git diff --cached --name-only
git diff --cached --name-only | grep -Ev '(^|/)\.env\.example$' \
  | grep -Ei '(^|/)\.env($|\.)|^tasks/|\.(pem|key)$|(^|/)node_modules/|(^|/)(build|dist|\.svelte-kit|coverage)/|\.sql\.gz$'
git diff --cached -U0 | grep -nEi 'BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|(password|secret|api_?key)[[:space:]]*[=:]|postgres(ql)?://[^[:space:]]*:[^[:space:]]*@'
STAGED=$(git diff --cached --name-only)
[ -n "$STAGED" ] || echo "nothing staged — do not commit"
printf '%s\n' "$STAGED" | git check-ignore --no-index --stdin -v   # ANY line printed = an ignored file is staged
```
`--no-index` is **mandatory**: without it `git check-ignore` consults the index and therefore never reports a path that is already
staged — the only case that matters. Measured: with `.env` and `tasks/p.md` force-added, the bare form printed nothing and exited 1
(reading as a pass), while `--no-index --stdin` printed `.gitignore:2:.env` and `.gitignore:1:tasks/`. The bare form also aborts with
`fatal: no path specified` (exit 128) on an empty staged set, and word-splits on any path containing a space. Any line printed here
means `git restore --staged <path>`, then re-check; **no output (exit 1) is the pass**, and then: `git show --stat HEAD`.
`.env.example` is the one `.env*` path that may be committed (`.gitignore:17` un-ignores it), which is why the first grep excludes it —
a scaffolding task is expected to create and commit it.
Never `git add -A`, `git add .` or `git add -u`: each stages whatever else is in the tree — a scaffolding task's stray output, a file the
user was editing. Drizzle migrations under `src/lib/server/db/migrations` **are** committed, in the same commit as the schema change that
generated them; one that has already run is never hand-edited (CLAUDE.md) — add a new one. **A task with no diff** (`git status --short`
empty after the work) means an earlier task already satisfied it: do **not** commit `--allow-empty`, check it against the task's `Done
when:` ("no diff" ≠ "done"), and record `T-nn <title> — no commit (already satisfied by T-mm)` in the phase report and PR checklist. `git
commit --amend` is allowed only on the commit you just made, for the task you are on, while **unpushed**; once pushed, fix forward (§7).
## 4. Pushing
Push **once**, in Phase F, after the full adversarial panel has run and left no surviving BLOCKER (`references/verification.md` §2, §6),
immediately before `gh pr create` (§5). Do **not** push at a phase gate: the between-phase gate runs only the `invariants` and `tests`
lenses, so a phase-gate push publishes work the completeness, plan-vs-diff and spec-conformance lenses have never seen — and an
intermediate phase is not a state the user agreed to publish. Pushed history can never be rewritten (§7.1, §7.4), so a bad phase-1
schema commit would be permanent on the remote. Pushing **publishes** — always report the branch URL. If the user explicitly asks for an
intermediate backup push, say what it publishes, push only on their yes, and state in the same message that the branch is unverified.
```bash
cd "$WT"
git push -u origin "$BRANCH"       # sets upstream; there is no "later phases" push — see above
git rev-parse --abbrev-ref --symbolic-full-name @{u}
# rejected? diagnose, never force:
git fetch origin && git status -sb
git log --oneline @{u}..HEAD       # ours the remote lacks
git log --oneline HEAD..@{u}       # theirs we lack → the branch moved under us
```
Empty `HEAD..@{u}` with a rejection means a hook or protected-branch rule, not divergence — report the server's message verbatim.
Non-empty means someone else pushed: stop, show both logs, ask. The only resolution this skill may perform is `git merge origin/$BRANCH`,
after the user agrees. Force-push and rebasing pushed commits are never it (§7).
## 5. The pull request
Preconditions: branch pushed, `gh auth status` passes, and the panel in `references/verify-lenses.md` left **no surviving BLOCKER**. A
BLOCKER means no PR at all — fix it, or get the user's explicit override in words and quote it in the body. Non-blocking findings survive
→ `--draft`. Write the body to a file **outside the repo and the worktree** (session scratchpad): inside either it shows in `git status`
and risks being committed. Use `--body-file`, not `--body` — it keeps newlines, checklists and fences. Report the URL.
```bash
BODY="<paste your session's scratchpad path here>/pr-$SLUG.md"   # never inside $ROOT or $WT
case "$BODY" in /*) ;; *) echo "substitute the real scratchpad path first"; exit 1;; esac
cd "$WT"; git log --reverse --format='- [x] `%h` %s' "origin/$BASE..HEAD"   # checklist, with SHAs
EXISTING=$(gh pr list --head "$BRANCH" --state all --json url,state --jq '.[0] | "\(.url) \(.state)"')
[ -n "$EXISTING" ] && echo "PR already exists: $EXISTING — do NOT create a second one."
gh pr create --base "$BASE" --head "$BRANCH" \
             --title "Service charge on dine-in orders" --body-file "$BODY"  # + --draft if needed
gh pr view --json url,state,isDraft --jq '"\(.url) state=\(.state) draft=\(.isDraft)"'
```
An existing **OPEN** PR means §4's push already updated it: refresh the body with `gh pr edit --body-file "$BODY"` and report the same
URL — `gh pr create` would exit non-zero with `a pull request for branch "feat/<slug>" into branch "<base>" already exists`, which is
exactly the raw error this file forbids. An existing **CLOSED** or **MERGED** PR on this branch is a STOP: ask the user before opening
another. Reaching §5 twice is normal, not exotic — resuming a half-run plan and the verification fix loop both lead here.
````markdown
## What and why
<the plan header's Goal in 2-3 sentences, plus the chosen approach and what it rejected — from `## Approach`, not
re-argued.>  **Plan:** `tasks/service-charge/` (00-overview + 6 phase files) · executed 2026-09-12
## Tasks
- [x] `a1b2c3d` T-01 — Obtain the service-charge account code from the owner  <!-- one line per task, with its SHA -->
- [ ] T-03 — Snapshot the rate on the order — no commit (already satisfied by T-02)
## Tests  <!-- real output, including the spec 29 suites this touches. Never summarise a run you did not make. -->
```
$ pnpm test
 ✓ src/lib/server/accounting/posting-rules.test.ts (9)
 Test Files  2 passed (2)   Tests  23 passed (23)
```
## Verification panel
<n> lenses, <n> findings, **0 surviving blockers**. Reviewer checklist — non-blocking findings:
- [ ] <finding> — <why it is not a blocker; what a reviewer should confirm>
## Open decisions this rides on
- Open decision 3 (tax rules): the charge is assumed **taxable** — reversible as a setting, not a migration.
## Invariants deliberately touched
- 7 (discount before tax; each line snapshots its own numbers) — charge applied to the discounted subtotal and taxed
  with it, one rounding site in `src/lib/server/money`.
## Not in this PR
- <the plan's `## Scope` OUT list, plus anything the panel deferred.>
````
End the body with the generated-with line your session's attribution guidance specifies, verbatim — as with the commit trailer.
## 6. Cleanup — after merge, and only when the user says so
Never merge the PR yourself (§7). Confirm the state first.
```bash
gh pr view --json state,mergedAt,url --jq '"\(.state) \(.mergedAt) \(.url)"'   # want MERGED
cd "$ROOT"; git -C "$WT" status --short   # must be empty — anything here is unsaved work
git worktree remove "$WT" && git worktree list
git fetch --prune origin
git branch -d "$BRANCH"                   # -d refuses unmerged commits; that refusal is correct
git worktree prune
```
**The remote branch is not yours to delete.** GitHub deletes the head branch on merge when the repository is configured to; otherwise
`git push origin --delete "$BRANCH"` is a separate step the user must ask for **in words**, and only after `gh pr view --json state`
actually returned `MERGED`. Never run it to tidy up: if the PR is still open, deleting its head branch closes the PR and discards the
review, and the commits are recoverable only while someone still holds the SHA.
`git worktree remove` **refuses when the worktree has uncommitted or untracked changes** — the last thing standing between an unfinished
task and deletion. Never `--force` past it: show `git -C "$WT" status --short` and ask. Same when `git branch -d` refuses — the user
decides, not `-D`. In the §2.3 fallback there is no worktree; the user must `git switch main` before the branch will delete.
## 7. Forbidden — no exceptions, no "just this once"
1. `git push --force` / `--force-with-lease`, or any rewrite of pushed history.
2. Committing or merging to `main`/`master` locally; `git checkout main` to work there.
3. `git reset --hard`, `git clean -fd`, `git checkout .`, `git restore .`, `git stash` on the user's work.
4. `git rebase` of commits that have been pushed.
5. `git branch -D`, or removing a branch or worktree holding unmerged or uncommitted work.
6. `git add -A`, `git add .`, `git add -u`; committing `.env`, a credential, a build artifact, or anything under `tasks/`.
7. `gh repo create` without explicit confirmation, or at any visibility other than the agreed private.
8. `gh pr merge`, `gh pr close`, `gh pr review --approve` — merging is the human's call, never this skill's.
9. `git push origin --delete <branch>`, or any deletion of a remote ref, without the user explicitly asking for it after the PR is merged.

Plan path and slug come from `references/intake.md`; the panel gating §5 is `references/verify-lenses.md`.
