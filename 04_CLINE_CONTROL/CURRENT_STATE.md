# Current Project State

## Last verified task
P00-04 — Establish CI baseline and ADR system

## Evidence
See `COMPLETION_REPORT.md` for the P00-04 results (`make check` green; 65 tests
OK). CI: `ci/run-local.sh` (local deterministic runner) and
`.github/workflows/ci.yml` (four required blocking jobs). ADR system:
`docs/adr/README.md`, `02_TEMPLATES/ADR_TEMPLATE.md`, ADR-0003..0006.

## Verified next task
P01-01 — Build web application shell

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
