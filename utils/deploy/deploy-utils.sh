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

# Colors, logging, SSH plumbing, and the one implementation of "which color is
# live" that this script and deploy.sh both read. See utils/deploy/lib.sh.
source "$SCRIPT_DIR/lib.sh"

cmd_logs() {
  check_ssh_key
  # DEFAULTS TO THE LIVE COLOR AND SAYS SO. A `logs` that silently follows an
  # idle container shows you a container serving nothing while you are trying to
  # work out why the site is broken — worse than an error, because it looks like
  # an answer.
  local what="${1:-}" target
  case "$what" in
    blue|green) target=$(container_for "$what") ;;
    proxy)      target="$PROXY_CONTAINER_NAME" ;;
    db)         target="$DB_CONTAINER_NAME" ;;
    "")         local c; c=$(resolve_live_color); target=$(container_for "$c")
                log_info "Following the LIVE color: ${c} (${target})" ;;
    *) log_error "Usage: logs [blue|green|proxy|db]"; exit 1 ;;
  esac
  nas "$DOCKER logs -f ${target}"
}
cmd_db_logs() {
  check_ssh_key
  $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker logs -f ${DB_CONTAINER_NAME}"
}
cmd_status() {
  check_ssh_key
  local live idle
  live=$(live_color)
  [ -z "$live" ] && live="(upstream.caddy unreadable)"
  idle=""
  case "$live" in blue) idle="green" ;; green) idle="blue" ;; esac

  nas "$DOCKER ps -a --filter name=${BLUE_CONTAINER_NAME} --filter name=${GREEN_CONTAINER_NAME} \
       --filter name=${PROXY_CONTAINER_NAME} --filter name=${DB_CONTAINER_NAME} \
       --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || echo 'Not running'"
  echo ""
  log_info "The proxy says LIVE is: ${live}"
  echo ""

  # THROUGH the host port — what a rider actually gets.
  log_info "Origin (127.0.0.1:${HOST_PORT}, the port the tunnel targets):"
  nas "curl -fsS --max-time 10 http://127.0.0.1:${HOST_PORT}/healthz || echo 'no response'"
  echo ""

  # AND each color directly. This is the pair that tells you "green is healthy
  # but nothing points at it" — which through the proxy alone is invisible.
  for c in blue green; do
    local t; t=$(container_for "$c")
    if nas "$DOCKER ps --format '{{.Names}}' | grep -qx ${t}"; then
      log_info "${c} (direct):"
      echo "  $(color_health "$c")"
    else
      log_info "${c}: not running"
    fi
  done
}
cmd_restart() {
  check_ssh_key
  local c; c=$(resolve_live_color)
  log_warning "Restarting the LIVE color (${c}) IN PLACE. This is brief downtime."
  log_warning "The zero-downtime path is a deploy: DEPLOY_ENV=${DEPLOY_ENV} utils/deploy/${DEPLOY_ENV}.sh"
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE restart $(service_for "$c")"
  log_success "${c} restarted"
}
cmd_restart_proxy() {
  check_ssh_key
  # A reload, not a restart: Caddy re-reads its config without dropping a
  # connection, which is the entire reason the proxy is Caddy.
  nas "$DOCKER exec ${PROXY_CONTAINER_NAME} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile"
  log_success "Proxy config reloaded"
}
cmd_restart_db() {
  check_ssh_key
  log_warning "This restarts POSTGRES for ${DEPLOY_ENV}. Every in-flight query dies."
  read -r -p "Type the environment name to confirm: " confirm
  [ "$confirm" = "$DEPLOY_ENV" ] || { log_error "Not confirmed."; exit 1; }
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE restart db"
  log_success "Database restarted"
}
cmd_stop() {
  # STOPS THE COLORS AND THE PROXY, LEAVING db UP. `down` would take the
  # database and the bridge network with it, which is the thing Phase 1 spent
  # its whole existence removing from the deploy path.
  check_ssh_key
  if [ "${1:-}" = "--all" ]; then
    log_warning "--all stops the DATABASE too, for ${DEPLOY_ENV}."
    read -r -p "Type the environment name to confirm: " confirm
    [ "$confirm" = "$DEPLOY_ENV" ] || { log_error "Not confirmed."; exit 1; }
    nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE stop app-blue app-green proxy db"
    log_success "Everything stopped, including the database"
    return
  fi
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE stop app-blue app-green proxy"
  log_success "Colors and proxy stopped — the database is still up"
}
cmd_start() {
  # NEVER A BARE `up -d`. The colors are behind Compose profiles so it could not
  # start both even by accident, but naming what you want is the habit that
  # survives somebody removing the profiles.
  check_ssh_key
  local c; c=$(resolve_live_color)
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE up -d db proxy"
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE up -d --no-deps $(service_for "$c")"
  log_success "Started db, proxy and ${c} (the color upstream.caddy names)"
}
cmd_shell() {
  check_ssh_key
  # The LIVE color. Under blue/green "the app container" is two containers, and
  # a shell in the idle one looks identical while telling you nothing about what
  # riders are hitting.
  local c; c=$(resolve_live_color)
  log_info "Opening a shell in the LIVE color: ${c}"
  $(get_ssh_cmd) -t "$NAS_SSH_HOST" "$DOCKER exec -it $(container_for "$c") /bin/sh"
}
cmd_psql() {
  check_ssh_key
  $(get_ssh_cmd) -t "$NAS_SSH_HOST" \
    "/usr/local/bin/docker exec -it ${DB_CONTAINER_NAME} psql -U routeloop -d routeloop"
}
# Applies pending generated migrations. This used `push --force` until
# 2026-08-10, which the project's own docs called out as dangerous in the same
# breath as using it: --force does not mean "unattended", it means "answer yes",
# and push's prompts include offering to truncate the users table. migrate() has
# no prompts to answer, so the flag has no successor.
#
# THE ONE-SHOT `migrate` SERVICE, NOT `docker exec` INTO THE APP. Both work —
# drizzle-kit is in the image either way — but deploy.sh runs the compose
# service, and the recovery command its failure message hands you is this exact
# spelling. Two ways to say the same operation is two things to keep in step,
# and the one in the error message is the one somebody will actually paste.
cmd_migrate() {
  check_ssh_key
  log_info "Applying Drizzle migrations for ${DEPLOY_ENV}..."
  $(get_ssh_cmd) "$NAS_SSH_HOST" \
    "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose run --rm --no-deps -T migrate"
  log_success "Migrations applied"
}
# Live, idle, and what is actually running. The first thing to type when
# something looks wrong, because "which container is serving" is the question
# every other answer depends on.
cmd_colors() {
  check_ssh_key
  local live; live=$(live_color)
  if [ -z "$live" ]; then
    log_warning "upstream.caddy is missing or names neither color."
  else
    log_success "LIVE: ${live} ($(container_for "$live"))"
    local idle; idle=$(other_color "$live")
    # Only call it idle if it is actually there. An "idle" color that is not
    # running is not a rollback target, and reporting one is worse than
    # reporting none — `cutover` would refuse it and the operator would find
    # out during an incident.
    if color_is_running "$idle"; then
      log_info  "IDLE: ${idle} ($(container_for "$idle")) — up, and a valid rollback target"
    else
      log_warning "IDLE: ${idle} is NOT running. There is no rollback target right now."
    fi
  fi
  echo ""
  log_info "Actually running:"
  nas "$DOCKER ps --filter name=${BLUE_CONTAINER_NAME} --filter name=${GREEN_CONTAINER_NAME} \
       --filter name=${PROXY_CONTAINER_NAME} --format '  {{.Names}}  {{.Status}}'"
}

