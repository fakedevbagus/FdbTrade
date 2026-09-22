#!/usr/bin/env bash
# Compatibility wrapper for the R0.4 local SQLite authority.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:-up}"

case "$COMMAND" in
    up|migrate)
        exec corepack pnpm --dir "$REPO_ROOT" --filter @fdbtrade/backend run db:migrate
        ;;
    status)
        exec corepack pnpm --dir "$REPO_ROOT" --filter @fdbtrade/backend run db:status
        ;;
    down)
        echo "SQLite is embedded; there is no database daemon to stop."
        ;;
    --help|-h)
        echo "Usage: bash scripts/db-bootstrap.sh [up|migrate|status|down]"
        ;;
    *)
        echo "Unknown database command: $COMMAND" >&2
        exit 2
        ;;
esac
