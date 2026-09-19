# ADR-0028: Operational controls with RBAC, locked live-execution flag and audited workflow

- Status: Accepted
- Date: 2026-09-12 (UTC)
- Deciders: FdbTrade owner (approved via P13 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0005 (live trading OFF), ADR-0008 (private single-user auth), ADR-0020 (promotion gates), ADR-0022 (risk engine + kill switch), ADR-0025 (audit log), ADR-0026 (registry), ADR-0027 (health + risk-state store)

## Context

The frozen blueprint's P13 phase requires operational controls: feature
flags, a kill-switch UI, a publish/rollback workflow and incident notes,
with the acceptance criterion that privileged actions are authenticated,
authorized and audited, and the non-goal that no live enablement happens in
this phase. P13-04 introduced the latched risk-state store (kill authority);
P13-03 the registry; P13-02 the audit ledger. What was missing is a control
plane tying them together under explicit role-based access control.

## Decision

1. The controls vocabulary lives in `contracts/src/obs/controls.ts` as
   pure, typed, zod-validated TS. Frozen roles: `viewer | operator | admin`.
   Frozen actions with minimum roles (`CONTROLS_ACTION_MIN_ROLE`):
   view=viewer; toggle flag / engage kill / incident notes=operator;
   release kill / force state / publish / rollback=admin. `canPerform` is
   the single server-side authority; UI checks are cosmetic.
2. Feature flags (frozen keys: signal_alerts, paper_execution,
   ensemble_dashboard, research_lab, live_execution) carry updatedBy/
   AtUtc/note and every change is audited. `live_execution` is LOCKED OFF
   BY SCHEMA — `enabled: true` fails validation with the P17-gate message;
   no flag flip can enable live trading in this phase (blueprint
   non-negotiable). Defaults: introspective surfaces ON, paper and live
   execution OFF.
3. The kill switch routes through the P13-04 `RiskStateStore` (P11
   semantics): engage = operator+, release = admin, human-only, latched,
   never auto-reset; release lands in red. Every applied override is
   audited with actor + before/after state.
4. Publish/rollback is a registry-linked workflow: a publish record carries
   the registry `entryId`, a P09 `evidenceHash` linkage (champion-gate
   proof), and the CAPTURED `previousArtifactId` (a caller-supplied mismatch
   with the live version fails closed). Publishing is idempotent per
   content; rollback marks the record `rolledBack` (history is never
   deleted) and moves the family pointer to the previous version — or
   removes it when none existed; rollback without a live artifact fails
   closed. Publish/rollback requires the admin role and is audited.
5. Incident notes carry title, severity (`low|medium|high|critical`),
   status, note, createdBy/AtUtc, resolvedBy/AtUtc (schema-pinned pairing:
   open <=> null resolution, resolved <=> actor + timestamp). Resolution is
   a state transition, not a rewrite; re-resolving is a no-op; unknown
   incidents fail closed. All content-addressed (`inc_` ids).
6. Backend `ControlsService` enforces RBAC BEFORE any state or audit change
   (a denied action leaves zero audit entries) and wraps every mutation
   with an audit append. The API surface `GET/POST /api/admin/controls`
   (session-guarded) derives the role server-side — the private single
   user holds the admin role (ADR-0008); `ControlsAuthorizationError` maps
   to a new structured `FORBIDDEN` (403) API error code, distinct from
   401. Frontend `/admin/controls` renders flags (live execution visibly
   locked), the kill-switch form (reason required; engage/release/force
   buttons state-aware), publish state with rollback pointers, and incident
   notes — read views are fail-closed zod-validated; actions POST to the
   backend.

## Consequences

- Privileged actions are authenticated (session), authorized (RBAC matrix
  enforced server-side before state changes) and audited (actor,
  before/after, correlation, source) — the P13-05 acceptance criterion.
- `FORBIDDEN`/403 joins the API error taxonomy; 401 remains authentication
  and 403 authorization.
- Live enablement is impossible through the controls surface in this phase;
  the P17 live gate owns any future unlock (schema, not convention).
- Flags/publish/incidents are in-process state; durable stores can land
  later behind the same contracts.
- The single user being admin means 403 cannot be observed via the live API
  yet; the RBAC denial path is pinned by service tests with injected
  roles, and the mapping is pinned by the errors test.

## Verification

- `pnpm --filter @fdbtrade/contracts run test` — `obs-controls.test.ts`
  (22 tests) green: RBAC totality + matrix + fail-closed, flag defaults,
  live_execution lock, publish chain/previous-capture/idempotency (bug
  found and fixed: idempotency must be checked before the live-pointer
  mismatch), rollback restore + history preservation + fail-closed cases,
  incident open/resolve/no-op/unknown + pairing + malformed refusals.
- `pnpm --filter @fdbtrade/backend run test` — controls suites green:
  RBAC denial before any audit change, operator-vs-admin kill authority,
  audited flag toggle, P17 lock through the service, kill routing through
  the latched store, audited publish/rollback, incidents, API
  GET/POST happy path + malformed 400 + live-lock 400 + 401 + 405; errors
  test extended with FORBIDDEN/403.
- `pnpm --filter @fdbtrade/frontend run test` — controls client tests green
  (valid/malformed view, non-200/unreachable fail closed, safe action
  failures).
- Typecheck 0 errors + lint clean across contracts, backend, frontend.
