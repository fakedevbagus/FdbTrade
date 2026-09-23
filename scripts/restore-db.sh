#!/usr/bin/env bash
# R0.10 verified restore. The target must be absolute and empty.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: scripts/restore-db.sh ABSOLUTE_BACKUP_DIRECTORY ABSOLUTE_EMPTY_DATA_ROOT" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO_ROOT/scripts/operational-data.mjs" restore \
  --backup "$1" --target-data-root "$2"
