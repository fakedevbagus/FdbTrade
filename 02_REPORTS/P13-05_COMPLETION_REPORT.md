# Completion Report

Prompt ID: P13-05 Build operational controls
Phase: P13 Admin & Observability
Date/time UTC: 2026-09-12T01:00:00Z
Branch/commit: main / c001db9 + P10–P13-05 working tree (uncommitted)

## What changed

Operational controls with RBAC: feature flags, kill-switch UI,
publish/rollback workflow and incident notes (ADR-0028). Privileged actions
are authenticated (session), authorized (frozen role matrix enforced
server-side BEFORE any state change) and audited (actor, before/after,
correlation, source). Live enablement is impossible in this phase.

- `contracts/src/obs/controls.ts` (new): frozen RBAC matrix
  (`viewer|operator|admin` x 9 actions with minimum roles; `canPerform` /
  `minRoleFor` fail closed); feature flags (5 frozen keys; `live_execution`
  LOCKED OFF BY SCHEMA — enabling fails with the P17-gate message);
  publish/rollback workflow (registry `entryId` + P09 `evidenceHash`
  linkage; CAPTURED `previousArtifactId` — mismatch fails closed; idempotent
  per content; rollback marks `rolledBack`, preserves history, restores
  previous or removes the pointer); incident notes (open/resolved with
  schema-pinned actor+timestamp pairing; resolve is a transition not a
  rewrite; unknown incident fails closed; content-addressed ids).
- `backend/src/obs/controlsService.ts` (new): RBAC gate BEFORE any state or
  audit change (denied actions leave zero audit entries); flag toggles,
  kill engage/release/force routed through the P13-04 latched
  `RiskStateStore` (human-only, release lands red), publish/rollback,
  incident add/resolve — every mutation audited (ADR-0025).
- `backend/src/app/api/admin/controls/route.ts` (new): session-guarded
  GET (flags, risk state, publish view, incidents, allowed actions) +
  POST (one discriminated action; server-side role derivation — the
  private single user holds admin; `ControlsAuthorizationError` -> 403).
- `backend/src/http/errors.ts` (modified): additive `FORBIDDEN`/403 error
  code + `ApiError.forbidden()` (authenticated-but-unauthorized, distinct
  from 401). Taxonomy test updated + extended.
- `frontend/src/lib/controls.ts` + `components/admin/KillSwitchForm.tsx` +
  `/admin/controls` page (new): zod-validated fail-closed client;
  kill-switch form (reason required, state-aware buttons; backend is the
  authority); flags table (live execution visibly locked — P17), publish
  state with rollback pointers, incident notes.
- ADR-0028 recorded + indexed; CI ADR registry synchronized.

## Files changed

- contracts/src/obs/controls.ts (new)
- contracts/src/__tests__/obs-controls.test.ts (new)
- contracts/src/index.ts (barrel export)
- backend/src/obs/controlsService.ts (new)
- backend/src/obs/__tests__/controlsService.test.ts (new)
- backend/src/app/api/admin/controls/route.ts (new)
- backend/src/http/errors.ts (FORBIDDEN/403 — additive taxonomy entry)
- backend/src/http/__tests__/errors.test.ts (expected map + forbidden test)
- frontend/src/lib/controls.ts (new)
- frontend/src/lib/__tests__/controls.test.ts (new)
- frontend/src/components/admin/KillSwitchForm.tsx (new)
- frontend/src/app/(app)/admin/controls/page.tsx (new)
- docs/adr/ADR-0028-operational-controls-rbac.md (new)
- docs/adr/README.md (index row)
- tests/test_ci_contracts.py (KNOWN_ADRS entry — required registry sync)

## Tests executed

- `pnpm --filter @fdbtrade/contracts run test`: 29 files / 426 tests green
  (22 new controls tests; includes the regression fixture for the bug
  found: publish idempotency must be checked before the live-pointer
  mismatch — fixed in `publishArtifact`).
- `pnpm --filter @fdbtrade/backend run test`: 63 files / 587 tests green
  (11 new controls tests incl. RBAC-before-audit, P17 lock through the
  service, kill routing, audited publish/rollback; errors test FORBIDDEN).
- `pnpm --filter @fdbtrade/frontend run test`: 12 files / 92 tests green
  (6 new controls client tests).
- Typecheck 0 errors + lint clean across contracts, backend, frontend.
- `python3 -m unittest tests.test_ci_contracts`: 18/18 green.

## Acceptance criteria

- [x] Privileged actions are authenticated, authorized and audited
  (session 401; RBAC matrix enforced before any state/audit change with a
  403 FORBIDDEN mapping; ADR-0025 ledger entries with actor + before/after
  for flags, kill overrides, publish/rollback).
- [x] No live enablement in this phase (`live_execution` locked OFF by
  schema — `enabled: true` fails with the P17 message; pinned at schema,
  service and API layers).
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified (errors.ts FORBIDDEN is the minimal
  taxonomy extension for authorization-vs-authentication; ADR index + CI
  ADR registry are the required ADR-0028 synchronization).
- [x] Completion report written.

## Known limitations / blockers

- Flags/publish/incidents are in-process state; durable stores can land
  later behind the same contracts (no schema churn).
- The single private user holds the admin role, so 403 cannot be observed
  through the live API yet; the denial path is pinned by service tests
  with injected roles and the errors test.
- Publish requires callers to supply registry entryId/evidenceHash
  linkage; the research-lab runtime does not yet invoke publish (the
  workflow is contract-complete; adoption lands with later prompts).
- Port-3000 pre-existing blocker for `make start`-based Python acceptance
  still applies (documented since P10).

## Follow-up required before next prompt

- None. P13 phase gate complete: health + audit + strategy/model registry +
  operational controls (RUN_ORDER P13 gate). Next prompt per RUN_ORDER: P14
  (Hardening) — security, load, chaos, CI/CD, backups.

## Risk notes

- Trading safety: `live_execution` locked OFF BY SCHEMA (P17 gate owns the
  unlock); kill switch human-only, latched, never auto-reset (P11
  semantics via the P13-04 store); no broker access; live execution
  remains OFF (ADR-0005).
- Quant integrity: publish requires registry + evidence linkage (no
  ungated promotion); rollback history preserved (no silent edits);
  deterministic content-addressed ids throughout.
- Security: RBAC enforced server-side before any state change (denied
  actions leave no trace); every mutation audited; kill actions require a
  recorded reason; no secrets in any payload; 401 vs 403 distinct.
