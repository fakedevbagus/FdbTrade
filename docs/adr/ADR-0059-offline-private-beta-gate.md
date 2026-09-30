# ADR-0059: Offline Private Beta Gate

- Status: Accepted
- Date: 2026-09-30
- Deciders: FdbTrade private operator
- Supersedes: ad hoc private-beta walkthroughs without durable recovery evidence
- Related: ADR-0033, ADR-0037, ADR-0044, ADR-0056, ADR-0058
- Work unit: R1.13

## Context

R1.12 proved bounded upgrade and rollback safety. A private beta still needs one
repeatable end-to-end operator exercise that proves durable observable state
across the current offline decision-to-paper authorities without expanding
product scope.

## Decision

Adopt `scripts/private-beta-gate.py` as the hermetic R1.13 acceptance drill.
It creates a temporary migrated SQLite root and verifies bootstrap/login, CSV
import, signal evidence, research plus temporal validation, deterministic paper
input resolution, explicit operator-confirmed paper execution, outcome,
operational health, restart, verified backup, restore and reopen.

The gate requires three bounded reopen soak cycles. Authority is granted only
when every step passes and the complete repository gate passes. The drill uses
no network, external credential, provider, remote bind, live/demo execution,
automatic paper run, scheduler or M48 runtime.

## Recovery

Recovery is a verified restore into a new empty root, followed by integrity,
foreign-key, migration, artifact and workflow-authority checks. Production
rollback remains verified restore or reviewed compensating migration, never
reset or partial replacement.

## Consequences

The gate provides repeatable private-beta evidence without adding a product
feature. It is authority-level rather than browser automation, uses a tiny
fixture, and does not establish strategy performance or production readiness.

## Verification

Focused Python contracts execute all twelve steps and three reopen soak cycles.
The complete repository gate verifies lint, types, tests, builds, progression,
twelve migrations and preservation before the R1.13 authority artifact is
recorded.