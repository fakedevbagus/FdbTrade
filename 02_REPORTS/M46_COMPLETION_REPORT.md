# M46 Completion Report — User-facing historical research workflow

## Scope

Implemented only M46. Local operator can preview and approve an owned historical CSV, inspect quality/provenance, select it for replay/backtest, export backtest report, and reopen same local registry after restart.

## Behavior

- Strict `timestamp,open,high,low,close,volume` UTC CSV parsing.
- SHA-256 immutable content checksum and canonical candles persisted atomically.
- Duplicate/invalid rows quarantined; gaps reported; zero-valid and oversized input rejected.
- Reuse matching dataset content idempotently; divergent reuse fails closed.
- API/UI distinguish historical mode from fixture mode. Historical `datasetId` never falls back to fixture data.
- Backtest manifest/run ID bind historical checksum, strategy version and deterministic seed/config existing contract.

## Focused evidence

- `make historical-research-check`: PASS — 10 Vitest tests, 5 Python M46 contract tests.
- `make runtime-check`: PASS — 56 runtime tests.
- `make integration-replay-check`: PASS — 64 replay/backtest tests.

## Safety

Live execution remains false. Provider order transport remains false. No provider network path, broker order route, credential, public ingress, or automatic paper action was introduced.

## Known limitations

- Input transport is bounded JSON CSV text, not multipart upload.
- Historical artifacts are local filesystem durable state, not PostgreSQL; backup is operator responsibility.
- Dataset schema supports canonical OHLCV only; vendor-specific mappings are intentionally rejected.
- Browser end-to-end authenticated flow is not claimed by focused checks.

## Next

M47 — Seven-major runtime coverage. Not started.
