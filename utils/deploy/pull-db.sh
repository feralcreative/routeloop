#!/usr/bin/env bash
################################################################################
# routeloop – pull a remote database down onto the local dev stack.
#
#   ./utils/deploy/pull-db.sh              # prod → dev, database + storage
#   ./utils/deploy/pull-db.sh --from stage # stage → dev
#   ./utils/deploy/pull-db.sh --no-storage # database only, skip the KML/GPX
#   ./utils/deploy/pull-db.sh --no-migrate # leave the schema where the dump put it
#
# This is a wrapper around `deploy-utils.sh db-clone <src> dev`, which does the
# actual work and is the only thing here that touches a database. What the
# wrapper adds is the two steps that were easy to forget on either side of it:
#
#   BEFORE—the local Postgres container has to be running, or db-clone exits
#   on "Destination 'dev' database container is not running" after you have
#   already waited out a production dump.
#
#   AFTER—prod and stage are BEHIND local on migrations, so the dump restores
#   an older schema over a newer one and every `npm run db:migrate` that had
#   already run locally is undone. Reapplying them is not optional; the app will
#   500 on save without the newest three. Skip it with --no-migrate only if you
#   are deliberately inspecting the remote schema as it actually is.
#
# Everything destructive still belongs to db-clone: it dumps the LOCAL database
# to ./dev-db-before-clone-<ts>.sql.gz before dropping anything, makes you type
# "dev" to confirm, and prints the db-restore line that undoes it. The remote is
# only ever read—pg_dump, no writes—and this script has no path that names
# prod or stage as a destination.
#
# NOTE: docs/deployment.md records that db-clone's dump-and-load path has never
# been exercised end to end. Watch it run rather than walking away from it.
################################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

SRC="prod"
MIGRATE=1
CLONE_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --from)       SRC="${2:-}"; shift 2 ;;
    --from=*)     SRC="${1#*=}"; shift ;;
    --no-storage) CLONE_ARGS+=("--no-storage"); shift ;;
    --no-migrate) MIGRATE=0; shift ;;
    -h|--help)    sed -n '3,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            log_error "Unknown option: $1"; log_error "Try --help."; exit 1 ;;
  esac
done

# dev is the destination, always. Naming it as a source would mean pushing a
# laptop's database at the NAS, which is what db-clone is for and not this.
case "$SRC" in
  prod|stage) ;;
  dev) log_error "--from dev would clone the local database onto itself."; exit 1 ;;
  *)   log_error "--from takes prod or stage (got '${SRC}')."; exit 1 ;;
esac

cd "$PROJECT_ROOT"

log_info "Bringing the local Postgres container up..."
docker compose up -d --wait db

# Guarded rather than "${CLONE_ARGS[@]:-}": under `set -u` that form expands an
# empty array to one empty-string argument instead of to nothing, and
# deploy-utils.sh collects unrecognized arguments rather than rejecting them.
if [ "${#CLONE_ARGS[@]}" -gt 0 ]; then
  "$SCRIPT_DIR/deploy-utils.sh" db-clone "$SRC" dev "${CLONE_ARGS[@]}"
else
  "$SCRIPT_DIR/deploy-utils.sh" db-clone "$SRC" dev
fi

if [ "$MIGRATE" -eq 1 ]; then
  echo ""
  log_info "Reapplying local migrations over the ${SRC} schema..."
  npm run db:migrate
  log_success "Local database is ${SRC}'s data on the current schema."
else
  log_warning "Skipped migrations (--no-migrate). The local schema is ${SRC}'s, which is older."
  log_warning "Run 'npm run db:migrate' before 'npm run dev' or saves will 500."
fi
