#!/usr/bin/env bash
#
# FdbTrade local deterministic CI runner (P00-04).
#
# Creates a clean-room copy of the source tree (excluding .git, node_modules,
# virtualenvs, build caches, and .env) and runs the required CI jobs through the
# root Makefile targets: lint, typecheck, test, build.
#
# Behaviour:
#   * Blocks (fail-fast, non-zero exit) on any failing required job.
#   * Deterministic for deterministic inputs.
#   * All output timestamps are UTC.
#   * Never reads or prints secrets; .env is excluded from the copy.
#
# Usage:
#   ci/run-local.sh [--src DIR] [--work DIR] [--jobs a,b,c] [--skip-install]
#
#   --src DIR          source tree to copy (default: repository root)
#   --work DIR         destination workspace (default: fresh temp dir)
#   --jobs a,b,c       comma-separated make targets (default: lint,typecheck,test,build)
#   --skip-install     do not run `pnpm install` before the jobs
#   --help             show this help and exit
set -euo pipefail

ME="$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT"
WORK=""
JOBS="lint,typecheck,test,build"
SKIP_INSTALL=0

usage() {
  cat <<EOF
$ME - FdbTrade local CI runner

Usage: $ME [--src DIR] [--work DIR] [--jobs a,b,c] [--skip-install] [--help]

Options:
  --src DIR         source tree to copy (default: repo root)
  --work DIR        destination workspace (default: temp dir)
  --jobs a,b,c      make targets to run (default: lint,typecheck,test,build)
  --skip-install    do not run 'pnpm install' before the jobs
  --help            show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="${2:?--src requires a path}"; shift 2 ;;
    --work) WORK="${2:?--work requires a path}"; shift 2 ;;
    --jobs) JOBS="${2:?--jobs requires a value}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "$ME: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

IFS=',' read -r -a JOB_LIST <<< "$JOBS"
if [[ "${#JOB_LIST[@]}" -eq 0 ]]; then
  echo "$ME: no jobs selected" >&2
  exit 2
fi

if [[ -z "$WORK" ]]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/fdbtrade-ci.XXXXXX")"
fi
mkdir -p "$WORK"

echo "[ci] source:  $SRC"
echo "[ci] work:    $WORK"
echo "[ci] jobs:    ${JOB_LIST[*]}"

# Clean-room copy: source minus repository/cache dirs and any local .env.
tar -C "$SRC" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.venv' \
  --exclude='./venv' \
  --exclude='__pycache__' \
  --exclude='./dist' \
  --exclude='./build' \
  --exclude='./out' \
  --exclude='./.next' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='*.pyc' \
  -cf - . | (cd "$WORK" && tar -xf -)

cd "$WORK"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  echo "[ci] installing dependencies (frozen lockfile)"
  pnpm install --frozen-lockfile
fi

run_job() {
  local job="$1"
  echo "[ci] running job '$job' (UTC: $(date -u +'%Y-%m-%dT%H:%MZ'))"
  make "$job"
}

for job in "${JOB_LIST[@]}"; do
  if ! run_job "$job"; then
    echo "[ci] FAILED: job '$job'" >&2
    exit 1
  fi
done

echo "[ci] all required jobs passed: ${JOB_LIST[*]}"