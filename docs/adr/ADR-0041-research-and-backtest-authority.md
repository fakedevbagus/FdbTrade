# ADR-0041: Research and backtest authority

- Status: Accepted
- Date: 2026-09-23
- Deciders: FdbTrade private-beta owner
- Supersedes: File-only backtest run authority assumptions in ADR-0019 and isolated research-runner assumptions in ADR-0020
- Related: ADR-0017, ADR-0019, ADR-0020, ADR-0037, ADR-0039, ADR-0040
- Work unit: R0.8

## Context

The preserved event-driven backtest engine and research helpers were
deterministic in isolation, but their run store was a caller-selected directory
of mutable JSON files. There was no application authority for a registered
research configuration, queued or interrupted work, the exact R0.6 dataset and
R0.7 rule lineage used by a run, or recovery after artifact publication. The
legacy served endpoint also accepted only a `noop` subject and therefore did not
prove historical evaluation of the authoritative signal rule.

R0.8 must make one deterministic baseline research path durable without
turning historical performance into signal confidence, model promotion,
operational outcomes, risk approval or order authority.

## Decision

1. Migration `0007_research_backtest_authority` makes SQLite authoritative for
   immutable research configurations, run lifecycle, content-addressed result
   artifacts and result summaries. Terminal runs, configurations, artifacts
   and results cannot be updated or deleted.
2. The registered `baseline-historical-evaluation` configuration version
   `1.0.0` is tied by foreign key and digest to the R0.7
   `authoritative-momentum-baseline` rule at logic/config version `1.0.0`.
   Current signal evaluation and historical replay call the same pure rule
   evaluator; replay does not persist historical candidates into the live
   signal-candidate authority.
3. Every run opens its dataset through the R0.6 market-data authority, which
   re-hashes and parses the immutable candle artifact. Only accepted datasets
   with zero quarantined, gap or duplicate observations are executed. Rejected
   quality produces a durable `blocked` result with no fabricated metrics.
   Historical datasets need not be currently fresh; their exact bounded period
   and content digest are the research input.
4. The initial research configuration records initial equity, quantity,
   warmup, seed and a realistic deterministic fill policy with one-bar latency,
   explicit spread/slippage/commission assumptions, full fills and conservative
   stop-first ambiguity handling. The backtest engine remains pure and performs
   no provider or execution call.
5. Successful and blocked evidence is serialized deterministically and stored
   under `<data-root>/artifacts/research-backtests/sha256/<prefix>/<digest>.json`.
   Artifact bytes are fsynced and renamed before SQLite metadata commits. The
   SQLite result pins artifact bytes, dataset provenance, engine manifest,
   config digest and summary digest.
6. Run identity is deterministic over dataset id and registered research
   configuration. Runs progress `pending -> running -> succeeded|blocked|
   failed`; identical requests replay the terminal result. Recovery returns
   interrupted `running` work to `pending`, verifies registered artifacts and
   source datasets, and reports unreferenced result blobs without adopting or
   deleting them.
7. Result evidence explicitly records `historicalOnly=true`, null uncalibrated
   signal confidence, `modelPromotionEligible=false` and
   `operationalOutcomeAuthority=false`. Backtest metrics never rewrite R0.7
   confidence or create promotion, risk, paper position, broker outcome or
   order intent authority.
8. Walk-forward optimization, out-of-sample/stress orchestration and controlled
   promotion remain non-authoritative. The legacy backtest API/run directory is
   not promoted or rewired, and no UI surface is added in R0.8.

## Consequences

- A local restart preserves exactly which verified dataset, signal-rule version
  and explicit simulation assumptions produced a historical result.
- Crash replay cannot duplicate a logical run, while a response lost after the
  terminal commit reopens the original immutable evidence.
- SQLite remains the sole durable metadata authority; large result bytes remain
  inspectable content-addressed files below the configured data root.
- Empirical metrics are useful research evidence but are not a probability of
  signal correctness, operational trading outcome, champion label or approval
  to execute.
- Risk, paper broker/outcomes, UI, backup/restore, credentialed providers and
  all live/provider-order transport remain separate future work units.

## Verification

- Vitest covers real baseline-rule replay, realistic cost assumptions,
  persistence across reopen, quality blocking, immutable rows, content
  corruption, pre-commit recovery, orphan reporting and post-commit replay.
- Existing R0.7 behavior tests prove the shared rule extraction does not change
  current signal evaluation behavior.
- Python contracts pin migration ownership, content addressing, recovery,
  confidence/promotion separation and safety exclusions.
- `make toolchain-gate` is the final bounded acceptance authority.
