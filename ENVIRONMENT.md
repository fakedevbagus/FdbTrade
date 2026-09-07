# FdbTrade Environment Inventory (P00-01)

Verified runtime facts for the FdbTrade execution environment, captured from live shell
output on the development machine. Evidence commands are listed at the bottom so every
fact is reproducible. All timestamps UTC.

- Inspected: 2026-09-07T15:06Z
- Inspector: fakedevbagus (uid 1000, groups include `sudo`, `docker`)
- Host: `fakedevbagus` (single-user private product target)

## Operating system

| Fact | Value |
|---|---|
| Distribution | Linux Mint 22.3 (Zena), Ubuntu noble base |
| Kernel | 7.0.0-31-generic x86_64 |
| glibc | 2.39 |
| Shell | /bin/bash 5.2.21 |
| Timezone (local display only) | Asia/Jakarta (WIB, +0700); system clock synchronized; all internal timestamps remain UTC per constitution |

## Hardware

| Fact | Value |
|---|---|
| CPU | Intel Core i5-4690 @ 3.50GHz, 4 cores / 4 threads |
| RAM | 15 GiB total (10 GiB used by other workloads at inspection time) |
| Disk (workspace volume) | /dev/sda1, 466 GiB total, 234 GiB available (50% used) |
| GPU | No CUDA/GPU acceleration assumed; ML stays CPU-first per blueprint ("GPU optional only if evidence") |

## Filesystem constraint (important)

The workspace lives on `/media/fakedevbagus/WD BLUE` mounted as `fuseblk` (NTFS,
udisks2). Verified consequences:

- No Unix permission bits / no executable-bit semantics beyond mount defaults.
- No symlink support.
- Git must run with `core.fileMode=false` (auto-detected) and must not rely on symlinks.
- I/O is slower than a native ext4 volume; large `node_modules`/venv trees are usable
  but slower. Documented, not a blocker.

## Runtimes and package managers

| Tool | Status | Version |
|---|---|---|
| node | available | v24.19.0 |
| npm | available | 11.17.0 |
| npx | available | 11.17.0 |
| pnpm | available | 11.22.0 |
| yarn | NOT FOUND | — |
| bun | NOT FOUND | — |
| deno | NOT FOUND | — |
| python3 | available | 3.12.3 |
| pip3 | available | 24.0 (Ubuntu system pip) |
| uv | NOT FOUND | — |
| git | available | 2.43.0 |

OS package managers: `apt` / `apt-get` available; `flatpak` available; `snap`, `dnf`,
`pacman`, `zypper`, `brew` not present.

Decision: use present tooling (pnpm for JS workspaces, pip3/venv for Python) until an
ADR approves anything else. Do not pretend yarn/bun/uv exist.

## Containers and data services

| Tool | Status | Version |
|---|---|---|
| Docker CLI | available | 29.8.0 |
| Docker daemon | running (verified `docker info`) | ServerVersion 29.8.0 |
| Docker Compose | available | v5.5.1 |
| PostgreSQL client (`psql`, `pg_dump`) | available | 16.15 |
| Redis client (`redis-cli`) | available | 7.0.15 |
| Local `redis-server` binary | NOT FOUND (use Docker image instead) |

Existing local Docker images usable for FdbTrade dev services: `postgres:16`,
`postgres:16-alpine`, `redis:7`, `redis:alpine`. No FdbTrade containers exist yet;
existing containers on the host belong to unrelated projects and must not be touched.

## Network

| Target | Result |
|---|---|
| https://registry.npmjs.org/ | HTTP 200 in ~0.3 s (fast) |
| https://pypi.org/simple/ | HTTP 200 in ~28 s (reachable but slow; first byte latency high) |

Implication: JS dependency installs will be fast; Python package installs may be slow
or flaky. Python dependency strategy must prefer Docker-based or vendored wheels where
practical, and scripts must have retry/timeout handling. No broker endpoints were
contacted and no credentials exist in this repository.

## IDE / editor

VS Code CLI 1.136.1 present. No other required tooling assumed.

## Repository state at inspection

Workspace root `/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade` contained
only `FdbTrade_PromptPack_v1/` (prompt pack, control docs, templates, reference
blueprint, source `.docx`/`.zip` artifacts). No application source, no git history, no
prior `COMPLETION_REPORT.md`, no CI, no packages. Greenfield state confirmed.

## Capability summary against Blueprint v2 stack

Blueprint target stack: Next.js/React + TypeScript BFF/API, Python quant
engine/workers (FastAPI), PostgreSQL, Redis, object storage, Docker, MT5 bridge.

| Blueprint requirement | Environment verdict |
|---|---|
| Node/TypeScript web + BFF | Feasible (node 24, pnpm, VS Code) |
| Python quant engine/workers | Feasible (python 3.12.3; PyPI slow — see Network) |
| PostgreSQL | Feasible via Docker (`postgres:16` image already local; psql 16 client present) |
| Redis | Feasible via Docker (no local redis-server binary) |
| Docker runtime for workers | Feasible (daemon running, compose v5.5.1) |
| Object storage | No S3/MinIO verified; local filesystem artifacts are the P0-P4 posture. MinIO not installed — do not assume it |
| MT5 bridge | MT5 terminal not present on this Linux host; P15+ will need fixtures/mocks first (per constitution) |
| GPU/ML acceleration | None; CPU-only until evidence justifies otherwise |

## Evidence commands

Facts above were produced by: `uname -a`, `cat /etc/os-release`, `ldd --version`,
`whoami`/`id`, `date -u`, `timedatectl`, `node|npm|npx|pnpm|yarn|bun|deno --version`,
`python3 --version`, `pip3 --version`, `git --version`, `docker --version`,
`docker compose version`, `docker info`, `docker ps`/`docker images`, `psql --version`,
`redis-cli --version`, `nproc`, `lscpu`, `free -h`, `df -h`, `stat -f`, `mount`,
`curl -o /dev/null -w ...` against npm and PyPI registries. No secret values were
captured or recorded.
