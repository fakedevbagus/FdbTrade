# ADR-0015: Immutable feature snapshot store with deterministic hashes

- Status: Accepted
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint v2 approval), Cline agent
- Supersedes: none
- Related: ADR-0013 (dataset manifests), ADR-0014 (feature definitions and lineage), ADR-0004 (UTC policy)

## Context

Prompt P03-04: "Persist feature snapshots keyed by event time, instrument,
timeframe, feature version and data snapshot ID", acceptance "Same input
snapshot + version produces identical snapshot hash", non-goal "No mutable
overwrite of historical lineage." P4 regime classification and P5 strategies
must be able to reproduce exactly which feature values existed at a given
bar, from which data — so snapshot identity and content must be
deterministic, tamper-evident and append-only.

## Decision

1. Snapshots are persisted by `FeatureSnapshotStore`
   (`backend/src/features/store.ts`) under the canonical key
   (instrument, timeframe, event time UTC, feature-group id + version,
   data snapshot id — the P02-05 dataset id). Key shape is pinned by
   `snapshotKeyString` in `@fdbtrade/contracts`.
2. `snapshotHash` = sha256 over the canonical serialization
   (`serializeSnapshotCanonical`): fixed field order, keys sorted,
   nulls as `-`, booleans as `true`/`false`, numbers in JS `String(number)`
   form (P02-05 cross-layer rules). The hash covers identity fields,
   values and feature versions — NOT createdAtUtc (metadata only).
3. Idempotency: re-persisting the SAME draft returns the EXISTING record
   (`idempotent: true`) without mutation — the original createdAtUtc and
   hash are preserved; no duplicate row.
4. Immutability: a DIFFERENT draft under the same key is a lineage
   conflict — rejected with a structured reason; history is never
   overwritten. Divergent content requires a new feature-group version or
   dataset id (a new logical snapshot).
5. The store is in-process with an INJECTABLE clock (only createdAtUtc
   uses it); a later durable backing store (Postgres) can replace the map
   without changing the persist/idempotency/conflict contract.
6. Drafts are validated fail-closed through the full snapshot schema
   before hashing/storing; malformed input never reaches the store.
7. Python mirror hashing (`quant/featurecore/snapshot.py`) is byte-exact;
   cross-layer parity is contract-tested via a node-inlined serialization
   script (same pattern as ADR-0013).

## Consequences

- Snapshot identity is fully derived from declared identity fields — no
  server-side uniqueness (e.g. auto-increment ids) can drift lineage.
- Warmup nulls are content (`-`), not absence: a warmup snapshot is a
  valid, hashable snapshot.
- Re-computation from the same inputs is always verifiable: recompute,
  hash, compare to the stored snapshotHash.
- In-process store is a known limitation (restart loses state); swap to a
  durable store is a later phase and must preserve the same contract.

## Verification

- Backend vitest `store.test.ts` (12 cases): identical-hash determinism,
  field-change hash sensitivity, key-order insensitivity, idempotent
  persist, conflict rejection, malformed drafts, clock independence,
  insertion-order listing.
- `tests/test_snapshot_store_contracts.py` (4 cases): TS<->Python hash
  parity (float/bool/int/null values), independent sha256 recomputation,
  key field order.
- `make check` green.
