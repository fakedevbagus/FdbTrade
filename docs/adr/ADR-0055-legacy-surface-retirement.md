# ADR-0055: Legacy surface retirement

- Status: Accepted
- Date: 2026-09-29
- Deciders: FdbTrade private operator
- Supersedes: production exposure of fixture trading surfaces; preserves their evidence
- Related: ADR-0036, ADR-0037, ADR-0039, ADR-0040, ADR-0041, ADR-0047, ADR-0048
- Work unit: R1.9

## Context

Fixture dashboard, scanner and signal-detail projections and filesystem backtest
routes remained production-visible beside durable R0/R1 authorities. Historical
import also accepted instruments and intervals outside approved R0.6 scope.

## Decision

1. Former dashboard, scanner, signal-detail/chart and backtest operations remain
   authenticated but return HTTP 410 `LEGACY_SURFACE_RETIRED` with replacement
   locations and no former result payload.
2. Retired routes do not invoke legacy pipeline or filesystem execution.
3. Their UI pages render explicit retirement notices and durable workbench links.
4. Preserved implementation remains evidence; retirement is wiring-level.
5. Historical preview/registration accepts exactly EURUSD, GBPUSD, USDJPY,
   USDCHF, AUDUSD, USDCAD, NZDUSD and exactly 15m, 1h, 4h.
6. No migration, provider, scheduler, execution, rule or M48 change is introduced.

## Consequences

Legacy bookmarks remain truthful migration notices and callers receive terminal
responses rather than ambiguous fixture data. Out-of-scope imports fail closed.
The migration count remains twelve and preserved evidence stays intact.

## Verification

Route tests prove auth, 410 retirement, absent payloads and method closure.
Negative scope tests reject XAUUSD, 5m and 1d. Python contracts lock wiring,
progression, preservation and the 15/15 final gate.
