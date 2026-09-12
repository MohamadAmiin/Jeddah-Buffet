# Task file format — the output contract

**The consumer is a fresh Claude session with zero context.** It opens `tasks/<feature>.md`, reads
**one** task, and must implement it correctly from that text plus the repo. It cannot ask what you
meant. Every ambiguity becomes a wrong implementation — here, an unbalanced ledger, an edited posted
record, or money in a float. Over-specify. Nothing below happens until Phase 4's gate returns an
explicit go-ahead.

## 1. Pre-write checks

**Go-ahead**: the user said yes, in words, **after** you presented Phase 4 and in response to that
presentation. "Looks good" counts. Silence, a question, your own confidence, and a request made
*before* the presentation ("plan X and write me the task file", "just give me the tasks") do **not**
— that is a request for the skill, not approval of a plan the user has not seen. If you cannot quote
the approval, stop, finish phases 0–4, and ask at the gate. Say in the handoff if you created
`.gitignore`. If the collision check prints a path, do **not** overwrite — ask (§2).

**Run nothing below until you can quote the user's approval.**

```bash
# ONLY after the go-ahead above is quoted
cd /home/mohamed-amiin/Desktop/matcami
mkdir -p tasks
# idempotent: creates .gitignore if absent, appends once, never duplicates, never joins the last line
grep -qxF 'tasks/' .gitignore 2>/dev/null || {
  [ -s .gitignore ] && [ "$(tail -c1 .gitignore)" != "" ] && printf '\n' >> .gitignore
  printf 'tasks/\n' >> .gitignore
}
grep -nxF 'tasks/' .gitignore                                     # must print exactly ONE line
                                                                  # zero or two ⇒ stop, fix by hand
ls -d tasks/<slug>.md tasks/<slug>/ 2>/dev/null || echo "clear"   # collision check
```

## 2. Naming and re-plans

`tasks/<feature-slug>.md` — kebab-case, from the **feature**, never the date or a ticket id. Good:
`split-bill-by-seat`, `service-charge`, `offline-card-fallback`. Bad: `2026-09-12-plan`,
`pos-improvements` (not one feature).

Re-planning — ask, never guess. **Supersede** (default): rename the old file `tasks/<slug>-v1.md`,
open the new one with a dated note. **Amend**: append tasks with fresh IDs, mark old ones
`~~T-04~~ SUPERSEDED by T-11 (2026-09-12): <why>` — never renumber a task someone may have run.
**Replace**: only on explicit instruction, and say history was dropped. Plans are decision history;
deleting one deletes the reason an approach was rejected.

```markdown
> **Supersedes `tasks/service-charge-v1.md` (2026-09-12).** v1 posted the charge to 4000 Sales
> Revenue; the owner decided it is not revenue. Recorded under Assumptions.
```

## 3. The document header

Every plan file — single, or `00-overview.md` — opens with this. **It is the only context transfer
that exists.** Without it a fresh session knows the *what* but not the *why*, and will "improve" the
design in the exact direction Phase 2 ruled out.

````markdown
# Service charge on dine-in orders

**Goal.** A configurable percentage service charge on dine-in orders, applied after discounts and
before tax, on its own receipt line, posted to its own ledger account so gross profit is not
distorted. Takeaway unaffected.

## Requirements (as agreed with the user)
- Owner sets one percentage in settings; 0 disables it. Dine-in only.
- Applies to the discounted subtotal, before tax (invariant 7); its own line, never folded into
  item prices.
- Must work offline — the POS computes it from the cached setting.
- Waiters cannot change it; the owner can waive it with a PIN approval.

## Scope
**IN** — settings field, order totals, receipt line, posting rule, offline snapshot, reports line.
**OUT** — per-item charge, tips, allocating across split bills by seat, distributing it to staff
(payroll is in CLAUDE.md "Do NOT build").

## Approach
**Chosen: an order-level charge line stored on the order, posted to a new liability account.**
Rejected — *synthetic order item*: a non-menu item row breaks recipe deduction and COGS (inv. 6).
Rejected — *compute at render time*: the charge never reaches the journal, so the trial balance stops
tying to the receipts.

