# Completion Report

Prompt ID: P11_Risk_Engine (P11-01 through P11-05, executed in required order)
Phase: P11 Risk Engine
Date/time UTC: 2026-09-11T18:30:00Z
Branch/commit: main / c001db9 + P10/P11 working tree (uncommitted)

## What changed

The P11 Risk Engine phase is complete: the independent risk service
boundary (P11-01), hard limits and deterministic sizing (P11-02), portfolio
heat and correlation controls (P11-03), risk states with the human kill
switch (P11-04), and risk observability/audit (P11-05). All risk logic
lives in `contracts/src/risk/` as pure, typed, zod-validated contracts plus
a deterministic evaluator (ADR-0022). The phase gate "Hard limits +
portfolio heat + risk states + kill switch" is satisfied.

### P11-01 — Independent risk service boundary
- `contracts/src/risk/contract.ts`: `RiskCheckRequest` (verbatim signal
  lineage + account snapshot + open-position snapshot + market freshness
  snapshot + latched risk state; strict zod validation with
  direction-consistency, market-instrument match, unique position ids) and
  `RiskDecision` (content-addressed `riskdec_` FNV-1a64 id, outcome, FINAL
  sized quantity, planned risk, utilization ratios, frozen machine-readable
  `RISK_REJECT_REASONS` 16-code vocabulary, request digest). Canonical
  serializations are pinned by tests. `assertRiskGateCleared` is the only
  fail-closed way for an order to leave the P10 `intent` state — no
  decision laundering (intent match, engine id, approval, entry-allowing
  state, positive size are all enforced).
- Integration (`risk-paper-integration.test.ts`): approved intents walk
  `intent -> risk_checked -> submitting`; rejected intents are forced into
  `intent -> rejected` (`risk_rejected`); cross-intent approvals cannot
  clear another order; KILL and provider outage block the gate.

### P11-02 — Hard limits and sizing
- `contracts/src/risk/limits.ts`: versioned `RiskLimitsConfig`
  (max risk/trade 0.50% blueprint placeholder, portfolio heat 3%, daily
  loss 2%, weekly drawdown 5%, max open positions, spread/slippage caps,
  data-age cap, redundancy caps, currency exposure caps, yellow factor)
  with `DEFAULT_RISK_LIMITS`; fail-closed `parseRiskLimitsConfig`.
  Deterministic sizing `sizePositionByRisk` (budget / (stop distance x
  quote->account rate), provenance-carrying conversion metadata, round6);
  `finalQuantityUnits` = min(requested, risk-sized) — proposals can only be
  reduced. Daily-loss/weekly-drawdown fractions; stale-data gate
  `staleDataReason` (freshness from the bar CLOSE; a "closed" bar closing
  in the future is a look-ahead shape and fails closed). Boundary
  conventions frozen and pinned: caps strict `>`, loss stops `>=`.
- `contracts/src/risk/engine.ts`: `evaluateRisk` — the ONE deterministic
  gate, frozen check order (control plane short-circuit -> account limits
  -> portfolio controls), `RiskEngineError` fail-closed on malformed
  input.

### P11-03 — Portfolio heat and correlation controls
- `contracts/src/risk/portfolio.ts`: portfolio heat = sum of planned stop
  risks attributed from each open position's OWN protective stop (no
  caller-supplied risk); projected heat layers the candidate risk.
  Documented correlation model `currency-leg-overlap-v1`: signed
  base/quote currency legs per FX position; NET per-currency exposure
  (directional concentration) and GROSS per-currency exposure
  (correlated-group stacking, e.g. USD across majors); metals contribute
  no legs in v1 (documented, conservative). Redundancy counts
  (instrument+direction; strategy+instrument+direction) with
  `redundancyDenial`.

