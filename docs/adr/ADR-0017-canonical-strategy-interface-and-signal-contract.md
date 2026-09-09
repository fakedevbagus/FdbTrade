# ADR-0017: Canonical strategy interface and signal contract v2

- Status: Accepted
- Date: 2026-09-09 (UTC)
- Deciders: FdbTrade owner (blueprint v2 approval), Cline agent
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC policy), ADR-0005 (live trading OFF), ADR-0014 (versioned definitions), ADR-0016 (regime engine)

## Context

Phase P5 requires baseline strategies that consume the P3/P4 feature and
regime layers and emit tradeable intents. Before any strategy is coded, the
frozen signal contract must exist: every signal needs strategy/version/
input-snapshot lineage (blueprint non-negotiable), explicit validity and
expiry, deterministic identity for idempotent re-evaluation, and level
consistency. Strategies are pure data components: they must never call a
broker and never bypass the future risk/execution boundary (ADR-0003).

## Decision

1. The canonical `Signal` lives in `contracts/src/strategy/contract.ts`
   (Python mirror `quant/strategycore/contract.py`): instrument, timeframe,
   UTC bar-OPEN event time, direction (`long`/`short`), strategy id + LOGIC
   semver + CONFIG semver (versioned separately), entry type
   (`market`/`stop`/`limit` + explicit `entryPrice` for resting entries),
   `referencePrice`, MANDATORY `stopLoss` (a signal without an invalidation
   level is invalid by construction), optional `takeProfit`, strict
   `expiresAtUtc`, `confidence` in [0,1] (strategy certainty — NEVER a win
   probability), sorted unique reason codes, the exact input values used,
   and sha256 `snapshotHash`.
2. Deterministic identity: `signalId` =
   `sig_{strategyId}_{instrument}_{timeframe}_{eventTimeUtc}_{direction}` —
   a strategy emits at most one signal per (closed bar, direction); the
   schema enforces the id equals its own fields. Idempotent evaluation of
   the same snapshot yields the same signal (same id, same hash).
3. `expiresAtUtc` must be strictly after `eventTimeUtc` AND aligned to the
   timeframe grid; `eventTimeUtc` must be grid-aligned. After expiry a
   signal is dead — no implicit extension (P05-06 formalizes the lifecycle).
4. Levels are direction-consistent (long: stop below and target above the
   effective reference `entryPrice ?? referencePrice`; short mirrored);
   stop==reference or target==stop reject. `stop`/`limit` entries require
   an explicit `entryPrice`.
5. `StrategyEvaluation` is the per-bar result envelope: at most one signal,
   `emitted` flag consistent with signal presence, signal anchored to the
   same event time and strategy, sorted reason codes. No-signal is a
   first-class explained outcome, never an error.
6. `StrategyInputSnapshot` is the closed-world input: instrument metadata
   (pip/digits from the catalog — never literals), one timeframe,
   strictly-ascending CONTIGUOUS candles ending exactly at `eventTimeUtc`
   (the last closed bar — strategies never see forming bars), and the P04-03
   regime context for the same event time. Empty windows are valid input;
   strategies must fail closed (warmup) on them.
7. The `Strategy` interface: id, versions, timeframe, description, typed
   config and a pure `evaluate(snapshot) -> evaluation`. No wall clock, no
   randomness, no broker/execution calls — enforced by review + tests
   (determinism and no-look-ahead are proven per strategy in P05-02..05).
8. The backend builder (`backend/src/strategy/builder.ts`) is the single
   construction path: derives `signalId`, hashes
   `serializeSignalCanonical` (byte-identical TS/Python form; nulls `-`,
   booleans `true/false`, JS number formatting per P02-05), validates
   against the strict schema. TS/Python parity is pinned by the committed
   fixture `tests/fixtures/signal_parity.json`.
9. Signal reason codes are a frozen shared enum (`SIGNAL_REASON_CODES`),
   reused by evaluations and the P05-06 lifecycle; extension requires
   bumping the contract version.

## Consequences

- P5-02..P05-05 strategies implement only this interface; ensemble, cost
  gate, risk and execution consume signals only through this contract.
- Changing field set, level rules, id form or serialization is a breaking
  change: bump `signalContractVersion` and supersede this ADR.
- Strategies cannot hold positions or manage exits themselves; exits
  belong to invalidation levels and the later lifecycle/execution layers.

## Verification

- `contracts` vitest: signal schema valid/malformed/boundary, evaluation
  envelope, input-snapshot guards (21 cases).
- `backend` vitest: builder happy path, idempotency, fail-closed drafts,
  canonical serialization + parity fixture writer (6 cases).
- Python stdlib: parse/serialize/hash parity + fail-closed mirrors
  (16 cases), committed fixture parity.
- `make check` green.
