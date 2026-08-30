#!/usr/bin/env bash
################################################################################
# routeloop — plumbing shared by deploy.sh and deploy-utils.sh.
#
# WHY IT EXISTS. Both scripts carried `check_ssh_key`, `get_ssh_cmd` and the log
# helpers verbatim, which was survivable while they were four lines that never
# changed. Blue/green adds a question both scripts have to answer the same way
# and get right every time — WHICH COLOR IS LIVE — and two copies of that
# answer is two chances to cut over to the wrong container.
#
# Sourced, not executed. It assumes deploy.config has already been sourced and
# that NAS_USER / NAS_HOST / NAS_SSH_PORT / NAS_DEPLOY_PATH are set.
################################################################################

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

check_ssh_key() {
  # A LEADING ~ IS EXPANDED BY HAND, because nothing else will. Tilde expansion
  # happens when the shell PARSES a word, so a `~` that arrives inside a
  # variable — from .env, or from a CI env block — stays a literal character and
  # the -f test fails against a file that exists. It cost the first CI deploy.
  case "${SSH_KEY_PATH:-}" in "~/"*) SSH_KEY_PATH="$HOME/${SSH_KEY_PATH#\~/}" ;; esac
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

# ONE ROUND TRIP BEFORE ANYTHING ELSE, SO A CONNECTION PROBLEM IS REPORTED AS A
# CONNECTION PROBLEM. Without it the first thing to touch the NAS is the deploy
# lock, and its failure path reads as contention — so an unreachable host was
# reported as "Another deploy holds the lock on stage", with no holder recorded.
# That sent the first CI run after the env fix looking for a stuck lock that did
# not exist.
#
# The host-key case gets its own paragraph because the trap is not obvious: ssh
# looks a host up in known_hosts under the name AND PORT it was given, and a
# non-default port makes that key BRACKETED — `[host]:33725`. An entry generated
# with a portless `ssh-keyscan host` is filed under the bare name and never
# matches, which fails identically to a key that is genuinely wrong.
check_ssh_reachable() {
  local err
  if err=$($(get_ssh_cmd) -o BatchMode=yes -o ConnectTimeout=15 "$NAS_SSH_HOST" true 2>&1); then
    return 0
  fi
  log_error "Cannot reach ${NAS_SSH_HOST} on port ${NAS_SSH_PORT} over SSH."
  [ -n "$err" ] && log_error "  ssh said: ${err%%$'\n'*}"
  case "$err" in
    *"Host key verification failed"*)
      log_error ""
      log_error "The host key is not in known_hosts under the name ssh looks it up by."
      log_error "Port ${NAS_SSH_PORT} is not 22, so that name is BRACKETED and an entry"
      log_error "written for the bare hostname never matches. Regenerate it WITH the port:"
      log_error "  ssh-keyscan -p ${NAS_SSH_PORT} ${NAS_HOST}"
      log_error "In CI that is the NAS_SSH_KNOWN_HOSTS repository secret."
      ;;
  esac
  exit 1
}

# Run one command on the NAS. Every remote call in both scripts goes through
# this, so there is one place that knows how to reach the host.
nas() { $(get_ssh_cmd) "$NAS_SSH_HOST" "$@"; }

# The hyphenated binary, because that is what is on the Synology PATH. Measured
# 2026-08-27: Compose v2.20.1, so profiles (>=1.28) are available and both
# spellings resolve to the same binary.
COMPOSE="/usr/local/bin/docker-compose"
DOCKER="/usr/local/bin/docker"

