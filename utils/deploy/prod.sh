#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# RouteLoop — Production deploy to Synology NAS (Docker)
# Usage: ./utils/deploy/prod.sh [--dry-run] [--force]
# ============================================================================

# Configuration
NAS_USER="ziad"
NAS_HOST="nas.feralcreative.co"
NAS_SSH_PORT="33725"
NAS_DEPLOY_PATH="/volume1/web/routeloop.app"
CONTAINER_NAME="routeloop"
IMAGE_NAME="routeloop:latest"
HOST_PORT="16703"
TARGET_URL="https://routeloop.app"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

format_time() {
  local s=$1
  if [ "$s" -lt 60 ]; then echo "${s}s"; else echo "$((s/60))m $((s%60))s"; fi
}

require_cmd() {
  local cmd=$1 hint=${2:-}
  command -v "$cmd" >/dev/null 2>&1 || { log_error "Required command '$cmd' not found. $hint"; exit 1; }
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

DEPLOY_START=$(date +%s)

# Parse flags
DRY_RUN=""; FORCE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --force|-f)   FORCE=1 ;;
    --help|-h)    echo "Usage: $(basename "$0") [--dry-run] [--force]"; exit 0 ;;
    *) log_error "Unknown flag: $arg"; exit 1 ;;
  esac
done

DEPLOY_ENV="prod"

require_cmd docker "Install Docker Desktop."
require_cmd ssh    "OpenSSH client is required."
require_cmd git    "Git is required."

# Load .env (provides GOOGLE_MAPS_API_KEY, Cloudflare creds, optional SSH_KEY_PATH)
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a; source "$PROJECT_ROOT/.env"; set +a
fi

if [ ! -f "$PROJECT_ROOT/.env" ]; then
  log_error ".env not found — the container needs GOOGLE_MAPS_API_KEY at runtime."; exit 1
fi

# SSH key detection (explicit -> ed25519 -> rsa -> agent)
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

# Production safety gates
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ -z "${FORCE:-}" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    log_error "Working tree is dirty. Commit/stash, or pass --force."; exit 1
  fi
  if [ "$GIT_BRANCH" != "main" ]; then
    log_error "Not on 'main' (current: $GIT_BRANCH). Switch or pass --force."; exit 1
  fi
fi

if [ -z "${DRY_RUN:-}" ]; then
  echo ""
  echo -e "${RED}${BOLD}⚠  You are about to deploy to PRODUCTION${NC}"
  echo -e "   URL    : ${BOLD}${TARGET_URL}${NC}"
  echo -e "   Commit : ${BOLD}${GIT_SHA}${NC} on ${BOLD}${GIT_BRANCH}${NC}"
  [ -n "${FORCE:-}" ] && echo -e "   Mode   : ${YELLOW}--force (gates bypassed)${NC}"
  read -r -p "Type 'yes' to continue: " CONFIRM
  [ "$CONFIRM" = "yes" ] || { log_error "Aborted."; exit 1; }
fi

SSH_CMD=$(get_ssh_cmd)
SSH_TARGET="${NAS_USER}@${NAS_HOST}"

if [ -n "${DRY_RUN:-}" ]; then
  log_warning "DRY RUN — no build, transfer, or remote changes will occur."
  log_info "Would build ${IMAGE_NAME} (linux/amd64) and deploy to ${SSH_TARGET}:${NAS_DEPLOY_PATH}"
  log_info "Would publish container ${CONTAINER_NAME} on host port ${HOST_PORT} -> 6686"
  exit 0
fi

# Build
log_info "Building Docker image (linux/amd64)..."
BUILD_START=$(date +%s)
docker build --platform linux/amd64 -t "${IMAGE_NAME}" .
BUILD_TIME=$(($(date +%s) - BUILD_START))
log_success "Image built in $(format_time $BUILD_TIME)"

# Save and transfer image
TEMP_FILE="/tmp/${CONTAINER_NAME}-$(date +%s).tar.gz"
log_info "Saving image..."
docker save "${IMAGE_NAME}" | gzip > "${TEMP_FILE}"
TAR_SIZE=$(du -h "${TEMP_FILE}" | awk '{print $1}')

log_info "Ensuring deploy path on NAS..."
$SSH_CMD "$SSH_TARGET" "mkdir -p ${NAS_DEPLOY_PATH}/logs"

