#!/usr/bin/env bash
#
# Rebuild the local dev dataset: the imported sample ride, then a set of
# generated native rides.
#
# Why this exists rather than running the two seeders by hand:
#
#   src/db/seed.ts opens with
#     TRUNCATE rides, user_identities, users RESTART IDENTITY CASCADE
#   and — unlike utils/seed-demo-rides.ts — carries no check that the database
#   is local. Run it by hand after pulling prod down and it silently destroys
#   every account you just cloned. This script guards the connection string
#   first, then carries your accounts across the truncate and puts them back.
#
# Order matters. seed-demo-rides.ts assigns its rides to an owner looked up by
# email, so the accounts have to be restored before it runs or everything lands
# on the demo user and is invisible from the account you actually sign in with.
#
# Usage:
#   utils/seed-dev.sh                     # sample ride + 12 generated rides
#   utils/seed-dev.sh --count=4           # fewer generated rides
#   utils/seed-dev.sh --straight          # no Routes API calls (straight lines)
#   utils/seed-dev.sh --rides-only        # skip the truncating seed entirely
#   utils/seed-dev.sh --yes               # skip the confirmation
#
# --count, --straight and --owner are passed through to seed-demo-rides.ts.

set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; YEL=$'\033[0;33m'; GRN=$'\033[0;32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
info() { printf '%s==>%s %s\n' "$DIM" "$OFF" "$*"; }
warn() { printf '%s !%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '%sERROR%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
ok()   { printf '%s ✓%s %s\n' "$GRN" "$OFF" "$*"; }

ASSUME_YES=""
RIDES_ONLY=""
PASSTHRU=()
for arg in "$@"; do
  case "$arg" in
    --yes|-y)     ASSUME_YES=1 ;;
    --rides-only) RIDES_ONLY=1 ;;
    --count=*|--straight|--owner=*) PASSTHRU+=("$arg") ;;
    -h|--help)    sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "Unknown option: $arg  (try --help)" ;;
  esac
done

# --- Guard ------------------------------------------------------------------
# The same check seed-demo-rides.ts makes, applied here because src/db/seed.ts
# does not make it. Tested against the connection string rather than NODE_ENV,
# which nothing in this project sets.
[ -f .env ] || die "No .env in $(pwd)"
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
[ -n "$DB_URL" ] || die "DATABASE_URL is not set in .env"
if ! printf '%s' "$DB_URL" | grep -qE '@(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]'; then
  die "DATABASE_URL is not local — refusing to seed.
       $(printf '%s' "$DB_URL" | sed 's|://[^@]*@|://***@|')"
fi

# </dev/null on every one of these: `docker compose exec` forwards stdin to the
# container even with -T, so without it the queries below eat the confirmation
# keystrokes — or, when stdin is a pipe, consume it entirely and leave `read`
# at EOF, which under `set -e` kills the script with no message at all.
psql_q() { docker compose exec -T db psql -U tankbag -d tankbag -tAc "$1" </dev/null; }
docker compose ps --status running --format '{{.Service}}' </dev/null | grep -qx db \
  || die "The dev database container is not running. Try: docker compose up -d --wait db"

# --- What is about to go ----------------------------------------------------
RIDE_COUNT="$(psql_q 'SELECT count(*) FROM rides' | tr -d '[:space:]')"
USER_ROWS="$(psql_q "SELECT email || '  ' || status || '  manager=' || can_manage_riders FROM users ORDER BY id")"
USER_COUNT="$(printf '%s\n' "$USER_ROWS" | grep -c . || true)"

if [ -z "$RIDES_ONLY" ]; then
  echo
  warn "src/db/seed.ts will TRUNCATE rides, user_identities and users."
  warn "${RIDE_COUNT} ride(s) will be destroyed and are NOT restored by this script."
  warn "Anything you want to keep should be in prod, not only here."
  echo
  info "These ${USER_COUNT} account(s) WILL be carried across and restored:"
  printf '%s\n' "$USER_ROWS" | sed 's/^/      /'
  echo
  warn "OAuth identity rows are not restored — they are not needed. resolveUser()"
  warn "falls back to matching on email, so signing in re-links each account."
  echo
  if [ -z "$ASSUME_YES" ]; then
    printf 'Type %s to continue: ' "seed"
    # An explicit EOF branch: under `set -e` a failed read would otherwise abort
    # the script with no output, which reads exactly like a crash.
    if ! read -r reply; then
      echo
      die "No input to read for the confirmation. Re-run with --yes if that is what you meant."
    fi
    echo # read swallows the newline, so without this the next line runs into the prompt
    [ "$reply" = "seed" ] || die "Aborted."
  fi

  # Captured as INSERTs so the restore does not depend on this shell holding the
  # rows in a variable across a truncate. id is deliberately omitted: seed.ts
  # RESTARTs IDENTITY and takes id 1 for its demo user, so the original ids
  # would collide. Nothing references these rows by id after the truncate.
  SNAPSHOT="$(mktemp -t tankbag-users)"
  psql_q "SELECT format(
            'INSERT INTO users (email, display_name, username, avatar_url, status, can_manage_riders) VALUES (%L, %L, %L, %L, %L, %L) ON CONFLICT (email) DO UPDATE SET status = EXCLUDED.status, can_manage_riders = EXCLUDED.can_manage_riders;',
            email, display_name, username, avatar_url, status, can_manage_riders)
          FROM users ORDER BY id" > "$SNAPSHOT"
  ok "Captured $(grep -c . "$SNAPSHOT") account(s) → $SNAPSHOT"

  info "Seeding the imported sample ride (src/db/seed.ts)..."
  npx tsx src/db/seed.ts

  info "Restoring accounts..."
  docker compose exec -T db psql -U tankbag -d tankbag -v ON_ERROR_STOP=1 -q < "$SNAPSHOT"
  rm -f "$SNAPSHOT"
  ok "Accounts restored"
else
  info "--rides-only: leaving existing rides and accounts alone"
fi

# --- Generated rides --------------------------------------------------------
# Real routing costs Routes API quota, one call per leg. --straight skips it.
if ! printf '%s ' "${PASSTHRU[@]:-}" | grep -q -- '--straight'; then
  if ! grep -qE '^GMAPS_SERVER_KEY=.+' .env; then
    warn "No GMAPS_SERVER_KEY — seed-demo-rides.ts will fall back to straight lines."
  else
    warn "This calls the Routes API once per leg and bills against your quota."
    warn "Use --straight if you only need shapes on the map."
  fi
fi

info "Generating native rides (utils/seed-demo-rides.ts)..."
npx tsx utils/seed-demo-rides.ts --reset "${PASSTHRU[@]:-}"

# --- Summary ----------------------------------------------------------------
echo
ok "Done. The database now holds:"
psql_q "SELECT '  rides: ' || count(*) FROM rides"
psql_q "SELECT '  days: ' || count(*) FROM days"
psql_q "SELECT '  legs: ' || count(*) FROM route_legs"
psql_q "SELECT '  users: ' || count(*) FROM users"
echo
info "Sign in at http://localhost:6686 with any restored account."
