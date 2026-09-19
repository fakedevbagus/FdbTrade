# ADR-0022: Independent risk engine with hard limits, portfolio controls and kill switch

- Status: Accepted
- Date: 2026-09-11 (UTC)
- Deciders: FdbTrade owner (approved via P11 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC), ADR-0005 (live OFF), ADR-0017 (signal contract), ADR-0019 (backtest engine), ADR-0021 (paper broker)

## Context

The frozen blueprint requires an independent risk engine: every order intent
must pass risk checks that strategy, feature, UI or LLM code can never
bypass, with hard limits (per-trade risk, aggregate open risk, daily loss,
weekly drawdown, position count, spread/slippage, stale data), portfolio
heat and correlation controls, GREEN/YELLOW/ORANGE/RED/KILL states with a
human kill switch, fail-closed behavior on uncertainty/outage, and full
auditability of every decision. P10 already froze the paper order state
machine whose `intent -> risk_checked` transition reserves the verdict slot
for this phase; the risk layer is the upstream, broker-free side of that
boundary.

## Decision

1. The risk engine lives in `contracts/src/risk/` (pure, typed, zod-
   validated TS contracts + deterministic evaluation) and imports NO broker
   module — not even the paper module — so risk stays independent of
   execution (ADR-0003). Hashing/rounding helpers are duplicated locally
   (`riskHash16`/`riskRound6`) instead of imported from `paper/`.
2. The boundary contract is `RiskCheckRequest` (verbatim signal lineage +
   account snapshot + open-position snapshot + market freshness snapshot +
   latched risk state) in, `RiskDecision` (content-addressed id, outcome,
   FINAL sized quantity, planned risk, utilization ratios, machine-readable
   rejection reasons, request digest) out. `assertRiskGateCleared` is the
   only fail-closed way for an order to leave `intent`; there is no bypass
   path, and the P10 integration tests pin `intent -> risk_checked` for
   approvals and `intent -> rejected` (`risk_rejected`) for denials.
3. Rejection reasons are a frozen machine-readable vocabulary
   (`RISK_REJECT_REASONS`, 16 codes). Check order is frozen: control plane
   (kill/orange/red/stale/provider-outage) short-circuits, then account
   hard limits, then portfolio controls (sizing feasibility, heat, currency
   exposure, correlated-group exposure, redundancy). Caps compare strict
   `>` (at-cap allowed); loss stops compare `>=`; the candidate counts
   itself in redundancy counts. These conventions are pinned by tests.
4. Sizing is deterministic and owned by the engine: final size =
   min(strategy proposal, budget / (stop distance x quote->account rate));
   proposals are never inflated. The 0.25-0.50% per-trade risk is the
   frozen blueprint PLACEHOLDER (default 0.50%), configuration, never a
   promise. All limits are versioned `RiskLimitsConfig` data.
5. Portfolio heat = sum of planned stop risks attributed from each open
   position's OWN protective stop (no caller-supplied risk numbers).
   Correlation uses the documented, versioned model
   `currency-leg-overlap-v1`: each FX position contributes two signed
   currency legs; NET per-currency exposure catches directional
   concentration, GROSS catches correlated-group stacking (e.g. the USD legs
   of all majors). Metals contribute no legs in v1 (documented, kept
   uncovered — conservative). Redundancy = concurrent same
   instrument+direction (and same strategy+instrument+direction) counts vs
   config caps.
6. Risk states are GREEN (<50% worst utilization), YELLOW (<75%, entries
   allowed at reduced size), ORANGE (<100%, no new entries), RED (>=100%,
   no new entries), KILL (manual-only, latched, never auto-derived, never
   auto-reset; release lands conservatively in RED). Overrides change the
   STATE only — never hard limits — and always carry the human actor for
   the audit trail.
7. Stale-data and provider-health gates fail closed: freshness is measured
   from the CLOSE of the last closed bar (a "closed" bar closing in the
   future is a look-ahead shape and is rejected); any provider health other
   than `healthy` blocks new intents.
8. Observability (P11-05): every check is appended to an audit log
   (`RiskAuditEvent` union: `risk_check_recorded` with the FULL request
   snapshot + decision, `risk_state_changed`, `risk_override_recorded`,
   `risk_kill_engaged`/`risk_kill_released` with the override actor). Event
   ids are content-addressed (FNV-1a64); duplicate replays fail closed; the
   tamper-evident log digest covers the full stream. No secret-bearing
   fields exist in any risk schema.

## Consequences

- Strategy/feature/UI/LLM code can only CALL `evaluateRisk`; the sized
  quantity in the decision is authoritative and the strategy proposal can
  only be reduced. A later execution phase must consume the decision's
  `sizedQuantityUnits`, not its own sizing.
- The latched state tracker and audit log are pure in-memory projections;
  persistence lands in the backend/orchestration and P13 observability
  phases. The contracts pin the shapes now so storage cannot weaken them.
- The correlation model is deliberately simple and fully documented; a
  statistical correlation matrix would require its own model version and
  validation evidence (no hidden correlations).
- Daily/weekly equity marks, provider health and conversion rates are
  INPUTS (data with provenance); risk never fabricates or hard-codes them.
- Follow-on: backend wiring (requests from the paper pipeline, snapshot
  persistence) in P12/P13; no Python mirror is required by P11 scope.

## Verification

- `pnpm --filter @fdbtrade/contracts run typecheck` (0 errors)
- `pnpm --filter @fdbtrade/contracts run lint` (clean)
- `pnpm --filter @fdbtrade/contracts run test` — 20 files / 250 tests green,
  including 6 new P11 suites (risk-contract, risk-limits-sizing,
  risk-portfolio-heat, risk-states-kill, risk-audit, risk-paper-integration)
  covering happy path, malformed/missing input, boundary/stale/empty cases,
  idempotency (content-addressed ids; duplicate audit replays refused) and
  the P10 state-machine integration gate.
- Deterministic for deterministic inputs: no wall clock, no randomness;
  repeated runs produce byte-identical decisions/audit serializations.
