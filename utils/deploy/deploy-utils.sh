#!/usr/bin/env bash
################################################################################
# tankbag — post-deploy management for the NAS stack.
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
    "/usr/local/bin/docker exec -it ${DB_CONTAINER_NAME} psql -U tankbag -d tankbag"
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
    "/usr/local/bin/docker exec ${DB_CONTAINER_NAME} pg_dump -U tankbag -d tankbag | gzip" > "./$f"
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
################################################################################
# Environment-to-environment cloning.
#
# Everything above addresses one environment, the one in DEPLOY_ENV. Cloning
# needs two at once and has to reach a third that is not a deploy target at all
# — the local dev stack — so these resolve their own container names and
# transport rather than reading the DEPLOY_ENV-derived globals.
################################################################################

# The local dev database from the repo's root docker-compose.yml. Note it shares
# a container name with prod's; they never collide because one is on this
# machine and the other is on the NAS, but every function below has to be
# explicit about WHICH host it means.
DEV_DB_CONTAINER_NAME="tankbag-db"

valid_env() {
  case "$1" in prod|stage|dev) return 0 ;; *) return 1 ;; esac
}

env_db_container() {
  case "$1" in
    prod)  echo "$PROD_DB_CONTAINER_NAME" ;;
    stage) echo "$STAGE_DB_CONTAINER_NAME" ;;
    dev)   echo "$DEV_DB_CONTAINER_NAME" ;;
  esac
}

env_storage_path() {
  case "$1" in
    prod)  echo "${NAS_DEPLOY_BASE}/${PROD_DOMAIN}/data/storage" ;;
    stage) echo "${NAS_DEPLOY_BASE}/${STAGE_DOMAIN}/data/storage" ;;
    dev)   echo "${PROJECT_ROOT}/moto-storage" ;;
  esac
}

# Runs a docker command against the right host for that environment: locally for
# dev, over SSH for the two on the NAS.
env_docker() {
  local e="$1"; shift
  if [ "$e" = "dev" ]; then
    docker "$@"
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker $*"
  fi
}

env_is_up() {
  local e="$1" c
  c="$(env_db_container "$e")"
  if [ "$e" = "dev" ]; then
    [ -n "$(docker ps -q -f "name=^${c}$" 2>/dev/null)" ]
  else
    check_ssh_key
    [ -n "$($(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker ps -q -f name=^${c}\$" 2>/dev/null)" ]
  fi
}

# --clean --if-exists so the dump drops what it is about to recreate. Without it
# a restore onto a populated database fails on every existing table, and a
# restore onto a *differently shaped* one half-succeeds, which is worse.
env_dump() {
  local e="$1" c
  c="$(env_db_container "$e")"
  if [ "$e" = "dev" ]; then
    docker exec "$c" pg_dump -U tankbag -d tankbag --clean --if-exists
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker exec ${c} pg_dump -U tankbag -d tankbag --clean --if-exists"
  fi
}

env_load() {
  local e="$1" c
  c="$(env_db_container "$e")"
  if [ "$e" = "dev" ]; then
    docker exec -i "$c" psql -U tankbag -d tankbag -v ON_ERROR_STOP=1 -q
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker exec -i ${c} psql -U tankbag -d tankbag -v ON_ERROR_STOP=1 -q"
  fi
}

env_row_counts() {
  local e="$1" c sql
  c="$(env_db_container "$e")"
  sql="select 'users=' || (select count(*) from users) || ' rides=' || (select count(*) from rides)"
  if [ "$e" = "dev" ]; then
    docker exec "$c" psql -U tankbag -d tankbag -tAc "$sql" 2>/dev/null || echo "(unreadable)"
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker exec ${c} psql -U tankbag -d tankbag -tAc \"$sql\"" 2>/dev/null || echo "(unreadable)"
  fi
}

cmd_db_restore() {
  local file="${1:-}"
  [ -n "$file" ] || { log_error "Usage: $0 db-restore <file.sql.gz>   (target: DEPLOY_ENV=${DEPLOY_ENV})"; exit 1; }
  [ -f "$file" ] || { log_error "No such file: $file"; exit 1; }
  confirm_destructive "$DEPLOY_ENV" "restore $file into"
  log_info "Restoring $file into ${DEPLOY_ENV}..."
  gunzip -c "$file" | env_load "$DEPLOY_ENV"
  log_success "Restored. ${DEPLOY_ENV} now holds: $(env_row_counts "$DEPLOY_ENV")"
}

# Prod is never a silent destination. Anywhere else still asks, because the
# destination is dropped and replaced either way.
confirm_destructive() {
  local dst="$1" what="$2"
  if [ "$dst" = "prod" ] && [ -z "${FORCE_CLONE:-}" ]; then
    log_error "Refusing to ${what} PROD without --force."
    log_error "Prod is the one environment nothing else should be able to overwrite by accident."
    exit 1
  fi
  echo ""
  log_warning "About to ${what} ${dst} — its current database will be DROPPED."
  log_warning "${dst} currently holds: $(env_row_counts "$dst")"
  printf "Type the destination name (%s) to continue: " "$dst"
  read -r reply
  [ "$reply" = "$dst" ] || { log_error "Aborted."; exit 1; }
}

