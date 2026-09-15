# matcami

Restaurant management and point of sale. One restaurant, one branch, one registered POS device,
one owner plus one cashier and one waiter. Dine-in (tables) and takeaway.

SvelteKit + TypeScript (UI **and** server) · Node.js · PostgreSQL · Drizzle ORM · IndexedDB and a
service worker for the offline POS · a local print agent over WebSocket/HTTP for receipts, kitchen
tickets and the cash drawer.

## Documentation

- **`docs/spec.md` is authoritative.** Sections 1–33; cite it as `(spec 17)`. It outranks everything
  else in the repo, including `CLAUDE.md`.
- **`CLAUDE.md`** holds the twelve non-negotiable invariants, the module layout, the glossary and the
  seven still-open decisions. Read it before changing anything.
- `docs/design-system.md` and `src/lib/styles/tokens.css` hold the design tokens.

## Prerequisites

|            |                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node       | **24.21.0**, pinned in `.nvmrc`. Run `nvm use` (or `fnm use`) before any pnpm command — `.npmrc` sets `engine-strict=true`, so `engines` refuses any other major version. |
| pnpm       | 10.33.0. `corepack` is not installed here, so there is no `packageManager` field to auto-install it.                                                                      |
| PostgreSQL | 16, running locally on port 5432. Not Docker — there is no compose file.                                                                                                  |

## First-time setup

```bash
nvm use                                   # 24.21.0
pnpm install
pnpm exec playwright install chromium     # browser binary, separate from the npm package

bash scripts/db-bootstrap.sh <owner-password> <app-password>   # roles + both databases; needs sudo
cp .env.example .env                      # then fill in the password you just chose
pnpm db:migrate                           # takes a backup first, then applies
```

`scripts/db-bootstrap.sh` is idempotent and safe to re-run. It takes **two** passwords, because there
are two roles: `matcami` **owns** the tables (migrations, `pg_dump`, `db:studio`) and `matcami_app` is
the **runtime** role, which owns nothing. That split is what lets row-level security be switched on
later by one migration instead of a database re-bootstrap. It creates `matcami` and `matcami_test`,
both owned by the `matcami` role and both pinned to UTC. Ownership is not cosmetic: PostgreSQL 15+
revoked `CREATE` on schema `public` from `PUBLIC`, and drizzle-kit needs `CREATE` on the database for
its own `drizzle` schema.

`.env` is gitignored and must never be committed. `.env.example` is the committed template and must
never contain a working credential.

### Creating a company: public sign-up

Anyone can create a company — a restaurant and its owner account — at `/register` (decided
2026-09-15). There is no setup token and no first-run step. The limits: a per-address throttle, and at
most **3 new companies per internet address per 24 hours** (IPv6 counted per /64), counted in the
database so a restart does not reset it. One email address belongs to one company.

`SIGNUP=closed` in the environment stops new sign-ups (restart the app to apply): `/register` then
says sign-up is closed and `/login` hides its link. Unset, or `SIGNUP=open`, is the default.

**Companies created from the server** — for example while sign-up is closed — use
`pnpm restaurant:create`. It runs the same code without the public page's limits.

**A forgotten owner password** is reset with `pnpm auth:reset-owner <email>`. It hashes through the
same module the application uses, clears the lockout, ends every session for that owner and writes an
audit row. Never run `UPDATE users SET password_hash = ...` by hand: that leaves no audit row, no
session invalidation, and a hash that may not parse.

For production — HTTPS, Nginx, the proxy headers, migrations in a container, and the two database
roles — see [docs/deployment.md](docs/deployment.md).

## Everyday commands

```bash
pnpm dev                  # dev server
pnpm build                # production build (adapter-node → build/index.js)
pnpm preview              # serve the production build

pnpm check                # svelte-kit sync && svelte-check
pnpm lint                 # prettier --check . && eslint .
pnpm format               # prettier --write .

pnpm test                 # Vitest: unit + integration
pnpm test:unit            # unit project only
pnpm test:integration     # integration project only — needs TEST_DATABASE_URL
pnpm test:e2e             # Playwright, against the production build

pnpm db:generate          # drizzle-kit — SQL from src/lib/server/db/schema
pnpm db:migrate           # db:backup, then drizzle-kit migrate
pnpm db:backup            # pg_dump into backups/ (gitignored)
pnpm db:studio            # row editor over the live database

pnpm auth:reset-owner <email>   # reset the owner's password (prompts, audited)
pnpm restaurant:create          # create an ADDITIONAL restaurant and its owner
```

## Three warnings

**`pnpm db:studio` is a row editor over the live database. Never edit a posted record with it.** A
paid order, invoice, payment, stock movement or journal entry is corrected with a _reversing record_,
never an `UPDATE` (invariant 2).

**Hand-written SQL migrations are created only with `drizzle-kit generate --custom`.** That command
registers the file in `migrations/meta/_journal.json`. A `.sql` file added to the folder by hand is
never registered and is silently never applied — so you would believe a constraint exists while the
database has no such thing.

**Migrations are never deleted or edited once they have run.** Drizzle stores a hash per migration and
does not re-check it, so removing one silently diverges this database from every freshly built one.
Add a new migration instead. `pnpm db:migrate` takes a backup first, automatically (spec 29) — do not
bypass it by calling `drizzle-kit migrate` directly.

## Tests

Two Vitest projects. `unit` runs `src/**/*.test.ts` in plain Node. `integration` runs
`src/**/*.integration.test.ts` against a real PostgreSQL, serially (`fileParallelism: false`), because
every file shares one database.

The integration project **fails closed**: it refuses to run unless `TEST_DATABASE_URL` is set _and_
the database name ends in `_test`. There is no fallback to `DATABASE_URL`, deliberately — a fallback
is what turns "the test database was not configured" into "the test suite truncated the real one".

Playwright runs against `pnpm build && pnpm preview`, never the dev server: service workers and
SvelteKit's CSRF origin check do not exist under `vite dev`, so a dev-server harness could never test
the offline POS.

### Spec 29's six mandatory test areas

This harness makes all six testable. **None of them is implemented yet** — the mandatory suites arrive
with the code they cover.

| Area                                          | Project it belongs to                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Money arithmetic and rounding                 | unit                                                                            |
| Tax calculation in **both** modes             | unit                                                                            |
| Journal entries always balance                | **integration** — only a real database can prove it rejects an unbalanced entry |
| One posting rule per business event (spec 24) | unit + integration                                                              |
| Offline sync retries never duplicate          | integration                                                                     |
| Permission checks on every POS API            | **integration**                                                                 |

## Pinned versions that look wrong and are not

Do not "update" these to `latest`; each breaks something.

- **Node 24.21.0** — `vitest@5` declares `engines.node: ^22.12.0 || ^24.0.0 || >=26.0.0`, so Node 25 is
  excluded outright and `pnpm test` refuses to run there.
- **TypeScript 6.0.3**, not 7.x — `@sveltejs/kit` peers `^5.3.3 || ^6.0.0`, `svelte-check` peers
  `^5.0.0 || ^6.0.0`, `typescript-eslint` peers `>=4.8.4 <6.1.0`. 6.0.3 is the only version all three
  accept, and a plain `pnpm add -D typescript` installs 7.x and breaks `pnpm check` and `pnpm lint`.
- **`@types/node` 24.13.4**, not the `latest` 22.x and not the `ts6.0` tag's 26.x — it must match the
  Node 24 runtime.

Every dependency is pinned exactly, with no `^` or `~`. That is deliberate: a scaffold is the one place
determinism is worth more than easy minor upgrades.
