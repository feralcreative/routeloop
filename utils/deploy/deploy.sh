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

# Colors, logging, SSH plumbing and — the part that matters here — the single
# implementation of "which color is live". See utils/deploy/lib.sh.
source "$SCRIPT_DIR/lib.sh"

format_time() { local s=$1; if [ "$s" -lt 60 ]; then echo "${s}s"; else echo "$((s/60))m $((s%60))s"; fi; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { log_error "Required command '$1' not found. ${2:-}"; exit 1; }; }

cd "$PROJECT_ROOT"
DEPLOY_START=$(date +%s)
BUILD_TIME=0
TRANSFER_TIME=0

# ---------------------------------------------------------------- flags ------
DRY_RUN=""; FORCE=""; NO_OVERLAP=""; FORCE_COLOR=""
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --force|-f)   FORCE=1 ;;
    # THE ESCAPE HATCH FOR A MIGRATION THAT CANNOT BE MADE ADDITIVE. Ziad's
    # call, 2026-08-27: expand/contract is the rule, and a rule with no lever
    # blocks a genuine emergency. This stops the old color BEFORE starting the
    # new one, so the two never overlap and the old code never sees the new
    # schema — at the cost of one slow deploy with real downtime.
    --no-overlap) NO_OVERLAP=1 ;;
    --color=*)    FORCE_COLOR="${arg#*=}" ;;
    --help|-h)    echo "Usage: $(basename "$0") [--dry-run] [--force] [--no-overlap] [--color=blue|green]"; exit 0 ;;
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
[ -n "${DB_PASSWORD}" ]  || MISSING="${MISSING} $([ "$DEPLOY_ENV" = "prod" ] && echo PROD_DB_PASSWORD || echo STAGE_DB_PASSWORD)"

# Promoted to hard failures when the Google migrations landed, because without
# them the container starts, passes its healthcheck, and is useless:
#
#   GMAPS_MAP_ID          Advanced Markers render NOTHING without a Map ID — no
#                         error, no marker, just an empty map.
#   GOOGLE_CLIENT_ID/     Both sign-in methods feature-flag themselves off when
#   GOOGLE_CLIENT_SECRET  unconfigured, and Cloudflare Access no longer backs
#   SMTP_* / MAIL_FROM    them up — so an omission here ships a site that NOBODY,
#                         including the owner, can sign in to.
#
# These used never to be shipped at all. That was survivable only while Access
# was still authenticating at the edge; it is not survivable now.
[ -n "${GMAPS_MAP_ID:-}" ] || MISSING="${MISSING} GMAPS_MAP_ID"
[ -n "${GOOGLE_CLIENT_ID:-}" ] || MISSING="${MISSING} GOOGLE_CLIENT_ID"
[ -n "${GOOGLE_CLIENT_SECRET:-}" ] || MISSING="${MISSING} GOOGLE_CLIENT_SECRET"
[ -n "${GMAPS_SERVER_KEY:-}" ] || MISSING="${MISSING} GMAPS_SERVER_KEY"

if [ -n "$MISSING" ]; then
  log_error "Missing required value(s) in .env:${MISSING}"
  log_error "See .env.example. Aborting rather than deploying a broken container."
  exit 1
fi


# Mail is genuinely optional — Google OAuth alone is a working sign-in — so an
# incomplete SMTP triple warns rather than blocks. All three or none: a partial
# set is the case that looks configured and fails at send time.
#
# Note what "none" now costs. It is no longer only the magic-link form: the same
# three values gate every notification, so an unconfigured deploy also sends no
# waitlist confirmation, no approval notice and no new-signup alert. Riders are
# approved by hand, so that last one is how the owner learns anyone is waiting.
SMTP_SET=0
[ -n "${SMTP_USER:-}" ] && SMTP_SET=$((SMTP_SET + 1))
[ -n "${SMTP_PASS:-}" ] && SMTP_SET=$((SMTP_SET + 1))
[ -n "${MAIL_FROM:-}" ] && SMTP_SET=$((SMTP_SET + 1))
if [ "$SMTP_SET" -eq 0 ]; then
  log_warning "SMTP_USER/SMTP_PASS/MAIL_FROM unset — no mail at all: magic-link sign-in hidden, and no"
  log_warning "  waitlist, approval or new-signup notifications will be sent. Google OAuth only."
