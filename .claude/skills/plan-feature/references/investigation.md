# Phase 1 — Workspace Investigation (MANDATORY)

## Why

A plan built on assumed file contents is worse than no plan: it is wrong *and* it looks authoritative, so a fresh session executes it without doubt.
In a repo this young the dominant failure is planning an **edit** to a file that was never built — the module layout in `CLAUDE.md` is a plan, not an inventory.
Never skip this phase, never substitute memory for a command you actually ran, and record the command **and** its output for anything you later assert. Run every step from the repo root.

## Step 1 — Orient: what phase is this repo in?

Decide this before forming any opinion, because it decides whether the plan CREATES or MODIFIES.

```bash
cd /home/mohamed-amiin/Desktop/matcami && ls -la
for f in package.json drizzle.config.ts docker-compose.yml .env .gitignore vitest.config.ts; do
  test -f "$f" && echo "$f: YES" || echo "$f: NO"; done   # never print .env contents
for d in src src/lib/server/db src/lib/server/db/migrations src/lib/pos src/routes; do
  test -d "$d" && echo "$d: YES" || echo "$d: NO"; done
mig=$(find src/lib/server/db/migrations -maxdepth 1 -name '*.sql' 2>/dev/null | sort | head -20)
[ -n "$mig" ] && echo "$mig" || echo "no migrations"
grep -n '^tasks' .gitignore 2>/dev/null || echo ".gitignore missing or lacks tasks/"
git rev-parse --is-inside-work-tree 2>/dev/null && git status --short | head -30 || echo "NOT a git repo"
t=$(find src \( -name '*.test.ts' -o -name '*.spec.ts' \) 2>/dev/null | sort | head -20)
[ -n "$t" ] && echo "$t" || echo "NO test files (src/ may not exist)"
```

Two shell rules for every block in this file, because a silently empty check is worse than no check.
**Never write `cmd | filter || echo "fallback"`** — `||` tests the *pipeline's* exit status, which is
the filter's (`sort`/`head` succeed on empty input), so the fallback never fires and the step prints
nothing at all. Capture into a variable and test it, as above. And **never glob a path that may not
exist** (`src/**/*.sql`): this shell is zsh, which aborts the whole command with `no matches found`
before it runs, and `2>/dev/null` cannot suppress that. Use `find` instead.

**Required output — one line, this exact shape:**
> `REPO PHASE: <greenfield | greenfield-area | partially-built | established> — <evidence, e.g. "no package.json, no src/; only CLAUDE.md + docs/spec.md">`

- **greenfield** — no `package.json`, no `src/`. Every task is a CREATE, and the plan must name the scaffolding this feature forces into existence (tooling, DB client, migration runner) as explicit prerequisite tasks.
- **greenfield-area** — scaffolded, but the feature's modules do not exist. Mixed CREATE/MODIFY; name which per file.
- **partially-built / established** — the modules exist. Every MODIFY task must cite a path you opened.

A greenfield verdict does **not** shorten the investigation; it shifts it — you establish build order and dependencies instead of blast radius in existing code.

## Step 2 — The rules

```bash
cat CLAUDE.md                            # all 12 invariants, in full, every time
grep -n '^## ' docs/spec.md              # section index — find the numbers this feature touches
# then READ the sections themselves: CLAUDE.md is a summary with citations, not the spec text
sed -n '/^## 13\./,/^## 14\./p' docs/spec.md   # substitute the section you need; read it whole
grep -n -iE 'idempoten|invoice number|business date|unsynced' docs/spec.md          # offline
grep -n -iE 'weighted average|COGS|stock movement|negative stock|recipe' docs/spec.md
grep -n -iE 'posting rule|journal|debit|credit|chart of accounts|clearing' docs/spec.md
grep -n -iE 'tax mode|inclusive|exclusive|round|discount' docs/spec.md              # money
grep -n -iE 'owner approval|PIN|permission|403|audit' docs/spec.md                  # access
grep -n -iE 'ESC/POS|print agent|kitchen ticket|drawer|open decision' docs/spec.md
```

Record: section numbers read (cite as `(spec 24)`), the invariant numbers governing this feature, and any **open decision (spec 33)** it collides with — surfaced to the user at the Phase 4 gate, never answered silently.

## Step 3 — The schema

