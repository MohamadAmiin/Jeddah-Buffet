# Adversarial verification — the gate on the pull request

## 1. The principle

No lens asks "does this look done?". You wrote the code; you already believe it works — that belief is
why you stopped, and asking yourself again returns the answer you already gave. Every lens is briefed
instead to **prove the work is NOT done**, and a finding reaches the user only after an adversary has
tried to kill it and failed.

- **"Tests exist" is not "tests pass."** A test file in the diff proves someone typed a test. Only the
  runner's output proves it runs; only a real assertion proves it checks anything. A mandatory spec 29
  test that cannot be executed counts as failing, not as missing infrastructure.
- **"The file is there" is not "Done when is satisfied."** Check that sentence, not the path.
- **"I followed the plan" is not what the diff says.** A session narrating a step it skipped is the
  normal failure, not an exotic one.

The panel is read-only by construction: a verifier that fixes what it finds destroys the evidence and
escapes review. Fixes happen afterwards, in the open, as their own commits (§7).

## 2. When it runs

- **After the final phase, before any `git push` and before `gh pr create`.** Nothing is pushed and no
  PR is opened while a BLOCKER stands (§6).
- **Standalone verify mode** — the user points at a plan plus an existing branch or worktree. Resolve
  `PLAN` / `WORKTREE` / `BASE` / `HEAD` / `SCOPE` per `references/intake.md` **§8**, run this file
  unchanged, report, propose no commits.

**This section is the single authority on when the panel runs.** `SKILL.md`, `references/execution.md`
and `references/verify-lenses.md` defer to it; where any of them reads differently, this wins:

| Moment | Lenses | Scope |
|---|---|---|
| Each intermediate phase gate | `invariants` + `tests` only | **this phase's task IDs only** |
| After the final phase, before any `git push` and before `gh pr create` | all five | the whole plan |

Say which lenses ran, and with which scope, every time. A finding against a task outside the scope you
dispatched is a scoping error, never a blocker — autonomy is per phase, so an unstarted task is not a
missing one.

Running this panel through the Workflow tool is **explicitly sanctioned**: Workflow normally needs a
user opt-in, and a skill whose instructions tell Claude to call it *is* that opt-in. Call it.

## 3. Collect the evidence first

Gather it once, from the branch or worktree under test, and hand every lens the same material. Write it
to the session scratchpad — **never inside the repo**, where it would appear in `git status`.

These three values come from the run context, not from this file: `$WORKTREE` and `$BASE_BRANCH` are what
Phase B/C recorded (or what `references/intake.md` §8 resolved in standalone verify mode), and the scratchpad
path is in your session's environment block. **Substitute them before running anything** — `EV=<scratchpad>/verify`
inside a bash block is a shell *redirect*, not a placeholder, and leaves `EV` empty.

```bash
ROOT=/home/mohamed-amiin/Desktop/matcami
WT="$WORKTREE"                                       # worktree or repo under test; $ROOT for the in-place fallback
BASE="$BASE_BRANCH"                                  # the ref the branch forked from — what the PR targets
EV="<paste your session's scratchpad path here>/verify"      # never inside $ROOT or $WT
case "$EV" in /*) ;; *) echo "substitute the real scratchpad path first"; exit 1;; esac
mkdir -p "$EV"

[ -n "$WT" ] && [ -d "$WT" ] || { echo "WT unset or missing — STOP; resolve it per intake.md §8."; exit 1; }
[ -n "$BASE" ] || { echo "BASE unset — STOP and ask which ref the branch forked from. Never assume 'main'."; exit 1; }
if [ "$BASE" = "ROOT" ]; then            # a branch with no base branch at all (intake.md §8 step 3)
  EMPTY=$(git -C "$WT" hash-object -t tree /dev/null); DIFFRANGE="$EMPTY..HEAD"; LOGRANGE="HEAD"
else
  git -C "$WT" rev-parse --verify -q "$BASE" >/dev/null || {
    echo "NO BASE '$BASE' — STOP. Do not collect evidence, do not run the panel; ask the user which ref the branch forked from."
    exit 1; }
  DIFFRANGE="$BASE...HEAD"; LOGRANGE="$BASE..HEAD"
fi

git -C "$WT" status --porcelain > "$EV/status.txt"   # non-empty ⇒ uncommitted work is NOT verified work:
                                                     # stop, show it, ask. Never reset it, never stash it away.
git -C "$WT" diff "$DIFFRANGE" > "$EV/diff.patch" || { echo "git diff failed — STOP"; exit 1; }
[ -s "$EV/diff.patch" ] || { echo "EMPTY diff vs $BASE — either the branch carries no work or BASE is wrong. STOP; never run the panel on an empty diff."; exit 1; }
git -C "$WT" log --oneline --no-decorate "$LOGRANGE" > "$EV/commits.txt" || { echo "git log failed — STOP"; exit 1; }
[ -s "$EV/commits.txt" ] || { echo "NO commits in $LOGRANGE — STOP."; exit 1; }

# Tests: run what the plan's "Done when" clauses name. The toolchain is ASSUMED until a scaffolding
# task makes it real (CLAUDE.md "Commands & setup") — never report a command you did not run.
if [ -f "$WT/package.json" ] && grep -q '"test"' "$WT/package.json"; then
  ( cd "$WT" && CI=1 pnpm test --run 2>&1 ) | tee "$EV/test-output.txt"
  echo "exit=${PIPESTATUS[0]}" | tee -a "$EV/test-output.txt"
else
  echo 'NO TEST RUNNER: package.json or its "test" script is absent — no mandatory test is proven to pass.' \
    | tee "$EV/test-output.txt"
fi
```

