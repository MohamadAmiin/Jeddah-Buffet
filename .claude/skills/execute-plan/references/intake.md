# Intake — from a plan path to an executable task graph

Intake runs **before git is touched**: nothing here creates a repo, branch, worktree or commit. It ends with the
intake report (§7) and the user's go-ahead. Plans come from `plan-feature`;
`.claude/skills/plan-feature/references/task-format.md` is the contract and every field name below is quoted
from it — open it when a plan surprises you, never work from memory.

## 1. Accepted inputs and how to tell them apart

A `.md` file · a plan **directory** (`00-overview.md` + numbered phase files, optionally `RESEARCH.md`) · a
`.zip` of such a directory · **no path at all**.

```bash
cd /home/mohamed-amiin/Desktop/matcami
PLAN='tasks/service-charge.md'   # substitute the path the user gave; leave empty ONLY when they gave none
                                 # (there is no $1 in a tool-call shell — "${1:-}" is always empty)
if [ -z "$PLAN" ]; then                                    # no path — list, then ASK. Never guess.
  ls -1d tasks/*.md tasks/*/ tasks/*.zip 2>/dev/null || echo "tasks/ holds no plans (or does not exist)"
fi
[ -n "$PLAN" ] && { [ -e "$PLAN" ] || { echo "no such path: $PLAN — stop and ask"; exit 1; }; }
if   [ -d "$PLAN" ];                    then FORM=dir
elif file -b "$PLAN" | grep -qi '^zip'; then FORM=zip      # trust content, not the extension
elif [ "${PLAN##*.}" = md ];            then FORM=file
else FORM=unknown; fi; echo "$FORM"
ls -1 "$PLAN"/00-overview.md "$PLAN"/[0-9][0-9]-*.md "$PLAN"/RESEARCH.md 2>/dev/null    # dir form

# The plan's FILE(S) — one for a single-file plan, 00-overview.md plus every numbered phase file for a
# directory. Every grep/awk below reads $PLAN_FILES, never $PLAN.
if [ -d "$PLAN" ]; then set -- "$PLAN"/00-overview.md "$PLAN"/[0-9][0-9]-*.md; else set -- "$PLAN"; fi
PLAN_FILES="$*"; echo "PLAN_FILES=$PLAN_FILES"
```

**Never grep `$PLAN` itself.** On a directory plan `grep … "$PLAN"` prints `Is a directory` (or nothing under `-s`)
and every check below silently returns clean — on exactly the plans that most need checking, the big ones that were
split because they exceeded ~15 tasks. `$PLAN_FILES` is left unquoted where it is used, so the list expands.

`tasks/` is gitignored (`.gitignore` line 2) and **does not exist today** — if absent, say so and offer
`plan-feature`. With several plans listed, quote the list and ask which; a directory without `00-overview.md` is
non-conforming (§5). Both `tasks/<slug>.md` and `tasks/<slug>/`, or a `tasks/<slug>-v1.md` beside them, means a
re-plan (task-format §2 supersede/amend) — ask which is current, never pick by mtime.

## 2. The zip case

Inspect the listing **before** extracting. Extract to scratch **outside** the repo — never into the working
tree, and never into `tasks/`, where it collides with the directory the zip was made from.

```bash
SCRATCH="<paste your session's scratchpad path here>/plan-unzip"   # from your environment block; NOT $ROOT, NOT tasks/
case "$SCRATCH" in /*) ;; *) echo "substitute the real scratchpad path first"; exit 1;; esac
expr "$SCRATCH" : "/home/mohamed-amiin/Desktop/matcami" >/dev/null && { echo "refusing: scratch is inside the repo"; exit 1; }
mkdir -p "$SCRATCH"
unzip -l "$PLAN"                                                   # 1. look first
unzip -Z1 "$PLAN" | grep -E '^/|(^|/)\.\.(/|$)' && echo "UNSAFE ENTRY — refuse, do not extract"
unzip -q -n "$PLAN" -d "$SCRATCH"                                  # 2. -n never overwrites
find "$SCRATCH" -name '00-overview.md'                             # 3. the extracted plan dir
```

No `unzip`: `bsdtar -tvf "$PLAN"` then `bsdtar -xf "$PLAN" -C "$SCRATCH"` (bsdtar is **not** installed here —
verified), else `python3 -m zipfile -l "$PLAN"` then `python3 -m zipfile -e "$PLAN" "$SCRATCH"`; if none exist
ask for the directory rather than hand-rolling an extractor. Then treat it exactly like the directory case. The
zip is a **snapshot for handoff; the directory is the working copy** (task-format §7) — when `tasks/<slug>/`
exists beside the zip use it and report drift, never choose silently: `diff -ru tasks/<slug> "$SCRATCH/<slug>"`.

