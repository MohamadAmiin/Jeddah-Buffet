#!/usr/bin/env bash
#
# Redeploy matcami on the VPS: pull → install → build → print agent installers →
# backup+migrate → restart → health check.
#
# Run ON the server as the user that owns the checkout AND the PM2 daemon that
# runs the app (on this server that is root, app dir /root/buufiya). It finds
# the checkout by itself (current dir → next to the script → /root/buufiya):
#
#   bash /root/deploy.sh            # the server copy in root's home
#   bash scripts/deploy.sh          # or from inside the repo
#
# Configuration comes from the environment, with defaults matching this server:
#
#   BRANCH=main            the branch to reset the checkout to (origin/BRANCH)
#   PM2_APP=buufiya        the PM2 process name (`pm2 ls` shows it)
#   HEALTH_URL=http://127.0.0.1:4173/login   (adapter-node binds 127.0.0.1, not ::1)
#   SKIP_MIGRATE=          set to 1 to skip backup+migrations (code-only deploy)
#
# The checkout is treated as DISPOSABLE: every run discards local edits to
# tracked files and resets hard to origin/$BRANCH. Ignored files (.env,
# backups/, node_modules) are never touched by the reset. Never hand-edit code
# on the server — it will be gone on the next deploy.
#
# The print agent installers (one download per OS, served at
# /downloads/print-agent) are built from .env's ORIGIN into
# dist/print-agent/current, with the last good set kept in previous/ (about
# 0.5 GB together); the Node binaries they are made from are cached in
# .cache/print-agent. When neither the agent nor ORIGIN changed, that step is a
# no-op, and a failure there never stops the app's own deploy.
#
# What it deliberately does NOT do:
#   - no nginx, TLS, PM2 process-definition or .env changes — it restarts the
#     app exactly as PM2 already knows it;
#   - no database writes outside `pnpm db:migrate`, which takes a pg_dump FIRST
#     (spec 29) — the dump lands in backups/ next to this checkout;
#   - no automatic rollback: migrations are forward-only (invariant 2), so on a
#     failed deploy it prints the previous commit and the restore steps instead
#     of guessing.
#
set -euo pipefail

BRANCH="${BRANCH:-main}"
PM2_APP="${PM2_APP:-buufiya}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4173/login}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"

log() { printf '\n== %s ==\n' "$*"; }
die() { printf 'DEPLOY FAILED: %s\n' "$*" >&2; exit 1; }

# ── Preflight: refuse early, before anything is touched ──────────────────────
# The script may live inside the repo (scripts/deploy.sh) or beside it (e.g.
# /root/deploy.sh with the checkout at /root/buufiya): take APP_DIR from the
# environment, else the current directory, else the directory above this
# script, else this server's checkout.
SCRIPT_PARENT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${APP_DIR:-}" ]; then
	if [ -f package.json ]; then APP_DIR="$PWD"
	elif [ -f "$SCRIPT_PARENT/package.json" ]; then APP_DIR="$SCRIPT_PARENT"
	elif [ -f /root/buufiya/package.json ]; then APP_DIR=/root/buufiya
	else die "cannot find the app — run from the repo or set APP_DIR=/path/to/checkout"
	fi
fi
cd "$APP_DIR"
log "Preflight in $APP_DIR"

[ -f package.json ] || die "no package.json in $APP_DIR"
[ -f .env ] || die ".env is missing (see .env.example)"
grep -q '^DATABASE_URL=' .env || die "DATABASE_URL missing from .env"
grep -q '^MIGRATE_DATABASE_URL=' .env || die "MIGRATE_DATABASE_URL missing from .env (owner role — backups and migrations need it)"

# Node comes from nvm on this server; engines is strict, so the wrong node
# refuses every pnpm command anyway — this just makes the error readable.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
	# nvm's scripts are not set -u clean.
	set +u; . "$NVM_DIR/nvm.sh"; nvm use >/dev/null 2>&1 || true; set -u