`CI=1` and `--run` are both required: Vitest otherwise enters watch mode and this call never returns — the one
place a hang costs the whole panel. Record the exit code; a green-looking tail with a non-zero exit is a failing
suite. **Every guard above is a hard stop, not a warning.** A shell redirect creates the file even when the
command fails, so a `git diff` against a bad `$BASE` leaves a zero-byte `diff.patch` that every lens then reads
as "no code changed" and returns PASS on — the gate passing on nothing.

Capture the output **verbatim, failures included**; never summarise it, never re-run until it looks
better. If the suite cannot run, that sentence is the evidence and the `tests` lens rules on it.

## 4. What each lens receives

The plan in full (header **plus every task** — the header carries the rejected approaches and accepted
assumptions, so a lens without it reports deliberate decisions as defects), the commit list, the
verbatim test output, the path to `$EV/diff.patch`, and the paths to `CLAUDE.md` and `docs/spec.md`.

**The diff is the evidence.** Each lens reads it in full and judges the code as written, never the
implementing session's account of what it did; a claim with no line of diff behind it is not a finding.
The diff goes as a file path because a real one is far too large to inline; the rest is pasted text.
The five briefs live in `references/verify-lenses.md` — **completeness**, **tests**, **invariants**,
**plan-vs-diff**, **spec-conformance**. The `hunts` lines below are the short form of those briefs, and
each lens reads its own section first.

## 5. The workflow script

Pass it inline, with `args` as a real JSON object (not a JSON string). Adapt the `hunts` lines to the
feature; leave the structure alone.

