#!/usr/bin/env bash
################################################################################
# Post-deploy hook — apply pending Drizzle migrations inside the freshly
# started container.
#
# Migrations are generated files under drizzle/, committed to the repo, and
# applied with `drizzle-kit migrate`. This replaced `drizzle-kit push` on
# 2026-08-10: push is declarative and leaves no trace in git, so a schema change
# made on one machine reached neither the other dev machine nor a reviewer's
# diff — it was rediscovered as a 500 (`column users.survey_invited_at does not
# exist`) on whichever machine had not run it.
#
# migrate() also cannot prompt. That is the point: push's prompts are what made
# this step unrunnable over SSH, and what made --force tempting.
#
# A database created before drizzle/ existed must be baselined ONCE before this
# will work — see docs/database.md. Without it, migrate tries to create tables
# that already exist and fails on the first statement.
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

log_info "Applying Drizzle migrations in ${CONTAINER_NAME}..."

# Fatal on failure. That changed on 2026-08-03 after prod was found running
# three sprints behind its schema: a failed push printed a yellow warning, the
# deploy reported SUCCESS, and nobody looked again. The app was then serving
# 500s on every page that touched a table with a missing column. A deploy whose
# schema step failed has not succeeded.
#
# Applying migrations is idempotent — migrate() records each one in
# drizzle.__drizzle_migrations and skips what is already there — so a re-run
# after a fixed failure is safe.
if $SSH "${NAS_USER}@${NAS_HOST}" \
     "/usr/local/bin/docker exec ${CONTAINER_NAME} npx drizzle-kit migrate"; then
  log_success "Migrations applied"
else
  log_error "Migration FAILED. The app is running against a database that does not match it."
  log_error ""
  log_error "Two likely causes:"
  log_error ""
  log_error "  1. This database predates drizzle/ and was never baselined, so migrate is"
  log_error "     trying to create tables that already exist. Baseline it ONCE:"
  log_error "       ssh -p ${NAS_SSH_PORT} ${NAS_USER}@${NAS_HOST} \\"
  log_error "         'docker exec ${CONTAINER_NAME} npx tsx utils/db-baseline.ts'"
  log_error "     Confirm the schema really does match src/db/schema.ts first —"
  log_error "     a baseline records a claim it cannot verify. See docs/database.md."
  log_error ""
  log_error "  2. A migration genuinely failed against production data — a NOT NULL on a"
  log_error "     column holding nulls, or a unique constraint on duplicates. Fix it by"
  log_error "     editing the generated SQL to backfill first, not by forcing it through."
  log_error ""
  log_error "See the error in full:"
  log_error "  ssh -p ${NAS_SSH_PORT} ${NAS_USER}@${NAS_HOST} \\"
  log_error "    'docker exec ${CONTAINER_NAME} npx drizzle-kit migrate'"
  exit 1
fi
