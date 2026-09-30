# ADR-0062: Twelve Data credentialed read-only shadow

- Status: Accepted
- Date: 2026-09-30
- Deciders: FdbTrade private operator
- Supersedes: provider evidence inferred from fixtures or promoted directly
- Related: ADR-0039, ADR-0059, ADR-0060, ADR-0061
- Work unit: R1.16

## Context

R1.15 established an exact credential and egress boundary but deliberately
contained no production transport or provider comparison. The next safe step is
to observe Twelve Data evidence without publishing it as R0.6 authority.

The preserved M48 files were checked byte-for-byte against the R0.1 manifest.
They implement a generic operator-declared shadow with different scope and
authority assumptions. No M48 file is imported, modified or adopted.

## Decision

Add an explicit operator CLI and a provider-specific projection that:

1. reuses the R1.15 secret, request, DNS/IP, timeout, retry and rate boundary;
2. pins the HTTPS connection to the public address approved by that boundary;
3. accepts only bounded `/time_series` JSON for the requested pair and interval;
4. normalizes UTC OHLC rows, rejects malformed, duplicate or unaligned
   timestamps, and excludes a bar until its interval has closed;
5. compares closed provider observations with an operator-supplied canonical
   R0.6 candle artifact for coverage and OHLC drift in caller-supplied pips;
6. prints metadata-only evidence and never writes SQLite or an artifact; and
7. is invoked only by an operator command—there is no API, UI or scheduler.

The report explicitly marks provider observations ineligible for signals,
research and paper behavior. It is evidence about a provider, not market-data
authority.

## Consequences

A credentialed call is now possible, but no call is performed by tests or by
this work unit. Missing credentials block the command without fixture fallback.
R1.17 remains necessary before any provider candle may enter the existing R0.6
ingestion and immutable publication path.

## Verification

Hermetic tests cover normalization, bar closure, coverage, timestamp integrity,
drift, malformed responses and credential failure. A no-network CLI smoke test
proves fail-closed behavior. Python contracts pin the non-authoritative surface,
unchanged migrations and all ten preserved M48 hashes.