## Risks that survived adversarial verification
- **HIGH** — needs an account spec 23 does not define. That is an open decision, not a gap to fill
  silently. T-01 surfaces it; no schema lands before it is answered.
- **MED** — rounding charge and tax separately re-introduces a second rounding site, breaking
  invariant 7's "one rounding rule in one function".
- **LOW** — setting changed mid-shift; mitigated by snapshotting the rate on the order.
- *Refuted, dropped*: "split bills double-charge" — split allocates an already-computed total.

## Assumptions (open decisions this plan rides on)
- Open decision 3 (tax rules): assumed the charge **is taxable**. Flagged for the accountant; T-04
  keeps it a boolean setting so reversing it is a setting change, not a migration.
- Account code: **not yet assigned.** Spec 23 defines no service-charge account and CLAUDE.md
  forbids inventing one. T-01 must obtain the code and the name from the owner before any schema,
  seed row or posting rule references it — no task below may hardcode a number until it does.

## In play
Spec: 13 (payment transaction), 14 (approvals), 17 (money, tax, rounding), 23 (chart of accounts),
24 (posting rules), 29 (mandatory tests).
Invariants: 1 (integer cents in bigint), 2 (posted records permanent), 3 (entries balance in the DB),
4 (one transaction at payment), 7 (discount before tax; line snapshots), 8 (server-side permissions).

## Research (only when research happened)
One §8 block per question, inline. Every `CONFLICT WITH SPEC` and every `GAP` recorded here also
appears in the risk section above and in the Phase 5 handoff message.

## Workspace state at plan time (Phase 1, 2026-09-12)
`src/` does not exist. This describes the repo **before T-01 runs**: every path in this plan is
absent today, so there is no pre-existing code to modify. Files created by **earlier tasks in this
plan** are expected to exist by the time a later task runs — each task's `Files:` tag says which case
it is (`NEW` = this task creates it, `EXTEND` = an earlier task in this plan created it and names
which, `EDIT` = it already existed at Phase 1). **Stop and report a mismatch only** when a path
tagged `NEW` in the task you are about to run already exists, or a path tagged `EXTEND`/`EDIT` does
not — either means the repo is not in the state this plan assumed.
````

That last block is not optional: it stops a fresh session inventing a "small edit" to a file that was
never created, and it stops the opposite mistake — a session re-creating from scratch a file an
earlier task in the same plan already wrote.

## 4. Phases

| # | Phase | Contains |
|---|---|---|
| 0 | Scaffolding | `package.json`, the SvelteKit app, `drizzle.config.ts` pointed at `src/lib/server/db/migrations`, the DB client, `docker-compose.yml`, the Vitest/Playwright harness — ONLY the parts this feature forces into existence |
| 1 | Schema | Drizzle tables, columns, indexes, constraints, one generated migration, CoA rows |
| 2 | Domain | `src/lib/server/{money,accounting,inventory,orders,permissions,audit}` |
| 3 | API | `+server.ts` / form actions — validate, check permission, call the module, return |
| 4 | UI | `routes/(pos)`, `routes/(dashboard)` |
| 5 | Tests | E2E and the spec 29 suites that span layers |

Deviate with one line of why under the phase heading: a **phase 0 decisions** when an open decision
or a new account code is in play; **no schema phase** for a pure calculation or report; an **offline
phase between domain and API** when `lib/pos` needs its own store, queue op or snapshot field —
offline is not a UI concern and must never be smuggled into phase 4. A **phase 0 scaffolding** is
REQUIRED whenever Phase 1 returned `REPO PHASE: greenfield` — without it the first schema task runs
`pnpm db:generate` in a repo with no `package.json`. List only what this feature forces into
existence, state the invariant 1/3 constraints the scaffolding must already satisfy (`bigint` money
columns; the deferred debits=credits constraint written as raw SQL, since drizzle-kit will not
generate it), and make every later phase declare `**Depends on:** Phase 0`. When a decisions phase
and a scaffolding phase are both needed, number them `0a decisions` and `0b scaffolding` — no
scaffolding or schema may encode an answer 0a has not obtained. Unit tests are never deferred to
phase 5; they ship in the task that writes the code. Declare dependencies twice, redundantly:
`**Depends on:** Phase 1` under each phase heading, and per-task `Needs:` IDs — by ID, never "the
previous work".