# --- The deploy lock ---------------------------------------------------------
#
# ONE DEPLOY AT A TIME, AND THE LOCK LIVES ON THE NAS BECAUSE THAT IS THE ONLY
# PLACE BOTH DEPLOYERS CAN SEE IT. There was no lock at all until 2026-08-29,
# which was survivable while a deploy could only ever be started by one person
# at one terminal. It stops being survivable the moment a CI workflow can start
# one too: two deploys interleaving during a cutover both rewrite
# `proxy/upstream.caddy`, which is the ONE line recording which color is
# serving — so the proxy can end up pointed at a container the other deploy is
# in the middle of recreating.
#
# A local flock would not do: the two racers are different machines.
#
# `mkdir` rather than a lock FILE, because mkdir is atomic on POSIX — it either
# creates the directory or fails, with no window between testing and taking.
# `test -f && touch` has exactly that window and would hand the lock to both.
#
# The holder writes who and when into the directory, so a stuck lock says what
# to look at rather than only that something is stuck.
DEPLOY_LOCK_DIR=""

acquire_deploy_lock() {
  local dir="${NAS_DEPLOY_PATH}/.deploy.lock"
  local who="${DEPLOY_LOCK_OWNER:-$(whoami)@$(hostname -s 2>/dev/null || echo unknown)}"

  # -p on the PARENT only. The lock directory itself is created without -p on
  # purpose: `mkdir -p` succeeds when the directory already exists, which would
  # hand the lock to every caller at once and make this whole function a no-op.
  # A first deploy onto a fresh path needs the parent, though, or the lock fails
  # for a reason that has nothing to do with contention.
  if ! nas "mkdir -p '${NAS_DEPLOY_PATH}' && mkdir '${dir}' 2>/dev/null"; then
    # A FAILED mkdir IS NOT PROOF OF CONTENTION. It is equally what an
    # unreachable host looks like, and reporting that as a held lock sends
    # somebody to `unlock` a lock that was never taken.
    if ! nas true >/dev/null 2>&1; then
      log_error "Cannot reach the NAS over SSH, so the lock was never tested."
      log_error "This is a connection failure, NOT a held lock — do not run unlock."
      return 1
    fi
    local held; held=$(nas "cat '${dir}/holder' 2>/dev/null" || true)
    log_error "Another deploy holds the lock on ${DEPLOY_ENV}."
    log_error "  ${held:-<no holder recorded>}"
    log_error ""
    log_error "If that deploy is genuinely gone, break the lock and retry:"
    log_error "  DEPLOY_ENV=${DEPLOY_ENV} utils/deploy/deploy-utils.sh unlock"
    return 1
  fi

  DEPLOY_LOCK_DIR="$dir"
  nas "printf '%s\n' 'held by ${who} since '\"\$(date -u '+%Y-%m-%dT%H:%M:%SZ')\" > '${dir}/holder'" || true
  return 0
}

# Called from a trap, so it must never fail the script it is cleaning up after.
release_deploy_lock() {
  [ -n "$DEPLOY_LOCK_DIR" ] || return 0
  nas "rm -rf '${DEPLOY_LOCK_DIR}'" >/dev/null 2>&1 || true
  DEPLOY_LOCK_DIR=""
}

# --- Colors -----------------------------------------------------------------
#
# WHICH COLOR IS LIVE IS READ OUT OF THE PROXY'S OWN CONFIG, and that is the
# whole design. `proxy/upstream.caddy` is one line, it is NAS state rather than
# a repo file, and it IS what Caddy is serving — so there is no second source of
# truth that can drift from the first.
#
# Three alternatives were considered and rejected. `docker ps` is ambiguous BY
# CONSTRUCTION: during a cutover both colors run, and the entire point of the
# design is that "running" and "serving" are different states. The Caddy admin
# API is authoritative but answers in adapted JSON, and grepping JSON in bash to
# decide which container to cut over to is how you cut over to the wrong one. A
# separate marker file is a second source of truth by definition.

live_color() {
  local up
  up=$(nas "cat ${NAS_DEPLOY_PATH}/proxy/upstream.caddy 2>/dev/null" || true)
  case "$up" in
    *"${BLUE_CONTAINER_NAME}"*)  echo "blue"  ;;
    *"${GREEN_CONTAINER_NAME}"*) echo "green" ;;
    *) echo "" ;;
  esac
}