### P11-04 — Risk states and kill switch
- `contracts/src/risk/states.ts`: GREEN/YELLOW/ORANGE/RED/KILL vocabulary
  (frozen); deterministic `deriveRiskState` from utilization ratios
  (thresholds <0.5/<0.75/<1/>=1; KILL never derived); YELLOW halves the
  per-trade budget, ORANGE/RED/KILL zero it; human-only overrides
  (`engage_kill` any-state latching, `release_kill` only from kill landing
  conservatively in RED — never auto-reset, `force_state` explicit) with
  content-addressed override ids and actor accountability; latched
  `RiskStateTracker` (KILL sticky until a human acts).

### P11-05 — Risk observability
- `contracts/src/risk/audit.ts`: append-only `RiskAuditEvent` union
  (`risk_check_recorded` with the FULL request snapshot + decision,
  `risk_state_changed` with cause/override provenance,
  `risk_override_recorded`, `risk_kill_engaged`/`risk_kill_released` with
  actor). Content-addressed event ids; duplicate replays FAIL CLOSED;
  chronological append enforcement; tamper-evident log digest;
  `recordRiskCheck` verifies the decision belongs to the exact request
  (digest match); per-intent end-to-end query helper. No secret-bearing
  payloads.

### Shared
- `contracts/src/risk/util.ts`: local FNV-1a64 hash + round6 (risk imports
  NO broker module, not even `paper/` — independence by construction).
- `contracts/src/index.ts`: barrel exports for all risk modules.
- `docs/adr/ADR-0022-independent-risk-engine.md` (new); ADR index +
  `tests/test_ci_contracts.py` ADR registry synced (required
  synchronization).

## Files changed

- `contracts/src/risk/util.ts`, `contract.ts`, `limits.ts`, `portfolio.ts`,
  `states.ts`, `engine.ts`, `audit.ts` (new)
- `contracts/src/__tests__/risk-fixture.ts` (new, shared fixtures)
- `contracts/src/__tests__/risk-contract.test.ts` (new, 16 tests)
- `contracts/src/__tests__/risk-limits-sizing.test.ts` (new, 21 tests)
- `contracts/src/__tests__/risk-portfolio-heat.test.ts` (new, 12 tests)
- `contracts/src/__tests__/risk-states-kill.test.ts` (new, 18 tests)
- `contracts/src/__tests__/risk-audit.test.ts` (new, 11 tests)
- `contracts/src/__tests__/risk-paper-integration.test.ts` (new, 6 tests)
- `contracts/src/index.ts` (barrel: +7 risk exports)
- `docs/adr/ADR-0022-independent-risk-engine.md` (new)
- `docs/adr/README.md` (index row)
- `tests/test_ci_contracts.py` (ADR registry entry 22)
- `02_REPORTS/P11_COMPLETION_REPORT.md` (this report)

## Tests executed

- `pnpm --filter @fdbtrade/contracts run typecheck` — 0 errors.
- `pnpm --filter @fdbtrade/contracts run lint` — clean (pre-existing benign
  warnings only).
- `pnpm --filter @fdbtrade/contracts run test` — 20 files / 250 tests green
  (162 pre-existing P02-P10 + 88 new P11; includes the P10 state-machine
  integration gate).
- `python3 -m unittest tests.test_ci_contracts` — 18/18 OK (ADR-0022
  registered).
- `make check` — lint + typecheck + workspace tests green; the Python
  stdlib suite ran 476 tests with 475 OK and 1 pre-existing failure
  (`test_make_start_serves_when_production_build_exists`: port 3000 held
  by an unrelated process, pid 104824 — the SAME blocker documented in the
  P10 report, unrelated to P11; `make` therefore did not reach `build`,
  which was run separately).
- `make build` — exit 0 (all packages).

