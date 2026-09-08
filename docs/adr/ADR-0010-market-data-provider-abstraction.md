# ADR-0010: Market-data provider abstraction and deterministic fixtures

- Status: Accepted (P02-02)
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0009 (canonical
  market-data model), `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`, Prompt Pack P02-02

## Context

The blueprint locks "provider-agnostic market-data layer" and
"MT5/broker adapter pattern" with a free-first posture: P2 must work with
fixtures, no external credentials, no live provider. The first implementation
must therefore define the provider interface AND a fully deterministic
fixture provider so later phases (features, regime, backtests) can build on
reproducible datasets. TradingView is explicitly NOT the non-display core
data source (blueprint locked decision).

## Decision

1. **`MarketDataProvider` lives in `@fdbtrade/contracts`** (TS interface +
   zod request/capability/health schemas): `getHistoricalCandles`,
   `getQuotes`, `capabilities`, `health`. All providers implement this ONE
   interface; MT5/other adapters later plug in behind it.
2. **Capabilities are explicit.** Providers declare instruments, timeframes,
   quote support and synthetic-ness; unsupported requests fail with
   structured `ProviderError` codes (`UNSUPPORTED_INSTRUMENT`,
   `UNSUPPORTED_TIMEFRAME`, `INVALID_REQUEST`, `PROVIDER_FAILURE`) — never
   silent guessing or empty fallbacks.
3. **The fixture provider is deterministic by construction**: a splitmix64
   integer hash seeded by (instrument, bar index) synthesizes every value —
   no `Math.random`, no `Date.now`, no network. Same request => byte-identical
   data across processes and restarts (quant reproducibility).
4. **Fixture anchors are data** (`contracts/src/data/fixtureProvider.json`):
   base price, pip volatility and typical spread per instrument — no price
   literals in provider code.
5. **Fixture synthesis is session-aware**: bars exist only when both open and
   close instants fall inside the instrument's session schedule
   (ADR-0009 registry), so weekends and metals maintenance appear as real
   gaps, not invented data.
6. **Provider health has a fixed shape** (`healthy|degraded|down`,
   sanitized detail only) reported by the provider; state monitoring and
   transitions are P02-04's scope.
7. **Candle timestamps are open-time UTC**; range requests are
   `[startUtc, endUtc)` with open-time-in-range semantics, aligned to the
   timeframe grid (ADR-0009).
8. **Providers are data-only components**: no execution, no order authority;
   the strategy->signal->risk->execution boundary (ADR-0003) is untouched.

## Consequences

- All later market-data consumers (P02-04 ingestion, P03 features, P08
  backtests) depend only on the interface, never on a concrete provider.
- Swapping in MT5 or a paid feed requires no downstream changes, only a new
  adapter implementing the interface (+ mapping entries in the versioned
  symbol table).
- Fixture datasets are replayable forever (determinism), which is the basis
  for golden backtest runs later.
- The fixture provider intentionally models closures as absent bars; gap
  detection (P02-03) must treat session-closed gaps as EXPECTED, not defects.

## Verification

- Backend vitest provider contract suite (14 cases): happy path, empty/
  boundary ranges, weekend/maintenance gaps, determinism across instances,
  malformed requests, unsupported capability error codes.
- `tests/test_data_core_contracts.py::ProviderBoundaryContracts`: interface
  surface in contracts; fixture provider offline (no fetch/http), no
  wall-clock, no randomness; session-aware synthesis via registry; no
  TradingView dependency anywhere.
- `make check` green.