# THE MANUAL LEVER, and the reason the old color is left running after a deploy:
# this is how you put it back in about ten seconds, while it is still warm.
#
# REFUSES A TARGET THAT IS NOT RUNNING AND HEALTHY. Pointing the proxy at a dead
# container is a 502 for every rider, and it is the one mistake this command
# exists to make impossible — a human types it when something is already wrong,
# which is exactly when a second failure is least welcome.
# Break a deploy lock whose holder is gone.
#
# DELIBERATELY MANUAL, WITH NO AGE-BASED AUTO-BREAK. A lock that expires on its
# own is a lock that expires DURING the slowest deploy you ever run — which is
# the one most likely to be mid-cutover, and the one where a second deploy
# starting is worst. A human reading who holds it and deciding they are gone is
# the correct amount of ceremony for something that happens approximately never.
cmd_unlock() {
  local dir="${NAS_DEPLOY_PATH}/.deploy.lock"
  local held; held=$(nas "cat '${dir}/holder' 2>/dev/null" || true)
  if [ -z "$held" ] && ! nas "test -d '${dir}'"; then
    log_info "No deploy lock is held on ${DEPLOY_ENV}."
    return 0
  fi
  log_warning "Deploy lock on ${DEPLOY_ENV}: ${held:-<no holder recorded>}"
  log_warning "Breaking it while that deploy is still running risks two deploys"
  log_warning "cutting the proxy over at once. Check first."
  nas "rm -rf '${dir}'"
  log_success "Lock released."
}

