# ADR-0060: Provider selection dossier

- Status: Accepted
- Date: 2026-09-30
- Deciders: FdbTrade private operator
- Supersedes: provider selection by undocumented preference
- Related: ADR-0029, ADR-0032, ADR-0046, ADR-0059
- Work unit: R1.14

## Context

R1.13 completed the offline private-beta gate. Any external FX data work now
requires a sourced comparison before credentials, egress or production behavior
can change.

## Decision

Use measurable coverage, candle semantics, history, freshness/revision,
licensing/export, cost/limits/uptime, authentication, SDK independence and
testability criteria. Keep sourced facts, engineering inferences and unknowns
separate.

The decision-ready shortlist is Twelve Data Basic, OANDA v20 candles and
Dukascopy Historical Data Export, with Dukascopy limited to a historical role.
R1.14 does not select a winner. Alpha Vantage FX_INTRADAY and HistData are
rejected for the present target for the reasons recorded in the dossier.

R1.15 remains blocked until the operator authorizes exactly one named provider
or explicitly defers.

## Consequences

Provider choice becomes reviewable and reversible. Unknown terms, entitlements,
revision behavior and uptime remain visible rather than being converted into
assumptions. A future implementation must stay provider-specific and bounded.

## Verification

Contracts verify the complete matrix, source labeling, shortlist, rejection
reasons, null selection, copy-ready provider choices, unchanged twelve
migrations, preserved M48 files and a passing complete gate.