#!/usr/bin/env bash
#
# Create the matcami PostgreSQL roles and both databases.
#
# TWO roles: `matcami` OWNS the tables (migrations, pg_dump, db:studio), and
# `matcami_app` is the RUNTIME role, which owns nothing. That split is what makes
# row-level security a later one-line migration instead of a re-bootstrap.
#
# Idempotent and safe to re-run: it creates only what is missing. It needs
# `sudo -u postgres` because the default Ubuntu PostgreSQL 16 install uses peer
# authentication for the postgres superuser and has no role for the OS user.
#
#   bash scripts/db-bootstrap.sh <owner-password> <app-password>
#   MATCAMI_DB_PASSWORD=<pw> MATCAMI_APP_DB_PASSWORD=<pw> bash scripts/db-bootstrap.sh
#
# The password is NEVER stored in this file. Put it in .env as part of
# DATABASE_URL / TEST_DATABASE_URL; .env is gitignored and never committed.
#
set -euo pipefail

ROLE=matcami
APP_ROLE=matcami_app
DBS=(matcami matcami_test)

PASSWORD="${1:-${MATCAMI_DB_PASSWORD:-}}"
APP_PASSWORD="${2:-${MATCAMI_APP_DB_PASSWORD:-}}"

command -v psql >/dev/null || { echo "psql not found — install the PostgreSQL client." >&2; exit 1; }
command -v sudo >/dev/null || { echo "sudo not found — this script needs sudo -u postgres." >&2; exit 1; }

# Fail fast and legibly rather than half-way through: everything below is sudo.
sudo -v || { echo "sudo authentication failed — nothing was changed." >&2; exit 1; }

psql_super() { sudo -u postgres psql -X -q --no-psqlrc "$@"; }