cmd_cutover() {
  check_ssh_key
  local target="${1:-}"
  case "$target" in
    blue|green) ;;
    *) log_error "Usage: cutover blue|green"; exit 1 ;;
  esac

  local container; container=$(container_for "$target")
  if ! nas "$DOCKER ps --format '{{.Names}}' | grep -qx ${container}"; then
    log_error "${target} (${container}) is not running. Refusing to cut over to it."
    log_error "Start it first:  cd ${NAS_DEPLOY_PATH} && docker-compose up -d --no-deps $(service_for "$target")"
    exit 1
  fi

  local body; body=$(color_health "$target")
  case "$body" in
    *'"ok":true'*) ;;
    *) log_error "${target} is running but not healthy. Refusing to cut over to it."
       log_error "It said: ${body:-<nothing>}"
       exit 1 ;;
  esac

  local from; from=$(live_color)
  log_info "Cutting over from ${from:-unknown} to ${target}..."
  point_proxy_at "$target" || { log_error "Cutover failed — nothing changed."; exit 1; }

  local origin; origin=$(nas "curl -fsS --max-time 5 http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null || true)
  case "$origin" in
    *'"ok":true'*) log_success "Origin is now serving ${target}"; echo "  ${origin}" ;;
    *) log_error "Proxy reloaded but the origin did not answer healthy: ${origin:-<nothing>}"; exit 1 ;;
  esac
}

