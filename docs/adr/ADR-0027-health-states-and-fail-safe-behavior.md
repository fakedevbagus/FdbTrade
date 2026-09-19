# ADR-0027: Health states with explicit fail-safe behavior

- Status: Accepted
- Date: 2026-09-12 (UTC)
- Deciders: FdbTrade owner (approved via P13 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC), ADR-0010 (provider abstraction), ADR-0012 (ingestion idempotency and provider health), ADR-0022 (risk engine states), ADR-0024 (structured logging), ADR-0025 (audit log)

## Context

The frozen blueprint's P13 phase requires a provider/system health dashboard
showing feed freshness, queue backlog, API failures, DB/cache health,
latency and the current risk state. Acceptance: health states map to
explicit fail-safe behavior; the non-goal is "no green-by-default when data
is stale". P11 defines risk states and their entry semantics; P01-03 has a
DB liveness check; no shared health vocabulary or state-to-behavior mapping
existed.

## Decision

1. The health vocabulary lives in `contracts/src/obs/health.ts` as pure,
   typed, zod-validated TS. Components (frozen): `feed | queue | api | db |
   cache | risk`. Check statuses: `ok | degraded | down | unknown`; snapshot
   states: `healthy | degraded | fail_safe`. Reason codes are a frozen
   machine-readable list (feed_stale, queue_backlog, db_unreachable,
   risk_kill_engaged, check_stale, check_missing, ...).
2. The fail-safe mapping is FROZEN and TOTAL (`HEALTH_FAIL_SAFE_ACTIONS`):
   `healthy` allows new entries at full risk budget; `degraded` allows
   operation with the per-trade risk budget REDUCED (yellow semantics);
   `fail_safe` DENIES new entries (manage/close only) — the blueprint's
   fail-closed-for-new-entries rule. Every state exposes
   `denyNewEntries`, `reduceRisk` and a human description; unknown states
   fail closed at the schema.
3. NO GREEN-BY-DEFAULT: staleness is applied BEFORE state computation.
   Each component has a freshness budget (`warnAgeMs`, `maxAgeMs`); a check
   older than `warnAgeMs` degrades via `check_stale`, older than `maxAgeMs`
   becomes `unknown`; a future-dated check or a missing budget fails closed
   (`HealthError`). An EMPTY check set is `fail_safe` via `check_missing` —
   absence of evidence is never healthy.
4. State computation is deterministic and monotone: any degraded check -> at
   least `degraded`; `down`/`unknown` on the entry-spine components
   (feed/db/risk) -> `fail_safe`; down/unknown on queue/api/cache alone ->
   `degraded`. The latched risk state contributes independently: orange ->
   degraded, red/kill -> fail_safe (mirrors P11-04; kill is engaged/released
   only by human override and never auto-reset). Check input order never
   changes the snapshot.
5. Check metrics are redacted scalars through the P13-01 boundary
   (`obsAttributeRecordSchema`); ok checks carry `reason: null` and non-ok
   checks carry a reason code (schema-pinned).
6. Backend wiring: `backend/src/obs/healthService.ts` aggregates observations
   (default factory: fixture feed EXPLICITLY degraded — no live provider
   exists, so feed health is never fabricated green; queue backlog surface;
   API error surface from the obs log; the P01-03 DB probe with latencyMs;
   in-process cache; the latched risk state) and computes the snapshot via
   the contracts layer. `backend/src/obs/riskStateStore.ts` is the
   process-wide latched risk-state store wrapping the P11
   `RiskStateTracker`: human-only overrides (content-addressed P11 override
   ids), every applied override audited with actor + before/after
   (ADR-0025), `release_kill` lands in red, invalid overrides change nothing.
   Surface: session-guarded read-only `GET /api/admin/health`; frontend
   `/admin/health` page shows state, the EXPLICIT fail-safe behavior,
   per-component effective status with age and reasons.

## Consequences

- The dashboard can never show a bare green: every state carries its
  fail-safe consequence, and stale/missing evidence visibly degrades.
- The fixture feed is honestly degraded until a real provider exists (P15
  read-only sync will replace that check with real freshness observations).
- The risk-state store is in-process latching; a durable store lands with
  later execution phases behind the same P11 contract.
- Freshness budgets are data (5/30 minutes default, 10/60 for db) and are
  recorded in this ADR; tuning requires no schema change but must stay
  documented.

## Verification

- `pnpm --filter @fdbtrade/contracts run test` — `obs-health.test.ts` (16
  tests) green: fail-safe mapping totality, ok/reason pairing, staleness
  warn/max/future/budget-missing, snapshot healthy/degraded/fail-safe paths,
  risk-state contributions, empty-check fail_safe, shuffled-order determinism,
  malformed-input refusals, frozen vocabularies. Includes the regression
  test that caught a real bug: stale checks must surface `check_stale` in
  snapshot reasons (staleness owns the effective reason).
- `pnpm --filter @fdbtrade/backend run test` — health suites green: default
  factory (fixture degraded, DB-down fail_safe, kill contribution), the
  latched risk-state store (audited engage/release, sticky kill, invalid
  override no-op), API 200/401/405.
- `pnpm --filter @fdbtrade/frontend run test` — health client tests green
  (valid/malformed parse, non-200/unreachable fail closed).
- Typecheck 0 errors + lint clean across contracts, backend, frontend.
