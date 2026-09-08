# ADR-0011: Data quality gates — normalize and quarantine, never repair

- Status: Accepted (P02-03)
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0004 (UTC time policy), ADR-0009 (canonical market-data model),
  ADR-0010 (provider abstraction), Prompt Pack P02-03

## Context

Providers emit heterogeneous raw payloads: different symbol names, offset
timestamps, epoch numbers, extra decimals. Downstream consumers (features,
regime, backtests) need ONE canonical form plus a trustworthy statement of
what is wrong with imperfect data. The prompt's non-goal is explicit: no
auto-repair that invents market data — silently "fixing" a bad bar is worse
than rejecting it (quant integrity: a fabricated bar poisons every
downstream statistic).

## Decision

1. **Two-stage gate in `backend/src/data/quality/`**:
   - `normalizer.ts`: raw provider payloads -> canonical records. Symbol
     mapping via the versioned table (ADR-0009); timestamps accepted as
     `Z`, `±HH:MM` offsets, or epoch seconds/milliseconds and converted to
     canonical UTC ms instants; prices rounded to the instrument's declared
     digits (metadata).
   - `validator.ts`: series-level checks on already-canonical data —
     duplicates, strict ordering, session-aware gaps, impossible OHLC
     (defense in depth), stale/future/crossed quotes.
2. **Fixed quarantine taxonomy** shared by both stages and the Python
   mirror: `UNKNOWN_PROVIDER_SYMBOL`, `INVALID_TIMESTAMP`,
   `MISALIGNED_TIMESTAMP`, `DUPLICATE_TIMESTAMP`, `OUT_OF_ORDER`,
   `IMPOSSIBLE_OHLC`, `SESSION_GAP`, `STALE_QUOTE`, `CROSSED_QUOTE`.
   Rejected records carry (index, reason, detail) — never a raw provider
   payload (secret-safe detail only).
3. **No repair, ever.** Misaligned bars are NOT shifted onto the grid;
   gaps are NOT back-filled; duplicates keep the FIRST occurrence and
   quarantine the later one; naive timestamps (no zone) are rejected
   because silently assuming UTC is a data-integrity bug.
4. **Naive timestamps reject**: input timestamps must carry a zone (`Z` or
   offset) or be epoch numbers. Silent zone assumption is forbidden.
5. **Gap semantics are session-aware**: a missing bar is a `SESSION_GAP`
   only when BOTH its open and close instants fall inside the instrument's
   session schedule (ADR-0009). Weekends and metals maintenance closures
   are EXPECTED and never reported as gaps.
6. **Staleness is caller-defined**: `validateQuotes(quotes, asOfUtc,
   maxAgeMs)` — the asOf instant and max age are inputs (determinism; no
   wall-clock reads inside the gate). Future-dated quotes quarantine (clock
   skew / look-ahead risk).
7. **Python mirror** `quant/datacore/validate.py` implements the same gates
   for research/backtest parity; the cross-cutting contract tests pin the
   shared reason-code taxonomy.
8. **Mixed series are a caller bug**: validating candles of different
   (instrument, timeframe) in one call throws an explicit error instead of
   producing misleading cross-series gap reports.

## Consequences

- Downstream layers consume either ACCEPTED canonical data or an explicit
  quarantine report — never silent repairs.
- Gap reports become quality metrics for providers (P02-04 health uses
  them) without inventing data.
- Adding a reason code is a cross-layer change (TS + Python + contract
  test taxonomy) — deliberate, not accidental.
- The normalizer accepts offset/epoch inputs, so real MT5-style providers
  plug in without a separate converter.

## Verification

- Backend vitest suite `src/data/quality/__tests__/quality.test.ts`
  (28 cases): happy paths, every reason code, session-gap vs closure,
  boundary/empty, determinism, idempotency.
- `tests/test_data_core_contracts.py::ValidationContractTests` (10 cases):
  instant<->epoch-ms exactness (datetime cross-check), mirror parity,
  taxonomy lock.
- `make check` green.
