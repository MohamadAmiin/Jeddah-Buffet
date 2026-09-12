# Phase 2 — the parallel risk panel

Five specialist lenses hunt in parallel for what this feature breaks in their own domain; an
adversarial pass then tries to **refute** every finding, so speculation never reaches the plan.
Survivors feed Phase 3 and, after the Phase 4 gate, the task file.

Running this panel via the Workflow tool is **explicitly sanctioned**: Workflow normally needs a user
opt-in, and a skill whose instructions tell Claude to call Workflow *is* that opt-in. Call it — do not
stop to ask, do not apologise for it.

## 1. When to run the panel

**Default: run it.** Scale down only for a genuinely trivial, isolated change — a copy tweak, a label,
a cosmetic component, a test rename. A feature is **NOT trivial**, and the full panel is mandatory, if it touches any of:

- money, prices, totals, tax, rounding, currency (invariants 1, 7 · spec 17, 18)
- accounting: accounts, journal entries, posting rules, anything reported off them (invariants 2, 3 · spec 22–25)
- inventory: stock movements, recipes, unit conversion, costing, COGS (invariant 6 · spec 15, 16)
- the payment transaction, order lifecycle, split/merge, voids, refunds, comps (invariants 2, 4, 9 · spec 13, 14)
- offline: IndexedDB, sync queue, idempotency keys, the device invoice sequence, menu version (invariant 5 · spec 5, 6)
- permissions, PINs, sessions, device registration, owner-PIN approval, audit (invariants 8–10, 12 · spec 7–9)
- printing, the print agent, the cash drawer (spec 11); POS sessions, business date, end-of-day (invariant 11 · spec 10)
- the database schema — any new table, column, index, constraint or migration

That covers nearly everything in matcami. **If in doubt, run the panel.** Running it on a small
feature costs minutes; skipping it on one that silently unbalances the ledger costs the books.

## 2. What each lens agent receives

Four things, and the third is what makes the panel worth running:

1. **Its lens brief** — the path to its file in `references/lenses/`: `accounting.md`, `data-model.md`,
   `offline-sync.md`, `permissions.md`, `ops-migration.md`. `ls` that directory first and use the names
   actually present.
2. **The feature description and the requirements agreed in Phase 0** — including the answers to your
   clarifying questions, not just the user's opening sentence.
3. **The FULL Phase 1 investigation findings, pasted as text into the prompt.** Not a summary, not a
   pointer to "go look at the repo". This is what stops a lens speculating about files: an agent that
   must re-derive the workspace burns its effort on `ls` and may contradict the investigation —
   asserting a table Phase 1 proved absent, or planning an edit to an imaginary file. The text must say
   per module whether it **exists** (and what is in it) or **does not exist yet** (so the plan must
   create it). Tell the lens to treat it as ground truth.
4. **Paths** to `/home/mohamed-amiin/Desktop/matcami/CLAUDE.md` and `.../docs/spec.md`, for quoting
   exact invariant wording and grepping citations. (Subagents get CLAUDE.md injected already; the path
   is for checking exact numbers, not re-reading the rulebook.)

## 3. The script

Pass the script inline, with `args` as a real JSON object (not a JSON string) carrying the three text
blobs. Adapt the lens `hunts` lines to the feature; leave the structure alone. If `args.feature` or
`args.investigation` is missing the script logs `ABORT` and returns `{ error: 'missing args' }` without
spawning anything — that is a **caller** bug, not the Workflow tool failing, so fix the call and re-run
rather than falling back to §6.

