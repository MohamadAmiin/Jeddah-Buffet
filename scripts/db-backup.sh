#!/usr/bin/env bash
#
# Take a pg_dump of DATABASE_URL into backups/.
#
# `pnpm db:migrate` runs this FIRST (it is chained in package.json), which turns
# spec 29's "a backup is always taken before running database migrations" into a
# mechanism rather than a comment. Do not bypass it by calling drizzle-kit
# migrate directly.
#
# backups/ is gitignored: a dump of this database will eventually contain PIN
# hashes, session tokens and the audit log, and must never be committed.
#
set -euo pipefail
[ -f .env ] && set -a && . ./.env && set +a
mkdir -p backups
out="backups/matcami-$(date -u +%Y%m%d-%H%M%SZ).dump"
# MIGRATE_DATABASE_URL, not DATABASE_URL: a dump must read every table, which the
# runtime role cannot do. Running pg_dump as the OWNER is also what keeps the door
# open for row-level security later — a forced-RLS table dumped by its own owner
# fails outright, and that would break `pnpm db:migrate`, which chains this script.
pg_dump "$MIGRATE_DATABASE_URL" --format=custom --file="$out"
echo "Backup written: $out"
