# ADR-0038: Local application and runtime lifecycle

- Status: Accepted
- Date: 2026-09-22
- Deciders: FdbTrade private-beta owner
- Supersedes: ADR-0034 production persistence and process-lock decisions
- Related: ADR-0004, ADR-0005, ADR-0027, ADR-0033, ADR-0037
- Work unit: R0.5

## Context

The M44 operator command started only the backend and inferred ownership from a
PID file plus a listening port. The M45 scheduler described durable recovery,
but its production-shaped wiring still used in-memory locks, leases,
checkpoints, completions and dedupe; its only external lock adapter was tied to
the retired PostgreSQL authority. Health could therefore report an API and
database without proving the scheduler's durable state.

R0.5 must make the two local applications one bounded loopback lifecycle and
move scheduler lifecycle facts into the SQLite authority established by
ADR-0037. It must not add product, data, signal, broker or provider authority.

## Decision

1. `scripts/fdbtrade start|status|stop` is the operator lifecycle authority;
   `make start` delegates to it. It manages the frontend at
   `127.0.0.1:3000` and backend at `127.0.0.1:3100` together. Both package
   development and production commands pin the loopback host explicitly.
2. Start requires a migrated SQLite database, refuses any occupied required
   port, starts both process groups, and has a 60-second readiness bound. A
   partial or unready start terminates only the process groups it created.
3. The lifecycle JSON under `<data-root>/run` is non-authoritative ephemeral
   ownership metadata. Stop accepts a recorded process only when its PID and
   Linux `/proc` start token still match; corrupt or absent ownership metadata
   never authorizes a broad name- or port-based kill.
4. Migration `0004_runtime_lifecycle` owns `runtime_locks`, `runtime_cycles`,
   `runtime_checkpoints`, `runtime_completions` and `runtime_dedupe`. All
   mutations use the canonical Node SQLite connection and short
   `BEGIN IMMEDIATE` transactions.
5. Scheduler process locks are renewable expiring rows. An active owner cannot
   be stolen; a row may be taken over only after expiry. Each tick heartbeats
   its lock and stops scheduling if ownership is lost.
6. Cycle leases, checkpoint hash chains (including stage digests), completion
   identity and cross-domain dedupe survive process restart. Startup enumerates
   uncompleted cycles, verifies every checkpoint chain, resumes after the last
   verified stage, and records completion first-write-wins. Corrupt chains
   block recovery.
7. The observation-only scheduler remains OFF by default. When explicitly
   enabled with a bounded interval, the backend Node instrumentation hook wires
   it to SQLite. This grants no market-data, signal, paper-order or live-order
   authority.
8. `GET /api/health` reports database and scheduler configuration separately
   and derives lock, incomplete-cycle, last-completion and checkpoint-integrity
   facts from SQLite. An enabled scheduler without a current lock, or any
   corrupt checkpoint chain, degrades health; a deliberately disabled
   scheduler is reported as disabled rather than fabricated running.

## Consequences

- One command starts, observes and stops both local applications without
  claiming ownership of unrelated host processes.
- A process crash leaves sufficient SQLite evidence for bounded takeover and
  idempotent resume; no PostgreSQL or in-memory production store is required.
- SQLite write serialization remains visible. Busy/lock errors fail the
  operation and are not converted to success.
- The run metadata is deliberately not a durable business-state authority and
  is safe to recreate after proving no recorded process remains.
- Backup/restore, market data, artifact authority, signals, backtest/research,
  risk, paper broker, UI and credentialed providers remain outside this ADR.

## Verification

- Vitest reopens a file-backed database to prove lock exclusion, stale
  takeover, dedupe persistence, crash recovery from a checkpoint, exactly-once
  completion and corruption reporting.
- Python contracts prove both package commands bind loopback, the Make target
  delegates to the operator lifecycle, corrupt ownership metadata cannot send
  a signal, the PostgreSQL lock adapter is absent, and health uses SQLite.
- A real backend smoke with the scheduler enabled reports a held SQLite lock,
  advances durable completions, and removes the lock on graceful shutdown.
- `make toolchain-gate` is the final bounded acceptance authority.
