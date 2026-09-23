# ADR-0043: UI and operational hardening

- Status: Accepted
- Date: 2026-09-23
- Deciders: FdbTrade private-beta owner
- Supersedes: In-memory UI authority assumptions in ADR-0024, ADR-0027 and ADR-0028; backup deferral in ADR-0037
- Related: ADR-0005, ADR-0008, ADR-0025, ADR-0037, ADR-0039, ADR-0040, ADR-0041, ADR-0042
- Work unit: R0.10

## Context

R0.6 through R0.9 established SQLite authority for datasets, signal evidence,
historical research, risk decisions, paper execution and outcomes, but the
visible admin surfaces still included process-local risk, registry and control
state from the pre-rebuild application. The local operator also had no truthful
SQLite backup/restore path: legacy scripts correctly failed closed after the
PostgreSQL retirement. R0.10 must expose existing authority without making the
browser authoritative and must prove recovery without adding a provider or
execution path.

## Decision

1. Migration `0009_operational_hardening` adds only the append-only
   `operational_events` stream. It records successful backup, restore and local
   deployment drills with contiguous sequence numbers and content digests.
   Updates and deletes are rejected by SQLite triggers.
2. The authenticated operational overview is a read-only projection over the
   R0.6–R0.9 tables. It reports fixed seven-major/15m/1h/4h scope, durable risk
   state, status counts, reconciliation failures, recent lineage and recovery
   evidence. It creates no signal, research run, order, outcome or promotion.
3. The admin kill controls call `RiskPaperAuthority` directly. The old
   process-local risk store is not used by production controls or health.
   Engage, release and force-state remain the only UI mutations; release from
   kill remains conservative and the durable R0.9 latch remains authoritative.
4. Navigation points to the operational overview, verified historical dataset
   surface, durable risk controls and health. Earlier deterministic dashboard
   and scanner routes remain regression evidence but are not presented as the
   authoritative operational surface.
5. A backup is a Node 24 SQLite online snapshot plus every R0.6 market-data and
   R0.8 research artifact referenced by that snapshot. A manifest pins the
   migration ledger, byte counts, SHA-256 digests and safety flags. Publication
   is staged and renamed only after integrity verification.
6. Restore accepts only a verified R0.10 backup and an absolute empty target
   data root. It copies no unlisted state, verifies SQLite integrity, foreign
   keys, migrations and artifact hashes, then records a durable restore event.
   It never overwrites an existing data root.
7. The deployment drill is local and hermetic: snapshot, restore to a temporary
   root, reopen and re-verify, then record the result in the source SQLite
   authority. It does not claim an external staging deployment.
8. Live execution, provider-order transport, credentialed/network providers,
   model promotion and M48 remain disconnected. Paper actions still require a
   persisted R0.9 risk decision; the UI exposes no order action.

## Consequences

- The operator can inspect one honest cross-authority view and can prove a
  recoverable SQLite/artifact set without Docker, PostgreSQL, Redis or network.
- Backup directories are evidence artifacts, not a second metadata authority;
  SQLite remains the only mutable durable metadata authority.
- Restore is intentionally non-destructive. Replacing an active data root is a
  separate human filesystem operation after services are stopped and the
  restored root is verified.
- Process-local legacy registry, feature-flag and incident-note services remain
  code-level historical evidence but are no longer exposed by the operational
  navigation or control route.
- No claim is made about remote deployment, provider readiness, live execution,
  model quality or profitability.

## Verification

- Vitest covers the SQLite operational projection, immutable event triggers,
  durable health/risk wiring and frontend validation boundaries.
- Python behavior tests perform migrate, backup, artifact copy, restore, reopen,
  non-empty-target rejection, tamper rejection and a local deployment drill in
  temporary directories.
- Migration lifecycle tests require nine ordered migrations and rollback/reapply
  of `0009_operational_hardening`.
- `make toolchain-gate` is the final bounded acceptance authority.
