#!/usr/bin/env bash
################################################################################
# Post-deploy hook — apply the Drizzle schema inside the freshly started
# container.
#
# There is no drizzle/ migrations directory in this project, so the schema is
# applied with `drizzle-kit push` (declarative sync from src/db/schema.ts)
# rather than `drizzle-kit migrate`. If generated migrations are adopted later,
# switch the command below to `npx drizzle-kit migrate`.
#
# Runs locally (invoked by deploy.sh) and reaches the NAS over SSH.
################################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export DEPLOY_ENV="${DEPLOY_ENV:-prod}"
source "$PROJECT_ROOT/deploy.config"

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
RED='\033[0;31m'
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

SSH="ssh -p ${NAS_SSH_PORT}"
[ -n "${SSH_KEY_PATH:-}" ] && [ -f "${SSH_KEY_PATH}" ] && SSH="$SSH -i $SSH_KEY_PATH"

log_info "Applying Drizzle schema in ${CONTAINER_NAME}..."

# No --force, and fatal on failure. Both of those changed on 2026-08-03 after
# prod was found running three sprints behind its schema.
#
# --force is gone because it does not mean "run unattended" — it means "answer
# yes to every prompt", and drizzle-kit's prompts include "do you want to
# truncate users table?" when adding a unique constraint to a populated column.
# It was one drizzle-kit version away from emptying the users table on prod.
#
# Fatal because non-fatal is how the drift happened: a failed push printed a
# yellow warning, the deploy reported SUCCESS, and nobody looked again for three
# sprints. The app was then serving 500s on every page that touched a table with
# a missing column. A deploy whose schema step failed has not succeeded.
if $SSH "${NAS_USER}@${NAS_HOST}" \
     "/usr/local/bin/docker exec ${CONTAINER_NAME} npx drizzle-kit push"; then
  log_success "Schema applied"
else
  log_error "Schema push FAILED. The app is running against a database that does not match it."
  log_error ""
  log_error "The usual cause is a prompt drizzle-kit cannot ask over SSH — most often"
  log_error "a unique constraint on a populated column, where it wants to know whether"
  log_error "to truncate. Do NOT re-run with --force to get past that: --force answers"
  log_error "yes, and yes means the table is emptied."
  log_error ""
  log_error "See what it wants:"
  log_error "  ssh -p ${NAS_SSH_PORT} ${NAS_USER}@${NAS_HOST} \\"
  log_error "    'docker exec -it ${CONTAINER_NAME} npx drizzle-kit push'"
  log_error ""
  log_error "Then write the additive DDL by hand, as in"
  log_error "  utils/deploy/sql/2026-08-03-catch-up-prod-schema.sql"
  exit 1
fi
