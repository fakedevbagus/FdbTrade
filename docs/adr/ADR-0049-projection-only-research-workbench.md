# ADR-0049: Projection-only research workbench

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private operator
- Supersedes: no authority; adds an operator projection over ADR-0048
- Related: ADR-0041, ADR-0047, ADR-0048
- Work unit: R1.3

## Context

R0.8 established one frozen historical baseline backed by SQLite and immutable,
content-addressed artifacts. R1.2 exposed strict authenticated POST/list/detail
adapters, but the operator still had no dedicated UI for choosing eligible R0.6
data, explicitly starting that baseline, or interpreting its durable evidence.

The workbench must not become a second authority or imply that historical
metrics are current signals, calibrated confidence, operational outcomes, or
promotion evidence. It also must not expose optimization or editable strategy
inputs through a convenient UI side door.

## Decision

1. `/research/workbench` is a force-dynamic authenticated server projection.
   It forwards the private session to the R1.2 GET list/detail routes and
   validates every nested response object with strict frontend schemas.
2. The submission control is a narrow client component. It offers only
   registered datasets whose R0.6 quality is accepted with zero quarantined,
   gap, and duplicate observations. Historical staleness is not treated as a
   current-feed failure.
3. A submission sends exactly `datasetId` and a canonical millisecond UTC
   `createdAtUtc` through a same-origin POST facade. The facade forwards the
   opaque session cookie and body to R1.2; it contains no research logic.
4. The UI exposes no baseline parameter. Configuration, rule, costs, seed,
   quantity, warmup, latency, and conservative exit policy remain frozen by
   R0.8/R1.2. Duplicate submissions reopen the same durable run.
5. List and detail views project lifecycle, failure/block evidence, the full
   frozen metrics set, cost assumptions, source/config/rule/artifact hashes,
   engine lineage, and explicit historical-only, uncalibrated, non-promotion
   interpretation. Null or absent evidence remains visibly absent.
6. Empty, loading, quality-blocked, failed, stale-session, malformed-response,
   and backend-unavailable states fail closed without legacy or fixture
   fallback.
7. No backend production source or migration changes. R1.2 remains the API and
   R0.8 remains the research authority. The legacy backtest route remains
   separate and non-authoritative.

## Consequences

- The operator can deliberately run and reopen exactly one authoritative
  historical baseline from the protected application.
- Browser mutation stays same-origin while backend authentication remains the
  security boundary.
- The UI cannot tune, promote, infer confidence, invoke risk/paper authority,
  call a provider, or schedule work.
- Temporal validation, robustness, and any broader research claim remain later
  separately authorized units.

## Verification

Frontend tests cover strict nested schemas, exact submission payloads,
same-origin forwarding, eligible selection, successful/blocked/failed/empty
views, duplicate replay, stale session, malformed evidence, and unavailable
backend behavior. Python contracts pin the unchanged R1.2 backend source
digests, nine migrations, false safety flags, and all ten M48 hashes.
`make toolchain-gate` remains the final acceptance authority.