## 3. Parsing

**The document header is the only context transfer that exists** (task-format §3). Read it in full before
executing any task: a session that reads only its own task will re-decide what the planning session settled and
"improve" the design in the exact direction Phase 2 ruled out.

Extract by these literal headings — `# <feature>` · `**Goal.**` · `## Requirements (as agreed with the user)` ·
`## Scope` (`**IN** —` / `**OUT** —`) · `## Approach` (`**Chosen:` plus every `Rejected — *…*:`; if execution
tempts you toward a rejected alternative, surface it, never revive it) · `## Risks that survived adversarial
verification` (`**HIGH**`/`**MED**`/`**LOW**`, `*Refuted, dropped*`) · `## Assumptions (open decisions this plan
rides on)` · `## In play` (`Spec:`, `Invariants:`) · `## Research` or `RESEARCH.md` (every
`CONFLICT WITH SPEC`, every `GAP`) · `## Workspace state at plan time (Phase 1, <date>)`, the world the plan
assumed and the baseline for §4's disk cross-check · a leading `> **Supersedes …` blockquote when this is a
re-plan.

```bash
sed -n '1,/^## .*Phase/p' "$PLAN"        # single file: everything above the first phase heading
grep -nE '^(# |\*\*Goal\.\*\*|## (Requirements|Scope|Approach|Risks|Assumptions|In play|Research|Workspace))' $PLAN_FILES
grep -nE 'CONFLICT WITH SPEC|GAP|\*\*(HIGH|MED|LOW)\*\*' $PLAN_FILES
grep -nE '^## .*Phase|^\*\*Depends on:\*\*|^### T-[0-9]+ —' $PLAN_FILES
```

Directory form: the header lives in `00-overview.md`, which also carries the **complete task index** (every ID,
title, phase file, `Needs`). Read `00-overview.md` **and every phase file** — the index is a cross-check, not a
substitute. Per task record all nine fields verbatim: **ID** and title from `### T-NN — <title>`; `**Needs:**`
(IDs or `-`); `**Files:**` (bullets, each `` `path` `` — `NEW` / `EXTEND (created by T-NN; …)` / `EDIT
(<where>)`); `**Spec:**`; `**Invariants:**` (numbered *and* named); `**Do:**`; `**Tests:**` (note every
`MANDATORY (spec 29)`); `**Done when:**`; `**Watch out:**` (optional). Build the graph: a node per ID, an edge
per `Needs`. A task struck `~~T-04~~ SUPERSEDED by T-11 (<date>): <why>` leaves the executable set but stays in
the report.

## 4. Validation — run every check, report **all** failures in one message

```bash
python3 - "$PLAN" <<'PY'
import re, sys, os, glob
p = sys.argv[1]; fs = sorted(glob.glob(p + '/[0-9][0-9]-*.md')) if os.path.isdir(p) else [p]
text = "\n".join(open(f, encoding='utf-8').read() for f in fs)
T, order, fail, phase, cur = {}, [], [], None, None
for ln in text.splitlines():
    # anchored: '## Workspace state … (Phase 1, <date>)' is a header line, not a phase heading
    m = re.match(r'^##\s+Phase\s+(\S+)', ln)
    if m: phase = m.group(1).strip('—- ')
    m = re.match(r'^###\s+(T-\d+)\s+—\s*(.*)', ln)
    if m:
        cur = m.group(1); order.append(cur)
        if cur in T: fail.append(f"DUPLICATE ID {cur}")
        T[cur] = {'title': m.group(2), 'phase': phase, 'body': ''}
    elif cur: T[cur]['body'] += ln + "\n"
for t, d in T.items():
    # re.S + a lazy stop at the next **Field:** — Needs: lists wrap (task-format's own T-07 example does)
    b = d['body']; m = re.search(r'\*\*Needs:\*\*(.*?)(?=\n\*\*|\Z)', b, re.S)
    d['needs'] = re.findall(r'T-\d+', m.group(1)) if m else []
    if d['phase'] is None: fail.append(f"{t}: sits under no phase heading")
    fail += [f"{t}: no **{f}:**" for f in ('Files','Spec','Invariants','Do','Tests','Done when') if f'**{f}:**' not in b]
    fail += [f"{t}: Needs {n} — no such task" if n not in T else f"{t}: Needs {n} — FORWARD edge, later task"
             for n in d['needs'] if n not in T or order.index(n) > order.index(t)]
deg = {t: sum(n in T for n in d['needs']) for t, d in T.items()}; q = [t for t in order if not deg[t]]; seen = []
while q:                                                   # Kahn — whatever never drains is the cycle
    t = q.pop(0); seen.append(t)
    for u, d in T.items():
        if t in d['needs']:
            deg[u] -= 1
            if not deg[u]: q.append(u)
if len(seen) != len(T): fail.append("CYCLE among " + ", ".join(sorted(set(T) - set(seen))))
print("\n".join(fail) or "graph OK", f"\n-- {len(T)} tasks | order: {' '.join(seen)}")
PY
grep -nE '^## .*Phase' $PLAN_FILES    # a phase heading with no ### T- beneath it is a phase with no tasks
```

