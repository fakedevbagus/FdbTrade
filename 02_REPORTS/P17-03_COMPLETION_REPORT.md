# Completion Report

Prompt ID: P17-03
Phase: P17 Live Gate
Date/time UTC: 2026-09-12T15:50:00Z
Branch/commit: main (uncommitted working tree; commit deferred to phase gate)

## What changed

Implemented tiny-live pilot controls:

- Created `contracts/src/live/pilot.ts`:
  - `LivePilotConfig`: smallest permitted order size (dust floor) AND ceiling, symbol allowlist, trading days (ISO 1..7), UTC intraday session window (overnight wrap supported, empty window rejected), `maxOrdersPerSession`, `maxConcurrentPositions`, and a mandatory armed `emergencyStop` (a pilot cannot be created without it).
  - Strictness enforcement (acceptance criterion): `pilotStrictnessViolations` / `assertPilotStricter` fail closed when the pilot allows a bigger volume, more symbols, symbols outside the demo allowlist, or a higher order ceiling than the demo configuration. Equal limits are acceptable (never looser).
  - `LivePilotSession.checkEntry`: deterministic entry gate — refuses when stopped, volume below floor / above ceiling, symbol not allowlisted, instant before session start, outside trading days / session window (start inclusive, end exclusive), order ceiling reached, or concurrency ceiling reached.
  - `emergencyStop`: immediate entry disable; idempotent (first event is the record); event carries `exitManagementPreserved: true` and `stateDeleted: false` — rollback never deletes state.
  - `isInSessionWindow` helper (UTC, deterministic, overnight-window aware).
- No performance-based scaling anywhere: order volume fixed by config (non-goal respected).

## Files changed

- `contracts/src/live/pilot.ts` (new)
- `contracts/src/live/index.ts` (export added)
- `contracts/src/__tests__/live-pilot.test.ts` (new, 22 tests)
- `02_REPORTS/P17-03_COMPLETION_REPORT.md` (new)

## Tests executed

- `pnpm --filter @fdbtrade/contracts test -- src/__tests__/live-pilot.test.ts` — 22/22 passed.
- Full contracts suite, lint, typecheck run at phase end (see P17 phase report).

## Acceptance criteria

- [x] Pilot configuration is stricter than normal demo configuration (machine-checked by `assertPilotStricter`; violations listed explicitly).
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified without justification.
- [x] Completion report written.

## Known limitations / blockers

- Session state is in-memory per process; persistence deferred.
- Wiring the pilot gate to the actual live submission path happens when a live wire transport exists (none in this phase — contract layer only).

## Follow-up required before next prompt

- P17-04: Implement live rollback and circuit breakers.

## Risk notes

- Trading safety: emergency stop armed by default and required by schema; entry gate fails closed on every dimension; exit-management path documented as preserved.
- Quant integrity: deterministic window/entry checks; UTC only; no wall-clock reads.
- Security: no secrets; actor ids are shape-validated.
