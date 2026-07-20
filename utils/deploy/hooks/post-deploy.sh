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

SSH="ssh -p ${NAS_SSH_PORT}"
[ -n "${SSH_KEY_PATH:-}" ] && [ -f "${SSH_KEY_PATH}" ] && SSH="$SSH -i $SSH_KEY_PATH"

log_info "Applying Drizzle schema in ${CONTAINER_NAME}..."

# --force skips drizzle-kit's interactive confirmation, which cannot be answered
# over a non-TTY SSH session. Non-fatal: the deploy has already succeeded, and a
# schema that is already current is the common case.
if $SSH "${NAS_USER}@${NAS_HOST}" \
     "/usr/local/bin/docker exec ${CONTAINER_NAME} npx drizzle-kit push --force"; then
  log_success "Schema applied"
else
  log_warning "Schema push failed — the app is running but the database may be out of date."
  log_warning "Investigate with: DEPLOY_ENV=${DEPLOY_ENV} ./utils/deploy/deploy-utils.sh migrate"
fi
