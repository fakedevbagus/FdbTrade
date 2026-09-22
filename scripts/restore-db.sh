#!/usr/bin/env bash
# R0.4 fail-closed boundary: restoration must not claim success without an
# approved, verified SQLite backup format and recovery procedure.
set -euo pipefail

echo "[restore-db] unavailable: legacy PostgreSQL restore was retired in R0.4." >&2
echo "[restore-db] no SQLite backup/restore authority is approved yet." >&2
exit 2