elif [ "$SMTP_SET" -lt 3 ]; then
  log_error "SMTP is partially configured ($SMTP_SET/3). Set all of SMTP_USER, SMTP_PASS, MAIL_FROM, or none."
  exit 1
fi

# MAIL_FROM travels through printf into a compose .env, where a `<` or `#` does
# not mean what it means in a shell. mailer.ts composes the display name, so the
# bracketed form is never needed and is rejected here rather than producing a
# malformed SMTP envelope that only shows up in a recipient's headers.
case "${MAIL_FROM:-}" in
  *"<"*|*">"*|*"#"*)
    log_error "MAIL_FROM must be a bare address, not a display-name form. Got: ${MAIL_FROM}"
    exit 1
    ;;
esac

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
# check_ssh_key and get_ssh_cmd live in lib.sh; both scripts carried identical
# copies before blue/green gave them a third thing to agree about.
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

# The build's version, shown to riders in the footer and in the release-notes
# modal. `YYYY-MM-DD-HHMMPT` — the minute HEAD's history was assembled, on the
# clock Ziad keeps.
#
# Derived from the COMMIT rather than from the deploy, so redeploying the same
# tree reports the same version — it is the same code, and a string that moved
# would be a claim that something changed. Nothing is stored, so there is no
# counter to get out of step with reality.
#
# Pacific, and the suffix says so ALOUD. A bare timestamp is read in whatever
# zone the reader is sitting in, and a tester a few hours ahead would put the
# build they are running in the future. `PT` rather than `PDT`/`PST` because the
# zone database already swaps those for us and a rider does not care which half
# of the year it is — they care that it is not their own clock.
#
# Committer date, not author date: a rebase rewrites the second and leaves the
# first, and what this wants to say is when the build's history was actually
# assembled. The zone belongs on the `git` call, because `format-local` reads TZ.
BUILD_STAMP=$(TZ=America/Los_Angeles git show -s --format=%cd --date=format-local:%Y-%m-%d-%H%M HEAD 2>/dev/null || echo "")
if [ -n "$BUILD_STAMP" ]; then
  APP_VERSION="${BUILD_STAMP}PT"
else
  APP_VERSION="unknown"
fi
export APP_VERSION

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
  echo -e "   Version: ${BOLD}${APP_VERSION}${NC}"
  read -r -p "Type 'yes' to continue: " CONFIRM
  [ "$CONFIRM" = "yes" ] || { log_error "Aborted."; exit 1; }
fi

echo ""
echo -e "${CYAN}═══ ${PROJECT_NAME} → ${ENV_COLOR}${ENV_LABEL}${NC}${CYAN} ═══${NC}"
echo -e "  ${MAGENTA}Target${NC}    : ${TARGET_URL}"
echo -e "  ${MAGENTA}NAS path${NC}  : ${NAS_DEPLOY_PATH}"
echo -e "  ${MAGENTA}Colors${NC}    : ${BLUE_CONTAINER_NAME} / ${GREEN_CONTAINER_NAME}"
echo -e "  ${MAGENTA}Proxy${NC}     : ${PROXY_CONTAINER_NAME} (host 127.0.0.1:${HOST_PORT}, 127.0.0.1:${ALIAS_HOST_PORT})"
[ -n "${DRY_RUN:-}" ] && echo -e "  ${YELLOW}DRY RUN — nothing will be built, transferred, or restarted${NC}"
echo ""

