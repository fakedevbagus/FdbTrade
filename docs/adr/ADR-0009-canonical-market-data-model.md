# ADR-0009: Canonical market-data model

- Status: Accepted (P02-01)
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0002 (repository layout), ADR-0003 (architecture boundaries),
  ADR-0004 (UTC time policy), `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`, Prompt Pack P02-01

## Context

P02 starts the Data Core. Backend (TS), research (Python) and tests all need
ONE canonical model for instruments, quotes, candles, spreads, sessions and
symbol mappings. Without a frozen shared model, each layer drifts: different
timestamp forms, different pip assumptions, different session semantics —
exactly the hard-coded assumptions the Agent Constitution prohibits.
The frozen blueprint locks the trading universe (7 FX majors + XAUUSD) and
timeframes (5m, 15m, 1h, 4h, 1d context) that the model must express.

## Decision

1. **`@fdbtrade/contracts` is the shared TS contract package.** It contains
   the canonical zod schemas and becomes a real (no longer placeholder)
   workspace package. Backend consumes it as a `workspace:*` dependency with
   `transpilePackages` (source-package consumption, no dist build step).
2. **`quant/datacore` is the stdlib Python mirror.** Same shapes, same
   validation semantics, no third-party dependencies (ADR-0001). It is the
   pattern already proven by `infra/config` (dual-language contract).
3. **Instrument/session/mapping VALUES are data files, not code.** One set
   of JSON files (`contracts/src/data/{instruments,sessions,symbolMappings}.json`)
   is the single source of truth both layers load, validate and expose.
   Pip size, point, digits, contract size and session windows appear ONLY
   there — never as literals in strategy/feature/UI/research code.
4. **Canonical timestamp: `YYYY-MM-DDTHH:mm:ss.sssZ`, millisecond precision.**
   `z.iso.datetime({offset:false, precision:3})` on the TS side and an exact
   regex on the Python side; offset or naive forms reject at the boundary.
   Candle timestamps are the bar OPEN time in UTC (ADR-0004 item 4).
5. **Spread is derived, never stored as input**: `(ask-bid)` and
   `(ask-bid)/pip` computed from instrument precision metadata; crossed
   markets (ask < bid) are invalid and fail closed.
6. **Candle OHLC sanity is enforced at the schema** (high >= open/close,
   low <= open/close, high >= low) so no downstream consumer can see an
   impossible bar; volume is nullable (FX providers often publish none).
7. **Symbol mapping is versioned** (`version` + `updatedAtUtc` on the table)
   and lookup returns explicit null for unmapped symbols — unknown provider
   symbols are a quarantine condition (P02-03), never a guess.
8. **Session schedules are UTC weekday windows** (`mon..fri` tokens,
   `HH:MM`/`24:00` boundaries, midnight-rolling windows and intraday breaks
   supported; `timezone` is locked to the literal `UTC`).
9. **Timeframe set is frozen to the blueprint**: 5m/15m/1h/4h/1d, with
   `TIMEFRAME_MS` durations used for alignment and (later) gap checks.
   Intraday bars align to the UTC epoch grid; 1d bars align to UTC midnight.

## Consequences

- Every later phase (features, regime, backtest, execution) types its
  market-data inputs against these contracts; pip/precision assumptions
  cannot silently enter strategy code.
- Adding an instrument/timeframe/provider mapping is a DATA change plus a
  version bump, not a code change — but adding a new timeframe still
  requires a blueprint-level decision (frozen set).
- The Python mirror must track schema changes in lockstep; the
  cross-cutting contract tests (`tests/test_data_core_contracts.py`) pin the
  shared-source wiring and the no-literals invariant.
- The contracts package is consumed as TS source; a future dist build (for
  browser bundles or publishing) needs its own decision, not a silent change.

## Verification

- `pnpm --filter @fdbtrade/contracts run test` — 28 vitest cases over the
  schemas and registry (valid/malformed/boundary/determinism).
- `python3 -m unittest tests.test_data_core_contracts -v` — shared-data,
  Python-mirror and single-source contracts.
- `make check` green across the workspace.
