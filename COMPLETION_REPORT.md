# Completion Report

Prompt ID: M46 — User-facing historical research workflow
Phase: Phase 2 — Operational Private Beta 2.1
Date/time UTC: 2026-09-20T00:00:00Z
Branch/commit: main (`7877e53` implementation; authority pin pending commit)
Baseline commit: b97c5b7 (M45 implementation commit)

## M46 summary

M46 adds authenticated operator workflow for user-owned historical CSV data.
`/research/datasets` displays historical data distinctly from fixture and shadow
modes. Authenticated API routes provide preview, explicit confirmation, list,
and replay. CSV input is parsed fail-closed for headers, UTC timestamps, OHLC,
precision, duplicates, gaps, quarantined rows, and row limits. Oversized input
is rejected, never truncated.

Confirmed datasets use immutable content checksums and a durable local registry.
Divergent reuse fails. Historical replay loads only registered historical
content; it never substitutes fixture candles. Backtests record historical
checksum provenance and domain-separate run IDs by dataset digest. Existing
backtest artifact retrieval remains exportable reproducibility evidence.

Safety unchanged: `LIVE_EXECUTION_ENABLED=false`,
`PROVIDER_ORDER_TRANSPORT_ENABLED=false`, loopback-only, paper-only, no live
route, no provider-order path, no network fallback.

## Evidence

- `make historical-research-check` — 10 Vitest and 5 Python M46 tests pass.
- `make runtime-check`, `make operational-persistence-check`, and
  `make integration-replay-check` pass.
- `make operational-packaging-check`, `make private-beta-check`,
  `make security-check`, `make dashboard-check`, `make phase2-check`,
  `make handoff-check`, `make lint`, `make typecheck`, and `make format-check` pass.
- `make test` required before final commit.

## Records

- ADR: `docs/adr/ADR-0035-user-facing-historical-research-workflow.md`
- Checkpoint: `docs/checkpoints/46_historical_research.md`
- Detailed report: `02_REPORTS/M46_COMPLETION_REPORT.md`
- Next authorized milestone: M47 — Seven-major runtime coverage. Not started.

## Prior milestone archive

M45 scheduler/runtime evidence remains immutable in
`02_REPORTS/M45_COMPLETION_REPORT.md` and
`docs/checkpoints/45_continuous_scheduler.md`.
