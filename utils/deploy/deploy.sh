#!/usr/bin/env bash
################################################################################
# routeloop — shared deploy logic (Docker-on-NAS, templated archetype).
#
# Don't run directly — use prod.sh or stage.sh, which set DEPLOY_ENV.
#
# Ships two containers to /volume1/web/<domain> on the Synology NAS: the Hono
# app and its Postgres. Cloudflare Tunnel already routes the public hostname to
# 127.0.0.1:<HOST_PORT> on the NAS host, so nothing here touches tunnel config.
################################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

[ -f "$PROJECT_ROOT/deploy.config" ] || { echo "ERROR: deploy.config not found in project root" >&2; exit 1; }
source "$PROJECT_ROOT/deploy.config"

NAS_SSH_HOST="${NAS_USER}@${NAS_HOST}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

format_time() { local s=$1; if [ "$s" -lt 60 ]; then echo "${s}s"; else echo "$((s/60))m $((s%60))s"; fi; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { log_error "Required command '$1' not found. ${2:-}"; exit 1; }; }

cd "$PROJECT_ROOT"
DEPLOY_START=$(date +%s)
BUILD_TIME=0
TRANSFER_TIME=0

# ---------------------------------------------------------------- flags ------
DRY_RUN=""; FORCE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --force|-f)   FORCE=1 ;;
    --help|-h)    echo "Usage: $(basename "$0") [--dry-run] [--force]"; exit 0 ;;
    *) log_error "Unknown flag: $arg"; exit 1 ;;
  esac
done

[ -n "${DEPLOY_ENV:-}" ] || { log_error "DEPLOY_ENV not set — run prod.sh or stage.sh"; exit 1; }
[ "$DEPLOY_ENV" = "prod" ] || [ "$DEPLOY_ENV" = "stage" ] || { log_error "Invalid DEPLOY_ENV: $DEPLOY_ENV"; exit 1; }

require_cmd docker "Install Docker Desktop."
require_cmd ssh
require_cmd git
require_cmd curl

# ------------------------------------------------------------------ env ------
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a; source "$PROJECT_ROOT/.env"; set +a
fi

# Pick the env-specific DB password out of .env (deploy.config stays secret-free).
if [ "$DEPLOY_ENV" = "prod" ]; then
  DB_PASSWORD="${PROD_DB_PASSWORD:-}"
else
  DB_PASSWORD="${STAGE_DB_PASSWORD:-}"
fi

MISSING=""
[ -n "${GMAPS_KEY:-}" ]  || MISSING="${MISSING} GMAPS_KEY"
[ -n "${MAPBOX_TOKEN:-}" ] || MISSING="${MISSING} MAPBOX_TOKEN"
[ -n "${DB_PASSWORD}" ]  || MISSING="${MISSING} $([ "$DEPLOY_ENV" = "prod" ] && echo PROD_DB_PASSWORD || echo STAGE_DB_PASSWORD)"
if [ -n "$MISSING" ]; then
  log_error "Missing required value(s) in .env:${MISSING}"
  log_error "See .env.example. Aborting rather than deploying a broken container."
  exit 1
fi

# The password is interpolated into a postgresql:// URL; reserved characters
# would silently corrupt it, so reject them up front.
case "$DB_PASSWORD" in
  *[!A-Za-z0-9_-]*)
    log_error "DB password contains characters unsafe for a connection URL."
    log_error "Use only letters, digits, underscore, hyphen."
    exit 1 ;;
esac

# ------------------------------------------------------------- auth env ------
# APP_ORIGIN is always this environment's own public origin. It decides the
# Secure flag on session cookies, so the dev value must not leak into a deploy.
APP_ORIGIN="https://${DOMAIN}"

[ -f "$PROJECT_ROOT/$COMPOSE_SRC" ] || { log_error "Compose file not found: $COMPOSE_SRC"; exit 1; }

# -------------------------------------------------------------- ssh key ------
check_ssh_key() {
  if [ -n "${SSH_KEY_PATH:-}" ] && [ -f "$SSH_KEY_PATH" ]; then return; fi
  if [ -f "$HOME/.ssh/id_ed25519" ]; then SSH_KEY_PATH="$HOME/.ssh/id_ed25519"; return; fi
  if [ -f "$HOME/.ssh/id_rsa" ];      then SSH_KEY_PATH="$HOME/.ssh/id_rsa";      return; fi
  if ssh-add -l > /dev/null 2>&1;     then USE_SSH_AGENT=1;                       return; fi
  log_error "No SSH key found."; exit 1
}
get_ssh_cmd() {
  local cmd="ssh -p ${NAS_SSH_PORT}"
  [ -z "${USE_SSH_AGENT:-}" ] && [ -n "${SSH_KEY_PATH:-}" ] && cmd="$cmd -i $SSH_KEY_PATH"
  echo "$cmd"
}
check_ssh_key
SSH_CMD=$(get_ssh_cmd)

