# ADR-0056: Durable operational health

- Status: Accepted
- Date: 2026-09-29
- Deciders: FdbTrade private operator
- Supersedes: invented process-local health defaults in ADR-0027 implementation
- Related: ADR-0027, ADR-0037, ADR-0039, ADR-0042, ADR-0043, ADR-0055
- Work unit: R1.10

## Context

The health route labeled queue, API and cache healthy from process defaults and
used an in-memory error ring. It did not verify durable run backlog, accepted
data, artifact bytes, disk budget or durable failure/audit evidence.

## Decision

1. Health remains authenticated and read-only.
2. SQLite supplies pending/running run counts, accepted dataset freshness,
   durable failures/audit counts and risk latch state.
3. Every registered market artifact is checked for presence, byte count and
   SHA-256. Disk free space is measured against an explicit minimum budget.
4. Missing data is not healthy; stale, corrupt, low-disk, backlog and unknown
   evidence degrade or fail closed through the existing health contract.
5. Database or projection uncertainty returns unknown/down checks, never green.
6. No health read mutates risk, queue, data, artifact or audit state.

## Consequences

Health is conservative and may remain fail-safe until accepted data and risk
evidence exist. Operators receive truthful component metrics across restarts.
No migration, scheduler, provider selection, trading mutation or M48 wiring is
introduced.

## Verification

File-backed restart, absent data, backlog, corrupt artifact, disk-budget,
database failure and UI boundary tests plus the 15/15 gate verify the decision.
