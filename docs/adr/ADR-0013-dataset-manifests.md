# ADR-0013: Historical dataset manifests and replayable datasets

- Status: Accepted (P02-05)
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0004 (UTC policy), ADR-0009 (canonical model),
  ADR-0010 (deterministic fixtures), ADR-0011 (quality gates), Prompt Pack P02-05

## Context

Research and backtests need datasets that are reproducible: the same dataset
id must always describe the same bytes, and any tampering or drift must be
detectable. The prompt also forbids claiming a dataset is licensed without
evidence. The manifest is the provenance anchor the blueprint requires
("dataset/version/parameter/code provenance").

## Decision

1. **Manifest schema in `@fdbtrade/contracts`** (`marketdata/dataset.ts`):
   datasetId, providerId, instrument, timeframe, period `[start, end)`,
   recordCount, sha256 checksum, timezone locked to `UTC`,
   candleTimestampSemantics locked to `open-time-utc`, manifestVersion 1,
   createdAtUtc, and a license note.
2. **Deterministic dataset identity**: `datasetId =
   dataset|provider|instrument|timeframe|periodStart|periodEnd` — the natural
   key; two manifests with the same id describe the same logical dataset.
   Period end is EXCLUSIVE (last bar open + one frame): replay = fetching
   `[periodStart, periodEnd)` returns exactly the recorded batch.
3. **Checksum over a canonical serialization**: candles serialize to
   pipe-joined fixed-order fields (`instrument|timeframe|timestamp|open|
   high|low|close|volume`, `-` for null volume, newline-joined, no trailing
   newline); sha256 over the UTF-8 bytes. Numbers use JS `String(number)`
   formatting — the Python mirror implements byte-exact `js_number_str`
   (decimal expansion via `decimal.Decimal`, JS exponent form at 1e21 /
   below 1e-6) so BOTH layers produce identical digests. Changing the
   serialization is a cross-layer breaking change; parity is contract-tested.
4. **Builder + verifier in the backend** (`src/data/manifest.ts`):
   `buildDatasetManifest` derives everything from a homogeneous, ascending,
   non-empty canonical batch (fail-closed otherwise); `verifyDatasetManifest`
   re-derives and compares (schema, homogeneity, count, checksum) returning
   explicit mismatch reasons. Replay = refetch the period and verify.
5. **License notes are honest by construction**: status is
   `verified | unverified | synthetic`. A `verified` claim REQUIRES an
   `evidenceUrl` (schema-enforced, mirrored in Python). Fixture datasets
   declare `synthetic` and make no license claim. Third-party data defaults
   to `unverified` until evidence exists.
6. **Python mirror** (`quant/datacore/manifest.py`) parses, serializes,
   hashes and verifies with the same rules so research provenance matches
   the TS layer exactly.

## Consequences

- Any dataset used in research can be pinned by id and byte-verified on
  replay — the foundation for golden backtest runs and the promotion
  registry's provenance requirements.
- Dataset tampering (accidental edits, provider drift) is detected by
  checksum mismatch with a machine-readable reason.
- License status is auditable: no "verified" claim without a recorded
  evidence URL.
- A future dataset registry (DB-backed store) can adopt the same schema;
  the in-code contract stays authoritative.

## Verification

- Backend vitest `src/data/__tests__/manifest.test.ts` (12 cases):
  deterministic ids, checksum derivation, replay from the fixture provider,
  tamper/count/foreign-record detection, malformed manifests,
  license-evidence enforcement.
- `tests/test_data_core_contracts.py::ManifestContractTests` (6 cases):
  JS number formatting parity, canonical serialization shape, TS/Python
  digest equality, manifest roundtrip + tamper detection, verified-license
  evidence requirement, malformed-manifest rejection.
- `make check` green.