log_info "Transferring image (${TAR_SIZE})..."
TRANSFER_START=$(date +%s)
cat "${TEMP_FILE}" | $SSH_CMD "$SSH_TARGET" "cat > ${NAS_DEPLOY_PATH}/${CONTAINER_NAME}.tar.gz"
TRANSFER_TIME=$(($(date +%s) - TRANSFER_START))
rm -f "${TEMP_FILE}"
log_success "Image transferred in $(format_time $TRANSFER_TIME)"

log_info "Loading image on NAS..."
$SSH_CMD "$SSH_TARGET" "/usr/local/bin/docker load < ${NAS_DEPLOY_PATH}/${CONTAINER_NAME}.tar.gz && rm ${NAS_DEPLOY_PATH}/${CONTAINER_NAME}.tar.gz"

# Transfer docker-compose.yml
log_info "Transferring docker-compose.yml..."
cat "$PROJECT_ROOT/docker-compose.yml" | $SSH_CMD "$SSH_TARGET" "cat > ${NAS_DEPLOY_PATH}/docker-compose.yml"

# Transfer .env (container reads GOOGLE_MAPS_API_KEY via env_file)
log_info "Transferring .env..."
cat "$PROJECT_ROOT/.env" | $SSH_CMD "$SSH_TARGET" "cat > ${NAS_DEPLOY_PATH}/.env && chmod 600 ${NAS_DEPLOY_PATH}/.env"

# Deploy
log_info "Deploying container..."
$SSH_CMD "$SSH_TARGET" << EOF
cd ${NAS_DEPLOY_PATH}
/usr/local/bin/docker-compose down || true
/usr/local/bin/docker-compose up -d
EOF

# Verify
log_info "Verifying..."
sleep 3
if $SSH_CMD "$SSH_TARGET" "/usr/local/bin/docker ps | grep -q ${CONTAINER_NAME}"; then
  log_success "Container is running"
else
  log_error "Container failed to start"
  $SSH_CMD "$SSH_TARGET" "/usr/local/bin/docker logs ${CONTAINER_NAME}" || true
  exit 1
fi

# Cloudflare cache purge (non-fatal)
purge_cloudflare_cache() {
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ZONE_ID:-}" ]; then
    log_warning "Cloudflare credentials not set — skipping purge"
    return 0
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
IMAGE_SIZE=$(docker images "${IMAGE_NAME}" --format "{{.Size}}")
CONTAINER_INFO=$($SSH_CMD "$SSH_TARGET" "/usr/local/bin/docker inspect ${CONTAINER_NAME} --format '{{.State.Status}}|{{.RestartCount}}'" 2>/dev/null || echo "unknown|0")
CONTAINER_STATUS=$(echo "$CONTAINER_INFO" | cut -d'|' -f1)
RESTART_COUNT=$(echo "$CONTAINER_INFO" | cut -d'|' -f2)

# Summary
echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}                   ${GREEN}DEPLOYMENT SUMMARY${NC}                          ${CYAN}║${NC}"
echo -e "${CYAN}╠════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}   Target        : ${BOLD}${TARGET_URL}${NC}"
echo -e "${CYAN}║${NC}   Host port     : ${BOLD}${HOST_PORT}${NC} -> 6686"
echo -e "${CYAN}║${NC}   Git           : ${BOLD}${GIT_SHA}${NC} (${GIT_BRANCH})"
echo -e "${CYAN}║${NC}   Image size    : ${YELLOW}${IMAGE_SIZE}${NC}"
echo -e "${CYAN}║${NC}   Tar size      : ${YELLOW}${TAR_SIZE}${NC}"
echo -e "${CYAN}║${NC}   Container     : ${GREEN}${CONTAINER_STATUS}${NC} (restarts: ${RESTART_COUNT})"
echo -e "${CYAN}║${NC}   Build time    : ${BLUE}$(format_time $BUILD_TIME)${NC}"
echo -e "${CYAN}║${NC}   Transfer time : ${BLUE}$(format_time $TRANSFER_TIME)${NC}"
echo -e "${CYAN}║${NC}   Total time    : ${GREEN}$(format_time $TOTAL_TIME)${NC}"
echo -e "${CYAN}║${NC}   Timestamp     : $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"

echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo "  View logs:    ./utils/deploy/deploy-utils.sh logs"
echo "  Status:       ./utils/deploy/deploy-utils.sh status"
echo "  Restart:      ./utils/deploy/deploy-utils.sh restart"
echo ""