```js
export const meta = {
  name: 'matcami-verify-panel',
  description: 'Adversarial panel that tries to prove a matcami task plan was NOT correctly executed',
  phases: [
    { title: 'Lens panel', detail: 'five lenses try to prove the work is not done' },
    { title: 'Refute', detail: 'adversarial agents try to kill each finding' },
  ],
}

const A = (args && typeof args === 'object') ? args : {}
const ROOT = '/home/mohamed-amiin/Desktop/matcami'
const PLAN = A.plan || ''
const DIFF = A.diffPath || ''
const COMMITS = A.commits || '(no commit list supplied)'
const TESTS = A.testOutput || 'NO TEST OUTPUT SUPPLIED — treat every mandatory test as unproven.'
const BASE = A.base || ''          // NO default: §3 forbids assuming 'main'
const WT = A.worktree || ''        // NO default: the main checkout is the wrong tree in worktree mode
const SCOPE = A.scope || ''        // the task IDs this run verifies — one phase's, or all of them
const BRIEFS = ROOT + '/.claude/skills/execute-plan/references/verify-lenses.md'

if (!PLAN || !DIFF || !BASE || !WT || !SCOPE) {
  log('ABORT: args.plan, args.diffPath, args.base, args.worktree and args.scope are all required — no default base branch, no default worktree, no implicit scope.')
  return { error: 'missing args', needed: ['plan', 'diffPath', 'commits', 'testOutput', 'base', 'worktree', 'scope'] }
}

const LENSES = [
  { id: 'completeness', title: 'Completeness', brief: 'LENS 1 — COMPLETENESS', hunts:
    'a task whose "Done when" is not actually satisfied; a task skipped or half-done; a file under Files: absent, or present without the thing the task asked for; an EXTEND file rewritten wholesale, destroying an earlier task\'s work; a Do: step with no diff behind it; a commit claiming more than its diff contains' },
  { id: 'tests', title: 'Tests', brief: 'LENS 2 — TESTS', hunts:
    'a missing spec 29 mandatory test (money arithmetic and rounding; tax in BOTH modes; entries balance — property test plus the DB rejecting an unbalanced entry; one posting-rule test per spec 24 event; offline retries never duplicate; a permission check per POS API route); a test present but failing, skipped or never executed; a test asserting truthiness, a snapshot or its own input instead of the value the task named' },
  { id: 'invariants', title: 'CLAUDE.md invariants', brief: 'LENS 3 — INVARIANTS', hunts:
    'float/numeric/parseFloat money, or money arithmetic outside src/lib/server/money (1); UPDATE or DELETE of a paid order, invoice, payment, stock movement, journal entry or line (2); journal tables without the DB-level deferred debits=credits constraint (3); the payment transaction split, or printing inside it (4); a synced offline cash sale discarded, a missing idempotency key, a renumbered invoice (5); a cached stock quantity written without its movement, or a sale blocked by stock (6); tax before discount, a second rounding site, a line not snapshotting price and rate (7); a +server.ts or form action with no server-side permission check and 403 (8); a missing owner-PIN gate or reason code (9); a missing audit row, or one outside the action\'s transaction (10); created_at::date where business date is required (11); a reversible PIN hash, a session in localStorage (12)' },
  { id: 'plan-vs-diff', title: 'Plan vs diff', brief: 'LENS 4 — PLAN VS DIFF', hunts:
    'code no task asked for; a Do: step implemented differently from what it says; an open decision (CLAUDE.md) answered silently in schema, code or the chart of accounts; an invented account code; anything off the "Do NOT build" list smuggled in; a file touched that no task listed' },
  { id: 'spec-conformance', title: 'Spec conformance', brief: 'LENS 5 — SPEC CONFORMANCE', hunts:
    'the diff against docs/spec.md verbatim — chart-of-accounts codes and names (23), the posting-rule table (24), the ordered payment transaction (13), approvals and reason codes (8, 14), the device invoice sequence and offline rules (6), tax modes and rounding (17), weighted-average costing and COGS (16)' },
]

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'MAJOR', 'MINOR'] },
          title: { type: 'string' }, taskId: { type: 'string' },
          evidence: { type: 'string' }, failureScenario: { type: 'string' },
          violates: { type: 'array', items: { type: 'string' } }, fix: { type: 'string' },
        },
        required: ['severity', 'title', 'taskId', 'evidence', 'failureScenario', 'violates', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
  required: ['refuted', 'reasoning'],
}

const READONLY = `You are READ-ONLY and this is absolute. Read, cat and grep freely, and run read-only git
commands (git show, git log, git diff). NEVER create, edit or delete a file; never git add, commit,
checkout, stash, reset, clean or push. Running the project's NON-WRITING test/check command yourself
(CI=1 pnpm test --run, pnpm check) is permitted and expected for the Completeness and Tests lenses — it
is the only first-hand evidence there is; --run is mandatory or Vitest watches and hangs you. Everything
that WRITES stays forbidden: no pnpm install, no db:migrate/db:generate/db:push, no docker compose up,
no build that emits into the worktree, no touching the database. A verifier that fixes what it finds
destroys the evidence and escapes review. Report the defect; do not repair it.`

function evidence() {
  return `## The plan — document header AND every task. This is the contract.
${PLAN}

## Commits on this branch (the protocol is one commit per task, T-nn in the subject)
${COMMITS}

## Test output, verbatim, exactly as it ran
${TESTS}