Coverage highlights: happy-path approvals with pinned sizing math;
malformed/missing input fail-closed (missing fields, non-UTC timestamps,
direction-inconsistent levels, duplicate position ids, instrument mismatch,
out-of-range limits); boundary cases (spread exactly at cap allowed, daily
stop exactly at cap rejected, data age exactly at limit fresh vs 1ms past
stale, heat exactly at cap allowed); empty portfolio; idempotency
(content-addressed decision ids identical across replays; duplicate audit
replays refused; deterministic digests); integration regression coverage
for every boundary bypass attempt (cross-intent approval, foreign engine
id, forged state, rejected decision, KILL, provider outage).

## Acceptance criteria

- [x] P11-01: all paper/demo order intents pass through the risk service
      in integration tests (`risk-paper-integration.test.ts`; the only
      route out of `intent` is `assertRiskGateCleared`).
- [x] P11-02: impossible/over-limit orders are rejected with reason codes
      (16-code frozen vocabulary; every code is exercised by at least one
      test).
- [x] P11-03: new positions can be denied when portfolio
      heat/correlation caps are exceeded (heat, net-currency, gross
      correlated-group denials pinned).
- [x] P11-04: KILL blocks new orders; provider outage/stale data cannot
      create new live intents (fail-closed gates pinned; kill is
      manual-only, latched, never auto-reset).
- [x] P11-05: risk decisions are auditable end-to-end (full input
      snapshot + decision + reasons + override actor per event; digest
      verification; duplicate replay refusal).
- [x] Relevant tests pass from a clean environment or the blocker is
      documented (contracts 250/250 green; Python 475/476 with the
      pre-existing port-3000 blocker documented — NOT assumed passed).
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified without justification (ADR index + CI
      ADR registry are the required synchronization for ADR-0022).
- [x] Completion report written.
- [x] Trading safety: risk is independent of strategy/execution; no
      broker access anywhere in `contracts/src/risk/`; overrides change
      STATE only, never hard limits; live execution remains OFF.

## Known limitations / blockers

- Port 3000 is occupied by an unrelated process (pid 104824), so
  `make start`-based Python acceptance cannot run to green. Pre-existing
  blocker (already documented in the P10 report); to verify: stop that
  process and rerun `python3 -m unittest tests.test_skeleton_contracts`.
- The latched state tracker and the audit log are pure in-memory
  projections; persistence (DB tables, API wiring) is deferred to the
  backend/orchestration and P13 observability prompts per the phase plan.
- The risk evaluator lives in the contracts package (pure TS); no Python
  mirror was required by P11 scope (unlike data/research contracts).
- `currency-leg-overlap-v1` models only FX legs; metals contribute no legs
  (documented and conservative — metal exposure stays uncovered by the
  correlation cap until a v2 model with validation evidence).
- Equity marks, provider health, spread/slippage estimates and conversion
  rates are INPUTS with provenance; no providers are wired in this phase.

## Follow-up required before next prompt

- None for P11. Next prompt per RUN_ORDER: P12 (Analytics) — performance,
  calibration, MAE/MFE and attribution analytics over the frozen engine +
  paper + risk layers.

## Risk notes

- Trading safety: the hard boundary strategy -> signal -> risk -> execution
  is enforced in code (`assertRiskGateCleared` + the P10 frozen transition
  table); strategy/feature/UI/LLM code can only call `evaluateRisk` and can
  never bypass it; the risk engine never contacts a broker and live
  execution stays OFF (ADR-0005). Risk hard limits are authoritative and
  cannot be weakened by operator overrides or AI components.
- Quant integrity: planned risk is derived from each position's OWN stop
  (no caller-supplied risk); sizing is deterministic (budget / (stop
  distance x rate)); the 0.25-0.50% per-trade placeholder is configuration
  explicitly labeled as such, not a promise; the stale-data gate rejects
  future-closing bars (look-ahead shapes fail closed); the correlation
  model is versioned and documented (no hidden correlations); all
  conversions carry rate provenance.
- Security: no secrets, credentials, or provider endpoints in any risk
  schema, fixture, or log payload; provider identity is an id string only;
  conversion rates carry `rateSource` provenance instead of literals.
