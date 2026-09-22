# ADR-0039: Market-data and artifact authority

- Status: Accepted
- Date: 2026-09-22
- Deciders: FdbTrade private-beta owner
- Supersedes: Process-local ingestion job authority in ADR-0012 and file-only dataset registry in ADR-0035
- Related: ADR-0004, ADR-0009, ADR-0010, ADR-0011, ADR-0013, ADR-0036, ADR-0037, ADR-0038
- Work unit: R0.6

## Context

The preserved market-data pipeline validated deterministic fixture and
operator-owned historical candles, but its ingestion jobs lived in memory and
its historical registry stored mutable JSON documents directly by logical
dataset id. A restart could therefore forget a completed ingestion, metadata
could disagree with artifact bytes, and publication had no recoverable boundary.
R0.6 must establish one authority without choosing a credentialed provider or
adding signal, research, risk, broker, UI, backup or execution behavior.

## Decision

1. Migration `0005_market_data_artifacts` makes SQLite authoritative for
   market-data dataset metadata, artifact locations, quality/freshness facts and
   ingestion job state. Dataset and artifact rows are immutable; terminal jobs
   are immutable and all job rows are append-only.
2. Approved R0.6 scope is exactly the seven FX majors `EURUSD`, `GBPUSD`,
   `USDJPY`, `USDCHF`, `AUDUSD`, `USDCAD`, `NZDUSD` and timeframes `15m`, `1h`,
   `4h`. SQLite constraints and the application boundary both fail closed on
   any wider instrument or timeframe.
3. Canonical candle bytes are immutable content-addressed files below
   `<data-root>/artifacts/market-data/sha256/<prefix>/<digest>.candles`. SQLite
   stores the SHA-256 digest, relative path and byte count; readers re-hash and
   parse every opened artifact before returning candles.
4. Publication writes a same-filesystem staging file, fsyncs it, renames it to
   its digest path, fsyncs the containing directory, and only then commits the
   artifact and dataset metadata in one `BEGIN IMMEDIATE` transaction. Thus a
   visible dataset row always has already-published content. A crash may leave
   only an unreferenced immutable blob, never authoritative metadata without
   bytes.
5. Recovery removes incomplete staging files, identifies unreferenced blobs,
   verifies every registered dataset, and returns interrupted `running`
   ingestion jobs to `pending`. Replaying that job republishes the same digest
   idempotently before completing the job once.
6. Quality state derives only from measured accepted, quarantined, duplicate
   and gap counts. Freshness is deterministic: the caller supplies an assessment
   instant and data is fresh only through twice its timeframe after the latest
   completed bar. No wall clock can rewrite stored facts.
7. Historical CSV confirmation and replay use the canonical application SQLite
   connection. Fixture ingestion accepts only providers declaring synthetic
   capability, retains bounded retry/quality behavior, and writes its durable
   job and dataset evidence through this authority.
8. Credentialed/network providers and the quarantined M48 shadow code remain
   disconnected. Live execution and provider-order transport remain off.

## Consequences

- SQLite is the only durable metadata authority while large immutable candle
  bytes remain inspectable files whose identity is enforced by SQLite and hash.
- Crash recovery can safely repeat publication; content duplicates collapse to
  one digest and logical dataset conflicts fail closed.
- Unreferenced content is reported, not silently adopted or deleted. A future
  cleanup or backup policy needs separate authorization.
- Existing 5m/1d and XAUUSD contracts remain available as historical model
  evidence but cannot be published through the R0.6 authority.
- No claim is made that fixture freshness represents a live market feed.

## Verification

- Vitest covers exact scope, fixture publication, SQLite reopen, content
  integrity, immutable metadata, crash after dataset publication, recovery and
  duplicate replay without a second logical dataset.
- Historical workflow tests prove confirm/list/replay and downstream provenance
  reopen through SQLite-backed metadata and immutable content.
- Python contracts pin migration ownership, publication ordering, canonical
  route wiring and safety exclusions.
- `make toolchain-gate` is the final bounded acceptance authority.