# ------------------------------------------------- remote environment ------
# Composed here, above the dry-run exit, so `--dry-run` exercises the guard
# below. A check that only runs during a real deploy is one nobody can test.
# Supplies every ${VAR} in docker-compose.yml. Contains secrets → mode 600.
REMOTE_ENV=$(mktemp)
trap 'rm -f "$REMOTE_ENV"' EXIT
printf '%s\n' \
  "# Written by utils/deploy/deploy.sh — do not edit by hand." \
  "COMPOSE_PROJECT_NAME=${PROJECT_NAME}-${DEPLOY_ENV}" \
  "IMAGE_NAME=${IMAGE_NAME}" \
  "DB_CONTAINER_NAME=${DB_CONTAINER_NAME}" \
  "HOST_PORT=${HOST_PORT}" \
  "ALIAS_HOST_PORT=${ALIAS_HOST_PORT}" \
  "APP_UID=${APP_UID}" \
  "APP_GID=${APP_GID}" \
  "GMAPS_KEY=${GMAPS_KEY}" \
  "GMAPS_SERVER_KEY=${GMAPS_SERVER_KEY:-}" \
  "GMAPS_MAP_ID=${GMAPS_MAP_ID}" \
  "DB_PASSWORD=${DB_PASSWORD}" \
  "APP_ORIGIN=${APP_ORIGIN}" \
  "OWNER_EMAIL=${OWNER_EMAIL:-}" \
  "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" \
  "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}" \
  "SMTP_HOST=${SMTP_HOST:-}" \
  "SMTP_PORT=${SMTP_PORT:-}" \
  "SMTP_USER=${SMTP_USER:-}" \
  "SMTP_PASS=${SMTP_PASS:-}" \
  "MAIL_FROM=${MAIL_FROM:-}" \
  "APP_VERSION=${APP_VERSION}" \
  "BUILD_SHA=${GIT_SHA}" \
  "PURGE_ACCOUNTS=${PURGE_ACCOUNTS:-}" \
  "DRAIN_GRACE_MS=${DRAIN_GRACE_MS:-10000}" \
  "BLUE_CONTAINER_NAME=${BLUE_CONTAINER_NAME}" \
  "GREEN_CONTAINER_NAME=${GREEN_CONTAINER_NAME}" \
  "PROXY_CONTAINER_NAME=${PROXY_CONTAINER_NAME}" \
  "PROXY_IMAGE=${PROXY_IMAGE}" \
  "DB_VOLUME_NAME=${DB_VOLUME_NAME}" \
  > "$REMOTE_ENV"

# Verify the artifact, not the source. The list above is an explicit allow-list,
# so a dev-only variable cannot reach the server through this script — but that
# is a property of the list, and lists get edited. This asserts it of the bytes
# actually about to be written, which is the thing that matters.
#
# It replaces a check on the local .env that refused to deploy whenever
# DEV_LOGIN_EMAIL was set. That was wrong: the variable was never going to be
# shipped, so the check only ever cost a manual edit before every deploy — which
# is how a guard earns itself deleted.
for FORBIDDEN in DEV_LOGIN_EMAIL DEV_AUTH_EMAIL; do
  if grep -q "^${FORBIDDEN}=" "$REMOTE_ENV"; then
    log_error "${FORBIDDEN} is in the generated remote .env. That is a passwordless sign-in."
    log_error "Remove it from the allow-list in this script. Refusing to continue."
    rm -f "$REMOTE_ENV"
    exit 1
  fi
done


if [ -n "${DRY_RUN:-}" ]; then
  log_info "Would build ${IMAGE_NAME} (${DOCKER_PLATFORM}) from $PROJECT_ROOT"
  log_info "Would transfer the image + ${COMPOSE_SRC} to ${NAS_SSH_HOST}:${NAS_DEPLOY_PATH}"
  log_info "Would write ${NAS_DEPLOY_PATH}/.env (chmod 600) and restart the stack"
  log_info "Would converge db and proxy, then run the one-shot migrate service"
  log_info "Would deploy the idle color, gate it on /healthz reporting ${GIT_SHA},"
  log_info "  cut the proxy over, verify the origin, and drain the old color"
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
log_info "Writing compose file, proxy config and environment..."
cat "$PROJECT_ROOT/$COMPOSE_SRC" | $SSH_CMD "$NAS_SSH_HOST" "cat > ${NAS_DEPLOY_PATH}/docker-compose.yml"