fi
command -v node >/dev/null || die "node not found"
WANT="v$(cat .nvmrc)"
[ "$(node -v)" = "$WANT" ] || die "node $(node -v) but .nvmrc wants $WANT (install it: nvm install $(cat .nvmrc))"
command -v pnpm >/dev/null || die "pnpm not found"
command -v pm2 >/dev/null || die "pm2 not found"
command -v pg_dump >/dev/null || die "pg_dump not found (backups run before migrations)"

# ORIGIN, CHECKED BEFORE ANYTHING IS BUILT OR MIGRATED.
# src/lib/server/env.ts is the source of truth and refuses to boot on a bad
# ORIGIN; this mirrors its rule so the refusal costs a second here instead of a
# full build plus a schema migration followed by an app that will not start. If
# that guard ever changes, change this with it.
# Read in a subshell so .env cannot leak into this script's environment
# (scripts/db-backup.sh sources it the same way).
ORIGIN_VALUE="$(set -a; . ./.env; set +a; printf '%s' "${ORIGIN:-}")"
ADDRESS_HEADER_VALUE="$(set -a; . ./.env; set +a; printf '%s' "${ADDRESS_HEADER:-}")"
ORIGIN_KIND="$(node -e '
const o = process.argv[1];
if (!o) { console.log("missing"); process.exit(0); }
let u; try { u = new URL(o); } catch { console.log("invalid"); process.exit(0); }
const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
console.log(u.protocol === "https:" ? "https" : loopback ? "loopback" : "insecure");
' "$ORIGIN_VALUE")"

case "$ORIGIN_KIND" in
	https) echo "ORIGIN: $ORIGIN_VALUE" ;;
	loopback)
		echo "ORIGIN: $ORIGIN_VALUE — loopback. Correct for a local production build,"
		echo "  WRONG for a real deployment: browsers reach this server by its public name,"
		echo "  and the app would answer their form POSTs with 403. See docs/deployment.md."
		;;
	missing) die "ORIGIN is not set in .env. The app refuses to boot in production without it." ;;
	invalid) die "ORIGIN in .env is not a valid URL (got \"$ORIGIN_VALUE\")." ;;
	insecure)
		die "ORIGIN is \"$ORIGIN_VALUE\" — plain HTTP on a public address, which the app
  REFUSES to boot on (src/lib/server/env.ts), so deploying would stop the site.
  SvelteKit marks the session cookie Secure for every origin but http://localhost,
  and a browser throws a Secure cookie away when it arrives over plain HTTP — the
  result is a login screen that silently loops forever (docs/deployment.md §1).
  Serve this host over HTTPS and set ORIGIN to the https:// URL.
  Nothing was built, migrated or restarted."
		;;
	*) die "could not read ORIGIN from .env" ;;
esac

if [ "$ORIGIN_KIND" != "loopback" ] && [ -z "$ADDRESS_HEADER_VALUE" ]; then
	die "ADDRESS_HEADER is not set in .env, and the app refuses to boot without it behind
  a proxy: every visitor would look like Nginx, so public sign-up's per-address cap
  would treat them as one client and every audit row would record the proxy.
  Set ADDRESS_HEADER=x-forwarded-for and XFF_DEPTH=1. Nothing was changed."
fi

pm2 describe "$PM2_APP" >/dev/null 2>&1 \
	|| die "PM2 app '$PM2_APP' not found — run 'pm2 ls' and re-run with PM2_APP=<name>"

# ── Reset hard to origin/$BRANCH (the checkout is disposable) ────────────────
log "Updating to origin/$BRANCH"
git fetch origin "$BRANCH" || die "git fetch failed"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
if [ -n "$(git status --porcelain)" ]; then
	echo "Discarding local changes on the server:"
	git status --short | sed 's/^/  /'
