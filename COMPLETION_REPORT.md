# Completion Report

Prompt ID: P03_Feature_Core (P03-01 through P03-04, executed in required order)
Phase: P3 Feature Core
Date/time UTC: 2026-09-09T00:30Z
Branch/commit: main / four focused commits, HEAD at P03-04 commit

## What changed

The P3 Feature Core phase is complete: versioned feature definitions and
lineage (P03-01), deterministic core indicators (P03-02), market-structure
features with explicit no-look-ahead proofs (P03-03), and the immutable
snapshot/lineage store with cross-layer hash parity (P03-04) — the phase
gate "Feature schemas; snapshots; fixtures" is satisfied and `make check`
is green.

### P03-01 — Feature schema and lineage (ADR-0014)
- `contracts/src/feature/definition.ts`: `FeatureDefinition` (featureId
  snake_case, semver version, inputs from canonical series fields,
  `fn` + `params`, `lookbackBars` PINNED to the deterministic warmup table
  `functionLookback(fn, params)` — sma/ema period-1, rsi/atr period,
  adx 2*period-1, macd (slow-1)+(signal-1) — a lying lookback rejects at
  parse time), `FeatureGroup`, `FeatureLineage` (event time UTC + P02-05
  dataset id/manifest digest binding), typed `InputWindow` (fail-closed
  field guards, instrument-precision metadata travels with the window).
- Null policies: `null_on_warmup` (deterministic warmup emits null) and
  `null_on_insufficient_data` (fail closed — no invented bars, no
  zero-fill).
- `contracts/src/feature/snapshot.ts` (P03-04 shape defined here):
  `FeatureSnapshot` (strict schema, hash-addressed, snapshotVersion 1),
  canonical serialization (`serializeSnapshotCanonical` — fixed field
  order, sorted keys, null `-`, JS number strings), deterministic store
  keys (`snapshotKeyString`).
- Stdlib Python mirror `quant/featurecore` (definition.py, snapshot.py)
  reusing `datacore` validators.

### P03-02 — Core indicators (backend `src/features/indicators.ts`)
- Deterministic, bar-index-aligned series: `sma`, `ema` (SMA-seeded),
  `rsi` (Wilder; flat-series convention = 50; clamped [0,100]), `atr`
  (Wilder), `adx` (Wilder, first value at 2*period-1), `macd`
  (line/signal/histogram), `returns`, `logReturns` (non-positive prices
  fail closed), `realizedVolatility` (rolling sample stdev of 1-bar log
  returns, annualization via caller-provided periodsPerYear).
- 35 vitest cases: hand-computed fixtures, monotone/constant/edge cases,
  warmup alignment, determinism, and no-look-ahead truncation proofs.
- Python mirror `quant/featurecore/indicators.py` — TS<->Python numeric
  parity PINNED by committed fixture `tests/fixtures/indicator_parity.json`
  (written deterministically by a backend test; Python asserts exact
  equality).

### P03-03 — Market-structure features (backend `src/features/structure.ts`)
- `candleStructure` (body/range, wick ratios null on zero range, direction,
  inside/outside vs prior bar), `distanceToLevel` (metadata pips),
  `rollingPriorHigh/Low` + `distanceToPriorRange` (level EXCLUDES the
  current bar — no self-look-ahead), `trendSlope`/`trendSlopePips`
  (rolling OLS), `multiHorizonReturns`, `realizedVolatilityWindows`,
  `atrFraction`, `sessionFeatures` (UTC weekday/hour/day fraction,
  schedule membership from session metadata, bounded backward
  minutes-since-open, session-reopen flags).
- Explicit no-look-ahead proof tests: tail truncation AND future-append
  invariance across structure/slope/ATR/returns.

### P03-04 — Snapshot/lineage store (ADR-0015, backend `src/features/store.ts`)
- `FeatureSnapshotStore`: append-only, keyed by (instrument, timeframe,
  event time UTC, feature-group id+version, dataset id). Drafts validated
  fail-closed through the full snapshot schema before hashing.
- `snapshotHashFor` = sha256 over the canonical serialization (content
  only — hash excludes snapshotHash and createdAtUtc, so the same input
  snapshot + versions ALWAYS hashes identically; clock-independent).
- Idempotent re-persist returns the EXISTING record without mutation;
  conflicting content under the same key is REJECTED (historical lineage
  never overwritten — prompt non-goal); malformed drafts rejected with
  structured reasons; injectable clock.
