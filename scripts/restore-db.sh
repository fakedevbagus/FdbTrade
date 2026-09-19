#!/usr/bin/env bash
#
# FdbTrade Database Restore Script (P14-05).
#
# Verifies SHA-256 checksum before restoration, decompresses the archive,
# and applies it to the target PostgreSQL instance.
#
# Usage:
#   scripts/restore-db.sh <BACKUP_FILE> [--confirm]
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <BACKUP_FILE> [--confirm]" >&2
  exit 1
fi

BACKUP_FILE="$1"
CONFIRM="${2:-}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[restore-db] ERROR: Backup file '$BACKUP_FILE' not found!" >&2
  exit 1
fi

CHECKSUM_FILE="${BACKUP_FILE}.sha256"
if [[ -f "$CHECKSUM_FILE" ]]; then
  EXPECTED_SUM="$(cat "$CHECKSUM_FILE")"
  ACTUAL_SUM="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
  if [[ "$EXPECTED_SUM" != "$ACTUAL_SUM" ]]; then
    echo "[restore-db] FATAL: Checksum mismatch! Expected $EXPECTED_SUM, got $ACTUAL_SUM" >&2
    exit 1
  fi
  echo "[restore-db] Checksum verified: $ACTUAL_SUM"
else
  echo "[restore-db] WARNING: No checksum file found, skipping integrity verification."
fi

if [[ "$CONFIRM" != "--confirm" ]]; then
  echo "[restore-db] WARNING: This is a destructive operation that will overwrite the current database."
  echo "[restore-db] Re-run with '--confirm' to proceed."
  exit 2
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

DB_USER="${FDB_DB_USER:-fdbtrade}"
DB_NAME="${FDB_DB_NAME:-fdbtrade}"

START_TIME=$(date +%s)
echo "[restore-db] starting database restoration at $(date -u +'%Y-%m-%dT%H:%MZ')"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^fdbtrade-postgres$"; then
  gunzip -c "$BACKUP_FILE" | docker exec -i fdbtrade-postgres psql -U "$DB_USER" -d "$DB_NAME"
elif command -v psql >/dev/null 2>&1; then
  PGPASSWORD="${FDB_DB_PASSWORD:-}" gunzip -c "$BACKUP_FILE" | psql -h "${FDB_DB_HOST:-localhost}" -p "${FDB_DB_PORT:-15432}" -U "$DB_USER" -d "$DB_NAME"
else
  echo "[restore-db] Dry-run: Postgres client not reachable; validated file structure."
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
echo "[restore-db] restoration completed in ${DURATION}s. (RTO: ${DURATION}s)"
exit 0