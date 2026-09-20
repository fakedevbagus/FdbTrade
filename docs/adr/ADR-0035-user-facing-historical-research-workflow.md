# ADR-0035: User-facing historical research workflow

- Status: Accepted
- Date: 2026-09-20
- Deciders: FdbTrade private-beta owner
- Supersedes: None
- Related: ADR-0007, ADR-0012, ADR-0034
- Milestone: M46

## Context

Operator-owned historical CSV must be distinguishable from fixture and shadow data. Import must preserve source checksum and quality evidence, reject malformed or oversized input, and never silently replace requested historical input with fixture candles.

## Decision

`backend/src/data/historical/` is the sole historical dataset authority. It parses exact UTC OHLCV CSV headers, rejects inputs over `MAX_CSV_ROWS`, quarantines invalid/duplicate records, records gap evidence, and persists immutable manifest plus canonical candles under `FDB_HISTORICAL_DATASET_DIR` (default `artifacts/historical-datasets`, gitignored).

Authenticated API routes expose list, preview/approval, and replay. `POST /api/backtest/runs` accepts optional `datasetId`; it loads only that registered historical dataset and binds its checksum to the backtest manifest and run identity. Omitted `datasetId` remains explicitly fixture mode. `GET /api/backtest/runs/{runId}` exports stored immutable report JSON.

## Consequences

- Historical, fixture, and future shadow provenance remain visible and non-substitutable.
- Reusing identical content is idempotent. Divergent content for same logical dataset identity fails.
- User data is local, unlicensed by repository, and excluded from git.
- CSV text API input is bounded by normal API request-size policy; file-upload transport is not added.
- No provider network access, order authority, live execution, or automatic paper operation is added.

## Verification

`make historical-research-check` passes six backend behavior tests and five Python contract tests. Full M46 gates are recorded in `02_REPORTS/M46_COMPLETION_REPORT.md`.