# THE PROXY'S CONFIG DIRECTORY HAS TO EXIST AS A DIRECTORY AND upstream.caddy
# AS A FILE, BEFORE THE PROXY IS EVER STARTED. Compose bind-mounts
# ./proxy/upstream.caddy into the container; if that path does not exist on the
# host, Docker helpfully creates a DIRECTORY there — and Caddy then fails to
# read its own config with an error that says nothing about bind mounts. The
# seed points at blue because a first deploy has no live color to preserve;
# every deploy after this one finds the file already written and leaves it
# alone, because it is the only record of which color is serving.
$SSH_CMD "$NAS_SSH_HOST" "mkdir -p ${NAS_DEPLOY_PATH}/proxy"
cat "$PROJECT_ROOT/proxy/Caddyfile" | $SSH_CMD "$NAS_SSH_HOST" "cat > ${NAS_DEPLOY_PATH}/proxy/Caddyfile"
$SSH_CMD "$NAS_SSH_HOST" "test -f ${NAS_DEPLOY_PATH}/proxy/upstream.caddy || printf 'reverse_proxy %s:6686\n' '${BLUE_CONTAINER_NAME}' > ${NAS_DEPLOY_PATH}/proxy/upstream.caddy"

cat "$REMOTE_ENV" | $SSH_CMD "$NAS_SSH_HOST" "cat > ${NAS_DEPLOY_PATH}/.env && chmod 600 ${NAS_DEPLOY_PATH}/.env"

# --------------------------------------------------------------- deploy ------
#
# THE DATABASE IS NEVER TORN DOWN. This block used to be
# `docker-compose down || true` followed by `up -d`, and `down` takes the app
# container, the Postgres container AND the bridge network with it — after which
# `up -d` has to wait on `depends_on: db: condition: service_healthy` before the
# app can even start. That is where the 60–90 seconds of 502s came from. Nothing
# below stops db, so its healthcheck is already green and the app's dependency
# is satisfied the moment it starts.
#
# Order matters and is the point of the whole change: converge db, migrate,
# THEN recreate the app. See docs/zero-downtime-deploy.md.

log_info "Converging database container..."
$SSH_CMD "$NAS_SSH_HOST" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose up -d db" || {
  log_error "Could not bring up the database container. Refusing to continue."
  exit 1
}

# Poll rather than sleep. On a deploy where db was already running this returns
# on the first attempt; on a cold start it is the only thing standing between
# the migration and a connection refused.
log_info "Waiting for Postgres to report healthy..."
DB_READY=""
for _ in $(seq 1 60); do
  if $SSH_CMD "$NAS_SSH_HOST" "/usr/local/bin/docker exec ${DB_CONTAINER_NAME} pg_isready -U routeloop -d routeloop" >/dev/null 2>&1; then
    DB_READY="yes"; break
  fi
  sleep 1
done
if [ -z "$DB_READY" ]; then
  log_error "Postgres did not become ready within 60s. Refusing to migrate or deploy."
  $SSH_CMD "$NAS_SSH_HOST" "/usr/local/bin/docker logs --tail 30 ${DB_CONTAINER_NAME}" || true
  exit 1
fi
log_success "Database ready"

