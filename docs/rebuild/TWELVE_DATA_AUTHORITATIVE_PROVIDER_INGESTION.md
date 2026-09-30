# Twelve Data Authoritative Provider Ingestion

R1.17 connects accepted Twelve Data candles to the unchanged R0.6 ingestion
job, immutable artifact and SQLite metadata authority.

## Acceptance pipeline

One explicit call to `AuthoritativeTwelveDataIngestion.ingest` performs:

1. canonical request and R0.6 scope validation;
2. official verified license-evidence validation;
3. aligned range planning, capped at 5,000 bars in five 1,000-bar pages;
4. credentialed reads through the R1.15 boundary and DNS-pinned HTTPS port;
5. R1.16 normalization and closed-bar enforcement;
6. exact per-page scope validation;
7. global duplicate, quarantine and session-gap rejection;
8. complete session-aware requested-range coverage;
9. latest-bar freshness enforcement;
10. manifest construction with provider and license provenance;
11. existing R0.6 content-addressed artifact publication; and
12. terminal durable-job linkage to the published dataset.

The Twelve Data time-series contract documents bar-open `datetime` values and
string OHLC fields:
<https://twelvedata.com/docs/llms/market-data/time-series.md>.

## Failure behavior

No artifact or dataset metadata is published when any page:

- fails transport, provider, retry or rate budget;
- is malformed, oversized or outside the requested range;
- contains an open, duplicate or misaligned bar;
- leaves an in-session coverage gap; or
- produces stale evidence.

A failed dedupe key remains terminal. A process crash after immutable
publication leaves a running job; the existing R0.6 recovery resets that job
to pending, and replay publishes the same content idempotently.

Artifact tampering remains detectable by the existing SHA-256 verification.
SHA-256 proves integrity only, not provider authenticity.

## Authority and safety

- Source mode remains `historical`; provider identity is `twelve-data`.
- License status must be `verified` with an official HTTPS evidence URL.
- Raw responses and credentials are not persisted.
- No fixture fallback or partial publication exists.
- No scheduler, API/UI trigger, signal evaluation, research run, paper run,
  provider-order method, demo execution or live execution was added.
- The migration ledger remains at twelve.
- All ten quarantined M48 files remain byte-identical and unused.

## Test policy

All network outcomes use injected deterministic executors. R1.17 performed no
real credentialed smoke test and no Twelve Data request.

## Stop boundary

R1.18 may schedule this ingestion and downstream analysis only after separate
authorization. The scheduler remains opt-in and off by default.