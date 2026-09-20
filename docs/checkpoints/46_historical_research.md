# M46 Checkpoint — User-facing historical research workflow

Status: complete; implementation commit `7877e53`; authority pin pending commit

## Delivered

- Local immutable user-owned CSV registry, SHA-256 source provenance, canonical candles, quality summary, quarantine and gap reporting.
- Exact UTC OHLCV header validation; malformed, ambiguous, duplicate, and oversized input fail closed.
- Authenticated dataset list, preview/approval, and replay API. Research dashboard lists provenance and quality state.
- Historical backtest selection binds dataset ID/checksum into manifest/run identity. No requested historical dataset can fall back to fixtures.
- Backtest report export remains authenticated `GET /api/backtest/runs/{runId}`.

## Authority and safety

Authoritative durable historical state: `FDB_HISTORICAL_DATASET_DIR` (default `artifacts/historical-datasets/`), intentionally gitignored. Existing PostgreSQL remains runtime authority; historical artifact registry is local immutable research input storage.

`LIVE_EXECUTION_ENABLED=false`; `PROVIDER_ORDER_TRANSPORT_ENABLED=false`; fixture remains default; no network provider, broker credential, trade route, or paper auto-confirmation exists.

## Recovery

Keep `artifacts/historical-datasets/` with private backup. On corruption, restore exact directory backup; do not reconstruct manifests or edit canonical candle files. Re-import original CSV only when no backup exists; checksum/version will establish a new verified artifact.

## Evidence

Focused: `make historical-research-check`, `make runtime-check`, and `make integration-replay-check` pass. See `02_REPORTS/M46_COMPLETION_REPORT.md` for final gate record.

Next authorized milestone: M47 — Seven-major runtime coverage. Do not begin in same agent run.
