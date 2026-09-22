# docs/adr/ — Architecture Decision Records

Architecture Decision Records (ADRs) record durable, binding decisions for
FdbTrade. They are lightweight and deterministic: one decision per record,
numbered, and reviewed before a phase gate.

## Purpose

- Preserve the reasoning behind architectural decisions.
- Provide the binding contract for later prompts (a later prompt may not weaken
  an earlier acceptance gate without a superseding ADR).
- Keep "silent architecture changes" out: any change to a recorded decision
  requires a new ADR that supersedes the old one.

## Format

Every ADR MUST follow `02_TEMPLATES/ADR_TEMPLATE.md` and contain at least these
sections, in order:

1. `# ADR-XXXX: <Title>` — title line.
2. A metadata block of `- Key: value` bullets, including `Status`, `Date`
   (`YYYY-MM-DD` in **UTC**), `Deciders`, `Supersedes`, `Related`.
3. `## Context` — the problem and constraints.
4. `## Decision` — numbered, concrete, testable decisions.
5. `## Consequences` — trade-offs and follow-on work.
6. `## Verification` — how the decision is verified.

Templates live in `02_TEMPLATES/` (the canonical templates directory):
`ADR_TEMPLATE.md`, plus `COMPLETION_REPORT_TEMPLATE.md` and `PROMPT_TEMPLATE.md`.

## Numbering

ADRs are numbered sequentially `ADR-0001`, `ADR-0002`, ... The next number is
the current highest number + 1. Never reuse a number. `0000` is reserved and
not used.

## Status lifecycle

- `Proposed` — proposed at the planning stage; not yet binding.
- `Accepted` — approved and binding; recorded when the prompt that creates the
  decision lands.
- `Superseded` — replaced by a later ADR (which must reference it).
- `Deprecated` — no longer applies; keep only as history.

## Process

1. Identify a durable architectural decision within a prompt's exact scope.
2. Draft the ADR using the template, with `Status: Proposed`.
3. On completion of the prompt that decides it, set `Status: Accepted`.
4. Cross-reference related ADRs and update this index.

## Verification

- Each ADR has the required sections (enforced by
  `tests/test_ci_contracts.py`).
- ADR numbers are contiguous from `0001` with no gaps or duplicates (enforced
  by tests).
- `make check` passes after any ADR change.

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](ADR-0001-baseline-stack.md) | Baseline stack | Accepted |
| [ADR-0002](ADR-0002-repository-layout-and-workspace-contracts.md) | Repository layout and workspace contracts | Accepted |
| [ADR-0003](ADR-0003-architecture-boundaries.md) | Architecture boundaries | Accepted |
| [ADR-0004](ADR-0004-utc-time-policy.md) | UTC time policy | Accepted |
| [ADR-0005](ADR-0005-live-trading-off-by-default.md) | Live trading OFF by default | Accepted |
| [ADR-0006](ADR-0006-ci-baseline.md) | CI baseline | Accepted |
| [ADR-0007](ADR-0007-sql-migrations-and-database-foundation.md) | SQL-first migrations and database foundation | Accepted |
| [ADR-0008](ADR-0008-private-single-user-authentication.md) | Private single-user authentication | Accepted |
| [ADR-0009](ADR-0009-canonical-market-data-model.md) | Canonical market-data model | Accepted |
| [ADR-0010](ADR-0010-market-data-provider-abstraction.md) | Market-data provider abstraction and deterministic fixtures | Accepted |
| [ADR-0011](ADR-0011-data-quality-gates.md) | Data quality gates — normalize and quarantine, never repair | Accepted |
| [ADR-0012](ADR-0012-ingestion-idempotency-and-provider-health.md) | Ingestion idempotency, bounded retries and provider health | Accepted |
| [ADR-0013](ADR-0013-dataset-manifests.md) | Historical dataset manifests and replayable datasets | Accepted |
| [ADR-0014](ADR-0014-versioned-feature-definitions.md) | Versioned feature definitions and lineage contracts | Accepted |
| [ADR-0015](ADR-0015-immutable-feature-snapshot-store.md) | Immutable feature snapshot store with deterministic hashes | Accepted |
| [ADR-0016](ADR-0016-deterministic-rule-based-regime-engine.md) | Deterministic rule-based regime engine | Accepted |
| [ADR-0017](ADR-0017-canonical-strategy-interface-and-signal-contract.md) | Canonical strategy interface and signal contract v2 | Accepted |
| [ADR-0018](ADR-0018-ensemble-decision-contract-and-evidence-preservation.md) | Ensemble decision contract and auditable evidence preservation | Accepted |
| [ADR-0019](ADR-0019-event-driven-backtest-engine.md) | Event-driven backtest engine and run-result contract | Accepted |
| [ADR-0020](ADR-0020-research-lab-validation-gates.md) | Research-lab validation gates and promotion registry | Accepted |
| [ADR-0021](ADR-0021-paper-broker-and-reconciliation.md) | Paper broker state machine, deterministic fill simulation, ledger and reconciliation | Accepted |
| [ADR-0022](ADR-0022-independent-risk-engine.md) | Independent risk engine with hard limits, portfolio controls and kill switch | Accepted |
| [ADR-0023](ADR-0023-analytics-layer.md) | Analytics layer for trade outcomes, calibration, MAE/MFE and attribution | Accepted |
| [ADR-0024](ADR-0024-structured-logging-and-tracing.md) | Structured logging, correlation and end-to-end tracing | Accepted |
| [ADR-0025](ADR-0025-append-only-audit-log.md) | Append-only audit log for privileged changes | Accepted |
| [ADR-0026](ADR-0026-versioned-strategy-model-registry.md) | Versioned strategy/model registry with research-run linkage | Accepted |
| [ADR-0027](ADR-0027-health-states-and-fail-safe-behavior.md) | Health states with explicit fail-safe behavior | Accepted |
| [ADR-0028](ADR-0028-operational-controls-rbac.md) | Operational controls with RBAC, locked live-execution flag and audited workflow | Accepted |
| [ADR-0029](ADR-0029-broker-read-only-adapter-contract.md) | Provider-neutral broker read-only adapter contract and execution exclusion | Accepted |
| [ADR-0030](ADR-0030-demo-execution-and-environment-guards.md) | Demo execution adapter and environment guards | Accepted |
| [ADR-0031](ADR-0031-live-gate-preflight-approval-pilot-controls.md) | Live gate preflight, approval, pilot controls and circuit breakers | Accepted |
| [ADR-0032](ADR-0032-advanced-alpha-research-layer.md) | Advanced-alpha research layer (meta-labeling, ML challengers, provider comparison, portfolio intelligence, adaptive research, feature sandbox) | Accepted |
| [ADR-0033](ADR-0033-reproducible-bootstrap-and-beta-onboarding.md) | Reproducible bootstrap and beta onboarding | Accepted |
| [ADR-0034](ADR-0034-continuous-scheduler-and-runtime-hardening.md) | Continuous scheduler and runtime hardening | Accepted |
| [ADR-0035](ADR-0035-user-facing-historical-research-workflow.md) | User-facing historical research workflow | Accepted |
| [ADR-0036](ADR-0036-seven-major-runtime-coverage.md) | Seven-major runtime coverage | Accepted |
| [ADR-0037](ADR-0037-local-sqlite-authority.md) | Local SQLite authority | Accepted |
| [ADR-0038](ADR-0038-local-application-and-runtime-lifecycle.md) | Local application and runtime lifecycle | Accepted |
