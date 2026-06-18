#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# RouteLoop — post-deploy management for the NAS Docker container.
# Usage: ./utils/deploy/deploy-utils.sh <command> [options]
# ============================================================================

NAS_USER="ziad"
NAS_HOST="nas.feralcreative.co"
NAS_SSH_PORT="33725"
NAS_DEPLOY_PATH="/volume1/web/routeloop.app"
CONTAINER_NAME="routeloop"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
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

cmd_logs() {
  check_ssh_key
  $(get_ssh_cmd) "${NAS_USER}@${NAS_HOST}" "/usr/local/bin/docker logs -f ${CONTAINER_NAME}"
}
cmd_status() {
  check_ssh_key
  $(get_ssh_cmd) "${NAS_USER}@${NAS_HOST}" "/usr/local/bin/docker ps | grep ${CONTAINER_NAME} || echo 'Not running'"
}
cmd_restart() {
  check_ssh_key
  $(get_ssh_cmd) "${NAS_USER}@${NAS_HOST}" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose restart"
  log_success "Container restarted"
}
cmd_stop() {
  check_ssh_key
  $(get_ssh_cmd) "${NAS_USER}@${NAS_HOST}" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose down"
  log_success "Container stopped"
}
cmd_start() {
  check_ssh_key
  $(get_ssh_cmd) "${NAS_USER}@${NAS_HOST}" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose up -d"
  log_success "Container started"
}
cmd_shell() {
  check_ssh_key
  $(get_ssh_cmd) -t "${NAS_USER}@${NAS_HOST}" "/usr/local/bin/docker exec -it ${CONTAINER_NAME} /bin/sh"
}
cmd_help() {
  cat <<EOF
Deployment Utilities for ${CONTAINER_NAME}

Usage: $0 <command>

Commands:
  logs       Follow container logs
  status     Show container status
  restart    Restart the container
  stop       Stop the container
  start      Start the container
  shell      Open a shell in the container
  help       Show this help

Environment:
  SSH_KEY_PATH   Override SSH key path (default: auto-detect)
EOF
}

case "${1:-help}" in
  logs)        cmd_logs ;;
  status)      cmd_status ;;
  restart)     cmd_restart ;;
  stop)        cmd_stop ;;
  start)       cmd_start ;;
  shell)       cmd_shell ;;
  help|--help|-h) cmd_help ;;
  *) log_error "Unknown command: $1"; cmd_help; exit 1 ;;
esac