```js
export const meta = {
  name: 'matcami-risk-panel',
  description: 'Five-lens risk panel with adversarial refutation for a matcami feature plan',
  phases: [
    { title: 'Lens panel', detail: 'five specialist lenses hunt for what this feature breaks' },
    { title: 'Refute', detail: 'adversarial agents try to kill each finding' },
  ],
}

const A = (args && typeof args === 'object') ? args : {}
const FEATURE = A.feature || 'MISSING - the caller did not pass args.feature'
const REQUIREMENTS = A.requirements || 'MISSING - the caller did not pass args.requirements'
const INVESTIGATION = A.investigation || 'MISSING - the caller did not pass args.investigation'
const ROOT = '/home/mohamed-amiin/Desktop/matcami'
const BRIEFS = ROOT + '/.claude/skills/plan-feature/references/lenses'

if (!A.feature || !A.investigation) {
  log('ABORT: args.feature and args.investigation are required; pass args as a JSON object, not a JSON string.')
  return { error: 'missing args', needed: ['feature', 'requirements', 'investigation'] }
}

const LENSES = [
  { id: 'accounting',   brief: 'accounting.md',   title: 'Accounting & finance',
    hunts: 'unbalanced or missing journal entries, wrong account codes, contra-revenue booked as expense, clearing accounts never cleared, COGS not posted with the sale, edits to posted records, money as float or numeric, rounding applied twice' },
  { id: 'data-model',   brief: 'data-model.md',   title: 'Data model & schema',
    hunts: 'missing constraints and indexes, nullable columns that must not be, cached quantities treated as truth, missing snapshot columns on order lines, transaction boundaries and isolation, UNIQUE (device_id, invoice_number), tables that do not exist yet and must be created' },
  { id: 'offline-sync', brief: 'offline-sync.md', title: 'Offline & sync',
    hunts: 'operations that cannot complete offline, missing or non-deterministic idempotency keys, retries that duplicate, server rejecting a completed offline cash sale, invoice sequence gaps, card/mobile auto-completed offline, queue lost on logout or session close, menu snapshot replacement' },
  { id: 'permissions',  brief: 'permissions.md',  title: 'Permissions & security',
    hunts: 'a route with no server-side permission check (reads included), owner-PIN gates missing on the spec 8/14 actions, missing reason codes, audit row not written in the same transaction, PIN handling, session cookies, device cookie assumptions' },
  { id: 'ops-migration',brief: 'ops-migration.md',title: 'Ops & migration',
    hunts: 'hand-edited or destructive migrations, backfills that UPDATE posted rows, a journal table created without the balance constraint, deploy ordering vs devices still running old code, missing mandatory tests, report performance' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'MAJOR', 'MINOR'] },
          title: { type: 'string' },
          failureScenario: { type: 'string' },
          violates: { type: 'array', items: { type: 'string' } },
          mitigation: { type: 'string' },
        },
        required: ['severity', 'title', 'failureScenario', 'violates', 'mitigation'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['refuted', 'reasoning'],
}

function lensPrompt(lens) {
  return `You are the ${lens.title} lens on a planning risk panel for matcami (Restaurant POS, MVP v1.1).
Read your brief FIRST: ${BRIEFS}/${lens.brief}
Rulebook: ${ROOT}/CLAUDE.md (12 numbered invariants). Spec: ${ROOT}/docs/spec.md — grep it, cite as "spec 24".

## Feature
${FEATURE}

## Agreed requirements
${REQUIREMENTS}

## Workspace investigation — GROUND TRUTH. Do not re-derive it, do not contradict it.
${INVESTIGATION}

The repo may be greenfield in your area. Where the investigation says a module or table DOES NOT EXIST,
say the plan must create it — never describe editing a file the investigation did not find. You may read
files the investigation names to check details; do not go re-survey the repo.

You are READ-ONLY. Read and grep as much as you like; NEVER create, edit, delete or append to any file,
and never write to tasks/. Nothing reaches disk before the user approves the plan, which has not happened.
Your entire output is the findings array.

Hunt ONLY in your domain: ${lens.hunts}.
For each real risk return: severity (BLOCKER = corrupts money, the ledger, immutability or offline
correctness, or ships a security hole; MAJOR = wrong behaviour or certain rework; MINOR = smell), a
title, a CONCRETE failureScenario (specific inputs and sequence -> the wrong state that results),
violates (invariant numbers and spec sections, e.g. ["invariant 3", "spec 24"]), and a one-line
mitigation. Quality over volume — return an empty array rather than padding. Every finding must survive
a skeptic who will try to prove it cannot happen.`
}

function refutePrompt(f, lens, attempt) {
  return `You are an adversarial reviewer. REFUTE the risk below — argue it is NOT real.
Project: matcami (Restaurant POS). Rulebook: ${ROOT}/CLAUDE.md. Spec: ${ROOT}/docs/spec.md — grep it.

## The feature under review
${FEATURE}

## Agreed requirements (Phase 0)
${REQUIREMENTS}

## The claim (from the ${lens.title} lens)
Severity: ${f.severity}
Title: ${f.title}
Failure scenario: ${f.failureScenario}
Claims it violates: ${f.violates.join(', ')}

## Workspace investigation (ground truth)
${INVESTIGATION}

It is REFUTED if ANY of these hold:
  1. the cited invariant or spec section does not say, or does not apply, what the claim says it does;
  2. the failure scenario cannot occur, given this feature and the workspace as investigated;
  3. the spec already handles it — find the section and quote it;
  4. it is speculation about code nobody has written, tied to no decision this plan actually makes.