## THE DIFF — your primary evidence
The full diff of this branch against ${BASE} is saved at: ${DIFF}
Read it IN FULL before judging anything; \`git -C ${WT} diff ${BASE}...HEAD\` reproduces it. Judge the
code AS WRITTEN there, never the implementing session's narrative of what it did. A claim with no line
of diff behind it is not a finding.
Rulebook: ${ROOT}/CLAUDE.md — 12 numbered invariants; quote the wording.
Spec: ${ROOT}/docs/spec.md — sections 1-33; grep it and cite as "spec 24".`
}

function lensPrompt(lens) {
  return `You are the ${lens.title} lens on an ADVERSARIAL verification panel for matcami (Restaurant POS, MVP v1.1).
Your job is NOT to judge whether this looks done. Your job is to PROVE IT IS NOT DONE.
Read your brief first — it is the section headed "## ${lens.brief}" in ${BRIEFS}. Read that whole
section before anything else.

DISPATCH — the only scope you have:
PLAN:     ${A.planPath || '(inline below)'}
SCOPE:    ${SCOPE}
WORKTREE: ${WT}
BASE:     ${BASE}
HEAD:     ${A.branch || '(current)'}
Judge ONLY the task IDs in SCOPE. A task outside SCOPE is NOT MISSING — it has not been started yet;
autonomy is per phase. Do not report it.

${evidence()}

Hunt ONLY in your domain: ${lens.hunts}.

Per defect return: severity; title; taskId (the T-nn it belongs to, or "-" for unplanned code);
evidence (file path plus the quoted diff hunk or line that proves it); failureScenario (inputs and
sequence -> the wrong state or the broken promise); violates (e.g. ["invariant 3", "spec 24"]); fix
(one line). BLOCKER = an invariant is violated, money can be wrong, a posted record is mutated, entries
can be unbalanced, a route is unauthenticated or unauthorised, a mandatory test is missing or failing,
or a task is not actually done. MAJOR = works but diverges from the plan or the spec, a test asserts
nothing meaningful, or unplanned scope crept in. MINOR = style, naming, a missing comment.
The plan header records deliberate decisions and accepted assumptions — a choice it states is not a
defect; re-read it before calling one. Return an empty array rather than padding: every finding faces
an adversary who will try to prove it is not real, so carry evidence that survives one.

${READONLY}
Your entire output is the findings array.`
}

function refutePrompt(f, lens, attempt) {
  return `You are an adversarial reviewer. REFUTE the finding below — argue the work IS done in this respect.
Project: matcami (Restaurant POS). Rulebook: ${ROOT}/CLAUDE.md. Spec: ${ROOT}/docs/spec.md — grep it.

${evidence()}

## The claim (from the ${lens.title} lens)
Severity: ${f.severity} | Task: ${f.taskId}
Title: ${f.title}
Evidence offered: ${f.evidence}
Failure scenario: ${f.failureScenario}
Claims it violates: ${f.violates.join(', ')}

REFUTED if ANY holds: (1) the diff does not say what the claim says — check the quoted lines yourself
in ${DIFF}; (2) the plan does not require what the claim requires — check the task and the header;
(3) the test output shows that test present and passing, or the plan never made it mandatory;
(4) another commit on this branch, or an existing constraint, already handles it; (5) it is generic
advice tied to no line of this diff and no task in this plan.
Verify every citation by reading the spec, CLAUDE.md and the diff yourself; never trust the claim's
reading of them. Default to refuted=true when genuinely uncertain — plausible findings drown real ones.
${f.severity === 'BLOCKER' ? 'EXCEPTION — this BLOCKER blocks the pull request. A false blocker costs an hour; a missed one ships wrong money or an open route. Set refuted=true ONLY if your refutation is convincing and evidenced, not merely plausible. On a coin flip, refuted=false.' : ''}

${READONLY}
Refutation attempt ${attempt + 1}. Return refuted plus one or two sentences naming what you checked.`
}

phase('Lens panel')
log('Five lenses hunting in parallel; each lens\'s findings are refuted as soon as that lens reports.')