# ---------------------------------------------------------------- role --------
# CREATE ROLE is not idempotent, so guard it. The guard is at shell level rather
# than in a DO block because the password must reach psql as a variable: psql
# does not interpolate :'vars' inside a dollar-quoted $$ ... $$ body, so a DO
# block could only get the password by string-pasting it into SQL, which is
# injection-prone. :'pw' below is quoted by psql itself.
#
# The password is fed on STDIN, not via -c: psql performs variable interpolation
# only on input it reads from stdin or a file. With -c the literal text :'pw'
# reaches the server and it answers `syntax error at or near ":"`, which means the
# role is never created. Measured, not assumed.
role_exists=$(psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'")
app_role_exists=$(psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE'")

# Validate EVERY password we will need BEFORE changing anything. Exiting halfway
# is the failure this ordering exists to prevent: the app-role block sits between
# the owner role and the database loop, so a late `exit 1` would leave the owner
# role created and neither database in existence — a half-bootstrapped cluster
# that the next documented step (pnpm db:migrate) then dies against.
missing=''
if [ "$role_exists" != "1" ] && [ -z "$PASSWORD" ]; then
  missing="$missing
  - $ROLE (the OWNER) needs a password: argument 1, or MATCAMI_DB_PASSWORD"
fi
if [ "$app_role_exists" != "1" ] && [ -z "$APP_PASSWORD" ]; then
  missing="$missing
  - $APP_ROLE (the RUNTIME role) needs a password: argument 2, or MATCAMI_APP_DB_PASSWORD"
fi
if [ -n "$missing" ]; then
  {
    echo "Nothing was changed. These roles do not exist and no password was supplied:$missing"
    echo
    echo "Usage: bash scripts/db-bootstrap.sh <owner-password> <app-password>"
    echo "   or: MATCAMI_DB_PASSWORD=<pw> MATCAMI_APP_DB_PASSWORD=<pw> bash scripts/db-bootstrap.sh"
  } >&2
  exit 1
fi

if [ "$role_exists" = "1" ]; then
  echo "role $ROLE: already exists, left untouched"
  if [ -n "$PASSWORD" ]; then
    echo "  NOTE: a password was supplied but NOT applied — this script never rotates an"
    echo "        existing credential. To set it deliberately, run:"
    echo "        sudo -u postgres psql -c \"ALTER ROLE $ROLE PASSWORD '<password>'\""
  fi
else
  # Password presence was already validated above, before any mutation.
  psql_super -v pw="$PASSWORD" <<<"CREATE ROLE $ROLE LOGIN PASSWORD :'pw'"
  echo "role $ROLE: created"
fi

# ------------------------------------------------------- runtime role ---------
# The application connects as this role, which OWNS NOTHING. That separation is
# the whole point: a table owner bypasses that table's row-level security unless
# the table is additionally marked FORCE ROW LEVEL SECURITY, and forcing it makes
# pg_dump run by that same owner fail outright — which breaks `pnpm db:migrate`,
# because that script chains `pnpm db:backup` first. Splitting the roles now means
# row-level security can be switched on later by ONE migration, with no bootstrap
# rewrite and no privilege re-grant. This script creates NO policy.
#
# Deliberately NOT granted: SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS.
if [ "$app_role_exists" = "1" ]; then
  echo "role $APP_ROLE: already exists, left untouched"
  if [ -n "$APP_PASSWORD" ]; then
    echo "  NOTE: a password was supplied but NOT applied — this script never rotates an"
    echo "        existing credential. To set it deliberately, run:"
    echo "        sudo -u postgres psql -c \"ALTER ROLE $APP_ROLE PASSWORD '<password>'\""
  fi
else
  # Password presence was already validated above, before any mutation.
  psql_super -v pw="$APP_PASSWORD" <<<"CREATE ROLE $APP_ROLE LOGIN PASSWORD :'pw'"
  echo "role $APP_ROLE: created (owns nothing, by design)"
fi

# ------------------------------------------------------------ databases -------
# CREATE DATABASE cannot run inside a transaction or a DO block, so it is
# guarded here, once per database. Ownership is not cosmetic: PostgreSQL 15+
# revoked CREATE on schema public from PUBLIC, so a non-owner cannot create
# tables there, and drizzle-kit needs CREATE on the database to make its own
# `drizzle` schema for the migrations table. Ownership grants both.
for dbname in "${DBS[@]}"; do
  exists=$(psql_super -tAc "SELECT 1 FROM pg_database WHERE datname = '$dbname'")
  if [ "$exists" = "1" ]; then
    echo "database $dbname: already exists"
    current_owner=$(psql_super -tAc \
      "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$dbname'")
    if [ "$current_owner" != "$ROLE" ]; then
      echo "  owner is '$current_owner', not '$ROLE' — reassigning"
      psql_super -c "ALTER DATABASE \"$dbname\" OWNER TO $ROLE"
    fi
  else
    sudo -u postgres createdb -O "$ROLE" "$dbname"
    echo "database $dbname: created, owner $ROLE"
  fi

  # Every connection to these databases speaks UTC. Timestamps are stored UTC in
  # timestamptz; the restaurant's time zone is a setting applied at the edges,
  # never a property of the database.
  psql_super -c "ALTER DATABASE \"$dbname\" SET timezone TO 'UTC'"
  echo "database $dbname: timezone = UTC"

  # Grant the runtime role what it needs and nothing more. These run INSIDE the
  # database ( -d "$dbname" ): GRANT USAGE ON SCHEMA and ALTER DEFAULT PRIVILEGES
  # are per-database, and running them against `postgres` would silently do
  # nothing useful.
  #
  # The two ALTER DEFAULT PRIVILEGES statements are the point of this whole
  # block, and they MUST say FOR ROLE matcami: default privileges attach to the
  # role that CREATES the object, and `matcami` is the role that will create
  # every future table through migrations. Without FOR ROLE, they would attach to
  # whoever ran this script (postgres), never apply, and every table a later plan
  # adds would be invisible to the runtime — surfacing as "permission denied for
  # table" only after that table's first query in production.
  #
  # The sequence grant is not optional: audit_log.id is GENERATED ALWAYS AS
  # IDENTITY, which is backed by a sequence, and an insert fails without USAGE.
  #
  # TRUNCATE is deliberately ABSENT. PostgreSQL requires the TRUNCATE privilege
  # for that statement and only the owner holds it by default, so the runtime role
  # cannot truncate audit_log even though the append-only trigger covers only
  # UPDATE and DELETE. That is the intended division of labour — do not add it.
  psql_super -d "$dbname" <<SQL
GRANT CONNECT ON DATABASE "$dbname" TO $APP_ROLE;
GRANT USAGE ON SCHEMA public TO $APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $APP_ROLE;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $APP_ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE $ROLE IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APP_ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE $ROLE IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO $APP_ROLE;
SQL
  echo "database $dbname: $APP_ROLE granted CRUD + default privileges (no TRUNCATE, no DDL)"
done

# ------------------------------------------------------------------ report ----
# matcami_test exists so the Vitest integration project can never touch
# development data; its setup refuses any database not ending in _test.
echo
echo "Put these in .env (see .env.example). .env is gitignored — never commit it."
# DATABASE_URL is the RUNTIME role, which owns nothing. MIGRATE_DATABASE_URL and
# TEST_DATABASE_URL are the OWNER: migrations and pg_dump create and read
# everything, and the integration harness creates and truncates tables, which the
# runtime role must not be able to do.
# Only ever print a password supplied on THIS run — never read one back out of
# the database, where it is stored as a hash.
if [ -n "$APP_PASSWORD" ] && [ "$app_role_exists" != "1" ]; then
  echo "  DATABASE_URL=postgres://$APP_ROLE:$APP_PASSWORD@localhost:5432/matcami"
else
  echo "  DATABASE_URL=postgres://$APP_ROLE:<app-password>@localhost:5432/matcami"
fi
if [ -n "$PASSWORD" ] && [ "$role_exists" != "1" ]; then
  echo "  MIGRATE_DATABASE_URL=postgres://$ROLE:$PASSWORD@localhost:5432/matcami"
  echo "  TEST_DATABASE_URL=postgres://$ROLE:$PASSWORD@localhost:5432/matcami_test"
else
  echo "  MIGRATE_DATABASE_URL=postgres://$ROLE:<owner-password>@localhost:5432/matcami"
  echo "  TEST_DATABASE_URL=postgres://$ROLE:<owner-password>@localhost:5432/matcami_test"
fi
echo
echo "Verify (as the role, over TCP — not as postgres):"
echo "  psql \"\$DATABASE_URL\" -c \"select current_user, current_database(), current_setting('TimeZone')\""
