# ADR-0034: Continuous scheduler and runtime hardening

- Status: Accepted
- Date: 2026-09-19
- Deciders: FdbTrade owner (approved M45 in the post-Phase 2 blueprint pack)
- Supersedes: none
- Related: ADR-0004 (UTC time policy), ADR-0005 (live trading OFF by default), ADR-0012 (ingestion idempotency), ADR-0027 (health states and fail-safe behavior), ADR-0033 (reproducible bootstrap)

## Context

M44 delivered a reproducible bootstrap and operator CLI. The runtime, however, remained an on-demand process without a continuous local scheduler, restart-safe cycle coordination, process mutual exclusion, or controlled degradation under system pressure.

The post-Phase 2 blueprint authorizes **M45 — Continuous scheduler and runtime hardening** to turn the deterministic runtime into a continuously running local process with:
1. One process lock per runtime database.
2. Bounded scheduler interval and explicit clock source.
3. Cycle lease, heartbeat, timeout, retry, and shutdown states.
4. Recovery from interrupted cycles using durable checkpoints.
5. No duplicate cycle, job, outbox event, paper order, or fill.
6. Health projections for scheduler, queue, database, source, analysis, and paper broker.
7. Controlled degradation under queue, memory, disk, or stale-data pressure.
8. Operational log correlation and bounded retention.

## Decision

1. **Process Lock.** One lock per database id (`lock.ts`). Supports in-memory tracking with heartbeat renewals and a PostgreSQL advisory-lock adapter (`pg_try_advisory_lock` / `pg_advisory_unlock`) keyed on the hashed database identifier. Stale locks (> 30s without heartbeat) can be claimed with an explicit takeover event. Second owners fail closed without taking over active holders.
2. **Explicit Clock Source.** Bounded scheduler interval strictly validated to `[1_000, 3_600_000]` ms (`scheduler.ts`). Uses an explicit `ClockSource` (`clock.ts`): `ManualClock` for zero-jitter deterministic soak/tests and `SystemClock` for wall-clock execution. All times are UTC ISO strings or epoch ms. Negative advance is rejected.
3. **Cycle Lease Lifecycle.** State machine (`lease.ts`): `pending -> leased -> running -> committing -> completed`, with `timeout`, `failed`, and `shutdown_draining` terminal or recovery states. Heartbeats must be renewed within `leaseTtlMs`. Expiration marks timeout; retries are bounded by `maxRetries` per cycle before terminal failure.
4. **Deduplication Ledgers.** Universal deduplication ledger (`dedupe.ts`) covering 5 independent namespaces: `cycle`, `job`, `outbox_event`, `paper_order`, `fill`. Replay of identical input is absorbed idempotently; divergent reuse with the same key fails closed. Deterministic ID derivations (`evt-<hash>`, `ord-<hash>`) prevent drift.
5. **Durable Checkpoints & Completion Ledger.** Cryptographic hash-chained checkpoints (`checkpoints.ts`) recorded at each cycle stage boundary (`ingest`, `analyze`, `emit`, `observe`). Tampered checkpoints are detected and rejected; restart recovery resumes from the last verified good checkpoint. First-write-wins completion ledger prevents double-counting or progress jumps.
6. **Controlled Degradation.** Monotone scale (`normal -> elevated -> conservative -> suspended`) driven by 4 honest pressure signals (`degradation.ts`): queue backlog, heap ratio, free disk ratio, and data staleness. Suspended admits nothing (ticks skipped); conservative admits observation-only; normal/elevated admit full cycles. Unknown/malformed pressure metrics fail closed to conservative/suspended.
7. **Health Projections.** Pure aggregate projection (`health.ts`) covering 6 subsystems: `scheduler`, `queue`, `database`, `source`, `analysis`, `paperBroker`. Fails closed if components miss heartbeats. Never reports live execution or provider order transport as enabled.
8. **Operational Log & Bounded Retention.** Structured cycle-correlated ring log (`retention.ts`) with strict capacity bound (`maxEntries`). Bounded FIFO eviction drops oldest entries and reports cumulative drop count.
9. **Fixture Soak & Restart Recovery.** Multi-checkpoint kill and restart soak harness (`soak.ts`). Verifies that killing the scheduler at arbitrary cycle and stage boundaries, followed by restart recovery, produces an identical durable outcome hash as an uninterrupted clean run, with zero duplicate side effects.
10. **Startup Integration.** Opt-in continuous scheduler start (`startup.ts` via `FDB_CONTINUOUS_SCHEDULER_ENABLED=true`), default false. Live trading remains strictly OFF.

## Consequences

- Continuous scheduling runs locally with single-process mutual exclusion per database.
- Crashing at any stage of a cycle allows the next process invocation to resume without duplicating external events or paper orders.
- System pressure degrades explicitly into throttled/suspended states rather than crashing silently.
- All live/order safety flags remain false: `LIVE_EXECUTION_ENABLED=false`, `PROVIDER_ORDER_TRANSPORT_ENABLED=false`.

## Verification

```bash
make runtime-check
make operational-persistence-check
make integration-replay-check
pnpm --filter backend test src/runtime/__tests__/runtime.test.ts   # 56/56 passing
python3 -m unittest tests.test_m45_runtime_contracts             # 10/10 passing
```
