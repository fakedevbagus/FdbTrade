# @fdbtrade/contracts — Shared typed contracts

Canonical market-data model shared by backend, research (Python mirror in
`quant/datacore`) and tests (ADR-0009, P02-01).

## Layout

- `src/marketdata/time.ts` — canonical UTC instant (ms precision, Z only),
  frozen timeframe set (5m/15m/1h/4h/1d), durations, open-time alignment.
- `src/marketdata/instrument.ts` — instrument, precision (digits/pip/point),
  contract spec, versioned symbol mapping schemas.
- `src/marketdata/session.ts` — UTC weekday session windows, breaks,
  schedules; membership helpers.
- `src/marketdata/quote.ts` — quote and derived spread (pip size from
  instrument metadata — never literals).
- `src/marketdata/candle.ts` — OHLCV candle with schema-level OHLC sanity.
- `src/marketdata/registry.ts` — validated frozen lookups over the shared
  data files.
- `src/marketdata/provider.ts` — `MarketDataProvider` interface, request/
  capability/health schemas, structured `ProviderError` codes (P02-02).
- `src/marketdata/dataset.ts` — historical dataset manifest schemas,
  canonical candle serialization + deterministic dataset ids (P02-05).
- `src/feature/definition.ts` — versioned feature definitions (version,
  inputs, lookback warmup table, output type, null policy), feature groups,
  lineage metadata, typed input windows (P03-01, ADR-0014).
- `src/feature/snapshot.ts` — immutable feature-snapshot schemas, canonical
  serialization + snapshot hash + deterministic store keys (P03-04).
- `src/data/*.json` — the SINGLE source of truth for instrument, session and
  mapping values; consumed by both this package and `quant/datacore`.
  `fixtureProvider.json` holds the deterministic fixture anchors (P02-02).

Python mirrors: `quant/datacore` (market data) and `quant/featurecore`
(feature definitions + snapshots) — same model, stdlib only.

## Conventions

- All internal timestamps are UTC, millisecond precision, `...Z` (ADR-0004).
- Candle timestamps are bar OPEN times.
- Schemas are `strict()` — unknown keys reject.
- Pip/precision/contract-size values live in `src/data/*.json`, never in code.

## Scripts

`lint` (eslint), `typecheck` (tsc --noEmit), `test` (vitest), `build`
(tsc --noEmit — the package ships TS source; see ADR-0009).