# The fallback, for a first cutover or a file somebody deleted. Deliberately
# REFUSES to guess when both colors are running: that is the one state where a
# wrong guess points the proxy at the container that is on its way out, and a
# human naming the color explicitly is the only safe answer.
resolve_live_color() {
  local c; c=$(live_color)
  if [ -n "$c" ]; then echo "$c"; return; fi

  local blue_up green_up
  blue_up=$(nas "$DOCKER ps --format '{{.Names}}' | grep -cx ${BLUE_CONTAINER_NAME}" || echo 0)
  green_up=$(nas "$DOCKER ps --format '{{.Names}}' | grep -cx ${GREEN_CONTAINER_NAME}" || echo 0)

  if [ "$blue_up" = "1" ] && [ "$green_up" = "1" ]; then
    log_error "upstream.caddy is missing or unreadable AND both colors are running."
    log_error "Refusing to guess which one is serving. Name it explicitly:"
    log_error "  DEPLOY_ENV=${DEPLOY_ENV} utils/deploy/deploy-utils.sh cutover blue|green"
    exit 1
  fi
  if [ "$blue_up" = "1" ];  then echo "blue";  return; fi
  if [ "$green_up" = "1" ]; then echo "green"; return; fi
  # NOTHING IS LIVE. Deliberately its own answer rather than defaulting to a
  # color: on a first deploy onto this topology there is no idle container to
  # roll back to, and saying "blue is live" makes the deploy report an idle
  # color that has never existed and that `cutover` would refuse. Callers must
  # handle the empty string.
  echo ""
}

# True when the named color is actually running. The deploy uses it to decide
# whether it has a rollback target to talk about, rather than assuming it does.
color_is_running() {
  local t; t=$(container_for "$1")
  nas "$DOCKER ps --format '{{.Names}}' | grep -qx ${t}" >/dev/null 2>&1
}

other_color() { [ "$1" = "blue" ] && echo "green" || echo "blue"; }

container_for() {
  case "$1" in
    blue)  echo "$BLUE_CONTAINER_NAME"  ;;
    green) echo "$GREEN_CONTAINER_NAME" ;;
    *) log_error "Not a color: $1"; exit 1 ;;
  esac
}

service_for() {
  case "$1" in
    blue)  echo "app-blue"  ;;
    green) echo "app-green" ;;
    *) log_error "Not a color: $1"; exit 1 ;;
  esac
}

# --- The cutover ------------------------------------------------------------
#
# VALIDATE BEFORE RELOAD, so a config this script generated badly is caught
# while the OLD one is still serving. Caddy keeps its running config when a
# reload fails, so the failure mode here is "nothing happened" rather than "the
# proxy is down" — but only if validate runs first and its failure is fatal.
point_proxy_at() {
  local color="$1" target
  target=$(container_for "$color")

  nas "printf 'reverse_proxy %s:6686\n' '${target}' > ${NAS_DEPLOY_PATH}/proxy/upstream.caddy"

  if ! nas "$DOCKER exec ${PROXY_CONTAINER_NAME} caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" >/dev/null 2>&1; then
    log_error "Caddy refused the generated config. The proxy was NOT reloaded and is"
    log_error "still serving whatever it was serving. Nothing has changed."
    nas "$DOCKER exec ${PROXY_CONTAINER_NAME} caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" || true
    return 1
  fi

  nas "$DOCKER exec ${PROXY_CONTAINER_NAME} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile"
}

# Ask a color directly, bypassing the proxy, which is how you tell "this color
# is broken" apart from "the proxy is pointed somewhere else".
color_health() {
  local color="$1" target
  target=$(container_for "$color")
  nas "$DOCKER exec ${target} wget -qO- http://127.0.0.1:6686/healthz 2>/dev/null" || true
}