Judge criteria 2 and 4 against THIS feature and THESE requirements, not against matcami in general: a
risk about a decision this feature genuinely makes is not speculation just because the code is unwritten.
Verify every citation by reading the spec yourself; do not trust the claim's reading of it.
Default to refuted=true when genuinely uncertain — plausible-sounding risks drown the real ones.
${f.severity === 'BLOCKER' ? 'EXCEPTION — this is a BLOCKER. A false blocker costs a day; a missed blocker corrupts the books. Set refuted=true ONLY if your refutation is convincing and evidenced, not merely plausible. On a coin flip, refuted=false.' : ''}
You are READ-ONLY. Read and grep as much as you like; NEVER create, edit, delete or append to any file,
and never write to tasks/. Your entire output is the verdict.
Refutation attempt ${attempt + 1}. Return refuted plus one or two sentences citing what you checked.`
}

phase('Lens panel')
log('Five lenses hunting in parallel; each finding is refuted as soon as its lens reports.')

// pipeline(): each lens's findings go straight into refutation. No barrier — lens A's findings are
// being refuted while lens B is still hunting.
const panels = await pipeline(
  LENSES,
  (lens) => agent(lensPrompt(lens), {
    label: lens.title + ' lens', phase: 'Lens panel', schema: FINDINGS_SCHEMA, effort: 'max',
  }),
  async (result, lens) => {
    const findings = result && result.findings ? result.findings : []
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
for (const f of survivors) bySeverity[f.severity].push(f)
if (done.length < LENSES.length) log('WARNING: only ' + done.length + ' of ' + LENSES.length + ' lenses returned.')
log(survivors.length + ' findings survived (' + bySeverity.BLOCKER.length + ' blockers); ' + refuted.length + ' refuted.')

return {
  lensesCompleted: done.map((p) => p.lens),
  bySeverity: bySeverity,
  refutedCount: refuted.length,
  refutedLog: refuted.map((r) => r.severity + ' ' + r.title + ' (' + r.lens + ') — ' + r.why),
}
```

## 4. The adversarial pass — why it exists

An unchecked risk panel produces a wall of plausible-sounding risks in which the real ones drown; five
agents asked "what could go wrong?" will always find something to say. The refuter makes each finding
earn its place by arguing the invariant does not apply, the scenario cannot occur, the spec already
handles it, or it is speculation about code nobody has written — verifying citations against
`docs/spec.md` itself rather than trusting the lens's reading of them.

**Default to refuted when genuinely uncertain.** That instruction is deliberate.

The asymmetry inverts at the top of the scale: a false BLOCKER wastes a day of argument; a missed
BLOCKER corrupts the books, and in double-entry there is no clean undo — only a reversing entry and an
owner who stops trusting the reports. So BLOCKERs get two refuters, survive unless both kill them, and
their refutation must be **convincing and evidenced, not merely plausible**.

## 5. Synthesising the result — ultrathink

The workflow returns raw material; do this yourself, in conversation, at ultrathink effort.

- **Merge duplicates.** Two lenses raising one risk from different angles is one finding — but say so:
  independent agreement raises confidence, and the merged finding inherits the higher severity and the
  sharper failure scenario.
- **Order by severity**, blockers first; within a severity, by how early the decision must be made (a
  schema decision outranks a UI one — it constrains everything downstream).
- **Keep the refuted log**, one line each as `refutedLog` returns it. It shows the user what was
  considered and killed — how they judge whether the panel looked in the right places, and what
  pre-empts "did anyone think about X?".
- **Sanity-check coverage.** A lens returning nothing in an area the feature obviously touches is
  suspicious, not reassuring. Say so, or re-run that lens.
- **Feed survivors into Phase 3.** Each is a constraint the approaches must answer; an approach that
  cannot mitigate a BLOCKER is not a candidate. A finding whose only fix is a question the spec does
  not answer becomes an open-decision item for the Phase 4 gate (spec 33) — never silently resolved.

Nothing from this phase is written to `tasks/`. Phase 4 is a hard stop.

## 6. Fallback

If the Workflow tool is unavailable, errors out, or the user declines it, **do not skip lenses**. Run
the same five briefs sequentially in-conversation at maximum reasoning effort, with the same inputs
from section 2, applying the section 4 refutation test to each finding before keeping it. Then say
plainly:

> The risk panel ran in reduced form — five lenses sequentially in-conversation rather than in
> parallel with independent adversarial refutation. Findings are less independently challenged than
> usual.

Silently running three lenses, or dropping the adversarial pass without saying so, is worse than
skipping the panel outright: same confident-looking output, none of the checking.
