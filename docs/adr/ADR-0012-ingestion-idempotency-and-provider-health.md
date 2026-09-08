# ADR-0012: Ingestion idempotency, bounded retries and provider health

- Status: Accepted (P02-04)
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0010 (provider abstraction), ADR-0011 (data quality gates),
  `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`, Prompt Pack P02-04

## Context

P02-02/P02-03 produce canonical data but nothing orchestrates fetching,
quality-checking and reuse. The prompt requires: ingestion orchestration,
bounded retries, rate-limit hooks, cache keys, job idempotency, and provider
health state — explicitly WITHOUT a production scheduler dependency.

## Decision

1. **`backend/src/data/ingestion/`** is the orchestration layer:
   `cache.ts` (deterministic keys + bounded TTL memory cache),
   `jobs.ts` (idempotent job store + retry policy) and `worker.ts`
   (pipeline: fetch -> validate -> cache).
2. **Job identity = dedup key** `candles|provider|instrument|timeframe|
   start|end`; job id is its sha256 (first 16 hex). Registering the same
   event twice returns the SAME job with state preserved — repeated
   ingestion of a succeeded event is a cache hit, ZERO provider calls.
   Terminal failures stay failed for the same event (bounded retries
   already spent); re-ingestion never re-runs them.
3. **Bounded exponential backoff**: default 3 attempts, 100ms base doubling
   to a 5s cap (`backoffDelayMs` is a pure function). ONLY transient
   failures retry; `ProviderError` contract errors (unsupported
   instrument/timeframe, invalid request) fail fast without backoff —
   retrying a wrong request is waste.
4. **Rate limiting is a hook**, not a policy: the worker calls a
   caller-supplied gate before each provider attempt (default: unlimited).
   A real limiter plugs in later without touching worker logic; a denied
   call fails the job with `RATE_LIMITED`.
5. **Provider health is a pure state machine**: consecutive failures move
   the provider `healthy -> degraded` at a configurable threshold
   (default 2); a success restores `healthy`. `nextHealthStatus` is
   exported and unit-tested; no timers, no scheduler.
6. **Clocks and sleeps are injectable** — every test is deterministic; the
   production defaults (`Date.now`, `setTimeout` sleep) are the only
   wall-clock reads in the module and are documented as such.
7. **Cache is a performance layer only**: bounded entries (LRU-style
   eviction), TTL expiry, positive-TTL validation. A cache miss never
   fabricates data; a hit is byte-identical to a fresh fetch (fixture
   determinism, ADR-0010).
8. **No scheduler dependency**: the worker runs only when invoked
   (tests, CLI, future queue consumers). A later phase may add a queue
   but must bring its own ADR.
9. **Validation failure is not provider failure**: quarantined records
   (duplicates etc.) still let the job succeed for the clean subset, with
   the gap/quarantine report returned to the caller (ADR-0011 taxonomy).

## Consequences

- Safe replays: crash- or duplicate-redelivered ingestion events cannot
  double-fetch or double-write (idempotency by construction).
- Retry storms are impossible (attempt cap + backoff cap); rate-limit
  enforcement is centralized in one injectable hook.
- Degraded providers are visible to callers (P02-05 datasets and later
  signal consumers can refuse new entries on degraded feeds — blueprint
  "stale data fails closed for new entries").
- The in-memory job store/cache are process-local; a later phase may swap
  backing stores (Redis/Postgres) without changing the worker contract.

## Verification

- Backend vitest suite `src/data/ingestion/__tests__/ingestion.test.ts`
  (22 cases): cache keys/TTL/bounds, job idempotency, backoff curve,
  health transitions, retry-success/retry-exhaustion, contract-error
  fail-fast, rate-limit hook, degraded->healthy recovery, duplicate
  quarantine passthrough.
- `tests/test_data_core_contracts.py::IngestionBoundaryContracts`: no
  scheduler dependency in the worker; pipeline uses the P02-03 validator.
- `make check` green.
