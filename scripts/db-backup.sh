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
pg_dump "$DATABASE_URL" --format=custom --file="$out"
echo "Backup written: $out"
