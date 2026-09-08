# ADR-0014: Versioned feature definitions and lineage contracts

- Status: Accepted
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint v2 approval), Cline agent
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC policy), ADR-0009 (canonical market-data model), ADR-0013 (dataset manifests)

## Context

P3 Feature Core starts with the prompt P03-01: "Create versioned feature
definitions, feature groups, null policy, lookback requirements, and lineage
metadata." Features feed regime classification (P4), strategies (P5) and
signals; every derived value must be reproducible and attributable to an
exact input snapshot. The canonical market-data model (ADR-0009) and the
dataset manifest (ADR-0013) already define candles and dataset identity —
the feature layer must build on them, not duplicate them.

## Decision

1. Feature contracts live in `@fdbtrade/contracts`
   (`src/feature/{definition,snapshot}.ts`) — the same shared-package
   boundary as market data; backend and tests consume one model.
2. Every `FeatureDefinition` declares, at schema level: `featureId`
   (snake_case), semver `version`, `inputs` (subset of canonical series
   fields `close/high/low/open/volume/mid`), `fn` (deterministic transform
   id), `params`, `lookbackBars` (warmup bars before first non-null output),
   `outputType` (`number`|`boolean`), `nullPolicy`, `description`, and
   `metadata` (UTC creation instant + provenance notes).
3. `lookbackBars` is NOT free: a schema refinement pins it to the
   deterministic warmup table `functionLookback(fn, params)` (sma period-1,
   ema period-1, rsi/atr period, adx 2*adxPeriod-1, macd
   (slow-1)+(signal-1)). A definition that lies about its lookback is
   invalid at parse time.
4. Null policy is explicit: `null_on_warmup` (deterministic warmup emits
   null) and `null_on_insufficient_data` (a malformed/gappy input fails the
   snapshot — fail closed; no invented bars, no zero-fill).
5. A `FeatureGroup` bundles definitions sharing one input timeframe; a
   `FeatureLineage` binds a computed value set to instrument, timeframe,
   event time (UTC), group id+version, feature ids+versions and the P02-05
   dataset id + manifest checksum digest. Lineage is data — reproducible
   from these fields alone.
6. Feature snapshots (P03-04 shape, defined here) are immutable and
   hash-addressed over a canonical pipe-serialization (keys sorted, nulls
   as `-`, JS `String(number)` formatting — the P02-05 cross-layer rules).
7. Stdlib Python mirror `quant/featurecore` (definition + snapshot) keeps
   research and cross-cutting contract tests on the same model, reusing
   `datacore` validators; no third-party dependencies.
8. Input windows are typed (`InputWindow`): fields come from canonical
   candles; `mid` requires a quote-derived series and rejects fail-closed
   here; instrument precision metadata travels with the window so pip size
   is never hardcoded.

## Consequences

- Adding a new indicator function requires extending the `FEATURE_FUNCTIONS`
  enum + warmup table in BOTH layers and a contract-test update — deliberate
  friction against silent drift.
- MACD-family multi-output functions are represented as one definition per
  output value (e.g. macd line vs signal vs histogram as separate ids).
- `mid` inputs wait for quote-derived series support (P03-02+); rejecting
  early avoids inventing data.
- Snapshots keyed by (instrument, timeframe, event time, group version,
  dataset id) make re-computation idempotent and historical lineage
  immutable (no mutable overwrite).

## Verification

- `contracts` vitest: feature-definitions + feature-groups-lineage suites
  (valid/malformed/missing/boundary/determinism cases).
- `tests/test_feature_core_contracts.py` +
  `tests/test_feature_groups_lineage_contracts.py` +
  `tests/test_feature_snapshot_contracts.py` (stdlib unittest, mirror
  parity of enums, warmup table and fail-closed parsing).
- `make check` green for affected packages.