// pipeline(): no barrier between stages — lens A's findings are refuted while lens B is still hunting.
const panels = await pipeline(
  LENSES,
  (lens) => agent(lensPrompt(lens), {
    label: lens.title + ' lens', phase: 'Lens panel', schema: FINDING_SCHEMA, effort: 'max',
  }),
  async (result, lens) => {
    if (!result || !Array.isArray(result.findings)) {
      log(lens.title + ': DID NOT REPORT — panel coverage is partial')
      return null   // filtered out by done = panels.filter(Boolean) ⇒ incomplete ⇒ BLOCKED
    }
    const findings = result.findings
    if (!findings.length) { log(lens.title + ': no findings'); return { lens: lens.id, survivors: [], refuted: [] } }
    // BLOCKERs get two independent refuters and die only if BOTH kill them.
    const votes = await parallel(findings.flatMap((f, i) =>
      Array.from({ length: f.severity === 'BLOCKER' ? 2 : 1 }, (_, k) => () =>
        agent(refutePrompt(f, lens, k), {
          label: 'refute ' + lens.id + ' #' + (i + 1) + (k ? 'b' : ''),
          phase: 'Refute', schema: VERDICT_SCHEMA, effort: 'max',
        }))))
    const survivors = []
    const refuted = []
    let cursor = 0
    for (const f of findings) {
      const n = f.severity === 'BLOCKER' ? 2 : 1
      const heard = votes.slice(cursor, cursor + n).filter(Boolean)
      cursor += n
      // A refuter that died counts as no refutation: the finding survives. Fail safe, not silent.
      if (heard.length === n && heard.every((v) => v.refuted)) {
        refuted.push({ lens: lens.id, severity: f.severity, title: f.title, why: heard[0].reasoning })
      } else {
        survivors.push(Object.assign({ lens: lens.id }, f))
      }
    }
    log(lens.title + ': ' + survivors.length + ' survived, ' + refuted.length + ' refuted')
    return { lens: lens.id, survivors: survivors, refuted: refuted }
  }
)

const done = panels.filter(Boolean)
const survivors = done.flatMap((p) => p.survivors)
const refuted = done.flatMap((p) => p.refuted)
const bySeverity = { BLOCKER: [], MAJOR: [], MINOR: [] }
for (const f of survivors) (bySeverity[f.severity] || (bySeverity[f.severity] = [])).push(f)
const unknown = survivors.filter((f) => !['BLOCKER', 'MAJOR', 'MINOR'].includes(f.severity))
if (unknown.length) log('WARNING: ' + unknown.length + ' finding(s) carry an off-enum severity — treated as blocking.')

const verdicts = LENSES.map((l) => {
  const p = done.find((d) => d.lens === l.id)
  if (!p) return { lens: l.id, verdict: 'DID NOT REPORT — re-run this lens before deciding' }
  const b = p.survivors.filter((f) => f.severity === 'BLOCKER').length
  return { lens: l.id, survivors: p.survivors.length, refuted: p.refuted.length,
    verdict: b ? 'FAIL — ' + b + ' blocker(s)' : (p.survivors.length ? 'PASS WITH FINDINGS' : 'PASS') }
})

const incomplete = done.length < LENSES.length
if (incomplete) log('WARNING: only ' + done.length + ' of ' + LENSES.length + ' lenses returned — coverage is partial.')
log(survivors.length + ' findings survived (' + bySeverity.BLOCKER.length + ' blockers); ' + refuted.length + ' refuted.')

return {
  lensVerdicts: verdicts,
  bySeverity: bySeverity,
  refutedCount: refuted.length,
  refutedLog: refuted.map((r) => r.severity + ' ' + r.title + ' (' + r.lens + ') — ' + r.why),
  unknownSeverity: unknown,
  prDecision: (bySeverity.BLOCKER.length || incomplete || unknown.length) ? 'BLOCKED' : 'MAY OPEN',
  prReason: bySeverity.BLOCKER.length ? bySeverity.BLOCKER.length + ' surviving blocker(s)'
    : (incomplete ? 'panel incomplete — a lens did not report'
    : (unknown.length ? 'finding(s) with an unrecognised severity — classify them before deciding'
    : 'no surviving blockers')),
}
```

## 6. Severity and gating

- **BLOCKER — blocks the PR.** An invariant is violated; money can be wrong; a posted record is
  mutated; journal entries can be unbalanced; a route is unauthenticated or unauthorised; a mandatory
  test (spec 29) is missing or failing; a task in the plan is not actually done. No push, no
  `gh pr create`, while one stands — and a lens that did not report blocks too, since partial coverage
  is not a pass.
- **A zero-byte `diff.patch` or an empty `commits.txt` is a panel ABORT, never a PASS.** An empty diff
  means `$BASE` is wrong or the work never landed; report it and stop. Every lens is told "a claim with
  no line of diff behind it is not a finding", so on an empty diff all five return PASS on nothing and
  the gate opens the PR it exists to block.
- **MAJOR — does not block.** Diverges from the plan or the spec; a weak test that asserts nothing
  meaningful; unplanned scope in the diff. Tell the user **before** the PR opens, and put each one in
  the PR body as a reviewer checklist line.
- **MINOR — noted only.** Style, naming, a missing comment. One line each in the report.

**Override.** Only the user overrides a BLOCKER, explicitly, in their own words, after seeing the
finding and its evidence — your confidence is not an override and neither is a deadline. Record it in
the PR body under `## Overridden blockers` with the finding, its evidence and the user's words. Never
open a PR "with a note" to get past a blocker: that is an override nobody granted.

