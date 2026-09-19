# Completion Report

Prompt ID: P13-04 Build provider/system health dashboard
Phase: P13 Admin & Observability
Date/time UTC: 2026-09-12T00:05:00Z
Branch/commit: main / c001db9 + P10–P13-04 working tree (uncommitted)

## What changed

Provider/system health dashboard with an EXPLICIT state-to-fail-safe
mapping and no green-by-default (ADR-0027). The dashboard shows feed
freshness, queue backlog, API failures, DB/cache health, latency metrics
and the current risk state, and every state carries its fail-safe
consequence.

- `contracts/src/obs/health.ts` (new): frozen component vocabulary
  (`feed|queue|api|db|cache|risk`), check statuses
  (`ok|degraded|down|unknown`), snapshot states
  (`healthy|degraded|fail_safe`), frozen reason codes; TOTAL fail-safe
  mapping (`HEALTH_FAIL_SAFE_ACTIONS`: healthy = full budget; degraded =
  REDUCED risk; fail_safe = DENY new entries — fail closed); staleness
  budgets applied BEFORE state computation (warn-age -> degraded via
  `check_stale`; max-age -> unknown; future check / missing budget fail
  closed; EMPTY checks -> `fail_safe` via `check_missing`); monotone state
  computation (spine components feed/db/risk down-or-unknown -> fail_safe;
  queue/api/cache -> degraded; latched risk state orange -> degraded,
  red/kill -> fail_safe); deterministic (input order irrelevant); redacted
  scalar metrics.
- `backend/src/obs/healthService.ts` (new): check aggregator — fixture feed
  EXPLICITLY degraded (no live provider; never fabricated green), queue
  backlog surface, API error surface from the obs log, P01-03 DB probe with
  latency, in-process cache, latched risk state; computes the snapshot via
  the contracts layer; documented freshness budgets.
- `backend/src/obs/riskStateStore.ts` (new): process-wide latched risk
  state over the P11 `RiskStateTracker` contract — human-only overrides
  (engage/release/force), content-addressed P11 override ids, every applied
  override audited with actor + before/after (ADR-0025), release_kill lands
  red, invalid overrides change nothing (fail closed).
- `backend/src/app/api/admin/health/route.ts` (new): read-only
  session-guarded snapshot surface (writes 405).
- `frontend/src/lib/health.ts` + `/admin/health` page (new): zod-validated
  client (fail closed) + dashboard — overall state badge, the explicit
  fail-safe behavior (deny/reduce + description), risk state, per-component
  effective status with age/reason/metrics, explicit "never green without
  fresh evidence" notice.
- ADR-0027 recorded + indexed; CI ADR registry synchronized.

## Files changed

- contracts/src/obs/health.ts (new)
- contracts/src/__tests__/obs-health.test.ts (new)
- contracts/src/index.ts (barrel export)
- backend/src/obs/healthService.ts (new)
- backend/src/obs/riskStateStore.ts (new)
- backend/src/obs/__tests__/healthService.test.ts (new)
- backend/src/app/api/admin/health/route.ts (new)
- frontend/src/lib/health.ts (new)
- frontend/src/lib/__tests__/health.test.ts (new)
- frontend/src/app/(app)/admin/health/page.tsx (new)
- docs/adr/ADR-0027-health-states-and-fail-safe-behavior.md (new)
- docs/adr/README.md (index row)
- tests/test_ci_contracts.py (KNOWN_ADRS entry — required registry sync)

## Tests executed

- `pnpm --filter @fdbtrade/contracts run test`: 28 files / 404 tests green
  (16 new health tests; includes the regression fixture that caught a real
  bug — stale checks must surface `check_stale` in snapshot reasons; fixed in
  `computeHealthSnapshot` where staleness now owns the effective reason).
- `pnpm --filter @fdbtrade/backend run test`: obs suites 40/40 green (10 new
  health tests: fixture-degraded feed, DB-down fail_safe, kill contribution,
  audited sticky kill, release->red, invalid override no-op, API 200/401/405).
- `pnpm --filter @fdbtrade/frontend run test`: 11 files / 86 tests green
  (5 new health client tests).
- Typecheck 0 errors + lint clean across contracts, backend, frontend.
- `python3 -m unittest tests.test_ci_contracts`: 18/18 green.

## Acceptance criteria

- [x] Health states map to explicit fail-safe behavior (TOTAL frozen
  mapping; fail_safe denies new entries; degraded reduces risk; surfaced in
  API + UI).
- [x] No green-by-default when data is stale (staleness budgets applied
  before state computation; empty checks -> fail_safe; fixture feed
  explicitly degraded).
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified (ADR index + CI ADR registry are the
  required synchronization for ADR-0027).
- [x] Completion report written.

## Known limitations / blockers

- No live provider exists, so the feed check is honestly degraded
  (`feed_no_data`); real freshness observations land with P15 read-only sync.
- The latched risk state is in-process (no durable store yet) — later
  execution phases persist it behind the same P11 contract.
- Queue backlog surface is a structural placeholder (0 pending/running
  without a live worker sweep); the metric is displayed, never fabricated.
- Port-3000 pre-existing blocker for `make start`-based Python acceptance
  still applies.

## Follow-up required before next prompt

- None. Next prompt per required order: P13-05 Build operational controls.

## Risk notes

- Trading safety: the dashboard is read-only; the fail-safe mapping mirrors
  the blueprint's fail-closed-for-new-entries rule and P11 state semantics;
  kill remains human-only and never auto-reset; live execution stays OFF
  (ADR-0005).
- Quant integrity: determinism pinned (order-independent snapshots);
  staleness is machine-readable (`check_stale`, ages in ms); absence of
  evidence is fail_safe, never healthy.
- Security: metrics are redacted scalars; all surfaces session-guarded
  (401) and write-method-guarded (405); no secrets in payloads or the page.
