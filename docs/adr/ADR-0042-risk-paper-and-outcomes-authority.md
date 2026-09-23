# ADR-0042: Risk, paper broker and outcomes authority

- Status: Accepted
- Date: 2026-09-23
- Deciders: FdbTrade private-beta owner
- Supersedes: Process-local authority assumptions in ADR-0021, ADR-0022 and ADR-0023
- Related: ADR-0003, ADR-0005, ADR-0021, ADR-0022, ADR-0023, ADR-0037, ADR-0039, ADR-0040, ADR-0041
- Work unit: R0.9

## Context

The preserved risk engine, paper fill simulator, ledger, reconciliation and
analytics contracts were deterministic in isolation but owned no application
state. Risk state could disappear on restart, a caller could use paper
simulation without a durable risk verdict, and fills, positions and outcomes
had no transactional lineage back to an authoritative signal candidate. R0.9
must establish this authority without creating a live or provider-order path
and without treating R0.8 historical results as confidence or promotion
evidence.

## Decision

1. Migration `0008_risk_paper_outcomes_authority` makes SQLite authoritative
   for the versioned risk/paper configuration, append-only risk-state events,
   risk-paper run lifecycle, immutable risk decisions, paper orders, order
   events, fills, position events, reconciliation reports, operational paper
   outcomes and attribution reports.
2. Every paper order has exactly one persisted risk decision for the same R0.7
   candidate and run. Database triggers prevent submission, acknowledgement,
   fill and position events unless that decision is `approved`. Rejections are
   durable orders with `order_created`, `order_risk_checked` and
   `order_rejected` only.
3. Risk evaluation reopens the candidate's verified R0.6 dataset, re-hashes
   its artifact through `MarketDataAuthority`, requires an active unexpired
   candidate and derives the account/open-position snapshot from the complete
   SQLite paper ledger. A separate verified R0.6 dataset supplies only the
   closed-bar paper cascade and must match the candidate instrument/timeframe.
4. The initial baseline uses the frozen deterministic risk limits and realistic
   paper fill policy. It is a local simulation with explicit spread, slippage,
   commission, latency and quote-to-account conversion provenance. It performs
   no network request, broker call or provider-order submission.
5. Risk state is an append-only chronological event stream. `kill` is latched;
   only an explicit recorded human `release_kill` moves it to conservative
   `red`, and a second explicit `force_state` is required to reopen entries.
   Risk decisions pin the exact state event they evaluated.
6. Orders, lifecycle events, fills and opened/closed position snapshots are
   append-only. Every terminal run replays the entire ledger and event stream
   through the deterministic reconciliation contract. Any discrepancy fails
   closed before terminal publication.
7. A closed paper position creates one immutable outcome linking candidate,
   risk decision, order and position. Attribution is recomputed over durable
   paper outcomes. Outcome evidence explicitly records paper-only operation,
   null uncalibrated signal confidence, no model-promotion eligibility and no
   use of backtest evidence as confidence.
8. Run identity is one-to-one with the source candidate. Recovery resets
   interrupted `running` work to `pending`, re-evaluates persisted risk inputs,
   verifies content digests and reconciles the durable ledger. A lost response
   after commit returns the existing terminal result and cannot duplicate a
   decision, order, fill, position or outcome.
9. R0.9 adds no route or UI, backup/restore behavior, credentialed provider,
   M48 wiring, live execution, provider-order transport or model-promotion
   authority. The approved universe remains the seven FX majors at 15m/1h/4h.

## Consequences

- A restart retains the exact mandatory risk verdict and every paper ledger
  fact required to reconstruct and reconcile operational paper outcomes.
- The initial authority is intentionally single-user and serial: another
  candidate cannot start while an interrupted run requires recovery.
- Paper outcomes are useful observed simulation evidence, not a promise of
  live execution quality and not a calibrated probability of signal success.
- UI/operational hardening, backup/restore and all provider work remain later
  separately authorized units.

## Verification

- Vitest covers approved round trips, rejection under a durable kill latch,
  explicit release, append-only rows, reconciliation, outcome attribution,
  SQLite reopen, crash recovery and post-commit idempotency.
- Python contracts pin migration ownership, mandatory pre-paper risk,
  fail-closed recovery markers, confidence separation and the absence of live,
  provider, UI, backup and M48 authority.
- Migration lifecycle verification covers eight ordered migrations and
  rollback/reapply of `0008_risk_paper_outcomes_authority`.
- `make toolchain-gate` is the final bounded acceptance authority.
