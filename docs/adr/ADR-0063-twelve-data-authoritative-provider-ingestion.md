# ADR-0063: Twelve Data authoritative provider ingestion

- Status: Accepted
- Date: 2026-09-30
- Deciders: FdbTrade private operator
- Supersedes: provider candles remaining shadow-only
- Related: ADR-0039, ADR-0059, ADR-0061, ADR-0062
- Work unit: R1.17

## Context

R1.16 could compare credentialed observations but explicitly could not publish
them. Authoritative ingestion must preserve the existing R0.6 SQLite metadata
and content-addressed artifact path while refusing incomplete, open, stale or
unlicensed provider evidence.

## Decision

Add a Twelve Data-specific ingestion service that:

1. retains the seven-pair and three-timeframe R0.6 scope;
2. extends the exact R1.15 query allowlist only with paired UTC `start_date`
   and `end_date` parameters;
3. limits a request to five non-overlapping pages of at most 1,000 bars each;
4. uses the DNS-pinned HTTPS adapter and shared retry/rate budget;
5. accepts only closed, aligned, unique candles inside each page;
6. requires complete session-aware coverage with zero quarantined rows or
   in-session gaps;
7. rejects stale ranges and requires verified licensing evidence on an
   official Twelve Data HTTPS origin;
8. publishes only the complete batch through `MarketDataAuthority.publish`;
   and
9. uses the existing durable ingestion jobs for dedupe, terminal failure and
   crash recovery.

Provider data uses the existing truthful `historical` source mode. No database
migration or competing authority is introduced.

## Consequences

A successful provider batch can now become R0.6 authority and can subsequently
be consumed by existing signal, research and paper workflows under their own
operator gates. A provider or page failure publishes nothing and never falls
back to fixture data.

R1.17 adds no API/UI trigger and no scheduler. R1.18 may call this service only
under separate authorization and must preserve all scheduler safety controls.

## Verification

Hermetic tests cover bounded pages, successful and deduplicated publication,
partial-page failure, rate exhaustion, stale evidence, duplicate timestamps,
gaps, crash/restart recovery, artifact tampering and license rejection. No real
credential or provider request is used.