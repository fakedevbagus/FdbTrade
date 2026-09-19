# Checkpoint 45 — Continuous scheduler and runtime hardening

- Milestone: M45
- Status: Complete — all required gates pass
- Target release: `2.0.0-private-beta`
- Recorded: 2026-09-19 (UTC)
- Baseline commit: `9daced3` (M44 authority pin commit)

## 1. Objective

Turn the deterministic runtime into a continuously running local process with
safe scheduling, process mutual exclusion, graceful shutdown, and restart-neutral
recovery.

## 2. Delivered

| Artifact | Purpose |
| --- | --- |
| `backend/src/runtime/clock.ts` | Explicit clock abstraction (`ClockSource`, `SystemClock`, `ManualClock` for deterministic tests). UTC ISO and epoch ms. Monotonicity enforced. |
| `backend/src/runtime/lock.ts` | One process lock per runtime database (`RuntimeProcessLock`). Re-entrant for owner, heartbeat refresh, takeover of stale locks (>30s), advisory adapter for PostgreSQL. |
| `backend/src/runtime/lease.ts` | Cycle lease state machine: `pending -> leased -> running -> committing -> completed`, timeout handling, attempt budgeting, graceful shutdown draining. |
| `backend/src/runtime/dedupe.ts` | Universal deduplication ledger: 5 independent namespaces (`cycle`, `job`, `outbox_event`, `paper_order`, `fill`). Replay absorbed idempotently; divergent reuse fails closed. Deterministic ID derivations. |
| `backend/src/runtime/checkpoints.ts` | Durable hash-chained checkpoints across cycle stages (`ingest`, `analyze`, `emit`, `observe`). Tamper detection and last-verified checkpoint resume. Completion ledger prevents double-counting. |
| `backend/src/runtime/degradation.ts` | Controlled degradation engine: 4 pressure signals (queue, memory, disk, staleness). 4 levels: normal, elevated, conservative, suspended. Unknown metrics fail closed. |
| `backend/src/runtime/health.ts` | Pure health projection over 6 subsystems: scheduler, queue, database, source, analysis, paperBroker. Fails safe when data is missing/stale. Never claims live trading. |
| `backend/src/runtime/retention.ts` | Structured cycle-correlated ring log (`BoundedLog`) with strict capacity bound and FIFO drop counting. |
| `backend/src/runtime/scheduler.ts` | Continuous `Scheduler` engine coordinating lock, lease, stages, checkpoints, degradation, health, and shutdown draining. |
| `backend/src/runtime/observation.ts` | Default observation-only stage handlers wiring fixture data and observability services without order authority. |
| `backend/src/runtime/startup.ts` | Process entry point: opt-in continuous scheduler start (`FDB_CONTINUOUS_SCHEDULER_ENABLED=true`), default false. |
| `backend/src/runtime/soak.ts` | Fixture soak harness: multi-checkpoint kills, crash restart, outcome hash convergence verification across runs. |
| `backend/src/runtime/__tests__/runtime.test.ts` | Comprehensive Vitest suite: 56 tests covering all M45 modules, invariants, and soak recovery. |
| `tests/test_m45_runtime_contracts.py` | Python contract tests: 10 tests verifying module structure, safety invariants, hashing, and admission rules. |
| `docs/adr/ADR-0034-*.md` | Architecture Decision Record for continuous scheduling, locking, and recovery. |
| `Makefile` | Added `runtime-check`, `operational-persistence-check`, and `integration-replay-check`. |

## 3. Required behavior → evidence

| Requirement | Evidence |
| --- | --- |
| One process lock per runtime database | `RuntimeProcessLock`: second owner fails closed; distinct databases lock independently; stale locks reclaimable after 30s. |
| Bounded scheduler interval and explicit clock source | `MIN_INTERVAL_MS=1_000`, `MAX_INTERVAL_MS=3_600_000`; `ManualClock` and `SystemClock` UTC-only; tested. |
| Cycle lease, heartbeat, timeout, retry, shutdown | `CycleLease` state machine transitions, heartbeat TTL, max retries enforcement, graceful shutdown drain. |
| Recovery from interrupted cycles using durable checkpoints | `recoverInterruptedCycles()` resumes from last verified stage checkpoint; soak test proves crash recovery convergence. |
| No duplicate cycle, job, outbox event, paper order, fill | `UniversalDedupeLedger` covers all 5 domains; identical writes absorbed; conflicting writes throw `DedupeConflictError`. |
| Health projections for 6 subsystems | `buildRuntimeHealth()` covers scheduler, queue, database, source, analysis, paperBroker; degradation reflected. |
| Controlled degradation under pressure | `evaluateDegradation()` maps queue, memory, disk, and staleness to normal/elevated/conservative/suspended. |
| Correlated operational log and bounded retention | `BoundedLog` cycle-correlated entries; FIFO eviction drops oldest and tracks drop count. |
| Soak and crash recovery | `runFixtureSoak()` verifies clean run and multi-checkpoint killed run converge to the identical outcome hash. |

## 4. Acceptance gates

```bash
make runtime-check                 # exit 0 (56 Vitest + 10 Python contract tests)
make operational-persistence-check # exit 0 (17 Python DB foundation tests)
make operational-packaging-check   # exit 0 (M44 packaging invariants)
make integration-replay-check      # exit 0 (64 Vitest backtest/fixture tests)
make private-beta-check            # exit 0 (live=false, transport=false)
make dashboard-check               # exit 0 (dashboard and health endpoints)
make security-check                # exit 0 (no secrets, gitignored env)
make phase2-check                  # exit 0 (Phase 2 authority files)
make handoff-check                 # exit 0 (handoff docs)
```

## 5. Safety state (unchanged)

- `LIVE_EXECUTION_ENABLED=false`
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false`
- Loopback-only binding (`127.0.0.1`)
- Scheduler disabled by default; opt-in only via `FDB_CONTINUOUS_SCHEDULER_ENABLED=true`
- Observation-only handlers by default; zero order authority in scheduler
- No live route, broker credential, or automated order execution added

## 6. Next authorized milestone

**M46 — User-facing historical research workflow.** Not started. Do not begin it in the same agent run.
