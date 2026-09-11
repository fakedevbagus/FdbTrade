# quant/ — Python quant engine + research

Python 3.12, stdlib-only (no third-party deps; ADR-0001). Real code from
P02_Data_Core onward.

## datacore/ (P02-01)

Stdlib mirror of `@fdbtrade/contracts` (ADR-0009):

- `model.py` — dataclass shapes, UTC instant/HH:MM/price validators,
  timeframe constants, open-time alignment helpers (no datetime deps).
- `parse.py` — strict fail-closed dict->model parsers (unknown keys reject),
  quote/candle validation, metadata-driven spread derivation.
- `registry.py` — loads the shared JSON (`contracts/src/data/*.json`),
  validated frozen lookups, session membership.

The JSON under `contracts/src/data` is the single source of truth for
instruments, sessions and provider symbol mappings; this package contains
no pip/precision literals.

Backtest engine lands in P08; research lab in P09.

## research/ (P09, ADR-0020)

Stdlib mirror of `contracts/src/research`:

- `splits.py` — deterministic train/validate/test partition with purge
  gaps (P09-01); byte-identical canonical serialization.
- `walkforward.py` — rolling/expanding folds, forward-only (P09-02).
- `purge.py` — horizon-based train purge + embargo tail (P09-03).
- `stress.py` — multiplier scenarios, seeded shuffle + block Monte Carlo
  (P09-04; stressed outputs always labeled `stressed`).
- `promotion.py` — candidate/challenger/champion lifecycle with evidence
  gates (P09-05; no order authority, ADR-0005).

Covered by `tests/test_research_lab.py` (mirrors the TS suites).

## backtestcore/ (P08-01)

Stdlib mirror of the event-driven backtest contracts and engine
(`contracts/src/backtest/contract.ts`, `backend/src/backtest/engine.ts`):

- `contract.py` — strict fail-closed parsers (intent, fill policy, run
  config), deterministic ids, canonical serializations for config/equity/
  trade hashing (byte-identical with the TS layer).
- `engine.py` — deterministic bar-replay with the same frozen per-bar event
  order (expiry -> fills -> exits -> MFE/MAE -> mark -> subject), the
  `next-bar-open` zero-cost placeholder fill policy and the conservative
  stop-first rule. NEVER calls a broker (ADR-0003/0019); live execution
  stays OFF (ADR-0005).

Cross-layer parity is pinned by `tests/fixtures/backtest_parity.json`.

## featurecore/ (P03)

Stdlib mirror of the feature contracts (`contracts/src/feature`, ADR-0014):

- `definition.py` — versioned feature definitions, feature groups, null
  policy, warmup (lookback) table, lineage metadata; strict fail-closed
  parsers mirroring the zod schemas.
- `snapshot.py` — immutable feature snapshots: canonical serialization,
  sha256 snapshot hashing, deterministic store keys, strict parsing.

Reuses `datacore` validators (UTC instants, instrument ids, semver); no
pip/precision literals; deterministic for deterministic inputs.

Indicators (P03-02) and market-structure features (P03-03) land in
`featurecore` in their own prompts.
