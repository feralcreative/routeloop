#!/usr/bin/env bash
################################################################################
# routeloop — post-deploy management for the NAS stack.
#
# Defaults to production. For staging, prefix with DEPLOY_ENV=stage:
#   DEPLOY_ENV=stage ./utils/deploy/deploy-utils.sh logs
################################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

export DEPLOY_ENV="${DEPLOY_ENV:-prod}"
[ -f "$PROJECT_ROOT/deploy.config" ] || { echo "ERROR: deploy.config not found" >&2; exit 1; }
source "$PROJECT_ROOT/deploy.config"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

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
get_scp_cmd() {
  local cmd="scp -P ${NAS_SSH_PORT}"
  [ -z "${USE_SSH_AGENT:-}" ] && [ -n "${SSH_KEY_PATH:-}" ] && cmd="$cmd -i $SSH_KEY_PATH"
  echo "$cmd"
}

NAS_SSH_HOST="${NAS_USER}@${NAS_HOST}"

cmd_logs() {
  check_ssh_key
  $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker logs -f ${CONTAINER_NAME}"
}
cmd_db_logs() {
  check_ssh_key
  $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker logs -f ${DB_CONTAINER_NAME}"
}
cmd_status() {
  check_ssh_key
  $(get_ssh_cmd) "$NAS_SSH_HOST" \
    "/usr/local/bin/docker ps --filter name=${CONTAINER_NAME} --filter name=${DB_CONTAINER_NAME} \
     --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || echo 'Not running'"
  echo ""
  log_info "Origin check (from the NAS host, the port the tunnel targets):"
  $(get_ssh_cmd) "$NAS_SSH_HOST" \
    "curl -fsS -o /dev/null -w 'HTTP %{http_code} in %{time_total}s\n' --max-time 10 http://127.0.0.1:${HOST_PORT}/ \
     || echo 'no response'"
}
cmd_restart() {
  check_ssh_key
  $(get_ssh_cmd) "$NAS_SSH_HOST" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose restart"
  log_success "Stack restarted"
}
cmd_stop() {
  check_ssh_key
  $(get_ssh_cmd) "$NAS_SSH_HOST" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose down"
  log_success "Stack stopped"
}
cmd_start() {
  check_ssh_key
  $(get_ssh_cmd) "$NAS_SSH_HOST" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose up -d"
  log_success "Stack started"
}
cmd_shell() {
  check_ssh_key
  $(get_ssh_cmd) -t "$NAS_SSH_HOST" "/usr/local/bin/docker exec -it ${CONTAINER_NAME} /bin/sh"
}
cmd_psql() {
  check_ssh_key
  $(get_ssh_cmd) -t "$NAS_SSH_HOST" \
    "/usr/local/bin/docker exec -it ${DB_CONTAINER_NAME} psql -U routeloop -d routeloop"
}
cmd_migrate() {
  check_ssh_key
  log_info "Applying Drizzle schema in ${CONTAINER_NAME}..."
  $(get_ssh_cmd) "$NAS_SSH_HOST" \
    "/usr/local/bin/docker exec ${CONTAINER_NAME} npx drizzle-kit push --force"
  log_success "Schema applied"
}
# Postgres dump — the real backup. Map files are backed up separately.
cmd_db_backup() {
  check_ssh_key
  local f="${CONTAINER_NAME}-db-$(date +%Y%m%d-%H%M%S).sql.gz"
  log_info "Dumping database to $f"
  $(get_ssh_cmd) "$NAS_SSH_HOST" \
    "/usr/local/bin/docker exec ${DB_CONTAINER_NAME} pg_dump -U routeloop -d routeloop | gzip" > "./$f"
  log_success "Database backup saved to ./$f"
}
# User-uploaded KML/GPX from the mounted storage volume.
cmd_backup() {
  check_ssh_key
  local f="${CONTAINER_NAME}-storage-$(date +%Y%m%d-%H%M%S).tar.gz"
  log_info "Archiving user files to $f"
  $(get_ssh_cmd) "$NAS_SSH_HOST" "tar -czf - -C ${NAS_DEPLOY_PATH}/data storage" > "./$f"
  log_success "Storage backup saved to ./$f"
}
cmd_help() {
  cat <<EOF
Deployment utilities for ${PROJECT_NAME} (${DEPLOY_ENV} → ${DOMAIN})

Usage: $0 <command>
       DEPLOY_ENV=stage $0 <command>

Commands:
  logs         Follow app container logs
  db-logs      Follow Postgres logs
  status       Container status + origin HTTP check on 127.0.0.1:${HOST_PORT}
  restart      Restart the stack
  stop         Stop the stack
  start        Start the stack
  shell        Shell into the app container
  psql         Open psql against the app database
  migrate      Re-apply the Drizzle schema (drizzle-kit push)
  db-backup    Dump Postgres to ./<container>-db-<ts>.sql.gz
  backup       Archive user KML/GPX to ./<container>-storage-<ts>.tar.gz
  help         Show this help

Environment:
  DEPLOY_ENV   prod (default) | stage
  SSH_KEY_PATH Override SSH key (default: id_ed25519, id_rsa, then ssh-agent)
EOF
}

case "${1:-help}" in
  logs)      cmd_logs ;;
  db-logs)   cmd_db_logs ;;
  status)    cmd_status ;;
  restart)   cmd_restart ;;
  stop)      cmd_stop ;;
  start)     cmd_start ;;
  shell)     cmd_shell ;;
  psql)      cmd_psql ;;
  migrate)   cmd_migrate ;;
  db-backup) cmd_db_backup ;;
  backup)    cmd_backup ;;
  help|--help|-h) cmd_help ;;
  *) log_error "Unknown command: $1"; cmd_help; exit 1 ;;
esac