## 7. The fix loop

1. **Report the blocker first** — finding, evidence, the task it belongs to. No silent fixing.
2. **Fix it in its own commit** on the same branch, the message naming the finding, not a new task id:
   `fix(verify): journal_entry_lines missing deferred balance constraint (BLOCKER, invariants lens)`.
   A verification fix is never a T-nn; the one-commit-per-task mapping stays intact.
3. **Re-collect the evidence** (§3 — diff and test output have both changed) and **re-run the affected
   lenses**: a schema fix re-runs `invariants` and `tests`, a scope fix re-runs `plan-vs-diff`; all
   five when the fix touched more than one task's files.
4. **Cap at three rounds.** If a blocker survives round three, stop: report what was tried, why each
   attempt failed, and hand the decision to the user. Thrashing at the gate burns context and leaves
   commits that confuse the reviewer more than the original defect did.

If a fix needs an open decision answered or an account code invented, it is not a fix — stop and ask
(CLAUDE.md "Open decisions"). If it needs an already-run migration changed, add a new one; never
hand-edit the old one, and never `UPDATE` a posted row to make a test pass (invariant 2).

## 8. The verification report

Give the user exactly this shape, in the conversation, before touching the remote: per-lens verdict;
surviving findings with the evidence that convinced you; the refuted list one line each, so the user
sees what was weighed instead of wondering what was missed; the real test output; the decision and why.

```markdown
## Verification — <feature slug> · <n> tasks · <n> commits · base <base-branch>

**Lenses:** completeness PASS · tests FAIL (1 blocker) · invariants PASS WITH FINDINGS ·
plan-vs-diff PASS · spec-conformance PASS

### Surviving findings
**BLOCKER — T-07: no test asserts the COGS entry (Dr 5000 = Cr 1200)**
Evidence: the diff adds only a `postSale` describe block to `posting-rules.test.ts`; `pnpm test`
reports 14 passed, none named cogs. Spec 29 makes a posting-rule test per event mandatory.
Fix: add the case T-07's Tests section names, then re-run.
**MAJOR — T-04: tax rate read at render time, not snapshotted on the line** → reviewer checklist.
**MINOR — T-02: `business_date` has no column comment.**

### Refuted (considered, then killed) — <n> in total
- BLOCKER "invoice numbers can collide" — UNIQUE (device_id, invoice_number) is in migration 0002.
- MAJOR "money helper duplicated" — the second file re-exports the first; no second rounding site.

### Tests
`pnpm test` — 14 passed, 0 failed, 2 skipped. Verbatim tail: <…>

### PR decision
**BLOCKED** — 1 surviving blocker. Fixing it as its own commit, then re-running the tests lens.
```

## 9. Fallback — Workflow unavailable or declined

Do not skip lenses. Run the same five briefs from `references/verify-lenses.md` sequentially,
in-conversation, at maximum reasoning effort, on the same §3 evidence, applying §5's refutation test to
every finding before keeping it — including the BLOCKER asymmetry: refute one only on convincing,
evidenced grounds. Then say plainly:

> The verification panel ran in reduced form — five lenses sequentially in-conversation rather than in
> parallel with independent adversarial refutation. Findings are less independently challenged than
> usual.

Silently running three lenses, or dropping the refutation pass without saying so, is worse than not
verifying at all: the same confident report, none of the checking behind it.
