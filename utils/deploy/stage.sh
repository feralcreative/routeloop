#!/usr/bin/env bash
# routeloop — staging deploy wrapper (stage.routeloop.app). Pass --dry-run to preview.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEPLOY_ENV="stage"
exec "$SCRIPT_DIR/deploy.sh" "$@"
