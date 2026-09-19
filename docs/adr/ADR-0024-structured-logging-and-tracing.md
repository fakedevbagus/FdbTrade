# ADR-0024: Structured logging, correlation and end-to-end tracing

- Status: Accepted
- Date: 2026-09-11 (UTC)
- Deciders: FdbTrade owner (approved via P13 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC), ADR-0005 (live OFF), ADR-0008 (private single-user auth), ADR-0018 (ensemble decision), ADR-0021 (paper broker), ADR-0022 (risk engine)

## Context

The frozen blueprint's P13 phase requires observability over the trading
loop: structured logs, correlation IDs, trace spans and redaction for the
market/signal/order pipelines, with the acceptance criterion that a single
signal can be traced through decision, risk, paper/demo execution and
outcome. Prior prompts already assign request/correlation IDs at the HTTP
boundary (P01-02) and record append-only risk audit events (P11-05), but no
shared log/trace vocabulary exists. Logs must never contain credentials, must
be deterministic for deterministic inputs, and must never fabricate a complete
pipeline (a signal with no outcome is visibly incomplete, never green).

## Decision

1. The logging/tracing vocabulary lives in `contracts/src/obs/logging.ts` as
   pure, typed, zod-validated TS (same pattern as risk/paper/analytics):
   `ObsLogRecord` (structured log line), `ObsTraceSpan` (named operation in a
   correlation), `assembleTrace` (deterministic end-to-end reconstruction),
   and `buildSignalPipelineSpans` (canonical per-stage span builder for the
   decision -> risk -> execution -> outcome path).
2. Frozen vocabularies: levels `debug|info|warn|error`; pipeline stages
   `market|signal|risk|execution|analytics|admin`. Adding a value requires a
   superseding ADR.
3. IDs are content-addressed (`obslog_`/`obsspan_` + FNV-1a64 of the canonical
   serialization, fixed field order, sorted attribute keys). Duplicate log
   content append is refused (an identical event is emitted exactly once);
   duplicate span append is a no-op (idempotency at the boundary). Timestamps
   are UTC (ADR-0004) and are explicit caller inputs — the contracts layer
   reads no wall clock, so identical inputs always produce identical output.
4. Redaction is fail-closed and structural: attribute values are restricted
   to `string|number|boolean|null`, and attribute keys matching
   `OBS_REDACTED_KEY_PATTERN` (password/secret/token/api-key/credential/cookie/
   authorization/private-key, case-insensitive) fail schema validation — a
   secret-shaped entry cannot enter a log payload even by caller bug.
5. Span invariants are schema-pinned: `endedAtUtc >= startedAtUtc`; `ok`
   spans carry `errorCode: null`; `error` spans MUST carry a snake_case
   reason code (raw error text never enters a span).
6. `assembleTrace` reconstructs one signal's story from spans in ANY input
   order — deterministic ordering `(startedAtUtc, spanId)`, correlation-id
   agreement enforced, unknown signal fails closed. `traceCoversFullPipeline`
   requires signal + risk + execution + a recorded outcome; missing outcome
   leaves the trace visibly incomplete.
7. Backend wiring lives in `backend/src/obs/service.ts`: a process-wide
   `ObsService` with an injectable sink and a bounded in-memory ring
   (default 5,000 records, oldest dropped), plus read-only admin surfaces
   `GET /api/admin/logs` (optional correlation filter, malformed filter -> 400)
   and `GET /api/admin/traces/[signalId]` (assembled trace + completeness
   flag; unknown signal -> 404). Both are session-guarded (ADR-0008) and
   write-method-guarded. The wall clock is read ONLY at the service recording
   boundary (`atUtc` default), never in the contracts layer.

## Consequences

- Every pipeline stage can emit records/spans through one typed vocabulary;
  the P11 risk audit log stays untouched (it serves a different, regulatory
  purpose — full typed decision snapshots).
- The in-memory ring is observability surface, not durable storage; swapping
  the sink for file/DB persistence in a later prompt requires no call-site
  changes.
- Log volume is bounded per process; the admin API caps responses at the
   latest 500 records.
- Follow-on: ingestion/worker and paper-execution runtimes may adopt
  `obsService.recordSpan` as they gain persistence; the frontend consumes the
  admin APIs in P13-03..05 surfaces.

## Verification

- `pnpm --filter @fdbtrade/contracts run test` — `obs-logging.test.ts` (19
  tests) green: happy path, malformed input, redaction fail-closed, duplicate
  append refused, deterministic ids (attribute order independent), span
  boundary rules, shuffled-order trace determinism, incomplete-pipeline
  flag, rejected-risk visibility.
- `pnpm --filter @fdbtrade/backend run test` — `src/obs/__tests__/service.test.ts`
  (14 tests) green: service ring bound, redaction through the service,
  idempotent spans, full-trace assembly, `/api/admin/logs` filter + 400/401/
  405 paths, `/api/admin/traces/[signalId]` 200/404/401/405.
- `pnpm --filter @fdbtrade/contracts run typecheck && pnpm --filter
  @fdbtrade/backend run typecheck` — 0 errors; lint clean for both packages.
