#!/usr/bin/env bash
# R0.10 consistent SQLite + immutable-artifact backup.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: scripts/backup-db.sh ABSOLUTE_OUTPUT_ROOT" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO_ROOT/scripts/operational-data.mjs" backup --output-root "$1"
