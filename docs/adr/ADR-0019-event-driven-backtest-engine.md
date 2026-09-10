# ADR-0019: Event-driven backtest engine and run-result contract

- Status: Accepted
- Date: 2026-09-10 (UTC)
- Deciders: FdbTrade owner (blueprint v2 approval), Cline agent
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC policy), ADR-0005 (live trading OFF), ADR-0009 (canonical market data), ADR-0013 (dataset manifests), ADR-0017 (strategy/signal contract), ADR-0018 (ensemble decisions)

## Context

Phase P8 needs a research harness that replays historical data deterministically
with realistic costs before any promotion/optimization happens (blueprint:
"no optimization before the backtest harness and validation gates are stable").
Prior layers froze canonical candles (ADR-0009), dataset manifests (ADR-0013)
and the signal contract (ADR-0017) — the backtest must consume exactly these,
with zero look-ahead, and produce a run result that is fully attributable and
replayable. The engine is a simulation only: it never contacts an execution
layer (ADR-0003/0005).

## Decision

1. The backtest contract lives in `contracts/src/backtest/contract.ts`
   (Python mirror `quant/backtestcore/contract.py`): strict schemas for order
   intents (derived from canonical signals, full lineage, direction-consistent
   levels, grid-aligned event/expiry times), fills (explicit per-fill cost
   breakdown), positions (entry/exit, MFE/MAE in pips, realized PnL), run
   config (period, warmup, fill policy, subject lineage, seed), events
   (append-only replay log) and the full run result (`runId`, dataset ref,
   equity curve, final state).
2. Deterministic identity: `runId = btrun_ + first 16 hex of sha256(canonical
   config serialization)`. Same config -> same id; any cost, version, period or
   seed change yields a different id. Intent id `btord_{signalId}`, position id
   `btpos_{intentId}` — one intent per signal, one position per intent
   (idempotent replay).
3. Engine semantics (frozen event order per bar): intent expiry -> entry
   fills -> position exits -> MFE/MAE update -> equity mark -> subject
   evaluation. Any change to this order is a breaking change for golden
   fixtures (P08-04).
4. No look-ahead by construction: the subject is evaluated with candles
   [0..i] only (defensive slice per bar); market intents fill at the open of
   the bar `latencyBars` >= 1 bars later; intra-bar exit ambiguity resolves
   CONSERVATIVELY (stop-first when one bar touches both stop and target).
5. Fill policy is explicit config, never implicit: P08-01 ships the labeled
   `next-bar-open` zero-cost placeholder; P08-02 adds the `realistic` policy
   (spread/slippage/commission/latency/partial fills). Zero-cost runs are
   clearly identifiable via the policy id in run metadata.
6. Admission: one open position and one pending intent per instrument;
   excess intents are event-logged rejections (`position_open`,
   `intent_pending`), never silent drops. Open positions at the last bar are
   force-closed (`end_of_run`) so final equity is fully realized.
7. Session gaps are absent bars (ADR-0010): the engine invents no data.
8. The engine never calls a broker, reads no wall clock, uses no randomness
   (the seed is recorded provenance, not consumed by the deterministic core).

## Consequences

- P08-02 cost policy, P08-03 metrics and P08-04 golden fixtures consume only
  the frozen `BacktestResult`; later phases (P9 promotion registry) can pin
  runs by `runId` + dataset digest + config digest.
- The single-position-per-instrument admission rule mirrors a simple paper
  account; the P11 risk engine may tighten (never loosen) it.
- MFE/MAE are per-position aggregates over closed bars (intra-bar excursion
  is not modeled — documented limitation, conservative for research).

## Verification

- `contracts` vitest: 6 contract cases (schemas, ids, serializations,
  fail-closed refinements).
- `backend` vitest: 16 engine cases (fills, exits, expiry, admission, warmup,
  no-look-ahead, determinism, run-id sensitivity, failure paths) + the parity
  fixture writer.
- Python stdlib: 13 mirror cases including the cross-layer parity fixture
  `tests/fixtures/backtest_parity.json` (runId, dataset digest, equity curve,
  trades must match byte-for-byte).
- `make check` green.