fi
if [ "$OLD" = "$NEW" ]; then
	echo "Already at origin/$BRANCH ($(git rev-parse --short HEAD)) — rebuilding and restarting anyway."
else
	echo "Incoming:"
	git log --oneline "$OLD..$NEW" | sed 's/^/  /'
fi
git reset --hard "origin/$BRANCH" || die "git reset --hard origin/$BRANCH failed"

# ── Install and build (the old process keeps serving while this runs) ─────────
log "Installing dependencies"
pnpm install --frozen-lockfile || die "pnpm install failed"

log "Building"
pnpm build || die "build failed — the running app was not touched"

# Non-fatal on purpose: the app must deploy even when nodejs.org is unreachable,
# and it runs BEFORE migrations so a slow build never leaves the database
# migrated while the old app is still serving.
log "Building the print agent installers"
if ! pnpm build:print-agent; then
	echo "WARNING: the print agent installers were NOT rebuilt."
	echo "  The previous installers (if any) stay in dist/print-agent/current and keep"
	echo "  answering the ORIGIN they were built for. Fix the error above and run"
	echo "  'pnpm build:print-agent' in $APP_DIR."
fi

# ── Backup, then migrations (spec 29: the backup ALWAYS runs first) ───────────
if [ "${SKIP_MIGRATE:-}" = "1" ]; then
	log "Skipping backup+migrations (SKIP_MIGRATE=1)"
else
	log "Backup + migrations"
	pnpm db:migrate || die "migration failed — the pre-migration dump is in backups/ (newest file); the app was NOT restarted"
fi

# ── Restart and verify ────────────────────────────────────────────────────────

# PM2's restart counter, so a process dying on boot is caught as the crash LOOP it
# is. Without this the health check cannot tell "still warming up" from "exiting
# and being respawned every second", and waits out every attempt before saying so.
restart_count() {
	pm2 jlist 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
	try {
		const app = JSON.parse(raw).find((a) => a.name === process.argv[1]);
		console.log(app ? app.pm2_env.restart_time : "");
	} catch { console.log(""); }
});' "$PM2_APP"
}

RESTARTS_BEFORE="$(restart_count)"

log "Restarting PM2 app '$PM2_APP'"
pm2 restart "$PM2_APP" --update-env || die "pm2 restart failed"

log "Health check: $HEALTH_URL"
ok=""
crashing=""
for i in $(seq 1 "$HEALTH_TRIES"); do
	code="$(curl -gsS --max-time 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
	if [ "$code" = "200" ]; then ok=1; break; fi

	# The restart we just asked for counts as one; several more mean it is dying on
	# boot, and waiting longer cannot help.
	now="$(restart_count)"
	if [ -n "$now" ] && [ -n "$RESTARTS_BEFORE" ] && [ "$((now - RESTARTS_BEFORE))" -ge 4 ]; then
		crashing=1; break
	fi

	printf 'waiting (%s/%s) — last status: %s\n' "$i" "$HEALTH_TRIES" "${code:-none}"
	sleep 2
done

if [ -z "$ok" ]; then
	echo
	if [ -n "$crashing" ]; then
		echo "The app is CRASH-LOOPING: PM2 has respawned it repeatedly since the restart."
		echo "The reason is the last error below — fix that, not the deploy."
		echo
	fi
	pm2 logs "$PM2_APP" --lines 25 --nostream || true
	die "no 200 from $HEALTH_URL.
  Previous commit: $OLD
  To roll the code back:
    git reset --hard $OLD && pnpm install --frozen-lockfile && pnpm build && pm2 restart $PM2_APP
  A failure on startup (bad .env, missing variable) is NOT fixed by rolling back:
  the previous commit reads the same .env and will die the same way.
  If a migration ran, restore the newest dump in backups/ with pg_restore first."
fi

pm2 save >/dev/null 2>&1 || true
log "Deployed $(git rev-parse --short HEAD) — $HEALTH_URL answers 200"
