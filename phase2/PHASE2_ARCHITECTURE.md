# Phase 2 — Private Beta Architecture

**Version:** 2.0.0-private-beta  
**Status:** Active (M44 complete, M45 authorized)  
**Baseline:** Legacy P0-P18 roadmap complete

## Architecture Overview

FdbTrade is a private, single-user trading intelligence OS built on a layered, immutable, deterministic architecture:

```
┌────────────────────────────────────────────────────────────┐
│                        UI / Operator Layer                  │
│  Next.js frontend (127.0.0.1:3000) | scripts/fdbtrade CLI   │
├────────────────────────────────────────────────────────────┤
│                    API / BFF Layer                          │
│  Next.js backend (127.0.0.1:3100) | typed API, auth, health │
├────────────────────────────────────────────────────────────┤
│                  Domain Service Layer                       │
│  Data Core | Feature Core | Regime | Strategy | Ensemble    │
│  Backtest | Research | Paper Broker | Risk | Analytics      │
├────────────────────────────────────────────────────────────┤
│              Deterministic Contract Layer                   │
│  contracts/ (TS) + quant/ (Python stdlib mirrors)           │
├────────────────────────────────────────────────────────────┤
│                 Persistence Layer                           │
│  PostgreSQL 16 (Docker) + Redis 7 + filesystem artifacts    │
└────────────────────────────────────────────────────────────┘
```

## Layer Responsibilities

### 1. Operator Layer (`frontend/`, `scripts/`)
- Web UI for private command center, scanner, signal detail, alerts
- `scripts/fdbtrade` CLI for bootstrap, init, start, stop, status, check, recover
- Loopback-only binding (127.0.0.1) for all services
- No secrets, no broker access, no live execution

### 2. API / BFF Layer (`backend/`)
- Next.js typed API foundation
- Authentication (single user), structured errors, request IDs
- Health endpoint, dashboard, auth, alerts, registry, observability routes
- All routes are read-only except authenticated session management

### 3. Domain Service Layer (`backend/src/` + `contracts/src/`)
- Market data pipeline: provider abstraction → fixture adapter → normalizer → validator → cache
- Feature engineering: versioned definitions → indicators → structure → snapshot store
- Regime classification: deterministic rules + multi-timeframe context
- Strategy layer: trend-pullback, breakout, mean-reversion, momentum
- Ensemble: weighting, cost-aware edge gate, calibration, ranking
- Backtest engine: event-driven, realistic costs, golden fixtures
- Research lab: walk-forward, purge/embargo, stress, Monte Carlo, promotion
- Paper broker: state machine, fill simulator, ledger, reconciliation
- Risk engine: independent hard limits, portfolio heat, kill switch
- Analytics: outcomes, calibration, MAE/MFE, attribution
- Admin/observability: audit log, health states, operational controls

### 4. Deterministic Contract Layer (`contracts/`, `quant/`)
- Pure, zod-validated, deterministic modules
- Python stdlib mirrors of TypeScript contracts
- Content-addressed IDs, canonical serialization, deterministic hashing
- No clock, no randomness, no broker access
- All strategies/signals are research-only (paper or demo only)

### 5. Persistence Layer (`infra/`, `backend/db/`)
- PostgreSQL 16 via Docker Compose (isolated `fdbtrade` project)
- Redis 7 for caching (loopback only)
- Filesystem run artifacts for backtests/research
- Append-only audit log
- Migrations are checksummed, versioned, immutable

## Safety Boundaries (Hard)

```
Strategy → Signal → Risk → Execution
```

- Strategy code never calls a broker
- LLM/AI never has direct order authority
- Risk engine is independent of strategy logic
- Live execution OFF by default (`FDB_BROKER_LIVE_ENABLED=false`)
- Provider order transport OFF (`PROVIDER_ORDER_TRANSPORT_ENABLED=false`)
- Missing/stale/unverified safety data fails closed
- No public ingress; all services loopback-only

## Data Flow (Normal Path)

```
Fixture/Provider → Normalizer → Validator → Cache → Feature Pipeline
              → Regime → Strategy → Ensemble → Risk → (Paper/Demo only)
              → Backtest/Research → Analytics → Dashboard
```

## Failure Modes (Fail Closed)

| Failure | Behavior |
|---|---|
| DB unavailable | Health degraded; dashboard returns deterministic fixture snapshot |
| Provider unavailable | No invented data; quarantine + retry |
| Stale data | New entries blocked; stale state visible |
| Security header missing | Deployment rejected |
| Auth missing | 401 fail closed |
| Invalid config | Fail fast with redacted error |
| Live execution attempted | Rejected (flag false) |
| Live provider order attempted | Rejected (flag false) |

## M44 Bootstrap Architecture

```
make bootstrap
  → scripts/fdbtrade preflight
  → scripts/fdbtrade init
  → scripts/fdbtrade start (optional)
  → scripts/fdbtrade status
  → scripts/fdbtrade check
```

- Preflight checks Python, Node, npm, SQLite, Make, Bash, disk, permissions, ports
- Init creates/validates `.venv`, installs locked Python deps, runs `npm ci`/`pnpm install --frozen-lockfile`
- No secrets requested; `.env` copy from template only
- Recovery documented in `RECOVERY.md`

---
*Generated at M43 handoff. Updated for M44 bootstrap implementation.*