#!/usr/bin/env bash
#
# Create the matcami PostgreSQL role and both databases.
#
# Idempotent and safe to re-run: it creates only what is missing. It needs
# `sudo -u postgres` because the default Ubuntu PostgreSQL 16 install uses peer
# authentication for the postgres superuser and has no role for the OS user.
#
#   bash scripts/db-bootstrap.sh <password>
#   MATCAMI_DB_PASSWORD=<password> bash scripts/db-bootstrap.sh
#
# The password is NEVER stored in this file. Put it in .env as part of
# DATABASE_URL / TEST_DATABASE_URL; .env is gitignored and never committed.
#
set -euo pipefail

ROLE=matcami
DBS=(matcami matcami_test)

PASSWORD="${1:-${MATCAMI_DB_PASSWORD:-}}"

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
role_exists=$(psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'")
if [ "$role_exists" = "1" ]; then
  echo "role $ROLE: already exists, left untouched"
  if [ -n "$PASSWORD" ]; then
    echo "  NOTE: a password was supplied but NOT applied — this script never rotates an"
    echo "        existing credential. To set it deliberately, run:"
    echo "        sudo -u postgres psql -c \"ALTER ROLE $ROLE PASSWORD '<password>'\""
  fi
else
  [ -n "$PASSWORD" ] || {
    echo "Role $ROLE does not exist and no password was given." >&2
    echo "Usage: bash scripts/db-bootstrap.sh <password>" >&2
    echo "   or: MATCAMI_DB_PASSWORD=<password> bash scripts/db-bootstrap.sh" >&2
    exit 1
  }
  psql_super -v pw="$PASSWORD" -c "CREATE ROLE $ROLE LOGIN PASSWORD :'pw'"
  echo "role $ROLE: created"
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
done

# ------------------------------------------------------------------ report ----
# matcami_test exists so the Vitest integration project can never touch
# development data; its setup refuses any database not ending in _test.
echo
echo "Put these in .env (see .env.example). .env is gitignored — never commit it."
if [ -n "$PASSWORD" ] && [ "$role_exists" != "1" ]; then
  echo "  DATABASE_URL=postgres://$ROLE:$PASSWORD@localhost:5432/matcami"
  echo "  TEST_DATABASE_URL=postgres://$ROLE:$PASSWORD@localhost:5432/matcami_test"
else
  # Never read a password back out of the database — it is stored only as a hash.
  echo "  DATABASE_URL=postgres://$ROLE:<password>@localhost:5432/matcami"
  echo "  TEST_DATABASE_URL=postgres://$ROLE:<password>@localhost:5432/matcami_test"
fi
echo
echo "Verify (as the role, over TCP — not as postgres):"
echo "  psql \"\$DATABASE_URL\" -c \"select current_user, current_database(), current_setting('TimeZone')\""