# What shape is this database actually in?
#
# EXISTS BECAUSE THE THREE WAYS `migrate` FAILS LOOK IDENTICAL FROM THE DEPLOY
# LOG AND TWO OF THEM HAVE OPPOSITE FIXES. A stale adopted volume and a genuine
# pre-drizzle database both present as "migrate tried to create a table that
# already exists"; baselining is right for the second and destroys the first,
# because it records every later migration as applied against a schema that
# never got them. The difference is visible in ten seconds — is the table list
# COMPLETE, and are there any rows — and invisible in the error.
#
# Observed on stage 2026-08-27: 7 tables including `routes`, the name `days`
# replaced on 2026-08-09, 0 migrations recorded and 0 rows anywhere. Prod on the
# same host was 26 tables and 19 migrations. Read-only; safe to run anywhere.
cmd_schema_state() {
  check_ssh_key
  log_info "Schema state for ${DEPLOY_ENV} (${DB_CONTAINER_NAME}):"
  $(get_ssh_cmd) "$NAS_SSH_HOST" \
    "/usr/local/bin/docker exec ${DB_CONTAINER_NAME} psql -U routeloop -d routeloop -At -c \"
      select 'tables=' || count(*) from information_schema.tables where table_schema = 'public';
      -- Guarded with to_regclass because a wiped or never-migrated database has
      -- no drizzle schema at all, and psql runs a multi-statement -c as ONE
      -- transaction: an undefined-relation error there aborts every query
      -- after it, so the interesting half of this report would never print.
      -- CASE short-circuits, and query_to_xml takes its query as a runtime
      -- string, so nothing plans a table that does not exist.
      select 'migrations_recorded=' || case
        when to_regclass('drizzle.__drizzle_migrations') is null then 'none (no drizzle schema)'
        else (xpath('/row/c/text()', query_to_xml('select count(*) as c from drizzle.__drizzle_migrations', false, true, '')))[1]::text
      end;
      select string_agg(table_name, ' ' order by table_name) from information_schema.tables where table_schema = 'public';
      -- Exact counts per table, so 'stale but empty' is distinguishable from
      -- 'behind and full'. query_to_xml is the standard way to count a table
      -- whose name is only known at runtime without writing a DO block.
      select coalesce(string_agg(t.table_name || '=' || t.n, ' ' order by t.n desc, t.table_name), '(no tables)')
        from (
          select table_name,
                 (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as n
            from information_schema.tables where table_schema = 'public'
        ) t;
    \"" 2>&1 || log_warning "Could not read the schema — is the database container up?"
}
# One-time, for a database created before drizzle/ existed. Records the
# migrations as applied without running them. See docs/database.md.
cmd_db_baseline() {
  check_ssh_key
  # The same one-shot the migration uses, with the command overridden. It used
  # to `docker exec` into the app container, which under blue/green means
  # "whichever color happens to be up" — and during a cutover that is ambiguous.
  log_info "Baselining migration history for ${DEPLOY_ENV}..."
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE run --rm --no-deps -T --entrypoint sh migrate -c 'npx tsx utils/db-baseline.ts'"
}
# WHERE A BACKUP LANDS. Ziad's call, 2026-08-27: data/, not the repo root.
#
# It is where dumps had already been collecting by hand, and the root is a bad
# default for a file nobody reviews — `*.sql.gz` and `*.tar.gz` are gitignored,
# so a stray one is invisible rather than merely untidy, and these hold rider
# PII. Keeping them in one directory means "what backups do I have" is an `ls`.
#
# Created on demand: a fresh clone has no data/ and a backup must never be the
# thing that fails because a directory was missing.
BACKUP_DIR="$PROJECT_ROOT/data"

# Postgres dump — the real backup. Map files are backed up separately.
cmd_db_backup() {
  check_ssh_key
  mkdir -p "$BACKUP_DIR"
  local f="$BACKUP_DIR/routeloop-${DEPLOY_ENV}-db-$(date +%Y%m%d-%H%M%S).sql.gz"
  log_info "Dumping database to $f"
  $(get_ssh_cmd) "$NAS_SSH_HOST" \
    "/usr/local/bin/docker exec ${DB_CONTAINER_NAME} pg_dump -U routeloop -d routeloop | gzip" > "$f"
  log_success "Database backup saved to $f"
}
# User-uploaded KML/GPX from the mounted storage volume.
cmd_backup() {
  check_ssh_key
  mkdir -p "$BACKUP_DIR"
  local f="$BACKUP_DIR/routeloop-${DEPLOY_ENV}-storage-$(date +%Y%m%d-%H%M%S).tar.gz"
  log_info "Archiving user files to $f"
  $(get_ssh_cmd) "$NAS_SSH_HOST" "tar -czf - -C ${NAS_DEPLOY_PATH}/data storage" > "$f"
  log_success "Storage backup saved to $f"
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
DEV_DB_CONTAINER_NAME="routeloop-db"

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
    dev)   echo "${PROJECT_ROOT}/storage" ;;
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
    docker exec "$c" pg_dump -U routeloop -d routeloop --clean --if-exists
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker exec ${c} pg_dump -U routeloop -d routeloop --clean --if-exists"
  fi
}