# ----------------------------------------------------------- env labels ------
if [ "$DEPLOY_ENV" = "prod" ]; then
  TARGET_URL="https://${DOMAIN}"; ENV_LABEL="PRODUCTION"; ENV_COLOR="$RED"
else
  TARGET_URL="https://${STAGE_DOMAIN}"; ENV_LABEL="STAGING"; ENV_COLOR="$YELLOW"
fi

# --------------------------------------------------------- safety gates ------
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ "$DEPLOY_ENV" = "prod" ] && [ -z "${FORCE:-}" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    log_error "Working tree is dirty. Commit/stash, or pass --force."; exit 1
  fi
  if [ "$GIT_BRANCH" != "main" ]; then
    log_error "Not on 'main' (current: $GIT_BRANCH). Switch or pass --force."; exit 1
  fi
fi

if [ "$DEPLOY_ENV" = "prod" ] && [ -z "${DRY_RUN:-}" ]; then
  echo ""
  echo -e "${RED}${BOLD}⚠  You are about to deploy to PRODUCTION${NC}"
  echo -e "   URL    : ${BOLD}${TARGET_URL}${NC}"
  echo -e "   Commit : ${BOLD}${GIT_SHA}${NC} on ${BOLD}${GIT_BRANCH}${NC}"
  read -r -p "Type 'yes' to continue: " CONFIRM
  [ "$CONFIRM" = "yes" ] || { log_error "Aborted."; exit 1; }
fi

echo ""
echo -e "${CYAN}═══ ${PROJECT_NAME} → ${ENV_COLOR}${ENV_LABEL}${NC}${CYAN} ═══${NC}"
echo -e "  ${MAGENTA}Target${NC}    : ${TARGET_URL}"
echo -e "  ${MAGENTA}NAS path${NC}  : ${NAS_DEPLOY_PATH}"
echo -e "  ${MAGENTA}Container${NC} : ${CONTAINER_NAME} (host 127.0.0.1:${HOST_PORT})"
[ -n "${DRY_RUN:-}" ] && echo -e "  ${YELLOW}DRY RUN — nothing will be built, transferred, or restarted${NC}"
echo ""

if [ -n "${DRY_RUN:-}" ]; then
  log_info "Would build ${IMAGE_NAME} (${DOCKER_PLATFORM}) from $PROJECT_ROOT"
  log_info "Would transfer the image + ${COMPOSE_SRC} to ${NAS_SSH_HOST}:${NAS_DEPLOY_PATH}"
  log_info "Would write ${NAS_DEPLOY_PATH}/.env (chmod 600) and restart the stack"
  log_info "Would apply the Drizzle schema via ${POST_DEPLOY_HOOK:-<no hook>}"
  log_success "Dry run complete — no changes made."
  exit 0
fi

# ------------------------------------------------------- pre-build hook ------
if [ -n "${PRE_BUILD_HOOK:-}" ] && [ -f "$PROJECT_ROOT/$PRE_BUILD_HOOK" ]; then
  log_info "Running pre-build hook: $PRE_BUILD_HOOK"
  bash "$PROJECT_ROOT/$PRE_BUILD_HOOK"
fi

# ---------------------------------------------------------------- build ------
log_info "Building Docker image (${DOCKER_PLATFORM})..."
BUILD_START=$(date +%s)
docker build --platform "${DOCKER_PLATFORM}" -t "${IMAGE_NAME}" .
BUILD_TIME=$(($(date +%s) - BUILD_START))
log_success "Image built in $(format_time $BUILD_TIME)"

# ----------------------------------------------------- save and transfer -----
TEMP_FILE="/tmp/${PROJECT_NAME}-$(date +%s).tar.gz"
cleanup() { rm -f "$TEMP_FILE"; }
trap cleanup EXIT

log_info "Saving image..."
docker save "${IMAGE_NAME}" | gzip > "${TEMP_FILE}"

log_info "Transferring image ($(du -h "$TEMP_FILE" | cut -f1))..."
TRANSFER_START=$(date +%s)
$SSH_CMD "$NAS_SSH_HOST" "mkdir -p ${NAS_DEPLOY_PATH}/data/storage ${NAS_DEPLOY_PATH}/logs"
# Piped cat, not scp — more reliable to the NAS.
cat "${TEMP_FILE}" | $SSH_CMD "$NAS_SSH_HOST" "cat > ${NAS_DEPLOY_PATH}/${PROJECT_NAME}.tar.gz"
TRANSFER_TIME=$(($(date +%s) - TRANSFER_START))
rm -f "${TEMP_FILE}"
log_success "Transferred in $(format_time $TRANSFER_TIME)"

log_info "Loading image on NAS..."
$SSH_CMD "$NAS_SSH_HOST" "/usr/local/bin/docker load < ${NAS_DEPLOY_PATH}/${PROJECT_NAME}.tar.gz && rm ${NAS_DEPLOY_PATH}/${PROJECT_NAME}.tar.gz"

# --------------------------------------------- compose file + remote env -----
log_info "Writing compose file and environment..."
cat "$PROJECT_ROOT/$COMPOSE_SRC" | $SSH_CMD "$NAS_SSH_HOST" "cat > ${NAS_DEPLOY_PATH}/docker-compose.yml"

# Supplies every ${VAR} in docker-compose.yml. Contains secrets → mode 600.
printf '%s\n' \
  "# Written by utils/deploy/deploy.sh — do not edit by hand." \
  "COMPOSE_PROJECT_NAME=${PROJECT_NAME}-${DEPLOY_ENV}" \
  "IMAGE_NAME=${IMAGE_NAME}" \
  "CONTAINER_NAME=${CONTAINER_NAME}" \
  "DB_CONTAINER_NAME=${DB_CONTAINER_NAME}" \
  "HOST_PORT=${HOST_PORT}" \
  "ALIAS_HOST_PORT=${ALIAS_HOST_PORT}" \
  "APP_UID=${APP_UID}" \
  "APP_GID=${APP_GID}" \
  "GMAPS_KEY=${GMAPS_KEY}" \
  "MAPBOX_TOKEN=${MAPBOX_TOKEN}" \
  "DB_PASSWORD=${DB_PASSWORD}" \
  "APP_ORIGIN=${APP_ORIGIN}" \
  | $SSH_CMD "$NAS_SSH_HOST" "cat > ${NAS_DEPLOY_PATH}/.env && chmod 600 ${NAS_DEPLOY_PATH}/.env"

# --------------------------------------------------------------- deploy ------
log_info "Restarting stack..."
$SSH_CMD "$NAS_SSH_HOST" << EOF
cd ${NAS_DEPLOY_PATH}
/usr/local/bin/docker-compose down || true
/usr/local/bin/docker-compose up -d
EOF

# --------------------------------------------------------------- verify ------
log_info "Verifying..."
sleep 5
if $SSH_CMD "$NAS_SSH_HOST" "/usr/local/bin/docker ps --format '{{.Names}}' | grep -qx ${CONTAINER_NAME}"; then
  log_success "Container ${CONTAINER_NAME} is running"
else
  log_error "Container failed to start"
  $SSH_CMD "$NAS_SSH_HOST" "/usr/local/bin/docker logs --tail 50 ${CONTAINER_NAME}" || true
  exit 1
fi

# Hit the port the tunnel actually targets, from the NAS host itself.
if $SSH_CMD "$NAS_SSH_HOST" "curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:${HOST_PORT}/"; then
  log_success "App responding on 127.0.0.1:${HOST_PORT} (tunnel origin)"
else
  log_warning "App not responding yet on 127.0.0.1:${HOST_PORT} — it may still be starting"
  $SSH_CMD "$NAS_SSH_HOST" "/usr/local/bin/docker logs --tail 30 ${CONTAINER_NAME}" || true
fi

# ------------------------------------------------------ post-deploy hook -----
if [ -n "${POST_DEPLOY_HOOK:-}" ] && [ -f "$PROJECT_ROOT/$POST_DEPLOY_HOOK" ]; then
  log_info "Running post-deploy hook: $POST_DEPLOY_HOOK"
  DEPLOY_ENV="$DEPLOY_ENV" bash "$PROJECT_ROOT/$POST_DEPLOY_HOOK"
fi

# ------------------------------------------------------ cloudflare purge -----
purge_cloudflare_cache() {
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ZONE_ID:-}" ]; then
    log_warning "Cloudflare credentials not set — skipping purge"; return 0
  fi
  local response
  response=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"purge_everything":true}')
  if echo "$response" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    log_success "Cloudflare cache purged"
  else
    log_warning "Cloudflare cache purge failed (non-fatal)"
  fi
}
purge_cloudflare_cache

TOTAL_TIME=$(($(date +%s) - DEPLOY_START))

# -------------------------------------------------------------- summary ------
echo ""
echo -e "${CYAN}═══ ${PROJECT_NAME} — ${ENV_COLOR}${ENV_LABEL}${NC}${CYAN} deploy complete ═══${NC}"
echo -e "  Target        : ${BOLD}${TARGET_URL}${NC}"
echo -e "  Git           : ${BOLD}${GIT_SHA}${NC} (${GIT_BRANCH})"
echo -e "  Container     : ${CONTAINER_NAME} → 127.0.0.1:${HOST_PORT}"
echo -e "  Build time    : $(format_time $BUILD_TIME)"
echo -e "  Transfer time : $(format_time $TRANSFER_TIME)"
echo -e "  Total time    : ${GREEN}$(format_time $TOTAL_TIME)${NC}"
echo -e "  Timestamp     : $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo "  Logs:    ./utils/deploy/deploy-utils.sh logs"
echo "  Status:  ./utils/deploy/deploy-utils.sh status"
echo "  Restart: ./utils/deploy/deploy-utils.sh restart"
echo ""
