# ADR-0001: Baseline stack for FdbTrade

- Status: Proposed (P00-01) — stack facts verified against the actual environment; no code installed yet
- Date: 2026-09-07 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`, `ENVIRONMENT.md`, Prompt Pack P00-01

## Context

FdbTrade is a private, single-user trading intelligence OS built from the approved
Blueprint v2.0. The blueprint locks the target stack. This ADR records the baseline
stack decision and the environment-verified facts behind it, without claiming any
capability that is not actually present on the machine (see `ENVIRONMENT.md`).

Verified environment: Linux Mint 22.3 x86_64, node v24.19.0 + pnpm 11.22.0,
python 3.12.3, Docker 29.8.0 (daemon running, Compose v5.5.1), local `postgres:16` and
`redis:7` Docker images, psql 16 client. Absent: yarn, bun, uv, local redis-server
binary, MinIO/S3, GPU, MT5 terminal. Workspace is on an NTFS (fuseblk) volume: no
symlinks, no Unix permission bits.

## Decision

Adopt the Blueprint v2 stack as the baseline, with environment-verified runner
selections:

| Layer | Decision | Runner/tool choice |
|---|---|---|
| Web UI + BFF/API | Next.js (React) + TypeScript | node v24 + pnpm (yarn/bun absent) |
| Quant engine + workers | Python (FastAPI services, batch workers) | python 3.12 + pip3/venv; PyPI is slow — prefer Docker/wheels and retries |
| Primary datastore | PostgreSQL 16 | Docker container `postgres:16` (image already local); psql 16 client |
| Cache / queue | Redis 7 | Docker container `redis:7` (no local redis-server binary) |
| Object storage / artifacts | Local filesystem artifacts for P0–P4 | No MinIO/S3 assumed; upgrade later via ADR only |
| Research/backtest runtime | Docker on this host | CPU-only; no GPU claim |
| Broker bridge | MT5 adapter pattern, fixtures/mocks first | MT5 terminal absent on host; real adapter deferred to P15+ with health checks |
| Source control | git 2.43.0 on NTFS volume | `core.fileMode=false`, no symlinks allowed in repo tree |
| Live execution | OFF by default | Enforced by config/phase gates, not this ADR's tooling |

Free-first posture (Blueprint §28): P0–P11 run on $0 local Docker + fixtures + paper
trading; paid infra only when a later prompt explicitly requires it.

## Consequences

- Monorepo will host JS (pnpm workspace) and Python (venv) trees side by side; exact
  layout is recorded in ADR-0002 (P00-02), not here.
- `postgres:16` and `redis:7` Docker images run as disposable local services; data
  volumes live on the NTFS workspace with documented performance caveat.
- Python dependency fetches must tolerate slow PyPI (timeouts, retries, wheel cache).
- No component may assume symlinks, executable bits, or POSIX ACLs inside the repo.
- Any stack change (adding yarn/bun/uv, MinIO, GPU, cloud hosting) requires a new ADR
  and explicit approval, per blueprint rule "Never change dependencies or stack
  without ADR".
- LLMs never get order authority; live trading stays OFF by default (restated because
  it bounds every later stack choice).

## Verification

All environment facts cited above come from live shell output captured on
2026-09-07T15:06Z and recorded in `ENVIRONMENT.md` with reproduction commands.
