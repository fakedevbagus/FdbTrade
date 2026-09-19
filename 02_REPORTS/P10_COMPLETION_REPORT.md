# Completion Report

Prompt ID: P10_Paper_Broker (P10-01 through P10-04, executed in required order)
Phase: P10 Paper Broker
Date/time UTC: 2026-09-11T00:00Z
Branch/commit: main / c001db9ccff04c5630dbf6eca82eebfef3a5470b + P10 working tree (uncommitted)

## What changed

The P10 Paper Broker phase is complete: the frozen paper order state machine
(P10-01), the deterministic paper fill simulator (P10-02), the paper position
ledger (P10-03) and the reconciliation loop (P10-04). All paper-broker logic
lives in `contracts/src/paper/` as typed, zod-validated, shared contracts
(ADR-0021). The phase gate "Paper broker + ledger + reconciliation" is
satisfied: contracts typecheck (0 errors), contracts lint clean, contracts
test suite 14 files / 162 tests green.

### P10-01 — Paper order state machine
- `contracts/src/paper/stateMachine.ts`: frozen state vocabulary
  `intent, risk_checked, submitting, acknowledged, partially_filled, filled,
  managed, closed` plus terminal `rejected, expired, cancelled, error`
  (exported via `PAPER_ORDER_STATES`, `PAPER_TERMINAL_STATES`, zod
  `paperOrderStateSchema`); frozen transition table `PAPER_ORDER_TRANSITIONS`
  (working-order terminal exits; `closed` absorbing); `canTransitionPaperOrder`
  (boolean check), `assertPaperOrderTransition` (fail-closed
  `PaperOrderStateError`), `applyPaperOrderTransition` (returns a new minimal
  `PaperOrderStateful`, validates UTC timestamps, non-empty reasons; terminal
  states are absorbing). Illegal transitions are rejected explicitly.
- `contracts/src/paper/order.ts`: `PaperOrder` derived from a canonical
  `BacktestOrderIntent` (full signal lineage, grid-aligned expiry, direction-
  consistent levels), `PaperFill`, `PaperFillPolicy` (latency >= 1, costs >= 0,
  `maxFillFraction` in (0,1]), machine-readable `PAPER_REJECT_REASONS`,
  `PAPER_EXIT_REASONS`, `PAPER_FILL_SIDES`, the append-only
  `PaperBrokerEvent` discriminated union, content-addressed deterministic ids
  (`paperHash16` FNV-1a 64, `paperOrderIdFor`, `paperFillIdFor`,
  `paperEventIdFor`, `paperEventLogDigest`) and canonical serializations
  ready for the Python mirror.

### P10-02 — Paper fill simulator
- `contracts/src/paper/fillSimulator.ts`: `simulateOrderEntryFills` and
  `simulatePaperRoundTrip` over CLOSED bars only (no look-ahead):
  MARKET fills at the OPEN of the bar `latencyBars` bars after the submit bar;
  LIMIT/STOP rest and fill on touch at the resting level (`low <= entry` /
  `high >= entry` and mirror); costs adversarial per P08 parity math
  (half-spread + slippage on every fill, commission split per side); per-bar
  partial-fill cap measured against the ORIGINAL request (a remainder-geometric
  cap would under-fill forever); frozen conservative STOP-FIRST intra-bar
  exit rule; explicit rejection conditions (`expired_before_submit` boundary
  at/after expiry, `no_latency_bars`, `expired_unfilled`,
  `end_of_simulation` fallback exit); fail-closed input guards
  (`PaperFillSimulatorError`, `round6` storage convention). Zero randomness,
  zero wall clock, zero broker access.

### P10-03 — Paper position ledger
- `contracts/src/paper/ledger.ts`: `createPaperLedger` (account ccy +
  initial cash), `applyPaperFill` (VWAP average entry, per-side fee split,
  exposure `avgPrice * qty * conversionRate`, long entry debits / long exit
  credits cash, realized PnL in QUOTE ccy net of round-trip commission,
  `PaperConversionMetadata` quote->account with `rateAtUtc`/`rateSource`
  provenance recorded per fill), `markPaperPositions` (unrealized PnL mark,
  equity = cash + open unrealized, cash never moves), `paperEquity`,
  `verifyPaperLedger` (structural sanity feeding P10-04
  `impossible_balance`). Impossible balances fail closed: closing more than
  open, exit without an open position, currency mismatch, non-positive
  notional/money, malformed pip size.

### P10-04 — Reconciliation loop
- `contracts/src/paper/reconciliation.ts`: `reconcilePaperBroker` replays the
  event log through the frozen state machine (P10-01), matches
  `fill_executed` events against the derived fill records, replays the fills
  through a scratch ledger and compares to the derived ledger. Emits the ten
  actionable reason codes `duplicate_event, unknown_order, unknown_position,
  out_of_order_events, illegal_transition, missing_fill, phantom_fill,
  state_mismatch, impossible_balance, drift` (`PAPER_DISCREPANCY_CODES`) with
  event/order/position/fill correlation and a deterministic
  `pbrec_` + 16-hex id derived from atUtc + log digest + cash/equity. NO
  destructive repair — the loop only reports (non-goal honored).

## Files changed

