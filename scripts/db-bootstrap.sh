#!/usr/bin/env bash
#
# FdbTrade local database bootstrap (P01-03).
#
# Starts the isolated `fdbtrade` Docker Compose project (postgres:16), waits
# for a healthy database, and applies migrations from zero. Never prints or
# logs credential values; the git-ignored `.env` is the only secret carrier.
#
# Usage: scripts/db-bootstrap.sh up|down|status|reset --yes
#
# Behaviour:
#   up      create `.env` from the template if missing (random DB password),
#           start postgres (compose --wait), then run `db:migrate`.
#   down    stop the fdbtrade postgres (data volume preserved).
#   status  show compose service state.
#   reset   DANGER: down AND delete the data volume (requires `--yes`).
#
# Deterministic, UTC timestamps, no secrets in output.

set -euo pipefail

ME="$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_TEMPLATE="$REPO_ROOT/infra/.env.example"
COMPOSE_FILE="$REPO_ROOT/infra/compose.yaml"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

usage() {
  cat <<EOF
$ME - FdbTrade local database bootstrap

Usage: $ME up|down|status|reset [--yes]

  up            start postgres (creates .env from the template if missing)
                and apply migrations from zero
  down          stop the fdbtrade postgres (data volume preserved)
  status        show compose service state
  reset --yes   stop postgres AND delete the data volume (destructive)
EOF
}

generate_env_if_missing() {
  if [[ -f "$ENV_FILE" ]]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] using existing $ENV_FILE"
    return
  fi
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] creating .env from infra/.env.example"
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  local password
  if command -v openssl >/dev/null 2>&1; then
    password="$(openssl rand -hex 16)"
  else
    password="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  # Replace the (empty) development password placeholder with a random value.
  # Written only to the git-ignored .env; never echoed.
  sed -i "s|^FDB_DB_PASSWORD=.*|FDB_DB_PASSWORD=${password}|" "$ENV_FILE"
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] generated random FDB_DB_PASSWORD into .env (value not shown)"
}

wait_for_postgres() {
  local user db deadline
  # Read only the non-secret identifiers needed for pg_isready.
  user="$(grep -E '^FDB_DB_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  db="$(grep -E '^FDB_DB_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  deadline=$(( $(date +%s) + 60 ))
  until docker exec fdbtrade-postgres pg_isready -U "${user:-fdbtrade}" -d "${db:-fdbtrade}" >/dev/null 2>&1; do
    if (( $(date +%s) > deadline )); then
      echo "$ME: postgres did not become ready in time" >&2
      exit 1
    fi
    sleep 1
  done
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] postgres is ready"
}

cmd_up() {
  generate_env_if_missing
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] starting fdbtrade postgres (isolated compose project)"
  "${COMPOSE[@]}" up -d --wait
  wait_for_postgres
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] applying migrations from zero"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  (cd "$REPO_ROOT" && pnpm --filter @fdbtrade/backend run db:migrate)
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] database bootstrap complete"
}

cmd_down() {
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] stopping fdbtrade postgres (data volume preserved)"
  "${COMPOSE[@]}" down
}

cmd_status() {
  "${COMPOSE[@]}" ps
}

cmd_reset() {
  if [[ "${2:-}" != "--yes" ]]; then
    echo "$ME: reset deletes the data volume; run as: $ME reset --yes" >&2
    exit 2
  fi
  echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] deleting fdbtrade postgres AND its data volume"
  "${COMPOSE[@]}" down -v
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  reset) cmd_reset "$@" ;;
  ""|-h|--help) usage; exit 0 ;;
  *) echo "$ME: unknown command: $1" >&2; usage >&2; exit 2 ;;
esac
