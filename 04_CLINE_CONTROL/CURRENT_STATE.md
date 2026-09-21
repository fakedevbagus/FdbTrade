# Current Project State

## Last verified task
M47 — Seven-major runtime coverage

## Evidence
See `COMPLETION_REPORT.md` and `02_REPORTS/M47_COMPLETION_REPORT.md`.
All gates exit 0 on 2026-09-21:
- `make seven-majors-check` — seven-major runtime isolation, bounded shedding, measured quarantine, dashboard pair filter
- `make runtime-check`, `make operational-persistence-check`, `make integration-replay-check`, `make historical-research-check`
- `make lint`, `make typecheck`, `make format-check`, `make test`, `make build`
- `make operational-packaging-check`, `make private-beta-check`, `make dashboard-check`, `make security-check`, `make phase2-check`, `make handoff-check`
Checkpoint: `docs/checkpoints/47_seven_major_runtime.md`.
ADR: `docs/adr/ADR-0036-seven-major-runtime-coverage.md`.
Safety: live execution OFF, provider order transport OFF, loopback-only, paper-only.
The operational slice is exactly the seven configured majors with fixture provenance; M47 adds no durable state (restart = re-derivation).

## Verified next task
M48 — Credentialed read-only provider shadow (authorized; NOT started — do not begin in the same agent run)

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
