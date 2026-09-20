# Current Project State

## Last verified task
M46 — User-facing historical research workflow

## Evidence
See `COMPLETION_REPORT.md` and `02_REPORTS/M46_COMPLETION_REPORT.md`.
Focused M46 gates exit 0:
- `make historical-research-check` — historical import, immutable registry, replay, and backtest provenance
- `make runtime-check`, `make operational-persistence-check`, `make integration-replay-check`
- `make operational-packaging-check`, `make private-beta-check`, `make dashboard-check`, `make security-check`, `make phase2-check`, `make handoff-check`
Checkpoint: `docs/checkpoints/46_historical_research.md`.
ADR: `docs/adr/ADR-0035-user-facing-historical-research-workflow.md`.
Safety: live execution OFF, provider order transport OFF, loopback-only, paper-only.
Historical CSV datasets are immutable, operator-owned, and never silently fall back to fixtures.

## Verified next task
M47 — Seven-major runtime coverage (authorized; NOT started — do not begin in the same agent run)

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
