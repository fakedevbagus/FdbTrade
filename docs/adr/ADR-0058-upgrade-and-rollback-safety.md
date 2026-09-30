# ADR-0058: Upgrade and rollback safety

- Status: Accepted
- Date: 2026-09-30
- Deciders: FdbTrade private operator
- Supersedes: unverified in-place upgrade and reset-based rollback assumptions
- Related: ADR-0007, ADR-0037, ADR-0038, ADR-0044, ADR-0056, ADR-0057
- Work unit: R1.12

## Context

R0.11 already provides crash-consistent verified backup and atomic restore, but
there was no single preflight and drill proving that an application upgrade can
validate version, exact migration ledger, artifacts and disk before operating on
a temporary restored root. Rollback policy also needed to exclude repository or
database reset as a production recovery mechanism.

## Decision

1. Upgrade preflight verifies application version, SQLite integrity/foreign keys,
   exact migration checksums, all referenced artifact hashes and a 512 MiB free
   disk budget.
2. The drill creates and verifies an R0.11 backup, injects failure immediately
   before restore publication, and requires that no target becomes visible.
3. A separate temporary root is restored, passed through the current migration
   runner, reopened read-only and rechecked for schema and artifact authority.
4. Restore rejects non-empty targets and unknown/future backup manifests.
   Compatibility is explicit: R0.10 schema 1 and R0.11 schema 2 are accepted;
   absent, malformed, unknown or future manifests fail closed.
5. Production rollback is only a verified restore or a reviewed compensating
   migration. Git/database reset is never a rollback mechanism.

## Consequences

Upgrade readiness is locally executable without mutating the production root
beyond durable backup evidence. The drill requires enough temporary disk for a
backup plus restored copy. New manifest versions require an explicit policy
change before they can be restored.

## Verification

Behavior tests prove preflight, verified backup, temporary restore/migration,
failure isolation, non-empty target preservation, future-manifest rejection and
restart/reopen. Python contracts lock policy, progression, preservation and the
canonical gate.
