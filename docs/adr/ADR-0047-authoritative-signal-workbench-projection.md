# ADR-0047: Authoritative signal workbench projection

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private operator
- Supersedes: no authority; adds an operator projection over ADR-0040 and ADR-0045
- Related: ADR-0039, ADR-0040, ADR-0045, ADR-0046
- Work unit: R1.1

## Context

R0.7 made SQLite authoritative for deterministic signal evaluations,
evidence, candidates and lifecycle. R0.12 added the authenticated operator POST
that creates or replays an evaluation. The production UI still exposed only
the older fixture-backed scanner, and there was no authenticated way to reopen
R0.7 run/candidate evidence after a restart.

R1.1 needs an operator workbench without copying signal logic, treating the UI
as authority, or relabeling the legacy scanner. Read paths must also fail closed
when terminal evidence or its immutable R0.6 artifact lineage is corrupt.

## Decision

1. `GET /api/signals/evaluations` is the authenticated list projection. It
   returns registered R0.6 datasets and at most the newest 100 R0.7 runs,
   ordered by assessment, creation and run identity descending.
2. `GET /api/signals/evaluations/{runId}` is the authenticated detail
   projection. The path accepts only canonical `sir_` identities. Both GET
   routes reject all query fields.
3. The projection executes SELECT/read operations only. It never calls R0.7
   recovery, evaluation or lifecycle advancement and adds no mutable state.
4. Succeeded and blocked reads verify the stored evidence digest, dataset/rule
   lineage, candidate identity, lifecycle ordering and the R0.6 artifact bytes.
   Failed runs remain inspectable from SQLite even when their failure was an
   unavailable or corrupt input artifact.
5. The workbench selects a registered R0.6 dataset and submits exactly its
   identity plus recorded assessment instant to the existing R0.12 POST. The
   frozen R0.7 rule is not editable. Identical submissions reopen the same run.
6. Browser mutation uses one same-origin facade that forwards only the exact
   POST body and opaque session cookie. Backend authentication and schemas
   remain the security/authority boundary; the UI stores no credentials.
7. The workbench labels candidate, wait, blocked and failed states explicitly
   with dataset, artifact, rule and UTC lineage. Empty/unavailable states never
   fall back to the fixture scanner.
8. No migration is added. The ordered migration ledger remains nine through
   `0009_operational_hardening`.

## Consequences

- Operators can create, list and reopen authoritative signal evidence after a
  process restart without using legacy fixture surfaces.
- Corrupt terminal evidence fails the read route closed instead of rendering a
  partial or invented result.
- The list is intentionally bounded. Pagination or broader operational search
  requires a later authorized unit.
- R0.8 research, R0.9 risk/paper, scheduling, provider access, model promotion,
  demo/live execution and M48 remain disconnected.

## Verification

File-backed backend route tests cover authentication, strict list/detail
boundaries, deterministic ordering, candidate/wait/blocked/failed display,
duplicate replay, reopen and cross-authority non-mutation. Frontend tests cover
strict response schemas, empty/error states, exact submissions and same-origin
forwarding. `make toolchain-gate` remains final acceptance authority.