cmd_db_clone() {
  local src="${1:-}" dst="${2:-}"
  if ! valid_env "$src" || ! valid_env "$dst"; then
    log_error "Usage: $0 db-clone <src> <dst>    envs: prod | stage | dev"
    log_error "Example: $0 db-clone prod dev"
    exit 1
  fi
  [ "$src" != "$dst" ] || { log_error "Source and destination are both '$src'."; exit 1; }

  env_is_up "$src" || { log_error "Source '$src' database container is not running."; exit 1; }
  env_is_up "$dst" || { log_error "Destination '$dst' database container is not running."; exit 1; }

  log_info "Source ${src} holds: $(env_row_counts "$src")"
  confirm_destructive "$dst" "clone ${src} into"

  local ts stamp safety
  ts="$(date +%Y%m%d-%H%M%S)"
  safety="./${dst}-db-before-clone-${ts}.sql.gz"

  # Taken before anything is dropped. This is the only undo.
  log_info "Backing up ${dst} first → ${safety}"
  env_dump "$dst" | gzip > "$safety"

  stamp="$(mktemp -t tankbag-clone)"
  log_info "Dumping ${src}..."
  env_dump "$src" > "$stamp"
  log_info "Loading into ${dst}..."
  env_load "$dst" < "$stamp"
  rm -f "$stamp"

  log_success "${src} → ${dst} complete. ${dst} now holds: $(env_row_counts "$dst")"

  if [ -n "${NO_STORAGE:-}" ]; then
    log_warning "Skipped storage sync (--no-storage). Imported rides will 404 their KML/GPX."
  else
    clone_storage "$src" "$dst"
  fi
  log_info "Undo with: DEPLOY_ENV=${dst} $0 db-restore ${safety}"
}

# The database references files by owner/ride id. Cloning rows without the files
# leaves every imported ride pointing at a 404, so this is part of a clone, not
# an extra.
clone_storage() {
  local src="$1" dst="$2" sp dp tar
  sp="$(env_storage_path "$src")"; dp="$(env_storage_path "$dst")"
  tar="$(mktemp -t tankbag-storage).tar.gz"

  log_info "Syncing storage ${src} → ${dst}"
  if [ "$src" = "dev" ]; then
    ( cd "$(dirname "$sp")" && tar -czf - "$(basename "$sp")" ) > "$tar" 2>/dev/null || true
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "tar -czf - -C $(dirname "$sp") $(basename "$sp") 2>/dev/null" > "$tar" || true
  fi

  if [ ! -s "$tar" ]; then
    log_warning "Source ${src} has no storage directory — nothing to sync."
    rm -f "$tar"; return
  fi

  if [ "$dst" = "dev" ]; then
    mkdir -p "$(dirname "$dp")"
    tar -xzf "$tar" -C "$(dirname "$dp")"
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "mkdir -p $(dirname "$dp") && tar -xzf - -C $(dirname "$dp")" < "$tar"
  fi
  rm -f "$tar"
  log_success "Storage synced"
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

Cloning (these name their environments explicitly and ignore DEPLOY_ENV,
except db-restore, which targets DEPLOY_ENV):

  db-clone <src> <dst>    Replace <dst>'s database and storage with <src>'s
  db-restore <file>       Load a dump into DEPLOY_ENV

  Environments: prod | stage | dev     (dev = the local docker-compose stack)

  The destination is dropped and replaced, so both commands back it up first
  and print the exact command to undo. Prod as a destination additionally
  requires --force; every destination requires typing its name to confirm.

  Examples:
    $0 db-clone prod dev              # pull production down to your laptop
    $0 db-clone prod stage            # refresh staging from production
    NO_STORAGE=1 $0 db-clone prod dev # database only, skip the KML/GPX files
    DEPLOY_ENV=stage $0 db-restore stage-db-20260731-010000.sql.gz

Environment:
  DEPLOY_ENV   prod (default) | stage
  SSH_KEY_PATH Override SSH key (default: id_ed25519, id_rsa, then ssh-agent)
  NO_STORAGE   Set to skip the storage sync during db-clone
EOF
}

# --force is consumed here rather than in the command, so it can appear anywhere.
ARGS=()
for a in "$@"; do
  case "$a" in
    --force|-f)   FORCE_CLONE=1 ;;
    --no-storage) NO_STORAGE=1 ;;
    *)            ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]:-help}"

case "${1:-help}" in
  logs)       cmd_logs ;;
  db-logs)    cmd_db_logs ;;
  status)     cmd_status ;;
  restart)    cmd_restart ;;
  stop)       cmd_stop ;;
  start)      cmd_start ;;
  shell)      cmd_shell ;;
  psql)       cmd_psql ;;
  migrate)    cmd_migrate ;;
  db-backup)  cmd_db_backup ;;
  backup)     cmd_backup ;;
  db-clone)   cmd_db_clone "${2:-}" "${3:-}" ;;
  db-restore) cmd_db_restore "${2:-}" ;;
  help|--help|-h) cmd_help ;;
  *) log_error "Unknown command: $1"; cmd_help; exit 1 ;;
esac
