# Current Project State

## Last verified task
M44 — Reproducible bootstrap and beta onboarding

## Evidence
See `COMPLETION_REPORT.md` and `02_REPORTS/M44_COMPLETION_REPORT.md`.
`make bootstrap` exit 0 (`.venv` created, locked install up to date); all seven M44
acceptance gates exit 0; `make check` exit 0 (Python 511 tests OK, TypeScript 1320
tests passed, 1831 total).
Checkpoints: `docs/checkpoints/43_private_beta.md`, `docs/checkpoints/44_bootstrap.md`.
ADR: `docs/adr/ADR-0033-reproducible-bootstrap-and-beta-onboarding.md`.
Operator guide: `docs/OPERATOR_GUIDE.md`. Entry points: `make bootstrap`,
`make preflight`, `scripts/fdbtrade`.
Safety: live execution OFF, provider order transport OFF, loopback-only, paper-only.

## Verified next task
M45 — Continuous scheduler and runtime hardening (authorized; NOT started — do not
begin in the same agent run)

## Environment facts
- Linux Mint 22.3 / Ubuntu noble base
- Node 24.19.0
- pnpm 11.22.0
- Python 3.12.3
- PostgreSQL client 16.15; PostgreSQL 16 available via Docker image
- Redis client 7.0.15; Redis server via Docker
- Docker 29.8.0 / Compose 5.5.1
- NTFS/fuseblk workspace, no symlinks
- No GPU assumed
- MT5 terminal not present
- PyPI reachable but slow

Do not overwrite these facts unless a new live inspection verifies a change.