```bash
db=$(find src/lib/server/db -name '*.ts' 2>/dev/null | sort)
[ -n "$db" ] && echo "$db" || echo "NO db module — every table is a CREATE"
grep -rn 'pgTable' src/lib/server/db 2>/dev/null | head -40
find src/lib/server/db/migrations -maxdepth 1 -name '*.sql' 2>/dev/null | sort   # every migration, in order
grep -rnE 'bigint|numeric\(|timestamptz|timestamp\(' src/lib/server/db 2>/dev/null | head -40
grep -rnE 'references\(|unique\(|index\(|check\(' src/lib/server/db 2>/dev/null | head -40
```

Open and read the table definitions this feature touches — do not infer columns from a name. Record, per table: money columns (must be `bigint` minor units, invariant 1), quantity columns (`numeric(12,3)`), timestamps (`timestamptz`, invariant 11), unique constraints (notably `UNIQUE (device_id, invoice_number)`, invariant 5), the balanced-journal DB constraint (invariant 3), foreign keys and indexes.

Check for **pending** migrations: a `pgTable` change with no matching `.sql` in `migrations/` means the schema files and the generated SQL disagree — say so.

**When none of this exists:** state plainly `no schema exists yet`. The plan's first phase then *defines* these tables and must specify the column types and constraints above itself — the invariants bind tables you are about to create exactly as they bind tables that exist.

## Step 4 — The live database (OPTIONAL, GATED, READ-ONLY)

Only if Step 1 found a `DATABASE_URL` or a `docker-compose.yml` suggesting a reachable database. **ASK THE USER FIRST. Do not connect on your own initiative.** Ask in one line: *"A database appears reachable. May I run read-only structure and count queries against it? I will not write, migrate, or read customer or payment data."* On an explicit yes, read-only only:

```bash
psql "$DATABASE_URL" -c '\dt'                     # tables that actually exist — READ THIS FIRST
psql "$DATABASE_URL" -c '\d+ orders'              # real columns, types, constraints, indexes
psql "$DATABASE_URL" -c 'select count(*) from orders;'
# spec 24 names the accounting tables: accounts, journal_entries, journal_entry_lines.
# Confirm that name against the \dt output above before running this — a mistyped regclass errors with
# "relation ... does not exist" and the invariant-3 check is silently skipped, which is the one
# outcome this step exists to prevent.
psql "$DATABASE_URL" -c "select conname, pg_get_constraintdef(oid) from pg_constraint
                         where conrelid='journal_entry_lines'::regclass;"
psql "$DATABASE_URL" -c "select * from drizzle.__drizzle_migrations order by created_at desc limit 5;"
```

Hard limits: **NEVER** `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`DROP`, **NEVER** run a migration, **NEVER** `SELECT` customer, employee or payment rows — structure and `count(*)` only; never print `.env` or the connection string.
The point: **the deployed schema can differ from the schema files.** A balance constraint present in `schema.ts` but absent from the running database is exactly what makes an invariant-3 plan fail at deploy, and this is the only check that catches it. Also determine whether existing rows would need backfilling by a new NOT NULL column or constraint.

## Step 5 — The code

Find the modules the feature touches, then **read the real signatures** — a guessed signature produces tasks that call functions which do not exist.

```bash
ls src/lib/server/ src/lib/pos/ src/routes/ 2>/dev/null
grep -rn '^export ' src/lib/server/money src/lib/server/accounting src/lib/server/inventory \
                    src/lib/server/orders src/lib/server/permissions src/lib/server/audit \
                    src/lib/pos 2>/dev/null | head -60
