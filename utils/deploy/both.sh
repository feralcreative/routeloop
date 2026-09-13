#!/usr/bin/env bash
# routeloop — deploy BOTH environments, one after the other, from one command.
#
# PROD FIRST, THEN STAGE, BY DEFAULT — and that order is the reason this exists.
# Stage runs on production's database and applies no migration (RUNS_DATABASE
# gates converge, readiness and migrate together, see deploy.config), so when
# main carries a schema change, stage deployed first is new code on the old
# schema and fails its own health gate. Prod first runs the migration; stage
# then lands on the schema it expects. Every deploy that touches src/db/schema.ts
# goes through this script in this order.
#
# `--stage-first` reverses it, for a deploy with no migration where you want to
# see the build on stage before it reaches riders. It refuses when the tree
# carries a migration main has not shipped, because that is precisely the case
# the default order exists for — and a refusal beats a health gate failing
# five minutes into the second half.
#
# EACH HALF IS THE ORDINARY WRAPPER (prod.sh, stage.sh) with every flag passed
# through, so --dry-run, --force and --no-overlap mean what they always mean.
# The second half does not run if the first fails: a stage deploy after a
# failed prod one would put stage ahead of prod on the shared database.
#
#   utils/deploy/both.sh                 # prod, then stage
#   utils/deploy/both.sh --stage-first   # stage, then prod (no migration only)
#   utils/deploy/both.sh --dry-run       # both halves in preview
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STAGE_FIRST=0
PASS=()
for arg in "$@"; do
  case "$arg" in
    --stage-first) STAGE_FIRST=1 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--stage-first] [deploy.sh flags: --dry-run --force --no-overlap --color=blue|green]"
      exit 0 ;;
    *) PASS+=("$arg") ;;
  esac
done

# A migration the last prod deploy has not applied. `drizzle/*.sql` files
# added since the commit prod is serving — read off /healthz so the answer is
# about what is RUNNING, not about what is merged. Unreachable prod (a laptop
# off the network) is treated as "unknown" and the reversed order is refused,
# because guessing wrong here is a broken stage on a live database.
pending_migration() {
  local prod_sha
  prod_sha="$(curl -fsS --max-time 10 https://routeloop.app/healthz 2>/dev/null | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')"
  if [[ -z "$prod_sha" ]]; then
    echo "unknown"
    return
  fi
  if ! git -C "$REPO_ROOT" cat-file -e "${prod_sha}^{commit}" 2>/dev/null; then
    echo "unknown"
    return
  fi
  git -C "$REPO_ROOT" diff --name-only "$prod_sha" HEAD -- drizzle/ | grep -c '\.sql$' || true
}

if [[ "$STAGE_FIRST" == "1" ]]; then
  pending="$(pending_migration)"
  if [[ "$pending" == "unknown" ]]; then
    echo "both.sh: cannot read the commit prod is serving, so cannot tell whether a migration is pending." >&2
    echo "         --stage-first is refused; run without it (prod first) or check /healthz by hand." >&2
    exit 1
  fi
  if [[ "$pending" != "0" ]]; then
    echo "both.sh: $pending migration file(s) not yet on prod. Stage runs on prod's database and applies none," >&2
    echo "         so stage first would be new code on the old schema. Run without --stage-first." >&2
    exit 1
  fi
  echo "==> stage"
  "$SCRIPT_DIR/stage.sh" "${PASS[@]+"${PASS[@]}"}"
  echo "==> prod"
  "$SCRIPT_DIR/prod.sh" "${PASS[@]+"${PASS[@]}"}"
else
  echo "==> prod"
  "$SCRIPT_DIR/prod.sh" "${PASS[@]+"${PASS[@]}"}"
  echo "==> stage"
  "$SCRIPT_DIR/stage.sh" "${PASS[@]+"${PASS[@]}"}"
fi
