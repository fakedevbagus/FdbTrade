# Current Project State

## Last verified task
P00-03 — Create configuration and environment contract

## Evidence
See `COMPLETION_REPORT.md` for the P00-03 results (`make check` green; 46 tests
OK). The typed server-side config contract lives in `infra/config/` with
`infra/.env.example`.

## Verified next task
P00-04 — Establish CI baseline and ADR system

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
