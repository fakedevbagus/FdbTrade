# M45 Completion Report — Continuous scheduler and runtime hardening

Prompt ID: M45 (post-Phase 2 blueprint, `POST_PHASE2_BLUEPRINT_PROMPT_PACK.md`)
Phase: Phase 2 — Operational Private Beta 2.1
Date/time UTC: 2026-09-19T22:15:00Z
Branch/commit: `main` (M45 implementation commit)
Baseline commit: `9daced3` (M44 authority pin commit)

## What changed

M45 turns the deterministic runtime into a continuously running local process with safe scheduling, process mutual exclusion, cycle lease tracking, durable checkpoints, restart-neutral recovery, deduplication across 5 domains, controlled degradation under system pressure, and correlated bounded logging.

Live trading remains strictly OFF (`LIVE_EXECUTION_ENABLED=false`), provider order transport stays OFF (`PROVIDER_ORDER_TRANSPORT_ENABLED=false`), and scheduler runs observation-only by default with zero order authority.

### New runtime subsystem (`backend/src/runtime/`)

- `clock.ts`: explicit `ClockSource` interface, `SystemClock` (wall-clock UTC ISO and ms), `ManualClock` (deterministic, zero-jitter, step-based, backwards-time rejection).
- `lock.ts`: `RuntimeProcessLock` providing single-process mutual exclusion per runtime database ID. Includes owner re-entrancy, heartbeat renewal, takeover of stale locks (>30s without heartbeat), and an advisory lock adapter for PostgreSQL.
- `lease.ts`: `CycleLease` finite-state machine (`pending -> leased -> running -> committing -> completed`, with `timeout`, `failed`, and `shutdown_draining`). Strictly validates transitions, enforces heartbeats and max retry budgets.
- `dedupe.ts`: `UniversalDedupeLedger` providing multi-domain deduplication (`cycle`, `job`, `outbox_event`, `paper_order`, `fill`). Identical replays absorbed idempotently; conflicting payloads fail closed with `DedupeConflictError`. Includes deterministic ID derivation (`evt-<hash>`, `ord-<hash>`).
- `checkpoints.ts`: hash-chained stage checkpoints (`ingest`, `analyze`, `emit`, `observe`). Detects corruption/tampering, recovers from the last verified good checkpoint. First-write-wins `CompletionLedger` prevents double counting.
- `degradation.ts`: controlled degradation engine evaluating 4 pressure metrics (queue backlog, memory/heap ratio, disk free ratio, data staleness) into 4 levels (`normal`, `elevated`, `conservative`, `suspended`). Suspended admits nothing; conservative admits observation-only.
- `health.ts`: pure runtime health projection across 6 subsystems (`scheduler`, `queue`, `database`, `source`, `analysis`, `paperBroker`). Degrades honestly when heartbeats or observations are missing. Never reports live execution.
- `retention.ts`: `BoundedLog` with cycle-correlated ring buffer, strict entry cap, and FIFO eviction drop counting.
- `scheduler.ts`: the continuous `Scheduler` coordinating the full tick loop: lock checks, degradation admission, stage execution with checkpoint chaining, timeout handling, retries, and graceful shutdown draining.
- `observation.ts`: observation-only stage handlers wiring fixture feeds and read-only analysis without order authority.
- `startup.ts`: process startup hook, disabled by default, opt-in via `FDB_CONTINUOUS_SCHEDULER_ENABLED=true`.
- `soak.ts`: multi-checkpoint kill and restart soak harness verifying outcome hash invariance between uninterrupted and crash-interrupted runs.

### Tests & gates

- `backend/src/runtime/__tests__/runtime.test.ts`: 56 Vitest unit and soak tests covering all modules and edge cases.
- `tests/test_m45_runtime_contracts.py`: 10 Python contract tests verifying invariants, hashing, and safety flags.
- `Makefile`: added `runtime-check`, `operational-persistence-check`, and `integration-replay-check`.
- `docs/adr/ADR-0034-continuous-scheduler-and-runtime-hardening.md`: architectural record for continuous scheduler.
- `docs/checkpoints/45_continuous_scheduler.md`: M45 milestone checkpoint.

## Gates executed

- `make runtime-check` — PASS (56 Vitest + 10 Python contract tests)
- `make operational-persistence-check` — PASS (17 Python DB foundation tests)
- `make operational-packaging-check` — PASS (all packaging contracts)
- `make integration-replay-check` — PASS (64 Vitest tests: engine, golden, fillPolicy, fixture)
- `make private-beta-check` — PASS (both live flags confirmed false)
- `make dashboard-check` — PASS
- `make security-check` — PASS
- `make phase2-check` — PASS
- `make handoff-check` — PASS
- `make format-check` — PASS
- `pnpm --filter @fdbtrade/backend typecheck` — PASS (zero errors)
- `pnpm --filter @fdbtrade/backend lint` — PASS (zero errors)
- `python3 -m unittest tests/test_skeleton_contracts.py` — PASS (14 tests)
- `python3 -m unittest tests/test_ci_contracts.py` — PASS (18 tests)

## Safety invariants verified

- `LIVE_EXECUTION_ENABLED=false` (enforced across runtime and config)
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false` (enforced everywhere)
- Scheduler disabled by default (`FDB_CONTINUOUS_SCHEDULER_ENABLED=false`)
- Observation-only default handlers; zero automated order capability

## Next milestone

**M46 — User-facing historical research workflow.**
