#!/usr/bin/env bash
#
# R0.10 local deployment/recovery drill. This does not deploy to an external
# staging host and never enables live/provider transport.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

exec node "$REPO_ROOT/scripts/operational-data.mjs" drill