Marker legality, then the cross-check against reality:

```bash
awk '/^\*\*Files:\*\*/{f=1;next} /^\*\*/{f=0} f&&/^- /{ if ($0 !~ / — (NEW|EXTEND|EDIT)([ (]|$)/) print "ILLEGAL MARKER: "$0 }' $PLAN_FILES
grep -hoE '^- `[^`]+` — (NEW|EXTEND|EDIT)\b' $PLAN_FILES | tr -d '`' | sed 's/^- //' | while read -r fp _ mark; do
  case "$mark" in                       # NB: never name this loop var `path` — in zsh that clobbers $PATH
    NEW)  [ -e "$fp" ] && echo "MISMATCH: $fp tagged NEW but already exists";;
    EDIT) [ -e "$fp" ] || echo "MISMATCH: $fp tagged EDIT but does not exist";;
  esac
done
grep -hoE '^- `[^`]+` — NEW\b' $PLAN_FILES | sort | uniq -d  # one path tagged NEW by two tasks
```

`EXTEND` means an **earlier task in this plan** creates the file: confirm `EXTEND (created by T-NN; …)` names a
task in the graph, earlier in the order. A mismatch is the plan and the world disagreeing — **report it, never
silently adapt**; with no `src/` today, every `EDIT` tag on a greenfield plan is one. Also surface, deciding
nothing:

- Every unresolved item under `## Assumptions`, every `CONFLICT WITH SPEC`, every `GAP` — flagging any a schema
  or `0b scaffolding` task would bake in (a column, a seed row, an account code). CLAUDE.md's open-decisions
  rule forbids encoding an answer silently: such a task must not start before its decisions task resolves it.
- Any task whose `**Invariants:**` is `-` or absent while its `Do:`/`Files:` touch money (`minor`, `bigint`,
  price, tax, discount, total), posted records (journal, invoice, payment, stock movement), permissions (`403`,
  PIN, approval) or the payment transaction — those owe invariants 1, 2, 3, 4, 7, 8, 9 by name. Suspicious, not
  fatal: list it.
- Any `**Done when:**` naming no command and no observable condition (task-format §9).

## 5. Non-conforming plans

A hand-written or older plan will lack fields. Extract what you can, say plainly what is missing and what it
costs, and **ask** — never invent a field.

| Missing | Cost |
|---|---|
| `### T-NN` headings | no task graph, so no one-commit-per-task history |
| `Needs:` | no dependency order — only document order, which may be wrong |
| `Done when:` | nothing objective for `references/verify-lenses.md` to assert against |
| `Files:` | cannot stage precisely, and `git add -A` is forbidden — commits become guesswork |
| the header | goal, rejected approaches and accepted risks are gone; you will re-decide them |

Then ask: proceed with reduced guarantees (naming each one lost), or run `plan-feature` first? If the user
proceeds, put every order you derived into the intake report so they can correct it.

## 6. The execution order

Phases in the plan's own numbered order — `0a decisions` → `0b scaffolding` → schema → domain → (offline) → API
→ UI → tests; take it from the plan, not this list, since a pure-calculation plan has no schema phase. **0a
blocks everything** (no schema, chart-of-accounts row or seed may encode an answer it has not obtained); **0b
blocks every code phase** (there is no `package.json` today, so a schema task would run `pnpm db:generate` into
an empty repo). Within a phase, topologically sort on `Needs`, ties broken by ID so a re-run gives the same
order; cross-phase edges resolve themselves, because a phase completes, is verified and is reported before the
next begins. Independent tasks — no path between them — may run in any order, but run them **one at a time**,
and never two naming the same path in `Files:`: one commit per task needs a clean staging area. Never reorder to
get something working sooner — an `EXTEND` task run before its creator rewrites the file from scratch and
destroys the earlier task's work.

## 7. The intake report — before git is touched

```
PLAN      tasks/service-charge/ (directory: 00-overview.md + 6 phase files + RESEARCH.md)
          [zip form: extracted to <scratch>/service-charge; matches tasks/service-charge/]
FEATURE   Service charge on dine-in orders — configurable %, after discount, before tax, own account
SIZE      6 phases, 12 tasks (1 superseded: T-04 → T-11)
ORDER     0a: T-01 | 1: T-02, T-03 → T-04 | 2: T-05 → T-06, T-07 | 3: T-08 | 4: T-09 | 5: T-10..T-12
IN PLAY   spec 13, 14, 17, 23, 24, 29 · invariants 1, 2, 3, 4, 7, 8
VALIDATION  <every failure, one line each — or "all checks passed">
OPEN DECISIONS the plan rides on  <verbatim from ## Assumptions, each with the task that resolves it>
RISKS the plan accepted           <verbatim HIGH/MED/LOW lines, plus every CONFLICT WITH SPEC / GAP>
GIT       not a git repository · no remote · no base branch — the isolation step will ask first
NEXT      T-01, then stop at the end of phase 0a and report
GATES     6 — I stop and wait for you after each of phases 0a, 1, 2, 3, 4, 5. Approving now approves phase 0a ONLY.

Shall I proceed?
```

Copy the plan's risks and assumptions **verbatim**; summarising them away is how an accepted risk becomes an
unnoticed one. If validation produced any failure, ask what to do about it instead of proceeding. Nothing in git
— not `git init`, not a branch — happens before the answer is yes. The GATES line is not decoration: it is the
only place the user is told, up front, that "shall I proceed?" buys one phase and not the run.

## 8. Standalone verify mode — resolving the target

The user gives a plan **plus** a branch name or a worktree path. §§1–4 run unchanged on the plan; this section
resolves the second input, which nothing else in the skill does — `references/verification.md` §2 and §3 and every
lens require `WORKTREE` and `BASE` as real values, and a branch name is neither. One inversion applies throughout:
against a branch where the work has already run, paths tagged `NEW`/`EXTEND` **should** exist now, and one that
does not is a task that did not land.

```bash
cd /home/mohamed-amiin/Desktop/matcami; ROOT=$(git rev-parse --show-toplevel)
TARGET='feat/service-charge'          # substitute exactly what the user gave: a branch name or a path
```

1. **A path** → it is the worktree:
   `git -C "$TARGET" rev-parse --show-toplevel` (fails ⇒ not a checkout, stop and ask) and
   `git -C "$TARGET" symbolic-ref --short HEAD` → `WORKTREE` and `HEAD`.
2. **A branch name** → find the checkout that holds it:
   `git worktree list --porcelain | grep -B2 "^branch refs/heads/$TARGET"`.
   A checkout found ⇒ its `worktree` line is `WORKTREE`. **None found** (the common case after
   `git worktree remove`) ⇒ `WORKTREE=$ROOT` and you verify the branch **without checking it out**: every range
   becomes `<base>...<branch>` rather than `...HEAD`, and `git status --porcelain` is **not** a finding — it
   describes the main checkout, not the branch. Never check out, create or move a branch to make verification
   easier; that mutates the user's tree in a mode whose whole promise is that it changes nothing.
3. **`BASE`** → `git merge-base <base-candidate> "$TARGET"` with the candidate resolved per
   `references/worktree-git.md` §1.6 (never assume `main`). If the repo genuinely has no base branch — one branch,
   no `main`/`master` — set `BASE=ROOT`, the literal string: `verification.md` §3 and the lens dispatch block both
   read it as "diff against the empty tree" rather than a ref.
4. **`SCOPE`** → the task IDs this run judges. Default to **every** ID in the plan, and say so; if the user names a
   phase, take that phase's IDs only. A lens dispatched without `SCOPE` reports every unstarted task as missing.

Report the resolved `PLAN` / `WORKTREE` / `BASE` / `HEAD` / `SCOPE` and **confirm them before the panel runs** — a
wrong `BASE` produces an empty diff, and an empty diff makes all five lenses pass on nothing
(`references/verification.md` §3, §6).
