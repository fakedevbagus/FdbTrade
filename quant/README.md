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
