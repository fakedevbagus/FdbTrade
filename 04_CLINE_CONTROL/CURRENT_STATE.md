# Current Project State

## Last verified task
M45 — Continuous scheduler and runtime hardening

## Evidence
See `COMPLETION_REPORT.md` and `02_REPORTS/M45_COMPLETION_REPORT.md`.
All M45 acceptance gates exit 0:
- `make runtime-check` exit 0 (56 Vitest + 10 Python contract tests)
- `make operational-persistence-check` exit 0 (17 Python DB foundation tests)
- `make integration-replay-check` exit 0 (64 Vitest backtest/fixture tests)
- `make operational-packaging-check` exit 0
- `make private-beta-check` exit 0 (live=false, transport=false)
- `make dashboard-check` exit 0
- `make security-check` exit 0
- `make phase2-check` exit 0
- `make handoff-check` exit 0
- `make format-check` exit 0
Checkpoint: `docs/checkpoints/45_continuous_scheduler.md`.
ADR: `docs/adr/ADR-0034-continuous-scheduler-and-runtime-hardening.md`.
Safety: live execution OFF, provider order transport OFF, loopback-only, paper-only.
Continuous scheduler disabled by default; opt-in via `FDB_CONTINUOUS_SCHEDULER_ENABLED=true`.

## Verified next task
M46 — User-facing historical research workflow (authorized; NOT started — do not
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