```

Then **open** the files that matter and record **path + actual signature** — or `DOES NOT EXIST YET — this plan must create it`:

| Thing | Look in | Why |
|---|---|---|
| The rounding function, tax in both modes | `lib/server/money` | Inv. 1, 7 — a second rounding helper is a bug |
| The payment transaction | `lib/server/orders` | Inv. 4 — one all-or-nothing transaction at payment |
| The posting-rule table | `lib/server/accounting` | Inv. 3 — entries generated, never typed |
| The stock movement writer | `lib/server/inventory` | Inv. 6 — no cached qty without its movement |
| The permission check helper | `lib/server/permissions` | Inv. 8 — every route, reads included |
| Sync queue + idempotency key derivation | `lib/pos` | Inv. 5 — a retry must be a no-op |
| Device invoice sequence | `lib/pos` | Inv. 5 — gap-free, per device |
| Print agent client | `lib/pos` | Printing never inside the transaction (inv. 4) |

## Step 6 — The tests

```bash
find . -path ./node_modules -prune -o \( -name '*.test.ts' -o -name '*.spec.ts' \) -print 2>/dev/null
ls e2e tests playwright.config.ts 2>/dev/null || echo "no e2e setup"
grep -rln 'describe(' src 2>/dev/null | head -20
```

State which of the six mandatory areas (spec 29) this feature lands in — each one it touches is a required test in the plan, not an optional one:
money arithmetic and rounding · tax in **both** modes · journal entries always balance (property test + DB rejects unbalanced) · one posting-rule test per business event (spec 24) · offline sync retries never duplicate · a permission check test on every POS API route.
If no test harness exists, the plan must stand one up before the first task that owes a test.

## Step 7 — Blast radius (mechanical, not intuitive)

Run the greps; do not reason about what "probably" calls what.

```bash
grep -rn '<functionBeingChanged>' src --include='*.ts' --include='*.svelte' 2>/dev/null  # every caller
grep -rln '<tableName>' src/routes src/lib/server 2>/dev/null              # routes + modules on the table
grep -rnE 'snapshot|menuVersion|menu_version' src/lib/pos src/routes/api 2>/dev/null
grep -rn 'lib/server' src/lib/pos 'src/routes/(pos)' 2>/dev/null           # boundary violation check
grep -rniE 'receipt|kitchen ticket|escpos|drawer' src 2>/dev/null          # does it print?
grep -rniE 'end-of-day|endOfDay|business_date|businessDate|trial balance' src 2>/dev/null
```

These are **templates**: `<functionBeingChanged>` and `<tableName>` are placeholders. Substitute the
real symbol and table names Phase 1 actually named and run the grep once per symbol — grepping the
placeholder finds nothing and "no callers found" then means nothing. When the repo is greenfield,
record `src/ does not exist — blast radius is forward-looking` rather than an empty result set.

Answer explicitly, each with evidence: who calls the changed functions · which routes touch the tables · is this data in the **menu snapshot** (a change there forces a menu-version bump and a full POS re-download) · does it cross into `lib/pos` (then it must work offline and carry an idempotency key) · does it appear on a **receipt, kitchen ticket, or the end-of-day report / trial balance**.

On an empty repo the blast radius is forward-looking: which *planned* modules will depend on what this feature creates, and therefore what must be built first.

## The investigation report

Present this before Phase 2. Every claim carries its evidence; an unknown is written as unknown.

```
REPO PHASE: <verdict> — <evidence>
FILES READ  (only files you opened; a grep is "grepped, not read")
  <absolute path> — <one line: what it actually contains>
EXISTS vs MUST BE CREATED
  EXISTS: <path> — <signature / table definition>
  CREATE: <path> — <what it must become, and why this feature needs it>
SCHEMA FACTS
  <table>: money <bigint?> · qty <numeric(12,3)?> · time <timestamptz?>
           constraints <...> · indexes <...> · pending migration? <yes/no>
  (or "no schema exists yet — `find src/lib/server/db` returned nothing")
LIVE DB: <not checked, no DATABASE_URL> | <user declined> | <read-only findings>
BLAST RADIUS
  callers · routes · menu snapshot yes/no · crosses into lib/pos yes/no
  appears on receipt / kitchen ticket / EOD report / trial balance: ...
INVARIANTS ENGAGED: <numbers from CLAUDE.md>
SPEC SECTIONS READ: <numbers>
OPEN DECISIONS TOUCHED (spec 33): <numbers, or none>
UNKNOWNS
  - <stated as a question, never guessed at>
```

## Anti-patterns — any one of these invalidates the investigation

- Describing a file you did not open.
- "The codebase probably has…" — probably is not evidence. Run the grep or write it as an unknown.
- Using `CLAUDE.md` as a substitute for reading the cited spec section.
- Skipping investigation because the feature "seems small" — small features break invariants just as effectively.
- Assuming a module exists because `CLAUDE.md`'s layout lists it. That layout is a plan.
- Connecting to a database without asking, or running anything that writes.
- Filling an unknown with a plausible answer instead of surfacing it in Phase 4.
