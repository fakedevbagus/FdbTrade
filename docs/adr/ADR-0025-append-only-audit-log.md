# ADR-0025: Append-only audit log for privileged changes

- Status: Accepted
- Date: 2026-09-11 (UTC)
- Deciders: FdbTrade owner (approved via P13 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC), ADR-0008 (private single-user auth), ADR-0022 (risk engine), ADR-0024 (structured logging)

## Context

The frozen blueprint's P13 phase requires an immutable-style, append-only
audit log for privileged changes: configuration, strategy versions, risk
overrides and execution state changes. Acceptance: entries include actor,
before/after summary, timestamp, correlation and source. There must be no
silent edits (no update/delete path), replayed changes must be detected, and
before/after summaries must never carry credentials. The P11-05 risk audit
log already serves risk-decision snapshots; this log is the general
privileged-change ledger and deliberately reuses the P13-01 redaction
boundary.

## Decision

1. The audit vocabulary lives in `contracts/src/obs/audit.ts` as pure, typed,
   zod-validated TS: `AuditEvent` carries `actor`, `action`, `subjectType`,
   `subjectId`, `before` (nullable summary), `after` (summary), `atUtc`
   (UTC), `correlationId` and `source`. Adding a subject type or source value
   requires a superseding ADR (frozen lists).
2. Frozen subject types: `config | strategy_version | risk_override |
   execution_state | feature_flag | incident`. Frozen sources: `admin-api |
   risk-service | paper-service | research-lab | pipeline | system`.
3. Actors are lowercase identifiers; `anonymous` is REFUSED by schema — every
   entry must name a real actor (human username or system role).
4. Events are content-addressed (`aud_` + FNV-1a64 of the canonical
   serialization; sorted summary keys; fixed field order) and carry a
   1-based, contiguous, log-assigned `seq`. Summary key order cannot change
   an event id.
5. The log is append-only with fail-closed semantics: duplicate event ids
   (replays of the same change) are REFUSED; out-of-chronology appends
   (earlier `atUtc` than the last event) are REFUSED; same-instant distinct
   events are legal and ordered by `seq`. There is no update or delete
   operation in the vocabulary.
6. Before/after summaries reuse the P13-01 redacted attribute record
   (scalar-only values; secret-shaped keys fail validation) — a credential
   cannot be recorded as a before/after value even by caller bug.
7. `auditLogDigest` (FNV-1a64 over the newline-joined canonical stream)
   provides tamper-evidence for a later durable storage integration; the
   backend exposes the current digest on every audit read.
8. Backend wiring: `backend/src/obs/auditService.ts` (process-wide singleton;
   wall clock read ONLY at the recording boundary for the default `atUtc`)
   and a read-only, session-guarded `GET /api/admin/audit` (optional
   `subjectId` filter, latest 500 events + digest; no client write method —
   audit entries are appended by privileged mutations inside their owning
   services, e.g. the P13-05 operational controls).

## Consequences

- Every privileged change recorded through `auditService.append` is
  attributable (actor), explainable (before/after), ordered (seq + atUtc)
  and correlatable (correlationId); the P11-05 risk decision audit remains
  the specialized decision snapshot store.
- The in-memory log is process-lifetime storage; durable append-only storage
  (DB table or file) can be added later behind the same contract without
  schema churn.
- Strict chronology means a caller cannot backdate an entry after a later
  one has been written in the same process; a durable store must preserve
  this rule.
- The API exposes no audit-write path to clients: privileged mutations
  append internally at the moment of change (single transactional moment),
  which P13-05 enforces.

## Verification

- `pnpm --filter @fdbtrade/contracts run test` — `obs-audit.test.ts` (14
  tests) green: happy path, actor/source/shape/time validation, redaction
  fail-closed on before/after, duplicate replay refused, chronology
  enforced, same-instant distinct events legal + seq contiguous,
  tamper-evidence (changed content -> different id), deterministic ids
  (summary key order), pinned canonical serialization, deterministic stream
  digest, subject/actor queries, frozen vocabularies.
- `pnpm --filter @fdbtrade/backend run test` — `auditService.test.ts` (9
  tests) green: append happy path, malformed append leaves log unchanged,
  duplicate/chronology through the service, secret-shaped summaries
  refused, digest stability, API list/filter/400/401/405.
- contracts + backend typecheck: 0 errors; lint clean.
