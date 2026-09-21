#!/usr/bin/env bash
# FdbTrade reproducible bootstrap wrapper (M44).
#
# Responsibilities:
#   - create or validate the local Python virtual environment (.venv)
#   - install only the locked Python dependencies declared in requirements.txt
#   - install the locked Node dependencies from pnpm-lock.yaml
#   - create .env from the committed template when it is missing
#
# Guarantees:
#   - never requests, generates, prints or stores a secret
#   - deterministic and idempotent: re-running converges to the same state
#   - offline-safe: no network call happens when there is nothing to install
#   - --dry-run validates and prints the plan while mutating nothing
#
# Dependency-manager note: the frozen blueprint words this step as `npm ci`.
# This repository's approved dependency manager is pnpm (ADR-0001, ADR-0002) and
# it ships pnpm-lock.yaml, not package-lock.json, so `npm ci` cannot reproduce
# an install here. The deterministic equivalent `pnpm install --frozen-lockfile`
# is used instead; the substitution is recorded in ADR-0033.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$REPO_ROOT/.venv"
ENV_FILE="$REPO_ROOT/.env"
ENV_TEMPLATE="$REPO_ROOT/infra/.env.example"
REQUIREMENTS="$REPO_ROOT/requirements.txt"
DRY_RUN=0

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --help|-h)
            echo "Usage: bash scripts/bootstrap.sh [--dry-run]"
            echo "  --dry-run  validate prerequisites and print the plan without mutating anything"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "Usage: bash scripts/bootstrap.sh [--dry-run]" >&2
            exit 2
            ;;
    esac
done

log() {
    echo "[$(date -u +'%Y-%m-%dT%H:%MZ')] $*"
}

# True when requirements.txt declares at least one installable (non-comment,
# non-blank) line. An installable-free file is valid policy here: the Python
# side is stdlib-only, and `pip install -r` would otherwise abort with
# "You must give at least one requirement to install".
has_installable_requirements() {
    local file="$1" line
    [[ -f "$file" ]] || return 1
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%%#*}"
        line="$(printf '%s' "$line" | tr -d '[:space:]')"
        [[ -z "$line" ]] && continue
        return 0
    done < "$file"
    return 1
}

log "FdbTrade reproducible bootstrap (M44)"
if [[ "$DRY_RUN" -eq 1 ]]; then
    log "MODE: --dry-run (validation only, nothing will be modified)"
fi

# 0. Required tools must be present before anything is mutated.
for tool in python3 node corepack; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        log "ERROR: required tool '$tool' not found on PATH"
        exit 1
    fi
done
log "Prerequisites present: python3 $(python3 --version 2>&1 | awk '{print $2}'), node $(node --version), corepack $(corepack --version)"

# 1. Create or validate the Python virtual environment.
if [[ -d "$VENV_DIR" ]]; then
    if [[ -x "$VENV_DIR/bin/python" ]]; then
        log "Virtual environment valid at $VENV_DIR"
    else
        log "ERROR: $VENV_DIR exists but has no working bin/python; remove it and re-run"
        exit 1
    fi
elif [[ "$DRY_RUN" -eq 1 ]]; then
    log "PLAN: create virtual environment at $VENV_DIR"
else
    log "Creating virtual environment at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
    log "Virtual environment created"
fi

# 2. Install only the declared, locked Python dependencies.
if has_installable_requirements "$REQUIREMENTS"; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
        log "PLAN: pip install -r requirements.txt (locked pins only)"
    else
        log "Installing declared Python dependencies from requirements.txt"
        "$VENV_DIR/bin/pip" install --quiet -r "$REQUIREMENTS"
        log "Python dependencies installed"
    fi
else
    log "No installable Python requirements: quant/tests/scripts are stdlib-only (nothing to install)"
fi

# 3. Install the locked Node dependencies (deterministic; fails on lockfile drift).
if [[ ! -f "$REPO_ROOT/pnpm-lock.yaml" ]]; then
    log "ERROR: pnpm-lock.yaml missing; a locked install cannot be reproduced"
    exit 1
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
    log "PLAN: pnpm install --frozen-lockfile"
else
    log "Installing locked Node dependencies through the bounded R0.3 toolchain"
    python3 "$REPO_ROOT/scripts/rebuild_toolchain.py" install
    log "Node dependencies installed"
fi

# 4. Ensure .env exists. The committed template carries placeholders only; no
#    secret is generated, requested or printed here.
if [[ -f "$ENV_FILE" ]]; then
    log "Using existing .env (left untouched)"
elif [[ -f "$ENV_TEMPLATE" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
        log "PLAN: create .env from infra/.env.example (placeholders only, no secrets)"
    else
        log "Creating .env from infra/.env.example (placeholders only, no secrets)"
        cp "$ENV_TEMPLATE" "$ENV_FILE"
        log ".env created from template"
    fi
else
    log "ERROR: neither .env nor infra/.env.example found"
    exit 1
fi

# 5. Report safe next steps. Execution authority is unchanged.
log "Safety: LIVE_EXECUTION_ENABLED=false | PROVIDER_ORDER_TRANSPORT_ENABLED=false | loopback-only"
if [[ "$DRY_RUN" -eq 1 ]]; then
    log "Dry run complete: no changes were made"
else
    log "Bootstrap complete"
fi
log "Next: make preflight | scripts/fdbtrade start | scripts/fdbtrade status | make check"
exit 0