# ------------------------------------------------------------ migrations -----
#
# BEFORE the new code serves anything, which is the half of this that fixes a
# live bug rather than an inconvenience. This step used to run as a post-deploy
# hook via `docker exec` into the app container AFTER it was already serving, so
# a deploy carrying a migration had a window where new code answered requests
# against the old schema.
#
# Applying migrations is idempotent — migrate() records each one in
# drizzle.__drizzle_migrations and skips what is already there — so a re-run
# after a fixed failure is safe.
#
# Fatal on failure, and the wording below is carried over verbatim from the hook
# this replaced. That text is the record of a real outage (2026-08-03, when a
# non-fatal schema step let prod drift three sprints behind, serving 500s on
# every page that touched a table with a missing column). A deploy whose schema
# step failed has not succeeded.
log_info "Applying Drizzle migrations..."
if $SSH_CMD "$NAS_SSH_HOST" "cd ${NAS_DEPLOY_PATH} && /usr/local/bin/docker-compose run --rm --no-deps -T migrate"; then
  log_success "Migrations applied"
else
  log_error "Migration FAILED. Refusing to deploy code against a database that does not match it."
  log_error ""
  log_error "LOOK AT THE SCHEMA BEFORE YOU DO ANYTHING. Two of the three causes below"
  log_error "look identical from here and the fixes are opposites:"
  log_error ""
  log_error "  DEPLOY_ENV=${DEPLOY_ENV} utils/deploy/deploy-utils.sh schema-state"
  log_error ""
  log_error "  1. A STALE VOLUME was adopted — the tables are from an older pivot of the"
  log_error "     schema and the row counts are zero. Compose namespaces volumes by"
  log_error "     COMPOSE_PROJECT_NAME, not by deploy directory, so a \"fresh\" environment"
  log_error "     can come up on a months-old database. DO NOT BASELINE THIS. Drop the"
  log_error "     schemas and let the migrations build it from 0000:"
  log_error "       docker exec <db-container> psql -U routeloop -d routeloop -c \\"
  log_error "         'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;'"
  log_error "     Confirm the row counts really are zero first. This destroys the database."
  log_error ""
  log_error "  2. This database PREDATES drizzle/ and was never baselined, so migrate is"
  log_error "     trying to create tables that already exist. This is cause 1 with real"
  log_error "     data in it, and the schema must ALREADY match src/db/schema.ts — check"
  log_error "     that the table list is complete, not merely non-empty. Then, ONCE:"
  log_error "       DEPLOY_ENV=${DEPLOY_ENV} utils/deploy/deploy-utils.sh db-baseline"
  log_error "     A baseline records a claim it cannot verify: run it against a database"
  log_error "     that is actually behind and every later migration is skipped forever,"
  log_error "     leaving an app that 500s on columns that will never be created."
  log_error "     See docs/database.md."
  log_error ""
  log_error "  3. A migration genuinely failed against real data — a NOT NULL on a column"
  log_error "     holding nulls, or a unique constraint on duplicates. Fix it by editing"
  log_error "     the generated SQL to backfill first, not by forcing it through."
  log_error ""
  log_error "Re-run it and see the error in full:"
  log_error "  DEPLOY_ENV=${DEPLOY_ENV} utils/deploy/deploy-utils.sh migrate"
  log_error ""
  log_error "THE OLD CONTAINER IS STILL SERVING and still matches the old schema, so the"
  log_error "site is up. Nothing has been swapped."
  exit 1
fi

# ------------------------------------------------------------- the colors ----
#
# THE OLD CONTAINER IS NEVER RECREATED. It is replaced by whichever color is not
# currently serving, and the proxy is the last thing touched — so every failure
# before the cutover is a no-op on the live site.

LIVE_COLOR=$(resolve_live_color)
if [ -n "$FORCE_COLOR" ]; then
  TARGET_COLOR="$FORCE_COLOR"
  log_warning "Deploying to ${TARGET_COLOR} because --color was given, not because it is idle"
elif [ -z "$LIVE_COLOR" ]; then
  # FIRST DEPLOY ONTO THIS TOPOLOGY. Nothing is serving, so there is no idle
  # color and nothing to drain or roll back to — say so rather than inventing
  # one. Blue by convention, so a fresh environment is predictable.
  TARGET_COLOR="blue"
else
  TARGET_COLOR=$(other_color "$LIVE_COLOR")
