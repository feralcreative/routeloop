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

# Run one command on the NAS. Every remote call in both scripts goes through
# this, so there is one place that knows how to reach the host.
nas() { $(get_ssh_cmd) "$NAS_SSH_HOST" "$@"; }

# The hyphenated binary, because that is what is on the Synology PATH. Measured
# 2026-08-27: Compose v2.20.1, so profiles (>=1.28) are available and both
# spellings resolve to the same binary.
COMPOSE="/usr/local/bin/docker-compose"
DOCKER="/usr/local/bin/docker"

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