- `contracts/src/paper/stateMachine.ts` (new, P10-01)
- `contracts/src/paper/order.ts` (new, P10-01)
- `contracts/src/paper/fillSimulator.ts` (new, P10-02)
- `contracts/src/paper/ledger.ts` (new, P10-03)
- `contracts/src/paper/reconciliation.ts` (new, P10-04)
- `contracts/src/index.ts` (paper exports via the package index)
- `contracts/src/__tests__/paper-state-machine.test.ts` (new, 7 tests)
- `contracts/src/__tests__/paper-fill-simulator.test.ts` (new, 16 tests)
- `contracts/src/__tests__/paper-ledger-reconciliation.test.ts` (new, 17 tests)
- `docs/adr/ADR-0021-paper-broker-and-reconciliation.md` (new, Accepted)
- `docs/adr/README.md` (ADR index row)
- `tests/test_ci_contracts.py` (ADR-21 registered in `KNOWN_ADRS`)

## Tests executed

- `contracts`: `pnpm vitest run` — 14 files, 162 tests, all passing.
  Paper-specific: `paper-state-machine.test.ts` (7), `paper-fill-simulator.test.ts`
  (16), `paper-ledger-reconciliation.test.ts` (17).
- `contracts`: `pnpm run typecheck` — exit 0, 0 errors.
- `contracts`: `pnpm run lint` — exit 0 (pre-existing eslint warnings only).
- Python `tests/test_ci_contracts.py` — 18/18 OK (ADR-0021 recognized).
- Python full suite `unittest discover -s tests` — 476 tests, 1 failure:
  `test_make_start_serves_when_production_build_exists` fails with
  `EADDRINUSE :::3000` because an UNRELATED process (pid 104824,
  MainThread) already listens on port 3000 on this host; `make start`
  cannot bind. Environmental, pre-existing, NOT caused by P10 (the paper
  broker is a library package with no runtime server). All other 475 Python
  tests pass.
- Coverage highlights (per prompt test-case requirements):
  - P10-01: happy path intent->closed, terminal absorbing, explicit illegal
    transition rejection, malformed input (bad UTC, empty reason, unknown
    state), determinism/idempotency of repeated transitions.
  - P10-02: market/limit/stop entries and exits, adverse long/short cost math,
    partial-fill cap, latency boundary (never on submit bar),
    `expired_before_submit` exact boundary, `no_latency_bars`,
    `expired_unfilled`, stop-first dual-level bar, `end_of_simulation`,
    malformed policy/bars/pipSize, byte-identical determinism/idempotency,
    expected fill pair + fees + PnL for the target-exit fixture.
  - P10-03: ledger reconciles to order/fill fixtures (open->mark->close),
    VWAP/fees/exposure/conversion metadata (unit and non-unit rate),
    impossible-balance fail-closed matrix, `verifyPaperLedger` problems,
    state machine + ledger deterministic bridge.
  - P10-04: clean report + empty boundary case, all ten reason codes
    individually exercised (duplicate ids, unknown order/position,
    out-of-order, illegal transition, missing/phantom fill, state mismatch,
    impossible balance, cash drift), malformed reconciliation input,
    deterministic report id.

- `02_REPORTS/P10_COMPLETION_REPORT.md` (this report)



## Acceptance criteria

- [x] P10-01: state transitions are explicit; illegal transitions rejected.
- [x] P10-02: known fixtures produce expected fills and PnL.
- [x] P10-03: ledger reconciles to order/fill fixtures.
- [x] P10-04: reconciliation produces actionable discrepancy reason codes.
- [x] Relevant tests pass (contracts suite 162/162 green).
- [x] Lint/typecheck clean for affected packages.
- [x] No unrelated files modified without justification (ADR index + CI
      ADR registry are the required synchronization for ADR-0021).
- [x] Completion report written.
- [x] No broker calls; no live execution; strategy -> signal -> risk ->
      execution boundary untouched (paper subsystem derives from
      `BacktestOrderIntent` and never touches an execution adapter).
- [x] Deterministic: FNV-1a content-addressed ids, no randomness, no wall
      clock; repeated runs produce byte-identical fills/reports.

## Known limitations / blockers

- The Python acceptance gate `make start` (skeleton contract test) could not
  be verified on this host: port 3000 is occupied by an unrelated process.
  Blocker documented, not assumed passed. To verify: stop the process
  listening on 127.0.0.1:3000 (pid 104824 at report time) and rerun
  `python3 -m unittest tests.test_skeleton_contracts`.
- MT5 terminal is absent on this host; the paper broker intentionally has no
  external adapter — fills are simulated (per prompt; no blocker).
- Currency conversion rates are input metadata (`conversionRate` +
  `rateSource` provenance); no rate provider is implemented in this phase.
- Event-log replay checks per-order state at event time against the frozen
  table; full per-order state-history snapshots are deferred to the broker
  orchestration layer (P11) which stamps the events.

## Follow-up required before next prompt

- None for P10. Next prompt per RUN_ORDER: P11 (Risk & Sizing) — the paper
  broker consumes already risk-checked intents and NEVER sizes positions.

## Risk notes

- Trading safety: paper broker only; live execution remains OFF by default;
  no strategy/feature/UI/LLM code gained broker access. Risk hard limits are
  upstream (intents already carry `risk_checked` state) and are never bypassed
  here.
- Quant integrity: CLOSED-bar semantics are explicit (fills use bar OPEN/HIGH/
  LOW with latency >= 1; exits stop-first); no look-ahead by construction;
  costs (spread/slippage/commission) are mandatory inputs (`PaperFillPolicy`)
  and recorded per fill; fixtures pin PnL so cost-math regressions fail CI.
- Security: no secrets, no network, no provider access; conversion-rate data
  carries provenance instead of literals.