fi
TARGET_SERVICE=$(service_for "$TARGET_COLOR")
TARGET_CONTAINER=$(container_for "$TARGET_COLOR")

if [ -n "$LIVE_COLOR" ]; then
  LIVE_SERVICE=$(service_for "$LIVE_COLOR")
  LIVE_CONTAINER=$(container_for "$LIVE_COLOR")
  log_info "Live: ${LIVE_COLOR} (${LIVE_CONTAINER}) → deploying ${TARGET_COLOR} (${TARGET_CONTAINER})"
else
  LIVE_SERVICE=""; LIVE_CONTAINER=""
  log_warning "Nothing is serving — this is a first deploy onto the blue/green topology."
  log_warning "There is no idle color to roll back to until the next deploy."
  log_info "Deploying ${TARGET_COLOR} (${TARGET_CONTAINER})"
fi

# Bring the proxy up if it is not already. Never a bare `up -d`: that would
# start every service in the file, and the two colors are exactly what must not
# both be started. They are behind Compose profiles for that reason, so naming
# them is the only way they run at all.
log_info "Converging proxy..."
nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE up -d --no-deps proxy" || {
  log_error "Could not bring up the proxy. Nothing has been swapped."
  exit 1
}

if [ -n "$NO_OVERLAP" ] && [ -n "$LIVE_COLOR" ]; then
  # THE ESCAPE HATCH, AND IT HAS REAL DOWNTIME. Used when a migration cannot be
  # made backward compatible, so the old code must never see the new schema.
  log_warning "--no-overlap: stopping ${LIVE_COLOR} BEFORE starting ${TARGET_COLOR}."
  log_warning "This deploy HAS DOWNTIME — roughly the boot time of one container."
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE stop ${LIVE_SERVICE}" || true
fi

log_info "Starting ${TARGET_COLOR}..."
nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE up -d --no-deps --force-recreate ${TARGET_SERVICE}" || {
  log_error "Failed to start ${TARGET_COLOR}."
  nas "$DOCKER logs --tail 50 ${TARGET_CONTAINER}" || true
  [ -n "$LIVE_COLOR" ] && log_error "The proxy was never touched — ${LIVE_COLOR} is still serving."
  exit 1
}

# --------------------------------------------------------- the health gate ---
#
# ASKED OF THE CONTAINER DIRECTLY, not through the proxy, because the proxy is
# still pointed at the OLD color — a probe through it would cheerfully report
# the old container healthy and pass a gate that has tested nothing.
#
# The SHA assertion is the part that earns its keep: a 200 alone proves only
# that something is listening, and a Compose that decided the service was
# up-to-date would answer 200 with the old build.
log_info "Health-gating ${TARGET_COLOR} for ${GIT_SHA} (direct, not through the proxy)..."
GATE_OK=""
GATE_LAST=""
for _ in $(seq 1 60); do
  GATE_LAST=$(color_health "$TARGET_COLOR")
  case "$GATE_LAST" in
    *"\"build\":\"${GIT_SHA}\""*) GATE_OK="yes"; break ;;
  esac
  sleep 1
done

if [ -z "$GATE_OK" ]; then
  log_error "${TARGET_COLOR} did not report healthy with build ${GIT_SHA} within 60s."
  log_error "Last response: ${GATE_LAST:-<none>}"
  nas "$DOCKER logs --tail 50 ${TARGET_CONTAINER}" || true
  echo ""
  if [ -n "$LIVE_COLOR" ]; then
    log_warning "The new color failed its health gate and the proxy was never touched —"
    log_warning "the site is still serving ${LIVE_COLOR} and never blinked."
  else
    log_warning "The new color failed its health gate. Nothing was serving before it,"
    log_warning "so this environment is down until a color comes up."
  fi
  log_warning ""
  log_warning "BUT: migrations already ran. This environment's schema is now AHEAD of"
  log_warning "the code serving it. That is safe only if the migration was backward"
  log_warning "compatible — which is exactly what the expand/contract rule in"
  log_warning "AGENTS.md exists to guarantee. If it was not, roll the schema back by"
  log_warning "hand before doing anything else."
  exit 1
