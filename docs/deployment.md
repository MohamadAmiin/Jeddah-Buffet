# Deploying matcami

Target: a cloud server running Docker behind Nginx, HTTPS only (spec 29, spec 32;
spec 33 open decision 2's recommended default).

`docs/spec.md` is authoritative. Where this file and the spec disagree, the spec
wins and this file is wrong.

---

## 1. HTTPS only, everywhere — including a LAN trial

**Do not serve matcami over plain HTTP on anything except `localhost`.**

SvelteKit marks the session cookie `Secure` for every origin except
`http://localhost`, and browsers **discard** a `Secure` cookie delivered over
plain HTTP from any other host. On `http://192.168.1.10:3000` the result is a
silent endless login loop:

1. the owner signs in, the server sets the cookie,
2. the browser drops it because the connection is not secure,
3. the next request has no session, so the guard redirects to `/login`,
4. nothing is logged anywhere, because nothing failed.

Test locally on `localhost`, or through an SSH port-forward. **Never add an HTTP
exception to the cookie** — the cookie flags come from SvelteKit's defaults on
purpose (invariant 12), so that a future safer default is inherited.

In production the app refuses to start unless `ORIGIN` is set, is `https:` and is
not localhost.

## 2. Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name pos.example.com;

  # ... ssl_certificate / ssl_certificate_key ...

  # Without this, every audit row records the proxy's address and the login
  # throttle treats all visitors as one client.
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Host $host;

  # THE PRIMARY THROTTLE. The application's in-memory bucket (auth/throttle.ts)
  # is a backstop only: it is process-local, resets on restart, and would not be
  # shared if a second Node instance were ever added.
  limit_req zone=login burst=5 nodelay;
  limit_conn addr 10;

  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}

# In the http{} block:
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=addr:10m;
```

Pair the `X-Forwarded-For` header with `ADDRESS_HEADER=x-forwarded-for` and
`XFF_DEPTH=1` in the environment. `XFF_DEPTH=1` is correct for **one** proxy in
front of the app; if you add a CDN or a second proxy, raise it to match, or the
address read will be a header value an attacker can set.

## 3. First run

The window between deploying and the owner registering is real, and it is
scanned: a new host's TLS certificate appears in Certificate Transparency logs
within minutes of issuance, and scanners follow. `/register` creates the owner
account.

1. Set `SETUP_TOKEN` to a long random value in the server environment.
2. Deploy and start the app.
3. Register the owner **immediately**, at `https://<host>/register`.
4. **Unset `SETUP_TOKEN` and restart.**

While `SETUP_TOKEN` is unset, `/register` refuses every submission regardless of
the restaurant count. Once a restaurant exists, `/register` answers 404 to anyone
signed out, and redirects a signed-in owner to `/dashboard`.

Additional restaurants are created with `pnpm restaurant:create`, never by
re-opening the endpoint. There is deliberately no environment variable that
re-opens `/register`: a flag that re-exposes an unauthenticated account-creating
endpoint is one forgotten variable away from public signup with none of the
guards public signup would need.

## 4. Migrations in production

`drizzle-kit` is a **dev** dependency, so an image built with
`pnpm install --prod` cannot run `pnpm db:migrate`. Do not add it to the
production image just to run migrations.

1. **Back up first** (spec 29: "A backup is always taken before running database
   migrations"). Take the `pg_dump` **on the database host**, as the **owner**
   role (`MIGRATE_DATABASE_URL`), into storage that is **not the container's
   filesystem**. `backups/` inside a container is ephemeral and is not a backup.
2. Apply migrations with a small runner using `drizzle-orm/node-postgres/migrator`
   — the same runtime migrator `src/lib/server/db/test/global-setup.ts` uses for
   the test database. `drizzle-orm` is a runtime dependency, so it is present.
3. Never hand-edit or delete a migration that has run. Drizzle records a hash per
   migration and does not re-check it, so removing one silently diverges that
   database from every freshly built one. Add a new migration instead.
4. Hand-written SQL is created **only** with `drizzle-kit generate --custom`,
   which registers the file in `migrations/meta/_journal.json`. A `.sql` file
   dropped into the folder by hand is never registered and is silently never
   applied.

## 5. The two database roles

| Role | Owns | Used by |
|---|---|---|
| `matcami` | every table | migrations, `pg_dump`, `db:studio`, the test harness |
| `matcami_app` | **nothing** | the running application (`DATABASE_URL`) |

`matcami_app` has `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE, SELECT`
on sequences, and **not** `TRUNCATE`, `CREATE` or any DDL. It cannot truncate
`audit_log` even though that table's append-only trigger covers only `UPDATE` and
`DELETE` — the privilege is the second half of that guarantee.

**Do not "simplify" the deployment by pointing the application at the owner
role.** The split is what makes row-level security a later one-line migration
rather than a database re-bootstrap: a table owner bypasses that table's policies
unless it is additionally `FORCE ROW LEVEL SECURITY`, and forcing it makes
`pg_dump` run by that owner fail outright — which would break the migration
pipeline, because `pnpm db:migrate` chains `pnpm db:backup` first.

Create both roles with `bash scripts/db-bootstrap.sh <owner-password>
<app-password>`. It is idempotent and never rotates an existing credential.

## 6. `db:studio` is a row editor over the live database

**Never edit a posted record with it.** A paid order, invoice, payment, stock
movement or journal entry is corrected with a **reversing record**, never an
`UPDATE` (invariant 2).

Audit rows cannot be edited at all: the database refuses. `UPDATE` and `DELETE` on
`audit_log` both raise `audit_log is append-only`. That is deliberate, and it
means a mistake in the audit log is corrected by writing a NEW row, never by
changing an existing one.

`db:studio` connects as the owner role (`MIGRATE_DATABASE_URL`), so it can do
everything the application cannot. Treat it as a production database console.

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | always | The **runtime** role. Owns nothing. |
| `MIGRATE_DATABASE_URL` | always | The **owner** role. See the note below. |
| `TEST_DATABASE_URL` | tests only | Must end in `_test`; the harness refuses otherwise. |
| `ORIGIN` | production | Must be `https:` and not localhost, or the app refuses to start. |
| `ADDRESS_HEADER` | behind a proxy | `x-forwarded-for`. Without it every audit row records the proxy. |
| `XFF_DEPTH` | behind a proxy | `1` for a single proxy. |
| `SETUP_TOKEN` | first run only | Unset it after the owner registers. |

**One open question, recorded rather than decided.** `env.ts` currently *requires*
`MIGRATE_DATABASE_URL` at application startup, which puts the **owner** credential
into the runtime environment — working against the containment the role split
exists to provide, since an attacker with code execution in the app process would
find it there. Migrations and dumps run outside the app process (see §4), so this
could reasonably become optional in production. It is required today because T-02
of the restaurant-identity plan specified it; changing it is a deliberate decision
for whoever next touches `env.ts`.