## 5. The task template

```markdown
### T-NN — <imperative one-line title>

**Needs:** T-NN, T-NN   (or `-`)
**Files:**
- `path/to/file.ts` — NEW
- `path/to/created-earlier.ts` — EXTEND (created by T-NN; <what to add, beside what>)
- `path/to/other.ts` — EDIT (<where in the file>)
**Spec:** <n> (<what it settles>), <n> (<...>)
**Invariants:** <n> (<name>), <n> (<name>)

**Do:**
1. <concrete step — real symbols, real column types, real account codes>

**Tests:** (mark `MANDATORY (spec 29)` when the area is one of the six)
- <named case → expected value>

**Done when:** <objectively checkable — a command that passes, a constraint that rejects a row>

**Watch out:** <the specific trap here, if there is one>
```

- **ID** `T-01`, zero-padded, unique across the whole plan including split directories, never reused.
- **Files** exact from the repo root, each tagged `NEW` / `EXTEND` / `EDIT`. The tag is how a
  zero-context session decides whether to create a file or open one, so it must be right:
  - `NEW` — absent at Phase 1 **and** created by this task. Write it from scratch.
  - `EXTEND` — absent at Phase 1 but created by an **earlier task in this plan**. Write
    `EXTEND (created by T-03; add X beside Y)` and **never rewrite the file wholesale** — what is
    already in it was written by a task that has run, and recreating the file destroys it.
  - `EDIT` — present at Phase 1, with a location hint (`inside payOrder()`) or the code lands in
    the wrong function.
  On a greenfield repo there is no `EDIT`: the first task to touch a path tags it `NEW`, and every
  later task tags it `EXTEND` naming the task that created it.
- **Invariants** numbered **and named**: `Invariants: 3` is a lottery ticket, `3 (journal entries
  balance in the DB)` is an instruction.
- **Do** schema tasks give column names, types and constraints verbatim; accounting tasks give
  literal `Dr <code> <name> / Cr <code> <name>`.
- **Tests** the six mandatory areas: money arithmetic and rounding; tax in **both** modes; entries
  balance; one posting-rule test per spec 24 event; offline retries never duplicate; a permission
  check per POS API route. **Done when** must be checkable by someone who does not understand the
  feature — never "it works".
