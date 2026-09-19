# Completion Report

Prompt ID: P13-02 Build audit log
Phase: P13 Admin & Observability
Date/time UTC: 2026-09-11T23:05:00Z
Branch/commit: main / c001db9 + P10–P13-02 working tree (uncommitted)

## What changed

Immutable-style append-only audit ledger for privileged changes (ADR-0025).
Every entry carries actor, action, subject, before/after summary, UTC
timestamp, correlation id and source; replays and backdated entries are
refused; no update/delete path exists.

- `contracts/src/obs/audit.ts` (new): `AuditEvent` schema (actor — `anonymous`
  refused; action; subjectType; subjectId; before/after summaries; atUtc;
  correlationId; source), frozen subject types
  (`config|strategy_version|risk_override|execution_state|feature_flag|
  incident`) and sources (`admin-api|risk-service|paper-service|research-lab|
  pipeline|system`); content-addressed ids (`aud_` + FNV-1a64 of the canonical
  serialization — summary key order cannot change an id); append-only log
  with 1-based contiguous seq; fail-closed rules (duplicate event id =
  replay refused; out-of-chronology atUtc refused; same-instant distinct
  events legal, ordered by seq); `auditLogDigest` stream tamper-evidence;
  subject/actor queries. Before/after summaries reuse the P13-01 redacted
  attribute boundary (scalar-only; secret-shaped keys fail validation).
- `backend/src/obs/auditService.ts` (new): process-wide `AuditService` —
  append (throws on malformed/duplicate/backdated, log unchanged), subject
  filter, digest. Wall clock only at the recording boundary (default atUtc).
- `backend/src/app/api/admin/audit/route.ts` (new): read-only
  session-guarded surface; optional `subjectId` filter (malformed -> 400);
  latest 500 events + current digest; no client write method (POST/PUT/PATCH/
  DELETE -> 405 — appends happen inside privileged services at the moment of
  change, e.g. P13-05 controls).
- ADR-0025 recorded + indexed; CI ADR registry synchronized.

## Files changed

- contracts/src/obs/audit.ts (new)
- contracts/src/obs/logging.ts (export obsAttributeRecordSchema — shared
  redaction boundary, no behavior change)
- contracts/src/__tests__/obs-audit.test.ts (new)
- contracts/src/index.ts (barrel export)
- backend/src/obs/auditService.ts (new)
- backend/src/obs/__tests__/auditService.test.ts (new)
- backend/src/app/api/admin/audit/route.ts (new)
- docs/adr/ADR-0025-append-only-audit-log.md (new)
- docs/adr/README.md (index row)
- tests/test_ci_contracts.py (KNOWN_ADRS entry — required registry sync)

## Tests executed

- `pnpm --filter @fdbtrade/contracts run test`: 26 files / 374 tests green
  (14 new audit tests: happy path, actor/source/shape/time validation,
  redaction fail-closed on before/after, duplicate replay refused,
  chronology enforced, same-instant legality + seq contiguity,
  tamper-evidence, deterministic ids, pinned serialization, digest
  determinism, subject/actor queries, frozen vocabularies).
- `pnpm --filter @fdbtrade/backend run test`: obs suites 23/23 green
  (9 new auditService/route tests: append happy path, malformed append
  leaves log unchanged, duplicate/chronology through the service,
  secret-shaped summaries refused, digest stability, API 200/400/401/405).
- contracts + backend typecheck: 0 errors; lint clean for both packages.
- `python3 -m unittest tests.test_ci_contracts`: 18/18 green after the
  ADR-0025 sync.

## Acceptance criteria

- [x] Audit entries include actor, before/after summary, timestamp,
  correlation and source (schema-pinned; `anonymous` actors refused).
- [x] No silent edits (append-only vocabulary; duplicate replay and
  backdating fail closed; no update/delete operations exist).
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified (ADR index + CI ADR registry are the
  required synchronization for ADR-0025; the logging export is the shared
  redaction boundary the ADR explicitly reuses).
- [x] Completion report written.

## Known limitations / blockers

- Storage is process-lifetime in-memory; durable append-only storage (DB
  table or file with the same digest rule) can be added later behind the
  same contract without schema churn.
- Existing P10/P11 runtimes do not yet append to this ledger (they have
  their own specialized decision audit logs); adoption happens as those
  services gain privileged-mutation surfaces (P13-05 wires the controls).
- Port-3000 pre-existing blocker for `make start`-based Python acceptance
  still applies (documented in prior reports).

## Follow-up required before next prompt

- None. Next prompt per required order: P13-03 Build strategy/model
  registry UI.

## Risk notes

- Trading safety: the audit layer records changes; it never executes
  anything, never touches a broker, and cannot alter risk state. Live
  execution remains OFF (ADR-0005).
- Quant integrity: content-addressed ids + canonical serialization pin
  reproducibility; chronology enforcement prevents backdating; the digest
  makes stream tampering detectable.
- Security: fail-closed redaction on before/after summaries; read surface
  session-guarded (401) and write-method-guarded (405); no secrets in
  fixtures or payloads.
