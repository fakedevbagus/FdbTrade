# ADR-0048: Authoritative research API

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private operator
- Supersedes: no authority; adds authenticated adapters over ADR-0041
- Related: ADR-0039, ADR-0040, ADR-0041, ADR-0046, ADR-0047
- Work unit: R1.2

## Context

R0.8 made SQLite and content-addressed artifacts authoritative for one frozen,
deterministic historical research baseline. That authority was exercised only
through direct tests. The production API still exposed the unrelated legacy
`/api/backtest/runs` behavior, so an operator could neither invoke nor reopen
R0.8 evidence through an authenticated boundary.

R1.2 needs a narrow adapter over the existing authority. It must preserve the
frozen research assumptions, verify durable evidence, recover interrupted
work, and keep historical results separate from signals, risk, paper outcomes,
confidence and model promotion.

## Decision

1. `POST /api/research/runs` requires the private session and accepts exactly
   an existing R0.6 `datasetId` and a canonical millisecond-precision
   `createdAtUtc`. Query extensions, unknown fields and unsupported methods are
   rejected.
2. Before queueing work, the adapter idempotently registers or verifies the
   frozen R0.7 baseline rule and R0.8 research configuration. It then invokes
   R0.8 recovery and refuses to start another run if any registered result
   fails integrity verification.
3. The POST calls `ResearchBacktestAuthority.runDataset`; it does not copy
   research or engine logic. Dataset/config identity remains the R0.8 dedupe
   key, so repeated calls reopen one durable run with `executed=false`.
4. `GET /api/research/runs` returns registered R0.6 dataset metadata and at
   most the newest 100 R0.8 runs ordered by creation time and run identity
   descending. `GET /api/research/runs/{id}` accepts only canonical `rbr_`
   identities and returns one run. Both reads reject query fields.
5. Read projections are SQLite and immutable-artifact backed. Succeeded and
   blocked runs re-hash artifact bytes and verify byte count, summary, source
   dataset, frozen config, engine manifest and request lineage before return.
   Failed runs remain inspectable from SQLite without fabricating evidence.
6. Responses label research as historical-only, uncalibrated, ineligible for
   model promotion and not operational-outcome authority. The legacy backtest
   endpoint remains explicitly non-authoritative.
7. No migration is added. The ledger remains nine migrations through
   `0009_operational_hardening`; SQLite remains sole mutable metadata authority.
8. R0.7 evaluation/candidate/evidence and R0.9 risk, paper, fill and outcome
   tables are not mutated. Scheduling, providers, demo/live execution and M48
   remain disconnected.

## Consequences

- An authenticated local operator can execute, list and reopen the one R0.8
  baseline without promoting the legacy route or creating a second authority.
- A corrupt prior result blocks new execution, and corrupt terminal evidence
  cannot be projected as a partial success.
- The collection projection is deliberately bounded; pagination and a research
  workbench remain later work.
- Registering the frozen rule/config is setup metadata only. It does not create
  an operational signal evaluation or candidate.

## Verification

File-backed route tests cover authentication, strict schemas, registered
dataset identity, successful and quality-blocked runs, deterministic list and
detail reads, duplicate replay, restart recovery, artifact tamper rejection and
R0.7/R0.9 non-mutation. Python contracts pin production wiring, safety flags,
nine migrations and all ten M48 hashes. `make toolchain-gate` remains the final
acceptance authority.
