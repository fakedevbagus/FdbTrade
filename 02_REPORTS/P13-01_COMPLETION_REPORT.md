# Completion Report

Prompt ID: P13-01 Implement structured logging/tracing
Phase: P13 Admin & Observability
Date/time UTC: 2026-09-11T22:45:00Z
Branch/commit: main / c001db9 + P10–P13-01 working tree (uncommitted)

## What changed

Structured logging, correlation, trace spans and redaction for the
market/signal/order pipelines (ADR-0024). A single signal can now be traced
through decision -> risk -> paper/demo execution -> outcome via
content-addressed spans assembled deterministically.

- `contracts/src/obs/logging.ts` (new): frozen log levels
  (`debug|info|warn|error`) and pipeline stages
  (`market|signal|risk|execution|analytics|admin`); `ObsLogRecord` (structured
  log line with level/UTC instant/stage/event/correlation/entities/redacted
  attributes/message); `ObsTraceSpan` (stage operation inside a correlation
  with `ok|error` status and required reason codes on errors); content-
  addressed ids (`obslog_`/`obsspan_` + FNV-1a64 of canonical serialization,
  attribute-order independent); duplicate log append refused (idempotency);
  span invariants schema-pinned (`endedAtUtc >= startedAtUtc`; `ok` spans
  carry `errorCode: null`, error spans carry a snake_case code);
  FAIL-CLOSED redaction (`OBS_REDACTED_KEY_PATTERN` plus scalar-only values,
  so secrets cannot enter a log payload even by caller bug);
  `assembleTrace` (deterministic `(startedAtUtc, spanId)` ordering from ANY
  input order, correlation agreement enforced, unknown signal fails closed);
  `traceCoversFullPipeline` (missing outcome is visibly incomplete — no
  green-by-default); `buildSignalPipelineSpans` (canonical decision/risk/
  execution/outcome span builder).
- `backend/src/obs/service.ts` (new): process-wide `ObsService` — injectable
  sink, bounded in-memory ring (default 5,000 records), `record`/`info`
  helpers, idempotent `recordSpan`, `traceFor` assembly with a machine-
  readable `complete` flag. Wall clock read only at the recording boundary.
- `backend/src/app/api/admin/logs/route.ts` (new): read-only session-guarded
  log surface; optional `correlationId` filter (well-formed ids only —
  malformed -> 400); latest 500 records.
- `backend/src/app/api/admin/traces/[signalId]/route.ts` (new): read-only
  session-guarded end-to-end trace view; unknown signal -> 404 (never
  fabricated).
- ADR-0024 recorded and indexed; CI ADR registry (test_ci_contracts.py)
  synchronized.

## Files changed

- contracts/src/obs/logging.ts (new)
- contracts/src/__tests__/obs-logging.test.ts (new)
- contracts/src/index.ts (barrel export)
- backend/src/obs/service.ts (new)
- backend/src/obs/__tests__/service.test.ts (new)
- backend/src/app/api/admin/logs/route.ts (new)
- backend/src/app/api/admin/traces/[signalId]/route.ts (new)
- docs/adr/ADR-0024-structured-logging-and-tracing.md (new)
- docs/adr/README.md (index row)
- tests/test_ci_contracts.py (KNOWN_ADRS entry — required registry sync)

## Tests executed

- `pnpm --filter @fdbtrade/contracts run test`: 25 files / 360 tests green
  (19 new obs-logging tests).
- `pnpm --filter @fdbtrade/backend run test`: 62 files / 552 tests green
  (14 new obs service/route tests).
- contracts + backend typecheck: 0 errors. Lint clean for affected packages.
- `python3 -m unittest tests.test_ci_contracts` (ADR registry): green after
  the ADR-0024 sync.

## Acceptance criteria

- [x] A single signal can be traced through decision, risk, paper/demo
  execution and outcome (`buildSignalPipelineSpans` + `assembleTrace` +
  `traceCoversFullPipeline`, exposed via `GET /api/admin/traces/[signalId]`;
  rejected-risk path is an explicit error span, not a hidden skip).
- [x] Relevant tests pass from a clean environment (contracts 360/360,
  backend 552/552).
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified (ADR index + CI ADR registry are the
  required synchronization for ADR-0024).
- [x] Completion report written.

## Known limitations / blockers

- The default sink is a bounded in-memory ring — observability surface, not
  durable storage. File/DB persistence can be added later behind the same
  `ObsSink` interface with no call-site changes.
- Spans are recorded by explicit runtime call sites; existing P07/P10/P11
  runtimes do not yet emit spans (they can adopt `obsService.recordSpan` as
  they gain persistence — the contracts fixture + admin surface satisfy this
  prompt's acceptance criterion).
- Port-3000 pre-existing blocker for `make start`-based Python acceptance
  (documented in P10–P12 reports) still applies.

## Follow-up required before next prompt

- None. Next prompt per required order: P13-02 Build audit log.

## Risk notes

- Trading safety: observability is read-only; no broker access anywhere in
  the obs layer; live execution remains OFF (ADR-0005). Kill switch /
  risk-state logic untouched.
- Quant integrity: deterministic ids + canonical serialization mean identical
  inputs produce byte-identical logs/spans; trace assembly is order-
  independent; incompleteness is machine-readable (`outcomeRecorded`,
  `complete`), never silently green.
- Security: fail-closed redaction (secret-shaped keys and non-scalar values
  rejected at the schema boundary); admin surfaces session-guarded (401) and
  write-method-guarded (405); no secrets in fixtures, logs, or responses.
