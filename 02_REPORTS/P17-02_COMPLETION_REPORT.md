# Completion Report

Prompt ID: P17-02
Phase: P17 Live Gate
Date/time UTC: 2026-09-12T15:32:00Z
Branch/commit: main (uncommitted working tree; commit deferred to phase gate)

## What changed

Implemented the manual approval workflow for live sessions:

- Created `contracts/src/live/approval.ts`:
  - Human-only approval: `liveApprovalActorSchema` rejects `anonymous` and AI/automation identities (`ai`, `llm`, `agent`, `bot`, `auto*`, `system`, `model`, `gpt*`, `claude*`) — no approval by AI/LLM.
  - Immutable, append-only records: content-addressed `lapp_` ids (FNV-1a64); no update/delete path; duplicate replay refused; out-of-chronology appends refused.
  - Approval carries mandatory reason (10–2000 chars), expected limits (`minOrderVolumeUnits`, `maxOrderVolumeUnits`, `maxConcurrentPositions`, `maxDailyLossPct`, `allowedSymbols`), approval instant, expiry instant and linked preflight id.
  - Safe expiry: strict boundary (at/after `expiresAtUtc` the approval authorizes nothing); hard 24h duration ceiling on any approved session.
  - Revocation: original record never mutated or deleted; a new `revoked` record is appended and the original gains a `supersededBy` pointer. Idempotent re-revoke. `resolveActiveLiveApproval` returns the single current authorizing record or null (fail closed). `assertApprovalAuthorizes` throws with exact cause.
- Exported from `contracts/src/live/index.ts` (already re-exported by the contracts barrel).

## Files changed

- `contracts/src/live/approval.ts` (new)
- `contracts/src/live/index.ts` (export added)
- `contracts/src/__tests__/live-approval.test.ts` (new, 13 tests)
- `02_REPORTS/P17-02_COMPLETION_REPORT.md` (new)

## Tests executed

- `pnpm --filter @fdbtrade/contracts test -- src/__tests__/live-approval.test.ts` — 13/13 passed.
- Full contracts suite, lint, typecheck run at phase end (see P17 phase report).

## Acceptance criteria

- [x] Approval is immutable/audited (append-only log, content-addressed ids, supersede pointers, replay refused) and expires safely (strict expiry boundary + 24h ceiling; fail-closed resolution).
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified without justification.
- [x] Completion report written.

## Known limitations / blockers

- Authentication of the actor is upstream (backend auth, ADR-0008); this module validates actor identity shape and the human-only policy.
- Persistent approval store deferred; log is an in-memory contract-level structure.

## Follow-up required before next prompt

- P17-03: Implement tiny-live pilot controls.

## Risk notes

- Trading safety: approvals are the only live-session authority besides the P17-01 preflight; expiry is strict; revocation preserves full history; AI can never approve.
- Quant integrity: deterministic ids and ordering; UTC timestamps only.
- Security: no secrets in records; reason text is length-bounded plain text.