fi
log_success "${TARGET_COLOR} is healthy and reporting ${GIT_SHA}"

# --------------------------------------------------------------- cutover -----
log_info "Pointing the proxy at ${TARGET_COLOR}..."
if ! point_proxy_at "$TARGET_COLOR"; then
  log_error "Cutover failed. ${LIVE_COLOR:-nothing} is still serving and the site never blinked."
  exit 1
fi

# --------------------------------------------------------------- verify ------
#
# Through the HOST PORT this time — the one the tunnel actually targets — so
# this proves the whole path rather than the container in isolation.
log_info "Verifying through the tunnel origin on 127.0.0.1:${HOST_PORT}..."
VERIFY_OK=""
VERIFY_LAST=""
for _ in $(seq 1 30); do
  VERIFY_LAST=$(nas "curl -fsS --max-time 5 http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null || true)
  case "$VERIFY_LAST" in
    *"\"build\":\"${GIT_SHA}\""*) VERIFY_OK="yes"; break ;;
  esac
  sleep 1
done

if [ -z "$VERIFY_OK" ]; then
  log_error "The origin is not serving ${GIT_SHA} after the cutover."
  log_error "Last response: ${VERIFY_LAST:-<none>}"
  if [ -z "$LIVE_COLOR" ]; then
    log_error "There is no previous color to roll back to — this was a first deploy."
    exit 1
  fi
  log_warning "Rolling the proxy back to ${LIVE_COLOR}..."
  if point_proxy_at "$LIVE_COLOR"; then
    log_success "Rolled back — ${LIVE_COLOR} is serving again."
  else
    log_error "ROLLBACK ALSO FAILED. Do this by hand, now:"
    log_error "  DEPLOY_ENV=${DEPLOY_ENV} utils/deploy/deploy-utils.sh cutover ${LIVE_COLOR}"
  fi
  exit 1
fi
log_success "Origin serving ${TARGET_COLOR} on 127.0.0.1:${HOST_PORT}, reporting ${GIT_SHA}"

# ------------------------------------------------------------ drain the old --
#
# LAST, AND ONLY AFTER THE VERIFY PASSED. Until this line the old color is still
# running and one `cutover` away from taking traffic back, which is the whole
# rollback story. `docker-compose stop` sends SIGTERM and waits out
# stop_grace_period, so the requests it is still holding finish — see
# src/shutdown.ts.
if [ -z "$NO_OVERLAP" ] && [ -n "$LIVE_COLOR" ]; then
  log_info "Draining ${LIVE_COLOR}..."
  nas "cd ${NAS_DEPLOY_PATH} && $COMPOSE stop ${LIVE_SERVICE}" || log_warning "Could not stop ${LIVE_COLOR} — it is idle, so this is not fatal."
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
echo -e "  Version       : ${BOLD}${APP_VERSION}${NC}"
echo -e "  Serving       : ${TARGET_COLOR} (${TARGET_CONTAINER}) → 127.0.0.1:${HOST_PORT}"
if [ -n "$LIVE_COLOR" ]; then
  # STOPPED, not warm. The drain above stops it once the origin verify passes,
  # which is deliberate — two live app containers on this NAS is memory spent on
  # nothing, and the next deploy force-recreates the idle one anyway. Rolling
  # back is therefore start-then-cutover rather than cutover alone, so the
  # command is printed rather than described.
  echo -e "  Previous      : ${LIVE_COLOR} (${LIVE_CONTAINER}), drained and stopped"
  echo -e "  ${DIM}Roll back:      docker-compose up -d --no-deps ${LIVE_SERVICE}${NC}"
  echo -e "  ${DIM}                then deploy-utils.sh cutover ${LIVE_COLOR}${NC}"
else
  echo -e "  Previous      : none — first deploy onto this topology"
fi
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