env_load() {
  local e="$1" c
  c="$(env_db_container "$e")"
  if [ "$e" = "dev" ]; then
    docker exec -i "$c" psql -U routeloop -d routeloop -v ON_ERROR_STOP=1 -q
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker exec -i ${c} psql -U routeloop -d routeloop -v ON_ERROR_STOP=1 -q"
  fi
}

env_row_counts() {
  local e="$1" c sql
  c="$(env_db_container "$e")"
  sql="select 'users=' || (select count(*) from users) || ' rides=' || (select count(*) from rides)"
  if [ "$e" = "dev" ]; then
    docker exec "$c" psql -U routeloop -d routeloop -tAc "$sql" 2>/dev/null || echo "(unreadable)"
  else
    check_ssh_key
    $(get_ssh_cmd) "$NAS_SSH_HOST" "/usr/local/bin/docker exec ${c} psql -U routeloop -d routeloop -tAc \"$sql\"" 2>/dev/null || echo "(unreadable)"
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
  mkdir -p "$BACKUP_DIR"
  safety="$BACKUP_DIR/${dst}-db-before-clone-${ts}.sql.gz"

  # Taken before anything is dropped. This is the only undo.
  log_info "Backing up ${dst} first → ${safety}"
  env_dump "$dst" | gzip > "$safety"

  stamp="$(mktemp -t routeloop-clone)"
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
  tar="$(mktemp -t routeloop-storage).tar.gz"

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
  logs [what]  Follow logs — blue|green|proxy|db, default the LIVE color
  colors       Which color is live, which is idle, what is running
  cutover <c>  Point the proxy at blue|green — the manual rollback lever
  unlock       Break a stale deploy lock (says who holds it first)
  db-logs      Follow Postgres logs
  status       Container status + origin HTTP check on 127.0.0.1:${HOST_PORT}
  restart      Restart the LIVE color in place (brief downtime)
  restart-proxy  Reload the proxy config (no dropped connections)
  restart-db   Restart Postgres (asks for confirmation)
  stop [--all] Stop the colors and proxy; --all adds the database
  start        Start db, proxy and the color upstream.caddy names
  shell        Shell into the LIVE color
  psql         Open psql against the app database
  migrate      Apply pending Drizzle migrations (drizzle-kit migrate)
  schema-state Table list, row counts and migrations recorded — read-only
  db-baseline  Record migrations as applied WITHOUT running them — one-time,
               for a database created before drizzle/ existed
  db-backup    Dump Postgres to data/routeloop-<env>-db-<ts>.sql.gz
  backup       Archive user KML/GPX to data/routeloop-<env>-storage-<ts>.tar.gz
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
    DEPLOY_ENV=stage $0 db-restore data/stage-db-20260731-010000.sql.gz

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
  logs)       cmd_logs "${2:-}" ;;
  db-logs)    cmd_db_logs ;;
  status)     cmd_status ;;
  restart)    cmd_restart ;;
  stop)       cmd_stop "${2:-}" ;;
  start)      cmd_start ;;
  shell)      cmd_shell ;;
  psql)       cmd_psql ;;
  migrate)     cmd_migrate ;;
  colors)      cmd_colors ;;
  cutover)     cmd_cutover "${2:-}" ;;
  restart-proxy) cmd_restart_proxy ;;
  restart-db)  cmd_restart_db ;;
  unlock)      cmd_unlock ;;
  schema-state) cmd_schema_state ;;
  db-baseline) cmd_db_baseline ;;
  db-backup)  cmd_db_backup ;;
  backup)     cmd_backup ;;
  db-clone)   cmd_db_clone "${2:-}" "${3:-}" ;;
  db-restore) cmd_db_restore "${2:-}" ;;
  help|--help|-h) cmd_help ;;
  *) log_error "Unknown command: $1"; cmd_help; exit 1 ;;
esac