- Cross-layer parity contract test (`tests/test_snapshot_store_contracts.py`):
  TS and Python produce the IDENTICAL snapshot hash (node-inlined TS
  serialization, sha256; float/bool/int/null values).

## Files changed

- contracts: `src/feature/{definition,snapshot}.ts` (new), `src/index.ts`
  (exports), `src/__tests__/{feature-definitions,feature-groups-lineage}.test.ts`
  (new, 20 cases), `README.md` (feature section).
- backend: `src/features/{indicators,structure,store}.ts` (new),
  `src/features/__tests__/` (6 new test files, 84 cases).
- quant: `featurecore/{__init__,definition,indicators,snapshot}.py` (new),
  `README.md` (featurecore section).
- tests: `test_feature_core_contracts.py`,
  `test_feature_groups_lineage_contracts.py`,
  `test_feature_snapshot_contracts.py`,
  `test_feature_indicators_contracts.py`,
  `test_snapshot_store_contracts.py` (new),
  `fixtures/indicator_parity.json` (new), `test_ci_contracts.py`
  (ADR list extended to 0015 — justified: the ADR-list contract follows
  the repo's per-ADR pattern from P02).
- docs: ADR-0014, ADR-0015 + `docs/adr/README.md` index.

## Tests executed

- `make check` — GREEN (lint + typecheck + test + build, all packages).
- Backend vitest: 246 tests (72 feature-layer: 35 indicators, 25 structure,
  12 store; plus all P1/P2 suites).
- Contracts vitest: 48 tests (20 new feature schema cases).
- Python stdlib contracts: 237 tests (44 new feature-core cases across 5
  files; all prior suites still green).
- Cross-layer: TS<->Python indicator numeric parity (committed fixture);
  TS<->Python snapshot-hash parity (node-inlined serialization).

## Acceptance criteria

- [x] P03-01: every feature declares version, inputs, lookback and output
      type; feature schema tests pass (contracts 20 + Python 20 cases).
- [x] P03-02: known fixtures match expected outputs within documented
      tolerance (toBeCloseTo 9 digits / places=10; hand-computed fixtures);
      TS<->Python numeric parity pinned by fixture.
- [x] P03-03: features computed without future bars; tests explicitly
      prove no look-ahead (truncation + future-append invariance).
- [x] P03-04: same input snapshot + version produces identical snapshot
      hash (deterministic, order-insensitive, clock-independent);
      immutable store (idempotent put, conflict rejection).
- [x] Relevant tests pass from a clean environment — `make check` green.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified without justification (ADR-list contract
      test update justified above; `.git/config` core.fileMode repaired to
      `false` per repo rules after a corrupted value blocked commits —
      environment repair, not a repo file change).
- [x] Completion report written — this file.

## Known limitations / blockers

- Snapshot store is in-process only (restart loses state); swapping to a
  durable backing store must preserve the persist/idempotency/conflict
  contract (ADR-0015, cf. ADR-0012 precedent).
- `mid` input series is reserved but rejected in candle windows until a
  quote-derived series exists (fail-closed, documented).
- Realized volatility annualization is caller-supplied (periodsPerYear);
  no annualization policy is baked into the feature layer.
- Fixture parity file is regenerated by the backend test; both layers must
  stay in lockstep (pinned by tests on both sides).

## Follow-up required before next prompt

None blocking. P3 phase gate ("Feature schemas; snapshots; fixtures") is
satisfied.

## Risk notes

Quant: all timestamps UTC; candle-open semantics preserved; warmup nulls
are content (hashable), never fabricated values; no look-ahead is proven
by tests, not asserted; indicator conventions (Wilder smoothing, EMA SMA
seeding, RSI flat=50) are documented and pinned by tests on both layers;
snapshot lineage binds every value to feature versions + dataset id +
manifest digest, making every computation reproducible and tamper-evident.
Security: no secrets in fixtures, logs or bundles; store rejection reasons
are structured and sanitized. Trading safety: no strategy, signal, risk or
broker code added; live execution remains OFF (ADR-0005); the feature
layer is a pure data component (ADR-0003 boundaries intact).

## Next prompt (safe to run)

`01_PROMPTS/P04_Regime_Engine/` — deterministic regime classifier with
tests, per `00_CONTROL/RUN_ORDER.md` (P3 gate passed).
