#!/usr/bin/env bash
# R0.4 fail-closed boundary: the legacy PostgreSQL dump path is retired.
set -euo pipefail

echo "[backup-db] unavailable: legacy PostgreSQL backup was retired in R0.4." >&2
echo "[backup-db] no SQLite backup/restore authority is approved yet." >&2
exit 2