- **Sizing** one task ≈ one sitting, one reviewable diff. Split when `Files:` exceeds ~4 paths, `Do:`
  exceeds ~8 steps, it crosses two layers, or two steps fail for unrelated reasons — along the seam
  giving **independently verifiable halves** ("write the posting rule + its unit test", then "call it
  from the payment transaction + its rollback test"), never "part 1 of 2".

### A fully worked example

````markdown
### T-07 — Post the COGS journal entry inside the payment transaction

**Needs:** T-02 (journal tables + deferred balance constraint), T-05 (weighted-average cost lookup),
T-06 (`postSale` + the `payOrder()` transaction skeleton)
**Files:**
- `src/lib/server/accounting/posting-rules.ts` — EXTEND (created by T-06; add `postCogs` beside
  `postSale`. Do not rewrite the file)
- `src/lib/server/orders/payment.ts` — EXTEND (created by T-06; inside `payOrder()`, after the
  inventory deduction and the invoice row, before `markPaid`)
- `src/lib/server/accounting/posting-rules.test.ts` — EXTEND (created by T-06; add a new describe
  block beside the existing `postSale` block)
**Spec:** 13 (the ordered payment transaction), 16 (weighted average; COGS posted on every sale),
24 (posting rule "Cost of food sold": Debit COGS, Credit Inventory)
**Invariants:** 1 (money is integer cents in bigint), 3 (journal entries balance in the DB),
4 (one all-or-nothing transaction at payment), 6 (inventory is a ledger; every sale posts COGS)

**Do:**
1. Export `postCogs(tx: DbTx, args: { orderId: string; businessDate: string;
   movements: StockMovement[] })`. It takes the transaction handle — it MUST NOT open its own.
2. Sum `movements` into `totalCostMinor: bigint` from each movement's `cost_minor`. Do **not**
   recompute cost from quantity × average: T-05 computed it at deduction time and that is what the
   inventory ledger recorded. Two computations of one cost are two chances to disagree (inv. 6).
3. If `totalCostMinor === 0n`, write nothing and return `null` — a zero entry is trial-balance noise,
   and a comped order legitimately lands here.
4. Insert one `journal_entries` row: `event_type = 'COGS'`, `source_type = 'order'`,
   `source_id = orderId`, `business_date = businessDate` — the POS session's business date, passed
   in, never `created_at::date` (inv. 11).
5. Insert exactly two `journal_entry_lines`:
   - `Dr 5000 Cost of Goods Sold` — `debit_minor = totalCostMinor`, `credit_minor = 0`
   - `Cr 1200 Inventory` — `credit_minor = totalCostMinor`, `debit_minor = 0`
6. In `payment.ts` call `postCogs(tx, …)` inside the existing transaction, in spec 13's order —
   payment(s) → finalize totals → record invoice number → deduct inventory → **create invoice** →
   create journal entries (sale, then COGS) → mark PAID. So: after `deductInventory` returns its
   movements, after the invoice row is created, and after `postSale`, immediately before `markPaid`.
   Pass those movements through; do not re-query them.
7. Do not catch its errors — a COGS failure must roll the whole payment back (inv. 4).

**Tests:**
- MANDATORY (spec 29 — posting rule per business event): a sale consuming ingredients at `1250` and
  `300` minor units posts `Dr 5000 = 1550n` and `Cr 1200 = 1550n`.
- MANDATORY (spec 29 — entries balance): property test over generated movement sets asserts
  `sum(debit_minor) === sum(credit_minor)` for every entry `postCogs` writes.
- MANDATORY (spec 29 — DB level): committing only the debit line is rejected by T-02's deferred
  constraint. A comped order (`totalCostMinor === 0n`) writes zero `journal_entries` rows.
- Integration: forcing `postCogs` to throw leaves **no** payment, invoice, stock movement or sale
  journal entry behind — assert row counts unchanged after the rollback.

**Done when:** `pnpm test src/lib/server/accounting/posting-rules.test.ts` passes, the rollback
integration test passes, and a manually paid order produces exactly two journal entries (sale and
COGS) whose lines sum debit = credit.

**Watch out:** `bigint` columns return as `bigint`/string, not `number`. Seed the sum with `0n`; a
`bigint + number` throws at runtime. Nothing here may `UPDATE` an existing entry (inv. 2) — a wrong
cost is fixed by a reversing entry in its own task, never an edit.
````

Note the tags. Phase 1 found no `src/`, so nothing in T-07 is `EDIT`: T-06 created all three files
earlier in this same plan, which is exactly what `EXTEND` means — T-07 adds to them and rewrites
none of them. In a repo where Phase 1 had actually opened those files, the same three lines would
read `EDIT` with the same location hints.

## 6. Writing rules

- Real paths, real symbols. Never "the relevant module" or "the existing helper". If Phase 1 gave you
  no name, write `create <name>` — inventing a name is fine, leaving it unnamed is not.
- Give the numbers: account codes (`5000`, `1200`), column types (`bigint`, `numeric(12,3)`,
  `timestamptz`), the `Dr`/`Cr` side, the status code (`403`).
- State the invariant in words inside the task. Not "respects invariant 7" — write "discount first,
  then tax the discounted amount (inv. 7)". Never assume CLAUDE.md will be opened.
- Never reference the planning conversation — no "as we discussed", "the approach we picked". The
  header carries that; tasks repeat what they need.
- Prefer concrete over-specification to graceful ambiguity: redundancy costs lines, ambiguity costs a
  migration that has already run, which invariant 2 forbids you to hand-edit back.
- Never say a file "contains X". Say to check the file, and what to do if it is absent.

## 7. Packaging and the zip

Default one file. Switch to a directory past **~600 lines** or **~15 tasks** — count before writing.

```
tasks/service-charge/
  00-overview.md   the document header + the COMPLETE task index (every ID, title, phase file, Needs)
  01-decisions.md  02-schema.md  03-domain.md  04-api.md  05-ui.md  06-tests.md
  RESEARCH.md      only when research actually happened
tasks/service-charge.zip
```

Only phases the plan actually has get a file: a greenfield plan inserts `02-scaffolding.md` before
the schema file and renumbers the rest; a pure-calculation plan has no schema file at all.

`00-overview.md` always lists **every** task ID. The index is never split from the plan: a session
handed `03-domain.md` must still see from the overview that T-07 needs T-05 from `02-schema.md`.

```bash
cd /home/mohamed-amiin/Desktop/matcami/tasks
zip -r service-charge.zip service-charge/ -x '.*' && unzip -l service-charge.zip
```

The zip is a **snapshot for handoff**; the directory stays the working copy — edit the `.md` files
and regenerate, never edit inside the zip. If `command -v zip` is empty use
`tar -czf service-charge.tar.gz service-charge/` and say the format changed; if neither exists, skip
the archive, say so explicitly, and hand over the directory path.

## 8. Research findings

One block per question — in `RESEARCH.md` when the plan is a directory, or under the header's
`## Research` section in the single file otherwise. Findings are evidence, not decisions — a source
never silently overrides the spec. URL and access date mandatory; quote what the source says, not
what you think it means; two sources disagreeing is itself a finding, so record both.

````markdown
## Q: Does ESC/POS `ESC p` fire a drawer on the printer's RJ11 port?

- **Source:** https://example-vendor.test/escpos-manual.pdf — accessed 2026-09-12
- **Says:** `ESC p m t1 t2` pulses pin 2 or 5; widths are in 2 ms units and many printers ignore `t2`.
- **Affects the plan:** T-09 sends `ESC p 0 25 250` and treats the ack as "command sent", not "drawer
  opened". No task may claim the drawer state is known.
- **GAP — for the user:** spec 11 says the print agent opens the drawer on cash payments but says
  nothing about whether the drawer's open/closed state can be read back; this source says the
  hardware gives no feedback. **Not resolved here.** T-09 is blocked until the user chooses: drop
  any UI that claims the drawer state is known, or require a drawer with a sense line.
````

Label it `CONFLICT WITH SPEC` only when the spec actually states something the source contradicts —
quote the spec line. When the spec is simply silent, it is a `GAP`. Manufacturing a spec position in
order to declare a conflict is the same defect as ignoring a real one. Every `CONFLICT WITH SPEC`
and every `GAP` also appears in the plan's risk section and in the Phase 5 handoff message.

## 9. Quality bar — run before handing over

- [ ] Could a fresh session execute **T-07 alone**, having read only the header and that task?
- [ ] Does every money task name `bigint` integer minor units, with no float, no `parseFloat`, no
      `numeric` money column, and no rounding outside `src/lib/server/money` (inv. 1, 7)?
- [ ] Does every accounting task name its literal `Dr`/`Cr` codes from spec 23?
- [ ] Does every new `+server.ts` or form action include its permission check and `403` (inv. 8)?
- [ ] Does each of spec 29's six areas the feature touches have a real test case, marked MANDATORY,
      with expected values?
- [ ] Is any file path invented? Cross-check against Phase 1 **and** against the `Files:` lists of
      earlier tasks: a path in neither is `NEW`, a path an earlier task in this plan creates is
      `EXTEND` (naming that task), and a path Phase 1 actually opened is `EDIT`. No task may be
      tagged `NEW` for a file an earlier task already wrote.
- [ ] Does any task `UPDATE`/`DELETE` a paid order, invoice, payment, stock movement, journal entry
      or line (inv. 2)? Replace it with a reversing record.
- [ ] Does every assumed open decision appear under Assumptions **and** in a task that surfaces it
      before schema lands?
- [ ] Does every `Done when:` name a command or an observable condition, not a feeling?
- [ ] Is `tasks/` in `.gitignore`, exactly once?
