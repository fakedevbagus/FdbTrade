# ADR-0021: Paper broker state machine, deterministic fill simulation, ledger and reconciliation

- Status: Accepted
- Date: 2026-09-11 (UTC)
- Deciders: FdbTrade owner (blueprint v2.0 frozen scope, phase P10)
- Supersedes: none
- Related: ADR-0003 (no live execution by default), ADR-0004 (UTC timestamps), ADR-0005 (no broker calls from strategy/LLM), ADR-0019 (event-driven backtest engine), P08 frozen cost semantics, P09 research lab gates

## Context

Phase P10 requires a realistic paper broker: an order state machine, a
deterministic fill simulator, a position ledger and a reconciliation loop.
Constraints: strategy -> signal -> risk -> execution remains a hard boundary
(AI/LLM never gets broker authority); live execution stays OFF by default;
determinism for deterministic inputs; closed-bar semantics only (no
look-ahead); adversarial costs (spread, slippage, commission) as frozen in
P08; all internal timestamps UTC; fail-closed on malformed input. The paper
broker must never contact an execution layer, and reconciliation must never
silently repair state.

## Decision

1. Order lifecycle is a frozen explicit state machine
   (`PAPER_ORDER_TRANSITIONS`): intent -> risk_checked -> submitting ->
   acknowledged -> (partially_filled <->) filled -> managed -> closed, with
   terminal rejected/expired/cancelled/error states. Illegal transitions are
   rejected fail-closed (`assertPaperOrderTransition`); terminal states are
   absorbing; every transition requires a UTC instant.
2. Paper orders (`PaperOrder`) are derived strictly from canonical
   `BacktestOrderIntent`s (full signal lineage: strategyId/version,
   configVersion, snapshotHash preserved); ids are deterministic
   (`pbord_<intentId>`, `pbfill_<fnv1a64(content)>`,
   `pbevt_<fnv1a64(content)>`).
3. Fills are simulated ONLY over CLOSED canonical candles. Market orders fill
   at the OPEN of the bar `latencyBars` after the submit bar (latency >= 1 —
   zero-latency fills are invalid). Limit/stop orders rest and fill at their
   resting level when touched by the correct side of the bar. The expiry bar
   must be inside the cascade for `expired_unfilled` to fire; otherwise the
   order deterministically stays live (no look-ahead).
4. Costs are adversarial and per-fill: half-spread + slippage embedded in the
   effective price (long entry buys at ask, long exit sells at bid; short
   mirrored), commission recorded per side and split across the round trip.
   Partial fills are capped per bar by `maxFillFraction` of the ORIGINAL
   request (never of the remainder).
5. Round trips apply the frozen conservative intra-bar rule: STOP-FIRST; an
   exit fill closes the full position; unrealized round trips end at the last
   cascade close (`end_of_simulation`).
6. The ledger (`PaperLedgerState`) tracks cash in the account currency,
   positions keyed by deterministic `pbpos_<orderId>`, VWAP average entry
   price, realized/unrealized PnL in QUOTE currency, fees in quote + account
   currency, exposure and quote->account conversion metadata (`conversionRate`,
   `rateAtUtc`, `rateSource` — data, never literals). Closing more than is
   open, negative quantities and non-finite money fail closed.
7. The broker event log is append-only with content-addressed deterministic
   event ids; `paperEventLogDigest` pins the whole log for replay.
8. Reconciliation replays the event log through the frozen state machine,
   re-applies fills into a scratch ledger, and emits ACTIONABLE discrepancy
   codes only (duplicate_event, unknown_order, unknown_position,
   out_of_order_events, illegal_transition, missing_fill, phantom_fill,
   state_mismatch, impossible_balance, drift). It performs NO destructive
   repair.
9. No randomness, no wall clock, no broker access anywhere in
   `contracts/src/paper/**`.

## Consequences

- The paper broker is directly reusable by later execution phases and by the
  Python mirror (fill math mirrors P08 semantics; hashing matches the
  established FNV-1a64 canonical convention).
- Reconciliation depends on the ledger applying fills in log order; future
  out-of-order fill handling must normalize the log first.
- Exposure/account-currency conversion currently relies on the caller
  supplying conversion metadata per fill; a conversion-rate source is later
  phase work, not part of P10.

## Verification

- `cd contracts && pnpm run typecheck && pnpm run lint && pnpm vitest run`
  (162 tests, including `paper-state-machine.test.ts`,
  `paper-fill-simulator.test.ts`, `paper-ledger-reconciliation.test.ts`).
- Golden determinism: same fixtures -> same fill ids, event ids and digests
  (asserted in the tests).
